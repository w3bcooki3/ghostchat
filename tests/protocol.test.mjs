// Unit tests for the wire protocol (v3). Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/protocol.js';

/** Host policy helper: evaluated when the HELLO arrives; returns copies like the session does. */
const policy = (state) => ({ policy: () => ({ locked: !!state.locked, secrets: (state.secrets || []).map((x) => (x instanceof Uint8Array ? { secret: x.slice(), continuity: true } : { secret: x.secret.slice(), continuity: x.continuity })) }) });
/** Runs a full handshake. hostOpts/joinOpts are passed to the Handshake constructors. */
async function pair(codeH, codeJ = codeH, hostOpts = {}, joinOpts = {}) {
  const host = new P.Handshake('host', await P.deriveRoomKey(codeH), hostOpts);
  const join = new P.Handshake('joiner', await P.deriveRoomKey(codeJ), joinOpts);
  const m1 = await join.start();
  const r1 = await host.receive(m1);
  const r2 = await join.receive(r1.send);
  const r3 = await host.receive(r2.send);
  return { host: r3.done, join: r2.done, frames: [m1, r1.send, r2.send], hs: { host, join } };
}
const flip = (u8, i) => { const c = u8.slice(); c[i] ^= 1; return c; };

test('room codes: format, alphabet, normalization', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = P.generateCode();
    assert.match(c, /^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/);
    seen.add(c);
  }
  assert.equal(seen.size, 2000);
  const c = P.generateCode();
  assert.equal(P.normalizeCode(c.toLowerCase().replace(/-/g, ' ')), c);
  assert.equal(P.normalizeCode('https://x.example/ghost/#' + c), c);
  assert.equal(P.normalizeCode(c.replace(/-/g, '')), c);
  assert.equal(P.normalizeCode('ABCDE-FGHIJ-KLMNO-PQRST'), null, 'I and O are not in the alphabet');
  assert.equal(P.normalizeCode('ABCD'), null);
  assert.equal(P.normalizeCode(42), null);
  assert.match(P.roomIdFromCode(c), /^ghostchat-v3-[a-z2-9]{5}$/);
});

test('alphabet distribution is unbiased (chi-square sanity)', () => {
  const counts = new Map();
  const N = 4000;
  for (let i = 0; i < N; i++) for (const ch of P.generateCode().replace(/-/g, '')) counts.set(ch, (counts.get(ch) || 0) + 1);
  assert.equal(counts.size, 32);
  const exp = (N * 20) / 32;
  let chi = 0; for (const v of counts.values()) chi += (v - exp) ** 2 / exp;
  assert.ok(chi < 70, 'chi-square ' + chi);
});

test('hybrid handshake succeeds; both sides agree on keys and safety number', async () => {
  const { host, join, frames } = await pair(P.generateCode());
  assert.equal(host.safetyNumber, join.safetyNumber);
  assert.match(host.safetyNumber, /^(\d{5} ){11}\d{5}$/);
  assert.deepEqual(host.send, join.recv);
  assert.deepEqual(host.recv, join.send);
  assert.notDeepEqual(host.send, host.recv);
  assert.deepEqual(host.resumeSecret, join.resumeSecret);
  assert.equal(host.send.length, 48);
  assert.equal(frames[0].length, 3 + 1 + 8 + 32 + 97 + 1568, 'joiner hello carries key id + P-384 + ML-KEM-1024 keys');
  assert.equal(frames[1].length, 3 + 32 + 97 + 1568 + 48, 'host hello carries ML-KEM ciphertext + HMAC-SHA-384');
  assert.equal(host.resumed, false);
});

test('wrong code fails; same room id with different secret fails', async () => {
  await assert.rejects(pair(P.generateCode(), P.generateCode()), (e) => e.code === 'auth-failed');
  const a = P.generateCode();
  const b = a.slice(0, 6) + P.generateCode().slice(6);
  assert.equal(P.roomIdFromCode(a), P.roomIdFromCode(b));
  await assert.rejects(pair(a, b), (e) => e.code === 'auth-failed');
});

test('host rejects a forged confirm', async () => {
  const host = new P.Handshake('host', await P.deriveRoomKey(P.generateCode()));
  const attacker = new P.Handshake('joiner', await P.deriveRoomKey(P.generateCode()));
  await host.receive(await attacker.start());
  const forged = P.concat([P.MAGIC, P.T_CONFIRM], globalThis.crypto.getRandomValues(new Uint8Array(48)));
  await assert.rejects(host.receive(forged), (e) => e.code === 'auth-failed');
});

