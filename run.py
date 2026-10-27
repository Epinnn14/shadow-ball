"""Shadow Ball, Phase 1 pipeline. One entry point, so the submission is one command away.

    python run.py cache                 # parse the raw ATD once -> cache/tactical_atd.npz
    python run.py check                 # sanity checks on the data (counts, ball visibility)
    python run.py baseline --window 50  # v0: reproduce the organisers' baseline
    python run.py v1                    # v1: dead-ball detection + sticky possession (HMM)
    python run.py ball-train --cv       # v2: train the ball model (GPU if available), validate
    python run.py v2                    # v2: v1 + reconstructed ball
    python run.py v3                    # v3: v2 + fouls / whistles (current submission)
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

from sb import atd, baseline, paths, submission, v1, v2, v3


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


def cmd_ball_train(args):
    import json
    import os
    from sb import ballnet
    track = atd.Tracking()
    halves = {1: ballnet.half_frames(track, 1), 2: ballnet.half_frames(track, 2)}
    report = {"steps": args.steps, "batch": args.batch}
    if args.train_half:
        # one half only, early-stopped on the other: a model that has never seen the other half,
        # for leak-free tests on it (e.g. scripts/mask_test.py on the public window, half 1)
        val_h = 3 - args.train_half
        model = ballnet.train(track, halves[args.train_half], steps=args.steps, batch=args.batch,
                              val_frames=halves[val_h])
        out = os.path.join(paths.CACHE_DIR, "ballnet_half{}.pt".format(args.train_half))
        ballnet.save(model, out)
        print("saved {} (best step {})".format(out, model.best_step))
        return
    final_steps = args.steps
    if args.cv:
        best_steps = []
        for train_h, val_h in ((1, 2), (2, 1)):
            print("cross-validation: train half {}, validate half {}".format(train_h, val_h))
            model = ballnet.train(track, halves[train_h], steps=args.steps, batch=args.batch,
                                  val_frames=halves[val_h])
            res = ballnet.evaluate(model, track, halves[val_h])
            res["best_step"] = model.best_step
            best_steps.append(model.best_step)
            report["cv_train{}_val{}".format(train_h, val_h)] = res
            print(json.dumps(res, indent=1))
        # early stopping chose these; the final model (no held-out half left) uses their mean
        final_steps = int(np.mean(best_steps))
    report["final_steps"] = final_steps
    print("final model: train on both halves, {} steps".format(final_steps))
    model = ballnet.train(track, np.concatenate([halves[1], halves[2]]),
                          steps=final_steps, batch=args.batch)
    ballnet.save(model)
    ball, sigma, source = ballnet.reconstruct(model, track)
    out = os.path.join(paths.CACHE_DIR, "ball_reconstructed.npz")
    np.savez(out, ball=ball, sigma=sigma, source=source)
    log = os.path.join(paths.REPO, "experiments", "ballnet_{}.json".format(time.strftime("%Y%m%d_%H%M")))
    with open(log, "w") as handle:
        json.dump(report, handle, indent=1)
    print("saved model to {}, reconstruction to {}, report to {}".format(
        ballnet.model_path(), out, log))


def cmd_v2(args, module=v2, name="v2_ballnet"):
    import os
    path = os.path.join(paths.CACHE_DIR, "ball_reconstructed.npz")
    if not os.path.isfile(path):
        sys.exit("No reconstructed ball yet. Run: python run.py ball-train --cv")
    z = np.load(path)
    track = atd.Tracking()
    labels = module.run(track, z["ball"], z["sigma"])
    out = submission.write(labels, name)
    stats = submission.summary(labels)
    graded = sum(stats[k] for k in "HAD")
    print("wrote", out)
    print("{}  D share {:.1f}%  mean possession {:.1f}s".format(
        stats, 100 * stats["D"] / graded, (stats["H"] + stats["A"]) / paths.FPS / stats["possessions"]))
    submission.validate(out)


def cmd_v3(args):
    cmd_v2(args, module=v3, name="v3_whistle")


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
    p = sub.add_parser("ball-train")
    p.add_argument("--steps", type=int, default=20000)
    p.add_argument("--batch", type=int, default=512)
    p.add_argument("--cv", action="store_true", help="also train/validate across halves (3x time)")
    p.add_argument("--train-half", type=int, choices=(1, 2),
                   help="train on one half only -> cache/ballnet_half<N>.pt (for leak-free tests)")
    p.set_defaults(func=cmd_ball_train)
    sub.add_parser("v2").set_defaults(func=cmd_v2)
    sub.add_parser("v3").set_defaults(func=cmd_v3)
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
