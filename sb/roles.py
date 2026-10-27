"""Fase B: who plays WHERE, per frame -- role-based tracking with position labels.

Track slots are tracklets, not people (identities swap), so we follow ROLES instead: in every
frame each team's outfield players are matched to the 10 slots of that team's average shape
(Hungarian algorithm), the way Bialkowski et al. (2014) build formations from tracking data.
The goalkeeper is handled separately (the deepest player near his own goal).

Each role then gets a football name from where it sits on average: depth splits the 10 roles
into lines (defence / midfield / attack), width orders each line from the team's left to right.

    python run.py roles        # -> exports/roles.parquet, exports/formations.json

Coordinates are normalised per team and half so that the team always attacks towards +x and
its LEFT side is small y (checked with the homography: y = 0 is the far touchline, and a team
attacking to the right of the tactical camera has the far touchline on its left).

These labels describe a TACTICAL role in the shape at that time, not a player's official
position (a full-back who pushes up can read as a wing-back).
"""

import json
import os

import numpy as np
import pandas as pd
from scipy.optimize import linear_sum_assignment

from . import paths

N_OUTFIELD = 10
GK_MAX_DEPTH = 25.0          # m from own goal line: deepest player beyond this is not a keeper
ITERATIONS = 4


def attacks_right(track, team, half):
    """True if `team` attacks towards +x in `half` (its mean x is below the opponent's)."""
    first, last = paths.HALVES[half - 1]
    xs = track.xy[first:last + 1, :, 0]
    own = np.nanmean(xs[:, track.teams == team])
    opp = np.nanmean(xs[:, track.teams != team])
    return own < opp


def normalised(track, team, half):
    """(frames, positions (T, S_team, 2) normalised, slot ids) for one team in one half."""
    first, last = paths.HALVES[half - 1]
    slots = np.where(track.teams == team)[0]
    xy = track.xy[first:last + 1][:, slots].copy()
    if not attacks_right(track, team, half):
        length, width = paths.PITCH
        xy[..., 0] = length - xy[..., 0]
        xy[..., 1] = width - xy[..., 1]
    return np.arange(first, last + 1), xy, slots


def split_goalkeeper(xy):
    """Per frame: index (into the team's slots) of the goalkeeper, or -1."""
    x = np.where(np.isnan(xy[..., 0]), np.inf, xy[..., 0])
    gk = np.argmin(x, axis=1)
    deepest = x[np.arange(len(x)), gk]
    # the keeper is clearly the deepest: within GK_MAX_DEPTH of his goal and >= 5 m behind
    # the next deepest player (a centre-back can be deep too, but not alone that deep)
    second = np.partition(x, 1, axis=1)[:, 1]
    with np.errstate(invalid="ignore"):
        ok = (deepest < GK_MAX_DEPTH) & (second - deepest > 5.0)
    return np.where(ok, gk, -1)


def _assign(rel_t, idx, means):
    cost = ((rel_t[idx, None, :] - means[None]) ** 2).sum(-1)       # (players, roles)
    r, c = linear_sum_assignment(cost)
    return idx[r], c


