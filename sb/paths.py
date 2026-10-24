"""Where things live. One place, so no other module spells a path out.

Data directory, in order of preference:
  1. the MTAH_DATA_DIR environment variable
  2. <repo>/data                      (the layout the organisers' README describes)
  3. <repo>/../Dataset Drive          (our team's local layout)

The data is gated and never committed: see .gitignore.
"""

import os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(REPO, "cache")
SUBMISSIONS_DIR = os.path.join(REPO, "submissions")
EVAL_DIR = os.path.join(REPO, "evaluation")
PUBLIC_GT = os.path.join(EVAL_DIR, "gt", "BAR-ATH_possession_gt_public.csv")

GAME = "BAR-ATH"
N_FRAMES = 199319          # tactical video frames = submission rows
FPS = 25
PITCH = (105.3, 68.0)      # metres, measured from corrected tracking (games.py)
HALVES = ((11185, 90651), (110808, 190197))   # graded video frames, inclusive
PUBLIC_WINDOW = (11185, 18684)


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
