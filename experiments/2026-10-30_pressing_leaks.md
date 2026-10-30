# Pressing Trap Map and Space leaks (2026-10-30)

Both now run inside `python run.py offball`, which takes about 53 s. They write
`exports/pressing.parquet`, `pressing_summary.json`, `offball_leak.parquet` and
`offball_summary.json["fatigue_vs_denial"]`. All of these files are derived data and are not
committed.

## Pressing Trap Map (`sb/pressing.py`)

We take one row per second of play for the team without the ball. A second counts as a **press**
when 2 or more of its outfield players are within 8 m of the ball. That is 30% of defending
seconds. For each second we record two outcomes:

- the defenders win the ball back within 5 s;
- the attackers get the ball into the defenders' box within 10 s.

Seconds are grouped into zones in the defenders' attacking frame: 4 bands × 3 lanes. In each
zone we compare seconds with a press against seconds without one.

This is NOT a causal effect. Teams press when the ball is close, and the ball is close in duels.
What the comparison shows is what happened after pressing in a zone, next to what happened when
the team held its shape there.

| Defending | Band | Hold: won back / box | Press: won back / box | Seconds (hold / press) |
|---|---|---|---|---|
| Barça | our third | 38.2% / 58.6% | 27.8% / 46.3% | 152 / 108 |
| Barça | our half | 29.1% / 7.6% | **18.2% / 11.9%** | 172 / 143 |
| Barça | their half | 26.7% / 6.2% | 27.4% / 5.5% | 243 / 73 |
| Barça | their third | 17.0% / 0.5% | **27.8% / 2.2%** | 436 / 90 |
| Athletic | their own third | 17.6% / 33.7% | 24.4% / 45.4% | 329 / 262 |
| Athletic | their half | 9.9% / 5.6% | 21.3% / 7.7% | 252 / 169 |
| Athletic | our half | 17.1% / 6.0% | 27.0% / 4.5% | 368 / 111 |
| Athletic | our third | 10.9% / 1.4% | 25.6% / 0.9% | 576 / 117 |

Reading for the bench: Barça's high press works. In the final third it wins the ball back 28%
of the time vs 17% when holding. Pressing in our own half does the opposite: 18% vs 29%, and the
opponent gets into our box more often (12% vs 8%). Athletic's press works in every zone.

The demo builds this table from kick-off up to the current time. Each zone's difference is
shrunk by n / (n + 20). A zone is drawn as a trap or a leak only with 12+ seconds on each side.

## Space leaks (fatigue → denial, `offball.leak_blocks`)

We measure the space each position leaves while defending, per position and per 5-minute block.
This is the gap: the best reachable position minus the actual one, the same as the Shadow pitch.
Each block is compared with the same position's first 15 minutes of that half.

Does running data tell us who leaks space? Across 409 role-blocks, the Fatigue Risk Score does
not predict a drop in held space (r = -0.005). Its link to the gap is weak (r = 0.16). The 18 red
blocks do leave more (median gap 15.3 vs 5.5 green), but that is a small sample. So Shadow Ball
measures the space directly instead of trusting the running data.

Single 5-minute blocks are noisy: the same RCB scores 76, 25, 85 and 35 per mille. The demo
therefore uses the last 10 minutes, two blocks weighted by seconds. A position is flagged when it
leaves at least 1.5× its early space AND at least 0.8 more points of dangerous space per second.

In the clip, Cubarsí and García are red on fatigue but still hold their space (0.9×). Plan B now
says so ("but still holding his space") and ranks that substitution lower. A position that leaks
AND is tiring becomes the first substitution.

## Limits

This is one match, the pressing comparison is not causal, and the leak flag has not been
validated against outcomes.
