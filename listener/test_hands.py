"""Tests for the camera hand tracker, without a camera.

Tracker is fed synthetic landmarks (test_hand_pose.hand_with). The landmarker
smoke test needs models/hand_landmarker.task (not in git) and mediapipe.
"""

from __future__ import annotations

import base64
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pytest

import hands
from hand_pose import ZOOM_STEP
from test_hand_pose import hand_with, line, pinch_hand, zoom_hands

needs_model = pytest.mark.skipif(not hands.hand_model_path().is_file(), reason="hand landmarker model missing")


def test_a_new_count_is_reported_once():
    tracker = hands.Tracker()
    assert tracker.frame(0.0, [hand_with(3)]) == [
        {"type": "hand", "fingers": 3, "carrying": False, "zooming": False, "pinched": False}
    ]
    assert tracker.frame(0.033, [hand_with(3)]) == []
    assert tracker.frame(0.066, []) == [
        {"type": "hand", "fingers": None, "carrying": False, "zooming": False, "pinched": False}
    ]


def test_holding_fingers_up_becomes_one_gesture_event():
    tracker = hands.Tracker()
    events = []
    for i in range(30):
        events += tracker.frame(i / 30, [hand_with(2)])
    assert events == [
        {"type": "hand", "fingers": 2, "carrying": False, "zooming": False, "pinched": False},
        {"type": "gesture", "action": "switch", "workspace": 2},
    ]


def test_a_fist_then_fingers_reports_the_grab_and_the_carry():
    tracker = hands.Tracker()
    events = []
    for i in range(15):
        events += tracker.frame(i / 30, [hand_with(0)])
    for i in range(15, 45):
        events += tracker.frame(i / 30, [hand_with(4)])
    assert events == [
        {"type": "hand", "fingers": 0, "carrying": False, "zooming": False, "pinched": False},
        {"type": "hand", "fingers": 0, "carrying": True, "zooming": False, "pinched": False},
        {"type": "hand", "fingers": 4, "carrying": True, "zooming": False, "pinched": False},
        {"type": "gesture", "action": "carry", "workspace": 4},
        {"type": "hand", "fingers": 4, "carrying": False, "zooming": False, "pinched": False},
    ]


def test_the_debug_picture_has_the_landmarks_count_and_progress():
    tracker = hands.Tracker(hands.FingerCommands(hold_s=0.5))
    tracker.frame(0.0, [hand_with(1)])
    tracker.frame(0.25, [hand_with(1)])
    picture = tracker.debug(0.25)
    assert picture["type"] == "frame"
    assert [len(hand) for hand in picture["hands"]] == [21]
    assert picture["fingers"] == 1
    assert picture["carrying"] is False
    assert picture["progress"] == pytest.approx(0.5)
    tracker.frame(0.3, [])
    assert tracker.debug(0.3)["hands"] == []


def test_spreading_two_hands_reports_the_zoom_and_holds_off_commands():
    tracker = hands.Tracker(zoom=hands.Zoom(arm_s=0.1))
    events = []
    for i in range(6):
        events += tracker.frame(i / 30, zoom_hands(0.2))
    for i in range(6, 40):
        events += tracker.frame(i / 30, zoom_hands(0.3))
    # Back to one hand, still showing two fingers: no workspace 2.
    for i in range(40, 80):
        events += tracker.frame(i / 30, zoom_hands(0.3)[1:])
    kinds = [event["type"] for event in events]
    assert "gesture" not in kinds
    zooms = [event["factor"] for event in events if event["type"] == "zoom"]
    assert zooms[-1] == pytest.approx(1.5, abs=ZOOM_STEP)
    hand_events = [event for event in events if event["type"] == "hand"]
    assert hand_events[0] == {"type": "hand", "fingers": 2, "carrying": False, "zooming": False, "pinched": False}
    assert {"type": "hand", "fingers": 2, "carrying": False, "zooming": True, "pinched": False} in hand_events
    assert hand_events[-1]["zooming"] is False


def test_the_debug_picture_shows_both_hands_and_the_zoom():
    tracker = hands.Tracker(zoom=hands.Zoom(arm_s=0.1))
    for i in range(20):
        tracker.frame(i / 30, zoom_hands(0.2 + i / 100))
    picture = tracker.debug(20 / 30)
    assert [len(hand) for hand in picture["hands"]] == [21, 21]
    assert picture["zooming"] is True
    assert picture["zoom"] > 1.0


