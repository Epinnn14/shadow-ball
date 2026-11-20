"""From a match video to Shadow Ball tracking: players and ball in metres, every 1/25 s.

    python run.py video frame match.mp4 --at 30            # still for calibration -> cache/video-frames/
    (open demo/calibrate.html, load the still, click 4+ pitch landmarks, save calib.json)
    python run.py video track match.mp4 --calib calib.json --name my-match [--camera moving]
    python run.py --game VIDEO-MY-MATCH v4                 # then roles, tactics, offball, demo as usual

Steps per frame (resampled to 25 fps):
  1. detect people and the ball: YOLO (ultralytics, COCO person / sports ball) or, without a GPU
     or model, `blobs`: everything on the pitch that is not grass (works for wide tactical cameras)
  2. image -> pitch: the calibration homography (4+ landmarks clicked once); with --camera moving the
     camera's own pan/zoom is followed by matching background features frame to frame (players masked)
  3. foot point of each person (bottom centre of the box) -> metres; a pitch-space tracker
     (Hungarian, 3 m gate, 1 s memory) links them into tracks
  4. team per track from the shirt colour (k-means over tracks); the two big clusters are the teams,
     the rest (referees, keepers) are dropped except a keeper near a goal, given to the team defending it
  5. tracks -> fixed slots per team (tracks that never overlap share a slot), speed from positions

Writes cache/video-<name>/tactical_atd.npz in the same format as the competition cache, plus
meta.json, so the whole pipeline (possession, off-ball, demo) runs on it unchanged.
The competition match video may not be used here: it is licensed for the competition only.
"""

import json
import os
import time

import numpy as np

from . import paths

FPS = paths.FPS

# Pitch landmarks (metres; x along the length from the left goal line, y across from the top touchline)
def landmarks(L=105.0, W=68.0):
    c, box, six, pen = W / 2, 20.16, 9.16, 11.0
    pts = {
        "corner top-left": (0, 0), "corner bottom-left": (0, W), "corner top-right": (L, 0), "corner bottom-right": (L, W),
        "halfway top": (L / 2, 0), "halfway bottom": (L / 2, W), "centre spot": (L / 2, c),
        "centre circle top": (L / 2, c - 9.15), "centre circle bottom": (L / 2, c + 9.15),
    }
    for side, x0, s in (("left", 0, 1), ("right", L, -1)):
        pts.update({
            "{} box top goal-line".format(side): (x0, c - box), "{} box bottom goal-line".format(side): (x0, c + box),
            "{} box top corner".format(side): (x0 + s * 16.5, c - box), "{} box bottom corner".format(side): (x0 + s * 16.5, c + box),
            "{} six top goal-line".format(side): (x0, c - six), "{} six bottom goal-line".format(side): (x0, c + six),
            "{} six top corner".format(side): (x0 + s * 5.5, c - six), "{} six bottom corner".format(side): (x0 + s * 5.5, c + six),
            "{} penalty spot".format(side): (x0 + s * pen, c),
            "{} box arc centre".format(side): (x0 + s * (pen + 9.15), c),
        })
    return pts


def homography_from_calib(calib, pitch):
    """Image -> pitch homography from clicked landmarks ({"points": [{"name", "px": [u, v]}]})."""
    import cv2
    lm = landmarks(*pitch)
    src, dst = [], []
    for p in calib["points"]:
        if p["name"] not in lm:
            raise SystemExit("Unknown landmark {!r}; use the names in demo/calibrate.html".format(p["name"]))
        src.append(p["px"]); dst.append(lm[p["name"]])
    if len(src) < 4:
        raise SystemExit("Need at least 4 landmarks, got {}".format(len(src)))
    H, _ = cv2.findHomography(np.array(src, np.float64), np.array(dst, np.float64), cv2.RANSAC if len(src) > 4 else 0, 1.5)
    if H is None:
        raise SystemExit("The landmarks do not give a homography: check that no three are on one line")
    return H


def to_pitch(H, pts):
    pts = np.asarray(pts, np.float64).reshape(-1, 2)
    if not len(pts):
        return pts
    q = np.c_[pts, np.ones(len(pts))] @ H.T
    return q[:, :2] / q[:, 2:3]