test('MITM substituting its own key shares cannot complete either side', async () => {
  const key = await P.deriveRoomKey(P.generateCode());
  const host = new P.Handshake('host', key);
  const join = new P.Handshake('joiner', key);
  const mitm = new P.Handshake('joiner', await P.deriveRoomKey(P.generateCode()));
  await join.start();
  const reply = await host.receive(await mitm.start());
  await assert.rejects(mitm.receive(reply.send), (e) => e.code === 'auth-failed');
  await assert.rejects(join.receive(reply.send), (e) => e.code === 'auth-failed');
});

test('tampering with any handshake field is detected', async () => {
  const code = P.generateCode();
  // ML-KEM ciphertext tampered → implicit rejection gives a different secret → MAC fails
  {
    const key = await P.deriveRoomKey(code);
    const host = new P.Handshake('host', key), join = new P.Handshake('joiner', key);
    const r1 = await host.receive(await join.start());
    await assert.rejects(join.receive(flip(r1.send, 3 + 32 + 97 + 100)), (e) => e.code === 'auth-failed');
    assert.equal(join.kem, null, 'failure wipes handshake state');
  }
  // ML-KEM public key tampered in transit → host derives with a different key → joiner rejects
  {
    const key = await P.deriveRoomKey(code);
    const host = new P.Handshake('host', key), join = new P.Handshake('joiner', key);
    const m1 = await join.start();
    const r1 = await host.receive(flip(m1, 3 + 1 + 8 + 32 + 97 + 500));
    await assert.rejects(join.receive(r1.send), (e) => e.code === 'auth-failed');
  }
  // nonce tampered
  {
    const key = await P.deriveRoomKey(code);
    const host = new P.Handshake('host', key), join = new P.Handshake('joiner', key);
    const r1 = await host.receive(flip(await join.start(), 3 + 1 + 8 + 5)); // inside nonceJ
    await assert.rejects(join.receive(r1.send), (e) => e.code === 'auth-failed');
  }
  // mode byte flipped (fresh → resume) is refused by a host with nothing to resume
  {
    const key = await P.deriveRoomKey(code);
    const host = new P.Handshake('host', key), join = new P.Handshake('joiner', key);
    await assert.rejects(host.receive(flip(await join.start(), 3)), (e) => e.code === 'auth-failed');
  }
});

test('malformed and invalid-curve keys are rejected', async () => {
  const key = await P.deriveRoomKey(P.generateCode());
  const bad = new Uint8Array(3 + 1 + 8 + 32 + 97 + 1568); bad.set([P.MAGIC, P.T_HELLO, 0x4a, 0]); bad[44] = 4; // point (0,0)
  await assert.rejects(new P.Handshake('host', key).receive(bad), (e) => e.code === 'bad-key');
  await assert.rejects(new P.Handshake('host', key).receive(new Uint8Array([P.MAGIC, P.T_HELLO, 0x4a, 0, 1])), (e) => e.code === 'bad-hello');
  await assert.rejects(new P.Handshake('host', key).receive(new Uint8Array([0, 0])), (e) => e.code === 'bad-frame');
  await assert.rejects(new P.Handshake('host', key).receive(P.concat([P.MAGIC, P.T_CONFIRM], new Uint8Array(48))), (e) => e.code === 'bad-hello');
  const j = new P.Handshake('joiner', key);
  await assert.rejects(j.receive(new Uint8Array([P.MAGIC, 3])), (e) => e.code === 'state');
});

test('every handshake yields fresh keys', async () => {
  const code = P.generateCode();
  const a = await pair(code), b = await pair(code);
  assert.notDeepEqual(a.host.send, b.host.send);
  assert.notEqual(a.host.safetyNumber, b.host.safetyNumber);
  assert.notDeepEqual(a.host.resumeSecret, b.host.resumeSecret);
});

// ── room lock & resumption ──
test('locked room refuses a first-join handshake, even with the right code', async () => {
  const code = P.generateCode();
  const first = await pair(code);
  const key = await P.deriveRoomKey(code);
  const host = new P.Handshake('host', key, policy({ locked: true, secrets: [first.host.resumeSecret] }));
  const leaker = new P.Handshake('joiner', key); // knows the full code, lacks the resumption secret
  let err;
  try { await host.receive(await leaker.start()); } catch (e) { err = e; }
  assert.equal(err?.code, 'locked');
  assert.deepEqual([...err.send], [P.MAGIC, P.T_LOCKED], 'host provides a LOCKED frame');
  await assert.rejects(leaker.receive(err.send), (e) => e.code === 'locked', 'joiner reports the lock');
});

