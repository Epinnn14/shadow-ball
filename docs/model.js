/* Shadow Ball model for the playground: the same pitch control x threat surface as sb/offball.py and
   the replay (arrival time = reaction + distance / speed, soft-min per team, logistic control).
   Pure functions, no DOM: tested by tests/model_test.js.

   Players: { team: 'H' | 'A', x, y, role, pace } in metres, H attacks to the right (+x).
   pace scales the player's top speed (1 = the model's default 5 m/s). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SB_MODEL = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const REACT = 0.7, VMAX = 5, SOFT = 0.3, TEMP = 0.45, CELL = 3;
  const OFFS = [[0, 0]];
  for (const r of [2.5, 5]) for (let k = 0; k < 8; k++) OFFS.push([r * Math.cos(k * Math.PI / 4), r * Math.sin(k * Math.PI / 4)]);

  function create(opts) {
    const L = opts.L || 105, W = opts.W || 68, surf = opts.surface, scell = opts.cell || 5;
    const cells = []; for (let x = CELL / 2; x < L; x += CELL) for (let y = CELL / 2; y < W; y += CELL) cells.push([x, y]);
    const n = cells.length, nx = surf.length, ny = surf[0].length;

    function threatAt(ax, ay) {          // in the attacking team's frame (attacking right)
      return surf[Math.max(0, Math.min(nx - 1, Math.floor(ax / scell)))][Math.max(0, Math.min(ny - 1, Math.floor(ay / scell)))];
    }
    // value of every cell for team `att`, weighted towards the ball, normalised to sum 1
    function valueFor(att, ball) {
      const v = new Float64Array(n); let sum = 0;
      for (let i = 0; i < n; i++) {
        const [x, y] = cells[i], ax = att === 'H' ? x : L - x, ay = att === 'H' ? y : W - y;
        v[i] = threatAt(ax, ay) * (ball ? 0.5 + 0.5 * Math.exp(-Math.hypot(x - ball.x, y - ball.y) / 25) : 1);
        sum += v[i];
      }
      for (let i = 0; i < n; i++) v[i] /= sum || 1;
      return v;
    }
    function expArr(x, y, pace) {
      const e = new Float64Array(n), vmax = VMAX * (pace || 1);
      for (let i = 0; i < n; i++) e[i] = Math.exp(-(REACT + Math.hypot(x - cells[i][0], y - cells[i][1]) / vmax) / SOFT);
      return e;
    }
    function sums(ps) {
      const E = ps.map((p) => expArr(p.x, p.y, p.pace)), sH = new Float64Array(n), sA = new Float64Array(n);
      ps.forEach((p, k) => { const s = p.team === 'H' ? sH : sA; for (let i = 0; i < n; i++) s[i] += E[k][i]; });
      return { E, sH, sA };
    }
    const tOf = (s) => -SOFT * Math.log(Math.max(s, 1e-300));
    // H's control of each cell, 0..1
    function control(ps) {
      const { sH, sA } = sums(ps), c = new Float64Array(n);
      for (let i = 0; i < n; i++) c[i] = 1 / (1 + Math.exp(-(tOf(sA[i]) - tOf(sH[i])) / TEMP));
      return c;
    }
    function shareH(v, sH, tA) {
      let j = 0;
      for (let i = 0; i < n; i++) j += v[i] / (1 + Math.exp(-(tA[i] - tOf(sH[i])) / TEMP));
      return j;
    }
    // the numbers the playground shows for team H, with `poss` the team on the ball
    function evaluate(ps, ball, poss) {
      const { sH, sA } = sums(ps), tA = Array.from(sA, tOf);
      const vAtt = valueFor(poss, ball), own = shareH(vAtt, sH, tA);
      const out = { control: null, poss };
      if (poss === 'H') { out.spaceOwned = own; out.restDefence = shareH(valueFor('A', ball), sH, tA); }
      else out.spaceDenied = own;          // H's share of the dangerous space A attacks
      return out;
    }
    // greedy unit move for team H: up to maxMoves players, each to the best of 16 spots within 5 m,
    // each move counted with the earlier ones (same as the replay's Attack / Defend cards)
    function simulate(ps, ball, poss, maxMoves = 4, minGain = 0.004) {
      const v = valueFor(poss, ball), { E, sH, sA } = sums(ps), tA = Array.from(sA, tOf);
      let carrier = -1;
      if (poss === 'H' && ball) {
        let bd = 3; ps.forEach((p, k) => { if (p.team === 'H') { const d = Math.hypot(p.x - ball.x, p.y - ball.y); if (d < bd) { bd = d; carrier = k; } } });
      }
      const movable = ps.map((p, k) => k).filter((k) => ps[k].team === 'H' && ps[k].role !== 'GK' && k !== carrier);
      const before = shareH(v, sH, tA);
      let cur = before; const moves = [], moved = new Set(), pos = ps.map((p) => ({ x: p.x, y: p.y })), trial = new Float64Array(n);
      for (let step = 0; step < maxMoves; step++) {
        let best = null;
        for (const k of movable) {
          if (moved.has(k)) continue;
          for (let o = 1; o < OFFS.length; o++) {
            const x = Math.max(0.5, Math.min(L - 0.5, pos[k].x + OFFS[o][0])), y = Math.max(0.5, Math.min(W - 0.5, pos[k].y + OFFS[o][1]));
            const e = expArr(x, y, ps[k].pace);
            for (let i = 0; i < n; i++) trial[i] = sH[i] - E[k][i] + e[i];
            const j = shareH(v, trial, tA);
            if (!best || j > best.j) best = { k, x, y, j, e };
          }
        }
        if (!best || best.j - cur < minGain) break;
        for (let i = 0; i < n; i++) sH[i] += best.e[i] - E[best.k][i];
        E[best.k] = best.e; moved.add(best.k);
        moves.push({ k: best.k, role: ps[best.k].role, x: pos[best.k].x, y: pos[best.k].y, sx: best.x, sy: best.y, gain: best.j - cur });
        pos[best.k] = { x: best.x, y: best.y }; cur = best.j;
      }
      const after = ps.map((p, k) => Object.assign({}, p, pos[k]));
      const res = { before, after: cur, moves, players: after };
      if (poss === 'H') {
        const vr = valueFor('A', ball), b = sums(ps), a = sums(after);
        res.restBefore = shareH(vr, b.sH, Array.from(b.sA, tOf)); res.restAfter = shareH(vr, a.sH, Array.from(a.sA, tOf));
      }
      return res;
    }
    // per cell: [x0, y0, control of H, value] for drawing the dangerous space
    function dangerMap(ps, ball, poss) {
      const c = control(ps), v = valueFor(poss, ball);
      return cells.map(([x, y], i) => [x - CELL / 2, y - CELL / 2, c[i], v[i]]);
    }
    return { cells, CELL, valueFor, control, evaluate, simulate, dangerMap, threatAt };
  }

  // Formation slots (0..1 box: x = width from the team's left, y = depth from its own goal) to metres
  // for a team shape: `line` = back-line distance from its own goal, `len` = back line to front line,
  // `width` = share of the pitch width used. H attacks right; A is mirrored.
  function place(slots, team, shape, L = 105, W = 68) {
    const { line, len, width = 0.86, shift = 0 } = shape;
    return slots.map((s) => {
      let d = s.label === 'GK' ? Math.max(4, Math.min(line - 12, 4 + Math.max(0, line - 30) * 0.5)) : line + Math.max(0, (s.y - 0.2) / 0.66) * len;
      const w = W / 2 + (s.x - 0.5) * W * width + shift;
      d = Math.max(1, Math.min(L - 1, d));
      return team === 'H' ? { x: d, y: Math.max(1, Math.min(W - 1, w)) } : { x: L - d, y: Math.max(1, Math.min(W - 1, W - w)) };
    });
  }

  return { create, place, REACT, VMAX, SOFT, TEMP };
});
