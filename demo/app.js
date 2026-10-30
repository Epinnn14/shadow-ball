/* Shadow Ball demo — the coach's live screen (laptop) and the pitch-side view (phone).
   Replays one clip "as live": python run.py demo -> /data/clip.json, python run.py serve.
   The laptop leads the clock; phones follow it through /api/state. The coach's line-up
   (names, numbers, formation, own photos) is kept on the laptop through /api/lineup.

   Every view shows OUR team attacking to the right (up on a phone). */
(function () {
  'use strict';
  const D = window.SB_DATA;
  const $ = (id) => document.getElementById(id);
  const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const params = new URLSearchParams(location.search);
  const narrow = () => matchMedia('(max-width: 900px)').matches;
  const CSS = getComputedStyle(document.documentElement);
  const COL = { shadow: '#A78BFA', ok: '#4ADE80', warn: '#FBBF24', bad: '#F87171', D: '#3A3F47' };
  const LEVEL = { red: COL.bad, amber: COL.warn, green: COL.ok, 'no data': '#4B5159' };
  let L = 105.3, W = 68;

  let C, meta, labels, nFrames, duration, flipH, half1End = Infinity;
  const inClip = new Set();
  const S = { t: 0, playing: false, speed: 1, team: 'H', sel: null, follow: false,
              layers: { names: true }, seen: new Set(), feedKey: '' };
  let lineup = null, roleToPlayer = {};

  // ================================================================== load
  Promise.all([
    fetch('data/clip.json').then((r) => { if (!r.ok) throw new Error('No clip.json yet: run python run.py demo'); return r.json(); }),
    fetch('api/lineup', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { lineup: null })).catch(() => ({ lineup: null })),
  ]).then(([clip, saved]) => init(clip, saved.lineup)).catch((e) => { $('loading').textContent = e.message; });

  function init(clip, savedLineup) {
    C = clip; meta = C.meta; labels = meta.labels; [L, W] = meta.pitch;
    if (meta.teams.A === 'Atletic Club') meta.teams.A = 'Athletic Club';   // spelling in the data file
    nFrames = C.frames.length; duration = (nFrames - 1) / meta.sample_fps;
    flipH = !meta.attacks_right.H;
    for (const fr of C.frames) for (const p of fr[3]) inClip.add(key(p));
    for (const [fr, code, team] of C.match_events) if (code === 'GOALS') C.events.push({ frame: fr, kind: 'goal', team });
    initShadow();
    C.events.sort((a, b) => a.frame - b.frame);
    half1End = (C.runs.find((r) => r[1] === 'end') || [Infinity])[0] - 1;
    S.follow = params.get('mode') === 'follow' || (params.get('mode') !== 'lead' && narrow());
    lineup = savedLineup || readLocal() || defaultLineup();
    for (const p of lineup.squad) {                       // line-ups saved before profiles existed
      const d = D.SQUAD.find((q) => q.id === p.id);
      if (p.keys === undefined) { p.pos = d ? d.pos : []; p.foot = d ? d.foot : null; p.keys = d ? d.keys : []; }
    }
    applyLineup();
    $('scrub').max = duration;
    bindUI();
    buildViews();
    $('loading').classList.add('gone');
    const showSetup = !S.follow && !savedLineup && !readLocal() && params.get('setup') !== '0';
    if (showSetup) openSetup(); else { S.playing = !S.follow && params.get('autoplay') !== '0'; }
    updateFollow();
    requestAnimationFrame(loop);
    setInterval(sync, 600);
    if (S.follow) setInterval(pullLineup, 8000);
  }

  // ================================================================== geometry
  const key = (p) => `${p[1] === 0 ? 'H' : 'A'}:${labels[p[2]]}`;
  const tf = (x, y) => (flipH ? [L - x, W - y] : [x, y]);           // raw camera frame -> our attacking frame
  const lane = (y) => (y < W / 3 ? 'left' : y < 2 * W / 3 ? 'middle' : 'right');

  function hungarian(a) {             // square cost matrix -> assignment row i -> column
    const n = a.length, INF = 1e18, u = Array(n + 1).fill(0), v = Array(n + 1).fill(0), p = Array(n + 1).fill(0), way = Array(n + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i; let j0 = 0; const minv = Array(n + 1).fill(INF), used = Array(n + 1).fill(false);
      do {
        used[j0] = true; const i0 = p[j0]; let delta = INF, j1 = 0;
        for (let j = 1; j <= n; j++) if (!used[j]) {
          const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= n; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const ans = Array(n); for (let j = 1; j <= n; j++) if (p[j]) ans[p[j] - 1] = j - 1; return ans;
  }

  // A pitch drawn in OUR attacking frame. x0..x1 = the part of the length shown.
  class PitchView {
    constructor(canvas, o) { this.c = canvas; this.ctx = canvas.getContext('2d'); this.o = Object.assign({ portrait: false, x0: 0, x1: L, m: 2 }, o); }
    layout(w) {
      const o = this.o, len = o.x1 - o.x0 + 2 * o.m, wid = W + 2 * o.m;
      w = Math.max(60, w || 0);
      this.d = window.devicePixelRatio || 1; this.w = w;
      if (o.portrait) { this.sc = w / wid; this.h = Math.round(len * this.sc); } else { this.sc = w / len; this.h = Math.round(wid * this.sc); }
      this.c.width = Math.round(w * this.d); this.c.height = Math.round(this.h * this.d); this.c.style.height = this.h + 'px';
      this.surface = null;
    }
    S(x, y) { const o = this.o, s = this.sc; return o.portrait ? [(y + o.m) * s, (o.x1 - x + o.m) * s] : [(x - o.x0 + o.m) * s, (y + o.m) * s]; }
    path(pts, close) {
      const g = this.ctx; g.beginPath();
      pts.forEach(([x, y], i) => { const [a, b] = this.S(x, y); i ? g.lineTo(a, b) : g.moveTo(a, b); });
      if (close) g.closePath();
    }
    rect(x0, y0, x1, y1) { this.path([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true); }
    arcPts(cx, cy, r, a0 = 0, a1 = 2 * Math.PI, n = 48) {
      const pts = []; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } return pts;
    }
    begin() {
      const g = this.ctx; g.setTransform(this.d, 0, 0, this.d, 0, 0); g.clearRect(0, 0, this.w, this.h);
      if (!this.surface) this.surface = this.drawSurface();
      g.drawImage(this.surface, 0, 0, this.w, this.h);
    }
    drawSurface() {
      const off = document.createElement('canvas'); off.width = this.c.width; off.height = this.c.height;
      const real = this.ctx; this.ctx = off.getContext('2d'); const g = this.ctx;
      g.setTransform(this.d, 0, 0, this.d, 0, 0);
      g.fillStyle = '#21522F'; g.fillRect(0, 0, this.w, this.h);
      const n = 14; for (let k = 0; k < n; k++) {         // mowing stripes across the length
        this.rect(-3 + k * (L + 6) / n, -3, -3 + (k + 1) * (L + 6) / n, W + 3); g.fillStyle = k % 2 ? '#2A6A3E' : '#2F7445'; g.fill();
      }
      g.strokeStyle = 'rgba(255,255,255,0.82)'; g.lineWidth = Math.max(1, 0.13 * this.sc); g.lineJoin = 'round';
      const line = (pts, c) => { this.path(pts, c); g.stroke(); };
      line([[0, 0], [L, 0], [L, W], [0, W]], true);
      line([[L / 2, 0], [L / 2, W]]);
      line(this.arcPts(L / 2, W / 2, 9.15));
      for (const side of [0, 1]) {
        const gx = side ? L : 0, s = side ? -1 : 1;
        line([[gx, W / 2 - 20.16], [gx + s * 16.5, W / 2 - 20.16], [gx + s * 16.5, W / 2 + 20.16], [gx, W / 2 + 20.16]]);
        line([[gx, W / 2 - 9.16], [gx + s * 5.5, W / 2 - 9.16], [gx + s * 5.5, W / 2 + 9.16], [gx, W / 2 + 9.16]]);
        const spot = gx + s * 11, a = Math.acos(5.5 / 9.15);
        line(side ? this.arcPts(spot, W / 2, 9.15, Math.PI - a, Math.PI + a, 24) : this.arcPts(spot, W / 2, 9.15, -a, a, 24));
        for (const [cx, cy] of [[spot, W / 2]]) { const [a1, b1] = this.S(cx, cy); g.beginPath(); g.arc(a1, b1, Math.max(1.2, 0.25 * this.sc), 0, 7); g.fillStyle = 'rgba(255,255,255,.85)'; g.fill(); }
        line([[gx, W / 2 - 3.66], [gx - s * 1.6, W / 2 - 3.66], [gx - s * 1.6, W / 2 + 3.66], [gx, W / 2 + 3.66]]);
        for (const cy of [0, W]) line(this.arcPts(gx, cy, 1, side ? (cy ? Math.PI : Math.PI / 2) : (cy ? -Math.PI / 2 : 0), side ? (cy ? 1.5 * Math.PI : Math.PI) : (cy ? 0 : Math.PI / 2), 8));
      }
      const [cxs, cys] = this.S(L / 2, W / 2); g.beginPath(); g.arc(cxs, cys, Math.max(1.2, 0.25 * this.sc), 0, 7); g.fillStyle = 'rgba(255,255,255,.85)'; g.fill();
      const vg = g.createRadialGradient(this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.3, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.28)');
      g.fillStyle = vg; g.fillRect(0, 0, this.w, this.h);
      this.ctx = real; return off;
    }
    label(text, x, y, dy, opts = {}) {
      const g = this.ctx, [a, b] = this.S(x, y); const size = opts.size || 11;
      g.font = `${opts.weight || 600} ${size}px ${opts.mono ? CSS.getPropertyValue('--mono') : CSS.getPropertyValue('--sans')}`;
      const w = g.measureText(text).width + 10, h = size + 6, yy = b + dy;
      if (opts.pill !== false) { g.fillStyle = opts.bg || 'rgba(10,11,13,0.72)'; roundRect(g, a - w / 2, yy - h / 2, w, h, h / 2); g.fill(); }
      g.fillStyle = opts.color || '#F1F3F6'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, a, yy + 0.5);
    }
    arrow(x0, y0, x1, y1, color, width = 2.5, dash) {
      const g = this.ctx, [a, b] = this.S(x0, y0), [c, d] = this.S(x1, y1);
      g.save(); g.strokeStyle = color; g.fillStyle = color; g.lineWidth = width; g.lineCap = 'round';
      if (dash) g.setLineDash(dash);
      g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke(); g.setLineDash([]);
      const ang = Math.atan2(d - b, c - a), h = 8 + width * 1.5;
      g.beginPath(); g.moveTo(c, d); g.lineTo(c - h * Math.cos(ang - 0.45), d - h * Math.sin(ang - 0.45));
      g.lineTo(c - h * Math.cos(ang + 0.45), d - h * Math.sin(ang + 0.45)); g.closePath(); g.fill(); g.restore();
    }
  }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }

  // ================================================================== line-up
  function defaultLineup() {
    return { formation: '4-2-1-3', squad: JSON.parse(JSON.stringify(D.SQUAD)), xi: Object.assign({}, D.DEFAULT_XI),
             oppName: meta.teams.A, kitH: '#3D7BFF', kitA: '#F2613F' };
  }
  function readLocal() { try { const s = localStorage.getItem('sb_lineup'); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function saveLineup() {
    try { localStorage.setItem('sb_lineup', JSON.stringify(lineup)); } catch (e) { /* storage full or blocked */ }
    fetch('api/lineup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lineup }) }).catch(() => {});
  }
  function pullLineup() {
    fetch('api/lineup', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
      if (d.lineup && JSON.stringify(d.lineup) !== JSON.stringify(lineup)) { lineup = d.lineup; applyLineup(); }
    }).catch(() => {});
  }
  const player = (id) => lineup.squad.find((p) => p.id === id);
  const shortName = (p) => { if (!p) return ''; const parts = p.name.trim().split(/\s+/); return parts.length > 1 && parts[0].length > 2 ? parts.slice(1).join(' ') : p.name; };

  // The coach's formation slots are matched to the roles our tracking finds (same Hungarian idea
  // as roles.py): each named player lands on the detected role closest to his slot. Works for both
  // teams: the opponent's names are optional (lineup.opp).
  function matchRoles(team, formation) {
    const det = meta.role_means[team] || {}, detLabels = Object.keys(det), out = { GK: 'GK' };
    const slots = D.slots(formation).filter((s) => s.label !== 'GK');
    if (!detLabels.length) return out;
    const depths = detLabels.map((l) => det[l][0]), dmin = Math.min(...depths), dmax = Math.max(...depths);
    const pts = detLabels.map((l) => ({ l, x: det[l][1] / W, y: 0.2 + 0.66 * (det[l][0] - dmin) / Math.max(1, dmax - dmin) }));
    const n = Math.max(pts.length, slots.length);
    const cost = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
      if (i >= pts.length || j >= slots.length) return 0;
      const exact = pts[i].l === slots[j].label ? -0.05 : 0;
      return (pts[i].x - slots[j].x) ** 2 + (pts[i].y - slots[j].y) ** 2 + exact;
    }));
    hungarian(cost).forEach((j, i) => { if (i < pts.length && j < slots.length) out[pts[i].l] = slots[j].label; });
    return out;
  }
  const oppFormation = () => (lineup.opp && D.FORMATIONS[lineup.opp.formation] ? lineup.opp.formation : D.FORMATIONS[meta.formation.A] ? meta.formation.A : '4-4-2');
  let oppToPlayer = {}, roleToSlot = { H: {}, A: {} };
  function applyLineup() {
    document.documentElement.style.setProperty('--home', lineup.kitH);
    document.documentElement.style.setProperty('--away', lineup.kitA);
    roleToPlayer = {}; oppToPlayer = {};
    roleToSlot.H = matchRoles('H', lineup.formation); roleToSlot.A = matchRoles('A', oppFormation());
    for (const [role, slot] of Object.entries(roleToSlot.H)) { const pid = lineup.xi[slot]; if (pid && player(pid)) roleToPlayer[role] = Object.assign({ slot }, player(pid)); }
    if (lineup.opp) for (const [role, slot] of Object.entries(roleToSlot.A)) { const p = lineup.opp.xi[slot]; if (p && p.name) oppToPlayer[role] = Object.assign({ slot }, p); }
    $('match').textContent = `${meta.teams.H} – ${lineup.oppName || meta.teams.A} · ${lineup.formation} vs ${meta.formation.A}`;
    $('match').dataset.score = '';
    $('tabA').textContent = (lineup.oppName || meta.teams.A).split(' ')[0];
    $('tabH').textContent = meta.teams.H;
    advCache = -1; heatCache = ''; luKey = '';
  }

  // ---------------------------------------------------------------- setup screen (FotMob-style card)
  // Flow: pick a position, then the player for it (search the squad or type a new name); "Fill one by
  // one" walks through every position in order. The opponent's card is optional (names typed or pasted).
  let selSlot = null, setupTeam = 'H', stepMode = false;
  function openSetup() {
    S.playing = false; $('setup').hidden = false; $('live').hidden = true; document.body.classList.add('setup-open');
    $('oppName').value = lineup.oppName || meta.teams.A; $('kitH').value = lineup.kitH; $('kitA').value = lineup.kitA;
    $('detected').textContent = `Detected from tracking, half ${meta.half}: ${meta.teams.H} ${meta.formation.H}, opponent ${meta.formation.A}. Names are matched to the nearest tracked player automatically, so your formation may differ.`;
    renderSetup();
  }
  function closeSetup() {
    lineup.oppName = $('oppName').value.trim() || meta.teams.A; lineup.kitH = $('kitH').value; lineup.kitA = $('kitA').value;
    saveLineup(); applyLineup(); $('setup').hidden = true; $('live').hidden = false; document.body.classList.remove('setup-open'); buildViews(); S.playing = true;
  }
  function formationSvg(name) {
    const sl = D.slots(name);
    return `<svg viewBox="0 0 100 60" aria-hidden="true"><rect x="1" y="1" width="98" height="58" rx="6" fill="#24603A"/>` +
      sl.map((s) => `<circle cx="${4 + s.y * 92}" cy="${4 + s.x * 52}" r="3.6" fill="#fff"/>`).join('') + '</svg>';
  }
  const curFormation = () => (setupTeam === 'H' ? lineup.formation : oppFormation());
  function ensureOpp() { if (!lineup.opp) lineup.opp = { formation: oppFormation(), xi: {} }; return lineup.opp; }
  function slotPlayer(team, label) { return team === 'H' ? player(lineup.xi[label]) : (lineup.opp && lineup.opp.xi[label]) || null; }
  function slotFace(p, team, label) {
    const style = `--kit:var(--${team === 'H' ? 'home' : 'away'});` + (p && p.photo ? `background-image:url(${p.photo})` : '');
    const inner = p ? (p.photo ? '' : (p.num != null && p.num !== '' ? String(p.num) : initials(p.name))) : '+';
    return `<span class="ph" style="${style}">${inner}${p && p.num != null && p.num !== '' && p.photo ? `<span class="no">${p.num}</span>` : ''}</span>`;
  }
  function renderSetup() {
    const team = setupTeam, f = curFormation();
    $('formationList').innerHTML = Object.keys(D.FORMATIONS).map((k) =>
      `<button type="button" class="fm${k === f ? ' on' : ''}" data-f="${k}">${formationSvg(k)}<span>${k}</span></button>`).join('');
    $('formationList').querySelectorAll('.fm').forEach((b) => b.onclick = () => changeFormation(b.dataset.f));
    const slots = D.slots(f), filled = slots.filter((s) => slotPlayer(team, s.label)).length;
    $('boardTitle').textContent = `${team === 'H' ? meta.teams.H : (lineup.oppName || meta.teams.A)} · ${f}`;
    $('boardCount').textContent = `${filled}/${slots.length} named`;
    $('board').innerHTML = slots.map((s) => {
      const p = slotPlayer(team, s.label);
      return `<button type="button" class="slot${p ? '' : ' empty'}${selSlot === s.label ? ' sel' : ''}" data-s="${s.label}"
        style="left:${6 + s.x * 88}%;top:${94 - s.y * 86}%;--kit:var(--${team === 'H' ? 'home' : 'away'})">${slotFace(p, team, s.label)}<span class="nm">${p ? esc(shortName(p)) : 'Add player'}</span><span class="rl">${s.label}</span></button>`;
    }).join('');
    $('board').querySelectorAll('.slot').forEach((b) => b.onclick = () => { stepMode = false; selSlot = selSlot === b.dataset.s ? null : b.dataset.s; renderSetup(); });
    $('slotHint').textContent = stepMode ? `One by one: ${slots.findIndex((s) => s.label === selSlot) + 1} of ${slots.length}` :
      team === 'H' ? 'Click a position, then pick the player (or type a new name)' : 'Optional: name their players so the live screens use names instead of positions';
    $('stepBtn').textContent = stepMode ? 'Stop' : 'Fill one by one';
    document.querySelectorAll('#setupTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === team));
    $('setupThem').textContent = lineup.opp && Object.keys(lineup.opp.xi).length ? (lineup.oppName || meta.teams.A).split(' ')[0] : 'Opponent (optional)';
    // right column: the picker for the selected position; the squad (us) or the paste box (them)
    renderPicker();
    $('oppPaste').hidden = team !== 'A';
    for (const id of ['squadHead', 'squadEdit', 'photoNote']) $(id).hidden = team !== 'H';
    if (team === 'H') renderSquad(); else $('profileEditor').hidden = true;
  }
  function renderSquad() {
    const inXI = {}; for (const [l, id] of Object.entries(lineup.xi)) inXI[id] = l;
    $('squadEdit').innerHTML = lineup.squad.map((p) => `<div class="se${inXI[p.id] ? ' inxi' : ''}${selSlot ? ' pick' : ''}" data-id="${p.id}">
        <label class="av" title="Add a photo" style="${p.photo ? `background-image:url(${p.photo})` : ''}">${p.photo ? '' : initials(p.name)}<input type="file" accept="image/*" hidden></label>
        <input class="num" value="${p.num}" inputmode="numeric" aria-label="Number">
        <input class="name" value="${esc(p.name)}" aria-label="Name">
        <span class="pos">${inXI[p.id] || p.group}</span>
        <button type="button" class="ed" aria-label="Edit profile">✎</button><button type="button" class="x" aria-label="Remove">×</button></div>`).join('');
    renderProfile();
    $('squadEdit').querySelectorAll('.se').forEach((row) => {
      const p = player(row.dataset.id);
      row.querySelector('.num').onchange = (e) => { p.num = parseInt(e.target.value, 10) || p.num; renderSetup(); };
      row.querySelector('.name').onchange = (e) => { p.name = e.target.value.trim() || p.name; renderSetup(); };
      row.querySelector('input[type=file]').onchange = (e) => e.target.files[0] && loadPhoto(e.target.files[0], p);
      row.querySelector('.ed').onclick = () => { editId = editId === p.id ? null : p.id; renderSetup(); };
      if (p.id === editId) row.classList.add('editing');
      row.querySelector('.x').onclick = () => {
        lineup.squad = lineup.squad.filter((q) => q.id !== p.id);
        for (const l in lineup.xi) if (lineup.xi[l] === p.id) delete lineup.xi[l];
        renderSetup();
      };
      row.onclick = (e) => { if (!selSlot || e.target.closest('input,label,button')) return; assign(p); };
    });
  }
  // ---- the picker: search our squad (best fit for the position first) or type a new player
  function renderPicker() {
    const box = $('picker'), team = setupTeam;
    if (!selSlot) { box.hidden = true; return; }
    box.hidden = false;
    const cur = slotPlayer(team, selSlot), DEC = window.SB_DECIDE;
    box.innerHTML = `<div class="pk-head"><b>${selSlot}</b><span class="muted small">${cur ? 'now: ' + esc(cur.name) : 'empty'}</span></div>
      <div class="pk-row"><input id="pkName" placeholder="${team === 'H' ? 'Search the squad or type a new name' : 'Player name'}" autocomplete="off">
      <input id="pkNum" placeholder="No." inputmode="numeric"></div>
      <div class="pk-list" id="pkList"></div>
      <div class="pk-actions">${cur ? '<button type="button" class="ghost small" id="pkClear">Clear position</button>' : ''}
        ${team === 'A' ? '<label class="ghost small pk-photo">Photo<input type="file" accept="image/*" hidden id="pkPhoto"></label>' : ''}
        <button type="button" class="ghost small" id="pkSkip">${stepMode ? 'Skip' : 'Close'}</button></div>`;
    const name = $('pkName'), num = $('pkNum');
    if (team === 'A' && cur) { name.value = cur.name || ''; num.value = cur.num != null ? cur.num : ''; }
    const list = () => {
      const q = name.value.trim().toLowerCase();
      if (team === 'A') {
        $('pkList').innerHTML = q ? `<button type="button" class="pk-item first" data-new="1"><span class="av">${esc(initials(name.value))}</span><span class="who"><b>${esc(name.value.trim())}</b><span>press Enter to set ${selSlot}</span></span><em>${esc(num.value)}</em></button>` : '';
      } else {
        const inXI = new Set(Object.values(lineup.xi));
        const rows = lineup.squad.filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.num) === q)
          .map((p) => ({ p, fit: DEC.canPlay(p, selSlot) })).sort((a, b) => b.fit - a.fit || a.p.num - b.p.num).slice(0, 8);
        const exact = rows.some((r) => r.p.name.toLowerCase() === q);
        $('pkList').innerHTML = rows.map((r, i) => `<button type="button" class="pk-item${i === 0 ? ' first' : ''}" data-id="${r.p.id}">${avatar(r.p, 'H', '')}
            <span class="who"><b>${esc(r.p.name)}</b><span>${(r.p.pos || []).join(' · ') || r.p.group}${inXI.has(r.p.id) ? ' · in the XI' : ''}</span></span><em>${r.fit === 1 ? 'fits' : r.fit >= 0.85 ? 'same job' : ''}</em></button>`).join('') +
          (q && !exact ? `<button type="button" class="pk-item${rows.length ? '' : ' first'}" data-new="1"><span class="av">+</span><span class="who"><b>Add “${esc(name.value.trim())}”</b><span>new player for ${selSlot}${num.value ? ', number ' + esc(num.value) : ''}</span></span><em></em></button>` : '');
      }
      $('pkList').querySelectorAll('.pk-item').forEach((b) => b.onclick = () => pick(b));
    };
    const pick = (b) => {
      if (!b) return;
      if (b.dataset.id) { assign(player(b.dataset.id)); return; }
      const nm = name.value.trim(); if (!nm) return;
      const n = parseInt(num.value, 10);
      if (team === 'A') { assign({ name: nm, num: isNaN(n) ? null : n, photo: (cur && cur.photo) || null }); return; }
      const p = { id: 'n' + Date.now(), num: isNaN(n) ? Math.max(0, ...lineup.squad.map((q) => q.num)) + 1 : n, name: nm,
                  group: { GK: 'GK', DEF: 'DF', MID: 'MF', ATT: 'FW' }[window.SB_DECIDE.GROUP[selSlot]] || 'MF', pos: [selSlot], foot: null, keys: [], photo: null };
      lineup.squad.push(p); assign(p);
    };
    name.oninput = list; num.oninput = list;
    name.onkeydown = num.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); pick($('pkList').querySelector('.pk-item.first')); } };
    list(); setTimeout(() => name.focus(), 0);
    if ($('pkClear')) $('pkClear').onclick = () => { if (team === 'H') delete lineup.xi[selSlot]; else delete ensureOpp().xi[selSlot]; next(); };
    $('pkSkip').onclick = () => next();
    if ($('pkPhoto')) $('pkPhoto').onchange = (e) => { const p = ensureOpp().xi[selSlot] || (ensureOpp().xi[selSlot] = { name: name.value.trim() || selSlot, num: null }); if (e.target.files[0]) loadPhoto(e.target.files[0], p); };
  }
  function assign(p) {
    if (setupTeam === 'H') { for (const l in lineup.xi) if (lineup.xi[l] === p.id) delete lineup.xi[l]; lineup.xi[selSlot] = p.id; }
    else { const o = ensureOpp(); o.formation = oppFormation(); o.xi[selSlot] = p; }
    next(true);
  }
  // after a pick: one-by-one mode walks to the next position; otherwise the picker closes
  function next() {
    if (stepMode) {
      const order = D.slots(curFormation()).map((s) => s.label), i = order.indexOf(selSlot);
      selSlot = i >= 0 && i < order.length - 1 ? order[i + 1] : null;
      if (!selSlot) stepMode = false;
    } else selSlot = null;
    renderSetup();
  }
  // ---------------------------------------------------------------- player profile editor
  let editId = null;
  const ALL_ROLES = ['GK', 'LB', 'LCB', 'CB', 'RCB', 'RB', 'LWB', 'RWB', 'CDM', 'LCDM', 'RCDM', 'LCM', 'CM', 'RCM', 'LM', 'RM', 'CAM', 'LAM', 'RAM', 'LW', 'RW', 'CF', 'ST'];
  function renderProfile() {
    const box = $('profileEditor'), p = editId && player(editId);
    if (!p) { box.hidden = true; return; }
    box.hidden = false;
    const keys = (p.keys || []).concat(['', '', '']).slice(0, 3);
    box.innerHTML = `<div class="pe-head"><b>${esc(p.name)}</b><span class="muted small">profile used by the Player Recommender</span></div>
      <div class="pe-roles">${ALL_ROLES.map((r) => `<button type="button" class="rchip${(p.pos || []).includes(r) ? ' on' : ''}" data-r="${r}">${r}</button>`).join('')}</div>
      <div class="pe-row"><label class="field"><span>Foot</span><select id="peFoot"><option value="">?</option><option value="R"${p.foot === 'R' ? ' selected' : ''}>Right</option><option value="L"${p.foot === 'L' ? ' selected' : ''}>Left</option></select></label>
      ${keys.map((k, i) => `<label class="field"><span>Keyword ${i + 1}</span><input class="peKey" list="traitList" value="${esc(k)}" maxlength="24"></label>`).join('')}</div>
      <datalist id="traitList">${window.SB_DECIDE.TRAITS.map((t) => `<option value="${t}">`).join('')}</datalist>`;
    box.querySelectorAll('.rchip').forEach((b) => b.onclick = () => {
      const r = b.dataset.r; p.pos = p.pos || [];
      p.pos = p.pos.includes(r) ? p.pos.filter((x) => x !== r) : [...p.pos, r]; renderProfile();
    });
    box.querySelector('#peFoot').onchange = (e) => { p.foot = e.target.value || null; };
    box.querySelectorAll('.peKey').forEach((inp, i) => inp.onchange = () => {
      const k = [...box.querySelectorAll('.peKey')].map((x) => x.value.trim().toLowerCase()).filter(Boolean); p.keys = k.slice(0, 3);
    });
  }

  function changeFormation(f) {
    // keep the same players, moved to the nearest slots of the new shape
    const team = setupTeam, from = curFormation(), xiOld = team === 'H' ? lineup.xi : ensureOpp().xi;
    const old = D.slots(from).filter((s) => xiOld[s.label]), neu = D.slots(f);
    const n = Math.max(old.length, neu.length);
    const cost = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
      i < old.length && j < neu.length ? (old[i].x - neu[j].x) ** 2 + (old[i].y - neu[j].y) ** 2 + (old[i].label === 'GK') * (neu[j].label !== 'GK') * 9 : 0));
    const xi = {};
    hungarian(cost).forEach((j, i) => { if (i < old.length && j < neu.length) xi[neu[j].label] = xiOld[old[i].label]; });
    if (team === 'H') { lineup.formation = f; lineup.xi = xi; } else { lineup.opp.formation = f; lineup.opp.xi = xi; }
    selSlot = null; stepMode = false; renderSetup();
  }
  function loadPhoto(file, p) {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas'), s = Math.min(img.width, img.height); c.width = c.height = 160;
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 4, s, s, 0, 0, 160, 160);
      p.photo = c.toDataURL('image/jpeg', 0.82); URL.revokeObjectURL(url); renderSetup();
    };
    img.src = url;
  }
  function avatar(p, team, role) {
    const style = p && p.photo ? `background-image:url(${p.photo})` : '';
    return `<span class="av team" style="--kit:var(--${team === 'H' ? 'home' : 'away'});${style}">${p && p.photo ? '' : (p ? p.num : role)}</span>`;
  }
  const initials = (n) => n.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  $('addPlayer').onclick = () => {
    const num = Math.max(0, ...lineup.squad.map((p) => p.num)) + 1;
    lineup.squad.push({ id: 'n' + Date.now(), num, name: 'New player', group: 'MF', photo: null }); renderSetup();
  };

  // ================================================================== time + sync
  const videoFrame = (t) => meta.first + Math.round(t * meta.fps);
  function clockText(f) {
    const s = (f - meta.half_start) / meta.fps + (meta.half === 2 ? 45 * 60 : 0);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }
  let lastPost = 0, lastSnap = 0;
  function postSnapshot(f) {
    if (S.follow || performance.now() - lastSnap < 2000) return;
    lastSnap = performance.now();
    const sc = score(f);
    const snap = {
      clock: clockText(f), frame: f, half: meta.half,
      teams: { us: meta.teams.H, them: lineup.oppName || meta.teams.A }, score: { us: sc.H, them: sc.A },
      formation: { us: lineup.formation, them: meta.formation.A },
      need_to_know: (S.top3 || []).map((it) => ({ title: it.title, detail: it.sub })),
      plan_b: (S.plan || []).slice(0, 4).map((o) => ({ kind: o.kind, title: o.title, why: o.why, effect: o.effect || null })),
      substitutes: S.subsShown || null,
      advice: S.adv ? { attack_lane: S.adv.atkLane, attack_space_m: S.adv.atkFree && Math.round(S.adv.atkFree),
                        defend_lane: S.adv.defLane, drop_line_m: S.adv.dropTo ? Math.round(S.adv.ourLine - S.adv.dropTo) : 0 } : null,
      fatigue: Object.values(latestStamina(f)).filter((r) => r.team === 'H' && r.half === meta.half && r.risk != null)
        .map((r) => ({ role: r.label, player: (roleToPlayer[r.label] || {}).name || null, risk: r.risk, level: r.level })),
      duels: (S.duels || []).map((d) => ({ defender: (roleToPlayer[d.def] || {}).name || d.def, role: d.def, opponent: d.att, goal_side: Math.round(d.behind * 100) / 100 })),
      shadow: shadowSnapshot(f),
      shadow_ratings: Object.entries(S.ratings || {}).filter(([k]) => k[0] === 'H').map(([k, r]) => ({ player: nameOf(k.slice(2)), role: k.slice(2), rating: Math.round(r.rating * 10) / 10 })),
      space_leaks: (S.leaks || []).slice(0, 4).map((r) => ({ player: nameOf(r.role), role: r.role, ratio_vs_first_15_min: Math.round(r.ratio * 10) / 10, flagged: r.flag, fatigue: r.risk, level: r.level })),
      pressing: S.pressing ? { best_zone: S.pressing.best ? { where: P_BAND.H[S.pressing.best.band], won_back_press: Math.round(S.pressing.best.regP * 100), won_back_hold: Math.round(S.pressing.best.regH * 100) } : null,
                               worst_zone: S.pressing.worst ? { where: P_BAND.H[S.pressing.worst.band], won_back_press: Math.round(S.pressing.worst.regP * 100), won_back_hold: Math.round(S.pressing.worst.regH * 100),
                                                               box_press: Math.round(S.pressing.worst.boxP * 100), box_hold: Math.round(S.pressing.worst.boxH * 100) } : null } : null,
    };
    fetch('api/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snap) }).catch(() => {});
  }
  function shadowSnapshot(f) {
    if (!SH.rows.length) return null;
    const i = shIdx(f), row = i >= 0 ? SH.rows[i] : null, r = shRecent(f, 120);
    const out = (m) => ({ player: nameOf(m.role), role: m.role, move: moveText(m), gain_pct: Math.round(m.gap) / 10, kind: m.kind });
    return { our_share_of_dangerous_space_pct: row ? Math.round(row[2]) / 10 : null, phase: row ? (row[1] === 'A' ? 'defending' : 'attacking') : null,
             usual_space_denied_pct: SH.usual.H != null ? Math.round(SH.usual.H) / 10 : null,
             rest_defence_pct: row && row[1] === 'H' && row[6] != null ? Math.round(row[6]) / 10 : null,
             usual_rest_defence_pct: SH.usualRest.H != null ? Math.round(SH.usualRest.H) / 10 : null,
             rest_defence_thin: !!restThin(row),
             space_denied_last_2min_pct: r && r.avg != null ? Math.round(r.avg) / 10 : null,
             rest_defence_last_2min_pct: r && r.rest != null ? Math.round(r.rest) / 10 : null,
             most_often_out_of_position: r && r.who ? nameOf(r.who) : null, most_often_out_of_cover: r && r.cover ? nameOf(r.cover) : null,
             moves_now: (i >= 0 ? liveMoves(i) : []).map(out),
             replays: SH.moments.filter((m) => m[2] === 'H' && m[0] <= f).map((m) => ({ clock: clockText(m[1]), kind: m[5] === 'rest' ? 'lost the ball, thin rest defence' : 'space denied low',
               value_pct: Math.round(m[3]) / 10, moves: momentMoves(m).map(out) })) };
  }
  function sync() {
    if (S.follow) {
      fetch('api/state', { cache: 'no-store' }).then((r) => r.json()).then((st) => {
        if (st.frame == null) return;
        let t = (st.frame - meta.first) / meta.fps; if (st.playing) t += (st.now - st.t) * st.speed;
        if (Math.abs(t - S.t) > 1 || S.playing !== st.playing) S.t = Math.max(0, Math.min(duration, t));
        S.playing = st.playing; S.speed = st.speed; markSpeed();
      }).catch(() => {});
    } else if (performance.now() - lastPost > 500 && $('setup').hidden) {
      lastPost = performance.now();
      fetch('api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frame: videoFrame(S.t), playing: S.playing, speed: S.speed }) }).catch(() => {});
    }
  }
  function updateFollow() { const b = $('followBtn'); b.hidden = false; b.textContent = S.follow ? 'Follow laptop ✓' : 'Follow laptop'; }
  function markSpeed() { document.querySelectorAll('#speeds button').forEach((b) => b.classList.toggle('on', +b.dataset.speed === S.speed)); }
  function takeOver() { if (S.follow) { S.follow = false; updateFollow(); } }

  function bindUI() {
    $('playBtn').onclick = () => { takeOver(); if (S.t >= duration) S.t = 0; S.playing = !S.playing; };
    $('scrub').oninput = (e) => { takeOver(); S.t = +e.target.value; };
    document.querySelectorAll('#speeds button').forEach((b) => b.onclick = () => { takeOver(); S.speed = +b.dataset.speed; markSpeed(); });
    document.querySelectorAll('[data-layer]').forEach((b) => b.onclick = () => { const k = b.dataset.layer; S.layers[k] = !S.layers[k]; b.classList.toggle('on', S.layers[k]); });
    document.querySelectorAll('#teamTabs button').forEach((b) => b.onclick = () => {
      S.team = b.dataset.team; S.sel = null; document.querySelectorAll('#teamTabs button').forEach((x) => x.classList.toggle('on', x === b)); panels(true);
    });
    $('followBtn').onclick = () => { S.follow = !S.follow; updateFollow(); };
    $('setupBtn').onclick = openSetup;
    $('reportBtn').onclick = openReport;
    $('repClose').onclick = () => { $('report').hidden = true; document.body.classList.remove('report-open'); };
    $('repPrint').onclick = () => window.print();
    $('startBtn').onclick = closeSetup;
    document.querySelectorAll('#setupTabs button').forEach((b) => b.onclick = () => { setupTeam = b.dataset.t; selSlot = null; stepMode = false; editId = null; renderSetup(); });
    $('stepBtn').onclick = () => { stepMode = !stepMode; selSlot = stepMode ? D.slots(curFormation())[0].label : null; renderSetup(); };
    $('oppFill').onclick = () => {
      const order = D.slots(oppFormation()).map((s) => s.label), o = ensureOpp();
      $('oppText').value.split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, order.length).forEach((line, i) => {
        const m = line.match(/^(\d+)[\s.,:-]+(.+)$/);
        o.xi[order[i]] = Object.assign(o.xi[order[i]] || {}, m ? { num: +m[1], name: m[2].trim() } : { num: null, name: line });
      });
      o.formation = oppFormation(); renderSetup();
    };
    $('shReplayClose').onclick = closeReplay;
    document.querySelectorAll('#pressTabs button').forEach((b) => b.onclick = () => {
      pressTeamSel = b.dataset.t; pressCache = ''; document.querySelectorAll('#pressTabs button').forEach((x) => x.classList.toggle('on', x === b)); pressingCard(videoFrame(S.t));
    });
    addEventListener('resize', () => { buildViews(); panels(true); });
    addEventListener('keydown', (e) => {
      if (e.target.closest && e.target.closest('input')) return;
      if (e.code === 'Space') { e.preventDefault(); $('playBtn').click(); }
      if (e.code === 'ArrowRight') { takeOver(); S.t = Math.min(duration, S.t + 10); }
      if (e.code === 'ArrowLeft') { takeOver(); S.t = Math.max(0, S.t - 10); }
    });
    $('pitch').addEventListener('click', pick);
  }

  // ================================================================== state at time t
  function interp(t) {
    const i = Math.max(0, Math.min(nFrames - 1, Math.floor(t * meta.sample_fps)));
    const a = C.frames[i], b = C.frames[Math.min(nFrames - 1, i + 1)], k = t * meta.sample_fps - i;
    const nb = new Map(b[3].map((p) => [p[0], p]));
    const players = a[3].map((p) => {
      const q = nb.get(p[0]);
      const [x, y] = q && q[2] === p[2] ? [p[3] + (q[3] - p[3]) * k, p[4] + (q[4] - p[4]) * k] : [p[3], p[4]];
      const [X, Y] = tf(x, y);
      return { k: key(p), team: p[1] === 0 ? 'H' : 'A', role: labels[p[2]], x: X, y: Y, v: p[5] };
    });
    let ball = null;
    if (a[2]) {
      let [bx, by] = [a[2][0], a[2][1]];
      if (b[2]) { bx += (b[2][0] - bx) * k; by += (b[2][1] - by) * k; }
      const [X, Y] = tf(bx, by); ball = { x: X, y: Y, model: a[2][2] === 1, sigma: a[2][3] };
    }
    let poss = 'D'; for (let j = i; j >= 0; j--) if (C.frames[j][1] !== 'X') { poss = C.frames[j][1]; break; }
    return { idx: i, frame: a[0], players, ball, poss };
  }
  function framePlayers(i) { return C.frames[i][3].map((p) => { const [x, y] = tf(p[3], p[4]); return { k: key(p), team: p[1] === 0 ? 'H' : 'A', role: labels[p[2]], x, y, v: p[5] }; }); }

  function blockEnd(half, minute) { return half < meta.half ? -Infinity : meta.half_start + (minute + 5 - (half === 1 ? 0 : 45)) * 60 * meta.fps; }
  function latestStamina(f) { const out = {}; for (const r of C.stamina) if (blockEnd(r.half, r.minute) <= f) out[`${r.team}:${r.label}`] = r; return out; }

  // ================================================================== views
  let main, advA, advD, fatigueV, heatV, channelsV, spV, duelV;
  function buildViews() {
    const holder = $('pitch').parentElement;
    main = new PitchView($('pitch'), { portrait: narrow(), m: 2.5 });
    main.layout(holder.clientWidth);
    $('dir').textContent = narrow() ? '' : `${meta.teams.H} attacking →`;
    if (!narrow()) {
      advA = new PitchView($('advAtk').querySelector('canvas'), { portrait: true, x0: 50, x1: L, m: 1.5 });
      advD = new PitchView($('advDef').querySelector('canvas'), { portrait: true, x0: 0, x1: L - 50, m: 1.5 });
      advA.layout($('advAtk').clientWidth - 28); advD.layout($('advDef').clientWidth - 28);
      fatigueV = new PitchView($('fatigueMap'), { x0: 0, x1: L, m: 1.5 }); fatigueV.layout($('fatigueMap').parentElement.clientWidth - 28);
      channelsV = new PitchView($('channels'), { x0: 0, x1: L, m: 1.5 }); channelsV.layout($('channels').parentElement.clientWidth - 28);
      spV = new PitchView($('spMap'), { x0: 0, x1: L, m: 1.5 }); spV.layout($('spCard').clientWidth - 28);
      duelV = new PitchView($('duelMap'), { x0: 0, x1: 62, m: 1.5 }); duelV.layout($('duelCard').clientWidth - 28);
      const baW = Math.floor(($('planCard').clientWidth - 28 - 10) / 2);
      planBV = new PitchView($('baBefore'), { x0: 0, x1: 42, m: 1 }); planBV.layout(baW);
      planAV = new PitchView($('baAfterC'), { x0: 0, x1: 42, m: 1 }); planAV.layout(baW);
    }
    heatV = new PitchView($('heat'), { portrait: narrow(), x0: 0, x1: L, m: 1.5 });
    heatV.layout(Math.min(narrow() ? 300 : 300, $('pdetail').clientWidth || 300));
    if (!narrow()) { pressV = new PitchView($('pressMap'), { x0: 0, x1: L, m: 1.5 }); pressV.layout($('pressCard').clientWidth - 28); }
    shV = new PitchView($('shadowPitch'), { portrait: narrow(), m: 2.5 });
    shV.layout($('shadowPitch').parentElement.clientWidth);
    advCache = -1; heatCache = ''; S.feedKey = ''; shKey = ''; simKey = ''; pressCache = ''; leakCache = '';
  }

  // a 3 m grid painted as a small image, then stretched with smoothing onto the pitch.
  // cells: [x0, y0, red, green, blue, alpha 0..1] in our attacking frame
  const zoneImg = document.createElement('canvas');
  function paintCells(v, cells, c = 3) {
    if (!cells || !cells.length) return;
    const nx = Math.ceil(L / c), ny = Math.ceil(W / c); zoneImg.width = nx; zoneImg.height = ny;
    const zc = zoneImg.getContext('2d'), img = zc.createImageData(nx, ny);
    for (const [x0, y0, r, gr, b, a] of cells) {
      const i = Math.round(y0 / c) * nx + Math.round(x0 / c); if (i >= nx * ny) continue;
      img.data.set([r, gr, b, Math.round(255 * a)], i * 4);
    }
    zc.putImageData(img, 0, 0);
    const g = v.ctx, [ox, oy] = v.S(0, 0), [lx, ly] = v.S(nx * c, 0), [wx, wy] = v.S(0, ny * c);
    g.save(); g.imageSmoothingEnabled = true;
    g.setTransform(v.d * (lx - ox) / nx, v.d * (ly - oy) / nx, v.d * (wx - ox) / ny, v.d * (wy - oy) / ny, v.d * ox, v.d * oy);
    g.drawImage(zoneImg, 0, 0); g.restore();
  }

  // The live pitch stays plain: players, names, the ball. Analysis lives on the Shadow pitch below.
  function drawMain(st) {
    const v = main, g = v.ctx; v.begin();
    const kitH = lineup.kitH, kitA = lineup.kitA;
    // trail of the selected player (last 5 s): only when the coach asks for it
    if (S.sel) {
      const pts = []; for (let i = Math.max(0, st.idx - 25); i <= st.idx; i++) { const p = framePlayers(i).find((q) => q.k === S.sel); if (p) pts.push([p.x, p.y]); }
      if (pts.length > 1) { v.path(pts); g.strokeStyle = hexA(COL.shadow, 0.9); g.lineWidth = 3; g.lineCap = 'round'; g.stroke(); }
    }
    // players
    const r = Math.max(6.5, 1.15 * v.sc);
    for (const p of st.players) {
      const [a, b] = v.S(p.x, p.y), kit = p.team === 'H' ? kitH : kitA;
      g.beginPath(); g.ellipse(a + r * 0.25, b + r * 0.55, r * 0.95, r * 0.45, 0, 0, 7); g.fillStyle = 'rgba(0,0,0,.28)'; g.fill();
      g.beginPath(); g.arc(a, b, r, 0, 7); g.fillStyle = kit; g.fill(); g.lineWidth = 1.5; g.strokeStyle = 'rgba(255,255,255,.9)'; g.stroke();
      if (S.sel === p.k) { g.beginPath(); g.arc(a, b, r + 6, 0, 7); g.strokeStyle = COL.shadow; g.lineWidth = 2.5; g.stroke(); }
      const pl = p.team === 'H' ? roleToPlayer[p.role] : oppToPlayer[p.role];
      g.fillStyle = '#fff'; g.font = `700 ${Math.round(r * 0.95)}px ${CSS.getPropertyValue('--mono')}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(pl && pl.num != null ? String(pl.num) : '', a, b + 0.5);
      if (S.layers.names || narrow()) {
        const text = pl ? shortName(pl) : p.role;
        v.label(text, p.x, p.y, r + 9, { size: narrow() ? 9.5 : 10.5, color: p.team === 'H' ? '#fff' : '#FFE1D8' });
      }
    }
    // the ball: seen = solid; reconstructed by the model = faint (its uncertainty cloud is on the Shadow pitch)
    if (st.ball) drawBall(v, st.ball, false);
    lastPlayers = st.players;
  }
  function drawBall(v, bl, cloud) {
    const g = v.ctx, [a, b] = v.S(bl.x, bl.y);
    if (bl.model && cloud) {        // Shadow Ball: a cloud as wide as the model's uncertainty
      const rad = Math.max(10, Math.min(bl.sigma || 4, 9) * v.sc);
      const gr = g.createRadialGradient(a, b, 0, a, b, rad);
      gr.addColorStop(0, 'rgba(167,139,250,.55)'); gr.addColorStop(1, 'rgba(167,139,250,0)');
      g.beginPath(); g.arc(a, b, rad, 0, 7); g.fillStyle = gr; g.fill();
    }
    g.beginPath(); g.arc(a, b, Math.max(3.5, 0.55 * v.sc), 0, 7);
    g.fillStyle = bl.model ? 'rgba(255,255,255,.55)' : '#fff'; g.fill();
    if (!bl.model) { g.strokeStyle = '#111'; g.lineWidth = 1.2; g.stroke(); }
  }
  let lastPlayers = [];
  function pick(e) {
    const rect = $('pitch').getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best = null, bd = 24;
    for (const p of lastPlayers) { const [a, b] = main.S(p.x, p.y), d = Math.hypot(a - x, b - y); if (d < bd) { bd = d; best = p; } }
    if (!best) return;
    S.sel = S.sel === best.k ? null : best.k;
    if (best.team !== S.team) document.querySelector(`#teamTabs button[data-team="${best.team}"]`).click();
    panels(true);
  }

  // ================================================================== Shadow pitch (the core)
  // sb/offball.py once per second. Without the ball: the share of OUR dangerous space we own (space
  // denied) and, for each off-ball player, the best position he could have reached in that second.
  // With the ball: the share of their dangerous space we own, the best moves to get open, and REST
  // DEFENCE: the share of our own dangerous space we would still own if we lost the ball right now;
  // when it is thin, the cover moves are shown instead. The live pitch stays clean; this pitch shows
  // what SHOULD be. Only moves worth SH_MIN per mille, already there a second earlier (no flicker).
  const SH_MIN = 15, REST_THIN = 80;           // per mille: rest defence this far under usual = thin
  const SH = { rows: [], frames: [], players: [], usual: {}, usualRest: {}, moments: [], surf: null, cell: 5 };
  let shV, shKey = '', shPaint = null, replay = null, prevF = null;
  function initShadow() {
    const s = C.shadow;
    if (!s || !s.teams.length) { $('shadowCard').hidden = true; return; }
    Object.assign(SH, { rows: s.teams, frames: s.teams.map((r) => r[0]), players: s.players, usual: s.usual,
                        usualRest: s.usual_rest || {}, surf: s.surface, cell: s.surface_cell || 5 });
    // replayable moments: the low point is inside the clip
    SH.moments = s.moments.filter((m) => m[1] >= meta.first && m[0] <= meta.last);
    for (const m of SH.moments) C.events.push({ frame: m[0], kind: 'shadow', team: m[2], m });
  }
  function shIdx(f) {
    let lo = 0, hi = SH.frames.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (SH.frames[mid] <= f) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans >= 0 && f - SH.frames[ans] <= 3 * meta.fps ? ans : -1;
  }
  const toMove = (role, gap, x, y, sx, sy, kind = 'shadow', team = 'H') => { const [X, Y] = tf(x, y), [SX, SY] = tf(sx, sy); return { role, gap, x: X, y: Y, sx: SX, sy: SY, kind, team }; };
  const momentMoves = (m) => m[4].filter((t) => t[1] >= SH_MIN / 3)
    .map(([li, gap, x, y, sx, sy]) => toMove(labels[li], gap, x, y, sx, sy, m[5] === 'rest' ? 'cover' : 'shadow', m[2]));
  // kind 'shadow': best position for the current phase; 'cover': best position for the rest defence
  const COLS = { shadow: { gap: 4, x: 6, y: 7 }, cover: { gap: 10, x: 11, y: 12 } };
  function shMoves(i, team = 'H', kind = 'shadow', n = 3) {
    if (i < 0) return [];
    const t = team === 'H' ? 0 : 1, c = COLS[kind];
    const prev = i > 0 && SH.frames[i] - SH.frames[i - 1] <= 2 * meta.fps ? SH.players[i - 1] : null;
    return SH.players[i].filter((p) => p[1] === t && p[c.gap] != null && p[c.gap] >= SH_MIN &&
        (!prev || prev.some((q) => q[1] === t && q[2] === p[2] && q[c.gap] != null && q[c.gap] >= SH_MIN / 2)))
      .sort((a, b) => b[c.gap] - a[c.gap]).slice(0, n).map((p) => toMove(labels[p[2]], p[c.gap], p[8], p[9], p[c.x], p[c.y], kind, team));
  }
  const restThin = (row) => row && row[1] === 'H' && row[6] != null && SH.usualRest.H != null && row[6] < SH.usualRest.H - REST_THIN;
  // what the Shadow pitch shows at row i: thin rest defence -> 2 cover moves + the best attacking one
  function liveMoves(i) {
    if (i < 0) return [];
    if (!restThin(SH.rows[i])) return shMoves(i);
    const cover = shMoves(i, 'H', 'cover', 2), roles = new Set(cover.map((m) => m.role));
    return cover.concat(shMoves(i).filter((m) => !roles.has(m.role)).slice(0, 1));
  }
  function moveText(m) {
    const s = m.team === 'A' ? -1 : 1, dx = s * (m.sx - m.x), dy = s * (m.sy - m.y), parts = [];   // in that team's own direction
    if (Math.abs(dx) >= 1) parts.push(`${Math.round(Math.abs(dx))} m ${dx < 0 ? 'deeper' : 'higher'}`);
    if (Math.abs(dy) >= 1) parts.push(`${Math.round(Math.abs(dy))} m ${dy < 0 ? 'left' : 'right'}`);
    return parts.join(', ') || 'hold';
  }
  const pctM = (permille) => Math.round(permille / 10) + '%';
  const nameFor = (team, role) => (team === 'H' ? nameOf(role) : oppToPlayer[role] ? shortName(oppToPlayer[role]) : `${(lineup.oppName || meta.teams.A).split(' ')[0]} ${role}`);
  const moveColor = (m) => (m.kind === 'cover' ? COL.warn : COL.shadow);

  // the model's control (same as sb/offball.py, players standing) x threat, painted per 3 m cell.
  // `poss` = the team whose attack the threat is valued for.
  const REACT = 0.7, VMAX = 5, SOFT = 0.3, TEMP = 0.45;
  function dangerCells(ps, poss, ball) {
    if (!SH.surf || (poss !== 'H' && poss !== 'A') || !ps.length) return null;
    const c = 3, nx = SH.surf.length, ny = SH.surf[0].length, raw = [];
    let vmax = 1e-9;
    for (let x = 0; x < L; x += c) for (let y = 0; y < W; y += c) {
      const mx = x + c / 2, my = y + c / 2; let sh = 0, sa = 0;
      for (const p of ps) { const e = Math.exp(-(REACT + Math.hypot(p.x - mx, p.y - my) / VMAX) / SOFT); if (p.team === 'H') sh += e; else sa += e; }
      const th = -SOFT * Math.log(Math.max(sh, 1e-300)), ta = -SOFT * Math.log(Math.max(sa, 1e-300));
      const ctl = 1 / (1 + Math.exp(-(ta - th) / TEMP));
      const ax = poss === 'H' ? mx : L - mx, ay = poss === 'H' ? my : W - my;
      const val = SH.surf[Math.max(0, Math.min(nx - 1, Math.floor(ax / SH.cell)))][Math.max(0, Math.min(ny - 1, Math.floor(ay / SH.cell)))] *
        (ball ? 0.5 + 0.5 * Math.exp(-Math.hypot(mx - ball.x, my - ball.y) / 25) : 1);
      vmax = Math.max(vmax, val); raw.push([x, y, ctl, val]);
    }
    const ch = parseInt(lineup.kitH.slice(1), 16), ca = parseInt(lineup.kitA.slice(1), 16);
    return raw.map(([x, y, ctl, val]) => {
      const col = ctl > 0.5 ? ch : ca, a = 0.62 * Math.pow(val / vmax, 0.75) * Math.min(1, Math.abs(ctl - 0.5) * 2.4);
      return [x, y, col >> 16, (col >> 8) & 255, col & 255, a];
    });
  }
  function frameState(frame) {
    const fi = Math.max(0, Math.min(nFrames - 1, Math.round((frame - meta.first) / (meta.fps / meta.sample_fps))));
    const b = C.frames[fi][2]; let ball = null;
    if (b) { const [X, Y] = tf(b[0], b[1]); ball = { x: X, y: Y, model: b[2] === 1, sigma: b[3] }; }
    return { ps: framePlayers(fi), ball };
  }
  const rowState = (i) => frameState(SH.frames[i]);     // players + ball at an evaluated second

  function drawShadowPitch(ps, ball, moves, alphaOf, team) {
    const v = shV, g = v.ctx; v.begin();
    if (shPaint) paintCells(v, shPaint);
    const r = Math.max(5.5, 0.95 * v.sc), mover = new Map(moves.map((m) => [m.role, m]));
    for (const p of ps) {           // their players small and dim, ours solid; movers get a ring
      const [a, b] = v.S(p.x, p.y), ours = p.team === team;
      g.beginPath(); g.arc(a, b, ours ? r : r * 0.8, 0, 7);
      g.fillStyle = hexA(p.team === 'H' ? lineup.kitH : lineup.kitA, ours ? 0.95 : 0.5); g.fill();
      g.lineWidth = 1.2; g.strokeStyle = ours ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.35)'; g.stroke();
      if (ours && team === 'H') {
        const pl = roleToPlayer[p.role];
        g.fillStyle = '#fff'; g.font = `700 ${Math.round(r * 0.9)}px ${CSS.getPropertyValue('--mono')}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(pl && pl.num != null ? String(pl.num) : '', a, b + 0.5);
      }
      if (ours && mover.has(p.role)) { g.beginPath(); g.arc(a, b, r + 3, 0, 7); g.strokeStyle = moveColor(mover.get(p.role)); g.lineWidth = 2; g.stroke(); }
    }
    for (const m of moves) {
      const al = alphaOf(m); if (al <= 0.02) continue;
      const col = moveColor(m);
      g.save(); g.globalAlpha = al;
      const [a, b] = v.S(m.sx, m.sy);
      g.beginPath(); g.arc(a, b, r, 0, 7); g.fillStyle = hexA(col, 0.22); g.fill();
      g.setLineDash([3, 3]); g.strokeStyle = m.kind === 'cover' ? '#FDE7A8' : '#D9CCFF'; g.lineWidth = 1.6; g.stroke(); g.setLineDash([]);
      const d = Math.hypot(m.sx - m.x, m.sy - m.y);
      if (d > 1.2) { const k = (d - r / v.sc - 0.2) / d; v.arrow(m.x, m.y, m.x + (m.sx - m.x) * k, m.y + (m.sy - m.y) * k, col, 2.6); }
      v.label(`${nameFor(team, m.role)}${m.kind === 'cover' ? ' cover' : ''} +${fmt1(m.gap / 10)}%`, m.sx, m.sy, -(r + 11),
              { size: 10.5, bg: m.kind === 'cover' ? 'rgba(60,40,5,.88)' : 'rgba(30,18,60,.85)' });
      g.restore();
    }
    if (ball) drawBall(v, ball, true);
  }

  function moveCards(moves, team) {
    if (!moves.length) return '<p class="empty">No move worth calling: every player is within reach of his best spot.</p>';
    return moves.map((m) => { const pl = team === 'H' ? roleToPlayer[m.role] : null; return `<div class="mv${m.kind === 'cover' ? ' cover' : ''}">${avatar(pl, team, m.role)}
      <span class="who"><b>${esc(team === 'H' ? nameOf(m.role) : nameFor(team, m.role))}</b><span>${m.role} · ${m.kind === 'cover' ? 'cover: ' : ''}${esc(moveText(m))}</span></span><em>+${fmt1(m.gap / 10)}%</em></div>`; }).join('');
  }

  function setKpi(id, value, cls, sub) { const el = $(id); el.textContent = value; el.className = cls || ''; if (sub != null) $(id + 'U').textContent = sub; }
  function shadowKpis(i) {
    const row = SH.rows[i], ours = row[2], defending = row[1] === 'A', u = SH.usual.H, ur = SH.usualRest.H;
    $('shDenK').textContent = defending ? 'Space denied' : 'Space owned';
    setKpi('shDen', pctM(ours), defending && u ? (ours < u - 100 ? 'bad' : ours < u - 50 ? 'warn' : '') : '',
           defending && u ? `usual ${pctM(u)}` : 'of their dangerous space');
    if (!defending && row[6] != null) setKpi('shRest', pctM(row[6]), restThin(row) ? 'warn' : '', ur ? `if lost now · usual ${pctM(ur)}` : 'if lost now');
    else setKpi('shRest', '–', '', 'while we have the ball');
    $('shGap').textContent = String(SH.moments.filter((m) => m[2] === 'H' && m[0] <= SH.frames[i]).length);
    // sparkline: our share of the dangerous space over the last 2 minutes (dashed: usual while defending)
    const c = $('shSpark'), w = c.clientWidth, h = 40, d = window.devicePixelRatio || 1; if (!w) return;
    c.width = w * d; c.height = h * d; const g = c.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0);
    const from = SH.frames[i] - 120 * meta.fps, X = (fr) => (fr - from) / (120 * meta.fps) * w, Y = (v) => h - 3 - (v / 1000) * (h - 6);
    if (u) { g.strokeStyle = 'rgba(255,255,255,.3)'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(0, Y(u)); g.lineTo(w, Y(u)); g.stroke(); g.setLineDash([]); }
    let started = false; g.beginPath();
    for (let j = i; j >= 0 && SH.frames[j] >= from; j--) { const x = X(SH.frames[j]), y = Y(SH.rows[j][2]); if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y); }
    g.strokeStyle = COL.shadow; g.lineWidth = 1.6; g.stroke();
  }

  function drawShadow() {
    if (!SH.rows.length || !shV) return;
    if (replay) { drawReplay(); return; }
    if (narrow()) return;
    const f = videoFrame(S.t), i = shIdx(f);
    if (i < 0) {
      if (shKey !== 'none') { shKey = 'none'; shPaint = null; const { ps, ball } = frameState(f); drawShadowPitch(ps, ball, [], () => 0, 'H');
        $('shMoves').innerHTML = '<p class="empty">Dead ball or no tracking: the model waits for play.</p>'; $('shCalm').hidden = true; $('shWarn').hidden = true;
        setKpi('shDen', '–'); setKpi('shRest', '–'); }
      return;
    }
    // glide from the previous evaluated second to this one over 0.4 s; new arrows fade in
    const k = S.playing ? Math.min(1, (f - SH.frames[i]) / (0.4 * meta.fps)) : 1;
    const cur = rowState(i), moves = liveMoves(i), thin = restThin(SH.rows[i]);
    if (shKey !== 'r' + i) {
      shKey = 'r' + i;
      // thin rest defence: paint OUR dangerous space (valued for their attack), where the cover is needed
      shPaint = dangerCells(cur.ps, thin ? 'A' : SH.rows[i][1], cur.ball);
      shadowKpis(i);
      $('shMoves').innerHTML = moveCards(moves, 'H');
      $('shCalm').hidden = !!moves.length || thin; $('shWarn').hidden = !thin;
      S.shadowNow = { i, moves };
    }
    const prev = i > 0 && SH.frames[i] - SH.frames[i - 1] <= 2 * meta.fps ? rowState(i - 1) : null;
    let ps = cur.ps;
    if (prev && k < 1) {
      const pm = new Map(prev.ps.map((p) => [p.k, p]));
      ps = cur.ps.map((p) => { const q = pm.get(p.k); return q ? Object.assign({}, p, { x: q.x + (p.x - q.x) * k, y: q.y + (p.y - q.y) * k }) : p; });
    }
    // a move already called a second ago stays solid; only new ones fade in
    const before = new Set(prev ? liveMoves(i - 1).map((m) => m.kind + m.role) : []);
    drawShadowPitch(ps, cur.ball, moves, (m) => (before.has(m.kind + m.role) ? 1 : k), 'H');
  }

  // ---------------------------------------------------------------- Shadow Replay
  // Fires live when the opponent enters our final third and either (denial) in the 10 s before, our
  // space denial dropped into its lowest 35%, or (rest) we had just lost the ball with our rest
  // defence below its usual (sb/demo.py). Freezes the Shadow pitch on that second for 7 s.
  function openReplay(m) {
    replay = { m, start: performance.now(), until: performance.now() + 7000 };
    $('shadowCard').classList.add('replay');
    if (narrow()) shV.layout($('shadowPitch').parentElement.clientWidth);
    const [entry, low, team, value, , kind] = m, opp = (lineup.oppName || meta.teams.A).split(' ')[0];
    const moves = momentMoves(m), ours = team === 'H', rest = kind === 'rest';
    $('shReplay').hidden = false; $('shCalm').hidden = true; $('shWarn').hidden = true;
    $('shReplayAt').textContent = clockText(low);
    const secs = Math.max(1, Math.round((entry - low) / meta.fps));
    $('shTitle').textContent = ours
      ? (rest ? `We lost the ball, ${opp} reached our final third ${secs} s later` : `${secs} s before ${opp} reached our final third`)
      : (rest ? `${opp} lost the ball with thin cover` : `${opp} left space before our attack`);
    $('shSub').textContent = ours ? (rest ? 'where our players could have covered, a second before the loss' : 'where our players could have been')
      : (rest ? 'their weakest cover: counter there again' : 'their weakest moves: attack there again');
    $('shDenK').textContent = rest ? (ours ? 'Rest defence' : 'Their rest defence') : (ours ? 'Space denied' : 'Their space denied');
    const usual = rest ? SH.usualRest[team] : SH.usual[team];
    setKpi('shDen', pctM(value), ours ? 'bad' : '', usual ? `usual ${pctM(usual)}` : '');
    setKpi('shRest', '–', '', '');
    $('shMoves').innerHTML = moveCards(moves, team);
    const { ps, ball } = frameState(low);
    shPaint = dangerCells(ps, team === 'H' ? 'A' : 'H', ball);      // the space the team that suffered had to protect
    replay.draw = () => { replay.view = shV; drawShadowPitch(ps, ball, moves, () => 1, team); };
    replay.draw();
  }
  function drawReplay() {
    const left = replay.until - performance.now();
    if (left <= 0) { closeReplay(); return; }
    if (replay.view !== shV) replay.draw();          // the views were rebuilt (resize, rotation)
    $('shReplayBar').style.transform = `scaleX(${(left / (replay.until - replay.start)).toFixed(3)})`;
  }
  function closeReplay() {
    replay = null; shKey = ''; $('shadowCard').classList.remove('replay'); $('shReplay').hidden = true;
    $('shTitle').textContent = 'Best positions'; $('shSub').textContent = 'the last second, re-computed every second';
  }
  // live trigger: the playhead crosses an entry that follows one of OUR lapses (not on a scrub jump)
  function replayTrigger(f) {
    if (prevF != null && S.playing && f > prevF && f - prevF < 5 * meta.fps) {
      const m = SH.moments.find((x) => x[2] === 'H' && x[0] > prevF && x[0] <= f);
      if (m) openReplay(m);
    }
    prevF = f;
  }
  // over the last `sec` seconds: our mean space denied while they had the ball, our mean rest defence
  // while we had it, and who most often had a move (or a cover move) to make
  function shRecent(f, sec) {
    const i = shIdx(f); if (i < 0) return null;
    let n = 0, sum = 0, nr = 0, sr = 0; const who = {}, cover = {};
    for (let j = i; j >= 0 && SH.frames[j] > f - sec * meta.fps; j--) {
      const row = SH.rows[j];
      if (row[1] === 'A') { n++; sum += row[2]; for (const mv of shMoves(j)) who[mv.role] = (who[mv.role] || 0) + 1; }
      else if (row[1] === 'H' && row[6] != null) { nr++; sr += row[6]; for (const mv of shMoves(j, 'H', 'cover')) cover[mv.role] = (cover[mv.role] || 0) + 1; }
    }
    const top = (o) => { const t = Object.entries(o).sort((a, b) => b[1] - a[1])[0]; return t && t[1] >= 3 ? t[0] : null; };
    return { avg: n >= 10 ? sum / n : null, n, who: top(who), rest: nr >= 10 ? sr / nr : null, nr, cover: top(cover) };
  }

  // ================================================================== Pressing traps (sb/pressing.py)
  // Per zone, from kick-off to now: when the team pressed (2+ within 8 m of the ball) vs held its
  // shape, how often it won the ball back within 5 s and how often the opponent reached its box
  // within 10 s. Zones in the defenders' attacking frame; drawn in our view.
  const P_BANDS = [0, L / 3, L / 2, 2 * L / 3, L];
  // band names for our coach: our pressing (H frame) and theirs (A frame: their own third is deep in their half)
  const P_BAND = { H: ['our third', 'our half', 'their half', 'their third'], A: ['their own third', 'their half', 'our half', 'our third'] };
  const P_LANE = ['left', 'middle', 'right'];
  let pressV, pressTeamSel = 'H', pressCache = '';
  function pressZones(f, team) {
    const t = team === 'H' ? 0 : 1, z = {};
    for (const [fr, d, band, ln, press, regain, box] of C.pressing || []) {
      if (fr > f || d !== t) continue;
      const k = band * 3 + ln, s = z[k] || (z[k] = { band, lane: ln, np: 0, nh: 0, rp: 0, rh: 0, bp: 0, bh: 0 });
      if (press) { s.np++; s.rp += regain; s.bp += box; } else { s.nh++; s.rh += regain; s.bh += box; }
    }
    for (const s of Object.values(z)) {
      const k = s.np / (s.np + 20);                                   // shrink small samples
      s.regP = s.np ? s.rp / s.np : null; s.regH = s.nh ? s.rh / s.nh : null; s.boxP = s.np ? s.bp / s.np : null; s.boxH = s.nh ? s.bh / s.nh : null;
      s.ok = s.np >= 12 && s.nh >= 12;
      s.dr = s.ok ? (s.regP - s.regH) * k : 0; s.db = s.ok ? (s.boxP - s.boxH) * k : 0;
      s.kind = !s.ok ? 'few' : (s.db >= 0.03 || s.dr <= -0.05) ? 'leak' : (s.dr >= 0.05 && s.db <= 0.02) ? 'trap' : 'even';
    }
    return z;
  }
  function pressBands(f, team) {        // the same by band (all lanes): the headline
    const out = [];
    const z = pressZones(f, team);
    for (let b = 0; b < 4; b++) {
      const s = { band: b, np: 0, nh: 0, rp: 0, rh: 0, bp: 0, bh: 0 };
      for (const v of Object.values(z)) if (v.band === b) { s.np += v.np; s.nh += v.nh; s.rp += v.rp; s.rh += v.rh; s.bp += v.bp; s.bh += v.bh; }
      s.regP = s.np ? s.rp / s.np : 0; s.regH = s.nh ? s.rh / s.nh : 0; s.boxP = s.np ? s.bp / s.np : 0; s.boxH = s.nh ? s.bh / s.nh : 0;
      s.ok = s.np >= 25 && s.nh >= 25; out.push(s);
    }
    return out;
  }
  // a zone's rectangle in OUR view: the defenders' frame is ours for H, flipped for A
  function zoneRect(band, ln, team) {
    let x0 = P_BANDS[band], x1 = P_BANDS[band + 1], y0 = ln * W / 3, y1 = (ln + 1) * W / 3;
    if (team === 'A') [x0, x1, y0, y1] = [L - x1, L - x0, W - y1, W - y0];
    return [x0, y0, x1, y1];
  }
  const pctR = (v) => (v == null ? '–' : Math.round(v * 100) + '%');
  // live card (defaults) or the report (its own view, our team, no cache)
  function pressingCard(f, v = pressV, tEl = $('pressTitle'), sEl = $('pressSub'), pressTeam = pressTeamSel) {
    if (!C.pressing) { if ($('pressCard')) $('pressCard').hidden = true; return; }
    const live = v === pressV;
    if (live && (narrow() || !pressV)) return;
    const key = pressTeam + Math.floor((f - meta.first) / (10 * meta.fps)) + lineup.kitH;
    if (live) { if (key === pressCache) return; pressCache = key; }
    const g = v.ctx; v.begin();
    const z = pressZones(f, pressTeam);
    for (const s of Object.values(z)) {
      const [x0, y0, x1, y1] = zoneRect(s.band, s.lane, pressTeam);
      const col = s.kind === 'trap' ? COL.ok : s.kind === 'leak' ? COL.bad : '#9AA1AB';
      const a = s.kind === 'few' ? 0.06 : s.kind === 'even' ? 0.1 : Math.min(0.55, 0.2 + Math.max(Math.abs(s.dr), Math.abs(s.db) * 2) * 2);
      v.rect(x0 + 0.6, y0 + 0.6, x1 - 0.6, y1 - 0.6); g.fillStyle = hexA(col, a); g.fill();
      if (s.kind === 'trap' || s.kind === 'leak') { g.strokeStyle = hexA(col, 0.9); g.lineWidth = 1.5; g.stroke(); }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      if (s.ok) {
        v.label(`${pctR(s.regP)} · ${pctR(s.regH)}`, cx, cy, -6, { size: 11, mono: true, pill: false, color: '#fff' });
        v.label(s.kind === 'leak' && s.db >= 0.03 ? `box ${pctR(s.boxP)} · ${pctR(s.boxH)}` : `n ${s.np} · ${s.nh}`, cx, cy, 9, { size: 9, pill: false, color: 'rgba(255,255,255,.7)' });
      } else v.label('few', cx, cy, 0, { size: 9, pill: false, color: 'rgba(255,255,255,.45)' });
    }
    const opp = (lineup.oppName || meta.teams.A).split(' ')[0], who = pressTeam === 'H' ? 'we' : opp;
    const bands = pressBands(f, pressTeam).filter((b) => b.ok);
    const best = bands.slice().sort((a, b) => (b.regP - b.regH) - (a.regP - a.regH))[0];
    const worst = bands.slice().sort((a, b) => ((a.regP - a.regH) - 2 * (a.boxP - a.boxH)) - ((b.regP - b.regH) - 2 * (b.boxP - b.boxH)))[0];
    const where = (b) => P_BAND[pressTeam][b.band];
    tEl.textContent = best && best.regP > best.regH + 0.04 ? `${pressTeam === 'H' ? 'Press' : `${opp} press`} in ${where(best)}: won back ${pctR(best.regP)} vs ${pctR(best.regH)} holding` : 'No zone where pressing clearly pays yet';
    sEl.textContent = worst && worst !== best && (worst.regP < worst.regH - 0.04 || worst.boxP > worst.boxH + 0.02)
      ? `${pressTeam === 'H' ? 'Hold' : `${opp} leak`} in ${where(worst)}: pressing there won it back ${pctR(worst.regP)} vs ${pctR(worst.regH)}, ball in ${pressTeam === 'H' ? 'our' : 'their'} box ${pctR(worst.boxP)} vs ${pctR(worst.boxH)}`
      : `${who === 'we' ? 'We' : who} pressed ${Math.round(100 * bands.reduce((s, b) => s + b.np, 0) / Math.max(1, bands.reduce((s, b) => s + b.np + b.nh, 0)))}% of the time without the ball`;
    if (live) S.pressing = pressTeam === 'H' ? { best, worst, zones: z } : S.pressing;
  }
  // the kind of OUR pressing zone a point (our view) falls in: for the Defend simulation
  function ourPressZone(f, x, y) {
    const z = pressZones(f, 'H'), band = x < P_BANDS[1] ? 0 : x < P_BANDS[2] ? 1 : x < P_BANDS[3] ? 2 : 3, ln = y < W / 3 ? 0 : y < 2 * W / 3 ? 1 : 2;
    return z[band * 3 + ln] || null;
  }

  // ================================================================== Space leaks (fatigue -> denial)
  // Per our position, the latest completed 5-min block: the dangerous space he leaves on the table
  // per second while we defend (gap), against his own first 15 minutes of this half.
  function leaks(f) {
    const by = {};
    for (const r of C.leak || []) {
      const [team, li, half, block, n, contrib, gap, baseC, baseG, risk, level] = r;
      if (team !== 'H' || half !== meta.half || blockEnd(half, block) > f || n < 30 || baseG == null || labels[li] === 'GK') continue;
      (by[labels[li]] = by[labels[li]] || []).push({ block, n, gap, baseG, risk, level });
    }
    // the last 10 minutes (two completed blocks, weighted by seconds): one 5-min block is too noisy
    const out = Object.entries(by).map(([role, bl]) => {
      const last2 = bl.sort((a, b) => a.block - b.block).slice(-2), n = last2.reduce((s, b) => s + b.n, 0);
      const gap = last2.reduce((s, b) => s + b.gap * b.n, 0) / n, cur = last2[last2.length - 1];
      return { role, block: cur.block, gap, baseG: cur.baseG, risk: cur.risk, level: cur.level, ratio: gap / Math.max(1.5, cur.baseG), early: bl.length < 4 };
    }).filter((r) => !r.early).sort((a, b) => b.gap - a.gap);         // most space left first (the back line)
    for (const r of out) r.flag = r.ratio >= 1.5 && r.gap - r.baseG >= 8;     // 0.8+ points of the dangerous space per second
    return out;
  }
  let leakCache = '';
  function leakCard(f) {
    if (narrow() || !C.leak) { if (!C.leak && $('leakCard')) $('leakCard').hidden = true; S.leaks = []; return; }
    const rows = leaks(f); S.leaks = rows;
    const key = rows.map((r) => r.role + r.block).join('|') + lineup.kitH;
    if (key === leakCache) return; leakCache = key;
    const max = Math.max(3, ...rows.map((r) => Math.max(r.gap, r.baseG)));
    $('leakList').innerHTML = rows.length ? rows.slice(0, 6).map((r) => {
      const pl = roleToPlayer[r.role];
      return `<div class="lk${r.flag ? ' flag' : ''}">${avatar(pl, 'H', r.role)}
        <span class="who"><b>${esc(nameOf(r.role))}</b><span>${r.role} · <i style="background:${LEVEL[r.level] || LEVEL['no data']}"></i>${r.risk != null ? 'fatigue ' + r.risk : 'no fatigue data'}</span></span>
        <span class="bars" title="space left per second: first 15 min vs last block"><i style="width:${(r.baseG / max * 100).toFixed(0)}%"></i><i class="now" style="width:${(r.gap / max * 100).toFixed(0)}%"></i></span>
        <em>${r.ratio.toFixed(1)}×</em></div>`;
    }).join('') : '<p class="empty">The first blocks of this half are the baseline: leaks show from minute 15 of the half.</p>';
  }

  // ================================================================== live Shadow ratings (FotMob-style card)
  // Per position, from kick-off to now: 6.5 + movement without the ball (mean Shadow score vs 55,
  // the match average; random = 50) + dangerous space held (mean contribution vs the average for the
  // position family in this match). Shown on the coach's own line-up card, both teams.
  function shadowRatings(f) {
    const nowMin = Math.floor((f - meta.half_start) / meta.fps / 60) + (meta.half === 2 ? 45 : 0), acc = {};
    for (const [team, li, half, minute, n, score, contrib] of C.ratings || []) {
      if (half > meta.half || (half === meta.half && minute >= nowMin)) continue;    // completed minutes only
      const k = team + ':' + labels[li], a = acc[k] || (acc[k] = { n: 0, score: 0, contrib: 0 });
      a.n += n; a.score += score; a.contrib += contrib;
    }
    const out = {};
    for (const [k, a] of Object.entries(acc)) {
      if (a.n < 60) continue;
      const ref = (C.rating_ref || {})[k.split(':')[1]] || 10;
      const move = Math.max(-1.8, Math.min(1.8, (a.score / a.n - 55) * 0.45));
      const space = Math.max(-1.2, Math.min(1.2, (a.contrib / a.n / ref - 1) * 1.2));
      out[k] = { rating: Math.max(3, Math.min(10, 6.5 + move + space)), score: a.score / a.n, held: a.contrib / a.n / ref, n: a.n };
    }
    return out;
  }
  const rateColor = (r) => (r >= 7 ? COL.ok : r >= 6 ? COL.warn : COL.bad);
  let luKey = '';
  function lineupCard(f) {
    if (narrow() || !C.ratings) { if (!C.ratings && $('luCard')) $('luCard').hidden = true; return; }
    const R = shadowRatings(f); S.ratings = R;
    const key = Object.entries(R).map(([k, v]) => k + v.rating.toFixed(1)).join('|') + lineup.formation + oppFormation() + JSON.stringify(lineup.opp ? lineup.opp.xi : 0);
    if (key === luKey) return; luKey = key;
    const opp = lineup.oppName || meta.teams.A, html = [];
    const team = (t) => {
      const form = t === 'H' ? lineup.formation : oppFormation(), slotRole = {};
      for (const [role, slot] of Object.entries(roleToSlot[t])) slotRole[slot] = role;
      const vals = [];
      for (const s of D.slots(form)) {
        const role = slotRole[s.label], r = role && R[`${t}:${role}`], p = t === 'H' ? player(lineup.xi[s.label]) : lineup.opp && lineup.opp.xi[s.label];
        // ours from the bottom (attacking up), theirs from the top
        const left = t === 'H' ? 8 + s.x * 84 : 92 - s.x * 84, top = t === 'H' ? 95 - s.y * 42 : 5 + s.y * 42;
        if (r) vals.push(r.rating);
        const name = p ? shortName(p) : s.label;
        html.push(`<div class="lp" style="left:${left}%;top:${top}%" title="${esc(name)} · ${s.label}${r ? ` · Shadow score ${Math.round(r.score)} · space held ${r.held.toFixed(2)}×` : ''}">
          <span class="ph" style="--kit:var(--${t === 'H' ? 'home' : 'away'});${p && p.photo ? `background-image:url(${p.photo})` : ''}">${p && p.photo ? '' : (p && p.num != null ? p.num : s.label)}
          ${r ? `<span class="rt" style="background:${rateColor(r.rating)}">${r.rating.toFixed(1)}</span>` : ''}</span><span class="nm">${esc(name)}</span></div>`);
      }
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const avgH = team('H'), avgA = team('A');
    const tag = (name, avg) => `${esc(name)}${avg != null ? `<em style="background:${rateColor(avg)}">${avg.toFixed(1)}</em>` : ''}`;
    $('luTop').innerHTML = tag(opp.split(' ')[0], avgA); $('luBot').innerHTML = tag(meta.teams.H, avgH);
    $('luLive').innerHTML = html.join('');
  }

  // ================================================================== simulation cards (Attack / Defend)
  // The off-ball model run forward: from a real second of the last 30 s, up to 4 of our players move
  // TOGETHER (each within 5 m, about one second of running), chosen greedily so that every move
  // counts the moves already made: a unit shift, not 4 separate tips. Defend = our weakest second
  // while they had the ball (lowest space denied); Attack = our latest second with the ball, with
  // what the moves cost the rest defence. The card loops: now -> simulated -> now.
  const SIM_OFFS = [[0, 0]];
  for (const r of [2.5, 5]) for (let k = 0; k < 8; k++) SIM_OFFS.push([r * Math.cos(k * Math.PI / 4), r * Math.sin(k * Math.PI / 4)]);
  let simCells = null, simKey = '', lastSim = 0, sims = { atk: null, def: null };
  function simGrid() {
    if (simCells) return simCells;
    const pts = []; for (let x = 1.5; x < L; x += 3) for (let y = 1.5; y < W; y += 3) pts.push([x, y]);
    return (simCells = pts);
  }
  function valueFor(att, ball) {       // the threat surface seen from `att`'s attack, weighted towards the ball
    const cells = simGrid(), nx = SH.surf.length, ny = SH.surf[0].length, v = new Float64Array(cells.length);
    let sum = 0;
    cells.forEach(([x, y], i) => {
      const ax = att === 'H' ? x : L - x, ay = att === 'H' ? y : W - y;
      v[i] = SH.surf[Math.max(0, Math.min(nx - 1, Math.floor(ax / SH.cell)))][Math.max(0, Math.min(ny - 1, Math.floor(ay / SH.cell)))] *
        (ball ? 0.5 + 0.5 * Math.exp(-Math.hypot(x - ball.x, y - ball.y) / 25) : 1);
      sum += v[i];
    });
    for (let i = 0; i < v.length; i++) v[i] /= sum;
    return v;
  }
  function expArr(x, y) {
    const cells = simGrid(), e = new Float64Array(cells.length);
    for (let i = 0; i < cells.length; i++) e[i] = Math.exp(-(REACT + Math.hypot(x - cells[i][0], y - cells[i][1]) / VMAX) / SOFT);
    return e;
  }
  function ownJ(v, sH, tA) {          // our share of the space valued by v
    let j = 0;
    for (let i = 0; i < v.length; i++) j += v[i] / (1 + Math.exp(-(tA[i] + SOFT * Math.log(Math.max(sH[i], 1e-300))) / TEMP));
    return j;
  }
  function simulateUnit(ps, ball, att, maxMoves = 4) {
    const cells = simGrid(), n = cells.length, v = valueFor(att, ball), vRest = att === 'H' ? valueFor('A', ball) : null;
    const E = ps.map((p) => expArr(p.x, p.y)), sH = new Float64Array(n), sA = new Float64Array(n);
    ps.forEach((p, k) => { const s = p.team === 'H' ? sH : sA; for (let i = 0; i < n; i++) s[i] += E[k][i]; });
    const tA = sA.map((s) => -SOFT * Math.log(Math.max(s, 1e-300)));
    let carrier = -1;
    if (att === 'H' && ball) { let bd = 3; ps.forEach((p, k) => { if (p.team === 'H') { const d = Math.hypot(p.x - ball.x, p.y - ball.y); if (d < bd) { bd = d; carrier = k; } } }); }
    const movable = ps.map((p, k) => k).filter((k) => ps[k].team === 'H' && ps[k].role !== 'GK' && k !== carrier);
    const before = ownJ(v, sH, tA), restBefore = vRest ? ownJ(vRest, sH, tA) : null;
    let cur = before; const moves = [], moved = new Set(), pos = ps.map((p) => ({ x: p.x, y: p.y }));
    const trial = new Float64Array(n);
    for (let step = 0; step < maxMoves; step++) {
      let best = null;
      for (const k of movable) {
        if (moved.has(k)) continue;
        for (let o = 1; o < SIM_OFFS.length; o++) {
          const x = Math.max(0.5, Math.min(L - 0.5, pos[k].x + SIM_OFFS[o][0])), y = Math.max(0.5, Math.min(W - 0.5, pos[k].y + SIM_OFFS[o][1]));
          const e = expArr(x, y);
          for (let i = 0; i < n; i++) trial[i] = sH[i] - E[k][i] + e[i];
          const j = ownJ(v, trial, tA);
          if (!best || j > best.j) best = { k, x, y, j, e };
        }
      }
      if (!best || best.j - cur < 0.004) break;          // under 0.4 points: not worth a call
      for (let i = 0; i < n; i++) sH[i] += best.e[i] - E[best.k][i];
      E[best.k] = best.e; moved.add(best.k);
      moves.push({ role: ps[best.k].role, x: ps[best.k].x, y: ps[best.k].y, sx: best.x, sy: best.y, gap: (best.j - cur) * 1000, team: 'H', kind: 'shadow' });
      pos[best.k] = { x: best.x, y: best.y }; cur = best.j;
    }
    const ps2 = ps.map((p, k) => Object.assign({}, p, pos[k]));
    return { before, after: cur, restBefore, restAfter: vRest ? ownJ(vRest, sH, tA) : null, moves, ps2 };
  }

  function pickSecond(f, poss, mode) {
    const i = shIdx(f); if (i < 0) return null;
    let pick = null;
    for (let j = i; j >= 0 && SH.frames[j] > f - 30 * meta.fps; j--) {
      if (SH.rows[j][1] !== poss) continue;
      if (mode === 'latest') return j;
      if (!pick || SH.rows[j][2] < SH.rows[pick][2]) pick = j;       // lowest share of the dangerous space we own
    }
    return pick;
  }
  function simCards() {
    if (narrow() || !SH.surf || !advA) return;
    const f = videoFrame(S.t), jd = pickSecond(f, 'A', 'worst'), ja = pickSecond(f, 'H', 'latest');
    const key = `${jd}|${ja}|${lineup.kitH}`;
    if (key === simKey || (simKey && performance.now() - lastSim < 700)) return;     // at 10x: at most ~1.5 runs a second
    simKey = key; lastSim = performance.now();
    for (const [side, j, att] of [['def', jd, 'A'], ['atk', ja, 'H']]) {
      if (j == null) { sims[side] = null; continue; }
      const { ps, ball } = frameState(SH.frames[j]), r = simulateUnit(ps, ball, att);
      sims[side] = Object.assign(r, { ps, ball, frame: SH.frames[j], att, t0: performance.now(),
        paintNow: dangerCells(ps, att, ball), paintSim: dangerCells(r.ps2, att, ball) });
    }
    const list = (s) => s.moves.map((m) => `${nameOf(m.role)} ${moveText(m)}`).join(' · ');
    const d = sims.def, a = sims.atk, el = (id) => $(id).querySelector('.adv-text');
    if (!d) { el('advDef').querySelector('b').textContent = 'No defending moment in the last 30 s'; el('advDef').querySelector('span').textContent = ''; }
    else {
      el('advDef').querySelector('b').textContent = d.moves.length ? `Shift ${d.moves.length} together: space denied ${pctM(d.before * 1000)} → ${pctM(d.after * 1000)}` : `Shape holds: space denied ${pctM(d.before * 1000)}`;
      const pz = d.ball && C.pressing ? ourPressZone(d.frame, d.ball.x, d.ball.y) : null;
      el('advDef').querySelector('span').textContent = `Weakest moment ${clockText(d.frame)}` + (d.moves.length ? ` · ${list(d)}` : ' · no unit move gains 0.4 points') +
        (pz && pz.kind === 'trap' ? ` · or press: ball in a trap zone (won back ${pctR(pz.regP)} vs ${pctR(pz.regH)})` : pz && pz.kind === 'leak' ? ' · do not press here: a leak zone' : '');
    }
    if (!a) { el('advAtk').querySelector('b').textContent = 'No attacking moment in the last 30 s'; el('advAtk').querySelector('span').textContent = ''; }
    else {
      el('advAtk').querySelector('b').textContent = a.moves.length ? `Get open: space owned ${pctM(a.before * 1000)} → ${pctM(a.after * 1000)}` : `No better runs: space owned ${pctM(a.before * 1000)}`;
      el('advAtk').querySelector('span').textContent = `${clockText(a.frame)}` + (a.moves.length ? ` · ${list(a)}` : '') +
        (a.restBefore != null ? ` · rest defence ${pctM(a.restBefore * 1000)} → ${pctM(a.restAfter * 1000)}` : '');
    }
    $('advAtk').querySelector('header .muted').textContent = 'simulated · last 30 s';
    $('advDef').querySelector('header .muted').textContent = 'simulated · weakest moment, last 30 s';
  }
  // now (1.6 s) -> glide (1 s) -> simulated (1.8 s) -> glide back (0.6 s)
  function simPhase(t) { const s = (t % 5000) / 1000; return s < 1.6 ? 0 : s < 2.6 ? (s - 1.6) : s < 4.4 ? 1 : 1 - (s - 4.4) / 0.6; }
  function drawSims() {
    if (narrow() || !SH.surf || !advA) return;
    for (const [v, s] of [[advD, sims.def], [advA, sims.atk]]) {
      const g = v.ctx; v.begin();
      if (!s) continue;
      const raw = simPhase(performance.now() - s.t0), k = raw * raw * (3 - 2 * raw);
      g.save(); g.globalAlpha = 1 - k; paintCells(v, s.paintNow); g.globalAlpha = k; paintCells(v, s.paintSim); g.restore();
      const mv = new Map(s.moves.map((m) => [m.role, m]));
      for (const m of s.moves) if (k < 0.5) {     // where they are going
        const [a, b] = v.S(m.sx, m.sy); g.save(); g.globalAlpha = 1 - 2 * k;
        g.beginPath(); g.arc(a, b, 6, 0, 7); g.setLineDash([3, 3]); g.strokeStyle = '#D9CCFF'; g.lineWidth = 1.5; g.stroke(); g.setLineDash([]);
        v.arrow(m.x, m.y, m.sx, m.sy, COL.shadow, 2); g.restore();
      }
      for (let i = 0; i < s.ps.length; i++) {
        const p = s.ps[i], q = s.ps2[i], x = p.x + (q.x - p.x) * k, y = p.y + (q.y - p.y) * k, [a, b] = v.S(x, y);
        g.beginPath(); g.arc(a, b, 4.8, 0, 7); g.fillStyle = p.team === 'H' ? lineup.kitH : lineup.kitA; g.globalAlpha = p.team === 'H' ? 1 : 0.75; g.fill(); g.globalAlpha = 1;
        g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 1; g.stroke();
        if (mv.has(p.role) && p.team === 'H') { g.beginPath(); g.arc(a, b, 8, 0, 7); g.strokeStyle = COL.shadow; g.lineWidth = 2; g.stroke(); v.label(nameOf(p.role), x, y, -15, { size: 9.5, bg: 'rgba(30,18,60,.85)' }); }
      }
      if (s.ball) drawBall(v, s.ball, false);
      // state pill, screen corner
      const val = s.before + (s.after - s.before) * k, sim = k >= 0.5;
      const text = `${sim ? 'SIMULATED' : 'NOW'} · ${s.att === 'A' ? 'denied' : 'owned'} ${pctM(val * 1000)}`;
      g.font = `700 11px ${CSS.getPropertyValue('--sans')}`; const w = g.measureText(text).width + 16;
      g.fillStyle = sim ? 'rgba(167,139,250,.92)' : 'rgba(10,11,13,.78)'; roundRect(g, 8, 8, w, 22, 11); g.fill();
      g.fillStyle = sim ? '#120D22' : '#F1F3F6'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(text, 16, 19.5);
    }
  }

  // ================================================================== advice maps (last 30 s)
  let advCache = -1;
  function windowSamples(idx) { const out = []; for (let i = Math.max(0, idx - 150); i <= idx; i += 5) { const ps = framePlayers(i); ps.poss = C.frames[i][1]; out.push(ps); } return out; }
  const nameOf = (role) => { const p = roleToPlayer[role]; return p ? shortName(p) : role; };

  function advice(st) {
    const draw = !narrow() && advA && advD && !SH.surf;      // with the off-ball model the cards are simulations (simCards)
    const bucket = Math.floor(S.t / 2);
    if (bucket === advCache) return; advCache = bucket;
    const samples = windowSamples(st.idx), cell = 5, f = videoFrame(S.t);
    // ---------- attack: where the opponent leaves space in his half
    const free = []; let best = null;
    for (let x = 55; x < L - 2; x += cell) for (let y = 2; y < W - 2; y += cell) {
      const mx = x + cell / 2, my = y + cell / 2; let s = 0, n = 0;
      for (const ps of samples) { let d = 1e9; for (const p of ps) if (p.team === 'A') d = Math.min(d, Math.hypot(p.x - mx, p.y - my)); if (d < 1e8) { s += d; n++; } }
      const v = n ? s / n : 0; free.push([x, y, v]);
      if (mx > 62 && mx < 97 && my > 5 && my < W - 5 && (!best || v > best.v)) best = { x: mx, y: my, v };
    }
    const lines = samples.map((ps) => { const xs = ps.filter((p) => p.team === 'A' && p.role !== 'GK').map((p) => p.x).sort((a, b) => b - a); return xs.length >= 4 ? xs.slice(0, 4).reduce((a, b) => a + b) / 4 : null; }).filter((v) => v != null);
    const oppLine = lines.length ? lines.reduce((a, b) => a + b) / lines.length : null;
    const attackers = st.players.filter((p) => p.team === 'H' && !['GK', 'LCB', 'RCB', 'CB'].includes(p.role));
    let runner = null; if (best) for (const p of attackers) { const d = Math.hypot(p.x - best.x, p.y - best.y); if (!runner || d < runner.d) runner = { p, d }; }
    const fv = free.map((c) => c[2]), fmin = Math.min(...fv), fmax = Math.max(...fv);
    if (draw) drawAdvice(advA, free.map(([x, y, v]) => [x, y, (v - fmin) / Math.max(1e-6, fmax - fmin) * 15]), best, '#A78BFA', st, (v) => {
      if (oppLine) { v.path([[oppLine, 0], [oppLine, W]]); v.ctx.save(); v.ctx.setLineDash([6, 6]); v.ctx.strokeStyle = 'rgba(255,255,255,.7)'; v.ctx.lineWidth = 1.5; v.ctx.stroke(); v.ctx.restore(); v.label('their line', oppLine, 3, 0, { size: 10 }); }
      if (runner && best) v.arrow(runner.p.x, runner.p.y, best.x, best.y, '#fff', 2.5);
    });
    const atk = $('advAtk').querySelector('.adv-text');
    if (!SH.surf) atk.querySelector('b').textContent = best ? `Attack down the ${lane(best.y)}` : 'Waiting for data';
    if (!SH.surf) atk.querySelector('span').textContent = best ? `${Math.round(best.v)} m from the nearest opponent` + (runner ? ` · ${nameOf(runner.p.role)} runs into it` : '') +
      (oppLine ? ` · their line ${Math.round(L - oppLine)} m from their goal` : '') : '';
    // ---------- defence: where the opponent is and we are not
    const danger = []; let worst = null;
    for (let x = 0; x < 55; x += cell) for (let y = 0; y < W; y += cell) {
      const mx = x + cell / 2, my = y + cell / 2; let s = 0;
      for (const ps of samples) {
        let dh = 1e9; for (const p of ps) if (p.team === 'H' && p.role !== 'GK') dh = Math.min(dh, Math.hypot(p.x - mx, p.y - my));
        let dens = 0; for (const p of ps) if (p.team === 'A') dens += Math.exp(-(((p.x - mx) ** 2 + (p.y - my) ** 2) / (2 * 49)));
        s += dens * Math.min(1, dh / 10);
      }
      const v = s / Math.max(1, samples.length); danger.push([x, y, v]);
      if (mx > 8 && mx < 50 && (!worst || v > worst.v)) worst = { x: mx, y: my, v };
    }
    const dmax = Math.max(1e-6, ...danger.map((d) => d[2]));
    // our defensive line is measured while THEY have the ball (in possession the whole team pushes up)
    const defending = samples.filter((ps) => ps.poss === 'A');
    const ourLines = (defending.length >= 5 ? defending : samples).map((ps) => { const xs = ps.filter((p) => p.team === 'H' && p.role !== 'GK').map((p) => p.x).sort((a, b) => a - b); return xs.length >= 4 ? xs.slice(0, 4).reduce((a, b) => a + b) / 4 : null; }).filter((v) => v != null);
    const ourLine = ourLines.length ? ourLines.reduce((a, b) => a + b) / ourLines.length : null;
    let mover = null; if (worst) for (const p of st.players) if (p.team === 'H' && p.role !== 'GK') { const d = Math.hypot(p.x - worst.x, p.y - worst.y); if (!mover || d < mover.d) mover = { p, d }; }
    const fat = latestStamina(f), tiredCB = ['LCB', 'RCB', 'CB'].filter((r) => fat['H:' + r] && fat['H:' + r].level === 'red' && fat['H:' + r].half === meta.half);
    const ref = (meta.shape_ref['H_half' + meta.half] || {}).line_height_m;
    const dropTo = tiredCB.length && ref && ourLine && ourLine > ref - 2 ? Math.min(ourLine - 4, ref) : null;
    if (draw) drawAdvice(advD, danger.map(([x, y, v]) => [x, y, v / dmax * 15]), worst, '#F87171', st, (v) => {
      if (ourLine) { v.path([[ourLine, 0], [ourLine, W]]); v.ctx.save(); v.ctx.setLineDash([6, 6]); v.ctx.strokeStyle = 'rgba(255,255,255,.7)'; v.ctx.lineWidth = 1.5; v.ctx.stroke(); v.ctx.restore(); v.label('our line', ourLine, 3, 0, { size: 10 }); }
      if (dropTo) { v.path([[dropTo, 0], [dropTo, W]]); v.ctx.save(); v.ctx.setLineDash([2, 5]); v.ctx.strokeStyle = COL.shadow; v.ctx.lineWidth = 2; v.ctx.stroke(); v.ctx.restore(); v.arrow(ourLine, W - 6, dropTo + 0.5, W - 6, COL.shadow, 2); }
      if (mover && worst && mover.d > 4) { const k = (mover.d - 3) / mover.d; v.arrow(mover.p.x, mover.p.y, mover.p.x + (worst.x - mover.p.x) * k, mover.p.y + (worst.y - mover.p.y) * k, '#fff', 2.5); }
    });
    S.adv = { atkLane: best ? lane(best.y) : null, atkFree: best ? best.v : null, runner: runner ? runner.p.role : null,
              defLane: worst ? lane(worst.y) : null, mover: mover ? mover.p.role : null, dropTo, ourLine, tiredCB };
    simulate(samples, st);
    const def = $('advDef').querySelector('.adv-text');
    if (SH.surf) return;
    def.querySelector('b').textContent = worst ? `Close the ${lane(worst.y)}` : 'Waiting for data';
    def.querySelector('span').textContent = (mover ? `${nameOf(mover.p.role)} shifts ${Math.max(0, Math.round(mover.d - 3))} m` : '') +
      (dropTo ? ` · drop the line ${Math.round(ourLine - dropTo)} m (${tiredCB.join(' + ')} tiring)` : ourLine ? ` · our line ${Math.round(ourLine)} m` : '');
  }
  // ---------------------------------------------------------------- Plan B simulations
  // Share of our defensive third that the opponent reaches first (nearest player), averaged over
  // the last 30 s, with our players where they were vs moved as the option says.
  const G = () => window.SB_DECIDE.GROUP;
  function theirControl(samples, move) {
    let theirs = 0, all = 0;
    for (let k = 0; k < samples.length; k += 2) {
      const ps = samples[k].map((p) => (p.team === 'H' && move ? move(p, samples[k]) : p));
      for (let x = 1.5; x < L / 3; x += 3) for (let y = 1.5; y < W; y += 3) {
        let dh = 1e9, da = 1e9;
        for (const p of ps) { const d = (p.x - x) ** 2 + (p.y - y) ** 2; if (p.team === 'H') dh = Math.min(dh, d); else da = Math.min(da, d); }
        if (da < 1e8 && dh < 1e8) { all++; if (da < dh) theirs++; }
      }
    }
    return all ? theirs / all : 0;
  }
  const dropMove = (by) => (p) => (p.role === 'GK' ? p : Object.assign({}, p, { x: Math.max(1, p.x - by) }));
  function backFiveMove(sideLane) {
    // the midfielder nearest the gap drops between that side's full-back and centre-back
    return (p, ps) => {
      const defs = ps.filter((q) => q.team === 'H' && G()[q.role] === 'DEF');
      const mids = ps.filter((q) => q.team === 'H' && G()[q.role] === 'MID');
      if (!defs.length || !mids.length) return p;
      const lineX = defs.reduce((s, q) => s + q.x, 0) / defs.length;
      const gapY = sideLane === 'left' ? W * 0.27 : sideLane === 'right' ? W * 0.73 : W / 2;
      const drop = mids.reduce((b, q) => (Math.hypot(q.x - lineX, q.y - gapY) < Math.hypot(b.x - lineX, b.y - gapY) ? q : b));
      return p.k === drop.k ? Object.assign({}, p, { x: lineX, y: gapY }) : p;
    };
  }
  function simulate(all, st) {
    // judged on the moments the opponent had the ball (when the defensive shape matters)
    const defending = all.filter((ps) => ps.poss === 'A'), samples = defending.length >= 4 ? defending : all;
    const sim = {}, base = theirControl(samples, null);
    if (S.adv.dropTo) {
      const by = Math.round(S.adv.ourLine - S.adv.dropTo);
      sim.drop = { by, effect: { metric: 'their control of our third', before: base, after: theirControl(samples, dropMove(by)) }, move: dropMove(by) };
    }
    const cnt = channelCounts(videoFrame(S.t), 15).A, tot = cnt.reduce((a, b) => a + b, 0);
    const laneTop = tot ? LANES[cnt.indexOf(Math.max(...cnt))] : (S.adv.defLane || 'middle');
    const mv = backFiveMove(laneTop);
    sim.backFive = { side: laneTop, effect: { metric: 'their control of our third', before: base, after: theirControl(samples, mv) }, move: mv };
    sim.oppLane = tot ? laneTop : null; sim.oppShare = tot ? Math.max(...cnt) / tot : 0;
    sim.base = base; sim.samples = samples;
    S.sim = sim;
  }

  function drawAdvice(v, cells, best, color, st, extra) {
    const g = v.ctx; v.begin();
    for (const [x, y, val] of cells) { const a = Math.min(1, val / 15); if (a < 0.08) continue; v.rect(x, y, x + 5, y + 5); g.fillStyle = hexA(color, 0.5 * a * a); g.fill(); }
    if (best) { const [a, b] = v.S(best.x - 6, best.y - 6), [c, d] = v.S(best.x + 6, best.y + 6); roundRect(g, Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b), 8); g.strokeStyle = color; g.lineWidth = 2.5; g.stroke(); }
    for (const p of st.players) { const [a, b] = v.S(p.x, p.y); g.beginPath(); g.arc(a, b, 4.5, 0, 7); g.fillStyle = p.team === 'H' ? lineup.kitH : lineup.kitA; g.globalAlpha = 0.9; g.fill(); g.globalAlpha = 1; g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 1; g.stroke(); }
    extra(v);
  }

  // ================================================================== side panels
  function fatigueMap(f, v = fatigueV, noteEl = $('fatigueNote')) {
    if (!v) return; const g = v.ctx; v.begin();
    const fat = latestStamina(f); let red = 0;
    for (const [role, [depth, width]] of Object.entries(meta.role_means.H)) {
      const x = 52 + depth * 2.2, y = Math.max(4, Math.min(W - 4, W / 2 + (width - W / 2) * 1.5)), s = fat['H:' + role], lvl = s && s.half === meta.half ? s.level : 'no data';
      if (lvl === 'red') red++;
      const [a, b] = v.S(x, y), r = 11;
      g.beginPath(); g.arc(a, b, r + 5, 0, 7); g.fillStyle = hexA(LEVEL[lvl], lvl === 'no data' ? 0 : 0.25); g.fill();
      g.beginPath(); g.arc(a, b, r, 0, 7); g.fillStyle = LEVEL[lvl]; g.fill();
      g.fillStyle = '#0A0B0D'; g.font = `700 10px ${CSS.getPropertyValue('--mono')}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(s && s.risk != null && s.half === meta.half ? String(s.risk) : '–', a, b + 0.5);
      v.label(nameOf(role), x, y, r + 9, { size: 9.5 });
    }
    if (noteEl) noteEl.textContent = red ? `${red} positions in the red` : 'last 5-min block';
  }

  function feedThumb(canvas, frame, ev) {
    const i = Math.round(((ev.kind === 'shadow' ? ev.m[1] : frame) - meta.first) / (meta.fps / meta.sample_fps));
    const v = new PitchView(canvas, { m: 1 }); v.layout(84); v.begin();
    const g = v.ctx;
    if (i >= 0 && i < nFrames) for (const p of framePlayers(i)) { const [a, b] = v.S(p.x, p.y); g.beginPath(); g.arc(a, b, 2.2, 0, 7); g.fillStyle = p.team === 'H' ? lineup.kitH : lineup.kitA; g.fill(); }
    if (ev.kind === 'fatigue' && ev.team === 'H') { const m = meta.role_means.H[ev.label]; if (m) { const [a, b] = v.S(52 + m[0] * 2.2, W / 2 + (m[1] - W / 2) * 1.5); g.beginPath(); g.arc(a, b, 6, 0, 7); g.strokeStyle = COL.bad; g.lineWidth = 2; g.stroke(); } }
    if (ev.kind === 'shadow') for (const [, , x, y, sx, sy] of ev.m[4]) {
      const [a, b] = v.S(...tf(x, y)), [c, d] = v.S(...tf(sx, sy));
      g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.strokeStyle = ev.m[5] === 'rest' ? COL.warn : COL.shadow; g.lineWidth = 2; g.stroke();
      g.beginPath(); g.arc(c, d, 2.6, 0, 7); g.fillStyle = '#E9E2FF'; g.fill();
    }
    if (ev.free) { const [fx, fy] = tf(ev.free[0], ev.free[1]); const [a, b] = v.S(fx, fy); g.beginPath(); g.arc(a, b, 7, 0, 7); g.strokeStyle = '#fff'; g.setLineDash([2, 2]); g.lineWidth = 1.2; g.stroke(); g.setLineDash([]); }
  }
  const ZONE = { 'defensive third': 'our third', 'middle third': 'midfield', 'final third': 'the final third' };
  function eventView(e) {
    const opp = (lineup.oppName || meta.teams.A).split(' ')[0];
    if (e.kind === 'shadow') {
      const mv = momentMoves(e.m)[0], rest = e.m[5] === 'rest';
      if (e.team === 'H') return rest
        ? { title: `Lost the ball, thin cover${mv ? `: ${nameOf(mv.role)} ${moveText(mv)}` : ''} · rest ${pctM(e.m[3])}`, dot: COL.warn }
        : { title: `Shadow Replay: ${mv ? `${nameOf(mv.role)} ${moveText(mv)}` : 'space lost'} · denied ${pctM(e.m[3])}`, dot: COL.shadow };
      return { title: rest ? `${opp} lost the ball with thin cover${mv ? ` (${mv.role})` : ''}: counter there` : `${opp} left space before our attack${mv ? ` (${mv.role})` : ''}`, dot: COL.ok };
    }
    if (e.kind === 'goal') { const sc = score(e.frame); return { title: `GOAL ${e.team === 'H' ? meta.teams.H : opp} · ${sc.H}–${sc.A}`, dot: e.team === 'H' ? lineup.kitH : lineup.kitA }; }
    if (e.kind === 'fatigue') return e.team === 'H'
      ? { title: `${nameOf(e.label)} tiring · ${e.risk}`, dot: COL.bad }
      : { title: `${opp}: ${e.label} fading · ${e.risk}`, dot: COL.ok };
    if (e.kind === 'shape') {
      const m = e.messages[0], deep = m.match(/(\d+) m deeper/), loose = m.match(/(\d+)% less compact/);
      const what = deep ? `line ${deep[1]} m deeper` : loose ? `block ${loose[1]}% looser` : m;
      return e.team === 'H' ? { title: `Us: ${what}`, dot: COL.warn } : { title: `${opp}: ${what}`, dot: COL.shadow };
    }
    return e.team === 'H' ? { title: `Ball won in ${ZONE[e.zone]}`, dot: COL.shadow } : { title: `${opp} counter-attack`, dot: COL.bad };
  }
  function feed(f) {
    if (narrow()) return;
    const all = C.events.filter((e) => e.frame <= f), evs = all.slice(-8).reverse();
    const k = evs.map((e) => e.frame + e.kind + (e.label || '')).join('|');
    if (k === S.feedKey) return; S.feedKey = k;
    $('feedCount').textContent = all.length ? String(all.length) : '';
    if (!evs.length) { $('feed').innerHTML = '<p class="empty">Insights appear once there is enough data.</p>'; return; }
    $('feed').innerHTML = evs.map((e) => {
      const id = e.frame + e.kind + (e.label || ''), fresh = !S.seen.has(id); S.seen.add(id);
      const vw = eventView(e);
      return `<button type="button" class="ev${fresh ? ' new' : ''}" data-frame="${e.frame}"><canvas></canvas>
        <span class="t"><b>${esc(vw.title)}</b><span><i class="dot" style="background:${vw.dot}"></i>${clockText(e.frame)}</span></span></button>`;
    }).join('');
    $('feed').querySelectorAll('.ev').forEach((el, i) => {
      feedThumb(el.querySelector('canvas'), evs[i].frame, evs[i]);
      el.onclick = () => {
        if (evs[i].kind === 'shadow') { openReplay(evs[i].m); return; }
        const t = (+el.dataset.frame - meta.first) / meta.fps - 3; if (t >= 0 && t <= duration) { takeOver(); S.t = t; }
      };
    });
  }

  function strip(f) {
    const nowMin = (f - meta.half_start) / meta.fps / 60;
    const h1 = C.timeline.filter((m) => m[0] === 1).length, total = h1 + 50, w = (100 / total).toFixed(3);
    const cur = C.timeline.filter((m, i) => m[0] < meta.half || (i - h1) <= nowMin);
    const col = { H: lineup.kitH, A: lineup.kitA, D: COL.D, X: COL.D };
    $('strip').innerHTML = cur.map((m) => `<i style="width:${w}%;background:${col[m[1]]}"></i>`).join('');
  }

  function median(a) { const b = a.filter((v) => v != null).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; }
  function stats(f, si) {
    if (narrow()) return;
    const tr = C.transitions.filter((t) => t.frame <= f && t.won_by === 'A');
    const cp = (h) => { const x = tr.filter((t) => t.half === h); return x.length ? { reg: x.filter((t) => t.regained).length / x.length, pr: x.reduce((s, t) => s + t.pressers, 0) / x.length } : null; };
    const now = cp(meta.half), before = meta.half === 2 ? cp(1) : null;
    const shp = C.seconds.shape.H.slice(Math.max(0, si - 60), si + 1).filter((r) => r[4] === 'o');
    const line = median(shp.map((r) => r[0])), ref = (meta.shape_ref.H_half1 || {}).line_height_m;
    const cell = (k, v, d, warn) => `<div class="stat"><span class="k">${k}</span><span class="v${warn ? ' warn' : ''}">${v}<span class="d">${d || ''}</span></span></div>`;
    $('stats').innerHTML = [
      cell('Pressing', now ? fmt1(now.pr) : '–', before ? `H1 ${fmt1(before.pr)}` : '', before && now && now.pr < before.pr),
      cell('Regain ≤5 s', now ? Math.round(now.reg * 100) + '%' : '–', before ? `H1 ${Math.round(before.reg * 100)}%` : '', before && now && now.reg < before.reg),
      cell('Line height', line != null ? Math.round(line) + ' m' : '–', ref ? `H1 ${Math.round(ref)}` : '', ref && line != null && line - ref > 3),
      (() => { const r = shRecent(f, 60), u = SH.usual.H; return cell('Space denied', r && r.avg != null ? pctM(r.avg) : '–', u ? `usual ${pctM(u)}` : 'last 60 s', r && u && r.avg != null && r.avg < u - 50); })(),
    ].join('');
  }

  // ---------------------------------------------------------------- squad list + player detail
  let heatCache = '';
  function squad(st, f, si, force) {
    const fat = latestStamina(f), speed = {};
    for (const p of st.players) speed[p.k] = p.v * 3.6;
    const rows = Object.entries(C.seconds.movement).filter(([k]) => inClip.has(k) && k.startsWith(S.team + ':'))
      .map(([k, arr]) => ({ k, role: k.split(':')[1], v: arr[si] })).sort((a, b) => b.v[0] - a.v[0]);
    if (S.sel && !S.sel.startsWith(S.team + ':')) S.sel = null;
    const max = Math.max(1, ...rows.map((r) => r.v[0]));
    $('plist').innerHTML = rows.map((r) => {
      const pl = S.team === 'H' ? roleToPlayer[r.role] : oppToPlayer[r.role], s = fat[r.k], lvl = s && s.half === meta.half ? s.level : 'no data';
      const kmh = speed[r.k];
      return `<button type="button" class="prow${S.sel === r.k ? ' sel' : ''}" data-k="${r.k}" style="--kit:var(--${S.team === 'H' ? 'home' : 'away'})">
        ${avatar(pl, S.team, r.role)}
        <span class="who"><b>${esc(pl ? pl.name : r.role)}</b><span>${r.role}${pl && pl.slot && pl.slot !== r.role ? ' · ' + pl.slot : ''}</span></span>
        <span class="dist">${fmt1(r.v[0] / 1000)} km<i style="--w:${(r.v[0] / max * 100).toFixed(1)}%"></i></span>
        <span class="spd${kmh > 19.8 ? ' hot' : ''}">${kmh == null ? '–' : Math.round(kmh)}<small> km/h</small></span>
        <span class="spr">${r.v[2]}×</span>
        <span class="risk" style="background:${LEVEL[lvl]}" title="Fatigue risk ${s && s.risk != null ? s.risk : '–'}"></span></button>`;
    }).join('');
    $('plist').querySelectorAll('.prow').forEach((el) => el.onclick = () => { S.sel = S.sel === el.dataset.k ? null : el.dataset.k; panels(true); });
    detail(rows, fat, si, force);
  }
  function detail(rows, fat, si, force) {
    const k = S.sel || (rows[0] && rows[0].k); if (!k) return;
    const role = k.split(':')[1], team = k[0], arr = C.seconds.movement[k]; if (!arr) return;
    const v = arr[si], pl = team === 'H' ? roleToPlayer[role] : oppToPlayer[role], s = fat[k];
    $('pdStats').innerHTML = `<div class="pd-name"><b>${esc(pl ? pl.name : role)}</b><span>${role} · ${team === 'H' ? meta.teams.H : (lineup.oppName || meta.teams.A)}</span></div>
      <div><b>${fmt1(v[0] / 1000)}</b><span>km since kick-off</span></div><div><b>${fmt1(v[3])}</b><span>top km/h</span></div>
      <div><b>${v[2]}</b><span>sprints</span></div><div><b style="color:${s ? LEVEL[s.level] : 'inherit'}">${s && s.risk != null ? s.risk : '–'}</b><span>fatigue risk</span></div>`;
    const bucket = k + Math.floor(S.t / 3);
    if (bucket === heatCache && !force) return; heatCache = bucket;
    // heatmap of this position in the clip so far
    const gx = 21, gy = 14, grid = new Float32Array(gx * gy), idx = Math.floor(S.t * meta.sample_fps);
    for (let i = 0; i <= idx; i += 2) for (const p of framePlayers(i)) if (p.k === k) {
      const cx = Math.min(gx - 1, Math.max(0, Math.floor(p.x / L * gx))), cy = Math.min(gy - 1, Math.max(0, Math.floor(p.y / W * gy))); grid[cy * gx + cx]++;
    }
    const m = Math.max(1, ...grid), hv = heatV, g = hv.ctx; hv.begin();
    for (let cy = 0; cy < gy; cy++) for (let cx = 0; cx < gx; cx++) {
      const a = grid[cy * gx + cx] / m; if (a < 0.03) continue;
      const x0 = cx * L / gx, y0 = cy * W / gy;
      hv.rect(x0, y0, x0 + L / gx + 0.05, y0 + W / gy + 0.05); g.fillStyle = hexA(COL.shadow, 0.15 + 0.7 * Math.sqrt(a)); g.fill();
    }
  }

  // ================================================================== what the bench needs to know
  // Momentum: per match minute, share of live time the ball spends in the opponent's final third
  // (up, our colour) and in ours (down, theirs). Territory says more than possession alone.
  function momentumChart(f, c = $('momentum'), h = 46) {
    const w = c.clientWidth, d = window.devicePixelRatio || 1;
    if (!w) return;
    c.width = w * d; c.height = h * d; const g = c.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, w, h);
    const h1 = C.momentum.filter((m) => m[0] === 1).length, total = h1 + 50, bw = w / total;
    const nowMin = (f - meta.half_start) / meta.fps / 60, mid = h / 2;
    g.fillStyle = '#1E2229'; g.fillRect(0, mid - 0.5, w, 1);
    C.momentum.forEach((m, i) => {
      if (m[0] === meta.half && i - (meta.half === 2 ? h1 : 0) > nowMin) return;
      const x = i * bw;
      g.fillStyle = lineup.kitH; g.fillRect(x + 0.5, mid - m[2] * (mid - 2), Math.max(1, bw - 1.5), m[2] * (mid - 2));
      g.fillStyle = lineup.kitA; g.fillRect(x + 0.5, mid + 1, Math.max(1, bw - 1.5), m[3] * (mid - 2));
    });
    g.fillStyle = '#5B626C'; g.fillRect(h1 * bw, 2, 1, h - 4);
    const nx = ((meta.half === 2 ? h1 : 0) + nowMin) * bw; g.fillStyle = '#F1F3F6'; g.fillRect(nx, 0, 1.5, h);
  }

  const laneIdx = (y) => (y < W / 3 ? 0 : y < 2 * W / 3 ? 1 : 2);
  const LANES = ['left', 'middle', 'right'];
  function channelCounts(f, minutes) {
    const out = { H: [0, 0, 0], A: [0, 0, 0] };
    for (const [fr, team, y] of C.entries) if (fr <= f && fr > f - minutes * 60 * meta.fps) out[team][laneIdx(y)]++;
    return out;
  }
  // the opponent who spends most time near our goal and runs the most, last 10 min
  function keyOpponent(st, si) {
    const stats = {};
    for (let i = Math.max(0, st.idx - 3000); i <= st.idx; i += 10) for (const p of framePlayers(i)) {
      if (p.team !== 'A' || p.role === 'GK') continue;
      const s = stats[p.role] || (stats[p.role] = { n: 0, deep: 0 }); s.n++; if (p.x < L / 3) s.deep++;
    }
    let best = null;
    for (const [role, s] of Object.entries(stats)) {
      const arr = C.seconds.movement['A:' + role]; if (!arr || s.n < 20) continue;
      const spr = arr[si][2] - arr[Math.max(0, si - 600)][2], frac = s.deep / s.n, score = frac * 100 + spr * 6;
      if (!best || score > best.score) best = { role, frac, spr, score };
    }
    return best;
  }
  function channels(f, st, v = channelsV, note = $('watch')) {
    if (!v) return; const g = v.ctx; v.begin();
    const cnt = channelCounts(f, 15), ys = [W / 6, W / 2, 5 * W / 6];
    const draw = (team, x0, x1, color) => cnt[team].forEach((n, k) => {
      if (!n) { v.path([[x0, ys[k]], [x1, ys[k]]]); g.save(); g.setLineDash([2, 5]); g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 1; g.stroke(); g.restore(); return; }
      v.arrow(x0, ys[k], x1, ys[k], color, Math.min(10, 2 + n * 1.3));
      v.label(String(n), x0, ys[k], 0, { size: 11, mono: true });
    });
    draw('H', 58, 92, lineup.kitH); draw('A', 47, 13, lineup.kitA);
    const ko = keyOpponent(st, Math.max(0, Math.floor(S.t)));
    const opp = (lineup.oppName || meta.teams.A).split(' ')[0];
    note.innerHTML = `Arrows = entries into the final third (right: us, left: ${esc(opp)}).` +
      (ko && ko.score > 30 ? ` Watch <b>${esc(opp)} ${ko.role}</b>: ${Math.round(ko.frac * 100)}% of his time near our goal, ${ko.spr} sprints in the last 10 min.` : '');
    S.keyOpp = ko;
  }

  // The three things to know right now, ranked. Each comes from a module above.
  function priorities(f, st, si) {
    const items = [], opp = (lineup.oppName || meta.teams.A).split(' ')[0];
    const fat = latestStamina(f);
    const red = Object.values(fat).filter((r) => r.team === 'H' && r.half === meta.half && r.level === 'red').sort((a, b) => b.risk - a.risk);
    const bestSub = S.subsShown && red.length && S.subsShown.for_role === red[0].label ? S.subsShown.candidates[0] : null;
    if (red.length) items.push({ score: 90 + red[0].risk / 10, color: COL.bad, title: `Prepare a substitution: ${nameOf(red[0].label)}${bestSub ? ' → ' + bestSub.name : ''}`,
      sub: `Fatigue risk ${red[0].risk} · high-speed running at ${Math.round(red[0].hsr * 100)}% of his start` + (red.length > 1 ? ` · also ${red.slice(1).map((r) => nameOf(r.label)).join(', ')}` : '') });
    const dangerA = C.transitions.filter((t) => t.won_by === 'A' && t.dangerous && t.frame <= f && t.frame > f - 10 * 60 * meta.fps).length;
    if (dangerA >= 2) items.push({ score: 80 + dangerA, color: COL.bad, title: `Beware the ${opp} counter`, sub: `${dangerA} dangerous transitions in 10 min` });
    const cnt = channelCounts(f, 15).A, tot = cnt.reduce((a, b) => a + b, 0), top = cnt.indexOf(Math.max(...cnt));
    const second = [...cnt].sort((a, b) => b - a)[1];
    if (tot >= 3 && cnt[top] / tot >= 0.5 && cnt[top] > second) items.push({ score: 70 + cnt[top], color: COL.warn, title: `${opp} getting through our ${LANES[top]}`, sub: `${cnt[top]} of ${tot} attacks in the last 15 min` });
    const h1n = C.momentum.filter((m) => m[0] === 1).length;
    const nowI = Math.min(C.momentum.length - 1, (meta.half === 2 ? h1n : 0) + Math.floor((f - meta.half_start) / meta.fps / 60));
    const recent = C.momentum.slice(Math.max(0, nowI - 4), nowI + 1);
    if (recent.length) {
      const att = recent.reduce((s, m) => s + m[2], 0) / recent.length, def = recent.reduce((s, m) => s + m[3], 0) / recent.length;
      if (def > att + 0.1) items.push({ score: 62, color: COL.warn, title: `${opp} are pressing`, sub: `Ball ${Math.round(def * 100)}% of the time in our third, last 5 min` });
      else if (att > def + 0.15) items.push({ score: 35, color: COL.ok, title: 'Momentum is ours', sub: `Ball ${Math.round(att * 100)}% of the time in the ${opp} third, last 5 min` });
    }
    // the core: space we leave while they have the ball, and the last Shadow Replay
    const den = shRecent(f, 120), u = SH.usual.H, ur = SH.usualRest.H;
    if (den && u && den.avg != null && den.avg < u - 50) items.push({ score: 67, color: COL.warn, title: 'We are leaving dangerous space',
      sub: `Space denied ${pctM(den.avg)} in the last 2 min (usual ${pctM(u)})` + (den.who ? ` · most often ${nameOf(den.who)}` : '') });
    if (den && ur && den.rest != null && den.rest < ur - 60) items.push({ score: 69, color: COL.warn,
      title: den.cover ? `Thin rest defence: keep ${nameOf(den.cover)} back` : 'Thin rest defence when we attack',
      sub: `If we lose the ball: we own ${pctM(den.rest)} of our dangerous space, last 2 min (usual ${pctM(ur)})` });
    const lk = (S.leaks || []).filter((r) => r.flag).sort((a, b) => b.ratio - a.ratio)[0];
    if (lk) {
      const tired = lk.level === 'red' || lk.level === 'amber';
      items.push({ score: tired ? 86 : 70, color: COL.bad, title: tired ? `Sub candidate: ${nameOf(lk.role)} is leaking space` : `${nameOf(lk.role)} is leaking space`,
        sub: `${lk.ratio.toFixed(1)}× the dangerous space he left early in the half (last 10 min)` + (lk.risk != null ? ` · fatigue ${lk.risk}` : '') });
    }
    const pr = S.pressing;
    if (pr && pr.worst && pr.worst !== pr.best && (pr.worst.regP < pr.worst.regH - 0.04 || pr.worst.boxP > pr.worst.boxH + 0.02))
      items.push({ score: 52, color: COL.warn, title: `Hold, don't press, in ${P_BAND.H[pr.worst.band]}`, sub: `Pressing there won it back ${pctR(pr.worst.regP)} vs ${pctR(pr.worst.regH)} holding` });
    else if (pr && pr.best && pr.best.regP > pr.best.regH + 0.04)
      items.push({ score: 48, color: COL.ok, title: `Press in ${P_BAND.H[pr.best.band]}`, sub: `Won back ${pctR(pr.best.regP)} within 5 s vs ${pctR(pr.best.regH)} holding` });
    const lastRep = SH.moments.filter((m) => m[2] === 'H' && m[0] <= f && m[0] > f - 90 * meta.fps).pop();
    const repMv = lastRep && momentMoves(lastRep)[0];
    if (repMv) {
      const rest = lastRep[5] === 'rest';
      items.push({ score: 72, color: rest ? COL.warn : COL.shadow,
        title: rest ? `Lost the ball, then their attack: ${nameOf(repMv.role)} should cover ${moveText(repMv)}` : `Before their last attack: ${nameOf(repMv.role)} ${moveText(repMv)}`,
        sub: `${rest ? 'Rest defence' : 'Space denied'} ${pctM(lastRep[3])} (usual ${pctM(rest ? ur : u)}) · +${fmt1(repMv.gap / 10)}% back from that move · Shadow Replay` });
    }
    if (S.adv && S.adv.dropTo) items.push({ score: 64, color: COL.shadow, title: `Drop the line ${Math.round(S.adv.ourLine - S.adv.dropTo)} m`, sub: `${S.adv.tiredCB.join(' + ')} tiring, space behind the line` });
    if (S.keyOpp && S.keyOpp.score > 45) items.push({ score: 55, color: COL.warn, title: `Watch the ${opp} ${S.keyOpp.role}`, sub: `${Math.round(S.keyOpp.frac * 100)}% of his time near our goal · ${S.keyOpp.spr} sprints` });
    if (S.adv && S.adv.atkLane) items.push({ score: 50, color: COL.shadow, title: `Chance: attack down the ${S.adv.atkLane}`, sub: `${Math.round(S.adv.atkFree)} m of space` + (S.adv.runner ? ` · ${nameOf(S.adv.runner)} runs into it` : '') });
    const sp = C.setpieces.filter((r) => r[1] === 'A' && r[0] <= f && r[0] > f - 15 * 60 * meta.fps && ['corner', 'freekick_final'].includes(r[2]));
    if (sp.length >= 3) items.push({ score: 58 + sp.length, color: COL.warn, title: `${opp} keep winning set pieces near our box`, sub: `${sp.length} corners / free kicks in the last 15 min: set the marking` });
    const bad = (S.duels || []).filter((d) => d.danger >= 0.35).sort((a, b) => b.danger - a.danger)[0];
    if (bad) items.push({ score: 68 + bad.danger * 10, color: COL.bad, title: `Losing duel: ${nameOf(bad.def)} vs ${opp} ${bad.att}`,
      sub: `Opponent goal-side of him ${Math.round(bad.behind * 100)}% of the time` + (bad.races >= 5 ? ` · races lost ${bad.lost}/${bad.races}` : '') });
    const top3 = items.sort((a, b) => b.score - a.score).slice(0, 3);
    S.top3 = top3;
    const html = top3.length ? top3.map((it) => `<div class="pi"><i style="background:${it.color}"></i><div><b>${esc(it.title)}</b><span>${esc(it.sub)}</span></div></div>`).join('')
      : '<p class="empty">Nothing urgent yet.</p>';
    if ($('prio').innerHTML !== html) $('prio').innerHTML = html;
    if ($('prioPhone').innerHTML !== html) $('prioPhone').innerHTML = html;
  }

  // ================================================================== set pieces
  const SP_NAMES = { corner: 'Corners', freekick_final: 'Free kicks, final third', freekick: 'Other free kicks', throw: 'Throw-ins', goalkick: 'Goal kicks' };
  function setPieceSummary(f) {
    const rows = C.setpieces.filter((r) => r[0] <= f), out = { H: {}, A: {}, keepH: [0, 0], keepA: [0, 0], boxH: 0, boxA: 0 };
    for (const [, team, kind, , , kept, box] of rows) {
      out[team][kind] = (out[team][kind] || 0) + 1;
      if (kind === 'corner' || kind === 'freekick_final') { out['keep' + team][1]++; if (kept) out['keep' + team][0]++; if (box) out['box' + team]++; }
    }
    return { rows, out };
  }
  function setPieces(f, v = spV, el = $('spTable')) {
    if (!v) return; const g = v.ctx; v.begin();
    const { rows, out } = setPieceSummary(f);
    for (const [, team, kind, x, y, kept, box] of rows) {
      if (kind === 'goalkick' || kind === 'kickoff') continue;
      const [a, b] = v.S(x, y), col = team === 'H' ? lineup.kitH : lineup.kitA, r = kind === 'throw' ? 3 : 5.5;
      g.beginPath();
      if (kind === 'corner') { g.moveTo(a, b - 7); g.lineTo(a + 6.5, b + 5); g.lineTo(a - 6.5, b + 5); g.closePath(); }
      else if (kind === 'throw') g.rect(a - r, b - r, 2 * r, 2 * r);
      else g.arc(a, b, r, 0, 7);
      g.fillStyle = hexA(col, kind === 'freekick' ? 0.55 : 0.95); g.fill();
      if (box) { g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke(); }
    }
    const opp = (lineup.oppName || meta.teams.A).split(' ')[0];
    const line = (k) => `<tr><td>${SP_NAMES[k]}</td><td>${out.H[k] || 0}</td><td>${out.A[k] || 0}</td></tr>`;
    const pct = (k) => (k[1] ? Math.round(k[0] / k[1] * 100) + '%' : '–');
    el.innerHTML = `<table class="mini"><thead><tr><th></th><th>${esc(meta.teams.H)}</th><th>${esc(opp)}</th></tr></thead><tbody>
      ${['corner', 'freekick_final', 'freekick', 'throw'].map(line).join('')}
      <tr><td>Ball kept after 10 s (corners + final-third FKs)</td><td>${pct(out.keepH)}</td><td>${pct(out.keepA)}</td></tr>
      <tr><td>Ball reached the box</td><td>${out.boxH}</td><td>${out.boxA}</td></tr></tbody></table>`;
    return out;
  }

  // ================================================================== 1v1 duels (last 10 min)
  // For each of our defenders: the opponent he is closest to most often in our half; how often
  // that opponent is goal-side of him, and who wins the races when both run above 19.8 km/h.
  const DEF_ROLES = ['LB', 'LCB', 'CB', 'RCB', 'RB', 'LWB', 'RWB'];
  function computeDuels(st) {
    const pairs = {};
    for (let i = Math.max(0, st.idx - 3000); i <= st.idx; i += 5) {
      const fr = C.frames[i]; if (!fr[2] || fr[1] === 'D') continue;
      const [bx] = tf(fr[2][0], fr[2][1]); if (bx > 60) continue;
      const ps = framePlayers(i), opps = ps.filter((p) => p.team === 'A' && p.role !== 'GK');
      for (const d of ps) {
        if (d.team !== 'H' || !DEF_ROLES.includes(d.role)) continue;
        let best = null; for (const o of opps) { const dist = Math.hypot(o.x - d.x, o.y - d.y); if (dist < 15 && (!best || dist < best.dist)) best = { o, dist }; }
        if (!best) continue;
        const k = d.role + '|' + best.o.role, s = pairs[k] || (pairs[k] = { def: d.role, att: best.o.role, n: 0, dist: 0, behind: 0, races: 0, lost: 0, dx: 0, dy: 0, ax: 0, ay: 0 });
        s.n++; s.dist += best.dist; s.dx += d.x; s.dy += d.y; s.ax += best.o.x; s.ay += best.o.y;
        if (best.o.x < d.x - 1) s.behind++;
        if (d.v > 5.5 && best.o.v > 5.5 && best.dist < 10) { s.races++; if (best.o.v > d.v + 0.5) s.lost++; }
      }
    }
    const byDef = {};
    for (const s of Object.values(pairs)) if (!byDef[s.def] || s.n > byDef[s.def].n) byDef[s.def] = s;
    return Object.values(byDef).filter((s) => s.n >= 20).map((s) => {
      const behind = s.behind / s.n, lostR = s.races >= 5 ? s.lost / s.races : 0;
      return { def: s.def, att: s.att, mins: s.n / 60, dist: s.dist / s.n, behind, races: s.races, lost: s.lost,
               danger: 0.6 * behind + 0.4 * lostR, d: [s.dx / s.n, s.dy / s.n], a: [s.ax / s.n, s.ay / s.n] };
    });
  }
  let duelCache = -1;
  function duels(st, v = duelV, el = $('duelList'), force) {
    if (!v) return;
    const bucket = Math.floor(S.t / 5);
    if (bucket !== duelCache || force) { S.duels = computeDuels(st); duelCache = bucket; }
    v.c.style.display = S.duels.length ? '' : 'none';      // no empty pitch while there is nothing to show
    const g = v.ctx; v.begin();
    const color = (dg) => (dg >= 0.35 ? COL.bad : dg >= 0.2 ? COL.warn : COL.ok);
    for (const dl of S.duels) {
      v.path([dl.d, dl.a]); g.strokeStyle = color(dl.danger); g.lineWidth = 3; g.lineCap = 'round'; g.stroke();
      for (const [[x, y], col] of [[dl.d, lineup.kitH], [dl.a, lineup.kitA]]) { const [a, b] = v.S(x, y); g.beginPath(); g.arc(a, b, 7, 0, 7); g.fillStyle = col; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
      v.label(nameOf(dl.def), dl.d[0], dl.d[1], 15, { size: 10 });
      v.label(dl.att, dl.a[0], dl.a[1], -15, { size: 10, color: '#FFE1D8' });
    }
    const opp = (lineup.oppName || meta.teams.A).split(' ')[0];
    el.innerHTML = S.duels.length ? S.duels.sort((a, b) => b.danger - a.danger).map((dl) => `<div class="duel">
        <i style="background:${color(dl.danger)}"></i><b>${esc(nameOf(dl.def))}</b><span>vs ${dl.att} ${esc(opp)}</span>
        <em>goal-side ${Math.round(dl.behind * 100)}%${dl.races >= 5 ? ` · races lost ${dl.lost}/${dl.races}` : ''}</em></div>`).join('')
      : '<p class="empty">Not enough duels in our half yet: the map appears after about 20 s of 1v1s near our goal.</p>';
  }

  // ================================================================== one-page report
  function reportStats(f) {
    const h1n = C.momentum.filter((m) => m[0] === 1).length, nowI = Math.min(C.momentum.length - 1, (meta.half === 2 ? h1n : 0) + Math.floor((f - meta.half_start) / meta.fps / 60));
    const mm = C.momentum.slice(0, nowI + 1).filter((m) => m[1] != null);
    const avg = (k) => mm.reduce((s, m) => s + m[k], 0) / Math.max(1, mm.length);
    const tr = C.transitions.filter((t) => t.frame <= f);
    const lost = tr.filter((t) => t.won_by === 'A');
    const shp = C.seconds.shape.H.filter((r, i) => i <= Math.floor(S.t) && r[4] === 'o');
    const ent = { H: 0, A: 0 }; for (const [fr, team] of C.entries) if (fr <= f) ent[team]++;
    return {
      poss: avg(1), att: avg(2), def: avg(3),
      regain: lost.length ? lost.filter((t) => t.regained).length / lost.length : null,
      press: lost.length ? lost.reduce((s, t) => s + t.pressers, 0) / lost.length : null,
      dangerH: tr.filter((t) => t.won_by === 'H' && t.dangerous).length, dangerA: tr.filter((t) => t.won_by === 'A' && t.dangerous).length,
      line: median(shp.map((r) => r[0])), lineRef: (meta.shape_ref.H_half1 || {}).line_height_m, ent,
    };
  }
  // ================================================================== match statistics
  const halfOf = (fr) => (fr <= half1End ? 1 : 2);
  function score(f) {
    const s = { H: 0, A: 0 };
    for (const [fr, code, team] of C.match_events) if (code === 'GOALS' && fr <= f) s[team]++;
    return s;
  }
  function matchStats(f) {
    const blank = () => ({ goals: 0, possT: 0, n: 0, chances: 0, counters: 0, danger: 0, entries: 0, box: 0, long: 0,
      wins: 0, lost: 0, regained: 0, corner: 0, fk: 0, throw: 0, gk: 0, km: 0, sprints: 0 });
    const S2 = { 1: { H: blank(), A: blank() }, 2: { H: blank(), A: blank() } };
    for (let i = 0; i < C.runs.length - 1; i++) {
      const [fr, l] = C.runs[i], nx = C.runs[i + 1][0];
      if (l !== 'H' && l !== 'A') continue;
      if (fr > f) break;
      const s = S2[halfOf(fr)][l]; s.possT += Math.min(nx, f + 1) - fr; s.n++;
    }
    const code2 = { GOALS: 'goals', 'CREATING CHANCES': 'chances', 'ATTACKING TRANSITION': 'counters', 'BALL IN THE BOX': 'box', 'LONG BALL': 'long' };
    for (const [fr, code, team] of C.match_events) if (fr <= f && code2[code]) S2[halfOf(fr)][team][code2[code]]++;
    for (const t of C.transitions) if (t.frame <= f) {
      const w = S2[t.half][t.won_by], l = S2[t.half][t.won_by === 'H' ? 'A' : 'H'];
      w.wins++; if (t.dangerous) w.danger++; l.lost++; if (t.regained) l.regained++;
    }
    for (const [fr, team] of C.entries) if (fr <= f) S2[halfOf(fr)][team].entries++;
    const spKey = { corner: 'corner', freekick: 'fk', freekick_final: 'fk', throw: 'throw', goalkick: 'gk' };
    for (const [fr, team, kind] of C.setpieces) if (fr <= f && spKey[kind]) S2[halfOf(fr)][team][spKey[kind]]++;
    for (const [team, h, minute, km, , spr] of C.team_running) if (blockEnd(h, minute) <= f) { S2[h][team].km += km; S2[h][team].sprints += spr; }
    const T = { H: blank(), A: blank() };
    for (const h of [1, 2]) for (const team of ['H', 'A']) for (const k in T[team]) T[team][k] += S2[h][team][k];
    return { 1: S2[1], 2: S2[2], T };
  }
  const STAT_ROWS = [
    ['Goals', (s) => s.goals],
    ['Possession', (s, o) => (s.possT + o.possT ? Math.round(100 * s.possT / (s.possT + o.possT)) + '%' : '–')],
    ['Possessions', (s) => s.n],
    ['Average possession', (s) => (s.n ? Math.round(s.possT / s.n / meta.fps) + ' s' : '–')],
    ['Chances created', (s) => s.chances],
    ['Counter-attacks', (s) => s.counters],
    ['Dangerous transitions', (s) => s.danger],
    ['Final-third entries', (s) => s.entries],
    ['Box entries', (s) => s.box],
    ['Long balls', (s) => s.long],
    ['Ball recoveries', (s) => s.wins],
    ['Counter-press regains ≤5 s', (s) => (s.lost ? Math.round(100 * s.regained / s.lost) + '%' : '–')],
    ['Corners', (s) => s.corner],
    ['Free kicks', (s) => s.fk],
    ['Throw-ins', (s) => s.throw],
    ['Goal kicks', (s) => s.gk],
    ['Team distance', (s) => (s.km ? fmt1(s.km) + ' km' : '–')],
    ['Sprints', (s) => s.sprints || '–'],
  ];
  function statsTable(f) {
    const m = matchStats(f), opp1 = (lineup.oppName || meta.teams.A).split(' ')[0], live = meta.half === 2;
    const head = (t) => `<th>${esc(meta.teams.H)}</th><th>${esc(opp1)}</th>`;
    const cell = (grp, fn, bold) => { const a = fn(grp.H, grp.A), b = fn(grp.A, grp.H); return `<td${bold ? ' class="b"' : ''}>${a}</td><td${bold ? ' class="b"' : ''}>${b}</td>`; };
    return `<table class="mstats"><thead>
      <tr><th></th><th colspan="2">1st half</th><th colspan="2">2nd half${live ? ` (to ${clockText(f)})` : ''}</th><th colspan="2">Total</th></tr>
      <tr><th></th>${head()}${head()}${head()}</tr></thead><tbody>
      ${STAT_ROWS.map(([name, fn]) => `<tr><td>${name}</td>${cell(m[1], fn)}${cell(m[2], fn)}${cell(m.T, fn, true)}</tr>`).join('')}
      </tbody></table>`;
  }

  function openReport() {
    S.playing = false;
    const st = interp(S.t), f = videoFrame(S.t), si = Math.max(0, Math.floor(S.t));
    panels(true);
    const r = reportStats(f), opp = lineup.oppName || meta.teams.A, opp1 = opp.split(' ')[0];
    const kpi = (k, v, d) => `<div class="rk"><span>${k}</span><b>${v}</b><em>${d || ''}</em></div>`;
    const pct = (v) => (v == null ? '–' : Math.round(v * 100) + '%');
    const top = (S.top3 || []).map((it) => `<li><i style="background:${it.color}"></i><b>${esc(it.title)}</b> <span>${esc(it.sub)}</span></li>`).join('');
    const atk = $('advAtk').querySelector('.adv-text'), def = $('advDef').querySelector('.adv-text');
    $('repBody').innerHTML = `
      <header class="rh"><div><h1>${esc(meta.teams.H)} <span class="score">${score(f).H}–${score(f).A}</span> ${esc(opp)}</h1><p>Shadow Ball automatic report · up to ${clockText(f)} · ${lineup.formation} vs ${meta.formation.A}</p></div>
        <div class="rmark"><span class="mark"></span>Shadow<b>Ball</b></div></header>
      <section class="rblock"><h2>Match statistics</h2>${statsTable(f)}
        <p class="rnote">Goals, chances, counter-attacks, box entries, long balls and set pieces: Metrica Smart Tagging (automatic, can be wrong). Possession, transitions, final-third entries, recoveries and running: the Shadow Ball pipeline, from tracking. Shots are not counted: the data has no shot events and the tactical camera often loses the ball in front of goal, so "chances created" is used instead. Distance counts completed 5-minute blocks and reads low whenever a player is not tracked.</p></section>
      <section class="rkpis rk-hidden">
        ${kpi('Minutes in possession', pct(r.poss), `${esc(opp1)} ${pct(r.poss == null ? null : 1 - r.poss)}`)}
        ${kpi('Ball in their third', pct(r.att), `in ours ${pct(r.def)}`)}
        ${kpi('Final-third entries', String(r.ent.H), `${esc(opp1)} ${r.ent.A}`)}
        ${kpi('Regain ≤5 s', pct(r.regain), r.press ? `${fmt1(r.press)} players pressing` : '')}
        ${kpi('Dangerous transitions', String(r.dangerH), `${esc(opp1)} ${r.dangerA}`)}
        ${kpi('Defensive line height', r.line != null ? Math.round(r.line) + ' m' : '–', r.lineRef ? `1st half ${Math.round(r.lineRef)} m` : '')}
      </section>
      <section class="rblock"><h2>Momentum</h2><p class="rnote">Per minute: up = ball in the ${esc(opp1)} third, down = ball in our third.</p><canvas id="repMom"></canvas></section>
      <div class="rpair">
        <section class="rblock"><h2>Three things that matter now</h2><ul class="rtop">${top || '<li>Nothing urgent yet.</li>'}</ul></section>
        <section class="rblock"><h2>For the next minutes</h2><ul class="rnext">
          <li><b>Attack:</b> ${esc(atk.querySelector('b').textContent)}. ${esc(atk.querySelector('span').textContent)}</li>
          <li><b>Defend:</b> ${esc(def.querySelector('b').textContent)}. ${esc(def.querySelector('span').textContent)}</li>
          ${(S.plan || []).slice(0, 2).map((o, i) => `<li><b>Plan B ${i + 1}:</b> ${esc(o.title)}. ${esc(o.why)}</li>`).join('')}</ul></section>
      </div>
      <div class="pagebreak"></div>
      <header class="rh small"><div><h1>Maps</h1><p>${esc(meta.teams.H)} ${score(f).H}–${score(f).A} ${esc(opp)} · up to ${clockText(f)}</p></div><div class="rmark"><span class="mark"></span>Shadow<b>Ball</b></div></header>
      <div class="rgrid">
        <section class="rblock"><h2>Attack channels · 15 min</h2><canvas id="repCh"></canvas><p class="rnote" id="repChNote"></p></section>
        <section class="rblock"><h2>Set pieces</h2><canvas id="repSp"></canvas><div id="repSpT"></div></section>
        <section class="rblock"><h2>Freshness</h2><canvas id="repFat"></canvas><p class="rnote">Number = fatigue risk 0–100 (last 5-minute block), against that position's first 15 minutes.</p></section>
        <section class="rblock"><h2>1v1 duels · 10 min</h2><canvas id="repDuel"></canvas><div id="repDuelL"></div></section>
      </div>
      ${shadowReportHtml(f)}
      <footer class="rf">Positions are tactical roles from tracking (substitutions are not visible yet). Set pieces from Smart Tagging, placed where the ball was seen; duels are estimates from player positions. Licensed match data: this report is for the team only.</footer>`;
    $('report').hidden = false; document.body.classList.add('report-open');
    const wFull = $('repBody').clientWidth, wHalf = Math.floor((wFull - 20) / 2);
    const mk = (id, o, w) => { const v = new PitchView($(id), o); v.layout(w); return v; };
    momentumChart(f, $('repMom'), 60);
    channels(f, st, mk('repCh', { x0: 0, x1: L, m: 1.5 }, wHalf), $('repChNote'));
    setPieces(f, mk('repSp', { x0: 0, x1: L, m: 1.5 }, wHalf), $('repSpT'));
    fatigueMap(f, mk('repFat', { x0: 0, x1: L, m: 1.5 }, wHalf), null);
    duels(st, mk('repDuel', { x0: 0, x1: 62, m: 1.5 }, wHalf), $('repDuelL'), true);
    if ($('repTrend')) trendChart(f, $('repTrend'), wFull);
    if ($('repPress')) pressingCard(f, mk('repPress', { x0: 0, x1: L, m: 1.5 }, wHalf), $('repPressT'), $('repPressS'), 'H');
  }

  // ---------------------------------------------------------------- report page 3: Shadow Ball
  // movement without the ball, from kick-off to now: space denied and rest defence per 5 minutes,
  // the replays, pressing traps, space leaks and the Shadow ratings of our XI.
  function trendRows(f) { return ((C.shadow || {}).trend || []).filter(([h, b]) => blockEnd(h, b) <= f); }
  function shadowReportHtml(f) {
    if (!C.shadow) return '';
    const tr = trendRows(f), opp = lineup.oppName || meta.teams.A, opp1 = opp.split(' ')[0];
    const wavg = (team, vi, ni, half) => { let s = 0, n = 0; for (const r of tr) if (r[2] === team && r[vi] != null && (!half || r[0] === half)) { s += r[vi] * r[ni]; n += r[ni]; } return n ? s / n : null; };
    const pc = (v) => (v == null ? '–' : Math.round(v / 10) + '%');
    const reps = SH.moments.filter((m) => m[0] <= f), ours = reps.filter((m) => m[2] === 'H'), theirs = reps.filter((m) => m[2] === 'A');
    const R = shadowRatings(f), avg = (t) => { const v = Object.entries(R).filter(([k]) => k[0] === t).map(([, r]) => r.rating); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const kpi = (k, v, d) => `<div class="rk"><span>${k}</span><b>${v}</b><em>${d || ''}</em></div>`;
    const slotRole = {}; for (const [role, slot] of Object.entries(roleToSlot.H)) slotRole[slot] = role;
    const rateRows = D.slots(lineup.formation).filter((sl) => sl.label !== 'GK').map((sl) => {
      const role = slotRole[sl.label], r = role && R['H:' + role], p = player(lineup.xi[sl.label]);
      return r ? { name: p ? p.name : sl.label, slot: sl.label, r } : null;
    }).filter(Boolean).sort((a, b) => b.r.rating - a.r.rating);
    const leaksNow = leaks(f).slice(0, 5);
    const repLine = (m) => { const mv = momentMoves(m)[0]; return `<li><b>${clockText(m[1])}</b> ${m[5] === 'rest' ? 'lost the ball, rest defence' : 'space denied'} ${pc(m[3])}${mv ? ` · ${esc(nameFor(m[2], mv.role))} ${esc(moveText(mv))} (+${fmt1(mv.gap / 10)}%)` : ''}</li>`; };
    return `<div class="pagebreak"></div>
      <header class="rh small"><div><h1>Shadow Ball: movement without the ball</h1><p>${esc(meta.teams.H)} ${score(f).H}–${score(f).A} ${esc(opp)} · up to ${clockText(f)}</p></div><div class="rmark"><span class="mark"></span>Shadow<b>Ball</b></div></header>
      <section class="rkpis rk4">
        ${kpi('Space denied', pc(wavg('H', 3, 4)), `1st half ${pc(wavg('H', 3, 4, 1))} · 2nd ${pc(wavg('H', 3, 4, 2))} · ${esc(opp1)} ${pc(wavg('A', 3, 4))}`)}
        ${kpi('Rest defence', pc(wavg('H', 5, 6)), `if the ball is lost · ${esc(opp1)} ${pc(wavg('A', 5, 6))}`)}
        ${kpi('Shadow Replays', String(ours.length), `our lapses in this clip · ${esc(opp1)} ${theirs.length}`)}
        ${kpi('Shadow rating', avg('H') != null ? avg('H').toFixed(1) : '–', `${esc(opp1)} ${avg('A') != null ? avg('A').toFixed(1) : '–'} · 6.5 = average`)}
      </section>
      <section class="rblock"><h2>Space denied per 5 minutes</h2><canvas id="repTrend"></canvas>
        <p class="rnote">Share of the dangerous space each team controls while the other has the ball (pitch control x the threat surface learned from this match). Low space denied came before 2.3x more final-third entries against Barcelona.</p></section>
      <div class="rgrid">
        <section class="rblock"><h2>Pressing traps · ${esc(meta.teams.H)}</h2><canvas id="repPress"></canvas><p class="rnote"><b id="repPressT"></b> <span id="repPressS"></span></p>
          <p class="rnote">Per zone: won back within 5 s when 2+ players pressed · when we held. Green = trap, red = leak. Not causal.</p></section>
        <section class="rblock"><h2>Shadow ratings · ${esc(meta.teams.H)}</h2>
          <table class="mini"><thead><tr><th>Player</th><th>Rating</th><th>Shadow score</th><th>Space held</th></tr></thead><tbody>
          ${rateRows.map((x) => `<tr><td>${esc(x.name)} <span class="muted">${x.slot}</span></td><td><b>${x.r.rating.toFixed(1)}</b></td><td>${Math.round(x.r.score)}</td><td>${x.r.held.toFixed(2)}×</td></tr>`).join('') || '<tr><td colspan="4">Not enough minutes yet.</td></tr>'}</tbody></table>
          <p class="rnote">6.5 + movement without the ball (Shadow score vs 55; random = 50) + dangerous space held vs the average for the position. Our formula, not validated.</p></section>
        <section class="rblock"><h2>Space leaks · last 10 min vs first 15</h2>
          <table class="mini"><thead><tr><th>Player</th><th>Now vs early</th><th>Fatigue</th></tr></thead><tbody>
          ${leaksNow.map((r) => `<tr><td>${esc(nameOf(r.role))} <span class="muted">${r.role}</span></td><td><b>${r.ratio.toFixed(1)}×</b>${r.flag ? ' leaking' : ''}</td><td>${r.risk != null ? r.risk + ' ' + (r.level || '') : '–'}</td></tr>`).join('') || '<tr><td colspan="3">Baseline still building (first 15 minutes of the half).</td></tr>'}</tbody></table>
          <p class="rnote">Dangerous space each position leaves on the table while we defend. The fatigue score alone does not predict it (r = -0.005).</p></section>
        <section class="rblock"><h2>Shadow Replays</h2>
          <p class="rnote"><b>Ours</b> (before ${esc(opp1)} reached our final third)</p><ul class="rrep">${ours.map(repLine).join('') || '<li>None in this clip.</li>'}</ul>
          <p class="rnote"><b>Theirs</b> (where ${esc(opp1)} left space before our attacks)</p><ul class="rrep">${theirs.slice(-6).map(repLine).join('') || '<li>None in this clip.</li>'}</ul></section>
      </div>`;
  }
  function trendChart(f, c, w) {
    const h = 150, d = window.devicePixelRatio || 1; c.width = w * d; c.height = h * d; c.style.height = h + 'px';
    const g = c.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, w, h);
    const tr = trendRows(f), x0 = 34, x1 = w - 8, y0 = 10, y1 = h - 22, maxM = 95;
    const X = (h_, b) => x0 + ((b + 2.5 + (h_ === 2 ? 5 : 0)) / (maxM + 5)) * (x1 - x0), Y = (v) => y1 - ((v / 10 - 40) / 60) * (y1 - y0);
    g.font = `10px ${CSS.getPropertyValue('--sans')}`; g.fillStyle = '#5B626C'; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (const v of [40, 60, 80, 100]) { g.fillText(v + '%', x0 - 4, Y(v * 10)); g.strokeStyle = '#E3E6EA'; g.beginPath(); g.moveTo(x0, Y(v * 10)); g.lineTo(x1, Y(v * 10)); g.stroke(); }
    g.textAlign = 'center'; for (const m of [0, 15, 30, 45, 60, 75, 90]) g.fillText(m + "'", X(m < 45 ? 1 : 2, m - 2.5), h - 8);
    g.strokeStyle = '#9AA1AB'; g.beginPath(); g.moveTo(X(2, 42.5), y0); g.lineTo(X(2, 42.5), y1); g.stroke();
    for (const [team, col] of [['A', lineup.kitA], ['H', lineup.kitH]]) {
      for (const half of [1, 2]) {
        const pts = tr.filter((r) => r[2] === team && r[0] === half && r[3] != null && r[4] >= 20);
        g.strokeStyle = col; g.lineWidth = team === 'H' ? 2.2 : 1.4; g.beginPath();
        pts.forEach((r, i) => (i ? g.lineTo(X(r[0], r[1]), Y(r[3])) : g.moveTo(X(r[0], r[1]), Y(r[3])))); g.stroke();
        g.fillStyle = col; for (const r of pts) { g.beginPath(); g.arc(X(r[0], r[1]), Y(r[3]), 2.4, 0, 7); g.fill(); }
      }
    }
    g.textAlign = 'left'; g.font = `600 11px ${CSS.getPropertyValue('--sans')}`;
    g.fillStyle = lineup.kitH; g.fillText(`${meta.teams.H} defending`, x0 + 6, y0 + 6);
    g.fillStyle = lineup.kitA; g.fillText(`${(lineup.oppName || meta.teams.A).split(' ')[0]} defending`, x0 + 150, y0 + 6);
  }

  // ================================================================== Plan B + Player Recommender
  let planBV, planAV;
  function planCard(f) {
    const DEC = window.SB_DECIDE, fat = latestStamina(f);
    const tired = Object.values(fat).filter((r) => r.team === 'H' && r.half === meta.half && r.level === 'red' && r.label !== 'GK')
      .sort((a, b) => b.risk - a.risk).map((r) => { const lk = (S.leaks || []).find((x) => x.role === r.label); return { role: r.label, risk: r.risk, label: nameOf(r.label), space: lk ? lk.ratio : null }; });
    const badDuel = (S.duels || []).filter((d) => d.danger >= 0.3).sort((a, b) => b.danger - a.danger)[0];
    const subs = {}, needsOf = {};
    for (const t of tired) { needsOf[t.role] = DEC.needsFor(t.role, 'fatigue'); subs[t.role] = DEC.recommend(lineup.squad, lineup.xi, slotOf(t.role), needsOf[t.role]); }
    if (badDuel) { needsOf[badDuel.def] = DEC.needsFor(badDuel.def, 'duel'); subs[badDuel.def] = DEC.recommend(lineup.squad, lineup.xi, slotOf(badDuel.def), needsOf[badDuel.def]); }
    // a position that leaks dangerous space and is tiring (Space leaks card)
    const lkr = (S.leaks || []).filter((r) => r.flag && (r.level === 'red' || r.level === 'amber')).sort((a, b) => b.ratio - a.ratio)[0];
    const leak = lkr ? { role: lkr.role, label: nameOf(lkr.role), ratio: lkr.ratio, risk: lkr.risk } : null;
    if (leak && !subs[leak.role]) { needsOf[leak.role] = DEC.needsFor(leak.role, 'line'); subs[leak.role] = DEC.recommend(lineup.squad, lineup.xi, slotOf(leak.role), needsOf[leak.role]); }
    const tr = C.transitions.filter((t) => t.frame <= f && t.won_by === 'A');
    const rate = (h) => { const x = tr.filter((t) => t.half === h); return x.length >= 4 ? x.filter((t) => t.regained).length / x.length : null; };
    const dangerA = C.transitions.filter((t) => t.won_by === 'A' && t.dangerous && t.frame <= f && t.frame > f - 10 * 60 * meta.fps).length;
    const sim = S.sim || {};
    S.plan = DEC.planB({ tired, leak, badDuel: badDuel && { def: badDuel.def, att: badDuel.att, behind: badDuel.behind }, subs,
      drop: sim.drop, backFive: sim.backFive, oppLane: sim.oppLane, oppShare: sim.oppShare, dangerA,
      regainNow: meta.half === 2 ? rate(2) : null, regainH1: meta.half === 2 ? rate(1) : null,
      atkLane: S.adv && S.adv.atkLane, atkFree: S.adv && S.adv.atkFree });
    // substitutes: for the most urgent role (or, with nothing urgent, the most tired outfield role)
    let role = (S.plan.find((o) => o.kind === 'sub') || {}).role;
    if (!role) {
      const any = Object.values(fat).filter((r) => r.team === 'H' && r.half === meta.half && r.risk != null && r.label !== 'GK').sort((a, b) => b.risk - a.risk)[0];
      role = any && any.label;
    }
    if (role && !subs[role]) { needsOf[role] = DEC.needsFor(role, 'fatigue'); subs[role] = DEC.recommend(lineup.squad, lineup.xi, slotOf(role), needsOf[role]); }
    S.subsShown = role ? { for_role: role, for_player: nameOf(role), needs: needsOf[role],
      candidates: subs[role].slice(0, 3).map((c) => ({ name: c.name, number: c.num, match: c.score, why: c.why })) } : null;
    if (narrow()) return;
    $('plan').innerHTML = S.plan.length ? S.plan.slice(0, 4).map((o, i) => `<div class="po${i === 0 ? ' top' : ''}">
        <span class="pn">${i + 1}</span><div><b>${esc(o.title)}</b><span>${esc(o.why)}</span></div></div>`).join('')
      : '<p class="empty">No change needed right now.</p>';
    $('subFor').textContent = role ? `for ${nameOf(role)} (${role})` : '';
    $('subs').innerHTML = role ? `<div class="needs">${needsOf[role].map((n) => `<span>${esc(n)}</span>`).join('')}</div>` +
      subs[role].slice(0, 3).map((c, i) => { const p = player(c.id); return `<div class="sub${i === 0 ? ' top' : ''}">
        ${avatar(p, 'H', '')}<div class="who"><b>${esc(c.name)}</b><span>${esc((p.pos || []).join(' · ') || p.group)}</span></div>
        <div class="why">${c.why.map((w) => `<span>${esc(w)}</span>`).join('')}</div><em>${c.score}</em></div>`; }).join('')
      : '<p class="empty">No fatigue data yet.</p>';
    drawBeforeAfter();
  }
  // the coach's slot for a tracked role (LCDM tracked may be the coach's CDM): recommend for that slot
  function slotOf(role) { const p = roleToPlayer[role]; return (p && p.slot) || role; }
  function drawBeforeAfter() {
    const top = (S.plan || []).find((o) => o.kind === 'line' || o.kind === 'shape'), sim = S.sim;
    $('ba').hidden = !top || !sim;
    if (!top || !sim) return;
    const move = top.kind === 'line' ? sim.drop.move : sim.backFive.move, e = top.effect;
    const last = sim.samples[sim.samples.length - 1];
    for (const [v, after] of [[planBV, false], [planAV, true]]) {
      const g = v.ctx; v.begin();
      const ps = last.map((p) => (after && p.team === 'H' ? move(p, last) : p));
      for (let x = 0; x < L / 3 + 6; x += 3) for (let y = 0; y < W; y += 3) {
        let dh = 1e9, da = 1e9;
        for (const p of ps) { const d = (p.x - x - 1.5) ** 2 + (p.y - y - 1.5) ** 2; if (p.team === 'H') dh = Math.min(dh, d); else da = Math.min(da, d); }
        if (da < dh) { v.rect(x, y, x + 3.05, y + 3.05); g.fillStyle = hexA(lineup.kitA, 0.32); g.fill(); }
      }
      for (const p of ps) { const [a, b] = v.S(p.x, p.y); g.beginPath(); g.arc(a, b, 4.5, 0, 7); g.fillStyle = p.team === 'H' ? lineup.kitH : lineup.kitA; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 1; g.stroke(); }
    }
    $('baNow').textContent = `Now · theirs ${Math.round(e.before * 100)}%`;
    $('baAfter').textContent = `${top.kind === 'line' ? `Line −${S.sim.drop.by} m` : 'Back five'} · theirs ${Math.round(e.after * 100)}%`;
  }

  // ================================================================== loop
  let last = performance.now(), lastPanel = -1;
  function panels(force) {
    const st = interp(S.t), f = videoFrame(S.t), si = Math.max(0, Math.min(C.seconds.frames.length - 1, Math.floor(S.t)));
    squad(st, f, si, force); strip(f); advice(st); pressingCard(f); leakCard(f); lineupCard(f); simCards();
    if (!narrow()) { feed(f); fatigueMap(f); stats(f, si); momentumChart(f); channels(f, st); setPieces(f); duels(st); }
    planCard(f);
    postSnapshot(f);
    priorities(f, st, si);
  }
  function loop(now) {
    const dt = (now - last) / 1000; last = now;
    if ($('live').hidden) { requestAnimationFrame(loop); return; }
    if (S.playing) { S.t = Math.min(duration, S.t + dt * S.speed); if (S.t >= duration) S.playing = false; }
    const st = interp(S.t);
    drawMain(st);
    replayTrigger(st.frame);
    drawShadow();
    drawSims();
    $('scrub').value = S.t;
    $('playBtn').classList.toggle('on', S.playing);
    $('clock').textContent = clockText(st.frame);
    const sc = score(st.frame), scTxt = `${meta.teams.H} ${sc.H}–${sc.A} ${(lineup.oppName || meta.teams.A)}`;
    if ($('match').dataset.score !== scTxt) { $('match').dataset.score = scTxt; $('match').innerHTML = `<b>${esc(scTxt)}</b> · ${lineup.formation} vs ${meta.formation.A}`; }
    const pe = $('poss'), opp = (lineup.oppName || meta.teams.A).split(' ')[0];
    pe.innerHTML = st.poss === 'D' ? '<i style="background:#6B7280"></i>Dead ball'
      : `<i style="background:${st.poss === 'H' ? lineup.kitH : lineup.kitA}"></i>${st.poss === 'H' ? meta.teams.H : opp}`;
    const half = Math.floor(S.t * 2) / 2;
    if (half !== lastPanel) { lastPanel = half; panels(false); }
    requestAnimationFrame(loop);
  }
})();
