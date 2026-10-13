"""Voice command capture and transcription for F.R.I.D.A.Y.

After the wake word fires, CommandSession records the spoken command from the
same microphone stream, ends it locally with Silero VAD (vad.py; no audio
leaves the machine before the wake word, and silence, fan noise or typing is
never uploaded as a command), checks that the
voice is the enrolled one (speaker.py), then sends the utterance to OpenAI
speech-to-text and streams the text back as events:

    {"type": "capture", "id": 3, "state": "listening"}
    {"type": "capture", "id": 3, "state": "processing", "reason": "silence", "seconds": 2.4}
    {"type": "capture", "id": 3, "state": "empty"}          # nothing was said
    {"type": "capture", "id": 3, "state": "cancelled"}      # the microphone restarted
    {"type": "capture", "id": 3, "state": "verified", "score": 0.71}   # the enrolled voice
    {"type": "capture", "id": 3, "state": "rejected", "score": 0.08}   # someone else; nothing is sent
    {"type": "capture", "id": 3, "state": "rejected", "error": "..."}  # the voiceprint is unusable
    {"type": "capture", "id": 3, "state": "unclear"}       # too little speech to tell who it was
    {"type": "transcript", "id": 3, "delta": "open the"}
    {"type": "transcript", "id": 3, "text": "open the browser.", "raw": "Friday, open the browser.", "final": true}
    {"type": "transcript", "id": 3, "error": "..."}
"""

from __future__ import annotations

import io
import os
import re
import sys
import time
import wave
from collections import deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Protocol

from speaker import UnusableVerifier, Verdict
from vad import FRAME_BYTES, SileroVad, SpeechDetector, VadUnavailable, default_vad

SAMPLE_RATE = 16000
FRAME_S = FRAME_BYTES / (2 * SAMPLE_RATE)  # 32 ms, the frame Silero VAD scores
START_WINDOW = 10  # frames (320 ms) considered when deciding speech has started
START_VOICED = 7  # of START_WINDOW frames must be voiced
NO_SPEECH_TIMEOUT_S = 5.0  # give up if no command starts within this long after the wake word
END_SILENCE_S = 1.0  # trailing silence that ends the command
MAX_CAPTURE_S = 15.0
PREROLL_S = 1.5  # audio before the wake event, so "Friday open..." keeps its first words
PREROLL_BYTES = int(PREROLL_S * SAMPLE_RATE) * 2

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_STT_MODEL = "gpt-transcribe"
# Language auto-detection misfires when an English wake word precedes a
# Vietnamese command (gpt-transcribe returned an empty transcript). With a
# "vi" hint English commands still transcribe verbatim, so it is the safer
# default. FRIDAY_STT_LANGUAGE=auto restores detection.
DEFAULT_STT_LANGUAGE = "vi"
API_TIMEOUT_S = 20.0
CONNECT_TIMEOUT_S = 3.0  # per route and address; see network.py
# A command with this much voiced speech is verified on its own: the owner's
# "Friday" must not vouch for someone else speaking the command. Shorter
# commands borrow the wake word's audio, which the model needs to be reliable.
SOLO_VERIFY_S = 1.5

WAKE_PREFIX = re.compile(r"^\s*(?:hey[\s,.!?-]+)?friday\b[\s,.!?-]*", re.IGNORECASE)

Emit = Callable[[dict], None]


def strip_wake_phrase(text: str) -> str:
    """Drop a leading "Friday"/"Hey Friday" in case some of the wake word reached the recording."""
    return WAKE_PREFIX.sub("", text, count=1).strip()


def voiced_audio(pcm: bytes, vad: SileroVad | None = None) -> bytes:
    """Only the 32 ms frames that are speech."""
    detector = SpeechDetector((vad or default_vad()).stream())
    frames = (pcm[i : i + FRAME_BYTES] for i in range(0, len(pcm) - FRAME_BYTES + 1, FRAME_BYTES))
    return b"".join(frame for frame in frames if detector.is_speech(frame))


def save_private_wav(folder: Path, name: str, pcm: bytes) -> Path:
    """Write a WAV only the owner can read, in a folder only the owner can enter: it is their voice."""
    folder.mkdir(parents=True, exist_ok=True)
    os.chmod(folder, 0o700)
    path = folder / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(wav_bytes(pcm))
    os.chmod(path, 0o600)  # in case the file already existed
    return path


def wav_bytes(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm)
    return buf.getvalue()


