"""Hand pose and swipe recognition from MediaPipe hand landmarks.

Pure functions and one small state machine, with no camera and no MediaPipe,
so the tests drive them with synthetic landmarks. Points are normalized image
coordinates (0..1) of a frame hands.py has already mirrored, so x grows as the
owner moves their hand to their own right.
"""

from __future__ import annotations

import math
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

Pose = Literal["open", "fist", "other", "none"]
Point = tuple[float, float]

LANDMARKS = 21
WRIST = 0
# (tip, pip) of the index, middle, ring and pinky fingers. The thumb is left
# out: it folds sideways, so from the front it looks extended either way.
FINGERS = ((8, 6), (12, 10), (16, 14), (20, 18))
PALM = (0, 5, 9, 13, 17)  # wrist and the four knuckles
# A finger is extended when its tip is this much farther from the wrist than
# its middle joint. Distances, not directions, so a turned hand still counts.
EXTENDED_RATIO = 1.15


def _distance(a: Point, b: Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def classify_pose(landmarks: Sequence[Point] | None) -> Pose:
    """open (four fingers out), fist (none out), other, or none when no hand was found."""
    if not landmarks:
        return "none"
    if len(landmarks) != LANDMARKS:
        raise ValueError(f"expected {LANDMARKS} hand landmarks, got {len(landmarks)}")
    wrist = landmarks[WRIST]
    extended = sum(
        _distance(wrist, landmarks[tip]) > EXTENDED_RATIO * _distance(wrist, landmarks[pip]) for tip, pip in FINGERS
    )
    if extended == len(FINGERS):
        return "open"
    if extended == 0:
        return "fist"
    return "other"


def palm_center(landmarks: Sequence[Point]) -> Point:
    """Mean of the wrist and the knuckles: steadier than any single point while fingers move."""
    xs = [landmarks[i][0] for i in PALM]
    ys = [landmarks[i][1] for i in PALM]
    return (sum(xs) / len(PALM), sum(ys) / len(PALM))


@dataclass(frozen=True)
class Swipe:
    pose: Literal["open", "fist"]
    direction: Literal["left", "right"]


class SwipeDetector:
    """A fast, mostly horizontal movement of an open hand or a fist.

    A swipe is at least `min_dx` (fraction of the frame width) of travel within
    `window_s` seconds while the pose stays the same, with vertical travel at
    most `max_slope` times the horizontal. After one, nothing is detected for
    `cooldown_s`, so the hand coming back is not read as a swipe the other way.
    A single blurred frame ("other") is skipped; losing the hand or changing
    between open and fist starts over.
    """

    def __init__(self, window_s: float = 0.45, min_dx: float = 0.22, max_slope: float = 0.6, cooldown_s: float = 0.9):
        self.window_s = window_s
        self.min_dx = min_dx
        self.max_slope = max_slope
        self.cooldown_s = cooldown_s
        self._samples: deque[tuple[float, Point]] = deque()
        self._pose: Pose | None = None
        self._quiet_until = -math.inf

    def _reset(self) -> None:
        self._samples.clear()
        self._pose = None

    def update(self, t: float, pose: Pose, center: Point | None) -> Swipe | None:
        """Feed one frame at time `t` (seconds); the swipe it completes, if any."""
        if t < self._quiet_until:
            self._reset()
            return None
        if pose == "other":
            return None
        if pose not in ("open", "fist") or center is None:
            self._reset()
            return None
        if pose != self._pose:
            self._reset()
            self._pose = pose
        self._samples.append((t, center))
        while t - self._samples[0][0] > self.window_s:
            self._samples.popleft()
        x0, y0 = self._samples[0][1]
        dx, dy = center[0] - x0, center[1] - y0
        if abs(dx) < self.min_dx or abs(dy) > self.max_slope * abs(dx):
            return None
        self._reset()
        self._quiet_until = t + self.cooldown_s
        return Swipe(pose, "right" if dx > 0 else "left")
