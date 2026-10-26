// Ghost Chat — interface controller.
// All peer-supplied strings reach the DOM through textContent / attribute
// setters only; nothing from the network is ever parsed as HTML.
import { generateCode, normalizeCode, roomIdFromCode } from './protocol.js';
import { uid, iceServersWith, parseTurn } from './session.js';
import { Room, MAX_MEMBERS } from './room.js';
import { checkNetwork, explain } from './netcheck.js';
import { LIMITS } from './config.js';
import { scramble, scrambleOverlay, loopScramble, cycleText, followEyes, EtherLine, renderQR, flash, wait, reducedMotion } from './fx.js';
import { cleanLabel, cleanName, cleanText, isMid, sniffImage, parseLink } from './ui/sanitize.js';
import { $, h, fmtSize, fmtTime, fmtSecs, fmtLeft, toast, copy, confirmDialog, closeDialog, dialogOpen, initDialog } from './ui/dom.js';
import { HandshakeStage } from './ui/handshake.js';
import { presentReceived } from './ui/media.js';

// Refuse to run inside a frame: prevents click-jacking of the panic/end/verify controls
// and keeps a hostile embedding page from overlaying the UI.
if (window.top !== window.self) {
  document.body.replaceChildren(Object.assign(document.createElement('p'), { className: 'noscript', textContent: 'Ghost Chat must be opened directly, not inside another page.' }));
  throw new Error('framed');
}


const AVATARS = ['👻', '🦊', '🐺', '🦉', '🐙', '🦑', '🦈', '🐸', '🦎', '🐝', '🦋', '🐌', '🌚', '🌵', '🍄', '🪐', '🔮', '🗝️', '🕯️', '🧊', '⚡', '🌊', '🎭', '🤖', '👾', '🛸', '🦇', '🐈‍⬛', '🐉', '🦂', '🪼', '🌑'];
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const TIMERS = [[0, 'Off'], [10, '10 s'], [30, '30 s'], [60, '1 min'], [300, '5 min'], [3600, '1 h']];
const GROUP_GAP_MS = 3 * 60_000;

// ───────────────────────────── state ─────────────────────────────
const me = { name: '', avatar: AVATARS[crypto.getRandomValues(new Uint8Array(1))[0] % AVATARS.length] };
// Everyone else in the room, by member id. Entries stay after someone leaves (marked gone) so
// their old messages keep a name.
const people = new Map();
let session = null;            // the Room
let selPerson = null;          // whose safety number the panel shows
let code = null;
let role = null;
let burnSecs = 0;
let replyTo = null;
let editing = null;           // the message being edited in the composer
let unread = 0;
let menuFor = null;
let lastTypingSent = 0;
let typingIdle = null;
let roomTakenRetries = 0;
const opts = { receipts: true, typing: true, veil: false, notify: false, shape: false };
let privacy = 'standard'; // 'standard' | 'max' — chosen on the home screen
const msgs = new Map(); // id → record
const objectUrls = new Set();
// Automation hook, only present when the test server marks the page (never in production builds).
const testHook = document.documentElement.dataset.test === '1' ? (window.__ghost = { get session() { return session; }, msgs, people, files: {} }) : null;

// ───────────────────────────── helpers ─────────────────────────────
const inviteLink = (c = shareCode() || code) => location.href.split('#')[0] + '#' + c;

// ── people ──
function person(id) {
  let p = people.get(id);
  if (!p) { p = { id, name: '', avatar: '👤', verified: false, sn: null, ready: false, gone: false, state: 'connecting' }; people.set(id, p); }
  return p;
}
const isHostId = (id) => !!session && id === session.hostId;
const nameOf = (id) => people.get(id)?.name || (isHostId(id) ? 'The host' : 'Someone');
const present = () => [...people.values()].filter((p) => !p.gone);
const inGroup = () => present().length > 1 || (!!session && session.count() > 2);
const allVerified = () => { const ps = present().filter((p) => p.sn); return ps.length > 0 && ps.every((p) => p.verified); };
const canInviteNow = () => !!session && !session.ended && (role === 'host' || (session.canInvite && !!session.inviteCode));
/** The code to share right now: the host's current one, or the one the host gave a member who may invite. */
const shareCode = () => (role === 'host' ? session?.inviteCode || code : session?.inviteCode) || null;

/** Someone else's name, numbered if it matches yours or another person's ("Bob (2)"). */
function distinctName(name, id) {
  const taken = new Set([me.name, ...[...people.values()].filter((p) => p.id !== id && !p.gone).map((p) => p.name)].filter(Boolean).map((n) => n.toLowerCase()));
  for (const k of knockCards.values()) taken.add(k.name.toLowerCase());
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) { const n = `${name.slice(0, 19)} (${i})`; if (!taken.has(n.toLowerCase())) return n; }
}
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('is-on', s.id === id);
}

initDialog();

async function imageTypeOf(blob) { return sniffImage(new Uint8Array(await blob.slice(0, 16).arrayBuffer())); }
function track(url) { objectUrls.add(url); return url; }
function release(url) { if (url) { URL.revokeObjectURL(url); objectUrls.delete(url); } }

// ───────────────────────────── home ─────────────────────────────

// ── home motion: decrypting headline, status line, ghosts whose eyes follow you ──
const homeOn = () => !!$('home')?.classList.contains('is-on');   // false once a panic wipe emptied the page
loopScramble($('headLine'), 'Say it once.', 9000, homeOn);
loopScramble($('heroLine'), 'Say it once.', 9000, homeOn);
cycleText($('statusPill'), ['BROWSER TO BROWSER', 'POST-QUANTUM KEY EXCHANGE', 'NO ACCOUNT · NOTHING STORED', 'THE CODE IS THE ONLY WAY IN'], 3400, homeOn);
for (const id of ['stageGhost', 'heroGhost']) { const g = $(id); followEyes(g, g.querySelector('.ghost-eyes')); }

// ── identity: avatar + name, shown on the chips of the home and join screens ──
function renderIdentity() {
  const name = cleanLabel($('nameInput').value, 24) || 'Anonymous ghost';
  for (const el of document.querySelectorAll('[data-avatar]')) el.textContent = me.avatar;
  for (const el of document.querySelectorAll('[data-name]')) el.textContent = name;
  if (document.activeElement !== $('joinName')) $('joinName').value = $('nameInput').value;
}
function buildAvatars() {
  const g = $('avatarGrid');
  g.replaceChildren();
  for (const a of AVATARS) {
    const b = h('button', null, a);
    b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(a === me.avatar));
    b.setAttribute('aria-label', 'Avatar ' + a);
    b.onclick = () => { me.avatar = a; for (const x of g.children) x.setAttribute('aria-checked', String(x === b)); renderIdentity(); };
    g.append(b);
  }
}
buildAvatars();
renderIdentity();
$('nameInput').addEventListener('input', renderIdentity);
// The join screen's own name field: the same name as "Your ghost", right where people join.
$('joinName').addEventListener('input', () => { $('nameInput').value = $('joinName').value; renderIdentity(); });
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); closeSheet(); } });

function readName() {
  const n = cleanLabel($('nameInput').value, 24);
  me.name = n || 'Ghost ' + (crypto.getRandomValues(new Uint16Array(1))[0] % 900 + 100);
  $('nameInput').value = me.name;
  renderIdentity();
}

// ── sheets (bottom sheets on phones, centered dialogs on larger screens) ──
let openSheetEl = null, sheetOpener = null;
function openSheet(id, opener) {
  const sh = $(id);
  if (!sh || openSheetEl === sh) return;
  if (openSheetEl) closeSheet(true);
  openSheetEl = sh; sheetOpener = opener || document.activeElement;
  $('sheetScrim').hidden = false; sh.hidden = false;
  requestAnimationFrame(() => { $('sheetScrim').classList.add('is-on'); sh.classList.add('is-on'); });
  setTimeout(() => (sh.querySelector('[aria-checked="true"], input:checked') || sh.querySelector('button, input'))?.focus({ preventScroll: true }), 60);
}
function closeSheet(instant) {
  const sh = openSheetEl;
  if (!sh) return;
  openSheetEl = null;
  sh.classList.remove('is-on'); $('sheetScrim').classList.remove('is-on');
  sh.style.transform = '';
  const done = () => { if (openSheetEl !== sh) sh.hidden = true; if (!openSheetEl) $('sheetScrim').hidden = true; };
  if (instant || matchMedia('(prefers-reduced-motion: reduce)').matches) done(); else setTimeout(done, 260);
  sheetOpener?.focus?.({ preventScroll: true }); sheetOpener = null;
}
for (const b of document.querySelectorAll('[data-sheet]')) b.addEventListener('click', () => openSheet(b.dataset.sheet, b));
for (const b of document.querySelectorAll('[data-close-sheet]')) b.addEventListener('click', () => closeSheet());

// ── colour themes: one layout, several palettes. Auto follows the device's light/dark
// setting. The choice lasts for this tab only: nothing is written to storage. ──
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
let theme = 'auto';
let typeStyle;
function applyTheme(t) {
  theme = THEMES.some(([id]) => id === t) ? t : 'auto';
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const chrome = getComputedStyle(document.documentElement).getPropertyValue('--chrome').trim();
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = chrome;
  for (const b of document.querySelectorAll('[data-theme-picker] button')) b.setAttribute('aria-checked', String(b.dataset.t === theme));
  // Links to the info pages carry the theme in the fragment (never sent to a server).
  for (const a of document.querySelectorAll('a[href]')) {
    const m = /^(guide|security|legal)\.html(#theme=[a-z]+)?$/.exec(a.getAttribute('href'));
    if (m) a.setAttribute('href', `${m[1]}.html${theme === 'auto' ? '' : '#theme=' + theme}`);
  }
  applyType(typeStyle);
}
// ── text style: separate from colour. Auto picks what suits the theme (dot-matrix for the
// hacker palettes, clean type for the softer ones). Also lasts for this tab only. ──
const TYPES = [['auto', 'Auto'], ['terminal', 'Terminal'], ['clean', 'Clean'], ['mono', 'Mono']];
const THEME_TYPE = { signal: 'terminal', phosphor: 'terminal', graphite: 'terminal', vault: 'mono', aurora: 'clean', daylight: 'clean', ledger: 'clean', apple: 'clean', haven: 'clean', telegram: 'clean' };
typeStyle = 'auto';
function applyType(t) {
  typeStyle = TYPES.some(([id]) => id === t) ? t : 'auto';
  const eff = typeStyle === 'auto' ? THEME_TYPE[theme] || 'terminal' : typeStyle;
  if (eff === 'terminal') delete document.documentElement.dataset.type; else document.documentElement.dataset.type = eff;
  for (const b of document.querySelectorAll('[data-type-picker] button')) {
    b.setAttribute('aria-checked', String(b.dataset.ty === typeStyle));
    if (b.dataset.ty === 'auto') b.title = 'Matches the theme: ' + eff[0].toUpperCase() + eff.slice(1);
  }
}
for (const grid of document.querySelectorAll('[data-type-picker]')) {
  for (const [id, label] of TYPES) {
    const b = h('button', null, label);
    b.type = 'button'; b.dataset.ty = id; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(id === 'auto'));
    b.onclick = () => applyType(id);
    grid.append(b);
  }
}
for (const grid of document.querySelectorAll('[data-theme-picker]')) {
  for (const [id, label, [bg, a, b]] of THEMES) {
    const btn = h('button', 'th');
    btn.type = 'button'; btn.dataset.t = id; btn.setAttribute('role', 'radio'); btn.setAttribute('aria-checked', 'false');
    const sw = h('span', 'th-sw');
    sw.style.background = id === 'auto' ? `linear-gradient(135deg, ${bg} 50%, ${a} 50%)` : bg;
    const dotA = h('i'); dotA.style.background = id === 'auto' ? b : a;
    const dotB = h('b'); dotB.style.background = id === 'auto' ? '#111214' : b;
    sw.append(dotA, dotB);
    btn.append(sw, h('span', 'th-name', label));
    btn.onclick = () => applyTheme(id);
    grid.append(btn);
  }
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (theme === 'auto') applyTheme('auto'); });
// ── message layout: bubbles, or lines (a left-aligned log). Lasts for this tab only. ──
const LAYOUTS = [['bubbles', 'Bubbles'], ['lines', 'Lines']];
let layout = 'bubbles';
function applyLayout(l) {
  layout = LAYOUTS.some(([id]) => id === l) ? l : 'bubbles';
  if (layout === 'bubbles') delete document.documentElement.dataset.layout; else document.documentElement.dataset.layout = layout;
  for (const b of document.querySelectorAll('[data-layout-picker] button')) b.setAttribute('aria-checked', String(b.dataset.ly === layout));
}
for (const grid of document.querySelectorAll('[data-layout-picker]')) {
  for (const [id, label] of LAYOUTS) {
    const b = h('button', null, label);
    b.type = 'button'; b.dataset.ly = id; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(id === layout));
    b.onclick = () => applyLayout(id);
    grid.append(b);
  }
}
$('optWire').onchange = (e) => document.documentElement.classList.toggle('no-wire', !e.target.checked);
applyTheme('auto');
$('sheetScrim').addEventListener('click', () => closeSheet());
for (const sh of document.querySelectorAll('.sheet')) { // drag the grip down to dismiss (phones)
  let y0 = null, dy = 0;
  sh.addEventListener('touchstart', (e) => { if (e.target.closest('.sheet-grip, .sheet-title')) { y0 = e.touches[0].clientY; dy = 0; sh.style.transition = 'none'; } }, { passive: true });
  sh.addEventListener('touchmove', (e) => { if (y0 === null) return; dy = Math.max(0, e.touches[0].clientY - y0); sh.style.transform = `translateY(${dy}px)`; }, { passive: true });
  sh.addEventListener('touchend', () => { if (y0 === null) return; y0 = null; sh.style.transition = ''; if (dy > 90) closeSheet(); else sh.style.transform = ''; }, { passive: true });
}
// Keep keyboard focus inside an open sheet.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !openSheetEl) return;
  const f = [...openSheetEl.querySelectorAll('button, input, summary, [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null && !x.disabled);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// ── join screen: four code boxes ──
const boxes = [1, 2, 3, 4].map((n) => $('code' + n));
const CODE_OK = /[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g;
const HELP_DEFAULT = 'Letters and digits 2–9';
function codeHelp(text, bad) {
  $('codeHelp').textContent = text || HELP_DEFAULT;
  $('codeHelp').classList.toggle('is-error', !!bad);
  for (const b of boxes) b.classList.toggle('is-invalid', !!bad && !text?.startsWith('Codes never'));
}
function codeValue() { return boxes.map((b) => b.value).join(''); }
function syncBoxes() {
  for (const b of boxes) b.classList.toggle('is-full', b.value.length === 5);
  $('joinBtn').classList.toggle('is-ready', codeValue().length === 20);
}
/** Puts a code (or anything containing one, like an invite link) into the boxes. */
function setCode(raw, focus = true) {
  let s = String(raw || '');
  if (s.includes('#')) s = s.slice(s.indexOf('#') + 1);
  const up = s.toUpperCase();
  if (/[01IO]/.test(up.replace(/[^A-Z0-9]/g, ''))) codeHelp('Codes never contain 0, 1, I or O — check for a look-alike character.', true);
  else codeHelp();
  const clean = up.replace(CODE_OK, '').slice(0, 20);
  boxes.forEach((b, i) => { b.value = clean.slice(i * 5, i * 5 + 5); });
  syncBoxes();
  if (focus) (boxes.find((b) => b.value.length < 5) || $('joinBtn')).focus({ preventScroll: true });
}
boxes.forEach((box, i) => {
  box.addEventListener('input', () => {
    const v = box.value;
    const up = v.toUpperCase();
    if (v.length > 5 || /[^A-Za-z0-9]/.test(v.replace(/[\s-]/g, '')) || v.includes('#')) {
      // a paste or autofill of the whole code into one box
      return setCode(boxes.slice(0, i).map((b) => b.value).join('') + v);
    }
    if (/[01IO]/.test(up)) codeHelp('Codes never contain 0, 1, I or O — check for a look-alike character.', true);
    else codeHelp();
    box.value = up.replace(CODE_OK, '').slice(0, 5);
    syncBoxes();
    if (box.value.length === 5 && boxes[i + 1] && !boxes[i + 1].value) boxes[i + 1].focus();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && boxes[i - 1]) { e.preventDefault(); boxes[i - 1].focus(); boxes[i - 1].value = boxes[i - 1].value.slice(0, -1); syncBoxes(); }
    if (e.key === 'ArrowLeft' && box.selectionStart === 0 && boxes[i - 1]) { e.preventDefault(); boxes[i - 1].focus(); }
    if (e.key === 'ArrowRight' && box.selectionStart === box.value.length && boxes[i + 1]) { e.preventDefault(); boxes[i + 1].focus(); }
  });
  box.addEventListener('paste', (e) => {
    const t = e.clipboardData?.getData('text');
    if (t) { e.preventDefault(); setCode(boxes.slice(0, i).map((b) => b.value).join('') + t); }
  });
});
$('pasteBtn').onclick = async () => {
  try { setCode(await navigator.clipboard.readText()); }
  catch { toast('Couldn\'t read the clipboard. Long-press the first box and paste.', true); boxes[0].focus(); }
};

let invited = false;
function openJoin({ code: c = null } = {}) {
  closeSheet(true);
  invited = !!c;
  $('joinTitle').textContent = invited ? 'You\'re invited to a private chat' : 'Join a private chat';
  $('joinSub').textContent = invited ? 'Choose how you\'ll appear, then join.' : 'Enter the code you were sent, or paste the invite link.';
  $('joinOr').textContent = invited ? 'Not expecting this?' : 'No code?';
  if (c) setCode(c, false);
  else { boxes.forEach((b) => { b.value = ''; }); codeHelp(); syncBoxes(); }
  const wasHome = $('home').classList.contains('is-on');
  show('joinScreen');
  if (wasHome) history.pushState({ gc: 'join' }, '');
  setTimeout(() => (invited ? ($('joinName').value.trim() ? $('joinBtn') : $('joinName')) : boxes[0]).focus({ preventScroll: true }), 50);
}
function leaveJoin() {
  if (!$('joinScreen').classList.contains('is-on')) return;
  if (history.state?.gc === 'join') history.back(); else show('home');
}
addEventListener('popstate', () => { if ($('joinScreen').classList.contains('is-on')) { closeSheet(true); show('home'); $('openJoinBtn').focus({ preventScroll: true }); } });

$('openJoinBtn').onclick = () => openJoin();
$('joinBack').onclick = leaveJoin;
$('createBtn').onclick = () => { readName(); startSession('host', generateCode()); };
$('joinCreateBtn').onclick = () => { readName(); startSession('host', generateCode()); };
$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = codeValue();
  const c = normalizeCode(v);
  if (!c) {
    codeHelp(v.length < 20 ? `That's ${v.length} of 20 characters. Check the code and try again.` : 'That isn\'t a valid room code.', true);
    (boxes.find((b) => b.value.length < 5) || boxes[0]).focus();
    return;
  }
  readName();
  startSession('joiner', c);
});

