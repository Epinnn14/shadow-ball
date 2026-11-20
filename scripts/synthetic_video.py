"""A synthetic match video with known truth, to test the video pipeline (sb/video.py).

    python scripts/synthetic_video.py --game 2 --start 600 --seconds 60 --camera moving --out cache/synth/moving.mp4
    python run.py video track cache/synth/moving.mp4 --calib cache/synth/moving_calib.json --name synth-moving --detector blobs --camera moving
    python scripts/video_eval.py --truth cache/synth/moving_truth.npz --game VIDEO-SYNTH-MOVING

It renders open Metrica tracking (the true positions) through a virtual camera on a 3-D pitch:
grass texture, lines, players as simple shaded figures in kit colours, a referee who is NOT in the
truth, and the ball. Writes the video, the truth (positions per frame, teams) and a calibration file
made from the true camera at the first frame (as if the landmarks had been clicked).
"""

import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("SB_GAME", "METRICA-2")
from sb import external, video  # noqa: E402

PX_PER_M = 8


def camera(cx, cam, L, W, size):
    """K, R, C for a camera behind the bottom touchline looking at (cx, W/2)."""
    wimg, himg = size
    if cam == "static":
        C = np.array([L / 2, W + 48.0, 40.0]); T = np.array([L / 2, W / 2 - 2, 0.0]); f = 0.62 * wimg
    else:
        C = np.array([cx, W + 30.0, 22.0]); T = np.array([cx, W / 2 - 4, 0.0]); f = 1.05 * wimg
    fw = (T - C) / np.linalg.norm(T - C)
    up = np.array([0, 0, 1.0])
    r = np.cross(up, fw); r /= np.linalg.norm(r)
    d = np.cross(r, fw); d /= np.linalg.norm(d)
    if d[2] > 0:
        d = -d
    R = np.stack([r, d, fw])
    K = np.array([[f, 0, wimg / 2], [0, f, himg / 2], [0, 0, 1.0]])
    return K, R, C


def project(K, R, C, X):
    X = np.atleast_2d(X)
    q = (K @ (R @ (X - C).T)).T
    return q[:, :2] / q[:, 2:3], q[:, 2]


def pitch_texture(L, W, margin=8):
    import cv2
    w, h = int((L + 2 * margin) * PX_PER_M), int((W + 2 * margin) * PX_PER_M)
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = (52, 112, 58)
    for k in range(16):                               # mowing stripes
        x0 = int((margin + k * L / 16) * PX_PER_M); x1 = int((margin + (k + 1) * L / 16) * PX_PER_M)
        img[:, x0:x1] = (48, 122, 60) if k % 2 else (44, 108, 52)
    rng = np.random.default_rng(3)
    img = np.clip(img.astype(int) + rng.integers(-9, 10, img.shape[:2])[..., None], 0, 255).astype(np.uint8)
    P = lambda x, y: (int((x + margin) * PX_PER_M), int((y + margin) * PX_PER_M))
    white, t = (235, 235, 235), 2
    cv2.rectangle(img, P(0, 0), P(L, W), white, t)
    cv2.line(img, P(L / 2, 0), P(L / 2, W), white, t)
    cv2.circle(img, P(L / 2, W / 2), int(9.15 * PX_PER_M), white, t)
    cv2.circle(img, P(L / 2, W / 2), 3, white, -1)
    for x0, s in ((0, 1), (L, -1)):
        c = W / 2
        cv2.rectangle(img, P(x0, c - 20.16), P(x0 + s * 16.5, c + 20.16), white, t)
        cv2.rectangle(img, P(x0, c - 9.16), P(x0 + s * 5.5, c + 9.16), white, t)
        cv2.circle(img, P(x0 + s * 11, c), 3, white, -1)
    return img, margin


