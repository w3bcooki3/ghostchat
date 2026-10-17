// End-to-end tests: real Chromium, real WebRTC, a local PeerJS signaling server.
// Separate browser contexts behave like separate browsers (or a normal + an incognito window);
// two pages in ONE context behave like two incognito windows (they share a session).
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServers } from './serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const T = (name, fn) => results.push({ name, fn });
const assert = (c, m) => { if (!c) throw new Error(m); };

const live = await startServers();
const dead = await startServers({ deadSignal: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

async function page(ctx) {
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  return p;
}
const state = (p) => p.evaluate(() => window.__ghost?.session?.state);
async function host(p, url, { relayOnly = false } = {}) {
  await p.goto(url);
  if (relayOnly) await p.evaluate(() => { document.getElementById('relayOnly').checked = true; });
  await p.click('#createBtn');
  await p.waitForFunction(() => window.__ghost?.session?.code);
  return p.evaluate(() => window.__ghost.session.code);
}
async function join(p, url, code, opts = {}) {
  await p.goto(url + '#' + code);
  if (opts.relayOnly) await p.evaluate(() => { document.getElementById('relayOnly').checked = true; });
  await p.click('#joinBtn');
}
const inChat = (p, t = 20000) => p.waitForSelector('#chat.is-on', { timeout: t });
async function say(from, to, text) {
  await from.fill('#input', text);
  await from.click('#sendBtn');
  await to.waitForFunction((t) => [...document.querySelectorAll('.msg.them .bubble')].some((b) => b.textContent.includes(t)), text, { timeout: 10000 });
}
const route = (p) => p.evaluate(() => window.__ghost.session.getRoute());
async function pair(ctxA, ctxB, url) {
  const A = await page(ctxA), B = await page(ctxB);
  const code = await host(A, url);
  await join(B, url, code);
  await Promise.all([inChat(A), inChat(B)]);
  return { A, B, code };
}
const fresh = () => browser.newContext();

T('two separate browsers connect over WebRTC and exchange messages', async () => {
  const a = await fresh(), b = await fresh();
  const { A, B } = await pair(a, b, live.url);
  await say(A, B, 'hello from A <img src=x onerror=alert(1)>');
  await say(B, A, 'hello back from B');
  assert(await A.evaluate(() => !document.querySelector('.msg img[src="x"]')), 'peer text was parsed as HTML');
  assert(['direct', 'local'].includes(await route(B)), 'expected a WebRTC route, got ' + await route(B));
  assert(!A.errors.length && !B.errors.length, 'page errors: ' + [...A.errors, ...B.errors].join('; '));
  await a.close(); await b.close();
});

T('two windows of one browser profile (like two incognito windows) connect with NO signaling server', async () => {
  const ctx = await fresh();
  const A = await page(ctx), B = await page(ctx);
  const code = await host(A, dead.url);
  await A.waitForFunction(() => /only another window/i.test(document.getElementById('peerStepText').textContent), null, { timeout: 15000 });
  await join(B, dead.url, code);
  await Promise.all([inChat(A), inChat(B)]);
  await say(A, B, 'offline hello');
  await say(B, A, 'offline reply');
  assert(await route(A) === 'device' && await route(B) === 'device', 'route should be device');
  assert(await B.textContent('#routeChip') === 'This device', 'route chip not shown');
  await ctx.close();
});

T('same profile with signaling up: connects over the same-device link', async () => {
  const ctx = await fresh();
  const { A, B } = await pair(ctx, ctx, live.url);
  await say(B, A, 'quick');
  assert(await route(B) === 'device', 'expected same-device route');
  await ctx.close();
});

T('a code that names the room but differs in the secret part is refused (auth-failed)', async () => {
  const a = await fresh(), b = await fresh();
  const A = await page(a), B = await page(b);
  const code = await host(A, live.url);
  const c = code.split('-'); c[3] = c[3] === 'AAAAA' ? 'BBBBB' : 'AAAAA';
  await join(B, live.url, c.join('-'));
  await B.waitForFunction(() => window.__ghost.session.state === 'failed', null, { timeout: 20000 });
  assert(/didn't accept this code/.test(await B.textContent('#connectErrorText')), 'wrong error text');
  assert(await state(A) === 'waiting', 'host should still be waiting');
  await a.close(); await b.close();
});

T('wrong code in the same profile is refused too (same-device link is authenticated)', async () => {
  const ctx = await fresh();
  const A = await page(ctx), B = await page(ctx);
  const code = await host(A, dead.url);
  const c = code.split('-'); c[2] = c[2] === 'CCCCC' ? 'DDDDD' : 'CCCCC';
  await join(B, dead.url, c.join('-'));
  await B.waitForFunction(() => window.__ghost.session.state === 'failed', null, { timeout: 15000 });
  assert(/didn't accept this code/.test(await B.textContent('#connectErrorText')), 'wrong error: ' + await B.textContent('#connectErrorText'));
  await ctx.close();
});

T('room locks after the first join: a third browser with the right code is refused', async () => {
  const a = await fresh(), b = await fresh(), c = await fresh();
  const { A, code } = await pair(a, b, live.url);
  const C = await page(c);
  await join(C, live.url, code);
  await C.waitForFunction(() => window.__ghost.session.state === 'failed', null, { timeout: 20000 });
  assert(/locked/.test(await C.textContent('#connectErrorText')), 'third party not told it is locked');
  await A.waitForFunction(() => /refused/.test(document.getElementById('messages').textContent), null, { timeout: 5000 });
  await a.close(); await b.close(); await c.close();
});

T('a dropped same-device link reconnects and keeps the safety number (resume)', async () => {
  const ctx = await fresh();
  const { A, B } = await pair(ctx, ctx, dead.url);
  const sn = await A.evaluate(() => window.__ghost.session.safetyNumber);
  await B.evaluate(() => window.__ghost.session.active.conn.close());
  await A.waitForFunction(() => window.__ghost.session.state === 'reconnecting', null, { timeout: 5000 });
  await A.waitForFunction(() => window.__ghost.session.state === 'ready', null, { timeout: 20000 });
  assert(await A.evaluate(() => window.__ghost.session.safetyNumber) === sn, 'safety number changed after resume');
  await say(A, B, 'after reconnect');
  await ctx.close();
});

T('relay-only with no relay fails with a specific diagnosis, not a generic error', async () => {
  const a = await fresh(), b = await fresh();
  const A = await page(a), B = await page(b);
  const code = await host(A, live.url, { relayOnly: true });
  await join(B, live.url, code, { relayOnly: true });
  await B.waitForFunction(() => window.__ghost.session.state === 'failed', null, { timeout: 30000 });
  const t = await B.textContent('#connectErrorText');
  assert(/needs a relay server/.test(t), 'diagnosis missing: ' + t);
  assert(await B.isVisible('#netCheckBtn'), 'network check button hidden');
  await B.click('#netCheckBtn');
  await B.waitForFunction(() => document.querySelector('#netResult dl'), null, { timeout: 15000 });
  await a.close(); await b.close();
});

T('files transfer byte-exact over WebRTC and over the same-device link', async () => {
  for (const sameProfile of [false, true]) {
    const a = await fresh(), b = sameProfile ? a : await fresh();
    const { A, B } = await pair(a, b, live.url);
    const size = 3 * 1024 * 1024 + 123;
    const digest = await A.evaluate(async (n) => {
      const buf = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(buf.subarray(i, Math.min(n, i + 65536)));
      const f = new File([buf], 'blob.bin', { type: 'application/octet-stream' });
      window.__sent = f; window.__ghost.session.sendFile(f);
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).join(',');
    }, size);
    await B.waitForFunction(() => Object.keys(window.__ghost.files).length > 0, null, { timeout: 30000 });
    const got = await B.evaluate(async () => {
      const blob = Object.values(window.__ghost.files)[0];
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))).join(',');
    });
    assert(got === digest, `file corrupted (sameProfile=${sameProfile})`);
    await a.close(); if (b !== a) await b.close();
  }
});

