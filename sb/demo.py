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
  shadow      the off-ball core once per second: space denied, shadow positions, Shadow Replay
              moments (see shadow_block; null until `python run.py offball` has been run)
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

    momentum, entries = momentum_and_entries(lab, ball, sides, half, last)
    from . import tagging
    tags = tagging.load()
    setpieces = set_pieces(tags, lab, ball, source, sides, half, last)
    events_st = match_events(tags, lab, last)
    runs = label_runs(lab, half, last)
    running = team_running(pd.read_parquet(os.path.join(tactics_dir, "movement.parquet")))

    ob_players, ob_teams, surface = load_offball(tactics_dir)
    shadow = shadow_block(ob_players, ob_teams, entries, label_idx, first, last, surface,
                          pd.read_parquet(os.path.join(tactics_dir, "transitions.parquet")))

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
                 "shape_ref": alerts["reference"],
                 # each team's own out-of-possession shape (roles.py): depth relative to the
                 # team centroid, width from its left touchline, in its attacking frame.
                 # The demo's fatigue map and line-up matching use this shape.
                 "role_means": {side: _role_means(formations["{}_half{}".format(track.team_names[t], half)])
                                for t, side in ((0, "H"), (1, "A"))},
                 "attacks_right": {side: bool(sides[(t, half)]) for t, side in ((0, "H"), (1, "A"))}},
        "frames": frames, "seconds": {"frames": secs.tolist(), "movement": cum, "shape": shape},
        "timeline": timeline, "events": events, "stamina": stam_rows, "transitions": tr_rows,
        "momentum": momentum, "entries": entries, "setpieces": setpieces,
        "match_events": events_st, "runs": runs, "team_running": running, "shadow": shadow,
    }


FINAL_THIRD = paths.PITCH[0] * 2 / 3


def momentum_and_entries(lab, ball, sides, half, last):
    """What the bench reads at a glance, for every match minute up to the end of the clip.

    momentum: [half, home possession share, share of live time the ball is in the opponent's
               final third, share in our own final third] -- territory, not just possession.
    entries:  [frame, team, y] each time a team carries the ball into the opponent's final third
              (once per 5 s), y in OUR attacking frame (0 = our left), so the demo can show
              through which channel each side attacks."""
    length, width = paths.PITCH
    momentum, entries = [], []
    for h in (1, 2):
        if h > half:
            break
        a, b = paths.HALVES[h - 1]
        end = b if h < half else last
        right = sides[(0, h)]
        x = ball[a:end + 1, 0] if right else length - ball[a:end + 1, 0]
        y = ball[a:end + 1, 1] if right else width - ball[a:end + 1, 1]
        l = lab[a:end + 1]
        live = np.isin(l, ["H", "A"])
        for s in range(0, len(l), 60 * paths.FPS):
            sl = slice(s, s + 60 * paths.FPS)
            lv = live[sl]
            if lv.sum() == 0:
                momentum.append([h, None, 0.0, 0.0])
                continue
            xs = x[sl][lv]
            momentum.append([h, round(float((l[sl][lv] == "H").mean()), 3),
                             round(float(np.nanmean(xs > FINAL_THIRD)), 3),
                             round(float(np.nanmean(xs < length - FINAL_THIRD)), 3)])
        # final-third entries: ball crosses into the attacking third while that team has it
        for team, inside in (("H", x >= FINAL_THIRD), ("A", x <= length - FINAL_THIRD)):
            has = l == team
            cross = np.where(inside[1:] & ~inside[:-1] & has[1:])[0] + 1
            last_f = -10 ** 9
            for c in cross:
                if c - last_f < 5 * paths.FPS or np.isnan(y[c]):
                    continue
                last_f = c
                entries.append([int(a + c), team, round(float(y[c]), 1)])
    entries.sort()
    return momentum, entries


ST_KINDS = {"Corner Kick": "corner", "Free Kick": "freekick", "Throw-in": "throw", "Goal Kick": "goalkick",
            "Kick Off (Start)": "kickoff", "Kick Off (After Goal)": "kickoff"}


