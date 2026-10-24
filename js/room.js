// Room layer: a conversation between up to MAX_MEMBERS browsers, built from one pairwise
// end-to-end encrypted Session per pair of people. No DOM access.
//
// How people get in:
//  1. The creator (host) listens on the room code with a lobby Session. A newcomer runs the
//     normal code-authenticated handshake against it, which proves they hold the full code.
//  2. The first newcomer is let in straight away (that's who the invite was for). After that
//     the host admits or denies each one.
//  3. On admission the host hands out fresh random pair codes, over encrypted channels only:
//     one for host <-> newcomer, and one for each existing member <-> newcomer. Every pair then
//     runs its own Session (own keys, own safety number, own reconnection) on its own code.
//
// What that gives: messages between two members are encrypted end to end between them; the
// host's browser never relays or decrypts them. The host does learn each pair code (it's the
// introducer), so a malicious host could try to sit in the middle of a pair — the two people's
// safety number for each other would then differ, which is what verifying catches.
import { Session, Emitter, uid } from './session.js';
import { generateCode, normalizeCode } from './protocol.js';

export const MAX_MEMBERS = 6;                 // including yourself
const ADMIT_TIMEOUT_MS = 3 * 60_000;          // a knock nobody answers is turned away
const PAIR_RETRIES = 10;                      // a pair's host may register a moment after we dial
const ID = /^[0-9a-f]{16}$/;

/**
 * Events (in addition to the ones the app already knows from Session, now carrying `from`):
 *  state {state}            signaling|waiting|dialing|knocking|ready|reconnecting|alone|failed|ended
 *  joined {}                the first pair connected: show the conversation
 *  waiting-admit {host}     joiner: the code was right; the host has to let you in
 *  denied {reason}          joiner: denied | full | timeout
 *  knock {kid,name,avatar}  host: someone with the code wants in
 *  knock-gone {kid}
 *  member-join {id,isHost}  a pair session was created (connecting)
 *  member-ready {id, safetyNumber, resumed, continuity, newPeer, first}
 *  member-state {id, state}
 *  member-left {id, reason, isHost}
 *  settings {canInvite}
 *  kicked {}                the host removed you
 *  message {from, …}        app messages; `from` is the pair the message arrived on (unforgeable)
 */
export class Room extends Emitter {
  constructor({ code, role, relayOnly = false, extraIce = [], sameDevice = true }) {
    super();
    const c = normalizeCode(code);
    if (!c) throw new Error('Invalid room code');
    this.code = c; this.role = role; this.isHost = role === 'host';
    this.pairOpts = { relayOnly, extraIce, sameDevice };
    this.myId = this.isHost ? uid() : null;
    this.hostId = this.myId;
    this.members = new Map();        // id → member
    this.knocks = new Map();         // host: kid → { kid, link, name, avatar, timer }
    this.canInvite = false;
    this.joined = false; this.ended = false; this.everAdmitted = false;
    this.state = 'idle'; this.shaping = false;
    this.profile = { name: '', avatar: '' };
    this.outFiles = new Map();       // afid → { size, per: Map<memberId, {fid, done, st}> }
    this.outFid = new Map();         // `${memberId}:${fid}` → afid
    this.inFiles = new Map();        // fid → memberId
    this.lobby = new Session({ code: c, role, relayOnly, extraIce, sameDevice, lobby: this.isHost });
    this.wireLobby();
  }

  // ── compatibility with code (and tests) written against a single Session ──
  get everReady() { return this.joined; }
  get expiresAt() { return this.lobby?.expiresAt; }
  get createdAt() { return this.lobby?.createdAt; }
  get roomKey() { return this.lobby?.roomKey; }
  get first() { for (const m of this.members.values()) if (m.everReady) return m; return this.members.values().next().value || null; }
  get active() { const m = [...this.members.values()].find((x) => x.s.active) ; return m ? m.s.active : null; }
  get safetyNumber() { return this.first?.s.safetyNumber; }
  get liveSafetyNumber() { return this.first?.s.liveSafetyNumber; }
  get locked() { return !!this.lobby?.locked; }
  memberIds() { return [...this.members.keys()]; }
  readyIds() { return [...this.members.values()].filter((m) => m.ready).map((m) => m.id); }
  count() { return this.members.size + 1; }

