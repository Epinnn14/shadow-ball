"""v2 = v1 + the reconstructed ball.

Same dead-ball evidence and HMM decoder as v1. The difference is team control: where the tracker
lost the ball, v1 had no evidence (0.5/0.5) and could only hold the previous label. v2 uses the
ball position predicted by ballnet, trusted less the more uncertain the model says it is.

Dead-ball evidence keeps using the REAL ball only (a predicted ball over a line is not proof).
"""

import numpy as np

from . import features as F
from . import hmm, paths, tagging, v1

PARAMS = dict(v1.PARAMS, **{
    "sigma_trust": 8.0,      # m: model uncertainty at which a predicted ball counts ~37%
})


def team_distances(xy, teams, ball):
    diff = xy - ball[:, None, :]
    dist = np.sqrt(np.einsum("tsk,tsk->ts", diff, diff))
    dist = np.where(np.isnan(dist), np.inf, dist)
    home = np.where(teams == 0, dist, np.inf).min(axis=1)
    away = np.where(teams == 1, dist, np.inf).min(axis=1)
    return home, away


def home_probability(track, ball, sigma, p):
    dh, da = team_distances(track.xy, track.teams, ball)
    near = np.minimum(dh, da)
    with np.errstate(invalid="ignore"):
        gap = np.where(np.isfinite(dh) & np.isfinite(da), da - dh, 0.0)
    p_home = v1.sigmoid(gap / p["control_scale"])
    reliability = np.where(np.isfinite(near), np.exp(-near / p["reach"]), 0.0)
    reliability *= np.exp(-sigma / p["sigma_trust"])           # sigma = 0 where the ball is seen
    return np.clip(0.5 + reliability * (p_home - 0.5), 1e-4, 1 - 1e-4)


def run(track, ball, sigma, params=None):
    p = dict(PARAMS, **(params or {}))
    fps = paths.FPS
    log_trans = hmm.transition_matrix(
        p_switch=1.0 / (p["mean_possession_s"] * fps),
        p_die=1.0 / (p["mean_live_s"] * fps),
        p_revive=1.0 / (p["mean_stoppage_s"] * fps))
    p_dead = v1.dead_probability(track, p, tagging.set_pieces())
    p_home = home_probability(track, ball, sigma, p)
    log_e = p["evidence_weight"] * np.stack([
        np.log(1 - p_dead) + np.log(p_home),
        np.log(1 - p_dead) + np.log(1 - p_home),
        np.log(p_dead) + np.log(0.5),
    ], axis=1)
    labels = np.full(len(track), "X", dtype="<U1")
    for first, last in paths.HALVES:
        start = np.log(np.array([0.5, 0.5, 1e-6]))
        path = hmm.viterbi(log_e[first:last + 1], log_trans, start)
        labels[first:last + 1] = hmm.STATES[path]
    return labels
