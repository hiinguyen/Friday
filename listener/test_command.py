"""Tests for command capture (endpointing) and transcription."""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import wave
from pathlib import Path
from types import SimpleNamespace

import pytest

import command
from speaker import Verdict, VoiceprintError

ESPEAK = shutil.which("espeak-ng")
FFMPEG = shutil.which("ffmpeg")
needs_tts = pytest.mark.skipif(not (ESPEAK and FFMPEG), reason="espeak-ng and ffmpeg required")
live_api = pytest.mark.skipif(
    os.environ.get("FRIDAY_LIVE_API") != "1", reason="set FRIDAY_LIVE_API=1 to call the real OpenAI API"
)

CHUNK = 1600  # matches wake.CHUNK_BYTES


def silence(seconds: float) -> bytes:
    return bytes(int(command.SAMPLE_RATE * seconds) * 2)


def speech(text: str, tmp_path: Path) -> bytes:
    raw, out = tmp_path / "raw.wav", tmp_path / "s.wav"
    subprocess.run([ESPEAK, "-v", "en-us", "-s", "155", "-w", str(raw), text], check=True)
    subprocess.run(
        [FFMPEG, "-loglevel", "error", "-y", "-i", str(raw), "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", str(out)],
        check=True,
    )
    with wave.open(str(out), "rb") as wav:
        return wav.readframes(wav.getnframes())


def run(endpointer: command.Endpointer, audio: bytes) -> str | None:
    for i in range(0, len(audio), CHUNK):
        if (reason := endpointer.feed(audio[i : i + CHUNK])) is not None:
            return reason
    return None


def feed_all(session: command.CommandSession, audio: bytes) -> None:
    for i in range(0, len(audio), CHUNK):
        if not session.feed(audio[i : i + CHUNK]):
            return


class TestStripWakePhrase:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("Friday, open the browser.", "open the browser."),
            ("Hey Friday. What time is it?", "What time is it?"),
            ("friday mở Chrome", "mở Chrome"),
            ("Friday.", ""),
            ("Open the browser", "Open the browser"),
            ("I will see you on Friday", "I will see you on Friday"),
            ("  ", ""),
        ],
    )
    def test_strips_only_a_leading_wake_phrase(self, text: str, expected: str) -> None:
        assert command.strip_wake_phrase(text) == expected


class TestEndpointer:
    def test_no_speech_times_out(self) -> None:
        ep = command.Endpointer()
        assert run(ep, silence(command.NO_SPEECH_TIMEOUT_S + 1)) == "nospeech"
        assert not ep.heard_speech

    def test_preroll_is_kept_in_audio(self) -> None:
        ep = command.Endpointer(preroll=b"\x01\x00" * 100)
        run(ep, silence(command.NO_SPEECH_TIMEOUT_S + 1))
        assert ep.audio.startswith(b"\x01\x00" * 100)

    @needs_tts
    def test_command_already_in_preroll_is_not_dropped(self, tmp_path: Path) -> None:
        """'Friday stop': the wake fires late, so the short command is entirely in the pre-roll."""
        ep = command.Endpointer(preroll=speech("stop the music", tmp_path))
        assert run(ep, silence(3)) == "silence"
        assert ep.heard_speech

    @needs_tts
    def test_ends_after_trailing_silence(self, tmp_path: Path) -> None:
        said = speech("open the browser and play some music", tmp_path)
        ep = command.Endpointer()
        assert run(ep, silence(0.5) + said + silence(3)) == "silence"
        assert ep.heard_speech
        # Ends roughly END_SILENCE_S after the speech, not at the end of the input.
        captured_s = len(ep.audio) / (2 * command.SAMPLE_RATE)
        spoken_s = 0.5 + len(said) / (2 * command.SAMPLE_RATE)
        assert spoken_s < captured_s < spoken_s + command.END_SILENCE_S + 0.6

    @needs_tts
    def test_waits_for_a_command_after_a_pause(self, tmp_path: Path) -> None:
        """'Friday ... <pause> ... open the browser': the pause before speech must not end capture."""
        said = speech("open the browser", tmp_path)
        ep = command.Endpointer()
        assert run(ep, silence(2.5) + said + silence(3)) == "silence"
        assert len(ep.audio) > len(said)

    @needs_tts
    def test_speech_keeps_only_voiced_frames(self, tmp_path: Path) -> None:
        """Speaker verification scores the voice, not the pauses around it."""
        said = speech("open the browser and play some music", tmp_path)
        ep = command.Endpointer(preroll=silence(0.5))
        run(ep, silence(1.0) + said + silence(3))
        assert 0.6 * len(said) < len(ep.speech) <= len(said)
        assert len(ep.speech) % command.FRAME_BYTES == 0

    @needs_tts
    def test_speech_includes_voiced_preroll(self, tmp_path: Path) -> None:
        said = speech("stop the music", tmp_path)
        ep = command.Endpointer(preroll=said)
        assert len(ep.speech) > 0.6 * len(said)

    @needs_tts
    def test_long_speech_is_capped(self, tmp_path: Path) -> None:
        said = speech("one two three four five six seven eight nine ten " * 6, tmp_path)
        assert len(said) / (2 * command.SAMPLE_RATE) > command.MAX_CAPTURE_S
        assert run(command.Endpointer(), said) == "maxlength"


