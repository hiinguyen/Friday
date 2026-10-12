"""Tests for the wake-word listener.

The end-to-end cases synthesise speech with espeak-ng and run it through the
real Vosk model, so they exercise the same decoder path as the live mic.
"""

from __future__ import annotations

import array
import json
import shutil
import subprocess
import wave
from pathlib import Path

import pytest

import wake

ESPEAK = shutil.which("espeak-ng")
FFMPEG = shutil.which("ffmpeg")
needs_tts = pytest.mark.skipif(not (ESPEAK and FFMPEG), reason="espeak-ng and ffmpeg required")
needs_model = pytest.mark.skipif(not wake.DEFAULT_MODEL.is_dir(), reason="Vosk model not downloaded")

POSITIVE = [
    "Friday",
    "Hey Friday",
    "Friday, open the browser",
    "Friday what time is it",
    "I will see you on Friday",
]
NEGATIVE = [
    "fried eggs for dinner",
    "my friend Freddy",
    "the fridge is free",
    "Today is a fine day",
    "fire in the sky",
    "Monday Tuesday",
    "Hello there how are you",
]


def pcm(samples: list[int]) -> bytes:
    return array.array("h", samples).tobytes()


class TestRmsLevel:
    def test_silence_is_zero(self) -> None:
        assert wake.rms_level(pcm([0] * 800)) == 0.0

    def test_full_scale_is_one(self) -> None:
        assert wake.rms_level(pcm([32767, -32767] * 400)) == pytest.approx(1.0, abs=0.01)

    def test_quiet_signal_is_between(self) -> None:
        level = wake.rms_level(pcm([300, -300] * 400))
        assert 0.1 < level < 0.6

    def test_odd_byte_count_is_tolerated(self) -> None:
        assert wake.rms_level(pcm([1000] * 10) + b"\x00") > 0


class TestResultParsing:
    def test_wake_confidence_found(self) -> None:
        result = json.dumps({"result": [{"word": "hey", "conf": 1.0}, {"word": "friday", "conf": 0.83}]})
        assert wake.wake_confidence(result) == pytest.approx(0.83)

    def test_wake_confidence_absent(self) -> None:
        assert wake.wake_confidence(json.dumps({"result": [{"word": "fried", "conf": 1.0}]})) is None
        assert wake.wake_confidence(json.dumps({"text": ""})) is None

    @pytest.mark.parametrize(
        ("partial", "expected"),
        [
            ("friday", False),  # trailing: decoder may still revise it
            ("hey friday", False),
            ("friday [unk]", True),  # decoder moved past the word
            ("today fine hey friday", False),
            ("fried", False),
            ("", False),
        ],
    )
    def test_partial_commit_rule(self, partial: str, expected: bool) -> None:
        assert wake.partial_has_committed_wake(json.dumps({"partial": partial})) is expected


def synthesize(text: str, out: Path, voice: str) -> Path:
    raw = out.with_suffix(".raw.wav")
    subprocess.run([ESPEAK, "-v", voice, "-s", "155", "-w", str(raw), text], check=True)
    subprocess.run(
        [FFMPEG, "-loglevel", "error", "-y", "-i", str(raw), "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", str(out)],
        check=True,
    )
    return out


def detections(path: Path, model) -> list[float]:
    detector = wake.WakeDetector(model, wake.DEFAULT_MIN_CONF)
    with wave.open(str(path), "rb") as wav:
        frames = wav.readframes(wav.getnframes())
    hits = [
        conf
        for i in range(0, len(frames), wake.CHUNK_BYTES)
        if (conf := detector.feed(frames[i : i + wake.CHUNK_BYTES])) is not None
    ]
    if (conf := detector.flush()) is not None:
        hits.append(conf)
    return hits


@pytest.fixture(scope="module")
def model():
    from vosk import Model, SetLogLevel

    SetLogLevel(-1)
    return Model(str(wake.DEFAULT_MODEL))


@needs_tts
@needs_model
@pytest.mark.parametrize("voice", ["en-us", "en-gb"])
class TestEndToEnd:
    @pytest.mark.parametrize("text", POSITIVE)
    def test_wake_word_fires_exactly_once(self, model, tmp_path: Path, voice: str, text: str) -> None:
        assert len(detections(synthesize(text, tmp_path / "s.wav", voice), model)) == 1

    @pytest.mark.parametrize("text", NEGATIVE)
    def test_similar_speech_does_not_fire(self, model, tmp_path: Path, voice: str, text: str) -> None:
        assert detections(synthesize(text, tmp_path / "s.wav", voice), model) == []


def silence(seconds: float) -> bytes:
    return bytes(int(wake.SAMPLE_RATE * seconds) * 2)


def wav_bytes(path: Path) -> bytes:
    with wave.open(str(path), "rb") as wav:
        return wav.readframes(wav.getnframes())


def detect_stream(audio: bytes, model) -> list[float]:
    detector = wake.WakeDetector(model, wake.DEFAULT_MIN_CONF)
    hits = [
        conf
        for i in range(0, len(audio), wake.CHUNK_BYTES)
        if (conf := detector.feed(audio[i : i + wake.CHUNK_BYTES])) is not None
    ]
    if (conf := detector.flush()) is not None:
        hits.append(conf)
    return hits


@needs_tts
@needs_model
@pytest.mark.parametrize(
    ("first", "second"),
    [
        ("Hey Friday", "Friday run a full diagnostic"),  # first fires on the final result
        ("Friday what time is it", "Friday"),  # first fires on a committed partial
    ],
)
def test_consecutive_wake_utterances_each_fire(model, tmp_path: Path, first: str, second: str) -> None:
    """Regression: a wake fired on the final result used to swallow the NEXT utterance."""
    a = wav_bytes(synthesize(first, tmp_path / "a.wav", "en-us"))
    b = wav_bytes(synthesize(second, tmp_path / "b.wav", "en-us"))
    stream = silence(0.5) + a + silence(2.5) + b + silence(1.0)
    assert len(detect_stream(stream, model)) == 2


@needs_tts
@needs_model
def test_cooldown_is_measured_in_audio_time(model, tmp_path: Path) -> None:
    """Two wake words closer than COOLDOWN_S of audio fire once, even when decoded faster than real time."""
    a = wav_bytes(synthesize("Friday", tmp_path / "a.wav", "en-us"))
    gap = max(0.0, wake.COOLDOWN_S - 1.6)
    assert len(detect_stream(a + silence(gap) + a + silence(1.0), model)) == 1
