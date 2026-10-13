"""Offline wake-word listener for F.R.I.D.A.Y.

Reads 16 kHz mono PCM from PipeWire (pw-record) or a WAV file, runs a
grammar-constrained Vosk recognizer, and writes JSON events to stdout,
one per line:

    {"type": "ready", "voiceprint": "armed"}  # or "off" (any voice) / "unusable" (none)
    {"type": "wake", "conf": 0.93}
    {"type": "level", "value": 0.12}      # mic loudness 0..1, ~20 Hz
    {"type": "error", "message": "..."}

After a wake event the following audio is the spoken command; command.py
records and transcribes it and adds "capture" / "transcript" events.
The Electron shell consumes these events. Run standalone to debug:

    python listener/wake.py               # live microphone
    python listener/wake.py --wav x.wav   # offline file
"""

from __future__ import annotations

import argparse
import array
import itertools
import json
import math
import os
import signal
import subprocess
import sys
import threading
import time
import wave
from collections import deque
from collections.abc import Iterator
from pathlib import Path
from typing import BinaryIO

from vosk import KaldiRecognizer, Model, SetLogLevel

from command import PREROLL_BYTES, CommandSession, build_transcriber
from speaker import UnusableVerifier, build_verifier, voiceprint_path

SAMPLE_RATE = 16000
CHUNK_BYTES = 1600  # 50 ms of s16 mono audio
WAKE_WORD = "friday"
# Restricting the vocabulary makes Vosk fast and accurate for a single word,
# but a tiny grammar forces near-sounding speech onto "friday". Decoy words
# that sound close give the decoder somewhere else to land; "[unk]" absorbs
# everything else.
DECOYS = (
    "fried fry fries frying freddy friend friends free freed fred fright "
    "frightened fridge right ride bride pride tried dry eye eyes day days "
    "today sunday monday tuesday thursday saturday fire find fine five"
)
GRAMMAR = json.dumps([WAKE_WORD, "hey friday", *DECOYS.split(), "[unk]"])
DEFAULT_MODEL = Path(__file__).resolve().parent.parent / "models" / "vosk-model-small-en-us-0.15"
DEFAULT_MIN_CONF = 0.6
COOLDOWN_S = 2.0
LEVEL_INTERVAL_S = 0.05
RESTART_BACKOFF_S = (1, 2, 5, 10)
PREROLL_CHUNKS = PREROLL_BYTES // CHUNK_BYTES

_emit_lock = threading.Lock()


def emit(event: dict) -> None:
    # Transcription threads emit too; keep each JSON line whole.
    with _emit_lock:
        sys.stdout.write(json.dumps(event) + "\n")
        sys.stdout.flush()


def log(message: str) -> None:
    """Diagnostics for the journal; stderr is forwarded by the Electron supervisor."""
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


def rms_level(chunk: bytes) -> float:
    """Loudness of an s16 chunk mapped to 0..1 on a perceptual (dB) scale."""
    samples = array.array("h", chunk[: len(chunk) - len(chunk) % 2])
    if not samples:
        return 0.0
    rms = math.sqrt(sum(s * s for s in samples) / len(samples)) / 32768.0
    if rms <= 1e-5:
        return 0.0
    db = 20 * math.log10(rms)  # -100..0
    return max(0.0, min(1.0, (db + 60) / 60))


def wake_confidence(result_json: str) -> float | None:
    """Return confidence of the wake word in a final Vosk result, if present."""
    result = json.loads(result_json)
    for word in result.get("result", []):
        if word.get("word") == WAKE_WORD:
            return float(word.get("conf", 0.0))
    return None


def wake_word_span(result_json: str) -> tuple[float, float] | None:
    """Stream times (s) at which the wake word started and ended, from a final or partial result."""
    result = json.loads(result_json)
    for word in result.get("result", result.get("partial_result", [])):
        if word.get("word") == WAKE_WORD and "start" in word and "end" in word:
            return float(word["start"]), float(word["end"])
    return None


def wake_word_end(result_json: str) -> float | None:
    span = wake_word_span(result_json)
    return span[1] if span else None


