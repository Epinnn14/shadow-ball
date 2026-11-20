"""Compare the video pipeline's tracking with the truth of a synthetic video.

    python scripts/video_eval.py --truth cache/synth/moving_truth.npz --game VIDEO-SYNTH-MOVING

Per frame, detected players are matched to the true (visible) players with the Hungarian method.
Reports: recall (true players found within 2 m), precision (detections that are a real player within
2 m: the referee and false blobs count against it), median position error, team accuracy (the
detected slot's team vs the true team, after fixing which colour is "home"), and ball error.
"""

import argparse
import json
import os

import numpy as np
from scipy.optimize import linear_sum_assignment

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--truth", required=True)
    ap.add_argument("--game", required=True)
    args = ap.parse_args()
    t = np.load(args.truth)
    sub = os.path.join(REPO, "cache", args.game.lower())
    z = np.load(os.path.join(sub, "tactical_atd.npz"))
    with open(os.path.join(sub, "meta.json")) as handle:
        meta = json.load(handle)
    pitch = np.array(meta["pitch"], np.float32)
    det = z["players"][:, :, :2] * pitch
    dteam = z["teams"]
    txy, tteam = t["xy"], t["teams"]
    n = min(len(det), len(txy))
    errs, found, total, real, ndet, agree = [], 0, 0, 0, 0, []
    for k in range(n):
        ts = np.where(~np.isnan(txy[k, :, 0]))[0]
        ds = np.where(~np.isnan(det[k, :, 0]))[0]
        total += len(ts); ndet += len(ds)
        if not len(ts) or not len(ds):
            continue
        cost = np.linalg.norm(txy[k, ts][:, None] - det[k, ds][None], axis=2)
        r, c = linear_sum_assignment(cost)
        ok = cost[r, c] <= 2.0
        found += ok.sum(); real += ok.sum()
        errs += list(cost[r, c][ok])
        agree += [int(tteam[ts[a]] == dteam[ds[b]]) for a, b in zip(r[ok], c[ok])]
    team_acc = np.mean(agree) if agree else float("nan")
    team_acc = max(team_acc, 1 - team_acc)          # which colour is "home" is a convention
    tb, db = t["ball"][:n], z["ball"][:n] * pitch
    both = ~np.isnan(tb[:, 0]) & ~np.isnan(db[:, 0])
    berr = np.linalg.norm(tb[both] - db[both], axis=1)
    out = {
        "frames": int(n), "recall_2m": round(found / max(1, total), 3), "precision_2m": round(real / max(1, ndet), 3),
        "median_error_m": round(float(np.median(errs)), 2) if errs else None, "p90_error_m": round(float(np.percentile(errs, 90)), 2) if errs else None,
        "team_accuracy": round(float(team_acc), 3), "slots": int(len(dteam)), "tracks": meta.get("tracks"),
        "ball_seen_truth": round(float(np.mean(~np.isnan(tb[:, 0]))), 3), "ball_seen_detected": round(float(np.mean(~np.isnan(db[:, 0]))), 3),
        "ball_median_error_m": round(float(np.median(berr)), 2) if len(berr) else None,
        "camera_lost_frames": meta.get("camera_lost_frames"),
    }
    print(json.dumps(out, indent=1))
    return out


if __name__ == "__main__":
    main()
