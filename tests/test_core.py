"""Fast tests that need no match data. Run: python -m pytest -q"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sb import atd, baseline, paths, submission  # noqa: E402


def _write_fake_atd(tmp_path, n_frames=5, n_slots=2):
    lines = []
    for f in range(1, n_frames + 1):
        players = ";".join("{:.3f},{:.3f},1.0".format(0.1 * s, 0.5) for s in range(n_slots))
        ball = "0.0,0.5,NaN" if f % 2 else "NaN,NaN,NaN"
        lines.append("{}:{}:{}".format(f, players, ball))
    path = tmp_path / "fake_atd.txt"
    path.write_text("\n".join(lines) + "\n")
    return str(path)


def test_parse_raw_shapes_and_nan(tmp_path):
    raw = _write_fake_atd(tmp_path)
    frame_id, players, ball = atd.parse_raw(raw, n_slots=2)
    assert frame_id.tolist() == [1, 2, 3, 4, 5]
    assert players.shape == (5, 2, 3)
    assert ball.shape == (5, 2)
    assert not np.isnan(ball[0, 0]) and np.isnan(ball[1, 0])


def test_alignment_rejects_gaps():
    try:
        atd.check_alignment(np.array([1, 2, 4]), source="broadcast")
    except ValueError:
        return
    raise AssertionError("a gap in frame ids must be rejected")


class _FakeTrack:
    def __init__(self):
        # 3 frames, 2 slots: slot 0 home at x=0, slot 1 away at x=10
        self.xy = np.array([[[0, 0], [10, 0]]] * 3, dtype=np.float32)
        self.ball = np.array([[1, 0], [9, 0], [np.nan, np.nan]], dtype=np.float32)
        self.teams = np.array([0, 1], dtype=np.int8)

    @property
    def ball_seen(self):
        return ~np.isnan(self.ball[:, 0])


def test_nearest_team():
    codes = baseline.nearest_team(_FakeTrack())
    assert codes.tolist() == [baseline.HOME, baseline.AWAY, baseline.NOBODY]


def test_majority_window_zero_maps_codes():
    labels = baseline.majority(np.array([0, 1, -1], dtype=np.int8), 0)
    assert labels.tolist() == ["H", "A", "D"]


def test_graded_mask_size():
    mask = paths.graded_mask()
    assert mask.sum() == 158857 and len(mask) == paths.N_FRAMES


def test_summary_counts_possessions():
    labels = np.full(paths.N_FRAMES, "D", dtype="<U1")
    a, _ = paths.HALVES[0]
    labels[a:a + 10] = "H"
    labels[a + 10:a + 20] = "X"      # forward-filled -> still H, not a new possession
    labels[a + 20:a + 30] = "A"
    assert submission.summary(labels)["possessions"] == 2


def test_viterbi_prefers_sticky_runs():
    from sb import hmm
    # evidence flickers H/A every frame; a sticky transition matrix must not flicker
    e = np.tile([[0.0, -0.2, -5.0], [-0.2, 0.0, -5.0]], (50, 1))
    path = hmm.viterbi(e, hmm.transition_matrix(0.001, 0.001, 0.01))
    assert len(set(path.tolist())) == 1


class _BallTrack:
    """Ball goes out, is carried back fast, placed, then kicked: dead until the kick."""
    def __init__(self):
        n = 400
        x = np.full(n, 50.0)
        x[0:20] = np.linspace(10, -2, 20)          # leaves over the goal line
        x[20:60] = -2.0                             # out
        x[60:100] = np.linspace(-2, 4, 40)          # carried back in, ~3.75 m/s
        x[100:300] = 4.0                            # placed
        x[300:] = 4.0 + np.arange(n - 300) * 0.4    # kicked, 10 m/s
        self.ball = np.stack([x, np.full(n, 30.0)], axis=1).astype(np.float32)
        self.speed = np.full((n, 2), 1.0, dtype=np.float32)


def test_out_until_restart_waits_for_placement_and_kick():
    from sb import features as F
    flag = F.out_until_restart(_BallTrack())
    assert flag[10] == 0           # still in play
    assert flag[30] == 1 and flag[80] == 1 and flag[250] == 1
    assert flag[320] == 0          # restart taken


def test_seen_neighbours():
    from sb import ballnet
    seen = np.array([True, False, False, True, False])
    last, nxt = ballnet.seen_neighbours(seen)
    assert last.tolist() == [-1, 0, 0, 0, 3]
    assert nxt.tolist() == [3, 3, 3, -1, -1]


def test_context_features_flags_far_context():
    from sb import ballnet
    ball = np.array([[10.0, 20.0], [np.nan, np.nan]] + [[50.0, 30.0]] * 1000, dtype=np.float32)
    ctx = ballnet.context_features(ball, np.array([1]), np.array([0]), np.array([1001]))
    assert ctx[0, 3] == 1.0            # last seen 1 frame ago: known
    assert ctx[0, 7] == 0.0            # next seen 40 s later: beyond MAX_CONTEXT_S -> unknown


class _WhistleTrack:
    """Players run at 3 m/s, a whistle at frame 300 slows everyone to 0.8 m/s for 20 s,
    the ball is placed then kicked at frame 700 and everyone speeds up again."""
    def __init__(self):
        n = 1200
        speed = np.full(n, 3.0)
        speed[300:700] = 0.8
        speed[300:350] = np.linspace(3.0, 0.8, 50)
        speed[700:760] = np.linspace(0.8, 3.0, 60)
        self.speed = np.repeat(speed[:, None], 4, axis=1).astype(np.float32)
        x = np.full(n, 40.0)
        x[:300] = 40 + np.arange(300) * 0.2          # ball moving with play
        x[300:700] = 100.0                             # placed (still) inside the pitch
        x[700:] = 100 - np.arange(n - 700) * 0.4       # kicked, 10 m/s
        self.ball = np.stack([x, np.full(n, 30.0)], axis=1).astype(np.float32)


def test_whistle_latch_covers_foul_until_restart():
    from sb import features as F
    flag = F.whistle_until_restart(_WhistleTrack())
    assert flag[100] == 0              # live play before the whistle
    assert flag[500] == 1              # stoppage
    assert flag[800] == 0              # restart taken