def frames(path, start_s=0.0, max_s=None, fps_out=FPS):
    """(k, frame) at fps_out from a video file: the nearest source frame to each output time."""
    import cv2
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise SystemExit("Cannot open video {}".format(path))
    src_fps = cap.get(cv2.CAP_PROP_FPS) or fps_out
    cap.set(cv2.CAP_PROP_POS_MSEC, start_s * 1000)
    i_src, k, img = int(round(start_s * src_fps)), 0, None
    while True:
        t = start_s + k / fps_out
        if max_s is not None and t >= start_s + max_s:
            break
        want = int(round(t * src_fps))
        while i_src <= want:
            ok, img = cap.read()
            if not ok:
                cap.release()
                return
            i_src += 1
        yield k, img
        k += 1
    cap.release()


# ---------------------------------------------------------------- detection

class YoloDetector:
    """People and the ball with an ultralytics YOLO model (COCO classes 0 person, 32 sports ball)."""

    def __init__(self, model="yolo11n.pt", conf=0.25, imgsz=1280, device=None):
        from ultralytics import YOLO
        self.model, self.conf, self.imgsz, self.device = YOLO(model), conf, imgsz, device

    def __call__(self, img, pitch_mask=None):
        r = self.model.predict(img, conf=self.conf, imgsz=self.imgsz, classes=[0, 32], verbose=False, device=self.device)[0]
        boxes = r.boxes.xyxy.cpu().numpy() if len(r.boxes) else np.zeros((0, 4))
        cls = r.boxes.cls.cpu().numpy().astype(int) if len(r.boxes) else np.zeros(0, int)
        conf = r.boxes.conf.cpu().numpy() if len(r.boxes) else np.zeros(0)
        people = boxes[cls == 0]
        balls = boxes[cls == 32]
        order = np.argsort(-conf[cls == 32])[:3]
        balls = [((b[0] + b[2]) / 2, (b[1] + b[3]) / 2) for b in balls[order]]
        if pitch_mask is not None and len(people):           # keep people standing on the pitch
            h, w = pitch_mask.shape
            u = np.clip(((people[:, 0] + people[:, 2]) / 2).astype(int), 0, w - 1)
            v = np.clip(people[:, 3].astype(int), 0, h - 1)
            people = people[pitch_mask[v, u] > 0]
        return people, balls


class BlobDetector:
    """No model: everything inside the pitch that is not grass, sized like a person. Works for wide,
    fairly high cameras (tactical feeds); broadcast close-ups need YOLO."""

    def __init__(self, min_h=6, max_h=140):
        self.min_h, self.max_h = min_h, max_h

    def __call__(self, img, pitch_mask=None):
        import cv2
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        grass = cv2.inRange(hsv, (30, 40, 30), (90, 255, 255))
        lines = cv2.inRange(hsv, (0, 0, 175), (180, 45, 255))          # white lines and the ball
        fg = cv2.bitwise_and(cv2.bitwise_not(grass), cv2.bitwise_not(lines))
        if pitch_mask is not None:
            fg = cv2.bitwise_and(fg, pitch_mask)
        fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
        fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((5, 3), np.uint8))
        n, lab, st, _ = cv2.connectedComponentsWithStats(fg)
        people = []
        for i in range(1, n):
            x, y, w, h, area = st[i]
            if self.min_h <= h <= self.max_h and 0.15 <= w / max(h, 1) <= 1.4 and area >= 0.25 * w * h:
                people.append((x, y, x + w, y + h))
        # ball: a small, round, bright blob
        wb = lines if pitch_mask is None else cv2.bitwise_and(lines, pitch_mask)
        n2, _, st2, cen2 = cv2.connectedComponentsWithStats(wb)
        balls = []
        for i in range(1, n2):
            x, y, w, h, area = st2[i]
            if 2 <= w <= 14 and 2 <= h <= 14 and 0.6 <= w / max(h, 1) <= 1.6 and area >= 0.55 * w * h:
                balls.append(tuple(cen2[i]))
        return np.array(people, float).reshape(-1, 4), balls


# ---------------------------------------------------------------- camera motion