T('200 messages arrive in order', async () => {
  const a = await fresh(), b = await fresh();
  const { A, B } = await pair(a, b, live.url);
  await A.evaluate(() => { for (let i = 0; i < 200; i++) window.__ghost.session.send({ t: 'msg', text: 'm' + i }); });
  await B.waitForFunction(() => document.querySelectorAll('.msg.them .bubble').length >= 200, null, { timeout: 30000 });
  const order = await B.evaluate(() => [...document.querySelectorAll('.msg.them .bubble')].map((b) => b.textContent.trim()));
  assert(order.every((t, i) => t === 'm' + i), 'messages out of order');
  await a.close(); await b.close();
});

T('index.html opened from disk shows a clear explanation; dist/ghostchat.html works from disk', async () => {
  execFileSync(process.execPath, [path.join(root, 'tools/build.mjs')], { stdio: 'ignore' });
  const ctx = await fresh();
  const p = await page(ctx);
  await p.goto(pathToFileURL(path.join(root, 'index.html')).href);
  await p.waitForSelector('.boot-fail', { state: 'visible', timeout: 6000 });
  await p.goto(pathToFileURL(path.join(root, 'dist/ghostchat.html')).href);
  await p.waitForFunction(() => document.documentElement.classList.contains('booted'), null, { timeout: 6000 });
  assert(!(await p.isVisible('.boot-fail')), 'boot warning shown in the working build');
  await ctx.close();
});