// Invite links carry the code in the fragment (never sent to any server). Read it, then erase it.
function readInvite() {
  // Coming back from an info page: it passes the theme along (never a code).
  const tm = /^#theme=([a-z]+)$/.exec(location.hash);
  if (tm) { history.replaceState(history.state, '', location.pathname + location.search); applyTheme(tm[1]); return; }
  if (location.hash === '#new') {
    history.replaceState(history.state, '', location.pathname + location.search);
    // After the rest of the page has initialised (this runs while the module is loading).
    if ($('home').classList.contains('is-on') || $('joinScreen').classList.contains('is-on')) setTimeout(() => { readName(); startSession('host', generateCode()); }, 0);
    return;
  }
  const c = normalizeCode(location.hash);
  if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
  if (!c) return;
  if ($('home').classList.contains('is-on') || $('joinScreen').classList.contains('is-on')) openJoin({ code: c });
  else toast('Invite link received. Leave this session to use it.');
}
readInvite();
window.addEventListener('hashchange', readInvite);

// ───────────────────────────── connecting ─────────────────────────────
function setSteps(active, doneUntil, errorAt) {
  const order = ['signal', 'peer', 'keys', 'ready'];
  for (const li of $('steps').children) {
    const i = order.indexOf(li.dataset.step);
    li.className = errorAt === li.dataset.step ? 'is-error' : i < order.indexOf(doneUntil) + 1 ? 'is-done' : li.dataset.step === active ? 'is-active' : '';
  }
}
function renderCode() {
  const g = $('codeGroups');
  g.replaceChildren();
  code.split('-').forEach((part, i) => {
    if (i) g.append(h('span', 'code-sep', '-'));
    g.append(h('span', 'code-group', part));
  });
  g.setAttribute('aria-label', 'Room code ' + code.split('').join(' '));
}
function showConnectError(text, canRetry, canCheck = false, retryLabel = 'Try again') {
  $('connectError').hidden = false;
  $('retryBtn').textContent = retryLabel;
  stopExpiryClock();
  $('connectErrorText').textContent = text;
  $('retryBtn').hidden = !canRetry;
  $('netCheckBtn').hidden = !canCheck;
  $('netResult').hidden = true;
}
/** Turns what ICE found on this side into specific advice. */
function timeoutAdvice(d) {
  if (!d) return '';
  if (d.noRelayConfigured) return '"Hide my IP" needs a relay server, and none is configured. Add one under Privacy → Customize, or switch to Standard.';
  if (d.relayOnly && !d.relay && !d.relayTried) return '"Hide my IP" needs a relay server, and none answered from your network. Add your own relay under Privacy → Customize, or switch to Standard.';
  if (!d.relay && !d.srflx && !d.host) return 'WebRTC found no network paths at all. A browser setting, an extension or a firewall is blocking it.';
  if (d.relayTried) return 'Your network blocks direct connections, and the Ghost Chat relay couldn\'t reach the other person either. Check that both of you are online and the relay is deployed (see relay/README.md), then try again.';
  if (!d.relay) return 'Your network blocks direct connections (strict NAT, a VPN or a firewall), and no relay server was reachable. Fixes: add a TURN relay under Privacy → Customize; try without the VPN or on another network; or, to test on one computer, open both windows in the same browser profile (two incognito windows work), which connects without the network.';
  return 'A relay was available but the connection still didn\'t open. The other person\'s network may be blocking it.';
}
async function runNetCheck(outEl, btn) {
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'Checking…';
  outEl.hidden = false; outEl.className = 'net-result'; outEl.textContent = 'Testing what your network allows. This takes about 5 seconds.';
  try {
    const r = await checkNetwork(await iceServersWith(customRelay ? [customRelay] : []));
    const v = explain(r);
    outEl.replaceChildren();
    outEl.classList.add(v.ok ? 'is-ok' : 'is-bad');
    outEl.append(h('p', null, v.text));
    const dl = h('dl', 'kv');
    const row = (k, val) => { dl.append(h('dt', null, k), h('dd', null, val)); };
    row('Local paths', r.host ? (r.mdns ? 'Yes (hidden .local names)' : 'Yes') : 'None');
    row('Public address', r.srflx ? 'Found' : 'Not found');
    row('NAT type', r.srflx ? (r.symmetric ? 'Strict (symmetric)' : 'Friendly') : 'Unknown');
    row('Relay (TURN)', r.relay ? 'Reachable' : r.relayConfigured ? 'Not reachable' : 'None configured');
    row('Same-page test', r.loopback ? 'Connected' : 'Failed');
    outEl.append(dl);
  } catch (e) {
    outEl.textContent = 'The check couldn\'t run: ' + (e?.message || e);
  } finally { btn.disabled = false; btn.textContent = label; }
}
$('netCheckBtn').onclick = () => runNetCheck($('netResult'), $('netCheckBtn'));

const FAIL_TEXT = {
  'not-found': 'This room isn\'t open with this code. Each invite code works once: after someone is let in, the room moves to a new one. The code may also have expired, or the person who made the room ended it. Ask them for a new invite.',
  'host-away': 'The room exists, but the person who made it isn\'t answering. Their phone may be locked, or Ghost Chat was closed or put in the background. Ask them to open it again, then try again.',
  'auth-failed': 'A room exists, but it didn\'t accept this code. Check every character. If you\'re certain it\'s right, something may be interfering with the connection — don\'t continue.',
  signaling: 'Couldn\'t reach the introduction server. Check your internet connection, or whether a firewall or content blocker is stopping it.',
  timeout: 'Found the room, but your browsers couldn\'t open a connection to each other.',
  unsupported: 'This browser lacks WebRTC or Web Crypto support. Use a current version of Firefox, Chrome, Edge or Safari.',
  'room-taken': 'Couldn\'t reserve a room. Try again.',
  locked: `This room is full (${MAX_MEMBERS} people), so it isn't taking anyone new right now.`,
};

function startSession(r, c) {
  role = r; code = c; roomTakenRetries = r === 'host' ? roomTakenRetries : 0;
  resetChat();
  $('connectTitle').textContent = role === 'host' ? 'Your room is ready to share' : 'Joining room';
  $('keycard').classList.toggle('is-joining', role === 'joiner');
  $('shareRow').hidden = role !== 'host';
  $('shareHint').hidden = role !== 'host';
  $('peerStepText').textContent = role === 'host' ? 'Waiting for the other person to open the link' : 'Finding the room';
  $('connectError').hidden = true;
  renderCode();
  setSteps('signal', null);
  $('qrBox').hidden = true; $('qrBox').replaceChildren(); $('qrBtn').textContent = 'Show QR'; $('qrBtn').setAttribute('aria-expanded', 'false');
  stage.reset(role);
  $('expiryRow').hidden = role !== 'host';
  show('connect');
  if (role === 'host') $('copyLinkBtn').focus();

  session = new Room({ code, role, relayOnly: $('relayOnly').checked, extraIce: customRelay ? [customRelay] : [] });
  session.profile = { name: me.name, avatar: me.avatar };
  applyPrivacyPreset();
  wire(session);
  session.start().then(() => { if (role === 'host') startExpiryClock(); }).catch((e) => { console.error(e); showConnectError(FAIL_TEXT.unsupported, false); });
}

$('copyLinkBtn').onclick = () => copy(inviteLink(), 'Invite link');
// Phones: hand the invite to the system share sheet (same trust as copying it).
if (navigator.share && matchMedia('(pointer: coarse)').matches) {
  $('shareBtn').hidden = false;
  $('copyLinkBtn').classList.replace('btn-primary', 'btn-ghost');
  $('shareBtn').onclick = async () => {
    try { await navigator.share({ title: 'Ghost Chat invite', text: 'Join my private Ghost Chat room:', url: inviteLink() }); }
    catch (e) { if (e?.name !== 'AbortError') copy(inviteLink(), 'Invite link'); }
  };
}
$('copyCodeBtn').onclick = () => copy(code, 'Room code');

// ── invite expiry countdown (host) ──
let expiryClock = 0;
function renderExpiry() {
  const s = session;
  if (!s || s.role !== 'host' || s.everReady || s.ended || !s.expiresAt) return stopExpiryClock();
  const left = Math.max(0, s.expiresAt - Date.now());
  $('expiryText').textContent = 'Expires in ' + fmtLeft(left);
  $('expiryRow').classList.toggle('is-soon', left < 60_000);
  $('extendBtn').hidden = s.expiresAt >= s.createdAt + LIMITS.inviteMaxMs - 1000;
}
function startExpiryClock() { stopExpiryClock(); renderExpiry(); expiryClock = setInterval(renderExpiry, 1000); }
function stopExpiryClock() { clearInterval(expiryClock); expiryClock = 0; }
$('extendBtn').onclick = () => { session?.extendInvite(); renderExpiry(); toast('Code extended'); };
$('qrBtn').onclick = () => {
  const box = $('qrBox'), open = box.hidden;
  if (open) { try { renderQR(box, inviteLink()); } catch (e) { console.warn('[ghost] qr', e); return toast('Couldn\'t draw the QR code', true); } }
  else box.replaceChildren();
  box.hidden = !open;
  $('qrBtn').setAttribute('aria-expanded', String(open));
  $('qrBtn').textContent = open ? 'Hide QR' : 'Show QR';
};

// ───────────────────────────── handshake stage ─────────────────────────────
const stage = new HandshakeStage();

$('cancelBtn').onclick = () => { teardown(); show('home'); };
$('retryBtn').onclick = () => {
  $('connectError').hidden = true;
  if (session && role === 'joiner' && !session.ended) { setSteps('peer', 'signal'); session.retry(); }
  else { const r = role, c = code; teardown(); startSession(r, r === 'host' ? generateCode() : c); }
};

