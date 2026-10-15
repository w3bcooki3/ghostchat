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

async function page(name, viewport = { width: 1200, height: 800 }) {
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

await test('images render inline only for sniffed raster types; SVG and spoofed MIME do not', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await S.A.setInputFiles('#fileInput', { name: 'dot.png', mimeType: 'image/png', buffer: png });
  await S.B.waitForSelector('.msg.them .img-wrap img', { timeout: 10000 });
  const src = await S.B.getAttribute('.msg.them .img-wrap img', 'src');
  assert(src.startsWith('blob:'), 'image should be a blob URL');
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
    return { pwned: window.__pwned, fetchBlocked, inlineImgs: document.querySelectorAll('.msg.them .img-wrap').length };
  });
  assert(t.pwned === undefined, 'script ran');
  assert(t.fetchBlocked, 'CSP should block fetch of blob URLs');
  assert(t.inlineImgs === 1, 'only the PNG should be inline, got ' + t.inlineImgs);
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
  assert(/locked/.test(msg), 'a locked room refuses before even checking the code: ' + msg);
  await S.A.waitForSelector('.sys.is-warn >> text=locked to the two of you', { timeout: 5000 });
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

await test('room locks once both people are in: a full, correct code is refused afterwards', async () => {
  const M = await page('Leaker');
  await join(M, S.code, 'Leaker');
  await M.waitForSelector('#connectError:not([hidden])', { timeout: 20000 });
  assert(/locked/.test(await M.textContent('#connectErrorText')), 'joiner told the room is locked: ' + await M.textContent('#connectErrorText'));
  await S.A.waitForSelector('.sys.is-warn >> text=locked to the two of you', { timeout: 5000 });
  await say(S.A, 'still just us');
  await S.B.waitForFunction(() => document.querySelector('.msg.them:last-child .bubble')?.textContent === 'still just us', null, { timeout: 5000 });
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
  await S.B.click('#panelBtn'); await S.B.click('label:has(#optShape)'); await S.B.click('#panelClose');
  await S.A.waitForSelector('.sys >> text=turned off constant-rate', { timeout: 5000 });
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

await test('joining a room that does not exist explains what happened', async () => {
  const P = await page('Lonely');
  await join(P, 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', 'Lonely');
  await P.waitForSelector('#connectError:not([hidden])', { timeout: 20000 });
  assert(/No room with this code/.test(await P.textContent('#connectErrorText')), 'message');
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

await test('host can unlock once for a peer who reloaded; the new safety number must be re-verified', async () => {
  const s = await pair('Host', 'Guest');
  const sn0 = await s.A.getAttribute('#safetyNumber', 'data-value');
  await s.B.context().close();                                  // guest "reloads": its keys are gone
  await s.A.waitForSelector('#banner:not([hidden])', { timeout: 15000 });
  const G = await page('Guest again');
  await join(G, s.code, 'Guest');
  await G.waitForSelector('#connectError:not([hidden])', { timeout: 20000 });
  await s.A.waitForSelector('#banner button >> text=Unlock room once', { timeout: 5000 });
  await s.A.click('#banner button');
  assert(/Anyone holding the room code/.test(await s.A.textContent('#dialogBody')), 'unlock warns before acting');
  await s.A.click('#dialogOk');
  await G.click('#retryBtn');
  await G.waitForSelector('#chat.is-on', { timeout: 20000 });
  await s.A.waitForSelector('.sys.is-warn >> text=new browser joined', { timeout: 10000 });
  const sn1 = await s.A.getAttribute('#safetyNumber', 'data-value');
  assert(sn1 !== sn0 && sn1 === await G.getAttribute('#safetyNumber', 'data-value'), 'fresh, matching safety number');
  await s.A.context().close(); await G.context().close();
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
  assert(await B.isHidden('#panicBtn'), 'no panic button in the phone header');
  const overflow = await B.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert(!overflow, 'no horizontal overflow');
  await A.context().close(); await ctx.close();
});

// ───────────────────────────── report ─────────────────────────────
await browser.close();
for (const p of procs) p.kill();
const unexpected = problems.filter((p) => !/protocol violation/.test(p) && !/connect to 'blob:|cannot load blob:/.test(p) && !/page error: framed/.test(p));
console.log(`\n${passed} passed, ${failed} failed`);
if (unexpected.length) { console.log('\nBrowser problems:'); for (const p of [...new Set(unexpected)]) console.log('  ' + p); }
process.exit(failed || unexpected.length ? 1 : 0);
