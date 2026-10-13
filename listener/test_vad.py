"""Tests for the Silero voice activity detector.

Noise clips are real recordings (testdata/noise): a fan in the owner's room
and keyboard typing, both of which WebRTC VAD took for speech.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

import vad

FFMPEG = shutil.which("ffmpeg")
TESTDATA = Path(__file__).resolve().parent / "testdata"
# Everything that records a command needs the model (models/ is not in git).
needs_vad = pytest.mark.skipif(not vad.vad_model_path().is_file(), reason="Silero VAD model missing")
needs_model = pytest.mark.skipif(
    not vad.vad_model_path().is_file() or not FFMPEG, reason="Silero VAD model or ffmpeg missing"
)


def load_clip(path: Path) -> bytes:
    """16 kHz mono s16 PCM of a test clip."""
    out = subprocess.run(
        [FFMPEG, "-loglevel", "error", "-i", str(path), "-f", "s16le", "-ar", "16000", "-ac", "1", "-"],
        check=True,
        capture_output=True,
    )
    return out.stdout


def frames(pcm: bytes) -> list[bytes]:
    return [pcm[i : i + vad.FRAME_BYTES] for i in range(0, len(pcm) - vad.FRAME_BYTES + 1, vad.FRAME_BYTES)]


def probabilities(model: vad.SileroVad, pcm: bytes) -> np.ndarray:
    stream = model.stream()
    return np.array([stream.probability(frame) for frame in frames(pcm)])


@pytest.fixture(scope="module")
def model() -> vad.SileroVad:
    return vad.SileroVad(vad.vad_model_path())


def test_missing_model_says_which_file(tmp_path: Path) -> None:
    with pytest.raises(vad.VadUnavailable, match="nope.onnx"):
        vad.SileroVad(tmp_path / "nope.onnx")


def test_model_path_can_be_overridden(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("FRIDAY_VAD_MODEL", str(tmp_path / "other.onnx"))
    assert vad.vad_model_path() == tmp_path / "other.onnx"
    with pytest.raises(vad.VadUnavailable, match="other.onnx"):
        vad.default_vad()


@needs_model
@pytest.mark.parametrize("clip", ["fan.flac", "typing.flac"])
def test_background_noise_is_not_speech(model, clip: str) -> None:
    """Regression: WebRTC VAD classified 84-100% of these frames as speech."""
    probs = probabilities(model, load_clip(TESTDATA / "noise" / clip))
    assert probs.max() < vad.SPEECH_START


@needs_model
def test_real_speech_is_speech(model) -> None:
    probs = probabilities(model, load_clip(TESTDATA / "speakers" / "a-test-1.flac"))
    assert np.mean(probs >= vad.SPEECH_START) > 0.6


@needs_model
def test_streams_do_not_share_state(model) -> None:
    """Each command starts fresh: what the last one heard must not colour the next."""
    speech = load_clip(TESTDATA / "speakers" / "a-test-1.flac")
    first = probabilities(model, speech)
    busy = model.stream()
    for frame in frames(load_clip(TESTDATA / "noise" / "typing.flac")):
        busy.probability(frame)
    assert np.allclose(probabilities(model, speech), first)


@needs_model
def test_rejects_frames_of_the_wrong_size(model) -> None:
    with pytest.raises(ValueError, match=str(vad.FRAME_BYTES)):
        model.stream().probability(bytes(960))


class ScriptedStream:
    def __init__(self, probs: list[float]) -> None:
        self._probs = iter(probs)

    def probability(self, frame: bytes) -> float:
        return next(self._probs)


def test_detector_holds_speech_through_a_dip() -> None:
    """Hysteresis: speech starts at SPEECH_START but only ends below SPEECH_KEEP."""
    detector = vad.SpeechDetector(ScriptedStream([0.4, 0.9, 0.4, 0.3, 0.4]))
    frame = bytes(vad.FRAME_BYTES)
    assert [detector.is_speech(frame) for _ in range(5)] == [False, True, True, False, False]
