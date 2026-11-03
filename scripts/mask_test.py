"""Does the reconstructed ball improve POSSESSION labels when the ball is missing?

The public 5 minutes cannot answer this directly: the ball is seen on almost every frame there.
So we hide it on purpose, with gaps drawn from the real gap lengths until ~41% of the window is
missing (the full-match rate), then score v1 and v2 against the public ground truth. Several
random maskings, paired comparison: same mask for both versions.

This uses the public ground truth to MEASURE, not to tune: no parameter is chosen from it. Under
the rules clarification of 3 Nov 2026 it is a sanity check only; it never picks a version.
The ball model is trained on external data only, so it has never seen this match at all.

    python scripts/mask_test.py --runs 8          # uses the frozen models/ballnet.pt
"""

import argparse
import copy
import os
import sys

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "evaluation"))

import possession_metrics as pm  # noqa: E402
from sb import atd, ballnet, paths, v1, v2, v3, v4  # noqa: E402

TARGET_MISSING = 0.41
VERSIONS = ("v1", "v2", "v3", "v4")


def masked_track(track, rng, gaps):
    first, last = paths.PUBLIC_WINDOW
    ball = track.ball.copy()
    hidden = np.zeros(len(ball), dtype=bool)
    span = last - first + 1
    while hidden[first:last + 1].mean() < TARGET_MISSING:
        g = int(min(rng.choice(gaps), span // 3))
        start = rng.integers(first, last - g)
        hidden[start:start + g] = True
    ball[hidden] = np.nan
    out = copy.copy(track)
    out.ball = ball
    return out


def score(labels, gt_codes):
    res = pm.evaluate(gt_codes, pm.label_codes(labels), bootstrap_n=0)
    return res["spell_f1_mean"], res["macro_f1"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=8)
    parser.add_argument("--model", default=os.path.join(paths.REPO, "models", "ballnet.pt"),
                        help="frozen weights trained on external data only")
    args = parser.parse_args()
    track = atd.Tracking()
    model = ballnet.load(args.model)
    gaps = ballnet.real_gap_lengths(track)
    gt_codes = pm.label_codes(pd.read_csv(paths.PUBLIC_GT))
    rows = []
    rng = np.random.default_rng(7)
    for run in range(args.runs):
        t2 = masked_track(track, rng, gaps)
        ball, sigma, _ = ballnet.reconstruct(model, t2)
        labels = {"v1": v1.run(t2), "v2": v2.run(t2, ball, sigma), "v3": v3.run(t2, ball, sigma),
                  "v4": v4.run(t2, ball, sigma)}
        scores = {k: score(lab, gt_codes) for k, lab in labels.items()}
        rows.append([scores[k][0] for k in VERSIONS] + [scores[k][1] for k in VERSIONS])
        print("run {}: spellF1 ".format(run) + "  ".join(
            "{} {:.3f}".format(k, scores[k][0]) for k in VERSIONS) + "   macroF1 " + "  ".join(
            "{} {:.3f}".format(k, scores[k][1]) for k in VERSIONS))
    r = np.array(rows)
    n = len(VERSIONS)
    for j, metric in ((0, "spellF1"), (n, "macroF1")):
        means = "  ".join("{} {:.3f}".format(k, r[:, j + i].mean()) for i, k in enumerate(VERSIONS))
        print("mean {}  {}".format(metric, means))
        for i in range(1, n):
            better = int((r[:, j + i] > r[:, j + i - 1]).sum())
            print("   {} better than {} in {}/{} runs".format(
                VERSIONS[i], VERSIONS[i - 1], better, len(r)))
    full = (score(v1.run(track), gt_codes))
    print("reference, ball NOT hidden: v1 spellF1 {:.3f} macroF1 {:.3f}".format(*full))


if __name__ == "__main__":
    main()
