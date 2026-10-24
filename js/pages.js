// Guide and legal pages: reveal-on-scroll, "you are here" in the contents, and the
// interactive connection flowchart. No network, no storage; text goes in via textContent.
'use strict';
(() => {
  const doc = document.documentElement;
  doc.classList.add('js');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Reveal sections as they come into view.
  const reveals = document.querySelectorAll('.reveal');
  if (reduced || !('IntersectionObserver' in window)) reveals.forEach((el) => el.classList.add('is-in'));
  else {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.04 });
    reveals.forEach((el) => io.observe(el));
  }

  // Highlight the contents link for the section being read.
  const links = [...document.querySelectorAll('.toc a[href^="#"], .legal-nav a[href^="#"]')];
  const targets = links.map((a) => document.getElementById(a.getAttribute('href').slice(1))).filter(Boolean);
  if (targets.length && 'IntersectionObserver' in window) {
    const seen = new Map();
    const spy = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting);
      const here = targets.find((t) => seen.get(t.id));
      if (!here) return;
      for (const a of links) a.classList.toggle('is-here', a.getAttribute('href') === '#' + here.id);
    }, { rootMargin: '-30% 0px -60% 0px' });
    targets.forEach((t) => spy.observe(t));
  }

  // Connection flowchart: each situation lights one path through the chart.
  const flow = document.getElementById('flow');
  const scen = document.getElementById('scen');
  if (!flow || !scen) return;
  const BASE_N = ['n1', 'n2', 'n3'];
  const TAIL_N = ['n7', 'n8', 'n9'];
  const SCEN = {
    home: {
      n: [...BASE_N, 'n4', 'n5', ...TAIL_N, 'n10'], e: ['e12', 'e23', 'e34', 'e45', 'e57', 'e78', 'e89', 'e910'],
      note: 'On an ordinary home network the browsers connect straight to each other. The relay is never used.',
      steps: [
        ['Host opens a room', 'Your browser registers the room name with the introduction server and keeps a door open on the relay.'],
        ['Joiner tries direct', 'WebRTC asks STUN servers for each side\'s public address and opens a peer-to-peer pipe.'],
        ['Handshake', 'Three messages trade fresh keys and prove both sides hold the code.'],
        ['Connected', 'Anyone else needs the host\'s approval. Messages flow directly between you.'],
      ],
    },
    vpn: {
      n: [...BASE_N, 'n4', 'n5', 'n6', ...TAIL_N, 'n10'], e: ['e12', 'e23', 'e34', 'e45', 'e56', 'e67', 'e78', 'e89', 'e910'],
      note: 'VPNs, phone carriers and strict routers block direct links. After 2.5 seconds without one, the relay takes over, usually within a few seconds.',
      steps: [
        ['Direct attempt stalls', 'The VPN or carrier network hides a usable address, so no peer-to-peer path opens.'],
        ['Relay dialled', 'A WebSocket on port 443, the same as any website, so it gets through.'],
        ['Same handshake', 'The relay forwards the three handshake messages it can\'t read or fake.'],
        ['Connected', 'Messages flow through the relay, sealed end to end. It sees sizes and timing, never content.'],
      ],
    },
    max: {
      n: [...BASE_N, 'n6', ...TAIL_N, 'n10'], e: ['e12', 'e23', 'e36', 'e67', 'e78', 'e89', 'e910'],
      note: 'Maximum privacy never attempts a direct link, so the other person never learns your IP address. Only the relay sees it.',
      steps: [
        ['No direct attempt', 'WebRTC is never asked for your address, so it never reaches the other person.'],
        ['Relay only', 'Traffic goes through the relay, with steady 4 KB packets that hide when you type.'],
        ['Same handshake', 'Keys and proofs are identical; only the route differs.'],
        ['Connected', 'Slower, and about 60 MB an hour, in exchange for hiding your address and your rhythm.'],
      ],
    },
    wrong: {
      n: [...BASE_N, 'n4', 'n5', ...TAIL_N, 'n11'], e: ['e12', 'e23', 'e34', 'e45', 'e57', 'e78', 'e89', 'e911'],
      note: 'Someone guessed the room name but not the secret part. Their proof can\'t match, so the host refuses them and keeps waiting for the right person.',
      steps: [
        ['Pipe opens', 'Getting a connection is easy: the first five characters are not secret.'],
        ['Handshake starts', 'Keys are exchanged, but they\'re salted with the full code.'],
        ['Proof fails', 'Without all 20 characters the HMAC proof is wrong.'],
        ['Refused', 'Nothing is decrypted, and the real room is untouched.'],
      ],
    },
  };
  const note = document.getElementById('scenNote');
  const list = document.getElementById('scenSteps');
  function show(key) {
    const s = SCEN[key];
    if (!s) return;
    for (const b of scen.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.scen === key));
    flow.classList.add('has-path');
    for (const el of flow.querySelectorAll('[data-n]')) el.classList.toggle('is-lit', s.n.includes(el.dataset.n));
    for (const el of flow.querySelectorAll('[data-e]')) el.classList.toggle('is-lit', s.e.includes(el.dataset.e));
    note.textContent = s.note;
    list.replaceChildren(...s.steps.map(([t, d]) => {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = t;
      li.append(b, document.createTextNode(d));
      return li;
    }));
  }
  scen.addEventListener('click', (e) => { const b = e.target.closest('button[data-scen]'); if (b) show(b.dataset.scen); });
  show('home');
})();