  setState(s) { if (this.state !== s) { this.state = s; this.emit('state', { state: s }); } }
  recalc() {
    if (this.ended) return this.setState('ended');
    if (!this.joined) return;
    if ([...this.members.values()].some((m) => m.ready)) return this.setState('ready');
    if (this.members.size) return this.setState('reconnecting');
    this.setState('alone');
  }

  async start() { await this.lobby.start(); }

  // ── the lobby: the room code's front door ──
  wireLobby() {
    const L = this.lobby;
    const pre = (ev) => L.on(ev, (d) => { if (!this.joined || ev === 'rejected') this.emit(ev, d); });
    for (const ev of ['link-open', 'hs-frame', 'signaling-down', 'relay-up', 'rejected']) pre(ev);
    L.on('wire', (d) => { if (!this.joined) this.emit('wire', d); });
    L.on('state', ({ state }) => { if (!this.joined && state !== 'ready') this.setState(state); });
    L.on('failed', (d) => { if (!this.joined && !this.lobbyDone) { this.setState('failed'); this.emit('failed', d); } });
    L.on('ended', ({ reason }) => {
      if (this.lobbyDone || this.ended) return;
      if (!this.joined && !this.members.size) this.destroy(reason === 'peer-left' ? 'host-left' : reason);
    });
    if (this.isHost) {
      L.on('knock', ({ link }) => this.onKnock(link));
      L.on('lobby-message', ({ link, o }) => this.onLobbyMessage(link, o));
      L.on('knock-gone', ({ link }) => {
        const k = link.kid && this.knocks.get(link.kid);
        if (k && !k.admitted) { clearTimeout(k.timer); this.knocks.delete(k.kid); this.emit('knock-gone', { kid: k.kid }); }
      });
    } else {
      L.on('ready', () => {
        this.setState('knocking');
        L.send({ t: 'knock', name: this.profile.name, avatar: this.profile.avatar });
      });
      L.on('message', (o) => this.onLobbyReply(o));
    }
  }

  // host
  onKnock(link) {
    const kid = uid();
    link.kid = kid;
    const k = { kid, link, name: '', avatar: '', admitted: false };
    k.timer = setTimeout(() => this.deny(kid, 'timeout'), ADMIT_TIMEOUT_MS);
    this.knocks.set(kid, k);
  }
  onLobbyMessage(link, o) {
    const k = link.kid && this.knocks.get(link.kid);
    if (!k || o.t !== 'knock' || k.announced) return;
    k.announced = true;
    k.name = typeof o.name === 'string' ? o.name : ''; k.avatar = typeof o.avatar === 'string' ? o.avatar : '';
    if (this.count() + this.admitting() >= MAX_MEMBERS) return this.deny(k.kid, 'full');
    if (!this.everAdmitted) return this.admit(k.kid);   // the person the invite was for
    link.sendJSON({ t: 'wait', host: this.profile.name }).catch(() => {});
    this.emit('knock', { kid: k.kid, name: k.name, avatar: k.avatar });
  }
  admitting() { return [...this.knocks.values()].filter((k) => k.admitted).length; }

