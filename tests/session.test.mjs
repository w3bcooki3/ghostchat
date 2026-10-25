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