// ───────────────────────────── session wiring ─────────────────────────────
function wire(s) {
  s.on('state', ({ state }) => {
    if (s !== session) return;
    if (state === 'waiting' || state === 'dialing') setSteps('peer', 'signal');
    if (state === 'reconnecting') onReconnecting();
    if (state === 'ready' && $('chat').classList.contains('is-on')) { hideBanner(); setLink('is-good', 'Encrypted'); enableComposer(); }
    if (state === 'alone') onAlone();
  });
  s.on('link-open', () => {
    if (s !== session || s.everReady) return;
    setSteps('keys', 'peer');
    stage.linked(role);
  });
  s.on('hs-frame', ({ dir, kind }) => { if (s === session && !s.everReady) stage.packet(dir, kind); });
  s.on('wire', ({ dir, bytes }) => { if (s === session) onWire(dir, bytes); });
  s.on('failed', ({ code: f, diag }) => {
    if (s !== session) return;
    if (f === 'room-taken' && role === 'host' && roomTakenRetries++ < 3) { teardown(); startSession('host', generateCode()); return; }
    const step = f === 'signaling' ? 'signal' : f === 'auth-failed' || f === 'timeout' ? 'keys' : 'peer';
    setSteps(null, { signal: null, peer: 'signal', keys: 'peer' }[step], step);
    stage.set('failed');
    showConnectError((FAIL_TEXT[f] || 'Connection failed.') + (f === 'timeout' ? ' ' + timeoutAdvice(diag) : ''), f !== 'unsupported', f === 'timeout' || f === 'signaling');
  });
  s.on('signaling-down', ({ relay }) => {
    if (s !== session) return;
    $('peerStepText').textContent = relay ? 'Introduction server unreachable. Waiting through the relay instead' : 'Introduction server unreachable. Only another window of this browser can join right now';
    setSteps('peer', null, relay ? null : 'signal');
  });
  s.on('relay-up', () => { if (s === session && !s.everReady) { $('connectError').hidden = true; setSteps('peer', 'signal'); } });
  s.on('rejected', ({ count, locked, pair }) => {
    if (s !== session || pair) return;
    if (locked) { sys(`Someone tried to join, but the room is full (${MAX_MEMBERS} people), so they were turned away.`, 'is-warn'); return; }
    const msg = count === 1 ? 'A connection attempt was refused because it couldn\'t prove it had the room code.' : `${count} connection attempts were refused because they couldn't prove they had the room code.`;
    if (!s.everReady) toast(msg, true);
    else sys(msg, 'is-warn');
  });
  s.on('waiting-admit', ({ host }) => {
    if (s !== session) return;
    const who = cleanLabel(host, 24) || 'the host';
    $('connectTitle').textContent = 'Waiting to be let in';
    $('peerStepText').textContent = `The code is right. Waiting for ${who} to let you in`;
    setSteps('peer', 'signal');
  });
  s.on('denied', ({ reason }) => {
    if (s !== session) return;
    stage.set('failed');
    setSteps(null, 'signal', 'peer');
    showConnectError({
      full: `This room is full (${MAX_MEMBERS} people). Ask the host for a new invite later.`,
      timeout: 'Nobody let you in within 3 minutes. Ask the host to try again while you wait.',
    }[reason] || 'The host didn\'t let you in.', false);
  });
  s.on('joined', onJoined);
  s.on('member-join', ({ id }) => { if (s === session) { person(id); renderHead(); } });
  s.on('member-ready', onMemberReady);
  s.on('member-state', ({ id, state }) => {
    if (s !== session) return;
    const p = person(id);
    p.state = state; if (state !== 'ready') p.ready = false;
    renderHead();
  });
  s.on('member-left', onMemberLeft);
  s.on('knock', onKnock);
  s.on('knock-gone', ({ kid, reason }) => { if (s === session) knockGone(kid, reason); });
  s.on('invite-code', ({ code: c }) => {
    if (s !== session) return;
    if (role === 'host' && c) code = c;
    renderRoomCode(); renderHead();
    if (!$('inviteSheet').hidden) fillInvite();
  });
  s.on('invite-failed', () => { if (s === session) toast('Couldn\'t open the new invite. Use "Retire this code" in the invite to try again.', true); });
  s.on('settings', ({ canInvite }) => {
    if (s !== session) return;
    $('optCanInvite').checked = canInvite;
    if (role !== 'host' && $('chat').classList.contains('is-on')) sys(canInvite ? 'The host lets everyone invite people. The host still lets each newcomer in.' : 'Only the host can invite people now.');
    renderHead();
  });
  s.on('latency', ({ ms, from }) => {
    if (selPerson && from !== selPerson) return;
    $('kvLatency').textContent = ms + ' ms'; $('railLatency').textContent = ms + ' ms';
    setLink(ms < 250 ? 'is-good' : 'is-fair', `${ms} ms`);
  });
  s.on('delivered', ({ mid, from }) => {
    const r = msgs.get(mid);
    if (r && r.side === 'me') { r.deliveredTo.add(from); r.delivered = true; updateStatus(r); if (r.ttl) startBurn(r); }
  });
  s.on('message', onMessage);
  s.on('file-in', onFileIn);
  s.on('file-progress', onFileProgress);
  s.on('file-received', onFileReceived);
  s.on('file-failed', onFileFailed);
  s.on('file-sent', ({ fid, sent, total }) => {
    const r = msgs.get(fid);
    if (r) { r.sub.textContent = fmtSize(r.size) + (total > 1 ? (sent === total ? ` · sent to all ${total}` : ` · sent to ${sent} of ${total}`) : ' · sent'); r.cancelBtn?.remove(); if (r.ttl) startBurn(r); }
  });
  s.on('ended', ({ reason }) => onEnded(s, reason));
}

/** The first pair connected: open the conversation. */
async function onJoined() {
  const s = session;
  stopExpiryClock(); $('expiryRow').hidden = true;
  const first = s.first && people.get(s.first.id);
  $('hsThemName').textContent = first?.name || (role === 'host' ? 'Them' : 'The room');
  await stage.seal(s.safetyNumber, () => setSteps(null, 'ready'));
  if (!session || session !== s || s.ended) return;
  show('chat');
  applyDock();
  etherOut.clear(); etherIn.clear();
  $('kvRoom').textContent = roomIdFromCode(code).replace(/^ghostchat-v\d+-/, '').toUpperCase();
  $('phRoom').textContent = '· ' + $('kvRoom').textContent;
  renderRoomCode();
  sys(role === 'host'
    ? 'End-to-end encrypted with post-quantum protection. Only someone holding the room code could have joined, and anyone else who uses it has to wait for you to let them in.'
    : 'End-to-end encrypted with post-quantum protection. Only someone holding the room code could have joined. Every pair of people in this room has its own keys.', 'is-good');
  if (s.first) sysSafety(s.first.id);
  if (privacy === 'max') sys('Maximum privacy: relayed connection, constant-rate traffic, no typing indicator or read receipts.', 'is-good');
  $('optCanInvite').checked = s.canInvite;
  enableComposer();
  setLink('is-good', 'Encrypted');
  renderHead();
  refreshRoute();
  $('input').focus();
}

function onMemberReady({ id, safetyNumber, resumed, continuity, newPeer, first }) {
  if (!session) return;
  const p = person(id);
  const wasReady = p.everReady;
  p.ready = true; p.state = 'ready'; p.gone = false; p.everReady = true;
  if (!continuity) p.verified = false;   // a proven resume keeps your verification
  p.sn = safetyNumber;
  if (!selPerson || !people.get(selPerson) || people.get(selPerson).gone) selPerson = id;
  session.sendTo(id, { t: 'profile', name: me.name, avatar: me.avatar });
  if (opts.shape) session.sendTo(id, { t: 'shape', on: true });
  if (!resumed && burnSecs && (role === 'host' || !first)) session.sendTo(id, { t: 'timer', secs: burnSecs });
  if (resumed && wasReady) {
    if (newPeer) sys(`A new browser took ${nameOf(id)}'s place. The safety number changed, so verify it again before sharing anything sensitive.`, 'is-warn');
    else sys(present().length > 1 ? `Reconnected to ${nameOf(id)} with fresh keys. Their browser proved it's the same one as before, so the safety number hasn't changed.` : 'Reconnected with fresh keys. Their browser proved it\'s the same one as before, so the safety number hasn\'t changed.', 'is-good');
  } else if (!first) {
    // Their name arrives a moment later, with their profile.
    p.announce = setTimeout(() => announce(p), 1500);
  }
  $('kvLive').textContent = (session.members.get(id)?.s.liveSafetyNumber || '').split(' ').slice(0, 3).join(' ') || '—';
  renderHead(); renderSafety();
  refreshRoute();
  for (const r of msgs.values()) if (r.side === 'me' && !r.delivered) updateStatus(r);
}
function announce(p) {
  if (!p.announce || !session) return;
  clearTimeout(p.announce); p.announce = null;
  sys(`${nameOf(p.id)} joined. Your connection with them has its own keys and safety number.`, 'is-good');
  sysSafety(p.id);
}

function onMemberLeft({ id, reason, isHost, wasReady }) {
  if (!session) return;
  const p = person(id);
  const name = nameOf(id);
  p.gone = true; p.ready = false; clearTimeout(p.announce); p.announce = null;
  typers.delete(id); renderTyping();
  lastLeft = name;
  if (shapeWanted.delete(id) && !applyShape() && !session.ended) sys(`Constant-rate traffic is off: ${name}, who turned it on, left.`);   // their request leaves with them
  if (session.ended) return;
  const text = !wasReady ? `Couldn't connect to ${name}.`
    : reason === 'removed' ? (role === 'host' ? `You removed ${name} from the room.` : `The host removed ${name} from the room.`)
    : reason === 'peer-left' ? `${name} left.`
    : reason === 'resume-failed' ? `${name}'s browser couldn't prove it was the same one after reconnecting, so that connection was closed.`
    : `Lost the connection to ${name}.`;
  sys(text, reason === 'peer-left' || reason === 'removed' ? '' : 'is-warn');
  if (isHost && role !== 'host') sys('The host has left, so nobody new can join this room.', 'is-warn');
  if (selPerson === id) selPerson = present()[0]?.id || null;
  renderHead(); renderSafety();
  for (const r of msgs.values()) if (r.side === 'me') updateStatus(r);
}
let lastLeft = '';

function onAlone() {
  if (!$('chat').classList.contains('is-on')) return;
  setLink('is-down', 'Alone');
  lockComposer('Nobody else is here', 'You can send messages again when someone joins');
  showBanner('Everyone else has left. The room is still open: anyone with the code can ask to join, and you decide who comes in.', false, 'Leave');
}
function enableComposer() {
  $('chat').classList.remove('composer-locked');
  $('input').disabled = false; $('attachBtn').disabled = false; $('timerBtn').disabled = false;
  $('sendBtn').disabled = !$('input').value.trim();
  renderHead();   // restores the placeholder and the "encrypted for" line
}
/** Greys out the message box and says why nothing can be sent or received. */
function lockComposer(why, detail = 'Messages can\'t be sent or received') {
  $('chat').classList.add('composer-locked');
  clearReply(); clearEdit(); closeTimerMenu(); stopTyping();
  $('input').disabled = true; $('attachBtn').disabled = true; $('sendBtn').disabled = true; $('timerBtn').disabled = true;
  $('input').placeholder = why;
  $('encFor').textContent = detail;
}

// ── knocks (host): someone with the code wants in ──
const knockCards = new Map();
function onKnock({ kid, name, avatar }) {
  const n = distinctName(cleanName(name, 24) || 'Guest', null);
  const av = AVATARS.includes(avatar) ? avatar : '👤';
  const stick = atBottom();
  const card = h('div', 'knock-card');
  card.append(h('span', 'kn-av', av));
  const txt = h('div', 'kn-text');
  txt.append(h('b', null, `${n} wants to join`), h('small', null, 'They have the room code. Only let them in if you know who they are.'));
  const acts = h('div', 'kn-acts');
  const deny = h('button', 'btn btn-ghost btn-sm', 'Deny'); deny.type = 'button';
  const ok = h('button', 'btn btn-primary btn-sm', 'Let in'); ok.type = 'button';
  deny.onclick = () => { session?.deny(kid); };
  ok.onclick = () => { if (session?.admit(kid)) { knockGone(kid, 'admitted'); sys(`You let ${n} in. Connecting…`); } };
  acts.append(deny, ok);
  card.append(txt, acts);
  $('messages').append(card);
  knockCards.set(kid, { card, name: n, avatar: av });
  scrollDown(stick);
  toast(`${n} wants to join`);
  notifyIncoming('Someone wants to join');
  renderPeople();
}
function knockGone(kid, reason) {
  const k = knockCards.get(kid);
  if (!k) return;
  knockCards.delete(kid);
  k.card.remove();
  if (reason === 'denied') sys(`You turned ${k.name} away.`);
  else if (reason === 'timeout') sys(`${k.name} wasn't let in within 3 minutes, so they were turned away.`);
  else if (reason === 'full') sys(`${k.name} couldn't join: the room is full.`);
  else if (reason !== 'admitted') sys(`${k.name} stopped waiting.`);
  renderPeople();
}

async function refreshRoute() {
  const route = await session?.getRoute(selPerson);
  const label = { direct: 'Direct, peer-to-peer', local: 'Direct, same network', relay: 'Relayed via TURN server', 'relay-ws': 'Via the Ghost Chat relay (end-to-end encrypted)', device: 'Same browser on this device (no network)' }[route] || 'Unknown';
  $('kvRoute').textContent = label;
  $('railRoute').textContent = { direct: 'Direct · P2P', local: 'Direct · LAN', relay: 'Relayed (TURN)', 'relay-ws': 'Ghost Chat relay', device: 'This device' }[route] || '—';
  $('railRoute').classList.toggle('is-good', route === 'direct' || route === 'local' || route === 'device');
  const chip = $('routeChip');
  chip.hidden = !route;
  chip.textContent = { direct: 'P2P', local: 'LAN', relay: 'Relay', 'relay-ws': 'Relay', device: 'This device' }[route] || '';
  chip.title = label;
}

function onReconnecting() {
  setLink('is-down', 'Reconnecting');
  showBanner(role === 'joiner'
    ? 'Connection dropped. Reconnecting… Messages you send now are queued and delivered when it\'s back.'
    : 'Connection dropped. Waiting for the others to reconnect… Messages you send now are queued.');
  typers.clear(); renderTyping();
  for (const r of msgs.values()) if (r.side === 'me' && !r.delivered) updateStatus(r);
}

