"""Tests for finger counting and finger commands, driven by synthetic landmarks.

make_hand() builds the 21 MediaPipe hand landmarks of an upright hand in
normalized image coordinates; hold() feeds a detector one count for a while at
30 fps. test_hands.py reuses make_hand() and hand_with().
"""

from __future__ import annotations

import math

import pytest

from hand_pose import ZOOM_STEP, Command, FingerCommands, Swipes, Zoom, count_fingers, pinched, zoom_handle, zoom_pose

# x offsets of the index, middle, ring and pinky columns from the palm center.
FINGER_X = (-0.045, -0.015, 0.015, 0.045)
THUMB_OUT = ((-0.05, 0.10), (-0.09, 0.07), (-0.13, 0.05), (-0.16, 0.03))  # cmc, mcp, ip, tip
THUMB_IN = ((-0.05, 0.10), (-0.06, 0.06), (-0.03, 0.04), (0.0, 0.03))  # folded across the palm


def make_hand(extended=(True, True, True, True, True), center=(0.5, 0.5), angle=0.0, mirror=False):
    """Landmarks of a hand whose fingers are `extended` (thumb..pinky), rotated by `angle` radians.

    `mirror` flips it left to right: the other hand.
    """
    rel = [(0.0, 0.0)] * 21
    rel[0] = (0.0, 0.15)  # wrist, below the palm
    rel[1:5] = THUMB_OUT if extended[0] else THUMB_IN
    for finger, dx in enumerate(FINGER_X):
        mcp = 5 + 4 * finger
        rel[mcp] = (dx, 0.0)
        rel[mcp + 1] = (dx, -0.05)  # pip
        if extended[finger + 1]:
            rel[mcp + 2], rel[mcp + 3] = (dx, -0.085), (dx, -0.12)  # dip, tip: straight up
        else:
            rel[mcp + 2], rel[mcp + 3] = (dx, -0.02), (dx, 0.02)  # folded back over the palm
    if mirror:
        rel = [(-x, y) for x, y in rel]
    cos, sin = math.cos(angle), math.sin(angle)
    return [(center[0] + x * cos - y * sin, center[1] + x * sin + y * cos) for x, y in rel]


def hand_with(count):
    """A hand showing `count` fingers the usual way: the index finger first, the thumb last."""
    order = (1, 2, 3, 4, 0)
    return make_hand(tuple(i in order[:count] for i in range(5)))


def hold(detector, fingers, t0, duration, fps=30):
    """Show `fingers` (None: no hand) from t0 for `duration` seconds; the commands it produced."""
    commands = []
    for i in range(round(duration * fps) + 1):
        command = detector.update(t0 + i / fps, fingers)
        if command:
            commands.append(command)
    return commands


@pytest.mark.parametrize("count", range(6))
def test_the_fingers_held_up_are_counted(count):
    assert count_fingers(hand_with(count)) == count


def test_a_fist_is_zero_and_an_open_hand_five():
    assert count_fingers(make_hand((False,) * 5)) == 0
    assert count_fingers(make_hand()) == 5


def test_the_thumb_alone_counts_as_one():
    assert count_fingers(make_hand((True, False, False, False, False))) == 1


def test_the_count_does_not_depend_on_how_the_hand_is_turned_or_which_hand_it_is():
    three = (False, True, True, True, False)
    assert count_fingers(make_hand(three, angle=math.pi / 2)) == 3
    assert count_fingers(make_hand(three, mirror=True)) == 3
    assert count_fingers(make_hand(angle=-math.pi / 3, mirror=True)) == 5
    assert count_fingers(make_hand((False,) * 5, angle=math.pi / 4)) == 0


def test_no_hand_is_none():
    assert count_fingers(None) is None
    assert count_fingers([]) is None


def test_a_partial_hand_is_rejected():
    with pytest.raises(ValueError):
        count_fingers(make_hand()[:20])


def test_holding_fingers_up_switches_to_that_workspace_once():
    detector = FingerCommands()
    assert hold(detector, 3, t0=0.0, duration=0.4) == []
    assert hold(detector, 3, t0=0.43, duration=2.0) == [Command("switch", 3)]


