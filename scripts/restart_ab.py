"""A/B: v4 with the old restart rules (placement 20 frames, no unseen restart) vs v4.1
same random masks as scripts/mask_test.py."""
import functools, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (ROOT, os.path.join(ROOT, "evaluation"), os.path.join(ROOT, "scripts")):
    sys.path.insert(0, _p)
import numpy as np, pandas as pd
import possession_metrics as pm
from sb import atd, ballnet, paths, features as F, v4
import mask_test as M
track = atd.Tracking(); model = ballnet.load(os.path.join(paths.CACHE_DIR, "ballnet_half2.pt"))
gaps = ballnet.real_gap_lengths(track); gt = pm.label_codes(pd.read_csv(paths.PUBLIC_GT))
orig_out, orig_wh = F.out_until_restart, F.whistle_until_restart
old_out = functools.partial(orig_out, placed_frames=20, unseen_restart=False)
old_wh = functools.partial(orig_wh, placed_frames=20, unseen_restart=False)
rng = np.random.default_rng(7); rows = []
for run in range(8):
    t2 = M.masked_track(track, rng, gaps)
    ball, sigma, _ = ballnet.reconstruct(model, t2)
    F.out_until_restart, F.whistle_until_restart = old_out, old_wh
    a = M.score(v4.run(t2, ball, sigma), gt)
    F.out_until_restart, F.whistle_until_restart = orig_out, orig_wh
    b = M.score(v4.run(t2, ball, sigma), gt)
    rows.append(a + b); print("run", run, "old spell %.3f macro %.3f | fixed spell %.3f macro %.3f" % (a + b))
r = np.array(rows)
print("mean old spellF1 %.3f macroF1 %.3f | fixed spellF1 %.3f macroF1 %.3f" % tuple(r.mean(0)))
print("fixed better/equal/worse spellF1: %d/%d/%d" % ((r[:,2]>r[:,0]).sum(), (r[:,2]==r[:,0]).sum(), (r[:,2]<r[:,0]).sum()))
