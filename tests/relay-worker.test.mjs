// Unit tests for the real relay Worker (relay/ws-relay.js), run against a small stand-in for
// the Cloudflare Durable Object runtime: hibernatable WebSockets with attachments, alarms,
// WebSocketPair and the 101 Response. No Cloudflare tooling needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeWS {
  constructor() { this.readyState = 1; this.sent = []; this.att = null; this.closedWith = null; }
  send(d) { if (this.readyState !== 1) throw new Error('closed'); this.sent.push(typeof d === 'string' ? d : Uint8Array.from(d)); }
  close(code, why) { if (this.readyState === 3) return; this.readyState = 3; this.closedWith = [code, why]; this.room?.webSocketClose(this); }
  serializeAttachment(a) { this.att = structuredClone(a); }
  deserializeAttachment() { return structuredClone(this.att); }
  texts() { return this.sent.filter((d) => typeof d === 'string'); }
  bins() { return this.sent.filter((d) => typeof d !== 'string'); }
}
globalThis.WebSocketRequestResponsePair = class { constructor(a, b) { this.a = a; this.b = b; } };
globalThis.WebSocketPair = class { constructor() { this[0] = new FakeWS(); this[1] = new FakeWS(); } };
const RealResponse = globalThis.Response;
globalThis.Response = class { constructor(body, init = {}) { this.body = body; this.status = init.status || 200; this.webSocket = init.webSocket; } };

const { Room, default: worker } = await import('../relay/ws-relay.js');

function makeRoom() {
  const socks = [];
  const state = {
    alarm: null, all: socks,
    setWebSocketAutoResponse() {},
    getWebSocketAutoResponseTimestamp() { return null; },
    acceptWebSocket(ws) { socks.push(ws); },
    getWebSockets() { return socks.filter((w) => w.readyState !== 3); },
    storage: { async getAlarm() { return state.alarm; }, async setAlarm(t) { state.alarm = t; } },
  };
  const room = new Room(state);
  return { room, state };
}
const upgrade = (role) => ({ url: 'https://relay.example/r/' + 'a'.repeat(32) + '?role=' + role, headers: new Map([['Upgrade', 'websocket']]) });
async function connect(room, role) {
  const n = room.state.all.length;
  const res = await room.fetch(upgrade(role));
  const server = room.state.all[n] || null;
  if (server) server.room = room;
  return { res, server };
}
const bin = (...bytes) => Uint8Array.from(bytes).buffer;

test('joiner frames reach the host only after the host page accepts; ids are prefixed', async () => {
  const { room } = makeRoom();
  const { server: host } = await connect(room, 'host');
  const { server: j } = await connect(room, 'joiner');
  assert.deepEqual(JSON.parse(host.texts().at(-1)), { t: 'join', id: 0 });
  room.webSocketMessage(j, bin(9, 9, 9));
  assert.equal(host.bins().length, 0, 'nothing forwarded before accept');
  room.webSocketMessage(host, '{"t":"accept","id":0}');
  assert.equal(j.texts().at(-1), '{"t":"ready"}');
  room.webSocketMessage(j, bin(1, 2, 3));
  assert.deepEqual([...host.bins().at(-1)], [0, 1, 2, 3]);
  room.webSocketMessage(host, bin(0, 7, 8));
  assert.deepEqual([...j.bins().at(-1)], [7, 8]);
});

test('text frames: only the host may send control messages, and only short ones; ping is answered', async () => {
  const { room } = makeRoom();
  const { server: host } = await connect(room, 'host');
  const { server: j } = await connect(room, 'joiner');
  room.webSocketMessage(j, 'ping');
  assert.equal(j.readyState, 1); assert.equal(j.texts().at(-1), 'pong');
  room.webSocketMessage(j, '{"t":"accept","id":0}');
  assert.equal(j.readyState, 3, 'a joiner sending control text is dropped');
  room.webSocketMessage(host, 'x'.repeat(10_000));
  assert.equal(host.readyState, 3, 'oversized control text from the host is refused');
});

test('every frame counts toward the rate limit, including text', async () => {
  const { room } = makeRoom();
  const { server: host } = await connect(room, 'host');
  for (let i = 0; i < 4000; i++) room.webSocketMessage(host, 'ping');
  assert.equal(host.readyState, 1);
  room.webSocketMessage(host, 'ping');
  assert.deepEqual(host.closedWith, [1008, 'rate limit']);
});

test('per-socket byte budget', async () => {
  const { room } = makeRoom();
  const { server: host } = await connect(room, 'host');
  const a = host.deserializeAttachment(); a.b = 2 * 1024 ** 3 - 10; host.serializeAttachment(a);
  room.webSocketMessage(host, bin(0, ...new Array(64).fill(1)));
  assert.deepEqual(host.closedWith, [1008, 'byte budget']);
});

