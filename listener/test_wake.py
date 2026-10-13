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

    def test_wake_word_end_from_final_and_partial(self) -> None:
        final = json.dumps({"result": [{"word": "friday", "conf": 1.0, "start": 0.5, "end": 1.14}]})
        partial = json.dumps({"partial": "friday [unk]", "partial_result": [{"word": "friday", "start": 0.4, "end": 0.9}]})
        assert wake.wake_word_end(final) == pytest.approx(1.14)
        assert wake.wake_word_end(partial) == pytest.approx(0.9)
        assert wake.wake_word_end(json.dumps({"partial": "fried"})) is None

    def test_wake_word_span(self) -> None:
        final = json.dumps({"result": [{"word": "hey", "start": 0.1, "end": 0.4}, {"word": "friday", "start": 0.5, "end": 1.14}]})
        assert wake.wake_word_span(final) == pytest.approx((0.5, 1.14))
        assert wake.wake_word_span(json.dumps({"result": [{"word": "friday"}]})) is None

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



class TestCommandPreroll:
    def test_keeps_only_audio_after_the_wake_word(self) -> None:
        recent = bytes(range(10)) * 3200  # 1 s
        assert wake.command_preroll(recent, 0.25) == recent[-8000:]

    def test_unknown_timing_keeps_everything(self) -> None:
        assert wake.command_preroll(b"abcd", None) == b"abcd"

    def test_clamps_to_available_audio(self) -> None:
        assert wake.command_preroll(b"abcd", 9.0) == b"abcd"
        assert wake.command_preroll(b"abcd", 0.0) == b""


class TestWakeWordAudio:
    def test_slices_out_the_spoken_wake_word(self) -> None:
        recent = bytes(range(10)) * 3200  # 1 s
        assert wake.wake_word_audio(recent, (0.75, 0.25)) == recent[8000:24000]

    def test_unknown_timing_gives_nothing(self) -> None:
        assert wake.wake_word_audio(b"abcd", None) == b""

    def test_clamps_to_available_audio(self) -> None:
        assert wake.wake_word_audio(b"abcd", (9.0, 0.0)) == b"abcd"


def test_ready_event_says_whether_voices_are_verified() -> None:
    from command import CommandSession
    from speaker import UnusableVerifier

    def ready(verifier) -> dict:
        return wake.ready_event(CommandSession(None, lambda _e: None, verifier=verifier))

    assert ready(None) == {"type": "ready", "voiceprint": "off"}
    assert ready(object()) == {"type": "ready", "voiceprint": "armed"}
    assert ready(UnusableVerifier("outdated format; re-enroll")) == {"type": "ready", "voiceprint": "unusable"}


def source(name: str, api: str, media_class: str = "Audio/Source", priority: int = 2000) -> dict:
    return {
        "name": name,
        "properties": {"device.api": api, "media.class": media_class, "priority.session": str(priority)},
    }


LAPTOP_MIC = source("alsa_input.pci-0000_05_00.6.analog-stereo", "alsa", priority=2009)
BT_MIC = source("bluez_input.E8:9E:13:C5:0A:B7", "bluez5", priority=2010)
USB_MIC = source("alsa_input.usb-Blue_Yeti-00.analog-stereo", "alsa", priority=2100)
SPEAKER_MONITOR = source("alsa_output.pci-0000_05_00.6.analog-stereo.monitor", "alsa", "Audio/Sink", 1009)


class TestPickSource:
    """Recording from a Bluetooth mic forces the headset into the low-quality
    HFP call profile for as long as the stream is open, so the always-on
    listener must never pick one implicitly."""

    def test_skips_bluetooth_default_and_uses_builtin_mic(self) -> None:
        assert wake.pick_source([SPEAKER_MONITOR, LAPTOP_MIC, BT_MIC], BT_MIC["name"]) == LAPTOP_MIC["name"]

    def test_uses_default_when_it_is_not_bluetooth(self) -> None:
        assert wake.pick_source([LAPTOP_MIC, USB_MIC, BT_MIC], LAPTOP_MIC["name"]) == LAPTOP_MIC["name"]

    def test_prefers_highest_priority_when_default_is_ineligible(self) -> None:
        assert wake.pick_source([LAPTOP_MIC, USB_MIC, BT_MIC], BT_MIC["name"]) == USB_MIC["name"]

    def test_never_records_monitors(self) -> None:
        assert wake.pick_source([SPEAKER_MONITOR], SPEAKER_MONITOR["name"]) is None

    def test_none_when_only_bluetooth_mics_exist(self) -> None:
        assert wake.pick_source([BT_MIC], BT_MIC["name"]) is None


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


