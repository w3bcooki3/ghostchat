// Motion and visual effects. Purely presentational: nothing here touches keys or plaintext
// beyond writing already-decrypted text into the DOM with textContent. Everything honours
// prefers-reduced-motion (effects resolve instantly) and stops when its element leaves the page.
import { encode } from '../vendor/uqr-0.1.2.js';

const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
export const reducedMotion = () => mq.matches;
const GLYPHS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789#%&*+=<>/';
const rnd = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n; // decorative only
const SVGNS = 'http://www.w3.org/2000/svg';

/**
 * "Decrypts" text into an element: characters resolve left to right out of noise.
 * Resolves when done. Spaces and punctuation are never scrambled, so layout barely moves.
 */
export function scramble(el, text, { duration = 700, delay = 0 } = {}) {
  if (el._scr) cancelAnimationFrame(el._scr);
  if (reducedMotion() || !text) { el.textContent = text; return Promise.resolve(); }
  const chars = [...text];
  const t0 = performance.now() + delay;
  return new Promise((resolve) => {
    const step = (now) => {
      const p = Math.max(0, Math.min(1, (now - t0) / duration));
      const k = Math.floor(p * chars.length);
      let s = '';
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        s += i < k || /[\s.,!?'’\-:;()]/.test(c) ? c : GLYPHS[rnd(GLYPHS.length)];
      }
      el.textContent = s;
      if (p < 1 && el.isConnected) el._scr = requestAnimationFrame(step);
      else { el.textContent = text; el._scr = 0; resolve(); }
    };
    el._scr = requestAnimationFrame(step);
  });
}

/**
 * Same effect, drawn as a visual layer only: the element keeps its real text (for screen
 * readers, copy/paste, find-in-page) and a CSS ::after shows the noise on top, with empty
 * alt text so assistive tech never announces it. See .fx-host in app.css.
 */
export function scrambleOverlay(el, text, { duration = 700, delay = 0 } = {}) {
  if (el._scr) cancelAnimationFrame(el._scr);
  if (reducedMotion() || !text) { el.classList.remove('is-decrypting'); return Promise.resolve(); }
  const chars = [...text];
  const t0 = performance.now() + delay;
  el.classList.add('fx-host', 'is-decrypting');
  return new Promise((resolve) => {
    const step = (now) => {
      const p = Math.max(0, Math.min(1, (now - t0) / duration));
      const k = Math.floor(p * chars.length);
      let s = '';
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        s += i < k || /[\s.,!?'’\-:;()]/.test(c) ? c : GLYPHS[rnd(GLYPHS.length)];
      }
      el.dataset.fx = s;
      if (p < 1 && el.isConnected) el._scr = requestAnimationFrame(step);
      else { el.classList.remove('is-decrypting'); delete el.dataset.fx; el._scr = 0; resolve(); }
    };
    el._scr = requestAnimationFrame(step);
  });
}

/** Re-runs a scramble every `period` ms while `isActive()` is true (home headline). */
export function loopScramble(el, text, period = 9000, isActive = () => true) {
  let timer = 0;
  const run = () => {
    if (isActive() && !document.hidden) scrambleOverlay(el, text, { duration: 900 });
    timer = setTimeout(run, period);
  };
  el.textContent = text;
  if (!reducedMotion()) timer = setTimeout(run, 400);
  return () => clearTimeout(timer);
}

/** Cycles an element through phrases with a short scramble between them. */
export function cycleText(el, phrases, period = 3200, isActive = () => true) {
  let i = 0;
  el.textContent = phrases[0];
  if (reducedMotion()) return () => {};
  const t = setInterval(() => {
    if (!isActive() || document.hidden) return;
    i = (i + 1) % phrases.length;
    scramble(el, phrases[i], { duration: 500 });
  }, period);
  return () => clearInterval(t);
}

/**
 * Ghost eyes that follow the pointer. `eyes` is the <g> holding the two pupils; they are
 * moved with a CSS transform (in SVG user units, scaled by the viewBox) and eased.
 */
export function followEyes(svg, eyes, { range = 2.4 } = {}) {
  if (reducedMotion()) return () => {};
  let tx = 0, ty = 0, x = 0, y = 0, raf = 0, idle = 0;
  const onMove = (e) => {
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height * 0.4);
    const d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 400);
    tx = (dx / d) * range * k; ty = (dy / d) * range * 0.8 * k;
    idle = performance.now();
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const tick = (now) => {
    if (now - idle > 2600) {                         // nobody moving: glance around on its own
      const a = now / 1700;
      tx = Math.sin(a) * range * 0.6; ty = Math.sin(a * 0.7) * range * 0.3;
    }
    x += (tx - x) * 0.12; y += (ty - y) * 0.12;
    eyes.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
    raf = svg.isConnected && svg.getClientRects().length ? requestAnimationFrame(tick) : 0;
  };
  addEventListener('pointermove', onMove, { passive: true });
  raf = requestAnimationFrame(tick);
  return () => { removeEventListener('pointermove', onMove); cancelAnimationFrame(raf); raf = 0; };
}

/**
 * The "ether line": a strip of hex that shows the REAL encrypted frames passing between the
 * two browsers (the first bytes of each sealed frame's ciphertext). This is the same data
 * anyone on the network path sees, so displaying it reveals nothing.
 */
export class EtherLine {
  /** mode 'prepend': new bytes enter on the left (traffic flowing right); 'append': on the right. */
  constructor(el, max = 220, mode = 'prepend') { this.el = el; this.max = max; this.mode = mode; this.s = ''; this.pending = ''; this.raf = 0; }
  push(bytes) {
    let hx = '';
    for (const b of bytes) hx += b.toString(16).padStart(2, '0');
    const chunk = (hx.match(/.{1,4}/g) || []).join(' ') + ' ';
    this.pending = this.mode === 'prepend' ? chunk + this.pending : this.pending + chunk;
    if (this.pending.length > this.max) this.pending = this.mode === 'prepend' ? this.pending.slice(0, this.max) : this.pending.slice(-this.max);
    if (!this.raf) this.raf = requestAnimationFrame(() => this.flush());
  }
  flush() {
    this.raf = 0;
    this.s = this.mode === 'prepend' ? (this.pending + this.s).slice(0, this.max) : (this.s + this.pending).slice(-this.max);
    this.pending = '';
    this.el.textContent = this.s;
    if (!reducedMotion()) { this.el.classList.remove('is-tick'); void this.el.offsetWidth; this.el.classList.add('is-tick'); }
  }
  clear() { this.s = ''; this.pending = ''; this.el.textContent = ''; }
}

/** Renders text as a QR code (SVG, built with DOM calls only). */
export function renderQR(container, text) {
  container.replaceChildren();
  if (!text) return;
  const { data, size } = encode(text, { ecc: 'M', border: 2 });
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code of the invite link');
  const bg = document.createElementNS(SVGNS, 'rect');
  bg.setAttribute('width', size); bg.setAttribute('height', size); bg.setAttribute('class', 'qr-bg');
  let d = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (data[y][x]) d += `M${x} ${y}h1v1h-1z`;
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('d', d); path.setAttribute('class', 'qr-fg');
  svg.append(bg, path);
  container.append(svg);
}

/** Adds `cls` for `ms`, then removes it (restartable one-shot animations). */
export function flash(el, cls, ms = 700) {
  if (!el || reducedMotion()) return;
  el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
  clearTimeout(el['_f' + cls]);
  el['_f' + cls] = setTimeout(() => el.classList.remove(cls), ms);
}

export const wait = (ms) => new Promise((r) => setTimeout(r, reducedMotion() ? 0 : ms));
