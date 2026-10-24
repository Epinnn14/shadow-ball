"""v1: sticky possession + dead-ball detection, decoded with a 3-state HMM.

Evidence per frame (all from tracking, plus Smart Tagging as a weak hint):
  dead-ball score  low team activity, ball over a line, long unseen ball while slow,
                   start of a tagged set piece
  team control     which team's nearest player is closer to the ball, weighted by how close
                   anyone is (a loose ball far from everyone says little)

Parameters below are set from football reasoning, NOT tuned on the public 5 minutes
(the organisers show that tuning there picks the wrong version). Each has its reason.
"""

import numpy as np

from . import features as F
from . import hmm, paths, tagging

PARAMS = {
    # --- dead ball ---------------------------------------------------------------------------
    "activity_pivot": 1.3,    # m/s: team mean speed around which live/dead is undecided
    "activity_gain": 1.5,     # logit per m/s below the pivot, 2 s window (whistle = sudden drop)
    "activity_gain_long": 1.5,  # same, 5 s window (stoppages are SUSTAINED slowness)
    "dead_bias": -1.0,        # prior logit of D before evidence (~27%)
    "w_out": 8.0,             # ball over a line is dead by the laws: dominates other evidence
    "w_setpiece": 0.8,        # Smart Tagging is noisy: a nudge, not a decision
    "w_unseen_slow": 0.8,     # ball lost > 2 s while players are slow
    "unseen_frames": 50,
    "unseen_activity": 1.4,
    # --- team control ------------------------------------------------------------------------
    "control_scale": 1.0,     # m: distance gap that makes one team clearly closer
    "reach": 2.5,             # m: how close the nearest player must be for evidence to count
    # --- decoder -----------------------------------------------------------------------------
    "evidence_weight": 0.25,  # frames are correlated at 25 fps: ~4 frames = 1 independent look
    "mean_possession_s": 10.0,
    "mean_live_s": 40.0,
    "mean_stoppage_s": 15.0,
}


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def dead_probability(track, p, events):
    act = F.team_activity(track)
    act_long = F.team_activity(track, window=125)
    out = F.out_until_restart(track)
    unseen_slow = ((F.unseen_run(track) > p["unseen_frames"]) &
                   (act < p["unseen_activity"])).astype(float)
    setpiece = F.tagged_set_pieces(len(track), events)
    logit = (p["dead_bias"]
             + p["activity_gain"] * (p["activity_pivot"] - act)
             + p["activity_gain_long"] * (p["activity_pivot"] - act_long)
             + p["w_out"] * out
             + p["w_setpiece"] * setpiece
             + p["w_unseen_slow"] * unseen_slow)
    return np.clip(sigmoid(logit), 1e-4, 1 - 1e-4)


def home_probability(track, p):
    """P(home in control) per frame, 0.5 where the ball is unseen or nobody is near it."""
    dh, da = F.team_distances(track)
    near = np.minimum(dh, da)
    with np.errstate(invalid="ignore"):
        gap = np.where(np.isfinite(dh) & np.isfinite(da), da - dh, 0.0)
    p_home = sigmoid(gap / p["control_scale"])
    reliability = np.where(np.isfinite(near), np.exp(-near / p["reach"]), 0.0)
    return np.clip(0.5 + reliability * (p_home - 0.5), 1e-4, 1 - 1e-4)


def emissions(track, p, events):
    p_dead = dead_probability(track, p, events)
    p_home = home_probability(track, p)
    log_e = np.stack([
        np.log(1 - p_dead) + np.log(p_home),
        np.log(1 - p_dead) + np.log(1 - p_home),
        np.log(p_dead) + np.log(0.5),
    ], axis=1)
    return p["evidence_weight"] * log_e


def run(track, params=None):
    p = dict(PARAMS, **(params or {}))
    fps = paths.FPS
    log_trans = hmm.transition_matrix(
        p_switch=1.0 / (p["mean_possession_s"] * fps),
        p_die=1.0 / (p["mean_live_s"] * fps),
        p_revive=1.0 / (p["mean_stoppage_s"] * fps))
    log_e = emissions(track, p, tagging.set_pieces())
    labels = np.full(len(track), "X", dtype="<U1")
    for first, last in paths.HALVES:
        # each half starts with a kick-off: alive, either team
        start = np.log(np.array([0.5, 0.5, 1e-6]))
        path = hmm.viterbi(log_e[first:last + 1], log_trans, start)
        labels[first:last + 1] = hmm.STATES[path]
    return labels
