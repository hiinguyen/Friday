"""Tests for cutting a voice sample down to what Pocket TTS can condition on."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

import clone

SR = clone.SAMPLE_RATE
LISTENER = Path(__file__).resolve().parent


def tone(seconds: float, level: float = 0.3) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    return (level * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SR), dtype=np.float32)


def speech(*parts: tuple[str, float]) -> np.ndarray:
    """("v", 2.0) is two seconds of voice, ("p", 0.5) half a second of pause."""
    return np.concatenate([tone(s) if kind == "v" else silence(s) for kind, s in parts])


class TestTrim:
    def test_drops_leading_and_trailing_silence(self) -> None:
        sample, cut = clone.trim(speech(("p", 1.0), ("v", 4.0), ("p", 2.0)))
        assert not cut
        assert len(sample) / SR == pytest.approx(4.0, abs=clone.FRAME_S)

    def test_a_long_recording_ends_inside_the_last_pause_before_the_limit(self) -> None:
        audio = speech(("v", 12.0), ("p", 0.6), ("v", 10.0), ("p", 0.4), ("v", 12.0))
        sample, cut = clone.trim(audio)
        seconds = len(sample) / SR
        assert not cut
        # The pause at 22.6-23.0 s is the last one before 30 s; the sample ends inside it.
        assert 22.6 < seconds < 23.0
        assert np.abs(sample[-int(0.1 * SR) :]).max() < 1e-3

    def test_short_breaths_are_not_pauses(self) -> None:
        audio = speech(("v", 20.0), ("p", 0.1), ("v", 5.0), ("p", 0.5), ("v", 10.0))
        sample, _ = clone.trim(audio)
        assert 25.0 < len(sample) / SR < 25.5

    def test_without_any_pause_it_cuts_at_the_limit_and_says_so(self) -> None:
        sample, cut = clone.trim(tone(40.0))
        assert cut
        assert len(sample) / SR == pytest.approx(clone.MAX_SECONDS, abs=clone.FRAME_S)

    def test_silence_only_gives_nothing(self) -> None:
        sample, cut = clone.trim(silence(3.0))
        assert len(sample) == 0
        assert not cut

    def test_a_quiet_recording_is_judged_against_its_own_loudness(self) -> None:
        quiet = speech(("v", 3.0), ("p", 0.5), ("v", 3.0)) * 0.02  # about -40 dBFS
        sample, _ = clone.trim(quiet)
        assert len(sample) / SR == pytest.approx(6.5, abs=clone.FRAME_S)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
class TestDecode:
    def test_reads_any_format_as_24khz_mono(self, tmp_path: Path) -> None:
        path = tmp_path / "stereo.mp3"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=2:r=44100", "-ac", "2", str(path)],
            check=True,
        )
        audio = clone.decode(path)
        assert audio.dtype == np.float32
        assert len(audio) / SR == pytest.approx(2.0, abs=0.1)

    def test_an_unreadable_file_is_a_clear_error(self, tmp_path: Path) -> None:
        path = tmp_path / "broken.wav"
        path.write_bytes(b"not audio")
        with pytest.raises(SystemExit, match="cannot read"):
            clone.decode(path)

    def test_too_little_speech_is_refused_before_loading_the_model(self, tmp_path: Path) -> None:
        path = tmp_path / "short.wav"
        clone.write_wav(path, speech(("v", 1.5)))
        out = tmp_path / "v.safetensors"
        result = subprocess.run(
            [sys.executable, str(LISTENER / "clone.py"), str(path), "--out", str(out)],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        assert result.returncode != 0
        assert "need at least 3s" in result.stderr
        assert not out.exists()
