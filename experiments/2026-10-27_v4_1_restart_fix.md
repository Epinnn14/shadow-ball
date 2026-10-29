# v4.1 — unseen restarts

## Problem in v4
Two of the four restarts in the public window were still late:
- frame 12989: the ball was not visible during the stoppage, then reappeared already travelling at 10 m/s.
  The ball was placed and kicked while unseen, so the "placed, then kicked" rule failed.
- frame 16400: the thrower held the ball for only ~0.5 s before the throw-in; the
  "placed" condition at the time was 20 frames (0.8 s).

## Fix (sb/features.py, applies to all dead-ball latches)
- `reappears_fast`: the ball reappears after >= 1 s unseen and immediately moves
  > 5 m/s -> the restart happened unseen; the latch ends there (and counts as a restart).
- The "placed" condition was lowered from 20 to 10 frames (0.4 s).
- The old behaviour can still be called (`placed_frames=20, unseen_restart=False`) for A/B.

## Results

| | v4 | v4.1 |
| --- | --- | --- |
| Restart kicks detected (full match) | 77 | 92 |
| D share | 44.6% | 42.4% |
| Possessions / average duration | 273 / 12.9 s | 286 / 12.8 s |
| Public restarts GT -> model in play | 12989->13013, 16400->16512, 17838->17889, 18389->18364 | 12989->12979, 16400->16401, 17838->17826, 18389->18364 |
| Public spellF1 | 0.5455 | 0.5455 |
| Public macroF1 | 0.8715 | 0.9001 |
| Public transF1 (±1 s) | 0.36 | 0.46 |

Ball-hidden A/B, same masking (`scripts/restart_ab.py`, half-2 model):

| average of 8 runs | v4 | v4.1 |
| --- | --- | --- |
| spellF1 | 0.464 | 0.473 (better 2, equal 6, worse 0) |
| macroF1 | 0.806 | 0.829 (better 8/8) |

## Decision
v4.1 adopted (still `python run.py v4`). Note: two public restarts are now detected
0.4-1 s EARLIER than the GT; the ball model's sigma cap (max 7.4 m) is overconfident for
very long gaps -> fix later.
