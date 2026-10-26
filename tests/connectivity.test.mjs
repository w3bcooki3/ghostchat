// Protocol unit tests (Node >= 20): node --test tests/protocol.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/protocol.js';
import { parseTurn } from '../js/session.js';
import { restCredential, sanitizeIce, resolveIce } from '../js/ice.js';
import { createHmac } from 'node:crypto';

async function handshake(code, joinerCode = code, { policy, resumeSecret } = {}) {
  const host = new P.Handshake('host', await P.deriveRoomKey(code), { policy });
  const joiner = new P.Handshake('joiner', await P.deriveRoomKey(joinerCode), { resumeSecret });
  const r1 = await host.receive(await joiner.start());
  const r2 = await joiner.receive(r1.send);
  const r3 = await host.receive(r2.send);
  return { h: r3.done, j: r2.done };
}

test('codes: 20 chars of the 32-symbol alphabet, normalized from links and messy input', () => {
  const c = P.generateCode();
  assert.match(c, /^([A-HJ-NP-Z2-9]{5}-){3}[A-HJ-NP-Z2-9]{5}$/);
  assert.equal(P.normalizeCode('https://x.test/#' + c.toLowerCase().replace(/-/g, ' ')), c);
  assert.equal(P.normalizeCode('ABCDE-FGHJK-LMNPQ-RSTU0'), null); // 0 is not in the alphabet
  assert.equal(P.normalizeCode('short'), null);
  assert.equal(P.roomIdFromCode(c), 'ghostchat-v3-' + c.slice(0, 5).toLowerCase());
});

test('handshake: both sides derive matching keys and the same safety number', async () => {
  const code = P.generateCode();
  const { h, j } = await handshake(code);
  assert.deepEqual(h.send, j.recv); assert.deepEqual(h.recv, j.send);
  assert.equal(h.safetyNumber, j.safetyNumber);
  assert.match(h.safetyNumber, /^(\d{5} ){11}\d{5}$/);
  assert.deepEqual(h.resumeSecret, j.resumeSecret);
});

test('handshake: a different code with the same room prefix fails authentication', async () => {
  const code = P.generateCode();
  const other = code.slice(0, 6) + (code[6] === 'A' ? 'B' : 'A') + code.slice(7);
  await assert.rejects(handshake(code, other), (e) => e.code === 'auth-failed');
});

test('lock: a locked host refuses first joins; a resume with the right secret gets in', async () => {
  const code = P.generateCode();
  const { h } = await handshake(code);
  const policy = () => ({ locked: true, secrets: [{ secret: h.resumeSecret.slice(), continuity: true }] });
  await assert.rejects(handshake(code, code, { policy }), (e) => e.code === 'locked');
  const r = await handshake(code, code, { policy, resumeSecret: h.resumeSecret });
  assert.equal(r.h.resumed, true); assert.equal(r.j.resumed, true);
  const bad = crypto.getRandomValues(new Uint8Array(48));
  await assert.rejects(handshake(code, code, { policy, resumeSecret: bad }), (e) => e.code === 'auth-failed');
});

test('channel: round-trips, pads to buckets, and rejects tamper / replay / reorder', async () => {
  const { h, j } = await handshake(P.generateCode());
  const tx = new P.SecureChannel(h), rx = new P.SecureChannel(j);
  const f1 = await tx.sealJSON({ t: 'msg', text: 'hi' });
  assert.equal(f1.length, 6 + 12 + 256 + 16);
  assert.equal(P.decodeJSON((await rx.open(f1)).payload).text, 'hi');
  await assert.rejects(rx.open(f1), (e) => e.code === 'sequence'); // replay kills the channel
  const { h: h3, j: j3 } = await handshake(P.generateCode());
  const a = new P.SecureChannel(h3), b = new P.SecureChannel(j3);
  const g = await a.sealJSON({ t: 'x' }); g[g.length - 1] ^= 1;
  await assert.rejects(b.open(g), (e) => e.code === 'auth');
});

test('channel: out-of-order frames are rejected', async () => {
  const { h, j } = await handshake(P.generateCode());
  const a = new P.SecureChannel(h), b = new P.SecureChannel(j);
  await a.sealJSON({ t: '1' }); const f2 = await a.sealJSON({ t: '2' });
  await assert.rejects(b.open(f2), (e) => e.code === 'sequence');
});

test('padding: buckets and limits', () => {
  assert.equal(P.pad(1, new Uint8Array(10)).length, 256);
  assert.equal(P.pad(1, new Uint8Array(10), 4096).length, 4096);
  assert.throws(() => P.pad(1, new Uint8Array(P.MAX_PLAINTEXT + 1)), (e) => e.code === 'too-large');
  const u = P.unpad(P.pad(2, Uint8Array.of(1, 2, 3)));
  assert.equal(u.kind, 2); assert.deepEqual(u.payload, Uint8Array.of(1, 2, 3));
});

test('custom TURN relay input is validated', () => {
  assert.deepEqual(parseTurn('turn:relay.example.org:3478', 'u', 'p'), { urls: ['turn:relay.example.org:3478'], username: 'u', credential: 'p' });
  assert.deepEqual(parseTurn('turns:r.example.org:443?transport=tcp turn:r.example.org:3478', 'u', 'p').urls.length, 2);
  assert.throws(() => parseTurn('https://evil.example', 'u', 'p'));
  assert.throws(() => parseTurn('turn:x.example:3478', '', ''));
  assert.throws(() => parseTurn('turn:x.example:3478"><script>', 'u', 'p'));
});

