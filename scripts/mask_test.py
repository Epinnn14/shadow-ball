"""Does the reconstructed ball improve POSSESSION labels when the ball is missing?

The public 5 minutes cannot answer this directly: the ball is seen on almost every frame there.
So we hide it on purpose, with gaps drawn from the real gap lengths until ~41% of the window is
missing (the full-match rate), then score v1 and v2 against the public ground truth. Several
random maskings, paired comparison: same mask for both versions.

This uses the public ground truth to MEASURE, not to tune: no parameter is chosen from it.

    python run.py ball-train --train-half 2      # model that never saw half 1 (public window)
    python scripts/mask_test.py --runs 8 --model cache/ballnet_half2.pt
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
from sb import atd, ballnet, paths, v1, v2  # noqa: E402

TARGET_MISSING = 0.41


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
    parser.add_argument("--model", default=os.path.join(paths.CACHE_DIR, "ballnet_half2.pt"),
                        help="use a model trained on half 2 only; the full model has seen the "
                             "public window and makes this test optimistic")
    args = parser.parse_args()
    if os.path.basename(args.model) == "ballnet.pt":
        print("WARNING: the full model was trained on the public window too: results are optimistic")
    track = atd.Tracking()
    model = ballnet.load(args.model)
    gaps = ballnet.real_gap_lengths(track)
    gt_codes = pm.label_codes(pd.read_csv(paths.PUBLIC_GT))
    rows = []
    rng = np.random.default_rng(7)
    for run in range(args.runs):
        t2 = masked_track(track, rng, gaps)
        lab1 = v1.run(t2)
        ball, sigma, _ = ballnet.reconstruct(model, t2)
        lab2 = v2.run(t2, ball, sigma)
        s1, m1 = score(lab1, gt_codes)
        s2, m2 = score(lab2, gt_codes)
        rows.append((s1, s2, m1, m2))
        print("run {}: spellF1 v1 {:.3f}  v2 {:.3f}   macroF1 v1 {:.3f}  v2 {:.3f}".format(
            run, s1, s2, m1, m2))
    r = np.array(rows)
    print("\nmean spellF1  v1 {:.3f}  v2 {:.3f}  (v2 better in {}/{} runs)".format(
        r[:, 0].mean(), r[:, 1].mean(), int((r[:, 1] > r[:, 0]).sum()), len(r)))
    print("mean macroF1  v1 {:.3f}  v2 {:.3f}  (v2 better in {}/{} runs)".format(
        r[:, 2].mean(), r[:, 3].mean(), int((r[:, 3] > r[:, 2]).sum()), len(r)))
    full = (score(v1.run(track), gt_codes))
    print("reference, ball NOT hidden: v1 spellF1 {:.3f} macroF1 {:.3f}".format(*full))


if __name__ == "__main__":
    main()
