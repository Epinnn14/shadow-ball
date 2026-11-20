"""Reference possession labels for the open Metrica games, derived from Metrica's event data.

The competition ground truth comes from corrected tracking: dead where the ball is dead,
otherwise the team that owns it, sticky through loose balls. The open games have no such file,
but they do have human-tagged events, which give the same two answers:

  dead (D)    from a BALL OUT, a FAULT RECEIVED or a goal until the next SET PIECE starts;
              before the first kick-off of each half
  owner       the team of the latest event that shows control: PASS, CARRY, SET PIECE, SHOT,
              RECOVERY. A BALL LOST or a CHALLENGE does not hand the ball over by itself; the
              opponent's next controlling event does (the same sticky rule as the competition)
  X           after the last event of a half (time added, the final whistle): not graded

These labels are an approximation (event timing is to the frame the tagger chose, and a pass
that goes straight out is still the passer's team until the BALL OUT), so they are used only
to MEASURE the pipeline on games it never saw. No parameter is set from them.

    python run.py --game METRICA-3 reference      # -> cache/metrica-3/reference_labels.csv
"""

import os

import numpy as np

from . import external, paths

CONTROL = {"PASS", "CARRY", "SET PIECE", "SHOT", "RECOVERY"}
DEAD_START = {"BALL OUT", "FAULT RECEIVED"}
TAIL_S = 1.0          # the last event of a half is followed by 1 s of play before X


def labels(ev, n_frames, halves):
    """Array of 'H'/'A'/'D'/'X' over frames from the event table of one game."""
    out = np.full(n_frames, "X", dtype="<U1")
    for first, last in halves:
        half_ev = ev[(ev.start >= first) & (ev.start <= last)]
        if half_ev.empty:
            continue
        end_of_play = min(last, int(half_ev.end.max() + TAIL_S * paths.FPS))
        out[first:end_of_play + 1] = "D"              # dead until the kick-off
        owner, dead, cursor = None, True, first
        for r in half_ev.itertuples():
            t = int(r.start)
            if t > cursor:
                out[cursor:t] = "D" if dead or owner is None else owner
                cursor = t
            if r.type == "SET PIECE":
                dead, owner = False, r.side
            elif r.type in CONTROL:
                if not dead:
                    owner = r.side
            if r.type in DEAD_START or (r.type == "SHOT" and "GOAL" in r.subtype and "OFF" not in r.subtype):
                dead = True
                # a ball out / foul / goal ends the event; the dead spell starts at its end frame
                t_end = max(int(r.end), t)
                if owner is not None and t_end > cursor and r.type != "FAULT RECEIVED":
                    out[cursor:t_end] = owner
                    cursor = t_end
        if end_of_play + 1 > cursor:
            out[cursor:end_of_play + 1] = "D" if dead or owner is None else owner
    return out


def build(game_number=None):
    """Write cache/<game>/reference_labels.csv for the current open game and return its path."""
    if not paths.OPEN_DATA:
        raise SystemExit("Reference labels exist only for the open games (--game METRICA-1..3).")
    game_number = game_number or int(paths.GAME[-1])
    lab = labels(external.events(game_number), paths.N_FRAMES, paths.HALVES)
    os.makedirs(paths.CACHE_DIR, exist_ok=True)
    with open(paths.REFERENCE_LABELS, "w", newline="\n") as handle:
        handle.write("frame,label\n")
        handle.writelines("{},{}\n".format(i, x) for i, x in enumerate(lab))
    return paths.REFERENCE_LABELS
