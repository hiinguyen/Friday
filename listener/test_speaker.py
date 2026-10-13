"""Tests for speaker verification (voiceprint enrollment and matching).

The end-to-end cases run the real WeSpeaker model on short clips of real
people (testdata/speakers, from LibriSpeech): synthetic espeak voices all
share one vocal tract model and score as the same speaker.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

import speaker

FFMPEG = shutil.which("ffmpeg")
SPEAKERS = Path(__file__).resolve().parent / "testdata" / "speakers"
V = speaker.VOICEPRINT_VERSION
needs_model = pytest.mark.skipif(
    not speaker.DEFAULT_SPEAKER_MODEL.is_file() or not FFMPEG, reason="speaker model or ffmpeg missing"
)


def unit(*values: float) -> np.ndarray:
    v = np.array(values, dtype=np.float32)
    return v / np.linalg.norm(v)


def to_wav(path: Path, out_dir: Path) -> Path:
    out = out_dir / f"{path.stem}.wav"
    subprocess.run([FFMPEG, "-loglevel", "error", "-y", "-i", str(path), "-ar", "16000", "-ac", "1", str(out)], check=True)
    return out


def load_clip(path: Path) -> bytes:
    """16 kHz mono s16 PCM of a test clip."""
    out = subprocess.run(
        [FFMPEG, "-loglevel", "error", "-i", str(path), "-f", "s16le", "-ar", "16000", "-ac", "1", "-"],
        check=True,
        capture_output=True,
    )
    return out.stdout


def clips(prefix: str) -> list[Path]:
    return sorted(SPEAKERS.glob(f"{prefix}-*.flac"))


class TestVoiceprint:
    def test_score_is_cosine_to_the_centroid(self) -> None:
        vp = speaker.Voiceprint(model="m.onnx", embeddings=(unit(1, 0), unit(0, 1)))
        assert vp.score(unit(1, 1)) == pytest.approx(1.0)
        assert vp.score(unit(1, -1)) == pytest.approx(0.0, abs=1e-6)

    def test_self_scores_leave_each_sample_out(self) -> None:
        vp = speaker.Voiceprint(model="m.onnx", embeddings=(unit(1, 0), unit(1, 0), unit(0, 1)))
        assert vp.self_scores() == pytest.approx([1 / np.sqrt(2), 1 / np.sqrt(2), 0.0], abs=1e-6)

    def test_save_and_load_round_trip_privately(self, tmp_path: Path) -> None:
        path = tmp_path / "friday" / "voiceprint.json"
        vp = speaker.Voiceprint(model="m.onnx", embeddings=(unit(1, 2, 3), unit(3, 2, 1)))
        vp.save(path)
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
        loaded = speaker.Voiceprint.load(path)
        assert loaded.model == "m.onnx"
        assert np.allclose(loaded.centroid, vp.centroid)

    @pytest.mark.parametrize(
        "content",
        [
            "not json",
            json.dumps([1, 2]),
            # Version 1 embeddings came from sherpa-onnx without feature mean normalisation.
            json.dumps({"version": 1, "model": "m.onnx", "embeddings": [[1.0, 0.0]]}),
            json.dumps({"version": V, "model": "m.onnx", "embeddings": []}),
            json.dumps({"version": V, "model": "m.onnx", "embeddings": [[1.0, 0.0], [1.0]]}),
            json.dumps({"version": V, "model": "m.onnx", "embeddings": [[0.0, 0.0]]}),
        ],
    )
    def test_corrupt_files_are_rejected(self, tmp_path: Path, content: str) -> None:
        path = tmp_path / "voiceprint.json"
        path.write_text(content)
        with pytest.raises(speaker.VoiceprintError):
            speaker.Voiceprint.load(path)


class FakeModel:
    name = "m.onnx"

    def __init__(self, embedding: np.ndarray) -> None:
        self.embedding = embedding
        self.calls: list[bytes] = []

    def embed(self, pcm: bytes) -> np.ndarray:
        self.calls.append(pcm)
        return self.embedding


ENROLLED = speaker.Voiceprint(model="m.onnx", embeddings=(unit(1, 0),))
SAMPLE = bytes(int(speaker.MIN_SAMPLE_S * speaker.SAMPLE_RATE) * 2)


class TestSpeakerVerifier:
    def test_accepts_at_or_above_threshold(self) -> None:
        verifier = speaker.SpeakerVerifier(FakeModel(unit(1, 0.1)), ENROLLED, threshold=0.5)
        verdict = verifier.check(SAMPLE)
        assert verdict.accepted and verdict.score == pytest.approx(0.995, abs=1e-3)

    def test_rejects_below_threshold(self) -> None:
        verifier = speaker.SpeakerVerifier(FakeModel(unit(0.2, 1)), ENROLLED, threshold=0.5)
        assert not verifier.check(SAMPLE).accepted

    def test_too_little_speech_is_rejected_without_scoring(self) -> None:
        model = FakeModel(unit(1, 0))
        verdict = speaker.SpeakerVerifier(model, ENROLLED, threshold=0.5).check(SAMPLE[:-2])
        assert verdict == speaker.Verdict(False, 0.0, unclear=True)
        assert model.calls == []

    def test_unattributable_audio_is_rejected(self) -> None:
        class Silent(FakeModel):
            def embed(self, pcm: bytes) -> np.ndarray:
                raise speaker.NotEnoughSpeech("too little audio")

        verdict = speaker.SpeakerVerifier(Silent(unit(1, 0)), ENROLLED, threshold=0.5).check(SAMPLE)
        assert verdict == speaker.Verdict(False, 0.0, unclear=True)

    def test_a_scored_mismatch_is_not_unclear(self) -> None:
        verdict = speaker.SpeakerVerifier(FakeModel(unit(0, 1)), ENROLLED, threshold=0.5).check(SAMPLE)
        assert not verdict.accepted and not verdict.unclear

    def test_voiceprint_from_another_model_is_unusable(self) -> None:
        other = speaker.Voiceprint(model="other.onnx", embeddings=(unit(1, 0),))
        with pytest.raises(speaker.VoiceprintError, match="re-enroll"):
            speaker.SpeakerVerifier(FakeModel(unit(1, 0)), other, threshold=0.5)


class TestBuildVerifier:
    def test_not_enrolled_means_no_verification(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.setenv("FRIDAY_VOICEPRINT", str(tmp_path / "missing.json"))
        assert speaker.build_verifier() is None

    def test_default_location_is_private_user_data(self, monkeypatch) -> None:
        monkeypatch.delenv("FRIDAY_VOICEPRINT", raising=False)
        monkeypatch.setenv("XDG_DATA_HOME", "/data")
        assert speaker.voiceprint_path() == Path("/data/friday/voiceprint.json")

    def test_unusable_voiceprint_fails_closed(self, tmp_path: Path, monkeypatch) -> None:
        """An enrolled user must never silently fall back to accepting every voice."""
        path = tmp_path / "voiceprint.json"
        path.write_text("garbage")
        monkeypatch.setenv("FRIDAY_VOICEPRINT", str(path))
        verifier = speaker.build_verifier()
        assert isinstance(verifier, speaker.UnusableVerifier)
        with pytest.raises(speaker.VoiceprintError):
            verifier.check(SAMPLE)

    def test_a_file_that_is_not_a_model_is_unusable(self, tmp_path: Path) -> None:
        model = tmp_path / "not_a_model.onnx"
        model.write_bytes(b"onnx")
        with pytest.raises(speaker.VoiceprintError, match="cannot load"):
            speaker.SpeakerModel(model)

    def test_missing_model_fails_closed(self, tmp_path: Path, monkeypatch) -> None:
        path = tmp_path / "voiceprint.json"
        ENROLLED.save(path)
        monkeypatch.setenv("FRIDAY_VOICEPRINT", str(path))
        monkeypatch.setenv("FRIDAY_SPEAKER_MODEL", str(tmp_path / "nope.onnx"))
        assert isinstance(speaker.build_verifier(), speaker.UnusableVerifier)

    @pytest.mark.parametrize(
        ("setting", "expected"), [(None, speaker.DEFAULT_THRESHOLD), ("", speaker.DEFAULT_THRESHOLD), ("0.4", 0.4)]
    )
    def test_threshold_setting(self, setting, expected) -> None:
        assert speaker.speaker_threshold(setting) == pytest.approx(expected)

    @pytest.mark.parametrize("setting", ["high", "1.5", "-0.1", "nan"])
    def test_invalid_threshold_is_an_error(self, setting) -> None:
        with pytest.raises(speaker.VoiceprintError):
            speaker.speaker_threshold(setting)


@pytest.fixture(scope="module")
def verifier(model) -> speaker.SpeakerVerifier:
    """Speaker A (LibriSpeech 777) enrolled from four 3 s clips."""
    enroll = [model.embed(load_clip(p)) for p in clips("a-enroll")]
    assert len(enroll) >= 4
    voiceprint = speaker.Voiceprint(model=model.name, embeddings=tuple(enroll))
    return speaker.SpeakerVerifier(model, voiceprint, speaker.DEFAULT_THRESHOLD)


@pytest.fixture(scope="module")
def model() -> speaker.SpeakerModel:
    return speaker.SpeakerModel(speaker.DEFAULT_SPEAKER_MODEL)


@pytest.fixture(scope="module")
def clip() -> bytes:
    return load_clip(clips("b-test")[0])


@needs_model
class TestEmbedding:
    """The model must hear the voice, not the microphone."""

    def test_microphone_level_does_not_change_the_voice(self, model, clip) -> None:
        """Regression: without per-utterance feature mean normalisation (sherpa-onnx 1.13.8) a 12 dB
        quieter mic moved the embedding to cosine 0.87, and two strangers on one mic scored as alike."""
        quieter = (np.frombuffer(clip, dtype=np.int16) // 4).astype(np.int16).tobytes()
        assert float(model.embed(clip) @ model.embed(quieter)) > 0.999

    def test_microphone_colouring_barely_changes_the_voice(self, model, clip) -> None:
        samples = np.frombuffer(clip, dtype=np.int16).astype(np.float32)
        tilted = np.clip(samples - 0.6 * np.concatenate(([0.0], samples[:-1])), -32768, 32767)  # brighter mic
        assert float(model.embed(clip) @ model.embed(tilted.astype(np.int16).tobytes())) > 0.95

    def test_too_little_audio_is_not_enough_speech(self, model) -> None:
        with pytest.raises(speaker.NotEnoughSpeech):
            model.embed(bytes(3200))


@needs_model
class TestRealVoices:
    """Held-out 2.5 s clips of the enrolled speaker A, a man B and a woman C."""

    @pytest.mark.parametrize("clip", clips("a-test"), ids=lambda p: p.stem)
    def test_enrolled_speaker_is_accepted(self, verifier, clip: Path) -> None:
        assert verifier.check(load_clip(clip)).accepted

    @pytest.mark.parametrize("clip", clips("b-test") + clips("c-test"), ids=lambda p: p.stem)
    def test_other_speakers_are_rejected(self, verifier, clip: Path) -> None:
        assert not verifier.check(load_clip(clip)).accepted


def run_enroll(out: Path, wavs: list[Path]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(Path(__file__).resolve().parent / "enroll.py"), "--out", str(out), "--wav", *map(str, wavs)],
        capture_output=True,
        text=True,
        env={**os.environ, "FRIDAY_SPEAKER_THRESHOLD": ""},
        check=False,  # the exit status is asserted by the callers
    )


@needs_model
def test_enroll_refuses_samples_that_are_not_one_voice(tmp_path: Path) -> None:
    """A second person in the samples would widen the voiceprint and let them in."""
    out = tmp_path / "voiceprint.json"
    out.write_text("previous")
    wavs = [to_wav(p, tmp_path) for p in clips("a-enroll")[:3] + clips("c-test")[:1]]
    result = run_enroll(out, wavs)
    assert result.returncode != 0
    assert "sample 4" in result.stderr.lower()
    assert out.read_text() == "previous"


@needs_model
def test_enroll_cli_builds_a_voiceprint_from_files(tmp_path: Path) -> None:
    out = tmp_path / "voiceprint.json"
    wavs = [to_wav(p, tmp_path) for p in clips("a-enroll")]
    result = subprocess.run(
        [sys.executable, str(Path(__file__).resolve().parent / "enroll.py"), "--out", str(out), "--wav", *map(str, wavs)],
        capture_output=True,
        text=True,
        env={**os.environ, "FRIDAY_SPEAKER_THRESHOLD": ""},
        check=False,  # the exit status is asserted below, with stderr in the message
    )
    assert result.returncode == 0, result.stderr
    vp = speaker.Voiceprint.load(out)
    assert len(vp.embeddings) == len(wavs)
    assert vp.model == speaker.DEFAULT_SPEAKER_MODEL.name
    assert "saved" in result.stdout.lower()
