// End-to-end tests: real Chromium instances talking over real WebRTC through a
// local PeerJS signaling server. Run: npm run test:e2e
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIG = 9311, WEB = 8391;
const BASE = `http://127.0.0.1:${WEB}/`;
const procs = [];
function run(cmd, args, env) {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return new Promise((res) => { p.stdout.on('data', (d) => { if (/on|serving/.test(String(d))) res(); }); setTimeout(res, 3000); });
}
await run('node', ['tests/peerserver.cjs'], { PORT: SIG });
await run('node', ['tests/serve.mjs'], { PORT: WEB, TEST_SIGNAL_PORT: SIG, TEST_DEAD_MS: 6000 });

const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
const problems = [];
let passed = 0, failed = 0;
const results = [];

async function page(name, viewport = { width: 1024, height: 800 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  await ctx.route(/google\.com/, (r) => r.fulfill({ body: '<title>elsewhere</title>', contentType: 'text/html' }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => problems.push(`${name}: page error: ${e.message}`));
  p.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/Failed to load resource/.test(t)) problems.push(`${name}: console error: ${t}`);
    if (/Content.Security.Policy/i.test(t)) problems.push(`${name}: CSP violation: ${t}`);
  });
  await p.goto(BASE);
  return p;
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); passed++; results.push(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { failed++; results.push(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
  console.log(results[results.length - 1]);
}

/** Sets the display name through the "Your ghost" sheet, from whichever screen is showing. */
async function setName(p, name) {
  await p.locator('.screen.is-on .me-chip').click();
  await p.fill('#nameInput', name);
  await p.click('#meDone');
  await p.waitForSelector('#meSheet', { state: 'hidden' });
}
async function host(p, name = 'Alice') {
  await setName(p, name);
  await p.click('#createBtn');
  await p.waitForFunction(() => document.querySelector('#steps [data-step="signal"]').classList.contains('is-done'), null, { timeout: 15000 });
  return (await p.textContent('#codeGroups')).trim();
}
async function join(p, code, name = 'Bob') {
  await setName(p, name);
  await p.click('#openJoinBtn');
  await p.fill('#code1', code);           // a whole code typed or pasted into the first box spreads across all four
  await p.click('#joinBtn');
}
async function pair(nameA = 'Alice', nameB = 'Bob', vpB) {
  const A = await page(nameA), B = await page(nameB, vpB);
  const code = await host(A, nameA);
  await join(B, code, nameB);
  await A.waitForSelector('#chat.is-on', { timeout: 20000 });
  await B.waitForSelector('#chat.is-on', { timeout: 20000 });
  return { A, B, code };
}
async function say(p, text) { await p.fill('#input', text); await p.press('#input', 'Enter'); }
const lastThem = (p) => p.locator('.msg.them .bubble span:not(.quote)').last();
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
// The app's CSP forbids fetch() of blob: URLs, so read the received Blob via the test hook.
async function blobHash(p, name) {
  return p.evaluate(async (n) => {
    const buf = await window.__ghost.files[n].arrayBuffer();
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }, name);
}

// ───────────────────────────── scenarios ─────────────────────────────
let S;
await test('before anyone joins, a wrong secret for the right room is refused', async () => {
  const H = await page('Waiting host'), X = await page('Guesser');
  const code = await host(H, 'Waiting host');
  await join(X, code.slice(0, 6) + 'AAAAA-AAAAA-AAAAA', 'Guesser');
  await X.waitForSelector('#connectError:not([hidden])', { timeout: 20000 });
  assert(/didn.t accept this code/.test(await X.textContent('#connectErrorText')), await X.textContent('#connectErrorText'));
  assert(await H.locator('#chat.is-on').count() === 0, 'host stays in the waiting room');
  await H.context().close(); await X.context().close();
});

await test('connects, both safety numbers match, names exchanged', async () => {
  S = await pair();
  const [a, b] = [await S.A.getAttribute('#safetyNumber', 'data-value'), await S.B.getAttribute('#safetyNumber', 'data-value')];
  assert(a && a === b, `safety numbers differ: ${a} vs ${b}`);
  assert(/^(\d{5} ){11}\d{5}$/.test(a), 'safety number format');
  await S.A.waitForFunction(() => document.getElementById('peerName').textContent === 'Bob');
  await S.B.waitForFunction(() => document.getElementById('peerName').textContent === 'Alice');
});

await test('messages flow both ways with delivered → read receipts', async () => {
  await say(S.A, 'first message');
  await S.B.waitForSelector('.msg.them');
  assert((await lastThem(S.B).textContent()) === 'first message', 'B text');
  await S.A.waitForFunction(() => document.querySelector('.msg.me .status')?.textContent === 'Read', null, { timeout: 5000 });
  await say(S.B, 'reply from bob');
  await S.A.waitForFunction(() => document.querySelector('.msg.them .bubble')?.textContent.includes('reply from bob'));
});

await test('200 rapid messages arrive complete and in order', async () => {
  await S.A.evaluate(async () => {
    const s = window.__ghost.session;
    for (let i = 0; i < 200; i++) s.send({ t: 'msg', mid: crypto.getRandomValues(new Uint8Array(8)).reduce((a, b) => a + b.toString(16).padStart(2, '0'), ''), text: 'burst ' + i });
  });
  await S.B.waitForFunction(() => [...document.querySelectorAll('.msg.them .bubble')].filter((b) => b.textContent.startsWith('burst')).length === 200, null, { timeout: 20000 });
  const texts = await S.B.$$eval('.msg.them .bubble', (els) => els.map((e) => e.textContent).filter((t) => t.startsWith('burst')));
  assert(texts.every((t, i) => t === 'burst ' + i), 'order broken');
});

await test('maximum-length message (8000 chars, multi-byte) is delivered intact', async () => {
  const big = '👻ж'.repeat(2665) + 'end!'; // 7999 UTF-16 units, ~16 KB UTF-8
  await S.A.evaluate((t) => { const i = document.getElementById('input'); i.value = t; i.dispatchEvent(new Event('input')); }, big);
  await S.A.click('#sendBtn');
  await S.B.waitForFunction((n) => document.querySelector('.msg.them:last-child .bubble span')?.textContent.length === n, big.length, { timeout: 8000 });
});

await test('peer-supplied HTML/script is rendered inert', async () => {
  await S.A.evaluate(() => {
    window.__ghost.session.send({ t: 'msg', mid: 'aaaaaaaaaaaaaaaa', text: '<img src=x onerror="window.__pwned=1">' });
    window.__ghost.session.send({ t: 'profile', name: '<b onmouseover=alert(1)>‮evil', avatar: '<script>' });
    window.__ghost.session.send({ t: 'msg', mid: 'aaaaaaaaaaaaaaab', text: 'click javascript:alert(1) or https://ok.example/x' });
  });
  await S.B.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent.includes('ok.example'));
  const r = await S.B.evaluate(() => ({
    pwned: window.__pwned, imgs: document.querySelectorAll('.bubble img').length,
    name: document.getElementById('peerName').textContent, avatar: document.getElementById('peerAvatar').textContent,
    links: [...document.querySelectorAll('.bubble a')].map((a) => a.href),
  }));
  assert(r.pwned === undefined && r.imgs === 0, 'HTML executed or parsed');
  assert(!r.name.includes('‮') && r.name.startsWith('<b'), 'bidi override not stripped: ' + JSON.stringify(r.name));
  assert(r.avatar === '👤', 'unknown avatar should fall back');
  assert(r.links.every((h) => h.startsWith('https:') || h.startsWith('http:')), 'non-http link created: ' + r.links);
  await S.A.evaluate(() => window.__ghost.session.send({ t: 'profile', name: 'Alice', avatar: '👻' }));
});

await test('5 MB file transfers byte-for-byte', async () => {
  const buf = randomBytes(5 * 1024 * 1024);
  await S.A.setInputFiles('#fileInput', { name: 'payload.bin', mimeType: 'application/octet-stream', buffer: buf });
  await S.B.waitForSelector('.file-sub a[download]', { timeout: 30000 });
  const got = await blobHash(S.B, 'payload.bin');
  assert(got === sha(buf), 'hash mismatch');
  const dl = await S.B.getAttribute('.file-sub a[download]', 'download');
  assert(dl === 'payload.bin', 'name ' + dl);
});

await test('received images are never opened automatically; only sniffed raster types can be viewed; SVG and spoofed MIME cannot', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await S.A.setInputFiles('#fileInput', { name: 'dot.png', mimeType: 'image/png', buffer: png });
  await S.B.waitForSelector('.msg.them .media-view', { timeout: 10000 });
  assert(await S.B.$$eval('.msg.them img', (els) => els.length) === 0, 'an image was decoded before the person chose to view it');
  await S.B.click('.msg.them .media-view');
  await S.B.waitForSelector('#viewer:not([hidden]) #viewerImg[src^="blob:"]', { timeout: 5000 });
  await S.B.click('#viewerClose');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="parent.__pwned=2"><script>parent.__pwned=3</script></svg>');
  await S.A.setInputFiles('#fileInput', { name: 'evil.svg', mimeType: 'image/svg+xml', buffer: svg });
  await S.B.waitForFunction(() => [...document.querySelectorAll('.file-sub a[download]')].some((a) => a.download === 'evil.svg'), null, { timeout: 10000 });
  const html = Buffer.from('<script>parent.__pwned=4</script>');
  await S.A.setInputFiles('#fileInput', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: html });
  await S.B.waitForFunction(() => [...document.querySelectorAll('.file-sub a[download]')].some((a) => a.download === 'photo.jpg'), null, { timeout: 10000 });
  const t = await S.B.evaluate(async () => {
    const a = [...document.querySelectorAll('.file-sub a[download]')].find((x) => x.download === 'evil.svg');
    let fetchBlocked = false;
    try { await fetch(a.href); } catch { fetchBlocked = true; }
    return { pwned: window.__pwned, fetchBlocked, viewable: document.querySelectorAll('.msg.them .media-view').length, svgRisky: !!a.closest('.file-card.is-risky') };
  });
  assert(t.pwned === undefined, 'script ran');
  assert(t.fetchBlocked, 'CSP should block fetch of blob URLs');
  assert(t.viewable === 1, 'only the PNG should be viewable, got ' + t.viewable);
  assert(t.svgRisky, 'SVG should be flagged as able to run code');
});

