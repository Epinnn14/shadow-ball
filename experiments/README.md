# Experiments

One file per experiment: `YYYY-MM-DD_name.md` containing the idea, configuration, public score
(sanity check only), number of possessions, and the decision (kept / dropped + reason).

| Date | Version | Idea | Public spellF1 | Possessions | Decision |
| --- | --- | --- | --- | --- | --- |
| 2026-10-22 | v0 | Organizers' baseline (w=50) | 0.3256 | 594 (public GT: 17 in 5 minutes) | Floor, never drop below this |
| 2026-10-22 | v1 | Dead ball + HMM (see 2026-10-22_v1_hmm.md) | 0.5125 (noise ±0.36) | 239, average 16.3 s | Fallback |
| 2026-10-24 | v2 | Ball reconstruction + v1 (see 2026-10-24_v2_ballnet.md) | = v1 without masking; with the ball hidden 0.444 vs v1 0.419 | 259, average 15.1 s | Fallback |
| 2026-10-27 | v3 | v2 + fouls/whistle (see 2026-10-27_v3_whistle.md) | 0.5091 (macroF1 0.855); hidden 0.445 (macroF1 0.797 vs v2 0.731) | 264, average 13.1 s, D 45% | Fallback |
| 2026-10-27 | v4 | v3 + ball in play from the restart kick (see 2026-10-27_v4_restart.md) | 0.5455 (macroF1 0.872); hidden 0.464 vs v3 0.445 (never worse) | 273, average 12.9 s, D 44.6% | Superseded by v4.1 |
| 2026-10-27 | v4.1 | Unseen restart + 0.4 s placed condition (see 2026-10-27_v4_1_restart_fix.md) | 0.5455 (macroF1 0.900); hidden 0.473 vs v4 0.464, never worse | 286, average 12.8 s, D 42% | **Current submission** |
| 2026-10-27 | Phase B | Position labels + movement statistics (see 2026-10-27_fase_b_roles_movement.md) | - | Barça 4-2-3-1 / 4-2-1-3, Athletic 4-4-2 / 4-5-1; 9.5-12 km per position | Used for analytics & UI |
| 2026-10-27 | Phase B (2) | Transition Radar, Space Map, Shape Monitor, Stamina Monitor (see 2026-10-27_fase_b_tactics.md) | - | 162 turnovers; counter-press success Barça 24% vs Athletic 12%; 11 shape alerts; 18 red stamina blocks | Used for UI & Phase C |