class CameraFollower:
    """Image -> pitch homography for every frame. static: the calibration one. moving: follows the
    camera by matching background features (people masked) to a keyframe. Matching to a keyframe
    rather than to the previous frame stops small errors from adding up every frame; a new keyframe
    is taken when too few features still match."""

    def __init__(self, H_ref, moving, min_inliers=80):
        import cv2
        self.H, self.moving, self.key = H_ref.copy(), moving, None      # key = (kp, des, H_key->pitch)
        self.orb = cv2.ORB_create(2500) if moving else None
        self.bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True) if moving else None
        self.min_inliers, self.lost, self.keyframes = min_inliers, 0, 0

    def update(self, img, boxes):
        import cv2
        if not self.moving:
            return self.H
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        mask = np.full(gray.shape, 255, np.uint8)
        for x0, y0, x1, y1 in boxes.astype(int):
            mask[max(0, y0 - 6):y1 + 6, max(0, x0 - 6):x1 + 6] = 0
        kp, des = self.orb.detectAndCompute(gray, mask)
        if self.key is None:
            self.key = (kp, des, self.H.copy()); self.keyframes = 1
            return self.H
        ok = False
        if des is not None and self.key[1] is not None and len(kp) > 20:
            m = self.bf.match(self.key[1], des)
            if len(m) >= 12:
                a = np.float32([self.key[0][x.queryIdx].pt for x in m])
                b = np.float32([kp[x.trainIdx].pt for x in m])
                Hm, inl = cv2.findHomography(b, a, cv2.RANSAC, 1.5)     # current -> keyframe image
                if Hm is not None and inl is not None and inl.sum() >= 12:
                    self.H = self.key[2] @ Hm
                    self.H /= self.H[2, 2]
                    ok = True
                    if inl.sum() < self.min_inliers:                       # overlap is shrinking: new keyframe
                        self.key = (kp, des, self.H.copy()); self.keyframes += 1
        if not ok:
            self.lost += 1
        return self.H

    def pitch_mask(self, shape, pitch):
        """Image mask of the pitch (plus 3 m) for the current homography."""
        import cv2
        L, W = pitch
        Hinv = np.linalg.inv(self.H)
        poly = np.array([[-3, -3], [L + 3, -3], [L + 3, W + 3], [-3, W + 3]], np.float64)
        q = np.c_[poly, np.ones(4)] @ Hinv.T
        if np.any(q[:, 2] <= 0):            # part of the pitch is behind the camera: no clipping
            return None
        img_poly = (q[:, :2] / q[:, 2:3]).astype(np.int32)
        m = np.zeros(shape[:2], np.uint8)
        cv2.fillPoly(m, [img_poly], 255)
        return m


# ---------------------------------------------------------------- tracking in pitch space

def line_distance(p, L=105.0, W=68.0):
    """Distance (m) from a pitch point to the nearest painted line: bright blobs on a line are line
    fragments far more often than the ball."""
    x, y = p
    c = W / 2
    segs = [((0, 0), (L, 0)), ((0, W), (L, W)), ((0, 0), (0, W)), ((L, 0), (L, W)), ((L / 2, 0), (L / 2, W))]
    for x0, s in ((0, 1), (L, -1)):
        for d, half in ((16.5, 20.16), (5.5, 9.16)):
            a, b = (x0, c - half), (x0 + s * d, c - half)
            segs += [(a, b), ((x0 + s * d, c - half), (x0 + s * d, c + half)), ((x0, c + half), (x0 + s * d, c + half))]
    best = min(_seg_dist(x, y, a, b) for a, b in segs)
    best = min(best, abs(np.hypot(x - L / 2, y - c) - 9.15))
    for sx in (11.0, L - 11.0):
        r = np.hypot(x - sx, y - c)
        if (sx < L / 2 and x > 16.5) or (sx > L / 2 and x < L - 16.5):
            best = min(best, abs(r - 9.15))
    return best


def _seg_dist(x, y, a, b):
    ax, ay = a; bx, by = b
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return np.hypot(x - ax - t * dx, y - ay - t * dy)


class StillMarks:
    """Bright small blobs that stay at the same pitch spot (painted marks, line crossings, a cone)
    are not the ball: a decaying count per 1 m cell; a cell seen in most frames for ~1 s is blocked."""

    def __init__(self, pitch, decay=0.97, limit=18.0):
        self.occ = np.zeros((int(pitch[0]) + 3, int(pitch[1]) + 3), np.float32)
        self.decay, self.limit = decay, limit

    def blocked(self, cands_m):
        self.occ *= self.decay
        out = []
        for p in cands_m:
            i, j = int(np.clip(p[0] + 1, 0, self.occ.shape[0] - 1)), int(np.clip(p[1] + 1, 0, self.occ.shape[1] - 1))
            out.append(self.occ[max(0, i - 1):i + 2, max(0, j - 1):j + 2].max() > self.limit)
            self.occ[i, j] += 1
        return out