  /** Host: let a waiting person in. */
  admit(kid) {
    const k = this.knocks.get(kid);
    if (!k || k.admitted || this.ended) return false;
    if (this.members.size + 1 >= MAX_MEMBERS) { this.deny(kid, 'full'); return false; }
    clearTimeout(k.timer);
    k.admitted = true;
    this.everAdmitted = true;
    this.lobby.lobbyUsed();
    const id = uid(), code = generateCode();
    const others = [...this.members.values()];
    const m = this.addMember(id, { code, role: 'host', isHost: false });
    m.knockKid = kid;
    k.link.sendJSON({ t: 'admit', id, host: this.myId, code, canInvite: this.canInvite }).catch(() => {});
    // Introduce the newcomer to everyone already here: one fresh code per pair. The existing
    // member hosts (they're already online); the newcomer dials once it's connected to us.
    for (const o of others) {
      const pc = generateCode();
      o.s.send({ t: 'room', op: 'pair', id, code: pc, role: 'host' });
      m.s.send({ t: 'room', op: 'pair', id: o.id, code: pc, role: 'joiner' });
    }
    this.syncLock();
    return true;
  }
  /** Host: turn someone away. */
  deny(kid, reason = 'denied') {
    const k = this.knocks.get(kid);
    if (!k || k.admitted) return;
    clearTimeout(k.timer);
    this.knocks.delete(kid);
    k.link.sendJSON({ t: 'deny', reason }).catch(() => {});
    setTimeout(() => k.link.close('denied'), 400);
    this.emit('knock-gone', { kid, reason });
  }
  /** Host: remove someone from the room. Everyone else hangs up on them too. */
  remove(id) {
    const m = this.members.get(id);
    if (!this.isHost || !m) return;
    for (const o of this.members.values()) if (o !== m) o.s.send({ t: 'room', op: 'remove', id });
    m.s.sendVolatile({ t: 'room', op: 'kicked' });
    this.dropMember(id, 'removed', true);
  }
  setCanInvite(on) {
    if (!this.isHost) return;
    this.canInvite = !!on;
    for (const m of this.members.values()) m.s.send({ t: 'room', op: 'settings', canInvite: this.canInvite });
    this.emit('settings', { canInvite: this.canInvite });
  }
  syncLock() { if (this.isHost && this.lobby) this.lobby.locked = this.members.size + 1 >= MAX_MEMBERS; }

  // joiner
  onLobbyReply(o) {
    if (this.joined && this.lobbyDone) return;
    if (o.t === 'wait') { this.setState('knocking'); this.emit('waiting-admit', { host: typeof o.host === 'string' ? o.host : '' }); return; }
    if (o.t === 'deny') { this.emit('denied', { reason: ['full', 'timeout'].includes(o.reason) ? o.reason : 'denied' }); this.destroy('denied'); return; }
    if (o.t === 'admit') {
      if (this.myId || !ID.test(o.id) || !ID.test(o.host) || !normalizeCode(o.code)) return;
      this.myId = o.id; this.hostId = o.host; this.canInvite = o.canInvite === true;
      this.setState('dialing');
      this.addMember(o.host, { code: o.code, role: 'joiner', isHost: true });
    }
  }

  // ── pairs ──
  addMember(id, { code, role, isHost }) {
    const s = new Session({ code, role, ...this.pairOpts });
    const m = { id, s, role, isHost, ready: false, everReady: false, attempts: 0 };
    this.members.set(id, m);
    if (this.shaping) s.setShaping(true);
    s.on('ready', (d) => {
      if (this.members.get(id) !== m) return;
      m.ready = true;
      const first = !this.joined;
      m.everReady = true;
      if (first) this.joined = true;
      this.recalc();
      // Joiner: connected to the host, so the lobby link has done its job.
      if (!this.isHost && isHost) this.closeLobby();
      if (this.isHost && m.knockKid) { const k = this.knocks.get(m.knockKid); if (k) { this.knocks.delete(m.knockKid); setTimeout(() => k.link.close('admitted'), 300); } m.knockKid = null; }
      if (first) this.emit('joined', {});
      this.emit('member-ready', { id, ...d, first });
    });
    s.on('state', ({ state }) => {
      if (this.members.get(id) !== m) return;
      if (state === 'reconnecting') m.ready = false;
      this.emit('member-state', { id, state });
      this.recalc();
    });
    s.on('failed', ({ code: f }) => {
      if (this.members.get(id) !== m || this.ended) return;
      // The other side may not have registered yet, or the network needs another go.
      if (role === 'joiner' && !m.everReady && m.attempts++ < PAIR_RETRIES && f !== 'auth-failed' && f !== 'unsupported') {
        setTimeout(() => { if (this.members.get(id) === m && !s.ended) s.retry(); }, 900 + m.attempts * 400);
        return;
      }
      // Joiner who never reached the host: say why and keep the pair for "Try again".
      if (!this.joined && isHost) { m.attempts = 0; this.setState('failed'); this.emit('failed', { code: f }); return; }
      this.dropMember(id, 'failed', true);
    });
    s.on('ended', ({ reason }) => { if (this.members.get(id) === m) this.dropMember(id, reason, false); });
    s.on('message', (o) => this.onPairMessage(m, o));
    s.on('delivered', ({ mid }) => this.emit('delivered', { mid, from: id }));
    s.on('latency', (d) => this.emit('latency', { ...d, from: id }));
    s.on('wire', (d) => this.emit('wire', d));
    s.on('rejected', (d) => this.emit('rejected', { ...d, pair: true }));
    s.on('file-in', (d) => { this.inFiles.set(d.fid, id); this.emit('file-in', { ...d, from: id }); });
    s.on('file-received', (d) => { this.inFiles.delete(d.fid); this.emit('file-received', { ...d, from: id }); });
    s.on('file-progress', (d) => (d.dir === 'out' ? this.outProgress(id, d) : this.emit('file-progress', { ...d, from: id })));
    s.on('file-sent', ({ fid }) => this.outSettled(id, fid, 'sent'));
    s.on('file-failed', (d) => {
      if (d.dir === 'out') return this.outSettled(id, d.fid, 'failed', d.reason);
      this.inFiles.delete(d.fid);
      this.emit('file-failed', { ...d, from: id });
    });
    this.emit('member-join', { id, isHost });
    s.start().catch((e) => { console.warn('[ghost] pair start', e); this.dropMember(id, 'failed', true); });
    this.syncLock();
    return m;
  }

