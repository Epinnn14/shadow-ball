/* Tactics playground: pick two LaLiga sides, formations and XIs, set a scenario, drag players and the
   ball, and read the Shadow Ball model (demo/model.js) live. "Your team" is H and attacks right. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const T = (s, v) => (window.SB_I18N ? window.SB_I18N.t(s, v) : s.replace(/\{(\w+)\}/g, (_, k) => v[k]));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const D = window.SB_DATA, LIGA = window.SB_LALIGA, TH = window.SB_THREAT, M = window.SB_MODEL;
  const L = 105, W = 68, CSS = getComputedStyle(document.documentElement), tok = (n) => CSS.getPropertyValue(n).trim();
  const model = M.create({ L, W, surface: TH.surface, cell: TH.cell });
  const GROUP_OF = (label) => (label === 'GK' ? 'GK' : /B$|CB$/.test(label) ? 'DF' : /^(ST|CF|LW|RW)$/.test(label) ? 'FW' : 'MF');
  const clubById = (id) => LIGA.clubs.find((c) => c.id === id) || LIGA.clubs[0];
  const pid = (p) => `${p.num == null ? 'x' : p.num}:${p.name}`;
  const surname = (n) => { const parts = n.split(' '); return parts.length > 1 && n.length > 12 ? parts.slice(1).join(' ') : n; };

  // ---------------------------------------------------------------- scenarios (H frame, metres)
  const SCEN = [
    { id: 'build', name: 'Build-up from the back', poss: 'H', ball: [14, 24], H: { line: 16, len: 46, width: 0.96 }, A: { line: 50, len: 28, width: 0.8 },
      text: 'Your centre-back has the ball; they press high. Find the shape that keeps the most dangerous space.' },
    { id: 'press', name: 'High press', poss: 'A', ball: [93, 42], H: { line: 50, len: 30, width: 0.84 }, A: { line: 14, len: 46, width: 0.96 },
      text: 'They build from the back; you press in their half. Close the space they could play into.' },
    { id: 'mid', name: 'Mid-block', poss: 'A', ball: [62, 28], H: { line: 28, len: 28, width: 0.74 }, A: { line: 40, len: 34, width: 0.92 },
      text: 'They have it in midfield; you sit in a compact block.' },
    { id: 'final', name: 'Final-third attack', poss: 'H', ball: [80, 20], H: { line: 46, len: 38, width: 0.92 }, A: { line: 10, len: 24, width: 0.7 },
      text: 'You have the ball on the left of their box against a low block. Who should move where?' },
    { id: 'counter', name: 'Lost it high', poss: 'A', ball: [66, 44], H: { line: 46, len: 36, width: 0.96 }, A: { line: 26, len: 36, width: 0.86 },
      text: 'They just won it back with your team pushed up. How much space is left, and who covers it?' },
    { id: 'low', name: 'Low block', poss: 'A', ball: [28, 56], H: { line: 10, len: 22, width: 0.7 }, A: { line: 40, len: 40, width: 0.92 },
      text: 'Their winger has it near your box on your right.' },
  ];

  // ---------------------------------------------------------------- state
  const S = { side: 'H', scen: 'build', poss: 'H', ball: { x: 14, y: 24 }, players: [], sel: null, layers: { space: true, moves: true, names: true },
              teams: { H: null, A: null }, sim: null, anim: null };
  function defaultTeam(clubId, formation) {
    const club = clubById(clubId); return { club: club.id, formation, kit: 0, xi: autoXi(club, formation, {}), pace: {} };
  }
  function autoXi(club, formation, keep) {
    const used = new Set(), xi = {};
    for (const s of D.slots(formation)) {
      const k = keep[s.label]; if (k && club.players.some((p) => pid(p) === k) && !used.has(k)) { xi[s.label] = k; used.add(k); }
    }
    for (const s of D.slots(formation)) {
      if (xi[s.label]) continue;
      const g = GROUP_OF(s.label), p = club.players.find((q) => q.group === g && !used.has(pid(q))) || club.players.find((q) => !used.has(pid(q)));
      if (p) { xi[s.label] = pid(p); used.add(pid(p)); }
    }
    return xi;
  }
  function load() {
    try { const s = JSON.parse(localStorage.getItem('sb_pg') || 'null'); if (s && s.teams && s.teams.H && s.teams.A) return s; } catch (e) { /* storage blocked */ }
    return null;
  }
  function save() { try { localStorage.setItem('sb_pg', JSON.stringify({ teams: S.teams, scen: S.scen, side: S.side })); } catch (e) { /* storage blocked */ } }

  const saved = load();
  S.teams.H = saved ? saved.teams.H : defaultTeam('barcelona', '4-3-3');
  S.teams.A = saved ? saved.teams.A : defaultTeam('real-madrid', '4-4-2');
  if (saved && saved.scen) S.scen = saved.scen;
  for (const t of ['H', 'A']) if (!LIGA.clubs.some((c) => c.id === S.teams[t].club)) S.teams[t] = defaultTeam(LIGA.clubs[t === 'H' ? 0 : 1].id, '4-3-3');

  function kitOf(team) {
    const t = S.teams[team], club = clubById(t.club);
    let c = club.kit[t.kit] || club.kit[0];
    if (team === 'A') {                     // keep the two sides apart on the pitch
      const h = kitOf('H'), dist = (a, b) => { const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
        return Math.abs((x >> 16) - (y >> 16)) + Math.abs(((x >> 8) & 255) - ((y >> 8) & 255)) + Math.abs((x & 255) - (y & 255)); };
      if (dist(c, h) < 140) c = club.kit[1 - t.kit] || c;
      if (dist(c, h) < 140) c = h === '#F5F5F5' || h === '#FFFFFF' ? '#1F2937' : '#F5F5F5';
    }
    return c;
  }
  const ink = window.SB_PITCH.ink;
  function playerOf(team, label) {
    const t = S.teams[team], club = clubById(t.club), id = t.xi[label];
    return club.players.find((p) => pid(p) === id) || null;
  }

  // ---------------------------------------------------------------- positions
  function place(scenId) {
    const sc = SCEN.find((s) => s.id === scenId) || SCEN[0];
    S.scen = sc.id; S.poss = sc.poss; S.ball = { x: sc.ball[0], y: sc.ball[1] }; S.sim = null;
    const ps = [];
    for (const team of ['H', 'A']) {
      const slots = D.slots(S.teams[team].formation), pos = M.place(slots, team, sc[team], L, W);
      slots.forEach((s, k) => ps.push({ team, role: s.label, x: pos[k].x, y: pos[k].y }));
    }
    // the nearest outfield player of the team on the ball takes it
    let best = null;
    for (const p of ps) if (p.team === S.poss && p.role !== 'GK') { const d = Math.hypot(p.x - S.ball.x, p.y - S.ball.y); if (!best || d < best.d) best = { p, d }; }
    if (best && best.d > 1) { best.p.x = S.ball.x - (S.poss === 'H' ? 0.8 : -0.8); best.p.y = S.ball.y; }
    S.players = ps; applyPace(); save(); renderScen(); update();
  }
  function applyPace() { for (const p of S.players) { const pl = playerOf(p.team, p.role); p.pace = pl ? S.teams[p.team].pace[pid(pl)] || 1 : 1; } }

  // ---------------------------------------------------------------- team panel
  function renderTeam() {
    const t = S.teams[S.side], club = clubById(t.club);
    $('club').innerHTML = LIGA.clubs.map((c) => `<option value="${c.id}"${c.id === t.club ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
    $('formation').innerHTML = Object.keys(D.FORMATIONS).map((f) => `<option${f === t.formation ? ' selected' : ''}>${f}</option>`).join('');
    $('kit').value = String(t.kit);
    const groups = ['GK', 'DF', 'MF', 'FW'], gname = { GK: 'Goalkeepers', DF: 'Defenders', MF: 'Midfielders', FW: 'Forwards' };
    $('xi').innerHTML = D.slots(t.formation).map((s) => {
      const fit = GROUP_OF(s.label), order = [fit, ...groups.filter((g) => g !== fit)];
      const opts = order.map((g) => `<optgroup label="${gname[g]}">` + club.players.filter((p) => p.group === g)
        .map((p) => `<option value="${esc(pid(p))}"${t.xi[s.label] === pid(p) ? ' selected' : ''}>${p.num == null ? '' : p.num + ' · '}${esc(p.name)}</option>`).join('') + '</optgroup>').join('');
      const sel = S.sel && S.sel.team === S.side && S.sel.role === s.label;
      return `<label class="pg-slot${sel ? ' sel' : ''}"><span>${s.label}</span><select data-slot="${s.label}" aria-label="${s.label}">${opts}</select></label>`;
    }).join('');
    $('xi').querySelectorAll('select').forEach((el) => el.onchange = () => {
      const label = el.dataset.slot, id = el.value;
      for (const [k, v] of Object.entries(t.xi)) if (v === id && k !== label) t.xi[k] = t.xi[label];   // swap if already in the XI
      t.xi[label] = id; applyPace(); save(); renderTeam(); update();
    });
    $('clubSource').innerHTML = `Squad source: <a href="${esc(club.source)}" target="_blank" rel="noopener">${esc(new URL(club.source).hostname)}</a>, ${esc(club.as_of)}.` +
      (club.players.some((p) => p.num == null) && !/numbers/.test(club.as_of) ? ' Shirt numbers were not published there.' : '');
    $('tabUs').textContent = clubById(S.teams.H.club).short; $('tabThem').textContent = clubById(S.teams.A.club).short;
  }
  function bindTeam() {
    document.querySelectorAll('.pg-side button').forEach((b) => b.onclick = () => {
      S.side = b.dataset.side; document.querySelectorAll('.pg-side button').forEach((x) => x.classList.toggle('on', x === b)); renderTeam();
    });
    $('club').onchange = (e) => { const t = S.teams[S.side]; t.club = e.target.value; t.xi = autoXi(clubById(t.club), t.formation, {}); t.pace = {}; save(); renderTeam(); place(S.scen); };
    $('formation').onchange = (e) => { const t = S.teams[S.side]; const old = t.xi; t.formation = e.target.value; t.xi = autoXi(clubById(t.club), t.formation, old); save(); renderTeam(); place(S.scen); };
    $('kit').onchange = (e) => { S.teams[S.side].kit = +e.target.value; save(); draw(); };
    $('autoXi').onclick = () => { const t = S.teams[S.side]; t.xi = autoXi(clubById(t.club), t.formation, {}); applyPace(); save(); renderTeam(); update(); };
  }
  function renderScen() {
    $('scenarios').innerHTML = SCEN.map((s) => `<button type="button" data-s="${s.id}" class="${s.id === S.scen ? 'on' : ''}">${esc(s.name)}</button>`).join('');
    $('scenarios').querySelectorAll('button').forEach((b) => b.onclick = () => place(b.dataset.s));
    const sc = SCEN.find((s) => s.id === S.scen); $('scenText').textContent = sc ? sc.text : 'Your own set-up.';
  }

  // ---------------------------------------------------------------- pitch drawing (demo/pitch.js)
  const cv = $('pitch'), board = window.SB_PITCH.createBoard(cv, { L, W }); let view = null;
  function layout() {
    view = board.layout();
    $('dir').textContent = view.portrait ? T('Your team attacking ↑') : T('Your team attacking →');
  }
  const toPitch = board.toPitch;
  let danger = null, hints = [];
  function draw() {
    if (!view) return;
    board.begin();
    const kH = kitOf('H'), kA = kitOf('A'), accent = tok('--shadow') || '#6A4CF0';
    if (S.layers.space && danger) board.space(danger, model.CELL, kH, kA);
    const anim = S.anim, k = anim ? Math.min(1, (performance.now() - anim.t0) / 900) : 1, ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    if (S.layers.moves && !anim) for (const m of hints) board.arrow(m.x, m.y, m.sx, m.sy, accent);
    const r = Math.max(8, 1.55 * view.sc);
    S.players.forEach((p, i) => {
      let x = p.x, y = p.y; if (anim && anim.from[i]) { x = anim.from[i].x + (p.x - anim.from[i].x) * ease; y = anim.from[i].y + (p.y - anim.from[i].y) * ease; }
      const pl = playerOf(p.team, p.role), sel = S.sel && S.sel.team === p.team && S.sel.role === p.role;
      board.player(x, y, r, p.team === 'H' ? kH : kA, pl && pl.num != null ? String(pl.num) : p.role,
        S.layers.names ? (pl ? surname(pl.name) : p.role) : null, sel, accent);
    });
    board.ball(S.ball.x, S.ball.y);
    if (anim) { if (k < 1) requestAnimationFrame(draw); else { S.anim = null; update(); } }
  }

  // ---------------------------------------------------------------- model + panels
  const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
  const roleName = (team, role) => { const pl = playerOf(team, role); return pl ? `${pl.name} (${role})` : role; };
  function update() {
    const ev = model.evaluate(S.players, S.ball, S.poss);
    danger = model.dangerMap(S.players, S.ball, S.poss);
    const sim = model.simulate(S.players, S.ball, S.poss, 3);
    hints = sim.moves;
    const us = clubById(S.teams.H.club).short, them = clubById(S.teams.A.club).short;
    $('phase').textContent = S.poss === 'H' ? `${us} on the ball` : `${them} on the ball`;
    $('phase').className = 'tag ' + (S.poss === 'H' ? 'atk' : 'def');
    if (S.poss === 'H') {
      $('k1Label').textContent = 'Space owned'; $('k1').textContent = pct(ev.spaceOwned);
      $('k2Label').textContent = 'Rest defence'; $('k2').textContent = pct(ev.restDefence);
      $('kpiNote').textContent = `${us}'s share of the dangerous space ahead of the ball, and of its own dangerous space if the ball were lost now.`;
      $('meterH').style.width = (ev.spaceOwned * 100).toFixed(1) + '%';
    } else {
      $('k1Label').textContent = 'Space denied'; $('k1').textContent = pct(ev.spaceDenied);
      $('k2Label').textContent = 'Left to them'; $('k2').textContent = pct(1 - ev.spaceDenied);
      $('kpiNote').textContent = `${us}'s share of the space ${them} are attacking.`;
      $('meterH').style.width = (ev.spaceDenied * 100).toFixed(1) + '%';
    }
    const s = S.sim;
    for (const id of ['k1Sub', 'k2Sub']) { $(id).textContent = ''; $(id).className = ''; }
    if (s) {
      const d1 = s.after - s.before; $('k1Sub').textContent = `${d1 >= 0 ? '+' : ''}${(d1 * 100).toFixed(1)} pts after the move`; $('k1Sub').className = d1 >= 0 ? 'up' : 'down';
      if (s.restAfter != null) { const d2 = s.restAfter - s.restBefore; $('k2Sub').textContent = `${d2 >= 0 ? '+' : ''}${(d2 * 100).toFixed(1)} pts`; $('k2Sub').className = d2 >= 0 ? 'up' : 'down'; }
    }
    $('moves').innerHTML = hints.length ? hints.map((m) => {
      const dx = m.sx - m.x, dy = m.sy - m.y, dist = Math.hypot(dx, dy);
      const dir = (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'forward' : 'back') : (dy > 0 ? 'to his right' : 'to his left'));
      return `<li><b>${esc(roleName('H', m.role))}</b><span>${dist.toFixed(1)} m ${dir} · +${(m.gain * 100).toFixed(1)} pts</span></li>`;
    }).join('') : '<li><span>No single move worth 0.4 points: the shape is already close to the best the model finds.</span></li>';
    $('movesSum').textContent = hints.length ? `+${((sim.after - sim.before) * 100).toFixed(1)} pts together` : '';
    $('simBtn').disabled = !hints.length;
    renderPlayer(); draw();
  }
  function simulate() {
    const res = model.simulate(S.players, S.ball, S.poss, 4);
    if (!res.moves.length) return;
    S.anim = { t0: performance.now(), from: S.players.map((p) => ({ x: p.x, y: p.y })) };
    S.players = res.players; S.sim = res;
    $('simResult').hidden = false;
    $('simResult').innerHTML = `<b>${pct(res.before)} → ${pct(res.after)}</b><span>${res.moves.length} player${res.moves.length > 1 ? 's' : ''} moved, each within 5 m: ${res.moves.map((m) => esc(m.role)).join(', ')}.` +
      (res.restAfter != null ? ` Rest defence ${pct(res.restBefore)} → ${pct(res.restAfter)}.` : '') + '</span>';
    requestAnimationFrame(draw); setTimeout(update, 950);
  }
  function renderPlayer() {
    const card = $('playerCard'); if (!S.sel) { card.hidden = true; return; }
    const p = S.players.find((q) => q.team === S.sel.team && q.role === S.sel.role); if (!p) { card.hidden = true; return; }
    const pl = playerOf(p.team, p.role), kit = kitOf(p.team);
    card.hidden = false; $('pAv').style.background = kit; $('pAv').style.color = ink(kit); $('pAv').textContent = pl && pl.num != null ? pl.num : p.role;
    $('pName').textContent = pl ? pl.name : p.role; $('pRole').textContent = `${p.role} · ${clubById(S.teams[p.team].club).name}`;
    $('pace').value = p.pace || 1; $('paceOut').textContent = (p.pace || 1).toFixed(2) + '×';
  }

  // ---------------------------------------------------------------- interaction
  let drag = null;
  function hit(e) {
    const rect = cv.getBoundingClientRect(), [x, y] = toPitch(e.clientX - rect.left, e.clientY - rect.top);
    if (Math.hypot(x - S.ball.x, y - S.ball.y) < 2.2) return { ball: true, x, y };
    let best = null; S.players.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y); if (d < 3.2 && (!best || d < best.d)) best = { i, d }; });
    return best ? { i: best.i, x, y } : { x, y };
  }
  cv.addEventListener('pointerdown', (e) => {
    const h = hit(e); if (h.ball || h.i != null) { drag = Object.assign(h, { moved: false }); cv.setPointerCapture(e.pointerId); cv.classList.add('dragging'); }
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const rect = cv.getBoundingClientRect(), [x, y] = toPitch(e.clientX - rect.left, e.clientY - rect.top);
    const cx = Math.max(0.5, Math.min(L - 0.5, x)), cy = Math.max(0.5, Math.min(W - 0.5, y));
    if (drag.ball) S.ball = { x: cx, y: cy }; else { S.players[drag.i].x = cx; S.players[drag.i].y = cy; }
    drag.moved = true; S.sim = null; hints = []; draw();
  });
  const end = () => {
    if (!drag) return; const d = drag; drag = null; cv.classList.remove('dragging');
    if (!d.moved && d.i != null) { const p = S.players[d.i]; S.sel = S.sel && S.sel.team === p.team && S.sel.role === p.role ? null : { team: p.team, role: p.role };
      if (S.sel) { S.side = p.team; document.querySelectorAll('.pg-side button').forEach((x) => x.classList.toggle('on', x.dataset.side === p.team)); renderTeam(); } }
    if (d.moved) { S.scen = 'free'; renderScen(); }
    update();
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  $('pace').oninput = (e) => {
    const p = S.players.find((q) => q.team === S.sel.team && q.role === S.sel.role), pl = playerOf(p.team, p.role), v = +e.target.value;
    p.pace = v; if (pl) S.teams[p.team].pace[pid(pl)] = v; $('paceOut').textContent = v.toFixed(2) + '×'; save();
  };
  $('pace').onchange = () => update();
  $('closePlayer').onclick = () => { S.sel = null; renderTeam(); update(); };
  $('simBtn').onclick = simulate;
  $('swapBtn').onclick = () => {
    S.poss = S.poss === 'H' ? 'A' : 'H'; S.sim = null;
    let best = null; for (const p of S.players) if (p.team === S.poss && p.role !== 'GK') { const d = Math.hypot(p.x - S.ball.x, p.y - S.ball.y); if (!best || d < best.d) best = { p, d }; }
    if (best) S.ball = { x: best.p.x + (S.poss === 'H' ? 0.8 : -0.8), y: best.p.y };
    S.scen = 'free'; renderScen(); update();
  };
  $('resetBtn').onclick = () => place(S.scen === 'free' ? 'build' : S.scen);
  document.querySelectorAll('[data-layer]').forEach((b) => b.onclick = () => { const k = b.dataset.layer; S.layers[k] = !S.layers[k]; b.classList.toggle('on', S.layers[k]); draw(); });
  window.addEventListener('resize', () => { layout(); draw(); });
  window.addEventListener('sb-theme', () => draw());

  // ---------------------------------------------------------------- start
  $('season').textContent = LIGA.season;
  bindTeam(); renderTeam(); layout(); place(S.scen === 'free' ? 'build' : S.scen);
})();
