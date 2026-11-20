# Video input: tracking from a match video (2026-11-21)

`sb/video.py`, `python run.py video frame|track`, calibration page `demo/calibrate.html`.
Detector YOLO (ultralytics, COCO person / sports ball) or `blobs` (non-grass shapes on the pitch,
no model); image -> pitch from 4+ clicked landmarks; `--camera moving` follows pan/zoom by matching
background features to a keyframe; pitch-space tracker; teams by shirt colour; same cache format
as the competition, so possession, off-ball and the demo run unchanged.

The competition video is never used: it is licensed for the competition only.

## Test on synthetic video with known truth

`scripts/synthetic_video.py` renders open Metrica game 2 tracking (the truth) through a virtual
camera: textured pitch, lines, players as shaded figures in kit colours, keepers in their own
colours, a referee who is NOT in the truth, the ball. The calibration file is made from the true
camera at the first frame (as if clicked). `scripts/video_eval.py` matches detections to the truth
per frame (Hungarian, 2 m).

| Video | Detector | Recall 2 m | Precision 2 m | Median error | p90 | Team accuracy | Ball seen (truth 0.81) | Ball median error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 40 s, static wide camera | blobs | 0.865 | 0.985 | 1.15 m | 1.64 m | 0.959 | 0.65 | 0.39 m |
| 40 s, moving (panning) camera | blobs | 0.864 | 0.939 | 0.33 m | 0.98 m | 0.962 | 0.54 | 0.50 m |
| 6 min, static wide camera | blobs | 0.892 | 0.978 | 1.05 m | 1.55 m | 0.912 | 0.65 (truth 0.75) | 0.32 m |

- The static camera is far away (players ~12 px tall): most of its error is a 0.9 m bias towards
  the far touchline, 1-2 px of the foot point lost to blur and the morphological clean-up.
- Moving camera: matching each frame to a keyframe (not to the previous frame) was the fix; frame to
  frame chaining drifted (recall 0.57, precision 0.59 before).
- Ball: bright blobs on painted lines, on the centre / penalty spots, or that never move are
  rejected; the ball must move less than 1.4 m per frame from where it was.
- YOLO runs (smoke test) but cannot be judged here: the cartoon figures are not people to it.
  It still needs a test on real footage that we have the right to use.

## Possession from video (6 min synthetic, v4 unchanged)

Against the event-based reference for the same 6 minutes of game 2: macroF1 0.43 from the video
tracking vs 0.72 from the true tracking. H 0.66 / A 0.62 / D 0.00 F1. Dead balls are not found
because in this footage the ball is hidden whenever it is dead (as in Metrica's data) and is also
missed on 35% of live frames, so "ball not seen" no longer means "ball dead". Better ball
detection, or a dead-ball cue from the video itself (players walking, the ball held for a throw-in),
is the next step.

## Use

```
pip install -r requirements-video.txt
python run.py video frame match.mp4 --at 30
# demo/calibrate.html: load the still, click 4+ landmarks, save calib.json
python run.py video track match.mp4 --calib calib.json --name my-match --camera moving --preview check.mp4
python run.py --game VIDEO-MY-MATCH ball-predict   # then v4, roles, tactics, offball, demo (printed)
```

Without `--second-half` a video is analysed as two equal parts (`paths.H2` = the minute part 2
starts), because the half-based tools (half-time plan, fatigue vs the first 15 minutes) need two.
