"""Shadow Ball, Phase 1 pipeline. One entry point, so the submission is one command away.

    python run.py cache                 # parse the raw ATD once -> cache/tactical_atd.npz
    python run.py check                 # sanity checks on the data (counts, ball visibility)
    python run.py baseline --window 50  # v0: reproduce the organisers' baseline
    python run.py v1                    # v1: dead-ball detection + sticky possession (HMM)
    python run.py ball-train            # train the ball model on EXTERNAL data only (Metrica open sample games)
    python run.py ball-predict          # rebuild the unseen ball from the frozen models/ballnet.pt (CPU)
    python run.py v2                    # v2: v1 + reconstructed ball
    python run.py v3                    # v3: v2 + fouls / whistles
    python run.py v4                    # v4.3: v3 + restarts + kick-off; ballnet trained on external data (submission)
    python run.py export                # contract files for the next phases -> exports/
    python run.py roles                 # Fase B: position labels + movement per position -> exports/
    python run.py tactics               # Fase B: transitions, shape, stamina, space -> exports/
    python run.py offball               # Shadow Ball core: off-ball movement value + shadow positions
    python run.py demo                  # replay clip for the web demo -> exports/demo/clip.json
    python run.py serve                 # web demo on the laptop, phones on the same Wi-Fi
    python run.py score                 # score every CSV in submissions/ (public 5 min only)
    python run.py score -- --bootstrap 1000   # with confidence intervals
    python run.py validate FILE         # the organisers' exact validation checks

The public 5 minutes check that the pipeline is CORRECT. They cannot choose between versions:
see evaluation/../EVALUATION.md in the organisers' repo.
"""

import argparse
import os
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
    """Train ballnet on EXTERNAL data only (rules clarification, 3 Nov 2026): the open Metrica
    Sports sample games 1 + 2 train it, game 3 early-stops it. The competition match is never
    read here. Writes the frozen weights models/ballnet.pt and a report in experiments/."""
    import json
    from sb import ballnet, external
    games = {g: external.load_game(g) for g in (1, 2, 3)}
    train_track = external.concat([games[1], games[2]])
    val_track = external.concat([games[3]])
    gaps = external.gap_lengths(train_track)
    val_gaps = external.gap_lengths(val_track)
    print("external data: train {} ({} seen-ball frames), validate {} ({})".format(
        train_track.name, len(external.target_frames(train_track)),
        val_track.name, len(external.target_frames(val_track))))
    model = ballnet.train(train_track, external.target_frames(train_track), gaps,
                          steps=args.steps, batch=args.batch, seed=args.seed,
                          val_track=val_track, val_frames=external.target_frames(val_track),
                          val_gaps=val_gaps)
    report = {"data": "Metrica Sports sample data (github.com/metrica-sports/sample-data)",
              "train": train_track.name, "validate": val_track.name,
              "steps": args.steps, "batch": args.batch, "seed": args.seed,
              "best_step": int(model.best_step),
              "validation": ballnet.evaluate(model, val_track, external.target_frames(val_track), val_gaps)}
    print(json.dumps(report, indent=1))
    os.makedirs(os.path.dirname(FROZEN_WEIGHTS), exist_ok=True)
    ballnet.save(model, FROZEN_WEIGHTS)
    log = os.path.join(paths.REPO, "experiments", "ballnet_external_{}.json".format(time.strftime("%Y%m%d_%H%M")))
    with open(log, "w") as handle:
        json.dump(report, handle, indent=1)
    print("saved frozen weights to {} (sha256 {}) and report to {}".format(
        FROZEN_WEIGHTS, sha256(FROZEN_WEIGHTS), log))
    print("next: python run.py ball-predict")


FROZEN_WEIGHTS = os.path.join(paths.REPO, "models", "ballnet.pt")


