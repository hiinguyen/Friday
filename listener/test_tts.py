"""Tests for speaking replies: what gets read aloud, sentence streaming, and interrupting speech."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

import tts

LISTENER = Path(__file__).resolve().parent


def stream(text: str, size: int = 3) -> list[str]:
    """Feed text the way the agent streams it: in small, arbitrary pieces."""
    splitter = tts.SentenceSplitter()
    sentences = []
    for start in range(0, len(text), size):
        sentences += splitter.feed(text[start : start + size])
    return sentences + splitter.flush()


class TestCleanForSpeech:
    def test_drops_markdown_and_keeps_the_words(self) -> None:
        assert tts.clean_for_speech("## **Done**: opened `firefox` for _you_") == "Done: opened firefox for _you_"

    def test_reads_link_labels_and_drops_urls(self) -> None:
        text = "See [the docs](https://example.com/a) or https://example.com/b now."
        assert tts.clean_for_speech(text) == "See the docs or now."

    def test_drops_list_and_quote_markers(self) -> None:
        assert tts.clean_for_speech("- [x] buy milk") == "buy milk"
        assert tts.clean_for_speech("> quoted") == "quoted"
        assert tts.clean_for_speech("2. second step") == "second step"


class TestIsVietnamese:
    @pytest.mark.parametrize(
        "text",
        [
            "Đã mở Firefox.",
            "Hôm nay trời đẹp",
            "Tôi đã bật nhạc",
            "Mở trình duyệt",
            "Bật đèn",
            "Vâng",
            "Tôi là Friday.",
            "Cảm ơn anh.",
            "Ăn sáng chưa?",
        ],
    )
    def test_vietnamese(self, text: str) -> None:
        assert tts.is_vietnamese(text)

    @pytest.mark.parametrize(
        "text",
        [
            "I opened Firefox.",
            "Meet me at the café.",
            "That was a naïve idea.",
            "Please send your résumé.",
            "I made crêpes for dinner.",
            "Stay at the Hôtel de Ville.",
            "Déjà vu.",
            "Café.",
            "Erdoğan spoke today.",
        ],
    )
    def test_english_even_with_a_loanword(self, text: str) -> None:
        assert not tts.is_vietnamese(text)


class TestSentenceSplitter:
    def test_yields_each_sentence_as_soon_as_it_ends(self) -> None:
        splitter = tts.SentenceSplitter()
        assert splitter.feed("Sure. I opened") == ["Sure."]
        assert splitter.feed(" Firefox! What") == ["I opened Firefox!"]
        assert splitter.flush() == ["What"]

    def test_streamed_pieces_give_the_same_sentences(self) -> None:
        text = "Done. The meeting is at 3.30 pm today! Anything else?"
        assert stream(text) == ["Done.", "The meeting is at 3.30 pm today!", "Anything else?"]

    def test_abbreviations_and_list_numbers_do_not_end_a_sentence(self) -> None:
        text = "Ask Dr. Strange, e.g. tomorrow.\n1. Open the door.\n2. Close it."
        assert stream(text) == ["Ask Dr. Strange, e.g. tomorrow.", "Open the door.", "Close it."]

    def test_skips_code_blocks_even_when_the_fence_arrives_in_pieces(self) -> None:
        text = "Run this:\n```bash\nrm -rf build. && make\n```\nThen restart it."
        assert stream(text, size=2) == ["Run this:", "Then restart it."]

    def test_an_unterminated_code_block_is_never_read(self) -> None:
        assert stream("Here:\n```python\nprint('hi there. ok')") == ["Here:"]

    def test_lines_without_punctuation_are_separate_sentences(self) -> None:
        assert stream("# Weather\n- Sunny\n- 28 degrees") == ["Weather", "Sunny", "28 degrees"]

    def test_markup_only_pieces_are_not_spoken(self) -> None:
        assert stream("---\n| a | b |\n|---|---|\n...") == ["a b"]

    def test_a_long_run_without_punctuation_is_cut_at_spaces(self) -> None:
        words = " ".join(["word"] * 200)
        sentences = tts.SentenceSplitter().feed(words)
        assert len(sentences) == 2
        assert all(len(s) <= tts.MAX_SENTENCE_CHARS for s in sentences)


class FakePlayer:
    def __init__(self, log: list) -> None:
        self.log = log
        self.killed = False
        self.audio = b""

    def write(self, pcm: bytes) -> None:
        if self.killed:
            raise BrokenPipeError
        self.audio += pcm

    def close(self) -> None:
        self.log.append(("close", self.audio, self.killed))

    def kill(self) -> None:
        self.killed = True


class DrainingPlayer(FakePlayer):
    """close() plays out what is buffered: it returns only once killed (or after 5 s)."""

    def __init__(self, log: list, draining: threading.Event) -> None:
        super().__init__(log)
        self.draining = draining
        self.stopped = threading.Event()

    def close(self) -> None:
        self.draining.set()
        self.stopped.wait(5)
        super().close()

    def kill(self) -> None:
        super().kill()
        self.stopped.set()


class Harness:
    """A Speaker with fake synthesis (one chunk per word) and fake players."""

    def __init__(self, gate: threading.Event | None = None, draining: threading.Event | None = None) -> None:
        self.events: list[dict] = []
        self.players: list[tuple] = []
        self.spoken: list[str] = []
        self.started = threading.Event()
        self.gate = gate
        self.draining = draining
        self.speaker = tts.Speaker(self.synthesize, self.open_player, self.events.append)

    def synthesize(self, text: str, stop: threading.Event) -> Iterator[bytes]:
        self.spoken.append(text)
        self.started.set()
        for word in text.split():
            if self.gate is not None:
                self.gate.wait(5)
            if stop.is_set():
                return
            yield word.encode() + b" "

    def open_player(self) -> FakePlayer:
        if self.draining is not None:
            return DrainingPlayer(self.players, self.draining)
        return FakePlayer(self.players)

    def settle(self) -> None:
        assert self.speaker.wait(5)

    def states(self) -> list[tuple]:
        return [(e["id"], e["state"]) for e in self.events if e["type"] == "speech"]


class TestSpeaker:
    def test_speaks_a_streamed_reply_in_one_player_and_reports_it(self) -> None:
        h = Harness()
        h.speaker.say(1, "Sure. Opening")
        h.speaker.say(1, " Firefox now.")
        h.speaker.end(1)
        h.settle()
        assert h.spoken == ["Sure.", "Opening Firefox now."]
        assert h.players == [("close", b"Sure. Opening Firefox now. ", False)]
        assert h.states() == [(1, "speaking"), (1, "done")]
        h.speaker.close()

    def test_cancel_stops_mid_sentence_and_still_reports_done(self) -> None:
        """A cancel with nothing queued must not leave the HUD thinking she is still talking."""
        gate = threading.Event()
        h = Harness(gate)
        h.speaker.say(1, "One two three four five. ")
        assert h.started.wait(5)
        h.speaker.cancel()
        gate.set()
        h.settle()
        assert h.players == [("close", b"", True)]
        assert h.states() == [(1, "speaking"), (1, "done")]
        h.speaker.close()

    def test_a_newer_reply_silences_the_older_one(self) -> None:
        gate = threading.Event()
        h = Harness(gate)
        h.speaker.say(1, "A long answer to the first question. ")
        assert h.started.wait(5)
        h.speaker.say(2, "Second.")
        h.speaker.end(2)
        gate.set()
        h.settle()
        assert h.states() == [(1, "speaking"), (1, "done"), (2, "speaking"), (2, "done")]
        assert h.spoken[-1] == "Second."
        h.speaker.close()

    def test_cancel_stops_a_reply_that_is_playing_out(self) -> None:
        """Saying "Friday" while the last sentence drains must silence it, not record over it."""
        draining = threading.Event()
        h = Harness(draining=draining)
        h.speaker.say(1, "All done.")
        h.speaker.end(1)
        assert draining.wait(5)
        started = time.monotonic()
        h.speaker.cancel()
        h.settle()
        assert time.monotonic() - started < 2
        assert h.players == [("close", b"All done. ", True)]
        assert h.states() == [(1, "speaking"), (1, "done")]
        h.speaker.close()

    def test_the_rest_of_a_cancelled_reply_is_never_spoken(self) -> None:
        """Dismissing the HUD mid-reply: the agent's next pieces must not start her talking again."""
        gate = threading.Event()
        h = Harness(gate)
        h.speaker.say(1, "First sentence. ")
        assert h.started.wait(5)
        h.speaker.cancel()
        gate.set()
        h.speaker.say(1, "Second sentence. ")
        h.speaker.end(1)
        h.settle()
        assert h.spoken == ["First sentence."]
        assert h.states() == [(1, "speaking"), (1, "done")]
        h.speaker.say(2, "Next reply.")
        h.speaker.end(2)
        h.settle()
        assert h.spoken[-1] == "Next reply."
        h.speaker.close()

    def test_late_pieces_of_a_cancelled_reply_are_dropped(self) -> None:
        h = Harness()
        h.speaker.say(1, "Hello")
        h.speaker.cancel()
        h.speaker.end(1)  # the agent finished after the user said "Friday" again
        h.settle()
        assert h.spoken == []
        assert h.states() == []
        h.speaker.close()

    def test_vietnamese_sentences_are_skipped_once_per_reply(self) -> None:
        h = Harness()
        h.speaker.say(1, "Đã mở Firefox. Đã bật nhạc. Done.")
        h.speaker.end(1)
        h.settle()
        assert h.spoken == ["Done."]
        assert h.states() == [(1, "skipped"), (1, "speaking"), (1, "done")]
        h.speaker.close()

    def test_a_reply_with_nothing_speakable_opens_no_player(self) -> None:
        h = Harness()
        h.speaker.say(1, "```\ncode only\n```")
        h.speaker.end(1)
        h.settle()
        assert h.players == []
        assert h.states() == []
        h.speaker.close()

    def test_a_synthesis_failure_is_reported_and_the_next_reply_still_plays(self) -> None:
        h = Harness()
        fine = h.synthesize

        def flaky(text: str, stop: threading.Event) -> Iterator[bytes]:
            if text == "Broken.":
                raise RuntimeError("bad tokens")
            yield from fine(text, stop)

        h.speaker._synthesize = flaky
        h.speaker.say(1, "Broken.")
        h.speaker.end(1)
        h.settle()  # otherwise reply 2 would rightly cancel reply 1 before it is tried
        h.speaker.say(2, "Fine.")
        h.speaker.end(2)
        h.settle()
        errors = [e["message"] for e in h.events if e["type"] == "error"]
        assert errors == ["speech synthesis failed: bad tokens"]
        assert h.states()[-2:] == [(2, "speaking"), (2, "done")]
        h.speaker.close()