@needs_tts
def test_voiced_audio_drops_silence(tmp_path: Path) -> None:
    said = speech("what is the weather today", tmp_path)
    voiced = command.voiced_audio(silence(1.0) + said + silence(1.0))
    assert 0.6 * len(said) < len(voiced) <= len(said)
    assert command.voiced_audio(silence(2.0)) == b""


def test_wav_bytes_round_trip() -> None:
    pcm = b"\x10\x00\x20\x00" * 50
    with wave.open(io.BytesIO(command.wav_bytes(pcm)), "rb") as wav:
        assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (16000, 1, 2)
        assert wav.readframes(wav.getnframes()) == pcm


class FakeTranscriptions:
    def __init__(self, events):
        self.events = events
        self.kwargs = None

    def create(self, **kwargs):
        self.kwargs = kwargs
        if isinstance(self.events, Exception):
            raise self.events
        return iter(self.events)


def fake_client(events) -> SimpleNamespace:
    return SimpleNamespace(audio=SimpleNamespace(transcriptions=FakeTranscriptions(events)))


class TestTranscriber:
    def test_streams_deltas_then_returns_final_text(self) -> None:
        client = fake_client(
            [
                SimpleNamespace(type="transcript.text.delta", delta="Friday, open"),
                SimpleNamespace(type="transcript.text.delta", delta=" the browser."),
                SimpleNamespace(type="transcript.text.done", text="Friday, open the browser."),
            ]
        )
        deltas: list[str] = []
        text = command.Transcriber(client, model="gpt-transcribe").transcribe(silence(0.2), deltas.append)
        assert deltas == ["Friday, open", " the browser."]
        assert text == "Friday, open the browser."
        sent = client.audio.transcriptions.kwargs
        assert sent["model"] == "gpt-transcribe" and sent["stream"] is True
        name, data, mime = sent["file"]
        assert name.endswith(".wav") and mime == "audio/wav" and data.startswith(b"RIFF")
        assert "language" not in sent

    def test_language_hint_is_forwarded(self) -> None:
        client = fake_client([SimpleNamespace(type="transcript.text.done", text="xin chào")])
        command.Transcriber(client, model="m", language="vi").transcribe(silence(0.2), lambda _d: None)
        assert client.audio.transcriptions.kwargs["language"] == "vi"

    @pytest.mark.parametrize(("setting", "expected"), [(None, "vi"), ("", "vi"), ("en", "en"), ("AUTO", None)])
    def test_language_setting(self, setting, expected) -> None:
        assert command.stt_language(setting) == expected

    def test_missing_done_event_falls_back_to_joined_deltas(self) -> None:
        client = fake_client([SimpleNamespace(type="transcript.text.delta", delta="hello")])
        assert command.Transcriber(client, model="m").transcribe(silence(0.2), lambda _d: None) == "hello"

    def test_api_errors_propagate(self) -> None:
        client = fake_client(RuntimeError("401 invalid key"))
        with pytest.raises(RuntimeError, match="401"):
            command.Transcriber(client, model="m").transcribe(silence(0.2), lambda _d: None)


