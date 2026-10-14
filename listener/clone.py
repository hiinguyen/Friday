"""Clone the voice F.R.I.D.A.Y. replies in, from a recording of it.

    bin/friday voice AUDIO           # any format ffmpeg reads; one clear voice, no music
    bin/friday voice AUDIO --out models/other-voice.safetensors

Pocket TTS conditions on at most 30 s of audio and continues from where the
sample stops, so the sample is cut at the last pause before 30 s: a cut mid
word would bleed into every reply. The trimmed sample is kept next to the
voice (same name, .wav) to re-export it after a model update. The voice
cloning weights are gated: accept the terms at
https://huggingface.co/kyutai/pocket-tts and log in once with `hf auth login`.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

from env import load_env
from tts import voice_path

SAMPLE_RATE = 24000  # Pocket TTS (Mimi) rate
MAX_SECONDS = 30.0
MIN_SECONDS = 3.0
FRAME_S = 0.02
SILENCE_DB = -35.0  # below the loudest frame: a pause between words or sentences
FLOOR_DBFS = -60.0  # quieter than this is silence however quiet the whole recording is
MIN_PAUSE_S = 0.25
SERVICE = "friday.service"


def decode(path: Path) -> np.ndarray:
    """Any audio file as 24 kHz mono float32."""
    command = ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SAMPLE_RATE)]
    try:
        result = subprocess.run([*command, "-f", "f32le", "-"], capture_output=True, check=True)
    except FileNotFoundError:
        raise SystemExit("ffmpeg is needed to read the recording (install ffmpeg)") from None
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"cannot read {path}: {exc.stderr.decode(errors='replace').strip()}") from None
    return np.frombuffer(result.stdout, dtype="<f4").copy()


def silent_frames(audio: np.ndarray) -> np.ndarray:
    """Per 20 ms frame: quieter than SILENCE_DB below the loudest frame, or digital silence."""
    size = int(FRAME_S * SAMPLE_RATE)
    frames = audio[: len(audio) // size * size].reshape(-1, size)
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1)) + 1e-10
    dbfs = 20 * np.log10(rms)
    return (dbfs < dbfs.max() + SILENCE_DB) | (dbfs < FLOOR_DBFS)


def trim(audio: np.ndarray, max_seconds: float = MAX_SECONDS) -> tuple[np.ndarray, bool]:
    """Drop leading and trailing silence and end at a pause within max_seconds.

    Returns the sample and whether it had to be cut mid-speech (no pause found).
    """
    size = int(FRAME_S * SAMPLE_RATE)
    silent = silent_frames(audio)
    voiced = np.flatnonzero(~silent)
    if voiced.size == 0:
        return audio[:0], False
    first, last = voiced[0], voiced[-1] + 1
    limit = first + int(max_seconds / FRAME_S)
    if last <= limit:
        return audio[first * size : last * size], False
    # End in the middle of the last pause long enough to be between words.
    run = int(MIN_PAUSE_S / FRAME_S)
    for end in range(limit, first + run, -1):
        if silent[end - run : end].all():
            return audio[first * size : (end - run // 2) * size], False
    return audio[first * size : limit * size], True


def write_wav(path: Path, audio: np.ndarray) -> None:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes((np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes())


def export_voice(sample: np.ndarray, out: Path) -> None:
    import torch
    from pocket_tts import TTSModel
    from pocket_tts.models.model_state import export_model_state

    model = TTSModel.load_model()
    if not model.has_voice_cloning:
        raise SystemExit(
            "the Pocket TTS voice cloning weights are not available: accept the terms at "
            "https://huggingface.co/kyutai/pocket-tts, then run `.venv/bin/hf auth login`"
        )
    state = model.get_state_for_audio_prompt(torch.from_numpy(sample)[None])
    export_model_state(state, out)


def restart_service(out: Path) -> None:
    """The running service loads its voice at startup: restart it if it speaks with this one."""
    if out.resolve() != voice_path().resolve():
        return
    systemctl = ["systemctl", "--user", "--quiet"]
    try:
        if subprocess.run([*systemctl, "is-active", SERVICE], check=False).returncode != 0:
            return
        subprocess.run([*systemctl, "restart", SERVICE], check=True)
        print("Friday restarted with the new voice.")
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"Restart Friday to use the new voice (systemctl --user restart friday): {exc}")


def main() -> None:
    load_env()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("audio", type=Path, help="recording of the voice to clone")
    parser.add_argument("--out", type=Path, default=voice_path(), help="voice file (default: %(default)s)")
    args = parser.parse_args()

    sample, cut_mid_speech = trim(decode(args.audio))
    seconds = len(sample) / SAMPLE_RATE
    if seconds < MIN_SECONDS:
        raise SystemExit(f"only {seconds:.1f}s of speech in {args.audio}, need at least {MIN_SECONDS:.0f}s")
    if cut_mid_speech:
        print(f"No pause before {MAX_SECONDS:.0f}s: the sample is cut mid-speech, which may show in replies.")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    reference = args.out.with_suffix(".wav")
    write_wav(reference, sample)
    print(f"Sample: {seconds:.1f}s saved to {reference}")
    export_voice(sample, args.out)
    print(f"Voice saved to {args.out}")
    restart_service(args.out)


if __name__ == "__main__":
    sys.exit(main())