def pick_ball(cands_m, cands_px, last, gap, pitch, players, blocked=None):
    """The ball among the candidates: never a painted spot (centre / penalty spots), on the pitch,
    the nearest to where it was (a ball moves at most ~1.4 m per frame), else the one nearest a
    player. Returns (position in metres or NaN, image point or None)."""
    L, W = pitch
    spots = np.array([[L / 2, W / 2], [11.0, W / 2], [L - 11.0, W / 2]])
    best, best_score = None, None
    for j, p in enumerate(cands_m):
        if not (-1 <= p[0] <= L + 1 and -1 <= p[1] <= W + 1) or (blocked is not None and blocked[j]):
            continue
        if line_distance(p, L, W) < 0.7:
            continue
        if np.min(np.linalg.norm(spots - p, axis=1)) < 1.2:
            continue
        if last is not None and gap <= FPS:
            d = np.linalg.norm(p - last)
            if d > 1.4 * gap + 2:
                continue
            score = d
        else:
            score = 50 + (np.min(np.linalg.norm(players - p, axis=1)) if len(players) else 0)
        if best_score is None or score < best_score:
            best, best_score = j, score
    if best is None:
        return np.array([np.nan, np.nan]), None
    return cands_m[best], cands_px[best]


class PitchTracker:
    """Links detections (metres) into tracks: Hungarian on predicted positions, 3 m gate, tracks
    kept 1 s without a detection."""

    def __init__(self, gate=3.0, max_gap=FPS):
        self.gate, self.max_gap = gate, max_gap
        self.active = {}            # id -> {pos, vel, last}
        self.next_id = 0

    def step(self, k, pts):
        from scipy.optimize import linear_sum_assignment
        ids = list(self.active)
        pred = np.array([self.active[i]["pos"] + self.active[i]["vel"] * (k - self.active[i]["last"]) for i in ids]).reshape(-1, 2)
        out = [None] * len(pts)
        if len(ids) and len(pts):
            cost = np.linalg.norm(pred[:, None, :] - pts[None, :, :], axis=2)
            r, c = linear_sum_assignment(cost)
            for a, b in zip(r, c):
                if cost[a, b] <= self.gate:
                    t = self.active[ids[a]]
                    dt = max(1, k - t["last"])
                    t["vel"] = 0.6 * t["vel"] + 0.4 * (pts[b] - t["pos"]) / dt
                    t["pos"], t["last"] = pts[b].copy(), k
                    out[b] = ids[a]
        for b in range(len(pts)):
            if out[b] is None:
                self.active[self.next_id] = {"pos": pts[b].copy(), "vel": np.zeros(2), "last": k}
                out[b] = self.next_id
                self.next_id += 1
        for i in [i for i, t in self.active.items() if k - t["last"] > self.max_gap]:
            del self.active[i]
        return out


def shirt_colour(img, box):
    """Mean Lab colour of the shirt (upper body, grass and very dark/bright pixels removed)."""
    import cv2
    x0, y0, x1, y1 = [int(v) for v in box]
    h = y1 - y0
    crop = img[max(0, y0 + int(0.15 * h)):max(0, y0 + int(0.5 * h)), max(0, x0):max(0, x1)]
    if crop.size == 0:
        return None
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV).reshape(-1, 3)
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(np.float32)
    keep = ~((hsv[:, 0] >= 30) & (hsv[:, 0] <= 90) & (hsv[:, 1] >= 40))
    if keep.sum() < 3:
        return None
    return np.median(lab[keep], axis=0)


def assign_teams(colours, positions, pitch, min_len=FPS):
    """Track id -> 0 (team defending the left goal), 1 (right) or -1 (other). colours: id -> list of
    Lab colours; positions: id -> list of (x, y)."""
    import cv2
    ids = [i for i in colours if len(colours[i]) >= min(min_len, 5)]
    if len(ids) < 4:
        return {i: -1 for i in colours}
    feats = np.array([np.median(np.array(colours[i]), axis=0) for i in ids], np.float32)
    weight = np.array([len(colours[i]) for i in ids], float)
    k = 3 if len(ids) >= 6 else 2
    _, lab, cen = cv2.kmeans(feats, k, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 100, 0.2), 8, cv2.KMEANS_PP_CENTERS)
    lab = lab.ravel()
    mass = np.array([weight[lab == c].sum() for c in range(k)])
    teams = list(np.argsort(-mass)[:2])
    mean_x = {c: np.average([np.mean(np.array(positions[ids[j]])[:, 0]) for j in np.where(lab == c)[0]],
                            weights=weight[lab == c]) for c in teams}
    left, right = sorted(teams, key=lambda c: mean_x[c])
    out = {}
    L = pitch[0]
    for j, i in enumerate(ids):
        c = lab[j]
        if c == left:
            out[i] = 0
        elif c == right:
            out[i] = 1
        else:                               # referee or keeper: a keeper stays near one goal
            x = np.array(positions[i])[:, 0]
            if np.mean(x < 20) > 0.8:
                out[i] = 0
            elif np.mean(x > L - 20) > 0.8:
                out[i] = 1
            else:
                out[i] = -1
    for i in colours:
        out.setdefault(i, -1)
    return out


