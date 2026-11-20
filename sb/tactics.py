"""Fase B, part 2: what the bench needs to SEE live -- transitions, shape, stamina, space.

    python run.py tactics     # needs v4 + roles first
        -> exports/transitions.parquet, exports/space_maps.npz   (Transition Radar + Space Map)
        -> exports/shape.parquet, exports/shape_alerts.json      (Shape Monitor)
        -> exports/stamina.parquet                               (Stamina Monitor)

All positions are in the acting team's ATTACKING frame: x = 0 its own goal line, x = 105.3 the
opponent's, y = 0 its left touchline (same convention as roles.py).

Transition Radar
  A turnover is a direct H <-> A change of our possession labels (a change through D is a set
  piece, not a transition). For each one: where the ball was won, how many players of the team
  that LOST it pressed within 10 m in the next 5 s (counter-press), whether they won it back
  within 5 s, how far the winners progressed in 10 s, and how many losers were goal-side of the
  ball at the moment of the turnover (few = an open counter-attack).

Space Map
  At each turnover: who owns each 5 x 5 m cell (nearest player, a Voronoi pitch-control proxy),
  the winners' share of the opponent half, and the best free zone ahead of the ball (the cell the
  winners own that is furthest from any loser).

Shape Monitor
  Once per second per team: width, depth, defensive-line height (mean x of the 4 deepest outfield
  players), compactness (mean distance to the centroid), by phase (with / without the ball /
  dead). Alerts compare every 5 min out of possession with the first 15 min of that half.

Stamina Monitor
  From movement.parquet (per role, per 5 min): distance and high-speed running per minute of
  coverage, compared with the role's own first 15 minutes, gives a Fatigue Risk Score 0-100.
  A ROLE is not a person: substitutions and position swaps are not visible in tracking data.
"""

import json
import os
import warnings

import numpy as np
import pandas as pd

from . import paths, roles

FPS = paths.FPS
PRESS_RADIUS = 10.0          # m: a player this close to the ball is pressing it
PRESS_WINDOW = 5 * FPS       # counter-press = the first 5 s after losing the ball
PROGRESS_WINDOW = 10 * FPS
CELL = 5.0                   # m, Space Map grid
FINAL_THIRD = paths.PITCH[0] * 2 / 3


# ---------------------------------------------------------------- helpers

def filled_labels(labels):
    """Possession labels with X forward-filled inside each half (what the scorer does)."""
    lab = np.asarray(labels).astype("<U1").copy()
    for first, last in paths.HALVES:
        seg = lab[first:last + 1]
        idx = np.where(seg != "X", np.arange(len(seg)), 0)
        np.maximum.accumulate(idx, out=idx)
        lab[first:last + 1] = seg[idx]
    return lab


def turnovers(lab):
    """Frames t where the label changes directly H -> A or A -> H (inside a half)."""
    out = []
    for first, last in paths.HALVES:
        seg = lab[first:last + 1]
        prev, cur = seg[:-1], seg[1:]
        hit = np.where((prev != cur) & np.isin(prev, ["H", "A"]) & np.isin(cur, ["H", "A"]))[0]
        out.extend((first + hit + 1).tolist())
    return np.array(out, dtype=np.int64)


def assigned_slots(role_df, n_frames, n_slots):
    """(frames, slots) bool: the slot holds a role (<= 11 per team). Duplicate or ghost tracklets
    (a team can show 12-13 tracks at once) get no role in roles.py and are left out here."""
    mask = np.zeros((n_frames, n_slots), dtype=bool)
    mask[role_df.frame.to_numpy(), role_df.slot.to_numpy()] = True
    return mask


def to_attacking(xy, right):
    """Positions (..., 2) into the attacking frame of a team that attacks right (+x) or not."""
    if right:
        return xy
    length, width = paths.PITCH
    out = xy.copy()
    out[..., 0] = length - out[..., 0]
    out[..., 1] = width - out[..., 1]
    return out


def zone(x):
    return "defensive third" if x < paths.PITCH[0] / 3 else (
        "middle third" if x < FINAL_THIRD else "final third")


