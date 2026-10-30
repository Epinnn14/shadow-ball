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


def test_restart_kick_only_counts_latches_ended_by_a_kick():
    from sb import features as F
    track = _BallTrack()                      # out, carried back, placed, kicked at frame 300
    latch = F.out_until_restart(track)
    kicks = F.restart_kicks(track, [latch])
    assert kicks.sum() == 1 and 295 <= np.argmax(kicks) <= 310
    capped = np.zeros(len(latch))
    capped[20:100] = 1                        # ends while the ball is slow: not a restart
    assert F.restart_kicks(track, [capped]).sum() == 0


def test_reappears_fast_marks_unseen_restart_only():
    from sb import features as F

    class T:
        pass
    t = T()
    n = 200
    x = np.full(n, np.nan)
    x[:20] = 30.0                                   # seen, still
    x[100:] = 30 + np.arange(n - 100) * 0.4         # back in view after 80 unseen frames, 10 m/s
    t.ball = np.stack([x, np.full(n, 20.0)], axis=1).astype(np.float32)
    flags = F.reappears_fast(t)
    assert flags.sum() == 1 and flags[100]
    x2 = x.copy()
    x2[100:] = 30 + np.arange(n - 100) * 0.04       # back in view but slow (1 m/s): not a restart
    t.ball = np.stack([x2, np.full(n, 20.0)], axis=1).astype(np.float32)
    assert F.reappears_fast(t).sum() == 0


def test_lines_and_names_for_a_4_2_3_1():
    from sb import roles
    # depth (m, relative to the team centroid) and width (m, 0 = team's left touchline)
    depth = np.array([-12, -12, -8, -6, -4, -1, 8, 9, 9, 15], dtype=float)
    width = np.array([29, 42, 54, 18, 39, 31, 44, 55, 21, 33], dtype=float)
    names, formation = roles.name_roles(np.stack([depth, width], axis=1), width)
    assert formation == "4-2-3-1"
    assert names[3] == "LB" and names[2] == "RB"
    assert {names[0], names[1]} == {"LCB", "RCB"}
    assert {names[4], names[5]} == {"LCDM", "RCDM"}
    assert names[9] == "ST" and names[8] == "LW" and names[7] == "RW" and names[6] == "CAM"


def test_lines_and_names_for_a_4_4_2():
    from sb import roles
    depth = np.array([-11, -11, -9, -8, -1, 1, 4, 6, 12, 13], dtype=float)
    width = np.array([25, 35, 16, 46, 35, 26, 46, 14, 38, 26], dtype=float)
    names, formation = roles.name_roles(np.stack([depth, width], axis=1), width)
    assert formation == "4-4-2"
    assert names[2] == "LB" and names[3] == "RB" and names[7] == "LM"
    assert {names[8], names[9]} == {"CF", "ST"}


def test_sprint_needs_one_second():
    from sb import movement
    s = np.zeros(200)
    s[10:30] = 8.0          # 0.8 s: not a sprint
    s[50:90] = 8.0          # 1.6 s: a sprint
    assert movement.sprint_count(s) == 1


def test_turnovers_only_direct_changes():
    from sb import tactics
    lab = np.full(paths.N_FRAMES, "X", dtype="<U1")
    a, _ = paths.HALVES[0]
    lab[a:a + 10] = "H"
    lab[a + 10:a + 15] = "X"          # abstention inside H: still H
    lab[a + 15:a + 30] = "A"          # direct H -> A: a turnover
    lab[a + 30:a + 40] = "D"
    lab[a + 40:a + 50] = "H"          # A -> D -> H: a set piece, not a turnover
    t = tactics.turnovers(tactics.filled_labels(lab))
    assert t.tolist() == [a + 15]


def test_team_shape_line_and_width():
    from sb import tactics
    x = np.array([10, 12, 14, 16, 40, 42, 44, 46, 70, 72], dtype=float)
    y = np.linspace(5, 50, 10)
    s = tactics.team_shape(np.stack([x, y], 1)[None].astype(np.float32))
    assert abs(s["line_height_m"][0] - 13.0) < 1e-4
    assert abs(s["width_m"][0] - 45.0) < 1e-4 and abs(s["depth_m"][0] - 62.0) < 1e-4


def test_ownership_nearest_player():
    from sb import tactics
    grid = np.array([[10.0, 10.0], [90.0, 10.0]])
    own, d_opp = tactics.ownership(np.array([[12.0, 10.0]]), np.array([[88.0, 10.0]]), grid)
    assert own.tolist() == [1, 0] and abs(d_opp[0] - 78.0) < 1e-6


