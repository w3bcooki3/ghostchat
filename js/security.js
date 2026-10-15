// "Who can read your conversation?": interactive observer lens + summary matrix.
// Every statement here mirrors SECURITY.md; keep them in sync.
const FIELDS = [
  ['content', 'Message text'],
  ['files', 'Files and images'],
  ['names', 'Names and avatars'],
  ['activity', 'Typing, reactions, read receipts'],
  ['size', 'Exact message sizes'],
  ['timing', 'When and how much you talk'],
  ['ip', 'IP addresses'],
  ['room', 'That your room exists'],
  ['code', 'The full room code'],
];

const OBSERVERS = [
  {
    id: 'peer', name: 'The other person', short: 'Other person',
    verdict: 'The person you invited sees the whole conversation. That is the point. What they do with it is up to them.',
    s: {
      content: ['yes', 'Decrypted in their browser.'],
      files: ['yes', 'Saved only if they choose to.'],
      names: ['yes', 'The name and avatar you picked for this chat.'],
      activity: ['part', 'Reactions always; typing and read receipts only if you leave them on.'],
      size: ['yes', 'They see the message itself.'],
      timing: ['yes', 'They see when you write.'],
      ip: ['part', 'Visible on direct connections. Maximum privacy hides it behind a relay.'],
      room: ['yes', 'They joined it.'],
      code: ['yes', 'You gave it to them.'],
    },
    m: {
      activity: ['part', 'Only reactions. Typing indicator and read receipts are off.'],
      ip: ['no', 'Your traffic reaches them through a relay, so they see the relay\'s address.'],
    },
  },
  {
    id: 'server', name: 'Introduction server', short: 'Signaling server',
    verdict: 'It introduces the two browsers, then steps out. It never sees the code, the keys or anything you say. Running your own removes even the metadata.',
    s: {
      content: ['no', 'Messages never pass through it.'],
      files: ['no', 'Files go directly between browsers or through a relay, encrypted.'],
      names: ['no', 'Names are sent only after encryption is set up.'],
      activity: ['no', 'Encrypted, and never sent to it.'],
      size: ['no', 'Messages never pass through it.'],
      timing: ['part', 'It sees when browsers connect and reconnect, not when you send messages.'],
      ip: ['yes', 'Both browsers connect to it directly. Self-hosting it, or a VPN or Tor, is the fix.'],
      room: ['yes', 'It sees the first 5 characters, which name the room.'],
      code: ['no', 'The other 15 characters never leave your browsers.'],
    },
  },
  {
    id: 'relay', name: 'Relay server', short: 'TURN relay',
    verdict: 'Used when a direct connection isn\'t possible, or always with Maximum privacy. It forwards sealed packets it can\'t open.',
    s: {
      content: ['no', 'Encrypted twice: by WebRTC and by Ghost Chat.'],
      files: ['no', 'Encrypted chunk by chunk.'],
      names: ['no', 'Encrypted.'],
      activity: ['no', 'Encrypted, padded like everything else.'],
      size: ['part', 'Only padded sizes: 256 B, 1 KB, 4 KB, 16 KB or 64 KB.'],
      timing: ['yes', 'It sees when packets flow and roughly how much.'],
      ip: ['yes', 'It forwards traffic between your addresses.'],
      room: ['no', 'It never sees signaling.'],
      code: ['no', 'Never sent anywhere.'],
    },
    m: {
      size: ['part', 'Text, receipts and typing all travel as identical 4 KB packets. Files still show their rough size.'],
      timing: ['part', 'Only that a conversation is open and for how long. Packets flow at a fixed rate whether you talk or not.'],
    },
  },
  {
    id: 'network', name: 'Your network or ISP', short: 'Network / ISP',
    verdict: 'Your Wi-Fi owner or internet provider sees encrypted traffic going somewhere, and nothing inside it.',
    s: {
      content: ['no', 'Encrypted before it leaves your browser.'],
      files: ['no', 'Encrypted.'],
      names: ['no', 'Encrypted.'],
      activity: ['no', 'Encrypted.'],
      size: ['part', 'Only padded, encrypted packet sizes.'],
      timing: ['yes', 'Traffic volume and timing are visible.'],
      ip: ['yes', 'They see which addresses you exchange traffic with.'],
      room: ['no', 'Signaling travels over an encrypted connection.'],
      code: ['no', 'Never sent anywhere.'],
    },
    m: {
      size: ['part', 'Identical 4 KB packets for everything except files.'],
      timing: ['part', 'Only that a conversation is open and for how long.'],
      ip: ['part', 'They see you talking to a relay, not who is on the other end.'],
    },
  },
  {
    id: 'codeholder', name: 'Someone who learns the code', short: 'Code leaked',
    verdict: 'The code is the key, but only until your peer arrives. Once you are both in, the room locks and the code stops working.',
    s: {
      content: ['part', 'Only if they join before your peer does. After that the room is locked, even to the right code.'],
      files: ['part', 'Same: only if they get in first.'],
      names: ['part', 'Same: only if they get in first.'],
      activity: ['part', 'Same: only if they get in first.'],
      size: ['part', 'Same: only if they get in first.'],
      timing: ['part', 'Same: only if they get in first.'],
      ip: ['part', 'Same: only if they get in first.'],
      room: ['yes', 'Part of the code.'],
      code: ['yes', 'That is the risk. Share it once, over a channel you trust, and compare safety numbers.'],
    },
  },
  {
    id: 'device', name: 'Malware on your device', short: 'Compromised device',
    verdict: 'Encryption protects messages on the way. It can\'t protect a device that is already compromised. No app can.',
    s: {
      content: ['yes', 'It sees your screen and keyboard.'], files: ['yes', 'It can read files you open or save.'],
      names: ['yes', ''], activity: ['yes', ''], size: ['yes', ''], timing: ['yes', ''],
      ip: ['yes', ''], room: ['yes', ''], code: ['yes', 'If you type or paste it.'],
    },
  },
];
let mode = 'standard';
const view = (o, key) => (mode === 'max' && o.m && o.m[key]) || o.s[key];

