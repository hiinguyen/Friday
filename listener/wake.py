"""Offline wake-word listener for F.R.I.D.A.Y.

Reads 16 kHz mono PCM from PipeWire (pw-record) or a WAV file, runs a
grammar-constrained Vosk recognizer, and writes JSON events to stdout,
one per line:

    {"type": "ready"}
    {"type": "wake", "conf": 0.93}
    {"type": "level", "value": 0.12}      # mic loudness 0..1, ~20 Hz
    {"type": "error", "message": "..."}

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
import time
import wave
from pathlib import Path
from typing import BinaryIO, Iterator

from vosk import KaldiRecognizer, Model, SetLogLevel

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


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


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
        self._rec = KaldiRecognizer(model, SAMPLE_RATE, GRAMMAR)
        self._rec.SetWords(True)
        self._min_conf = min_conf
        self._audio_s = 0.0
        self._last_wake = -COOLDOWN_S
        self._partial_hits = 0
        self._fired_this_utterance = False

    def feed(self, chunk: bytes) -> float | None:
        """Feed audio; return confidence when the wake word is detected."""
        self._audio_s += len(chunk) / (2 * SAMPLE_RATE)
        if self._rec.AcceptWaveform(chunk):
            return self._end_utterance(self._rec.Result())

        if self._fired_this_utterance:
            return None
        if partial_has_committed_wake(self._rec.PartialResult()):
            self._partial_hits += 1
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

    def reset(self) -> None:
        """Start a fresh audio stream (e.g. after the microphone restarted)."""
        self._rec.Reset()
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
        return self._accept(conf)

    def _accept(self, conf: float) -> float | None:
        if self._audio_s - self._last_wake < COOLDOWN_S:
            return None
        self._last_wake = self._audio_s
        return conf


def mic_command(target: str | None) -> list[str]:
    cmd = ["pw-record", "--rate", str(SAMPLE_RATE), "--channels", "1", "--format", "s16"]
    if target:
        cmd += ["--target", target]
    return cmd + ["-"]


def read_chunks(stream: BinaryIO) -> Iterator[bytes]:
    while chunk := stream.read(CHUNK_BYTES):
        yield chunk


def process(detector: WakeDetector, chunks: Iterator[bytes]) -> None:
    last_level = 0.0
    for chunk in chunks:
        now = time.monotonic()
        if now - last_level >= LEVEL_INTERVAL_S:
            emit({"type": "level", "value": round(rms_level(chunk), 3)})
            last_level = now
        conf = detector.feed(chunk)
        if conf is not None:
            emit({"type": "wake", "conf": round(conf, 3)})


def run_wav(detector: WakeDetector, path: Path) -> None:
    with wave.open(str(path), "rb") as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (SAMPLE_RATE, 1, 2):
            raise SystemExit(f"{path}: need {SAMPLE_RATE} Hz mono s16 WAV")
        frames = wav.readframes(wav.getnframes())
    bytes_per_s = SAMPLE_RATE * 2
    for i in range(0, len(frames), CHUNK_BYTES):
        conf = detector.feed(frames[i : i + CHUNK_BYTES])
        if conf is not None:
            emit({"type": "wake", "conf": round(conf, 3), "at": round((i + CHUNK_BYTES) / bytes_per_s, 2)})
    conf = detector.flush()
    if conf is not None:
        emit({"type": "wake", "conf": round(conf, 3), "at": round(len(frames) / bytes_per_s, 2)})


def run_mic(detector: WakeDetector, target: str | None) -> None:
    """Capture forever, restarting pw-record if the device goes away."""
    attempt = 0
    recovering = False
    while True:
        proc = subprocess.Popen(mic_command(target), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        started = time.monotonic()
        assert proc.stdout is not None
        detector.reset()
        try:
            chunks = read_chunks(proc.stdout)
            first = next(chunks, None)
            if first is not None:
                if recovering:
                    emit({"type": "ready"})
                    recovering = False
                process(detector, itertools.chain([first], chunks))
        finally:
            proc.kill()
            proc.wait()
        stderr = proc.stderr.read().decode(errors="replace").strip() if proc.stderr else ""
        if time.monotonic() - started > 30:
            attempt = 0
        delay = RESTART_BACKOFF_S[min(attempt, len(RESTART_BACKOFF_S) - 1)]
        emit({"type": "error", "message": f"microphone stream ended ({stderr or 'no output'}); retrying in {delay}s"})
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
    emit({"type": "ready"})
    try:
        if args.wav:
            run_wav(detector, args.wav)
        else:
            run_mic(detector, args.target)
    except (KeyboardInterrupt, BrokenPipeError):
        pass


if __name__ == "__main__":
    main()