def test_stamina_flags_a_role_that_stops_running():
    import pandas as pd
    from sb import tactics
    rows = []
    for m in range(0, 45, 5):
        late = m >= 30
        rows.append({"team": "H", "label": "CM", "half": 1, "minute_from": m, "coverage": 1.0,
                     "distance_m": 400 if late else 600, "hsr_m": 10 if late else 80,
                     "sprints": 0 if late else 3, "top_speed_kmh": 22.0 if late else 28.0})
    s = tactics.stamina(pd.DataFrame(rows))
    assert s[s.minute_from == 0].level.iloc[0] == "green"
    assert s[s.minute_from == 40].level.iloc[0] == "red"


def test_demo_block_end_and_running_totals():
    from sb import demo
    a2 = paths.HALVES[1][0]
    assert demo.block_end(2, 60) == a2 + 20 * 60 * paths.FPS          # 60'-65' known at 65'
    assert demo.block_end(1, 50) == paths.HALVES[0][1]               # stoppage block: end of half
    speed = np.zeros(100)
    speed[10:60] = 8.0                                                # one 2-s sprint at 8 m/s
    dist, hsr, sprints, top = demo.cumulative_role_stats(speed)
    assert abs(dist[-1] - 16.0) < 1e-6 and abs(hsr[-1] - 16.0) < 1e-6
    assert sprints[-1] == 1 and abs(top[-1] - 28.8) < 1e-3


def test_label_runs_and_tag_side():
    from sb import demo
    lab = np.full(paths.N_FRAMES, "D", dtype="<U1")
    a, b = paths.HALVES[0]
    lab[a:a + 100] = "H"
    lab[a + 100:a + 300] = "A"
    runs = demo.label_runs(lab, 1, b)
    assert runs[:3] == [[a, "H"], [a + 100, "A"], [a + 300, "D"]] and runs[-1] == [b + 1, "end"]
    lab[a + 300:a + 400] = "D"
    lab[a + 400:a + 600] = "A"
    # throw-in tagged as the ball goes out: the team that restarts after the dead ball
    assert demo.tag_side({"side": None, "start": a + 250}, lab) == "A"
    lab2 = np.full(paths.N_FRAMES, "H", dtype="<U1")
    assert demo.tag_side({"side": None, "start": a}, lab2) == "H"      # no dead ball: 2 s later
    assert demo.tag_side({"side": "A", "start": a}, lab) == "A"


def test_offball_control_and_candidates():
    from sb import offball
    cells = np.array([[10.0, 34.0], [95.0, 34.0]], dtype=np.float32)
    home = np.array([[12.0, 34.0]], dtype=np.float32)
    away = np.array([[93.0, 34.0]], dtype=np.float32)
    zero = np.zeros_like(home)
    s_h = offball.team_sum(offball.arrival(home, zero, cells))
    s_a = offball.team_sum(offball.arrival(away, zero, cells))
    ctrl = offball.control(s_h, s_a)
    assert ctrl[0] > 0.95 and ctrl[1] < 0.05                 # each team owns the space next to it
    assert abs(offball.control(s_h, s_h)[0] - 0.5) < 1e-6    # same arrival time: 50/50
    assert len(offball.candidates()) == 17                   # stay + two rings of 8