def partial_has_committed_wake(partial_json: str) -> bool:
    """True when the wake word is in the partial AND the decoder moved past it.

    A trailing "friday" in a partial is still a guess ("fried eggs" briefly
    reads as "friday"); once another token follows it, the decoder has
    committed to the word boundary and the hypothesis rarely changes.
    """
    tokens = json.loads(partial_json).get("partial", "").split()
    return WAKE_WORD in tokens[:-1]


class WakeDetector:
    """Fires once per utterance, as early as the recognizer is sure.

    The final result (emitted at a pause) carries a real confidence score
    and is the primary trigger. If the speaker runs straight on ("Friday
    open the browser" without a pause), a committed partial hypothesis that
    stays stable for PARTIAL_STABLE chunks fires early instead, and the
    final result of that same utterance is then ignored.

    The cooldown is measured in audio time rather than wall time, so the
    behaviour is identical for a live mic and for faster-than-real-time
    file decoding.
    """

    PARTIAL_STABLE = 2  # x 50 ms chunks

    def __init__(self, model: Model, min_conf: float) -> None:
        self._model = model
        self._rec = self._new_recognizer()
        self._min_conf = min_conf
        self._audio_s = 0.0  # total audio fed, for the cooldown
        self._stream_s = 0.0  # audio since the last reset; Vosk word times use this clock
        self._wake_span: tuple[float, float] | None = None
        self._last_wake = -COOLDOWN_S
        self._partial_hits = 0
        self._fired_this_utterance = False

    def feed(self, chunk: bytes) -> float | None:
        """Feed audio; return confidence when the wake word is detected."""
        seconds = len(chunk) / (2 * SAMPLE_RATE)
        self._audio_s += seconds
        self._stream_s += seconds
        if self._rec.AcceptWaveform(chunk):
            return self._end_utterance(self._rec.Result())

        if self._fired_this_utterance:
            return None
        partial = self._rec.PartialResult()
        if partial_has_committed_wake(partial):
            self._partial_hits += 1
            self._wake_span = wake_word_span(partial)
        else:
            self._partial_hits = 0
        if self._partial_hits < self.PARTIAL_STABLE:
            return None
        self._fired_this_utterance = True
        # Partial hypotheses carry no score; report the stability instead.
        return self._accept(1.0)

    def flush(self) -> float | None:
        """End of input: decide on whatever audio is still buffered."""
        return self._end_utterance(self._rec.FinalResult())

    def _new_recognizer(self) -> KaldiRecognizer:
        rec = KaldiRecognizer(self._model, SAMPLE_RATE, GRAMMAR)
        rec.SetWords(True)
        rec.SetPartialWords(True)
        return rec

    def reset(self) -> None:
        """Start a fresh audio stream (after a command, or when the microphone restarted).

        A new recognizer (~0.2 ms) rather than KaldiRecognizer.Reset(): Reset()
        keeps an offset in its word timestamps, which would misplace the cut
        between the wake word and the command.
        """
        self._rec = self._new_recognizer()
        self._stream_s = 0.0
        self._wake_span = None
        self._partial_hits = 0
        self._fired_this_utterance = False

    def _end_utterance(self, result_json: str) -> float | None:
        # Whatever happened during this utterance, the next one starts fresh.
        fired_early = self._fired_this_utterance
        self._partial_hits = 0
        self._fired_this_utterance = False
        conf = wake_confidence(result_json)
        if fired_early or conf is None or conf < self._min_conf:
            return None
        self._wake_span = wake_word_span(result_json)
        return self._accept(conf)

    def wake_word_window(self) -> tuple[float, float] | None:
        """Seconds of audio fed since the last detected wake word (started, ended); None if unknown."""
        if self._wake_span is None:
            return None
        start, end = self._wake_span
        return max(0.0, self._stream_s - start), max(0.0, self._stream_s - end)

    def seconds_since_wake_word(self) -> float | None:
        """Audio fed after the last detected wake word ended (None if its timing is unknown)."""
        window = self.wake_word_window()
        return window[1] if window else None

    def _accept(self, conf: float) -> float | None:
        if self._audio_s - self._last_wake < COOLDOWN_S:
            return None
        self._last_wake = self._audio_s
        return conf