function onEnded(s, reason) {
  if (s !== session) return;
  const chatOn = $('chat').classList.contains('is-on');
  if (!chatOn) {
    if (reason === 'expired') {
      stage.set('failed'); setSteps(null, 'signal', 'peer');
      $('keycard').classList.add('is-spent');
      showConnectError(`This code expired: nobody joined within ${fmtSecs(Math.round((s.expiresAt - s.createdAt) / 1000))}. It no longer works, even for someone who has it.`, true, false, 'Get a new code');
    } else if (reason === 'host-left') showConnectError('The person who made this room left before letting you in. Ask them for a new invite.', false);
    else if (reason !== 'local' && reason !== 'denied' && s.state !== 'failed') showConnectError('The session ended.', false);
    return;
  }
  setLink('is-down', 'Ended');
  typers.clear(); renderTyping();
  for (const k of [...knockCards.keys()]) knockGone(k, 'admitted');
  const text = reason === 'kicked' ? 'The host removed you from this room.'
    : reason === 'room-ended' ? 'The host ended the session for everyone.'
    : reason === 'peer-left' ? (lastLeft && !inGroup() ? `${lastLeft} ended the session.` : 'Everyone else has left, so the session ended.')
    : reason === 'resume-failed' ? 'The other side couldn\'t prove it was the same conversation after reconnecting, so the session was closed.'
    : 'The connection couldn\'t be restored.';
  sys(text, 'is-bad');
  showBanner(text + ' Messages stay on screen until you leave.', true, 'Leave');
  renderHead();
  $('input').value = ''; autosize();
  lockComposer('This chat has ended', 'Messages can\'t be sent or received any more');
}

// ───────────────────────────── chat rendering ─────────────────────────────
function setLink(cls, text) {
  const el = $('linkState');
  el.className = 'link-state ' + cls;
  $('linkText').textContent = text;
}
function showBanner(text, bad = false, actionLabel) {
  const b = $('banner');
  b.replaceChildren(document.createTextNode(text));
  b.classList.toggle('is-bad', bad);
  if (actionLabel) {
    const btn = h('button', 'btn btn-ghost btn-sm', actionLabel);
    btn.type = 'button'; btn.style.marginLeft = '12px';
    btn.onclick = async () => { if (session && !session.ended) await session.end(); teardown(); show('home'); };
    b.append(btn);
  }
  b.hidden = false;
}
function hideBanner() { $('banner').hidden = true; }

function atBottom() { const m = $('messages'); return m.scrollHeight - m.scrollTop - m.clientHeight < 80; }
function scrollDown(force) { const m = $('messages'); if (force || atBottom()) requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; }); }

const MAX_SYS = 300;   // system notices kept on screen; older ones drop off
function sys(text, cls = '') {
  const stick = atBottom();
  const el = h('div', 'sys ' + cls, text);
  $('messages').append(el);
  const all = $('messages').querySelectorAll('.sys');
  for (let i = 0; i < all.length - MAX_SYS; i++) all[i].remove();
  scrollDown(stick);
  return el;
}
// Actions from others that change the room or post a notice (unsend all, clear, timer,
// constant-rate) are limited per person, so nobody can flood the screen or the CPU.
const noticeLog = new Map();   // member id → recent timestamps
function withinBudget(from, max = 12, perMs = 10_000) {
  const now = Date.now();
  const t = (noticeLog.get(from) || []).filter((x) => now - x < perMs);
  if (t.length >= max) { noticeLog.set(from, t); return false; }
  t.push(now); noticeLog.set(from, t);
  return true;
}
function sysSafety(id) {
  const p = people.get(id);
  if (!p?.sn) return;
  const stick = atBottom();
  const card = h('div', 'sn-card');
  const head = h('div', 'sn-card-head');
  const group = inGroup();
  head.append(h('strong', null, group ? `Safety number with ${nameOf(id)}` : 'Safety number'),
    h('span', null, group ? `Only you and ${nameOf(id)} share this number. Compare it by voice; if it matches, nobody is in the middle.` : 'Read it to the other person by voice. If both screens match, nobody is in the middle.'));
  const grid = h('div', 'sn-card-grid mono');
  for (const g of p.sn.split(' ')) grid.append(h('span', null, g));
  const btn = h('button', 'btn btn-ghost btn-sm sn-open', 'Compare and verify');
  btn.type = 'button'; btn.onclick = () => showSafetyFor(id);
  card.append(head, grid, btn);
  $('messages').append(card);
  scrollDown(stick);
}

/** The room rail's code: shown only to people who may share it. */
function renderRoomCode() {
  const c = canInviteNow() ? shareCode() : null;
  $('railCode').replaceChildren(...(c ? c.split('-').map((g) => h('span', null, g)) : []));
  $('railCode').setAttribute('aria-label', c ? 'Room code ' + c : '');
  $('railCode').closest('.room-code').hidden = !c;
}
/** Opens the details panel on someone's safety number. */
function showSafetyFor(id) {
  if (id) { selPerson = id; renderSafety(); refreshRoute(); }
  closeRail();
  openPanel(true, 'safety');
  setTimeout(() => { $('snSec').scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }); $('markVerified').focus({ preventScroll: true }); }, 60);
}
/** The panel's safety number: for the selected person (a picker appears in groups). */
function renderSafety() {
  const list = present().filter((p) => p.sn);
  if (selPerson && !list.some((p) => p.id === selPerson)) selPerson = list[0]?.id || null;
  const p = selPerson && people.get(selPerson);
  const pick = $('snPick');
  pick.replaceChildren();
  pick.hidden = list.length < 2;
  for (const q of list) {
    const b = h('button', 'sn-who' + (q.verified ? ' is-verified' : ''));
    b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(q.id === selPerson));
    b.append(h('span', null, q.avatar), h('b', null, q.name || '…'));
    b.onclick = () => { selPerson = q.id; renderSafety(); refreshRoute(); };
    pick.append(b);
  }
  const box = $('safetyNumber');
  if (!p?.sn) { box.replaceChildren(); delete box.dataset.value; }
  else { box.replaceChildren(...p.sn.split(' ').map((g) => h('span', null, g))); box.dataset.value = p.sn; }
  $('snWith').textContent = list.length > 1 && p ? `With ${p.name || 'them'}` : '';
  applyVerified();
}
function applyVerified() {
  const p = selPerson && people.get(selPerson);
  const v = !!p?.verified;
  const list = present().filter((q) => q.sn);
  const nV = list.filter((q) => q.verified).length;
  const all = allVerified();
  const label = all ? 'Verified' : list.length > 1 && nV ? `${nV} of ${list.length} verified` : 'Not verified';
  $('verifyText').textContent = label;
  // The header control is an action, worded as one: what to do, not a status to decode.
  const left = list.length - nV;
  $('verifyText').textContent = all ? 'Verified' : list.length > 1 ? `Verify ${left} ${left === 1 ? 'person' : 'people'}` : 'Verify identity';
  $('verifyChip').title = all ? 'You compared safety numbers: nobody is in the middle'
    : 'Compare safety numbers by voice to make sure nobody is listening in between';
  $('verifyChip').setAttribute('aria-label', all ? 'Verified: safety numbers match' : $('verifyText').textContent + ': compare safety numbers');
  $('verifyChip').classList.toggle('is-verified', all);
  syncHead();
  $('pidTrust').textContent = label;
  $('pidTrust').classList.toggle('is-verified', all);
  $('qaVerify').classList.toggle('is-done', all);
  $('qaVerifySub').textContent = all ? 'All safety numbers match' : list.length > 1 ? `${list.length - nV} still to compare` : 'Compare safety numbers';
  $('markVerified').setAttribute('aria-pressed', String(v));
  $('markVerified').textContent = v ? 'Verified' : 'Mark as verified';
  $('safetyNumber').classList.toggle('is-verified', v);
  $('trustBadge').classList.toggle('is-verified', v);
  const who = list.length > 1 && p ? p.name || 'them' : 'the other person';
  $('trustTitle').textContent = v ? 'Nobody in between' : 'Not verified yet';
  $('trustSub').textContent = v ? `You and ${list.length > 1 ? who : 'they'} confirmed the same safety number.` : `Compare the safety number with ${who} by voice to rule out anyone in the middle.`;
}

/** Header and panel identity: one person, or the group. */
function renderHead() {
  const list = present();
  const names = list.map((p) => p.name || '…');
  const title = !list.length ? (role === 'host' ? 'Just you' : 'Nobody here')
    : list.length === 1 ? names[0]
    : list.length === 2 ? `${names[0]} & ${names[1]}`
    : `${names[0]}, ${names[1]} +${list.length - 2}`;
  $('peerName').textContent = title;
  $('peerAvatar').textContent = list.length === 1 ? list[0].avatar : list.length ? '👥' : '👤';
  $('panelName').textContent = list.length > 1 ? `${list.length + 1} people` : title;
  $('panelAvatar').textContent = $('peerAvatar').textContent;
  $('pidSub').textContent = list.length > 1 ? names.join(' · ') : 'Nothing stored on this device';
  $('qaInvite').hidden = !canInviteNow();
  $('qaInvite').parentElement.classList.toggle('is-odd', $('qaInvite').hidden);
  $('qaEndLbl').textContent = role === 'host' && list.length ? 'End' : 'Leave';
  $('qaEndSub').textContent = role === 'host' && list.length ? 'For everyone' : 'Others are told';
  $('peoplesTitle').textContent = `People · ${list.length + 1} of ${MAX_MEMBERS}`;
  $('headCount').textContent = list.length > 1 ? `${list.length + 1} people` : '';
  $('chat').classList.toggle('is-group', list.length > 1);
  $('railInvite').hidden = !canInviteNow();
  renderRoomCode();
  $('railInviteNote').hidden = canInviteNow() || !session;
  $('railInviteNote').textContent = session?.ended ? 'This chat has ended.' : 'Only the host can invite people to this room.';
  $('railMeSub').textContent = role === 'host' ? 'You · host' : 'You';
  if (!$('chat').classList.contains('composer-locked')) $('encFor').textContent = !list.length ? 'End-to-end encrypted'
    : list.length <= 3 ? `Encrypted for ${list.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]} only`
    : `Encrypted for the ${list.length} people here only`;
  if (!$('chat').classList.contains('composer-locked')) $('input').placeholder = list.length === 1 ? `Message ${names[0]}` : list.length ? 'Message everyone' : 'Message';
  $('canInviteRow').hidden = role !== 'host';
  $('clearAllBtn').hidden = role !== 'host';
  $('kvAccess').textContent = role === 'host' ? 'Anyone else with the code waits for you to let them in' : 'Newcomers wait for the host to let them in';
  for (const n of document.querySelectorAll('.msg-name[data-from] .msg-who')) n.textContent = nameOf(n.parentElement.dataset.from);
  for (const a of document.querySelectorAll('.msg-av[data-from]')) a.textContent = people.get(a.dataset.from)?.avatar || '👤';
  applyVerified();
  renderPeople();
  renderTyping();
}

/** A small icon button; the label is for screen readers and the tooltip. */
const SVGNS = 'http://www.w3.org/2000/svg';
function iconBtn(cls, label, paths) {
  const b = h('button', cls); b.type = 'button';
  b.setAttribute('aria-label', label); b.title = label;
  const svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  // Fixed, trusted markup from this file only; never message content.
  for (const m of paths.matchAll(/<(path|circle) ([^>]*)\/>/g)) {
    const el = document.createElementNS(SVGNS, m[1]);
    for (const [, k, v] of m[2].matchAll(/([a-z]+)="([^"]*)"/g)) el.setAttribute(k, v);
    svg.append(el);
  }
  b.append(svg);
  return b;
}
/** The People section: everyone here, their state, and the host's controls. */
function renderPeople() {
  const box = $('peopleList');
  if (!box) return;
  box.replaceChildren();
  const row = (av, name, tag, sub, cls) => {
    const r = h('div', 'pp-row' + (cls ? ' ' + cls : ''));
    r.append(h('span', 'pp-av', av));
    const t = h('div', 'pp-text');
    const nm = h('b', null, name);
    if (tag) nm.append(h('em', 'pp-tag', tag));
    t.append(nm, h('small', null, sub));
    r.append(t);
    box.append(r);
    return r;
  };
  row(me.avatar, me.name + ' (you)', role === 'host' ? 'Host' : '', 'This browser', 'is-me');
  for (const p of present()) {
    const sub = session?.ended ? 'Disconnected' : !p.ready ? (p.state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…') : p.verified ? 'Verified' : 'Not verified';
    const r = row(p.avatar, p.name || '…', isHostId(p.id) ? 'Host' : '', sub, p.verified ? 'is-verified' : p.ready ? 'is-unverified' : '');
    if (p.sn && !session?.ended) {
      const b = iconBtn('pp-btn', `Safety number with ${p.name || 'them'}`, '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>');
      b.onclick = () => showSafetyFor(p.id);
      r.append(b);
    }
    if (role === 'host' && !session?.ended) {
      const b = iconBtn('pp-btn is-danger', `Remove ${p.name || 'them'}`, '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0M16 11h6"/>');
      b.onclick = async () => {
        if (!(await confirmDialog(`Remove ${p.name || 'them'}?`, 'Everyone disconnects from them at once. They can only come back if they ask again with the code and you let them in.', 'Remove', { danger: true }))) return;
        session?.remove(p.id);
      };
      r.append(b);
    }
  }
  for (const [kid, k] of knockCards) {
    const r = row(k.avatar, k.name, '', 'Waiting to be let in', 'is-knock');
    const no = h('button', 'pp-btn', 'Deny'); no.type = 'button'; no.onclick = () => session?.deny(kid);
    const yes = h('button', 'pp-btn is-primary', 'Let in'); yes.type = 'button';
    yes.onclick = () => { if (session?.admit(kid)) { knockGone(kid, 'admitted'); sys(`You let ${k.name} in. Connecting…`); } };
    r.append(no, yes);
  }
}

// ───────────────────────────── ether line: live ciphertext ─────────────────────────────
const etherOut = new EtherLine($('etherOut'), 260, 'prepend');
const etherIn = new EtherLine($('etherIn'), 260, 'append');
const wireLast = { in: 0, out: 0 };
function onWire(dir, bytes) {
  const now = performance.now();
  if (now - wireLast[dir] < 90) return;   // file transfers send hundreds of frames a second
  wireLast[dir] = now;
  (dir === 'out' ? etherOut : etherIn).push(bytes);
  const ch = session?.active?.channel;
  if (ch) $('kvKeys').textContent = $('railKeys').textContent = String(ch.tx.n + ch.rx.n);
}
$('markVerified').onclick = () => {
  const p = selPerson && people.get(selPerson);
  if (!p?.sn) return;
  p.verified = !p.verified; renderSafety(); renderPeople();
  if (p.verified) { sys(inGroup() ? `You marked your safety number with ${nameOf(p.id)} as verified.` : 'You marked the safety number as verified.', 'is-good'); flash($('trustBadge'), 'is-pop', 900); }
};
$('copySafety').onclick = () => copy($('safetyNumber').dataset.value || '', 'Safety number');
$('verifyChip').onclick = () => {
  const next = present().find((p) => p.sn && !p.verified);
  showSafetyFor(next ? next.id : null);
};
// One verify control on screen at a time: the header chip only shows while the panel is hidden.
function syncHead() {
  const panelShown = !$('panel').hidden;
  // Nothing to verify when nobody is here (or the chat has ended).
  const nobody = !present().some((p) => p.sn) || !session || session.ended;
  $('verifyChip').hidden = panelShown || nobody;
  $('chat').classList.toggle('panel-shown', panelShown);
}

// Linkify http(s) URLs as text nodes + anchors — no HTML parsing.
function fillText(el, text) {
  const re = /\bhttps?:\/\/[^\s<>"']+/gi;
  let last = 0, m;
  while ((m = re.exec(text))) {
    let url = m[0].replace(/[).,;:!?]+$/, '');
    if (m.index > last) el.append(text.slice(last, m.index));
    const u = parseLink(url);
    if (u) {
      const a = h('a', null, url); a.href = u.href; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
      a.addEventListener('click', (e) => { e.preventDefault(); openLink(u); });
      // Middle-click and dragging out would open it without the check: route them through it too.
      a.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); openLink(u); } });
      a.draggable = false; a.addEventListener('dragstart', (e) => e.preventDefault());
      el.append(a);
    } else el.append(url);
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < text.length) el.append(text.slice(last));
}
/**
 * Links never open on a single click: the dialog shows where it really goes (the hostname in
 * ASCII, so look-alike Unicode domains show as xn--…) and that leaving reveals your IP.
 */
