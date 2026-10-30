# Shadow Ball core: off-ball movement and space denial (2026-10-30)

`python run.py offball` (after `v4` and `roles`), ~50 s for the whole match at 1 sample per second:
67,641 player-seconds, 3,591 team-seconds of play. Outputs (derived, not committed):
`exports/offball.parquet` (every off-ball player, every second: contribution, movement gain, shadow
position, Shadow score), `offball_team.parquet`, `offball_roles.parquet`, `offball_summary.json`.

## Model

- **Pitch control:** arrival time = 0.7 s reaction + distance at 5 m/s. Soft minimum per team
  (0.3 s), then a logistic of the difference between the teams (0.45 s). Like for like: every
  position is compared standing still.
- **Value:** a threat surface learned from this match. It is P(ball in the box within 10 s, same
  possession) by ball location, from both teams, both halves and every 5th frame of play. It is
  smoothed and blended with a distance-to-goal prior, seen from the team with the ball, and weighted
  towards the ball.
- **One objective for both teams:** J = sum(value x control) = the share of the dangerous space a
  team owns. The team with the ball wants it; the team without the ball wants to take it away
  ("space denied").
- **Per off-ball player each second:**
  - contribution = J(team) - J(team without him);
  - movement gain = J(actual) - J(staying where he was 1 s earlier);
  - shadow = the best of 16 reachable positions (rings of 2.5 m and 5 m around where he was);
  - Shadow score = the share of those reachable positions his real move beat (random = 50).

## Does space denial mean anything? (validity)

Test: moments with the ball outside the attackers' final third, split by ball zone x defending team.
In each stratum, top vs bottom quartile of the defending team's space denial. Outcome: the attackers
reach the final third within 10 s.

| Defending | High denial | Low denial | Moments |
| --- | --- | --- | --- |
| Barcelona | 14.8% | 34.1% | 1,159 |
| Athletic | 25.2% | 28.5% | 1,581 |
| All (weighted) | 20.8% | 30.9% | 2,740 |

When Barcelona's shape off the ball denied the most dangerous space, Athletic got into the final
third 2.3x less often. The effect has the same sign in 5 of the 6 strata. The per-second Shadow score
is NOT a predictor: defenders score high when they run back, which happens when the attack is already
progressing. It rates movement choices, it does not forecast danger.

## Findings for the coach (and the presentation)

- Barcelona's space denial fell from 80.6% (1st half) to 75.9% (2nd half). Athletic's rose from
  71.8% to 74.2%. This matches the fatigue signal on the Barcelona centre-backs after 55'.
- Denial is carried by the back four, at 22-34 permille of the danger per player. Without the ball
  the midfielders contribute 4-12: the defenders behind them cover the same space.
- Off-ball movement choices (Shadow score):
  - Barcelona's two holding midfielders score 50.6 / 51.2, no better than moving at random;
  - Athletic's central midfielders score 59-60, the best on the pitch.
  - This is where the Shadow positions are most worth showing to the players.
- The team-level shadow gap (sum of every player's best-minus-actual) does not predict danger
  either: it grows with the space there is to win, not with mistakes.

## Limits

- One match, no event data: the threat surface comes from 75 minutes of box entries, smoothed.
- Players are tracklets with roles, not identities. Positions only: no body orientation, no pass
  model, so marking a player and blocking a lane are only seen through space.
- Moving one player while the others stay put ignores how they would react (a one-step best response).
