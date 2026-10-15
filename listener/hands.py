"""Camera hand tracker for F.R.I.D.A.Y. gesture control.

Runs only while gesture mode is on: the Electron shell starts it and stops it
(SIGTERM) when the mode ends, which releases the camera. It reads the webcam
with OpenCV, finds one hand with MediaPipe's hand landmarker, and writes JSON
events to stdout, one per line:

    {"type": "ready"}
    {"type": "hand", "pose": "open"}                        # open / fist / other / none, on change
    {"type": "gesture", "pose": "fist", "direction": "right"}
    {"type": "error", "message": "..."}

Frames never leave this process. Run standalone to debug:

    python listener/hands.py
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import signal
import sys
import time
import types
from pathlib import Path

from env import load_env
from hand_pose import Point, SwipeDetector, classify_pose, palm_center

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CAMERA = "/dev/video0"
DEFAULT_MODEL = ROOT / "models" / "hand_landmarker.task"
FRAME_WIDTH, FRAME_HEIGHT, FPS = 640, 480, 30
PR_SET_PDEATHSIG = 1  # linux/prctl.h


def camera_device() -> str:
    return os.environ.get("FRIDAY_CAMERA") or DEFAULT_CAMERA


def hand_model_path() -> Path:
    setting = os.environ.get("FRIDAY_HAND_MODEL")
    return Path(setting) if setting else DEFAULT_MODEL


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def exit_with_parent() -> None:
    """Have the kernel send SIGTERM when the Electron shell dies, however it dies.

    hands.py writes only when the pose changes, so a dead shell would otherwise
    go unnoticed, and the camera stay on, until the next pose change.
    """
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_PDEATHSIG) failed")


class Tracker:
    """Turns each frame's landmarks into events. No camera, so the tests drive it."""

    def __init__(self, detector: SwipeDetector | None = None):
        self.detector = detector or SwipeDetector()
        self.pose: str | None = None

    def frame(self, t: float, landmarks: list[Point] | None) -> list[dict]:
        pose = classify_pose(landmarks)
        events = []
        if pose != self.pose:
            self.pose = pose
            events.append({"type": "hand", "pose": pose})
        swipe = self.detector.update(t, pose, palm_center(landmarks) if landmarks else None)
        if swipe:
            events.append({"type": "gesture", "pose": swipe.pose, "direction": swipe.direction})
        return events


def _without_audio() -> None:
    # mediapipe.tasks imports sounddevice for its audio tasks, and PortAudio's
    # JACK backend (pipewire-jack) gets this process SIGKILLed while it starts.
    # Hand tracking needs no audio, so stand in for it before mediapipe loads.
    sys.modules.setdefault("sounddevice", types.ModuleType("sounddevice"))
    os.environ.setdefault("GLOG_minloglevel", "2")  # keep MediaPipe's info lines out of the journal


def load_landmarker(model: Path):
    """MediaPipe's hand landmarker in video mode, tracking one hand."""
    if not model.is_file():
        raise FileNotFoundError(f"hand model missing: {model} (see README, Install)")
    _without_audio()
    from mediapipe.tasks.python import BaseOptions, vision

    options = vision.HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(model)),
        running_mode=vision.RunningMode.VIDEO,
        num_hands=1,
    )
    return vision.HandLandmarker.create_from_options(options)


def find_hand(landmarker, rgb, timestamp_ms: int) -> list[Point] | None:
    """The (x, y) landmarks of the hand in an RGB frame, or None."""
    import mediapipe as mp

    result = landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), timestamp_ms)
    if not result.hand_landmarks:
        return None
    return [(point.x, point.y) for point in result.hand_landmarks[0]]


def open_camera(device: str):
    import cv2

    camera = cv2.VideoCapture(device, cv2.CAP_V4L2)
    camera.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    camera.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_WIDTH)
    camera.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_HEIGHT)
    camera.set(cv2.CAP_PROP_FPS, FPS)
    if not camera.isOpened():
        raise RuntimeError(f"cannot open camera {device}")
    return camera


def run(camera, landmarker, tracker: Tracker) -> None:
    import cv2

    start = time.monotonic()
    while True:
        ok, frame = camera.read()
        if not ok:
            raise RuntimeError("the camera stopped delivering frames")
        t = time.monotonic() - start
        # Mirrored, so the owner's right is the frame's right.
        rgb = cv2.cvtColor(cv2.flip(frame, 1), cv2.COLOR_BGR2RGB)
        for event in tracker.frame(t, find_hand(landmarker, rgb, int(t * 1000))):
            emit(event)


def main() -> int:
    load_env()
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args()
    # Stopping gesture mode sends SIGTERM: unwind through finally to release the camera.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    exit_with_parent()
    try:
        landmarker = load_landmarker(hand_model_path())
    except Exception as exc:  # noqa: BLE001 - any load failure is reported, then the shell retries
        emit({"type": "error", "message": f"hand tracking unavailable: {exc}"})
        return 1
    try:
        camera = open_camera(camera_device())
    except Exception as exc:  # noqa: BLE001 - a missing or busy camera is reported, then the shell retries
        landmarker.close()
        emit({"type": "error", "message": f"hand tracking unavailable: {exc}"})
        return 1
    emit({"type": "ready"})
    try:
        run(camera, landmarker, Tracker())
    except RuntimeError as exc:
        emit({"type": "error", "message": str(exc)})
        return 1
    finally:
        camera.release()
        landmarker.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
