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
python run.py v2                        # current submission: v2
python run.py validate submissions/v2_ballnet.csv
```

The match data is not in this repository and must not be: it is licensed for the competition only.

## Status

| Version | Idea | Public 5-min spellF1 (sanity check only) |
| --- | --- | --- |
| v0 | Organisers' baseline, vectorised (nearest player + ±2 s majority) | 0.3256 (full match: 0.2433, published) |
| v1 | Dead-ball detection (activity, ball over a line until the restart, Smart Tagging hint) + sticky possession decoded by a 3-state HMM | 0.5125 (public noise band ±0.36: not proof) |
| v2 | v1 + ball reconstruction (self-supervised transformer over the players; 2.9 m median error vs 5.6 m for interpolation, cross-half) | same as v1 when the ball is visible; with the ball hidden on ~41% of the public window: 0.444 vs v1 0.419 (8 random masks, model trained on half 2 only) |

## Third-party code

`games.py` and `evaluation/` are copied unchanged from the organisers' repository
(metrica-sports/more-than-a-hack-2027), MIT licence: see `evaluation/LICENSE-mtah2027`.
