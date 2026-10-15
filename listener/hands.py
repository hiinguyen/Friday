"""Camera hand tracker for F.R.I.D.A.Y. gesture control.

Runs only while gesture mode is on: the Electron shell starts it and stops it
(SIGTERM) when the mode ends, which releases the camera. It reads the webcam
with OpenCV, finds up to two hands with MediaPipe's hand landmarker, and
writes JSON events to stdout, one per line:

    {"type": "ready"}
    {"type": "hand", "fingers": 3, "carrying": false, "zooming": false, "pinched": false}  # on change
    {"type": "gesture", "action": "switch", "workspace": 3}  # or "carry": move the window there
    {"type": "swipe", "direction": "up"}                     # a pinch dragged up, down, left or right
    {"type": "zoom", "factor": 1.8}                          # two hands spread apart or brought together
    {"type": "error", "message": "..."}

fingers is null when no hand is in view. Finger commands need one hand in
view and pause while it pinches (a pinch drags swipes); two hands in the zoom pose zoom the
screen (hand_pose.Zoom), and hold finger commands off until no hand is in view.

With FRIDAY_GESTURE_DEBUG=1 it also writes, about 15 times a second, what it
sees for the debug view (app/src/gesture-debug.js): a small mirrored JPEG of
the frame, the landmarks of each hand it found, the count, how close it is to
firing and the zoom:

    {"type": "frame", "jpeg": "<base64>", "hands": [[[x, y], ...], ...],
     "fingers": 3, "carrying": false, "progress": 0.4, "zooming": false, "zoom": 1.0, "pinched": false}

Frames never leave the machine: the debug JPEGs go only to the Electron shell
that started this process. Run standalone to debug:

    python listener/hands.py
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import json
import os
import signal
import sys
import time
import types
from pathlib import Path

from env import load_env
from hand_pose import FingerCommands, Point, Swipes, Zoom, count_fingers

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CAMERA = "/dev/video0"
DEFAULT_MODEL = ROOT / "models" / "hand_landmarker.task"
FRAME_WIDTH, FRAME_HEIGHT, FPS = 640, 480, 30
MAX_HANDS = 2  # one for finger commands, two to zoom
PR_SET_PDEATHSIG = 1  # linux/prctl.h
# Debug view: every second frame (15 fps), scaled down, as JPEG.
DEBUG_EVERY = 2
DEBUG_WIDTH, DEBUG_HEIGHT, DEBUG_QUALITY = 320, 240, 70
# Finger command timing, in ms (see FingerCommands): .env can tune it.
TIMING_SETTINGS = {
    "hold_s": ("FRIDAY_GESTURE_HOLD_MS", 500),
    "grab_s": ("FRIDAY_GESTURE_GRAB_MS", 300),
    "carry_s": ("FRIDAY_GESTURE_CARRY_MS", 3000),
}


def camera_device() -> str:
    return os.environ.get("FRIDAY_CAMERA") or DEFAULT_CAMERA


def hand_model_path() -> Path:
    setting = os.environ.get("FRIDAY_HAND_MODEL")
    return Path(setting) if setting else DEFAULT_MODEL


def debug_enabled() -> bool:
    return os.environ.get("FRIDAY_GESTURE_DEBUG") == "1"


def timing() -> dict[str, float]:
    """FingerCommands keyword arguments, in seconds, from the FRIDAY_GESTURE_*_MS settings."""
    result = {}
    for name, (setting, default_ms) in TIMING_SETTINGS.items():
        try:
            ms = float(os.environ.get(setting, ""))
        except ValueError:
            ms = default_ms
        result[name] = (ms if ms > 0 else default_ms) / 1000
    return result


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def exit_with_parent() -> None:
    """Have the kernel send SIGTERM when the Electron shell dies, however it dies.

    hands.py writes only when the count changes, so a dead shell would otherwise
    go unnoticed, and the camera stay on, until the next change.
    """
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_PDEATHSIG) failed")


class Tracker:
    """Turns each frame's landmarks into events. No camera, so the tests drive it."""

    def __init__(self, commands: FingerCommands | None = None, zoom: Zoom | None = None, swipes: Swipes | None = None):
        self.commands = commands or FingerCommands()
        self.zoom = zoom or Zoom()
        self.swipes = swipes or Swipes()
        self.hand: dict | None = None  # the last "hand" event
        self.fingers: int | None = None  # of the first hand in view
        self.hands: list[list[Point]] = []

    def frame(self, t: float, hands: list[list[Point]]) -> list[dict]:
        """One frame's hands (none, one or two landmark lists); the events it makes."""
        self.hands = hands
        self.fingers = count_fingers(hands[0]) if hands else None
        factor = self.zoom.update(t, hands)
        direction = self.swipes.update(hands[0] if len(hands) == 1 else None)
        command = None
        if len(hands) > 1:
            self.commands.hold_off(t)
        elif self.swipes.pinched:
            self.commands.pause(t)
        else:
            command = self.commands.update(t, self.fingers)
        events = []
        if command:
            events.append({"type": "gesture", "action": command.action, "workspace": command.workspace})
        if factor is not None:
            events.append({"type": "zoom", "factor": factor})
        if direction:
            events.append({"type": "swipe", "direction": direction})
        hand = {
            "type": "hand",
            "fingers": self.fingers,
            "carrying": self.commands.carrying(t),
            "zooming": self.zoom.active,
            "pinched": self.swipes.pinched,
        }
        if hand != self.hand:
            self.hand = hand
            events.append(hand)
        return events

    def debug(self, t: float) -> dict:
        """The debug view's picture of the last frame, without the JPEG."""
        return {
            "type": "frame",
            "hands": [[[round(x, 4), round(y, 4)] for x, y in hand] for hand in self.hands],
            "fingers": self.fingers,
            "carrying": self.commands.carrying(t),
            "progress": round(self.commands.progress(t), 3),
            "zooming": self.zoom.active,
            "zoom": self.zoom.factor,
            "pinched": self.swipes.pinched,
        }


