# The pipeline on the open Metrica games (2026-11-20)

After Phase 1 (Látigo AI did not reach the top 20), the project continues as a portfolio piece on
data anyone may use: the three open Metrica Sports sample games
(github.com/metrica-sports/sample-data, credit: Metrica Sports). The competition match stays
supported (`--game BAR-ATH`, the default) and its submitted file still regenerates unchanged.

## What changed

- `sb/paths.py`: a game catalog (`SB_GAME` or `python run.py --game METRICA-1 ...`) with frames,
  halves and pitch per game; caches, submissions and exports go to a subfolder per open game.
- `run.py --game METRICA-n cache` builds the same cache format from the open CSV/EPTS files
  (speed computed from positions).
- `sb/reference.py` + `run.py reference`: reference possession labels from Metrica's event data
  (dead from BALL OUT / FAULT RECEIVED / goal until the next SET PIECE; owner = team of the latest
  PASS, CARRY, SET PIECE, SHOT or RECOVERY; sticky through BALL LOST and CHALLENGE). Check against
  the tracking: the ball is seen on 85-91% of H/A frames and on 15-22% of D frames, and the nearest
  team (player within 2 m) agrees with the reference owner on 91-92% of live frames.
- Set-piece hints for the labels are switched off on the open games (`tagging.set_pieces()` returns
  none): the events are tagged by people and also build the reference, so using them would leak it.
  The demo still shows set pieces and goals from the events.

No parameter of the pipeline was changed for these games, and none was set from the reference.

## Results (spellF1 / macroF1 against the event reference)

| Version | Game 3 (fully held out) | Game 2 | Game 1 |
| --- | --- | --- | --- |
| v0 organisers' baseline | 0.372 / 0.744 | 0.420 / 0.746 | 0.419 / 0.724 |
| v1 HMM | 0.514 / 0.761 | 0.535 / 0.747 | 0.533 / 0.776 |
| v2 + ballnet | 0.510 / 0.762 | 0.542 / 0.749 | 0.523 / 0.771 |
| v3 + whistle | 0.514 / 0.764 | 0.548 / 0.751 | 0.526 / 0.771 |
| **v4.3** (submitted method) | **0.525 / 0.768** | **0.555 / 0.754** | 0.523 / 0.764 |
| Reference: possessions, mean length | 352, 11.6 s | 299, 12.9 s | 308, 11.3 s |
| v4.3: possessions, mean length | 249, 15.4 s | 223, 14.9 s | 238, 13.3 s |

Game 3 is the honest test: ballnet only used it to pick its stopping step, and nothing else in the
pipeline has seen it. On games 1 and 2 ballnet was trained on the ball positions (never on
possession), so v2-v4 are slightly optimistic there.

Reading: the HMM is the big step (+0.10 to +0.14 spellF1 over the baseline on every game); the
later versions are within the ~0.04 noise band of each other and of v1. The pipeline makes 20-30%
fewer possessions than the reference: the reference switches on every tagged recovery, including
short ones the sticky HMM deliberately skips.

The open data hides the ball mostly when it is dead (ball seen on ~15-22% of dead frames), which is
easier than the competition match (ball missing on 41% of graded frames, in play too).
