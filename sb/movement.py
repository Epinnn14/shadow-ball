"""Fase B: movement statistics per position (role), per 5 minutes, plus heatmaps.

Built on roles.py: in every frame each role is held by exactly one tracked player, so summing
that player's speed gives the role's distance even when track identities swap.

    python run.py roles        # also writes exports/movement.parquet and exports/heatmaps.npz

Thresholds (common in football physical analysis):
  high-speed running  > 19.8 km/h (5.5 m/s)
  sprint              > 25.2 km/h (7.0 m/s) held for at least 1 s
Speeds above 11 m/s are tracking glitches (identity jumps) and are ignored.
Distances are UNDERESTIMATES where the tracker lost a player: `coverage` says how much of the
window the role was actually assigned.
"""

import os

import numpy as np
import pandas as pd

from . import paths

HSR = 5.5
SPRINT = 7.0
SPRINT_MIN_FRAMES = 25
MAX_SPEED = 11.0
WINDOW_S = 300
HEAT_BINS = (21, 14)


def role_series(roles, track, team, half, label):
    """Per-frame speed (m/s) and normalised position of whoever holds `label`, NaN if nobody."""
    first, last = paths.HALVES[half - 1]
    sel = roles[(roles.team == team) & (roles.half == half) & (roles.label == label)]
    n = last - first + 1
    speed = np.full(n, np.nan, dtype=np.float32)
    xy = np.full((n, 2), np.nan, dtype=np.float32)
    f = sel.frame.to_numpy() - first
    s = sel.slot.to_numpy()
    speed[f] = track.speed[sel.frame.to_numpy(), s]
    xy[f] = track.xy[sel.frame.to_numpy(), s]
    speed[speed > MAX_SPEED] = np.nan
    return speed, xy


def sprint_count(speed):
    fast = np.nan_to_num(speed) > SPRINT
    edges = np.diff(np.concatenate(([0], fast.astype(int), [0])))
    starts, ends = np.where(edges == 1)[0], np.where(edges == -1)[0]
    return int(np.sum(ends - starts >= SPRINT_MIN_FRAMES))


def run(roles, track, attacks_right):
    """attacks_right[(team_code, half)] -> bool, to normalise positions to 'attacking +x'."""
    length, width = paths.PITCH
    rows, heat = [], {}
    win = WINDOW_S * paths.FPS
    for (team, half), group in roles.groupby(["team", "half"]):
        first, _ = paths.HALVES[half - 1]
        for label in sorted(group.label.unique()):
            speed, xy = role_series(roles, track, team, half, label)
            if not attacks_right[(team, half)]:
                xy = np.stack([length - xy[:, 0], width - xy[:, 1]], axis=1)
            for w0 in range(0, len(speed), win):
                sp = speed[w0:w0 + win]
                pos = xy[w0:w0 + win]
                ok = ~np.isnan(sp)
                rows.append({
                    "team": team, "half": int(half), "label": label,
                    "minute_from": round((first + w0 - paths.HALVES[half - 1][0]) / paths.FPS / 60
                                         + (0 if half == 1 else 45)),
                    "coverage": round(float(ok.mean()), 3),
                    "distance_m": round(float(np.nansum(sp) / paths.FPS), 1),
                    "hsr_m": round(float(np.nansum(np.where(sp > HSR, sp, 0)) / paths.FPS), 1),
                    "sprints": sprint_count(sp),
                    "top_speed_kmh": round(float(np.nanpercentile(sp, 99) * 3.6), 1) if ok.any() else None,
                    "mean_x_m": round(float(np.nanmean(pos[:, 0])), 1) if ok.any() else None,
                    "mean_y_m": round(float(np.nanmean(pos[:, 1])), 1) if ok.any() else None,
                })
            good = ~np.isnan(xy[:, 0])
            h, _, _ = np.histogram2d(xy[good, 0], xy[good, 1], bins=HEAT_BINS,
                                     range=[[0, length], [0, width]])
            key = "{}_half{}_{}".format(team, half, label)
            heat[key] = (h / max(h.sum(), 1)).astype(np.float32)
    return pd.DataFrame(rows), heat


def save(df, heat):
    out = os.path.join(paths.REPO, "exports")
    os.makedirs(out, exist_ok=True)
    df.to_parquet(os.path.join(out, "movement.parquet"), index=False)
    np.savez_compressed(os.path.join(out, "heatmaps.npz"), **heat)
    return out