class RecordingTranscriber:
    def __init__(self) -> None:
        self.audio: list[bytes] = []

    def transcribe(self, pcm: bytes, on_delta) -> str:
        self.audio.append(pcm)
        return "Friday, open the browser."


class RecordingVerifier:
    def __init__(self) -> None:
        self.samples: list[bytes] = []

    def check(self, pcm: bytes):
        from speaker import Verdict

        self.samples.append(pcm)
        return Verdict(True, 0.9)


@needs_tts
@needs_model
@pytest.mark.parametrize("pause", [0.0, 1.5])
def test_wake_then_command_is_captured_and_transcribed(model, tmp_path: Path, monkeypatch, pause: float) -> None:
    """'Friday, open the browser' said in one breath, or with a pause after the wake word."""
    from command import CommandSession

    events: list[dict] = []
    monkeypatch.setattr(wake, "emit", events.append)
    stt, voice = RecordingTranscriber(), RecordingVerifier()
    session = CommandSession(stt, events.append, verifier=voice, synchronous=True)
    detector = wake.WakeDetector(model, wake.DEFAULT_MIN_CONF)
    friday = wav_bytes(synthesize("Friday", tmp_path / "w.wav", "en-us"))
    order = wav_bytes(synthesize("open the browser", tmp_path / "c.wav", "en-us"))
    stream = silence(0.5) + friday + silence(pause) + order + silence(2.0)

    wake.process(detector, session, (stream[i : i + wake.CHUNK_BYTES] for i in range(0, len(stream), wake.CHUNK_BYTES)))

    events = [e for e in events if e["type"] != "level"]
    assert [e["type"] for e in events].count("wake") == 1
    assert [e.get("state") for e in events if e["type"] == "capture"] == ["listening", "processing", "verified"]
    # The speaker is judged on the spoken "Friday" as well as the order: more
    # voice makes short commands ("Friday, stop") verifiable.
    (sample,) = voice.samples
    assert len(detections_in(sample, model)) == 1
    assert len(sample) > 0.7 * len(friday) + 0.6 * len(order)
    assert events[-1] == {"type": "transcript", "id": 1, "text": "open the browser.", "raw": "Friday, open the browser.", "final": True}
    # The transcriber gets the whole order but not the wake word: a clipped
    # "Friday" at the start used to be transcribed as a stray word ("Private.").
    assert len(stt.audio) == 1
    captured = stt.audio[0]
    assert len(captured) > len(order)
    assert detections_in(captured, model) == []


def detections_in(audio: bytes, model) -> list[float]:
    return detect_stream(silence(0.3) + audio + silence(1.0), model)


@needs_tts
@needs_model
def test_second_command_is_cut_at_its_own_wake_word(model, tmp_path: Path, monkeypatch) -> None:
    """Regression: Vosk's Reset() does not restart its word clock, so the second
    command was cut at the wrong place and lost its first words."""
    from command import CommandSession

    monkeypatch.setattr(wake, "emit", lambda _e: None)
    stt = RecordingTranscriber()
    session = CommandSession(stt, lambda _e: None, synchronous=True)
    detector = wake.WakeDetector(model, wake.DEFAULT_MIN_CONF)
    said = wav_bytes(synthesize("Friday, open the browser", tmp_path / "a.wav", "en-us"))
    stream = silence(0.5) + said + silence(2.0) + silence(1.7) + said + silence(2.0)

    wake.process(detector, session, (stream[i : i + wake.CHUNK_BYTES] for i in range(0, len(stream), wake.CHUNK_BYTES)))

    assert len(stt.audio) == 2
    first, second = stt.audio
    for captured in (first, second):
        assert detections_in(captured, model) == []
    # Identical utterances must yield (nearly) identical recordings.
    assert abs(len(first) - len(second)) / (2 * wake.SAMPLE_RATE) < 0.1