  dropMember(id, reason, destroy) {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    if (destroy && !m.s.ended) { m.s._h?.clear?.(); if (reason === 'removed' || reason === 'local') m.s.end(); else m.s.destroy('local'); }
    for (const [afid, j] of this.outFiles) if (j.per.has(id) && j.per.get(id).st === 'sending') this.outSettled(id, j.per.get(id).fid, 'failed', 'they left');
    for (const [fid, from] of this.inFiles) if (from === id) { this.inFiles.delete(fid); this.emit('file-failed', { fid, dir: 'in', reason: 'they left', from: id }); }
    if (m.knockKid) this.knocks.delete(m.knockKid);
    this.syncLock();
    if (this.ended || this.leaving) return;
    if (this.isHost && !this.joined && !this.members.size) this.everAdmitted = false;   // the first invitee never arrived
    this.emit('member-left', { id, reason, isHost: m.isHost, wasReady: m.everReady });
    if (!this.joined) {
      // Joiner never got through to the host: nothing to stay for.
      if (!this.isHost && m.isHost) this.destroy(reason === 'peer-left' ? 'host-left' : 'lost');
      return;
    }
    // A member with nobody left can't do anything; the host stays so others can still ask in.
    if (!this.isHost && !this.members.size) return this.destroy(reason === 'removed' ? 'kicked' : 'peer-left');
    this.recalc();
  }

  closeLobby() {
    if (this.lobbyDone) return;
    this.lobbyDone = true;
    const L = this.lobby;
    this.lobby = null;
    try { L._h.clear(); L.destroy('local'); } catch {}
  }

  onPairMessage(m, o) {
    if (o.t === 'room') {
      if (!m.isHost || this.isHost) return;          // only the host directs the room
      switch (o.op) {
        case 'pair': {
          const code = normalizeCode(o.code);
          if (!ID.test(o.id) || !code || (o.role !== 'host' && o.role !== 'joiner')) return;
          if (o.id === this.myId || this.members.has(o.id) || this.members.size + 1 >= MAX_MEMBERS) return;
          this.addMember(o.id, { code, role: o.role, isHost: false });
          return;
        }
        case 'settings':
          this.canInvite = o.canInvite === true;
          this.emit('settings', { canInvite: this.canInvite });
          return;
        case 'remove':
          if (ID.test(o.id) && this.members.has(o.id)) this.dropMember(o.id, 'removed', true);
          return;
        case 'kicked':
          this.emit('kicked', {});
          this.destroy('kicked');
          return;
        case 'end':
          this.destroy('room-ended');
          return;
      }
      return;
    }
    this.emit('message', { ...o, from: m.id });
  }

