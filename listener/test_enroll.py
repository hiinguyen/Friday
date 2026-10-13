"""Tests for voice enrollment prompts, pausing the service, and the opt-in voice sample log."""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import wave
from pathlib import Path

import pytest

import command
import enroll
from speaker import Verdict

ESPEAK = shutil.which("espeak-ng")
FFMPEG = shutil.which("ffmpeg")
SPEAKERS = Path(__file__).resolve().parent / "testdata" / "speakers"


class TestPrompts:
    def test_cover_the_ways_people_actually_talk_to_friday(self) -> None:
        """Regression: enrolled only from calm read sentences, the owner was rejected when louder or higher."""
        styles = {prompt.style for prompt in enroll.PROMPTS}
        assert {"normal", "loud", "high", "quick"} <= styles

    def test_are_short_commands_spoken_after_the_wake_word(self) -> None:
        """Enrollment should sound like use: "Friday, <command>", a few seconds long."""
        for prompt in enroll.PROMPTS:
            assert prompt.text.startswith("Friday,"), prompt
            assert prompt.hint, prompt


class FakeSystemctl:
    def __init__(self, active: bool) -> None:
        self.active = active
        self.calls: list[str] = []

    def __call__(self, args: list[str], check: bool = False) -> subprocess.CompletedProcess:
        action = args[-2]
        self.calls.append(action)
        return subprocess.CompletedProcess(args, 0 if (action != "is-active" or self.active) else 3)


class TestPausedService:
    def test_running_service_is_stopped_and_started_again(self) -> None:
        """Saying "Friday" during enrollment must not wake the running service."""
        systemctl = FakeSystemctl(active=True)
        with enroll.paused_service(systemctl):
            assert systemctl.calls == ["is-active", "stop"]
        assert systemctl.calls == ["is-active", "stop", "start"]

    def test_service_comes_back_when_enrollment_fails(self) -> None:
        systemctl = FakeSystemctl(active=True)
        with pytest.raises(KeyboardInterrupt), enroll.paused_service(systemctl):
            raise KeyboardInterrupt
        assert systemctl.calls[-1] == "start"

    def test_stopped_service_is_left_alone(self) -> None:
        systemctl = FakeSystemctl(active=False)
        with enroll.paused_service(systemctl):
            pass
        assert systemctl.calls == ["is-active"]


def mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_private_wav_is_readable_by_the_owner_only(tmp_path: Path) -> None:
    folder = tmp_path / "voice"
    path = command.save_private_wav(folder, "sample.wav", b"\x01\x00" * 1600)
    assert (mode(folder), mode(path)) == (0o700, 0o600)
    with wave.open(str(path), "rb") as wav:
        assert wav.getframerate() == command.SAMPLE_RATE and wav.getnframes() == 1600


class StubVerifier:
    def __init__(self, verdict: Verdict) -> None:
        self.verdict = verdict

    def check(self, pcm: bytes) -> Verdict:
        return self.verdict


class StubTranscriber:
    def transcribe(self, pcm: bytes, on_delta) -> str:
        return "Friday, stop the music."


@pytest.mark.skipif(not (ESPEAK and FFMPEG), reason="espeak-ng and ffmpeg required")
class TestVoiceSampleLog:
    def feed_command(self, session: command.CommandSession, tmp_path: Path) -> None:
        import test_command

        session.begin(b"", wake_audio=test_command.speech("Friday", tmp_path))
        test_command.feed_all(session, test_command.speech("stop the music", tmp_path) + test_command.silence(2))

    def test_off_by_default(self, tmp_path: Path) -> None:
        verifier = StubVerifier(Verdict(True, 0.7))
        session = command.CommandSession(StubTranscriber(), lambda _e: None, verifier=verifier, synchronous=True)
        self.feed_command(session, tmp_path)
        assert sorted(p.name for p in tmp_path.iterdir()) == ["raw.wav", "s.wav"]  # only the test's own speech

    def test_saves_the_exact_audio_that_was_scored(self, tmp_path: Path) -> None:
        """Opt-in (FRIDAY_VOICE_LOG): lets the owner tune the threshold on their own voice."""
        log = tmp_path / "log"
        session = command.CommandSession(
            StubTranscriber(),
            lambda _e: None,
            verifier=StubVerifier(Verdict(False, 0.412)),
            synchronous=True,
            voice_log=log,
        )
        self.feed_command(session, tmp_path)
        (saved,) = log.glob("*.wav")
        assert saved.name.endswith("-1-rejected-0.412.wav")
        assert mode(saved) == 0o600


@pytest.mark.skipif(not FFMPEG or not enroll.DEFAULT_SPEAKER_MODEL.is_file(), reason="speaker model or ffmpeg missing")
def test_enroll_can_save_its_samples(tmp_path: Path) -> None:
    wavs = []
    for clip in sorted(SPEAKERS.glob("a-enroll-*.flac")):
        out = tmp_path / f"{clip.stem}.wav"
        subprocess.run([FFMPEG, "-loglevel", "error", "-i", str(clip), "-ar", "16000", "-ac", "1", str(out)], check=True)
        wavs.append(out)
    samples = tmp_path / "samples"
    script = str(Path(enroll.__file__))
    result = subprocess.run(
        [sys.executable, script, "--out", str(tmp_path / "vp.json"), "--save", str(samples), "--wav", *map(str, wavs)],
        capture_output=True,
        text=True,
        env={**os.environ, "FRIDAY_SPEAKER_THRESHOLD": ""},
        check=False,  # asserted below with stderr
    )
    assert result.returncode == 0, result.stderr
    saved = sorted(samples.glob("*.wav"))
    assert len(saved) == len(wavs)
    assert all(mode(p) == 0o600 for p in saved)
