/* Tactics board: pick two LaLiga sides, formations, styles and XIs. Moments: set a scenario, drag
   players and the ball, and read the Shadow Ball model (demo/model.js) live. Full match: play
   2 x 45 minutes with demo/sim.js, track where the model wanted your players, and at half time
   search every formation x style against the opponent (demo/sim-worker.js). "Your team" is H. */
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
  const SUFFIX = /^(Júnior|Junior|Jr\.?|Filho|Neto|Sobrinho)$/i;     // "Vinícius Júnior" is Vinícius on a shirt
  const surname = (n) => {
    let parts = n.split(' ');
    if (parts.length > 1 && SUFFIX.test(parts[parts.length - 1])) { parts = parts.slice(0, -1); if (parts.length === 1) return parts[0]; }
    const s = parts.join(' '); return parts.length > 1 && s.length > 12 ? parts.slice(1).join(' ') : s;
  };

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
  const S = { mode: 'moments', side: 'H', scen: 'build', poss: 'H', ball: { x: 14, y: 24 }, players: [], sel: null, layers: { space: true, moves: true, names: true },
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
  function save() { try { localStorage.setItem('sb_pg', JSON.stringify({ teams: S.teams, scen: S.scen, side: S.side, mode: S.mode })); } catch (e) { /* storage blocked */ } }

  function fromLink() {                                // playground.html#s=<base64 json> from "Copy link"
    const m = location.hash.match(/[#&]s=([A-Za-z0-9_-]+)/); if (!m) return null;
    try {
      const j = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')))));
      if (j && j.t && j.t.H && j.t.A) return { teams: j.t, mode: j.m === 'match' ? 'match' : 'moments', scen: 'build', side: 'H' };
    } catch (e) { /* a broken link falls back to the saved set-up */ }
    return null;
  }
  const saved = fromLink() || load();
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
    $('style').innerHTML = Object.keys(window.SB_SIM.STYLES).map((k) => `<option value="${k}"${k === (t.style || 'possession') ? ' selected' : ''}>${esc(window.SB_SIM.STYLES[k].name)}</option>`).join('');
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
      if (S.mode === 'match' && !subAllowed(S.side, id)) { el.value = t.xi[label]; return; }
      for (const [k, v] of Object.entries(t.xi)) if (v === id && k !== label) t.xi[k] = t.xi[label];   // swap if already in the XI
      t.xi[label] = id; applyPace(); save(); renderTeam(); refresh();
    });
    $('clubSource').innerHTML = `Squad source: <a href="${esc(club.source)}" target="_blank" rel="noopener">${esc(new URL(club.source).hostname)}</a>, ${esc(club.as_of)}.` +
      (club.players.some((p) => p.num == null) && !/numbers/.test(club.as_of) ? ' Shirt numbers were not published there.' : '');
    $('tabUs').textContent = clubById(S.teams.H.club).short; $('tabThem').textContent = clubById(S.teams.A.club).short;
  }
  function bindTeam() {
    document.querySelectorAll('.pg-side button').forEach((b) => b.onclick = () => {
      S.side = b.dataset.side; document.querySelectorAll('.pg-side button').forEach((x) => x.classList.toggle('on', x === b)); renderTeam();
    });
    $('club').onchange = (e) => { const t = S.teams[S.side]; t.club = e.target.value; t.xi = autoXi(clubById(t.club), t.formation, {}); t.pace = {}; save(); renderTeam(); changed(); };
    $('formation').onchange = (e) => { const t = S.teams[S.side]; const old = t.xi; t.formation = e.target.value; t.xi = autoXi(clubById(t.club), t.formation, old); save(); renderTeam(); changed(); };
    $('kit').onchange = (e) => { S.teams[S.side].kit = +e.target.value; save(); draw(); };
    $('autoXi').onclick = () => { const t = S.teams[S.side]; t.xi = autoXi(clubById(t.club), t.formation, {}); applyPace(); save(); renderTeam(); refresh(); };
    $('style').onchange = (e) => { S.teams[S.side].style = e.target.value; save(); if (S.mode === 'match') matchTeamsChanged(); };
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
    if (S.mode === 'match') { drawMatch(); return; }
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
    if (S.mode === 'match') { draw(); return; }
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
  const ATTRS = ['pace', 'passing', 'finishing'];
  const attrOf = (team, role, k) => { const pl = playerOf(team, role), m = S.teams[team][k]; return (pl && m && m[pid(pl)]) || 1; };
  function renderPlayer() {
    const card = $('playerCard');
    if (!S.sel || !D.slots(S.teams[S.sel.team].formation).some((x) => x.label === S.sel.role)) { card.hidden = true; return; }
    const { team, role } = S.sel, pl = playerOf(team, role), kit = kitOf(team);
    card.hidden = false; $('pAv').style.background = kit; $('pAv').style.color = ink(kit); $('pAv').textContent = pl && pl.num != null ? pl.num : role;
    $('pName').textContent = pl ? pl.name : role; $('pRole').textContent = `${role} · ${clubById(S.teams[team].club).name}`;
    for (const k of ATTRS) { const v = attrOf(team, role, k); $(k).value = v; $(k + 'Out').textContent = v.toFixed(2) + '×'; }
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
    if (S.mode === 'match') {                         // a click picks a player (his card), nothing is dragged
      if (!X.m) return;
      const rect = cv.getBoundingClientRect(), [x, y] = toPitch(e.clientX - rect.left, e.clientY - rect.top);
      let best = null; X.m.S.players.forEach((p) => { const d = Math.hypot(p.x - x, p.y - y); if (d < 3.2 && (!best || d < best.d)) best = { p, d }; });
      if (best) {
        S.sel = { team: best.p.team, role: best.p.role }; S.side = best.p.team;
        document.querySelectorAll('.pg-side button').forEach((b) => b.classList.toggle('on', b.dataset.side === S.side)); renderTeam(); renderPlayer();
      }
      return;
    }
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
  for (const k of ATTRS) {
    $(k).oninput = (e) => {
      if (!S.sel) return;
      const t = S.teams[S.sel.team], pl = playerOf(S.sel.team, S.sel.role), v = +e.target.value;
      if (pl) { t[k] = t[k] || {}; t[k][pid(pl)] = v; }
      if (k === 'pace') { const p = S.players.find((q) => q.team === S.sel.team && q.role === S.sel.role); if (p) p.pace = v; }
      $(k + 'Out').textContent = v.toFixed(2) + '×'; save();
    };
    $(k).onchange = () => { if (S.mode === 'match') matchTeamsChanged(); else update(); };
  }
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

  function changed() { if (S.mode === 'match') matchTeamsChanged(); else place(S.scen); }
  function refresh() { if (S.mode === 'match') matchTeamsChanged(); else update(); }

  // ---------------------------------------------------------------- full match (demo/sim.js)
  const SIMM = window.SB_SIM, VER = '20261124a', MAX_SUBS = 5;
  const X = { m: null, seed: 1, state: 'idle', speed: 30, acc: 0, last: 0, prev: null, raf: 0, best: null, phase: 'in', team: 'H',
              nextSample: 20, skipping: false, advice: null, busy: false, danger: null, shown: 0 };
  const short = (t) => clubById(S.teams[t].club).short;
  const other = (t) => (t === 'H' ? 'A' : 'H');
  function cfgOf(team) {
    const t = S.teams[team], out = { formation: t.formation, style: t.style || 'possession', names: {}, pace: {}, passing: {}, finishing: {} };
    for (const s of D.slots(t.formation)) {
      const pl = playerOf(team, s.label); if (!pl) continue;
      out.names[s.label] = surname(pl.name);
      for (const k of ATTRS) out[k][s.label] = (t[k] && t[k][pid(pl)]) || 1;
    }
    return out;
  }
  function subAllowed(team, id) {                     // up to five substitutions once the match is under way
    if (!X.m || X.state === 'idle' || X.state === 'ft') return true;
    if (Object.values(S.teams[team].xi).includes(id)) return true;          // a swap inside the XI
    if (X.m.S.stats[team].subs < MAX_SUBS) return true;
    $('matchText').textContent = T('No substitutions left: {n} used.', { n: MAX_SUBS }); return false;
  }
  function stopLoop() { if (X.raf) cancelAnimationFrame(X.raf); X.raf = 0; }
  const blankBest = () => ({ in: {}, out: {}, n: { in: 0, out: 0 } });
  function newMatch() {
    stopLoop();
    X.seed = (Math.random() * 1e9) >>> 0;
    X.m = SIMM.create({ surface: TH.surface, cell: TH.cell, slots: D.slots, seed: X.seed, H: cfgOf('H'), A: cfgOf('A') });
    Object.assign(X, { state: 'idle', acc: 0, prev: null, nextSample: 20, advice: null, danger: null, best: { H: blankBest(), A: blankBest() } });
    renderMatch(true); renderAdvice(); draw();
  }
  function matchTeamsChanged() {
    if (!X.m || X.state === 'idle' || X.state === 'ft') { newMatch(); return; }
    X.m.setTeam('H', cfgOf('H')); X.m.setTeam('A', cfgOf('A')); X.prev = null;
    renderMatch(true); draw();
  }
  function setMode(mode) {
    S.mode = mode; save();
    document.body.classList.toggle('mode-match', mode === 'match');
    document.querySelectorAll('.pg-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    if (mode === 'match') { if (!X.m) newMatch(); else { renderMatch(true); draw(); } }
    else { if (X.state === 'playing') pause(); place(S.scen === 'free' ? 'build' : S.scen); }
  }

  // where the model wanted each team's players: average position per phase, and the mean of its suggested moves
  function movesFor(team, M2) {
    // model.simulate moves the H side; for A, mirror the pitch so A attacks right, then mirror the moves back
    const flip = team === 'A', fx = (x) => (flip ? L - x : x), fy = (y) => (flip ? W - y : y), ft = (t) => (flip ? other(t) : t);
    const ps = M2.players.map((p) => ({ team: ft(p.team), role: p.role, x: fx(p.x), y: fy(p.y), pace: p.pace }));
    const res = model.simulate(ps, { x: fx(M2.ball.x), y: fy(M2.ball.y) }, ft(M2.poss), 3);
    return res.moves.map((mv) => ({ role: mv.role, dx: flip ? -(mv.sx - mv.x) : mv.sx - mv.x, dy: flip ? -(mv.sy - mv.y) : mv.sy - mv.y }));
  }
  function track() {
    const M2 = X.m.S; if (M2.dead || (M2.ball.owner < 0 && !M2.ball.fly)) return;
    for (const team of ['H', 'A']) {
      const ph = M2.poss === team ? 'in' : 'out', B = X.best[team][ph];
      for (const p of M2.players) if (p.team === team && p.role !== 'GK') {
        const r = B[p.role] || (B[p.role] = { ax: 0, ay: 0, n: 0, ox: 0, oy: 0, m: 0 }); r.ax += p.x; r.ay += p.y; r.n += 1;
      }
    }
    if (M2.clock >= X.nextSample && M2.ball.owner >= 0) {
      X.nextSample = M2.clock + (X.skipping ? 30 : 20);
      for (const team of ['H', 'A']) {
        const ph = M2.poss === team ? 'in' : 'out', B = X.best[team][ph]; X.best[team].n[ph] += 1;
        for (const mv of movesFor(team, M2)) { const r = B[mv.role]; if (r) { r.ox += mv.dx; r.oy += mv.dy; r.m += 1; } }
      }
    }
  }
  function stepOnce() {
    const m = X.m, h = m.S.half;
    X.prev = m.S.players.map((p) => ({ x: p.x, y: p.y })).concat([{ x: m.S.ball.x, y: m.S.ball.y }]);
    m.step(1); track();
    if (m.S.ended) { X.state = 'ft'; onBreak(); } else if (m.S.half !== h) { X.state = 'ht'; onBreak(); }
  }
  function loop(now) {
    X.raf = 0; if (X.state !== 'playing') return;
    const dt = Math.min(0.1, (now - (X.last || now)) / 1000); X.last = now;
    X.acc += dt * X.speed;
    for (let n = 0; X.acc >= 1 && n < 200 && X.state === 'playing'; n++) { stepOnce(); X.acc -= 1; }
    if (now - X.shown > 250) { X.shown = now; renderMatch(); }
    draw();
    if (X.state === 'playing') X.raf = requestAnimationFrame(loop);
  }
  function play() { X.state = 'playing'; X.last = 0; X.m.S.paused = false; renderMatch(true); stopLoop(); X.raf = requestAnimationFrame(loop); }
  function pause() { X.state = 'paused'; stopLoop(); renderMatch(true); draw(); }
  function skip() {
    if (!X.m || X.state === 'ht' || X.state === 'ft') return;
    stopLoop(); X.state = 'playing'; X.skipping = true; X.prev = null; $('skipBtn').disabled = true;
    const chunk = () => {
      for (let n = 0; n < 240 && X.state === 'playing'; n++) stepOnce();
      renderMatch(); draw();
      if (X.state === 'playing') setTimeout(chunk, 0); else X.skipping = false;
    };
    chunk();
  }
  function onBreak() {
    stopLoop(); X.prev = null; X.skipping = false;
    if (!S.layers.best) { S.layers.best = true; document.querySelector('[data-layer="best"]').classList.add('on'); }
    renderMatch(true); renderAdvice(); draw();
  }

  // ---- panels
  const minuteOf = (e) => { const m = Math.floor(e.t / 60) + 1, cap = e.half === 1 ? 45 : 90; return m > cap ? `${cap}+${m - cap}'` : `${m}'`; };
  function renderFor() {
    $('forH').textContent = short('H'); $('forA').textContent = short('A');
    document.querySelectorAll('.pg-for button').forEach((b) => b.classList.toggle('on', b.dataset.for === X.team));
  }
  function renderMatch(force) {
    if (!X.m) return;
    const M2 = X.m.S, sH = M2.stats.H, sA = M2.stats.A;
    $('nameH').textContent = short('H'); $('nameA').textContent = short('A'); renderFor();
    $('kitH').style.background = kitOf('H'); $('kitA').style.background = kitOf('A');
    $('score').textContent = `${sH.goals}–${sA.goals}`;
    const clk = $('clock');
    clk.textContent = X.state === 'idle' ? "0'" : X.state === 'ht' ? T('HT') : X.state === 'ft' ? T('FT') : `${Math.min(M2.half * 45 + 5, Math.floor(M2.clock / 60) + 1)}'`;
    clk.classList.toggle('live', X.state === 'playing');
    $('playBtn').textContent = { idle: 'Kick off', playing: 'Pause', paused: 'Resume', ht: 'Start the second half', ft: 'New match' }[X.state];
    $('skipBtn').textContent = M2.half === 1 ? 'Skip to half time' : 'Skip to full time';
    $('skipBtn').disabled = X.state === 'ht' || X.state === 'ft' || X.skipping;
    $('matchText').textContent = X.state === 'idle' ? 'Pick both teams, formations, styles and players on the left, then kick off. 2 × 45 minutes, played in your browser.'
      : X.state === 'ht' ? 'Half time. Read the best positions, ask for a second-half suggestion, or change formation, style or players on the left, then start the second half.'
      : X.state === 'ft' ? 'Full time. The suggestion below shows which set-up would have suited this opponent.'
      : `${SIMM.STYLES[M2.teams.H.style].name} ${M2.teams.H.formation} against ${SIMM.STYLES[M2.teams.A.style].name} ${M2.teams.A.formation}.`;
    // stats
    const tot = sH.poss + sA.poss || 1, pH = Math.round(sH.poss / tot * 100), idle = X.state === 'idle';
    $('possBar').style.width = (idle ? 50 : pH) + '%';
    const acc = (s) => (s.passes ? Math.round(s.completed / s.passes * 100) + '%' : '—');
    const rows = [['Possession', idle ? '—' : pH + '%', idle ? '—' : (100 - pH) + '%', pH, 100 - pH],
      ['Shots (on target)', `${sH.shots} (${sH.onTarget})`, `${sA.shots} (${sA.onTarget})`, sH.shots, sA.shots],
      ['Expected goals (xG)', sH.xg.toFixed(2), sA.xg.toFixed(2), sH.xg, sA.xg],
      ['Passes', sH.passes, sA.passes, sH.passes, sA.passes],
      ['Pass accuracy', acc(sH), acc(sA), sH.completed / (sH.passes || 1), sA.completed / (sA.passes || 1)],
      ['Final-third entries', sH.entries, sA.entries, sH.entries, sA.entries],
      ['Balls won in their half', sH.regainsHigh, sA.regainsHigh, sH.regainsHigh, sA.regainsHigh],
      ['Corners', sH.corners, sA.corners, sH.corners, sA.corners],
      ['Offsides', sH.offsides, sA.offsides, 0, 0],
      ['Substitutions', `${sH.subs}/${MAX_SUBS}`, `${sA.subs}/${MAX_SUBS}`, 0, 0]];
    $('stats').innerHTML = `<tr><td>${esc(short('H'))}</td><td></td><td>${esc(short('A'))}</td></tr>` +
      rows.map(([k, a, b, va, vb]) => `<tr><td class="${va > vb ? 'lead' : ''}">${a}</td><td>${k}</td><td class="${vb > va ? 'lead' : ''}">${b}</td></tr>`).join('');
    $('statsNote').textContent = X.state === 'ht' ? 'First half' : '';
    // events, newest first
    let gh = 0, ga = 0; const items = [];
    for (const e of M2.events) {
      if (e.kind === 'goal') { if (e.team === 'H') gh++; else ga++; items.push(`<li class="goal"><time>${minuteOf(e)}</time><span><b>Goal</b> · ${esc(e.who)} (${esc(short(e.team))}) · xG ${e.xg.toFixed(2)} · ${gh}–${ga}</span></li>`); }
      else if (e.kind === 'chance') items.push(`<li><time>${minuteOf(e)}</time><span>Big chance · ${esc(e.who)} (${esc(short(e.team))}) · xG ${e.xg.toFixed(2)}</span></li>`);
      else if (e.kind === 'sub') items.push(`<li class="sub"><time>${minuteOf(e)}</time><span>Substitution · ${esc(e.who)} on${e.off ? ' for ' + esc(e.off) : ''} (${esc(short(e.team))})</span></li>`);
      else if (e.kind === 'ht' || e.kind === 'ft') items.push(`<li class="break"><time>${e.kind === 'ht' ? T('HT') : T('FT')}</time><span>${e.kind === 'ht' ? 'Half time' : 'Full time'} ${gh}–${ga}</span></li>`);
    }
    const evHtml = items.length ? items.reverse().join('') : '<li class="note">No goals or big chances yet.</li>';
    if (force || $('events').dataset.n !== String(items.length)) { $('events').innerHTML = evHtml; $('events').dataset.n = String(items.length); }
    renderBest();
    $('adviceBtn').disabled = X.busy || X.state === 'playing' || X.state === 'idle';
    if (S.layers.space) {
      const ps = M2.players.map((p) => ({ team: p.team, role: p.role, x: p.x, y: p.y, pace: p.pace }));
      X.danger = model.dangerMap(ps, { x: M2.ball.x, y: M2.ball.y }, M2.poss);
    }
  }
  function bestOf(team, ph) {
    const B = X.best[team][ph], n = X.best[team].n[ph], out = [];
    for (const p of X.m.S.players) {
      if (p.team !== team || p.role === 'GK') continue;
      const r = B[p.role]; if (!r || !r.n) continue;
      const freq = n ? r.m / n : 0, ox = r.m ? r.ox / r.m : 0, oy = r.m ? r.oy / r.m : 0;
      out.push({ role: p.role, x: r.ax / r.n, y: r.ay / r.n, ox, oy, freq, size: Math.hypot(ox, oy) * freq });
    }
    return out.sort((a, b) => b.size - a.size);
  }
  const shows = (b) => b.freq >= 0.08 && Math.hypot(b.ox, b.oy) > 0.8;
  function renderBest() {
    const team = X.team, n = X.best ? X.best[team].n[X.phase] : 0, list = n ? bestOf(team, X.phase).filter(shows).slice(0, 5) : [];
    $('bestList').innerHTML = !n ? '<li><span>Play some minutes first: the board samples the match every 20 seconds.</span></li>'
      : !list.length ? '<li><span>No player the model kept wanting somewhere else: the shape held up in this phase.</span></li>'
      : list.map((b) => {
        // directions in the team's own frame: forward = towards the goal it attacks
        const fx = team === 'H' ? b.ox : -b.ox, fy = team === 'H' ? b.oy : -b.oy;
        const dir = (Math.abs(fx) > Math.abs(fy) ? (fx > 0 ? 'forward' : 'back') : (fy > 0 ? 'to his right' : 'to his left'));
        return `<li><b>${esc(roleName(team, b.role))}</b><span>${Math.hypot(b.ox, b.oy).toFixed(1)} m ${dir} · in ${Math.round(b.freq * 100)}% of ${n} moments</span></li>`;
      }).join('');
  }
  function drawBest(r, accent) {
    const team = X.team, kit = kitOf(team), list = bestOf(team, X.phase), g = board.g;
    for (const b of list) {                           // averages first, numbers only: names sit in the list beside the pitch
      const pl = playerOf(team, b.role);
      board.player(b.x, b.y, r, kit, pl && pl.num != null ? String(pl.num) : b.role, null, false, accent);
    }
    for (const b of list) if (shows(b)) {            // then the arrows on top, thicker the more often he was moved
      g.save(); g.globalAlpha = Math.min(1, 0.55 + b.freq);
      board.arrow(b.x, b.y, b.x + b.ox, b.y + b.oy, accent, 2.5 + 3 * Math.min(1, b.freq)); g.restore();
    }
  }
  function drawMatch() {
    if (!view || !X.m) return;
    board.begin();
    const M2 = X.m.S, kH = kitOf('H'), kA = kitOf('A'), accent = tok('--shadow') || '#6A4CF0', r = Math.max(8, 1.55 * view.sc), g = board.g;
    if (S.layers.space && X.danger) board.space(X.danger, model.CELL, kH, kA);
    const still = X.state !== 'playing', avg = S.layers.best && still && X.best && X.best[X.team].n[X.phase] > 0;
    const f = X.prev && !X.skipping && X.speed <= 30 ? Math.min(1, X.acc) : 1, lerp = (i, p) => { const q = X.prev && X.prev[i] ? X.prev[i] : p; return [q.x + (p.x - q.x) * f, q.y + (p.y - q.y) * f]; };
    M2.players.forEach((p, i) => {
      const [x, y] = lerp(i, p), pl = playerOf(p.team, p.role), kit = p.team === 'H' ? kH : kA, num = pl && pl.num != null ? String(pl.num) : p.role;
      if (avg) { if (p.team !== X.team) { g.save(); g.globalAlpha = 0.28; board.player(x, y, r * 0.85, kit, num, null, false, accent); g.restore(); } return; }
      board.player(x, y, r, kit, num, S.layers.names ? (pl ? surname(pl.name) : p.role) : null, S.sel && S.sel.team === p.team && S.sel.role === p.role, accent);
    });
    if (avg) drawBest(r, accent);
    const [bx, by] = lerp(M2.players.length, M2.ball); board.ball(bx, by);
  }

  // ---- the suggestion: every formation x style for one team against the other's current set-up
  function renderAdvice() {
    const A = X.advice, st = X.m ? X.state : 'idle', team = X.team;
    $('adviceTitle').textContent = st === 'ft' ? 'What would have fitted' : 'Second-half suggestion';
    $('adviceBtn').textContent = X.busy ? 'Simulating…' : T('Find the best set-up for {team}', { team: short(team) });
    if (!A || A.team !== team) { $('advice').innerHTML = ''; $('adviceNote').textContent = 'At half time the board plays every formation and style for the team you pick against the other set-up, and suggests what fits best.'; return; }
    const { res, cur, opp, runs, lean } = A, ci = res.findIndex((x) => x.formation === cur.formation && x.style === cur.style), now = res[ci];
    const sgn = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2), top = res.slice(0, 3);
    const close = now && top[0] && top[0].score - now.score < 2 * Math.max(top[0].se, now.se, 0.05);
    $('adviceNote').textContent = `From ${runs} simulated 45-minute halves per set-up (${res.length} set-ups) against ${SIMM.STYLES[opp.style].name} ${opp.formation}. ` +
      (lean ? lean + ' ' : '') + (close ? 'The current set-up is within the simulation noise of the best one.' : 'Players count as rated on their cards (1.00× unless you change it).');
    const row = (x, cls) => `<li class="${cls}"><b>${x.formation} · ${esc(SIMM.STYLES[x.style].name)}</b><span>xG difference per half ${sgn(x.xgd)} (${esc(short(team))} ${x.xgf.toFixed(2)}, ${esc(short(other(team)))} ${x.xga.toFixed(2)})</span>` +
      (cls === 'now' ? '<span>Set-up now</span>' : `<button type="button" class="ghost small" data-f="${x.formation}" data-s="${x.style}">Use</button>`) + '</li>';
    $('advice').innerHTML = top.map((x, i) => (x === now ? row(x, 'now') : row(x, i === 0 ? 'top' : ''))).join('') + (ci >= 3 && now ? row(now, 'now') : '');
    $('advice').querySelectorAll('button[data-f]').forEach((b) => b.onclick = () => {
      const t = S.teams[team], old = t.xi; t.formation = b.dataset.f; t.style = b.dataset.s; t.xi = autoXi(clubById(t.club), t.formation, old);
      S.side = team; document.querySelectorAll('.pg-side button').forEach((x) => x.classList.toggle('on', x.dataset.side === team));
      applyPace(); save(); renderTeam(); X.advice.cur = { formation: t.formation, style: t.style }; renderAdvice();
      if (X.state === 'ft') newMatch(); else matchTeamsChanged();
    });
  }
  function findAdvice() {
    if (X.busy || !X.m) return;
    const team = X.team, opp = other(team), t = S.teams[team], M2 = X.m.S;
    const cur = { formation: t.formation, style: t.style || 'possession' }, oppSet = { formation: S.teams[opp].formation, style: S.teams[opp].style || 'possession' };
    const formations = SIMM.FORMATIONS_TRY.includes(cur.formation) ? SIMM.FORMATIONS_TRY.slice() : SIMM.FORMATIONS_TRY.concat([cur.formation]);
    // the score decides the trade-off at half time: chasing the game weighs chances made, protecting a lead weighs chances given away
    const diff = M2.stats[team].goals - M2.stats[opp].goals, ht = X.state === 'ht';
    const weights = !ht || diff === 0 ? { f: 1, a: 1 } : diff < 0 ? { f: 1.3, a: 0.7 } : { f: 0.7, a: 1.3 };
    const lean = !ht || diff === 0 ? '' : diff < 0 ? T('{team} are behind, so chances made count more than chances given away.', { team: short(team) }) : T('{team} are ahead, so chances given away count more than chances made.', { team: short(team) });
    const base = { H: cfgOf('H'), A: cfgOf('A'), side: team, runs: 10, half2: ht, weights, seed: X.seed % 100000 + 1 };
    const parts = [formations.filter((_, i) => i % 2 === 0), formations.filter((_, i) => i % 2 === 1)];
    const prog = $('adviceProg'), pr = [0, 0], results = [];
    X.busy = true; prog.hidden = false; prog.firstElementChild.style.width = '0%'; $('adviceBtn').disabled = true; renderAdvice();
    const progress = () => { prog.firstElementChild.style.width = ((pr[0] + pr[1]) * 50).toFixed(0) + '%'; };
    const done = (res, runs) => {
      X.busy = false; prog.hidden = true;
      X.advice = { team, res: res.sort((a, b) => b.score - a.score), cur, opp: oppSet, runs, lean }; renderAdvice(); renderMatch(true);
    };
    const inPage = () => setTimeout(() => done(SIMM.search(Object.assign({ surface: TH.surface, cell: TH.cell, slots: D.slots }, base, { runs: 4, formations }), (p) => { pr[0] = p; pr[1] = p; progress(); }), 4), 30);
    let workers;
    try { workers = parts.map(() => new Worker('sim-worker.js?v=' + VER)); } catch (e) { inPage(); return; }
    let left = workers.length, failed = false;
    workers.forEach((w, i) => {
      w.onmessage = (e) => {
        if (e.data.done) { w.terminate(); results.push(...e.data.done); if (--left === 0 && !failed) done(results, base.runs); }
        else { pr[i] = e.data.progress; progress(); }
      };
      w.onerror = (e) => { e.preventDefault(); workers.forEach((x) => x.terminate()); if (!failed) { failed = true; inPage(); } };
      w.postMessage(Object.assign({}, base, { formations: parts[i] }));
    });
  }

  // ---- a link that opens this set-up (teams, formations, styles, XIs, ratings) on another device
  function shareLink() {
    const pack = { m: S.mode, t: S.teams };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(pack)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = location.href.split('#')[0] + '#s=' + b64, box = $('shareLink');
    box.value = url; box.hidden = false; box.select();
    const ok = () => { $('shareBtn').textContent = T('Link copied'); setTimeout(() => { $('shareBtn').textContent = T('Copy link'); }, 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(ok, () => {}); else { try { document.execCommand('copy'); ok(); } catch (e) { /* the box stays selected */ } }
  }

  document.querySelectorAll('.pg-mode button').forEach((b) => b.onclick = () => setMode(b.dataset.mode));
  document.querySelectorAll('.pg-speed button').forEach((b) => b.onclick = () => {
    X.speed = +b.dataset.speed; document.querySelectorAll('.pg-speed button').forEach((x) => x.classList.toggle('on', x === b));
  });
  document.querySelectorAll('.pg-phase button').forEach((b) => b.onclick = () => {
    X.phase = b.dataset.phase; document.querySelectorAll('.pg-phase button').forEach((x) => x.classList.toggle('on', x === b)); renderBest(); draw();
  });
  document.querySelectorAll('.pg-for button').forEach((b) => b.onclick = () => { X.team = b.dataset.for; renderFor(); renderBest(); renderAdvice(); draw(); });
  $('playBtn').onclick = () => { if (X.state === 'playing') pause(); else if (X.state === 'ft') newMatch(); else play(); };
  $('skipBtn').onclick = skip;
  $('newBtn').onclick = newMatch;
  $('adviceBtn').onclick = findAdvice;
  $('shareBtn').onclick = shareLink;

  // ---------------------------------------------------------------- start
  $('season').textContent = LIGA.season;
  if (saved && saved.mode === 'match' || location.hash === '#match') S.mode = 'match';
  bindTeam(); renderTeam(); layout(); place(S.scen === 'free' ? 'build' : S.scen); setMode(S.mode);
})();