# Never pick a Bluetooth mic implicitly: while any app records from it, the
# headset is forced from A2DP (stereo, high quality) into the HFP call profile
# (mono, 16 kHz), which ruins music for as long as this listener runs.
EXCLUDED_APIS = {"bluez5"}
# If the chosen mic disappears, end the stream instead of letting WirePlumber
# silently move it to the default source (which may be a Bluetooth headset);
# run_mic then re-resolves the source.
STREAM_PROPS = "{ node.dont-fallback = true node.dont-reconnect = true }"


def pick_source(sources: list[dict], default: str | None) -> str | None:
    """Choose a capture source: the default if eligible, else the highest priority one."""
    eligible = [
        s
        for s in sources
        if s.get("properties", {}).get("media.class") == "Audio/Source"
        and s.get("properties", {}).get("device.api") not in EXCLUDED_APIS
    ]
    for s in eligible:
        if s["name"] == default:
            return default
    if not eligible:
        return None
    best = max(eligible, key=lambda s: int(s["properties"].get("priority.session", 0)))
    return best["name"]


def resolve_target(explicit: str | None) -> str | None:
    """FRIDAY_MIC wins; otherwise ask PipeWire for a suitable non-Bluetooth mic."""
    if explicit:
        return explicit
    try:
        listing = subprocess.run(
            ["pactl", "--format=json", "list", "sources"], capture_output=True, text=True, check=True, timeout=5
        )
        default = subprocess.run(
            ["pactl", "get-default-source"], capture_output=True, text=True, check=True, timeout=5
        ).stdout.strip()
        return pick_source(json.loads(listing.stdout), default or None)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        emit({"type": "error", "message": f"cannot list audio sources: {exc}"})
        return None


def mic_command(target: str) -> list[str]:
    return [
        "pw-record",
        "--rate", str(SAMPLE_RATE),
        "--channels", "1",
        "--format", "s16",
        "--target", target,
        "-P", STREAM_PROPS,
        "-",
    ]  # fmt: skip


def read_chunks(stream: BinaryIO) -> Iterator[bytes]:
    while chunk := stream.read(CHUNK_BYTES):
        yield chunk


def process(detector: WakeDetector, session: CommandSession, chunks: Iterator[bytes]) -> None:
    """Wake-word mode until "Friday", then command mode until the command ends."""
    last_level = 0.0
    preroll: deque[bytes] = deque(maxlen=PREROLL_CHUNKS)
    for chunk in chunks:
        now = time.monotonic()
        if now - last_level >= LEVEL_INTERVAL_S:
            emit({"type": "level", "value": round(rms_level(chunk), 3)})
            last_level = now
        if session.active:
            if not session.feed(chunk):
                # The command contained speech the wake detector never saw; start clean.
                detector.reset()
                preroll.clear()
            continue
        preroll.append(chunk)
        conf = detector.feed(chunk)
        if conf is not None:
            emit({"type": "wake", "conf": round(conf, 3)})
            recent, window = b"".join(preroll), detector.wake_word_window()
            session.begin(
                command_preroll(recent, window[1] if window else None),
                wake_audio=wake_word_audio(recent, window),
            )


def command_preroll(recent: bytes, after_wake_s: float | None) -> bytes:
    """The part of the recent audio that follows the wake word.

    The wake event lands late (after a pause, or a few words into "Friday open
    the..."), so the start of the command is already in `recent`. Cutting at
    the word boundary keeps the wake word out of the transcript; a clipped
    "Friday" would otherwise be transcribed as some other word.
    """
    if after_wake_s is None:
        return recent
    keep = min(len(recent), int(after_wake_s * SAMPLE_RATE) * 2)
    return recent[len(recent) - keep :] if keep else b""


def wake_word_audio(recent: bytes, window: tuple[float, float] | None) -> bytes:
    """The spoken wake word itself, cut from the recent audio, for speaker verification."""
    if window is None:
        return b""
    since_start, since_end = window
    start = max(0, len(recent) - int(since_start * SAMPLE_RATE) * 2)
    end = max(0, len(recent) - int(since_end * SAMPLE_RATE) * 2)
    return recent[start:end]


def ready_event(session: CommandSession) -> dict:
    return {"type": "ready", "voiceprint": session.voiceprint}


