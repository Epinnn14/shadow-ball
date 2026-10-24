"""A 3-state hidden Markov model over frames: H (home has it), A (away has it), D (dead ball).

Why an HMM: the ranking metric scores whole possessions, so the decoder must prefer a few long
runs over many flickering ones. The transition matrix encodes that "possession is sticky", and
Viterbi finds the single most likely label sequence for a whole half at once.
"""

import numpy as np

STATES = np.array(["H", "A", "D"])
H, A, D = 0, 1, 2


def transition_matrix(p_switch, p_die, p_revive):
    """Per-frame transition probabilities.

    p_switch: H<->A per frame while alive        (1 / mean possession length in frames)
    p_die:    alive -> D per frame               (1 / mean live stretch in frames)
    p_revive: D -> alive per frame, split evenly (1 / mean stoppage length in frames)
    """
    stay_alive = 1.0 - p_switch - p_die
    trans = np.array([
        [stay_alive, p_switch, p_die],
        [p_switch, stay_alive, p_die],
        [p_revive / 2, p_revive / 2, 1.0 - p_revive],
    ])
    return np.log(trans)


def viterbi(log_emission, log_trans, log_start=None):
    """Most likely state sequence. log_emission: (T, 3). Returns int array (T,)."""
    n, k = log_emission.shape
    if log_start is None:
        log_start = np.log(np.full(k, 1.0 / k))
    back = np.zeros((n, k), dtype=np.int8)
    score = log_start + log_emission[0]
    for t in range(1, n):
        cand = score[:, None] + log_trans          # (from, to)
        back[t] = np.argmax(cand, axis=0)
        score = cand[back[t], np.arange(k)] + log_emission[t]
    path = np.empty(n, dtype=np.int8)
    path[-1] = int(np.argmax(score))
    for t in range(n - 1, 0, -1):
        path[t - 1] = back[t, path[t]]
    return path