test('TURN REST credentials match the standard HMAC-SHA1 scheme', async () => {
  const { username, credential } = await restCredential('openrelayprojectsecret', 'ghostchat', 3600);
  assert.match(username, /^\d{10}:ghostchat$/);
  assert.ok(+username.split(':')[0] > Date.now() / 1000 + 3500);
  assert.equal(credential, createHmac('sha1', 'openrelayprojectsecret').update(username).digest('base64'));
});

test('ICE servers from an endpoint are sanitized', () => {
  const out = sanitizeIce([
    { urls: ['turn:a.example:3478', 'turn:a.example:53', 'javascript:alert(1)'], username: 'u', credential: 'p' },
    { urls: 'turn:b.example:3478' },                 // TURN without credentials: dropped
    { urls: 'stun:c.example:3478' },
    'junk', null,
  ]);
  assert.deepEqual(out, [{ urls: ['turn:a.example:3478'], username: 'u', credential: 'p' }, { urls: ['stun:c.example:3478'] }]);
});

test('default ICE is STUN only: no third-party TURN unless configured', async () => {
  const ice = await resolveIce();
  const urls = ice.flatMap((s) => [].concat(s.urls));
  assert.ok(urls.some((u) => u.startsWith('stun:')));
  assert.ok(!urls.some((u) => /^turns?:/.test(u)), 'no TURN by default: ' + urls.join(' '));
  const custom = { urls: 'turns:relay.example:443?transport=tcp', username: 'u', credential: 'p' };
  assert.ok((await resolveIce([custom])).includes(custom), 'a relay the person adds is still used');
});

import { cleanLabel, cleanName, cleanText, fileRisk, safeFilename, parseLink, sniffKind } from '../js/ui/sanitize.js';

test('text and names lose bidi overrides and control characters', () => {
  assert.equal(cleanLabel('photo‮gpj.exe', 60), 'photogpj.exe');
  assert.equal(cleanText('see https://bank.example‮/moc.live⁦x⁩', 100), 'see https://bank.example/moc.livex');
  assert.equal(cleanText('line one\nline two\ttab', 100), 'line one\nline two\ttab');
  assert.equal(cleanText('a\u0000b\u0007c', 10), 'abc');
});

test('risky files are recognised by name and by content', () => {
  assert.ok(fileRisk('setup.exe').risky);
  assert.ok(fileRisk('invoice.pdf.exe').risky);
  assert.ok(fileRisk('page.HTML').risky);
  assert.ok(fileRisk('logo.svg').risky);
  assert.ok(fileRisk('holiday.jpg', Uint8Array.of(0x4d, 0x5a, 0x90, 0)).risky, 'PE executable named .jpg');
  assert.ok(fileRisk('notes.txt', new TextEncoder().encode('#!/bin/sh\nrm -rf ~')).risky, 'script named .txt');
  assert.ok(fileRisk('report.pdf          .bat').risky);
  assert.equal(fileRisk('photo.jpg', Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)).risky, false);
  assert.equal(fileRisk('report.pdf', new TextEncoder().encode('%PDF-1.7')).risky, false);
  assert.equal(sniffKind(new TextEncoder().encode('%PDF-1.7')), 'pdf');
});

test('download names are safe', () => {
  assert.equal(safeFilename('../../etc/passwd'), '_._etc_passwd');
  assert.equal(safeFilename('a:b*c?.txt'), 'a_b_c_.txt');
  assert.equal(safeFilename('...hidden'), 'hidden');
  assert.equal(safeFilename('CON.txt'), '_CON.txt');
  assert.equal(safeFilename('‮'), 'file');
});

test('only http(s) links are links, and hosts come out in ASCII', () => {
  assert.equal(parseLink('javascript:alert(1)'), null);
  assert.equal(parseLink('data:text/html,x'), null);
  assert.equal(parseLink('https://exämple.com/').hostname, 'xn--exmple-cua.com');
});

test('the risk check judges the name that will be saved: trailing dots and spaces can\'t hide .bat', () => {
  for (const n of ['invoice.pdf.bat.', 'x.exe. . .', 'run.ps1.', 'a.hta..', 'setup.EXE ']) {
    assert.ok(fileRisk(safeFilename(n)).risky, n + ' (saved name)');
    assert.ok(fileRisk(n).risky, n + ' (raw name)');
  }
  for (const n of ['notes.chm', 'tool.py', 'add.xll', 'app.jnlp', 'x.desktop', 'doc.one']) assert.ok(fileRisk(n).risky, n);
  assert.ok(!fileRisk('holiday.jpg').risky);
});

test('names from others: no posing as you or the host, no blank or invisible names', () => {
  for (const n of ['You', 'you', ' YOU ', 'Ｙｏｕ', 'The host', 'host', 'Ghost Chat', 'Someone', 'You (host)']) assert.equal(cleanName(n), '', n);
  for (const n of ['\u3164', '\u2800\u2800', '\u00ad', '\u2060\u2061', '\u{E0041}\u{E0042}', '...', '  ']) assert.equal(cleanName(n), '', JSON.stringify(n));
  assert.equal(cleanName('Bob\u2060by'), 'Bobby');
  assert.equal(cleanName('Mira'), 'Mira');
  assert.equal(cleanName('Yousef'), 'Yousef');
  assert.equal(cleanName('Ann ❤'), 'Ann ❤');
});
