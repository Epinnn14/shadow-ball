# Phase B — position labels + movement statistics

`python run.py roles` -> `exports/roles.parquet`, `exports/formations.json`,
`exports/movement.parquet`, `exports/heatmaps.npz` (derived data: DO NOT commit).

## How it works (sb/roles.py, sb/movement.py)
- Coordinates are normalized per team per half: the team always attacks towards +x, the team's LEFT side = small y.
  Checked with the homography: y = 0 is the far touchline (top of the tactical camera image), and the team
  attacking to the camera's right has the far touchline on its left side.
- Goalkeeper: the deepest player, < 25 m from their own goal and >= 5 m behind the next player.
- The 10 outfield players are matched each frame to the 10 slots of the team's average shape (Hungarian algorithm,
  positions relative to the team centroid; in the style of Bialkowski et al. 2014). Robust to swapped track IDs.
- The shape that assigns the NAMES is fitted only on frames when the team is NOT in possession (from v4.1):
  in attack the full-backs push up and the team can look like 2-3-5; in defence the base positions are visible.
- Lines: defenders = the 3/4/5 deepest players, cut at the largest depth gap (a back four is given a
  3 m advantage); the rest are split at every gap >= 5 m (so 4-2-3-1 and 4-4-1-1 are recognized).
- Names: defenders LB/CB/RB (LWB/RWB if 5); midfielders LM/RM (width), CDM/CM/CAM (depth);
  forwards LW/RW (width), ST (CF for the deeper of two central forwards).
  Duplicate names get a side: LCB/RCB, LCDM/RCDM, LCM/CM/RCM.
- Movement per position per 5 minutes: distance, high-intensity running (> 19.8 km/h), sprints
  (> 25.2 km/h for >= 1 s), top speed (99th percentile), average position, coverage;
  21 x 14 heatmap per position per half. Speeds > 11 m/s are treated as tracking glitches.

## Results

| Team / half | Formation out of possession |
| --- | --- |
| Barcelona half 1 | 4-2-3-1 |
| Athletic half 1 | 4-4-2 |
| Barcelona half 2 | 4-2-1-3 |
| Athletic half 2 | 4-5-1 |

Sanity check (no ground truth): outfield players 9.5-12 km per position over the match,
top speed 25-31 km/h, role coverage 86-94% of frames. Goalkeepers only 19-26% (the tactical camera
often does not show the goal area) -> goalkeeper statistics cannot be trusted.

## Limits
- Label = tactical role in the average shape, not the player's official position; no player names.
- Barça half 2 was briefly read as 5-1-1-3 before the back-four advantage was raised from 2 to 3 m:
  a borderline case (defensive midfielder dropping between the centre-backs).
- Distance is a LOWER estimate when a player is lost from tracking (see the `coverage` column).