def ownership(own, opp, grid):
    """Nearest-player ownership of grid cells: 1 = `own` team, 0 = `opp`. Also the distance
    from each cell to the nearest `opp` player."""
    own = own[~np.isnan(own[:, 0])]
    opp = opp[~np.isnan(opp[:, 0])]
    if len(own) == 0 or len(opp) == 0:
        return None, None
    d_own = np.sqrt(((grid[:, None] - own[None]) ** 2).sum(-1)).min(1)
    d_opp = np.sqrt(((grid[:, None] - opp[None]) ** 2).sum(-1)).min(1)
    return (d_own < d_opp).astype(np.int8), d_opp


def pitch_grid():
    length, width = paths.PITCH
    nx, ny = int(round(length / CELL)), int(round(width / CELL))
    xs = (np.arange(nx) + 0.5) * length / nx
    ys = (np.arange(ny) + 0.5) * width / ny
    gx, gy = np.meshgrid(xs, ys, indexing="ij")
    return np.stack([gx.ravel(), gy.ravel()], 1), (nx, ny)


# ---------------------------------------------------------------- Transition Radar + Space Map

def transitions(track, labels, ball, valid):
    lab = filled_labels(labels)
    grid, shape = pitch_grid()
    sides = {(t, h): roles.attacks_right(track, t, h) for t in (0, 1) for h in (1, 2)}
    rows, maps = [], []
    half_of = paths.half_of_frames()
    for t in turnovers(lab):
        half = int(half_of[t])
        last = paths.HALVES[half - 1][1]
        winner = 0 if lab[t] == "H" else 1
        loser = 1 - winner
        right = sides[(winner, half)]
        w_slots = np.where(track.teams == winner)[0]
        l_slots = np.where(track.teams == loser)[0]
        b0 = to_attacking(ball[t], right)
        if np.isnan(b0[0]):
            continue
        # how long the winners keep it, and what comes next
        rest = lab[t:last + 1]
        change = np.where(rest != lab[t])[0]
        keep = int(change[0]) if len(change) else len(rest)
        nxt = rest[keep] if len(change) else "end"
        # counter-press by the losers
        end = min(t + PRESS_WINDOW, last + 1)
        xy_v = np.where(valid[t:end, :, None], track.xy[t:end], np.nan)
        lxy = xy_v[:, l_slots]
        dist = np.sqrt(((lxy - ball[t:end, None]) ** 2).sum(-1))
        with np.errstate(invalid="ignore"):
            pressers = (dist < PRESS_RADIUS).sum(1)
        nearest = np.nanmin(np.where(np.isnan(dist), np.inf, dist), axis=1)
        # progression by the winners while they keep it (up to 10 s)
        k = min(keep, PROGRESS_WINDOW, last - t) - 1
        b1 = to_attacking(ball[t + max(k, 0)], right)
        # who is where at the moment of the turnover
        w_now = to_attacking(xy_v[0, w_slots], right)
        l_now = to_attacking(xy_v[0, l_slots], right)
        goal_side = int(np.nansum(l_now[:, 0] > b0[0]))
        own, d_opp = ownership(w_now, l_now, grid)
        row = {
            "frame": int(t), "half": half,
            "minute": round(float((t - paths.HALVES[half - 1][0]) / FPS / 60 + (0 if half == 1 else paths.H2)), 2),
            "won_by": "H" if winner == 0 else "A",
            "ball_x": round(float(b0[0]), 1), "ball_y": round(float(b0[1]), 1),
            "zone": zone(b0[0]),
            "losers_goal_side": goal_side,
            "pressers_mean_5s": round(float(pressers.mean()), 2),
            "pressers_max_5s": int(pressers.max()),
            "nearest_presser_1s_m": round(float(nearest[min(FPS, len(nearest) - 1)]), 1),
            "kept_s": round(keep / FPS, 1),
            "next": nxt,
            "regained_5s": bool(nxt == lab[t - 1] and keep <= PRESS_WINDOW),
            "progress_10s_m": round(float(b1[0] - b0[0]), 1) if not np.isnan(b1[0]) else None,
            "reached_final_third": bool(np.nanmax(to_attacking(
                ball[t:t + max(k, 1)], right)[:, 0]) >= FINAL_THIRD) if k > 0 else False,
        }
        if own is not None:
            g = grid[:, 0]
            opp_half = g > paths.PITCH[0] / 2
            ahead = (g > b0[0] + CELL) & (own == 1)
            row["control_opp_half"] = round(float(own[opp_half].mean()), 3)
            if ahead.any():
                best = np.argmax(np.where(ahead, d_opp, -1))
                row.update({"free_x": float(grid[best, 0]), "free_y": float(grid[best, 1]),
                            "free_space_m": round(float(d_opp[best]), 1)})
            maps.append(own.reshape(shape))
            row["map_index"] = len(maps) - 1
        # an open transition: won outside the own third, few losers behind the ball (goalkeeper included)
        row["dangerous"] = bool(row["zone"] != "defensive third" and goal_side <= 4
                                and not row["regained_5s"])
        rows.append(row)
    df = pd.DataFrame(rows)
    return df, (np.stack(maps) if maps else np.zeros((0,) + shape, np.int8))