await test('reply, reactions and unsend sync between peers', async () => {
  await say(S.A, 'react to me');
  await S.B.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent === 'react to me');
  await S.B.locator('.msg.them').last().locator('.bubble').dblclick();
  await S.A.waitForFunction(() => document.querySelector('.msg.me:last-child .react')?.textContent.includes('❤️'), null, { timeout: 5000 });
  await S.B.locator('.msg.them').last().locator('.bubble').click({ button: 'right' });
  await S.B.click('[data-act="reply"]');
  await say(S.B, 'this is a reply');
  await S.A.waitForFunction(() => document.querySelector('.msg.them:last-child .quote')?.textContent.includes('react to me'), null, { timeout: 5000 });
  await say(S.A, 'oops, take that back');
  await S.B.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent === 'oops, take that back');
  await S.A.locator('.msg.me').last().locator('.bubble').click({ button: 'right' });
  await S.A.click('[data-act="unsend"]');
  await S.B.waitForFunction(() => ![...document.querySelectorAll('.msg.them .bubble')].some((b) => b.textContent === 'oops, take that back'), null, { timeout: 5000 });
  assert(await S.B.locator('.sys', { hasText: 'unsent a message' }).count() === 1, 'unsend notice');
});

await test('edit a message: both screens update and show it was edited', async () => {
  await say(S.A, 'meet at nine');
  await S.B.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent === 'meet at nine');
  await S.A.locator('.msg.me').last().locator('.bubble').click({ button: 'right' });
  await S.A.click('[data-act="edit"]');
  assert(await S.A.isVisible('#editBar'), 'edit bar shown');
  assert(await S.A.inputValue('#input') === 'meet at nine', 'composer holds the text');
  await S.A.fill('#input', 'meet at ten');
  await S.A.press('#input', 'Enter');
  await S.B.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble span')?.textContent === 'meet at ten', null, { timeout: 5000 });
  assert(await S.B.locator('.msg.them').last().locator('.edited').count() === 1, 'receiver sees "edited"');
  assert(await S.A.locator('.msg.me').last().locator('.edited').count() === 1, 'sender sees "edited"');
  assert(await S.A.isHidden('#editBar'), 'edit bar closes');
  // ArrowUp on an empty composer edits the last message; Escape cancels.
  await S.A.focus('#input'); await S.A.press('#input', 'ArrowUp');
  assert(await S.A.isVisible('#editBar'), 'ArrowUp starts editing');
  await S.A.press('#input', 'Escape');
  assert(await S.A.isHidden('#editBar') && await S.A.inputValue('#input') === '', 'Escape cancels editing');
});