def _without_audio() -> None:
    # mediapipe.tasks imports sounddevice for its audio tasks, and PortAudio's
    # JACK backend (pipewire-jack) gets this process SIGKILLed while it starts.
    # Hand tracking needs no audio, so stand in for it before mediapipe loads.
    sys.modules.setdefault("sounddevice", types.ModuleType("sounddevice"))


def load_landmarker(model: Path):
    """MediaPipe's hand landmarker in video mode, tracking up to MAX_HANDS hands."""
    if not model.is_file():
        raise FileNotFoundError(f"hand model missing: {model} (see README, Install)")
    _without_audio()
    from mediapipe.tasks.python import BaseOptions, vision

    options = vision.HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(model)),
        running_mode=vision.RunningMode.VIDEO,
        num_hands=MAX_HANDS,
    )
    return vision.HandLandmarker.create_from_options(options)


def find_hands(landmarker, rgb, timestamp_ms: int) -> list[list[Point]]:
    """The (x, y) landmarks of each hand in an RGB frame."""
    import mediapipe as mp

    result = landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), timestamp_ms)
    return [[(point.x, point.y) for point in hand] for hand in result.hand_landmarks]


def open_camera(device: str):
    import cv2

    camera = cv2.VideoCapture(device, cv2.CAP_V4L2)
    # Uncompressed: some webcams (Logitech C270) send MJPG that libjpeg warns
    # about on every frame, and at 640x480 YUYV runs at the same frame rate.
    camera.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"YUYV"))
    camera.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_WIDTH)
    camera.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_HEIGHT)
    camera.set(cv2.CAP_PROP_FPS, FPS)
    if not camera.isOpened():
        raise RuntimeError(f"cannot open camera {device}")
    return camera


def debug_jpeg(mirrored_bgr) -> str:
    """The frame for the debug view: small, JPEG, base64."""
    import cv2

    small = cv2.resize(mirrored_bgr, (DEBUG_WIDTH, DEBUG_HEIGHT), interpolation=cv2.INTER_AREA)
    ok, jpeg = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, DEBUG_QUALITY])
    if not ok:
        raise RuntimeError("cannot encode the debug frame")
    return base64.b64encode(jpeg.tobytes()).decode("ascii")


def run(camera, landmarker, tracker: Tracker, debug: bool = False) -> None:
    import cv2

    start = time.monotonic()
    frames = 0
    while True:
        ok, frame = camera.read()
        if not ok:
            raise RuntimeError("the camera stopped delivering frames")
        t = time.monotonic() - start
        # Mirrored, so the picture moves the way the owner does.
        mirrored = cv2.flip(frame, 1)
        rgb = cv2.cvtColor(mirrored, cv2.COLOR_BGR2RGB)
        for event in tracker.frame(t, find_hands(landmarker, rgb, int(t * 1000))):
            emit(event)
        frames += 1
        if debug and frames % DEBUG_EVERY == 0:
            emit({**tracker.debug(t), "jpeg": debug_jpeg(mirrored)})


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
        run(camera, landmarker, Tracker(FingerCommands(**timing())), debug=debug_enabled())
    except RuntimeError as exc:
        emit({"type": "error", "message": str(exc)})
        return 1
    finally:
        camera.release()
        landmarker.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