def fit_roles(xy, gk, fit_mask=None, fit_every=10):
    """Iterative role assignment. Returns (role (T, S) int8 with -1 = none / 10 = GK,
    role_means (10, 2) relative to the team centroid).

    The average shape is fitted on every `fit_every`-th frame (consecutive frames are nearly
    identical), then every frame is assigned once against the final shape."""
    from scipy.cluster.vq import kmeans2
    T, S, _ = xy.shape
    present = ~np.isnan(xy[..., 0])
    outfield = present.copy()
    has_gk = gk >= 0
    outfield[np.arange(T)[has_gk], gk[has_gk]] = False
    with np.errstate(invalid="ignore"):
        masked = np.where(outfield[..., None], xy, np.nan)
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            centroid = np.nanmean(masked, axis=1)
    rel = xy - centroid[:, None, :]

    fit = np.arange(0, T, fit_every)
    if fit_mask is not None and fit_mask[fit].sum() > 200:
        fit = fit[fit_mask[fit]]
    full = fit[outfield[fit].sum(1) == N_OUTFIELD]
    pts = np.concatenate([rel[t][outfield[t]] for t in full])
    means, _ = kmeans2(pts, N_OUTFIELD, minit="++", seed=0)
    for _ in range(ITERATIONS):
        sums = np.zeros((N_OUTFIELD, 2))
        counts = np.zeros(N_OUTFIELD)
        for t in fit:
            idx = np.where(outfield[t])[0]
            if len(idx):
                players, roles_ = _assign(rel[t], idx, means)
                np.add.at(sums, roles_, rel[t, players])
                np.add.at(counts, roles_, 1)
        means = sums / np.maximum(counts, 1)[:, None]

    role = np.full((T, S), -1, dtype=np.int8)
    for t in range(T):
        idx = np.where(outfield[t])[0]
        if len(idx):
            players, roles_ = _assign(rel[t], idx, means)
            role[t, players] = roles_
    role[np.arange(T)[has_gk], gk[has_gk]] = N_OUTFIELD
    return role, means


LINE_BREAK_M = 5.0           # a depth gap this large between roles separates two lines


def lines_from_depth(depth):
    """Split the 10 role depths into lines, deep -> high.

    Defence: the deepest 3, 4 or 5 roles, cut at the largest gap after them (a back four gets a
    3 m head start: it is by far the most common shape, and a holding midfielder dropping
    between the centre-backs should not turn it into a back five). The rest: a new line at every depth gap of at
    least LINE_BREAK_M (so 4-2-3-1 and 4-4-1-1 are found), or at the largest gap if none is."""
    order = np.argsort(depth)
    d = depth[order]
    best, n_def = -np.inf, 4
    for n in (3, 4, 5):
        score = d[n] - d[n - 1] + (3.0 if n == 4 else 0.0)
        if score > best:
            best, n_def = score, n
    rest = order[n_def:]
    gaps = np.diff(depth[rest])
    breaks = list(np.where(gaps >= LINE_BREAK_M)[0])
    if not breaks:
        breaks = [int(np.argmax(gaps))]
    groups = [order[:n_def]] + np.split(rest, np.array(breaks) + 1)
    return groups


def name_roles(means, width):
    """Football names for the 10 outfield roles from their mean depth (relative to the team
    centroid) and mean width (absolute y; small = the team's left)."""
    depth = means[:, 0]
    groups = lines_from_depth(depth)
    defence, middle, attack = groups[0], groups[1:-1], groups[-1]
    centre = paths.PITCH[1] / 2
    names = {}

    def by_width(group):
        return list(np.asarray(group)[np.argsort(width[np.asarray(group)])])

    def is_wide(r, limit):
        return abs(width[r] - centre) > limit

    d = by_width(defence)
    if len(d) >= 5:
        names.update({d[0]: "LWB", d[-1]: "RWB"})
        for r in d[1:-1]:
            names[r] = "CB"
    elif len(d) == 4:
        names.update({d[0]: "LB", d[1]: "CB", d[2]: "CB", d[3]: "RB"})
    else:
        for r in d:
            names[r] = "CB"

    if len(middle) == 1:
        m = by_width(middle[0])
        central = sorted([r for r in m if not is_wide(r, 15.0)], key=lambda r: depth[r])
        for r in m:
            if is_wide(r, 15.0):
                names[r] = "LM" if width[r] < centre else "RM"
        for r in central:
            names[r] = "CM"
        if len(central) >= 2 and depth[central[1]] - depth[central[0]] > 4.0:
            names[central[0]] = "CDM"
        if len(central) >= 2 and depth[central[-1]] - depth[central[-2]] > 4.0:
            names[central[-1]] = "CAM"
    else:
        # several midfield lines: the deepest holds (CDM), the highest supports (CAM / wingers)
        for k, line in enumerate(middle):
            holding = k == 0
            for r in line:
                if is_wide(r, 15.0 if holding else 11.0):
                    names[r] = ("LM" if width[r] < centre else "RM") if holding else \
                               ("LW" if width[r] < centre else "RW")
                else:
                    names[r] = "CDM" if holding else ("CAM" if k == len(middle) - 1 else "CM")

    a = by_width(attack)
    central = sorted([r for r in a if not is_wide(r, 12.0)], key=lambda r: depth[r])
    for r in a:
        if is_wide(r, 12.0):
            names[r] = "LW" if width[r] < centre else "RW"
    for r in central:
        names[r] = "ST"
    if len(central) >= 2:
        names[central[0]] = "CF"
    formation = "-".join(str(len(g)) for g in groups)
    # duplicated names get a side, from the team's left: LCB / RCB, LCDM / RCDM, LCM / CM / RCM
    for label in set(names.values()):
        same = sorted([r for r in names if names[r] == label], key=lambda r: width[r])
        if len(same) == 2:
            names[same[0]], names[same[1]] = "L" + label, "R" + label
        elif len(same) == 3:
            names[same[0]], names[same[2]] = "L" + label, "R" + label
    return names, formation


