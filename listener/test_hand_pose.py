"""Tests for hand pose and swipe recognition, driven by synthetic landmarks.

make_hand() builds the 21 MediaPipe hand landmarks of an upright hand in
normalized image coordinates; stroke() feeds a detector one straight hand
movement at 30 fps. test_hands.py reuses make_hand().
"""

from __future__ import annotations

import math

import pytest

from hand_pose import Swipe, SwipeDetector, classify_pose, palm_center

# x offsets of the index, middle, ring and pinky columns from the palm center.
FINGER_X = (-0.045, -0.015, 0.015, 0.045)


def make_hand(extended=(True, True, True, True), center=(0.5, 0.5), angle=0.0):
    """Landmarks of a hand whose fingers are `extended` (index..pinky), rotated by `angle` radians."""
    rel = [(0.0, 0.0)] * 21
    rel[0] = (0.0, 0.15)  # wrist, below the palm
    for i, point in zip(range(1, 5), ((-0.05, 0.10), (-0.07, 0.06), (-0.08, 0.03), (-0.09, 0.0))):
        rel[i] = point  # thumb: ignored by the classifier
    for finger, dx in enumerate(FINGER_X):
        mcp = 5 + 4 * finger
        rel[mcp] = (dx, 0.0)
        rel[mcp + 1] = (dx, -0.05)  # pip
        if extended[finger]:
            rel[mcp + 2], rel[mcp + 3] = (dx, -0.085), (dx, -0.12)  # dip, tip: straight up
        else:
            rel[mcp + 2], rel[mcp + 3] = (dx, -0.02), (dx, 0.02)  # folded back over the palm
    cos, sin = math.cos(angle), math.sin(angle)
    return [(center[0] + x * cos - y * sin, center[1] + x * sin + y * cos) for x, y in rel]


def stroke(detector, pose, x0, x1, t0, duration, y0=0.5, y1=None, fps=30):
    """Move the palm center in a straight line from (x0, y0) to (x1, y1); the swipes it produced."""
    y1 = y0 if y1 is None else y1
    frames = max(2, round(duration * fps))
    swipes = []
    for i in range(frames + 1):
        f = i / frames
        swipe = detector.update(t0 + f * duration, pose, (x0 + (x1 - x0) * f, y0 + (y1 - y0) * f))
        if swipe:
            swipes.append(swipe)
    return swipes


def test_an_open_hand_is_open():
    assert classify_pose(make_hand()) == "open"


def test_four_folded_fingers_are_a_fist():
    assert classify_pose(make_hand((False, False, False, False))) == "fist"


def test_some_fingers_up_is_another_pose():
    assert classify_pose(make_hand((True, True, False, False))) == "other"


def test_the_pose_does_not_depend_on_how_the_hand_is_turned():
    assert classify_pose(make_hand(angle=math.pi / 2)) == "open"
    assert classify_pose(make_hand((False, False, False, False), angle=-math.pi / 3)) == "fist"


def test_no_hand_is_none():
    assert classify_pose(None) == "none"
    assert classify_pose([]) == "none"


def test_a_partial_hand_is_rejected():
    with pytest.raises(ValueError):
        classify_pose(make_hand()[:20])


def test_the_palm_center_follows_the_hand():
    x, y = palm_center(make_hand(center=(0.4, 0.6)))
    assert x == pytest.approx(0.4)
    assert y == pytest.approx(0.63)  # the wrist sits below the knuckles


def test_a_quick_open_hand_swipe_right_is_one_swipe():
    assert stroke(SwipeDetector(), "open", 0.3, 0.65, t0=0.0, duration=0.3) == [Swipe("open", "right")]


def test_a_quick_fist_swipe_left_is_one_swipe():
    assert stroke(SwipeDetector(), "fist", 0.7, 0.35, t0=0.0, duration=0.3) == [Swipe("fist", "left")]


def test_a_slow_drift_is_not_a_swipe():
    assert stroke(SwipeDetector(), "open", 0.3, 0.6, t0=0.0, duration=2.0) == []


def test_a_diagonal_movement_is_not_a_swipe():
    assert stroke(SwipeDetector(), "open", 0.3, 0.6, t0=0.0, duration=0.3, y0=0.3, y1=0.6) == []


def test_the_return_stroke_after_a_swipe_is_ignored():
    detector = SwipeDetector()
    assert stroke(detector, "open", 0.3, 0.65, t0=0.0, duration=0.3) == [Swipe("open", "right")]
    assert stroke(detector, "open", 0.65, 0.3, t0=0.33, duration=0.3) == []
    assert stroke(detector, "open", 0.65, 0.3, t0=2.0, duration=0.3) == [Swipe("open", "left")]


def test_changing_pose_mid_movement_starts_over():
    detector = SwipeDetector()
    assert stroke(detector, "open", 0.3, 0.45, t0=0.0, duration=0.15) == []
    assert stroke(detector, "fist", 0.45, 0.6, t0=0.17, duration=0.15) == []


def test_a_blurred_frame_mid_swipe_does_not_break_it():
    detector = SwipeDetector()
    swipes = []
    for i in range(10):
        pose = "other" if i in (4, 5) else "open"
        swipe = detector.update(i / 30, pose, (0.3 + 0.04 * i, 0.5))
        if swipe:
            swipes.append(swipe)
    assert swipes == [Swipe("open", "right")]


def test_losing_the_hand_mid_movement_starts_over():
    detector = SwipeDetector()
    assert stroke(detector, "open", 0.3, 0.45, t0=0.0, duration=0.15) == []
    assert detector.update(0.16, "none", None) is None
    assert stroke(detector, "open", 0.45, 0.6, t0=0.17, duration=0.15) == []