def main():
    import cv2
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", type=int, default=2)
    ap.add_argument("--start", type=float, default=600, help="second of the open game to start at")
    ap.add_argument("--seconds", type=float, default=60)
    ap.add_argument("--camera", choices=["static", "moving"], default="moving")
    ap.add_argument("--size", default="1280x720")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    wimg, himg = (int(v) for v in args.size.split("x"))
    track = external.load_game(args.game)
    L, W = 105.0, 68.0
    f0, n = int(args.start * 25), int(args.seconds * 25)
    xy, ball, teams = track.xy[f0:f0 + n], track.ball[f0:f0 + n], track.teams
    # keepers: per team, the player whose mean x is most extreme
    mx = np.nanmean(xy[:, :, 0], axis=0)
    gk = set()
    for t in (0, 1):
        sl = np.where((teams == t) & ~np.isnan(mx))[0]
        side_left = np.nanmean(mx[sl]) < L / 2
        gk.add(int(sl[np.argmin(mx[sl])] if side_left else sl[np.argmax(mx[sl])]))
    kit = {0: ((40, 40, 200), (30, 30, 30)), 1: ((205, 120, 30), (240, 240, 240))}   # BGR shirt, shorts
    gk_kit = {0: ((30, 200, 230), (30, 30, 30)), 1: ((60, 60, 60), (60, 60, 60))}
    ref_kit = ((20, 20, 20), (20, 20, 20))
    tex, margin = pitch_texture(L, W)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    vw = cv2.VideoWriter(args.out, cv2.VideoWriter_fourcc(*"mp4v"), 25, (wimg, himg))
    rng = np.random.default_rng(0)
    cx, ref = L / 2, np.array([L / 2, W / 2])
    truth_xy = np.full((n, xy.shape[1], 2), np.nan, np.float32)
    truth_ball = np.full((n, 2), np.nan, np.float32)
    calib = None
    for k in range(n):
        b = ball[k]
        if not np.isnan(b[0]):
            cx = 0.96 * cx + 0.04 * np.clip(b[0], 28, L - 28)
            ref = 0.95 * ref + 0.05 * (b + np.array([-6.0, 7.0]))
        K, R, C = camera(cx, args.camera, L, W, (wimg, himg))
        # pitch texture -> image
        src = np.array([[0, 0], [tex.shape[1], 0], [tex.shape[1], tex.shape[0]], [0, tex.shape[0]]], np.float32)
        corners_m = np.array([[-margin, -margin, 0], [L + margin, -margin, 0], [L + margin, W + margin, 0], [-margin, W + margin, 0]])
        dst, _ = project(K, R, C, corners_m)
        Hm = cv2.getPerspectiveTransform(src, dst.astype(np.float32))
        frame = np.zeros((himg, wimg, 3), np.uint8); frame[:] = (70, 74, 78)       # stands
        cv2.warpPerspective(tex, Hm, (wimg, himg), dst=frame, borderMode=cv2.BORDER_TRANSPARENT)
        if k == 0:                                     # calibration from the true camera, as if clicked
            lm = video.landmarks(L, W)
            pts = []
            for name, (x, y) in lm.items():
                p, z = project(K, R, C, [x, y, 0])
                if z[0] > 0 and 0 <= p[0, 0] < wimg and 0 <= p[0, 1] < himg:
                    pts.append({"name": name, "px": [round(float(p[0, 0]), 1), round(float(p[0, 1]), 1)]})
            calib = {"image_size": [wimg, himg], "at_s": 0.0, "pitch": [L, W], "points": pts}
        # people, far to near
        people = [(s, xy[k, s]) for s in range(xy.shape[1]) if not np.isnan(xy[k, s, 0])]
        people.append((-1, ref))
        people.sort(key=lambda t: t[1][1])
        for s, (x, y) in people:
            foot, z = project(K, R, C, [x, y, 0]); head, _ = project(K, R, C, [x, y, 1.8])
            if z[0] <= 0:
                continue
            u, v = foot[0]; hu, hv = head[0]; hgt = v - hv
            if not (-20 < u < wimg + 20 and -20 < v < himg + 40):
                continue
            if s >= 0:
                truth_xy[k, s] = (x, y)
            shirt, shorts = ref_kit if s < 0 else (gk_kit if s in gk else kit)[int(teams[s])] if s >= 0 else ref_kit
            wdt = max(2, 0.28 * hgt)
            cv2.ellipse(frame, (int(u + 0.2 * wdt), int(v)), (int(wdt * 0.9), max(1, int(wdt * 0.25))), 0, 0, 360, (30, 70, 34), -1)
            leg_top = v - 0.45 * hgt
            cv2.rectangle(frame, (int(u - wdt * 0.35), int(leg_top)), (int(u + wdt * 0.35), int(v)), (40, 34, 30), -1)      # legs
            cv2.rectangle(frame, (int(u - wdt / 2), int(v - 0.55 * hgt)), (int(u + wdt / 2), int(leg_top)), shorts, -1)
            cv2.rectangle(frame, (int(u - wdt / 2), int(v - 0.85 * hgt)), (int(u + wdt / 2), int(v - 0.55 * hgt)), shirt, -1)
            cv2.circle(frame, (int(u), int(v - 0.92 * hgt)), max(1, int(wdt * 0.32)), (120, 160, 205), -1)
        if not np.isnan(b[0]):
            p, z = project(K, R, C, [b[0], b[1], 0.11])
            if z[0] > 0:
                rad = max(2, int(0.22 * K[0, 0] / z[0] * 1.6))
                cv2.circle(frame, (int(p[0, 0]), int(p[0, 1])), rad, (245, 245, 245), -1)
                truth_ball[k] = b
        frame = cv2.GaussianBlur(frame, (3, 3), 0)
        frame = np.clip(frame.astype(np.int16) + rng.integers(-4, 5, frame.shape[:2])[..., None], 0, 255).astype(np.uint8)
        vw.write(frame)
    vw.release()
    base = os.path.splitext(args.out)[0]
    np.savez(base + "_truth.npz", xy=truth_xy, ball=truth_ball, teams=teams, gk=np.array(sorted(gk)))
    with open(base + "_calib.json", "w") as handle:
        json.dump(calib, handle, indent=1)
    print("video -> {} ({} frames), truth + calibration ({} landmarks) next to it".format(args.out, n, len(calib["points"])))


if __name__ == "__main__":
    main()
