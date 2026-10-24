// Same-device transport: two tabs or windows of the same browser profile (for example two
// incognito windows, which share one incognito session) talk over a BroadcastChannel instead
// of WebRTC. It needs no network, no STUN/TURN and no signaling server, so it works where
// NAT traversal can't (symmetric NAT, VPNs, blocked mDNS).
//
// Security: this is ONLY a byte pipe. Everything sent over it is the same Ghost Chat
// protocol as over WebRTC: the room-code-authenticated hybrid handshake, then AES-256-GCM
// frames. A BroadcastChannel is visible only to pages of the same origin in the same browser
// profile; such a page could read ciphertext or inject garbage (which the protocol rejects
// and treats as a dropped link), but it learns nothing it couldn't from the network.
//
// The object handed to Link mimics the subset of a PeerJS DataConnection that Link uses.

const PREFIX = 'ghostchat-v3-local/';
const ACK_TIMEOUT_MS = 1200;
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

export const localSupported = () => typeof BroadcastChannel === 'function';

class LocalConn {
  constructor(hub, id, side) {
    this.hub = hub; this.id = id; this.side = side; // side: who WE are ('h' host, 'j' joiner)
    this.local = true;
    this.serialization = 'raw';
    this.bufferSize = 0;
    this.dataChannel = null; this.peerConnection = null;
    this.open = false; this.closed = false;
    this._h = { open: [], data: [], close: [], error: [] };
  }
  on(ev, fn) { (this._h[ev] ||= []).push(fn); return this; }
  _emit(ev, d) { for (const f of this._h[ev] || []) { try { f(d); } catch (e) { console.error('[ghost] local', ev, e); } } }
  _opened() { if (this.open || this.closed) return; this.open = true; this._emit('open'); }
  send(bytes) {
    if (this.closed || !this.open) return;
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // Copy into a standalone buffer: the sender may wipe its array right after sending.
    this.hub._post({ k: 'd', c: this.id, to: this.side === 'h' ? 'j' : 'h', d: u8.slice().buffer });
  }
  close() { this._shut(true); }
  _shut(notify) {
    if (this.closed) return;
    this.closed = true;
    if (notify) this.hub._post({ k: 'f', c: this.id, to: this.side === 'h' ? 'j' : 'h' });
    this.hub.conns.delete(this.id);
    this._emit('close');
  }
}

/** One per Session. Host: listen() and receive connections. Joiner: dial() a connection. */
export class LocalHub {
  constructor(roomId, role) {
    this.role = role === 'host' ? 'h' : 'j';
    this.conns = new Map();
    this.ch = new BroadcastChannel(PREFIX + roomId);
    this.ch.onmessage = (e) => this._onMsg(e.data);
    this.onConnection = null;
    this._bye = () => this.close();
    addEventListener('pagehide', this._bye);
  }

  _post(m) { try { this.ch?.postMessage(m); } catch {} }

  _onMsg(m) {
    if (!m || typeof m !== 'object' || typeof m.c !== 'string' || m.c.length !== 16) return;
    if (m.k === 's') {                                  // SYN: a joiner wants a connection
      if (this.role !== 'h' || this.conns.has(m.c) || !this.onConnection) return;
      const conn = new LocalConn(this, m.c, 'h');
      this.conns.set(m.c, conn);
      this.onConnection(conn);                          // Link attaches its handlers synchronously
      this._post({ k: 'a', c: m.c, to: 'j' });
      conn._opened();
      return;
    }
    if (m.to !== this.role) return;
    const conn = this.conns.get(m.c);
    if (!conn) return;
    if (m.k === 'a') { clearTimeout(conn.ackTimer); conn._opened(); }
    else if (m.k === 'd' && conn.open && m.d instanceof ArrayBuffer) conn._emit('data', m.d);
    else if (m.k === 'f') conn._shut(false);
  }

  /** Joiner: returns a conn that opens if a host for this room lives in this browser, else closes. */
  dial() {
    const conn = new LocalConn(this, rid(), 'j');
    this.conns.set(conn.id, conn);
    conn.ackTimer = setTimeout(() => { if (!conn.open) { conn.unanswered = true; conn._shut(false); } }, ACK_TIMEOUT_MS);
    queueMicrotask(() => this._post({ k: 's', c: conn.id, to: 'h' }));  // after Link has attached handlers
    return conn;
  }

  close() {
    removeEventListener('pagehide', this._bye);
    for (const c of [...this.conns.values()]) c._shut(true);
    try { this.ch?.close(); } catch {}
    this.ch = null;
  }
}
