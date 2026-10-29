"""v2 building block: reconstruct the ball when the tracker loses it, from the 22 players.

Self-supervised: every frame where the ball IS seen is a free training example. We pretend the
ball is missing around it (a synthetic gap drawn from the real gap lengths), give the model only
what it would have in a real gap -- the players, and where the ball was last/next seen and how
long ago -- and ask for the true position. The model also predicts its own uncertainty.

    python run.py ball-train            # trains on both halves, reports cross-half validation
    python run.py ball-predict          # fills every unseen frame -> cache/ball_reconstructed.npz

Model: a small transformer over the player set (order-free, so track-slot swaps do not matter)
plus one context token for the last/next seen ball. ~100k parameters: fits a 4 GB GPU easily
and also trains on CPU.
"""

import os
import time

import numpy as np

from . import paths

MAX_CONTEXT_S = 20.0          # beyond this, last/next seen ball is treated as unknown
VEL_HALF = 5                  # velocity from +/- 5 frames (0.2 s)
N_PLAYER_FEATS = 6            # x, y, vx, vy, speed, team
N_CONTEXT_FEATS = 8           # last (x, y, dt, flag), next (x, y, dt, flag)


# ---------------------------------------------------------------------------------------------
# features (numpy)
# ---------------------------------------------------------------------------------------------

def player_tensor(track):
    """float32 (T, S, 6) per-slot features, normalised; NaN where the slot is empty."""
    length, width = paths.PITCH
    xy = track.xy
    prev = np.concatenate([np.repeat(xy[:1], VEL_HALF, 0), xy[:-VEL_HALF]])
    nxt = np.concatenate([xy[VEL_HALF:], np.repeat(xy[-1:], VEL_HALF, 0)])
    vel = (nxt - prev) / (2 * VEL_HALF / paths.FPS)              # m/s
    vel = np.where(np.isnan(vel), 0.0, vel)
    team = np.broadcast_to(np.where(track.teams == 0, 1.0, -1.0), xy.shape[:2])
    feats = np.stack([
        xy[..., 0] / length, xy[..., 1] / width,
        vel[..., 0] / 10.0, vel[..., 1] / 10.0,
        track.speed / 10.0, team,
    ], axis=-1).astype(np.float32)
    feats[np.isnan(xy[..., 0])] = np.nan
    return feats


def seen_neighbours(seen):
    """For each frame: index of the last seen frame strictly before it and the next strictly
    after it (-1 if none)."""
    n = len(seen)
    idx = np.arange(n)
    last = np.where(seen, idx, -1)
    last = np.maximum.accumulate(last)
    last_before = np.concatenate(([-1], last[:-1]))
    nxt = np.where(seen, idx, n)
    nxt = np.minimum.accumulate(nxt[::-1])[::-1]
    next_after = np.concatenate((nxt[1:], [n]))
    next_after[next_after >= n] = -1
    return last_before, next_after


def context_features(ball, target, last_idx, next_idx):
    """float32 (B, 8): last/next seen ball, normalised, with time gaps and availability flags."""
    length, width = paths.PITCH
    out = np.zeros((len(target), N_CONTEXT_FEATS), dtype=np.float32)
    for k, (ref, sign) in enumerate(((last_idx, -1), (next_idx, 1))):
        dt = np.abs(target - ref) / paths.FPS
        ok = (ref >= 0) & (dt <= MAX_CONTEXT_S)
        safe = np.where(ok, ref, 0)
        out[:, 4 * k + 0] = np.where(ok, ball[safe, 0] / length, 0)
        out[:, 4 * k + 1] = np.where(ok, ball[safe, 1] / width, 0)
        out[:, 4 * k + 2] = np.where(ok, dt / MAX_CONTEXT_S, 1.0)
        out[:, 4 * k + 3] = ok.astype(np.float32)
    return out


