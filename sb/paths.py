"""Where things live. One place, so no other module spells a path out.

Data directory, in order of preference:
  1. the MTAH_DATA_DIR environment variable
  2. <repo>/data                      (the layout the organisers' README describes)
  3. <repo>/../Dataset Drive          (our team's local layout)

The data is gated and never committed: see .gitignore.
"""

import os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVAL_DIR = os.path.join(REPO, "evaluation")
PUBLIC_GT = os.path.join(EVAL_DIR, "gt", "BAR-ATH_possession_gt_public.csv")
FPS = 25

# Which match the whole pipeline runs on. SB_GAME (or `python run.py --game ...`) picks it before
# any module is imported, because several modules derive constants from the pitch size.
#   BAR-ATH      the competition match (gated data, licensed for the competition only)
#   METRICA-1..3 the open Metrica Sports sample games (github.com/metrica-sports/sample-data),
#                usable by anyone with attribution: the portfolio version of the project
GAMES = {
    "BAR-ATH": {"n_frames": 199319, "pitch": (105.3, 68.0),
                "halves": ((11185, 90651), (110808, 190197))},     # graded video frames, inclusive
    "METRICA-1": {"n_frames": 145006, "pitch": (105.0, 68.0), "halves": ((0, 71267), (71268, 145005))},
    "METRICA-2": {"n_frames": 141156, "pitch": (105.0, 68.0), "halves": ((0, 67940), (67941, 141155))},
    "METRICA-3": {"n_frames": 143761, "pitch": (105.0, 68.0), "halves": ((0, 69660), (69661, 143760))},
}
# Your own videos (`python run.py video track ...`) register themselves as VIDEO-<name> through the
# meta.json the video pipeline writes next to their cache.
def _video_games():
    import json
    root = os.path.join(REPO, "cache")
    out = {}
    if os.path.isdir(root):
        for sub in sorted(os.listdir(root)):
            meta = os.path.join(root, sub, "meta.json")
            if sub.startswith("video-") and os.path.isfile(meta):
                with open(meta, encoding="utf-8") as handle:
                    m = json.load(handle)
                out[sub.upper()] = {"n_frames": int(m["n_frames"]), "pitch": tuple(m["pitch"]),
                                    "halves": tuple(tuple(h) for h in m["halves"]), "video": m}
    return out


GAME = os.environ.get("SB_GAME", "BAR-ATH").upper()
if GAME.startswith("VIDEO-"):
    GAMES.update(_video_games())
if GAME not in GAMES:
    raise SystemExit("Unknown game {!r}; choose one of {} (videos: run python run.py video track first)".format(GAME, ", ".join(GAMES)))
OPEN_DATA = GAME.startswith("METRICA")      # open games with Metrica event data
VIDEO = GAME.startswith("VIDEO-")           # tracking made by sb/video.py from a video
ANONYMOUS = OPEN_DATA or VIDEO              # players shown by number only, never real names
# Match minute at which the second half starts. A video without halves is analysed as two equal
# parts (the half-based tools need two), and its second part starts at its real clip minute.
H2 = float(GAMES[GAME]["video"].get("h2_minute", 45)) if VIDEO else 45
N_FRAMES = GAMES[GAME]["n_frames"]        # tracking frames = submission rows
PITCH = GAMES[GAME]["pitch"]              # metres
HALVES = GAMES[GAME]["halves"]
PUBLIC_WINDOW = (11185, 18684)            # BAR-ATH only

# The competition keeps its original folders (so the submitted file still regenerates byte for
# byte); every open game gets its own subfolder.
_SUB = "" if GAME == "BAR-ATH" else GAME.lower()
CACHE_DIR = os.path.join(REPO, "cache", _SUB)
SUBMISSIONS_DIR = os.path.join(REPO, "submissions", _SUB)
EXPORTS_DIR = os.path.join(REPO, "exports", _SUB)
REFERENCE_LABELS = os.path.join(CACHE_DIR, "reference_labels.csv")    # open games: from Metrica events


def data_dir():
    """The folder holding tactical/ and broadcast/."""
    candidates = [
        os.environ.get("MTAH_DATA_DIR"),
        os.path.join(REPO, "data"),
        os.path.join(os.path.dirname(REPO), "Dataset Drive"),
    ]
    for path in candidates:
        if path and os.path.isfile(os.path.join(path, "tactical", GAME + "_tactical_atd.txt")):
            return path
    raise IOError(
        "Match data not found. Tried:\n  " + "\n  ".join(p for p in candidates if p) +
        "\nSet MTAH_DATA_DIR to the folder that contains tactical/ and broadcast/.")


def asset(name, source="tactical"):
    """Path to one provided file, e.g. asset('atd_raw')."""
    suffix = {
        "video": ".mp4",
        "atd_meta": "_atd.xml",
        "atd_raw": "_atd.txt",
        "homography": "_homography.csv",
        "smart_tagging": "_smart_tagging.xml",
    }[name]
    return os.path.join(data_dir(), source, "{}_{}{}".format(GAME, source, suffix))


def graded_mask():
    """Boolean array over video frames: True where the ground truth is graded."""
    import numpy as np
    mask = np.zeros(N_FRAMES, dtype=bool)
    for first, last in HALVES:
        mask[first:last + 1] = True
    return mask


def half_of_frames():
    """int8 array over video frames: 1 or 2 inside a half, 0 elsewhere."""
    import numpy as np
    half = np.zeros(N_FRAMES, dtype=np.int8)
    for i, (first, last) in enumerate(HALVES, start=1):
        half[first:last + 1] = i
    return half
