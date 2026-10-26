// Ghost Chat WebSocket relay — a Cloudflare Worker + Durable Object (free plan, no card).
//
// When two browsers can't connect directly (phones on mobile data, VPNs, strict NAT,
// blocked TURN servers), they both open a WebSocket here and this relay passes frames
// between them over ordinary HTTPS on port 443.
//
// What it sees: IP addresses, timing, sizes, which socket opened a room and how many are
// waiting in it, and Ghost Chat's frames, which are already end-to-end encrypted (hybrid
// ML-KEM + ECDH handshake, AES-256-GCM per message), so it can't read, alter or forge
// anything (tampering is detected and closes the chat).
// What it never sees: the room code, keys, names or content. Rooms are addressed by a
// 128-bit hash derived from the full room code, so nobody without the code can find,
// squat or watch a room here.
//
// Abuse limits. The Origin check only stops OTHER WEBSITES from using the relay in a
// browser: any non-browser client can send whatever Origin it likes. What actually bounds
// abuse is: a per-IP limit on new connections (the optional UPGRADES rate-limit binding in
// wrangler.toml), a frame-rate and byte budget per connection, a size limit on every frame,
// a cap on sockets per room, and dropping joiners that the room's creator never accepts.
//
// Deploy (Workers free plan): see relay/README.md. Set ALLOWED_ORIGINS to your site's
// origin(s), comma-separated, e.g. "https://<you>.github.io".

const MAX_FRAME = 66 * 1024;          // largest Ghost Chat frame is ~65.6 KB
const MAX_CONTROL = 64;               // longest control message: {"t":"accept","id":255}
const MAX_JOINERS = 8;                // joiners per room at once (people waiting to be let in, plus handshakes)
const RATE_PER_10S = 4000;            // frames per socket; generous for file transfers
const BYTES_PER_HOUR = 2 * 1024 ** 3; // per socket: a 100 MB file to five people fits many times over
const JOIN_WAIT_MS = 20_000;          // a joiner the creator's page hasn't accepted by then is dropped
// A host pings every 25 s. Phones freeze or kill background tabs without closing their
// sockets, so a host that has been silent this long is treated as gone (background tabs may
// be throttled to one timer a minute, hence the margin).
const HOST_SILENT_MS = 130_000;

