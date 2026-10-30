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

Training picks the GPU itself: CUDA (NVIDIA), MPS (Apple Silicon, used for the final models on a
MacBook M5) or CPU; `SB_DEVICE=cpu|cuda|mps` forces one.

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

## Demo (laptop + phone)

```bash
python run.py demo                      # replay clip, default 55'-70' -> exports/demo/clip.json
python run.py serve                     # prints the laptop and phone addresses
```

Before kick-off the coach picks a formation (18 shapes), types names and numbers and adds his own
player photos (kept on the laptop only; no photos are bundled). Names are matched to the tracked
players by position (Hungarian assignment), so the chosen formation may differ from the detected one.
The laptop then shows the full bench screen. The live pitch is kept plain (players, names, ball).
Below it, the **Shadow pitch** is the core of the concept (`sb/offball.py`, once per second): the
dangerous space each team controls (pitch control x a threat surface learned from the match), our
share of it ("space denied" while defending, vs our usual), and for at most three of our off-ball
players an arrow to the best position he could have reached in that second, with the share of the
dangerous space it wins back. With the ball, the pitch also measures **rest defence**: the share of
our own dangerous space we would still own if we lost the ball right now (validated: the opponent
reaches our final third within 15 s 6.1% vs 12.9% of the time, high vs low; the simple count of
players behind the ball does not predict it). When it is thin, amber cover arrows are shown.
Only moves worth 1.5%+ and already there a second earlier are shown,
so the pitch stays quiet while the shape holds. **Shadow Replay**: when the opponent enters our final
third after our space denial fell into its lowest 35% in the previous 10 s, the Shadow pitch freezes
for 7 s on that second (also on the phone) and the Copilot feed keeps it; the same moments for the
opponent show where they leave space. **Shadow Ball** (the uncertainty cloud of a reconstructed ball)
is drawn there too. Then two **simulation cards** (the off-ball model run forward, in the browser):
from a real second of the last 30 s, up to 4 of our players move together (each within 5 m), chosen
greedily so each move counts the ones already made. Defend = our weakest second while they had the
ball (space denied before -> after); Attack = our latest second with the ball (space owned before ->
after, and what it costs the rest defence). Each card loops now -> simulated. Without the off-ball
outputs they fall back to the 30 s heat maps. Then a fatigue map,
a Copilot feed with a mini-pitch per event, and movement per player with a heatmap. On top:
"Need to know", the three things that matter now, ranked from all modules (fatigue, counter-attacks,
the channel the opponent uses, pressure, space denial dropping, the last Shadow Replay, line height, a dangerous opponent, a chance);
a momentum chart (minutes with the ball in each final third); and attack channels (final-third
entries left/centre/right for both teams over 15 minutes). The phone also gets "Need to know". Two more cards: set pieces (every restart after a dead ball,
classified by where it is taken: corner, free kick in the final third, other free kick, throw-in,
goal kick; whether the team kept the ball 10 s later and reached the box) and 1v1 duels (for each of
our defenders, the opponent he meets most in our half over 10 minutes: how often that opponent is
goal-side of him and who wins the sprints). "Laporan" opens a two-page A4 report (print or save as
PDF) for half-time or the team meeting: the score and the usual match statistics per half and in total
(possession, number and length of possessions, chances created, counter-attacks, dangerous transitions,
final-third and box entries, long balls, ball wins, counter-press regains, corners, free kicks,
throw-ins, goal kicks, team distance and sprints), momentum, the three priorities and the advice, then
the maps. Before kick-off the coach can also edit each player's profile (positions he can play, foot, three
keywords); the **Player Recommender** ranks the bench for a role from position fit, the traits the
situation needs and the foot, and **Plan B** ranks the options (substitution, a deeper line, a back five
on the side they attack, the first-half counter-press, an overload where the space is) and shows the
effect it measured by moving our players in the last 30 s of tracking (their control of our third,
before / after). Everything the laptop shows is posted to `/api/snapshot` and written to
`exports/demo/decisions.json` for the LLM Bench Copilot; the squad profiles go to
`exports/demo/players.json`. Goals, chances, counter-attacks, box entries, long balls and set-piece types come from
Metrica's Smart Tagging; the rest from our pipeline. Shots are not reported: the data has no shot
events and the tactical camera often loses the ball in front of goal. A phone on the same Wi-Fi or on the laptop's
hotspot opens the printed address and gets the pitch (upright) plus movement per position, and
follows the laptop's clock. The clip is derived match data: it is served only from the laptop on
the local network and never uploaded. No internet or CDN is needed.

## Shadow Ball core: movement without the ball

```bash
python run.py offball                   # ~50 s: every off-ball player, every second of play
```

A pitch-control model (arrival times) weighted by a threat surface learned from the match gives one
objective for both teams: the share of the dangerous space a team owns. With the ball you want it;
without it you take it away ("space denied"). For every player off the ball, every second: his
contribution (what the team loses without him), what his last second of movement was worth, and his
**shadow**, the best position he could have reached. Validity: when the defending team denies the most
dangerous space, the attackers reach the final third within 10 s in 20.8% of moments, against 30.9%
when it denies the least (ball zone and team held fixed). See `experiments/2026-10-30_offball_shadow.md`.

## Third-party code

`games.py` and `evaluation/` are copied unchanged from the organisers' repository
(metrica-sports/more-than-a-hack-2027), MIT licence: see `evaluation/LICENSE-mtah2027`.