class Sampler:
    """Draws training batches: a seen frame + a synthetic gap around it."""

    def __init__(self, track, frames, gap_lengths, seed=0):
        self.players = player_tensor(track)
        self.ball = track.ball
        self.seen = track.ball_seen
        self.last_before, self.next_after = seen_neighbours(self.seen)
        self.frames = frames                       # candidate target frames (ball seen)
        self.gaps = np.asarray(gap_lengths)
        self.rng = np.random.default_rng(seed)

    def batch(self, size, augment=False):
        rng = self.rng
        t = rng.choice(self.frames, size)
        gap = rng.choice(self.gaps, size)
        a = (rng.random(size) * gap).astype(int)               # frames hidden before t
        b = gap - a - 1                                         # frames hidden after t
        lo = np.clip(t - a - 1, 0, len(self.seen) - 1)
        hi = np.clip(t + b + 1, 0, len(self.seen) - 1)
        last = np.where(self.seen[lo], lo, self.last_before[lo])
        nxt = np.where(self.seen[hi], hi, self.next_after[hi])
        ctx = context_features(self.ball, t, last, nxt)
        target = self.ball[t] / np.array(paths.PITCH, dtype=np.float32)
        self.last_gap = gap
        self.last_t = t
        players = self.players[t]
        if augment:
            players, ctx, target = augment_batch(rng, players, ctx, target)
        return players, ctx, target


def augment_batch(rng, players, ctx, target):
    """Symmetries of football that leave "where is the ball" unchanged in meaning: mirror the
    pitch along its length and/or width, and swap which team is which. Without these the model
    memorises the ~47k near-duplicate frames of one half instead of learning the pattern."""
    players, ctx, target = players.copy(), ctx.copy(), target.copy()
    n = len(target)
    for axis, vel, ctx_cols in ((0, 2, (0, 4)), (1, 3, (1, 5))):
        flip = rng.random(n) < 0.5
        players[flip, :, axis] = 1.0 - players[flip, :, axis]
        players[flip, :, vel] = -players[flip, :, vel]
        target[flip, axis] = 1.0 - target[flip, axis]
        for col, flag in zip(ctx_cols, (3, 7)):
            known = flip & (ctx[:, flag] > 0)
            ctx[known, col] = 1.0 - ctx[known, col]
    swap = rng.random(n) < 0.5
    players[swap, :, 5] = -players[swap, :, 5]
    return players, ctx, target


def real_gap_lengths(track):
    """Lengths (frames) of the real unseen-ball gaps in graded play: the training distribution."""
    seen = track.ball_seen
    graded = paths.graded_mask()
    runs, count = [], 0
    for s, g in zip(seen, graded):
        if not s and g:
            count += 1
        elif count:
            runs.append(count)
            count = 0
    runs = np.array(runs)
    # mix in short gaps too, so the model is also good right next to a seen ball
    return np.concatenate([runs, np.arange(1, 50)])


# ---------------------------------------------------------------------------------------------
# model (torch)
# ---------------------------------------------------------------------------------------------

def build_model(d=64, heads=4, layers=2):
    import torch
    from torch import nn

    class BallNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.player_in = nn.Sequential(nn.Linear(N_PLAYER_FEATS, d), nn.GELU(), nn.Linear(d, d))
            self.ctx_in = nn.Sequential(nn.Linear(N_CONTEXT_FEATS, d), nn.GELU(), nn.Linear(d, d))
            layer = nn.TransformerEncoderLayer(d, heads, dim_feedforward=2 * d, dropout=0.1,
                                               batch_first=True)
            self.encoder = nn.TransformerEncoder(layer, layers)
            self.head = nn.Sequential(nn.Linear(d, d), nn.GELU(), nn.Linear(d, 3))

        def forward(self, players, ctx):
            empty = torch.isnan(players[..., 0])                    # (B, S)
            players = torch.nan_to_num(players)
            tokens = torch.cat([self.ctx_in(ctx)[:, None], self.player_in(players)], dim=1)
            pad = torch.cat([torch.zeros_like(empty[:, :1]), empty], dim=1)
            h = self.encoder(tokens, src_key_padding_mask=pad)
            out = self.head(h[:, 0])
            # residual on a simple prior: interpolation if both ends are known, else the known end,
            # else the pitch centre. The network only learns the correction from the players.
            return prior(ctx) + out[:, :2], out[:, 2].clamp(-8, 4)   # mean (normalised), log var

    def prior(ctx):
        last_ok, next_ok = ctx[:, 3:4], ctx[:, 7:8]
        last, nxt = ctx[:, 0:2], ctx[:, 4:6]
        w = ctx[:, 2:3] / (ctx[:, 2:3] + ctx[:, 6:7]).clamp(min=1e-6)
        interp = (1 - w) * last + w * nxt
        centre = torch.full_like(last, 0.5)
        one = torch.where(last_ok > 0, last, torch.where(next_ok > 0, nxt, centre))
        return torch.where((last_ok * next_ok) > 0, interp, one)

    return BallNet()