def test_api_client_survives_a_broken_ipv6_route(monkeypatch) -> None:
    """Regression: on a network with a dead IPv6 route a command took about a minute to transcribe."""
    import network

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    transcriber = command.build_transcriber()
    client = transcriber._client
    assert isinstance(client._client._transport, network.FallbackTransport)
    assert client.timeout.connect == command.CONNECT_TIMEOUT_S < command.API_TIMEOUT_S


def test_api_client_keeps_a_configured_proxy(monkeypatch) -> None:
    """A custom transport makes httpx ignore HTTPS_PROXY; behind a proxy the proxy decides the route."""
    import network

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.local:3128")
    client = command.build_transcriber()._client
    assert not isinstance(client._client._transport, network.FallbackTransport)
    assert any(t is not None for t in client._client._mounts.values())


class StubTranscriber:
    def __init__(self, text: str = "Friday, open the browser.", error: Exception | None = None) -> None:
        self.text, self.error, self.calls = text, error, 0

    def transcribe(self, pcm: bytes, on_delta) -> str:
        self.calls += 1
        if self.error:
            raise self.error
        on_delta(self.text)
        return self.text


class StubVerifier:
    def __init__(self, score: float = 0.8, threshold: float = 0.45, error: Exception | None = None) -> None:
        self.score, self.threshold, self.error = score, threshold, error
        self.samples: list[bytes] = []

    def check(self, pcm: bytes) -> Verdict:
        self.samples.append(pcm)
        if self.error:
            raise self.error
        if self.score is None:
            return Verdict(False, 0.0, unclear=True)
        return Verdict(self.score >= self.threshold, self.score)


def make_session(transcriber, verifier=None) -> tuple[command.CommandSession, list[dict]]:
    events: list[dict] = []
    return command.CommandSession(transcriber, events.append, verifier=verifier, synchronous=True), events


