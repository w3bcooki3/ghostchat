// Ghost Chat — interface controller.
// All peer-supplied strings reach the DOM through textContent / attribute
// setters only; nothing from the network is ever parsed as HTML.
import { generateCode, normalizeCode, roomIdFromCode } from './protocol.js';
import { Session, uid } from './session.js';
import { LIMITS } from './config.js';
import { initFog } from './fog.js';

// Refuse to run inside a frame: prevents click-jacking of the panic/end/verify controls
// and keeps a hostile embedding page from overlaying the UI.
if (window.top !== window.self) {
  document.body.replaceChildren(Object.assign(document.createElement('p'), { className: 'noscript', textContent: 'Ghost Chat must be opened directly, not inside another page.' }));
  throw new Error('framed');
}

const $ = (id) => document.getElementById(id);
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const AVATARS = ['👻', '🦊', '🐺', '🦉', '🐙', '🦑', '🦈', '🐸', '🦎', '🐝', '🦋', '🐌', '🌚', '🌵', '🍄', '🪐', '🔮', '🗝️', '🕯️', '🧊', '⚡', '🌊', '🎭', '🤖', '👾', '🛸', '🦇', '🐈‍⬛', '🐉', '🦂', '🪼', '🌑'];
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const TIMERS = [[0, 'Off'], [10, '10 s'], [30, '30 s'], [60, '1 min'], [300, '5 min'], [3600, '1 h']];
const GROUP_GAP_MS = 3 * 60_000;

// ───────────────────────────── state ─────────────────────────────
const me = { name: '', avatar: AVATARS[crypto.getRandomValues(new Uint8Array(1))[0] % AVATARS.length] };
const them = { name: 'Peer', avatar: '👤' };
let session = null;
let code = null;
let role = null;
let burnSecs = 0;
let verified = false;
let replyTo = null;
let unread = 0;
let menuFor = null;
let lastTypingSent = 0;
let typingIdle = null;
let typingHide = null;
let roomTakenRetries = 0;
const opts = { receipts: true, typing: true, veil: false, notify: false, shape: false };
let privacy = 'standard'; // 'standard' | 'max' — chosen on the home screen
const msgs = new Map(); // id → record
const objectUrls = new Set();
// Automation hook, only present when the test server marks the page (never in production builds).
const testHook = document.documentElement.dataset.test === '1' ? (window.__ghost = { get session() { return session; }, msgs, files: {} }) : null;

// ───────────────────────────── helpers ─────────────────────────────
// Strip control chars and bidi overrides (filename/name spoofing like "photo‮gpj.exe").
const cleanLabel = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '').trim().slice(0, max);
const fmtSize = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtSecs = (s) => s >= 3600 ? Math.round(s / 3600) + ' h' : s >= 60 ? Math.round(s / 60) + ' min' : s + ' s';
const fmtLeft = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return s >= 60 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : s + 's'; };
const isMid = (s) => typeof s === 'string' && /^[0-9a-f]{16}$/.test(s);
const inviteLink = () => location.href.split('#')[0] + '#' + code;

let toastTimer;
function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast is-on' + (bad ? ' is-bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), 2600);
}
async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(label + ' copied'); }
  catch { toast("Couldn't access the clipboard", true); }
}
let fog = null; // home-screen atmosphere; created once the DOM helpers below exist
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('is-on', s.id === id);
  fog?.setActive(id === 'home' || id === 'joinScreen');
}

let dialogResolve = null;
function confirmDialog(title, body, okLabel) {
  $('dialogTitle').textContent = title;
  $('dialogBody').textContent = body;
  $('dialogOk').textContent = okLabel;
  $('dialog').hidden = false;
  $('dialogCancel').focus();
  return new Promise((r) => { dialogResolve = r; });
}
function closeDialog(v) { $('dialog').hidden = true; dialogResolve?.(v); dialogResolve = null; }
$('dialogCancel').onclick = () => closeDialog(false);
$('dialogOk').onclick = () => closeDialog(true);
$('dialog').addEventListener('click', (e) => { if (e.target === $('dialog')) closeDialog(false); });