export class Room {
  constructor(state) {
    this.state = state;
    // Keep-alive pings are answered by the platform without waking the object (and free).
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  silent(ws) {
    let last = 0;
    try { last = this.state.getWebSocketAutoResponseTimestamp(ws)?.getTime() || 0; } catch {}
    return Date.now() - Math.max(last, this.info(ws).since || 0) > HOST_SILENT_MS;
  }
  evict(ws, code, why) { try { ws.close(code, why); } catch {} this.gone(ws); }

  sockets(except) { return this.state.getWebSockets().filter((w) => w !== except && w.readyState === 1); }
  info(ws) { try { return ws.deserializeAttachment() || {}; } catch { return {}; } }
  save(ws, a) { try { ws.serializeAttachment(a); } catch {} }
  hostOf(except) { return this.sockets(except).find((w) => this.info(w).role === 'host'); }
  joinersOf(except) { return this.sockets(except).filter((w) => this.info(w).role === 'joiner'); }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const role = new URL(request.url).searchParams.get('role');
    if (role !== 'host' && role !== 'joiner') return new Response('bad role', { status: 400 });
    let host = this.hostOf();
    if (host && this.silent(host)) { this.evict(host, 4408, 'host silent'); host = null; }
    if (role === 'host' && host) return new Response('room already has a host', { status: 409 });
    const joiners = this.joinersOf();
    if (role === 'joiner' && joiners.length >= MAX_JOINERS) return new Response('room busy', { status: 429 });

    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server);
    const now = Date.now();
    if (role === 'host') {
      this.save(server, { role: 'host', n: 0, t: now, b: 0, bt: now, since: now });
      for (const j of joiners) server.send(JSON.stringify({ t: 'join', id: this.info(j).id }));
    } else {
      // An id still held by a socket that is closing (but whose close hasn't run yet) is not
      // reused, so that socket's later "leave" can't tear down a newcomer.
      const used = new Set(this.state.getWebSockets().filter((w) => w !== server && w.readyState !== 3)
        .map((w) => this.info(w)).filter((a) => a.role === 'joiner').map((a) => a.id));
      let id = 0; while (used.has(id)) id++;
      if (id > 255) { try { server.close(1013, 'room busy'); } catch {} return new Response(null, { status: 101, webSocket: client }); }
      this.save(server, { role: 'joiner', id, n: 0, t: now, b: 0, bt: now, since: now, ready: false });
      // The joiner is only told "ready" once the host's page answers (an 'accept'), so a frozen
      // or killed host tab can't swallow a handshake. 'wait' tells the joiner a host socket exists.
      if (host) {
        host.send(JSON.stringify({ t: 'join', id })); server.send('{"t":"wait"}');
        await this.armAlarm(now + JOIN_WAIT_MS);
      } else { server.send('{"t":"nohost"}'); server.close(4404, 'no host'); }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async armAlarm(at) {
    try {
      const cur = await this.state.storage.getAlarm();
      if (cur == null || cur > at) await this.state.storage.setAlarm(at);
    } catch {}
  }
  /** Drops joiners the creator's page never accepted, so nobody can sit in a room's slots. */
  async alarm() {
    const now = Date.now();
    let next = null;
    for (const j of this.joinersOf()) {
      const a = this.info(j);
      if (a.ready) continue;
      const due = (a.since || 0) + JOIN_WAIT_MS;
      if (due <= now) this.evict(j, 4408, 'not accepted');
      else next = next == null ? due : Math.min(next, due);
    }
    if (next != null) await this.armAlarm(next);
  }

  webSocketMessage(ws, msg) {
    const a = this.info(ws);
    // Every message counts against the socket's limits, text or binary.
    const now = Date.now();
    if (!(now - a.t <= 10_000)) { a.t = now; a.n = 0; }          // also resets missing/garbled counters
    if (!(now - a.bt <= 3_600_000)) { a.bt = now; a.b = 0; }
    const size = typeof msg === 'string' ? msg.length : msg.byteLength;
    a.b = (a.b || 0) + size;
    a.n = (a.n || 0) + 1;
    if (a.n > RATE_PER_10S) return this.evict(ws, 1008, 'rate limit');
    if (a.b > BYTES_PER_HOUR) return this.evict(ws, 1008, 'byte budget');
    this.save(ws, a);

    if (typeof msg === 'string') {                             // control: host accepts or drops a joiner
      if (msg === 'ping') { try { ws.send('pong'); } catch {} return; }   // normally answered by the platform for free
      if (a.role !== 'host' || size > MAX_CONTROL) return this.evict(ws, 1008, 'bad control');
      let m; try { m = JSON.parse(msg); } catch { return; }
      if (!m || typeof m !== 'object' || !Number.isInteger(m.id)) return;
      const j = this.joinersOf(ws).find((x) => this.info(x).id === m.id);
      if (!j) return;
      if (m.t === 'accept') { const ja = this.info(j); ja.ready = true; this.save(j, ja); try { j.send('{"t":"ready"}'); } catch {} }
      if (m.t === 'kick') this.evict(j, 4400, 'closed by host');
      return;
    }
    const u8 = new Uint8Array(msg);
    if (u8.length < 2 || u8.length > MAX_FRAME + 1) return this.evict(ws, 1009, 'bad size');
    if (a.role === 'host') {
      const target = this.joinersOf(ws).find((j) => this.info(j).id === u8[0]);
      target?.send(u8.subarray(1));
    } else {
      if (!a.ready) return;                                    // nothing reaches the host before it accepts
      const host = this.hostOf(ws);
      if (!host) return;
      const out = new Uint8Array(u8.length + 1);
      out[0] = a.id; out.set(u8, 1);
      host.send(out);
    }
  }

  webSocketClose(ws) { this.gone(ws); }
  webSocketError(ws) { this.gone(ws); }
  /** Runs once per socket, however it ended (evicted, closed, errored). */
  gone(ws) {
    const a = this.info(ws);
    if (a.gone) return;
    a.gone = true; this.save(ws, a);
    if (a.role === 'joiner') {
      // Only announce the leave if no live joiner has taken the same id in the meantime.
      if (!this.joinersOf(ws).some((j) => this.info(j).id === a.id)) this.hostOf(ws)?.send(JSON.stringify({ t: 'leave', id: a.id }));
    } else if (a.role === 'host') for (const j of this.joinersOf(ws)) { try { j.send('{"t":"hostgone"}'); } catch {} this.evict(j, 4410, 'host left'); }
    try { ws.close(1000, 'bye'); } catch {}
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') return new Response('ghostchat relay ok', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
    const m = url.pathname.match(/^\/r\/([0-9a-f]{32})$/);
    if (!m) return new Response('not found', { status: 404 });
    // Stops other websites from using the relay from a browser. It does NOT stop scripts or
    // other non-browser clients, which can send any Origin; the limits below and in Room do.
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(origin) && !allowed.includes('*')) return new Response('origin not allowed', { status: 403 });
    // Per-IP limit on new connections (Workers rate-limit binding; see wrangler.toml). The IP
    // is only used as the counter key, never stored or logged by this code.
    if (env.UPGRADES) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      try { const { success } = await env.UPGRADES.limit({ key: 'upgrade:' + ip }); if (!success) return new Response('too many connections, slow down', { status: 429 }); } catch {}
    }
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(request);
  },
};
