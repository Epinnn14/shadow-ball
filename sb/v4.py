"""v4 = v3 + the ball is live from the restart kick on.

v3 ended stoppages 1-5 s late: its slowness evidence uses 5-10 s windows, and right after a
throw-in or goal kick the players are still slow. When a stoppage latch (ball over a line, or an
inferred whistle) ends because the ball was KICKED, that kick is the restart: v4 adds strong
"alive" evidence for the next 5 s so the dead-ball stretch ends on the kick itself.
"""

import numpy as np

from . import features as F
from . import hmm, paths, tagging, v1, v2, v3

PARAMS = dict(v3.PARAMS, **{
    "w_restart": 5.0,   # logit pushed towards "alive" after a seen restart kick
})


def dead_probability(track, p, events):
    base = v3.dead_probability(track, p, events)
    logit = np.log(base) - np.log1p(-base)
    kicks = F.restart_kicks(track, [F.out_until_restart(track), F.whistle_until_restart(track)])
    logit = logit - p["w_restart"] * F.after_restart(kicks)
    return np.clip(v1.sigmoid(logit), 1e-4, 1 - 1e-4)


def run(track, ball, sigma, params=None):
    p = dict(PARAMS, **(params or {}))
    fps = paths.FPS
    log_trans = hmm.transition_matrix(
        p_switch=1.0 / (p["mean_possession_s"] * fps),
        p_die=1.0 / (p["mean_live_s"] * fps),
        p_revive=1.0 / (p["mean_stoppage_s"] * fps))
    p_dead = dead_probability(track, p, tagging.set_pieces())
    p_home = v2.home_probability(track, ball, sigma, p)
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