test('frame size limits', async () => {
  const { room } = makeRoom();
  const { server: host } = await connect(room, 'host');
  room.webSocketMessage(host, new Uint8Array(66 * 1024 + 2).buffer);
  assert.deepEqual(host.closedWith, [1009, 'bad size']);
});

test('joiners the host never accepts are dropped after 20 s, accepted ones stay', async () => {
  const { room, state } = makeRoom();
  const realNow = Date.now; let now = 1_000_000; Date.now = () => now;
  try {
    const { server: host } = await connect(room, 'host');
    const { server: idle } = await connect(room, 'joiner');
    const { server: ok } = await connect(room, 'joiner');
    room.webSocketMessage(host, '{"t":"accept","id":1}');
    assert.equal(state.alarm, 1_000_000 + 20_000);
    now += 20_001;
    await room.alarm();
    assert.deepEqual(idle.closedWith, [4408, 'not accepted']);
    assert.equal(ok.readyState, 1);
    assert.ok(host.texts().some((t) => t === '{"t":"leave","id":0}'), 'host told the idle joiner left');
  } finally { Date.now = realNow; }
});

test('a room holds at most 8 joiners', async () => {
  const { room } = makeRoom();
  await connect(room, 'host');
  for (let i = 0; i < 8; i++) assert.equal((await connect(room, 'joiner')).res.status, 101);
  assert.equal((await connect(room, 'joiner')).res.status, 429);
});

test('a late close of an old joiner never tears down a newcomer with the same id', async () => {
  const { room } = makeRoom();
  const { server: host } = await connect(room, 'host');
  const { server: old } = await connect(room, 'joiner');
  old.readyState = 2;                                   // closing, but its close handler hasn't run
  const { server: fresh } = await connect(room, 'joiner');
  assert.equal(fresh.deserializeAttachment().id, 1, 'a closing socket\'s id is not reused');
  old.readyState = 1; old.close(1000);                  // now its close handler runs
  assert.ok(host.texts().includes('{"t":"leave","id":0}'));
  assert.ok(!host.texts().includes('{"t":"leave","id":1}'));
  assert.equal(fresh.readyState, 1);
});

test('when the host leaves, each joiner is told once and closed', async () => {
  const { room } = makeRoom();
  const { server: host } = await connect(room, 'host');
  const { server: j } = await connect(room, 'joiner');
  room.evict(host, 4408, 'host silent');
  room.webSocketClose(host);                            // the platform's close callback runs too
  assert.equal(j.texts().filter((t) => t === '{"t":"hostgone"}').length, 1);
  assert.equal(j.readyState, 3);
});

test('only one host per room; joiner with no host is told and closed', async () => {
  const { room } = makeRoom();
  const { server: lone } = await connect(room, 'joiner');
  assert.equal(lone.texts()[0], '{"t":"nohost"}'); assert.equal(lone.readyState, 3);
  await connect(room, 'host');
  assert.equal((await connect(room, 'host')).res.status, 409);
});

test('worker: path, origin and per-IP connection limit', async () => {
  const forwarded = [];
  const env = {
    ALLOWED_ORIGINS: 'https://me.github.io',
    ROOMS: { idFromName: (n) => n, get: (id) => ({ fetch: async () => { forwarded.push(id); return new Response(null, { status: 101 }); } }) },
    UPGRADES: { calls: 0, async limit({ key }) { this.calls++; assert.ok(key.startsWith('upgrade:')); return { success: this.calls <= 2 }; } },
  };
  const req = (path, origin) => ({ url: 'https://relay.example' + path, headers: new Map(Object.entries({ Origin: origin, 'CF-Connecting-IP': '203.0.113.9' }).filter(([, v]) => v)) });
  for (const r of [req('/r/xyz', 'https://me.github.io'), req('/r/' + 'A'.repeat(32), 'https://me.github.io')]) assert.equal((await worker.fetch(r, env)).status, 404);
  for (const o of [undefined, 'null', 'https://evil.example', 'https://me.github.io.evil.example', 'HTTPS://ME.GITHUB.IO']) assert.equal((await worker.fetch(req('/r/' + 'b'.repeat(32), o), env)).status, 403, String(o));
  assert.equal((await worker.fetch(req('/r/' + 'b'.repeat(32), 'https://me.github.io'), env)).status, 101);
  assert.equal((await worker.fetch(req('/r/' + 'b'.repeat(32), 'https://me.github.io'), env)).status, 101);
  assert.equal((await worker.fetch(req('/r/' + 'b'.repeat(32), 'https://me.github.io'), env)).status, 429, 'third connection from the same IP is limited');
  delete env.UPGRADES;
  assert.equal((await worker.fetch(req('/r/' + 'c'.repeat(32), 'https://me.github.io'), env)).status, 101, 'works without the optional binding');
});

test.after(() => { globalThis.Response = RealResponse; });
