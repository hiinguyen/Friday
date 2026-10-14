"""Speak F.R.I.D.A.Y.'s replies in a cloned voice (Kyutai Pocket TTS, offline, on the CPU).

The Electron shell streams the agent's reply in as it arrives, one JSON
command per line on stdin:

    {"type": "say", "id": 3, "text": "Sure, I"}   # the next piece of reply 3
    {"type": "end", "id": 3}                      # reply 3 is complete: speak what is left
    {"type": "cancel"}                            # stop talking now (a new wake, the HUD dismissed)

and gets JSON events back on stdout:

    {"type": "ready", "voice": "/.../models/tts-voice.safetensors"}
    {"type": "disabled", "reason": "..."}         # nothing to speak with; the process exits
    {"type": "speech", "id": 3, "state": "speaking"}   # or "done", or "skipped" (not English)
    {"type": "error", "message": "..."}

Replies are spoken a sentence at a time, so the first words play while the
agent is still writing the rest. Run standalone to hear the voice:

    python listener/tts.py --say "Hello Peter."
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import queue
import re
import subprocess
import sys
import threading
import unicodedata
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Protocol

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_VOICE = ROOT / "models" / "tts-voice.safetensors"
OFF_VALUES = {"0", "off", "false", "no"}
# Playing out what is buffered takes a second or two; a stalled sink must not hang the voice.
DRAIN_TIMEOUT_S = 10.0

# --- Text: what of a chat reply can be read aloud ------------------------------

CODE_FENCE = "```"
LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")  # [label](url) -> label; images too
URL = re.compile(r"\bhttps?://\S+|\bwww\.\S+")
INLINE_CODE = re.compile(r"`([^`]*)`")
EMPHASIS = re.compile(r"(\*{1,3}|_{2,3}|~~)(\S(?:.*?\S)?)\1")
LINE_MARKUP = re.compile(r"^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)", re.MULTILINE)
TABLE_RULE = re.compile(r"^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$", re.MULTILINE)
SPACES = re.compile(r"\s+")

# A sentence ends at . ! ? or an ellipsis followed by whitespace, or at a line break.
SENTENCE_END = re.compile(r"(?<=[.!?…])[\"')\]]*[ \t]+|[ \t]*\n+")
ABBREVIATIONS = {"mr", "mrs", "ms", "dr", "st", "vs", "etc", "e.g", "i.e", "approx", "no", "fig"}
# Pocket TTS splits long text itself; a single runaway "sentence" is cut here so
# the first audio never waits on a whole paragraph without punctuation.
MAX_SENTENCE_CHARS = 400

# Marks no language an English reply borrows from uses: horn (ơ ư), hook above,
# dot below, and the breve on a (ă); plus đ. Circumflex and acute/grave/tilde
# also occur in loanwords ("crêpes", "résumé", "Hôtel") and only count in bulk.
VIETNAMESE_MARKS = {"̛", "̉", "̣"}
BREVE = "̆"
CIRCUMFLEX = "̂"
WORD = re.compile(r"\w+")


def clean_for_speech(text: str) -> str:
    """Markdown and links read aloud are noise: keep the words, drop the markup."""
    text = TABLE_RULE.sub(" ", text)
    text = LINK.sub(r"\1", text)
    text = URL.sub(" ", text)
    text = INLINE_CODE.sub(r"\1", text)
    text = LINE_MARKUP.sub("", text)
    text = EMPHASIS.sub(r"\2", text)
    text = text.replace("|", " ").replace("*", " ").replace("#", " ")
    return SPACES.sub(" ", text).strip()


def is_vietnamese(text: str) -> bool:
    """True for Vietnamese text, which the English voice would only mangle."""
    decomposed = unicodedata.normalize("NFD", text)
    if "đ" in text.lower() or any(mark in VIETNAMESE_MARKS for mark in decomposed):
        return True
    if any(base in "aA" and mark == BREVE for base, mark in itertools.pairwise(decomposed)):
        return True
    words = WORD.findall(unicodedata.normalize("NFC", text))
    accented = [word for word in words if unicodedata.normalize("NFD", word) != word]
    if len(words) == 1:
        return CIRCUMFLEX in unicodedata.normalize("NFD", words[0])  # "Vâng", but not "Café"
    # A loanword or two sits in an English sentence; Vietnamese accents most of its words.
    return len(accented) >= 2 and 2 * len(accented) >= len(words)


def speakable(sentence: str) -> bool:
    return any(ch.isalnum() for ch in sentence)


def _false_end(text: str, end: re.Match[str]) -> bool:
    """A period that does not end a sentence: "Dr. Strange", or a "1. " list marker."""
    before = text[: end.start()]
    if not before.endswith(".") or "\n" in end.group():
        return False
    line = before.rsplit("\n", 1)[-1]
    word = line.rsplit(None, 1)[-1].rstrip(".")
    return word.lower() in ABBREVIATIONS or (word.isdigit() and line.strip() == f"{word}.")


class SentenceSplitter:
    """Cuts a streamed reply into whole sentences, skipping fenced code blocks."""

    def __init__(self) -> None:
        self._buffer = ""
        self._in_code = False

    def feed(self, text: str) -> list[str]:
        self._buffer += text
        sentences: list[str] = []
        while True:
            if self._in_code:
                end = self._buffer.find(CODE_FENCE)
                if end == -1:
                    # Keep a partial fence ("``") that the next piece may complete.
                    self._buffer = self._buffer[-(len(CODE_FENCE) - 1) :]
                    return sentences
                self._buffer = self._buffer[end + len(CODE_FENCE) :]
                self._in_code = False
                continue
            fence = self._buffer.find(CODE_FENCE)
            if fence != -1:
                # Code is never read out: what precedes the fence ends there.
                sentences += self._sentences(self._buffer[:fence])
                self._buffer = self._buffer[fence + len(CODE_FENCE) :]
                self._in_code = True
                continue
            cut = self._last_sentence_end(self._buffer)
            if not cut and len(self._buffer) > MAX_SENTENCE_CHARS:
                space = self._buffer.rfind(" ", 0, MAX_SENTENCE_CHARS)
                cut = space if space > 0 else MAX_SENTENCE_CHARS
            if not cut:
                return sentences
            sentences += self._sentences(self._buffer[:cut])
            self._buffer = self._buffer[cut:]

    def flush(self) -> list[str]:
        rest = "" if self._in_code else self._buffer
        self._buffer = ""
        self._in_code = False
        return self._sentences(rest)

    @staticmethod
    def _last_sentence_end(text: str) -> int:
        cut = 0
        for end in SENTENCE_END.finditer(text):
            if not _false_end(text, end):
                cut = end.end()
        return cut

    @staticmethod
    def _sentences(text: str) -> list[str]:
        # One sentence at a time, so a Vietnamese one is skipped without its English neighbours.
        parts, start = [], 0
        for end in SENTENCE_END.finditer(text):
            if not _false_end(text, end):
                parts.append(text[start : end.end()])
                start = end.end()
        parts.append(text[start:])
        cleaned = (clean_for_speech(part) for part in parts)
        return [sentence for sentence in cleaned if speakable(sentence)]


# --- Audio: synthesis and playback ------------------------------------------------


class Player(Protocol):
    def write(self, pcm: bytes) -> None: ...
    def close(self) -> None: ...  # play what is buffered, then return
    def kill(self) -> None: ...  # stop at once


class PwPlayer:
    """Plays 16-bit mono PCM through PipeWire as it is written."""

    def __init__(self, sample_rate: int) -> None:
        command = [
            "pw-cat",
            "--playback",
            "--raw",
            "--format=s16",
            f"--rate={sample_rate}",
            "--channels=1",
            "--media-role=Communication",
            "-",
        ]
        self._proc = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def write(self, pcm: bytes) -> None:
        assert self._proc.stdin is not None
        self._proc.stdin.write(pcm)
        self._proc.stdin.flush()

    def close(self) -> None:
        assert self._proc.stdin is not None
        try:
            self._proc.stdin.close()
        except BrokenPipeError:
            pass  # killed: nothing left to play
        try:
            self._proc.wait(DRAIN_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            self._proc.wait()

    def kill(self) -> None:
        self._proc.kill()


Synthesize = Callable[[str, threading.Event], Iterator[bytes]]
# (generation, reply id, sentence); sentence None ends the reply. Reply id
# NO_REPLY is a wake-up after cancel() so the worker closes the silenced reply.
Work = tuple[int, int, str | None]
NO_REPLY = -1


class PocketVoice:
    """A Pocket TTS model conditioned on one exported voice."""

    def __init__(self, voice: Path) -> None:
        from pocket_tts import TTSModel  # imports torch: only when actually speaking

        self.model = TTSModel.load_model()
        self.state = self.model.get_state_for_audio_prompt(voice)
        self.sample_rate: int = self.model.sample_rate

    def synthesize(self, text: str, stop: threading.Event) -> Iterator[bytes]:
        import numpy as np

        for chunk in self.model.generate_audio_stream(self.state, text, stop=stop):
            samples = np.clip(chunk.reshape(-1).numpy(), -1.0, 1.0)
            yield (samples * 32767).astype("<i2").tobytes()


class Speaker:
    """Speaks streamed replies one at a time; a newer reply or cancel() silences the current one.

    say(), end() and cancel() come from one thread (the command reader); a
    single worker thread synthesizes and plays, so speech never overlaps itself.
    """

    def __init__(self, synthesize: Synthesize, open_player: Callable[[], Player], emit: Callable[[dict], None]):
        self._synthesize = synthesize
        self._open_player = open_player
        self._emit = emit
        self._queue: queue.Queue[Work | None] = queue.Queue()
        self._lock = threading.Lock()
        self._generation = 0  # bumped by cancel(): queued work of older generations is dropped
        self._stop = threading.Event()  # interrupts the synthesis in progress
        self._player: Player | None = None
        self._reply_id: int | None = None
        self._silenced: int | None = None  # pieces of this reply still arriving after cancel() are dropped
        self._splitter = SentenceSplitter()
        self._skipped = False
        # Work queued but not yet handled, and whether a reply is still playing: wait() needs both.
        self._progress = threading.Condition()
        self._pending = 0
        self._playing = False
        self._worker = threading.Thread(target=self._run, name="tts", daemon=True)
        self._worker.start()

    def say(self, reply_id: int, text: str) -> None:
        if reply_id == self._silenced:
            return
        if reply_id != self._reply_id:
            self.cancel()
            self._reply_id = reply_id
        for sentence in self._splitter.feed(text):
            self._enqueue(reply_id, sentence)

    def end(self, reply_id: int) -> None:
        if reply_id != self._reply_id:
            return  # cancelled, or nothing was said
        for sentence in self._splitter.flush():
            self._enqueue(reply_id, sentence)
        self._put((self._generation, reply_id, None))
        self._reply_id = None

    def cancel(self) -> None:
        with self._lock:
            self._generation += 1
            self._stop.set()
            if self._player is not None:
                self._player.kill()
            generation = self._generation
        if self._reply_id is not None:
            self._silenced = self._reply_id
        self._reply_id = None
        self._splitter = SentenceSplitter()
        self._skipped = False
        self._put((generation, NO_REPLY, None))

    def wait(self, timeout: float | None = None) -> bool:
        """Block until everything queued has been spoken (for --say)."""
        with self._progress:
            return self._progress.wait_for(lambda: self._pending == 0 and not self._playing, timeout)

    def close(self) -> None:
        self.cancel()
        self._queue.put(None)
        self._worker.join()

    def _enqueue(self, reply_id: int, sentence: str) -> None:
        if is_vietnamese(sentence):
            if not self._skipped:
                self._skipped = True
                self._emit({"type": "speech", "id": reply_id, "state": "skipped"})
            return
        self._put((self._generation, reply_id, sentence))

    def _put(self, work: Work) -> None:
        with self._progress:
            self._pending += 1
        self._queue.put(work)

    def _run(self) -> None:
        speaking: int | None = None  # the reply whose player is open
        while (work := self._queue.get()) is not None:
            generation, reply_id, sentence = work
            current = generation == self._generation
            if speaking is not None and (not current or reply_id != speaking):
                self._finish(speaking, interrupted=True)
                speaking = None
            if current and sentence is not None:
                if self._speak(generation, reply_id, sentence, opened=speaking is not None):
                    speaking = reply_id
            elif current and speaking is not None:
                self._finish(speaking, interrupted=False)  # end of the reply: let it play out
                speaking = None
            with self._progress:
                self._pending -= 1
                self._playing = speaking is not None
                self._progress.notify_all()
        if speaking is not None:
            self._finish(speaking, interrupted=True)

    def _speak(self, generation: int, reply_id: int, sentence: str, opened: bool) -> bool:
        """Synthesize one sentence into the reply's player; returns whether a player is open."""
        with self._lock:
            if generation != self._generation:
                return opened
            if not opened:
                try:
                    self._player = self._open_player()
                except OSError as exc:
                    self._emit({"type": "error", "message": f"cannot play audio: {exc}"})
                    return False
                self._emit({"type": "speech", "id": reply_id, "state": "speaking"})
            self._stop = stop = threading.Event()
            player = self._player
        assert player is not None
        try:
            for pcm in self._synthesize(sentence, stop):
                if stop.is_set():
                    break
                player.write(pcm)
        except (BrokenPipeError, ValueError):
            pass  # cancel() killed the player mid-write
        except Exception as exc:  # noqa: BLE001 - one bad sentence must not take the voice down
            self._emit({"type": "error", "message": f"speech synthesis failed: {exc}"})
        return True

    def _finish(self, reply_id: int, interrupted: bool) -> None:
        with self._lock:
            player = self._player
        if player is not None:
            if interrupted:
                player.kill()
            try:
                player.close()  # still reachable by cancel() while it plays out
            except OSError:
                pass
            with self._lock:
                self._player = None
        self._emit({"type": "speech", "id": reply_id, "state": "done"})