def _device():
    """NVIDIA GPU (cuda), Apple Silicon GPU (mps, e.g. the team's MacBook M5) or CPU.
    SB_DEVICE=cpu|cuda|mps forces one."""
    import os
    import torch
    forced = os.environ.get("SB_DEVICE")
    if forced:
        return forced
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _device_name(device):
    import platform
    import torch
    if device == "cuda":
        return torch.cuda.get_device_name(0)
    if device == "mps":
        return "Apple GPU ({})".format(platform.processor() or platform.machine())
    return "CPU"


def _to(device, *arrays):
    """Floats go as float32: Apple's mps backend has no float64."""
    import numpy as np
    import torch
    out = []
    for a in arrays:
        a = np.asarray(a)
        if a.dtype == np.float64:
            a = a.astype(np.float32)
        out.append(torch.as_tensor(a, device=device))
    return out


def nll_metres(mean, logvar, target):
    """Gaussian NLL with the error measured in metres (isotropic)."""
    import torch
    scale = torch.tensor(paths.PITCH, device=mean.device)
    err2 = (((mean - target) * scale) ** 2).sum(-1)
    return (0.5 * err2 * torch.exp(-logvar) + logvar).mean()


def train(track, train_frames, steps=4000, batch=512, lr=2e-3, seed=0, log_every=500,
          val_frames=None, eval_every=500):
    """Train with augmentation. With `val_frames`, keep the weights from the step with the lowest
    validation error (early stopping) and record it as model.best_step."""
    import copy
    import torch
    torch.manual_seed(seed)
    device = _device()
    gaps = real_gap_lengths(track)
    sampler = Sampler(track, train_frames, gaps, seed=seed)
    val = None
    if val_frames is not None:
        val = _to(device, *Sampler(track, val_frames, gaps, seed=999).batch(4096))
    model = build_model().to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-2)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=steps)
    name = _device_name(device)
    print("  training on {} ({}): {} steps, batch {}".format(device, name, steps, batch))
    log_every = min(log_every, max(steps // 4, 1)) if log_every else 0
    t0 = time.time()
    best = (float("inf"), steps, None)
    scale = torch.tensor(paths.PITCH, device=device)
    for step in range(1, steps + 1):
        model.train()
        players, ctx, target = _to(device, *sampler.batch(batch, augment=True))
        mean, logvar = model(players, ctx)
        loss = nll_metres(mean, logvar, target)
        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()
        val_msg = ""
        if val is not None and (step % eval_every == 0 or step == steps):
            model.eval()
            with torch.no_grad():
                vm, _ = model(val[0], val[1])
                err = torch.median(torch.linalg.norm((vm - val[2]) * scale, dim=-1)).item()
            if err < best[0]:
                best = (err, step, copy.deepcopy(model.state_dict()))
            val_msg = "  val median {:.2f} m (best {:.2f} @ {})".format(err, best[0], best[1])
        if (log_every and step % log_every == 0) or val_msg:
            print("  step {:>5}  loss {:.3f}{}  ({:.0f}s, {})".format(
                step, loss.item(), val_msg, time.time() - t0, device))
    if best[2] is not None:
        model.load_state_dict(best[2])
    model.best_step = best[1]
    model.eval()
    return model


def predict(model, players, ctx, batch=4096):
    """Predicted ball position (metres) and 1-sigma uncertainty (metres) for each row."""
    import torch
    device = next(model.parameters()).device
    model.eval()
    means, sigmas = [], []
    with torch.no_grad():
        for i in range(0, len(players), batch):
            p, c = _to(device, players[i:i + batch], ctx[i:i + batch])
            mean, logvar = model(p, c)
            means.append(mean.cpu().numpy())
            sigmas.append(torch.exp(0.5 * logvar).cpu().numpy())
    mean = np.concatenate(means) * np.array(paths.PITCH, dtype=np.float32)
    return mean, np.concatenate(sigmas)


def evaluate(model, track, frames, n=20000, seed=123):
    """Median error (m) on synthetic gaps at held-out frames, against two simple baselines."""
    sampler = Sampler(track, frames, real_gap_lengths(track), seed=seed)
    players, ctx, target = sampler.batch(n)
    scale = np.array(paths.PITCH, dtype=np.float32)
    mean, sigma = predict(model, players, ctx)
    truth = target * scale
    err = np.hypot(*(mean - truth).T)
    # baseline 1: last seen ball (if known), else pitch centre
    last = np.where(ctx[:, 3:4] > 0, ctx[:, 0:2] * scale, scale / 2)
    err_last = np.hypot(*(last - truth).T)
    # baseline 2: time-weighted interpolation between last and next seen (when both known)
    both = (ctx[:, 3] > 0) & (ctx[:, 7] > 0)
    w = ctx[:, 2] / np.maximum(ctx[:, 2] + ctx[:, 6], 1e-6)
    interp = (1 - w)[:, None] * ctx[:, 0:2] * scale + w[:, None] * ctx[:, 4:6] * scale
    interp = np.where(both[:, None], interp, last)
    err_interp = np.hypot(*(interp - truth).T)
    no_ctx = (ctx[:, 3] == 0) & (ctx[:, 7] == 0)
    report = {
        "model_median_m": float(np.median(err)),
        "interp_median_m": float(np.median(err_interp)),
        "last_seen_median_m": float(np.median(err_last)),
        "model_median_m_no_context": float(np.median(err[no_ctx])) if no_ctx.any() else None,
        "interp_median_m_no_context": float(np.median(err_interp[no_ctx])) if no_ctx.any() else None,
        "share_no_context": float(no_ctx.mean()),
        "within_1sigma": float(np.mean(err <= sigma)),
    }
    # what possession cares about: which TEAM is nearest to the ball, judged with the true ball
    # vs with the estimate, on frames where someone is close enough to be in control (< 3 m)
    t_idx = sampler.last_t
    xy = track.xy[t_idx]
    teams = track.teams

    def nearest_team(ball_xy):
        d = np.hypot(*(xy - ball_xy[:, None, :]).transpose(2, 0, 1))
        d = np.where(np.isnan(d), np.inf, d)
        return teams[np.argmin(d, axis=1)], d.min(axis=1)

    true_team, true_d = nearest_team(truth)
    contested = true_d < 3.0
    report["team_agreement_model"] = float(np.mean(nearest_team(mean)[0][contested] == true_team[contested]))
    report["team_agreement_interp"] = float(np.mean(nearest_team(interp)[0][contested] == true_team[contested]))
    gap_s = sampler.last_gap / paths.FPS
    for lo, hi in ((0, 2), (2, 10), (10, 30), (30, 1e9)):
        m = (gap_s >= lo) & (gap_s < hi)
        if m.any():
            report["gap_{}-{}s".format(lo, int(hi) if hi < 1e9 else "inf")] = {
                "share": round(float(m.mean()), 3),
                "model_m": round(float(np.median(err[m])), 2),
                "interp_m": round(float(np.median(err_interp[m])), 2)}
    return report


def half_frames(track, half):
    first, last = paths.HALVES[half - 1]
    idx = np.arange(first, last + 1)
    return idx[track.ball_seen[idx]]


def model_path():
    return os.path.join(paths.CACHE_DIR, "ballnet.pt")


def save(model, path=None):
    import torch
    os.makedirs(paths.CACHE_DIR, exist_ok=True)
    torch.save(model.state_dict(), path or model_path())


def load(path=None):
    import torch
    model = build_model()
    model.load_state_dict(torch.load(path or model_path(), map_location="cpu"))
    return model.to(_device())


def reconstruct(model, track):
    """Fill every unseen frame. Returns (ball_xy (T,2) metres, sigma (T,), source (T,) 0=seen 1=model)."""
    seen = track.ball_seen
    last_before, next_after = seen_neighbours(seen)
    target = np.where(~seen)[0]
    players = player_tensor(track)[target]
    ctx = context_features(track.ball, target, last_before[target], next_after[target])
    mean, sigma = predict(model, players, ctx)
    ball = track.ball.copy()
    ball[target] = mean
    sig = np.zeros(len(seen), dtype=np.float32)
    sig[target] = sigma
    source = (~seen).astype(np.int8)
    return ball, sig, source
