"""Can the broadcast tracking fill the tactical ball gaps? (feasibility probe, 2026-10-29)

The broadcast recording is not synchronised to the tactical one and comes with no mapping table,
but both ATD files are in pitch coordinates, so the same moment has the same player positions.
Each broadcast frame (every 5th) is matched to the tactical frame within +-12 frames of a per-half
offset whose players are closest (mean distance from each broadcast player to the nearest tactical
player, "chamfer"); replays, close-ups and cuts do not match and are dropped (> 1.5 m).

    python scripts/broadcast_probe.py
"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sb import atd, paths  # noqa: E402

OFFSETS = (4015, 26919)          # tactical - broadcast frame, half 1 / half 2 (found by a coarse search)


def main():
    teams = atd.slot_teams(paths.asset("atd_meta", "broadcast"))
    _, players, ball = atd.parse_raw(paths.asset("atd_raw", "broadcast"), n_slots=len(teams))
    scale = np.array(paths.PITCH)
    bp, bb = players[:, :, :2] * scale, ball * scale
    track = atd.Tracking()
    tp, tball, n = track.xy, track.ball, len(track)
    ks, ts, cs = [], [], []
    for k in range(0, len(bp), 5):
        b = bp[k][~np.isnan(bp[k][:, 0])]
        if len(b) < 6:
            continue
        guess = k + (OFFSETS[0] if k + OFFSETS[0] < paths.HALVES[0][1] + 2000 else OFFSETS[1])
        cand = np.arange(guess - 12, guess + 13)
        cand = cand[(cand >= 0) & (cand < n)]
        if not len(cand):
            continue
        d = np.sqrt(((tp[cand][:, None] - b[None, :, None]) ** 2).sum(-1))
        d = np.where(np.isnan(d), 1e3, d).min(2).mean(1)
        i = int(np.argmin(d))
        ks.append(k), ts.append(cand[i]), cs.append(d[i])
    ks, ts, cs = map(np.array, (ks, ts, cs))
    ok = cs < 1.5
    ks, ts = ks[ok], ts[ok]
    print("broadcast frames matched to a tactical frame: {:.1%}".format(ok.mean()))
    bseen, tseen = ~np.isnan(bb[ks, 0]), ~np.isnan(tball[ts, 0])
    both = bseen & tseen
    dist = np.hypot(*(bb[ks[both]] - tball[ts[both]]).T)
    print("ball seen by both: median distance {:.2f} m, 90th percentile {:.2f} m".format(
        np.median(dist), np.percentile(dist, 90)))
    graded = paths.graded_mask()[ts]
    missing = (~track.ball_seen[paths.graded_mask()]).sum() / 5
    print("missing graded tactical ball frames the broadcast could fill: {:.1%}".format(
        (bseen & ~tseen & graded).sum() / missing))


if __name__ == "__main__":
    main()
