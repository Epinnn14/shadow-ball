/* Theme: follows the device (or the host page) until the viewer picks light or dark here.
   The choice is a per-browser convenience, so storage failures are ignored. */
(function () {
  const KEY = 'sb_theme', ORDER = ['system', 'light', 'dark'], LABEL = { system: 'Auto', light: 'Light', dark: 'Dark' };
  const read = () => { try { return localStorage.getItem(KEY) || 'system'; } catch (e) { return 'system'; } };
  const hostTheme = document.documentElement.getAttribute('data-theme');
  function apply(mode) {
    const root = document.documentElement;
    if (mode === 'system') { if (hostTheme) root.setAttribute('data-theme', hostTheme); else root.removeAttribute('data-theme'); }
    else root.setAttribute('data-theme', mode);
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => { b.textContent = LABEL[mode]; b.setAttribute('aria-label', `Theme: ${LABEL[mode]}`); });
    window.dispatchEvent(new Event('sb-theme'));
  }
  let mode = read();
  apply(mode);
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-toggle]'); if (!b) return;
    mode = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
    try { localStorage.setItem(KEY, mode); } catch (err) { /* private window */ }
    apply(mode);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => window.dispatchEvent(new Event('sb-theme')));
  document.addEventListener('DOMContentLoaded', () => apply(mode));
})();
