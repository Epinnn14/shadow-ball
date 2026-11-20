/* English / Indonesian. The pages are written in English; in Indonesian this translates every
   text node and the placeholder / aria-label / title attributes by an exact-match dictionary and
   a short list of patterns (for sentences with numbers), including text the apps write later
   (a MutationObserver). Names, numbers and code are left alone; [data-no-i18n] opts a subtree out.
   Scripts can also call SB_I18N.t('Text with {n}', { n }) directly. */
(function () {
  'use strict';
  const KEY = 'sb_lang', ATTRS = ['placeholder', 'aria-label', 'title'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'NOSCRIPT']);
  let lang = 'en';
  try { lang = localStorage.getItem(KEY) || ''; } catch (e) { lang = ''; }
  if (lang !== 'en' && lang !== 'id') lang = /^id|^ms/i.test(navigator.language || '') ? 'id' : 'en';

  const dict = () => (window.SB_I18N_ID && window.SB_I18N_ID.words) || {};
  let compiled = null;
  const patterns = () => {
    if (!compiled) compiled = ((window.SB_I18N_ID && window.SB_I18N_ID.patterns) || []).map(([re, out]) => [new RegExp('^' + re + '$'), out]);
    return compiled;
  };
  function fill(s, v) { return v ? s.replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m)) : s; }
  function translate(src) {
    if (lang === 'en' || !src) return src;
    const lead = src.match(/^\s*/)[0], trail = src.match(/\s*$/)[0], core = src.trim();
    if (!core || !/[A-Za-z]/.test(core)) return src;
    const d = dict();
    if (Object.prototype.hasOwnProperty.call(d, core)) return lead + d[core] + trail;
    for (const [re, out] of patterns()) {
      const m = core.match(re);
      if (m) return lead + out.replace(/\$(\d)/g, (x, i) => { const g = m[+i]; return d[g] != null ? d[g] : g; }) + trail;
    }
    return src;
  }
  const t = (s, v) => fill(translate(s), v);

  const orig = new WeakMap();
  function skipNode(el) { return !el || (el.closest && el.closest('[data-no-i18n]')) || SKIP.has(el.nodeName); }
  function doText(n) {
    const p = n.parentElement; if (!p || skipNode(p) || (p.closest && p.closest('code, pre, textarea'))) return;
    const v = n.nodeValue, src = orig.get(n);
    if (lang === 'en') return;
    if (src != null && translateCached(src) === v) return;     // already ours
    orig.set(n, v);
    const tv = translateCached(v);
    if (tv !== v) n.nodeValue = tv;
  }
  const cache = new Map();
  function translateCached(s) { if (lang === 'en') return s; let r = cache.get(s); if (r == null) { r = translate(s); if (cache.size > 5000) cache.clear(); cache.set(s, r); } return r; }
  function doAttrs(el) {
    if (skipNode(el)) return;
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const key = 'i18n' + a.replace(/-./g, (x) => x[1].toUpperCase()), cur = el.getAttribute(a);
      const src = el.dataset[key];
      if (lang === 'en') { if (src != null) el.setAttribute(a, src); continue; }
      if (src != null && translateCached(src) === cur) continue;
      el.dataset[key] = cur; const tv = translateCached(cur); if (tv !== cur) el.setAttribute(a, tv);
    }
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1 || skipNode(root)) return;
    doAttrs(root);
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (n.nodeType === 1 && SKIP.has(n.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    let n; while ((n = tw.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }
  function restore(root) {           // back to English
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n; while ((n = tw.nextNode())) {
      if (n.nodeType === 3) { const s = orig.get(n); if (s != null) n.nodeValue = s; }
      else for (const a of ATTRS) { const key = 'i18n' + a.replace(/-./g, (x) => x[1].toUpperCase()); if (n.dataset && n.dataset[key] != null) n.setAttribute(a, n.dataset[key]); }
    }
  }
  let busy = false;
  const mo = new MutationObserver((list) => {
    if (busy || lang === 'en') return;
    busy = true;
    try {
      for (const m of list) {
        if (m.type === 'characterData') doText(m.target);
        else if (m.type === 'attributes') doAttrs(m.target);
        else m.addedNodes.forEach(walk);
      }
    } finally { mo.takeRecords(); busy = false; }
  });
  function label() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-lang-toggle]').forEach((b) => {
      b.textContent = lang === 'id' ? 'ID' : 'EN';
      b.setAttribute('aria-label', lang === 'id' ? 'Bahasa: Indonesia (ganti ke English)' : 'Language: English (switch to Indonesian)');
    });
  }
  function apply() {
    busy = true;
    try { if (lang === 'id') walk(document.body); else restore(document.body); label(); } finally { mo.takeRecords(); busy = false; }
    window.dispatchEvent(new Event('sb-lang'));
  }
  function set(l) {
    lang = l === 'id' ? 'id' : 'en'; cache.clear();
    try { localStorage.setItem(KEY, lang); } catch (e) { /* private window */ }
    apply();
  }
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-lang-toggle]'); if (b) set(lang === 'id' ? 'en' : 'id'); });
  function start() {
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.SB_I18N = { t, get lang() { return lang; }, set };
})();
