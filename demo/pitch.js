/* A drawable pitch for the playground and the home page: grass, lines, floodlight, player tokens,
   arrows, the dangerous-space glow and the ball. Coordinates in metres, x along the length
   (team H attacks +x). Narrow screens get an upright pitch with H attacking up. */
(function () {
  'use strict';
  function shade(hex, k) {
    const n = parseInt(hex.slice(1), 16), f = (c) => Math.round(k > 0 ? c + (255 - c) * k : c * (1 + k));
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }
  const ink = (hex) => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 170 ? '#14171C' : '#FFFFFF'; };
  const font = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'system-ui';

  function createBoard(cv, opts = {}) {
    const L = opts.L || 105, W = opts.W || 68, portraitBelow = opts.portraitBelow == null ? 600 : opts.portraitBelow;
    const g = cv.getContext('2d');
    let view = null, grass = null, heat = null;
    const B = { g, L, W };

    B.layout = () => {
      const w = cv.parentElement.clientWidth, d = window.devicePixelRatio || 1, m = 2, portrait = w < portraitBelow;
      const sc = w / ((portrait ? W : L) + 2 * m), h = Math.round(((portrait ? L : W) + 2 * m) * sc);
      cv.width = Math.round(w * d); cv.height = Math.round(h * d); cv.style.height = h + 'px';
      view = { w, h, d, m, sc, portrait }; grass = null; B.view = view;
      return view;
    };
    B.P = (x, y) => (view.portrait ? [(y + view.m) * view.sc, (L - x + view.m) * view.sc] : [(x + view.m) * view.sc, (y + view.m) * view.sc]);
    B.toPitch = (a, b) => (view.portrait ? [L - (b / view.sc - view.m), a / view.sc - view.m] : [a / view.sc - view.m, b / view.sc - view.m]);
    function pathPts(c, pts, close) { c.beginPath(); pts.forEach(([x, y], i) => { const [a, b] = B.P(x, y); i ? c.lineTo(a, b) : c.moveTo(a, b); }); if (close) c.closePath(); }
    function arcPts(cx, cy, r, a0 = 0, a1 = 2 * Math.PI, n = 48) { const o = []; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; o.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } return o; }
    function grassCanvas() {
      const off = document.createElement('canvas'); off.width = cv.width; off.height = cv.height; const c = off.getContext('2d');
      c.setTransform(view.d, 0, 0, view.d, 0, 0);
      const base = c.createLinearGradient(0, 0, 0, view.h); base.addColorStop(0, '#3B8A4E'); base.addColorStop(1, '#2C7140'); c.fillStyle = base; c.fillRect(0, 0, view.w, view.h);
      const n = 14; for (let k = 0; k < n; k++) { pathPts(c, [[-2 + k * (L + 4) / n, -2], [-2 + (k + 1) * (L + 4) / n, -2], [-2 + (k + 1) * (L + 4) / n, W + 2], [-2 + k * (L + 4) / n, W + 2]], true); c.fillStyle = k % 2 ? 'rgba(255,255,255,.045)' : 'rgba(0,0,0,.055)'; c.fill(); }
      const nz = document.createElement('canvas'); nz.width = nz.height = 96; const x = nz.getContext('2d'), im = x.createImageData(96, 96); let seed = 7;
      for (let i = 0; i < im.data.length; i += 4) { seed = (seed * 16807) % 2147483647; const v = seed / 2147483647, bl = v > 0.86 ? 255 : v < 0.14 ? 0 : 128; im.data[i] = im.data[i + 1] = im.data[i + 2] = bl; im.data[i + 3] = bl === 128 ? 0 : 20; }
      x.putImageData(im, 0, 0); c.fillStyle = c.createPattern(nz, 'repeat'); c.fillRect(0, 0, view.w, view.h);
      c.save(); c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = Math.max(1, 0.13 * view.sc); c.shadowColor = 'rgba(255,255,255,.35)'; c.shadowBlur = 1.5;
      const line = (pts, close) => { pathPts(c, pts, close); c.stroke(); };
      line([[0, 0], [L, 0], [L, W], [0, W]], true); line([[L / 2, 0], [L / 2, W]]); line(arcPts(L / 2, W / 2, 9.15));
      for (const side of [0, 1]) {
        const gx = side ? L : 0, s = side ? -1 : 1, a = Math.acos(5.5 / 9.15), spot = gx + s * 11;
        line([[gx, W / 2 - 20.16], [gx + s * 16.5, W / 2 - 20.16], [gx + s * 16.5, W / 2 + 20.16], [gx, W / 2 + 20.16]]);
        line([[gx, W / 2 - 9.16], [gx + s * 5.5, W / 2 - 9.16], [gx + s * 5.5, W / 2 + 9.16], [gx, W / 2 + 9.16]]);
        line(side ? arcPts(spot, W / 2, 9.15, Math.PI - a, Math.PI + a, 24) : arcPts(spot, W / 2, 9.15, -a, a, 24));
        line([[gx, W / 2 - 3.66], [gx - s * 1.6, W / 2 - 3.66], [gx - s * 1.6, W / 2 + 3.66], [gx, W / 2 + 3.66]]);
        const [px, py] = B.P(spot, W / 2); c.beginPath(); c.arc(px, py, Math.max(1.2, 0.25 * view.sc), 0, 7); c.fillStyle = 'rgba(255,255,255,.85)'; c.fill();
      }
      c.restore();
      const top = c.createRadialGradient(view.w * 0.5, -view.h * 0.25, view.h * 0.2, view.w * 0.5, view.h * 0.2, Math.max(view.w, view.h) * 0.9);
      top.addColorStop(0, 'rgba(255,255,240,.16)'); top.addColorStop(1, 'rgba(255,255,240,0)'); c.fillStyle = top; c.fillRect(0, 0, view.w, view.h);
      const vg = c.createRadialGradient(view.w / 2, view.h / 2, Math.min(view.w, view.h) * 0.35, view.w / 2, view.h / 2, Math.max(view.w, view.h) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,20,8,.30)'); c.fillStyle = vg; c.fillRect(0, 0, view.w, view.h);
      return off;
    }
    B.begin = () => {
      g.setTransform(view.d, 0, 0, view.d, 0, 0); g.clearRect(0, 0, view.w, view.h);
      if (!grass) grass = grassCanvas(); g.drawImage(grass, 0, 0, view.w, view.h);
    };
    // dangerous space: one pixel per model cell, scaled up with smoothing so it reads as a glow
    B.space = (danger, cell, kH, kA) => {
      if (!danger || !danger.length) return;
      const vmax = Math.max(...danger.map((d) => d[3])), cH = parseInt(kH.slice(1), 16), cA = parseInt(kA.slice(1), 16);
      const nx = Math.ceil(L / cell), ny = Math.ceil(W / cell);
      if (!heat || heat.width !== nx) { heat = document.createElement('canvas'); heat.width = nx; heat.height = ny; }
      const hc = heat.getContext('2d'), im = hc.createImageData(nx, ny);
      for (const [x, y, c, v] of danger) {
        const col = c > 0.5 ? cH : cA, a = 0.66 * Math.pow(v / vmax, 0.75) * Math.min(1, Math.abs(c - 0.5) * 2.4);
        const o = (Math.round(y / cell) * nx + Math.round(x / cell)) * 4;
        im.data[o] = col >> 16; im.data[o + 1] = (col >> 8) & 255; im.data[o + 2] = col & 255; im.data[o + 3] = Math.round(255 * a);
      }
      hc.putImageData(im, 0, 0);
      const k = cell * view.sc, m = view.m * view.sc, d = view.d;
      g.save(); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      if (view.portrait) g.setTransform(0, -k * d, k * d, 0, m * d, (L * view.sc + m) * d); else g.setTransform(k * d, 0, 0, k * d, m * d, m * d);
      g.drawImage(heat, 0, 0); g.restore();
    };
    B.token = (a, b, r, kit, ring) => {
      g.beginPath(); g.ellipse(a + r * 0.18, b + r * 0.62, r * 0.98, r * 0.42, 0, 0, 7); g.fillStyle = 'rgba(0,18,6,.32)'; g.fill();
      const body = g.createRadialGradient(a - r * 0.35, b - r * 0.4, r * 0.1, a, b, r * 1.05);
      body.addColorStop(0, shade(kit, 0.32)); body.addColorStop(0.55, kit); body.addColorStop(1, shade(kit, -0.28));
      g.beginPath(); g.arc(a, b, r, 0, 7); g.fillStyle = body; g.fill(); g.lineWidth = Math.max(1.2, r * 0.16); g.strokeStyle = ring || 'rgba(255,255,255,.92)'; g.stroke();
    };
    B.player = (x, y, r, kit, text, label, selected, accent) => {
      const [a, b] = B.P(x, y);
      if (selected) { g.beginPath(); g.arc(a, b, r + 6, 0, 7); g.strokeStyle = accent; g.lineWidth = 2.5; g.stroke(); }
      B.token(a, b, r, kit);
      g.fillStyle = ink(kit); g.font = `700 ${Math.round(r * 0.9)}px ${font('--mono')}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, a, b + 0.5);
      if (label) B.pill(label, a, b + r + 10, view.w < 600 ? 9 : 10.5);
    };
    B.pill = (text, a, b, size, color) => {
      g.font = `600 ${size}px ${font('--sans')}`; const w = g.measureText(text).width + 10, h = size + 6;
      g.fillStyle = 'rgba(10,14,12,.62)'; g.beginPath(); g.roundRect(a - w / 2, b - h / 2, w, h, h / 2); g.fill();
      g.fillStyle = color || '#F1F3F6'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, a, b + 0.5);
    };
    B.arrow = (x0, y0, x1, y1, color, width = 2.5) => {
      const [a, b] = B.P(x0, y0), [c, d] = B.P(x1, y1); g.save(); g.strokeStyle = color; g.fillStyle = color; g.lineWidth = width; g.lineCap = 'round'; g.setLineDash([6, 5]);
      g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke(); g.setLineDash([]);
      const ang = Math.atan2(d - b, c - a), h = 8 + width * 1.5; g.beginPath(); g.moveTo(c, d); g.lineTo(c - h * Math.cos(ang - 0.45), d - h * Math.sin(ang - 0.45));
      g.lineTo(c - h * Math.cos(ang + 0.45), d - h * Math.sin(ang + 0.45)); g.closePath(); g.fill(); g.restore();
    };
    B.ball = (x, y) => {
      const [ba, bb] = B.P(x, y);
      g.beginPath(); g.ellipse(ba + 1.5, bb + 3, 5, 2.2, 0, 0, 7); g.fillStyle = 'rgba(0,0,0,.3)'; g.fill();
      const bg = g.createRadialGradient(ba - 1.5, bb - 1.5, 0.5, ba, bb, 5.5); bg.addColorStop(0, '#FFFFFF'); bg.addColorStop(1, '#C9CED3');
      g.beginPath(); g.arc(ba, bb, Math.max(4, 0.6 * view.sc), 0, 7); g.fillStyle = bg; g.fill(); g.strokeStyle = '#2B3036'; g.lineWidth = 1; g.stroke();
    };
    return B;
  }
  window.SB_PITCH = { createBoard, shade, ink };
})();
