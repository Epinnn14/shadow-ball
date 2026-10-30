# Rest defence: protection while we have the ball (2026-10-30)

Part of `python run.py offball` (the run now takes ~52 s instead of ~48 s). New columns:
`offball_team.parquet` gets `rest` and `behind`; `offball.parquet` gets `rest_gap`, `cover_x` and
`cover_y` for the players of the team with the ball. The validation is in
`offball_summary.json["rest_defence"]`.

## Idea

The space the team without the ball denies is only half of off-ball work. While WE have the ball,
the players who are not on it also decide what happens if we lose it. Rest defence = the same J as
the core model (pitch control x the learned threat surface), but valued from the OPPONENT's
attacking side, as if the ball were lost right now where it is. It is the share of our own
dangerous space we would still own at the turnover.

Per off-ball player of the team in possession, the **cover shadow** is the reachable position
(same 16 candidates) that raises rest defence most. `rest_gap` = rest defence at the cover shadow
minus rest defence at his actual position.

## Does it mean anything? (validity)

**Test 1, every second in possession.** Seconds are split by ball zone (thirds, in the attacking
frame of the team with the ball) and by team. Within each stratum, we compare the top and bottom
quartile of rest defence. Outcome: the opponent carries the ball into our final third within 15 s.

| Ball | In possession | Seconds | High rest defence | Low rest defence |
|---|---|---|---|---|
| own third | Athletic | 531 | 9.8% | 28.6% |
| own third | Barça | 675 | 9.5% | 15.4% |
| middle third | Athletic | 633 | 12.6% | 18.9% |
| middle third | Barça | 906 | 2.2% | 4.0% |
| final third | Athletic | 260 | 1.5% | 6.2% |
| final third | Barça | 584 | 0.0% | 6.2% |
| **weighted** | | 3,589 | **6.1%** | **12.9%** |

The difference goes the same way in all 6 strata: about 2x. The naive count of players goal-side of
the ball does NOT work. Its top quartile has 12.4% and its bottom quartile 7.0%, the wrong way:
deep players often just mean a deep ball. Where players stand relative to the danger matters, not
how many are behind the ball.

**Test 2, the real turnovers (n = 162, small).** We take rest defence in the last second before the
loss and split it at the median within the turnover zone. The winner reached the final third after
33.3% of low-rest-defence losses and 23.5% of high-rest-defence losses (correlation -0.36).

## In the demo

- **Shadow pitch, in possession:**
  - The KPI "Rest defence" shows the value "if lost now", against our usual (median 90%).
  - Below usual - 8 points ("thin", ~20% of our possession seconds in the clip), the pitch shows 2
    amber cover arrows plus the best attacking move. It paints OUR dangerous space instead.
- **Shadow Replay, kind `rest`:**
  - Trigger: a lost ball followed by a final-third entry within 10 s, when rest defence in the
    second before the loss was below the team's median.
  - It replaces the `denial` moment for the same entry.
  - In 55'-70' there are 3 such moments for Athletic (counter-attack chances for us) and none for us.
- **Need to know:** "Thin rest defence: keep X back" fires when our rest defence over the last 2
  minutes of possession is 6+ points under usual.
- `decisions.json` gets `rest_defence_pct`, `rest_defence_thin`, cover moves and replays.

## Limits

- One match.
- The turnover test is small.
- Cover moves are judged ONLY for rest defence. Moving a full-back back costs attacking width,
  and the model does not weigh that trade-off. The coach does.