def tag_side(tag, lab):
    """Team of a Smart Tagging instance. Throw-ins come without one: the team that has the ball
    once the dead ball that follows the tag is over (or 2 s after the tag if no dead ball)."""
    if tag["side"] in ("H", "A"):
        return tag["side"]
    f0, n = tag["start"], len(lab)
    seg = lab[f0:min(n, f0 + 30 * paths.FPS)]
    dead = np.where(seg[:15 * paths.FPS] == "D")[0]
    if len(dead):
        live = np.where(np.isin(seg[dead[0]:], ["H", "A"]))[0]
        return str(seg[dead[0] + live[0]]) if len(live) else None
    k = 2 * paths.FPS
    return str(seg[k]) if len(seg) > k and seg[k] in ("H", "A") else None


def set_pieces(tags, lab, ball, source, sides, half, last):
    """Set pieces from Metrica's Smart Tagging (type and team), placed where the ball was seen
    around the restart: [frame, team, kind, x, y (OUR attacking frame), kept the ball 10 s later,
    ball reached the opponent's box within 10 s]. A free kick in the final third is 'freekick_final'."""
    length, width = paths.PITCH
    half_of = paths.half_of_frames()
    out = []
    for tag in tags:
        kind = ST_KINDS.get(tag["type"]) if tag["code"] == "SET PIECES" else None
        f = tag["start"]
        if kind is None or f > last or f >= len(half_of) or half_of[f] == 0:
            continue
        h = int(half_of[f])
        team = tag_side(tag, lab)
        if team is None:
            continue
        t = 0 if team == "H" else 1
        window = np.arange(max(0, f - 50), min(len(ball) - 1, f + 50) + 1)
        seen = window[source[window] == 0]
        fr = seen[np.argmin(np.abs(seen - f))] if len(seen) else f
        x, y = ball[fr]
        if np.isnan(x):
            continue
        right = sides[(t, h)]
        tx, ty = (x, y) if right else (length - x, width - y)
        if kind == "freekick" and tx > FINAL_THIRD:
            kind = "freekick_final"
        end = min(paths.HALVES[h - 1][1], f + 10 * paths.FPS)
        bx = ball[f:end + 1, 0] if right else length - ball[f:end + 1, 0]
        by = ball[f:end + 1, 1] if right else width - ball[f:end + 1, 1]
        in_box = bool(np.any((bx > length - 16.5) & (np.abs(by - width / 2) < 20.16) & (lab[f:end + 1] == team)))
        ox, oy = (x, y) if sides[(0, h)] else (length - x, width - y)
        out.append([int(f), team, kind, round(float(ox), 1), round(float(oy), 1), bool(lab[end] == team), in_box])
    return out


TAG_STATS = ("GOALS", "CREATING CHANCES", "ATTACKING TRANSITION", "BALL IN THE BOX", "LONG BALL", "BUILD UP",
             "PROGRESSION", "BALL IN FINAL THIRD")


def match_events(tags, lab, last):
    """Smart Tagging instances the report counts, up to the end of the clip: [frame, code, team]."""
    half_of = paths.half_of_frames()
    out = []
    for tag in tags:
        f = tag["start"]
        if tag["code"] not in TAG_STATS or f > last or f >= len(half_of) or half_of[f] == 0:
            continue
        team = tag_side(tag, lab)
        if team:
            out.append([int(f), tag["code"], team])
    return sorted(out)


def label_runs(lab, half, last):
    """Possession labels (X filled) as runs [frame, label] per half, up to the end of the clip;
    a run of the next half starts a new list entry, the report finds halves from the frames."""
    out = []
    for h in (1, 2):
        if h > half:
            break
        a, b = paths.HALVES[h - 1]
        seg = lab[a:(b if h < half else last) + 1]
        change = np.concatenate(([0], np.where(seg[1:] != seg[:-1])[0] + 1))
        out.extend([int(a + c), str(seg[c])] for c in change)
        out.append([int((b if h < half else last) + 1), "end"])
    return out