async function openLink(u) {
  const host = u.hostname;
  const lookalike = host.split('.').some((p) => p.startsWith('xn--'));
  // "https://bank.example@evil.example/" goes to evil.example: the part before @ is a disguise.
  const disguised = !!(u.username || u.password);
  const ok = await confirmDialog('Open this link?',
    `It goes to ${host}. ` +
    (disguised ? 'Careful: the address puts other text before an @ sign to look like a different site; it really goes to ' + host + '. ' : '') +
    (lookalike ? 'Careful: this address uses look-alike characters and may imitate another site. ' : '') +
    'It opens in a new tab outside Ghost Chat, and that site will see your IP address.', 'Open link', { danger: lookalike || disguised, detail: u.href });
  if (ok) window.open(u.href, '_blank', 'noopener,noreferrer');
}
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s){1,12}$/u;

function newRecord(id, side, ts, extra = {}) {
  const el = h('div', 'msg ' + side + ' arrive');
  el.dataset.id = id;
  const r = { id, wid: id, side, ts, el, reacts: new Map(), delivered: side !== 'me', read: false, seen: false, ttl: 0, burnAt: 0, urls: [],
    from: null, to: new Set(side === 'me' && session ? session.memberIds() : []), deliveredTo: new Set(), readBy: new Set(), ...extra };
  msgs.set(id, r);
  // A flooding peer can't grow the page without bound: the oldest messages drop off.
  if (msgs.size > MAX_RECORDS) { const oldest = msgs.values().next().value; if (oldest && oldest !== r) removeRecord(oldest, false); }
  return r;
}
const MAX_RECORDS = 2000;

function placeRecord(r, body) {
  const prev = [...$('messages').children].reverse().find((n) => n.classList.contains('msg') || n.classList.contains('sys'));
  const prevRec = prev && prev.classList.contains('msg') ? msgs.get(prev.dataset.id) : null;
  const grouped = prevRec && prevRec.side === r.side && prevRec.from === r.from && r.ts - prevRec.ts < GROUP_GAP_MS;
  if (grouped) prevRec.el.classList.remove('last'); else r.el.classList.add('first');
  r.el.classList.add('last');
  r.el.append(avatarTag(r));
  if (!grouped) r.el.append(nameTag(r));
  r.el.append(body);
  // A visible way into the actions (edit, delete, reply…) for mouse users; touch uses long-press.
  const more = h('button', 'msg-more');
  more.type = 'button'; more.setAttribute('aria-label', 'Message actions'); more.tabIndex = -1;
  for (let i = 0; i < 3; i++) more.append(h('i'));
  more.onclick = (e) => { e.stopPropagation(); const b = more.getBoundingClientRect(); openMenu(r, r.side === 'me' ? b.left - 180 : b.left, b.bottom + 4); };
  r.el.append(more);
  r.reactsEl = h('div', 'reacts'); r.reactsEl.hidden = true;
  r.metaEl = h('div', 'meta');
  r.timeEl = h('span', 'time', fmtTime(r.ts));
  r.statusEl = h('span', 'status');
  r.burnEl = h('span', 'burn');
  r.metaEl.append(r.burnEl, r.timeEl, r.statusEl);
  r.el.append(r.reactsEl, r.metaEl);
  const stick = atBottom() || r.side === 'me';
  $('messages').append(r.el);
  r.el.addEventListener('animationend', () => r.el.classList.remove('arrive'), { once: true });
  bindMenu(r, body);
  if (r.ttl) r.burnEl.textContent = '⏱ ' + fmtSecs(r.ttl);
  updateStatus(r);
  scrollDown(stick);
  if (r.side === 'them') markSeenSoon();
}

function nameTag(r) {
  const n = h('div', 'msg-name');
  n.append(h('span', 'msg-who', r.side === 'me' ? 'You' : nameOf(r.from)), h('span', 'msg-when', fmtTime(r.ts)));
  if (r.side === 'them' && r.from) n.dataset.from = r.from;
  return n;
}
function avatarTag(r) {
  const a = h('span', 'msg-av', r.side === 'me' ? me.avatar : people.get(r.from)?.avatar || '👤');
  a.setAttribute('aria-hidden', 'true');
  if (r.side === 'them' && r.from) a.dataset.from = r.from;
  return a;
}
function regroup() {
  let prev = null;
  for (const n of $('messages').children) {
    if (!n.classList.contains('msg')) { if (prev) prev.el.classList.add('last'); prev = null; continue; }
    const r = msgs.get(n.dataset.id);
    if (!r) continue;
    const grouped = prev && prev.side === r.side && prev.from === r.from && r.ts - prev.ts < GROUP_GAP_MS;
    r.el.classList.toggle('first', !grouped);
    if (prev) prev.el.classList.toggle('last', !grouped);
    r.el.classList.add('last');
    const nameEl = r.el.querySelector('.msg-name');
    if (!grouped && !nameEl) r.el.querySelector('.msg-av').after(nameTag(r));
    if (grouped && nameEl) nameEl.remove();
    prev = r;
  }
}

function addText(side, { id, wid = id, text, ts, ttl = 0, reply = null, from = null }) {
  const r = newRecord(id, side, ts, { kind: 'text', text, ttl, from, wid });
  const bubble = h('div', 'bubble');
  bubble.dir = 'auto';
  bubble.tabIndex = 0;
  if (reply) {
    const q = h('span', 'quote' + (reply.gone ? ' is-gone' : '') + (reply.file ? ' is-file' : ''));
    if (reply.name) q.append(h('span', 'q-name', reply.name));
    q.append(h('span', 'q-text', reply.text));
    if (!reply.gone) {
      q.setAttribute('role', 'button'); q.tabIndex = 0;
      q.setAttribute('aria-label', `Go to the message from ${reply.name}: ${reply.text}`);
      q.onclick = (e) => { e.stopPropagation(); jumpTo(reply.key ?? reply.mid); };
      q.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); jumpTo(reply.key ?? reply.mid); } };
    }
    bubble.append(q);
  }
  if (!reply && EMOJI_ONLY.test(text) && !/^[\s\d#*]+$/.test(text)) bubble.classList.add('emoji-only');
  const span = h('span');
  fillText(span, text);
  bubble.append(span);
  r.textEl = span; r.bubble = bubble;
  placeRecord(r, bubble);
  // Incoming text "decrypts" into place. Skipped for bursts, long text and emoji, so it never
  // gets in the way of reading.
  const now = performance.now();
  if (side === 'them' && !bubble.classList.contains('emoji-only') && text.length <= 280 && now - lastDecryptAt > 500 && !reducedMotion()) {
    scrambleOverlay(span, text, { duration: Math.min(650, 220 + text.length * 10) });
  }
  if (side === 'them') lastDecryptAt = now;
  return r;
}
let lastDecryptAt = 0;

/** What a reply quotes: resolved from our own copy of the conversation, by wire id. */
function findByWire(mid) {
  const r = msgs.get(mid);
  if (r && r.wid === mid) return r;
  for (const x of msgs.values()) if (x.wid === mid) return x;
  return null;
}
const fileLabel = (r) => (r.isImage ? 'Photo' : 'File') + (r.name ? ' · ' + r.name : '');
function quoteFor(mid) {
  const r = findByWire(mid) || msgs.get(mid);
  if (!r) return { mid, key: null, name: '', text: 'Original message is no longer here', gone: true };
  return { mid, key: r.id, name: r.side === 'me' ? 'You' : nameOf(r.from), text: (r.kind === 'text' ? r.text : fileLabel(r)).slice(0, 120), file: r.kind !== 'text' };
}

function applyEdit(r, text) {
  r.text = text;
  r.textEl.replaceChildren();
  fillText(r.textEl, text);
  r.bubble.classList.remove('emoji-only');
  if (!r.editedEl) { r.editedEl = h('span', 'edited', 'edited'); r.bubble.append(r.editedEl); }
  flash(r.bubble, 'is-edited', 900);
  if (replyTo?.key === r.id) setReply(r);
}

function jumpTo(id) {
  const r = msgs.get(id) || findByWire(id);
  if (!r) return toast('That message is no longer here');
  r.el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  r.el.classList.remove('flash'); void r.el.offsetWidth;   // restart the highlight if it's already running
  r.el.classList.add('flash');
  clearTimeout(r.flashT); r.flashT = setTimeout(() => r.el.classList.remove('flash'), 1800);
}

function updateStatus(r) {
  if (r.side !== 'me' || !r.statusEl || r.kind !== 'text') return;
  // Counted against the people who were here when it was sent and haven't left since.
  const live = [...r.to].filter((id) => people.has(id) && !people.get(id).gone);
  const nRead = live.filter((id) => r.readBy.has(id)).length;
  const nDel = live.filter((id) => r.deliveredTo.has(id) || r.readBy.has(id)).length;
  const many = r.to.size > 1;
  let t = 'Sent', cls = 'status';
  if (live.length && nRead === live.length) { t = 'Read'; cls += ' is-read'; }
  else if (many && nRead) { t = `Read by ${nRead}`; cls += ' is-read'; }
  else if (live.length && nDel === live.length) t = 'Delivered';
  else if (many && nDel) t = `Delivered to ${nDel}`;
  else if (!session || session.state !== 'ready') { t = 'Queued'; cls += ' is-queued'; }
  r.read = live.length > 0 && nRead === live.length;
  r.statusEl.textContent = t;
  r.statusEl.className = cls;
}

function renderReacts(r) {
  const counts = new Map();
  for (const [who, e] of r.reacts) {
    if (who !== 'me' && people.get(who)?.gone) continue;
    if (e) { const c = counts.get(e) || { n: 0, mine: false, who: [] }; c.n++; c.who.push(who === 'me' ? 'You' : nameOf(who)); if (who === 'me') c.mine = true; counts.set(e, c); }
  }
  r.reactsEl.replaceChildren();
  for (const [e, c] of counts) {
    const chip = h('span', 'react' + (c.mine ? ' mine' : ''), e);
    chip.title = c.who.join(', ');
    if (c.n > 1) chip.append(h('small', null, String(c.n)));
    r.reactsEl.append(chip);
  }
  r.reactsEl.hidden = counts.size === 0;
}

function removeRecord(r, animate = true) {
  if (!msgs.has(r.id)) return;
  msgs.delete(r.id);
  const done = () => { r.el.remove(); r.urls.forEach(release); regroup(); };
  if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) { r.el.classList.add('dissolve'); setTimeout(done, 600); }
  else done();
  if (replyTo?.key === r.id) clearReply();
  if (editing === r) clearEdit();
  // Nothing removed may stay on screen: an open image viewer or message menu goes with it.
  if (!$('viewer').hidden && r.urls.includes($('viewerImg').getAttribute('src'))) closeViewer();
  if (menuFor === r) closeMenu();
}

// ───────────────────────────── disappearing messages ─────────────────────────────
function startBurn(r) {
  if (!r.ttl || r.burnAt) return;
  r.burnAt = Date.now() + r.ttl * 1000;
}
setInterval(() => {
  const now = Date.now();
  for (const r of [...msgs.values()]) {
    if (!r.burnAt) continue;
    const left = r.burnAt - now;
    if (left <= 0) removeRecord(r);
    else if (r.burnEl) { r.burnEl.textContent = '⏱ ' + fmtLeft(left); r.el.classList.add('show-meta'); }
  }
}, 500);