test('lock state is read when the HELLO arrives, not when the connection opened', async () => {
  const code = P.generateCode();
  const key = await P.deriveRoomKey(code);
  const state = { locked: false, secrets: [] };
  const host = new P.Handshake('host', key, policy(state));   // connection opened while unlocked…
  const late = new P.Handshake('joiner', key);
  state.locked = true;                                         // …then the room locked
  await assert.rejects(host.receive(await late.start()), (e) => e.code === 'locked');
});

test('resume succeeds with the shared secret and rotates it', async () => {
  const code = P.generateCode();
  const first = await pair(code);
  const second = await pair(code, code, policy({ locked: true, secrets: [first.host.resumeSecret] }), { resumeSecret: first.join.resumeSecret });
  assert.equal(second.host.resumed, true);
  assert.equal(second.join.resumed, true);
  assert.equal(second.host.safetyNumber, second.join.safetyNumber);
  assert.deepEqual(second.host.resumeSecret, second.join.resumeSecret);
  assert.notDeepEqual(second.host.resumeSecret, first.host.resumeSecret, 'resumption secret rotates');
});

test('resume with a wrong secret is refused', async () => {
  const code = P.generateCode();
  const first = await pair(code);
  const forged = globalThis.crypto.getRandomValues(new Uint8Array(48));
  await assert.rejects(pair(code, code, policy({ locked: true, secrets: [first.host.resumeSecret] }), { resumeSecret: forged }),
    (e) => e.code === 'auth-failed');
});

test('regression: an all-zero secret can never be used (review finding: zeroed shared secret)', async () => {
  const code = P.generateCode();
  const key = await P.deriveRoomKey(code);
  assert.throws(() => new P.Handshake('joiner', key, { resumeSecret: new Uint8Array(48) }), (e) => e.code === 'bad-secret');
  // Even if the host's state were somehow zeroed, a HELLO naming the zero secret is refused.
  const host = new P.Handshake('host', key, policy({ locked: true, secrets: [new Uint8Array(48)] }));
  const j = new P.Handshake('joiner', key, { resumeSecret: globalThis.crypto.getRandomValues(new Uint8Array(48)) });
  const hello = await j.start();
  hello.set(await P.resumeId(new Uint8Array(48)), 4); // forge the key id of the zero secret
  await assert.rejects(host.receive(hello), (e) => e.code === 'auth-failed');
});

test('regression: policy secrets are copies the host wipes; caller state is untouched', async () => {
  const code = P.generateCode();
  const first = await pair(code);
  const sessionSecret = first.host.resumeSecret.slice();
  const host = new P.Handshake('host', await P.deriveRoomKey(code), policy({ locked: true, secrets: [sessionSecret] }));
  const j = new P.Handshake('joiner', await P.deriveRoomKey(code), { resumeSecret: first.join.resumeSecret });
  await host.receive(await j.start());
  assert.deepEqual(sessionSecret, first.host.resumeSecret, 'the session copy is not zeroed by a handshake');
});

test('lost CONFIRM: the joiner committed a secret the host only holds as a candidate, and can still resume', async () => {
  const code = P.generateCode();
  const key = await P.deriveRoomKey(code);
  const first = await pair(code);
  const S1 = first.host.resumeSecret;
  // A resume where the host's HELLO arrives but the joiner's CONFIRM is lost in transit.
  const h = new P.Handshake('host', key, policy({ locked: true, secrets: [S1] }));
  const j = new P.Handshake('joiner', key, { resumeSecret: first.join.resumeSecret });
  const r1 = await h.receive(await j.start());
  const candidate = h.candidate.slice();               // what the session stores (session.addCandidate)
  assert.equal(h.candidateContinuity, true, 'a candidate from a proven resume carries continuity');
  const r2 = await j.receive(r1.send);                 // joiner commits S2…
  const S2 = r2.done.resumeSecret;                     // …but the CONFIRM never reaches the host
  assert.deepEqual(candidate, S2);
  // Next resume: host still has S1 as current plus the candidate.
  const third = await pair(code, code, policy({ locked: true, secrets: [S1, { secret: candidate, continuity: true }] }), { resumeSecret: S2 });
  assert.equal(third.host.resumed, true);
});

