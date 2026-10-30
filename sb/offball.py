"""Shadow Ball's core: movement WITHOUT the ball.

For every player who is not on the ball, once per second of play, we ask what his last second of
movement was worth to his team, and where he could have gone instead: his "shadow". The gap between
the two is the off-ball work the team left on the table.

    python run.py offball        # needs v4 + roles   -> exports/offball*.parquet, offball_summary.json

The model (all in metres and seconds, one frame at a time):

  Pitch control  Each player reaches a point after a reaction time plus the distance at top speed,
                 starting from where his current velocity takes him (Spearman 2018, simplified).
                 Per team, a soft minimum of those arrival times; control of a point = logistic of
                 the difference between the two teams' times.
  Value          Where control matters: a threat surface LEARNED FROM THIS MATCH (how often the ball
                 reaches the box within 10 s when a team has it at that spot, smoothed, with a
                 distance-to-goal prior), seen from the team that has the ball, weighted towards the
                 ball. The team with the ball wants to control valuable space; the team without it
                 wants to take that same space away. One objective for both: J_team = sum(value x
                 control_team), the share of the dangerous space the team owns.
  Shadow         For an off-ball player, positions reachable from where he was one second earlier
                 (stay, rings of 2.5 m and 5 m), with the others where they really are. His movement
                 gain = J(actual) - J(stay); best gain = J(best) - J(stay); shadow gap = J(best) -
                 J(actual); Shadow score = the share of those reachable positions his real move beat
                 (0-100; moving at random scores 50).

  Rest defence   For the team WITH the ball: the same J, but valued from the opponent's side, as if the
                 ball were lost right now where it is: the share of OUR dangerous space we would still
                 own at the turnover. Each off-ball player of that team also gets a cover shadow: the
                 reachable position that would raise it most (rest_gap, cover_x/y).

A ROLE (LCB, CAM...) is a tactical position, not a person: substitutions are not visible.
"""

import json
import os

import numpy as np
import pandas as pd

from . import paths, roles as roles_mod
from .tactics import assigned_slots, filled_labels

L, W = paths.PITCH
FPS = paths.FPS
REACTION = 0.7          # s
VMAX = 5.0              # m/s
SOFTMIN = 0.3           # s: how much several players near a point add up
TEMP = 0.45             # s: control is 50/50 when both teams arrive at the same time
CELL = 3.0
STEP = FPS              # one sample per second
LOOKBACK = FPS          # the alternative positions are reachable from 1 s earlier
RINGS = (2.5, 5.0)
FINAL_THIRD = L * 2 / 3


def grid(cell=CELL):
    xs = np.arange(cell / 2, L, cell)
    ys = np.arange(cell / 2, W, cell)
    gx, gy = np.meshgrid(xs, ys, indexing="ij")
    return np.stack([gx.ravel(), gy.ravel()], 1).astype(np.float32), (len(xs), len(ys))


def candidates():
    offs = [(0.0, 0.0)]
    for r in RINGS:
        for a in np.arange(8) * np.pi / 4:
            offs.append((r * np.cos(a), r * np.sin(a)))
    return np.array(offs, dtype=np.float32)


def to_frame(xy, right):
    """Positions into the attacking frame of a team that attacks right (+x) or not."""
    if right:
        return xy
    out = np.array(xy, dtype=np.float32, copy=True)
    out[..., 0] = L - out[..., 0]
    out[..., 1] = W - out[..., 1]
    return out


# ---------------------------------------------------------------- threat surface (learned)

