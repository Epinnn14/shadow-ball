/* Home page: one real moment drawn by the same model as the tactics board (a mid-block, blue
   defending), with the best moves it finds. Nothing here is a mock-up. */
(function () {
  'use strict';
  const D = window.SB_DATA, M = window.SB_MODEL, TH = window.SB_THREAT, $ = (id) => document.getElementById(id);
  const L = 105, W = 68, model = M.create({ L, W, surface: TH.surface, cell: TH.cell });
  const KIT_H = '#2F6FEB', KIT_A = '#E4572E';
  const ps = [];
  for (const [team, formation, shape] of [['H', '4-4-2', { line: 28, len: 28, width: 0.74 }], ['A', '4-3-3', { line: 40, len: 34, width: 0.92 }]]) {
    const slots = D.slots(formation), pos = M.place(slots, team, shape, L, W);
    slots.forEach((s, k) => ps.push({ team, role: s.label, x: pos[k].x, y: pos[k].y }));
  }
  const ball = { x: 62, y: 28 };
  let best = null; for (const p of ps) if (p.team === 'A' && p.role !== 'GK') { const d = Math.hypot(p.x - ball.x, p.y - ball.y); if (!best || d < best.d) best = { p, d }; }
  best.p.x = ball.x + 0.8; best.p.y = ball.y;
  const ev = model.evaluate(ps, ball, 'A'), danger = model.dangerMap(ps, ball, 'A'), sim = model.simulate(ps, ball, 'A', 3);
  const board = window.SB_PITCH.createBoard($('heroPitch'), { L, W, portraitBelow: 420 });
  const tr = (s, v) => (window.SB_I18N ? window.SB_I18N.t(s, v) : s.replace(/\{(\w+)\}/g, (_, k) => v[k]));
  function draw() {
    const view = board.layout(); board.begin();
    board.space(danger, model.CELL, KIT_H, KIT_A);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--shadow').trim() || '#5B3FD9';
    for (const m of sim.moves) board.arrow(m.x, m.y, m.sx, m.sy, '#C9BCFF');
    const r = Math.max(6.5, 1.4 * view.sc);
    for (const p of ps) board.player(p.x, p.y, r, p.team === 'H' ? KIT_H : KIT_A, '', null, false, accent);
    board.ball(ball.x, ball.y);
    $('heroDenied').textContent = tr('blue denies {p}%', { p: Math.round(ev.spaceDenied * 100) });
  }
  draw();
  let t = null; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(draw, 120); });
  window.addEventListener('sb-lang', draw);
})();
