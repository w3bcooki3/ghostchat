// WebSocket relay transport (relay/ws-relay.js on Cloudflare Workers).
//
// The fallback that works on networks where WebRTC can't: phones on mobile data, VPNs,
// symmetric NAT, blocked TURN servers. Both browsers open a WebSocket (HTTPS, port 443)
// to the relay, which forwards frames between them.
//
// Like the same-device link this is ONLY a byte pipe: the room-code-authenticated hybrid
// handshake and AES-256-GCM frames run on top, unchanged. The relay sees ciphertext,
// sizes, timing and IP addresses — never the code, keys or content. Rooms on the relay are
// addressed by relayRoomId(): a hash of the room KEY (derived from the full 20-character
// code), unrelated to the public signaling ID, so the relay can't link the two, and nobody
// without the code can find, squat or observe a room.
//
// The objects handed to Link mimic the subset of a PeerJS DataConnection that Link uses.

const PING_MS = 25_000;          // keeps idle VPN/NAT/proxy mappings alive (answered for free)
const OPEN_TIMEOUT_MS = 8_000;
const te = new TextEncoder();
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

/** 128-bit relay address for a room, derived from the room key. */
export async function relayRoomId(roomKey) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...te.encode('ghostchat/v3/relay-room'), ...roomKey])));
  return hex(d.slice(0, 16));
}

class RelayConn {
  constructor({ send, close }) {
    this.relay = true; this.serialization = 'raw'; this.bufferSize = 0;
    this.dataChannel = null; this.peerConnection = null;
    this.open = false; this.closed = false;
    this._send = send; this._close = close;
    this._h = { open: [], data: [], close: [], error: [] };
  }
  on(ev, fn) { (this._h[ev] ||= []).push(fn); return this; }
  _emit(ev, d) { for (const f of this._h[ev] || []) { try { f(d); } catch (e) { console.error('[ghost] relay', ev, e); } } }
  _opened() { if (this.open || this.closed) return; this.open = true; this._emit('open'); }
  send(bytes) { if (!this.closed && this.open) this._send(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }
  get bufferedAmount() { return this._buffered ? this._buffered() : 0; }
  close() { this._shut(true); }
  _shut(notify) {
    if (this.closed) return;
    this.closed = true;
    if (notify) { try { this._close(); } catch {} }
    this._emit('close');
  }
}

function socketUrl(base, room, role) {
  const u = new URL(base.replace(/\/+$/, '') + '/r/' + room);
  u.searchParams.set('role', role);
  return u.href;
}

/** Joiner: one WebSocket per connection attempt. Closes with `unanswered` if no host is there. */
export function dialRelay(base, room) {
  let ws;
  const conn = new RelayConn({ send: (b) => ws.send(b), close: () => ws.close(1000) });
  conn._buffered = () => ws?.bufferedAmount || 0;
  try { ws = new WebSocket(socketUrl(base, room, 'joiner')); } catch { queueMicrotask(() => { conn.unanswered = true; conn._shut(false); }); return conn; }
  ws.binaryType = 'arraybuffer';
  const timer = setTimeout(() => { if (!conn.open) { conn.unanswered = true; try { ws.close(); } catch {} conn._shut(false); } }, OPEN_TIMEOUT_MS);
  const ping = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, PING_MS);
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m?.t === 'ready') { clearTimeout(timer); conn._opened(); }
      else if (m?.t === 'nohost') { conn.unanswered = true; conn.nohost = true; }
      else if (m?.t === 'hostgone') conn._shut(false);
      return;
    }
    if (conn.open) conn._emit('data', e.data);
  };
  ws.onclose = () => { clearTimeout(timer); clearInterval(ping); if (!conn.open) conn.unanswered = true; conn._shut(false); };
  ws.onerror = () => {};
  return conn;
}

/**
 * Host: one WebSocket that stays registered for the room and multiplexes joiners (the relay
 * prefixes each frame with a one-byte joiner id). Reconnects on its own while the session lives.
 */
export class RelayHost {
  constructor(base, room) {
    this.base = base; this.room = room;
    this.conns = new Map(); this.ws = null; this.closed = false; this.retry = 0;
    this.onConnection = null; this.onState = null; // onState(up: boolean)
  }
  start() { this._connect(); }
  _connect() {
    if (this.closed) return;
    let ws;
    try { ws = this.ws = new WebSocket(socketUrl(this.base, this.room, 'host')); } catch { return this._again(); }
    ws.binaryType = 'arraybuffer';
    clearInterval(this.ping);
    this.ping = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, PING_MS);
    ws.onopen = () => { this.retry = 0; this.onState?.(true); };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m?.t === 'join' && Number.isInteger(m.id) && m.id >= 0 && m.id < 256 && !this.conns.has(m.id)) {
          const id = m.id;
          const conn = new RelayConn({
            send: (b) => { if (ws.readyState !== 1) return; const out = new Uint8Array(b.length + 1); out[0] = id; out.set(b, 1); ws.send(out); },
            close: () => { this.conns.delete(id); if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'kick', id })); },
          });
          conn._buffered = () => ws.bufferedAmount || 0;
          this.conns.set(id, conn);
          this.onConnection?.(conn);           // Link attaches its handlers synchronously
          conn._opened();
        } else if (m?.t === 'leave') { const c = this.conns.get(m.id); this.conns.delete(m.id); c?._shut(false); }
        return;
      }
      const u8 = new Uint8Array(e.data);
      if (u8.length < 2) return;
      const c = this.conns.get(u8[0]);
      if (c?.open) c._emit('data', u8.slice(1).buffer);
    };
    ws.onclose = () => {
      clearInterval(this.ping);
      for (const c of this.conns.values()) c._shut(false);
      this.conns.clear();
      this.onState?.(false);
      this._again();
    };
    ws.onerror = () => {};
  }
  _again() {
    if (this.closed) return;
    const d = [1000, 2000, 4000, 8000, 15000][Math.min(this.retry++, 4)];
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._connect(), d);
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer); clearInterval(this.ping);
    for (const c of this.conns.values()) c._shut(false);
    this.conns.clear();
    try { this.ws?.close(1000); } catch {}
  }
}
