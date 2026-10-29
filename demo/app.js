/* Shadow Ball demo — the coach's live screen (laptop) and the pitch-side view (phone).
   Replays one clip "as live": python run.py demo -> /data/clip.json, python run.py serve.
   The laptop leads the clock; phones follow it through /api/state. The coach's line-up
   (names, numbers, formation, own photos) is kept on the laptop through /api/lineup.

   Every view shows OUR team attacking to the right (up on a phone). */
(function () {
  'use strict';
  const D = window.SB_DATA;
  const $ = (id) => document.getElementById(id);
  const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1).replace('.', ',');
  const params = new URLSearchParams(location.search);
  const narrow = () => matchMedia('(max-width: 900px)').matches;
  const CSS = getComputedStyle(document.documentElement);
  const COL = { shadow: '#A78BFA', ok: '#4ADE80', warn: '#FBBF24', bad: '#F87171', D: '#3A3F47' };
  const LEVEL = { red: COL.bad, amber: COL.warn, green: COL.ok, 'no data': '#4B5159' };
  let L = 105.3, W = 68;

  let C, meta, labels, nFrames, duration, flipH;
  const inClip = new Set();
  const S = { t: 0, playing: false, speed: 1, team: 'H', sel: null, follow: false,
              layers: { ghost: true, cloud: true, zones: true, names: true }, seen: new Set(), feedKey: '' };
  let lineup = null, roleToPlayer = {};

  // ================================================================== load
  Promise.all([
    fetch('data/clip.json').then((r) => { if (!r.ok) throw new Error('clip.json belum ada: jalankan python run.py demo'); return r.json(); }),
    fetch('api/lineup', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { lineup: null })).catch(() => ({ lineup: null })),
  ]).then(([clip, saved]) => init(clip, saved.lineup)).catch((e) => { $('loading').textContent = e.message; });

  function init(clip, savedLineup) {
    C = clip; meta = C.meta; labels = meta.labels; [L, W] = meta.pitch;
    if (meta.teams.A === 'Atletic Club') meta.teams.A = 'Athletic Club';   // spelling in the data file
    nFrames = C.frames.length; duration = (nFrames - 1) / meta.sample_fps;
    flipH = !meta.attacks_right.H;
    for (const fr of C.frames) for (const p of fr[3]) inClip.add(key(p));
    S.follow = params.get('mode') === 'follow' || (params.get('mode') !== 'lead' && narrow());
    lineup = savedLineup || readLocal() || defaultLineup();
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
  const lane = (y) => (y < W / 3 ? 'kiri' : y < 2 * W / 3 ? 'tengah' : 'kanan');

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
  // as roles.py): each named player lands on the detected role closest to his slot.
  function applyLineup() {
    document.documentElement.style.setProperty('--home', lineup.kitH);
    document.documentElement.style.setProperty('--away', lineup.kitA);
    roleToPlayer = {};
    const det = meta.role_means.H, detLabels = Object.keys(det);
    const slots = D.slots(lineup.formation).filter((s) => s.label !== 'GK');
    if (lineup.xi.GK) roleToPlayer.GK = player(lineup.xi.GK);
    const depths = detLabels.map((l) => det[l][0]), dmin = Math.min(...depths), dmax = Math.max(...depths);
    const pts = detLabels.map((l) => ({ l, x: det[l][1] / W, y: 0.2 + 0.66 * (det[l][0] - dmin) / Math.max(1, dmax - dmin) }));
    const n = Math.max(pts.length, slots.length);
    const cost = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
      if (i >= pts.length || j >= slots.length) return 0;
      const exact = pts[i].l === slots[j].label ? -0.05 : 0;
      return (pts[i].x - slots[j].x) ** 2 + (pts[i].y - slots[j].y) ** 2 + exact;
    }));
    hungarian(cost).forEach((j, i) => {
      if (i < pts.length && j < slots.length) {
        const pid = lineup.xi[slots[j].label];
        if (pid) roleToPlayer[pts[i].l] = Object.assign({ slot: slots[j].label }, player(pid));
      }
    });
    $('match').textContent = `${meta.teams.H} – ${lineup.oppName || meta.teams.A} · ${lineup.formation} vs ${meta.formation.A}`;
    $('tabA').textContent = (lineup.oppName || meta.teams.A).split(' ')[0];
    $('tabH').textContent = meta.teams.H;
    advCache = -1; heatCache = '';
  }

  // ---------------------------------------------------------------- setup screen
  let selSlot = null;
  function openSetup() {
    S.playing = false; $('setup').hidden = false; $('live').hidden = true; document.body.classList.add('setup-open');
    $('oppName').value = lineup.oppName || meta.teams.A; $('kitH').value = lineup.kitH; $('kitA').value = lineup.kitA;
    $('detected').textContent = `Terdeteksi dari tracking babak ${meta.half}: ${meta.teams.H} ${meta.formation.H}, lawan ${meta.formation.A}. Nama dipasang ke pemain terdekat secara otomatis, jadi formasi pilihanmu boleh berbeda.`;
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
  function renderSetup() {
    $('formationList').innerHTML = Object.keys(D.FORMATIONS).map((f) =>
      `<button type="button" class="fm${f === lineup.formation ? ' on' : ''}" data-f="${f}">${formationSvg(f)}<span>${f}</span></button>`).join('');
    $('formationList').querySelectorAll('.fm').forEach((b) => b.onclick = () => changeFormation(b.dataset.f));
    const slots = D.slots(lineup.formation);
    $('boardTitle').textContent = `Susunan pemain · ${lineup.formation}`;
    $('board').innerHTML = slots.map((s) => {
      const p = player(lineup.xi[s.label]);
      return `<button type="button" class="slot${p ? '' : ' empty'}${selSlot === s.label ? ' sel' : ''}" data-s="${s.label}"
        style="left:${6 + s.x * 88}%;top:${94 - s.y * 86}%">${avatar(p, 'H', s.label)}<span class="nm">${p ? esc(shortName(p)) : 'Kosong'}</span><span class="rl">${s.label}</span></button>`;
    }).join('');
    $('board').querySelectorAll('.slot').forEach((b) => b.onclick = () => { selSlot = selSlot === b.dataset.s ? null : b.dataset.s; renderSetup(); });
    $('slotHint').textContent = selSlot ? `Pilih pemain untuk ${selSlot} dari skuad` : 'Klik posisi, lalu klik pemain';
    const inXI = {}; for (const [l, id] of Object.entries(lineup.xi)) inXI[id] = l;
    $('squadEdit').innerHTML = lineup.squad.map((p) => `<div class="se${inXI[p.id] ? ' inxi' : ''}${selSlot ? ' pick' : ''}" data-id="${p.id}">
        <label class="av" title="Tambah foto" style="${p.photo ? `background-image:url(${p.photo})` : ''}">${p.photo ? '' : initials(p.name)}<input type="file" accept="image/*" hidden></label>
        <input class="num" value="${p.num}" inputmode="numeric" aria-label="Nomor">
        <input class="name" value="${esc(p.name)}" aria-label="Nama">
        <span class="pos">${inXI[p.id] || p.group}</span>
        <button type="button" class="x" aria-label="Hapus">×</button></div>`).join('');
    $('squadEdit').querySelectorAll('.se').forEach((row) => {
      const p = player(row.dataset.id);
      row.querySelector('.num').onchange = (e) => { p.num = parseInt(e.target.value, 10) || p.num; renderSetup(); };
      row.querySelector('.name').onchange = (e) => { p.name = e.target.value.trim() || p.name; renderSetup(); };
      row.querySelector('input[type=file]').onchange = (e) => e.target.files[0] && loadPhoto(e.target.files[0], p);
      row.querySelector('.x').onclick = () => {
        lineup.squad = lineup.squad.filter((q) => q.id !== p.id);
        for (const l in lineup.xi) if (lineup.xi[l] === p.id) delete lineup.xi[l];
        renderSetup();
      };
      row.onclick = (e) => {
        if (!selSlot || e.target.closest('input,label,button')) return;
        for (const l in lineup.xi) if (lineup.xi[l] === p.id) delete lineup.xi[l];
        lineup.xi[selSlot] = p.id; selSlot = null; renderSetup();
      };
    });
  }
  function changeFormation(f) {
    // keep the same players, moved to the nearest slots of the new shape
    const old = D.slots(lineup.formation).filter((s) => lineup.xi[s.label]), neu = D.slots(f);
    const n = Math.max(old.length, neu.length);
    const cost = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
      i < old.length && j < neu.length ? (old[i].x - neu[j].x) ** 2 + (old[i].y - neu[j].y) ** 2 + (old[i].label === 'GK') * (neu[j].label !== 'GK') * 9 : 0));
    const xi = {};
    hungarian(cost).forEach((j, i) => { if (i < old.length && j < neu.length) xi[neu[j].label] = lineup.xi[old[i].label]; });
    lineup.formation = f; lineup.xi = xi; selSlot = null; renderSetup();
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
    lineup.squad.push({ id: 'n' + Date.now(), num, name: 'Pemain baru', group: 'MF', photo: null }); renderSetup();
  };

  // ================================================================== time + sync
  const videoFrame = (t) => meta.first + Math.round(t * meta.fps);
  function clockText(f) {
    const s = (f - meta.half_start) / meta.fps + (meta.half === 2 ? 45 * 60 : 0);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }
  let lastPost = 0;
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
  function updateFollow() { const b = $('followBtn'); b.hidden = false; b.textContent = S.follow ? 'Ikuti laptop ✓' : 'Ikuti laptop'; }
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
    $('startBtn').onclick = closeSetup;
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
  function framePlayers(i) { return C.frames[i][3].map((p) => { const [x, y] = tf(p[3], p[4]); return { k: key(p), team: p[1] === 0 ? 'H' : 'A', role: labels[p[2]], x, y }; }); }

  function blockEnd(half, minute) { return half < meta.half ? -Infinity : meta.half_start + (minute + 5 - (half === 1 ? 0 : 45)) * 60 * meta.fps; }
  function latestStamina(f) { const out = {}; for (const r of C.stamina) if (blockEnd(r.half, r.minute) <= f) out[`${r.team}:${r.label}`] = r; return out; }

  // Shadow Team: our own out-of-possession shape (learned by roles.py) placed around the live
  // team, slid toward the ball. A player far from his shadow is out of shape.
  function shadowTeam(st) {
    const H = st.players.filter((p) => p.team === 'H' && p.role !== 'GK');
    if (H.length < 7) return null;
    const cx = H.reduce((s, p) => s + p.x, 0) / H.length;
    const by = st.ball ? st.ball.y : W / 2;
    const out = [];
    for (const [role, [depth, width]] of Object.entries(meta.role_means.H)) {
      const gx = Math.max(2, Math.min(L - 2, cx + depth)), gy = Math.max(2, Math.min(W - 2, width + 0.3 * (by - W / 2)));
      const p = H.find((q) => q.role === role);
      out.push({ role, x: gx, y: gy, p, dev: p ? Math.hypot(p.x - gx, p.y - gy) : null });
    }
    return out;
  }

  // ================================================================== views
  let main, advA, advD, fatigueV, heatV, channelsV;
  function buildViews() {
    const holder = $('pitch').parentElement;
    main = new PitchView($('pitch'), { portrait: narrow(), m: 2.5 });
    main.layout(holder.clientWidth);
    $('dir').textContent = narrow() ? '' : `${meta.teams.H} menyerang →`;
    if (!narrow()) {
      advA = new PitchView($('advAtk').querySelector('canvas'), { portrait: true, x0: 50, x1: L, m: 1.5 });
      advD = new PitchView($('advDef').querySelector('canvas'), { portrait: true, x0: 0, x1: L - 50, m: 1.5 });
      advA.layout($('advAtk').clientWidth - 28); advD.layout($('advDef').clientWidth - 28);
      fatigueV = new PitchView($('fatigueMap'), { x0: 0, x1: L, m: 1.5 }); fatigueV.layout($('fatigueMap').parentElement.clientWidth - 28);
      channelsV = new PitchView($('channels'), { x0: 0, x1: L, m: 1.5 }); channelsV.layout($('channels').parentElement.clientWidth - 28);
    }
    heatV = new PitchView($('heat'), { portrait: narrow(), x0: 0, x1: L, m: 1.5 });
    heatV.layout(Math.min(narrow() ? 300 : 300, $('pdetail').clientWidth || 300));
    advCache = -1; heatCache = ''; zoneT = -1; S.feedKey = '';
  }

  let zoneT = -1, zoneCells = [];
  function computeZones(st) {
    // pitch control proxy: who gets to each 3 m cell first (distance, softened)
    const H = st.players.filter((p) => p.team === 'H'), A = st.players.filter((p) => p.team === 'A');
    if (!H.length || !A.length) return [];
    const cells = [], c = 3;
    for (let x = 0; x < L; x += c) for (let y = 0; y < W; y += c) {
      const mx = x + c / 2, my = y + c / 2;
      let dh = 1e9, da = 1e9;
      for (const p of H) dh = Math.min(dh, (p.x - mx) ** 2 + (p.y - my) ** 2);
      for (const p of A) da = Math.min(da, (p.x - mx) ** 2 + (p.y - my) ** 2);
      const ctl = 1 / (1 + Math.exp((Math.sqrt(dh) - Math.sqrt(da)) / 2.2));
      cells.push([x, y, Math.min(L, x + c + 0.05), Math.min(W, y + c + 0.05), ctl]);
    }
    return cells;
  }

  // control grid painted as a small image, then stretched with smoothing onto the pitch
  const zoneImg = document.createElement('canvas');
  function drawZones(v, cells, kitH, kitA) {
    if (!cells.length) return;
    const nx = Math.ceil(L / 3), ny = Math.ceil(W / 3); zoneImg.width = nx; zoneImg.height = ny;
    const zc = zoneImg.getContext('2d'), img = zc.createImageData(nx, ny);
    const ch = parseInt(kitH.slice(1), 16), ca = parseInt(kitA.slice(1), 16);
    cells.forEach(([x0, y0, , , ctl]) => {
      const i = Math.round(y0 / 3) * nx + Math.round(x0 / 3); if (i >= nx * ny) return;
      const c = ctl > 0.5 ? ch : ca, a = Math.max(0, Math.abs(ctl - 0.5) * 2 - 0.1);
      img.data.set([c >> 16, (c >> 8) & 255, c & 255, Math.round(255 * 0.17 * a)], i * 4);
    });
    zc.putImageData(img, 0, 0);
    const g = v.ctx, [ox, oy] = v.S(0, 0), [lx, ly] = v.S(nx * 3, 0), [wx, wy] = v.S(0, ny * 3);
    g.save(); g.imageSmoothingEnabled = true;
    g.setTransform(v.d * (lx - ox) / nx, v.d * (ly - oy) / nx, v.d * (wx - ox) / ny, v.d * (wy - oy) / ny, v.d * ox, v.d * oy);
    g.drawImage(zoneImg, 0, 0); g.restore();
  }

  function drawMain(st) {
    const v = main, g = v.ctx; v.begin();
    const kitH = lineup.kitH, kitA = lineup.kitA;
    if (S.layers.zones) {
      if (Math.abs(S.t - zoneT) > 0.12) { zoneCells = computeZones(st); zoneT = S.t; }
      drawZones(v, zoneCells, kitH, kitA);
    }
    // free space right after a dangerous turnover
    const f = videoFrame(S.t);
    const ev = C.transitions.filter((t) => t.dangerous && t.free && t.frame <= f && f - t.frame < 6 * meta.fps).pop();
    if (ev) {
      const [fx, fy] = tf(ev.free[0], ev.free[1]), r = Math.min(ev.free[2], 14);
      v.path(v.arcPts(fx, fy, r)); g.save(); g.setLineDash([6, 5]); g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); g.restore();
      v.label(`ruang ${Math.round(ev.free[2])} m`, fx, fy, 0, { size: 11 });
    }
    // trail of the selected player (last 5 s)
    if (S.sel) {
      const pts = []; for (let i = Math.max(0, st.idx - 25); i <= st.idx; i++) { const p = framePlayers(i).find((q) => q.k === S.sel); if (p) pts.push([p.x, p.y]); }
      if (pts.length > 1) { v.path(pts); g.strokeStyle = hexA(COL.shadow, 0.9); g.lineWidth = 3; g.lineCap = 'round'; g.stroke(); }
    }
    // Shadow Team (only while the ball is theirs: it is the shape to defend in)
    const ghosts = shadowTeam(st); let outOfShape = 0;
    if (ghosts && S.layers.ghost && st.poss === 'A') {
      for (const gh of ghosts) {
        const off = gh.dev != null && gh.dev > 10; if (off) outOfShape++;
        if (gh.p) { v.path([[gh.p.x, gh.p.y], [gh.x, gh.y]]); g.save(); g.setLineDash([3, 4]); g.strokeStyle = off ? COL.warn : 'rgba(255,255,255,.45)'; g.lineWidth = off ? 2 : 1.2; g.stroke(); g.restore(); }
        const [a, b] = v.S(gh.x, gh.y), r = Math.max(6, 1.1 * v.sc);
        g.beginPath(); g.arc(a, b, r, 0, 7); g.fillStyle = 'rgba(167,139,250,.18)'; g.fill();
        g.save(); g.setLineDash([3, 3]); g.strokeStyle = off ? COL.warn : 'rgba(205,190,255,.85)'; g.lineWidth = 1.4; g.stroke(); g.restore();
      }
    } else if (ghosts) outOfShape = ghosts.filter((gh) => gh.dev != null && gh.dev > 10).length;
    S.outOfShape = st.poss === 'A' ? outOfShape : null;
    // players
    const fat = latestStamina(f), r = Math.max(6.5, 1.15 * v.sc);
    for (const p of st.players) {
      const [a, b] = v.S(p.x, p.y), kit = p.team === 'H' ? kitH : kitA;
      g.beginPath(); g.ellipse(a + r * 0.25, b + r * 0.55, r * 0.95, r * 0.45, 0, 0, 7); g.fillStyle = 'rgba(0,0,0,.28)'; g.fill();
      g.beginPath(); g.arc(a, b, r, 0, 7); g.fillStyle = kit; g.fill(); g.lineWidth = 1.5; g.strokeStyle = 'rgba(255,255,255,.9)'; g.stroke();
      const s = fat[p.k];
      if (p.team === 'H' && s && s.level === 'red' && s.half === meta.half) { g.beginPath(); g.arc(a, b, r + 3.5, -Math.PI / 2, Math.PI * 1.5 * (s.risk / 100) - Math.PI / 2); g.strokeStyle = COL.bad; g.lineWidth = 2.5; g.stroke(); }
      if (S.sel === p.k) { g.beginPath(); g.arc(a, b, r + 6, 0, 7); g.strokeStyle = COL.shadow; g.lineWidth = 2.5; g.stroke(); }
      const pl = p.team === 'H' ? roleToPlayer[p.role] : null;
      g.fillStyle = '#fff'; g.font = `700 ${Math.round(r * 0.95)}px ${CSS.getPropertyValue('--mono')}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(pl ? String(pl.num) : '', a, b + 0.5);
      if (S.layers.names || narrow()) {
        const text = pl ? shortName(pl) : p.role;
        v.label(text, p.x, p.y, r + 9, { size: narrow() ? 9.5 : 10.5, color: p.team === 'H' ? '#fff' : '#FFE1D8' });
      }
    }
    // Shadow Ball: seen = a ball; reconstructed = a cloud as wide as the model's uncertainty
    const bl = st.ball;
    if (bl) {
      const [a, b] = v.S(bl.x, bl.y);
      if (bl.model && S.layers.cloud) {
        const rad = Math.max(10, Math.min(bl.sigma || 4, 9) * v.sc);
        const gr = g.createRadialGradient(a, b, 0, a, b, rad);
        gr.addColorStop(0, 'rgba(167,139,250,.55)'); gr.addColorStop(1, 'rgba(167,139,250,0)');
        g.beginPath(); g.arc(a, b, rad, 0, 7); g.fillStyle = gr; g.fill();
        g.beginPath(); g.arc(a, b, Math.max(3, 0.45 * v.sc), 0, 7); g.fillStyle = 'rgba(255,255,255,.8)'; g.fill();
      } else if (!bl.model) {
        g.beginPath(); g.arc(a, b, Math.max(3.5, 0.55 * v.sc), 0, 7); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#111'; g.lineWidth = 1.2; g.stroke();
      }
    }
    lastPlayers = st.players;
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

  // ================================================================== advice maps (last 30 s)
  let advCache = -1;
  function windowSamples(idx) { const out = []; for (let i = Math.max(0, idx - 150); i <= idx; i += 5) out.push(framePlayers(i)); return out; }
  const nameOf = (role) => { const p = roleToPlayer[role]; return p ? shortName(p) : role; };

  function advice(st) {
    const draw = !narrow() && advA && advD;
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
      if (oppLine) { v.path([[oppLine, 0], [oppLine, W]]); v.ctx.save(); v.ctx.setLineDash([6, 6]); v.ctx.strokeStyle = 'rgba(255,255,255,.7)'; v.ctx.lineWidth = 1.5; v.ctx.stroke(); v.ctx.restore(); v.label('garis lawan', oppLine, 3, 0, { size: 10 }); }
      if (runner && best) v.arrow(runner.p.x, runner.p.y, best.x, best.y, '#fff', 2.5);
    });
    const atk = $('advAtk').querySelector('.adv-text');
    atk.querySelector('b').textContent = best ? `Serang lewat ${lane(best.y)}` : 'Menunggu data';
    atk.querySelector('span').textContent = best ? `Ruang ${Math.round(best.v)} m dari lawan terdekat` + (runner ? ` · ${nameOf(runner.p.role)} masuk ke zona` : '') +
      (oppLine ? ` · garis lawan ${Math.round(L - oppLine)} m dari gawangnya` : '') : '';
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
    const ourLines = samples.map((ps) => { const xs = ps.filter((p) => p.team === 'H' && p.role !== 'GK').map((p) => p.x).sort((a, b) => a - b); return xs.length >= 4 ? xs.slice(0, 4).reduce((a, b) => a + b) / 4 : null; }).filter((v) => v != null);
    const ourLine = ourLines.length ? ourLines.reduce((a, b) => a + b) / ourLines.length : null;
    let mover = null; if (worst) for (const p of st.players) if (p.team === 'H' && p.role !== 'GK') { const d = Math.hypot(p.x - worst.x, p.y - worst.y); if (!mover || d < mover.d) mover = { p, d }; }
    const fat = latestStamina(f), tiredCB = ['LCB', 'RCB', 'CB'].filter((r) => fat['H:' + r] && fat['H:' + r].level === 'red' && fat['H:' + r].half === meta.half);
    const ref = (meta.shape_ref['H_half' + meta.half] || {}).line_height_m;
    const dropTo = tiredCB.length && ref && ourLine && ourLine > ref - 2 ? Math.min(ourLine - 4, ref) : null;
    if (draw) drawAdvice(advD, danger.map(([x, y, v]) => [x, y, v / dmax * 15]), worst, '#F87171', st, (v) => {
      if (ourLine) { v.path([[ourLine, 0], [ourLine, W]]); v.ctx.save(); v.ctx.setLineDash([6, 6]); v.ctx.strokeStyle = 'rgba(255,255,255,.7)'; v.ctx.lineWidth = 1.5; v.ctx.stroke(); v.ctx.restore(); v.label('garis kita', ourLine, 3, 0, { size: 10 }); }
      if (dropTo) { v.path([[dropTo, 0], [dropTo, W]]); v.ctx.save(); v.ctx.setLineDash([2, 5]); v.ctx.strokeStyle = COL.shadow; v.ctx.lineWidth = 2; v.ctx.stroke(); v.ctx.restore(); v.arrow(ourLine, W - 6, dropTo + 0.5, W - 6, COL.shadow, 2); }
      if (mover && worst && mover.d > 4) { const k = (mover.d - 3) / mover.d; v.arrow(mover.p.x, mover.p.y, mover.p.x + (worst.x - mover.p.x) * k, mover.p.y + (worst.y - mover.p.y) * k, '#fff', 2.5); }
    });
    S.adv = { atkLane: best ? lane(best.y) : null, atkFree: best ? best.v : null, runner: runner ? runner.p.role : null,
              defLane: worst ? lane(worst.y) : null, mover: mover ? mover.p.role : null, dropTo, ourLine, tiredCB };
    const def = $('advDef').querySelector('.adv-text');
    def.querySelector('b').textContent = worst ? `Tutup sisi ${lane(worst.y)}` : 'Menunggu data';
    def.querySelector('span').textContent = (mover ? `${nameOf(mover.p.role)} geser ${Math.max(0, Math.round(mover.d - 3))} m` : '') +
      (dropTo ? ` · turunkan garis ${Math.round(ourLine - dropTo)} m (${tiredCB.join(' + ')} lelah)` : ourLine ? ` · garis kita ${Math.round(ourLine)} m` : '');
  }
  function drawAdvice(v, cells, best, color, st, extra) {
    const g = v.ctx; v.begin();
    for (const [x, y, val] of cells) { const a = Math.min(1, val / 15); if (a < 0.08) continue; v.rect(x, y, x + 5, y + 5); g.fillStyle = hexA(color, 0.5 * a * a); g.fill(); }
    if (best) { const [a, b] = v.S(best.x - 6, best.y - 6), [c, d] = v.S(best.x + 6, best.y + 6); roundRect(g, Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b), 8); g.strokeStyle = color; g.lineWidth = 2.5; g.stroke(); }
    for (const p of st.players) { const [a, b] = v.S(p.x, p.y); g.beginPath(); g.arc(a, b, 4.5, 0, 7); g.fillStyle = p.team === 'H' ? lineup.kitH : lineup.kitA; g.globalAlpha = 0.9; g.fill(); g.globalAlpha = 1; g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 1; g.stroke(); }
    extra(v);
  }

  // ================================================================== side panels
  function fatigueMap(f) {
    if (narrow()) return;
    const v = fatigueV, g = v.ctx; v.begin();
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
    $('fatigueNote').textContent = red ? `${red} posisi merah` : 'blok 5 menit terakhir';
  }

  function feedThumb(canvas, frame, ev) {
    const i = Math.round((frame - meta.first) / (meta.fps / meta.sample_fps));
    const v = new PitchView(canvas, { m: 1 }); v.layout(84); v.begin();
    const g = v.ctx;
    if (i >= 0 && i < nFrames) for (const p of framePlayers(i)) { const [a, b] = v.S(p.x, p.y); g.beginPath(); g.arc(a, b, 2.2, 0, 7); g.fillStyle = p.team === 'H' ? lineup.kitH : lineup.kitA; g.fill(); }
    if (ev.kind === 'fatigue' && ev.team === 'H') { const m = meta.role_means.H[ev.label]; if (m) { const [a, b] = v.S(52 + m[0] * 2.2, W / 2 + (m[1] - W / 2) * 1.5); g.beginPath(); g.arc(a, b, 6, 0, 7); g.strokeStyle = COL.bad; g.lineWidth = 2; g.stroke(); } }
    if (ev.free) { const [fx, fy] = tf(ev.free[0], ev.free[1]); const [a, b] = v.S(fx, fy); g.beginPath(); g.arc(a, b, 7, 0, 7); g.strokeStyle = '#fff'; g.setLineDash([2, 2]); g.lineWidth = 1.2; g.stroke(); g.setLineDash([]); }
  }
  const ZONE = { 'defensive third': 'sepertiga sendiri', 'middle third': 'tengah', 'final third': 'sepertiga akhir' };
  function eventView(e) {
    const opp = (lineup.oppName || meta.teams.A).split(' ')[0];
    if (e.kind === 'fatigue') return e.team === 'H'
      ? { title: `${nameOf(e.label)} mulai lelah · ${e.risk}`, dot: COL.bad }
      : { title: `${opp}: ${e.label} melemah · ${e.risk}`, dot: COL.ok };
    if (e.kind === 'shape') {
      const m = e.messages[0], deep = m.match(/(\d+) m deeper/), loose = m.match(/(\d+)% less compact/);
      const what = deep ? `garis turun ${deep[1]} m` : loose ? `blok renggang ${loose[1]}%` : m;
      return e.team === 'H' ? { title: `Kita: ${what}`, dot: COL.warn } : { title: `${opp}: ${what}`, dot: COL.shadow };
    }
    return e.team === 'H' ? { title: `Rebut bola di ${ZONE[e.zone]}`, dot: COL.shadow } : { title: `Serangan balik ${opp}`, dot: COL.bad };
  }
  function feed(f) {
    if (narrow()) return;
    const all = C.events.filter((e) => e.frame <= f), evs = all.slice(-8).reverse();
    const k = evs.map((e) => e.frame + e.kind + (e.label || '')).join('|');
    if (k === S.feedKey) return; S.feedKey = k;
    $('feedCount').textContent = all.length ? String(all.length) : '';
    if (!evs.length) { $('feed').innerHTML = '<p class="empty">Insight muncul saat data cukup.</p>'; return; }
    $('feed').innerHTML = evs.map((e) => {
      const id = e.frame + e.kind + (e.label || ''), fresh = !S.seen.has(id); S.seen.add(id);
      const vw = eventView(e);
      return `<button type="button" class="ev${fresh ? ' new' : ''}" data-frame="${e.frame}"><canvas></canvas>
        <span class="t"><b>${esc(vw.title)}</b><span><i class="dot" style="background:${vw.dot}"></i>${clockText(e.frame)}</span></span></button>`;
    }).join('');
    $('feed').querySelectorAll('.ev').forEach((el, i) => {
      feedThumb(el.querySelector('canvas'), evs[i].frame, evs[i]);
      el.onclick = () => { const t = (+el.dataset.frame - meta.first) / meta.fps - 3; if (t >= 0 && t <= duration) { takeOver(); S.t = t; } };
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
      cell('Pressing', now ? fmt1(now.pr) : '–', before ? `b1 ${fmt1(before.pr)}` : '', before && now && now.pr < before.pr),
      cell('Rebut ≤5 dtk', now ? Math.round(now.reg * 100) + '%' : '–', before ? `b1 ${Math.round(before.reg * 100)}%` : '', before && now && now.reg < before.reg),
      cell('Garis', line != null ? Math.round(line) + ' m' : '–', ref ? `b1 ${Math.round(ref)}` : '', ref && line != null && line - ref > 3),
      cell('Keluar bentuk', S.outOfShape != null ? `${S.outOfShape}/10` : '–', 'Shadow Team', S.outOfShape >= 3),
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
      const pl = S.team === 'H' ? roleToPlayer[r.role] : null, s = fat[r.k], lvl = s && s.half === meta.half ? s.level : 'no data';
      const kmh = speed[r.k];
      return `<button type="button" class="prow${S.sel === r.k ? ' sel' : ''}" data-k="${r.k}" style="--kit:var(--${S.team === 'H' ? 'home' : 'away'})">
        ${avatar(pl, S.team, r.role)}
        <span class="who"><b>${esc(pl ? pl.name : r.role)}</b><span>${r.role}${pl && pl.slot && pl.slot !== r.role ? ' · ' + pl.slot : ''}</span></span>
        <span class="dist">${fmt1(r.v[0] / 1000)} km<i style="--w:${(r.v[0] / max * 100).toFixed(1)}%"></i></span>
        <span class="spd${kmh > 19.8 ? ' hot' : ''}">${kmh == null ? '–' : Math.round(kmh)}<small> km/j</small></span>
        <span class="spr">${r.v[2]}×</span>
        <span class="risk" style="background:${LEVEL[lvl]}" title="Risiko lelah ${s && s.risk != null ? s.risk : '–'}"></span></button>`;
    }).join('');
    $('plist').querySelectorAll('.prow').forEach((el) => el.onclick = () => { S.sel = S.sel === el.dataset.k ? null : el.dataset.k; panels(true); });
    detail(rows, fat, si, force);
  }
  function detail(rows, fat, si, force) {
    const k = S.sel || (rows[0] && rows[0].k); if (!k) return;
    const role = k.split(':')[1], team = k[0], arr = C.seconds.movement[k]; if (!arr) return;
    const v = arr[si], pl = team === 'H' ? roleToPlayer[role] : null, s = fat[k];
    $('pdStats').innerHTML = `<div class="pd-name"><b>${esc(pl ? pl.name : role)}</b><span>${role} · ${team === 'H' ? meta.teams.H : (lineup.oppName || meta.teams.A)}</span></div>
      <div><b>${fmt1(v[0] / 1000)}</b><span>km sejak kick-off</span></div><div><b>${fmt1(v[3])}</b><span>km/j tercepat</span></div>
      <div><b>${v[2]}</b><span>sprint</span></div><div><b style="color:${s ? LEVEL[s.level] : 'inherit'}">${s && s.risk != null ? s.risk : '–'}</b><span>risiko lelah</span></div>`;
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
  function momentumChart(f) {
    const c = $('momentum'), w = c.clientWidth, h = 46, d = window.devicePixelRatio || 1;
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
  const LANES = ['kiri', 'tengah', 'kanan'];
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
  function channels(f, st) {
    const v = channelsV; if (!v) return; const g = v.ctx; v.begin();
    const cnt = channelCounts(f, 15), ys = [W / 6, W / 2, 5 * W / 6];
    const draw = (team, x0, x1, color) => cnt[team].forEach((n, k) => {
      if (!n) { v.path([[x0, ys[k]], [x1, ys[k]]]); g.save(); g.setLineDash([2, 5]); g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 1; g.stroke(); g.restore(); return; }
      v.arrow(x0, ys[k], x1, ys[k], color, Math.min(10, 2 + n * 1.3));
      v.label(String(n), x0, ys[k], 0, { size: 11, mono: true });
    });
    draw('H', 58, 92, lineup.kitH); draw('A', 47, 13, lineup.kitA);
    const ko = keyOpponent(st, Math.max(0, Math.floor(S.t)));
    const opp = (lineup.oppName || meta.teams.A).split(' ')[0];
    $('watch').innerHTML = `Panah = masuk sepertiga akhir (kanan: kita, kiri: ${esc(opp)}).` +
      (ko && ko.score > 30 ? ` Awasi <b>${ko.role} ${esc(opp)}</b>: ${Math.round(ko.frac * 100)}% waktu dekat gawang kita, ${ko.spr} sprint 10 menit terakhir.` : '');
    S.keyOpp = ko;
  }

  // The three things to know right now, ranked. Each comes from a module above.
  const oosHist = [];
  function priorities(f, st, si) {
    const items = [], opp = (lineup.oppName || meta.teams.A).split(' ')[0];
    const fat = latestStamina(f);
    const red = Object.values(fat).filter((r) => r.team === 'H' && r.half === meta.half && r.level === 'red').sort((a, b) => b.risk - a.risk);
    if (red.length) items.push({ score: 90 + red[0].risk / 10, color: COL.bad, title: `Siapkan pergantian: ${nameOf(red[0].label)}`,
      sub: `Risiko lelah ${red[0].risk} · lari cepat ${Math.round(red[0].hsr * 100)}% dari awal` + (red.length > 1 ? ` · juga ${red.slice(1).map((r) => nameOf(r.label)).join(', ')}` : '') });
    const dangerA = C.transitions.filter((t) => t.won_by === 'A' && t.dangerous && t.frame <= f && t.frame > f - 10 * 60 * meta.fps).length;
    if (dangerA >= 2) items.push({ score: 80 + dangerA, color: COL.bad, title: `Waspada serangan balik ${opp}`, sub: `${dangerA} transisi berbahaya dalam 10 menit` });
    const cnt = channelCounts(f, 15).A, tot = cnt.reduce((a, b) => a + b, 0), top = cnt.indexOf(Math.max(...cnt));
    const second = [...cnt].sort((a, b) => b - a)[1];
    if (tot >= 3 && cnt[top] / tot >= 0.5 && cnt[top] > second) items.push({ score: 70 + cnt[top], color: COL.warn, title: `${opp} masuk lewat sisi ${LANES[top]} kita`, sub: `${cnt[top]} dari ${tot} serangan 15 menit terakhir` });
    const h1n = C.momentum.filter((m) => m[0] === 1).length;
    const nowI = Math.min(C.momentum.length - 1, (meta.half === 2 ? h1n : 0) + Math.floor((f - meta.half_start) / meta.fps / 60));
    const recent = C.momentum.slice(Math.max(0, nowI - 4), nowI + 1);
    if (recent.length) {
      const att = recent.reduce((s, m) => s + m[2], 0) / recent.length, def = recent.reduce((s, m) => s + m[3], 0) / recent.length;
      if (def > att + 0.1) items.push({ score: 62, color: COL.warn, title: `${opp} sedang menekan`, sub: `Bola ${Math.round(def * 100)}% di sepertiga kita, 5 menit terakhir` });
      else if (att > def + 0.15) items.push({ score: 35, color: COL.ok, title: 'Momentum milik kita', sub: `Bola ${Math.round(att * 100)}% di sepertiga ${opp}, 5 menit terakhir` });
    }
    if (S.outOfShape != null) { oosHist.push(S.outOfShape); if (oosHist.length > 20) oosHist.shift(); }
    const oos = oosHist.length ? oosHist.reduce((a, b) => a + b, 0) / oosHist.length : 0;
    if (oos >= 2.5) items.push({ score: 66, color: COL.warn, title: 'Bentuk bertahan pecah', sub: `Rata-rata ${Math.round(oos)} pemain jauh dari Shadow Team saat ${opp} menguasai bola` });
    if (S.adv && S.adv.dropTo) items.push({ score: 64, color: COL.shadow, title: `Turunkan garis ${Math.round(S.adv.ourLine - S.adv.dropTo)} m`, sub: `${S.adv.tiredCB.join(' + ')} lelah, ruang di belakang garis` });
    if (S.keyOpp && S.keyOpp.score > 45) items.push({ score: 55, color: COL.warn, title: `Awasi ${S.keyOpp.role} ${opp}`, sub: `${Math.round(S.keyOpp.frac * 100)}% waktu dekat gawang kita · ${S.keyOpp.spr} sprint` });
    if (S.adv && S.adv.atkLane) items.push({ score: 50, color: COL.shadow, title: `Peluang: serang lewat ${S.adv.atkLane}`, sub: `Ruang ${Math.round(S.adv.atkFree)} m` + (S.adv.runner ? ` · ${nameOf(S.adv.runner)} lari ke zona` : '') });
    const top3 = items.sort((a, b) => b.score - a.score).slice(0, 3);
    const html = top3.length ? top3.map((it) => `<div class="pi"><i style="background:${it.color}"></i><div><b>${esc(it.title)}</b><span>${esc(it.sub)}</span></div></div>`).join('')
      : '<p class="empty">Belum ada yang mendesak.</p>';
    if ($('prio').innerHTML !== html) $('prio').innerHTML = html;
    if ($('prioPhone').innerHTML !== html) $('prioPhone').innerHTML = html;
  }

  // ================================================================== loop
  let last = performance.now(), lastPanel = -1;
  function panels(force) {
    const st = interp(S.t), f = videoFrame(S.t), si = Math.max(0, Math.min(C.seconds.frames.length - 1, Math.floor(S.t)));
    squad(st, f, si, force); strip(f); advice(st);
    if (!narrow()) { feed(f); fatigueMap(f); stats(f, si); momentumChart(f); channels(f, st); }
    priorities(f, st, si);
  }
  function loop(now) {
    const dt = (now - last) / 1000; last = now;
    if ($('live').hidden) { requestAnimationFrame(loop); return; }
    if (S.playing) { S.t = Math.min(duration, S.t + dt * S.speed); if (S.t >= duration) S.playing = false; }
    const st = interp(S.t);
    drawMain(st);
    $('scrub').value = S.t;
    $('playBtn').classList.toggle('on', S.playing);
    $('clock').textContent = clockText(st.frame);
    const pe = $('poss'), opp = (lineup.oppName || meta.teams.A).split(' ')[0];
    pe.innerHTML = st.poss === 'D' ? '<i style="background:#6B7280"></i>Bola mati'
      : `<i style="background:${st.poss === 'H' ? lineup.kitH : lineup.kitA}"></i>${st.poss === 'H' ? meta.teams.H : opp}`;
    const half = Math.floor(S.t * 2) / 2;
    if (half !== lastPanel) { lastPanel = half; panels(false); }
    requestAnimationFrame(loop);
  }
})();
