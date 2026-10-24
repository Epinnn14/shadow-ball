"""Shadow Ball, Phase 1 pipeline. One entry point, so the submission is one command away.

    python run.py cache                 # parse the raw ATD once -> cache/tactical_atd.npz
    python run.py check                 # sanity checks on the data (counts, ball visibility)
    python run.py baseline --window 50  # v0: reproduce the organisers' baseline
    python run.py v1                    # v1: dead-ball detection + sticky possession (HMM)
    python run.py score                 # score every CSV in submissions/ (public 5 min only)
    python run.py score -- --bootstrap 1000   # with confidence intervals
    python run.py validate FILE         # the organisers' exact validation checks

The public 5 minutes check that the pipeline is CORRECT. They cannot choose between versions:
see evaluation/../EVALUATION.md in the organisers' repo.
"""

import argparse
import sys
import time

import numpy as np

from sb import atd, baseline, paths, submission, v1


def cmd_cache(args):
    t0 = time.time()
    out = atd.build_cache("tactical")
    print("wrote {} in {:.0f}s".format(out, time.time() - t0))


def cmd_check(args):
    track = atd.Tracking()
    graded = paths.graded_mask()
    seen = track.player_seen
    print("teams: H = {}, A = {}".format(*track.team_names))
    print("frames: {}  (graded {})".format(len(track), int(graded.sum())))
    print("slots: {}  home {} / away {}".format(len(track.teams), int((track.teams == 0).sum()),
                                                 int((track.teams == 1).sum())))
    print("ball seen: {:.1f}% of all frames, {:.1f}% of graded".format(
        100 * track.ball_seen.mean(), 100 * track.ball_seen[graded].mean()))
    print("players seen per graded frame: mean {:.1f}".format(seen[graded].sum(1).mean()))
    for name, (a, b) in (("half 1", paths.HALVES[0]), ("half 2", paths.HALVES[1])):
        print("{}: frames {}..{}, ball seen {:.1f}%".format(
            name, a, b, 100 * track.ball_seen[a:b + 1].mean()))


def cmd_baseline(args):
    track = atd.Tracking()
    labels = baseline.run(track, args.window)
    name = "v0_baseline_w{}".format(args.window)
    path = submission.write(labels, name)
    print("wrote", path, submission.summary(labels))
    if args.window == 50:
        compare_reference(labels)
    submission.validate(path)


def cmd_v1(args):
    track = atd.Tracking()
    t0 = time.time()
    labels = v1.run(track)
    path = submission.write(labels, "v1_hmm")
    stats = submission.summary(labels)
    graded = sum(stats[k] for k in "HAD")
    print("wrote {} in {:.1f}s".format(path, time.time() - t0))
    print("{}  D share {:.1f}%  mean possession {:.1f}s".format(
        stats, 100 * stats["D"] / graded, (stats["H"] + stats["A"]) / paths.FPS / stats["possessions"]))
    submission.validate(path)


def compare_reference(labels):
    """v0 with window 50 must match the organisers' published baseline on graded frames."""
    import pandas as pd
    ref = pd.read_csv(paths.EVAL_DIR + "/reference_baseline_smooth50.csv")["label"].to_numpy()
    graded = paths.graded_mask()
    agree = np.mean(ref[graded] == np.asarray(labels)[graded])
    print("agreement with reference baseline_smooth50 on graded frames: {:.4%}".format(agree))


def cmd_score(args):
    extra = [a for a in args.extra if a != "--"]
    sys.exit(submission.score(extra_args=extra))


def cmd_validate(args):
    sys.exit(0 if submission.validate(args.file) else 1)


def main():
    parser = argparse.ArgumentParser(description="Shadow Ball Phase 1 pipeline")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("cache").set_defaults(func=cmd_cache)
    sub.add_parser("check").set_defaults(func=cmd_check)
    p = sub.add_parser("baseline")
    p.add_argument("--window", type=int, default=50)
    p.set_defaults(func=cmd_baseline)
    sub.add_parser("v1").set_defaults(func=cmd_v1)
    p = sub.add_parser("score")
    p.add_argument("extra", nargs=argparse.REMAINDER, help="passed to run_evaluation.py")
    p.set_defaults(func=cmd_score)
    p = sub.add_parser("validate")
    p.add_argument("file")
    p.set_defaults(func=cmd_validate)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