class TestCommands:
    def test_malformed_commands_are_logged_not_fatal(self, capsys: pytest.CaptureFixture[str]) -> None:
        h = Harness()
        tts.serve(h.speaker, iter(['{"type": "say"}\n', "not json\n", '{"type": "dance"}\n', "\n"]))
        h.speaker.close()
        err = capsys.readouterr().err
        assert err.count("bad command") == 2
        assert "unknown command" in err

    def test_commands_drive_the_speaker(self) -> None:
        h = Harness()
        lines = [json.dumps({"type": "say", "id": 4, "text": "Hi there."}), json.dumps({"type": "end", "id": 4})]
        tts.serve(h.speaker, iter(lines))
        h.settle()
        assert h.spoken == ["Hi there."]
        h.speaker.close()


def run_worker(env: dict[str, str]) -> list[dict]:
    result = subprocess.run(
        [sys.executable, str(LISTENER / "tts.py")],
        input="",
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, **env},
        check=True,
    )
    return [json.loads(line) for line in result.stdout.splitlines()]


class TestProcess:
    def test_without_a_voice_the_worker_reports_disabled_and_exits(self, tmp_path: Path) -> None:
        events = run_worker({"FRIDAY_TTS_VOICE": str(tmp_path / "missing.safetensors")})
        assert [e["type"] for e in events] == ["disabled"]
        assert "bin/friday voice" in events[0]["reason"]

    def test_friday_tts_off_disables_speech(self) -> None:
        assert run_worker({"FRIDAY_TTS": "off"}) == [{"type": "disabled", "reason": "FRIDAY_TTS is off"}]


@pytest.mark.skipif(not tts.voice_path().is_file(), reason="no cloned voice (bin/friday voice AUDIO)")
class TestPocketVoice:
    def test_synthesizes_pcm_in_the_cloned_voice(self) -> None:
        voice = tts.PocketVoice(tts.voice_path())
        pcm = b"".join(voice.synthesize("Hello there.", threading.Event()))
        seconds = len(pcm) / 2 / voice.sample_rate
        assert voice.sample_rate == 24000
        assert 0.3 < seconds < 5, seconds