await test('peer cannot edit messages it did not author, files, or messages that do not exist', async () => {
  await say(S.B, 'only bob writes this');
  await S.A.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent === 'only bob writes this');
  const bobsId = await S.B.evaluate(() => document.querySelector('.msg.me:last-child').dataset.id);
  await S.A.evaluate((id) => {
    const s = window.__ghost.session;
    s.send({ t: 'edit', target: id, text: 'forged by alice' });
    s.send({ t: 'edit', target: 'ffffffffffffffff', text: 'nothing here' });
    s.send({ t: 'edit', target: id, text: '' });
    s.send({ t: 'edit', target: { x: 1 }, text: 'bad target' });
  }, bobsId);
  await S.A.waitForTimeout(600);
  const t = await S.B.evaluate(() => document.querySelector('.msg.me:last-child .bubble span').textContent);
  assert(t === 'only bob writes this', 'forged edit was ignored: ' + t);
  assert(await S.B.locator('.edited', { hasText: 'edited' }).count() <= 1, 'no edited label added by forgeries');
});

await test('peer cannot unsend or react to messages it did not author or that do not exist', async () => {
  await say(S.B, 'bob owns this');
  await S.A.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent === 'bob owns this');
  const myId = await S.B.evaluate(() => document.querySelector('.msg.me:last-child').dataset.id);
  // A (the peer) tries to delete a message B wrote... from B's own view it's B's message: A sends unsend for it.
  await S.A.evaluate((id) => window.__ghost.session.send({ t: 'unsend', target: id }), myId);
  await S.A.evaluate(() => window.__ghost.session.send({ t: 'react', target: 'ffffffffffffffff', emoji: '🔥' }));
  await S.B.waitForTimeout(800);
  assert(await S.B.locator(`.msg[data-id="${myId}"]`).count() === 1, 'peer deleted a message it did not write');
});

await test('typing indicator appears and clears', async () => {
  await S.B.type('#input', 'typing…', { delay: 30 });
  await S.A.waitForSelector('#typing:not([hidden])', { timeout: 5000 });
  await S.B.fill('#input', '');
  await S.B.waitForTimeout(3800);
  await S.A.waitForSelector('#typing[hidden]', { state: 'attached', timeout: 5000 });
});

await test('a third browser with the right room but wrong secret is refused; chat continues', async () => {
  const M = await page('Mallory');
  const wrong = S.code.slice(0, 6) + 'AAAAA-AAAAA-AAAAA';
  await join(M, wrong, 'Mallory');
  await M.waitForSelector('#connectError:not([hidden])', { timeout: 20000 });
  const msg = await M.textContent('#connectErrorText');
  assert(/didn.t accept this code/.test(msg), 'refused for the wrong code: ' + msg);
  await S.A.waitForSelector('.sys.is-warn >> text=couldn\'t prove it had the room code', { timeout: 5000 });
  await say(S.A, 'still private');
  await S.B.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent === 'still private', null, { timeout: 5000 });
  assert(await M.locator('#chat.is-on').count() === 0, 'mallory reached the chat');
  await M.context().close();
});

await test('dropped link resumes automatically, proves continuity, delivers queued messages', async () => {
  const before = await S.A.getAttribute('#safetyNumber', 'data-value');
  await S.A.click('#panelBtn'); await S.A.click('#markVerified'); await S.A.click('#panelClose');
  await S.B.evaluate(() => window.__ghost.session.active.conn.peerConnection.close());
  await S.A.waitForSelector('#banner:not([hidden])', { timeout: 15000 });
  await say(S.A, 'sent while offline');
  const st = await S.A.textContent('.msg.me:last-child .status');
  await S.B.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent === 'sent while offline', null, { timeout: 30000 });
  await S.A.waitForSelector('#banner[hidden]', { state: 'attached', timeout: 10000 });
  const [a, b] = [await S.A.getAttribute('#safetyNumber', 'data-value'), await S.B.getAttribute('#safetyNumber', 'data-value')];
  assert(a === b && a === before, 'a proven resume keeps the original safety number');
  assert(await S.A.locator('#verifyChip.is-verified').count() === 1, 'verification survives a proven resume');
  await S.A.waitForSelector('.sys.is-good >> text=proved it\'s the same one', { timeout: 5000 });
  assert(st === 'Queued' || st === 'Sent', 'status while offline was ' + st);
  assert(await S.B.locator('.msg.them .bubble', { hasText: 'sent while offline' }).count() === 1, 'duplicate delivery');
});

await test('a newcomer with the full, correct code waits for the host; Deny turns them away', async () => {
  const M = await page('Leaker');
  await join(M, S.code, 'Leaker');
  await M.waitForFunction(() => /Waiting to be let in/.test(document.getElementById('connectTitle').textContent), null, { timeout: 20000 });
  assert(/Waiting for Alice to let you in/.test(await M.textContent('#peerStepText')), 'joiner told who decides: ' + await M.textContent('#peerStepText'));
  await S.A.waitForSelector('.knock-card >> text=Leaker wants to join', { timeout: 10000 });
  assert(await S.B.locator('.knock-card').count() === 0, 'only the host is asked');
  await S.A.click('.knock-card >> text=Deny');
  await M.waitForSelector('#connectError:not([hidden])', { timeout: 10000 });
  assert(/didn.t let you in/.test(await M.textContent('#connectErrorText')), await M.textContent('#connectErrorText'));
  await S.A.waitForSelector('.sys >> text=You turned Leaker away', { timeout: 5000 });
  await say(S.A, 'still just us');
  await S.B.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent === 'still just us', null, { timeout: 5000 });
  assert(await M.locator('#chat.is-on').count() === 0, 'denied joiner reached the chat');
  await M.context().close();
});

