"""Write and check the possession file: `frame,label`, 199319 rows, labels H/A/D/X."""

import os
import subprocess
import sys

import numpy as np

from . import paths

LABELS = ("H", "A", "D", "X")


def write(labels, name):
    """Write submissions/<name>.csv and return its path. `labels` = array of 'H'/'A'/'D'/'X'."""
    labels = np.asarray(labels).astype("<U1")
    if len(labels) != paths.N_FRAMES:
        raise ValueError("need {} labels, got {}".format(paths.N_FRAMES, len(labels)))
    bad = set(np.unique(labels)) - set(LABELS)
    if bad:
        raise ValueError("unknown labels: {}".format(sorted(bad)))
    # Ungraded frames are never scored; X there makes the file honest about it.
    labels = np.where(paths.graded_mask(), labels, "X")
    os.makedirs(paths.SUBMISSIONS_DIR, exist_ok=True)
    path = os.path.join(paths.SUBMISSIONS_DIR, name + ".csv")
    with open(path, "w", newline="\n") as handle:
        handle.write("frame,label\n")
        handle.writelines("{},{}\n".format(i, lab) for i, lab in enumerate(labels))
    return path


def summary(labels):
    """Counts and number of possessions (maximal H or A runs, X forward-filled per half)."""
    labels = np.asarray(labels).astype("<U1")
    graded = paths.graded_mask()
    out = {lab: int(np.sum((labels == lab) & graded)) for lab in LABELS}
    n_poss = 0
    for first, last in paths.HALVES:
        seg = labels[first:last + 1].copy()
        # forward-fill X the way the scorer does
        prev = None
        for i, lab in enumerate(seg):
            if lab == "X":
                seg[i] = prev if prev is not None else "X"
            else:
                prev = lab
        change = np.concatenate(([True], seg[1:] != seg[:-1]))
        n_poss += int(np.sum(change & np.isin(seg, ["H", "A"])))
    out["possessions"] = n_poss
    return out


def validate(path):
    """Run the organisers' validator on a file. Returns True if it passes."""
    script = os.path.join(paths.EVAL_DIR, "validate_submission.py")
    result = subprocess.run([sys.executable, script, path], capture_output=True, text=True)
    print(result.stdout.strip())
    if result.returncode != 0:
        print(result.stderr.strip())
    return result.returncode == 0


def score(results_dir=None, extra_args=()):
    """Run the organisers' scorer on every CSV in submissions/ against the public 5 minutes.

    Use it to check correctness, never to choose between versions (see EVALUATION.md).
    """
    script = os.path.join(paths.EVAL_DIR, "run_evaluation.py")
    out_dir = os.path.join(paths.REPO, "experiments", "scoreboard")
    os.makedirs(out_dir, exist_ok=True)
    cmd = [sys.executable, script, "--results", results_dir or paths.SUBMISSIONS_DIR,
           "--out", out_dir] + list(extra_args)
    return subprocess.run(cmd).returncode