def run_wav(detector: WakeDetector, session: CommandSession, path: Path) -> None:
    with wave.open(str(path), "rb") as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (SAMPLE_RATE, 1, 2):
            raise SystemExit(f"{path}: need {SAMPLE_RATE} Hz mono s16 WAV")
        frames = wav.readframes(wav.getnframes())
    process(detector, session, (frames[i : i + CHUNK_BYTES] for i in range(0, len(frames), CHUNK_BYTES)))
    if not session.active and (conf := detector.flush()) is not None:
        emit({"type": "wake", "conf": round(conf, 3)})


def run_mic(detector: WakeDetector, session: CommandSession, explicit_target: str | None) -> None:
    """Capture forever, re-resolving the mic and restarting pw-record if it goes away."""
    attempt = 0
    recovering = False
    while True:
        target = resolve_target(explicit_target)
        started = time.monotonic()
        if target is None:
            reason = "no non-Bluetooth microphone found (set FRIDAY_MIC to use a specific one)"
        else:
            if attempt == 0 or recovering:
                log(f"capturing from {target}")
            proc = subprocess.Popen(mic_command(target), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            assert proc.stdout is not None
            detector.reset()
            session.cancel()
            try:
                chunks = read_chunks(proc.stdout)
                first = next(chunks, None)
                if first is not None:
                    if recovering:
                        emit(ready_event(session))
                        recovering = False
                    process(detector, session, itertools.chain([first], chunks))
            finally:
                proc.kill()
                proc.wait()
            stderr = proc.stderr.read().decode(errors="replace").strip() if proc.stderr else ""
            reason = f"microphone stream ended ({stderr or 'no output'})"
        if time.monotonic() - started > 30:
            attempt = 0
        delay = RESTART_BACKOFF_S[min(attempt, len(RESTART_BACKOFF_S) - 1)]
        emit({"type": "error", "message": f"{reason}; retrying in {delay}s"})
        recovering = True
        attempt += 1
        time.sleep(delay)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--wav", type=Path, help="process a 16 kHz mono WAV file instead of the mic")
    parser.add_argument("--model", type=Path, default=Path(os.environ.get("FRIDAY_MODEL", DEFAULT_MODEL)))
    parser.add_argument("--target", default=os.environ.get("FRIDAY_MIC"), help="PipeWire source name or serial")
    parser.add_argument(
        "--min-conf", type=float, default=float(os.environ.get("FRIDAY_MIN_CONF", DEFAULT_MIN_CONF))
    )
    args = parser.parse_args()

    if not args.model.is_dir():
        emit({"type": "error", "message": f"Vosk model not found at {args.model}"})
        raise SystemExit(1)

    # Turn SIGTERM into SystemExit so `finally` blocks kill pw-record on shutdown.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    SetLogLevel(-1)
    detector = WakeDetector(Model(str(args.model)), args.min_conf)
    transcriber = build_transcriber()
    if transcriber is None:
        log("OPENAI_API_KEY not set (environment or .env): voice commands will not be transcribed")
    verifier = build_verifier()
    if verifier is None:
        log("no voiceprint enrolled (bin/friday enroll): commands are accepted from any voice")
    elif isinstance(verifier, UnusableVerifier):
        log(f"voiceprint {voiceprint_path()} unusable, every command will be rejected: {verifier.reason}")
    voice_log = Path(os.environ["FRIDAY_VOICE_LOG"]) if os.environ.get("FRIDAY_VOICE_LOG") else None
    if voice_log is not None:
        log(f"saving every scored voice sample to {voice_log} (FRIDAY_VOICE_LOG)")
    session = CommandSession(transcriber, emit, verifier=verifier, voice_log=voice_log)
    emit(ready_event(session))
    try:
        if args.wav:
            run_wav(detector, session, args.wav)  # returns once queued transcriptions finish
        else:
            run_mic(detector, session, args.target)
    except (KeyboardInterrupt, BrokenPipeError, SystemExit):
        # pw-record is already gone (run_mic's finally). Do not let a
        # transcription still talking to the API delay shutdown.
        session.close()
        sys.stderr.flush()
        os._exit(0)


if __name__ == "__main__":
    main()
