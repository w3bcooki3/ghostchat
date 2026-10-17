// Protocol unit tests (Node >= 20): node --test tests/protocol.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/protocol.js';
import { parseTurn } from '../js/session.js';

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