def test_a_flickering_count_does_not_fire_again():
    detector = FingerCommands()
    assert hold(detector, 3, t0=0.0, duration=1.0) == [Command("switch", 3)]
    assert hold(detector, 2, t0=1.03, duration=0.1) == []
    assert hold(detector, 3, t0=1.17, duration=1.0) == []


def test_another_count_switches_again_and_then_the_first_one_can_too():
    detector = FingerCommands()
    assert hold(detector, 3, t0=0.0, duration=1.0) == [Command("switch", 3)]
    assert hold(detector, 2, t0=1.03, duration=1.0) == [Command("switch", 2)]
    assert hold(detector, 3, t0=2.07, duration=1.0) == [Command("switch", 3)]


def test_counts_passed_through_quickly_do_nothing():
    detector = FingerCommands()
    assert hold(detector, 1, t0=0.0, duration=0.1) == []
    assert hold(detector, 2, t0=0.13, duration=0.1) == []
    assert hold(detector, 4, t0=0.27, duration=1.0) == [Command("switch", 4)]


def test_a_fist_then_fingers_carries_the_window():
    detector = FingerCommands()
    assert hold(detector, 0, t0=0.0, duration=0.5) == []
    assert detector.carrying(0.5)
    assert hold(detector, 2, t0=0.53, duration=1.0) == [Command("carry", 2)]
    assert not detector.carrying(1.6)


def test_a_fist_too_short_to_grab_carries_nothing():
    detector = FingerCommands()
    assert hold(detector, 0, t0=0.0, duration=0.2) == []
    assert hold(detector, 2, t0=0.23, duration=1.0) == [Command("switch", 2)]


def test_a_grab_lets_go_after_the_carry_time():
    detector = FingerCommands(carry_s=3.0)
    hold(detector, 0, t0=0.0, duration=0.5)
    assert hold(detector, None, t0=0.53, duration=0.2) == []  # a short gap keeps the grab
    assert detector.carrying(0.8)
    assert not detector.carrying(3.6)


def test_a_fist_lets_the_same_count_fire_again():
    detector = FingerCommands()
    assert hold(detector, 3, t0=0.0, duration=1.0) == [Command("switch", 3)]
    hold(detector, 0, t0=1.03, duration=0.5)
    assert hold(detector, 3, t0=1.57, duration=1.0) == [Command("carry", 3)]


def test_losing_the_hand_for_a_while_starts_over():
    detector = FingerCommands()
    assert hold(detector, 3, t0=0.0, duration=1.0) == [Command("switch", 3)]
    assert hold(detector, None, t0=1.03, duration=0.5) == []
    assert hold(detector, 3, t0=1.57, duration=1.0) == [Command("switch", 3)]


def test_a_dropped_frame_does_not_break_a_hold():
    detector = FingerCommands()
    commands = hold(detector, 4, t0=0.0, duration=0.3)
    commands += hold(detector, None, t0=0.33, duration=0.03)
    commands += hold(detector, 4, t0=0.4, duration=0.3)
    assert commands == [Command("switch", 4)]


def test_progress_shows_how_close_a_count_is_to_firing():
    detector = FingerCommands(hold_s=0.5, grab_s=0.3)
    detector.update(0.0, 2)
    assert detector.progress(0.25) == pytest.approx(0.5)
    detector.update(0.6, 2)
    assert detector.progress(0.7) == 0.0  # fired: nothing more to wait for
    detector.update(0.8, 0)
    assert detector.progress(0.95) == pytest.approx(0.5)


def zoom_hands(spread, center=0.5):
    """Both hands in the zoom pose (index and thumb out), their zoom handles `spread` apart; the left one mirrored."""
    pose = (True, True, False, False, False)

    def placed(handle_x, mirror):
        hand = make_hand(pose, mirror=mirror)
        dx = handle_x - zoom_handle(hand)[0]
        return [(x + dx, y) for x, y in hand]

    return [placed(center - spread / 2, True), placed(center + spread / 2, False)]