await test('constant-rate mode: syncs to the peer and every frame on the wire is identical in size', async () => {
  await S.A.click('#panelBtn'); await S.A.click('label:has(#optShape)'); await S.A.click('#panelClose');
  await S.B.waitForSelector('.sys.is-good >> text=constant-rate traffic', { timeout: 5000 });
  assert(await S.B.isChecked('#optShape'), 'peer toggle follows');
  await S.A.waitForTimeout(600);
  const stats = async (p) => p.evaluate(async () => {
    const r = await window.__ghost.session.active.conn.peerConnection.getStats();
    let out = null; r.forEach((x) => { if (x.type === 'data-channel') out = { b: x.bytesSent, m: x.messagesSent }; });
    return out;
  });
  const s0 = await stats(S.A);
  await say(S.A, 'hidden in the stream');
  const long = 'ж'.repeat(3000) + ' long message split into fragments';   // ~6 KB of UTF-8: used to leak as a 16 KB frame
  await S.A.evaluate((t) => { const i = document.getElementById('input'); i.value = t; i.dispatchEvent(new Event('input')); }, long);
  await S.A.click('#sendBtn');
  await S.A.waitForTimeout(3000);
  const s1 = await stats(S.A);
  const msgs = s1.m - s0.m, bytes = s1.b - s0.b;
  assert(msgs >= 10 && msgs <= 14, 'about 4 frames per second, got ' + msgs + ' in 3s');
  assert(bytes === msgs * 4130, `all frames 4130 bytes (4096 padded + 34 overhead): ${bytes} / ${msgs}`);
  await S.B.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent.endsWith('split into fragments'), null, { timeout: 5000 });
  assert(await S.B.locator('.msg.them .bubble', { hasText: 'hidden in the stream' }).count() === 1, 'short message delivered');
  // The peer can't switch off protection A chose: a forged "off" changes nothing.
  assert(await S.B.isChecked('#optShape'), 'B: shows it on');
  await S.B.evaluate(() => window.__ghost.session.send({ t: 'shape', on: false }));
  await S.A.waitForTimeout(800);
  assert(await S.A.evaluate(() => window.__ghost.session.shaping) === true, 'A still shaping after the peer said off');
  assert(await S.A.isChecked('#optShape'), 'A: toggle still on');
  // B adds its own request; A withdrawing then leaves it on, because B still wants it.
  await S.B.click('#panelBtn'); await S.B.click('label:has(#optShape)'); await S.B.click('#panelClose');
  await S.A.waitForTimeout(500);
  await S.A.click('#panelBtn'); await S.A.click('label:has(#optShape)'); await S.A.click('#panelClose');
  await S.A.waitForSelector('.sys >> text=It stays on here because', { timeout: 5000 }).catch(() => {});
  await S.B.waitForSelector('.sys >> text=It stays on here because you turned it on', { timeout: 5000 });
  assert(await S.A.evaluate(() => window.__ghost.session.shaping) === true, 'A still shaping: B wants it');
  // Once B withdraws too, it's off for both.
  await S.B.click('#panelBtn'); await S.B.click('label:has(#optShape)'); await S.B.click('#panelClose');
  await S.A.waitForSelector('.sys >> text=turned off constant-rate traffic.', { timeout: 5000 });
  await S.A.waitForFunction(() => window.__ghost.session.shaping === false, null, { timeout: 3000 });
  assert(await S.B.evaluate(() => window.__ghost.session.shaping) === false, 'B stopped shaping');
  assert(!(await S.B.isChecked('#optShape')) && !(await S.A.isChecked('#optShape')), 'toggles off');
});

await test('disappearing messages vanish on both sides', async () => {
  await S.A.click('#panelBtn');
  await S.A.click('#timerOptions button[data-secs="10"]');
  await S.A.click('#panelClose');
  await S.B.waitForSelector('.sys >> text=disappear after 10 s', { timeout: 5000 });
  assert(!(await S.B.isHidden('#timerBadge')), 'B badge should show');
  await say(S.A, 'self-destructing');
  await S.B.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent === 'self-destructing');
  await S.B.waitForFunction(() => /⏱ \d/.test(document.querySelector('.msg.them:last-child .burn')?.textContent || ''), null, { timeout: 3000 });
  await S.B.waitForFunction(() => ![...document.querySelectorAll('.bubble')].some((b) => b.textContent === 'self-destructing'), null, { timeout: 15000 });
  await S.A.waitForFunction(() => ![...document.querySelectorAll('.bubble')].some((b) => b.textContent === 'self-destructing'), null, { timeout: 15000 });
  await S.B.click('#panelBtn'); await S.B.click('#timerOptions button[data-secs="0"]'); await S.B.click('#panelClose');
  await S.A.waitForSelector('.sys >> text=turned off disappearing', { timeout: 5000 });
});

await test('ending the session notifies the peer and wipes local state', async () => {
  await S.A.click('#panelBtn');
  await S.A.click('#endBtn');
  await S.A.click('#dialogOk');
  await S.A.waitForSelector('#home.is-on');
  assert(await S.A.locator('.msg').count() === 0, 'messages not wiped');
  await S.B.waitForSelector('.sys.is-bad >> text=ended the session', { timeout: 10000 });
  assert(await S.B.isDisabled('#input'), 'composer should be disabled');
  await S.A.context().close(); await S.B.context().close();
});

await test('navigating away and pressing Back does not bring the conversation back', async () => {
  const { A, B } = await pair('Ann', 'Ben');
  await say(A, 'back-cache secret');
  await B.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent === 'back-cache secret', null, { timeout: 8000 });
  await A.goto('https://www.google.com/');
  await B.waitForSelector('.sys >> text=/ left|ended the session/', { timeout: 10000 });
  await A.goBack();
  await A.waitForSelector('#home.is-on', { timeout: 10000 });
  assert(await A.locator('.msg').count() === 0, 'transcript restored from the back/forward cache');
  assert(!(await A.content()).includes('back-cache secret'), 'message text still in the page');
  await A.context().close(); await B.context().close();
});

