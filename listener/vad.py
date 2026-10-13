"""Voice activity detection for F.R.I.D.A.Y.: is this 32 ms of audio someone speaking?

Silero VAD (a small neural network, ONNX, run by onnxruntime on the CPU)
replaces WebRTC VAD, which judged by energy and pitch-like features and took
a desk fan or keyboard typing for speech: commands then ran to the 15 s cap.
On the same recordings Silero scores the noise below 0.1 and speech near 1.
"""

from __future__ import annotations

import functools
import os
from pathlib import Path
from typing import Protocol

import numpy as np

SAMPLE_RATE = 16000
FRAME_SAMPLES = 512  # the only window Silero VAD takes at 16 kHz (32 ms)
FRAME_BYTES = FRAME_SAMPLES * 2
CONTEXT_SAMPLES = 64  # tail of the previous frame the model sees with each one
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_VAD_MODEL = ROOT / "models" / "silero_vad.onnx"
# Speech begins at SPEECH_START and continues until the probability falls
# below SPEECH_KEEP (Silero's own threshold and its default 0.15 hysteresis),
# so soft syllables inside a sentence do not count as pauses.
SPEECH_START = 0.5
SPEECH_KEEP = 0.35


class VadUnavailable(Exception):
    """The voice activity model cannot be loaded; the message says which file and why."""


class FrameScorer(Protocol):
    def probability(self, frame: bytes) -> float: ...


def vad_model_path() -> Path:
    return Path(os.environ.get("FRIDAY_VAD_MODEL") or DEFAULT_VAD_MODEL)


def default_vad() -> SileroVad:
    """The model at FRIDAY_VAD_MODEL (or models/silero_vad.onnx), loaded once per path."""
    return _load(vad_model_path())


@functools.cache
def _load(path: Path) -> SileroVad:
    return SileroVad(path)


class SileroVad:
    """The loaded model; stream() starts an independent scorer for one recording."""

    def __init__(self, path: Path) -> None:
        if not path.is_file():
            raise VadUnavailable(f"voice activity model {path} is missing (see Install in README.md)")
        try:
            import onnxruntime as ort
        except ImportError as exc:
            raise VadUnavailable(f"cannot load {path.name}: onnxruntime is not installed") from exc

        options = ort.SessionOptions()
        # One CPU thread that sleeps between frames: this runs inside an always-on service.
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        try:
            self._session = ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])
        except Exception as exc:
            raise VadUnavailable(f"cannot load voice activity model {path.name}") from exc
        if {i.name for i in self._session.get_inputs()} != {"input", "state", "sr"}:
            raise VadUnavailable(f"{path.name} is not a Silero VAD v5+ model")

    def stream(self) -> VadStream:
        return VadStream(self._session)


class VadStream:
    """Speech probability of consecutive frames; the model carries state from one frame to the next."""

    def __init__(self, session) -> None:
        self._session = session
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, CONTEXT_SAMPLES), dtype=np.float32)
        self._rate = np.array(SAMPLE_RATE, dtype=np.int64)

    def probability(self, frame: bytes) -> float:
        if len(frame) != FRAME_BYTES:
            raise ValueError(f"need frames of {FRAME_BYTES} bytes, got {len(frame)}")
        samples = (np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768.0)[np.newaxis]
        window = np.concatenate([self._context, samples], axis=1)
        prob, self._state = self._session.run(None, {"input": window, "state": self._state, "sr": self._rate})
        self._context = samples[:, -CONTEXT_SAMPLES:]
        return float(prob[0, 0])


class SpeechDetector:
    """Speech / not speech per frame, with hysteresis between SPEECH_START and SPEECH_KEEP."""

    def __init__(self, stream: FrameScorer) -> None:
        self._stream = stream
        self._speaking = False

    def is_speech(self, frame: bytes) -> bool:
        threshold = SPEECH_KEEP if self._speaking else SPEECH_START
        self._speaking = self._stream.probability(frame) >= threshold
        return self._speaking
