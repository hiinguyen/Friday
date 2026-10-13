"""Speaker verification for F.R.I.D.A.Y.: only the enrolled voice may command.

A WeSpeaker ResNet34 model (ONNX, run by onnxruntime on the CPU) turns speech
into a 256-dimensional embedding of the speaker's voice. Enrollment
(enroll.py) stores the embeddings of a few spoken sentences as a voiceprint;
a command is accepted when its embedding is close enough (cosine similarity)
to the voiceprint's centroid.

Without a voiceprint file every voice is accepted. Once one exists, any
problem with it (corrupt file, missing model, wrong model) rejects every
command rather than silently letting anyone in.
"""

from __future__ import annotations

import json
import math
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np

SAMPLE_RATE = 16000
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SPEAKER_MODEL = ROOT / "models" / "wespeaker_en_voxceleb_resnet34_LM.onnx"
# Cosine similarity to the enrolled centroid. On 13 held-out LibriSpeech
# speakers sharing one simulated laptop-mic channel, 1.5-3 s clips of the
# enrolled speaker scored >= 0.50 and of everyone else <= 0.40.
DEFAULT_THRESHOLD = 0.45
MIN_SAMPLE_S = 0.5  # less speech than this cannot be attributed to anyone
MIN_FRAMES = 20  # 10 ms feature frames the model needs to say anything
FBANK_BINS = 80
# 2: features are mean-normalised as WeSpeaker trains them. Version 1 came from
# sherpa-onnx, which skips that step for this model; its embeddings differ.
VOICEPRINT_VERSION = 2


class VoiceprintError(Exception):
    """The voiceprint cannot be used to verify speakers.

    Messages are short and say what to do: the HUD shows them on one log line.
    """


class NotEnoughSpeech(VoiceprintError):
    """The audio is too short or too quiet to tell who is speaking."""


def normalize(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    if not math.isfinite(norm) or norm == 0.0:
        raise VoiceprintError("degenerate voice embedding")
    return (vector / norm).astype(np.float32)


def voiceprint_path() -> Path:
    if explicit := os.environ.get("FRIDAY_VOICEPRINT"):
        return Path(explicit)
    data_home = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return Path(data_home) / "friday" / "voiceprint.json"


def speaker_threshold(setting: str | None) -> float:
    if not setting:
        return DEFAULT_THRESHOLD
    try:
        value = float(setting)
    except ValueError:
        value = math.nan
    if not 0.0 <= value <= 1.0:  # also rejects nan
        raise VoiceprintError(f"FRIDAY_SPEAKER_THRESHOLD must be a number from 0 to 1, got {setting!r}")
    return value


@dataclass(frozen=True)
class Voiceprint:
    model: str  # file name of the embedding model; embeddings of different models are not comparable
    embeddings: tuple[np.ndarray, ...]

    @property
    def centroid(self) -> np.ndarray:
        return normalize(np.mean(self.embeddings, axis=0))

    def score(self, embedding: np.ndarray) -> float:
        return float(self.centroid @ embedding)

    def self_scores(self) -> list[float]:
        """Each enrollment sample scored against the centroid of the others (consistency check)."""
        scores = []
        for i, embedding in enumerate(self.embeddings):
            others = self.embeddings[:i] + self.embeddings[i + 1 :]
            scores.append(float(normalize(np.mean(others, axis=0)) @ embedding))
        return scores

    def save(self, path: Path) -> None:
        """Write atomically, readable by the owner only: a voiceprint is biometric data."""
        path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        data = {
            "version": VOICEPRINT_VERSION,
            "model": self.model,
            "embeddings": [[round(float(x), 6) for x in e] for e in self.embeddings],
        }
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".voiceprint-")  # created 0600
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(data, f)
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    @classmethod
    def load(cls, path: Path) -> Voiceprint:
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError) as exc:
            raise VoiceprintError("file is unreadable; re-enroll") from exc
        if not isinstance(data, dict) or data.get("version") != VOICEPRINT_VERSION:
            raise VoiceprintError("outdated format; re-enroll")
        raw = data.get("embeddings")
        if not isinstance(raw, list) or not raw or not all(isinstance(e, list) and e for e in raw):
            raise VoiceprintError("file is corrupt; re-enroll")
        if len({len(e) for e in raw}) != 1:
            raise VoiceprintError("file is corrupt; re-enroll")
        try:
            embeddings = tuple(normalize(np.array(e, dtype=np.float32)) for e in raw)
        except (TypeError, ValueError) as exc:
            raise VoiceprintError("file is corrupt; re-enroll") from exc
        return cls(model=str(data.get("model", "")), embeddings=embeddings)