await test('joining a room that does not exist explains what happened', async () => {
  const P = await page('Lonely');
  await join(P, 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', 'Lonely');
  await P.waitForSelector('#connectError:not([hidden])', { timeout: 20000 });
  assert(/This room isn.t open/.test(await P.textContent('#connectErrorText')), 'message');
  await P.context().close();
});

await test('join screen: code boxes split pasted codes, warn about look-alikes, explain incomplete codes', async () => {
  const P = await page('Typo');
  await P.click('#openJoinBtn');
  assert(await P.locator('#joinScreen.is-on').count() === 1, 'join screen opens');
  await P.fill('#code1', 'ABCDE-FGHIO');
  assert(/0, 1, I or O/.test(await P.textContent('#codeHelp')), await P.textContent('#codeHelp'));
  await P.fill('#code1', 'https://example.org/ghost/#tzqfm-eqzpl-3jmhc-465qy');
  const boxes = await P.$$eval('.code-box', (b) => b.map((x) => x.value));
  assert(boxes.join('-') === 'TZQFM-EQZPL-3JMHC-465QY', 'invite link split into boxes: ' + boxes);
  await P.fill('#code4', ''); await P.fill('#code3', '3JM');
  await P.click('#joinBtn');
  assert(/13 of 20 characters/.test(await P.textContent('#codeHelp')), await P.textContent('#codeHelp'));
  // typing moves forward; backspace on an empty box moves back
  await P.fill('#code1', ''); await P.fill('#code2', ''); await P.fill('#code3', '');
  await P.click('#code1'); await P.keyboard.type('abcde');
  assert(await P.evaluate(() => document.activeElement.id) === 'code2', 'auto-advance to the next box');
  await P.keyboard.press('Backspace');
  assert(await P.evaluate(() => document.activeElement.id) === 'code1', 'backspace returns to the previous box');
  // back returns home (also via the browser/phone back button)
  await P.goBack();
  await P.waitForSelector('#home.is-on');
  await P.context().close();
});

await test('invite link fragment is consumed and removed from the address bar', async () => {
  const P = await page('Invitee', { width: 390, height: 844 });
  await P.goto(BASE + '?x#abcde-fghjk-mnpqr-stuvw');
  await P.reload();
  await P.goto(BASE + '#ABCDE-FGHJK-MNPQR-STUVW');
  assert(!P.url().includes('#'), 'fragment still present: ' + P.url());
  await P.waitForSelector('#joinScreen.is-on');
  const boxes = await P.$$eval('.code-box', (b) => b.map((x) => x.value).join('-'));
  assert(boxes === 'ABCDE-FGHJK-MNPQR-STUVW', 'code not prefilled: ' + boxes);
  assert(/invited/.test(await P.textContent('#joinTitle')), 'invite heading');
  assert(await P.evaluate(() => document.activeElement.id) === 'joinBtn', 'join is one tap away');
  await P.context().close();
});

await test('panic wipe destroys the page and leaves', async () => {
  const s = await pair('P1', 'P2');
  await say(s.A, 'secret');
  await s.B.waitForSelector('.msg.them');
  await s.A.keyboard.press('Escape'); await s.A.keyboard.press('Escape'); await s.A.keyboard.press('Escape');
  await s.A.waitForURL(/google/, { timeout: 5000 });
  await s.B.waitForSelector('#banner:not([hidden])', { timeout: 15000 });
  await s.A.context().close(); await s.B.context().close();
});

await test('wide screen: docked panel collapses, one verify control at a time, invite opens a new room', async () => {
  const s = await pair('W1', 'W2', { width: 1400, height: 860 });
  const B = s.B;
  assert(await B.isVisible('#panel'), 'panel docked open');
  assert(await B.isHidden('#verifyChip'), 'header chip hidden while the panel shows verification');
  await B.click('#panelClose');
  assert(await B.isHidden('#panel'), 'panel collapses');
  assert(await B.isVisible('#verifyChip') && await B.isVisible('#panelBtn'), 'chip and expand button appear');
  await B.waitForTimeout(450);
  const pr = await B.evaluate(() => getComputedStyle(document.getElementById('chat')).paddingRight);
  assert(pr === '0px', 'conversation takes the panel\'s space: ' + pr);
  await B.click('#panelBtn');
  assert(await B.isVisible('#panel') && await B.isHidden('#verifyChip'), 'panel expands again');
  assert(await B.isHidden('#qaInvite'), 'members can\'t invite by default');
  await s.A.click('#panelBtn');
  await s.A.click('#qaInvite');
  await s.A.waitForSelector('#inviteSheet:not([hidden])');
  assert((await s.A.textContent('#invCode')).trim() === s.code, 'invite shares this room\'s code');
  assert(s.A.context().pages().length === 1, 'no new tab');
  await s.A.click('#inviteSheet [data-close-sheet]');
  await s.A.context().close(); await s.B.context().close();
});

await test('refuses to run inside a frame (click-jacking guard)', async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(BASE + 'manifest.webmanifest');
  await p.setContent(`<iframe src="${BASE}" width="800" height="600"></iframe>`);
  const f = await (await p.waitForSelector('iframe')).contentFrame();
  await f.waitForLoadState();
  await f.waitForFunction(() => document.body && /opened directly/.test(document.body.textContent), null, { timeout: 5000 });
  assert(await f.locator('#createBtn').count() === 0, 'UI rendered inside frame');
  await ctx.close();
});

await test('security page: observer lens updates the sample view, no CSP problems', async () => {
  const P = await page('Security');
  await P.click('.trust-link');
  await P.waitForSelector('#observers .obs');
  assert(await P.textContent('#viewWho') === 'Introduction server', 'default observer');
  const scrambled = await P.textContent('.mock-bubble.them');
  assert(!scrambled.includes('north entrance'), 'server should see ciphertext');
  await P.click('.obs[data-id="peer"]');
  assert((await P.textContent('.mock-bubble.them')).includes('north entrance'), 'peer should see plaintext');
  assert(P.url().endsWith('#peer'), 'hash deep link');
  await P.click('.obs[data-id="relay"]');
  assert((await P.textContent('[data-f="size"] dd')).includes('64 KB'), 'relay sees padded sizes only');
  assert(await P.locator('#matrix tbody tr').count() === 9, 'matrix rows');
  await P.context().close();
});