// Magic-byte sniffing: only raster formats render inline. Peer-declared MIME types are ignored.
function sniffImage(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}
async function imageTypeOf(blob) { return sniffImage(new Uint8Array(await blob.slice(0, 16).arrayBuffer())); }
function track(url) { objectUrls.add(url); return url; }
function release(url) { if (url) { URL.revokeObjectURL(url); objectUrls.delete(url); } }

// ───────────────────────────── home ─────────────────────────────
try {
  fog = initFog({ fog: $('fogCanvas'), mark: $('homeMark'), markCanvas: $('markCanvas'), apparition: $('apparition'), interactive: $('home') });
  fog.setActive($('home').classList.contains('is-on'));
} catch (e) { console.warn('[ghost] fog unavailable', e); document.documentElement.classList.add('no-fog'); }

// ── identity: avatar + name, shown on the chips of the home and join screens ──
function renderIdentity() {
  const name = cleanLabel($('nameInput').value, 24) || 'Anonymous ghost';
  for (const el of document.querySelectorAll('[data-avatar]')) el.textContent = me.avatar;
  for (const el of document.querySelectorAll('[data-name]')) el.textContent = name;
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
  $('joinSub').textContent = invited ? 'Check your name and privacy below, then join.' : 'Enter the code you were sent, or paste the invite link.';
  $('joinOr').textContent = invited ? 'Not expecting this?' : 'No code?';
  if (c) setCode(c, false);
  else { boxes.forEach((b) => { b.value = ''; }); codeHelp(); syncBoxes(); }
  const wasHome = $('home').classList.contains('is-on');
  show('joinScreen');
  if (wasHome) history.pushState({ gc: 'join' }, '');
  setTimeout(() => (invited ? $('joinBtn') : boxes[0]).focus({ preventScroll: true }), 50);
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
function showConnectError(text, canRetry) {
  $('connectError').hidden = false;
  $('connectErrorText').textContent = text;
  $('retryBtn').hidden = !canRetry;
}

const FAIL_TEXT = {
  'not-found': 'No room with this code is open right now. Check the code, or ask the other person to create the room and keep the page open.',
  'auth-failed': 'A room exists, but it didn\'t accept this code. Check every character. If you\'re certain it\'s right, something may be interfering with the connection — don\'t continue.',
  signaling: 'Couldn\'t reach the introduction server. Check your internet connection, or whether a firewall or content blocker is stopping it.',
  timeout: 'Found the room but couldn\'t open a connection between your browsers. Some firewalls block this; try another network, or turn off "Hide my IP" if it is on.',
  unsupported: 'This browser lacks WebRTC or Web Crypto support. Use a current version of Firefox, Chrome, Edge or Safari.',
  'room-taken': 'Couldn\'t reserve a room. Try again.',
  locked: 'This room already has its two people and is locked. A room code can\'t be used again once a conversation has started. Ask for a new invite, or ask the person who created the room to unlock it.',
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
  show('connect');
  if (role === 'host') $('copyLinkBtn').focus();

  session = new Session({ code, role, relayOnly: $('relayOnly').checked });
  applyPrivacyPreset();
  wire(session);
  session.start().catch((e) => { console.error(e); showConnectError(FAIL_TEXT.unsupported, false); });
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
    if (state === 'waiting') setSteps('peer', 'signal');
    if (state === 'dialing') setSteps('peer', 'signal');
    if (state === 'reconnecting') onReconnecting();
  });
  s.on('link-open', () => { if (s === session && !s.everReady) setSteps('keys', 'peer'); });
  s.on('failed', ({ code: f }) => {
    if (s !== session) return;
    if (f === 'room-taken' && role === 'host' && roomTakenRetries++ < 3) { teardown(); startSession('host', generateCode()); return; }
    const step = f === 'signaling' ? 'signal' : f === 'auth-failed' || f === 'timeout' ? 'keys' : 'peer';
    setSteps(null, { signal: null, peer: 'signal', keys: 'peer' }[step], step);
    showConnectError(FAIL_TEXT[f] || 'Connection failed.', f !== 'unsupported');
  });
  s.on('rejected', ({ count, locked }) => {
    if (locked) {
      sys('Someone tried to join this room. It\'s locked to the two of you, so they were refused.', 'is-warn');
      if (s.state === 'reconnecting') offerUnlock();
      return;
    }
    const msg = count === 1 ? 'A connection attempt was refused because it couldn\'t prove it had the room code.' : `${count} connection attempts were refused because they couldn't prove they had the room code.`;
    if (!s.everReady) toast(msg, true);
    else sys(msg, 'is-warn');
  });
  s.on('ready', onReady);
  s.on('latency', ({ ms }) => {
    $('kvLatency').textContent = ms + ' ms';
    setLink(ms < 250 ? 'is-good' : 'is-fair', `${ms} ms`);
  });
  s.on('delivered', ({ mid }) => {
    const r = msgs.get(mid);
    if (r && r.side === 'me') { r.delivered = true; updateStatus(r); if (r.ttl) startBurn(r); }
  });
  s.on('message', onMessage);
  s.on('file-in', onFileIn);
  s.on('file-progress', onFileProgress);
  s.on('file-received', onFileReceived);
  s.on('file-failed', onFileFailed);
  s.on('file-sent', ({ fid }) => { const r = msgs.get(fid); if (r) { r.sub.textContent = fmtSize(r.size) + ' · sent'; r.cancelBtn?.remove(); if (r.ttl) startBurn(r); } });
  s.on('ended', ({ reason }) => onEnded(s, reason));
}