test('regression: a candidate from an unconfirmed FIRST join never proves continuity (re-review finding)', async () => {
  const code = P.generateCode();
  const key = await P.deriveRoomKey(code);
  // Attacker with only the code starts a first join on an unlocked host and never confirms.
  const h = new P.Handshake('host', key, policy({ locked: false, secrets: [] }));
  const atk = new P.Handshake('joiner', key);
  const r1 = await h.receive(await atk.start());
  assert.equal(h.candidateContinuity, false);
  const stolen = (await atk.receive(r1.send)).done.resumeSecret;
  const cand = { secret: h.candidate.slice(), continuity: h.candidateContinuity };
  // While unlocked it may resume, but only as a NEW peer (fresh safety number, verification reset).
  const asNew = await pair(code, code, policy({ locked: false, secrets: [cand] }), { resumeSecret: stolen });
  assert.equal(asNew.host.resumed, false, 'never reported as continuity');
  // Once locked, it is refused outright.
  await assert.rejects(pair(code, code, policy({ locked: true, secrets: [cand] }), { resumeSecret: stolen }), (e) => e.code === 'auth-failed');
});

test('resume requires the room code as well as the secret', async () => {
  const code = P.generateCode();
  const first = await pair(code);
  await assert.rejects(pair(code, P.generateCode(), policy({ locked: true, secrets: [first.host.resumeSecret] }), { resumeSecret: first.join.resumeSecret }),
    (e) => e.code === 'auth-failed');
});

test('completed handshakes retain nothing that could re-derive session keys', async () => {
  const { hs } = await pair(P.generateCode());
  for (const h of [hs.host, hs.join]) {
    assert.equal(h.state, 'done');
    for (const k of ['eph', 'kem', 'keys', 'nonceJ', 'helloBody', 'roomKey', 'resumeSecret', 'candidate']) assert.equal(h[k] ?? null, null, `${h.role}.${k} retained`);
  }
});

// ── secure channel ──
test('secure channel round trip, both directions, many messages', async () => {
  const { host, join } = await pair(P.generateCode());
  const H = new P.SecureChannel(host), J = new P.SecureChannel(join);
  for (let i = 0; i < 50; i++) {
    const { kind, payload } = await J.open(await H.sealJSON({ t: 'msg', text: 'hi ' + i }));
    assert.equal(kind, P.KIND_JSON);
    assert.equal(P.decodeJSON(payload).text, 'hi ' + i);
    const back = await H.open(await J.seal(P.KIND_BIN, new Uint8Array([i, i, i])));
    assert.deepEqual([...back.payload], [i, i, i]);
  }
});

test('concurrent seals are serialized and decrypt in order', async () => {
  const { host, join } = await pair(P.generateCode());
  const H = new P.SecureChannel(host), J = new P.SecureChannel(join);
  const frames = await Promise.all(Array.from({ length: 40 }, (_, i) => H.sealJSON({ t: 'n', i })));
  const out = await Promise.all(frames.map((f) => J.open(f)));
  assert.deepEqual(out.map((o) => P.decodeJSON(o.payload).i), [...Array(40).keys()]);
});

test('padding: fixed buckets, and minSize forces uniform frames', async () => {
  const { host } = await pair(P.generateCode());
  const H = new P.SecureChannel(host);
  const sizes = new Set();
  for (const n of [0, 1, 50, 200, 240]) sizes.add((await H.seal(P.KIND_BIN, new Uint8Array(n))).length);
  assert.equal(sizes.size, 1);
  const uniform = new Set();
  for (const n of [0, 10, 900, 3000, 4091]) uniform.add((await H.seal(P.KIND_BIN, new Uint8Array(n), 4096)).length);
  assert.equal(uniform.size, 1, 'constant-size mode: every frame identical length');
  assert.equal(P.pad(1, new Uint8Array(3), 4096).length, 4096);
  assert.equal((await H.seal(P.KIND_BIN, new Uint8Array(P.MAX_PLAINTEXT))).length, P.MAX_FRAME);
  await assert.rejects(H.seal(P.KIND_BIN, new Uint8Array(P.MAX_PLAINTEXT + 1)), (e) => e.code === 'too-large');
});

test('tampered ciphertext kills the channel', async () => {
  const { host, join } = await pair(P.generateCode());
  const H = new P.SecureChannel(host), J = new P.SecureChannel(join);
  const f = await H.sealJSON({ t: 'x' });
  f[f.length - 20] ^= 1;
  await assert.rejects(J.open(f), (e) => e.code === 'auth');
  await assert.rejects(J.open(await H.sealJSON({ t: 'y' })), (e) => e.code === 'closed');
});

