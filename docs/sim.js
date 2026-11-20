/* Shadow Ball match simulator: two sides, a formation and a playing style each, 2 x 45 minutes,
   one step per second of match time. It is a tactics toy, not a forecast of real results: squads
   carry no ratings, so every player is equal (except the pace the user sets) and the outcome comes
   from the shapes, the styles and chance.

   Each second: both teams take a shape from their formation and style, shifted with the ball
   (pressers step out, forwards hold the offside line); the ball carrier dribbles and, when his
   decision clock runs out, picks the best of pass / carry / cross / shot by expected value, with
   pass success from distance, the passing lane and the pressure on the receiver, and the value of
   a spot from the threat surface learned from open tracking (P(ball in the box within 10 s)).
   Tested by tests/sim_test.js. Pure functions, no DOM: runs in the page, in a Worker and in node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SB_SIM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const L = 105, W = 68;

  // Playing styles. line/press are distances from the team's own goal (m).
  //   defLine: back line when defending in its own half; attLine: back line with the ball
  //   pressFrom: they press when the ball is closer than this to their own goal (105 = anywhere)
  //   pressers: players who step out; tackle: tackle strength; tempo: seconds on the ball
  //   direct: weight on forward gain; safety: weight on keeping the ball; cross: crossing bias
  //   counter: tempo multiplier right after winning the ball; width: shape width with the ball
  const STYLES = {
    possession: { name: 'Possession', defLine: 34, attLine: 44, pressFrom: 70, pressers: 1, tackle: 0.5, tempo: 1.5, direct: 0.4, safety: 1.4, cross: 0.2, counter: 1.0, width: 0.94, compact: 30 },
    press:      { name: 'High press', defLine: 44, attLine: 46, pressFrom: 85, pressers: 2, tackle: 0.6, tempo: 1.2, direct: 0.9, safety: 0.9, cross: 0.4, counter: 0.7, width: 0.9, compact: 26 },
    counter:    { name: 'Counter-attack', defLine: 24, attLine: 36, pressFrom: 45, pressers: 1, tackle: 0.6, tempo: 1.1, direct: 1.6, safety: 0.7, cross: 0.4, counter: 0.45, width: 0.86, compact: 26 },
    direct:     { name: 'Direct', defLine: 32, attLine: 38, pressFrom: 60, pressers: 1, tackle: 0.6, tempo: 0.9, direct: 2.0, safety: 0.5, cross: 0.6, counter: 0.8, width: 0.88, compact: 30 },
    wing:       { name: 'Wing play', defLine: 32, attLine: 42, pressFrom: 65, pressers: 1, tackle: 0.55, tempo: 1.3, direct: 1.0, safety: 1.0, cross: 1.4, counter: 0.9, width: 1.0, compact: 30 },
    low:        { name: 'Low block', defLine: 18, attLine: 40, pressFrom: 40, pressers: 1, tackle: 0.65, tempo: 1.1, direct: 1.6, safety: 0.8, cross: 0.5, counter: 0.6, width: 0.82, compact: 22 },
  };
  const FORMATIONS_TRY = ['4-3-3', '4-2-3-1', '4-4-2', '4-1-4-1', '3-5-2', '3-4-3', '5-3-2', '4-3-1-2'];

  function rng(seed) {                       // mulberry32
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const sig = (z) => 1 / (1 + Math.exp(-z));

  function create(opts) {
    const surf = opts.surface, cell = opts.cell || 5, nx = surf.length, ny = surf[0].length;
    const slotsOf = opts.slots, R = rng(opts.seed == null ? 1 : opts.seed);
    // threat of a spot for a team attacking towards +x in its own frame
    const threat = (xt, yt) => surf[clamp(Math.floor(xt / cell), 0, nx - 1)][clamp(Math.floor(yt / cell), 0, ny - 1)];
    const S = { t: 0, half: 1, clock: 0, dead: 0, restart: null, ball: { x: L / 2, y: W / 2, owner: -1, fly: null }, poss: 'H',
                players: [], events: [], stats: { H: blank(), A: blank() }, teams: {}, decide: 0, lastWin: -99, ended: false, track: null };
    function blank() { return { poss: 0, passes: 0, completed: 0, shots: 0, onTarget: 0, xg: 0, goals: 0, entries: 0, regainsHigh: 0, crosses: 0, corners: 0, tackles: 0, fouls: 0 }; }

    // team frame: x = distance from own goal, y = width from the team's left
    const tx = (team, x) => (team === 'H' ? x : L - x);
    const ty = (team, y) => (team === 'H' ? y : W - y);
    const other = (t) => (t === 'H' ? 'A' : 'H');

    function setTeam(team, cfg) {
      const st = STYLES[cfg.style] || STYLES.possession;
      S.teams[team] = { formation: cfg.formation, style: cfg.style, st, names: cfg.names || {}, pace: cfg.pace || {} };
      const slots = slotsOf(cfg.formation);
      const old = S.players.filter((p) => p.team === team);
      S.players = S.players.filter((p) => p.team !== team);
      slots.forEach((s, i) => {
        const prev = old[i];
        S.players.push({ team, role: s.label, sx: s.x, sy: s.y, x: prev ? prev.x : L / 2, y: prev ? prev.y : W / 2,
                         pace: (cfg.pace && cfg.pace[s.label]) || 1, name: (cfg.names && cfg.names[s.label]) || s.label });
      });
      S.players.sort((a, b) => (a.team === b.team ? 0 : a.team === 'H' ? -1 : 1));
      S.ball.owner = -1;
    }
    setTeam('H', opts.H); setTeam('A', opts.A);

    // ---- shapes
    function shapeTargets(team) {
      const T = S.teams[team], st = T.st, b = S.ball, bx = tx(team, b.x), by = ty(team, b.y);
      const att = S.poss === team && !S.dead;
      let line, len, width, shift;
      if (att) {
        line = clamp(st.attLine + 0.42 * (bx - 45), 18, 62); len = 42; width = st.width; shift = (by - W / 2) * 0.15;
      } else {
        line = clamp(st.defLine + 0.33 * (bx - 52.5), 13, 58); len = st.compact; width = 0.7 + (st.width - 0.86) * 0.5; shift = (by - W / 2) * 0.32;
      }
      if (S.dead && S.restart && S.restart.kind === 'kickoff') { line = 18; len = 30; width = 0.86; shift = 0; }
      const out = [];
      for (const p of S.players) {
        if (p.team !== team) continue;
        const sy = !att && /^(LWB|RWB)$/.test(p.role) ? Math.min(p.sy, 0.24) : p.sy;      // wing-backs drop into a back five without the ball
        let d = p.role === 'GK' ? clamp(4 + Math.max(0, line - 30) * 0.45, 4, 18) : line + Math.max(0, (sy - 0.2) / 0.66) * len;
        const w = W / 2 + (p.sx - 0.5) * W * width + shift;
        if (S.dead && S.restart && S.restart.kind === 'kickoff') d = Math.min(d, 51);
        out.push([p, d, clamp(w, 2, W - 2)]);
      }
      return out;
    }
    function offsideLine(team) {          // second-last opponent, in team frame (can't be behind the ball or halfway)
      const xs = S.players.filter((p) => p.team !== team).map((p) => tx(team, p.x)).sort((a, b) => b - a);
      return Math.max(xs[1] || L / 2, tx(team, S.ball.x), L / 2);
    }

    function move(p, x, y, dt, sprint) {
      const dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy);
      if (d < 1e-3) return;
      const fat = 1 - 0.07 * (S.clock / 5400);
      const v = (sprint || d > 6 ? 7.0 : 4.2) * p.pace * fat * dt;
      const k = Math.min(1, v / d); p.x += dx * k; p.y += dy * k;
    }

    // ---- actions
    function nearestOpp(team, x, y) { let best = 1e9, who = -1; S.players.forEach((q, i) => { if (q.team !== team) { const d = Math.hypot(q.x - x, q.y - y); if (d < best) { best = d; who = i; } } }); return [best, who]; }
    function laneDist(team, x0, y0, x1, y1) {
      let best = 1e9; const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1;
      for (const q of S.players) {
        if (q.team === team) continue;
        const t = clamp(((q.x - x0) * dx + (q.y - y0) * dy) / l2, 0.08, 1);
        const d = Math.hypot(x0 + t * dx - q.x, y0 + t * dy - q.y); if (d < best) best = d;
      }
      return best;
    }
    function xgAt(team, x, y, press) {
      const xt = tx(team, x), yt = ty(team, y), dx = L - xt, dy = Math.abs(yt - W / 2);
      // defenders between the shooter and the goal (within 2.5 m of the shot line) make it harder
      const gx = team === 'H' ? L : 0; let crowd = 0, packed = 0;
      for (const q of S.players) {
        if (q.team === team || q.role === 'GK') continue;
        const qx = q.x - x, qy = q.y - y, sx = gx - x, sy = W / 2 - y, l2 = sx * sx + sy * sy || 1, t = (qx * sx + qy * sy) / l2;
        if (t > 0 && t < 1 && Math.hypot(qx - t * sx, qy - t * sy) < 2.5) crowd += 1;
        if (tx(team, q.x) > L - 18 && Math.abs(q.y - W / 2) < 20) packed += 1;       // bodies in the box
      }
      // open-play shot quality: about 0.3 from the penalty spot, 0.1 from the box edge, 0.05 from 20 m
      const dist = Math.hypot(dx, dy), base = sig(1.3 - 0.21 * dist - 0.07 * Math.max(0, dy - 4));
      return clamp(0.8 * base * (1 - 0.55 * Math.exp(-press / 1.6)) * Math.pow(0.72, crowd) * Math.pow(0.88, Math.max(0, packed - 3)), 0.005, 0.75);
    }
    function decide(ci) {
      const c = S.players[ci], team = c.team, T = S.teams[team], st = T.st;
      const cxT = tx(team, c.x), cyT = ty(team, c.y), here = threat(cxT, cyT);
      const [press] = nearestOpp(team, c.x, c.y);
      const lossCost = 0.03 + 0.12 * (1 - cxT / L);
      const opts = [];
      const off = offsideLine(team);
      S.players.forEach((r, j) => {
        if (j === ci || r.team !== team) return;
        const d = Math.hypot(r.x - c.x, r.y - c.y);
        if (d < 4 || d > 60) return;
        if (r.role === 'GK' && cxT > 45) return;
        if (tx(team, r.x) > off + 0.5) return;                       // offside
        const lane = laneDist(team, c.x, c.y, r.x, r.y), [rp] = nearestOpp(team, r.x, r.y), fwd = tx(team, r.x) - cxT;
        const z = 2.6 - 0.058 * d + 0.28 * Math.min(rp, 7) - 3.2 * Math.exp(-lane / 2.0) - 0.8 * Math.exp(-press / 1.5) - (fwd > 15 ? 0.4 : 0);
        const p = sig(z), gain = threat(tx(team, r.x), ty(team, r.y)) - here;
        const v = p * (Math.max(gain, -0.025) + 0.012 * st.safety) - (1 - p) * lossCost * (0.6 + 0.4 * st.safety) + st.direct * 0.0009 * fwd;   // keeping the ball has value: recycling costs little
        opts.push({ kind: 'pass', j, p, v, d });
      });
      // through ball: into the space behind the last line for a forward to run onto (a race)
      S.players.forEach((r, j) => {
        if (r.team !== team || !/^(ST|CF|LW|RW|LM|RM|CAM)$/.test(r.role)) return;
        const rxT = tx(team, r.x), ryT = ty(team, r.y);
        const txT = Math.min(L - 13, Math.max(rxT + 12, off + 6)), tyT = clamp(ryT + (W / 2 - ryT) * 0.25, 4, W - 4);
        if (txT - rxT < 5 || (L - 13) - off < 6) return;            // no room behind the line
        const X = tx(team, txT), Y = ty(team, tyT), d = Math.hypot(X - c.x, Y - c.y);
        if (d > 65) return;
        const [dd] = nearestOpp(team, X, Y), race = dd - Math.hypot(X - r.x, Y - r.y) * 0.95;
        const lane = laneDist(team, c.x, c.y, X, Y);
        const p = Math.min(0.55, sig(0.35 * race - 0.04 * d + 0.2 - 2.5 * Math.exp(-lane / 2.0)));
        const gain = threat(txT, tyT) - here;
        const v = p * (gain + 0.01) - (1 - p) * lossCost * 0.8 + st.direct * 0.0012 * (txT - cxT) + (press < 3 && cxT < 40 ? 0.02 : 0);
        opts.push({ kind: 'through', j, p, v, d, X, Y });
      });
      // clearance: under pressure deep in his own half, a long ball to the furthest forward (an aerial duel)
      if (cxT < 35 && press < 5) {
        let far = -1, fx = -1;
        S.players.forEach((r, j) => { if (r.team === team && j !== ci && tx(team, r.x) <= off + 0.5 && tx(team, r.x) > fx) { fx = tx(team, r.x); far = j; } });
        if (far >= 0 && fx - cxT > 25) { const r = S.players[far], d = Math.hypot(r.x - c.x, r.y - c.y);
          opts.push({ kind: 'pass', j: far, p: 0.4, d, v: 0.4 * (threat(fx, ty(team, r.y)) - here) - 0.6 * 0.03 + st.direct * 0.004 }); }
      }
      // carry forward if there is room
      const ahead = S.players.filter((q) => q.team !== team && tx(team, q.x) > cxT && Math.abs(q.y - c.y) < 7 && tx(team, q.x) - cxT < 9).length;
      if (!ahead) opts.push({ kind: 'carry', v: threat(Math.min(L, cxT + 8), cyT) - here + 0.004 });
      // shot
      if (cxT > L - 32) { const blocked = laneDist(team, c.x, c.y, team === 'H' ? L : 0, W / 2) < 1.5, xg = xgAt(team, c.x, c.y, press) * (blocked ? 0.45 : 1);   // a defender in the line of the shot
        if (xg > 0.05) opts.push({ kind: 'shot', xg, v: (xg - 0.11) * 1.5 + (press < 1.5 && cxT > L - 16 ? 0.02 : 0) }); }
      // cross from wide areas of the final third
      if (cxT > L - 28 && (cyT < 16 || cyT > W - 16)) {
        const inBox = S.players.filter((q) => q.team === team && tx(team, q.x) > L - 17 && Math.abs(ty(team, q.y) - W / 2) < 20).length;
        opts.push({ kind: 'cross', inBox, v: (0.05 + 0.03 * inBox) * 0.35 * (0.6 + 0.4 * st.cross) - 0.02 + 0.01 * st.cross });
      }
      let best = null;
      for (const o of opts) { const s = o.v + (R() - 0.5) * 0.02; if (!best || s > best.s) best = Object.assign({ s }, o); }
      if (S.debug && best && best.kind === 'shot') S.debug.push(opts.map((o) => o.kind + ':' + o.v.toFixed(3) + (o.p != null ? '@' + o.p.toFixed(2) : '')).join(' '));
      return best;
    }

    function giveBall(i, how) {
      const p = S.players[i], prev = S.poss;
      S.ball.owner = i; S.ball.fly = null; S.ball.x = p.x; S.ball.y = p.y;
      if (prev !== p.team) {
        S.poss = p.team; S.lastWin = S.clock;
        if (how === 'won' && tx(p.team, p.x) > L / 2) S.stats[p.team].regainsHigh += 1;
      }
      const st = S.teams[p.team].st, quick = S.clock - S.lastWin < 6 ? st.counter : 1;
      S.decide = st.tempo * quick * (0.6 + 0.8 * R());
    }
    function stopPlay(kind, team, x, y, secs) {
      S.dead = secs; S.restart = { kind, team, x, y }; S.ball.owner = -1; S.ball.fly = null; S.ball.x = x; S.ball.y = y; S.poss = team;
    }
    function restartPlay() {
      const r = S.restart; S.dead = 0; S.restart = null;
      let cands = S.players.map((p, i) => i).filter((i) => S.players[i].team === r.team);
      if (r.kind === 'goalkick') cands = cands.filter((i) => S.players[i].role === 'GK');
      else if (r.kind === 'kickoff') cands = cands.filter((i) => S.players[i].role !== 'GK');
      let best = cands[0], bd = 1e9;
      for (const i of cands) { const d = Math.hypot(S.players[i].x - r.x, S.players[i].y - r.y); if (d < bd) { bd = d; best = i; } }
      const p = S.players[best]; p.x = r.x; p.y = r.y;
      if (r.kind === 'corner') { cross(best, 3); return; }
      giveBall(best, 'restart');
    }
    function log(kind, team, extra) { S.events.push(Object.assign({ t: S.clock, half: S.half, kind, team }, extra || {})); }

    function shoot(ci, xg, src) {
      const c = S.players[ci], team = c.team, st = S.stats[team];

      st.shots += 1; st.xg += xg;
      const onT = R() < 0.3 + 0.9 * xg; if (onT) st.onTarget += 1;
      const goal = onT && R() < Math.min(0.95, xg / (0.3 + 0.9 * xg));
      if (goal) {
        st.goals += 1; log('goal', team, { who: c.name, role: c.role, xg, src: src || 'open' });
        stopPlay('kickoff', other(team), L / 2, W / 2, 45);
      } else {
        log(xg > 0.25 ? 'chance' : 'shot', team, { who: c.name, role: c.role, xg, src: src || 'open' });
        if (onT && R() < 0.35) { S.stats[team].corners += 1; stopPlay('corner', team, team === 'H' ? L - 0.5 : 0.5, R() < 0.5 ? 0.5 : W - 0.5, 18); }
        else stopPlay('goalkick', other(team), team === 'H' ? L - 6 : 6, W / 2, 22);
      }
    }
    function cross(ci, inBox) {
      const c = S.players[ci], team = c.team; S.stats[team].crosses += 1;
      const ok = R() < 0.18 + 0.05 * Math.min(inBox, 4);
      const targets = S.players.map((p, i) => i).filter((i) => S.players[i].team === team && i !== ci && tx(team, S.players[i].x) > L - 18);
      if (ok && targets.length) {
        const j = targets[Math.floor(R() * targets.length)], r = S.players[j];
        S.ball.x = r.x; S.ball.y = r.y; S.ball.owner = j;
        shoot(j, clamp(0.05 + 0.06 * R() + 0.4 * xgAt(team, r.x, r.y, 1.2) * 0.2, 0.03, 0.3), 'cross');
      } else if (R() < 0.3) { S.stats[team].corners += 1; stopPlay('corner', team, team === 'H' ? L - 0.5 : 0.5, c.y < W / 2 ? 0.5 : W - 0.5, 18); }
      else {
        const d = other(team); let best = -1, bd = 1e9;
        S.players.forEach((q, i) => { if (q.team === d) { const dd = Math.hypot(q.x - (team === 'H' ? L - 12 : 12), q.y - W / 2); if (dd < bd) { bd = dd; best = i; } } });
        giveBall(best, 'won');
      }
    }

    // ---- one second
    function step(dt = 1) {
      if (S.ended) return;
      S.t += dt; S.clock += dt;
      const b = S.ball;
      // shapes and movement
      const targets = shapeTargets('H').concat(shapeTargets('A'));
      const defTeam = other(S.poss), dst = S.teams[defTeam].st;
      const pressing = !S.dead && b.owner >= 0 && (L - tx(S.poss, b.x)) < dst.pressFrom;
      let pressers = [];
      if (pressing) pressers = S.players.map((p, i) => [i, Math.hypot(p.x - b.x, p.y - b.y)]).filter(([i]) => S.players[i].team === defTeam && S.players[i].role !== 'GK')
        .sort((a, c) => a[1] - c[1]).slice(0, dst.pressers).map(([i]) => i);
      const offs = { H: offsideLine('H'), A: offsideLine('A') };
      // near their own goal defenders also engage the ball goal-side and mark runners in the box
      const goalD = { x: defTeam === 'H' ? 0 : L, y: W / 2 }, dBall = Math.hypot(b.x - goalD.x, b.y - goalD.y);
      const engage = new Map();
      if (!S.dead && dBall < 42) {
        const n = dBall < 26 ? 2 : 1, ux = (goalD.x - b.x) / (dBall || 1), uy = (goalD.y - b.y) / (dBall || 1);
        S.players.map((p, i) => [i, Math.hypot(p.x - b.x, p.y - b.y)]).filter(([i]) => S.players[i].team === defTeam && S.players[i].role !== 'GK' && !pressers.includes(i))
          .sort((a, c) => a[1] - c[1]).slice(0, n).forEach(([i], k) => engage.set(i, [b.x + ux * (1.4 + 2 * k), b.y + uy * (1.4 + 2 * k) + (k ? 2.5 : 0)]));
        if (dBall < 30 + (S.teams[defTeam].st.defLine < 25 ? 12 : 0)) {          // a deep block marks earlier
          const runners = S.players.map((p, i) => i).filter((i) => S.players[i].team === S.poss && i !== b.owner && Math.hypot(S.players[i].x - goalD.x, S.players[i].y - goalD.y) < 24);
          const free = S.players.map((p, i) => i).filter((i) => S.players[i].team === defTeam && S.players[i].role !== 'GK' && !pressers.includes(i) && !engage.has(i));
          for (const ri of runners) {
            const r = S.players[ri]; let best = -1, bd = 14;
            for (const di of free) { if (engage.has(di)) continue; const d = Math.hypot(S.players[di].x - r.x, S.players[di].y - r.y); if (d < bd) { bd = d; best = di; } }
            if (best >= 0) { const gl = Math.hypot(goalD.x - r.x, goalD.y - r.y) || 1; engage.set(best, [r.x + (goalD.x - r.x) / gl * 1.5, r.y + (goalD.y - r.y) / gl * 1.5]); }
          }
        }
      }
      for (const [p, d, w] of targets) {
        const i = S.players.indexOf(p);
        if (i === b.owner) continue;
        let x = tx(p.team, d), y = ty(p.team, w);
        if (pressers[0] === i) { move(p, b.x, b.y, dt, true); continue; }
        if (pressers.includes(i)) {                 // the second presser cuts the nearest pass instead of chasing the ball
          let nx = b.x, ny = b.y, nd = 1e9; S.players.forEach((q, k) => { if (q.team === S.poss && k !== b.owner && q.role !== 'GK') { const dd = Math.hypot(q.x - b.x, q.y - b.y); if (dd < nd) { nd = dd; nx = q.x; ny = q.y; } } });
          move(p, b.x + (nx - b.x) * 0.6, b.y + (ny - b.y) * 0.6, dt, true); continue; }
        if (b.fly && b.fly.ok && i === b.fly.j) { move(p, b.fly.x, b.fly.y, dt, true); continue; }   // the receiver meets the pass
        if (engage.has(i)) { const [ex, ey] = engage.get(i); move(p, ex, ey, dt, true); continue; }
        if (!S.dead && p.team === S.poss) {
          const bxT = tx(p.team, b.x), lim = offs[p.team] - 0.5;
          // forwards run level with the last defender; wide and attacking midfielders join once the ball is in the opponent's half
          if (/^(ST|CF|LW|RW)$/.test(p.role)) x = tx(p.team, Math.min(Math.max(d, bxT + 6), lim));
          else if (/^(CAM|LAM|RAM|LM|RM)$/.test(p.role) && bxT > L / 2) x = tx(p.team, Math.min(Math.max(d, bxT + 2, bxT > L - 38 ? L - 17 : 0), lim - 1));
          else if (/^(LCM|RCM|CM)$/.test(p.role) && bxT > L - 38) x = tx(p.team, Math.min(Math.max(d, L - 20), lim - 1));   // late runs to the edge of the box
          else if (/^(LWB|RWB)$/.test(p.role) && bxT > L / 2 && S.teams[p.team].st.cross > 0.9) x = tx(p.team, Math.min(Math.max(d, bxT), lim - 5));
        }
        move(p, x, y, dt, false);
      }
      if (S.dead) { S.dead -= dt; if (S.dead <= 0) restartPlay(); endCheck(); return; }
      S.stats[S.poss].poss += dt;
      // ball in flight
      if (b.fly) {
        const f = b.fly; f.left -= dt;
        b.x += (f.x - b.x) * Math.min(1, dt / Math.max(f.left + dt, dt)); b.y += (f.y - b.y) * Math.min(1, dt / Math.max(f.left + dt, dt));
        if (f.left <= 0) {
          b.x = f.x; b.y = f.y;
          if (f.ok) { S.stats[f.team].completed += 1; const r = S.players[f.j]; r.x = f.x; r.y = f.y;
            if (tx(f.team, f.from) < L * 2 / 3 && tx(f.team, f.x) >= L * 2 / 3) S.stats[f.team].entries += 1;
            giveBall(f.j, 'pass'); }
          else if (f.x < 1 || f.x > L - 1 || f.y < 1 || f.y > W - 1) {
            const t2 = other(f.team);
            if (f.y < 1 || f.y > W - 1) stopPlay('throw', t2, clamp(f.x, 1, L - 1), f.y < 1 ? 0.5 : W - 0.5, 14);
            else stopPlay('goalkick', t2, t2 === 'H' ? 6 : L - 6, W / 2, 22);
          } else { const [, who] = nearestOpp(f.team, f.x, f.y); S.players[who].x = f.x; S.players[who].y = f.y; giveBall(who, 'won'); }
        }
        endCheck(); return;
      }
      if (b.owner < 0) { const [, who] = nearestOpp(other(S.poss), b.x, b.y); giveBall(who, 'won'); endCheck(); return; }
      // carrier
      const c = S.players[b.owner], team = c.team, gx = team === 'H' ? L - 2 : 2;
      const [press, presser] = nearestOpp(team, c.x, c.y);
      if (press < 1.6) {                           // duel: a tackle, a foul, or the carrier holds on
        const q = S.players[presser], pt = 0.025 + 0.045 * S.teams[q.team].st.tackle, u = R();
        if (u < pt * dt) { S.stats[q.team].tackles += 1; giveBall(presser, 'won'); endCheck(); return; }
        if (u < (pt + 0.016) * dt) {
          S.stats[q.team].fouls += 1; log('foul', q.team, { who: q.name });
          stopPlay('freekick', team, c.x, c.y, 18); endCheck(); return;
        }
      }
      // dribble towards goal, away from the nearest opponent
      const q = S.players[presser]; let ax = gx - c.x, ay = W / 2 - c.y; const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
      if (press < 8) { const rx = c.x - q.x, ry = c.y - q.y, rl = Math.hypot(rx, ry) || 1; ax += 0.8 * rx / rl; ay += 0.8 * ry / rl; }
      const v = 5.2 * c.pace * dt, al2 = Math.hypot(ax, ay) || 1;
      c.x = clamp(c.x + v * ax / al2 * 0.6, 1, L - 1); c.y = clamp(c.y + v * ay / al2 * 0.6, 1, W - 1);
      b.x = c.x; b.y = c.y;
      S.decide -= dt * (press < 2 ? 3 : press < 4 ? 1.6 : 1);
      if (S.decide <= 0) {
        const a = decide(b.owner);
        if (!a) { S.decide = 1; }
        else if (a.kind === 'pass') {
          const r = S.players[a.j], ok = R() < a.p; S.stats[team].passes += 1;
          let x = r.x, y = r.y;
          if (!ok && R() < 0.25) { x = r.x + (r.x - c.x) * 0.4; y = r.y + (r.y - c.y) * 0.4; }   // overhit
          b.fly = { team, j: a.j, ok, x: clamp(x, -1, L + 1), y: clamp(y, -1, W + 1), left: Math.max(1, a.d / (a.d > 30 ? 20 : 15)), from: c.x };
          b.owner = -2;
        } else if (a.kind === 'through') {
          const ok = R() < a.p; S.stats[team].passes += 1;
          b.fly = { team, j: a.j, ok, x: clamp(a.X, -1, L + 1), y: clamp(a.Y, -1, W + 1), left: Math.max(1.2, a.d / 17), from: c.x };
          b.owner = -2;
        } else if (a.kind === 'carry') { S.decide = 0.8 + 0.8 * R(); }
        else if (a.kind === 'shot') { shoot(b.owner, a.xg); }
        else if (a.kind === 'cross') { cross(b.owner, a.inBox); }
      }
      endCheck();
    }
    function endCheck() {
      if (S.clock >= S.half * 2700 && !(S.ball.fly)) {
        if (S.half === 1) { S.half = 2; log('ht', null); halftime(); }
        else { S.ended = true; log('ft', null); }
      }
    }
    function halftime() { S.paused = true; stopPlay('kickoff', 'A', L / 2, W / 2, 20); }
    function kickoff(team) { stopPlay('kickoff', team || 'H', L / 2, W / 2, 3); for (const p of S.players) { const s = shapeTargets(p.team).find((x) => x[0] === p); p.x = tx(p.team, s[1]); p.y = ty(p.team, s[2]); } }

    // run until the end of the current half (headless)
    function runHalf() { const h = S.half; while (!S.ended && S.half === h) step(1); }
    kickoff('H');
    return { S, step, setTeam, runHalf, kickoff, STYLES, threat, tx, ty };
  }

  // Search: which formation + style of team H plays the opponent best over a 45-minute half?
  // Common random numbers: every setup sees the same seeds. Returns setups sorted by mean xG difference.
  function search(opts, onProgress) {
    const formations = opts.formations || FORMATIONS_TRY, styles = opts.styles || Object.keys(STYLES), runs = opts.runs || 5;
    const out = [], total = formations.length * styles.length; let k = 0;
    for (const f of formations) for (const s of styles) {
      let xgd = 0, xgd2 = 0, gd = 0, xgf = 0, xga = 0, poss = 0;
      for (let r = 0; r < runs; r++) {
        const m = create({ surface: opts.surface, cell: opts.cell, slots: opts.slots, seed: 1000 + r * 7919,
          H: Object.assign({}, opts.H, { formation: f, style: s }), A: opts.A });
        m.runHalf();
        const H = m.S.stats.H, A = m.S.stats.A;
        xgd += H.xg - A.xg; xgd2 += (H.xg - A.xg) * (H.xg - A.xg); gd += H.goals - A.goals; xgf += H.xg; xga += A.xg; poss += H.poss / Math.max(1, H.poss + A.poss);
      }
      const mean = xgd / runs, sd = Math.sqrt(Math.max(0, xgd2 / runs - mean * mean));
      out.push({ formation: f, style: s, xgd: mean, se: sd / Math.sqrt(runs), gd: gd / runs, xgf: xgf / runs, xga: xga / runs, poss: poss / runs });
      k += 1; if (onProgress) onProgress(k / total);
    }
    return out.sort((a, b) => b.xgd - a.xgd);
  }

  return { create, search, STYLES, FORMATIONS_TRY };
});