async function onReady({ safetyNumber, resumed, continuity, newPeer }) {
  if (!continuity) verified = false;   // a proven resume keeps your verification
  renderSafety(safetyNumber);
  // The stable safety number identifies the conversation; the live fingerprint shows the
  // keys this particular connection negotiated (it changes on every reconnect).
  $('kvLive').textContent = (session.liveSafetyNumber || '').split(' ').slice(0, 3).join(' ') || '—';
  session.send({ t: 'profile', name: me.name, avatar: me.avatar });
  if (opts.shape) session.send({ t: 'shape', on: true });
  if (!resumed) {
    setSteps(null, 'ready');
    await new Promise((r) => setTimeout(r, 450)); // let the last step land before switching
    if (!session || session.ended) return;
    show('chat');
    $('kvRoom').textContent = roomIdFromCode(code).replace(/^ghostchat-v\d+-/, '').toUpperCase();
    sys('End-to-end encrypted with post-quantum protection. Only someone holding the room code could have joined, and the room is now locked to the two of you.', 'is-good');
    sysSafety(safetyNumber);
    if (privacy === 'max') sys('Maximum privacy: relayed connection, constant-rate traffic, no typing indicator or read receipts.', 'is-good');
    if (role === 'host' && burnSecs) session.send({ t: 'timer', secs: burnSecs });
    $('input').focus();
  } else {
    hideBanner();
    if (newPeer) sys('A new browser joined after you unlocked the room. The safety number changed, so verify it again before sharing anything sensitive.', 'is-warn');
    else sys('Reconnected with fresh keys. Their browser proved it\'s the same one as before, so the safety number hasn\'t changed.', 'is-good');
  }
  $('sendBtn').disabled = !$('input').value.trim();
  setLink('is-good', 'Encrypted');
  refreshRoute();
  for (const r of msgs.values()) if (r.side === 'me' && !r.delivered) updateStatus(r);
}

async function refreshRoute() {
  const route = await session?.getRoute();
  const label = { direct: 'Direct, peer-to-peer', local: 'Direct, same network', relay: 'Relayed via TURN server' }[route] || 'Unknown';
  $('kvRoute').textContent = label;
}

function onReconnecting() {
  setLink('is-down', 'Reconnecting');
  showBanner(role === 'joiner'
    ? 'Connection dropped. Reconnecting… Messages you send now are queued and delivered when it\'s back.'
    : 'Connection dropped. Waiting for the other person to reconnect… Messages you send now are queued.');
  $('typing').hidden = true;
  for (const r of msgs.values()) if (r.side === 'me' && !r.delivered) updateStatus(r);
}

