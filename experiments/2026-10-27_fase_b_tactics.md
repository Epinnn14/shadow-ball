# Fase B part 2: Transition Radar, Space Map, Shape Monitor, Stamina Monitor (2026-10-27)

`python run.py tactics` (after `v4` and `roles`), ~2 s. Outputs in `exports/` (derived, not committed):
transitions.parquet, transitions_summary.json, space_maps.npz, shape.parquet, shape_alerts.json,
stamina.parquet.

Only role-assigned slots are used (a team can show 12-13 tracklets at once: duplicates/ghosts).

## Transitions (open-play turnovers = direct H <-> A changes of the v4.1 labels)

| | ball wins | dangerous | reached final third | counter-press success 5 s (when THEY lost it) | pressers within 10 m |
| --- | --- | --- | --- | --- | --- |
| Barcelona (H) | 80 | 15 | 35% | 24% | 1.6 |
| Athletic (A) | 82 | 9 | 22% | 12% | 1.7 |

"Dangerous" = won outside the own third, <= 4 losers goal-side (keeper included), not regained in 5 s.
Median free space ahead of the ball at the turnover: 25 m to the nearest opponent.

## Shape (out of possession, first 15 min of each half = reference)

Line height (m from own goal): Barcelona 42.6 / 44.6, Athletic 37.8 / 36.4. Compactness ~14-15 m.
Barça in possession widens to 49 m (from 37 m). Alerts (11) are almost all Athletic's line dropping
8-22 m deeper, strongest from minute 75.

## Stamina

Fatigue Risk Score = 100 x (0.45 HSR drop + 0.25 distance drop + 0.15 top-speed drop + 0.15
minutes played), rates per minute of coverage, vs the role's own first 15 min, smoothed over 10 min.
Green < 35 <= amber < 55 <= red. 18 red blocks, mostly Barcelona centre-backs after minute 55 and
late-game Athletic midfielders.

## Limits (say these in the technical doc)

- A role is not a person: substitutions and swaps are invisible, so a "tired" role can be a fresh sub
  who plays differently. Live use needs player identity (auto-tagging at kickoff, Fase C).
- HSR depends on game state (a team defending deep runs less at high speed): risk is a prompt for
  the bench to look, not a diagnosis. Centre-backs have a small HSR baseline, so their ratio is noisy.
- Possession labels and the reconstructed ball carry their own errors into turnover locations.
