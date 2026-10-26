// Colour themes for the info pages (guide, security, legal): the same eleven choices as the
// app. Nothing is stored. The app passes the current theme in the link's fragment
// (#theme=apple), which never reaches any server; this script applies it, removes it from the
// address bar, and passes it on to the next page you open from here.
(() => {
  const THEMES = [
    ['auto', 'Auto', ['#F1F0EC', '#0A0B0C', '#62F2B4']],
    ['signal', 'Signal', ['#F1F0EC', '#111214', '#FF3B1F']],
    ['phosphor', 'Phosphor', ['#0A0B0C', '#62F2B4', '#E6ECE8']],
    ['aurora', 'Aurora', ['#0B0820', '#6D4AFF', '#F472B6']],
    ['daylight', 'Daylight', ['#F6F1EA', '#14151A', '#E8590C']],
    ['graphite', 'Graphite', ['#0E1012', '#45D69A', '#E8EAED']],
    ['ledger', 'Ledger', ['#13110F', '#8CC7B0', '#E0A458']],
    ['vault', 'Vault', ['#0A0C10', '#7AA2FF', '#E6E9EF']],
    ['apple', 'Apple', ['#FFFFFF', '#0A6CF0', '#E9E9EB']],
    ['haven', 'Haven', ['#F3F3F0', '#0B6B6B', '#FFFFFF']],
    ['telegram', 'Telegram', ['#CFE0B4', '#2479C9', '#E3FBD0']],
  ];
  // Dot-matrix headings for the "terminal" themes, clean type for the softer ones (as in the app).
  const CLEAN = new Set(['aurora', 'daylight', 'ledger', 'apple', 'haven', 'telegram']);
  const root = document.documentElement;
  let theme = 'auto';

  function apply(t) {
    theme = THEMES.some(([id]) => id === t) ? t : 'auto';
    if (theme === 'auto') delete root.dataset.theme; else root.dataset.theme = theme;
    if (CLEAN.has(theme)) root.dataset.type = 'clean'; else delete root.dataset.type;
    const chrome = getComputedStyle(root).getPropertyValue('--chrome').trim();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && chrome) meta.content = chrome;
    for (const b of document.querySelectorAll('.pt-grid button')) b.setAttribute('aria-checked', String(b.dataset.t === theme));
    // Links to the other pages and back to the app carry the choice along.
    for (const a of document.querySelectorAll('a[href]')) {
      const m = /^(index|ghostchat|guide|security|legal)\.html(#theme=[a-z]+)?$/.exec(a.getAttribute('href'));
      if (m) a.setAttribute('href', `${m[1]}.html${theme === 'auto' ? '' : '#theme=' + theme}`);
    }
  }

  const fromLink = /^#theme=([a-z]+)$/.exec(location.hash);
  if (fromLink) history.replaceState(null, '', location.pathname + location.search);
  apply(fromLink ? fromLink[1] : 'auto');
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => theme === 'auto' && apply('auto'));

  // The picker: a button in the top bar and a small menu of swatches.
  const top = document.querySelector('.top');
  if (!top) return;
  const wrap = document.createElement('div');
  wrap.className = 'pt';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'pt-btn'; btn.setAttribute('aria-haspopup', 'true'); btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', 'Colour theme'); btn.title = 'Colour theme';
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of [['path', { d: 'M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-1-.9-1.3-.9-2.3 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5C21 6.4 17 3 12 3z' }], ['circle', { cx: 7.5, cy: 11, r: 1.1 }], ['circle', { cx: 10.5, cy: 7, r: 1.1 }], ['circle', { cx: 15, cy: 7.5, r: 1.1 }]]) {
    const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); svg.append(el);
  }
  btn.append(svg);
  const menu = document.createElement('div');
  menu.className = 'pt-menu'; menu.hidden = true;
  const h = document.createElement('p'); h.className = 'pt-h'; h.textContent = 'Theme · lasts for this visit only';
  const grid = document.createElement('div'); grid.className = 'pt-grid'; grid.setAttribute('role', 'radiogroup'); grid.setAttribute('aria-label', 'Colour theme');
  for (const [id, label, [bg, a, b]] of THEMES) {
    const o = document.createElement('button');
    o.type = 'button'; o.dataset.t = id; o.setAttribute('role', 'radio'); o.setAttribute('aria-checked', String(id === theme));
    const sw = document.createElement('span'); sw.className = 'pt-sw';
    sw.style.background = id === 'auto' ? `linear-gradient(135deg, ${bg} 50%, ${a} 50%)` : bg;
    const d1 = document.createElement('i'); d1.style.background = id === 'auto' ? b : a;
    const d2 = document.createElement('b'); d2.style.background = id === 'auto' ? '#111214' : b;
    sw.append(d1, d2);
    const nm = document.createElement('span'); nm.textContent = label;
    o.append(sw, nm);
    o.onclick = () => { apply(id); };
    grid.append(o);
  }
  menu.append(h, grid);
  wrap.append(btn, menu);
  top.append(wrap);
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.onclick = () => {
    const open = menu.hidden;
    menu.hidden = !open; btn.setAttribute('aria-expanded', String(open));
    if (open) grid.querySelector('[aria-checked="true"]')?.focus();
  };
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !wrap.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { close(); btn.focus(); } });
  for (const b of grid.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.t === theme));
})();