def team_running(movement_df):
    """Team totals per 5-min block: [team, half, minute, km, hsr km, sprints]."""
    g = movement_df[movement_df.label != "GK"].groupby(["team", "half", "minute_from"])
    agg = g.agg(d=("distance_m", "sum"), h=("hsr_m", "sum"), s=("sprints", "sum")).reset_index()
    return [[r.team, int(r.half), int(r.minute_from), round(r.d / 1000, 2), round(r.h / 1000, 2), int(r.s)]
            for r in agg.itertuples()]


MOMENT_LOOKBACK = 10 * paths.FPS     # a final-third entry is traced back this far
MOMENT_PCT = 35                      # ... and kept when denial fell into the defender's lowest 35%
GAP_MIN = 5.0                        # per-mille: shadow rows below this are dropped (the app never draws them)


def _num(v, nd=1):
    return None if v is None or (isinstance(v, float) and np.isnan(v)) else round(float(v), nd)


def shadow_block(players, teams, entries, label_idx, first, last, surface, transitions=None):
    """Shadow Ball's core in the clip: the off-ball model (sb/offball.py) once per second.

    teams    [frame, possession, J_H, J_A, gap_H, gap_A, rest, behind] in per-mille of the dangerous
             space; the team WITHOUT the ball 'denies' its J; rest = rest defence of the team WITH it.
    players  aligned with teams: [slot, team (0/1), label idx, without ball (1/0), gap, Shadow score,
             shadow x, y, x, y, rest gap, cover x, cover y] (raw camera frame), only rows with a gap or
             a rest gap >= GAP_MIN.
    usual    each team's median space denial while defending, from kick-off to the end of the clip;
             usual_rest the same for rest defence while in possession.
    moments  Shadow Replay, up to the end of the clip: [entry frame, low frame, team that suffered,
             value, top 3 movers [label idx, gap, x, y, to x, to y], kind]
             kind 'denial': before a final-third entry, the second in the previous 10 s where the
               defending team denied the least, kept when among its lowest 35% (movers: shadows);
             kind 'rest': a lost ball that ended in a final-third entry within 10 s, when rest defence
               in the second before the loss was below the team's median (movers: cover positions).
               It replaces a 'denial' moment for the same entry: losing the ball came first.
    surface  the learned threat surface (5 m cells, attacking frame) to paint dangerous space."""
    if players is None or teams is None or not len(teams):
        return None
    has_rest = "rest" in teams.columns and "rest_gap" in players.columns
    teams = teams[teams.frame <= last].sort_values("frame")
    players = players[players.frame <= last]
    denial = np.where(teams.possession == "H", teams.J_A, teams.J_H)
    defending = np.where(teams.possession == "H", "A", "H")
    usual, usual_rest, cut = {}, {}, {}
    for team in ("H", "A"):
        d = denial[defending == team]
        usual[team] = round(float(np.median(d)), 1) if len(d) else None
        cut[team] = float(np.percentile(d, MOMENT_PCT)) if len(d) else -1
        r = teams.rest[teams.possession == team].dropna() if has_rest else []
        usual_rest[team] = round(float(np.median(r)), 1) if len(r) else None

    def rows_at(frame, team):
        g = players[players.frame == frame]
        return g[g.team == team]

    def movers(g, col, x, y):
        return [[label_idx.get(r.label, -1), round(float(getattr(r, col)), 1), round(float(r.x), 1), round(float(r.y), 1),
                 round(float(getattr(r, x)), 1), round(float(getattr(r, y)), 1)] for r in g.itertuples()]

    tf, poss = teams.frame.to_numpy(), teams.possession.to_numpy()
    rest_moments = {}
    if has_rest and transitions is not None:
        for r in transitions[transitions.frame <= last].itertuples():
            loser = "A" if r.won_by == "H" else "H"
            entry = next((e for e, team, _ in entries if team == r.won_by and r.frame < e <= r.frame + MOMENT_LOOKBACK), None)
            sel = np.where((tf >= r.frame - 4 * paths.FPS) & (tf <= r.frame - paths.FPS // 2) & (poss == loser))[0]
            if entry is None or entry > last or not len(sel):
                continue
            i = sel[-1]
            value = float(teams.rest.iloc[i])
            if np.isnan(value) or usual_rest[loser] is None or value > usual_rest[loser]:
                continue
            g = rows_at(int(tf[i]), loser)
            g = g[g.phase == "with ball"].dropna(subset=["rest_gap"]).sort_values("rest_gap", ascending=False).head(3)
            rest_moments[int(entry)] = [int(entry), int(tf[i]), loser, round(value, 1),
                                        movers(g, "rest_gap", "cover_x", "cover_y"), "rest"]

    moments = []
    for entry, attacker, _ in entries:
        if entry > last:
            continue
        if entry in rest_moments:
            moments.append(rest_moments[entry])
            continue
        defender = "A" if attacker == "H" else "H"
        sel = (tf >= entry - MOMENT_LOOKBACK) & (tf < entry) & (poss == attacker)
        if sel.sum() < 3:
            continue
        i = np.where(sel)[0][np.argmin(denial[sel])]
        if denial[i] >= cut[defender]:
            continue
        low = int(tf[i])
        g = rows_at(low, defender)
        g = g[g.phase == "without ball"].sort_values("gap", ascending=False).head(3)
        moments.append([int(entry), low, defender, round(float(denial[i]), 1), movers(g, "gap", "shadow_x", "shadow_y"), "denial"])

    clip_t = teams[(teams.frame >= first) & (teams.frame <= last)]
    keep = players.gap >= GAP_MIN
    if has_rest:
        keep |= players.rest_gap.fillna(0) >= GAP_MIN
    clip_p = players[(players.frame >= first) & keep]
    by_frame = {f: g for f, g in clip_p.groupby("frame")}
    rows = []
    for f in clip_t.frame:
        g = by_frame.get(f)
        rows.append([] if g is None else [
            [int(r.slot), 0 if r.team == "H" else 1, label_idx.get(r.label, -1), int(r.phase == "without ball"),
             round(float(r.gap), 1), int(round(r.shadow_score)), round(float(r.shadow_x), 1), round(float(r.shadow_y), 1),
             round(float(r.x), 1), round(float(r.y), 1),
             _num(getattr(r, "rest_gap", None)), _num(getattr(r, "cover_x", None)), _num(getattr(r, "cover_y", None))]
            for r in g.itertuples()])
    return {"teams": [[int(r.frame), r.possession, round(float(r.J_H), 1), round(float(r.J_A), 1),
                       round(float(r.gap_H), 1), round(float(r.gap_A), 1),
                       _num(getattr(r, "rest", None)), None if getattr(r, "behind", None) is None else int(r.behind)]
                      for r in clip_t.itertuples()],
            "players": rows, "usual": usual, "usual_rest": usual_rest, "moments": moments,
            "surface": None if surface is None else np.round(np.asarray(surface), 3).tolist(), "surface_cell": 5.0}


def load_offball(out_dir):
    """The off-ball outputs if `python run.py offball` has been run, else (None, None, None)."""
    p = os.path.join(out_dir, "offball.parquet")
    if not os.path.exists(p):
        return None, None, None
    surface = None
    summary = os.path.join(out_dir, "offball_summary.json")
    if os.path.exists(summary):
        with open(summary) as handle:
            surface = json.load(handle).get("threat_surface")
    return pd.read_parquet(p), pd.read_parquet(os.path.join(out_dir, "offball_team.parquet")), surface


def _role_means(entry):
    roles = entry["roles"]
    if isinstance(roles, dict):
        return {k: [float(v[0]), float(v[1])] for k, v in roles.items()}
    return {r["label"]: [float(r["depth_m"]), float(r["width_m"])] for r in roles}


def save(clip):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "clip.json")
    with open(path, "w") as handle:
        json.dump(clip, handle, separators=(",", ":"))
    return path
