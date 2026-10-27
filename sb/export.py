"""Contract files for the next phases (Fase B analytics, Fase C decisions, N's Bench Copilot).

    python run.py export            # -> exports/possession.csv, exports/ball.parquet

These are DERIVED from the licensed match data, so exports/ is gitignored and must never be
published (the organisers' terms forbid redistributing reconstructable tracking data).
"""

import os

import numpy as np
import pandas as pd

from . import paths

EXPORT_DIR = os.path.join(paths.REPO, "exports")


def export(labels, ball, sigma, source):
    """possession.csv: frame, label (H/A/D/X) = the submission labels.
    ball.parquet: frame, x, y (metres), source ('seen' or 'model'), sigma_m (model uncertainty,
    0 where seen), half (0 outside graded play)."""
    os.makedirs(EXPORT_DIR, exist_ok=True)
    frames = np.arange(paths.N_FRAMES)
    pd.DataFrame({"frame": frames, "label": labels}).to_csv(
        os.path.join(EXPORT_DIR, "possession.csv"), index=False)
    pd.DataFrame({
        "frame": frames,
        "x": ball[:, 0].astype(np.float32),
        "y": ball[:, 1].astype(np.float32),
        "source": np.where(source == 1, "model", "seen"),
        "sigma_m": sigma.astype(np.float32),
        "half": paths.half_of_frames(),
    }).to_parquet(os.path.join(EXPORT_DIR, "ball.parquet"), index=False)
    return EXPORT_DIR