def transition_summary(df):
    out = {}
    for team, g in df.groupby("won_by"):
        lost = df[df.won_by != team]        # turnovers this team suffered = its counter-press tests
        out[team] = {
            "ball_wins": int(len(g)),
            "won_in": g.zone.value_counts().to_dict(),
            "dangerous_transitions": int(g.dangerous.sum()),
            "reached_final_third_share": round(float(g.reached_final_third.mean()), 3),
            "counter_press_success_5s": round(float(lost.regained_5s.mean()), 3),
            "pressers_mean_5s": round(float(lost.pressers_mean_5s.mean()), 2),
        }
    return out


# ---------------------------------------------------------------- Shape Monitor

def team_shape(xy):
    """xy (T, S, 2) in the attacking frame, goalkeeper already removed (NaN).
    Returns dict of (T,) arrays; NaN where fewer than 8 outfield players are seen."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        n = (~np.isnan(xy[..., 0])).sum(1)
        x, y = xy[..., 0], xy[..., 1]
        cx, cy = np.nanmean(x, 1), np.nanmean(y, 1)
        width = np.nanmax(y, 1) - np.nanmin(y, 1)
        depth = np.nanmax(x, 1) - np.nanmin(x, 1)
        xs = np.sort(np.where(np.isnan(x), np.inf, x), axis=1)[:, :4]
        line = np.where(np.isinf(xs), np.nan, xs).mean(1)
        compact = np.nanmean(np.sqrt((x - cx[:, None]) ** 2 + (y - cy[:, None]) ** 2), 1)
    bad = n < 8
    out = {"width_m": width, "depth_m": depth, "line_height_m": line,
           "compactness_m": compact, "centroid_x_m": cx}
    for k in out:
        out[k] = np.where(bad, np.nan, out[k]).astype(np.float32)
    out["n_outfield"] = n
    return out


def shape(track, labels, valid):
    lab = filled_labels(labels)
    rows = []
    for half in (1, 2):
        for team in (0, 1):
            frames, xy, slots = roles.normalised(track, team, half)
            step = slice(0, None, FPS)                 # one sample per second
            frames, xy = frames[step], xy[step].copy()
            xy[~valid[frames][:, slots]] = np.nan
            gk = roles.split_goalkeeper(xy)
            has = gk >= 0
            xy[np.arange(len(xy))[has], gk[has]] = np.nan
            s = team_shape(xy)
            side = "H" if team == 0 else "A"
            l = lab[frames]
            phase = np.where(l == side, "in possession", np.where(l == "D", "dead", "out of possession"))
            df = pd.DataFrame({"frame": frames, "team": side, "half": half,
                               "minute": (frames - paths.HALVES[half - 1][0]) / FPS / 60 + (0 if half == 1 else paths.H2),
                               "phase": phase, **s})
            rows.append(df)
    return pd.concat(rows, ignore_index=True)


ALERT_LINE_DROP_M = 6.0      # out-of-possession line this much deeper than the reference
ALERT_SPREAD = 1.15          # compactness this many times looser than the reference


def shape_alerts(df):
    """Per team and half: reference = out-of-possession median in the first 15 min of the half;
    every 5-min block out of possession is compared with it."""
    alerts, refs = [], {}
    oop = df[df.phase == "out of possession"].copy()
    oop["block"] = (oop.minute // 5 * 5).astype(int)
    for (team, half), g in oop.groupby(["team", "half"]):
        start = 0 if half == 1 else paths.H2
        ref = g[g.minute < start + 15][["line_height_m", "compactness_m", "width_m"]].median()
        refs["{}_half{}".format(team, half)] = {k: round(float(v), 1) for k, v in ref.items()}
        for block, b in g.groupby("block"):
            if len(b) < 30:
                continue
            m = b[["line_height_m", "compactness_m", "width_m"]].median()
            msgs = []
            if ref.line_height_m - m.line_height_m > ALERT_LINE_DROP_M:
                msgs.append("defensive line {:.0f} m deeper than at the start".format(
                    ref.line_height_m - m.line_height_m))
            if m.compactness_m > ALERT_SPREAD * ref.compactness_m:
                msgs.append("block {:.0%} less compact".format(m.compactness_m / ref.compactness_m - 1))
            if msgs:
                alerts.append({"team": team, "half": int(half), "minute_from": int(block),
                               "line_height_m": round(float(m.line_height_m), 1),
                               "compactness_m": round(float(m.compactness_m), 1),
                               "messages": msgs})
    return {"reference": refs, "alerts": alerts}


# ---------------------------------------------------------------- Stamina Monitor

MIN_COVERAGE = 0.5           # a role tracked less than this in a block is not judged


def stamina(movement):
    """Fatigue Risk Score per role and 5-min block. Rates are per minute of COVERAGE, so a role
    the tracker lost half the time is not mistaken for a tired one."""
    mv = movement.copy()
    minutes = 5 * mv.coverage.clip(lower=1e-6)
    mv["dist_per_min"] = mv.distance_m / minutes
    mv["hsr_per_min"] = mv.hsr_m / minutes
    mv["sprints_per_10min"] = mv.sprints / minutes * 10
    ok = mv.coverage >= MIN_COVERAGE
    rows = []
    for (team, label), g in mv.groupby(["team", "label"]):
        g = g.sort_values(["half", "minute_from"])
        first_half = g.half.min()
        start = 0 if first_half == 1 else paths.H2
        base = g[(g.half == first_half) & (g.minute_from < start + 15) & ok.loc[g.index]]
        if base.empty:
            continue
        w = base.coverage
        b_dist = np.average(base.dist_per_min, weights=w)
        b_hsr = max(np.average(base.hsr_per_min, weights=w), 1.0)
        b_top = base.top_speed_kmh.max()
        for i, r in g.iterrows():
            row = {"team": team, "label": label, "half": int(r.half), "minute_from": int(r.minute_from),
                   "coverage": r.coverage, "dist_per_min": round(r.dist_per_min, 1),
                   "hsr_per_min": round(r.hsr_per_min, 1),
                   "dist_vs_start": round(r.dist_per_min / b_dist, 3),
                   "hsr_vs_start": round(r.hsr_per_min / b_hsr, 3)}
            if not ok.loc[i]:
                row.update({"risk": None, "level": "no data"})
            else:
                drop_hsr = max(0.0, 1 - r.hsr_per_min / b_hsr)
                drop_dist = max(0.0, 1 - r.dist_per_min / b_dist)
                drop_top = max(0.0, 1 - (r.top_speed_kmh or 0) / b_top) if b_top else 0.0
                load = min(1.0, (r.minute_from + 5) / 90)
                row["risk_raw"] = 0.45 * drop_hsr + 0.25 * drop_dist + 0.15 * drop_top + 0.15 * load
            rows.append(row)
    df = pd.DataFrame(rows)
    # smooth over the last 10 min (two blocks) of the same role: one quiet block is not fatigue
    df["risk"] = (df.groupby(["team", "label"]).risk_raw
                  .transform(lambda s: s.rolling(2, min_periods=1).mean()) * 100).round(0)
    df.loc[df.risk_raw.isna(), "risk"] = np.nan
    df["level"] = np.select([df.risk.isna(), df.risk >= 55, df.risk >= 35],
                            ["no data", "red", "amber"], "green")
    return df.drop(columns="risk_raw")


# ---------------------------------------------------------------- save

def save(trans, maps, summary, shp, alerts, stam):
    out = paths.EXPORTS_DIR
    os.makedirs(out, exist_ok=True)
    trans.to_parquet(os.path.join(out, "transitions.parquet"), index=False)
    _, (nx, ny) = pitch_grid()
    np.savez_compressed(os.path.join(out, "space_maps.npz"), maps=maps,
                        cell_m=CELL, grid=np.array([nx, ny]))
    shp.to_parquet(os.path.join(out, "shape.parquet"), index=False)
    with open(os.path.join(out, "shape_alerts.json"), "w") as handle:
        json.dump(alerts, handle, indent=1)
    with open(os.path.join(out, "transitions_summary.json"), "w") as handle:
        json.dump(summary, handle, indent=1)
    stam.to_parquet(os.path.join(out, "stamina.parquet"), index=False)
    return out
