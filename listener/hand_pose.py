"""Finger counting, finger commands, pinch swipes and the two-hand zoom from MediaPipe hand landmarks.

Pure functions and small state machines, with no camera and no MediaPipe,
so the tests drive them with synthetic landmarks. Points are normalized image
coordinates (0..1). Everything is measured as distances between landmarks, so
a turned hand, and a left hand as well as a right one, count the same.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

Point = tuple[float, float]

LANDMARKS = 21
WRIST = 0
THUMB_IP, THUMB_TIP = 3, 4
INDEX_MCP, INDEX_TIP, MIDDLE_MCP, PINKY_MCP = 5, 8, 9, 17
# (tip, pip) of the index, middle, ring and pinky fingers.
FINGERS = ((8, 6), (12, 10), (16, 14), (20, 18))
# A finger is extended when its tip is this much farther from the wrist than
# its middle joint.
EXTENDED_RATIO = 1.15
# The thumb folds sideways, so it gets its own test: it is out when its tip
# is farther from the pinky knuckle than its own last joint is, and clear of
# the index knuckle by this fraction of the palm (wrist to middle knuckle).
THUMB_OUT_RATIO = 1.05
THUMB_CLEAR_PALMS = 0.5
# A pinch (see Swipes): the thumb tip this close to the index tip, in palms,
# starts one, and it lasts until they are this far apart again.
PINCH_ON_PALMS = 0.3
PINCH_OFF_PALMS = 0.5
# A pinch dragged this far (a fraction of the frame) is one swipe, if it went
# this many times farther along one axis than along the other.
SWIPE_DISTANCE = 0.1
SWIPE_STRAIGHTNESS = 2.0
# Screen zoom (see Zoom): the range, the smallest change worth sending, how
# close to 1 snaps back to exactly 1, and how much of each frame's spread goes
# into the smoothed spread.
ZOOM_LOW, ZOOM_HIGH = 1.0, 4.0
ZOOM_STEP = 0.03
ZOOM_SNAP = 0.1
ZOOM_SMOOTHING = 0.5


def _distance(a: Point, b: Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def thumb_extended(landmarks: Sequence[Point]) -> bool:
    palm = _distance(landmarks[WRIST], landmarks[MIDDLE_MCP])
    tip, pinky = landmarks[THUMB_TIP], landmarks[PINKY_MCP]
    return (
        _distance(tip, pinky) > THUMB_OUT_RATIO * _distance(landmarks[THUMB_IP], pinky)
        and _distance(tip, landmarks[INDEX_MCP]) > THUMB_CLEAR_PALMS * palm
    )


def _finger_extended(landmarks: Sequence[Point], tip: int, pip: int) -> bool:
    wrist = landmarks[WRIST]
    return _distance(wrist, landmarks[tip]) > EXTENDED_RATIO * _distance(wrist, landmarks[pip])


def count_fingers(landmarks: Sequence[Point] | None) -> int | None:
    """How many fingers are up (0 is a fist, 5 an open hand), or None when no hand was found."""
    if not landmarks:
        return None
    if len(landmarks) != LANDMARKS:
        raise ValueError(f"expected {LANDMARKS} hand landmarks, got {len(landmarks)}")
    return sum(_finger_extended(landmarks, tip, pip) for tip, pip in FINGERS) + thumb_extended(landmarks)


def _pinch_gap(landmarks: Sequence[Point]) -> float:
    """How far apart the thumb and index tips are, in palms (wrist to middle knuckle)."""
    palm = _distance(landmarks[WRIST], landmarks[MIDDLE_MCP])
    return _distance(landmarks[THUMB_TIP], landmarks[INDEX_TIP]) / palm if palm else math.inf


def pinched(landmarks: Sequence[Point]) -> bool:
    """The thumb tip on the index tip."""
    return _pinch_gap(landmarks) < PINCH_ON_PALMS


def zoom_pose(landmarks: Sequence[Point]) -> bool:
    """The index finger out and the middle, ring and pinky fingers folded.

    The thumb, the least reliable finger to detect, is not checked.
    """
    index, *others = FINGERS
    return _finger_extended(landmarks, *index) and not any(_finger_extended(landmarks, *f) for f in others)


def zoom_handle(landmarks: Sequence[Point]) -> Point:
    """Where a hand in the zoom pose holds the zoom: between its thumb and index tips."""
    (tx, ty), (ix, iy) = landmarks[THUMB_TIP], landmarks[INDEX_TIP]
    return ((tx + ix) / 2, (ty + iy) / 2)


@dataclass(frozen=True)
class Command:
    action: Literal["switch", "carry"]
    workspace: int


class FingerCommands:
    """Turns a stream of finger counts into workspace commands.

    Holding up 1 to 5 fingers for `hold_s` switches to that workspace. Holding
    a fist for `grab_s` first grabs the focused window: the next count held
    within `carry_s` of letting go of the fist carries it there instead.
    A command fires once: the same count does not fire again until another
    count fires, a fist is made, or the hand is gone for longer than `gap_s`,
    so a finger that flickers for a frame cannot send a second command.
    Counts on the way from a fist to the fingers never last `hold_s`, so they
    do nothing.
    """

    def __init__(self, hold_s: float = 0.5, grab_s: float = 0.3, carry_s: float = 3.0, gap_s: float = 0.3):
        self.hold_s = hold_s
        self.grab_s = grab_s
        self.carry_s = carry_s
        self.gap_s = gap_s
        self.count: int | None = None  # the count being held
        self._since = 0.0
        self._last_seen = -math.inf
        self._fired: int | None = None
        self._grab_seen = -math.inf  # last time a grabbing fist was in view
        self._held_off = False  # two hands were in view: no commands until the hands are gone

    def carrying(self, t: float) -> bool:
        """A window is grabbed and waiting for a count to carry it to."""
        return t - self._grab_seen <= self.carry_s

    def progress(self, t: float) -> float:
        """How far the current count is towards firing (or grabbing, for a fist), 0..1."""
        if self.count is None or self.count == self._fired or self._held_off:
            return 0.0
        needed = self.grab_s if self.count == 0 else self.hold_s
        return min(1.0, (t - self._since) / needed)

    def hold_off(self, t: float) -> None:
        """Two hands are in view (a zoom): no commands until no hand is, so the hand left after a zoom fires nothing."""
        self._last_seen = t
        self.count = None
        self._grab_seen = -math.inf
        self._held_off = True

    def pause(self, t: float) -> None:
        """The hand is busy with something else (a pinch): no count is being held."""
        self._last_seen = t
        self.count = None

    def update(self, t: float, fingers: int | None) -> Command | None:
        """Feed one frame at time `t` (seconds); the command it completes, if any."""
        if fingers is None:
            if t - self._last_seen > self.gap_s:
                self.count = None
                self._fired = None
                self._grab_seen = -math.inf
                self._held_off = False
            return None
        self._last_seen = t
        if fingers != self.count:
            self.count = fingers
            self._since = t
        held = t - self._since
        if self._held_off:
            return None
        if fingers == 0:
            if held >= self.grab_s:
                self._grab_seen = t
                self._fired = None
            return None
        if held < self.hold_s or fingers == self._fired:
            return None
        action = "carry" if self.carrying(t) else "switch"
        self._fired = fingers
        self._grab_seen = -math.inf
        return Command(action, fingers)


class Swipes:
    """Turns a pinch dragged up, down, left or right into swipes.

    A vertical drag swipes once for every `distance` it covers, so one long drag
    scrolls on; a sideways drag swipes once per pinch (back and forward go one
    page each). A diagonal drag does nothing. A pinch swipes only the way its
    first swipe went: bringing the hand back to scroll on, still pinching,
    does not scroll back. Going the other way takes a new pinch.
    """

    def __init__(self, distance: float = SWIPE_DISTANCE):
        self.distance = distance
        self.pinched = False
        self._anchor: Point | None = None  # where the drag being measured started
        self._direction: str | None = None  # the way this pinch swipes, once it has

    def update(self, hand: Sequence[Point] | None) -> str | None:
        """Feed the one hand in view (None: no hand, or two); the swipe it completes: "up", "down", "left", "right"."""
        if hand is None:
            self.pinched = False
        else:
            self.pinched = _pinch_gap(hand) < (PINCH_OFF_PALMS if self.pinched else PINCH_ON_PALMS)
        if not self.pinched:
            self._anchor = None
            self._direction = None
            return None
        (tx, ty), (ix, iy) = hand[THUMB_TIP], hand[INDEX_TIP]
        point = ((tx + ix) / 2, (ty + iy) / 2)
        if self._anchor is None:
            self._anchor = point
            return None
        dx, dy = point[0] - self._anchor[0], point[1] - self._anchor[1]
        if max(abs(dx), abs(dy)) < self.distance:
            return None
        if abs(dy) >= SWIPE_STRAIGHTNESS * abs(dx):
            direction = "down" if dy > 0 else "up"
        elif abs(dx) >= SWIPE_STRAIGHTNESS * abs(dy):
            direction = "right" if dx > 0 else "left"
        else:
            return None
        self._anchor = point
        sideways = direction in ("left", "right")
        if self._direction is not None and (direction != self._direction or sideways):
            return None
        self._direction = direction
        return direction


class Zoom:
    """Turns two hands in the zoom pose into a screen zoom factor.

    Once both hands have held the pose for `arm_s`, the zoom follows the spread
    between them: twice as far apart as when it took hold, twice the zoom it
    had then. Letting go (the pose gone for longer than `gap_s`) keeps the zoom,
    and the next pose zooms on from it, so a long zoom can take several pulls.
    """

    def __init__(self, arm_s: float = 0.2, gap_s: float = 0.3, low: float = ZOOM_LOW, high: float = ZOOM_HIGH):
        self.arm_s = arm_s
        self.gap_s = gap_s
        self.low = low
        self.high = high
        self.factor = low  # the zoom last reported
        self._pose_since: float | None = None
        self._last_pose = -math.inf
        self._base: tuple[float, float] | None = None  # (spread, factor) when the zoom took hold
        self._spread = 0.0  # smoothed spread

    @property
    def active(self) -> bool:
        return self._base is not None

    def update(self, t: float, hands: Sequence[Sequence[Point]]) -> float | None:
        """Feed one frame's hands at time `t` (seconds); the new zoom factor, if it changed."""
        if len(hands) != 2 or not all(zoom_pose(hand) for hand in hands):
            if t - self._last_pose > self.gap_s:
                self._pose_since = None
                self._base = None
            return None
        self._last_pose = t
        spread = _distance(zoom_handle(hands[0]), zoom_handle(hands[1]))
        if self._pose_since is None:
            self._pose_since = t
        if self._base is None:
            if t - self._pose_since >= self.arm_s and spread > 0:
                self._base = (spread, self.factor)
                self._spread = spread
            return None
        self._spread += ZOOM_SMOOTHING * (spread - self._spread)
        base_spread, base_factor = self._base
        target = min(self.high, max(self.low, base_factor * self._spread / base_spread))
        if target < self.low + ZOOM_SNAP:
            target = self.low
        target = round(target, 2)
        at_bound = target in (self.low, self.high)
        if target == self.factor or (abs(target - self.factor) < ZOOM_STEP and not at_bound):
            return None
        self.factor = target
        return target
