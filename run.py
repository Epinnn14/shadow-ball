"""Shadow Ball, Phase 1 pipeline. One entry point, so the submission is one command away.

    python run.py cache                 # parse the raw ATD once -> cache/tactical_atd.npz
    python run.py check                 # sanity checks on the data (counts, ball visibility)
    python run.py baseline --window 50  # v0: reproduce the organisers' baseline
    python run.py v1                    # v1: dead-ball detection + sticky possession (HMM)
    python run.py ball-train --cv       # v2: train the ball model (GPU if available), validate
    python run.py v2                    # v2: v1 + reconstructed ball
    python run.py v3                    # v3: v2 + fouls / whistles
    python run.py v4                    # v4: v3 + live from the restart kick (current submission)
    python run.py export                # contract files for the next phases -> exports/
    python run.py roles                 # Fase B: position labels + movement per position -> exports/
    python run.py tactics               # Fase B: transitions, shape, stamina, space -> exports/
    python run.py demo                  # replay clip for the web demo -> exports/demo/clip.json
    python run.py serve                 # web demo on the laptop, phones on the same Wi-Fi
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

from sb import atd, baseline, paths, submission, v1, v2, v3, v4


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


def cmd_v4(args):
    cmd_v2(args, module=v4, name="v4_restart")


def cmd_export(args):
    import os
    from sb import export
    z = np.load(os.path.join(paths.CACHE_DIR, "ball_reconstructed.npz"))
    track = atd.Tracking()
    labels = v4.run(track, z["ball"], z["sigma"])
    out = export.export(labels, z["ball"], z["sigma"], z["source"])
    print("wrote possession.csv and ball.parquet to", out, "(derived data: never commit)")


def cmd_roles(args):
    import json
    import os
    from sb import movement, roles
    pos_path = os.path.join(paths.SUBMISSIONS_DIR, "v4_restart.csv")
    if not os.path.isfile(pos_path):
        sys.exit("Run python run.py v4 first: roles are named from the out-of-possession shape.")
    import pandas as pd
    possession = pd.read_csv(pos_path)["label"].to_numpy()
    track = atd.Tracking()
    t0 = time.time()
    df, formations = roles.run(track, possession)
    sides = {("H" if team == 0 else "A", half): roles.attacks_right(track, team, half)
             for team in (0, 1) for half in (1, 2)}
    mv, heat = movement.run(df, track, sides)
    roles.save(df, formations)
    out = movement.save(mv, heat)
    print("roles + movement in {:.0f}s -> {}".format(time.time() - t0, out))
    for key, value in formations.items():
        print("  {:<22} {}".format(key, value["formation"]))
    totals = mv.groupby(["team", "label"]).agg(
        km=("distance_m", lambda x: round(x.sum() / 1000, 2)),
        sprints=("sprints", "sum"), top_kmh=("top_speed_kmh", "max"))
    print(totals.sort_values("km", ascending=False).head(12).to_string())


def cmd_tactics(args):
    import os
    import pandas as pd
    from sb import tactics
    pos_path = os.path.join(paths.SUBMISSIONS_DIR, "v4_restart.csv")
    mv_path = os.path.join(paths.REPO, "exports", "movement.parquet")
    if not (os.path.isfile(pos_path) and os.path.isfile(mv_path)):
        sys.exit("Run python run.py v4 and python run.py roles first.")
    labels = pd.read_csv(pos_path)["label"].to_numpy()
    ball = np.load(os.path.join(paths.CACHE_DIR, "ball_reconstructed.npz"))["ball"]
    track = atd.Tracking()
    t0 = time.time()
    valid = tactics.assigned_slots(pd.read_parquet(os.path.join(paths.REPO, "exports", "roles.parquet"),
                                                   columns=["frame", "slot"]), *track.xy.shape[:2])
    trans, maps = tactics.transitions(track, labels, ball, valid)
    summary = tactics.transition_summary(trans)
    shp = tactics.shape(track, labels, valid)
    alerts = tactics.shape_alerts(shp)
    stam = tactics.stamina(pd.read_parquet(mv_path))
    out = tactics.save(trans, maps, summary, shp, alerts, stam)
    print("tactics in {:.0f}s -> {}".format(time.time() - t0, out))
    print("transitions: {} turnovers".format(len(trans)))
    for team, s in summary.items():
        print("  {} wins {:>3}  dangerous {:>3}  final third {:.0%}  counter-press success {:.0%} "
              "(pressers {:.1f})".format(team, s["ball_wins"], s["dangerous_transitions"],
                                         s["reached_final_third_share"], s["counter_press_success_5s"],
                                         s["pressers_mean_5s"]))
    print("shape alerts: {}".format(len(alerts["alerts"])))
    for a in alerts["alerts"][:6]:
        print("  {} min {:>2}: {}".format(a["team"], a["minute_from"], "; ".join(a["messages"])))
    red = stam[stam.level == "red"]
    print("stamina: {} red / {} amber blocks".format(len(red), int((stam.level == "amber").sum())))
    if len(red):
        print(red.sort_values("risk", ascending=False).head(6)[
            ["team", "label", "minute_from", "risk", "hsr_vs_start", "dist_vs_start"]].to_string(index=False))


def cmd_demo(args):
    import os
    import pandas as pd
    from sb import demo
    exp = os.path.join(paths.REPO, "exports")
    pos_path = os.path.join(paths.SUBMISSIONS_DIR, "v4_restart.csv")
    if not all(os.path.isfile(os.path.join(exp, f)) for f in ("roles.parquet", "shape.parquet")):
        sys.exit("Run python run.py v4, roles and tactics first.")
    labels = pd.read_csv(pos_path)["label"].to_numpy()
    z = np.load(os.path.join(paths.CACHE_DIR, "ball_reconstructed.npz"))
    track = atd.Tracking()
    role_df = pd.read_parquet(os.path.join(exp, "roles.parquet"))
    t0 = time.time()
    clip = demo.build(track, labels, z["ball"], z["sigma"], z["source"], role_df, exp,
                      minute_from=args.minute_from, minute_to=args.minute_to)
    path = demo.save(clip)
    print("demo clip {}'-{}' ({} frames, {} events) -> {} ({:.1f} MB) in {:.0f}s".format(
        args.minute_from, args.minute_to, len(clip["frames"]), len(clip["events"]), path,
        os.path.getsize(path) / 1e6, time.time() - t0))
    print("next: python run.py serve")


def cmd_serve(args):
    import functools
    import http.server
    import os
    import socket
    root = os.path.join(paths.REPO, "demo")
    clip = os.path.join(paths.REPO, "exports", "demo", "clip.json")
    if not os.path.isfile(clip):
        sys.exit("No demo clip yet. Run: python run.py demo")

    import json
    state = {"frame": None, "playing": False, "speed": 1, "t": time.time()}
    lineup_path = os.path.join(paths.REPO, "exports", "demo", "lineup.json")   # local only, gitignored
    MAX_LINEUP = 4 * 1024 * 1024                  # names + small photos chosen by the coach

    class Handler(http.server.SimpleHTTPRequestHandler):
        # /api/state : the laptop (lead) posts where the replay is; phones (follow) read it
        # /api/lineup: names, numbers, formation and photos the coach entered before kick-off
        def _json(self, body, code=200):
            body = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            route = self.path.split("?")[0]
            if route == "/api/state":
                return self._json(dict(state, now=time.time()))
            if route == "/api/lineup":
                if not os.path.isfile(lineup_path):
                    return self._json({"lineup": None})
                with open(lineup_path, "rb") as handle:
                    return self._json(handle.read())
            super().do_GET()

        def do_POST(self):
            route = self.path.split("?")[0]
            size = int(self.headers.get("Content-Length", 0))
            if route not in ("/api/state", "/api/lineup") or size > MAX_LINEUP:
                self.send_error(404 if size <= MAX_LINEUP else 413)
                return
            try:
                data = json.loads(self.rfile.read(size))
                if route == "/api/state":
                    state.update(frame=int(data["frame"]), playing=bool(data["playing"]),
                                 speed=float(data["speed"]), t=time.time())
                else:
                    if not isinstance(data.get("lineup"), dict):
                        raise ValueError("lineup missing")
                    with open(lineup_path, "w") as handle:
                        json.dump({"lineup": data["lineup"]}, handle)
            except (ValueError, KeyError, TypeError):
                self.send_error(400)
                return
            self.send_response(204)
            self.end_headers()

        def translate_path(self, path):
            if path.split("?")[0] == "/data/clip.json":
                return clip
            return super().translate_path(path)

        def log_message(self, *a):
            pass

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))        # no packet is sent: only picks the LAN interface
        ip = s.getsockname()[0]
        s.close()
    except OSError:
        ip = "127.0.0.1"
    server = http.server.ThreadingHTTPServer(("0.0.0.0", args.port),
                                             functools.partial(Handler, directory=root))
    print("Shadow Ball demo")
    print("  laptop : http://localhost:{}".format(args.port))
    print("  HP     : http://{}:{}  (Wi-Fi/hotspot yang sama; izinkan Python di firewall 'Private')".format(ip, args.port))
    print("Ctrl+C untuk berhenti. Data hanya dilayani dari laptop ini, tidak diunggah ke mana pun.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


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
    sub.add_parser("v4").set_defaults(func=cmd_v4)
    sub.add_parser("export").set_defaults(func=cmd_export)
    sub.add_parser("roles").set_defaults(func=cmd_roles)
    sub.add_parser("tactics").set_defaults(func=cmd_tactics)
    p = sub.add_parser("demo")
    p.add_argument("--from", dest="minute_from", type=float, default=55)
    p.add_argument("--to", dest="minute_to", type=float, default=70)
    p.set_defaults(func=cmd_demo)
    p = sub.add_parser("serve")
    p.add_argument("--port", type=int, default=8000)
    p.set_defaults(func=cmd_serve)
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