  // ── outbound: one copy per pair ──
  /** Reliable: each pair queues it while disconnected. Returns the message id. */
  send(obj) {
    const mid = obj.mid || uid();
    for (const m of this.members.values()) m.s.send({ ...obj, mid });
    return mid;
  }
  sendTo(id, obj) { return this.members.get(id)?.s.send(obj); }
  sendVolatile(obj) { for (const m of this.members.values()) m.s.sendVolatile(obj); }
  isQueued(mid) { return [...this.members.values()].some((m) => m.s.isQueued(mid)); }
  setShaping(on) { this.shaping = !!on; for (const m of this.members.values()) m.s.setShaping(on); }
  async getRoute(id) {
    const m = id ? this.members.get(id) : [...this.members.values()].find((x) => x.ready);
    return m ? m.s.getRoute() : null;
  }
  extendInvite(ms) { return this.lobby?.extendInvite(ms); }
  retry() {
    const host = !this.isHost && this.hostId && this.members.get(this.hostId);
    if (host && !host.everReady) { this.setState('dialing'); host.s.retry(); return; }
    if (this.lobby && !this.joined) this.lobby.retry();
  }

  // files
  sendFile(file, meta = {}) {
    const ready = [...this.members.values()].filter((m) => m.s.state === 'ready');
    if (!ready.length) throw new Error('not connected');
    const afid = uid();
    const job = { size: file.size, per: new Map() };
    this.outFiles.set(afid, job);
    for (const m of ready) {
      const fid = m.s.sendFile(file, meta);
      job.per.set(m.id, { fid, done: 0, st: 'sending' });
      this.outFid.set(m.id + ':' + fid, afid);
    }
    return afid;
  }
  cancelFile(id) {
    const job = this.outFiles.get(id);
    if (job) { for (const [mid, p] of job.per) this.members.get(mid)?.s.cancelFile(p.fid); return; }
    const from = this.inFiles.get(id);
    if (from) this.members.get(from)?.s.cancelFile(id);
  }
  outProgress(memberId, { fid, done, size }) {
    const afid = this.outFid.get(memberId + ':' + fid);
    const job = afid && this.outFiles.get(afid);
    if (!job) return;
    job.per.get(memberId).done = done;
    const live = [...job.per.values()].filter((p) => p.st !== 'failed');
    const avg = live.length ? live.reduce((a, p) => a + p.done, 0) / live.length : 0;
    this.emit('file-progress', { fid: afid, dir: 'out', done: Math.round(avg), size });
  }
  outSettled(memberId, fid, st, reason) {
    const key = memberId + ':' + fid;
    const afid = this.outFid.get(key);
    const job = afid && this.outFiles.get(afid);
    if (!job) return;
    const p = job.per.get(memberId);
    if (!p || p.st !== 'sending') return;
    p.st = st; p.reason = reason;
    this.outFid.delete(key);
    const all = [...job.per.values()];
    if (all.some((x) => x.st === 'sending')) return;
    this.outFiles.delete(afid);
    const sent = all.filter((x) => x.st === 'sent').length;
    if (sent) this.emit('file-sent', { fid: afid, sent, total: all.length });
    else this.emit('file-failed', { fid: afid, dir: 'out', reason: all.find((x) => x.reason)?.reason || 'failed' });
  }

  // ── teardown ──
  quickBye() { for (const m of this.members.values()) m.s.quickBye(); }
  /** Leave. The host can end the room for everyone instead. */
  async end({ forAll = false } = {}) {
    if (this.ended) return;
    this.leaving = true;
    if (forAll && this.isHost) for (const m of this.members.values()) m.s.send({ t: 'room', op: 'end' });
    await Promise.all([...this.members.values()].map((m) => m.s.end().catch(() => {})));
    this.destroy('local');
  }
  destroy(reason) {
    if (this.ended) return;
    this.ended = true;
    for (const k of this.knocks.values()) clearTimeout(k.timer);
    this.knocks.clear();
    try { this.lobby?.destroy('local'); } catch {}
    for (const m of this.members.values()) { try { m.s.destroy('local'); } catch {} }
    this.members.clear(); this.outFiles.clear(); this.outFid.clear(); this.inFiles.clear();
    this.setState('ended');
    this.emit('ended', { reason });
  }
}
