/* Shadow Ball demo: replays one clip "as live". The laptop leads; phones follow its clock
   through /api/state (python run.py serve). Data: /data/clip.json (python run.py demo). */
(function () {
  'use strict';
  const COLORS = { H: '#5B9BFF', A: '#FF9447', D: '#3B4A41', X: '#3B4A41' };
  const LEVEL = { red: '#FF6B6B', amber: '#F5C451', green: '#7FD48A', 'no data': '#5D6B63' };
  const $ = (id) => document.getElementById(id);
  const fmt1 = (v) => v.toFixed(1).replace('.', ',');
  const params = new URLSearchParams(location.search);
  const narrow = () => matchMedia('(max-width: 900px)').matches;

  let C, meta, labels, nFrames, duration;
  const inClip = new Set();          // roles that appear in this clip (team:label)
  const S = { t: 0, playing: false, speed: 1, team: 'H', sel: null, labels: true, shadow: true, space: true,
              follow: false, lastFeedKey: '', seenEvents: new Set() };

  fetch('data/clip.json').then((r) => {
    if (!r.ok) throw new Error('clip.json tidak ditemukan: jalankan python run.py demo');
    return r.json();
  }).then(init).catch((e) => { $('loading').textContent = e.message; });

  function init(clip) {
    C = clip; meta = C.meta; labels = meta.labels;
    if (meta.teams.A === 'Atletic Club') meta.teams.A = 'Athletic Club';   // spelling in the data file
    nFrames = C.frames.length; duration = (nFrames - 1) / meta.sample_fps;
    for (const fr of C.frames) for (const p of fr[3]) inClip.add(`${p[1] === 0 ? 'H' : 'A'}:${labels[p[2]]}`);
    S.follow = params.get('mode') === 'follow' || (params.get('mode') !== 'lead' && narrow());
    $('matchName').textContent = `${meta.teams.H} – ${meta.teams.A} · replay ${meta.minute_from}'–${meta.minute_to}' · ${meta.model}`;
    $('formations').textContent = `${meta.teams.H} ${meta.formation.H} · ${meta.teams.A} ${meta.formation.A}`;
    $('legH').textContent = `${meta.teams.H} (tim kita)`;
    $('legA').textContent = meta.teams.A;
    $('tabA').textContent = meta.teams.A.split(' ')[0];
    $('scrub').max = duration;
    $('followBtn').hidden = false;
    bindUI();
    resize();
    addEventListener('resize', resize);
    $('loading').classList.add('gone');
    if (!S.follow) S.playing = params.get('autoplay') !== '0';
    updateFollowBtn();
    requestAnimationFrame(loop);
    setInterval(sync, 600);
  }

  // ------------------------------------------------------------------ time
  const frameAt = (t) => C.frames[Math.max(0, Math.min(nFrames - 1, Math.floor(t * meta.sample_fps)))];
  const videoFrame = (t) => meta.first + Math.round(t * meta.fps);
  function clockText(f) {
    const half = meta.half, s = (f - meta.half_start) / meta.fps + (half === 2 ? 45 * 60 : 0);
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `Babak ${half} · ${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  let last = performance.now(), lastPanels = -1;
  function loop(now) {
    const dt = (now - last) / 1000; last = now;
    if (S.playing) {
      S.t = Math.min(duration, S.t + dt * S.speed);
      if (S.t >= duration) S.playing = false;
    }
    drawPitch();
    $('scrub').value = S.t;
    $('playBtn').innerHTML = S.playing ? '&#10073;&#10073;' : '&#9654;';
    $('playBtn').setAttribute('aria-label', S.playing ? 'Jeda' : 'Putar');
    const sec = Math.floor(S.t * 2) / 2;
    if (sec !== lastPanels) { lastPanels = sec; panels(); }
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------------ lead / follow sync
  let lastPost = 0;
  function sync() {
    if (S.follow) {
      fetch('api/state', { cache: 'no-store' }).then((r) => r.json()).then((st) => {
        if (st.frame == null) return;
        let t = (st.frame - meta.first) / meta.fps;
        if (st.playing) t += (st.now - st.t) * st.speed;
        if (Math.abs(t - S.t) > 1.0 || S.playing !== st.playing) S.t = Math.max(0, Math.min(duration, t));
        S.playing = st.playing; S.speed = st.speed; markSpeed();
      }).catch(() => {});
    } else if (performance.now() - lastPost > 500) {
      lastPost = performance.now();
      fetch('api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frame: videoFrame(S.t), playing: S.playing, speed: S.speed }) }).catch(() => {});
    }
  }
  function updateFollowBtn() {
    $('followBtn').textContent = S.follow ? 'Ikuti laptop: aktif' : 'Ikuti laptop: mati';
  }

  // ------------------------------------------------------------------ UI
  function bindUI() {
    $('playBtn').onclick = () => { S.follow = false; updateFollowBtn(); S.playing = !S.playing; if (S.t >= duration) S.t = 0; };
    $('scrub').oninput = (e) => { S.follow = false; updateFollowBtn(); S.t = +e.target.value; };
    document.querySelectorAll('.speeds button').forEach((b) => b.onclick = () => {
      S.follow = false; updateFollowBtn(); S.speed = +b.dataset.speed; markSpeed();
    });
    document.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = () => {
      const k = b.dataset.toggle; S[k] = !S[k]; b.classList.toggle('on', S[k]);
    });
    document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
      S.team = b.dataset.team; S.sel = null;
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b)); panels();
    });
    $('followBtn').onclick = () => { S.follow = !S.follow; updateFollowBtn(); };
    addEventListener('keydown', (e) => {
      if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); $('playBtn').click(); }
      if (e.code === 'ArrowRight') S.t = Math.min(duration, S.t + 10);
      if (e.code === 'ArrowLeft') S.t = Math.max(0, S.t - 10);
    });
    $('pitch').addEventListener('click', pickOnPitch);
  }
  function markSpeed() {
    document.querySelectorAll('.speeds button').forEach((b) => b.classList.toggle('on', +b.dataset.speed === S.speed));
  }

  // ------------------------------------------------------------------ pitch
  const cv = $('pitch'), ctx = cv.getContext('2d');
  // On a phone the pitch stands upright (rotated 90 degrees: attacking right becomes attacking
  // up), so it fills the screen. Everything is drawn in landscape coordinates through the
  // canvas transform; text is drawn upright at the transformed screen point.
  let W, H, LW, scale, M = 2.5, dpr = 1, portrait = false, lastPlayers = [];
  function resize() {
    const wrap = cv.parentElement.clientWidth;
    const [L, Wd] = meta.pitch;
    portrait = narrow();
    dpr = window.devicePixelRatio || 1;
    scale = wrap / ((portrait ? Wd : L) + 2 * M);
    LW = (L + 2 * M) * scale;
    W = wrap; H = Math.round((portrait ? L : Wd) * scale + 2 * M * scale);
    cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
  }
  function world() {
    if (portrait) ctx.setTransform(0, -dpr, dpr, 0, 0, LW * dpr);
    else ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const toScreen = (lx, ly) => (portrait ? [ly, LW - lx] : [lx, ly]);
  const px = (x) => (x + M) * scale, py = (y) => (y + M) * scale;

  function lines() {
    const [L, Wd] = meta.pitch, s = scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.lineWidth = Math.max(1, s * 0.15);
    ctx.strokeRect(px(0), py(0), L * s, Wd * s);
    ctx.beginPath(); ctx.moveTo(px(L / 2), py(0)); ctx.lineTo(px(L / 2), py(Wd)); ctx.stroke();
    ctx.beginPath(); ctx.arc(px(L / 2), py(Wd / 2), 9.15 * s, 0, 2 * Math.PI); ctx.stroke();
    for (const side of [0, 1]) {
      const x0 = side ? L - 16.5 : 0, x6 = side ? L - 5.5 : 0;
      ctx.strokeRect(px(x0), py(Wd / 2 - 20.16), 16.5 * s, 40.32 * s);
      ctx.strokeRect(px(x6), py(Wd / 2 - 9.16), 5.5 * s, 18.32 * s);
      const spot = side ? L - 11 : 11;
      ctx.beginPath(); ctx.arc(px(spot), py(Wd / 2), 9.15 * s, side ? Math.PI - 0.93 : -0.93, side ? Math.PI + 0.93 : 0.93);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(side ? px(L) : px(-1.5), py(Wd / 2 - 3.66), 1.5 * s, 7.32 * s);
    }
  }

  function interp(t) {
    const i = Math.max(0, Math.min(nFrames - 1, Math.floor(t * meta.sample_fps)));
    const a = C.frames[i], b = C.frames[Math.min(nFrames - 1, i + 1)];
    const k = t * meta.sample_fps - i;
    const nb = new Map(b[3].map((p) => [p[0], p]));
    const players = a[3].map((p) => {
      const q = nb.get(p[0]);
      return q && q[2] === p[2] ? [p[0], p[1], p[2], p[3] + (q[3] - p[3]) * k, p[4] + (q[4] - p[4]) * k, p[5]] : p;
    });
    let ball = a[2];
    if (a[2] && b[2]) ball = [a[2][0] + (b[2][0] - a[2][0]) * k, a[2][1] + (b[2][1] - a[2][1]) * k, a[2][2], a[2][3]];
    return { frame: a[0], poss: a[1], players, ball, idx: i };
  }

  function drawPitch() {
    const s = scale, st = interp(S.t);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    world();
    lines();
    // free space after a dangerous turnover (shown for 6 s)
    if (S.space) {
      const f = videoFrame(S.t);
      const ev = C.transitions.filter((t) => t.dangerous && t.free && t.frame <= f && f - t.frame < 6 * meta.fps).pop();
      if (ev) {
        const [fx, fy, d] = ev.free, r = Math.min(d, 14) * s;
        ctx.save(); ctx.setLineDash([6, 5]);
        ctx.fillStyle = 'rgba(255,148,71,0.16)'; ctx.strokeStyle = 'rgba(255,148,71,0.8)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(px(fx), py(fy), r, 0, 2 * Math.PI); ctx.fill(); ctx.stroke(); ctx.restore();
        label(`Ruang kosong ${Math.round(d)} m`, px(fx), py(fy), -r - 6, '#FFC79E', 12);
      }
    }
    // trail of the selected role (last 5 s)
    if (S.sel) {
      const [team, lab] = S.sel.split(':'), li = labels.indexOf(lab), tc = team === 'H' ? 0 : 1;
      ctx.beginPath(); let started = false;
      for (let i = Math.max(0, st.idx - 5 * meta.sample_fps); i <= st.idx; i++) {
        const p = C.frames[i][3].find((q) => q[1] === tc && q[2] === li);
        if (!p) continue;
        if (!started) { ctx.moveTo(px(p[3]), py(p[4])); started = true; } else ctx.lineTo(px(p[3]), py(p[4]));
      }
      ctx.strokeStyle = 'rgba(184,243,90,0.7)'; ctx.lineWidth = 2.5; ctx.stroke();
    }
    const red = redRoles(videoFrame(S.t));
    const r = Math.max(6, 1.15 * s);
    lastPlayers = st.players;
    for (const p of st.players) {
      const [, team, li, x, y] = p, side = team === 0 ? 'H' : 'A', lab = labels[li];
      const key = `${side}:${lab}`;
      ctx.beginPath(); ctx.arc(px(x), py(y), r, 0, 2 * Math.PI);
      ctx.fillStyle = COLORS[side]; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#0E1512'; ctx.stroke();
      if (red.has(key)) { ctx.beginPath(); ctx.arc(px(x), py(y), r + 4, 0, 2 * Math.PI); ctx.strokeStyle = '#FF6B6B'; ctx.lineWidth = 2.5; ctx.stroke(); }
      if (S.sel === key) { ctx.beginPath(); ctx.arc(px(x), py(y), r + 7, 0, 2 * Math.PI); ctx.strokeStyle = '#B8F35A'; ctx.lineWidth = 3; ctx.stroke(); }
      if (S.labels) label(lab, px(x), py(y), r + (portrait ? 11 : 13), side === 'H' ? '#CFE0FF' : '#FFD8BC', portrait ? 10.5 : 12);
    }
    // ball: seen = solid; model = dashed ring sized by its uncertainty
    const b = st.ball;
    if (b) {
      if (b[2] === 1) {
        if (S.shadow) {
          ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
          ctx.fillStyle = 'rgba(255,255,255,0.12)';
          ctx.beginPath(); ctx.arc(px(b[0]), py(b[1]), Math.max(8, Math.min(b[3], 8) * s * 0.6), 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
          ctx.restore();
          ctx.beginPath(); ctx.arc(px(b[0]), py(b[1]), Math.max(3, 0.55 * s), 0, 2 * Math.PI); ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fill();
        }
      } else {
        ctx.beginPath(); ctx.arc(px(b[0]), py(b[1]), Math.max(3.5, 0.6 * s), 0, 2 * Math.PI);
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#0E1512'; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }
    $('clock').textContent = clockText(st.frame);
    const poss = currentPossession(st.idx);
    const pe = $('poss');
    pe.textContent = poss === 'D' ? 'Bola mati' : poss === 'H' ? `${meta.teams.H} menguasai` : `${meta.teams.A.split(' ')[0]} menguasai`;
    pe.style.background = poss === 'D' ? '#26332C' : COLORS[poss]; pe.style.color = poss === 'D' ? '#E8EEE9' : '#0E1512';
  }
  function label(text, lx, ly, dy, color, size) {
    const [x0, y0] = toScreen(lx, ly), x = x0, y = y0 + dy;
    ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `600 ${size}px ui-monospace, Menlo, Consolas, monospace`; ctx.textAlign = 'center';
    ctx.lineWidth = 3.5; ctx.strokeStyle = '#0E1512'; ctx.lineJoin = 'round'; ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
    ctx.restore();
  }
  function currentPossession(i) {
    for (let k = i; k >= 0; k--) if (C.frames[k][1] !== 'X') return C.frames[k][1];
    return 'D';
  }
  function pickOnPitch(e) {
    const rect = cv.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best = null, bd = 22;
    for (const p of lastPlayers) {
      const [sx, sy] = toScreen(px(p[3]), py(p[4]));
      const d = Math.hypot(sx - x, sy - y);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) { S.sel = null; panels(); return; }
    const side = best[1] === 0 ? 'H' : 'A', key = `${side}:${labels[best[2]]}`;
    S.sel = S.sel === key ? null : key;
    if (S.team !== side) document.querySelector(`.tabs button[data-team="${side}"]`).click();
    panels();
  }

  // ------------------------------------------------------------------ knowledge at time t
  function blockEnd(half, minute) {
    if (half < meta.half) return -Infinity;
    return meta.half_start + (minute + 5 - (half === 1 ? 0 : 45)) * 60 * meta.fps;
  }
  function latestStamina(f) {
    const out = {};
    for (const r of C.stamina) if (blockEnd(r.half, r.minute) <= f) out[`${r.team}:${r.label}`] = r;
    return out;
  }
  function redRoles(f) {
    const set = new Set(), st = latestStamina(f);
    for (const k in st) if (st[k].level === 'red' && st[k].half === meta.half) set.add(k);
    return set;
  }

  // ------------------------------------------------------------------ panels (twice per second)
  function panels() {
    const f = videoFrame(S.t), si = Math.max(0, Math.min(C.seconds.frames.length - 1, Math.floor(S.t)));
    moveTable(f, si);
    if (narrow()) return;
    feed(f); fatigue(f); timeline(f); kpis(f, si);
  }

  function moveTable(f, si) {
    const st = latestStamina(f), now = interp(S.t);
    const speedOf = {};
    for (const p of now.players) speedOf[`${p[1] === 0 ? 'H' : 'A'}:${labels[p[2]]}`] = p[5];
    const rows = Object.entries(C.seconds.movement).filter(([k]) => inClip.has(k) && k.startsWith(S.team + ':'))
      .map(([k, arr]) => ({ k, lab: k.split(':')[1], v: arr[si] }))
      .sort((a, b) => b.v[0] - a.v[0]);
    const max = Math.max(1, ...rows.map((r) => r.v[0]));
    const col = COLORS[S.team];
    $('moveRows').innerHTML = rows.map((r) => {
      const s = st[r.k], lvl = s ? s.level : 'no data';
      const kmh = (speedOf[r.k] || 0) * 3.6;
      return `<div class="trow${S.sel === r.k ? ' sel' : ''}" data-k="${r.k}">
        <span class="pos" style="color:${col}">${r.lab}</span>
        <span class="dist"><span class="bar"><i style="width:${(r.v[0] / max * 100).toFixed(1)}%;background:${col}"></i></span><span>${fmt1(r.v[0] / 1000)} km</span></span>
        <span class="r" style="color:${kmh > 19.8 ? '#B8F35A' : 'inherit'}">${speedOf[r.k] === undefined ? '–' : Math.round(kmh)}</span>
        <span class="r">${r.v[1]} m</span>
        <span class="r">${r.v[2]}</span>
        <span class="r">${fmt1(r.v[3])}</span>
        <span class="r" style="color:${LEVEL[lvl]}">${s && s.risk != null ? s.risk : '–'}</span></div>`;
    }).join('');
    $('moveRows').querySelectorAll('.trow').forEach((el) => el.onclick = () => {
      S.sel = S.sel === el.dataset.k ? null : el.dataset.k; panels();
    });
  }

  const ZONE = { 'defensive third': 'sepertiga sendiri', 'middle third': 'tengah', 'final third': 'sepertiga akhir' };
  function shapeText(m) {
    let x = m.match(/defensive line (\d+) m deeper/);
    if (x) return `garis pertahanan ${x[1]} m lebih dalam dari awal babak`;
    x = m.match(/block (\d+)% less compact/);
    if (x) return `blok ${x[1]}% kurang rapat dari awal babak`;
    return m;
  }
  function eventCard(e) {
    const tm = (f) => clockText(f).split('· ')[1];
    const nameH = meta.teams.H, nameA = meta.teams.A.split(' ')[0];
    if (e.kind === 'fatigue') {
      const who = e.team === 'H' ? nameH : nameA;
      return { cls: e.team === 'H' ? 'fatigue' : 'chance', tag: e.team === 'H' ? 'ALERT KELELAHAN' : 'LAWAN MELEMAH',
        title: `${e.label} ${who}: risiko lelah ${e.risk}`,
        body: `Lari intensitas tinggi ${Math.round(e.hsr * 100)}% dan jarak ${Math.round(e.dist * 100)}% dibanding 15 menit pertama (blok ${e.minute}'–${e.minute + 5}'). Cek juga konteks: tim yang lama menguasai bola lebih jarang sprint.`, time: tm(e.frame) };
    }
    if (e.kind === 'shape') {
      const who = e.team === 'H' ? nameH : nameA;
      return { cls: e.team === 'H' ? 'danger' : 'chance', tag: 'BENTUK TIM',
        title: `${who}: ${shapeText(e.messages[0])}`,
        body: e.team === 'H' ? 'Tim kita mundur: ruang di depan garis untuk lawan.' : `Lawan bertahan lebih dalam (blok ${e.minute}'–${e.minute + 5}'): ruang di antara lini dan di depan kotak penalti.`, time: tm(e.frame) };
    }
    const mine = e.team === 'H';
    return { cls: mine ? 'chance' : 'danger', tag: mine ? 'TRANSISI · PELUANG' : 'TRANSISI · BAHAYA',
      title: mine ? `${nameH} merebut bola di ${ZONE[e.zone]}` : `${nameA} serangan balik dari ${ZONE[e.zone]}`,
      body: (e.goal_side <= 1 ? `Hampir tidak ada pemain ${mine ? nameA : nameH} di belakang bola saat bola berpindah.`
        : `Hanya ${e.goal_side} pemain ${mine ? nameA : nameH} di belakang bola saat bola berpindah.`) +
        (e.free ? ` Ruang kosong ${Math.round(e.free[2])} m di depan bola.` : ''), time: tm(e.frame) };
  }
  function feed(f) {
    const evs = C.events.filter((e) => e.frame <= f).slice(-10).reverse();
    const key = evs.map((e) => e.frame + e.kind + (e.label || '')).join('|');
    $('feedCount').textContent = evs.length ? `${C.events.filter((e) => e.frame <= f).length} insight` : '';
    if (key === S.lastFeedKey) return;
    S.lastFeedKey = key;
    if (!evs.length) { $('feed').innerHTML = '<p class="empty">Belum ada insight. Insight muncul saat data cukup (blok 5 menit, transisi).</p>'; return; }
    $('feed').innerHTML = evs.map((e) => {
      const c = eventCard(e), id = e.frame + e.kind + (e.label || ''), fresh = !S.seenEvents.has(id);
      S.seenEvents.add(id);
      return `<button type="button" class="ev ${c.cls}${fresh ? ' new' : ''}" data-frame="${e.frame}">
        <span class="meta"><span>${c.tag}</span><span>${c.time}</span></span>
        <span class="title">${c.title}</span><span class="body">${c.body}</span></button>`;
    }).join('');
    $('feed').querySelectorAll('.ev').forEach((el) => el.onclick = () => {
      const t = (+el.dataset.frame - meta.first) / meta.fps - 3;
      if (t >= 0 && t <= duration) { S.follow = false; updateFollowBtn(); S.t = t; }
    });
  }

  function fatigue(f) {
    const st = latestStamina(f);
    const rows = Object.values(st).filter((r) => r.team === 'H' && r.half === meta.half && r.risk != null)
      .sort((a, b) => b.risk - a.risk).slice(0, 6);
    $('fatigue').innerHTML = rows.length ? rows.map((r) => `<div class="bar-row">
      <div class="lbl"><span>${r.label} <span class="muted">· ${r.minute}'–${r.minute + 5}'</span></span><span style="color:${LEVEL[r.level]}">${r.risk}</span></div>
      <div class="bar"><i style="width:${r.risk}%;background:${LEVEL[r.level]}"></i></div></div>`).join('')
      : '<p class="empty">Menunggu blok 5 menit pertama babak ini.</p>';
  }

  function timeline(f) {
    const nowMin = (f - meta.half_start) / meta.fps / 60;
    const h1 = C.timeline.filter((m) => m[0] === 1).length, total = h1 + 50;
    const cur = C.timeline.filter((m, i) => m[0] < meta.half || (i - h1) <= nowMin);
    const w = (100 / total).toFixed(3);
    $('timeline').innerHTML = cur.map((m) => `<i style="width:${w}%;background:${COLORS[m[1]]}"></i>`).join('');
    const live = cur.filter((m) => m[1] !== 'D'), hs = live.filter((m) => m[1] === 'H').length;
    $('possShare').innerHTML = live.length ? `Menit dikuasai: <b style="color:${COLORS.H}">${meta.teams.H} ${Math.round(hs / live.length * 100)}%</b> · abu-abu = bola mati` : '';
    $('tickHalf').style.left = (h1 / total * 100) + '%';
    $('tickHalf').textContent = `45'`;
    const nowPct = (h1 + nowMin) / total * 100;
    $('tickNow').style.left = Math.min(92, nowPct) + '%';
    $('tickNow').textContent = `${Math.floor(45 + nowMin)}' sekarang`;
  }

  function median(a) { const b = a.filter((v) => v != null).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; }
  function kpis(f, si) {
    const tr = C.transitions.filter((t) => t.frame <= f && t.won_by === 'A');
    const cp = (h) => { const x = tr.filter((t) => t.half === h); return x.length ? { n: x.length, reg: x.filter((t) => t.regained).length / x.length, pr: x.reduce((s, t) => s + t.pressers, 0) / x.length } : null; };
    const now = cp(meta.half), before = meta.half === 2 ? cp(1) : null;
    const shp = C.seconds.shape.H.slice(Math.max(0, si - 60), si + 1).filter((r) => r[4] === 'o');
    const line = median(shp.map((r) => r[0])), wid = median(shp.map((r) => r[1])), dep = median(shp.map((r) => r[2]));
    const ref = (meta.shape_ref || {})['H_half1'] || {};
    const dangerA = C.transitions.filter((t) => t.frame <= f && t.won_by === 'A' && t.dangerous && t.half === meta.half).length;
    const card = (lbl, v, d, warn) => `<div class="kpi"><span class="muted">${lbl}</span><span class="v">${v}</span><span class="d${warn ? ' warn' : ''}">${d}</span></div>`;
    $('kpis').innerHTML = [
      card('Pemain menekan (≤10 m, 5 dtk setelah kehilangan bola)', now ? fmt1(now.pr) : '–',
        before ? `Babak 1: ${fmt1(before.pr)}` : '', before && now && now.pr < before.pr),
      card('Bola direbut balik ≤5 dtk', now ? Math.round(now.reg * 100) + '%' : '–',
        before ? `Babak 1: ${Math.round(before.reg * 100)}%` : '', before && now && now.reg < before.reg),
      card('Tinggi garis bertahan (60 dtk terakhir)', line != null ? Math.round(line) + ' m' : '–',
        ref.line_height_m && line != null ? `Babak 1: ${Math.round(ref.line_height_m)} m dari gawang sendiri` : 'saat tidak menguasai bola',
        ref.line_height_m && line != null && line - ref.line_height_m > 3),
      card('Bentuk saat bertahan', dep != null ? `${Math.round(dep)} × ${Math.round(wid)} m` : '–', 'Kedalaman × lebar'),
      card(`Serangan balik berbahaya ${meta.teams.A.split(' ')[0]}`, String(dangerA), `Babak ${meta.half} sampai sekarang`, dangerA > 0),
    ].join('');
  }
})();