function onEnded(s, reason) {
  if (s !== session) return;
  const chatOn = $('chat').classList.contains('is-on');
  if (!chatOn) { if (reason !== 'local') showConnectError('The session ended.', false); return; }
  setLink('is-down', 'Ended');
  $('sendBtn').disabled = true; $('input').disabled = true; $('attachBtn').disabled = true;
  $('typing').hidden = true;
  const text = reason === 'peer-left' ? `${them.name} ended the session.`
    : reason === 'resume-failed' ? 'The other side couldn\'t prove it was the same conversation after reconnecting, so the session was closed.'
    : 'The connection couldn\'t be restored.';
  sys(text, 'is-bad');
  showBanner(text + ' Messages stay on screen until you leave.', true, 'Leave');
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
    btn.onclick = () => { teardown(); show('home'); };
    b.append(btn);
  }
  b.hidden = false;
}
function hideBanner() { $('banner').hidden = true; }

// Host only: someone tried to join while the peer was away. If that's the peer after a reload,
// they lost the resumption secret and can only come back through a fresh join.
function offerUnlock() {
  if (role !== 'host' || !session || session.ended || !session.locked) return;
  showBanner(`Waiting for ${them.name} to reconnect. If they reloaded the page, their browser can't prove it's them any more.`);
  const btn = h('button', 'btn btn-ghost btn-sm', 'Unlock room once');
  btn.type = 'button';
  btn.onclick = async () => {
    const ok = await confirmDialog('Unlock the room?',
      `Only do this if ${them.name} told you, some other way, that they reloaded the page. Anyone holding the room code could take their place. You'll get a new safety number, and you should compare it again.`,
      'Unlock once');
    if (!ok || !session || session.ended) return;
    session.unlock();
    hideBanner();
    sys('Room unlocked. The next person with the room code can join; you\'ll see a new safety number to verify.', 'is-warn');
  };
  $('banner').append(btn);
}

function atBottom() { const m = $('messages'); return m.scrollHeight - m.scrollTop - m.clientHeight < 80; }
function scrollDown(force) { const m = $('messages'); if (force || atBottom()) requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; }); }

function sys(text, cls = '') {
  const stick = atBottom();
  const el = h('div', 'sys ' + cls, text);
  $('messages').append(el);
  scrollDown(stick);
  return el;
}
function sysSafety(sn) {
  const stick = atBottom();
  const card = h('div', 'sn-card');
  const head = h('div', 'sn-card-head');
  head.append(h('strong', null, 'Safety number'), h('span', null, 'Read it to the other person by voice. If both screens match, nobody is in the middle.'));
  const grid = h('div', 'sn-card-grid mono');
  for (const g of sn.split(' ')) grid.append(h('span', null, g));
  const btn = h('button', 'btn btn-ghost btn-sm', 'Compare and verify');
  btn.type = 'button'; btn.onclick = () => openPanel(true);
  card.append(head, grid, btn);
  $('messages').append(card);
  scrollDown(stick);
}

function renderSafety(sn) {
  const box = $('safetyNumber');
  box.replaceChildren(...sn.split(' ').map((g) => h('span', null, g)));
  box.dataset.value = sn;
  applyVerified();
}
function applyVerified() {
  $('verifyText').textContent = verified ? 'Verified' : 'Not verified';
  $('verifyChip').setAttribute('aria-label', verified ? 'Safety number verified' : 'Safety number not verified');
  $('verifyChip').classList.toggle('is-verified', verified);
  $('markVerified').setAttribute('aria-pressed', String(verified));
  $('markVerified').textContent = verified ? 'Verified' : 'Mark as verified';
  $('safetyNumber').classList.toggle('is-verified', verified);
}
$('markVerified').onclick = () => {
  verified = !verified; applyVerified();
  if (verified) sys('You marked the safety number as verified.', 'is-good');
};
$('copySafety').onclick = () => copy($('safetyNumber').dataset.value || '', 'Safety number');
$('verifyChip').onclick = () => openPanel(true);