class Endpointer:
    """Collects audio after the wake word and decides when the command is over.

    feed() returns None while recording, or the reason it stopped:
    "silence" (speech then END_SILENCE_S of quiet), "nospeech" (nothing said
    within NO_SPEECH_TIMEOUT_S) or "maxlength" (MAX_CAPTURE_S reached).
    """

    def __init__(self, preroll: bytes = b"", vad: SileroVad | None = None) -> None:
        """Raises VadUnavailable when the voice activity model cannot be loaded."""
        self._detector = SpeechDetector((vad or default_vad()).stream())
        self._chunks = [preroll]
        self._speech: list[bytes] = []
        self._window: deque[bool] = deque(maxlen=START_WINDOW)
        self._elapsed_s = 0.0
        self._silent_s = 0.0
        self.heard_speech = False
        # The wake event lands late, so a short command ("Friday stop") may be
        # entirely in the pre-roll. Run it through the VAD without counting it
        # against the timeouts, which start at the wake event.
        whole = len(preroll) - len(preroll) % FRAME_BYTES
        for i in range(0, whole, FRAME_BYTES):
            self._classify(preroll[i : i + FRAME_BYTES], counts_time=False)
        self._pending = preroll[whole:]  # its last partial frame starts the first live one

    @property
    def audio(self) -> bytes:
        return b"".join(self._chunks)

    @property
    def speech(self) -> bytes:
        """The voiced frames only, for telling who is speaking."""
        return b"".join(self._speech)

    def feed(self, chunk: bytes) -> str | None:
        self._chunks.append(chunk)
        self._pending += chunk
        while len(self._pending) >= FRAME_BYTES:
            frame, self._pending = self._pending[:FRAME_BYTES], self._pending[FRAME_BYTES:]
            if (reason := self._classify(frame)) is not None:
                return reason
        return None

    def _classify(self, frame: bytes, counts_time: bool = True) -> str | None:
        voiced = self._detector.is_speech(frame)
        if voiced:
            self._speech.append(frame)
        return self._frame(voiced, counts_time)

    def _frame(self, voiced: bool, counts_time: bool = True) -> str | None:
        if counts_time:
            self._elapsed_s += FRAME_S
        if not self.heard_speech:
            self._window.append(voiced)
            if sum(self._window) >= START_VOICED:
                self.heard_speech = True
            elif self._elapsed_s >= NO_SPEECH_TIMEOUT_S:
                return "nospeech"
        elif voiced:
            self._silent_s = 0.0
        else:
            self._silent_s += FRAME_S
            if self._silent_s >= END_SILENCE_S:
                return "silence"
        return "maxlength" if self._elapsed_s >= MAX_CAPTURE_S else None


class SpeechToText(Protocol):
    def transcribe(self, pcm: bytes, on_delta: Callable[[str], None]) -> str: ...


class VoiceCheck(Protocol):
    def check(self, pcm: bytes) -> Verdict: ...


class Transcriber:
    """OpenAI speech-to-text with streamed partial text."""

    def __init__(self, client, model: str, language: str | None = None) -> None:
        self._client = client
        self._model = model
        self._language = language

    def transcribe(self, pcm: bytes, on_delta: Callable[[str], None]) -> str:
        options = {"language": self._language} if self._language else {}
        stream = self._client.audio.transcriptions.create(
            model=self._model,
            file=("command.wav", wav_bytes(pcm), "audio/wav"),
            stream=True,
            **options,
        )
        deltas: list[str] = []
        for event in stream:
            if event.type == "transcript.text.delta":
                deltas.append(event.delta)
                on_delta(event.delta)
            elif event.type == "transcript.text.done":
                return event.text
        return "".join(deltas)


def build_transcriber() -> Transcriber | None:
    """OpenAI transcriber from the environment (and ROOT/.env), or None if unavailable."""
    try:
        import httpx2
        from dotenv import load_dotenv
        from openai import DefaultHttpx2Client, OpenAI

        from network import FallbackTransport, default_routes, uses_proxy
    except ImportError as exc:
        # Wake detection must keep working without the command dependencies.
        sys.stderr.write(f"voice commands disabled: {exc}\n")
        return None

    load_dotenv(ROOT / ".env", override=False)
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        return None
    client = OpenAI(
        api_key=key,
        timeout=httpx2.Timeout(API_TIMEOUT_S, connect=CONNECT_TIMEOUT_S),
        max_retries=1,
        http_client=None if uses_proxy() else DefaultHttpx2Client(transport=FallbackTransport(default_routes())),
    )
    model = os.environ.get("FRIDAY_STT_MODEL", DEFAULT_STT_MODEL)
    return Transcriber(client, model, stt_language(os.environ.get("FRIDAY_STT_LANGUAGE")))


def stt_language(setting: str | None) -> str | None:
    """ISO 639-1 hint for the API; None means auto-detect."""
    value = (setting or DEFAULT_STT_LANGUAGE).strip().lower()
    return None if value == "auto" else value