def sha256(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def cmd_ball_predict(args):
    """Rebuild the unseen ball from the frozen weights, on the CPU: no training, so the same
    weights + the same data give the same reconstruction (GPU training is not bit-reproducible)."""
    os.environ["SB_DEVICE"] = "cpu"
    import torch
    torch.use_deterministic_algorithms(True)
    torch.set_num_threads(1)
    from sb import ballnet
    weights = args.weights or FROZEN_WEIGHTS
    if not os.path.isfile(weights):
        sys.exit("No weights at {}. Train them with: python run.py ball-train".format(weights))
    track = atd.Tracking()
    model = ballnet.load(weights)
    model.eval()
    ball, sigma, source = ballnet.reconstruct(model, track)
    out = os.path.join(paths.CACHE_DIR, "ball_reconstructed.npz")
    os.makedirs(paths.CACHE_DIR, exist_ok=True)
    np.savez(out, ball=ball, sigma=sigma, source=source)
    print("weights  {}  sha256 {}".format(weights, sha256(weights)))
    print("wrote    {}  ({} frames rebuilt)".format(out, int(source.sum())))
    print("next: python run.py v4")


def cmd_v2(args, module=v2, name="v2_ballnet"):
    import os
    path = os.path.join(paths.CACHE_DIR, "ball_reconstructed.npz")
    if not os.path.isfile(path):
        sys.exit("No reconstructed ball yet. Run: python run.py ball-predict")
    z = np.load(path)
    track = atd.Tracking()
    labels = module.run(track, z["ball"], z["sigma"])
    out = submission.write(labels, name)
    stats = submission.summary(labels)
    graded = sum(stats[k] for k in "HAD")
    print("wrote", out, " sha256", sha256(out))
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


def cmd_offball(args):
    import json
    import os
    import pandas as pd
    from sb import offball, roles as roles_mod
    from sb.tactics import filled_labels
    exp = os.path.join(paths.REPO, "exports")
    labels = pd.read_csv(os.path.join(paths.SUBMISSIONS_DIR, "v4_restart.csv"))["label"].to_numpy()
    ball = np.load(os.path.join(paths.CACHE_DIR, "ball_reconstructed.npz"))["ball"]
    track = atd.Tracking()
    role_df = pd.read_parquet(os.path.join(exp, "roles.parquet"))
    t0 = time.time()
    players, teams, info = offball.run(track, labels, ball, role_df, every=args.every)
    lab = filled_labels(labels)
    sides = {(t, h): roles_mod.attacks_right(track, t, h) for t in (0, 1) for h in (1, 2)}
    transitions = pd.read_parquet(os.path.join(exp, "transitions.parquet"))
    by_role, by_team, validity, trend, recovery = offball.summarize(players, teams, lab, ball, sides, transitions)
    rest = offball.rest_validity(teams, lab, ball, sides, transitions)
    stamina = pd.read_parquet(os.path.join(exp, "stamina.parquet")) if os.path.exists(os.path.join(exp, "stamina.parquet")) else None
    leak, leak_rel = offball.leak_blocks(players, stamina)
    out = offball.save(players, teams, by_role, by_team, info, validity, trend, recovery, rest, leak, leak_rel)
    # Pressing Trap Map (same run: it needs the same labels, ball and roles)
    from sb import pressing
    from sb.tactics import assigned_slots
    valid = assigned_slots(role_df, *track.xy.shape[:2])
    gk = np.zeros_like(valid)
    g = role_df[role_df.label == "GK"]
    gk[g.frame.to_numpy(), g.slot.to_numpy()] = True
    press = pressing.seconds(track, lab, ball, valid, gk, sides)
    bands = pressing.band_table(press)
    pressing.save(press, pressing.zone_table(press), bands)
    print("off-ball model: {} player-seconds, {} team-seconds in {:.0f}s -> {}".format(
        len(players), len(teams), time.time() - t0, out))
    print(by_team.round(3).to_string(index=False))
    print(json.dumps(validity, indent=1))
    print("rest defence:", json.dumps(rest, indent=1))
    print("fatigue vs denial:", json.dumps(leak_rel, indent=1))
    print("pressing ({} s, {:.0%} pressed):".format(len(press), press.press.mean()))
    print(bands.to_string(index=False))
    print(json.dumps(recovery))


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
    players_path = os.path.join(paths.REPO, "exports", "demo", "players.json")
    decisions_path = os.path.join(paths.REPO, "exports", "demo", "decisions.json")
    snapshot = {"snapshot": None}
    MAX_LINEUP = 4 * 1024 * 1024                  # names + small photos chosen by the coach

    class Handler(http.server.SimpleHTTPRequestHandler):
        # /api/state : the laptop (lead) posts where the replay is; phones (follow) read it
        # /api/lineup: names, numbers, formation and photos the coach entered before kick-off
        #              (also written as players.json: the squad profiles, without photos)
        # /api/snapshot: what the laptop shows now (priorities, Plan B, substitutes, fatigue...),
        #              also written to decisions.json for the Bench Copilot
        def _json(self, body, code=200):
            body = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def end_headers(self):
            # the app changes often: the browser must re-check every file (304 when unchanged),
            # otherwise an old app.js / style.css stays cached next to a new index.html
            if not self.path.startswith("/api/"):
                self.send_header("Cache-Control", "no-cache")
            super().end_headers()

        def do_GET(self):
            route = self.path.split("?")[0]
            if route == "/api/state":
                return self._json(dict(state, now=time.time()))
            if route == "/api/snapshot":
                return self._json(snapshot)
            if route == "/api/lineup":
                if not os.path.isfile(lineup_path):
                    return self._json({"lineup": None})
                with open(lineup_path, "rb") as handle:
                    return self._json(handle.read())
            super().do_GET()

        def do_POST(self):
            route = self.path.split("?")[0]
            size = int(self.headers.get("Content-Length", 0))
            if route not in ("/api/state", "/api/lineup", "/api/snapshot") or size > MAX_LINEUP:
                self.send_error(404 if size <= MAX_LINEUP else 413)
                return
            try:
                data = json.loads(self.rfile.read(size))
                if route == "/api/state":
                    state.update(frame=int(data["frame"]), playing=bool(data["playing"]),
                                 speed=float(data["speed"]), t=time.time())
                elif route == "/api/snapshot":
                    if not isinstance(data, dict):
                        raise ValueError("snapshot must be an object")
                    snapshot["snapshot"] = data
                    with open(decisions_path, "w") as handle:
                        json.dump(data, handle, indent=1)
                else:
                    if not isinstance(data.get("lineup"), dict):
                        raise ValueError("lineup missing")
                    with open(lineup_path, "w") as handle:
                        json.dump({"lineup": data["lineup"]}, handle)
                    squad = [{k: v for k, v in p.items() if k != "photo"} for p in data["lineup"].get("squad", [])]
                    opp = data["lineup"].get("opp") or {}
                    opp_xi = {slot: {k: v for k, v in (p or {}).items() if k != "photo"} for slot, p in (opp.get("xi") or {}).items()}
                    with open(players_path, "w") as handle:
                        json.dump({"formation": data["lineup"].get("formation"), "xi": data["lineup"].get("xi"),
                                   "squad": squad, "opponent": {"name": data["lineup"].get("oppName"),
                                                                "formation": opp.get("formation"), "xi": opp_xi}}, handle, indent=1)
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
    print("  phone  : http://{}:{}  (same Wi-Fi / hotspot; allow Python on 'Private' networks in the firewall)".format(ip, args.port))
    print("Ctrl+C to stop. The data is served from this laptop only and never uploaded.")
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
    p.add_argument("--steps", type=int, default=60000)  # cap; early stopping on external game 3 picks the step
    p.add_argument("--batch", type=int, default=512)
    p.add_argument("--seed", type=int, default=0)
    p.set_defaults(func=cmd_ball_train)
    p = sub.add_parser("ball-predict", help="rebuild the unseen ball from the frozen weights (CPU, reproducible)")
    p.add_argument("--weights", help="default: models/ballnet.pt")
    p.set_defaults(func=cmd_ball_predict)
    sub.add_parser("v2").set_defaults(func=cmd_v2)
    sub.add_parser("v3").set_defaults(func=cmd_v3)
    sub.add_parser("v4").set_defaults(func=cmd_v4)
    sub.add_parser("export").set_defaults(func=cmd_export)
    sub.add_parser("roles").set_defaults(func=cmd_roles)
    sub.add_parser("tactics").set_defaults(func=cmd_tactics)
    p = sub.add_parser("offball")
    p.add_argument("--every", type=int, default=25, help="frames between samples (25 = once per second)")
    p.set_defaults(func=cmd_offball)
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
