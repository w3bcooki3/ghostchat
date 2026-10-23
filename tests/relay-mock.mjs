// Stand-in for relay/ws-relay.js (same wire protocol) so the browser tests can exercise the
// relay transport without Cloudflare tooling. Set RELAY_TEST_URL to test the real Worker
// instead (e.g. `npx wrangler dev` in relay/, then RELAY_TEST_URL=ws://127.0.0.1:8787).
import { WebSocketServer } from 'ws';

export async function startRelayMock(port = 0) {
  const rooms = new Map(); // room → { host, joiners: Map<id, ws> }
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/r\/([0-9a-f]{32})$/);
    const role = url.searchParams.get('role');
    if (!m || (role !== 'host' && role !== 'joiner')) return ws.close(4400);
    const r = rooms.get(m[1]) || { host: null, joiners: new Map() };
    rooms.set(m[1], r);
    if (role === 'host') {
      if (r.host) return ws.close(4409);
      r.host = ws;
      for (const id of r.joiners.keys()) ws.send(JSON.stringify({ t: 'join', id }));
      ws.on('message', (d, isBinary) => {
        if (!isBinary) { try { const c = JSON.parse(d); if (c.t === 'kick') r.joiners.get(c.id)?.close(4400); } catch {} return; }
        const u8 = new Uint8Array(d); r.joiners.get(u8[0])?.send(u8.subarray(1));
      });
      ws.on('close', () => { if (r.host === ws) r.host = null; for (const j of r.joiners.values()) { j.send('{"t":"hostgone"}'); j.close(4410); } });
    } else {
      if (r.joiners.size >= 4) return ws.close(4429);
      let id = 0; while (r.joiners.has(id)) id++;
      r.joiners.set(id, ws);
      if (!r.host) { ws.send('{"t":"nohost"}'); r.joiners.delete(id); return ws.close(4404); }
      r.host.send(JSON.stringify({ t: 'join', id })); ws.send('{"t":"ready"}');
      ws.on('message', (d, isBinary) => {
        if (!isBinary || !r.host) return;
        const u8 = new Uint8Array(d), out = new Uint8Array(u8.length + 1); out[0] = id; out.set(u8, 1); r.host.send(out);
      });
      ws.on('close', () => { r.joiners.delete(id); r.host?.send(JSON.stringify({ t: 'leave', id })); });
    }
  });
  await new Promise((res) => wss.once('listening', res));
  return { url: `ws://127.0.0.1:${wss.address().port}`, close: () => wss.close() };
}