def slots_for(tracks, cap=16):
    """Track id -> slot within its team: tracks that never overlap in time share a slot (interval
    colouring, longest first). tracks: id -> (first, last, length)."""
    order = sorted(tracks, key=lambda i: -tracks[i][2])
    slot_busy = []                 # per slot: list of (first, last)
    out = {}
    for i in order:
        f, l, _ = tracks[i]
        for s, busy in enumerate(slot_busy):
            if all(l < a or f > b for a, b in busy):
                busy.append((f, l)); out[i] = s
                break
        else:
            if len(slot_busy) < cap:
                slot_busy.append([(f, l)]); out[i] = len(slot_busy) - 1
    return out


def track_video(path, calib, name, detector="yolo", camera="static", start_s=0.0, max_s=None, pitch=(105.0, 68.0),
                home="left", team_names=("Home", "Away"), second_half_s=None, model="yolo11n.pt", preview=None, log=print):
    """Run the whole video pipeline and write cache/video-<name>/. Returns the meta dict."""
    import cv2
    from .external import _speed
    H0 = homography_from_calib(calib, pitch)
    det = YoloDetector(model) if detector == "yolo" else BlobDetector()
    cam = CameraFollower(H0, camera == "moving")
    trk = PitchTracker()
    rows, balls, colours, positions = [], [], {}, {}
    writer, t0, k = None, time.time(), -1
    last_ball, last_ball_k = None, -10 ** 9
    marks = StillMarks(pitch)
    for k, img in frames(path, start_s, max_s):
        H = cam.update(img, np.zeros((0, 4)) if not rows else rows[-1][2])
        mask = cam.pitch_mask(img.shape, pitch)
        boxes, cands = det(img, mask)
        foot = np.c_[(boxes[:, 0] + boxes[:, 2]) / 2, boxes[:, 3]] if len(boxes) else np.zeros((0, 2))
        pts = to_pitch(H, foot)
        keep = (pts[:, 0] > -5) & (pts[:, 0] < pitch[0] + 5) & (pts[:, 1] > -5) & (pts[:, 1] < pitch[1] + 5) if len(pts) else np.zeros(0, bool)
        boxes, pts = boxes[keep], pts[keep]
        ids = trk.step(k, pts)
        for i, b, p in zip(ids, boxes, pts):
            c = shirt_colour(img, b)
            if c is not None:
                colours.setdefault(i, []).append(c)
            positions.setdefault(i, []).append(p)
        cm = to_pitch(H, cands) if cands else np.zeros((0, 2))
        bp, ball = pick_ball(cm, cands, last_ball, k - last_ball_k, pitch, pts, marks.blocked(cm))
        if not np.isnan(bp[0]):
            last_ball, last_ball_k = bp, k
        rows.append((k, list(zip(ids, pts)), boxes))
        balls.append(bp)
        if preview is not None:
            writer = _preview(writer, preview, img, boxes, ids, ball, H, pitch)
        if k % 250 == 0:
            log("  {:>6} frames ({:.0f} s of video) {:.1f} fps, {} tracks".format(k, k / FPS, (k + 1) / max(1e-6, time.time() - t0), trk.next_id))
    if writer is not None:
        writer.release()
    n = k + 1
    if n <= 0:
        raise SystemExit("No frames read from {}".format(path))
    team_of = assign_teams(colours, positions, pitch)
    if home == "right":
        team_of = {i: (1 - t if t in (0, 1) else t) for i, t in team_of.items()}
    span = {}
    for k_, dets, _ in rows:
        for i, _p in dets:
            if team_of.get(i, -1) < 0:
                continue
            f, l, c = span.get(i, (k_, k_, 0))
            span[i] = (min(f, k_), max(l, k_), c + 1)
    slot_of, teams = {}, []
    for t in (0, 1):
        s = slots_for({i: v for i, v in span.items() if team_of[i] == t})
        base = len(teams)
        teams += [t] * (max(s.values()) + 1 if s else 0)
        slot_of.update({i: base + v for i, v in s.items()})
    S = len(teams)
    xy = np.full((n, S, 2), np.nan, np.float32)
    for k_, dets, _ in rows:
        for i, p in dets:
            if i in slot_of:
                xy[k_, slot_of[i]] = p
    xy[:, :, 0] = np.clip(xy[:, :, 0], 0, pitch[0]); xy[:, :, 1] = np.clip(xy[:, :, 1], 0, pitch[1])
    ball = np.array(balls, np.float32)
    ball[(ball[:, 0] < -2) | (ball[:, 0] > pitch[0] + 2) | (ball[:, 1] < -2) | (ball[:, 1] > pitch[1] + 2)] = np.nan
    speed = _speed(xy)
    scale = np.array(pitch, np.float32)
    players = np.concatenate([xy / scale, speed[..., None]], axis=-1).astype(np.float32)
    game = "video-" + _slug(name)
    out_dir = os.path.join(paths.REPO, "cache", game)
    os.makedirs(out_dir, exist_ok=True)
    np.savez(os.path.join(out_dir, "tactical_atd.npz"), frame_id=np.arange(1, n + 1, dtype=np.int64), players=players,
             ball=ball / scale, teams=np.array(teams, np.int8), team_names=np.array(team_names))
    if second_half_s is not None:
        cut = int(round((second_half_s - start_s) * FPS))
        halves = [[0, cut - 1], [cut, n - 1]]
    else:                                    # no halves given: two equal parts (see paths.H2)
        cut = n // 2
        halves = [[0, cut - 1], [cut, n - 1]]
    meta = {"n_frames": n, "pitch": list(pitch), "halves": halves, "file": os.path.basename(path), "start_s": start_s,
            "detector": detector, "camera": camera, "slots": S, "tracks": int(trk.next_id), "camera_lost_frames": int(cam.lost), "keyframes": int(cam.keyframes),
            "ball_seen": float(np.mean(~np.isnan(ball[:, 0]))),
            "h2_minute": 45 if second_half_s is not None else round(halves[1][0] / FPS / 60, 3), "split": second_half_s is None, "created": time.strftime("%Y-%m-%d %H:%M")}
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=1)
    meta["game"] = game.upper()
    return meta