function setTimer(secs, by) {
  burnSecs = secs;
  for (const b of $('timerOptions').children) b.setAttribute('aria-checked', String(Number(b.dataset.secs) === secs));
  $('timerBadge').hidden = !secs;
  $('timerBadge').textContent = secs ? fmtSecs(secs) : '';
  $('timerBtn').classList.toggle('is-on', !!secs);
  $('timerBtn').setAttribute('aria-label', 'Disappearing messages: ' + (secs ? fmtSecs(secs) : 'off'));
  $('railTimer').textContent = secs ? fmtSecs(secs) : 'Off';
  for (const b of $('timerMenu').querySelectorAll('[data-secs]')) b.setAttribute('aria-checked', String(Number(b.dataset.secs) === secs));
  const who = by === 'me' ? 'You' : nameOf(by);
  sys(secs ? `${who} set messages to disappear after ${fmtSecs(secs)}.` : `${who} turned off disappearing messages.`, secs ? 'is-warn' : '');
}
function chooseTimer(secs) { if (secs === burnSecs || !session || session.ended) return; setTimer(secs, 'me'); session.send({ t: 'timer', secs }); }
(function buildTimers() {
  for (const [secs, label] of TIMERS) {
    const b = h('button', null, label);
    b.type = 'button'; b.dataset.secs = secs; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(secs === 0));
    b.onclick = () => chooseTimer(secs);
    $('timerOptions').append(b);
    const m = h('button', 'tm-item', secs ? label : 'Off');
    m.type = 'button'; m.dataset.secs = secs; m.setAttribute('role', 'menuitemradio'); m.setAttribute('aria-checked', String(secs === 0));
    m.onclick = () => { closeTimerMenu(); chooseTimer(secs); $('input').focus(); };
    $('timerMenu').append(m);
  }
})();
function closeTimerMenu() { $('timerMenu').hidden = true; $('timerBtn').setAttribute('aria-expanded', 'false'); }
$('timerBtn').onclick = () => {
  const open = $('timerMenu').hidden;
  $('timerMenu').hidden = !open; $('timerBtn').setAttribute('aria-expanded', String(open));
  if (open) $('timerMenu').querySelector('[aria-checked="true"]')?.focus();
};
document.addEventListener('pointerdown', (e) => { if (!$('timerMenu').hidden && !e.target.closest('#timerMenu, #timerBtn')) closeTimerMenu(); });

// ───────────────────────────── read receipts ─────────────────────────────
let seenTimer = null;
function markSeenSoon() { clearTimeout(seenTimer); seenTimer = setTimeout(markSeen, 150); }
function markSeen() {
  if (document.hidden || !$('chat')?.classList.contains('is-on') || !$('veil').hidden) return;
  const byAuthor = new Map();
  for (const r of msgs.values()) {
    if (r.side !== 'them' || r.seen) continue;
    r.seen = true;
    if (r.ttl) startBurn(r);
    if (r.kind === 'text' && r.from) { if (!byAuthor.has(r.from)) byAuthor.set(r.from, []); byAuthor.get(r.from).push(r.wid); }
  }
  // Each author is told only about their own messages.
  if (opts.receipts && session?.state === 'ready') for (const [id, ids] of byAuthor) session.sendTo(id, { t: 'read', ids: ids.slice(0, 200) });
  unread = 0; updateTitle();
}
function updateTitle() { document.title = unread ? `(${unread}) Ghost Chat` : 'Ghost Chat'; }

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) markSeen();
  else if (opts.veil && $('chat').classList.contains('is-on')) $('veil').hidden = false;
});
window.addEventListener('blur', () => { if (opts.veil && $('chat').classList.contains('is-on')) $('veil').hidden = false; });
$('unveilBtn').onclick = () => { $('veil').hidden = true; markSeen(); $('input').focus(); };

// ───────────────────────────── inbound ─────────────────────────────
/** The record `from` authored under wire ID `mid`, wherever a clash put it; else null. */
function authoredBy(from, mid) {
  const r = msgs.get(mid);
  if (r && r.side === 'them' && r.from === from) return r;
  const alt = msgs.get(from + ':' + mid);
  return alt && alt.side === 'them' && alt.from === from ? alt : null;
}
function onMessage(o) {
  const from = o.from;
  if (!from || !session) return;
  switch (o.t) {
    case 'profile': {
      const p = person(from);
      // A name is set once per person and never changes afterwards: the app has no way to
      // rename mid-chat, so a later "profile" could only be someone relabelling their past
      // messages or posing as another member.
      if (p.name) return;
      p.name = distinctName(cleanName(o.name, 24) || 'Guest', from);
      p.avatar = AVATARS.includes(o.avatar) ? o.avatar : '👤';
      renderHead(); renderSafety();
      if (p.announce) announce(p);
      return;
    }
    case 'msg': {
      if (typeof o.text !== 'string' || !o.text || !isMid(o.mid)) return;
      // Everyone in a group receives the same message ID, so another member could reuse it to
      // claim the slot before the real message arrives. A clash never replaces or hides a record:
      // the newcomer is kept under a per-author key instead.
      let key = o.mid;
      const clash = msgs.get(o.mid);
      if (clash) {
        if (clash.side === 'them' && clash.from === from) return;   // a resend we already have
        key = from + ':' + o.mid;
        if (msgs.has(key)) return;
      }
      const ttl = Number.isInteger(o.ttl) && o.ttl > 0 && o.ttl <= 86400 ? o.ttl : 0;
      // Quotes are resolved from our own copy of the conversation; the sender only names the message.
      const reply = o.reply && isMid(o.reply.mid) ? quoteFor(o.reply.mid) : null;
      const text = cleanText(o.text, LIMITS.maxText);
      if (!text.trim()) return;
      addText('them', { id: key, wid: o.mid, text, ts: Date.now(), ttl, reply, from });
      typers.delete(from); renderTyping();
      notifyIncoming();
      return;
    }
    case 'read': {
      if (!Array.isArray(o.ids)) return;
      for (const id of o.ids.slice(0, 200)) {
        const r = msgs.get(id);
        if (r && r.side === 'me' && r.to.has(from)) { r.readBy.add(from); r.delivered = true; updateStatus(r); if (r.ttl) startBurn(r); }
      }
      return;
    }
    case 'typing':
      clearTimeout(typers.get(from));
      if (o.on === true) typers.set(from, setTimeout(() => { typers.delete(from); renderTyping(); }, 6000));
      else typers.delete(from);
      renderTyping();
      return;
    case 'react': {
      const r = isMid(o.target) && msgs.get(o.target);
      if (!r) return;
      r.reacts.set(from, REACTIONS.includes(o.emoji) ? o.emoji : null);
      renderReacts(r);
      return;
    }
    case 'edit': {
      // Only the author can edit, only text, and the new text passes the same checks as a new message.
      if (!isMid(o.target) || typeof o.text !== 'string') return;
      const r = authoredBy(from, o.target);
      if (!r || r.kind !== 'text') return;
      const text = cleanText(o.text, LIMITS.maxText);
      if (!text.trim() || text === r.text) return;
      applyEdit(r, text);
      return;
    }
    case 'unsend': {
      const r = isMid(o.target) && authoredBy(from, o.target);
      if (r) { removeRecord(r); if (withinBudget(from, 30)) sys(`${nameOf(from)} unsent a message.`); }
      return;
    }
    case 'unsend-all': {
      if (!withinBudget(from)) return;
      let n = 0;
      for (const r of [...msgs.values()]) if (r.side === 'them' && r.from === from) { removeRecord(r); n++; }
      sys(`${nameOf(from)} unsent all their messages${n ? '' : ' (there were none here)'}.`);
      return;
    }
    case 'clear-all': {
      if (!isHostId(from)) return;   // only the host can clear everyone's screens
      if (!withinBudget(from)) return;
      clearAll();
      sys(`${nameOf(from)} (the host) cleared the chat for everyone.`, 'is-warn');
      return;
    }
    case 'shape': {
      const on = o.on === true;
      if (on !== shapeWanted.has(from) && withinBudget(from)) setShape(on, from);
      return;
    }
    case 'timer': {
      const secs = Number(o.secs);
      if (TIMERS.some(([t]) => t === secs) && secs !== burnSecs && withinBudget(from)) setTimer(secs, from);
      return;
    }
  }
}

// ── typing: who is typing right now ──
const typers = new Map();   // member id → hide timer
function renderTyping() {
  const ids = [...typers.keys()].filter((id) => people.has(id) && !people.get(id).gone);
  $('typing').hidden = !ids.length;
  if (!ids.length) return;
  const n = ids.map(nameOf);
  $('typingText').textContent = n.length === 1 ? `${n[0]} is typing` : n.length === 2 ? `${n[0]} and ${n[1]} are typing` : `${n.length} people are typing`;
}

/** Removes every message and file from this screen (used by "clear for everyone"). */
function clearAll() {
  for (const r of [...msgs.values()]) removeRecord(r, false);
  for (const n of [...$('messages').querySelectorAll('.sys, .sn-card')]) n.remove();
  clearReply(); clearEdit();
}

function notifyIncoming(body = 'New message') {
  if (!document.hidden) return;
  unread++; updateTitle();
  if (opts.notify && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('Ghost Chat', { body, tag: 'ghostchat', silent: false }); } catch {}
  }
}

// ───────────────────────────── outbound ─────────────────────────────
const input = $('input');
const coarse = matchMedia('(pointer: coarse)').matches;
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
input.addEventListener('input', () => {
  autosize();
  $('sendBtn').disabled = !input.value.trim() || !session || session.ended;
  if (!opts.typing || session?.state !== 'ready') return;
  const now = Date.now();
  if (input.value && now - lastTypingSent > 2500) { lastTypingSent = now; session.sendVolatile({ t: 'typing', on: true }); }
  clearTimeout(typingIdle);
  typingIdle = setTimeout(stopTyping, 3500);
});
function stopTyping() {
  clearTimeout(typingIdle);
  if (lastTypingSent && session?.state === 'ready') session.sendVolatile({ t: 'typing', on: false });
  lastTypingSent = 0;
}
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); sendText(); }
  if (e.key === 'ArrowUp' && !input.value && session && !session.ended) {
    const mine = [...msgs.values()].filter((r) => r.side === 'me' && r.kind === 'text').pop();
    if (mine) { e.preventDefault(); startEdit(mine); }
  }
});
$('sendBtn').onclick = () => { sendText(); input.focus(); };

function sendText() {
  const text = input.value.replace(/^\s+|\s+$/g, '');
  if (!text || !session || session.ended) return;
  if (!session.members.size) return toast('Nobody else is in the room right now', true);
  if (text.length > LIMITS.maxText) return toast(`Messages are limited to ${LIMITS.maxText} characters`, true);
  if (editing) {
    const r = editing;
    clearEdit();
    if (msgs.has(r.id) && text !== r.text) { applyEdit(r, text); session.send({ t: 'edit', target: r.id, text }); }
    stopTyping();
    return;
  }
  const mid = uid();
  const o = { t: 'msg', mid, text, ttl: burnSecs || undefined };
  let reply = null;
  if (replyTo) { reply = quoteFor(replyTo.key); reply.mid = replyTo.key; o.reply = { mid: replyTo.mid }; }
  addText('me', { id: mid, text, ts: Date.now(), ttl: burnSecs, reply });
  session.send(o);
  input.value = ''; autosize(); $('sendBtn').disabled = true;
  clearReply(); stopTyping();
}

function setReply(r) {
  clearEdit();
  const text = r.kind === 'text' ? r.text : fileLabel(r);
  replyTo = { mid: r.wid, key: r.id, name: r.side === 'me' ? 'yourself' : nameOf(r.from), text: text.slice(0, 120) };
  $('replyName').textContent = replyTo.name;
  $('replyText').textContent = replyTo.text;
  $('replyBar').hidden = false;
  input.focus();
}
function clearReply() { replyTo = null; $('replyBar').hidden = true; }
$('replyCancel').onclick = clearReply;

// Editing: the composer takes the message's text; sending replaces it on both screens.
function startEdit(r) {
  if (r.side !== 'me' || r.kind !== 'text' || !session || session.ended) return;
  clearReply();
  editing = r;
  $('editText').textContent = r.text.slice(0, 120);
  $('editBar').hidden = false;
  input.value = r.text; autosize();
  $('sendBtn').disabled = false;
  $('chat').classList.add('is-editing');
  input.focus(); input.setSelectionRange(input.value.length, input.value.length);
}
function clearEdit() {
  if (!editing) return;
  editing = null;
  $('editBar').hidden = true;
  $('chat').classList.remove('is-editing');
  input.value = ''; autosize(); $('sendBtn').disabled = true;
}
$('editCancel').onclick = () => { clearEdit(); input.focus(); };

// ───────────────────────────── message menu ─────────────────────────────
(function buildReactRow() {
  for (const e of REACTIONS) {
    const b = h('button', null, e);
    b.type = 'button'; b.setAttribute('aria-label', 'React ' + e);
    b.onclick = () => { if (menuFor) toggleReact(menuFor, e); closeMenu(); };
    $('reactRow').append(b);
  }
})();
function toggleReact(r, e) {
  const mine = r.reacts.get('me') === e ? null : e;
  r.reacts.set('me', mine);
  renderReacts(r);
  session?.send({ t: 'react', target: r.wid, emoji: mine });
}
// Phones and small screens get bottom sheets instead of popovers.
const sheetMode = () => matchMedia('(max-width: 640px), (pointer: coarse)').matches;
function syncScrim() { $('scrim').hidden = !(sheetMode() && (!$('panel').hidden || !$('msgMenu').hidden)); }
$('scrim').addEventListener('click', () => { closeMenu(); openPanel(false); });

