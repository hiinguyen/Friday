"""Tests for the camera hand tracker, without a camera.

Tracker is fed synthetic landmarks (test_hand_pose.make_hand). The landmarker
smoke test needs models/hand_landmarker.task (not in git) and mediapipe.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

import hands
from test_hand_pose import make_hand

needs_model = pytest.mark.skipif(not hands.hand_model_path().is_file(), reason="hand landmarker model missing")


def test_a_new_pose_is_reported_once():
    tracker = hands.Tracker()
    assert tracker.frame(0.0, make_hand()) == [{"type": "hand", "pose": "open"}]
    assert tracker.frame(0.033, make_hand()) == []
    assert tracker.frame(0.066, None) == [{"type": "hand", "pose": "none"}]


def test_a_swipe_becomes_one_gesture_event():
    tracker = hands.Tracker()
    events = []
    for i in range(10):
        events += tracker.frame(i / 30, make_hand(center=(0.3 + 0.035 * i, 0.5)))
    assert events == [
        {"type": "hand", "pose": "open"},
        {"type": "gesture", "pose": "open", "direction": "right"},
    ]


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
        assert hands.find_hand(landmarker, np.zeros((480, 640, 3), np.uint8), 0) is None
    finally:
        landmarker.close()