class CommandSession:
    """Drives one command at a time: begin() on wake, feed() audio until it ends.

    With a verifier, the speaker is checked first and a voice that is not the
    enrolled one is never sent to the API. Verification and transcription run
    on a worker thread so the microphone keeps being read (a stalled pipe would
    make pw-record drop audio and the wake word deaf).
    """

    def __init__(
        self,
        transcriber: SpeechToText | None,
        emit: Emit,
        verifier: VoiceCheck | None = None,
        synchronous: bool = False,
        voice_log: Path | None = None,
    ) -> None:
        self._transcriber = transcriber
        self._verifier = verifier
        # Opt-in (FRIDAY_VOICE_LOG): keep each scored voice sample, named by
        # verdict and score, so the owner can tune the threshold on real use.
        self._voice_log = voice_log
        self._emit = emit
        self._executor = None if synchronous else ThreadPoolExecutor(max_workers=2, thread_name_prefix="stt")
        self._endpointer: Endpointer | None = None
        self._wake_audio = b""
        self._id = 0

    @property
    def active(self) -> bool:
        return self._endpointer is not None

    @property
    def voiceprint(self) -> str:
        """"off" (any voice is obeyed), "armed", or "unusable" (every command is rejected)."""
        if self._verifier is None:
            return "off"
        return "unusable" if isinstance(self._verifier, UnusableVerifier) else "armed"

    def begin(self, preroll: bytes, wake_audio: bytes = b"") -> None:
        """Start recording a command; `wake_audio` (the spoken wake word) only helps identify the speaker."""
        self._id += 1
        self._wake_audio = wake_audio
        if self._transcriber is None:
            self._endpointer = None
            self._emit({"type": "transcript", "id": self._id, "error": "OPENAI_API_KEY is not set"})
            return
        try:
            self._endpointer = Endpointer(preroll)
        except VadUnavailable as exc:
            self._endpointer = None
            self._emit({"type": "transcript", "id": self._id, "error": str(exc)})
            return
        self._emit({"type": "capture", "id": self._id, "state": "listening"})

    def cancel(self) -> None:
        """Abandon the command being recorded (e.g. the microphone restarted)."""
        if self._endpointer is None:
            return
        self._endpointer = None
        self._emit({"type": "capture", "id": self._id, "state": "cancelled"})

    def close(self) -> None:
        """Shutdown: drop queued work and do not wait for in-flight API calls."""
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)

    def feed(self, chunk: bytes) -> bool:
        """Record a chunk; returns False once the command has ended."""
        if self._endpointer is None:
            return False
        reason = self._endpointer.feed(chunk)
        if reason is None:
            return True
        endpointer, self._endpointer = self._endpointer, None
        if reason == "nospeech":
            self._emit({"type": "capture", "id": self._id, "state": "empty"})
            return False
        audio = endpointer.audio
        seconds = round(len(audio) / (2 * SAMPLE_RATE), 2)
        self._emit({"type": "capture", "id": self._id, "state": "processing", "reason": reason, "seconds": seconds})
        speech = endpointer.speech
        voice = speech if len(speech) >= SOLO_VERIFY_S * 2 * SAMPLE_RATE else self._wake_audio + speech
        if self._executor is None:
            self._handle(self._id, audio, voice)
        else:
            self._executor.submit(self._handle, self._id, audio, voice)
        return False

    def _handle(self, capture_id: int, audio: bytes, voice: bytes) -> None:
        if self._is_enrolled_voice(capture_id, voice):
            self._transcribe(capture_id, audio)

    def _is_enrolled_voice(self, capture_id: int, voice: bytes) -> bool:
        if self._verifier is None:
            return True
        try:
            verdict = self._verifier.check(voice)
        except Exception as exc:  # noqa: BLE001 - a broken voiceprint rejects, never lets everyone in
            sys.stderr.write(f"speaker verification failed: {exc!r}\n")
            self._emit_quietly(
                {"type": "capture", "id": capture_id, "state": "rejected", "error": str(exc) or type(exc).__name__}
            )
            return False
        state = "unclear" if verdict.unclear else "verified" if verdict.accepted else "rejected"
        self._log_voice(capture_id, state, verdict.score, voice)
        if verdict.unclear:
            self._emit_quietly({"type": "capture", "id": capture_id, "state": "unclear"})
            return False
        self._emit_quietly({"type": "capture", "id": capture_id, "state": state, "score": round(verdict.score, 3)})
        return verdict.accepted

    def _log_voice(self, capture_id: int, state: str, score: float, voice: bytes) -> None:
        if self._voice_log is None:
            return
        name = f"{time.strftime('%Y%m%d-%H%M%S')}-{capture_id}-{state}-{score:.3f}.wav"
        try:
            save_private_wav(self._voice_log, name, voice)
        except OSError as exc:  # a full disk must not block commands
            sys.stderr.write(f"cannot save voice sample: {exc}\n")

    def _transcribe(self, capture_id: int, audio: bytes) -> None:
        assert self._transcriber is not None
        try:
            raw = self._transcriber.transcribe(
                audio, lambda delta: self._emit({"type": "transcript", "id": capture_id, "delta": delta})
            )
        except BrokenPipeError:
            return  # the app went away mid-stream; nobody is listening
        except Exception as exc:  # noqa: BLE001 - any API/network failure is reported, never fatal
            sys.stderr.write(f"transcription failed: {exc!r}\n")
            self._emit_quietly({"type": "transcript", "id": capture_id, "error": str(exc) or type(exc).__name__})
            return
        self._emit_quietly(
            {"type": "transcript", "id": capture_id, "text": strip_wake_phrase(raw), "raw": raw, "final": True}
        )

    def _emit_quietly(self, event: dict) -> None:
        try:
            self._emit(event)
        except BrokenPipeError:
            pass