def threat_surface(lab, ball, sides, cell=5.0, horizon=10 * FPS, prior_weight=20.0):
    """P(ball in the opponent box within `horizon`, same possession) by ball location, in the
    attacking frame. Both teams, both halves, every 5th frame of play. Returns (grid values
    (nx, ny), prior)."""
    nx, ny = int(np.ceil(L / cell)), int(np.ceil(W / cell))
    hits, n = np.zeros((nx, ny)), np.zeros((nx, ny))
    for h, (a, b) in enumerate(paths.HALVES, 1):
        for team, t in (("H", 0), ("A", 1)):
            right = sides[(t, h)]
            bx = ball[a:b + 1, 0] if right else L - ball[a:b + 1, 0]
            by = ball[a:b + 1, 1] if right else W - ball[a:b + 1, 1]
            has = lab[a:b + 1] == team
            in_box = (bx > L - 16.5) & (np.abs(by - W / 2) < 20.16) & has
            # first frame of each future box entry, as a running "next box frame"
            idx = np.where(in_box, np.arange(len(bx)), len(bx) + horizon * 2)
            nxt = np.minimum.accumulate(idx[::-1])[::-1]
            # possession must not change before reaching the box
            change = np.where(lab[a:b + 1] != team, np.arange(len(bx)), len(bx) + horizon * 2)
            nchange = np.minimum.accumulate(change[::-1])[::-1]
            for i in range(0, len(bx), 5):
                if not has[i] or np.isnan(bx[i]):
                    continue
                cx = min(nx - 1, max(0, int(bx[i] // cell)))
                cy = min(ny - 1, max(0, int(by[i] // cell)))
                n[cx, cy] += 1
                if nxt[i] - i <= horizon and nxt[i] <= nchange[i]:
                    hits[cx, cy] += 1
    xs = (np.arange(nx) + 0.5) * cell
    ys = (np.arange(ny) + 0.5) * cell
    gx, gy = np.meshgrid(xs, ys, indexing="ij")
    dist = np.hypot(L - gx, W / 2 - gy)
    prior = 0.6 * np.exp(-dist / 14.0)                      # near the goal mouth: most threatening
    # light smoothing of the counts (3x3) before blending with the prior
    def smooth(m):
        p = np.pad(m, 1, mode="edge")
        return sum(p[1 + i:1 + i + nx, 1 + j:1 + j + ny] for i in (-1, 0, 1) for j in (-1, 0, 1)) / 9
    surf = (smooth(hits) * 9 + prior_weight * prior) / (smooth(n) * 9 + prior_weight)
    return surf.astype(np.float32), prior.astype(np.float32), {"samples": int(n.sum()), "hits": int(hits.sum())}


def surface_at(surf, pts, cell=5.0):
    nx, ny = surf.shape
    cx = np.clip((pts[:, 0] // cell).astype(int), 0, nx - 1)
    cy = np.clip((pts[:, 1] // cell).astype(int), 0, ny - 1)
    return surf[cx, cy]


# ---------------------------------------------------------------- pitch control

def arrival(pos, vel, cells):
    """(players, cells) arrival times: reaction, then straight at top speed."""
    start = pos + vel * REACTION
    d = np.sqrt(((start[:, None, :] - cells[None, :, :]) ** 2).sum(-1))
    return REACTION + d / VMAX


def team_sum(tau):
    return np.exp(-tau / SOFTMIN).sum(0)


def control(s_own, s_opp):
    t_own = -SOFTMIN * np.log(np.maximum(s_own, 1e-30))
    t_opp = -SOFTMIN * np.log(np.maximum(s_opp, 1e-30))
    return 1.0 / (1.0 + np.exp(-(t_opp - t_own) / TEMP))


# ---------------------------------------------------------------- the shadow of every off-ball player

def run(track, labels, ball, role_df, every=STEP):
    lab = filled_labels(labels)
    sides = {(t, h): roles_mod.attacks_right(track, t, h) for t in (0, 1) for h in (1, 2)}
    surf, prior, threat_info = threat_surface(lab, ball, sides)
    cells, _ = grid()
    offs = candidates()
    valid = assigned_slots(role_df, *track.xy.shape[:2])
    role_lookup = role_df.set_index(["frame", "slot"])["label"]
    half_of = paths.half_of_frames()
    rows, team_rows = [], []
    for h, (a, b) in enumerate(paths.HALVES, 1):
        for t in range(a + LOOKBACK, b + 1, every):
            team = lab[t]
            if team not in ("H", "A") or np.isnan(ball[t, 0]):
                continue
            slots = np.where(valid[t] & valid[t - LOOKBACK])[0]
            if len(slots) < 16:
                continue
            pos = track.xy[t, slots]
            prev = track.xy[t - LOOKBACK, slots]
            vel = (track.xy[t, slots] - track.xy[t - 5, slots]) / (5 / FPS)
            vel = np.nan_to_num(vel)
            sp = np.hypot(vel[:, 0], vel[:, 1])
            vel[sp > 10] = 0
            if np.isnan(pos).any() or np.isnan(prev).any():
                keep = ~np.isnan(pos[:, 0]) & ~np.isnan(prev[:, 0])
                slots, pos, prev, vel = slots[keep], pos[keep], prev[keep], vel[keep]
            tm = track.teams[slots]
            att = 0 if team == "H" else 1
            # value: threat seen from the team with the ball, weighted towards the ball
            right = sides[(att, h)]
            near = 0.5 + 0.5 * np.exp(-np.hypot(*(cells - ball[t]).T) / 25.0)
            v = surface_at(surf, to_frame(cells, right)) * near
            v = v / v.sum()
            # rest defence: the same space valued by the OPPONENT, as if the ball were lost here now
            vr = surface_at(surf, to_frame(cells, sides[(1 - att, h)])) * near
            vr = vr / vr.sum()
            tau = arrival(pos, np.zeros_like(vel), cells)
            e = np.exp(-tau / SOFTMIN)
            s = {0: e[tm == 0].sum(0), 1: e[tm == 1].sum(0)}
            j = {k: float((v * control(s[k], s[1 - k])).sum()) for k in (0, 1)}
            rest = float((vr * control(s[att], s[1 - att])).sum())
            # the ball carrier: the attacker nearest the ball (within 3 m) is ON the ball
            d_ball = np.hypot(*(pos - ball[t]).T)
            carrier = -1
            atk = np.where(tm == att)[0]
            if len(atk) and d_ball[atk].min() < 3.0:
                carrier = atk[np.argmin(d_ball[atk])]
            gaps = {0: 0.0, 1: 0.0}
            for i in range(len(slots)):
                label = role_lookup.get((t, int(slots[i])), None)
                if i == carrier or label == "GK" or label is None:
                    continue
                k = int(tm[i])
                others = s[k] - e[i]
                # his share: how much dangerous space the team would lose if he were not there
                contrib = j[k] - float((v * control(others, s[1 - k])).sum())
                # stay where he was 1 s ago, his candidates around that point, and what he did
                cand = np.concatenate([prev[i] + offs, pos[i][None]])
                cand[:, 0] = np.clip(cand[:, 0], 0, L)
                cand[:, 1] = np.clip(cand[:, 1], 0, W)
                tc = arrival(cand, np.zeros_like(cand), cells)      # all compared standing still: like for like
                ctl_c = control(others[None] + np.exp(-tc / SOFTMIN), s[1 - k][None])
                jc = (v[None] * ctl_c).sum(1)
                rest_gap, cover = np.nan, (np.nan, np.nan)
                if k == att:                        # his cover shadow: best for the rest defence
                    jr = (vr[None] * ctl_c).sum(1)
                    ci = int(np.argmax(jr[:-1]))
                    rest_gap = (max(jr[ci], jr[-1]) - jr[-1]) * 1000
                    cover = (float(cand[ci, 0]), float(cand[ci, 1]))
                stay, actual = jc[0], jc[-1]
                best_i = int(np.argmax(jc[:-1]))
                best = max(jc[best_i], actual)
                gain, gain_best = actual - stay, best - stay
                gaps[k] += best - actual
                # Shadow score: his move beat this share of the moves he could have made (random = 50)
                score = 100 * (np.mean(jc[:-1] < actual) + 0.5 * np.mean(jc[:-1] == actual))
                rows.append((t, h, int(slots[i]), "H" if k == 0 else "A", label,
                             "with ball" if k == att else "without ball", contrib * 1000,
                             gain * 1000, gain_best * 1000, (best - actual) * 1000, score,
                             float(cand[best_i, 0]), float(cand[best_i, 1]), float(pos[i, 0]), float(pos[i, 1]),
                             rest_gap, cover[0], cover[1]))
            # players of the team with the ball goal-side of it (outfield)
            own_x = to_frame(pos[tm == att], sides[(att, h)])[:, 0]
            ball_x = to_frame(ball[t][None], sides[(att, h)])[0, 0]
            behind = int((own_x < ball_x - 2).sum()) - 1
            team_rows.append((t, h, team, j[0] * 1000, j[1] * 1000, gaps[0] * 1000, gaps[1] * 1000, rest * 1000, behind))
    players = pd.DataFrame(rows, columns=["frame", "half", "slot", "team", "label", "phase", "contribution", "gain", "best_gain",
                                          "gap", "shadow_score", "shadow_x", "shadow_y", "x", "y", "rest_gap", "cover_x", "cover_y"])
    teams = pd.DataFrame(team_rows, columns=["frame", "half", "possession", "J_H", "J_A", "gap_H", "gap_A", "rest", "behind"])
    return players, teams, {"threat": threat_info, "surface": surf.tolist()}


# ---------------------------------------------------------------- what it tells the coach

def entries_within(lab, ball, sides, frames, team_of, horizon=10 * FPS):
    """For each frame: does `team_of[i]` carry the ball into its final third within `horizon`?"""
    out = np.zeros(len(frames), dtype=bool)
    half_of = paths.half_of_frames()
    for i, (f, team) in enumerate(zip(frames, team_of)):
        h = int(half_of[f])
        if h == 0:
            continue
        end = min(paths.HALVES[h - 1][1], f + horizon)
        right = sides[(0 if team == "H" else 1, h)]
        bx = ball[f:end + 1, 0] if right else L - ball[f:end + 1, 0]
        out[i] = bool(np.any((bx >= FINAL_THIRD) & (lab[f:end + 1] == team)))
    return out


def summarize(players, teams, lab, ball, sides, transitions=None):
    """Per team and role, per phase; the team's space denial over the match; how fast it comes back
    after losing the ball; and the check that it means something.

    Validity: among moments with the ball OUTSIDE the attackers' final third, split by ball zone and by
    team, does the defending team's space denial (J of the team without the ball) predict whether the
    attackers reach the final third in the next 10 s? Top vs bottom quartile, within each stratum."""
    g = players.groupby(["team", "label", "phase"])
    by_role = g.agg(samples=("gain", "size"), contribution=("contribution", "mean"), gain=("gain", "mean"),
                    gap=("gap", "mean"), shadow_score=("shadow_score", "mean")).reset_index()
    by_team = players.groupby(["team", "phase"]).agg(contribution=("contribution", "mean"), gain=("gain", "mean"),
                                                     gap=("gap", "mean"), shadow_score=("shadow_score", "mean")).reset_index()
    t = teams.copy()
    t["defending"] = np.where(t.possession == "H", "A", "H")
    t["denied"] = np.where(t.possession == "H", t.J_A, t.J_H)            # share of THEIR danger we own
    half_of = paths.half_of_frames()
    t["minute"] = [(f - paths.HALVES[h - 1][0]) / FPS / 60 + (0 if h == 1 else 45) for f, h in zip(t.frame, t.half)]
    bx = []
    for f, team in zip(t.frame, t.possession):
        right = sides[(0 if team == "H" else 1, int(half_of[f]))]
        bx.append(ball[f, 0] if right else L - ball[f, 0])
    t["ball_x_att"] = bx
    v = t[t.ball_x_att < FINAL_THIRD].copy()
    v["entry10"] = entries_within(lab, ball, sides, v.frame.to_numpy(), v.possession.to_numpy())
    v["zone"] = pd.cut(v.ball_x_att, [0, L / 3, L / 2, FINAL_THIRD], labels=["attackers' own third", "attackers' half", "defenders' half"])
    strata = []
    for (zone, team), grp in v.groupby(["zone", "defending"], observed=True):
        if len(grp) < 60:
            continue
        hi, lo = grp.denied.quantile(0.75), grp.denied.quantile(0.25)
        strata.append({"ball": str(zone), "defending": team, "moments": int(len(grp)),
                       "entry_rate_high_denial": round(float(grp[grp.denied >= hi].entry10.mean()), 3),
                       "entry_rate_low_denial": round(float(grp[grp.denied <= lo].entry10.mean()), 3)})
    w = sum(s_["moments"] for s_ in strata)
    validity = {"test": "attackers reach the final third within 10 s; defending team's space denial, top vs bottom quartile within ball zone x team",
                "strata": strata,
                "weighted_entry_rate_high_denial": round(sum(s_["entry_rate_high_denial"] * s_["moments"] for s_ in strata) / w, 3),
                "weighted_entry_rate_low_denial": round(sum(s_["entry_rate_low_denial"] * s_["moments"] for s_ in strata) / w, 3)}
    # space denial per team per 5 minutes, while defending
    t["block"] = (t.minute // 5 * 5).astype(int)
    trend = (t.groupby(["defending", "half", "block"]).denied.mean() * 1).round(1).reset_index()
    # recovery: the team that just LOST the ball, seconds 0..10 after the turnover
    recovery = {}
    if transitions is not None and len(transitions):
        idx = t.set_index("frame")
        frames = idx.index.to_numpy()
        for team in ("H", "A"):
            curves = []
            for f in transitions[transitions.won_by != team].frame:
                row = []
                for sec in range(0, 11):
                    j = np.searchsorted(frames, f + sec * FPS)
                    if j < len(frames) and abs(frames[j] - (f + sec * FPS)) <= FPS // 2 and idx.iloc[j].defending == team:
                        row.append(idx.iloc[j].denied)
                    else:
                        row.append(np.nan)
                curves.append(row)
            c = np.array(curves, dtype=float)
            base = t[t.defending == team].denied.mean()
            recovery[team] = {"turnovers": int(len(c)), "settled_denial": round(float(base), 1),
                              "denial_by_second": [None if np.isnan(x) else round(float(x), 1) for x in np.nanmean(c, 0)]}
    return by_role, by_team, validity, trend, recovery


def rest_validity(teams, lab, ball, sides, transitions=None, horizon=15 * FPS):
    """Does rest defence mean something? Two checks, both for the team WITH the ball.

    1. Every second in possession, split by where the ball is (thirds of the pitch, in that team's
       attacking frame) and by team: does the opponent carry the ball into OUR final third within 15 s?
       Top vs bottom quartile of rest defence. Compared with the naive count of players behind the ball.
    2. At the real turnovers: rest defence in the last second before the loss vs whether the winner
       reached the final third (transitions.parquet)."""
    t = teams.dropna(subset=["rest"]).copy()
    half_of = paths.half_of_frames()
    t["ball_x_own"] = [ball[f, 0] if sides[(0 if team == "H" else 1, int(half_of[f]))] else L - ball[f, 0]
                       for f, team in zip(t.frame, t.possession)]
    opp = np.where(t.possession == "H", "A", "H")
    t["against"] = entries_within(lab, ball, sides, t.frame.to_numpy(), opp, horizon=horizon)
    t["zone"] = pd.cut(t.ball_x_own, [-1, L / 3, 2 * L / 3, L + 5], labels=["own third", "middle third", "final third"])
    strata, naive = [], []
    for (zone, team), g in t.groupby(["zone", "possession"], observed=True):
        if len(g) < 60:
            continue
        hi, lo = g.rest.quantile(0.75), g.rest.quantile(0.25)
        strata.append({"ball": str(zone), "in_possession": team, "moments": int(len(g)),
                       "entry_against_high_rest": round(float(g[g.rest >= hi].against.mean()), 3),
                       "entry_against_low_rest": round(float(g[g.rest <= lo].against.mean()), 3)})
        bh, bl = g.behind.quantile(0.75), g.behind.quantile(0.25)
        naive.append((len(g), float(g[g.behind >= bh].against.mean()), float(g[g.behind <= bl].against.mean())))
    w = sum(s_["moments"] for s_ in strata)
    out = {"test": "opponent reaches our final third within 15 s; rest defence top vs bottom quartile within ball zone x team",
           "strata": strata,
           "weighted_entry_against_high_rest": round(sum(s_["entry_against_high_rest"] * s_["moments"] for s_ in strata) / w, 3),
           "weighted_entry_against_low_rest": round(sum(s_["entry_against_low_rest"] * s_["moments"] for s_ in strata) / w, 3),
           "naive_players_behind_ball_high": round(sum(n * a for n, a, _ in naive) / w, 3),
           "naive_players_behind_ball_low": round(sum(n * b for n, _, b in naive) / w, 3)}
    if transitions is not None and len(transitions):
        rows = []
        for r in transitions.itertuples():
            loser = "A" if r.won_by == "H" else "H"
            c = t[(t.possession == loser) & (t.frame <= r.frame - FPS // 2) & (t.frame >= r.frame - 4 * FPS)]
            if len(c):
                rows.append((float(c.rest.iloc[-1]), bool(r.reached_final_third), str(r.zone)))
        if rows:
            d = pd.DataFrame(rows, columns=["rest", "final_third", "zone"])
            low = d.rest <= d.groupby("zone").rest.transform("median")
            out["turnovers"] = {"n": int(len(d)), "reached_final_third_low_rest": round(float(d[low].final_third.mean()), 3),
                                "reached_final_third_high_rest": round(float(d[~low].final_third.mean()), 3),
                                "correlation": round(float(np.corrcoef(d.rest, d.final_third)[0, 1]), 3)}
    return out


def save(players, teams, by_role, by_team, info, validity, trend=None, recovery=None, rest=None):
    out = os.path.join(paths.REPO, "exports")
    os.makedirs(out, exist_ok=True)
    players.to_parquet(os.path.join(out, "offball.parquet"), index=False)
    teams.to_parquet(os.path.join(out, "offball_team.parquet"), index=False)
    by_role.to_parquet(os.path.join(out, "offball_roles.parquet"), index=False)
    summary = {"by_team": by_team.round(4).to_dict("records"), "validity": validity, "threat": info["threat"],
               "recovery_after_losing_the_ball": recovery or {},
               "denial_by_5min": [] if trend is None else trend.to_dict("records"),
               "rest_defence": rest or {},
               "threat_surface": info["surface"]}
    with open(os.path.join(out, "offball_summary.json"), "w") as handle:
        json.dump(summary, handle, indent=1)
    return out