def zoom_through(zoom, spreads, t0=0.0, fps=30):
    """Feed `zoom` one frame per spread (None: no hands); the factors it reported."""
    factors = []
    for i, spread in enumerate(spreads):
        factor = zoom.update(t0 + i / fps, [] if spread is None else zoom_hands(spread))
        if factor is not None:
            factors.append(factor)
    return factors


def test_the_zoom_pose_is_the_index_finger_out_and_the_rest_folded():
    assert zoom_pose(make_hand((True, True, False, False, False)))
    assert zoom_pose(make_hand((False, True, False, False, False)))  # the thumb is not required
    assert not zoom_pose(make_hand())
    assert not zoom_pose(make_hand((True, True, True, False, False)))
    assert not zoom_pose(make_hand((False,) * 5))


def test_spreading_the_hands_zooms_in_by_the_ratio_of_their_spread():
    zoom = Zoom(arm_s=0.1)
    factors = zoom_through(zoom, [0.2] * 6 + [0.4] * 30)
    assert factors[-1] == pytest.approx(2.0, abs=ZOOM_STEP)
    assert factors == sorted(factors)
    assert zoom.factor == factors[-1]


def test_bringing_the_hands_together_zooms_back_out_to_exactly_one():
    zoom = Zoom(arm_s=0.1)
    zoom_through(zoom, [0.2] * 6 + [0.5] * 30)
    assert zoom_through(zoom, [0.5] * 6 + [0.21] * 30, t0=2.0)[-1] == 1.0


def test_the_zoom_stays_between_one_and_the_maximum():
    zoom = Zoom(arm_s=0.1, high=3.0)
    assert zoom_through(zoom, [0.1] * 6 + [0.9] * 30)[-1] == 3.0
    assert zoom_through(zoom, [0.9] * 6 + [0.05] * 30, t0=2.0)[-1] == 1.0


def test_nothing_zooms_before_the_pose_is_held_for_arm_s():
    zoom = Zoom(arm_s=0.2)
    assert zoom_through(zoom, [0.2, 0.25, 0.3, 0.35, 0.4]) == []
    assert not zoom.active


def test_a_new_pose_zooms_on_from_the_factor_it_left():
    zoom = Zoom(arm_s=0.1)
    zoom_through(zoom, [0.2] * 6 + [0.4] * 30)
    assert zoom_through(zoom, [None] * 15, t0=2.0) == []
    assert not zoom.active
    # Hands back close together: no jump; spreading them doubles the zoom again.
    assert zoom_through(zoom, [0.2] * 6, t0=3.0) == []
    assert zoom_through(zoom, [0.4] * 30, t0=3.2)[-1] == pytest.approx(4.0)


def test_a_dropped_frame_does_not_end_the_zoom():
    zoom = Zoom(arm_s=0.1, gap_s=0.3)
    zoom_through(zoom, [0.2] * 6 + [0.3] * 5 + [None] * 3 + [0.4] * 30)
    assert zoom.factor == pytest.approx(2.0, abs=ZOOM_STEP)


def test_one_hand_or_hands_out_of_the_pose_do_not_zoom():
    zoom = Zoom(arm_s=0.1)
    for i in range(30):
        assert zoom.update(i / 30, [zoom_hands(0.2 + i / 100)[0]]) is None
        assert zoom.update(1 + i / 30, [make_hand(center=(0.3, 0.5)), make_hand(center=(0.4 + i / 100, 0.5))]) is None
    assert zoom.factor == 1.0


def test_two_hands_hold_off_finger_commands_until_the_hands_are_gone():
    detector = FingerCommands(hold_s=0.5, gap_s=0.3)
    for i in range(30):
        detector.hold_off(i / 30)
    # The hand left in view after a zoom shows a count: it fires nothing.
    assert hold(detector, 2, 1.0, 1.0) == []
    assert detector.progress(2.0) == 0.0
    assert hold(detector, 0, 2.0, 1.0) == []
    assert not detector.carrying(3.0)
    assert hold(detector, None, 3.0, 0.5) == []
    assert hold(detector, 2, 3.6, 0.6) == [Command("switch", 2)]


