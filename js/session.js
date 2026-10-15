// Session layer: PeerJS transport + authenticated handshake + reliable delivery,
// reconnection, heartbeats and file streaming. No DOM access.
import * as P from './protocol.js';
import { SIGNALING, ICE_SERVERS, LIMITS } from './config.js';

// PeerJS's built-in defaults, spelled out so relay-only mode can reuse them.
const DEFAULT_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
];

const FILE_CHUNK = 60 * 1024;           // fits the 64 KiB padding bucket with header room
const BUFFER_HIGH = 2 * 1024 * 1024;    // pause file streaming above this many queued bytes
const MAX_PENDING_HANDSHAKES = 3;
const RETRY_DELAYS = [800, 1500, 2500, 4000, 6000, 8000, 10000];
// Constant-rate traffic: one identically sized frame every slot, real or dummy.
const SHAPE_SLOT_MS = 250;
const SHAPE_BUCKET = 4096;
const FRAG_DATA = SHAPE_BUCKET - 5 - 8;   // fragment header: id u32, index u16, count u16
const MAX_FRAGS = 16;
const MAX_CANDIDATES = 4;
const MAX_RESUME_REFUSALS = 4;
// A tiny worker keeps the constant-rate clock steady in background tabs, where browsers
// throttle main-thread timers (which would reveal that the tab is hidden).
const CLOCK_SRC = 'let t;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}';
const te = new TextEncoder();

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
export const uid = () => hex(crypto.getRandomValues(new Uint8Array(8)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Emitter {
  constructor() { this._h = new Map(); }
  on(t, f) { if (!this._h.has(t)) this._h.set(t, new Set()); this._h.get(t).add(f); return () => this._h.get(t).delete(f); }
  emit(t, d) { for (const f of this._h.get(t) || []) { try { f(d); } catch (e) { console.error('[ghost] handler', t, e); } } }
}

/** One WebRTC data channel, from handshake to close. */
class Link {
  constructor(session, conn, role) {
    this.s = session; this.conn = conn; this.role = role;
    // Host: whether the room is locked, and which resumption secrets are acceptable, is decided
    // when the HELLO arrives (policy callback, fresh copies), not when the connection opened.
    // Joiner: a browser that has been connected before resumes with its (copied) secret.
    this.hs = new P.Handshake(role, session.roomKey, role === 'host'
      ? { policy: () => session.policy() }
      : { resumeSecret: session.resumeSecret });
    this.channel = null; this.closed = false; this.lastRx = Date.now();
    this.inq = Promise.resolve(); this.outq = Promise.resolve();
    this.hsTimer = setTimeout(() => { if (!this.channel) this.close('handshake-timeout'); }, LIMITS.handshakeTimeoutMs);

    conn.on('open', async () => {
      session.emit('link-open', { role });
      if (role === 'joiner') {
        try { this.rawSend(await this.hs.start()); } catch (e) { this.close('handshake-error'); }
      }
    });
    conn.on('data', (d) => { this.inq = this.inq.then(() => this.onData(d)); });
    conn.on('close', () => this.close('closed'));
    conn.on('error', () => this.close('error'));
  }

  async onData(d) {
    if (this.closed) return;
    let bytes;
    if (d instanceof ArrayBuffer || ArrayBuffer.isView(d)) bytes = P.toBytes(d);
    else if (typeof Blob !== 'undefined' && d instanceof Blob) bytes = new Uint8Array(await d.arrayBuffer());
    else return this.close('protocol'); // text frames are never valid
    if (bytes.length > P.MAX_FRAME) return this.close('protocol');
    this.lastRx = Date.now();

    if (!this.channel) {
      try {
        const r = await this.hs.receive(bytes);
        if (r.send) {
          if (this.role === 'host') {
            this.sentChallenge = true;
            if (this.hs?.candidate) this.s.addCandidate(this.hs.candidate.slice(), this.hs.candidateContinuity);
          }
          this.rawSend(r.send);
        }
        if (r.done) {
          clearTimeout(this.hsTimer);
          this.hs = null; // handshake state is wiped inside protocol; drop the reference too
          this.channel = new P.SecureChannel(r.done);
          this.done = { safetyNumber: r.done.safetyNumber, resumed: r.done.resumed, resumeSecret: r.done.resumeSecret };
          this.s._linkReady(this);
        }
      } catch (e) {
        if (e.send) { try { this.rawSend(e.send); } catch {} }
        const reason = e.code === 'auth-failed' || e.code === 'locked' ? e.code : 'handshake-error';
        this.refused = reason; // the peer may hang up first; remember why we refused
        // let the LOCKED frame flush before the channel closes
        if (e.send) setTimeout(() => this.close(reason), 150); else this.close(reason);
      }
      return;
    }
    let frame;
    try { frame = await this.channel.open(bytes); }
    catch (e) { console.warn('[ghost] protocol violation:', e.message); return this.close('protocol'); }
    this.s._onFrame(this, frame.kind, frame.payload);
  }

  rawSend(bytes) { if (!this.closed) this.conn.send(bytes); }

  /** Seal + send, strictly in order, with backpressure. */
  sendFrame(kind, payload, minSize = 0) {
    const job = this.outq.then(async () => {
      if (this.closed || !this.channel) throw new Error('link closed');
      const f = await this.channel.seal(kind, payload, minSize);
      if (this.closed) throw new Error('link closed');
      this.conn.send(f);
    });
    this.outq = job.catch(() => {});
    return job;
  }
  sendJSON(o) { return this.sendFrame(P.KIND_JSON, te.encode(JSON.stringify(o))); }

  buffered() {
    const dc = this.conn.dataChannel;
    return (dc ? dc.bufferedAmount : 0) + (this.conn.bufferSize || 0) * FILE_CHUNK;
  }
  async drain() {
    while (!this.closed && this.buffered() > BUFFER_HIGH) await sleep(15);
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.hsTimer);
    this.channel?.destroy();
    try { this.conn.close(); } catch {}
    this.s._linkClosed(this, reason);
  }
}

/**
 * Events:
 *  state {state}                       idle|signaling|waiting|dialing|ready|reconnecting|ended|failed
 *  ready {safetyNumber, resumed, continuity, newPeer}
 *                                      continuity: reconnect proved it is the same browser as before
 *                                      newPeer: someone joined fresh after the host unlocked the room
 *  message {…app payload}              msg/read/react/unsend/timer/typing/profile
 *  delivered {mid}
 *  latency {ms}
 *  rejected {count, locked}            host: refused attempts (wrong code, or right code but room locked)
 *  failed {code}                       not-found | auth-failed | locked | signaling | room-taken | unsupported | timeout
 *  file-in / file-progress / file-received / file-failed / file-sent
 *  ended {reason}                      local | peer-left | lost | resume-failed
 */
export class Session extends Emitter {
  constructor({ code, role, relayOnly = false }) {
    super();
    const c = P.normalizeCode(code);
    if (!c) throw new Error('Invalid room code');
    this.code = c; this.role = role; this.relayOnly = relayOnly;
    this.roomId = P.roomIdFromCode(c);
    this.state = 'idle';
    this.peer = null; this.active = null; this.pending = new Set();
    this.everReady = false; this.ended = false;
    this.outbox = new Map(); this.seenMids = new Set();
    this.incoming = new Map(); this.outgoing = []; this.sendingFile = null;
    this.rejected = 0; this.retryIdx = 0; this.lostAt = 0;
    this.pingSeq = 0; this.pings = new Map();
    this.locked = false; this.resumeSecret = null; this.candidates = []; this.resumeRefusals = 0;
    this.frag = null;
    this.shaping = false; this.shapeQ = []; this.shapeTimer = 0;
  }

  setState(s) { if (this.state !== s) { this.state = s; this.emit('state', { state: s }); } }

  async start() {
    if (typeof window === 'undefined' || !window.Peer) { this.fail('unsupported'); return; }
    if (!window.RTCPeerConnection || !crypto?.subtle) { this.fail('unsupported'); return; }
    this.roomKey = await P.deriveRoomKey(this.code);
    this.setState('signaling');
    const opts = {
      host: SIGNALING.host, port: SIGNALING.port, path: SIGNALING.path, secure: SIGNALING.secure, key: SIGNALING.key,
      debug: 0,
      config: { iceServers: ICE_SERVERS || DEFAULT_ICE, ...(this.relayOnly ? { iceTransportPolicy: 'relay' } : {}) },
    };
    this.peer = this.role === 'host' ? new window.Peer(this.roomId, opts) : new window.Peer(opts);
    this.peer.on('open', () => {
      if (this.ended) return;
      if (this.role === 'host') { if (!this.everReady) this.setState('waiting'); }
      else if (!this.active || this.active.closed) this.dial();
    });
    this.peer.on('connection', (conn) => this.accept(conn));
    this.peer.on('disconnected', () => {
      if (this.ended || this.peer.destroyed) return;
      setTimeout(() => { if (!this.ended && this.peer && this.peer.disconnected && !this.peer.destroyed) { try { this.peer.reconnect(); } catch {} } }, 2000);
    });
    this.peer.on('error', (err) => this.onPeerError(err));
    this.heartbeat = setInterval(() => this.tick(), LIMITS.pingIntervalMs);
  }

  onPeerError(err) {
    if (this.ended) return;
    const t = err && err.type;
    if (t === 'unavailable-id') return this.fail('room-taken');
    if (t === 'browser-incompatible') return this.fail('unsupported');
    if (t === 'peer-unavailable') {
      if (!this.everReady) return this.fail('not-found');
      return this.scheduleRetry();
    }
    if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(t)) {
      if (!this.everReady && (this.state === 'signaling' || this.state === 'dialing')) return this.fail('signaling');
      if (this.role === 'joiner' && this.state === 'reconnecting') this.scheduleRetry();
      return;
    }
    console.warn('[ghost] peer error', t);
  }

  // ── host side ──
  accept(conn) {
    if (this.ended || this.role !== 'host' || conn.serialization !== 'raw') { try { conn.close(); } catch {} return; }
    // Evict the oldest pending handshake rather than refusing the newcomer, so someone who
    // knows only the public room ID can't block the real peer by holding handshakes open.
    if (this.pending.size >= MAX_PENDING_HANDSHAKES) {
      const oldest = this.pending.values().next().value;
      oldest?.close('evicted');
    }
    this.pending.add(new Link(this, conn, 'host'));
  }

  // ── joiner side ──
  dial() {
    if (this.ended || this.role !== 'joiner') return;
    if (this.active && !this.active.closed) return;
    if (!this.peer || this.peer.destroyed) return;
    if (this.peer.disconnected) { try { this.peer.reconnect(); } catch {} return; } // 'open' will call dial again
    if (!this.everReady) this.setState('dialing');
    const conn = this.peer.connect(this.roomId, { reliable: true, serialization: 'raw' });
    if (!conn) return this.scheduleRetry();
    const link = new Link(this, conn, 'joiner');
    this.pending.add(link);
  }

  scheduleRetry() {
    if (this.ended || this.role !== 'joiner' || !this.everReady) return;
    clearTimeout(this.retryTimer);
    const d = RETRY_DELAYS[Math.min(this.retryIdx++, RETRY_DELAYS.length - 1)];
    this.retryTimer = setTimeout(() => this.dial(), d);
  }

  /** Retry the initial connection after a failure (joiner). */
  retry() {
    if (this.ended || this.role !== 'joiner') return;
    this.setState('dialing');
    if (this.peer?.open) this.dial();
    else if (this.peer && !this.peer.destroyed) { try { this.peer.reconnect(); } catch {} }
  }

  /** Host: let one more first-time join in with the room code (e.g. the peer reloaded and lost its keys). */
  unlock() { if (this.role === 'host') this.locked = false; }

  /** Host policy, evaluated when a HELLO arrives. Returns copies the handshake may wipe. */
  policy() {
    const secrets = [];
    if (this.resumeSecret) secrets.push({ secret: this.resumeSecret.slice(), continuity: true });
    for (const c of this.candidates) secrets.push({ secret: c.secret.slice(), continuity: c.continuity });
    return { locked: this.locked, secrets };
  }
  /** Host: remember the secret an in-flight handshake would commit, in case its CONFIRM is lost. */
  addCandidate(secret, continuity) {
    this.candidates.push({ secret, continuity: !!continuity });
    while (this.candidates.length > MAX_CANDIDATES) this.candidates.shift().secret.fill(0);
  }

  _linkReady(link) {
    if (this.ended) return link.close('ended');
    this.pending.delete(link);
    const old = this.active;
    this.active = link;
    if (old && old !== link) {
      this.shapeQ = []; this.frag = null;   // fragments queued for the old link must not start mid-message here
      old.close('replaced');
      // The previous link died without us noticing: anything in flight on it is gone.
      this.failTransfers('connection lost');
      this.emit('message', { t: 'typing', on: false });
    }
    const resumed = this.everReady;
    const { safetyNumber, resumeSecret } = link.done;
    const continuity = link.done.resumed && this.everReady;   // the first-ever ready is never "continuity"
    this.resumeSecret?.fill(0);
    this.resumeSecret = resumeSecret;          // rotates on every successful (re)connection
    for (const c of this.candidates) c.secret.fill(0);
    this.candidates = [];
    this.resumeRefusals = 0;
    this.liveSafetyNumber = safetyNumber;
    if (this.role === 'host') {
      this.locked = true;
      // Anything still mid-handshake started under the old state: drop it.
      for (const l of [...this.pending]) l.close('superseded');
    }
    // A proven resume keeps the original safety number: the reconnecting browser showed it
    // holds a secret only the original two had. A fresh join gets a new one.
    if (!continuity) this.safetyNumber = safetyNumber;
    this.everReady = true; this.retryIdx = 0; this.lostAt = 0;
    clearTimeout(this.retryTimer); clearTimeout(this.lostTimer);
    this.setState('ready');
    this.emit('ready', { safetyNumber: this.safetyNumber, resumed, continuity, newPeer: resumed && !continuity });
    for (const o of this.outbox.values()) this.transmit(o);
  }

  _linkClosed(link, reason) {
    if (link.refused) reason = link.refused;
    this.pending.delete(link);
    if (this.ended) return;
    // Host: a joiner that received our MAC but never confirmed could not prove the code.
    const hostRefused = this.role === 'host' && link !== this.active && !link.channel && reason !== 'evicted' && reason !== 'superseded'
      && (reason === 'auth-failed' || reason === 'locked' || link.sentChallenge);
    if (hostRefused) { this.rejected++; this.emit('rejected', { count: this.rejected, locked: reason === 'locked' }); }
    if (this.role === 'joiner' && (reason === 'auth-failed' || reason === 'locked')) {
      if (!this.everReady) return this.fail(reason);
      // A refusal during a resume may be forged (LOCKED frames are unauthenticated), so keep
      // trying within the reconnect window. Never fall back to a fresh join.
      if (++this.resumeRefusals >= MAX_RESUME_REFUSALS) return this.destroy('resume-failed');
      if (!this.active) this.scheduleRetry();
      return;
    }
    if (link !== this.active) {
      if (this.role === 'joiner' && !this.active) {
        if (!this.everReady && reason !== 'auth-failed' && this.state !== 'failed') return this.fail(reason === 'handshake-timeout' ? 'timeout' : 'not-found');
        if (this.everReady) this.scheduleRetry();
      }
      return;
    }
    this.active = null;
    this.shapeQ = []; this.frag = null;   // reliable items come back from the outbox after reconnecting
    this.failTransfers('connection lost');
    this.emit('message', { t: 'typing', on: false });
    this.setState('reconnecting');
    this.lostAt = Date.now();
    clearTimeout(this.lostTimer);
    this.lostTimer = setTimeout(() => { if (!this.active) this.destroy('lost'); }, LIMITS.reconnectWindowMs);
    if (this.role === 'joiner') this.scheduleRetry();
  }

  fail(code) {
    if (this.ended) return;
    this.setState('failed');
    this.emit('failed', { code });
  }

  tick() {
    const l = this.active;
    if (!l || l.closed || !l.channel) return;
    if (Date.now() - l.lastRx > LIMITS.deadAfterMs) return l.close('timeout');
    const k = ++this.pingSeq;
    this.pings.set(k, performance.now());
    if (this.pings.size > 20) this.pings.delete(this.pings.keys().next().value);
    this.transmit({ t: 'ping', k });
  }

  // ── constant-rate traffic ──
  /** Every SHAPE_SLOT_MS one SHAPE_BUCKET-sized frame goes out: the next queued message or a dummy. */
  setShaping(on) {
    // Re-send what was waiting, in the new mode (a half-sent fragmented message restarts at
    // fragment 0, which the receiver accepts as a new message).
    const pending = [...new Set(this.shapeQ.filter((i) => i.obj).map((i) => i.obj))];
    this.shaping = !!on;
    this.stopClock();
    this.shapeQ = [];
    if (this.shaping) this.startClock();
    for (const o of pending) this.transmit(o);
  }
  startClock() {
    try {
      const url = URL.createObjectURL(new Blob([CLOCK_SRC], { type: 'text/javascript' }));
      this.clock = new Worker(url);
      URL.revokeObjectURL(url);
      this.clock.onmessage = () => this.shapeTick();
      this.clock.postMessage(SHAPE_SLOT_MS);
    } catch {
      this.clock = null;
      this.shapeTimer = setInterval(() => this.shapeTick(), SHAPE_SLOT_MS); // fallback: may slow in background tabs
    }
  }
  stopClock() {
    if (this.clock) { try { this.clock.terminate(); } catch {} this.clock = null; }
    clearInterval(this.shapeTimer); this.shapeTimer = 0;
  }
  shapeTick() {
    const l = this.active;
    if (!l?.channel || l.closed) return;
    const item = this.shapeQ.shift() || { kind: P.KIND_JSON, bytes: te.encode('{"t":"_"}') };
    l.sendFrame(item.kind, item.bytes, SHAPE_BUCKET).catch(() => {});
  }
  /**
   * All JSON traffic goes through here. In constant-rate mode it is queued for the next slot;
   * anything larger than one slot is split into fragments, so every frame is exactly one bucket.
   */
  transmit(obj) {
    const l = this.active;
    if (!l?.channel || l.closed) return;
    if (!this.shaping) { l.sendJSON(obj).catch(() => {}); return; }
    if (this.shapeQ.length > 4000) return; // a peer that never reads: shed load rather than grow forever
    const bytes = te.encode(JSON.stringify(obj));
    if (bytes.length + 5 <= SHAPE_BUCKET) { this.shapeQ.push({ kind: P.KIND_JSON, bytes, obj }); return; }
    const n = Math.ceil(bytes.length / FRAG_DATA);
    if (n > MAX_FRAGS) return;
    const id = crypto.getRandomValues(new Uint32Array(1))[0];
    for (let i = 0; i < n; i++) {
      const head = new Uint8Array(8), dv = new DataView(head.buffer);
      dv.setUint32(0, id, false); dv.setUint16(4, i, false); dv.setUint16(6, n, false);
      this.shapeQ.push({ kind: P.KIND_FRAG, bytes: P.concat(head, bytes.subarray(i * FRAG_DATA, (i + 1) * FRAG_DATA)), obj });
    }
  }
  /** Reassembles fragments (strictly in order on the ordered channel). Returns JSON bytes when complete. */
  onFragment(link, payload) {
    if (payload.length < 9) return link.close('protocol');
    const dv = new DataView(payload.buffer, payload.byteOffset, 8);
    const id = dv.getUint32(0, false), i = dv.getUint16(4, false), n = dv.getUint16(6, false);
    if (n < 2 || n > MAX_FRAGS || i >= n) return link.close('protocol');
    if (i === 0) this.frag = { id, n, parts: [] };
    const f = this.frag;
    if (!f || f.id !== id || f.n !== n || f.parts.length !== i) { this.frag = null; return link.close('protocol'); }
    f.parts.push(payload.slice(8));
    if (f.parts.length < n) return null;
    this.frag = null;
    return P.concat(...f.parts);
  }

  // ── inbound ──
  _onFrame(link, kind, payload) {
    if (link !== this.active) return;
    if (kind === P.KIND_BIN) return this.onChunk(payload);
    if (kind === P.KIND_FRAG) { const whole = this.onFragment(link, payload); if (whole) this._onFrame(link, P.KIND_JSON, whole); return; }
    if (kind !== P.KIND_JSON) return link.close('protocol');
    let o;
    try { o = P.decodeJSON(payload); } catch { return link.close('protocol'); }
    switch (o.t) {
      case '_': return; // constant-rate filler
      case 'ping': this.transmit({ t: 'pong', k: o.k }); return;
      case 'pong': {
        const t0 = this.pings.get(o.k);
        if (t0 !== undefined) { this.pings.delete(o.k); this.emit('latency', { ms: Math.round(performance.now() - t0) }); }
        return;
      }
      case 'ack':
        if (Array.isArray(o.mids)) for (const m of o.mids.slice(0, 100)) {
          if (typeof m === 'string' && this.outbox.delete(m)) this.emit('delivered', { mid: m });
        }
        return;
      case 'bye': this.destroy('peer-left'); return;
      case 'file': return this.onFileOffer(o);
      case 'file-end': return this.onFileEnd(o);
      case 'file-abort': return this.onFileAbort(o);
    }
    if (typeof o.mid === 'string' && /^[0-9a-f]{16}$/.test(o.mid)) {
      this.transmit({ t: 'ack', mids: [o.mid] });
      if (this.seenMids.has(o.mid)) return; // duplicate after a resend
      this.seenMids.add(o.mid);
      if (this.seenMids.size > 50_000) this.seenMids.delete(this.seenMids.values().next().value);
    }
    this.emit('message', o);
  }

  // ── outbound ──
  /** Reliable: queued while disconnected, resent after reconnect until acknowledged. Returns mid. */
  send(obj) {
    const o = { ...obj, mid: obj.mid || uid() };
    this.outbox.set(o.mid, o);
    this.transmit(o);
    return o.mid;
  }
  /** Best-effort (typing indicators): dropped when offline. */
  sendVolatile(obj) { this.transmit(obj); }
  isQueued(mid) { return this.outbox.has(mid); }

  /** 'direct' | 'local' | 'relay' | null — which ICE path the live link uses. */
  async getRoute() {
    const pc = this.active?.conn?.peerConnection;
    if (!pc) return null;
    try {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
      });
      if (!pair) stats.forEach((r) => { if (!pair && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
      const local = pair && stats.get(pair.localCandidateId);
      const remote = pair && stats.get(pair.remoteCandidateId);
      if (!local) return null;
      if (local.candidateType === 'relay' || remote?.candidateType === 'relay') return 'relay';
      if (local.candidateType === 'host' && remote?.candidateType === 'host') return 'local';
      return 'direct';
    } catch { return null; }
  }

  // ── files ──
  sendFile(file, meta = {}) {
    if (file.size > LIMITS.maxFile) throw new Error('too-large');
    const fid = uid();
    const job = { fid, file, meta, cancelled: false };
    this.outgoing.push(job);
    this.pumpFiles();
    return fid;
  }
  cancelFile(fid) {
    const j = this.outgoing.find((x) => x.fid === fid) || (this.sendingFile?.fid === fid ? this.sendingFile : null);
    if (j) j.cancelled = true;
    const inc = this.incoming.get(fid);
    if (inc) {
      this.incoming.delete(fid);
      this.sendVolatile({ t: 'file-abort', fid });
      this.emit('file-failed', { fid, dir: 'in', reason: 'cancelled' });
    }
  }

  async pumpFiles() {
    if (this.sendingFile) return;
    while (this.outgoing.length) {
      const job = this.sendingFile = this.outgoing.shift();
      try { await this.streamFile(job); }
      catch (e) { this.emit('file-failed', { fid: job.fid, dir: 'out', reason: job.cancelled ? 'cancelled' : (e.message || 'failed') }); }
      this.sendingFile = null;
    }
  }

  async streamFile(job) {
    const link = this.active;
    if (!link?.channel) throw new Error('not connected');
    const { fid, file } = job;
    const name = String(file.name || 'file').slice(0, 255);
    await link.sendJSON({ t: 'file', fid, name, size: file.size, mime: String(file.type || '').slice(0, 100), ...job.meta });
    const idb = unhex(fid);
    let off = 0, seq = 0, lastEmit = 0;
    while (off < file.size) {
      if (job.cancelled) { link.sendJSON({ t: 'file-abort', fid }).catch(() => {}); throw new Error('cancelled'); }
      if (link.closed || link !== this.active) throw new Error('connection lost');
      const data = new Uint8Array(await file.slice(off, off + FILE_CHUNK).arrayBuffer());
      const hdr = new Uint8Array(12); hdr.set(idb, 0); new DataView(hdr.buffer).setUint32(8, seq++, false);
      await link.drain();
      await link.sendFrame(P.KIND_BIN, P.concat(hdr, data));
      off += data.length;
      const now = performance.now();
      if (now - lastEmit > 120 || off >= file.size) { lastEmit = now; this.emit('file-progress', { fid, dir: 'out', done: off, size: file.size }); }
    }
    await link.sendJSON({ t: 'file-end', fid, chunks: seq });
    this.emit('file-sent', { fid });
  }

  onFileOffer(o) {
    const ok = typeof o.fid === 'string' && /^[0-9a-f]{16}$/.test(o.fid) && !this.incoming.has(o.fid)
      && typeof o.name === 'string' && Number.isSafeInteger(o.size) && o.size >= 0 && o.size <= LIMITS.maxFile
      && this.incoming.size < LIMITS.maxIncomingFiles;
    if (!ok) { if (typeof o.fid === 'string') this.sendVolatile({ t: 'file-abort', fid: String(o.fid).slice(0, 16) }); return; }
    const rec = { fid: o.fid, name: o.name.slice(0, 255), size: o.size, mime: typeof o.mime === 'string' ? o.mime.slice(0, 100) : '', chunks: [], got: 0, seq: 0, lastEmit: 0, meta: o };
    this.incoming.set(o.fid, rec);
    this.emit('file-in', { fid: rec.fid, name: rec.name, size: rec.size, mime: rec.mime, meta: o });
  }

  onChunk(payload) {
    if (payload.length < 12) return this.active?.close('protocol');
    const fid = hex(payload.subarray(0, 8));
    const seq = new DataView(payload.buffer, payload.byteOffset + 8, 4).getUint32(0, false);
    const rec = this.incoming.get(fid);
    if (!rec) return; // cancelled/aborted transfer — ignore trailing chunks
    const data = payload.slice(12);
    if (seq !== rec.seq || rec.got + data.length > rec.size) return this.abortIncoming(rec, 'corrupt transfer');
    rec.seq++; rec.got += data.length; rec.chunks.push(data);
    const now = performance.now();
    if (now - rec.lastEmit > 120 || rec.got === rec.size) { rec.lastEmit = now; this.emit('file-progress', { fid, dir: 'in', done: rec.got, size: rec.size }); }
  }

  onFileEnd(o) {
    const rec = this.incoming.get(o.fid);
    if (!rec) return;
    this.incoming.delete(o.fid);
    if (rec.got !== rec.size || o.chunks !== rec.seq) return this.emit('file-failed', { fid: rec.fid, dir: 'in', reason: 'incomplete transfer' });
    const blob = new Blob(rec.chunks, { type: 'application/octet-stream' });
    rec.chunks = null;
    this.emit('file-received', { fid: rec.fid, name: rec.name, size: rec.size, mime: rec.mime, blob, meta: rec.meta });
  }

  onFileAbort(o) {
    const rec = this.incoming.get(o.fid);
    if (rec) { this.incoming.delete(o.fid); this.emit('file-failed', { fid: rec.fid, dir: 'in', reason: 'cancelled by sender' }); }
    const out = this.sendingFile?.fid === o.fid ? this.sendingFile : this.outgoing.find((j) => j.fid === o.fid);
    if (out) out.cancelled = true;
  }

  abortIncoming(rec, reason) {
    this.incoming.delete(rec.fid);
    this.sendVolatile({ t: 'file-abort', fid: rec.fid });
    this.emit('file-failed', { fid: rec.fid, dir: 'in', reason });
  }

  failTransfers(reason) {
    for (const rec of this.incoming.values()) this.emit('file-failed', { fid: rec.fid, dir: 'in', reason });
    this.incoming.clear();
    for (const j of this.outgoing) this.emit('file-failed', { fid: j.fid, dir: 'out', reason });
    this.outgoing = [];
  }

  // ── teardown ──
  async end() {
    if (this.ended) return;
    const l = this.active;
    if (l?.channel && !l.closed) {
      try { await Promise.race([l.sendJSON({ t: 'bye' }), sleep(400)]); await sleep(120); } catch {}
    }
    this.destroy('local');
  }

  destroy(reason) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.heartbeat); this.stopClock(); clearTimeout(this.retryTimer); clearTimeout(this.lostTimer);
    this.shapeQ = []; this.frag = null;
    this.resumeSecret?.fill(0); this.resumeSecret = null;
    for (const c of this.candidates) c.secret.fill(0);
    this.candidates = [];
    for (const l of [...this.pending, this.active]) if (l) { try { l.close('ended'); } catch {} }
    this.pending.clear(); this.active = null;
    try { this.peer?.destroy(); } catch {}
    this.peer = null;
    this.incoming.clear(); this.outgoing = []; this.outbox.clear(); this.seenMids.clear();
    if (this.roomKey) this.roomKey.fill(0);
    this.setState('ended');
    this.emit('ended', { reason });
  }
}