def test_a_pinch_dragged_up_reports_a_swipe_and_no_finger_command():
    tracker = hands.Tracker(swipes=hands.Swipes(distance=0.1))
    events = []
    points = [(0.5, 0.6)] * 30 + line((0.5, 0.6), (0.5, 0.45), steps=15)
    for i, point in enumerate(points):
        events += tracker.frame(i / 30, [pinch_hand(point)])
    assert [event for event in events if event["type"] in ("swipe", "gesture")] == [
        {"type": "swipe", "direction": "up"}
    ]
    assert events[0] == {
        "type": "hand",
        "fingers": events[0]["fingers"],
        "carrying": False,
        "zooming": False,
        "pinched": True,
    }
    assert tracker.debug(len(points) / 30)["pinched"] is True


def test_the_debug_frame_is_a_small_jpeg():
    jpeg = base64.b64decode(hands.debug_jpeg(np.zeros((480, 640, 3), np.uint8)))
    assert jpeg[:2] == b"\xff\xd8"
    assert len(jpeg) < 20000


def test_timing_and_debug_come_from_the_environment(monkeypatch):
    monkeypatch.setenv("FRIDAY_GESTURE_HOLD_MS", "800")
    monkeypatch.setenv("FRIDAY_GESTURE_GRAB_MS", "soon")
    monkeypatch.delenv("FRIDAY_GESTURE_CARRY_MS", raising=False)
    assert hands.timing() == {"hold_s": 0.8, "grab_s": 0.3, "carry_s": 3.0}
    monkeypatch.setenv("FRIDAY_GESTURE_DEBUG", "1")
    assert hands.debug_enabled()
    monkeypatch.setenv("FRIDAY_GESTURE_DEBUG", "")
    assert not hands.debug_enabled()


def test_settings_default_to_the_integrated_camera_and_the_bundled_model(monkeypatch):
    monkeypatch.delenv("FRIDAY_CAMERA", raising=False)
    monkeypatch.delenv("FRIDAY_HAND_MODEL", raising=False)
    assert hands.camera_device() == "/dev/video0"
    assert hands.hand_model_path() == Path(hands.__file__).resolve().parent.parent / "models" / "hand_landmarker.task"


def test_settings_come_from_the_environment(monkeypatch):
    monkeypatch.setenv("FRIDAY_CAMERA", "/dev/video2")
    monkeypatch.setenv("FRIDAY_HAND_MODEL", "/tmp/hand.task")
    assert hands.camera_device() == "/dev/video2"
    assert hands.hand_model_path() == Path("/tmp/hand.task")


def test_a_missing_model_is_reported_by_name(tmp_path):
    with pytest.raises(FileNotFoundError, match="hand.task"):
        hands.load_landmarker(tmp_path / "hand.task")


@needs_model
def test_the_landmarker_finds_no_hand_in_a_black_frame():
    landmarker = hands.load_landmarker(hands.hand_model_path())
    try:
        assert hands.find_hands(landmarker, np.zeros((480, 640, 3), np.uint8), 0) == []
    finally:
        landmarker.close()


# A parent that starts a child calling exit_with_parent(), then is SIGKILLed like a crashed shell.
CHILD = """
import os, sys, time
sys.path.insert(0, {listener!r})
import hands
from hand_pose import ZOOM_STEP
hands.exit_with_parent()
tmp = {pidfile!r} + ".tmp"
with open(tmp, "w") as f:
    f.write(str(os.getpid()))
os.replace(tmp, {pidfile!r})
time.sleep(30)
"""
PARENT = """
import subprocess, sys, time
subprocess.Popen([sys.executable, {child!r}])
time.sleep(30)
"""


def _running(pid: int) -> bool:
    try:
        return Path(f"/proc/{pid}/stat").read_text().split()[2] != "Z"
    except FileNotFoundError:
        return False


def _wait_for(condition, timeout_s: float, message: str) -> None:
    deadline = time.monotonic() + timeout_s
    while not condition():
        assert time.monotonic() < deadline, message
        time.sleep(0.05)


def test_the_tracker_exits_when_the_shell_dies(tmp_path):
    pidfile = tmp_path / "child.pid"
    child = tmp_path / "child.py"
    child.write_text(CHILD.format(listener=str(Path(hands.__file__).resolve().parent), pidfile=str(pidfile)))
    script = tmp_path / "parent.py"
    script.write_text(PARENT.format(child=str(child)))
    parent = subprocess.Popen([sys.executable, str(script)])
    try:
        _wait_for(pidfile.exists, 10, "the child never started")
        child_pid = int(pidfile.read_text())
        parent.kill()
        parent.wait()
        _wait_for(lambda: not _running(child_pid), 5, "the child outlived its parent")
    finally:
        parent.kill()
        if pidfile.exists() and _running(int(pidfile.read_text())):
            os.kill(int(pidfile.read_text()), 9)
