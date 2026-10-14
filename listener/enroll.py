"""Enroll your voice so F.R.I.D.A.Y. only takes commands from you.

Has you say a dozen short commands into the microphone, in the ways you
really talk to Friday (calm, loud, excited, quick), turns each into a voice
embedding and saves them as the voiceprint speaker.py checks commands against.
The running service is paused meanwhile, since every prompt starts with "Friday".

    bin/friday enroll                               # speak into the mic
    bin/friday enroll --save DIR                    # also keep the samples (private WAVs) for tuning
    python listener/enroll.py --wav a.wav b.wav ... # 16 kHz mono recordings instead
"""

from __future__ import annotations

import argparse
import contextlib
import os
import subprocess
import sys
import wave
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from command import SAMPLE_RATE, Endpointer, save_private_wav, voiced_audio
from env import load_env
from speaker import (
    DEFAULT_SPEAKER_MODEL,
    SpeakerModel,
    Voiceprint,
    VoiceprintError,
    speaker_threshold,
    voiceprint_path,
)
from vad import VadUnavailable


@dataclass(frozen=True)
class Prompt:
    style: str
    hint: str  # how to say it
    text: str


# The voiceprint must cover how the owner really talks to Friday: enrolled
# only from calm read sentences, the same voice scored 0.26-0.44 when louder
# or higher (below the 0.45 threshold). Commands like real ones, in both
# languages, each 1.5-3 s like the audio checked at runtime.
NORMAL, LOUD, HIGH, QUICK = (
    "giọng bình thường",
    "nói to, như gọi từ đầu kia phòng",
    "lên giọng, hào hứng hoặc hơi vội",
    "nói nhanh, gọn",
)
PROMPTS = (
    Prompt("normal", NORMAL, "Friday, hôm nay thời tiết ở Hà Nội thế nào?"),
    Prompt("normal", NORMAL, "Friday, mở trình duyệt và tìm tin tức mới nhất."),
    Prompt("normal", NORMAL, "Friday, open my email and read the first message."),
    Prompt("normal", NORMAL, "Friday, nhắc tôi gọi điện cho mẹ lúc tám giờ tối."),
    Prompt("loud", LOUD, "Friday, bật nhạc to lên một chút!"),
    Prompt("loud", LOUD, "Friday, what time is it right now?"),
    Prompt("loud", LOUD, "Friday, tắt hết đèn trong phòng đi!"),
    Prompt("high", HIGH, "Friday, mở bài hát tôi thích nhất đi!"),
    Prompt("high", HIGH, "Friday, play something fun for me!"),
    Prompt("high", HIGH, "Friday, còn bao lâu nữa thì đến cuộc họp?"),
    Prompt("quick", QUICK, "Friday, dừng nhạc và tắt màn hình."),
    Prompt("quick", QUICK, "Friday, stop and close the browser."),
)
MIN_SPEECH_S = 1.0  # voiced audio per sample
MIN_SAMPLES = 3
REDO_ROUNDS = 2  # chances to re-record samples that do not sound like the rest
# A sample is re-recorded (and finally refused) below this match with the rest.
# Another person scores about 0 against the owner's samples; the owner's own
# louder or higher samples stay well above this once the voiceprint covers them.
CONSISTENCY_MIN = 0.3
SERVICE = "friday.service"
Run = Callable[..., subprocess.CompletedProcess]


def seconds(pcm: bytes) -> float:
    return len(pcm) / (2 * SAMPLE_RATE)


def read_wav(path: Path) -> bytes:
    with wave.open(str(path), "rb") as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (SAMPLE_RATE, 1, 2):
            raise SystemExit(f"{path}: need {SAMPLE_RATE} Hz mono s16 WAV")
        return wav.readframes(wav.getnframes())


def capture_sentence(chunks: Iterator[bytes]) -> bytes | None:
    """Voiced audio of one spoken sentence; b"" if nothing was said, None if the mic stopped."""
    endpointer = Endpointer()
    for chunk in chunks:
        if (reason := endpointer.feed(chunk)) is not None:
            return endpointer.speech if reason != "nospeech" else b""
    return None


class Recorder:
    """Records prompted samples from the mic; keeps them as private WAVs when asked to."""

    def __init__(self, model: SpeakerModel, chunks: Iterator[bytes], save: Path | None) -> None:
        self._model, self._chunks, self._save = model, chunks, save

    def sample(self, number: int) -> np.ndarray:
        prompt = PROMPTS[number - 1]
        while True:
            print(f"\n[{number}/{len(PROMPTS)}] ({prompt.hint}):\n    {prompt.text}", flush=True)
            speech = capture_sentence(self._chunks)
            if speech is None:
                raise SystemExit("the microphone stream ended")
            if seconds(speech) < MIN_SPEECH_S:
                print("    Did not hear enough speech; please say it again.", flush=True)
                continue
            print(f"    ok ({seconds(speech):.1f}s of speech)", flush=True)
            if self._save is not None:
                save_private_wav(self._save, f"enroll-{number:02d}-{prompt.style}.wav", speech)
            return self._model.embed(speech)


