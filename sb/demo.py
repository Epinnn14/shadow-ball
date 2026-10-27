"""Demo data: one replay clip for the Shadow Ball web app (demo/), from the best pipeline outputs
(v4.1 possession, ballnet ball, roles, tactics).

    python run.py demo                    # default: second half, match minutes 55-70
    python run.py demo --from 60 --to 75
    python run.py serve                   # laptop + phones on the same Wi-Fi / hotspot

The clip is DERIVED match data (player positions): it is written to exports/demo/ (gitignored)
and served only from the laptop on the local network. Never upload it to a public host.

Layout of clip.json (positions in metres, raw camera frame: x 0..105.3, y 0..68, y = 0 is the
far touchline):
  meta        teams, labels, fps of the samples, clip window, pitch size
  frames      every 5th video frame: [frame, possession, ball, players]
              ball = [x, y, source (0 seen / 1 model), sigma]
              players = [[slot, team, label index, x, y, speed], ...] (role-assigned slots only)
  seconds     once per clip second: cumulative movement per role since kick-off,
              team shape (line height, width, depth, compactness, phase)
  timeline    possession per match minute up to the end of the clip
  events      Bench Copilot feed: fatigue, shape alerts, transitions, each with the frame it
              becomes known (the end of its 5-min block, or the turnover)
  stamina     Fatigue Risk Score per role and 5-min block
  transitions every turnover up to the end of the clip (for counter-press KPIs)
"""

import json
import os

import numpy as np
import pandas as pd

from . import movement, paths, roles as roles_mod

SAMPLE = 5                      # 25 fps / 5 = 5 samples per second
OUT_DIR = os.path.join(paths.REPO, "exports", "demo")


def match_minute(frame):
    half = 1 if frame <= paths.HALVES[0][1] else 2
    start = paths.HALVES[half - 1][0]
    return (frame - start) / paths.FPS / 60 + (0 if half == 1 else 45)


def frame_at(minute):
    """First video frame of a match minute (45+ = second half)."""
    if minute < 45:
        return int(paths.HALVES[0][0] + minute * 60 * paths.FPS)
    return int(paths.HALVES[1][0] + (minute - 45) * 60 * paths.FPS)


def block_end(half, minute_from, block=5):
    """Frame at which a 5-min block that started at `minute_from` (match minutes) of `half` ends:
    the moment its numbers are known. Half 1 can run past 45' (stoppage time)."""
    start, end = paths.HALVES[half - 1]
    offset = minute_from + block - (0 if half == 1 else 45)
    return int(min(start + offset * 60 * paths.FPS, end))


def cumulative_role_stats(speed):
    """Per-frame running totals for one role: distance (m), HSR (m), sprints, top speed (km/h,
    1-s rolling mean, so a one-frame glitch is not a record)."""
    v = np.nan_to_num(speed)
    dist = np.cumsum(v) / paths.FPS
    hsr = np.cumsum(np.where(v > movement.HSR, v, 0)) / paths.FPS
    fast = v > movement.SPRINT
    run = np.zeros(len(v), dtype=np.int32)
    for i in range(1, len(v)):
        run[i] = run[i - 1] + 1 if fast[i] else 0
    sprints = np.cumsum(run == movement.SPRINT_MIN_FRAMES)       # counted once, at 1 s
    smooth = np.convolve(v, np.ones(paths.FPS) / paths.FPS, mode="same")
    top = np.maximum.accumulate(smooth) * 3.6
    return dist, hsr, sprints, top


