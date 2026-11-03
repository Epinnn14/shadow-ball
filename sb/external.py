"""External training data for ballnet: the Metrica Sports open sample data.

The competition rules (clarification of 3 Nov 2026) say any training or tuning must use external
data only. Ballnet is therefore trained and early-stopped on the three open Metrica sample games,
never on the provided match:

    git clone https://github.com/metrica-sports/sample-data external/metrica-sample-data
    python run.py ball-train            # games 1 + 2 train, game 3 validates (early stopping)

Source: https://github.com/metrica-sports/sample-data ("If you use it for anything public, please
acknowledge the source"). The files are not copied into this repository.

The loaders return an `ExternalTrack` with the same attributes ballnet reads from the competition
`Tracking` (xy in metres, teams per slot, ball, ball_seen), so the same feature code runs on both.
Coordinates are normalised 0-1 in both sources; we scale them by paths.PITCH so that ballnet's
normalisation gives back the provider's 0-1 values.
"""

import csv
import os
import xml.etree.ElementTree as ET

import numpy as np

from . import paths

DEFAULT_DIR = os.path.join(paths.REPO, "external", "metrica-sample-data")
SEPARATOR_S = 30          # blank frames between concatenated games (longer than ballnet's 20 s context)
MAX_REAL_GAP_S = 60       # unseen-ball runs longer than this are stoppages/half-time, not tracking gaps


def data_dir():
    return os.environ.get("MTAH_EXTERNAL_DIR", DEFAULT_DIR)


class ExternalTrack:
    """xy (T, S, 2) metres with NaN for absent slots, teams (S,) 0/1, ball (T, 2) metres,
    ball_seen (T,) bool, period (T,) int (0 on separator frames)."""

    def __init__(self, xy, teams, ball, period, name=""):
        self.xy = xy.astype(np.float32)
        self.teams = np.asarray(teams, dtype=np.int8)
        self.ball = ball.astype(np.float32)
        self.period = np.asarray(period, dtype=np.int8)
        self.name = name

    @property
    def ball_seen(self):
        return ~np.isnan(self.ball[:, 0])

    def __len__(self):
        return len(self.ball)


def _scale():
    return np.array(paths.PITCH, dtype=np.float32)


def load_csv_game(game_dir, game):
    """Sample Games 1 and 2: one CSV per team, columns Period, Frame, Time, (x, y) per player,
    then the ball (x, y) at the end of each file."""
    teams_xy, ball, period = [], None, None
    for team_id, side in enumerate(("Home", "Away")):
        path = os.path.join(game_dir, "Sample_Game_{}_RawTrackingData_{}_Team.csv".format(game, side))
        with open(path, newline="") as handle:
            rows = csv.reader(handle)
            next(rows)
            next(rows)
            header = next(rows)
            data = np.array([[np.nan if v in ("", "NaN") else float(v) for v in r] for r in rows],
                            dtype=np.float64)
        n_players = sum(1 for h in header if h.startswith("Player"))
        xy = data[:, 3:3 + 2 * n_players].reshape(len(data), n_players, 2)
        teams_xy.append((team_id, xy))
        if ball is None:
            ball = data[:, 3 + 2 * n_players:5 + 2 * n_players]
            period = data[:, 0].astype(int)
    n = min(len(xy) for _, xy in teams_xy)
    xy = np.concatenate([xy[:n] for _, xy in teams_xy], axis=1)
    teams = np.concatenate([[team_id] * t.shape[1] for team_id, t in teams_xy])
    return ExternalTrack(xy * _scale(), teams, ball[:n] * _scale(), period[:n], "game{}".format(game))


