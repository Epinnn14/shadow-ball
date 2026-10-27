# Shadow Ball

Possession detection for More Than A Hack 2027, Phase 1: one label per frame of the tactical
video of FC Barcelona vs Athletic Club (H / A / D / X).

## Reproduce

```bash
pip install -r requirements.txt
export MTAH_DATA_DIR=/path/to/data      # folder containing tactical/ and broadcast/
python run.py cache
python run.py v1                        # fallback: v1
```

v2 additionally needs PyTorch (not in requirements.txt because the right build depends on your
GPU: take the command from https://pytorch.org/get-started/locally/):

```bash
python run.py ball-train --cv           # ~100k-parameter model; GPU if available, else CPU
python run.py v2                        # v2 (fallback)
python run.py v3                        # v3 (fallback)
python run.py v4                        # current submission: v4
python run.py validate submissions/v4_restart.csv
```

The match data is not in this repository and must not be: it is licensed for the competition only.

## Status

| Version | Idea | Public 5-min spellF1 (sanity check only) |
| --- | --- | --- |
| v0 | Organisers' baseline, vectorised (nearest player + ±2 s majority) | 0.3256 (full match: 0.2433, published) |
| v1 | Dead-ball detection (activity, ball over a line until the restart, Smart Tagging hint) + sticky possession decoded by a 3-state HMM | 0.5125 (public noise band ±0.36: not proof) |
| v2 | v1 + ball reconstruction (self-supervised transformer over the players; 2.9 m median error vs 5.6 m for interpolation, cross-half) | same as v1 when the ball is visible; with the ball hidden on ~41% of the public window: 0.444 vs v1 0.419 (8 random masks, model trained on half 2 only) |
| v3 | v2 + fouls and other stoppages with the ball still on the pitch: inferred whistle (collective deceleration that stays slow) latched until the restart, 10 s activity, ball placed inside the pitch | 0.5091 (macroF1 0.855 vs 0.760); ball hidden: spellF1 0.445 vs v2 0.444, macroF1 0.797 vs 0.731 |
| v4 | v3 + the ball is live from a seen restart kick on (a stoppage latch that ends on a kick pushes "alive" for 5 s), fixing dead-ball stretches that ended 1-5 s late | 0.5455 (macroF1 0.872); ball hidden: spellF1 0.464 vs v3 0.445, never worse in 8 masks |
| v4.1 | v4 with better restarts: the ball reappearing already moving fast after an unseen stretch ends a stoppage; a 0.4 s placement is enough | 0.5455 (macroF1 0.900, transitions F1 0.46); ball hidden: spellF1 0.473 vs v4 0.464, never worse |

## Tactical layer (Fase B)

`python run.py roles` labels every player with a tactical position (GK, LB, LCB, RCB, RB, LCDM,
CAM, LW, RW, ST, ...) by matching each team's outfield players, frame by frame, to its average
out-of-possession shape (Hungarian assignment), and computes distance, high-speed running,
sprints and top speed per position per 5 minutes.

`python run.py tactics` then builds what the bench sees live: open-play turnovers with the
counter-press that followed (players within 10 m, ball won back within 5 s), progression and an
"open transition" flag; a nearest-player space map at every turnover with the best free zone; team
shape once per second (width, depth, defensive-line height, compactness) with alerts against the
first 15 minutes; and a Fatigue Risk Score per position from the drop in high-speed running and
distance. Outputs go to `exports/` (derived data, not committed).

## Third-party code

`games.py` and `evaluation/` are copied unchanged from the organisers' repository
(metrica-sports/more-than-a-hack-2027), MIT licence: see `evaluation/LICENSE-mtah2027`.
