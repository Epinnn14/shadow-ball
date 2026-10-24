"""v0: the organisers' baseline, vectorised. Nearest player to the ball, then a majority window.

It exists to prove the pipeline (loader -> labels -> file -> scorer) is wired correctly: with
window=50 it must reproduce evaluation/reference_baseline_smooth50.csv (published spellF1 0.2433
on the full match). Every later version is compared against this floor.
"""

import numpy as np

HOME, AWAY, NOBODY = 0, 1, -1


def nearest_team(track):
    """Per frame: team (0/1) of the tracked player closest to the ball, NOBODY if no ball."""
    diff = track.xy.astype(np.float64) - track.ball[:, None, :].astype(np.float64)
    dist = np.einsum("tsk,tsk->ts", diff, diff)          # squared metres, NaN if unseen
    dist = np.where(np.isnan(dist), np.inf, dist)
    slot = np.argmin(dist, axis=1)                        # first minimum, like the reference
    codes = track.teams[slot].astype(np.int8)
    no_answer = ~track.ball_seen | np.isinf(dist[np.arange(len(slot)), slot])
    codes[no_answer] = NOBODY
    return codes


def majority(codes, window):
    """Centred majority vote over +/- window frames; D where nobody had the ball."""
    if window <= 0:
        return np.where(codes == HOME, "H", np.where(codes == AWAY, "A", "D"))
    home_c = np.concatenate(([0], np.cumsum(codes == HOME)))
    away_c = np.concatenate(([0], np.cumsum(codes == AWAY)))
    idx = np.arange(len(codes))
    low = np.maximum(0, idx - window)
    high = np.minimum(len(codes), idx + window + 1)
    home = home_c[high] - home_c[low]
    away = away_c[high] - away_c[low]
    labels = np.full(len(codes), "D", dtype="<U1")
    seen = (home + away) > 0
    labels[seen] = np.where(home[seen] >= away[seen], "H", "A")
    return labels


def run(track, window=50):
    return majority(nearest_team(track), window)
