# Shadow Ball — Phase 1 (More Than A Hack 2027)

Team of 5 (K lead, J, F, R, N). This repo produces the possession file for Phase 1:
for every tactical video frame, the label H (Barcelona in possession), A (Athletic), D (dead ball),
or X (no answer). Ranking uses `spellF1` (whole possessions), tie-break `macroF1`.

## Commands

```
pip install -r requirements.txt
python run.py cache                 # parse ATD once -> cache/tactical_atd.npz (~20 s)
python run.py check                 # check data
python run.py baseline --window 50  # v0, must match the organizers' baseline 100%
python run.py v1                    # v1, fallback
python run.py ball-train --cv       # v2: train the ball reconstruction model (GPU), cross-validation by half
python run.py v2                    # v2: v1 + reconstructed ball (fallback)
python run.py v3                    # v3: v2 + fouls/whistle (fallback)
python run.py v4                    # v4.1: v3 + ball in play from the restart kick -- CURRENT SUBMISSION
python run.py export                # exports/possession.csv + exports/ball.parquet (DO NOT commit)
python run.py roles                 # Phase B: position labels + movement -> exports/roles.parquet, movement.parquet
python run.py tactics               # Phase B: transitions/counter-press, space map, shape, stamina -> exports/
python run.py offball               # CORE: off-ball movement, space denial, shadow positions -> exports/offball*
python run.py demo                  # replay clip for the web demo -> exports/demo/clip.json (DO NOT upload)
python run.py serve                 # demo on the laptop (full) + phone on the same Wi-Fi/hotspot (pitch + movement)
python scripts/restart_ab.py        # A/B of the old vs new restart rule (ball hidden)
python run.py ball-train --train-half 2 && python scripts/mask_test.py   # leak-free v1 vs v2 test
python run.py score                 # score every CSV in submissions/ (public 5-minute GT)
python run.py validate FILE         # organizers' official validator
python -m pytest -q                 # quick tests, no data needed
```

Data is looked up in: `MTAH_DATA_DIR` -> `./data` -> `../Dataset Drive`.

## Structure

- `sb/paths.py` — all paths and constants (N_FRAMES, HALVES, PITCH). Do not write paths anywhere else.
- `sb/atd.py` — ATD parser + `Tracking` (indexed by video frame, positions in metres).
- `sb/submission.py` — write/validate/score submission files.
- `sb/baseline.py` — v0 (nearest player + majority window).
- `sb/features.py` — per-frame evidence (team activity, ball out until restart, team distance to the ball).
- `sb/tagging.py` — Smart Tagging to video frames.
- `sb/hmm.py` — 3-state HMM (H/A/D) + Viterbi.
- `sb/v1.py` — v1: all parameters in `PARAMS`, each with its physical justification.
- `sb/ballnet.py` — ball reconstruction model (small transformer over the player set, self-supervised
  with synthetic gaps drawn from the real gap distribution; outputs position + uncertainty).
- `sb/v2.py` — v1 + reconstructed ball for team-control evidence (dead ball still uses the real ball).
- `sb/v3.py` — v2 + stoppages without the ball going out (whistle inferred from collective slowdown,
  10 s activity, ball placed inside the pitch).