function bindMenu(r, el) {
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(r, e.clientX, e.clientY); });
  el.addEventListener('dblclick', (e) => { if (e.target.closest('a')) return; window.getSelection()?.removeAllRanges(); toggleReact(r, '❤️'); });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault(); const b = el.getBoundingClientRect(); openMenu(r, b.left + 20, b.bottom);
    }
  });
  // Touch: long-press opens the action sheet; swipe right replies.
  let press, sx = 0, sy = 0, dx = 0, swiping = false;
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; sx = t.clientX; sy = t.clientY; dx = 0; swiping = false;
    press = setTimeout(() => { if (!swiping) { navigator.vibrate?.(8); openMenu(r, t.clientX, t.clientY); } }, 480);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0]; const mx = t.clientX - sx, my = t.clientY - sy;
    if (Math.abs(mx) > 8 || Math.abs(my) > 8) clearTimeout(press);
    if (!session || session.ended) return;
    if (!swiping && mx > 12 && Math.abs(my) < Math.abs(mx) * .6) swiping = true;
    if (swiping) { dx = Math.max(0, Math.min(mx, 84)); r.el.style.transform = `translateX(${dx}px)`; r.el.classList.toggle('swipe-armed', dx > 56); }
  }, { passive: true });
  const endSwipe = () => {
    clearTimeout(press);
    if (!swiping) return;
    r.el.style.transform = ''; r.el.classList.remove('swipe-armed');
    if (dx > 56) { navigator.vibrate?.(10); setReply(r); }
    swiping = false; dx = 0;
  };
  el.addEventListener('touchend', endSwipe, { passive: true });
  el.addEventListener('touchcancel', endSwipe, { passive: true });
}
function openMenu(r, x, y) {
  menuFor = r;
  const m = $('msgMenu');
  m.querySelector('[data-act="unsend"]').hidden = r.side !== 'me' || session?.ended;
  m.querySelector('[data-act="copy"]').hidden = r.kind !== 'text';
  m.querySelector('[data-act="edit"]').hidden = r.side !== 'me' || r.kind !== 'text' || !session || session.ended;
  m.querySelector('[data-act="reply"]').hidden = !session || session.ended;
  $('reactRow').hidden = !session || session.ended;
  const sheet = sheetMode();
  m.classList.toggle('as-sheet', sheet);
  m.hidden = false;
  if (sheet) { m.style.left = ''; m.style.top = ''; }
  else {
    const w = m.offsetWidth, ht = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, innerHeight - ht - 8)) + 'px';
  }
  syncScrim();
  m.querySelector('button:not([hidden])')?.focus({ preventScroll: true });
}
function closeMenu() { $('msgMenu').hidden = true; menuFor = null; syncScrim(); }
$('msgMenu').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const r = menuFor;
  if (!act || !r) return;
  closeMenu();
  if (act === 'reply') setReply(r);
  if (act === 'edit') startEdit(r);
  if (act === 'copy') copy(r.text, 'Message');
  if (act === 'hide') removeRecord(r);
  if (act === 'unsend') { session?.send({ t: 'unsend', target: r.id }); removeRecord(r); }
});
document.addEventListener('pointerdown', (e) => { if (!$('msgMenu').hidden && !$('msgMenu').contains(e.target)) closeMenu(); });

// ───────────────────────────── files ─────────────────────────────
$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => { sendFiles([...e.target.files]); e.target.value = ''; };
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); sendFiles(files); }
});
let dragDepth = 0;
const chatEl = $('chat');
chatEl.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('dropzone').hidden = false; } });
chatEl.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropzone').hidden = true; } });
chatEl.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
chatEl.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('dropzone').hidden = true;
  if (e.dataTransfer?.files?.length) sendFiles([...e.dataTransfer.files]);
});

function fileExt(name) { const m = /\.([a-z0-9]{1,5})$/i.exec(name); return m ? m[1] : 'file'; }

function fileCard(r, name, size, sub) {
  const card = h('div', 'file-card');
  card.tabIndex = 0;
  const ico = h('div', 'file-ico', fileExt(name));
  const info = h('div', 'file-info');
  info.append(h('div', 'file-name', name));
  r.sub = h('div', 'file-sub', sub);
  r.bar = h('div', 'progress'); r.barFill = h('i'); r.bar.append(r.barFill);
  info.append(r.sub, r.bar);
  card.append(ico, info);
  return card;
}

async function sendFiles(files) {
  if (!session || session.ended) return;
  if (session.state !== 'ready') return toast('Files can only be sent while connected', true);
  for (const f of files) {
    if (f.size > LIMITS.maxFile) { toast(`${cleanLabel(f.name, 60)} is larger than ${fmtSize(LIMITS.maxFile)}`, true); continue; }
    const name = cleanLabel(f.name, 255) || 'file';
    const fid = session.sendFile(f, { ttl: burnSecs || undefined });
    const r = newRecord(fid, 'me', Date.now(), { kind: 'file', name, size: f.size, ttl: burnSecs });
    const imgType = await imageTypeOf(f);
    r.isImage = !!imgType;
    let body;
    if (imgType) {
      body = h('button', 'img-wrap');
      body.type = 'button';
      const url = track(URL.createObjectURL(new Blob([f], { type: imgType })));
      r.urls.push(url);
      const img = h('img'); img.src = url; img.alt = name;
      body.append(img);
      body.onclick = () => openViewer(url, name);
      r.sub = h('div', 'file-sub'); r.bar = h('div', 'progress'); r.barFill = h('i'); r.bar.append(r.barFill);
      const wrap = h('div'); wrap.append(body, r.bar);
      body = wrap;
    } else {
      body = fileCard(r, name, f.size, fmtSize(f.size) + ' · waiting');
    }
    const cancel = h('button', 'btn btn-text btn-sm', 'Cancel');
    cancel.type = 'button'; cancel.onclick = () => session?.cancelFile(fid);
    r.cancelBtn = cancel;
    placeRecord(r, body);
    r.metaEl.prepend(cancel);
    r.el.classList.add('show-meta');
  }
}

function onFileProgress({ fid, done, size }) {
  const r = msgs.get(fid);
  if (!r || !r.barFill) return;
  const pct = size ? Math.round((done / size) * 100) : 100;
  r.barFill.style.width = pct + '%';
  if (r.sub && r.kind === 'file') r.sub.textContent = `${fmtSize(done)} of ${fmtSize(size)}`;
  if (done >= size) setTimeout(() => r.bar?.remove(), 400);
}

function onFileIn({ fid, name, size, meta, from }) {
  if (msgs.has(fid)) { session?.cancelFile(fid); return; } // never let a peer overwrite an existing record
  const clean = cleanLabel(name, 255) || 'file';
  const ttl = Number.isInteger(meta?.ttl) && meta.ttl > 0 && meta.ttl <= 86400 ? meta.ttl : 0;
  const r = newRecord(fid, 'them', Date.now(), { kind: 'file', name: clean, size, ttl, from });
  const card = fileCard(r, clean, size, `Receiving · ${fmtSize(size)}`);
  const cancel = h('button', 'btn btn-text btn-sm', 'Cancel');
  cancel.type = 'button'; cancel.onclick = () => session?.cancelFile(fid);
  r.cancelBtn = cancel;
  placeRecord(r, card);
  r.metaEl.prepend(cancel);
  r.el.classList.add('show-meta');
  r.card = card;
  notifyIncoming();
}

async function onFileReceived({ fid, name, size, blob }) {
  const r = msgs.get(fid);
  if (testHook) testHook.files[name] = blob;
  if (!r) return;
  r.cancelBtn?.remove(); r.el.classList.remove('show-meta');
  // Nothing opens by itself: see js/ui/media.js.
  await presentReceived(r, { name: cleanLabel(name, 255) || 'file', size, blob }, {
    track,
    openViewer,
    onSeen: () => { if (r.ttl && !document.hidden) markSeenSoon(); },
  });
  r.isImage = !!r.card?.classList.contains('kind-image');
  scrollDown();
}

function onFileFailed({ fid, reason }) {
  const r = msgs.get(fid);
  if (!r) return;
  r.cancelBtn?.remove();
  r.bar?.remove();
  if (!r.sub) r.sub = h('div', 'file-sub');
  if (!r.sub.isConnected) r.el.insertBefore(r.sub, r.reactsEl);
  r.sub.textContent = reason === 'cancelled' ? 'Cancelled' : 'Not delivered: ' + reason;
  r.sub.classList.add('is-bad');
}

function openViewer(url, alt) { $('viewerImg').src = url; $('viewerImg').alt = alt; $('viewer').hidden = false; $('viewerClose').focus(); }
function closeViewer() { $('viewer').hidden = true; $('viewerImg').removeAttribute('src'); }
$('viewerClose').onclick = closeViewer;
$('viewer').addEventListener('click', (e) => { if (e.target === $('viewer')) closeViewer(); });