def _slug(s):
    return "".join(ch.lower() if ch.isalnum() else "-" for ch in s).strip("-") or "match"


def _preview(writer, path, img, boxes, ids, ball, H, pitch):
    """Optional check video: boxes with track ids and a mini-map of the pitch positions."""
    import cv2
    if writer is None:
        h, w = img.shape[:2]
        writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (w, h))
    out = img.copy()
    pts = to_pitch(H, np.c_[(boxes[:, 0] + boxes[:, 2]) / 2, boxes[:, 3]]) if len(boxes) else np.zeros((0, 2))
    for i, b in zip(ids, boxes):
        cv2.rectangle(out, (int(b[0]), int(b[1])), (int(b[2]), int(b[3])), (60, 220, 255), 1)
        cv2.putText(out, str(i), (int(b[0]), int(b[1]) - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (60, 220, 255), 1)
    mw, mh = 210, int(210 * pitch[1] / pitch[0])
    x0, y0 = out.shape[1] - mw - 10, out.shape[0] - mh - 10
    cv2.rectangle(out, (x0, y0), (x0 + mw, y0 + mh), (40, 110, 40), -1)
    cv2.rectangle(out, (x0, y0), (x0 + mw, y0 + mh), (255, 255, 255), 1)
    for p in pts:
        cv2.circle(out, (int(x0 + p[0] / pitch[0] * mw), int(y0 + p[1] / pitch[1] * mh)), 3, (60, 220, 255), -1)
    if ball is not None:
        bp = to_pitch(H, [ball])[0]
        cv2.circle(out, (int(x0 + bp[0] / pitch[0] * mw), int(y0 + bp[1] / pitch[1] * mh)), 3, (255, 255, 255), -1)
    writer.write(out)
    return writer


def save_frame(path, at_s, out_dir):
    """Save one still (JPEG) for calibration and return its path."""
    import cv2
    for _k, img in frames(path, at_s, 1.0 / FPS):
        os.makedirs(out_dir, exist_ok=True)
        out = os.path.join(out_dir, "{}_{:.0f}s.jpg".format(os.path.splitext(os.path.basename(path))[0], at_s))
        cv2.imwrite(out, img)
        return out, img.shape
    raise SystemExit("No frame at {} s".format(at_s))