def test_threat_surface_prefers_the_goal_mouth():
    from sb import offball
    lab = np.full(paths.N_FRAMES, "D", dtype="<U1")
    ball = np.full((paths.N_FRAMES, 2), np.nan, dtype=np.float32)
    sides = {(t, h): True for t in (0, 1) for h in (1, 2)}
    surf, prior, info = offball.threat_surface(lab, ball, sides)
    assert info["samples"] == 0
    assert surf[-1, surf.shape[1] // 2] > surf[0, 0]         # no data: the prior, goal mouth highest


def test_shadow_block_moments_and_rows():
    """Shadow Replay keeps an entry only when the defending team's denial before it was among its lowest;
    rows below the gap threshold are dropped from the clip."""
    import pandas as pd
    from sb import demo
    frames = list(range(1000, 1000 + 40 * 25, 25))
    # H defends throughout (A has the ball); denial dips to 300 at frame 1500, otherwise 800
    teams = pd.DataFrame({"frame": frames, "half": 1, "possession": "A",
                          "J_H": [300.0 if f == 1500 else 800.0 for f in frames],
                          "J_A": 100.0, "gap_H": 20.0, "gap_A": 0.0})
    players = pd.DataFrame([
        {"frame": 1500, "half": 1, "slot": 3, "team": "H", "label": "RB", "phase": "without ball", "contribution": 1.0,
         "gain": 0.0, "best_gain": 40.0, "gap": 40.0, "shadow_score": 20.0, "shadow_x": 10.0, "shadow_y": 60.0, "x": 14.0, "y": 60.0},
        {"frame": 1500, "half": 1, "slot": 4, "team": "H", "label": "LB", "phase": "without ball", "contribution": 1.0,
         "gain": 0.0, "best_gain": 2.0, "gap": 2.0, "shadow_score": 60.0, "shadow_x": 10.0, "shadow_y": 8.0, "x": 10.0, "y": 9.0}])
    entries = [[1600, "A", 30.0],          # 4 s after the dip: a moment
               [1900, "A", 30.0]]          # denial normal in the 10 s before: not a moment
    out = demo.shadow_block(players, teams, entries, {"RB": 0, "LB": 1}, 1000, 2000, [[0.1]])
    assert len(out["moments"]) == 1
    entry, low, defender, denial, top, kind = out["moments"][0]
    assert (entry, low, defender, denial, kind) == (1600, 1500, "H", 300.0, "denial")
    assert top[0][:2] == [0, 40.0]
    i = out["teams"].index(next(r for r in out["teams"] if r[0] == 1500))
    assert [p[2] for p in out["players"][i]] == [0]          # LB's 2-per-mille gap is dropped
    assert out["usual"]["H"] == 800.0 and out["usual"]["A"] is None
    assert demo.shadow_block(None, None, entries, {}, 1000, 2000, None) is None


def test_shadow_block_rest_moment_replaces_denial():
    """A lost ball that ends in a final-third entry, with thin rest defence just before the loss,
    is a 'rest' moment: its movers are the cover positions of the team that lost the ball."""
    import pandas as pd
    from sb import demo
    frames = list(range(1000, 1000 + 40 * 25, 25))
    poss = ["H" if f < 1500 else "A" for f in frames]
    teams = pd.DataFrame({"frame": frames, "half": 1, "possession": poss,
                          "J_H": [800.0 if p == "H" else (300.0 if f == 1550 else 800.0) for f, p in zip(frames, poss)],
                          "J_A": 200.0, "gap_H": 0.0, "gap_A": 0.0,
                          "rest": [(500.0 if f == 1475 else 900.0) if p == "H" else np.nan for f, p in zip(frames, poss)],
                          "behind": 3})
    players = pd.DataFrame([
        {"frame": 1475, "half": 1, "slot": 3, "team": "H", "label": "RB", "phase": "with ball", "contribution": 1.0, "gain": 0.0,
         "best_gain": 1.0, "gap": 1.0, "shadow_score": 50.0, "shadow_x": 50.0, "shadow_y": 60.0, "x": 50.0, "y": 60.0,
         "rest_gap": 30.0, "cover_x": 45.0, "cover_y": 58.0}])
    transitions = pd.DataFrame({"frame": [1500], "won_by": ["A"]})
    out = demo.shadow_block(players, teams, [[1600, "A", 30.0]], {"RB": 0}, 1000, 2000, None, transitions)
    assert len(out["moments"]) == 1
    entry, low, team, value, top, kind = out["moments"][0]
    assert (entry, low, team, value, kind) == (1600, 1475, "H", 500.0, "rest")
    assert top == [[0, 30.0, 50.0, 60.0, 45.0, 58.0]]
    assert out["usual_rest"]["H"] == 900.0
    row = out["players"][[r[0] for r in out["teams"]].index(1475)][0]
    assert row[10:] == [30.0, 45.0, 58.0]                     # kept for its rest gap although gap < 5


def test_pressing_seconds_and_zones():
    """Two defenders near the ball = a press; regain and box outcomes look forward in time."""
    import pandas as pd
    from types import SimpleNamespace
    from sb import pressing
    a, b = paths.HALVES[0]
    n_frames, n_slots = b + 300, 20
    xy = np.full((n_frames, n_slots, 2), np.nan, dtype=np.float32)
    teams = np.array([0] * 10 + [1] * 10)
    for s in range(20):
        xy[:, s] = (5 + 4 * s, 5 if s < 10 else 60)     # everybody far from the ball...
    xy[:, 0], xy[:, 1] = (47, 34), (54, 34)             # ...except two H defenders within 8 m
    t = a + 25
    ball = np.full((n_frames, 2), np.nan, dtype=np.float32)
    ball[t] = (50, 34)
    lab = np.array(["D"] * n_frames, dtype="<U1")
    lab[t:t + 50] = "A"
    lab[t + 50:t + 100] = "H"                           # H wins it back after 2 s
    valid = np.zeros((n_frames, n_slots), dtype=bool)
    valid[:, :] = True
    gk = np.zeros_like(valid)
    sides = {(0, 1): True, (1, 1): False, (0, 2): True, (1, 2): False}
    track = SimpleNamespace(xy=xy, teams=teams)
    df = pressing.seconds(track, lab, ball, valid, gk, sides)
    assert len(df) == 1
    r = df.iloc[0]
    assert r.defending == "H" and r.press and r.regain and not r.box and r.pressers == 2
    z = pressing.zone_table(pd.concat([df, df.assign(press=False, regain=False)]))
    row = z.iloc[0]
    assert (row.n_press, row.n_hold, row.regain_press, row.regain_hold) == (1, 1, 1.0, 0.0)
    assert pressing.band_of(10) == 0 and pressing.band_of(100) == 3 and pressing.lane_of(60) == 2


def test_leak_blocks_against_first_15_minutes():
    import pandas as pd
    from sb import offball
    a = paths.HALVES[1][0]
    rows = []
    for minute, gap in ((0, 2.0), (5, 2.0), (10, 2.0), (30, 8.0)):
        for k in range(40):
            rows.append({"frame": a + (minute * 60 + k) * 25, "half": 2, "team": "H", "label": "RB", "phase": "without ball",
                         "contribution": 10.0 if minute < 30 else 5.0, "gap": gap})
    stamina = pd.DataFrame({"team": ["H"], "label": ["RB"], "half": [2], "minute_from": [75], "risk": [60.0], "level": ["red"]})
    b, rel = offball.leak_blocks(pd.DataFrame(rows), stamina)
    last = b[b.block == 75].iloc[0]
    assert (last.contribution, last.base_contribution, last.gap, last.base_gap, last.level) == (5.0, 10.0, 8.0, 2.0, "red")


def test_rating_rows_per_minute_and_family_reference():
    import pandas as pd
    from sb import demo
    a = paths.HALVES[0][0]
    rows = [{"frame": a + k * 25, "half": 1, "team": "H", "label": "LCB", "shadow_score": 60.0, "contribution": 10.0} for k in range(90)]
    rows += [{"frame": a + k * 25, "half": 1, "team": "A", "label": "RCB", "shadow_score": 40.0, "contribution": 20.0} for k in range(30)]
    rows += [{"frame": a, "half": 1, "team": "H", "label": "GK", "shadow_score": 50.0, "contribution": 99.0}]
    out, ref = demo.rating_rows(pd.DataFrame(rows), {"LCB": 0, "RCB": 1, "GK": 2}, a + 200 * 25)
    assert ["H", 0, 1, 0, 60, 3600, 600.0] in out and ["H", 0, 1, 1, 30, 1800, 300.0] in out
    assert not any(r[1] == 2 for r in out)                       # no rating for goalkeepers
    assert ref["LCB"] == ref["RCB"] == 12.5                       # one family: centre-backs of both teams


def test_kickoff_frame_after_standstill_in_own_halves():
    from types import SimpleNamespace
    from sb import features
    fps, n = paths.FPS, 40 * paths.FPS
    teams = np.array([0] * 10 + [1] * 10)
    xy = np.zeros((n, 20, 2), dtype=np.float32)
    xy[:, :10, 0], xy[:, 10:, 0], xy[:, :, 1] = 30.0, 75.0, 34.0      # home on the left, away on the right
    speed = np.full((n, 20), 2.0, dtype=np.float32)                   # warming up: moving
    speed[10 * fps:20 * fps] = 0.3                                    # lined up and still
    kick = 20 * fps
    speed[kick:] = 3.0                                                # kick-off: everybody goes
    track = SimpleNamespace(xy=xy, teams=teams, speed=speed)
    k = features.kickoff_frame(track, 0, {0: True, 1: False})
    assert abs(k - kick) <= fps // 2
    # wrong sides: nobody is in his own half, so no kick-off is found
    assert features.kickoff_frame(track, 0, {0: False, 1: True}) is None