// ───────────────────────────── panel & settings ─────────────────────────────
// Wide screens: the session panel is a permanent right-hand column, not a drawer.
// It can be collapsed to give the conversation the full width (remembered for this tab only).
const dockMQ = matchMedia('(min-width: 1100px) and (pointer: fine)');
let dockCollapsed = false;
const docked = () => dockMQ.matches && $('chat').classList.contains('is-on');
function applyDock() {
  const dock = dockMQ.matches;
  document.documentElement.classList.toggle('dock', dock);
  document.documentElement.classList.toggle('dock-collapsed', dock && dockCollapsed);
  $('panelClose').setAttribute('aria-label', dock ? 'Collapse session panel' : 'Close');
  $('panelClose').title = dock ? 'Collapse panel' : '';
  if (!$('chat').classList.contains('is-on')) { syncHead(); return; }
  if (dock) { $('panel').hidden = dockCollapsed; if (!dockCollapsed) refreshRoute(); }
  else $('panel').hidden = true;
  $('panelBtn').setAttribute('aria-expanded', String(!$('panel').hidden));
  syncScrim(); syncHead();
}
dockMQ.addEventListener?.('change', applyDock);
applyDock();
// Details tabs: Safety, Privacy, Appearance, Keys.
function showTab(t) {
  for (const b of document.querySelectorAll('[data-ptab]')) {
    const on = b.dataset.ptab === t;
    b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
  }
  for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== t;
  $('panel').scrollTop = 0;
}
for (const b of document.querySelectorAll('[data-ptab]')) {
  b.onclick = () => showTab(b.dataset.ptab);
  b.onkeydown = (e) => {
    const tabs = [...document.querySelectorAll('[data-ptab]')];
    const i = tabs.indexOf(b), d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault(); const n = tabs[(i + d + tabs.length) % tabs.length]; showTab(n.dataset.ptab); n.focus();
  };
}
function openPanel(force, tab) {
  if (tab) showTab(tab);
  if (docked()) {
    const open = force ?? $('panel').hidden;
    dockCollapsed = !open;
    applyDock();
    if (open) $('panelClose').focus({ preventScroll: true });
    return;
  }
  const open = force ?? $('panel').hidden;
  $('panel').hidden = !open;
  $('panel').style.transform = '';
  $('panelBtn').setAttribute('aria-expanded', String(open));
  syncScrim(); syncHead();
  if (open) { refreshRoute(); $('panelClose').focus({ preventScroll: true }); }
}
// Drag the sheet's handle down to dismiss it.
(() => {
  let y0 = null, dy = 0;
  const panel = $('panel');
  panel.addEventListener('touchstart', (e) => {
    if (!sheetMode() || !e.target.closest('.sheet-handle, .panel-head')) return;
    y0 = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    panel.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  panel.addEventListener('touchend', () => {
    if (y0 === null) return;
    y0 = null;
    if (dy > 90) openPanel(false); else panel.style.transform = '';
  }, { passive: true });
})();
$('panelBtn').onclick = () => openPanel();
const railMQ = matchMedia('(min-width: 900px)');
function openRail() {
  if (railMQ.matches) return;
  if (!$('panel').hidden && !docked()) openPanel(false);
  $('chat').classList.add('rail-open'); $('railScrim').hidden = false;
  $('railBtn').setAttribute('aria-expanded', 'true');
  $('railClose').focus({ preventScroll: true });
}
function closeRail() {
  if (!$('chat').classList.contains('rail-open')) return;
  $('chat').classList.remove('rail-open'); $('railScrim').hidden = true;
  $('railBtn').setAttribute('aria-expanded', 'false');
}
$('railBtn').onclick = () => ($('chat').classList.contains('rail-open') ? closeRail() : openRail());
$('railClose').onclick = () => { closeRail(); $('railBtn').focus({ preventScroll: true }); };
$('railScrim').onclick = closeRail;
railMQ.addEventListener?.('change', closeRail);
$('railLook').onclick = () => { closeRail(); openPanel(true, 'look'); };
$('railCopy').onclick = () => { const c = shareCode(); if (c) copy(c, 'Room code'); };
$('railInvite').onclick = () => { closeRail(); openInvite(railMQ.matches ? $('railInvite') : $('railBtn')); };
$('qaVerify').onclick = () => {
  // Jump to the first person not yet verified.
  const next = present().find((p) => p.sn && !p.verified);
  if (next && next.id !== selPerson) { selPerson = next.id; renderSafety(); }
  $('snSec').scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  $('markVerified').focus({ preventScroll: true });
};

// ── invite: same room, same code; the host lets each newcomer in ──
function openInvite(opener = $('qaInvite')) {
  if (!canInviteNow()) return toast('Only the host can invite people to this room', true);
  if (session.count() >= MAX_MEMBERS) return toast(`The room is full (${MAX_MEMBERS} people)`, true);
  fillInvite();
  openSheet('inviteSheet', opener);
}
function fillInvite() {
  const c = shareCode();
  $('invCode').textContent = c || '';
  $('invNote').textContent = role === 'host'
    ? `Anyone who opens it asks to join, and you decide who comes in. Up to ${MAX_MEMBERS} people; ${MAX_MEMBERS - session.count()} more can join.`
    : `Whoever opens it asks to join, and ${nameOf(session.hostId)} (the host) decides who comes in.`;
  $('invNew').hidden = role !== 'host';
  $('invQr').hidden = true; $('invQr').replaceChildren(); $('invQrBtn').textContent = 'Show QR';
}
$('qaInvite').onclick = openInvite;
$('invCopy').onclick = () => copy(inviteLink(), 'Invite link');
$('invCopyCode').onclick = () => copy(shareCode() || '', 'Room code');
$('invNew').onclick = async () => {
  if (role !== 'host' || !session || session.ended) return;
  const waiting = knockCards.size;
  if (!(await confirmDialog('Make a new code?', 'The current code stops working at once' + (waiting ? `, and the ${waiting === 1 ? 'person' : waiting + ' people'} waiting to be let in ${waiting === 1 ? 'is' : 'are'} turned away` : '') + '. Share the new one instead.', 'New code'))) return;
  if (session.newInvite()) toast('New code ready. The old one no longer works.');
};
$('invShare').hidden = !(navigator.share && matchMedia('(pointer: coarse)').matches);
$('invShare').onclick = async () => {
  try { await navigator.share({ title: 'Ghost Chat invite', text: 'Join my private Ghost Chat room:', url: inviteLink() }); }
  catch (e) { if (e?.name !== 'AbortError') copy(inviteLink(), 'Invite link'); }
};
$('invQrBtn').onclick = () => {
  const box = $('invQr'), open = box.hidden;
  if (open) { try { renderQR(box, inviteLink()); } catch { return toast('Couldn\'t draw the QR code', true); } }
  else box.replaceChildren();
  box.hidden = !open;
  $('invQrBtn').textContent = open ? 'Hide QR' : 'Show QR';
};
$('optCanInvite').onchange = (e) => {
  session?.setCanInvite(e.target.checked);
  sys(e.target.checked ? 'Everyone can now share the invite. You still let each newcomer in.' : 'Only you can invite people now.');
};

// ── unsend all / clear for everyone ──
$('unsendAllBtn').onclick = async () => {
  if (!session || session.ended) return;
  const mine = [...msgs.values()].filter((r) => r.side === 'me');
  if (!(await confirmDialog('Unsend all your messages?', 'Every message and file you sent is removed from this screen and from everyone else\'s. Someone who already copied or screenshotted something keeps that copy.', 'Unsend all', { danger: true }))) return;
  for (const r of mine) removeRecord(r);
  session.send({ t: 'unsend-all' });
  sys('You unsent all your messages from every screen.');
};
$('clearAllBtn').onclick = async () => {
  if (!session || session.ended || role !== 'host') return;
  if (!(await confirmDialog('Clear the chat for everyone?', 'Every message and file, from everyone, is removed from all screens. Anyone who already copied or screenshotted something keeps that copy.', 'Clear for everyone', { danger: true }))) return;
  clearAll();
  session.send({ t: 'clear-all' });
  sys('You cleared the chat for everyone.', 'is-warn');
};
$('panelClose').onclick = () => openPanel(false);
$('optReceipts').onchange = (e) => { opts.receipts = e.target.checked; };
$('optTyping').onchange = (e) => { opts.typing = e.target.checked; if (!opts.typing) stopTyping(); };
$('optVeil').onchange = (e) => { opts.veil = e.target.checked; };
// The toggle shows whether it's on; clicking it adds or withdraws YOUR request.
$('optShape').onchange = () => {
  const want = !opts.shape;
  setShape(want, 'me');
  session?.send({ t: 'shape', on: want });
  if (!want && shapeOn()) toast('It stays on while someone else in the room has it on');
  else if (want) toast('Constant-rate traffic stays on until you turn it off');
};

// Constant-rate traffic: identical frames on a fixed clock (see SECURITY.md). It is ON while
// anyone in the room wants it, and each person can only withdraw their OWN request: someone
// else turning it off never switches off protection you chose.
const shapeWanted = new Set();   // member ids who asked for it
const shapeOn = () => opts.shape || [...shapeWanted].some((id) => people.has(id) && !people.get(id).gone);
function applyShape() {
  const on = shapeOn();
  $('optShape').checked = on;
  if (session && !session.ended && session.shaping !== on) session.setShaping(on);
  return on;
}
/** by: 'me' (my own toggle), null (privacy preset at start), or the member id who asked. */
function setShape(on, by) {
  const was = shapeOn();
  if (!by || by === 'me') opts.shape = on;
  else if (on) shapeWanted.add(by); else shapeWanted.delete(by);
  const now = applyShape();
  if (!by) return;
  const who = by === 'me' ? 'You' : nameOf(by);
  const scope = inGroup() ? 'anyone here' : 'either of you';
  if (on && !was) sys(`${who} turned on constant-rate traffic. Observers can no longer tell when ${scope} is typing or sending.`, 'is-good');
  else if (!on && !now) sys(`${who} turned off constant-rate traffic.`);
  else if (!on && by !== 'me') sys(`${who} turned off constant-rate traffic on their side. It stays on here because ${opts.shape ? 'you turned it on' : 'someone else has it on'}.`);
}

// ───────────────────────────── privacy preset (home screen) ─────────────────────────────
const PRIVACY_NOTE = {
  standard: 'On a direct connection you and the other person can see each other\'s IP address.',
  max: 'Needs a reachable relay server. If the connection fails on your network, switch back to Standard.',
};
function renderPrivacyChip() {
  const relay = $('relayOnly').checked, shape = $('shapeInit').checked;
  const label = privacy === 'max' ? 'Maximum' : relay || shape ? 'Custom' : 'Standard';
  for (const el of document.querySelectorAll('[data-priv-label]')) el.textContent = label;
  for (const el of document.querySelectorAll('.priv-chip')) el.classList.toggle('is-max', label !== 'Standard');
}
function setPrivacy(level) {
  privacy = level;
  for (const r of document.querySelectorAll('input[name="privacy"]')) r.checked = r.value === level;
  $('privacyNote').textContent = PRIVACY_NOTE[level];
  $('relayOnly').checked = level === 'max';
  $('shapeInit').checked = level === 'max';
  renderPrivacyChip();
}
for (const r of document.querySelectorAll('input[name="privacy"]')) r.addEventListener('change', () => setPrivacy(r.value));
for (const id of ['relayOnly', 'shapeInit']) $(id).addEventListener('change', () => {
  const max = $('relayOnly').checked && $('shapeInit').checked;
  privacy = max ? 'max' : 'standard';
  for (const r of document.querySelectorAll('input[name="privacy"]')) r.checked = r.value === privacy;
  const custom = [$('relayOnly').checked && 'IP hidden behind a relay', $('shapeInit').checked && 'constant-rate traffic'].filter(Boolean);
  $('privacyNote').textContent = max ? PRIVACY_NOTE.max : custom.length ? 'Custom: ' + custom.join(', ') + '.' : PRIVACY_NOTE.standard;
  renderPrivacyChip();
});
// ── custom TURN relay: kept in memory for this tab only, never stored or sent to the peer ──
let customRelay = null;
function renderRelay() {
  $('relayStatus').textContent = customRelay ? 'Using ' + customRelay.urls[0] + ' for this tab.' : 'Not saved anywhere. Closing the tab forgets it.';
  $('relayStatus').classList.remove('is-error');
  $('relayClear').hidden = !customRelay;
}
$('relaySave').onclick = () => {
  try {
    customRelay = parseTurn($('relayUrl').value.trim(), $('relayUser').value, $('relayPass').value);
    renderRelay();
    toast('Relay added for this tab');
  } catch (e) { $('relayStatus').textContent = e.message; $('relayStatus').classList.add('is-error'); }
};
$('relayClear').onclick = () => { customRelay = null; $('relayUrl').value = $('relayUser').value = $('relayPass').value = ''; renderRelay(); };
$('privCheckBtn').onclick = () => runNetCheck($('privNetResult'), $('privCheckBtn'));
renderRelay();

function applyPrivacyPreset() {
  const max = privacy === 'max';
  opts.receipts = !max; opts.typing = !max; opts.veil = max;
  $('optReceipts').checked = opts.receipts; $('optTyping').checked = opts.typing; $('optVeil').checked = opts.veil;
  setShape($('shapeInit').checked, null);
}
$('optNotify').onchange = async (e) => {
  if (!e.target.checked) { opts.notify = false; return; }
  if (!('Notification' in window)) { e.target.checked = false; return toast('Notifications aren\'t supported here', true); }
  const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  opts.notify = p === 'granted';
  e.target.checked = opts.notify;
  if (!opts.notify) toast('Notifications are blocked for this page', true);
};

$('endBtn').onclick = async () => {
  const host = role === 'host' && present().length > 0;
  const group = inGroup();
  const ok = await confirmDialog(host && group ? 'End for everyone?' : group ? 'Leave this room?' : 'End this session?',
    host && group ? 'Everyone is disconnected and the room closes. Messages, files and keys are wiped from this tab.'
      : group ? 'The others are told you left, and the room carries on without you. Messages, files and keys are wiped from this tab.'
      : 'The other person will be told you left. Messages, files and keys are wiped from this tab.',
    host && group ? 'End for everyone' : group ? 'Leave' : 'End session');
  if (!ok) return;
  await session?.end({ forAll: host });
  teardown();
  show('home');
  toast('Session ended and wiped');
};

// ───────────────────────────── teardown & panic ─────────────────────────────
function resetChat() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear(); msgs.clear();
  $('messages').replaceChildren();
  for (const p of people.values()) clearTimeout(p.announce);
  people.clear(); selPerson = null; lastLeft = '';
  shapeWanted.clear();
  for (const t of typers.values()) clearTimeout(t);
  typers.clear(); knockCards.clear();
  $('peerName').textContent = 'Connecting'; $('peerAvatar').textContent = '👤';
  $('panelName').textContent = '—'; $('panelAvatar').textContent = '👤'; $('phRoom').textContent = '';
  $('typingText').textContent = 'Typing';
  burnSecs = 0; replyTo = null; unread = 0; updateTitle();
  editing = null; $('editBar').hidden = true; $('chat').classList.remove('is-editing');
  for (const b of $('timerOptions').children) b.setAttribute('aria-checked', String(b.dataset.secs === '0'));
  $('timerBadge').hidden = true; $('replyBar').hidden = true; $('typing').hidden = true; $('veil').hidden = true;
  $('banner').hidden = true; $('panel').hidden = true; $('panelBtn').setAttribute('aria-expanded', 'false');
  $('input').value = ''; $('input').disabled = false; $('attachBtn').disabled = false; $('sendBtn').disabled = true;
  $('safetyNumber').replaceChildren(); delete $('safetyNumber').dataset.value; $('snPick').replaceChildren();
  $('optCanInvite').checked = false;
  $('kvRoute').textContent = '—'; $('kvLatency').textContent = '—'; $('kvRoom').textContent = '—';
  $('railRoute').textContent = '—'; $('railLatency').textContent = '—'; $('railKeys').textContent = '0'; $('railTimer').textContent = 'Off'; $('railCode').textContent = '—';
  $('timerBtn').classList.remove('is-on'); $('timerBtn').setAttribute('aria-label', 'Disappearing messages: off'); closeTimerMenu();
  for (const b of $('timerMenu').querySelectorAll('[data-secs]')) b.setAttribute('aria-checked', String(b.dataset.secs === '0'));
  $('chat').classList.remove('is-group'); closeRail(); showTab('safety');
  // Leave no names behind from the last room, even in hidden markup.
  noticeLog.clear();
  $('chat').classList.remove('composer-locked'); $('timerBtn').disabled = false;
  $('hsThemName').textContent = 'Waiting…'; $('hsSn').textContent = ''; $('hsSn').classList.remove('is-on');
  $('kvLive').textContent = '—'; $('kvKeys').textContent = '0'; $('kvAccess').textContent = '—';
  $('invCode').textContent = ''; $('invNote').textContent = ''; $('invQr').replaceChildren(); $('invQr').hidden = true;
  $('peopleList').replaceChildren(); $('peoplesTitle').textContent = 'People'; $('headCount').textContent = '';
  $('encFor').textContent = 'End-to-end encrypted'; $('input').placeholder = 'Message';
  $('railInvite').hidden = false; $('railInviteNote').hidden = true; $('railMeSub').textContent = 'You';
  $('pidSub').textContent = 'Nothing stored on this device'; $('verifyText').textContent = 'Not verified'; $('verifyChip').classList.remove('is-verified');
  setLink('', 'Connecting');
  closeMenu(); closeViewer();
}
function teardown() {
  const s = session;
  session = null;
  if (s && !s.ended) s.destroy('local');
  code = null;
  resetChat();
  $('codeGroups').replaceChildren();
}

function panic() {
  $('wipe').hidden = false;
  const s = session;
  session = null; code = null;
  try { s?.quickBye(); } catch {}            // the other side ends the session at once
  s?._h?.clear();                             // nothing may touch the page after this point
  for (const url of objectUrls) URL.revokeObjectURL(url);
  document.body.replaceChildren();
  navigator.clipboard?.writeText('').catch(() => {});
  // Let the goodbye frame leave the transport before tearing it down (the screen is already blank).
  setTimeout(() => { try { s?.destroy('local'); } catch {} location.replace('https://www.google.com/'); }, 150);
}
// Header panic button. Mouse and keyboard: instant. Touch: press and hold briefly, so a pocket
// tap or a slip of the thumb can't wipe a conversation (the ring fills while you hold).
for (const b of [$('panicBtn'), $('railWipe')]) {
  const HOLD_MS = 600;
  let t = 0, lastTouch = 0;
  const cancel = (hint) => {
    if (!t) return;
    clearTimeout(t); t = 0; b.classList.remove('is-holding');
    if (hint) toast('Hold to wipe everything');
  };
  b.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    lastTouch = Date.now();
    e.preventDefault();
    b.classList.add('is-holding');
    navigator.vibrate?.(12);
    t = setTimeout(() => { t = 0; navigator.vibrate?.([30, 40, 30]); panic(); }, HOLD_MS);
  });
  b.addEventListener('pointerup', () => cancel(true));
  b.addEventListener('pointercancel', () => cancel(false));
  b.addEventListener('pointerleave', () => cancel(false));
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  b.addEventListener('click', () => { if (Date.now() - lastTouch < 1500) return; panic(); });
}
$('panicSheetBtn').onclick = panic;

// Keep the chat sized to the visible viewport when the on-screen keyboard opens (iOS ignores
// interactive-widget; Chrome on Android honours it, so this is a no-op there).
if (window.visualViewport) {
  const vv = window.visualViewport;
  const fit = () => {
    const st = document.documentElement.style;
    st.setProperty('--vvh', vv.height + 'px');
    st.setProperty('--vvt', Math.max(0, vv.offsetTop) + 'px');   // iOS pans the page under the keyboard
    if ($('chat')?.classList.contains('is-on') && document.activeElement === $('input')) scrollDown(true);
  };
  vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
}
let escPresses = [];
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const now = Date.now();
  escPresses = escPresses.filter((t) => now - t < 1000).concat(now);
  if ($('chat').classList.contains('is-on') && escPresses.length >= 3) return panic();
  if (!$('dialog').hidden) return closeDialog(false);
  if (openSheetEl) return closeSheet();
  if ($('joinScreen').classList.contains('is-on')) return leaveJoin();
  if (!$('viewer').hidden) return closeViewer();
  if (!$('msgMenu').hidden) return closeMenu();
  if (!$('timerMenu').hidden) { closeTimerMenu(); $('timerBtn').focus(); return; }
  if ($('chat').classList.contains('rail-open')) return closeRail();
  if (!$('panel').hidden) return openPanel(false);
  if (editing) { clearEdit(); return; }
  if (replyTo) clearReply();
});

// Closing or reloading the tab: tell the other side immediately (our keys die with the page,
// so a reconnection could never succeed), then wipe.
// The transcript is wiped from the page too: browsers keep a page that was navigated away from
// in the back/forward cache, and pressing Back would otherwise bring the conversation back.
window.addEventListener('pagehide', () => {
  if (!session && !code) return;
  try { session?.quickBye(); } catch {}
  try { teardown(); } catch {}
  show('home');
});
// Restored from the back/forward cache: start from a clean page rather than a frozen one.
window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });

// Expose a tiny hook for automated tests only when explicitly served in test mode.


document.documentElement.classList.add('booted');
