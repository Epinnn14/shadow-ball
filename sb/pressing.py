"""Pressing Trap Map: where pressing wins the ball back, and where it opens the way to our box.

    python run.py offball         # also writes exports/pressing.parquet + pressing_summary.json

Once per second of play, for the team WITHOUT the ball (the defenders):
  press     2+ of its outfield players within PRESS_RADIUS of the ball (the carrier is under pressure
            from more than one man; ~30% of defending seconds)
  regain    the defenders have the ball within 5 s (a dead ball in between does not count)
  box       the attackers carry the ball into the defenders' penalty box within 10 s
Zones are in the DEFENDERS' attacking frame (x = 0 their own goal): 4 bands (own third, own half,
their half, their third) x 3 lanes.

The comparison is press vs no press in the same zone. It is NOT a causal effect: a team presses
when the ball is close, and the ball is close in duels. It is what happened after pressing here,
next to what happened when the team held its shape here, in this match.
"""

import json
import os

import numpy as np
import pandas as pd

from . import paths
from .offball import to_frame

FPS = paths.FPS
L, W = paths.PITCH
PRESS_RADIUS = 8.0
PRESSERS = 2
REGAIN_WINDOW = 5 * FPS
BOX_WINDOW = 10 * FPS
BANDS = (L / 3, L / 2, 2 * L / 3)
BAND_NAMES = ("own third", "own half", "their half", "their third")
LANE_NAMES = ("left", "middle", "right")
SHRINK = 20          # samples: a zone's difference is shrunk by n / (n + SHRINK) before it is drawn


def band_of(x):
    return int(np.searchsorted(BANDS, x, side="right"))


def lane_of(y):
    return 0 if y < W / 3 else (1 if y < 2 * W / 3 else 2)


def in_box(xy_att):
    """Ball inside the penalty box the attackers attack (attackers' frame)."""
    return (xy_att[..., 0] > L - 16.5) & (np.abs(xy_att[..., 1] - W / 2) < 20.16)


def seconds(track, lab, ball, valid, gk_mask, sides, step=FPS):
    """One row per second of play: [frame, half, defending team, ball x, y (defenders' frame),
    pressers, nearest defender (m), press, regain within 5 s, attackers in our box within 10 s].
    `valid` = role-assigned slots (frames x slots), `gk_mask` = the goalkeepers' slots."""
    rows = []
    for h, (a, b) in enumerate(paths.HALVES, 1):
        b = min(b, len(lab) - 1)
        if a > b:
            continue
        for t in range(a, b + 1, step):
            att = lab[t]
            if att not in ("H", "A") or np.isnan(ball[t, 0]):
                continue
            d = "A" if att == "H" else "H"
            dt, at = (0, 1) if d == "H" else (1, 0)
            slots = np.where(valid[t] & ~gk_mask[t] & (track.teams == dt))[0]
            pos = track.xy[t, slots]
            pos = pos[~np.isnan(pos[:, 0])]
            if len(pos) < 8:
                continue
            dist = np.hypot(*(pos - ball[t]).T)
            bx, by = to_frame(ball[t][None], sides[(dt, h)])[0]
            end = min(b, t + REGAIN_WINDOW)
            fut = lab[t + 1:end + 1]
            live = fut[np.isin(fut, ["H", "A"])]
            regain = bool(len(live) and (live == d).any())
            end = min(b, t + BOX_WINDOW)
            xy = to_frame(ball[t:end + 1], sides[(at, h)])
            box = bool(np.any(in_box(xy) & (lab[t:end + 1] == att)))
            pressers = int((dist < PRESS_RADIUS).sum())
            rows.append((t, h, d, float(bx), float(by), pressers, float(dist.min()), pressers >= PRESSERS, regain, box))
    return pd.DataFrame(rows, columns=["frame", "half", "defending", "x", "y", "pressers", "nearest", "press", "regain", "box"])


def zone_table(df, by=("defending",)):
    """Per team and zone: seconds pressed / not pressed, regain and box rates of each."""
    d = df.assign(band=[band_of(x) for x in df.x], lane=[lane_of(y) for y in df.y])
    out = []
    for key, g in d.groupby(list(by) + ["band", "lane"]):
        p, q = g[g.press], g[~g.press]
        row = dict(zip(list(by) + ["band", "lane"], key if isinstance(key, tuple) else (key,)))
        row.update({"zone": "{} {}".format(BAND_NAMES[row["band"]], LANE_NAMES[row["lane"]]),
                    "n_press": int(len(p)), "n_hold": int(len(q)),
                    "regain_press": float(p.regain.mean()) if len(p) else None,
                    "regain_hold": float(q.regain.mean()) if len(q) else None,
                    "box_press": float(p.box.mean()) if len(p) else None,
                    "box_hold": float(q.box.mean()) if len(q) else None})
        out.append(row)
    return pd.DataFrame(out)


def band_table(df):
    """The same by band only (all lanes), per team: the headline numbers."""
    d = df.assign(band=[BAND_NAMES[band_of(x)] for x in df.x])
    g = d.groupby(["defending", "band", "press"]).agg(seconds=("regain", "size"), regain=("regain", "mean"), box=("box", "mean"))
    return g.round(3).reset_index()


def save(df, zones, bands):
    out = paths.EXPORTS_DIR
    os.makedirs(out, exist_ok=True)
    df.to_parquet(os.path.join(out, "pressing.parquet"), index=False)
    with open(os.path.join(out, "pressing_summary.json"), "w") as handle:
        json.dump({"definition": "press = {}+ outfield defenders within {} m of the ball; regain within {} s; "
                                 "attackers in our box within {} s".format(PRESSERS, PRESS_RADIUS, REGAIN_WINDOW // FPS, BOX_WINDOW // FPS),
                   "share_pressing": round(float(df.press.mean()), 3),
                   "by_band": bands.to_dict("records"), "by_zone": zones.round(3).to_dict("records")}, handle, indent=1)
    return out