def build(track, labels, ball, sigma, source, role_df, tactics_dir, minute_from=55, minute_to=70):
    first, last = frame_at(minute_from), min(frame_at(minute_to), paths.N_FRAMES - 1)
    if paths.half_of_frames()[first] != paths.half_of_frames()[last]:
        raise ValueError("a clip must stay inside one half")
    half = int(paths.half_of_frames()[first])
    names = sorted(role_df.label.unique())
    label_idx = {l: i for i, l in enumerate(names)}

    # ---- frames (5 per second)
    sel = role_df[(role_df.frame >= first) & (role_df.frame <= last) & (role_df.frame % SAMPLE == 0)]
    by_frame = {f: g for f, g in sel.groupby("frame")}
    frames = []
    for f in range(-(-first // SAMPLE) * SAMPLE, last + 1, SAMPLE):
        g = by_frame.get(f)
        players = []
        if g is not None:
            slots = g.slot.to_numpy()
            xy = track.xy[f, slots]
            sp = np.nan_to_num(track.speed[f, slots])
            for k, s in enumerate(slots):
                if np.isnan(xy[k, 0]):
                    continue
                players.append([int(s), 0 if g.team.iloc[k] == "H" else 1, label_idx[g.label.iloc[k]],
                                round(float(xy[k, 0]), 2), round(float(xy[k, 1]), 2),
                                round(float(min(sp[k], movement.MAX_SPEED)), 1)])
        b = ball[f]
        frames.append([f, str(labels[f]),
                       [round(float(b[0]), 2), round(float(b[1]), 2), int(source[f]), round(float(sigma[f]), 1)]
                       if not np.isnan(b[0]) else None, players])

    # ---- cumulative movement per role since kick-off, sampled once per clip second
    secs = np.arange(first, last + 1, paths.FPS)
    cum = {}
    for team in ("H", "A"):
        for label in sorted(role_df[role_df.team == team].label.unique()):
            if label == "GK":
                continue
            totals = np.zeros((len(secs), 4))
            for h in (1, 2):
                if h > half:
                    break
                a, b_ = paths.HALVES[h - 1]
                if not ((role_df.team == team) & (role_df.half == h) & (role_df.label == label)).any():
                    continue
                speed, _ = movement.role_series(role_df, track, team, h, label)
                d, hs, spr, top = cumulative_role_stats(speed)
                if h < half:
                    totals[:, 0] += d[-1]
                    totals[:, 1] += hs[-1]
                    totals[:, 2] += spr[-1]
                    totals[:, 3] = np.maximum(totals[:, 3], top[-1])
                else:
                    idx = secs - a
                    totals[:, 0] += d[idx]
                    totals[:, 1] += hs[idx]
                    totals[:, 2] += spr[idx]
                    totals[:, 3] = np.maximum(totals[:, 3], top[idx])
            if totals[-1, 0] > 0:
                cum["{}:{}".format(team, label)] = [[round(r[0]), round(r[1]), int(r[2]), round(r[3], 1)]
                                                     for r in totals]

    # ---- team shape once per second (from tactics: shape.parquet is already 1 Hz)
    shp = pd.read_parquet(os.path.join(tactics_dir, "shape.parquet"))
    shp = shp[(shp.frame >= first) & (shp.frame <= last)]
    shape = {}
    for team, g in shp.groupby("team"):
        g = g.set_index("frame").reindex(secs, method="nearest")
        shape[team] = [[None if np.isnan(r.line_height_m) else round(float(r.line_height_m), 1),
                        None if np.isnan(r.width_m) else round(float(r.width_m), 1),
                        None if np.isnan(r.depth_m) else round(float(r.depth_m), 1),
                        None if np.isnan(r.compactness_m) else round(float(r.compactness_m), 1),
                        r.phase[0]] for r in g.itertuples()]

    # ---- possession per match minute (majority, X forward-filled) up to the end of the clip
    from .tactics import filled_labels
    lab = filled_labels(labels)
    timeline = []
    for h in (1, 2):
        a, b_ = paths.HALVES[h - 1]
        end = b_ if h < half else last
        if h > half:
            break
        for s in range(a, end + 1, 60 * paths.FPS):
            seg = lab[s:min(s + 60 * paths.FPS, end + 1)]
            vals, counts = np.unique(seg, return_counts=True)
            timeline.append([h, str(vals[np.argmax(counts)])])

    # ---- tactics outputs up to the end of the clip
    trans = pd.read_parquet(os.path.join(tactics_dir, "transitions.parquet"))
    trans = trans[trans.frame <= last]
    sides = {(t, h): roles_mod.attacks_right(track, t, h) for t in (0, 1) for h in (1, 2)}
    tr_rows = []
    for r in trans.itertuples():
        right = sides[(0 if r.won_by == "H" else 1, int(r.half))]
        fx, fy = (r.free_x, r.free_y) if not pd.isna(getattr(r, "free_x", np.nan)) else (None, None)
        if fx is not None and not right:                     # back to the raw camera frame
            fx, fy = paths.PITCH[0] - fx, paths.PITCH[1] - fy
        tr_rows.append({"frame": int(r.frame), "half": int(r.half), "won_by": r.won_by, "zone": r.zone,
                        "regained": bool(r.regained_5s), "pressers": float(r.pressers_mean_5s),
                        "dangerous": bool(r.dangerous), "final_third": bool(r.reached_final_third),
                        "goal_side": int(r.losers_goal_side),
                        "free": None if fx is None else [round(float(fx), 1), round(float(fy), 1),
                                                         float(r.free_space_m)]})
    stam = pd.read_parquet(os.path.join(tactics_dir, "stamina.parquet"))
    stam_rows = [{"team": r.team, "label": r.label, "half": int(r.half), "minute": int(r.minute_from),
                  "risk": None if pd.isna(r.risk) else int(r.risk), "level": r.level,
                  "hsr": float(r.hsr_vs_start), "dist": float(r.dist_vs_start)}
                 for r in stam.itertuples()]
    with open(os.path.join(tactics_dir, "shape_alerts.json")) as handle:
        alerts = json.load(handle)

    events = []
    for s in stam_rows:
        if s["level"] == "red":
            known = block_end(s["half"], s["minute"])
            if known <= last:
                events.append({"frame": known, "kind": "fatigue",
                               "team": s["team"], "label": s["label"], "risk": s["risk"],
                               "hsr": s["hsr"], "dist": s["dist"], "minute": s["minute"]})
    for a in alerts["alerts"]:
        known = block_end(a["half"], a["minute_from"])
        if known <= last:
            events.append({"frame": known, "kind": "shape", "team": a["team"],
                           "minute": a["minute_from"], "messages": a["messages"]})
    for t in tr_rows:
        if t["dangerous"]:
            events.append({"frame": t["frame"], "kind": "transition", "team": t["won_by"],
                           "zone": t["zone"], "goal_side": t["goal_side"], "free": t["free"]})
    events.sort(key=lambda e: e["frame"])

    with open(os.path.join(tactics_dir, "formations.json")) as handle:
        formations = json.load(handle)
    return {
        "meta": {"teams": {"H": track.team_names[0], "A": track.team_names[1]},
                 "formation": {"H": formations["{}_half{}".format(track.team_names[0], half)]["formation"],
                               "A": formations["{}_half{}".format(track.team_names[1], half)]["formation"]},
                 "labels": names, "sample_fps": paths.FPS // SAMPLE, "fps": paths.FPS,
                 "half": half, "half_start": paths.HALVES[half - 1][0],
                 "first": first, "last": last, "minute_from": minute_from, "minute_to": minute_to,
                 "pitch": list(paths.PITCH),
                 "model": "v4.1 possession (HMM + ballnet ball) / roles / tactics",
                 "shape_ref": alerts["reference"]},
        "frames": frames, "seconds": {"frames": secs.tolist(), "movement": cum, "shape": shape},
        "timeline": timeline, "events": events, "stamina": stam_rows, "transitions": tr_rows,
    }


def save(clip):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "clip.json")
    with open(path, "w") as handle:
        json.dump(clip, handle, separators=(",", ":"))
    return path