def load_epts_game(game_dir, game=3):
    """Sample Game 3: FIFA EPTS text (frame:x,y;x,y;...:ball_x,ball_y) + XML metadata. The player
    order changes between format blocks (substitutions), so every block maps its channels to
    player ids, and every player id to a team and a fixed slot."""
    meta = ET.parse(os.path.join(game_dir, "Sample_Game_{}_metadata.xml".format(game))).getroot()
    team_of = {}
    for player in meta.iter("Player"):
        team_of[player.get("id")] = player.get("teamId")
    team_ids = sorted(set(team_of.values()))
    home = team_ids[0]
    for team in meta.iter("Team"):                       # the first listed team is the home side
        if team.get("id") in team_ids:
            home = team.get("id")
            break
    channel_player = {ch.get("id"): ch.get("playerId") for ch in meta.iter("PlayerChannel")}
    slots = {pid: k for k, pid in enumerate(sorted(team_of))}
    blocks = []
    for spec in meta.iter("DataFormatSpecification"):
        refs = [r.get("playerChannelId") for r in spec.iter("PlayerChannelRef")]
        order = [channel_player[r] for r in refs if r.endswith("_x")]
        blocks.append((int(spec.get("startFrame")), int(spec.get("endFrame")), order))
    blocks.sort()
    frames, rows_xy, rows_ball = [], [], []
    with open(os.path.join(game_dir, "Sample_Game_{}_tracking.txt".format(game))) as handle:
        for line in handle:
            frame_s, players_s, ball_s = line.rstrip("\n").split(":")
            frame = int(frame_s)
            order = next(o for a, b, o in blocks if a <= frame <= b)
            xy = np.full((len(slots), 2), np.nan)
            for pid, cell in zip(order, players_s.split(";")):
                x, y = cell.split(",")
                xy[slots[pid]] = (float(x), float(y))
            bx, by = ball_s.split(",")
            frames.append(frame)
            rows_xy.append(xy)
            rows_ball.append((float(bx), float(by)))
    xy = np.array(rows_xy)
    ball = np.array(rows_ball)
    teams = np.array([0 if team_of[pid] == home else 1 for pid in sorted(team_of)])
    period = np.ones(len(frames), dtype=int)      # only used to tell game frames from separators
    return ExternalTrack(xy * _scale(), teams, ball * _scale(), period, "game{}".format(game))


def load_game(game, root=None):
    root = root or data_dir()
    game_dir = os.path.join(root, "data", "Sample_Game_{}".format(game))
    if not os.path.isdir(game_dir):
        raise SystemExit("External data not found at {}.\nDownload it with:\n  git clone "
                         "https://github.com/metrica-sports/sample-data {}".format(game_dir, root))
    return load_csv_game(game_dir, game) if game in (1, 2) else load_epts_game(game_dir, game)


def concat(tracks):
    """One track from several games, padded to a common slot count, with SEPARATOR_S blank frames
    between them so no context window reaches across two games."""
    # A slot means a different player in each game; ballnet reads the slots as a set, so only the
    # team of a slot matters. Home players go to the first block of slots and away players to the
    # second, so the team of every slot is the same in all games.
    n_home = max(int((t.teams == 0).sum()) for t in tracks)
    n_away = max(int((t.teams == 1).sum()) for t in tracks)
    teams = np.array([0] * n_home + [1] * n_away, dtype=np.int8)
    sep = SEPARATOR_S * paths.FPS
    xy, ball, period = [], [], []
    for k, t in enumerate(tracks):
        pad = np.full((len(t), n_home + n_away, 2), np.nan, dtype=np.float32)
        home, away = np.where(t.teams == 0)[0], np.where(t.teams == 1)[0]
        pad[:, :len(home)] = t.xy[:, home]
        pad[:, n_home:n_home + len(away)] = t.xy[:, away]
        xy.append(pad)
        ball.append(t.ball)
        period.append(t.period)
        if k < len(tracks) - 1:
            xy.append(np.full((sep, n_home + n_away, 2), np.nan, dtype=np.float32))
            ball.append(np.full((sep, 2), np.nan, dtype=np.float32))
            period.append(np.zeros(sep, dtype=np.int8))
    return ExternalTrack(np.concatenate(xy), teams, np.concatenate(ball), np.concatenate(period),
                         "+".join(t.name for t in tracks))


def gap_lengths(track):
    """Lengths (frames) of the real unseen-ball runs in the external data during play (between
    1 frame and MAX_REAL_GAP_S), plus short gaps 1-49 so the model also learns the easy cases."""
    seen = track.ball_seen | (track.period == 0)
    runs, count = [], 0
    for s in seen:
        if not s:
            count += 1
        elif count:
            runs.append(count)
            count = 0
    runs = np.array([r for r in runs if r <= MAX_REAL_GAP_S * paths.FPS], dtype=int)
    return np.concatenate([runs, np.arange(1, 50)])


def target_frames(track):
    """Frames with a seen ball and a known period: candidate training targets."""
    return np.where(track.ball_seen & (track.period > 0))[0]
