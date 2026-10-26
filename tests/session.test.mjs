// Session-layer unit tests (Node >= 20): node --test tests/session.test.mjs
// Exercises inbound file handling directly; no network, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../js/session.js';
import * as P from '../js/protocol.js';

const FILE_CHUNK = 60 * 1024;
function session() {
  const s = new Session({ code: P.generateCode(), role: 'joiner' });
  const events = [];
  for (const t of ['file-in', 'file-received', 'file-failed', 'file-progress']) s.on(t, (d) => events.push([t, d]));
  return { s, events };
}
const fidHex = 'aabbccddeeff0011';
function chunk(seq, bytes) {
  const hdr = new Uint8Array(12);
  hdr.set(Uint8Array.from(fidHex.match(/../g), (h) => parseInt(h, 16)), 0);
  new DataView(hdr.buffer).setUint32(8, seq, false);
  return P.concat(hdr, bytes);
}

test('a well-formed transfer is reassembled exactly', async () => {
  const { s, events } = session();
  const data = crypto.getRandomValues(new Uint8Array(FILE_CHUNK + 1000));
  s.onFileOffer({ t: 'file', fid: fidHex, name: 'a.bin', size: data.length });
  s.onChunk(chunk(0, data.subarray(0, FILE_CHUNK)));
  s.onChunk(chunk(1, data.subarray(FILE_CHUNK)));
  s.onFileEnd({ fid: fidHex, chunks: 2 });
  const got = events.find(([t]) => t === 'file-received');
  assert.ok(got, 'received');
  assert.deepEqual(new Uint8Array(await got[1].blob.arrayBuffer()), data);
  assert.equal(got[1].blob.type, 'application/octet-stream', 'never typed by the peer');
});

test('empty chunks abort the transfer instead of growing memory forever', () => {
  const { s, events } = session();
  s.onFileOffer({ t: 'file', fid: fidHex, name: 'a.bin', size: 10 });
  s.onChunk(chunk(0, new Uint8Array(0)));
  assert.equal(s.incoming.size, 0);
  assert.ok(events.some(([t, d]) => t === 'file-failed' && d.reason === 'corrupt transfer'));
  for (let i = 1; i < 1000; i++) s.onChunk(chunk(i, new Uint8Array(0)));   // trailing junk is ignored
  assert.equal(s.incoming.size, 0);
});

test('oversized, out-of-order and over-long chunks abort the transfer', () => {
  for (const bad of [
    (s) => s.onChunk(chunk(0, new Uint8Array(FILE_CHUNK + 1))),
    (s) => s.onChunk(chunk(1, new Uint8Array(5))),
    (s) => { s.onChunk(chunk(0, new Uint8Array(8))); s.onChunk(chunk(1, new Uint8Array(8))); },
    (s) => s.onChunk(chunk(0, new Uint8Array(1))),   // short chunk that isn't the last one
  ]) {
    const { s, events } = session();
    s.onFileOffer({ t: 'file', fid: fidHex, name: 'a.bin', size: 10 });
    bad(s);
    assert.equal(s.incoming.size, 0);
    assert.ok(events.some(([t]) => t === 'file-failed'));
  }
});

test('file offers are validated: size cap, id format, duplicate ids, concurrent limit', () => {
  const { s } = session();
  s.onFileOffer({ t: 'file', fid: fidHex, name: 'x', size: 101 * 1024 * 1024 });
  s.onFileOffer({ t: 'file', fid: 'not-hex', name: 'x', size: 1 });
  s.onFileOffer({ t: 'file', fid: fidHex, name: 'x', size: -1 });
  assert.equal(s.incoming.size, 0);
  for (let i = 0; i < 6; i++) s.onFileOffer({ t: 'file', fid: '00000000000000' + String(i).padStart(2, '0'), name: 'x', size: 1 });
  assert.equal(s.incoming.size, 4, 'at most 4 concurrent incoming transfers');
  s.onFileOffer({ t: 'file', fid: '0000000000000000', name: 'y', size: 1 });
  assert.equal(s.incoming.get('0000000000000000').name, 'x', 'an existing transfer is never replaced');
});

// ── two real Sessions over an in-memory link (frames can be dropped on purpose) ──
function memConn() {
  const c = { local: true, serialization: 'raw', open: false, closed: false, bufferSize: 0, _h: {},
    on(e, f) { (this._h[e] ||= []).push(f); return this; },
    emit(e, d) { for (const f of this._h[e] || []) f(d); },
    send(b) { if (this.closed || this.drop?.(b)) return; const copy = new Uint8Array(b).slice(); setTimeout(() => this.peer && !this.peer.closed && this.peer.emit('data', copy.buffer), 1); },
    close() { if (this.closed) return; this.closed = true; this.emit('close'); this.peer && setTimeout(() => this.peer.close(), 1); } };
  return c;
}
async function twoSessions() {
  const code = P.generateCode();
  const host = new Session({ code, role: 'host', sameDevice: false });
  const joiner = new Session({ code, role: 'joiner', sameDevice: false });
  host.roomKey = await P.deriveRoomKey(code); joiner.roomKey = await P.deriveRoomKey(code);
  return { host, joiner };
}
function link(host, joiner, dropFromJoiner) {
  const hc = memConn(), jc = memConn(); hc.peer = jc; jc.peer = hc; jc.drop = dropFromJoiner;
  host.accept(hc);
  joiner.hub = { dial: () => jc }; joiner.dialLocal(); joiner.hub = null;
  setTimeout(() => { hc.open = jc.open = true; hc.emit('open'); jc.emit('open'); }, 1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a lost CONFIRM on the first join still ends with matching safety numbers', async (t) => {
  const { host, joiner } = await twoSessions();
  t.after(() => { host.destroy('local'); joiner.destroy('local'); });
  link(host, joiner, (b) => b[1] === P.T_CONFIRM);          // the network eats the joiner's CONFIRM
  await sleep(300);
  assert.ok(joiner.safetyNumber && !host.everReady, 'joiner finished, host did not');
  joiner.active?.close('test'); for (const l of host.pending) l.close('test');
  await sleep(100);
  link(host, joiner);                                       // the joiner resumes
  await sleep(400);
  assert.ok(host.everReady);
  assert.equal(host.safetyNumber, joiner.safetyNumber, 'both sides show the same number');
});

test('a deeply nested message closes the link instead of silently freezing it', async (t) => {
  const { host, joiner } = await twoSessions();
  t.after(() => { host.destroy('local'); joiner.destroy('local'); });
  const got = [];
  host.on('message', (o) => got.push(o.t));
  link(host, joiner);
  await sleep(300);
  const closed = [];
  host.active.close = ((orig) => function (r) { closed.push(r); return orig.call(this, r); })(host.active.close);
  await joiner.active.sendFrame(P.KIND_JSON, new TextEncoder().encode('{"t":"ping","k":' + '['.repeat(20000) + ']'.repeat(20000) + '}'));
  await sleep(100);
  assert.equal(closed[0], 'protocol');
});
