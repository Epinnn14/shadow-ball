# Shadow Ball (personal project by epinnn)

A free football coaching assistant: website on GitHub Pages (https://epinnn14.github.io/shadow-ball/,
built into docs/ by scripts/build_site.py) + Python tools (tracking from video, possession, off-ball).
Started as Látigo AI's More Than A Hack 2027 entry (did not reach the top 20, Nov 2026); that code is
kept as history. The competition match (`--game BAR-ATH`, default) must keep regenerating the
submitted file (sha256 c3eb7ed6…, 275 possessions): do not change v1-v4 / ballnet behaviour or
`models/ballnet.pt` for it.

## Website (demo/ -> docs/)

- Pages: index.html (home, home.js/home.css), playground.html (tactics board), replay.html (bench
  replay: app.js; `#own` opens a local clip.json; SB_STATIC on static hosts), calibrate.html.
- Shared: style.css (design tokens at the top: navy ink, one violet accent = the Shadow Ball model
  layer, Outfit + Work Sans, flat cards, only the pitch lifted), theme.js (Auto/Light/Dark),
  i18n.js + i18n-id.js (EN/ID: exact phrases + regex patterns applied to rendered text; edit
  data_src/i18n_id.py, then scripts/build_i18n.py; [data-no-i18n] opts out), pitch.js (board
  drawing), model.js (pitch control x threat, tests/model_test.js).
- Public site: open Metrica data only, players anonymous; credit "by epinnn"; no logos/photos.
- Rebuild: build_playground_data.py, build_i18n.py, build_site.py (docs/ is committed).

## Open games (portfolio)

```
python run.py --game METRICA-2 cache|ball-predict|v4|reference|score|roles|tactics|offball|demo|serve
python scripts/build_site.py --game METRICA-2   # static site/ (SB_STATIC: no /api, no print)
```

- `sb/paths.py` game catalog; `SB_GAME` must be set before importing `sb` (run.py does it from `--game`).
  Open games write to `cache/<game>/`, `submissions/<game>/`, `exports/<game>/`.
- `sb/reference.py` reference labels from Metrica events, for MEASURING only. Set-piece hints are off
  on open games (they would leak the reference).
- Open games show players as "Player <shirt>" (`demo.open_game_squad`); never real names or photos.
  Attribute the data: Metrica Sports sample data, github.com/metrica-sports/sample-data.
- `sb/phase2.py` half-time screen (plan, possession & threat, heatmaps, passing network from events)
  and chemistry; every card uses only what was known at that moment. See experiments/2026-11-20_*.md.
- Hosted demo (open game 2 + playground): claude.ai artifact 8kWbpCy3Ty2h1uNdrMZYBq. Never host BAR-ATH.
- Video input (`sb/video.py`, `run.py video frame|track`, `demo/calibrate.html`, extra deps in
  requirements-video.txt): writes cache/video-<name>/ (+ meta.json) that registers game VIDEO-<NAME>.
  `paths.VIDEO`, `paths.ANONYMOUS` (open or video: players by number), `paths.H2` (minute half 2 starts;
  a video without --second-half is split into two equal parts). Tested only on synthetic video
  (scripts/synthetic_video.py + video_eval.py). Never run it on the competition video.
- Playground: demo/playground.html + playground.js, model in demo/model.js (same pitch control x threat
  as offball, tests/model_test.js), squads demo/laliga.js from data_src/laliga_2026_27.txt, threat
  surface demo/threat.js (mean of the 3 open games); `scripts/build_playground_data.py` rebuilds both.
- UI "soft realism": light + dark tokens at the top of demo/style.css (dark under prefers-color-scheme
  and [data-theme]); demo/theme.js = Auto/Light/Dark toggle; canvas text off the pitch uses tok('--x').

## Phase 1 (competition match)

Team of 5 (K lead, J, F, R, N). This part produces the possession file for Phase 1:
for every tactical video frame, the label H (Barcelona in possession), A (Athletic), D (dead ball),
or X (no answer). Ranking uses `spellF1` (whole possessions), tie-break `macroF1`.

## Commands

