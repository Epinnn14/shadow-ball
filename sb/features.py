"""Per-frame evidence computed from the tracking. Pure numpy/pandas, no labels involved.

Every feature is indexed by video frame (length N_FRAMES) and has a physical meaning, so its
thresholds can be set from football knowledge rather than fitted to the public 5 minutes.
"""

import numpy as np
import pandas as pd

from . import paths


def rolling_mean(x, window):
    return pd.Series(x).rolling(window, center=True, min_periods=1).mean().to_numpy()


def rolling_median(x, window):
    return pd.Series(x).rolling(window, center=True, min_periods=1).median().to_numpy()


def team_activity(track, window=50):
    """Mean speed of all tracked players (m/s), smoothed over `window` frames (2 s).

    Live play keeps players moving; stoppages (fouls, throw-ins, goal kicks) slow everyone down.
    """
    import warnings
    with warnings.catch_warnings(), np.errstate(all="ignore"):
        warnings.simplefilter("ignore", RuntimeWarning)
        speed = np.nanmean(track.speed, axis=1)
    speed = pd.Series(speed).interpolate(limit_direction="both").to_numpy()
    return rolling_mean(speed, window)


def ball_speed(track):
    """Ball speed in m/s from consecutive visible positions (NaN where either frame is unseen)."""
    v = np.full(len(track.ball), np.nan)
    v[1:] = np.hypot(*np.diff(track.ball, axis=0).T) * paths.FPS
    return v


def ball_out(track, margin=0.5):
    """1 while the ball is (or was last seen) outside the pitch, until it is seen inside again.

    A ball over a line is dead by definition. The tracker often loses the ball right after it
    leaves the pitch, so the flag is carried through the unseen gap that follows.
    """
    length, width = paths.PITCH
    bx, by = track.ball[:, 0], track.ball[:, 1]
    seen = ~np.isnan(bx)
    outside = seen & ((bx < -margin) | (bx > length + margin) |
                      (by < -margin) | (by > width + margin))
    state = np.where(seen, outside.astype(float), np.nan)
    return pd.Series(state).ffill().fillna(0).to_numpy()


def out_until_restart(track, margin=0.5, placed_speed=1.0, placed_frames=20,
                      kick_speed=5.0, max_s=40.0, resumed_activity=2.2, min_dead_s=8.0):
    """1 from the moment the ball is seen over a line until the restart is taken.

    A restart has two phases, and both must be seen:
      1. the ball is PLACED: seen and nearly still (median speed < `placed_speed` m/s) for
         `placed_frames` frames -- on the spot for a goal kick or corner, in the thrower's hands
      2. the ball is KICKED: its smoothed speed then exceeds `kick_speed` m/s
    Carrying the ball back onto the pitch is fast but not preceded by a placement, so it does
    not end the stoppage. Capped at `max_s` seconds in case the restart is never seen.

    Fallback when the restart itself is missed (ball unseen): after `min_dead_s`, play is taken
    as resumed once the ball is seen inside and the team mean speed is back above
    `resumed_activity` m/s AND rising (just after the ball goes out players are still
    decelerating from the last action; a restart is the opposite, everyone speeds up).
    """
    length, width = paths.PITCH
    bx, by = track.ball[:, 0], track.ball[:, 1]
    seen = ~np.isnan(bx)
    outside = seen & ((bx < -margin) | (bx > length + margin) |
                      (by < -margin) | (by > width + margin))
    v = rolling_median(ball_speed(track), 7)
    still = seen & (v < placed_speed)
    fast = seen & (v > kick_speed)
    act = team_activity(track)
    rising = act - np.concatenate((np.full(75, act[0]), act[:-75])) > 0.3
    resumed = seen & ~outside & (act > resumed_activity) & rising
    min_dead = int(min_dead_s * paths.FPS)
    cap = int(max_s * paths.FPS)
    flag = np.zeros(len(bx))
    dead_for, still_run, placed = -1, 0, False
    for i in range(len(bx)):
        if outside[i] and (dead_for < 0 or not placed):
            if dead_for < 0:
                dead_for, still_run, placed = 0, 0, False
        if dead_for >= 0:
            dead_for += 1
            still_run = still_run + 1 if still[i] else 0
            if still_run >= placed_frames:
                placed = True
            if ((placed and fast[i]) or dead_for > cap
                    or (dead_for > min_dead and resumed[i])):
                dead_for, placed = -1, False
        flag[i] = 1.0 if dead_for >= 0 else 0.0
    return flag


def ball_static(track, window=25, threshold=0.8):
    """1 where the ball is seen and has barely moved over ~1 s (placed for a restart)."""
    v = rolling_median(ball_speed(track), window)
    seen = rolling_mean((~np.isnan(track.ball[:, 0])).astype(float), window) > 0.8
    return ((v < threshold) & seen).astype(float)


def unseen_run(track):
    """How many consecutive frames the ball has been unseen at each frame (0 if seen)."""
    seen = ~np.isnan(track.ball[:, 0])
    run = np.zeros(len(seen), dtype=np.int32)
    count = 0
    for i, s in enumerate(seen):
        count = 0 if s else count + 1
        run[i] = count
    return run


def team_distances(track):
    """Distance (m) from the ball to the nearest home and nearest away player. inf if unknown."""
    diff = track.xy - track.ball[:, None, :]
    dist = np.sqrt(np.einsum("tsk,tsk->ts", diff, diff))
    dist = np.where(np.isnan(dist), np.inf, dist)
    home = np.where(track.teams == 0, dist, np.inf).min(axis=1)
    away = np.where(track.teams == 1, dist, np.inf).min(axis=1)
    return home, away


def tagged_set_pieces(n_frames, events):
    """1 inside the first 5 s of each Smart Tagging set piece: weak evidence of a restart."""
    flag = np.zeros(n_frames)
    for e in events:
        flag[max(0, e["start"]):min(n_frames, e["start"] + 5 * paths.FPS)] = 1.0
    return flag
