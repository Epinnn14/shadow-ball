# Broadcast tracking as extra ball evidence: feasibility probe (2026-10-29)

`python scripts/broadcast_probe.py`

Question: is all the provided data used? The tactical tracking is (ballnet trains on every frame with a
visible ball, both halves, cross-validated); the public 5-minute GT is deliberately not used for
training. The broadcast tracking had never been used: it is not synchronised and has no mapping table.

## Result

- Alignment works: both ATD files are in pitch coordinates, so matching player positions finds the
  tactical frame of a broadcast frame. The offset is constant within each half (tactical = broadcast
  + 4015 in half 1, + 26919 in half 2), refined by +-12 frames; 87% of broadcast frames with at least 6 visible players match
  (< 1.5 m); the rest are replays, close-ups and cuts.
- Where both cameras see the ball they agree: median 0.81 m apart (90th percentile 5.4 m).
- But the broadcast mostly sees the ball when the tactical camera already does: it could fill only
  about **8%** of the missing graded tactical ball frames.

## Decision

Small but real: a v5 could use the broadcast ball where it fills a gap (with its own ~1 m error) as
seen-ball evidence instead of the ballnet estimate. Expected effect on spellF1 is small; to be tried
only after Phase C, measured with the leak-free mask test. Videos remain unused: a vision ball
detector on the tactical video is the only way to recover more, and costs far more than it is likely
to return before the deadline.