@contextlib.contextmanager
def paused_service(run: Run = subprocess.run) -> Iterator[None]:
    """Stop the running listener while enrolling (every prompt says "Friday"), then start it again."""
    systemctl = ["systemctl", "--user", "--quiet"]
    active = run([*systemctl, "is-active", SERVICE], check=False).returncode == 0
    if active:
        run([*systemctl, "stop", SERVICE], check=False)
    try:
        yield
    finally:
        if active:
            run([*systemctl, "start", SERVICE], check=False)
            print("Friday is listening again.")


def enroll_from_mic(model: SpeakerModel, target: str | None, save: Path | None) -> list[np.ndarray]:
    from wake import mic_command, read_chunks, resolve_target

    source = resolve_target(target)
    if source is None:
        raise SystemExit("no microphone found (set FRIDAY_MIC or pass --target)")
    print(f"Recording from {source}, at your usual distance from the microphone.")
    print("Say each line the way the hint describes; Friday is paused until you finish.")
    proc = subprocess.Popen(mic_command(source), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    assert proc.stdout is not None
    try:
        recorder = Recorder(model, read_chunks(proc.stdout), save)
        embeddings = [recorder.sample(n) for n in range(1, len(PROMPTS) + 1)]
        # A cough or another voice spoils a sample: re-record the odd ones out.
        for _round in range(REDO_ROUNDS):
            scores = Voiceprint(model.name, tuple(embeddings)).self_scores()
            odd = [i for i, score in enumerate(scores) if score < CONSISTENCY_MIN]
            if not odd:
                break
            for i in odd:
                print(f"\nSample {i + 1} does not sound like the others (match {scores[i]:.2f}); once more:")
                embeddings[i] = recorder.sample(i + 1)
        return embeddings
    finally:
        proc.kill()
        proc.wait()


def enroll_from_files(model: SpeakerModel, paths: list[Path], save: Path | None) -> list[np.ndarray]:
    embeddings = []
    for number, path in enumerate(paths, 1):
        speech = voiced_audio(read_wav(path))
        if seconds(speech) < MIN_SPEECH_S:
            raise SystemExit(f"{path}: only {seconds(speech):.1f}s of speech, need {MIN_SPEECH_S}s")
        if save is not None:
            save_private_wav(save, f"enroll-{number:02d}-file.wav", speech)
        embeddings.append(model.embed(speech))
    return embeddings


def reload_service(saved: Path) -> None:
    """The listener reads the voiceprint at startup: restart it if it uses the file just written."""
    if saved.resolve() != voiceprint_path().resolve():
        return
    systemctl = ["systemctl", "--user", "--quiet"]
    try:
        if subprocess.run([*systemctl, "is-active", SERVICE], check=False).returncode != 0:
            return
        subprocess.run([*systemctl, "restart", SERVICE], check=True)
        print("Friday restarted with the new voiceprint.")
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"Restart Friday to use the new voiceprint (systemctl --user restart friday): {exc}")


def main() -> None:
    load_env()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--wav", type=Path, nargs="+", help="enroll from 16 kHz mono WAV recordings")
    parser.add_argument("--out", type=Path, default=voiceprint_path(), help="voiceprint file")
    parser.add_argument("--target", default=os.environ.get("FRIDAY_MIC"), help="PipeWire source to record from")
    parser.add_argument("--save", type=Path, help="also keep each sample as a private WAV in this folder")
    model_default = os.environ.get("FRIDAY_SPEAKER_MODEL") or DEFAULT_SPEAKER_MODEL
    parser.add_argument("--model", type=Path, default=Path(model_default))
    args = parser.parse_args()

    try:
        threshold = speaker_threshold(os.environ.get("FRIDAY_SPEAKER_THRESHOLD"))
        model = SpeakerModel(args.model)
        if args.wav:
            if len(args.wav) < MIN_SAMPLES:
                raise SystemExit(f"need at least {MIN_SAMPLES} recordings")
            scores = save_voiceprint(model, enroll_from_files(model, args.wav, args.save), args.out)
            reload_service(args.out)
        else:
            # Saved before the service resumes, so it starts with the new voiceprint.
            with paused_service():
                scores = save_voiceprint(model, enroll_from_mic(model, args.target, args.save), args.out)
    except (VoiceprintError, VadUnavailable) as exc:
        raise SystemExit(f"enrollment failed: {exc}") from exc
    except KeyboardInterrupt:
        raise SystemExit("\nenrollment cancelled; the previous voiceprint (if any) is unchanged") from None
    print(f"Consistency: min {min(scores):.2f}, mean {sum(scores) / len(scores):.2f} (threshold {threshold:.2f}).")


def save_voiceprint(model: SpeakerModel, embeddings: list[np.ndarray], out: Path) -> list[float]:
    """Save unless one sample is the odd one out; returns each sample's match with the rest."""
    voiceprint = Voiceprint(model.name, tuple(embeddings))
    scores = voiceprint.self_scores()
    worst = min(range(len(scores)), key=scores.__getitem__)
    if scores[worst] < CONSISTENCY_MIN:
        # Saving would widen the voiceprint towards whoever else is in that sample.
        raise SystemExit(
            f"Sample {worst + 1} does not sound like the others (match {scores[worst]:.2f}); nothing was saved.\n"
            "Enroll again alone, in a quiet room."
        )
    voiceprint.save(out)
    print(f"\nVoiceprint saved to {out} ({len(embeddings)} samples).")
    return scores


if __name__ == "__main__":
    sys.exit(main())