class Embedder(Protocol):
    name: str

    def embed(self, pcm: bytes) -> np.ndarray: ...


def wespeaker_features(pcm: bytes) -> np.ndarray:
    """Log mel filterbank exactly as WeSpeaker computes it in training and inference.

    80 bins over 25 ms Hamming frames every 10 ms of int16-scaled audio, then
    the per-utterance mean is subtracted. That last step cancels the
    microphone's fixed colouring and level, so the embedding describes the
    voice rather than the hardware it was recorded with.
    """
    import kaldi_native_fbank as knf

    opts = knf.FbankOptions()
    opts.frame_opts.samp_freq = SAMPLE_RATE
    opts.frame_opts.dither = 0.0
    opts.frame_opts.window_type = "hamming"
    opts.mel_opts.num_bins = FBANK_BINS
    fbank = knf.OnlineFbank(opts)
    samples = np.frombuffer(pcm[: len(pcm) - len(pcm) % 2], dtype=np.int16).astype(np.float32)
    fbank.accept_waveform(SAMPLE_RATE, samples)
    fbank.input_finished()
    if fbank.num_frames_ready < MIN_FRAMES:
        raise NotEnoughSpeech("too little audio to compute a voice embedding")
    feats = np.array([fbank.get_frame(i) for i in range(fbank.num_frames_ready)], dtype=np.float32)
    return feats - feats.mean(axis=0)


class SpeakerModel:
    """WeSpeaker embedding model; embed() takes 16 kHz mono s16 PCM."""

    def __init__(self, path: Path) -> None:
        if not path.is_file():
            raise VoiceprintError(f"speaker model {path.name} is missing")
        import onnxruntime as ort

        options = ort.SessionOptions()
        # One CPU thread that sleeps between commands: this runs inside an always-on service.
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        try:
            self._session = ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])
        except Exception as exc:
            raise VoiceprintError(f"cannot load speaker model {path.name}") from exc
        meta = self._session.get_modelmeta().custom_metadata_map
        if meta.get("framework") != "wespeaker" or meta.get("sample_rate") != str(SAMPLE_RATE):
            raise VoiceprintError(f"{path.name} is not a {SAMPLE_RATE} Hz WeSpeaker model")
        self._input = self._session.get_inputs()[0].name
        self.name = path.name

    def embed(self, pcm: bytes) -> np.ndarray:
        feats = wespeaker_features(pcm)
        embedding = self._session.run(None, {self._input: feats[np.newaxis]})[0][0]
        return normalize(np.asarray(embedding, dtype=np.float32))


@dataclass(frozen=True)
class Verdict:
    accepted: bool
    score: float
    unclear: bool = False  # too little speech to tell who it was; not evidence of another voice


class SpeakerVerifier:
    def __init__(self, model: Embedder, voiceprint: Voiceprint, threshold: float) -> None:
        if voiceprint.model != model.name:
            raise VoiceprintError(f"made with another model ({voiceprint.model or 'unknown'}); re-enroll")
        self._model = model
        self._voiceprint = voiceprint
        self.threshold = threshold

    def check(self, pcm: bytes) -> Verdict:
        if len(pcm) < int(MIN_SAMPLE_S * SAMPLE_RATE) * 2:
            return Verdict(False, 0.0, unclear=True)
        try:
            embedding = self._model.embed(pcm)
        except NotEnoughSpeech:
            return Verdict(False, 0.0, unclear=True)
        score = self._voiceprint.score(embedding)
        return Verdict(score >= self.threshold, score)


class UnusableVerifier:
    """Stands in for a broken voiceprint setup: every check fails with the reason."""

    def __init__(self, reason: str) -> None:
        self.reason = reason

    def check(self, pcm: bytes) -> Verdict:
        raise VoiceprintError(self.reason)


def build_verifier() -> SpeakerVerifier | UnusableVerifier | None:
    """Verifier for the enrolled voice; None when nobody has enrolled."""
    path = voiceprint_path()
    if not path.exists():
        return None
    model_path = Path(os.environ.get("FRIDAY_SPEAKER_MODEL") or DEFAULT_SPEAKER_MODEL)
    try:
        voiceprint = Voiceprint.load(path)
        threshold = speaker_threshold(os.environ.get("FRIDAY_SPEAKER_THRESHOLD"))
        return SpeakerVerifier(SpeakerModel(model_path), voiceprint, threshold)
    except ImportError as exc:
        return UnusableVerifier(f"dependencies are missing ({exc.name})")
    except (VoiceprintError, OSError, RuntimeError, ValueError) as exc:
        return UnusableVerifier(str(exc))