def run(track, possession):
    """Returns (DataFrame frame/slot/team/half/role/label, formations dict).

    `possession` = per-frame labels (H/A/D) from our own pipeline. The shape that NAMES the roles
    is fitted on frames where the team does NOT have the ball: out of possession every team
    falls back into its base shape (back four, midfield line, forwards), while in possession
    full-backs push up and the same team can look like a 2-3-5."""
    rows = []
    formations = {}
    for half in (1, 2):
        for team in (0, 1):
            frames, xy, slots = normalised(track, team, half)
            gk = split_goalkeeper(xy)
            side = "H" if team == 0 else "A"
            other = "A" if team == 0 else "H"
            defending = np.asarray(possession)[frames] == other
            role, means = fit_roles(xy, gk, fit_mask=defending)
            outfield = (role >= 0) & (role < N_OUTFIELD)
            width = np.array([np.nanmean(xy[..., 1][role == r]) for r in range(N_OUTFIELD)])
            names, formation = name_roles(means, width)
            labels = np.array([names[r] for r in range(N_OUTFIELD)] + ["GK"])
            t_idx, s_idx = np.where(role >= 0)
            rows.append(pd.DataFrame({
                "frame": frames[t_idx].astype(np.int32),
                "slot": slots[s_idx].astype(np.int16),
                "team": np.full(len(t_idx), side),
                "half": np.full(len(t_idx), half, dtype=np.int8),
                "role": role[t_idx, s_idx],
                "label": labels[role[t_idx, s_idx]],
            }))
            key = "{}_half{}".format(track.team_names[team], half)
            formations[key] = {
                "formation": formation,
                "roles": {labels[r]: [round(float(means[r, 0]), 1), round(float(width[r]), 1)]
                          for r in range(N_OUTFIELD)} if len(set(labels[:N_OUTFIELD])) == N_OUTFIELD
                else [{"label": labels[r], "depth_m": round(float(means[r, 0]), 1),
                       "width_m": round(float(width[r]), 1)} for r in range(N_OUTFIELD)],
                "fitted_on": "frames out of possession ({:.0%} of the half)".format(defending.mean()),
                "gk_found_share": round(float((gk >= 0).mean()), 3),
                "outfield_assigned_mean": round(float(outfield.sum(1).mean()), 2),
            }
    return pd.concat(rows, ignore_index=True), formations


def save(df, formations):
    out = os.path.join(paths.REPO, "exports")
    os.makedirs(out, exist_ok=True)
    df.to_parquet(os.path.join(out, "roles.parquet"), index=False)
    with open(os.path.join(out, "formations.json"), "w") as handle:
        json.dump(formations, handle, indent=1)
    return out