# --- Process ---------------------------------------------------------------------

_emit_lock = threading.Lock()


def emit(event: dict) -> None:
    # The worker thread emits too; keep each JSON line whole.
    with _emit_lock:
        sys.stdout.write(json.dumps(event) + "\n")
        sys.stdout.flush()


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def voice_path() -> Path:
    setting = os.environ.get("FRIDAY_TTS_VOICE")
    return Path(setting).expanduser() if setting else DEFAULT_VOICE


def handle(speaker: Speaker, line: str) -> None:
    try:
        command = json.loads(line)
        kind = command["type"]
        if kind == "say":
            speaker.say(int(command["id"]), str(command["text"]))
        elif kind == "end":
            speaker.end(int(command["id"]))
        elif kind == "cancel":
            speaker.cancel()
        else:
            log(f"unknown command: {line.strip()}")
    except (ValueError, KeyError, TypeError) as exc:
        log(f"bad command {line.strip()!r}: {exc}")


def serve(speaker: Speaker, lines: Iterator[str]) -> None:
    for line in lines:
        if line.strip():
            handle(speaker, line)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--say", help="speak this text and exit")
    parser.add_argument("--voice", type=Path, default=voice_path(), help="voice exported by 'friday voice'")
    args = parser.parse_args()

    if os.environ.get("FRIDAY_TTS", "").strip().lower() in OFF_VALUES:
        emit({"type": "disabled", "reason": "FRIDAY_TTS is off"})
        return
    if not args.voice.is_file():
        emit({"type": "disabled", "reason": f"no voice at {args.voice} (clone one: bin/friday voice AUDIO)"})
        return
    try:
        voice = PocketVoice(args.voice)
    except Exception as exc:  # noqa: BLE001 - any load failure is reported, then the shell retries
        emit({"type": "error", "message": f"cannot load voice {args.voice}: {exc}"})
        sys.exit(1)

    speaker = Speaker(voice.synthesize, lambda: PwPlayer(voice.sample_rate), emit)
    if args.say:
        speaker.say(1, args.say)
        speaker.end(1)
        speaker.wait()
        speaker.close()
        return
    emit({"type": "ready", "voice": str(args.voice)})
    try:
        serve(speaker, iter(sys.stdin.readline, ""))
    except KeyboardInterrupt:
        pass
    speaker.close()  # stdin closed: the shell is gone


if __name__ == "__main__":
    main()