class TestCommandSession:
    """wake -> capture -> transcription events, with a stubbed transcriber."""

    @needs_tts
    def test_full_command_flow(self, tmp_path: Path) -> None:
        session, events = make_session(StubTranscriber())
        session.begin(b"")
        feed_all(session, silence(0.3) + speech("open the browser", tmp_path) + silence(2))
        states = [(e["type"], e.get("state")) for e in events]
        assert states[0] == ("capture", "listening")
        assert ("capture", "processing") in states
        final = events[-1]
        assert final["type"] == "transcript" and final["final"] is True
        assert final["text"] == "open the browser."
        assert final["raw"] == "Friday, open the browser."
        assert {e["id"] for e in events} == {1}
        assert not session.active

    def test_silence_reports_no_command_and_skips_api(self) -> None:
        stub = StubTranscriber()
        session, events = make_session(stub)
        session.begin(b"")
        feed_all(session, silence(command.NO_SPEECH_TIMEOUT_S + 1))
        assert events[-1] == {"type": "capture", "id": 1, "state": "empty"}
        assert stub.calls == 0
        assert not session.active

    @needs_tts
    def test_api_failure_is_reported(self, tmp_path: Path) -> None:
        session, events = make_session(StubTranscriber(error=RuntimeError("boom")))
        session.begin(b"")
        feed_all(session, speech("open the browser", tmp_path) + silence(2))
        assert events[-1]["type"] == "transcript" and "boom" in events[-1]["error"]

    def test_without_transcriber_reports_configuration_error(self) -> None:
        session, events = make_session(None)
        session.begin(b"")
        assert not session.active
        assert events == [{"type": "transcript", "id": 1, "error": "OPENAI_API_KEY is not set"}]

    def test_cancel_reports_the_capture_as_cancelled(self) -> None:
        """A mic restart mid-command must not leave the HUD waiting forever."""
        session, events = make_session(StubTranscriber())
        session.begin(b"")
        session.cancel()
        assert events[-1] == {"type": "capture", "id": 1, "state": "cancelled"}
        session.cancel()  # idle: nothing to report
        assert len(events) == 2

    @needs_tts
    def test_enrolled_voice_is_verified_then_transcribed(self, tmp_path: Path) -> None:
        stt, voice = StubTranscriber(), StubVerifier(score=0.8)
        session, events = make_session(stt, voice)
        wake_word = speech("Friday", tmp_path)
        session.begin(b"", wake_audio=wake_word)
        feed_all(session, silence(0.5) + speech("open the browser", tmp_path) + silence(2))
        states = [e.get("state") for e in events if e["type"] == "capture"]
        assert states == ["listening", "processing", "verified"]
        assert next(e for e in events if e.get("state") == "verified")["score"] == 0.8
        assert events[-1]["final"] is True and stt.calls == 1
        # The voice is judged on the wake word plus the spoken frames, without the silences.
        (sample,) = voice.samples
        assert sample.startswith(wake_word)
        assert len(sample) < len(wake_word) + len(speech("open the browser", tmp_path))

    @needs_tts
    def test_other_voice_is_rejected_and_never_sent(self, tmp_path: Path) -> None:
        stt = StubTranscriber()
        session, events = make_session(stt, StubVerifier(score=0.12))
        session.begin(b"")
        feed_all(session, speech("open the browser", tmp_path) + silence(2))
        assert events[-1] == {"type": "capture", "id": 1, "state": "rejected", "score": 0.12}
        assert stt.calls == 0
        assert not session.active

    @needs_tts
    def test_broken_voiceprint_fails_closed(self, tmp_path: Path) -> None:
        stt = StubTranscriber()
        session, events = make_session(stt, StubVerifier(error=VoiceprintError("file is corrupt; re-enroll")))
        session.begin(b"")
        feed_all(session, speech("open the browser", tmp_path) + silence(2))
        assert events[-1] == {"type": "capture", "id": 1, "state": "rejected", "error": "file is corrupt; re-enroll"}
        assert stt.calls == 0

    @needs_tts
    def test_a_long_command_must_match_on_its_own(self, tmp_path: Path) -> None:
        """The owner saying "Friday" must not vouch for someone else speaking the command."""
        voice = StubVerifier(score=0.8)
        session, _events = make_session(StubTranscriber(), voice)
        wake_word = speech("Friday", tmp_path)
        session.begin(b"", wake_audio=wake_word)
        order = speech("open the browser and play some relaxing music in the kitchen", tmp_path)
        feed_all(session, order + silence(2))
        (sample,) = voice.samples
        assert not sample.startswith(wake_word)
        assert len(sample) / (2 * command.SAMPLE_RATE) >= command.SOLO_VERIFY_S

    @needs_tts
    def test_too_little_voice_is_reported_as_unclear(self, tmp_path: Path) -> None:
        stt = StubTranscriber()
        session, events = make_session(stt, StubVerifier(score=None))
        session.begin(b"")
        feed_all(session, speech("stop", tmp_path) + silence(2))
        assert events[-1] == {"type": "capture", "id": 1, "state": "unclear"}
        assert stt.calls == 0

    def test_reports_its_voiceprint_state(self) -> None:
        from speaker import UnusableVerifier

        assert make_session(StubTranscriber())[0].voiceprint == "off"
        assert make_session(StubTranscriber(), StubVerifier())[0].voiceprint == "armed"
        assert make_session(StubTranscriber(), UnusableVerifier("file is corrupt; re-enroll"))[0].voiceprint == "unusable"

    def test_ids_increase_per_capture(self) -> None:
        session, events = make_session(StubTranscriber())
        session.begin(b"")
        session.cancel()
        session.begin(b"")
        assert [e["id"] for e in events if e.get("state") == "listening"] == [1, 2]


@live_api
@needs_tts
def test_live_openai_transcription(tmp_path: Path) -> None:
    transcriber = command.build_transcriber()
    assert transcriber is not None, "OPENAI_API_KEY missing"
    deltas: list[str] = []
    text = transcriber.transcribe(speech("open the browser", tmp_path), deltas.append)
    assert "browser" in text.lower()
    assert deltas