T('motion UI is wired to real data: handshake seal, live ciphertext, key counter, QR, docked panel', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const A = await page(ctx), B = await page(ctx);
  const code = await host(A, dead.url);
  await A.click('#qrBtn');
  const qr = await A.evaluate(() => { const p = document.querySelector('#qrBox svg path'); return p ? p.getAttribute('d').length : 0; });
  assert(qr > 500, 'QR not rendered');
  await join(B, dead.url, code);
  await A.waitForFunction(() => document.getElementById('hsStage').classList.contains('is-sealed'), null, { timeout: 15000 });
  await Promise.all([inChat(A), inChat(B)]);
  const [shown, real] = await A.evaluate(() => [document.getElementById('hsSn').textContent.replace(/\s+/g, ' ').trim(), window.__ghost.session.safetyNumber.split(' ').slice(0, 6).join(' ')]);
  assert(shown === real, `stage showed "${shown}", real safety number starts "${real}"`);
  await say(A, B, 'ether check');
  await B.waitForFunction(() => /^[0-9a-f]{4} /.test(document.getElementById('etherIn').textContent), null, { timeout: 5000 });
  assert(+(await A.textContent('#kvKeys')) > 0, 'message key counter not updating');
  assert(!(await A.evaluate(() => document.getElementById('panel').hidden)), 'session panel should be docked on a wide screen');
  await say(B, A, 'decrypts into place');
  await A.waitForFunction(() => [...document.querySelectorAll('.msg.them .bubble')].some((b) => b.textContent === 'decrypts into place'), null, { timeout: 3000 });
  await ctx.close();
});

T('reduced motion: everything readable immediately, connection still works', async () => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const A = await page(ctx), B = await page(ctx);
  await A.goto(dead.url);
  const [line, goneOpacity] = await A.evaluate(() => [document.getElementById('headLine').textContent, getComputedStyle(document.querySelector('.hl-2')).opacity]);
  assert(line === 'Say it once.' && goneOpacity === '1', `headline not static: "${line}" opacity ${goneOpacity}`);
  await A.click('#createBtn');
  await A.waitForFunction(() => window.__ghost?.session?.code);
  const code = await A.evaluate(() => window.__ghost.session.code);
  await join(B, dead.url, code);
  await Promise.all([inChat(A, 8000), inChat(B, 8000)]);
  await say(A, B, 'calm');
  await ctx.close();
});

let failed = 0;
for (const { name, fn } of results) {
  const t0 = Date.now();
  try { await fn(); console.log(`  ok   ${name} (${Date.now() - t0} ms)`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`); }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close(); live.close(); dead.close();
process.exit(failed ? 1 : 0);
