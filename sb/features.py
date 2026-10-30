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


def reappears_fast(track, kick_speed=5.0, min_gap=25, look=6):
    """True at frames where the ball comes back into view after >= `min_gap` unseen frames and is
    ALREADY moving faster than `kick_speed` m/s: the restart happened while it was out of view
    (the placement was never seen, so the place-then-kick rule alone would miss it)."""
    seen = ~np.isnan(track.ball[:, 0])
    v = ball_speed(track)
    run = unseen_run(track)
    out = np.zeros(len(seen), dtype=bool)
    back = np.where(seen[1:] & ~seen[:-1])[0] + 1
    for i in back:
        if run[i - 1] < min_gap:
            continue
        window = v[i + 1:i + 1 + look]
        window = window[~np.isnan(window)]
        if len(window) >= 3 and np.median(window) > kick_speed:
            out[i] = True
    return out


def out_until_restart(track, margin=0.5, placed_speed=1.0, placed_frames=10,
                      kick_speed=5.0, max_s=40.0, resumed_activity=2.2, min_dead_s=8.0,
                      unseen_restart=True):
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
    unseen_restart = (reappears_fast(track, kick_speed) & ~outside if unseen_restart
                      else np.zeros(len(bx), dtype=bool))
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
            if ((placed and fast[i]) or unseen_restart[i] or dead_for > cap
                    or (dead_for > min_dead and resumed[i])):
                dead_for, placed = -1, False
        flag[i] = 1.0 if dead_for >= 0 else 0.0
    return flag


def whistle_until_restart(track, drop=0.8, drop_frames=75, low=1.6, confirm_s=4.0,
                          confirm_activity=1.4, kick_speed=5.0, placed_speed=1.0,
                          placed_frames=10, resumed_activity=2.0, max_s=40.0,
                          unseen_restart=True):
    """1 from a referee's whistle (inferred) until the restart.

    A foul leaves the ball on the pitch, so nothing crosses a line. What every stoppage does
    show is the players: after the whistle everyone decelerates together. Trigger: team mean
    speed falls by more than `drop` m/s within `drop_frames` and ends below `low` m/s.
    Confirmation: it STAYS below `confirm_activity` for `confirm_s` seconds (a slow build-up
    after a sprint does not; a stoppage does). Then dead until the ball is placed and kicked,
    or until the team clearly speeds up again, or `max_s` seconds.
    """
    act = team_activity(track)
    n = len(act)
    before = np.concatenate((np.full(drop_frames, act[0]), act[:-drop_frames]))
    trigger = (before - act > drop) & (act < low)
    confirm = int(confirm_s * paths.FPS)
    slow = act < confirm_activity
    # stays slow for the next confirm frames: forward-looking run length of `slow`
    run = np.zeros(n, dtype=np.int32)
    count = 0
    for i in range(n - 1, -1, -1):
        count = count + 1 if slow[i] else 0
        run[i] = count
    confirmed = trigger & (run >= confirm)

    seen = ~np.isnan(track.ball[:, 0])
    v = rolling_median(ball_speed(track), 7)
    still = seen & (v < placed_speed)
    fast = seen & (v > kick_speed)
    rising = act - before > 0.3
    resumed = (act > resumed_activity) & rising
    unseen_restart = (reappears_fast(track, kick_speed) if unseen_restart
                      else np.zeros(n, dtype=bool))
    cap = int(max_s * paths.FPS)
    flag = np.zeros(n)
    dead_for, still_run, placed = -1, 0, False
    for i in range(n):
        if dead_for < 0 and confirmed[i]:
            dead_for, still_run, placed = 0, 0, False
        if dead_for >= 0:
            dead_for += 1
            still_run = still_run + 1 if still[i] else 0
            if still_run >= placed_frames:
                placed = True
            if (placed and fast[i]) or unseen_restart[i] or resumed[i] or dead_for > cap:
                dead_for, placed = -1, False
        flag[i] = 1.0 if dead_for >= 0 else 0.0
    return flag


def restart_kicks(track, latches, kick_speed=5.0):
    """Frames where a stoppage latch ended BECAUSE the ball was kicked: a restart was seen.

    `latches` are 0/1 arrays such as out_until_restart / whistle_until_restart. A latch that
    ends with the ball moving faster than `kick_speed` m/s ended on a restart; one that ended on
    its time cap or on resumed activity did not, and is not counted.
    """
    seen = ~np.isnan(track.ball[:, 0])
    v = rolling_median(ball_speed(track), 7)
    kicks = np.zeros(len(seen), dtype=bool)
    for flag in latches:
        ends = np.where((flag[:-1] == 1) & (flag[1:] == 0))[0] + 1
        ends = ends[seen[ends] & (v[ends] > kick_speed)]
        kicks[ends] = True
    return kicks


def after_restart(kicks, seconds=5.0):
    """1 for `seconds` after a detected restart kick: the ball is live from the kick on, even if
    the players are still slow (they always are, right after a throw-in or goal kick)."""
    n = int(seconds * paths.FPS)
    out = np.zeros(len(kicks))
    for k in np.where(kicks)[0]:
        out[k:k + n] = 1.0
    return out


def ball_placed_inside(track, window=50, threshold=0.6, activity=1.5):
    """1 where the ball is seen INSIDE the pitch, nearly still for ~2 s, while the team is slow:
    a free kick being set up. (A goalkeeper holding the ball is still too, but the outfield
    players are then usually moving into shape, so team activity is higher.)"""
    length, width = paths.PITCH
    bx, by = track.ball[:, 0], track.ball[:, 1]
    inside = (bx >= 0) & (bx <= length) & (by >= 0) & (by <= width)
    v = rolling_median(ball_speed(track), window)
    seen = rolling_mean((~np.isnan(bx)).astype(float), window) > 0.8
    return ((v < threshold) & seen & inside & (team_activity(track) < activity)).astype(float)


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


def kickoff_frame(track, start, right, search_s=300, still=1.0, still_s=2.0, burst=1.5, own=0.7):
    """The kick-off of a half: both teams standing in their own halves (>= `own` of their tracked
    players on their side) and nearly still (team speed < `still` m/s for `still_s`), then
    play bursts (> `burst` m/s within 3 s). Returns the first frame where the team speeds up from
    that standstill, or None. `right` = {0: home attacks right, 1: away attacks right} for this half.
    The ball is not used: at the second-half kick-off of this match it is not tracked."""
    import warnings
    fps = paths.FPS
    with warnings.catch_warnings(), np.errstate(all="ignore"):
        warnings.simplefilter("ignore", RuntimeWarning)
        raw = np.nanmean(track.speed, axis=1)
    raw = np.nan_to_num(raw, nan=1.5)
    act = rolling_mean(raw, fps)
    L = paths.PITCH[0]
    w = int(still_s * fps)

    def own_share(f, team):
        x = track.xy[f, track.teams == team, 0]
        x = x[~np.isnan(x)]
        if len(x) < 6:
            return 0.0
        return float(np.mean(x < L / 2 if right[team] else x > L / 2))

    end = min(len(raw) - 4 * fps, start + int(search_s * fps))
    for k in range(max(start, w), end):
        if act[k - w:k].max() >= still or act[k:k + 3 * fps].max() <= burst:
            continue
        if own_share(k, 0) < own or own_share(k, 1) < own:
            continue
        base = raw[k - w:k].mean()
        rise = np.where(raw[k:k + 4 * fps] > base + 0.25)[0]
        if len(rise):
            return int(k + rise[0])
    return None
