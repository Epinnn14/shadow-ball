# Shadow Ball

Possession detection for More Than A Hack 2027, Phase 1: one label per frame of the tactical
video of FC Barcelona vs Athletic Club (H / A / D / X).

## Reproduce

```bash
pip install -r requirements.txt
export MTAH_DATA_DIR=/path/to/data      # folder containing tactical/ and broadcast/
python run.py cache
python run.py v1                        # current submission: v1
python run.py validate submissions/v1_hmm.csv
```

The match data is not in this repository and must not be: it is licensed for the competition only.

## Status

| Version | Idea | Public 5-min spellF1 (sanity check only) |
| --- | --- | --- |
| v0 | Organisers' baseline, vectorised (nearest player + ±2 s majority) | 0.3256 (full match: 0.2433, published) |
| v1 | Dead-ball detection (activity, ball over a line until the restart, Smart Tagging hint) + sticky possession decoded by a 3-state HMM | 0.5125 (public noise band ±0.36: not proof) |

## Third-party code

`games.py` and `evaluation/` are copied unchanged from the organisers' repository
(metrica-sports/more-than-a-hack-2027), MIT licence: see `evaluation/LICENSE-mtah2027`.