await test('guide and legal pages: linked from home, interactive flowchart works, no CSP problems', async () => {
  const P = await page('Guide');
  await P.click('.home-links a[href="guide.html"]');
  await P.waitForSelector('#flow');
  assert(await P.locator('#flow .n.is-lit').count() >= 8, 'a path is lit by default');
  await P.click('[data-scen="wrong"]');
  assert(await P.locator('#flow [data-n="n11"].is-lit').count() === 1, 'wrong code lights "Refused"');
  assert(await P.locator('#flow [data-n="n10"].is-lit').count() === 0, 'and not the chat');
  assert((await P.textContent('#scenNote')).includes('proof'), 'scenario note updates');
  await P.click('.nav a[href="legal.html"]');
  await P.waitForSelector('#privacy');
  assert(await P.locator('.legal-nav a').count() === 8, 'legal contents');
  await P.click('.nav a[href="security.html"]');
  await P.waitForSelector('#observers .obs');
  await P.context().close();
});

await test('someone who reloaded asks to join again; the host lets them in with a new safety number', async () => {
  const s = await pair('Host', 'Guest');
  const sn0 = await s.A.getAttribute('#safetyNumber', 'data-value');
  await s.B.context().close();                                  // guest "reloads": its keys are gone
  await s.A.waitForSelector('#banner:not([hidden])', { timeout: 15000 });
  const G = await page('Guest again');
  await join(G, s.code, 'Guest');
  await s.A.waitForSelector('.knock-card >> text=Guest wants to join', { timeout: 20000 });
  await s.A.click('.knock-card >> text=Let in');
  await G.waitForSelector('#chat.is-on', { timeout: 30000 });
  await s.A.waitForSelector('.sys.is-good >> text=Guest joined', { timeout: 10000 });
  await s.A.waitForSelector('#banner', { state: 'hidden', timeout: 10000 });
  const sn1 = await G.getAttribute('#safetyNumber', 'data-value');
  const hostHas = await s.A.evaluate(() => [...window.__ghost.people.values()].filter((p) => p.ready).map((p) => p.sn));
  assert(sn1 !== sn0 && hostHas.includes(sn1), 'fresh, matching safety number');
  assert(await s.A.locator('#verifyChip.is-verified').count() === 0, 'must be verified again');
  await say(G, 'back again');
  await s.A.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent === 'back again', null, { timeout: 8000 });
  await s.A.context().close(); await G.context().close();
});

// ───────────────────────────── groups ─────────────────────────────
const nameSn = (p) => p.evaluate(() => Object.fromEntries([...window.__ghost.people.values()].filter((x) => !x.gone).map((x) => [x.name, x.sn])));
async function trio() {
  const s = await pair('Ann', 'Ben');
  const C = await page('Cat');
  await join(C, s.code, 'Cat');
  await s.A.waitForSelector('.knock-card >> text=Cat wants to join', { timeout: 20000 });
  await s.A.click('.knock-card >> text=Let in');
  await C.waitForSelector('#chat.is-on', { timeout: 30000 });
  for (const p of [s.A, s.B, C]) await p.waitForFunction(() => window.__ghost.session.readyIds().length === 2, null, { timeout: 30000 });
  for (const p of [s.A, s.B, C]) await p.waitForFunction(() => [...window.__ghost.people.values()].every((x) => x.name), null, { timeout: 10000 });
  return { ...s, C };
}
let G3;
await test('groups: the host lets a third person in; every pair has its own end-to-end keys', async () => {
  G3 = await trio();
  const { A, B, C } = G3;
  await say(C, 'hi all');
  for (const p of [A, B]) await p.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent === 'hi all', null, { timeout: 8000 });
  assert(await A.textContent('.msg.them:last-child .msg-name, .msg.them .msg-name >> nth=-1') === 'Cat', 'sender named');
  await say(B, 'hello from ben');
  for (const p of [A, C]) await p.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent === 'hello from ben', null, { timeout: 8000 });
  assert(await A.textContent('#peerName') === 'Ben & Cat', 'header names the group: ' + await A.textContent('#peerName'));
  const [a, b, c] = [await nameSn(A), await nameSn(B), await nameSn(C)];
  assert(b.Cat && b.Cat === c.Ben, 'Ben and Cat share their own safety number');
  assert(a.Cat === c.Ann && a.Ben === b.Ann, 'each pair matches');
  assert(new Set([a.Ben, a.Cat, b.Cat]).size === 3, 'and every pair\'s number is different');
  await say(A, 'to both');
  await A.waitForFunction(() => document.querySelector('.msg.me:last-child .status')?.textContent === 'Read', null, { timeout: 8000 });
  await B.click('#panelBtn');
  assert(await B.locator('#snPick .sn-who').count() === 2, 'a picker for whose safety number');
  assert(/3 of 6/.test(await B.textContent('#peoplesTitle')), await B.textContent('#peoplesTitle'));
  await B.click('#panelClose');
});

await test('groups: unsend all mine; only the host can clear the chat for everyone', async () => {
  const { A, B, C } = G3;
  await say(B, 'b-one'); await say(B, 'b-two');
  await C.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent === 'b-two', null, { timeout: 8000 });
  await B.click('#panelBtn'); await B.click('#unsendAllBtn'); await B.click('#dialogOk');
  for (const p of [A, C]) {
    await p.waitForSelector('.sys >> text=Ben unsent all their messages', { timeout: 8000 });
    await p.waitForFunction(() => ![...document.querySelectorAll('.msg.them .bubble')].some((b) => /b-one|b-two|hello from ben/.test(b.textContent)), null, { timeout: 5000 });
  }
  assert(await C.locator('.msg.them .bubble', { hasText: 'hi all' }).count() === 0 && await C.locator('.msg.me .bubble', { hasText: 'hi all' }).count() === 1, 'other people\'s messages untouched');
  assert(await B.isHidden('#clearAllBtn'), 'members don\'t get the button');
  await B.evaluate(() => window.__ghost.session.send({ t: 'clear-all' }));   // a member forging it is ignored
  await C.waitForTimeout(600);
  assert(await C.locator('.msg').count() > 0, 'a member can\'t clear other screens');
  await B.click('#panelClose');
  await A.click('#panelBtn'); await A.click('#clearAllBtn'); await A.click('#dialogOk');
  for (const p of [B, C]) {
    await p.waitForSelector('.sys >> text=cleared the chat for everyone', { timeout: 8000 });
    await p.waitForFunction(() => document.querySelectorAll('.msg').length === 0, null, { timeout: 5000 });
  }
  assert(await A.locator('.msg').count() === 0, 'host\'s screen cleared too');
  await A.click('#panelClose');
});

