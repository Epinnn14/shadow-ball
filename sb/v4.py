"""v4 = v3 + the ball is live from the restart kick on (v4.1: restarts taken unseen; v4.2: dead before
the kick-off when a half's graded window opens before it).

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
    # v4.2: by the laws the ball is not in play before the kick-off. Only used when a half's graded
    # window opens more than `prekick_min_s` before the detected kick-off (in this match, half 2:
    # graded from 110,808, kick-off ~113,742); otherwise the window opens on the kick-off itself.
    "w_prekick": 20.0,
    "prekick_min_s": 10.0,
})


def prekick_mask(track, p):
    """1 on graded frames before a detected kick-off (see features.kickoff_frame), else 0."""
    from . import roles
    mask = np.zeros(len(track), dtype=float)
    kicks = {}
    for h, (first, last) in enumerate(paths.HALVES, 1):
        right = {t: roles.attacks_right(track, t, h) for t in (0, 1)}
        k = F.kickoff_frame(track, first, right)
        kicks[h] = k
        if k is not None and k - first > p["prekick_min_s"] * paths.FPS:
            mask[first:k] = 1.0
    return mask, kicks


def dead_probability(track, p, events):
    base = v3.dead_probability(track, p, events)
    logit = np.log(base) - np.log1p(-base)
    kicks = F.restart_kicks(track, [F.out_until_restart(track), F.whistle_until_restart(track)])
    logit = logit - p["w_restart"] * F.after_restart(kicks)
    if p.get("w_prekick"):
        logit = logit + p["w_prekick"] * prekick_mask(track, p)[0]
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
    pre = prekick_mask(track, p)[0] if p.get("w_prekick") else np.zeros(len(track))
    for first, last in paths.HALVES:
        # a half starts alive at its kick-off, or dead when its graded window opens before it (v4.2)
        start = np.log(np.array([1e-6, 1e-6, 1.0] if pre[first] else [0.5, 0.5, 1e-6]))
        path = hmm.viterbi(log_e[first:last + 1], log_trans, start)
        labels[first:last + 1] = hmm.STATES[path]
    return labels