test('tampered counter, replay, drop, reorder, reflection, cross-session are rejected', async () => {
  let s = await pair(P.generateCode());
  let H = new P.SecureChannel(s.host), J = new P.SecureChannel(s.join);
  const f = await H.sealJSON({ t: 'x' }); f[5] = 9;
  await assert.rejects(J.open(f), (e) => e.code === 'sequence');

  s = await pair(P.generateCode()); H = new P.SecureChannel(s.host); J = new P.SecureChannel(s.join);
  const f0 = await H.sealJSON({ t: 'a' }); await J.open(f0);
  await assert.rejects(J.open(f0), (e) => e.code === 'sequence', 'replay');

  s = await pair(P.generateCode()); H = new P.SecureChannel(s.host); J = new P.SecureChannel(s.join);
  await H.sealJSON({ t: 'dropped' });
  await assert.rejects(J.open(await H.sealJSON({ t: 'b' })), (e) => e.code === 'sequence', 'drop');

  s = await pair(P.generateCode()); H = new P.SecureChannel(s.host);
  await assert.rejects(H.open(await H.sealJSON({ t: 'x' })), (e) => e.code === 'auth', 'reflection');

  const code = P.generateCode();
  const a = await pair(code), b = await pair(code);
  await assert.rejects(new P.SecureChannel(b.join).open(await new P.SecureChannel(a.host).sealJSON({ t: 'x' })), (e) => e.code === 'auth', 'cross-session');
});

test('forward secrecy: chain keys advance and old keys are wiped', async () => {
  const { host, join } = await pair(P.generateCode());
  const sendCopy = host.send.slice();
  const H = new P.SecureChannel(host), J = new P.SecureChannel(join);
  const f = await H.sealJSON({ t: 'x' });
  assert.ok(host.send.every((b) => b === 0), 'initial chain key zeroed after first step');
  assert.notDeepEqual(H.tx.ck, sendCopy);
  await J.open(f);
  const later = new P.SecureChannel({ send: new Uint8Array(48), recv: J.rx.ck.slice() });
  await assert.rejects(later.open(f), (e) => e.code === 'sequence' || e.code === 'auth');
});

test('frame size bounds enforced', async () => {
  const J = new P.SecureChannel((await pair(P.generateCode())).join);
  await assert.rejects(J.open(new Uint8Array(10)), (e) => e.code === 'bad-frame');
  const J2 = new P.SecureChannel((await pair(P.generateCode())).join);
  await assert.rejects(J2.open(new Uint8Array(P.MAX_FRAME + 1)), (e) => e.code === 'bad-frame');
});

test('decodeJSON and unpad reject malformed input', () => {
  const e = (s) => new TextEncoder().encode(s);
  assert.throws(() => P.decodeJSON(e('[1]')));
  assert.throws(() => P.decodeJSON(e('null')));
  assert.throws(() => P.decodeJSON(e('{"x":1}')));
  assert.throws(() => P.decodeJSON(new Uint8Array([0xff, 0xfe])));
  assert.equal(P.decodeJSON(e('{"t":"ok","__proto__":{"polluted":1}}')).t, 'ok');
  assert.equal({}.polluted, undefined);
  const b = P.pad(1, new Uint8Array(10));
  new DataView(b.buffer).setUint32(0, 9999);
  assert.throws(() => P.unpad(b), (x) => x.code === 'bad-padding');
  assert.throws(() => P.unpad(new Uint8Array(300)), (x) => x.code === 'bad-padding');
});

test('JSON nested deeper than any real message is refused before parsing', () => {
  const enc = (s) => new TextEncoder().encode(s);
  const deep = '{"t":"ping","k":' + '['.repeat(30000) + ']'.repeat(30000) + '}';
  assert.throws(() => P.decodeJSON(enc(deep)), /nested too deeply/);
  // brackets inside strings don't count, and real messages pass
  assert.equal(P.decodeJSON(enc('{"t":"msg","text":"[[[[[[[[[[[[{{{{{{{{\\"]]]"}')).t, 'msg');
  assert.equal(P.decodeJSON(enc('{"t":"room","a":{"b":[{"c":[1]}]}}')).t, 'room');
  assert.ok(P.jsonTooDeep('[[[[[[[[[]]]]]]]]]'));
  assert.ok(!P.jsonTooDeep('[[[[[[[[]]]]]]]]'));
});
