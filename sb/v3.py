"""v3 = v2 + fouls and other stoppages where the ball stays on the pitch.

v1/v2 catch a stoppage reliably only when the ball crosses a line. A foul leaves no such trace,
so v3 reads it from the players instead:
  whistle   everyone decelerates together and stays slow (latched until the restart)
  long      team activity over 10 s (stoppages are long, slow build-ups are not that slow)
  placed    the ball sits still inside the pitch while the team is slow (free kick set-up)

Team control (who has the ball when it is alive) is exactly v2's, reconstructed ball included.
Parameters are set from football reasoning, not tuned on the public 5 minutes.
"""

import numpy as np

from . import features as F
from . import hmm, paths, tagging, v1, v2

PARAMS = dict(v2.PARAMS, **{
    "w_whistle": 2.5,            # inferred whistle until restart: strong, but not proof like a line
    "activity_gain_10s": 1.0,    # logit per m/s below the pivot, 10 s window
    "w_placed": 1.5,             # ball still inside the pitch while the team is slow
})


def dead_probability(track, p, events):
    base_logit = np.log(v1.dead_probability(track, p, events))
    base_logit -= np.log1p(-np.exp(base_logit))                 # back to logit space
    act_10s = F.team_activity(track, window=250)
    logit = (base_logit
             + p["activity_gain_10s"] * (p["activity_pivot"] - act_10s)
             + p["w_whistle"] * F.whistle_until_restart(track)
             + p["w_placed"] * F.ball_placed_inside(track))
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
