# Rules clarification: ballnet trained on external data only (v4.3), 2026-11-03

## Why

The organisers' "Clarification of the rules" (3 Nov 2026) overrides all earlier information:

- not allowed: checking output against the video; hand labels on the provided game; uploading the
  provided data to AI services; training, fitting or calibrating on the ground truth or the video;
- training or retraining MUST use only external data, and any tuned parameter MUST be tuned on
  external data.

v4.2 used a ballnet trained (self-supervised) and early-stopped on the competition match's own
tracking. That no longer complies.

## Change

- `sb/external.py`: loader for the open Metrica Sports sample data (3 games, 25 fps, normalised
  coordinates like ours). Games 1 + 2 train, game 3 picks the early-stopping step.
- `run.py ball-train`: trains only on that data, writes `models/ballnet.pt` + a report
  `experiments/ballnet_external_<time>.json`. The old in-match options (`--cv`, `--train-half`) are gone.
- Synthetic gap lengths now come from the external games' own unseen-ball runs (previously from the
  competition match).
- Player speed feature is computed from positions (`|velocity|`) instead of the provider's speed
  column, so the feature means the same thing in both sources.
- Step cap raised to 60,000; the step is chosen by early stopping on external game 3 only.
- `scripts/mask_test.py` and `restart_ab.py` now load `models/ballnet.pt`: they are sanity checks
  on the public window and are never used to choose a version.

The HMM rules and parameters are unchanged (set from football reasoning, not fitted).

## Process change

From 3 Nov, the AI assistant used during development no longer reads or runs the match data.
Code is written and unit-tested without it (tests need no data); everything that touches the match
data runs locally on the team's laptop.

## Results (laptop RTX 3050 Ti, 3 Nov, ~37 min)

`python run.py ball-train` (60,000-step cap, batch 512, seed 0). Early stopping on external game 3
picked step 50,500. Report: `ballnet_external_20261103_2040.json`.

Validation on external game 3 (synthetic gaps drawn from game 3's own unseen-ball runs):

| Gap length | Share | Ballnet median error | Interpolation |
| --- | --- | --- | --- |
| 0 to 2 s | 52.6% | 0.04 m | 0.00 m |
| 2 to 10 s | 21.3% | 4.33 m | 6.36 m |
| 10 to 30 s | 18.2% | 5.46 m | 15.54 m |
| Over 30 s | 7.9% | 6.13 m | 27.05 m |
| All | | 1.22 m | 1.47 m |

Nearest team right when a player is within 3 m: 79.2% (interpolation 78.1%). 66.6% of errors fall
within one predicted sigma. The all-gaps median is lower than the old in-match figure (2.8 m)
because the Metrica sample data has many more very short gaps; the per-length rows are the fair
comparison, and they are close to the old ones (2-10 s 3.9 m, 10-30 s 5.4 m, over 30 s 6.2 m).

Frozen weights `models/ballnet.pt` sha256 7e408f52dec493a4ddbdfb753981b95a96acc86be553392fa66a1b299f6b4e87.
`ball-predict` + `v4` on the match: CSV sha256
c3eb7ed644caa73e94d5f03764c34c8bc6ba1f6e380dc097fe068a2c4b9ce502; H 53,141, A 36,899, D 68,817,
X 40,462; 275 possessions, mean 13.1 s, D 43.3%.

## Decision

Kept as the submission (v4.3) regardless of its public-window score, which is a sanity check only.