- `sb/v4.py` — v3 + 5 s of "in play" evidence after a visible restart kick.
- `sb/roles.py` — per-frame position labels (Hungarian matching to the team's out-of-possession shape).
- `sb/movement.py` — distance, HSR, sprints, top speed, average position, heatmap per position.
- `sb/tactics.py` — Transition Radar, Space Map, Shape Monitor, Stamina Monitor (Fatigue Risk Score).
- `sb/demo.py` — demo clip data; `demo/` — web app (HTML/CSS/JS with no libraries, runs offline).
  Laptop = full screen & time controller; screen <900 px (phone) = vertical pitch + movement,
  follows the laptop's time via /api/state. `?mode=lead|follow` forces a role, `?setup=0` skips setup.
  `demo/data.js` = 18 formations + starting squads (editable by the coach). Line-up + photos are saved via
  /api/lineup to `exports/demo/lineup.json` (local). All views: our team attacks to the right/up.
  The live pitch is plain (players, names, ball). Below it the Shadow pitch (the core, `shadow` in clip.json from
  `sb/offball.py`): dangerous space each side controls, our space denied vs usual, max 3 arrows to the best reachable
  position (>= 15 per mille, held 2 s), and Shadow Replay (7 s freeze, also on the phone) when the opponent enters our
  final third after our denial fell into its lowest 35%. Run `python run.py offball` before `python run.py demo`.
  Also: Shadow Ball (sigma cloud, on the Shadow pitch), 30 s attack/defend suggestion map.
  "Need to know" (3 automatic priorities, laptop + phone), momentum per minute and attack lanes
  (final-third entries per side) from `momentum`/`entries` in clip.json.
  Set pieces (`setpieces`: type + team from Smart Tagging, position from the visible ball; throw-in team from
  who has possession after the dead ball), 1v1 duels (computed in the browser, 10 min), score from the GOALS tag.
  "Report" button = 2 A4 pages (print/PDF): match statistics for half 1 / half 2 / total
  (`match_events`, `runs`, `team_running` in clip.json) + momentum + priorities; page 2 maps.
  Shots are NOT in the data (no events, the ball is often invisible in front of goal): use "chances created".
  `demo/decide.js` = pure decision logic (needsFor, recommend, planB), tested by `tests/decide_test.js`
  (run through pytest when node is installed). Player profiles (pos, foot, 3 keywords) in `demo/data.js`,
  edited in the setup. Plan B effects are simulated in app.js (`theirControl`: nearest-player control of our
  third over the last 30 s while the opponent has the ball, our players moved as the option says); shape
  options are only proposed when they help by 2+ points. Server: `/api/snapshot` -> `exports/demo/decisions.json`
  (for N's Bench Copilot), `/api/lineup` -> `lineup.json` + `players.json`.
- `sb/offball.py` — THE CORE (focus of the concept): movement without the ball. Pitch control (arrival
  times, soft-min per team) x threat surface learned from the match (P(box within 10 s)) = J, the share of
  the dangerous space a team owns; same objective with and without the ball ("space denied"). Per off-ball
  player per second: contribution, movement gain, shadow (best of 16 reachable positions), Shadow score
  (share of reachable moves beaten, random = 50). `python run.py offball`. Validated: high space denial ->
  20.8% vs 30.9% final-third entries in 10 s (stratified). Shadow score rates movement, it does NOT predict danger.
- `scripts/broadcast_probe.py` — broadcast tracking aligned to tactical (offsets 4015 / 26919 frames, matched by
  player positions); fills ~8% of the missing ball frames. Candidate for a v5 after Phase C.
- `sb/export.py` — contract files in `exports/` (derived data, not committed).
- `scripts/mask_test.py` — tests v1/v2/v3/v4 with the ball hidden ~41% in the public window.
- PyTorch is installed separately (CUDA build from pytorch.org), needs Python <= 3.14.
  Final max-performance training on the MacBook M5 (MPS, automatic); RTX for quick experiments.
  `SB_DEVICE=cpu|cuda|mps` forces the device.
- `games.py`, `evaluation/` — copies of the organizers' code (MIT), DO NOT modify.
- `experiments/` — experiment notes (configuration + scores), one file per experiment.
- `submissions/`, `cache/`, `data/` — not committed.

## Data facts to remember

- Video frames 0..199318 = submission rows. ATD `frame_id` starts at 1: `video_frame = frame_id - 1`.
- Scored frames: half 1 11185..90651, half 2 110808..190197. Write X outside these.
- The 46 track slots are tracklets, not people; identities can swap. The team per slot IS in the XML metadata
  (`Tracking.teams`: 0 = home/H, 1 = away/A).
- The ball is not visible in ~41% of scored frames. The ball has no speed in the file (always NaN).
- Coordinates are normalized 0-1; `Tracking` already converts them to metres (105.3 x 68.0).
- Smart Tagging: time in seconds from tactical frame 0, `frame = round(seconds * 25)`; labels are noisy.

## Possession rules (CHALLENGE.md)

- Sticky possession: while the ball is contested/loose, it stays with the last team in control.
- Possession changes only when the opponent gains control (not a touch, deflection or aerial duel).
- Dead ball = D, nobody's possession.
- X in scored frames: the spellF1 scorer fills it with the previous label in the same half.

## Working rules

- Labels MUST be produced by the algorithm. No manual corrections to the submission.
- The public 5-minute GT is only for checking pipeline correctness, NOT for choosing parameters
  (the organizers showed that it picks the wrong version). The private GT is never used.
- Match data and anything derived from it is never committed; the final repo must be public.
- Every change: tests pass, `run.py validate` passes, record the score in `experiments/`.
- Plan before writing large code; keep changes small and testable.

## Contract files between members (see the team document)

`teams.parquet` (F), `ball.parquet` (K), `possession.csv` (K), `roles.parquet` (J),
`transitions.parquet` (J), `players.json` (R), `decisions.json` (R).
