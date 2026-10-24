// Ghost Chat WebSocket relay — a Cloudflare Worker + Durable Object (free plan, no card).
//
// When two browsers can't connect directly (phones on mobile data, VPNs, strict NAT,
// blocked TURN servers), they both open a WebSocket here and this relay passes frames
// between them over ordinary HTTPS on port 443.
//
// What it sees: IP addresses, timing, sizes, and Ghost Chat's frames, which are already
// end-to-end encrypted (hybrid ML-KEM + ECDH handshake, AES-256-GCM per message), so it
// can't read, alter or forge anything (tampering is detected and closes the chat).
// What it never sees: the room code, keys, names or content. Rooms are addressed by a
// 128-bit hash derived from the full room code, so nobody without the code can find,
// squat or watch a room here.
//
// Deploy (Workers free plan): see relay/README.md. Set ALLOWED_ORIGINS to your site's
// origin(s), comma-separated, e.g. "https://<you>.github.io".

const MAX_FRAME = 66 * 1024;      // largest Ghost Chat frame is ~65.6 KB
const MAX_JOINERS = 4;            // pending handshakes per room (the app locks after one)
const RATE_PER_10S = 4000;        // per socket; generous for file transfers
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
  evict(ws) { try { ws.close(4408, 'host silent'); } catch {} this.gone(ws); }

  sockets(except) { return this.state.getWebSockets().filter((w) => w !== except && w.readyState === 1); }
  info(ws) { try { return ws.deserializeAttachment() || {}; } catch { return {}; } }
  hostOf(except) { return this.sockets(except).find((w) => this.info(w).role === 'host'); }
  joinersOf(except) { return this.sockets(except).filter((w) => this.info(w).role === 'joiner'); }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const role = new URL(request.url).searchParams.get('role');
    if (role !== 'host' && role !== 'joiner') return new Response('bad role', { status: 400 });
    let host = this.hostOf();
    if (host && this.silent(host)) { this.evict(host); host = null; }
    if (role === 'host' && host) return new Response('room already has a host', { status: 409 });
    const joiners = this.joinersOf();
    if (role === 'joiner' && joiners.length >= MAX_JOINERS) return new Response('room busy', { status: 429 });

    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server);
    if (role === 'host') {
      server.serializeAttachment({ role: 'host', n: 0, t: Date.now(), since: Date.now() });
      for (const j of joiners) server.send(JSON.stringify({ t: 'join', id: this.info(j).id }));
    } else {
      const used = new Set(joiners.map((j) => this.info(j).id));
      let id = 0; while (used.has(id)) id++;
      server.serializeAttachment({ role: 'joiner', id, n: 0, t: Date.now() });
      // The joiner is only told "ready" once the host's page answers (an 'accept'), so a frozen
      // or killed host tab can't swallow a handshake. 'wait' tells the joiner a host socket exists.
      if (host) { host.send(JSON.stringify({ t: 'join', id })); server.send('{"t":"wait"}'); }
      else { server.send('{"t":"nohost"}'); server.close(4404, 'no host'); }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, msg) {
    const a = this.info(ws);
    if (typeof msg === 'string') {                             // control: host accepts or drops a joiner
      if (a.role !== 'host') return;
      let m; try { m = JSON.parse(msg); } catch { return; }
      const j = this.joinersOf(ws).find((x) => this.info(x).id === m?.id);
      if (m?.t === 'accept') { try { j?.send('{"t":"ready"}'); } catch {} }
      if (m?.t === 'kick') { try { j?.close(4400, 'closed by host'); } catch {} }
      return;
    }
    const now = Date.now();
    if (now - a.t > 10_000) { a.t = now; a.n = 0; }
    if (++a.n > RATE_PER_10S) { ws.close(1008, 'rate limit'); return; }
    ws.serializeAttachment(a);
    const u8 = new Uint8Array(msg);
    if (u8.length < 2 || u8.length > MAX_FRAME + 1) { ws.close(1009, 'bad size'); return; }
    if (a.role === 'host') {
      const target = this.joinersOf(ws).find((j) => this.info(j).id === u8[0]);
      target?.send(u8.subarray(1));
    } else {
      const host = this.hostOf(ws);
      if (!host) return;
      const out = new Uint8Array(u8.length + 1);
      out[0] = a.id; out.set(u8, 1);
      host.send(out);
    }
  }

  webSocketClose(ws) { this.gone(ws); }
  webSocketError(ws) { this.gone(ws); }
  gone(ws) {
    const a = this.info(ws);
    if (a.role === 'joiner') this.hostOf(ws)?.send(JSON.stringify({ t: 'leave', id: a.id }));
    else if (a.role === 'host') for (const j of this.joinersOf(ws)) { try { j.send('{"t":"hostgone"}'); j.close(4410, 'host left'); } catch {} }
    try { ws.close(1000, 'bye'); } catch {}
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (url.pathname === '/' || url.pathname === '/health') return new Response('ghostchat relay ok', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
    const m = url.pathname.match(/^\/r\/([0-9a-f]{32})$/);
    if (!m) return new Response('not found', { status: 404 });
    // Browsers always send Origin on WebSocket upgrades; refuse other sites (and origin-less
    // clients) so nobody else can run their traffic through your free allowance.
    if (!allowed.includes(origin) && !(allowed.includes('*'))) return new Response('origin not allowed', { status: 403 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(request);
  },
};