```
pip install -r requirements.txt
python run.py cache                 # parse ATD once -> cache/tactical_atd.npz (~20 s)
python run.py check                 # check data
python run.py baseline --window 50  # v0, must match the organizers' baseline 100%
python run.py v1                    # v1, fallback
python run.py ball-train            # train ballnet on EXTERNAL data only (Metrica open sample games 1+2, early stop on 3)
python run.py v2                    # v2: v1 + reconstructed ball (fallback)
python run.py v3                    # v3: v2 + fouls/whistle (fallback)
python run.py ball-predict          # unseen ball from the FROZEN weights models/ballnet.pt (CPU, deterministic, no training)
python run.py v4                    # v4.3: v4.2 rules + ballnet trained on external data -- CURRENT SUBMISSION (prints SHA-256)
python run.py export                # exports/possession.csv + exports/ball.parquet (DO NOT commit)
python run.py roles                 # Phase B: position labels + movement -> exports/roles.parquet, movement.parquet
python run.py tactics               # Phase B: transitions/counter-press, space map, shape, stamina -> exports/
python run.py offball               # CORE: off-ball movement, space denial, shadow positions -> exports/offball*
python run.py demo                  # replay clip for the web demo -> exports/demo/clip.json (DO NOT upload)
python run.py serve                 # demo on the laptop (full) + phone on the same Wi-Fi/hotspot (pitch + movement)
python scripts/restart_ab.py        # A/B of the old vs new restart rule (ball hidden)
python scripts/mask_test.py         # sanity check only (public GT): never used to pick a version
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
- `models/ballnet.pt` — frozen ballnet weights (sha256 7e408f52…, step 50,500, 3 Nov), trained on EXTERNAL data only (v4.3), COMMITTED (organisers
  allowed it, 2 Nov): the submission is regenerated with `ball-predict` + `v4` without retraining.
- `sb/external.py` — loader for the open Metrica Sports sample data (`external/metrica-sample-data`, git-ignored),
  same attributes as `Tracking`; `concat` puts home players in the first slots and away in the rest.
- `sb/ballnet.py` — ball reconstruction model (small transformer over the player set, self-supervised
  with synthetic gaps drawn from the real gap distribution; outputs position + uncertainty).
- `sb/v2.py` — v1 + reconstructed ball for team-control evidence (dead ball still uses the real ball).
- `sb/v3.py` — v2 + stoppages without the ball going out (whistle inferred from collective slowdown,
  10 s activity, ball placed inside the pitch).
- `sb/v4.py` — v3 + 5 s of "in play" evidence after a visible restart kick (v4.1: unseen restarts); v4.2: dead
  before the kick-off (`features.kickoff_frame`: both teams still in own halves, then a burst; ball not used) when a
  half's graded window opens > 10 s before it (half 2: graded from 110,808, kick-off ~113,742).
- `sb/roles.py` — per-frame position labels (Hungarian matching to the team's out-of-possession shape).
- `sb/movement.py` — distance, HSR, sprints, top speed, average position, heatmap per position.
- `sb/tactics.py` — Transition Radar, Space Map, Shape Monitor, Stamina Monitor (Fatigue Risk Score).
- `sb/demo.py` — demo clip data; `demo/` — web app (HTML/CSS/JS with no libraries, runs offline).
  Laptop = full screen & time controller; screen <900 px (phone) = vertical pitch + movement,
  follows the laptop's time via /api/state. `?mode=lead|follow` forces a role, `?setup=0` skips setup.
  `demo/data.js` = 18 formations + starting squads (editable by the coach). Setup = FotMob-style card: position
  first, then the player (picker: squad search ranked by fit, or a new name; "Fill one by one"); optional opponent
  card (`lineup.opp`, typed or pasted). Line-up + photos are saved via /api/lineup to `exports/demo/lineup.json`
  (local; players.json gets the opponent names without photos). All views: our team attacks to the right/up.
  Live "Shadow ratings" card: both XIs, rating = 6.5 + 0.45 x (Shadow score - 55) [+-1.8] + 1.2 x (space held vs
  position-family mean - 1) [+-1.2], from `ratings`/`rating_ref` in clip.json (completed minutes only).
  The live pitch is plain (players, names, ball). Below it the Shadow pitch (the core, `shadow` in clip.json from
  `sb/offball.py`): dangerous space each side controls, our space denied vs usual, max 3 arrows to the best reachable
  position (>= 15 per mille, held 2 s), and Shadow Replay (7 s freeze, also on the phone) when the opponent enters our
  final third after our denial fell into its lowest 35% (kind `denial`) or after we lost the ball with thin rest
  defence (kind `rest`). In possession: "Rest defence" KPI; when thin (usual - 8 points) 2 amber cover arrows.
  Run `python run.py offball` before `python run.py demo`.
  Also: Shadow Ball (sigma cloud, on the Shadow pitch). Attack/Defend cards = simulations (`simulateUnit` in app.js:
  greedy unit move of up to 4 players, 16 candidates within 5 m, same model; Defend = weakest denial second of the
  last 30 s, Attack = latest possession second + rest-defence cost; loops now -> simulated). The model has no
  pressing/offside value, so defensive simulations lean towards dropping deeper: say so when presenting.
  "Need to know" (3 automatic priorities, laptop + phone), momentum per minute and attack lanes
  (final-third entries per side) from `momentum`/`entries` in clip.json.
  Set pieces (`setpieces`: type + team from Smart Tagging, position from the visible ball; throw-in team from
  who has possession after the dead ball), 1v1 duels (computed in the browser, 10 min), score from the GOALS tag.
  "Report" button = 3 A4 pages (print/PDF): match statistics for half 1 / half 2 / total
  (`match_events`, `runs`, `team_running` in clip.json) + momentum + priorities; page 2 maps; page 3 Shadow Ball
  (space denied / rest defence per 5 min from `shadow.trend`, pressing traps, Shadow ratings, space leaks, replays).
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
  Rest defence (team WITH the ball): the same J valued from the opponent's side, as if the ball were lost now;
  cover shadow per player (`rest_gap`, `cover_x/y`). Validated: entry against in 15 s 6.1% vs 12.9% (6/6 strata);
  the count of players behind the ball fails.
- `sb/pressing.py` — Pressing Trap Map (run by `offball`): per defending second, press = 2+ within 8 m; regain 5 s /
  box 10 s, press vs hold per zone (4 bands x 3 lanes, defenders' frame). Not causal. `offball.leak_blocks` = Space
  leaks: gap per role per 5-min block vs its first 15 min (fatigue score does not predict it, r ~ 0); demo uses 10 min.
- `scripts/broadcast_probe.py` — broadcast tracking aligned to tactical (offsets 4015 / 26919 frames, matched by
  player positions); fills ~8% of the missing ball frames. Candidate for a v5 after Phase C.
- `sb/export.py` — contract files in `exports/` (derived data, not committed).
- `scripts/mask_test.py` — tests v1/v2/v3/v4 with the ball hidden ~41% in the public window.
- PyTorch 2.14.1 is pinned in requirements.txt (the PyPI CPU build reproduces the submission; a CUDA build from
  pytorch.org is only needed for fast training), needs Python <= 3.14.
  The submission model was trained on the RTX laptop (CUDA, 40k steps, 30 Oct); the M5 (MPS) works too.
  Retraining changes the CSV hash: adopt new weights only if the mask test improves, then re-check the hash on 2 machines.
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

- RULES CLARIFICATION (organisers, 3 Nov 2026, overrides everything earlier): no checking output against the
  video; no hand labels on this game; NO UPLOADING THE PROVIDED DATA TO AI SERVICES (an AI assistant must not
  read or run the match data: the team runs everything with data locally); no training/fitting/calibration on
  the ground truth or the video; any training or tuning uses EXTERNAL data only. Allowed: automatic checks
  with the provided data, looking at data/video to understand possession, intermediate files, datasets we
  have the rights to use.

- Labels MUST be produced by the algorithm. No manual corrections to the submission.
- The public 5-minute GT is only for checking pipeline correctness, NOT for choosing parameters
  (the organizers showed that it picks the wrong version). The private GT is never used.
- Match data and anything derived from it is never committed; the final repo must be public.
- Every change: tests pass, `run.py validate` passes, record the score in `experiments/`.
- Plan before writing large code; keep changes small and testable.

## Contract files between members (see the team document)

`teams.parquet` (F), `ball.parquet` (K), `possession.csv` (K), `roles.parquet` (J),
`transitions.parquet` (J), `players.json` (R), `decisions.json` (R).