// What a partly-seeing observer gets instead of the real value (padding, connection events only).
const PART_VIEW = { size: '256 B, 256 B, 21 × 64 KB', timing: '21:02 joined · 21:05 reconnected' };
const PART_VIEW_MAX = { size: '4 KB × 1,680 · 21 × 64 KB', timing: 'open 21:02 → 21:09', ip: '203.0.113.24 ↔ relay.example' };

const LABEL = { yes: 'Can see', part: 'Partly', no: "Can't see" };
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const CIPHER = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789+/=';
const scramble = (s) => Array.from(s, (ch) => (/\s/.test(ch) ? ch : CIPHER[(Math.random() * CIPHER.length) | 0])).join('');

let current = 'server';
function select(id, focus) {
  const o = OBSERVERS.find((x) => x.id === id) || OBSERVERS[1];
  for (const b of $('observers').children) {
    const on = b.dataset.id === o.id;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  $('viewWho').textContent = o.name;
  $('verdict').textContent = o.verdict;
  // The mock conversation: visible, scrambled to ciphertext, or dimmed when partly visible.
  for (const node of document.querySelectorAll('.mock [data-f]')) {
    const st = view(o, node.dataset.f)[0];
    node.dataset.state = st;
    const target = node.dataset.plain != null ? node : node.querySelector('[data-plain]');
    if (!target) continue;
    const plain = target.dataset.plain;
    const key = node.dataset.f;
    const partView = (mode === 'max' && PART_VIEW_MAX[key]) || PART_VIEW[key];
    target.textContent = st === 'no' ? scramble(plain) : st === 'part' && o.id !== 'codeholder' && partView ? partView : plain;
  }
  const list = $('fieldList');
  list.replaceChildren();
  for (const [key, label] of FIELDS) {
    const [st, note] = view(o, key);
    const li = el('li', 'f f-' + st);
    const head = el('div', 'f-head');
    head.append(el('span', 'st st-' + st), el('span', 'f-label', label), el('span', 'f-state', LABEL[st]));
    li.append(head);
    if (note) li.append(el('p', 'f-note', note));
    list.append(li);
  }
  for (const td of document.querySelectorAll('#matrix [data-col]')) td.classList.toggle('is-col', td.dataset.col === o.id);
  current = o.id;
  if (location.hash.slice(1) !== o.id) history.replaceState(null, '', '#' + o.id);
}

function renderMatrix() {
  const t = $('matrix');
  t.replaceChildren();
  const thead = el('thead'), hr = el('tr');
  hr.append(el('th', null, ''));
  for (const o of OBSERVERS) { const th = el('th', null, o.short); th.scope = 'col'; th.dataset.col = o.id; hr.append(th); }
  thead.append(hr);
  const tbody = el('tbody');
  for (const [key, label] of FIELDS) {
    const tr = el('tr');
    const th = el('th', null, label); th.scope = 'row'; tr.append(th);
    for (const o of OBSERVERS) {
      const st = view(o, key)[0];
      const changed = mode === 'max' && o.m && o.m[key] && o.m[key][0] !== o.s[key][0];
      const td = el('td', changed ? 'is-changed' : null); td.dataset.col = o.id;
      const dot = el('span', 'st st-' + st); dot.title = LABEL[st] + (changed ? ' (with Maximum privacy)' : '');
      const sr = el('span', 'visually-hidden', LABEL[st] + (changed ? ', improved by Maximum privacy' : ''));
      td.append(dot, sr); tr.append(td);
    }
    tbody.append(tr);
  }
  t.append(thead, tbody);
}

function setMode(m) {
  mode = m;
  for (const b of document.querySelectorAll('#modeSwitch button')) b.setAttribute('aria-checked', String(b.dataset.mode === m));
  $('modeNote').textContent = m === 'max'
    ? 'Maximum privacy: relayed connection, constant-rate traffic, no typing indicator or read receipts. Highlighted cells are what it changes.'
    : 'Standard: a direct connection, the fastest setting. Everything is still end-to-end encrypted with post-quantum protection.';
  renderMatrix();
  select(current);
}

function build() {
  for (const b of document.querySelectorAll('#modeSwitch button')) b.addEventListener('click', () => setMode(b.dataset.mode));
  const group = $('observers');
  for (const o of OBSERVERS) {
    const b = el('button', 'obs', o.name);
    b.type = 'button'; b.dataset.id = o.id; b.setAttribute('role', 'radio');
    b.addEventListener('click', () => select(o.id));
    group.append(b);
  }
  group.addEventListener('keydown', (e) => {
    const i = OBSERVERS.findIndex((o) => o.id === document.activeElement?.dataset.id);
    if (i < 0) return;
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    select(OBSERVERS[(i + d + OBSERVERS.length) % OBSERVERS.length].id, true);
  });

  renderMatrix();
  const t = $('matrix');
  t.addEventListener('click', (e) => { const col = e.target.closest('[data-col]')?.dataset.col; if (col) { select(col); $('observers').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } });
  select(location.hash.slice(1) || 'server');
}
build();
addEventListener('hashchange', () => select(location.hash.slice(1)));