def pinch_hand(at=(0.5, 0.5), gap=0.0):
    """A hand whose thumb tip is `gap` (in palms) from its index tip, that pinch point placed at `at`."""
    hand = make_hand((True, True, True, True, True))
    palm = math.dist(hand[0], hand[9])
    ix, iy = hand[8]
    hand[4] = (ix - gap * palm, iy)
    px, py = (hand[4][0] + ix) / 2, (hand[4][1] + iy) / 2
    return [(x + at[0] - px, y + at[1] - py) for x, y in hand]


def drag(swipes, points, gap=0.0):
    """Pinch and drag through `points` (None: no hand); the swipes it made."""
    out = []
    for point in points:
        direction = swipes.update(None if point is None else pinch_hand(point, gap))
        if direction:
            out.append(direction)
    return out


def line(start, end, steps=10):
    return [
        (start[0] + (end[0] - start[0]) * i / steps, start[1] + (end[1] - start[1]) * i / steps)
        for i in range(steps + 1)
    ]


def test_a_thumb_on_the_index_tip_is_a_pinch():
    assert pinched(pinch_hand(gap=0.0))
    assert pinched(pinch_hand(gap=0.2))
    assert not pinched(pinch_hand(gap=0.8))
    assert not pinched(make_hand())


@pytest.mark.parametrize(
    "end, direction",
    [((0.5, 0.35), "up"), ((0.5, 0.65), "down"), ((0.35, 0.5), "left"), ((0.65, 0.5), "right")],
)
def test_a_pinch_dragged_one_step_swipes_that_way(end, direction):
    assert drag(Swipes(distance=0.1), line((0.5, 0.5), end)) == [direction]


def test_a_long_vertical_drag_swipes_once_per_step():
    assert drag(Swipes(distance=0.1), line((0.5, 0.2), (0.5, 0.78), steps=30)) == ["down"] * 5


def test_a_sideways_drag_swipes_once_per_pinch():
    swipes = Swipes(distance=0.1)
    assert drag(swipes, line((0.2, 0.5), (0.8, 0.5), steps=30)) == ["right"]
    assert drag(swipes, [None] + line((0.2, 0.5), (0.4, 0.5))) == ["right"]


def test_a_diagonal_drag_does_not_swipe():
    assert drag(Swipes(distance=0.1), line((0.3, 0.3), (0.42, 0.42))) == []


def test_an_open_hand_moving_does_not_swipe():
    swipes = Swipes(distance=0.1)
    for x in range(30):
        assert swipes.update(make_hand(center=(0.2 + x / 50, 0.5))) is None
    assert not swipes.pinched


def test_a_loosening_pinch_holds_until_the_fingers_open():
    swipes = Swipes(distance=0.1)
    drag(swipes, [(0.5, 0.5)], gap=0.1)
    assert swipes.pinched
    # Looser than it takes to start a pinch, but not open yet: still dragging.
    assert drag(swipes, line((0.5, 0.5), (0.5, 0.62)), gap=0.4) == ["down"]
    drag(swipes, [(0.5, 0.62)], gap=0.8)
    assert not swipes.pinched


def test_a_pinch_pauses_finger_commands_without_holding_them_off():
    detector = FingerCommands(hold_s=0.5)
    for i in range(30):
        detector.pause(i / 30)
    assert detector.progress(1.0) == 0.0
    assert hold(detector, 3, 1.0, 0.6) == [Command("switch", 3)]


def test_a_pinch_swipes_only_the_way_it_started_so_the_way_back_does_nothing():
    swipes = Swipes(distance=0.1)
    # Scroll down, then bring the hand back up without letting go: no swipe up.
    assert drag(swipes, line((0.5, 0.2), (0.5, 0.45), steps=15) + line((0.5, 0.45), (0.5, 0.2), steps=15)) == [
        "down",
        "down",
    ]
    # Down again from the top keeps scrolling down, and a sideways move does nothing.
    assert drag(swipes, line((0.5, 0.2), (0.5, 0.35)) + line((0.5, 0.35), (0.8, 0.35))) == ["down"]
    # A new pinch can go the other way.
    assert drag(swipes, [None] + line((0.5, 0.5), (0.5, 0.35))) == ["up"]