// Linkify http(s) URLs as text nodes + anchors — no HTML parsing.
function fillText(el, text) {
  const re = /\bhttps?:\/\/[^\s<>"']+/gi;
  let last = 0, m;
  while ((m = re.exec(text))) {
    let url = m[0].replace(/[).,;:!?]+$/, '');
    if (m.index > last) el.append(text.slice(last, m.index));
    let ok = false;
    try { ok = ['http:', 'https:'].includes(new URL(url).protocol); } catch {}
    if (ok) {
      const a = h('a', null, url); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
      el.append(a);
    } else el.append(url);
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < text.length) el.append(text.slice(last));
}
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s){1,12}$/u;

function newRecord(id, side, ts, extra = {}) {
  const el = h('div', 'msg ' + side + ' arrive');
  el.dataset.id = id;
  const r = { id, side, ts, el, reacts: { me: null, them: null }, delivered: side !== 'me', read: false, seen: false, ttl: 0, burnAt: 0, urls: [], ...extra };
  msgs.set(id, r);
  return r;
}

function placeRecord(r, body) {
  const prev = [...$('messages').children].reverse().find((n) => n.classList.contains('msg') || n.classList.contains('sys'));
  const prevRec = prev && prev.classList.contains('msg') ? msgs.get(prev.dataset.id) : null;
  const grouped = prevRec && prevRec.side === r.side && r.ts - prevRec.ts < GROUP_GAP_MS;
  if (grouped) prevRec.el.classList.remove('last'); else r.el.classList.add('first');
  r.el.classList.add('last');
  if (!grouped && r.side === 'them') r.el.append(h('div', 'msg-name', them.name));
  r.el.append(body);
  r.reactsEl = h('div', 'reacts'); r.reactsEl.hidden = true;
  r.metaEl = h('div', 'meta');
  r.timeEl = h('span', null, fmtTime(r.ts));
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

function regroup() {
  let prev = null;
  for (const n of $('messages').children) {
    if (!n.classList.contains('msg')) { if (prev) prev.el.classList.add('last'); prev = null; continue; }
    const r = msgs.get(n.dataset.id);
    if (!r) continue;
    const grouped = prev && prev.side === r.side && r.ts - prev.ts < GROUP_GAP_MS;
    r.el.classList.toggle('first', !grouped);
    if (prev) prev.el.classList.toggle('last', !grouped);
    r.el.classList.add('last');
    const nameEl = r.el.querySelector('.msg-name');
    if (r.side === 'them' && !grouped && !nameEl) r.el.prepend(h('div', 'msg-name', them.name));
    if (grouped && nameEl) nameEl.remove();
    prev = r;
  }
}

function addText(side, { id, text, ts, ttl = 0, reply = null }) {
  const r = newRecord(id, side, ts, { kind: 'text', text, ttl });
  const bubble = h('div', 'bubble');
  bubble.dir = 'auto';
  bubble.tabIndex = 0;
  if (reply) {
    const q = h('span', 'quote');
    q.append(h('b', null, reply.name), document.createTextNode(reply.text));
    q.onclick = () => jumpTo(reply.mid);
    bubble.append(q);
  }
  if (!reply && EMOJI_ONLY.test(text) && !/^[\s\d#*]+$/.test(text)) bubble.classList.add('emoji-only');
  const span = h('span');
  fillText(span, text);
  bubble.append(span);
  placeRecord(r, bubble);
  return r;
}

function quoteFor(mid) {
  const r = msgs.get(mid);
  if (!r) return { mid, name: '', text: 'Message unavailable' };
  return { mid, name: r.side === 'me' ? 'You' : them.name, text: (r.kind === 'text' ? r.text : r.name).slice(0, 120) };
}

function jumpTo(mid) {
  const r = msgs.get(mid);
  if (!r) return toast('That message is gone');
  r.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  r.el.classList.add('flash');
  setTimeout(() => r.el.classList.remove('flash'), 1200);
}

function updateStatus(r) {
  if (r.side !== 'me' || !r.statusEl || r.kind !== 'text') return;
  let t = 'Sent', cls = 'status';
  if (r.read) { t = 'Read'; cls += ' is-read'; }
  else if (r.delivered) t = 'Delivered';
  else if (!session || session.state !== 'ready') { t = 'Queued'; cls += ' is-queued'; }
  r.statusEl.textContent = t;
  r.statusEl.className = cls;
}

function renderReacts(r) {
  const counts = new Map();
  for (const who of ['me', 'them']) {
    const e = r.reacts[who];
    if (e) { const c = counts.get(e) || { n: 0, mine: false }; c.n++; if (who === 'me') c.mine = true; counts.set(e, c); }
  }
  r.reactsEl.replaceChildren();
  for (const [e, c] of counts) {
    const chip = h('span', 'react' + (c.mine ? ' mine' : ''), e);
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
  if (replyTo?.mid === r.id) clearReply();
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
  $('timerBadge').textContent = secs ? '⏱ ' + fmtSecs(secs) : '';
  const who = by === 'me' ? 'You' : them.name;
  sys(secs ? `${who} set messages to disappear after ${fmtSecs(secs)}.` : `${who} turned off disappearing messages.`, secs ? 'is-warn' : '');
}
(function buildTimers() {
  for (const [secs, label] of TIMERS) {
    const b = h('button', null, label);
    b.type = 'button'; b.dataset.secs = secs; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(secs === 0));
    b.onclick = () => { if (secs === burnSecs) return; setTimer(secs, 'me'); session?.send({ t: 'timer', secs }); };
    $('timerOptions').append(b);
  }
})();

// ───────────────────────────── read receipts ─────────────────────────────
let seenTimer = null;
function markSeenSoon() { clearTimeout(seenTimer); seenTimer = setTimeout(markSeen, 150); }
function markSeen() {
  if (document.hidden || !$('chat').classList.contains('is-on') || !$('veil').hidden) return;
  const ids = [];
  for (const r of msgs.values()) {
    if (r.side !== 'them' || r.seen) continue;
    r.seen = true;
    if (r.ttl) startBurn(r);
    if (r.kind === 'text') ids.push(r.id);
  }
  if (ids.length && opts.receipts && session?.state === 'ready') session.send({ t: 'read', ids: ids.slice(0, 200) });
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
function onMessage(o) {
  switch (o.t) {
    case 'profile': {
      them.name = cleanLabel(o.name, 24) || 'Peer';
      them.avatar = AVATARS.includes(o.avatar) ? o.avatar : '👤';
      $('peerName').textContent = them.name;
      $('peerAvatar').textContent = them.avatar;
      $('typingText').textContent = `${them.name} is typing`;
      for (const n of document.querySelectorAll('.msg.them .msg-name')) n.textContent = them.name;
      return;
    }
    case 'msg': {
      if (typeof o.text !== 'string' || !o.text || !isMid(o.mid) || msgs.has(o.mid)) return;
      const ttl = Number.isInteger(o.ttl) && o.ttl > 0 && o.ttl <= 86400 ? o.ttl : 0;
      // Quotes are resolved from our own copy of the conversation; the peer only names the message.
      const reply = o.reply && isMid(o.reply.mid) ? quoteFor(o.reply.mid) : null;
      addText('them', { id: o.mid, text: o.text.slice(0, LIMITS.maxText), ts: Date.now(), ttl, reply });
      $('typing').hidden = true;
      notifyIncoming();
      return;
    }
    case 'read': {
      if (!Array.isArray(o.ids)) return;
      for (const id of o.ids.slice(0, 200)) {
        const r = msgs.get(id);
        if (r && r.side === 'me') { r.read = true; r.delivered = true; updateStatus(r); if (r.ttl) startBurn(r); }
      }
      return;
    }
    case 'typing':
      clearTimeout(typingHide);
      if (o.on === true) { $('typing').hidden = false; typingHide = setTimeout(() => { $('typing').hidden = true; }, 6000); }
      else $('typing').hidden = true;
      return;
    case 'react': {
      const r = msgs.get(o.target);
      if (!r) return;
      r.reacts.them = REACTIONS.includes(o.emoji) ? o.emoji : null;
      renderReacts(r);
      return;
    }
    case 'unsend': {
      const r = msgs.get(o.target);
      if (r && r.side === 'them') { removeRecord(r); sys(`${them.name} unsent a message.`); }
      return;
    }
    case 'shape': {
      const on = o.on === true;
      if (on !== opts.shape) setShape(on, 'them');
      return;
    }
    case 'timer': {
      const secs = Number(o.secs);
      if (TIMERS.some(([s]) => s === secs) && secs !== burnSecs) setTimer(secs, 'them');
      return;
    }
  }
}

function notifyIncoming() {
  if (!document.hidden) return;
  unread++; updateTitle();
  if (opts.notify && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('Ghost Chat', { body: 'New message', tag: 'ghostchat', silent: false }); } catch {}
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
  if (e.key === 'ArrowUp' && !input.value) {
    const mine = [...msgs.values()].filter((r) => r.side === 'me' && r.kind === 'text').pop();
    if (mine) { e.preventDefault(); setReply(mine); }
  }
});
$('sendBtn').onclick = () => { sendText(); input.focus(); };

function sendText() {
  const text = input.value.replace(/^\s+|\s+$/g, '');
  if (!text || !session || session.ended) return;
  if (text.length > LIMITS.maxText) return toast(`Messages are limited to ${LIMITS.maxText} characters`, true);
  const mid = uid();
  const o = { t: 'msg', mid, text, ttl: burnSecs || undefined };
  let reply = null;
  if (replyTo) { reply = quoteFor(replyTo.mid); o.reply = { mid: replyTo.mid }; }
  addText('me', { id: mid, text, ts: Date.now(), ttl: burnSecs, reply });
  session.send(o);
  input.value = ''; autosize(); $('sendBtn').disabled = true;
  clearReply(); stopTyping();
}

function setReply(r) {
  const text = r.kind === 'text' ? r.text : r.name;
  replyTo = { mid: r.id, name: r.side === 'me' ? 'You' : them.name, text: text.slice(0, 120) };
  $('replyName').textContent = replyTo.name;
  $('replyText').textContent = replyTo.text;
  $('replyBar').hidden = false;
  input.focus();
}
function clearReply() { replyTo = null; $('replyBar').hidden = true; }
$('replyCancel').onclick = clearReply;

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
  r.reacts.me = r.reacts.me === e ? null : e;
  renderReacts(r);
  session?.send({ t: 'react', target: r.id, emoji: r.reacts.me });
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

function onFileIn({ fid, name, size, meta }) {
  if (msgs.has(fid)) { session?.cancelFile(fid); return; } // never let a peer overwrite an existing record
  const clean = cleanLabel(name, 255) || 'file';
  const ttl = Number.isInteger(meta?.ttl) && meta.ttl > 0 && meta.ttl <= 86400 ? meta.ttl : 0;
  const r = newRecord(fid, 'them', Date.now(), { kind: 'file', name: clean, size, ttl });
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
  const clean = cleanLabel(name, 255) || 'file';
  const imgType = await imageTypeOf(blob);
  if (imgType) {
    const url = track(URL.createObjectURL(new Blob([blob], { type: imgType })));
    r.urls.push(url);
    const ok = await new Promise((res) => { const t = new Image(); t.onload = () => res(true); t.onerror = () => res(false); t.src = url; });
    if (ok) {
      const btn = h('button', 'img-wrap'); btn.type = 'button';
      const img = h('img'); img.src = url; img.alt = clean;
      btn.append(img); btn.onclick = () => openViewer(url, clean);
      bindMenu(r, btn);
      r.card.replaceWith(btn);
      scrollDown();
      if (r.ttl && !document.hidden) markSeenSoon();
      return;
    }
  }
  // Everything else is offered as a download only, typed as opaque bytes so the browser never renders it.
  const url = track(URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' })));
  r.urls.push(url);
  r.sub.textContent = fmtSize(size) + ' · ';
  const a = h('a', null, 'Save file'); a.href = url; a.download = clean; a.rel = 'noopener';
  r.sub.append(a);
  r.bar?.remove();
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
function openPanel(force) {
  const open = force ?? $('panel').hidden;
  $('panel').hidden = !open;
  $('panel').style.transform = '';
  $('panelBtn').setAttribute('aria-expanded', String(open));
  syncScrim();
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
$('panelClose').onclick = () => openPanel(false);
$('optReceipts').onchange = (e) => { opts.receipts = e.target.checked; };
$('optTyping').onchange = (e) => { opts.typing = e.target.checked; if (!opts.typing) stopTyping(); };
$('optVeil').onchange = (e) => { opts.veil = e.target.checked; };
$('optShape').onchange = (e) => { setShape(e.target.checked, 'me'); session?.send({ t: 'shape', on: opts.shape }); };

// Constant-rate traffic: both sides send identical frames on a fixed clock (see SECURITY.md).
function setShape(on, by) {
  opts.shape = on;
  $('optShape').checked = on;
  session?.setShaping(on);
  if (by) {
    const who = by === 'me' ? 'You' : them.name;
    sys(on ? `${who} turned on constant-rate traffic. Observers can no longer tell when either of you is typing or sending.` : `${who} turned off constant-rate traffic.`, on ? 'is-good' : '');
  }
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
  if (!(await confirmDialog('End this session?', 'The other person will be told you left. Messages, files and keys are wiped from this tab.', 'End session'))) return;
  await session?.end();
  teardown();
  show('home');
  toast('Session ended and wiped');
};

// ───────────────────────────── teardown & panic ─────────────────────────────
function resetChat() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear(); msgs.clear();
  $('messages').replaceChildren();
  them.name = 'Peer'; them.avatar = '👤';
  $('peerName').textContent = them.name; $('peerAvatar').textContent = them.avatar;
  $('typingText').textContent = 'Typing';
  burnSecs = 0; verified = false; replyTo = null; unread = 0; updateTitle();
  for (const b of $('timerOptions').children) b.setAttribute('aria-checked', String(b.dataset.secs === '0'));
  $('timerBadge').hidden = true; $('replyBar').hidden = true; $('typing').hidden = true; $('veil').hidden = true;
  $('banner').hidden = true; $('panel').hidden = true; $('panelBtn').setAttribute('aria-expanded', 'false');
  $('input').value = ''; $('input').disabled = false; $('attachBtn').disabled = false; $('sendBtn').disabled = true;
  $('safetyNumber').replaceChildren(); delete $('safetyNumber').dataset.value;
  $('kvRoute').textContent = '—'; $('kvLatency').textContent = '—'; $('kvRoom').textContent = '—';
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
  try { session?.destroy('local'); } catch {}
  session = null; code = null;
  for (const url of objectUrls) URL.revokeObjectURL(url);
  document.body.replaceChildren();
  navigator.clipboard?.writeText('').catch(() => {});
  location.replace('https://www.google.com/');
}
$('panicBtn').onclick = panic;
$('panicSheetBtn').onclick = panic;

// Keep the chat sized to the visible viewport when the on-screen keyboard opens (iOS ignores
// interactive-widget; Chrome on Android honours it, so this is a no-op there).
if (window.visualViewport) {
  const vv = window.visualViewport;
  const fit = () => {
    document.documentElement.style.setProperty('--vvh', vv.height + 'px');
    if ($('chat').classList.contains('is-on') && document.activeElement === $('input')) scrollDown(true);
  };
  vv.addEventListener('resize', fit); fit();
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
  if (!$('panel').hidden) return openPanel(false);
  if (replyTo) clearReply();
});

window.addEventListener('pagehide', () => { try { session?.destroy('local'); } catch {} });

// Expose a tiny hook for automated tests only when explicitly served in test mode.

