"""Automatic Tracking Data (ATD): parse once, cache as numpy, load in a second.

Raw line format (tactical: 46 track slots):

    <frame_id>:<x,y,s>;<x,y,s>;...;<x,y,s>:<ball_x,ball_y,NaN>

- frame_id counts from 1; video frame (= submission row) = frame_id - 1
- x, y are normalised 0-1; multiply by PITCH for metres
- s is speed in m/s; the ball carries no speed (always NaN)
- NaN = not observed

The metadata XML assigns every slot to a team: the first <Team> is home (H, Barcelona).
A slot is a tracklet, not a person: it can switch identity mid-match.

    python run.py cache        # builds cache/tactical_atd.npz
"""

import io
import os
import xml.etree.ElementTree as ET

import numpy as np
import pandas as pd

from . import paths

HOME, AWAY = 0, 1
CHUNK_LINES = 20000


def slot_teams(meta_path):
    """int8 array over slots: 0 = home, 1 = away. Order matches the raw file's slot order."""
    root = ET.parse(meta_path).getroot()
    team_ids = [team.get("id") for team in root.iter("Team")]
    if len(team_ids) != 2:
        raise ValueError("expected 2 teams in {}, found {}".format(meta_path, len(team_ids)))
    slots = [player.get("teamId") for player in root.iter("Player")]
    return np.array([HOME if t == team_ids[0] else AWAY for t in slots], dtype=np.int8)


def team_names(meta_path):
    root = ET.parse(meta_path).getroot()
    return tuple(team.findtext("Name") for team in root.iter("Team"))


def parse_raw(raw_path, n_slots):
    """Parse the raw ATD text into (frame_id, players, ball).

    players: float32 (T, n_slots, 3) -> x, y (normalised), speed (m/s)
    ball:    float32 (T, 2)          -> x, y (normalised)
    """
    n_cols = 1 + 3 * n_slots + 3
    table = str.maketrans({":": ",", ";": ","})
    blocks = []
    with open(raw_path) as handle:
        while True:
            lines = handle.readlines(CHUNK_LINES * 2200)
            if not lines:
                break
            text = "".join(lines).translate(table)
            block = pd.read_csv(io.StringIO(text), header=None, dtype=np.float64,
                                na_values=["NaN"]).to_numpy()
            if block.shape[1] != n_cols:
                raise ValueError("expected {} columns, got {}".format(n_cols, block.shape[1]))
            blocks.append(block)
    data = np.concatenate(blocks)
    frame_id = data[:, 0].astype(np.int64)
    players = data[:, 1:1 + 3 * n_slots].reshape(-1, n_slots, 3).astype(np.float32)
    ball = data[:, 1 + 3 * n_slots:1 + 3 * n_slots + 2].astype(np.float32)
    return frame_id, players, ball


def cache_path(source="tactical"):
    return os.path.join(paths.CACHE_DIR, "{}_atd.npz".format(source))


def build_cache(source="tactical"):
    """Parse the raw ATD for one source and write cache/<source>_atd.npz."""
    meta = paths.asset("atd_meta", source)
    raw = paths.asset("atd_raw", source)
    teams = slot_teams(meta)
    frame_id, players, ball = parse_raw(raw, len(teams))
    check_alignment(frame_id, source)
    os.makedirs(paths.CACHE_DIR, exist_ok=True)
    out = cache_path(source)
    np.savez(out, frame_id=frame_id, players=players, ball=ball, teams=teams,
             team_names=np.array(team_names(meta)))
    return out


def check_alignment(frame_id, source="tactical"):
    """The ATD must be one record per video frame, numbered 1..N with no gaps."""
    expected = paths.N_FRAMES if source == "tactical" else len(frame_id)
    ok = (len(frame_id) == expected and frame_id[0] == 1
          and np.all(np.diff(frame_id) == 1))
    if not ok:
        raise ValueError("ATD alignment broken: {} records, ids {}..{}".format(
            len(frame_id), frame_id[0], frame_id[-1]))


class Tracking:
    """The tactical ATD indexed by VIDEO frame (row i = submission row i).

    Attributes (T = 199319 video frames, S = 46 slots):
      xy      float32 (T, S, 2)  player positions in metres, NaN if unseen
      speed   float32 (T, S)     m/s
      ball    float32 (T, 2)     ball position in metres, NaN if unseen
      teams   int8    (S,)       0 = home (H), 1 = away (A)
    """

    def __init__(self, source="tactical"):
        path = cache_path(source)
        if not os.path.isfile(path):
            raise IOError("No cache at {}. Run: python run.py cache".format(path))
        z = np.load(path)
        scale = np.array(paths.PITCH, dtype=np.float32)
        self.frame_id = z["frame_id"]
        self.xy = z["players"][:, :, :2] * scale
        self.speed = z["players"][:, :, 2]
        self.ball = z["ball"] * scale
        self.teams = z["teams"]
        self.team_names = tuple(str(n) for n in z["team_names"])

    @property
    def ball_seen(self):
        return ~np.isnan(self.ball[:, 0])

    @property
    def player_seen(self):
        return ~np.isnan(self.xy[:, :, 0])

    def __len__(self):
        return len(self.frame_id)