await test('groups: a member reusing someone else\'s message ID can\'t hide, replace or edit their message', async () => {
  const { A, B, C } = G3;
  const mid = 'abcdef0123456789';
  const has = (p, t) => p.waitForFunction((x) => [...document.querySelectorAll('.msg.them .bubble span:not(.quote)')].some((b) => b.textContent === x), t, { timeout: 8000 });
  const gone = (p, t) => p.waitForFunction((x) => ![...document.querySelectorAll('.msg.them .bubble span:not(.quote)')].some((b) => b.textContent === x), t, { timeout: 8000 });
  // Cat claims the ID at Ann's first; then Ben's real message with the same ID arrives.
  await C.evaluate((m) => { const s = window.__ghost.session; s.sendTo(s.hostId, { t: 'msg', mid: m, text: 'squatter' }); }, mid);
  await has(A, 'squatter');
  await B.evaluate((m) => window.__ghost.session.send({ t: 'msg', mid: m, text: 'the real one' }), mid);
  await has(A, 'the real one');
  assert(await A.locator('.msg.them .bubble', { hasText: 'squatter' }).count() === 1, 'both shown, each under its own author');
  // An edit naming that ID changes only the sender's own message: Cat's edit hits Cat's.
  await C.evaluate((m) => { const s = window.__ghost.session; s.sendTo(s.hostId, { t: 'edit', target: m, text: 'cat edited' }); }, mid);
  await has(A, 'cat edited');
  await has(A, 'the real one');
  await B.evaluate((m) => window.__ghost.session.send({ t: 'edit', target: m, text: 'the real one, edited' }), mid);
  await has(A, 'the real one, edited');
  await has(A, 'cat edited');
  // Each can unsend only their own.
  await C.evaluate((m) => { const s = window.__ghost.session; s.sendTo(s.hostId, { t: 'unsend', target: m }); }, mid);
  await gone(A, 'cat edited');
  await has(A, 'the real one, edited');
  await B.evaluate((m) => window.__ghost.session.send({ t: 'unsend', target: m }), mid);
  await gone(A, 'the real one, edited');
});

await test('groups: the host decides who may invite, and can remove someone', async () => {
  const { A, B, C } = G3;
  await C.click('#panelBtn');
  assert(await C.isHidden('#qaInvite'), 'invite hidden for members by default');
  await A.click('#panelBtn');
  await A.click('label:has(#optCanInvite)');
  await C.waitForSelector('#qaInvite', { state: 'visible', timeout: 8000 });
  await C.click('#qaInvite');
  await C.waitForSelector('#inviteSheet:not([hidden])');
  assert(/Ann \(the host\) decides/.test(await C.textContent('#invNote')), await C.textContent('#invNote'));
  await C.click('#inviteSheet [data-close-sheet]');
  await A.click('.pp-row:has-text("Cat") .pp-btn.is-danger');
  await A.click('#dialogOk');
  await C.waitForSelector('.sys.is-bad >> text=The host removed you', { timeout: 10000 });
  await B.waitForSelector('.sys >> text=The host removed Cat', { timeout: 10000 });
  await B.waitForFunction(() => window.__ghost.session.readyIds().length === 1, null, { timeout: 8000 });
  await say(A, 'just us two');
  await B.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent === 'just us two', null, { timeout: 8000 });
  assert(await C.locator('.msg.them .bubble', { hasText: 'just us two' }).count() === 0, 'removed member gets nothing new');
  for (const p of [A, B, C]) await p.context().close();
});

await test('privacy preset: Maximum turns on relay + constant-rate, Customize reports a custom mix', async () => {
  const P = await page('Preset');
  await P.click('.home-panel .priv-chip');
  await P.click('label:has(input[value="max"])');
  assert(await P.isChecked('#relayOnly') && await P.isChecked('#shapeInit'), 'max enables both');
  assert(/relay/.test(await P.textContent('#privacyNote')), 'note explains max');
  await P.click('.privacy summary');
  await P.click('label:has(#relayOnly)');
  assert(/Custom: constant-rate traffic/.test(await P.textContent('#privacyNote')), await P.textContent('#privacyNote'));
  assert(await P.isChecked('input[name="privacy"][value="standard"]'), 'falls back to standard radio');
  await P.click('#privDone');
  assert(/Custom/.test(await P.textContent('.home-panel .priv-chip')), 'chip shows the custom level');
  await P.context().close();
});

await test('phone layout: action sheet, swipe-to-reply, session bottom sheet, no sideways scroll', async () => {
  const A = await page('Desk');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const B = await ctx.newPage();
  B.on('pageerror', (e) => problems.push('Phone: page error: ' + e.message));
  await B.goto(BASE);
  const code = await host(A, 'Desk');
  await join(B, code, 'Phone');
  await B.waitForSelector('#chat.is-on', { timeout: 20000 });
  await say(A, 'swipe me');
  await B.waitForSelector('.msg.them .bubble');
  const bubble = B.locator('.msg.them .bubble').last();
  const box = await bubble.boundingBox();
  // long-press → action sheet
  await bubble.dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: box.x + 20, clientY: box.y + 10 }] });
  await B.waitForTimeout(650);
  await bubble.dispatchEvent('touchend', { touches: [] });
  assert(await B.locator('#msgMenu.as-sheet:not([hidden])').count() === 1, 'action sheet opened');
  assert(await B.isVisible('#scrim'), 'scrim shown');
  await B.click('#scrim');
  assert(await B.isHidden('#msgMenu'), 'sheet closed by scrim');
  // swipe right → reply
  await B.evaluate(({ x, y }) => {
    const el = [...document.querySelectorAll('.msg.them .bubble')].pop();
    const t = (cx) => new Touch({ identifier: 2, target: el, clientX: cx, clientY: y });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [t(x)], bubbles: true }));
    for (let i = 1; i <= 8; i++) el.dispatchEvent(new TouchEvent('touchmove', { touches: [t(x + i * 11)], bubbles: true }));
    el.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
  }, { x: box.x + 20, y: box.y + 10 });
  assert(await B.isVisible('#replyBar'), 'swipe opened reply');
  // session sheet
  await B.click('#panelBtn');
  await B.waitForTimeout(450); // sheet slide-in
  const pb = await B.locator('#panel').boundingBox();
  assert(pb.y > 60 && Math.abs(pb.y + pb.height - 844) < 2, `panel docks to the bottom as a sheet (${pb.y}+${pb.height})`);
  assert(await B.isVisible('#panicSheetBtn'), 'panic lives in the sheet on phones');
  await B.click('#markVerified', { timeout: 3000 });   // controls inside the sheet must be tappable above the scrim
  assert(await B.locator('#verifyChip.is-verified').count() === 1, 'sheet controls work');
  await B.click('#panelClose');
  // Panic sits in the phone header, but a tap only hints: wiping needs a short hold.
  assert(await B.isVisible('#panicBtn'), 'panic button in the phone header');
  await B.tap('#panicBtn');
  await B.waitForTimeout(250);
  assert(await B.locator('#chat.is-on').count() === 1, 'a tap does not wipe');
  assert((await B.textContent('#toast')).includes('Hold'), 'tap explains hold-to-wipe');
  const overflow = await B.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert(!overflow, 'no horizontal overflow');
  await A.context().close(); await ctx.close();
});

