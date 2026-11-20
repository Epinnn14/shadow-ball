"""The half-time screen and the chemistry card (the ideas saved for Phase 2, built after it).

  possession_threat  possession share and threat per minute for both teams, plus team heatmaps
  passing_network    real passes from event data (open games only: the competition has none)
  halftime_plan      first-half grades and 3 attacking + 3 defending suggestions, each with the
                     number behind it. Transparent rules over the validated metrics, no LLM
  chemistry          how well neighbouring players in the formation work together, per pair

Everything is computed from what is known at a given frame, like the rest of the demo. "Us" is
the home team (H), as in the app. All outputs are plain lists/dicts for clip.json.
"""

import numpy as np
import pandas as pd

from . import paths

FPS = paths.FPS
L, W = paths.PITCH
HEAT_BINS = (21, 14)
LANES = ("left", "middle", "right")


def lane_of(y):
    return 0 if y < W / 3 else (1 if y < 2 * W / 3 else 2)


# ---------------------------------------------------------------- possession & threat

def possession_threat(track, lab, ball, sides, surface, upto, cell=5.0):
    """Per match minute [half, minute, home share of live time, threat H, threat A]. Threat is the
    sum, over the seconds a team had the ball, of the learned P(ball in the box within 10 s) at the
    ball's location, divided by 10 (each entry is seen from ~10 seconds): roughly the box entries
    expected from where the team had the ball in that minute. Also possession per half and
    per-team heatmaps (players in their own attacking frame, 21 x 14 bins, shares)."""
    surf = np.asarray(surface, dtype=float) if surface is not None else None
    minutes, poss = [], {}
    heat = {"H": np.zeros(HEAT_BINS), "A": np.zeros(HEAT_BINS)}
    for h, (a, b) in enumerate(paths.HALVES, 1):
        if a > upto:
            break
        end = min(b, upto)
        l = lab[a:end + 1]
        live = np.isin(l, ["H", "A"])
        poss[h] = round(float((l[live] == "H").mean()), 3) if live.any() else None
        for m0 in range(0, len(l), 60 * FPS):
            sl = slice(m0, min(m0 + 60 * FPS, len(l)))
            lv = live[sl]
            row = [h, int(m0 // (60 * FPS)) + (0 if h == 1 else paths.H2),
                   round(float((l[sl][lv] == "H").mean()), 3) if lv.any() else None]
            for team, t in (("H", 0), ("A", 1)):
                total = 0.0
                if surf is not None:
                    right = sides[(t, h)]
                    idx = np.arange(a + sl.start, a + sl.stop, FPS)
                    idx = idx[(lab[idx] == team) & ~np.isnan(ball[idx, 0])]
                    if len(idx):
                        bx = ball[idx, 0] if right else L - ball[idx, 0]
                        by = ball[idx, 1] if right else W - ball[idx, 1]
                        cx = np.clip((bx // cell).astype(int), 0, surf.shape[0] - 1)
                        cy = np.clip((by // cell).astype(int), 0, surf.shape[1] - 1)
                        # P(box within 10 s) summed once per second over-counts each entry ~10x
                        total = float(surf[cx, cy].sum()) / 10
                row.append(round(total, 2))
            minutes.append(row)
        for team, t in (("H", 0), ("A", 1)):
            if h != 1:
                continue                                   # heatmaps: the first half (half-time screen)
            right = sides[(t, h)]
            slots = np.where(track.teams == t)[0]
            xy = track.xy[a:end + 1:FPS][:, slots].reshape(-1, 2)
            xy = xy[~np.isnan(xy[:, 0])]
            if not len(xy):
                continue
            x = xy[:, 0] if right else L - xy[:, 0]
            y = xy[:, 1] if right else W - xy[:, 1]
            hist, _, _ = np.histogram2d(x, y, bins=HEAT_BINS, range=[[0, L], [0, W]])
            heat[team] += hist
    heat = {k: (np.round(v / max(v.max(), 1), 3)).tolist() for k, v in heat.items()}
    return {"minutes": minutes, "possession": poss, "heat": heat}


# ---------------------------------------------------------------- passing network

def _shirt(name):
    if not isinstance(name, str):
        return None
    digits = "".join(ch for ch in name if ch.isdigit())
    return int(digits) if digits else None


def passing_network(ev, sides, upto, half=None, min_link=2):
    """Per team: passes, success rate, pass types and the network (nodes = mean pass position per
    player in the team's attacking frame, edges = passes between two players, both directions).
    `ev` = the event table (open games); None when there is no event data."""
    if ev is None or ev.empty:
        return None
    ev = ev[ev.start <= upto]
    if half is not None:
        ev = ev[ev.period == half]
    out = {}
    for team, t in (("H", 0), ("A", 1)):
        e = ev[ev.side == team]
        passes = e[e.type == "PASS"].copy()
        lost = e[(e.type == "BALL LOST")]
        if passes.empty:
            out[team] = None
            continue
        right = np.array([sides[(t, int(p))] for p in passes.period])
        x0 = np.where(right, passes.x0, L - passes.x0)
        y0 = np.where(right, passes.y0, W - passes.y0)
        x1 = np.where(right, passes.x1, L - passes.x1)
        y1 = np.where(right, passes.y1, W - passes.y1)
        dx, dy = x1 - x0, y1 - y0
        length = np.hypot(dx, dy)
        key = 0
        for i in passes.index:                             # a pass whose team shoots within 5 s
            later = ev[(ev.start > ev.loc[i, "end"]) & (ev.start <= ev.loc[i, "end"] + 5 * FPS)]
            if len(later) and later.iloc[0].type == "SHOT" and later.iloc[0].side == team:
                key += 1
        passes["x"], passes["y"] = x0, y0
        passes["fr"], passes["to_"] = passes["from"].map(_shirt), passes["to"].map(_shirt)
        nodes = passes.groupby("fr").agg(x=("x", "mean"), y=("y", "mean"), n=("x", "size")).reset_index()
        pair = passes.dropna(subset=["fr", "to_"]).copy()
        pair["a"] = pair[["fr", "to_"]].min(axis=1)
        pair["b"] = pair[["fr", "to_"]].max(axis=1)
        links = pair.groupby(["a", "b"]).size().reset_index(name="n")
        links = links[links.n >= min_link]
        out[team] = {
            "passes": int(len(passes)), "lost": int(len(lost)),
            "success": round(float(len(passes) / max(1, len(passes) + len(lost))), 3),
            "types": {"forward": int(np.sum(dx > 10)), "long": int(np.sum(length > 30)),
                      "into_final_third": int(np.sum((x0 < 2 * L / 3) & (x1 >= 2 * L / 3))),
                      "switch": int(np.sum(np.abs(dy) > 25)), "key": key},
            "nodes": [[int(r.fr), round(float(r.x), 1), round(float(r.y), 1), int(r.n)] for r in nodes.itertuples()],
            "links": [[int(r.a), int(r.b), int(r.n)] for r in links.itertuples()],
        }
    return out


# ---------------------------------------------------------------- half-time plan

def _rate(s):
    return float(s.mean()) if len(s) else float("nan")


def halftime_plan(team_df, press_df, trans_df, entries, leak_df, poss, threat_minutes):
    """First-half grades (us vs them) and suggestions for the second half.

    team_df   offball_team.parquet (1 Hz: possession, J_H, J_A, rest)
    press_df  pressing.parquet (1 Hz defending seconds: zone, press, regain, box)
    trans_df  transitions.parquet; entries [frame, team, y (our frame)]; leak_df offball_leak
    Returns {"grades": [...], "attack": [...], "defend": [...]} with numbers behind every line."""
    h1 = team_df[team_df.half == 1]
    grades = []

    def grade(name, us, them, fmt, higher_better=True, note=""):
        if us is None or them is None or np.isnan(us) or np.isnan(them):
            return
        better = (us > them) if higher_better else (us < them)
        grades.append({"name": name, "us": fmt.format(us), "them": fmt.format(them), "better": bool(better),
                       "note": note})

    # space denied: the defending team's share of the dangerous space (per mille -> %)
    den_h = _rate(h1[h1.possession == "A"].J_H) / 10
    den_a = _rate(h1[h1.possession == "H"].J_A) / 10
    grade("Space denied", den_h, den_a, "{:.0f}%", note="share of the dangerous space held without the ball")
    rest_h = _rate(h1[h1.possession == "H"].rest) / 10
    rest_a = _rate(h1[h1.possession == "A"].rest) / 10
    grade("Rest defence", rest_h, rest_a, "{:.0f}%", note="protection if the ball were lost now")
    grade("Possession", (poss or {}).get(1, np.nan) * 100 if poss and poss.get(1) is not None else np.nan,
          (1 - poss[1]) * 100 if poss and poss.get(1) is not None else np.nan, "{:.0f}%")
    thr = [m for m in threat_minutes if m[0] == 1]
    grade("Threat created", sum(m[3] for m in thr), sum(m[4] for m in thr), "{:.1f}",
          note="expected box entries from where each side had the ball")
    p1 = press_df[press_df.half == 1]
    for team, other in (("H", "A"),):
        rp = _rate(p1[(p1.defending == team) & p1.press].regain) * 100
        ro = _rate(p1[(p1.defending == other) & p1.press].regain) * 100
        grade("Pressing wins it back", rp, ro, "{:.0f}%", note="ball won within 5 s of a press")
    t1 = trans_df[trans_df.half == 1]
    cp_h = _rate(t1[t1.won_by == "A"].regained_5s) * 100       # we lost it: did we win it back?
    cp_a = _rate(t1[t1.won_by == "H"].regained_5s) * 100
    grade("Counter-press", cp_h, cp_a, "{:.0f}%", note="won back within 5 s after losing it")
    e1 = [e for e in entries if e[0] <= paths.HALVES[0][1]]
    grade("Final-third entries", float(sum(e[1] == "H" for e in e1)), float(sum(e[1] == "A" for e in e1)), "{:.0f}")

    attack, defend = [], []
    # 1. where they attack us / where we attack: lanes of final-third entries
    ours = [lane_of(e[2]) for e in e1 if e[1] == "H"]
    theirs = [lane_of(e[2]) for e in e1 if e[1] == "A"]
    if theirs:
        lane = int(np.bincount(theirs, minlength=3).argmax())
        n = int(np.bincount(theirs, minlength=3)[lane])
        if n / len(theirs) >= 0.4:
            defend.append({"score": n / len(theirs), "title": "Close our {} side".format(LANES[lane]),
                           "evidence": "{} of their {} final-third entries came down our {}".format(n, len(theirs), LANES[lane])})
    # 2. pressing zones (ours when defending, theirs when we attack)
    for team, bucket, who in (("H", defend, "our"), ("A", attack, "their")):
        p = p1[p1.defending == team].copy()
        if p.empty:
            continue
        p["band"] = np.digitize(p.x, (L / 3, L / 2, 2 * L / 3))
        best = None
        for band, g in p.groupby("band"):
            pr, ho = g[g.press], g[~g.press]
            if len(pr) < 15 or len(ho) < 15:
                continue
            diff = pr.regain.mean() - ho.regain.mean()
            leak = pr.box.mean() - ho.box.mean()
            # bands are in the defenders' frame; name them from our side
            name = (("our third", "our half", "their half", "their third") if team == "H"
                    else ("their third", "their half", "our half", "our third"))[band]
            if team == "H":
                if diff > 0.05 and (best is None or diff > best[0]):
                    best = (diff, "Keep pressing in {}".format(name),
                            "pressing there won it back {:.0f}% vs {:.0f}% holding".format(100 * pr.regain.mean(), 100 * ho.regain.mean()))
                elif leak > 0.04 and (best is None or leak > best[0]):
                    best = (leak, "Hold, don't press, in {}".format(name),
                            "pressing there let them reach our box {:.0f}% vs {:.0f}%".format(100 * pr.box.mean(), 100 * ho.box.mean()))
            else:
                if leak > 0.04 and (best is None or leak > best[0]):
                    best = (leak, "Play through their press",
                            "when they press in {} we reach their box {:.0f}% vs {:.0f}%".format(
                                name, 100 * pr.box.mean(), 100 * ho.box.mean()))
        if best:
            bucket.append({"score": best[0] * 3, "title": best[1], "evidence": best[2]})
    # 3. space leaks: their weakest defender = our target; our weakest = cover him
    if leak_df is not None and not leak_df.empty:
        lk = leak_df[(leak_df.half == 1) & (leak_df.block >= 15)]
        for team, bucket in (("A", attack), ("H", defend)):
            g = lk[lk.team == team].groupby("label").agg(gap=("gap", "mean"), base=("base_gap", "mean")).dropna()
            g = g[g.index != "GK"]
            if g.empty:
                continue
            g["growth"] = g.gap - g.base
            worst = g.growth.idxmax()
            if g.loc[worst, "growth"] > 4:
                if team == "A":
                    bucket.append({"score": g.loc[worst, "growth"] / 20, "title": "Attack their {}".format(worst),
                                   "evidence": "their {} leaves {:.0f}‰ more dangerous space than in his first 15 min".format(worst, g.loc[worst, "growth"])})
                else:
                    bucket.append({"score": g.loc[worst, "growth"] / 20, "title": "Help our {}".format(worst),
                                   "evidence": "he leaves {:.0f}‰ more dangerous space than in his first 15 min".format(g.loc[worst, "growth"])})
    # 4. transitions: counter where they are thin, protect where we are
    won_h = t1[t1.won_by == "H"]
    if len(won_h) >= 5:
        share = float(won_h.reached_final_third.mean())
        attack.append({"score": share, "title": "Go fast when we win it",
                       "evidence": "{:.0f}% of our {} regains reached their final third within 10 s".format(100 * share, len(won_h))})
    if not np.isnan(rest_h) and not np.isnan(rest_a) and rest_h < rest_a - 3:
        defend.append({"score": (rest_a - rest_h) / 10, "title": "Keep more players behind the ball",
                       "evidence": "our rest defence {:.0f}% vs their {:.0f}%".format(rest_h, rest_a)})
    if ours:
        counts = np.bincount(ours, minlength=3)
        lane = int(counts.argmax())
        attack.append({"score": counts[lane] / max(1, len(ours)) * 0.8, "title": "Keep using the {}".format(LANES[lane]),
                       "evidence": "{} of our {} final-third entries came down the {}".format(counts[lane], len(ours), LANES[lane])})
    # denial trend inside the half: last 15 min vs the rest
    if len(h1):
        late = h1[(h1.possession == "A") & (h1.frame >= paths.HALVES[0][1] - 15 * 60 * FPS)].J_H
        early = h1[(h1.possession == "A") & (h1.frame < paths.HALVES[0][1] - 15 * 60 * FPS)].J_H
        if len(late) > 60 and len(early) > 60 and early.mean() - late.mean() > 15:
            defend.append({"score": (early.mean() - late.mean()) / 100, "title": "Tighten up again",
                           "evidence": "space denied fell from {:.0f}% to {:.0f}% in the last 15 min".format(early.mean() / 10, late.mean() / 10)})
    attack.sort(key=lambda s: -s["score"])
    defend.sort(key=lambda s: -s["score"])
    strip = lambda rows: [{k: v for k, v in r.items() if k != "score"} for r in rows[:3]]
    return {"grades": grades, "attack": strip(attack), "defend": strip(defend)}


# ---------------------------------------------------------------- chemistry

def neighbours(role_means):
    """Adjacent pairs of a formation from each role's mean depth and width: neighbours in the
    same line (sorted by width), and each player's nearest team-mate in the next line."""
    roles = {k: v for k, v in role_means.items() if k != "GK"}
    if len(roles) < 4:
        return []
    depth = np.array([v[0] for v in roles.values()])
    names = list(roles)
    order = np.argsort(depth)
    lines, cur = [], [names[order[0]]]
    for i in order[1:]:
        if roles[names[i]][0] - roles[cur[-1]][0] > 5.0:
            lines.append(cur)
            cur = []
        cur.append(names[i])
    lines.append(cur)
    pairs = set()
    for line in lines:
        line = sorted(line, key=lambda r: roles[r][1])
        pairs.update(tuple(sorted(p)) for p in zip(line, line[1:]))
    for back, front in zip(lines, lines[1:]):
        for r in back:
            near = min(front, key=lambda f: abs(roles[f][1] - roles[r][1]))
            pairs.add(tuple(sorted((r, near))))
    return sorted(pairs)


def chemistry(track, role_df, sides, role_means, half, first, last, ev=None, step=FPS):
    """Per team: [role a, role b, chemistry %, distance %, together %, cover %, passes] for every
    adjacent pair, and the team mean. Over the half up to `last`, one sample per second.

      distance  share of seconds the pair is within 0.6-1.4x its own typical distance
      together  how much they move together: correlation of their 1-s steps along the pitch, 0-100
      cover     when one steps 8 m+ beyond his usual depth in the team's shape, share of times the
                other holds his own depth (does not go too)
      passes    passes between them (event data only; shown, not scored)

    Our own indicator, not validated against outcomes: use it to start a conversation."""
    a, _b = paths.HALVES[half - 1]
    sel = role_df[(role_df.half == half) & (role_df.frame >= a) & (role_df.frame <= last) & (role_df.frame % step == 0)]
    out = {}
    for team, t in (("H", 0), ("A", 1)):
        pairs = neighbours(role_means.get(team, {}))
        if not pairs:
            out[team] = None
            continue
        right = sides[(t, half)]
        g = sel[sel.team == team]
        wide = g.pivot_table(index="frame", columns="label", values="slot", aggfunc="first")
        frames = wide.index.to_numpy()
        pos = {}
        for label in wide.columns:
            slots = wide[label].to_numpy()
            ok = ~np.isnan(slots)
            xy = np.full((len(frames), 2), np.nan)
            xy[ok] = track.xy[frames[ok], slots[ok].astype(int)]
            if not right:
                xy = np.column_stack([L - xy[:, 0], W - xy[:, 1]])
            pos[label] = xy
        centre = np.nanmean(np.stack([v[:, 0] for v in pos.values()]), axis=0)
        shirts_of = {}
        if ev is not None and paths.OPEN_DATA:
            from . import external
            shirts = external.slot_jerseys(int(paths.GAME[-1]))
            for label in wide.columns:
                s = wide[label].dropna()
                if len(s):
                    shirts_of[label] = shirts[int(s.mode().iloc[0])]
        rows = []
        for ra, rb in pairs:
            if ra not in pos or rb not in pos:
                continue
            pa, pb = pos[ra], pos[rb]
            d = np.hypot(*(pa - pb).T)
            ok = ~np.isnan(d)
            if ok.sum() < 60:
                continue
            med = np.nanmedian(d)
            dist = float(np.mean((d[ok] > 0.6 * med) & (d[ok] < 1.4 * med)))
            va, vb = np.diff(pa[:, 0]), np.diff(pb[:, 0])
            m = ~np.isnan(va) & ~np.isnan(vb)
            r = float(np.corrcoef(va[m], vb[m])[0, 1]) if m.sum() > 30 else 0.0
            together = (max(r, -1.0) + 1) / 2
            covers, held = 0, 0
            for p_go, p_stay in ((pa, pb), (pb, pa)):
                rg, rs = p_go[:, 0] - centre, p_stay[:, 0] - centre          # depth vs the team's centre
                go = rg - np.nanmedian(rg) > 8
                valid = go & ~np.isnan(rs)
                covers += int(valid.sum())
                held += int((valid & (rs - np.nanmedian(rs) < 3)).sum())   # the partner did not go too
            cover = held / covers if covers else 0.5
            n_pass = 0
            if ev is not None and ra in shirts_of and rb in shirts_of:
                e = ev[(ev.type == "PASS") & (ev.side == team) & (ev.period == half) & (ev.start <= last)]
                fr, to = e["from"].map(_shirt), e["to"].map(_shirt)
                n_pass = int((((fr == shirts_of[ra]) & (to == shirts_of[rb])) | ((fr == shirts_of[rb]) & (to == shirts_of[ra]))).sum())
            chem = 100 * (dist + together + cover) / 3
            rows.append([ra, rb, round(chem), round(100 * dist), round(100 * together), round(100 * cover), n_pass])
        out[team] = {"pairs": rows, "team": round(float(np.mean([r[2] for r in rows]))) if rows else None}
    return out