await test('phones: home, join, room and chat screens fit without scrolling or sideways overflow', async () => {
  const fits = (p) => p.evaluate(() => {
    const scr = document.querySelector('.screen.is-on');
    scr.scrollTop = 99999; const moved = scr.scrollTop; scr.scrollTop = 0;
    window.scrollTo(0, 99999); const win = window.scrollY; window.scrollTo(0, 0);
    return { id: scr.id, moved, win, wide: document.documentElement.scrollWidth > innerWidth };
  });
  const check = async (p, what) => { const r = await fits(p); assert(!r.moved && !r.win && !r.wide, `${what} (${r.id}) scrolls: ${JSON.stringify(r)}`); };
  for (const vp of [{ width: 360, height: 640 }, { width: 390, height: 664 }]) {
    const A = await page('Phone A', vp), B = await page('Phone B', vp);
    await check(A, 'home');
    await setName(A, 'Lol');   // a short name must not shrink the buttons
    const [cw, jw, vw] = await A.evaluate(() => [document.getElementById('createBtn').offsetWidth, document.getElementById('openJoinBtn').offsetWidth, innerWidth]);
    assert(cw === jw && cw >= vw - 48, `home buttons shrank with a short name: ${cw}/${jw} of ${vw}`);
    const code = await host(A, 'Ana');
    await check(A, 'room screen');
    await B.goto(BASE + '#' + code.replace(/\s+/g, '-'));
    await B.waitForSelector('#joinScreen.is-on');
    await check(B, 'join screen');
    await B.click('#joinBtn');
    await A.waitForSelector('#chat.is-on', { timeout: 20000 }); await B.waitForSelector('#chat.is-on', { timeout: 20000 });
    await say(A, 'hello phone ' + 'x'.repeat(300));
    await B.focus('#input'); await B.fill('#input', 'typing');
    await check(B, 'chat while typing');
    await A.context().close(); await B.context().close();
  }
});

await test('colour themes: every theme applies, Auto follows the device, nothing is stored', async () => {
  const P = await page('Themes');
  assert(!(await P.evaluate(() => document.documentElement.dataset.theme)), 'starts on Auto');
  await P.click('#themeBtn');
  await P.waitForSelector('#themeSheet:not([hidden])');
  const ids = await P.$$eval('#themeSheet [data-theme-picker] button', (bs) => bs.map((b) => b.dataset.t));
  assert(ids.length === 8 && ids[0] === 'auto', 'eight choices: ' + ids.join(','));
  const seen = new Set();
  for (const id of ids.slice(1)) {
    await P.click(`#themeSheet [data-theme-picker] button[data-t="${id}"]`);
    const r = await P.evaluate(() => ({ t: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, meta: document.querySelector('meta[name="theme-color"]').content, on: document.querySelector('#themeSheet [aria-checked="true"]').dataset.t }));
    assert(r.t === id && r.on === id, 'applied ' + id);
    assert(r.meta && r.meta.startsWith('#'), 'browser bar colour follows ' + id);
    seen.add(r.bg);
  }
  assert(seen.size === 7, 'each theme has its own background: ' + seen.size);
  await P.click('#themeSheet [data-theme-picker] button[data-t="auto"]');
  assert(!(await P.evaluate(() => document.documentElement.dataset.theme)), 'back to Auto');
  // Text style: separate from colour; Auto follows the theme; theme names fit their tiles.
  await P.click('#themeSheet [data-theme-picker] button[data-t="daylight"]');
  assert(await P.evaluate(() => document.documentElement.dataset.type) === 'clean', 'Auto text follows Daylight');
  for (const ty of ['terminal', 'clean', 'mono']) {
    await P.click(`#themeSheet [data-type-picker] button[data-ty="${ty}"]`);
    const got = await P.evaluate(() => document.documentElement.dataset.type || 'terminal');
    assert(got === ty, 'text style ' + ty + ' → ' + got);
    const spill = await P.$$eval('#themeSheet .th-name', (ns) => ns.filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent));
    assert(!spill.length, 'theme names spill out in ' + ty + ': ' + spill.join(','));
  }
  await P.click('#themeSheet [data-type-picker] button[data-ty="auto"]');
  await P.click('#themeSheet [data-theme-picker] button[data-t="auto"]');
  const stored = await P.evaluate(() => ({ ls: localStorage.length, ss: sessionStorage.length, ck: document.cookie }));
  assert(stored.ls === 0 && stored.ss === 0 && !stored.ck, 'nothing stored: ' + JSON.stringify(stored));
  await P.context().close();
});

// ───────────────────────────── report ─────────────────────────────
await browser.close();
for (const p of procs) p.kill();
const unexpected = problems.filter((p) => !/protocol violation/.test(p) && !/connect(?:ing)? to 'blob:|cannot load blob:/i.test(p) && !/page error: framed/.test(p));
console.log(`\n${passed} passed, ${failed} failed`);
if (unexpected.length) { console.log('\nBrowser problems:'); for (const p of [...new Set(unexpected)]) console.log('  ' + p); }
process.exit(failed || unexpected.length ? 1 : 0);
