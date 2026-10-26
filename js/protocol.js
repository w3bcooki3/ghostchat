// Ghost Chat wire protocol v3 — pure crypto, no DOM, no network.
// Runs in browsers and in Node >= 20 (globalThis.crypto.subtle).
//
// Summary (SECURITY.md has the full specification and threat model):
//   * Room code: 20 random base32 characters (100 bits). The first 5 name the signaling
//     room; the full code is a pre-shared secret that is never sent anywhere.
//   * Handshake: hybrid key exchange — ephemeral ECDH P-384 + ML-KEM-1024 (FIPS 203) —
//     both secrets fed to HKDF-SHA-384 salted with the room key, then two-way key
//     confirmation with HMAC-SHA-384. Breaking it requires breaking BOTH primitives and
//     knowing the room code.
//   * Pair lock + resumption: the first handshake yields a resumption secret known only to
//     the two original browsers. After that the pair only accepts reconnects that prove it,
//     so its pair code alone no longer gets anyone in. (A room's invite code is a separate,
//     single-use lobby code: see room.js.)
//   * Messages: AES-256-GCM with a fresh key per message from a per-direction HMAC-SHA-384
//     hash ratchet; strict counters bound as AAD (replay/reorder/drop/tamper → teardown);
//     plaintext padded to fixed buckets.
import { ml_kem1024 } from '../vendor/noble-ml-kem1024-0.7.1.min.js';

const subtle = globalThis.crypto.subtle;
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

export const VERSION = 3;
export const MAGIC = 0x47;   // 'G'
export const T_HELLO = 0x03; // v3 hello (v2 used 0x01; mixed versions fail fast)
export const T_CONFIRM = 0x02;
export const T_LOCKED = 0x04;
export const T_DATA = 0x10;
// Instant goodbye: MAGIC ‖ T_BYE ‖ 32-byte token. Each side picks a random token and gives it
// to the other INSIDE the encrypted channel; presenting it later ends the session at once.
// It is sent unencrypted because it must go out synchronously while a page is being torn
// down, which async WebCrypto can't guarantee. Only the peer can know the token, it's
// compared in constant time, and it is single-use (it ends the session), so a network
// attacker can neither forge nor usefully replay it.
export const T_BYE = 0x05;
export const BYE_TOKEN_LEN = 32;

export const KIND_JSON = 1;
export const KIND_BIN = 2;
export const KIND_FRAG = 3;   // a piece of a JSON message split for constant-rate mode

export const PAD_BUCKETS = [256, 1024, 4096, 16384, 65536];
export const MAX_PLAINTEXT = PAD_BUCKETS[PAD_BUCKETS.length - 1] - 5;
const HDR = 6, IVLEN = 12, TAGLEN = 16;
export const MAX_FRAME = HDR + IVLEN + PAD_BUCKETS[PAD_BUCKETS.length - 1] + TAGLEN;

const CURVE = 'P-384';
const HASH = 'SHA-384';
const PK_LEN = 97;          // uncompressed P-384 point
const KEM_PK = 1568;        // ML-KEM-1024 encapsulation key
const KEM_CT = 1568;        // ML-KEM-1024 ciphertext
const NONCE_LEN = 32;
const KEYID_LEN = 8;        // names which resumption secret a resume uses (hash, reveals nothing)
const MAC_LEN = 48;         // HMAC-SHA-384
const K = 48;               // key/chain length
const J_HELLO_LEN = 3 + 1 + KEYID_LEN + NONCE_LEN + PK_LEN + KEM_PK;
const H_HELLO_LEN = 3 + NONCE_LEN + PK_LEN + KEM_CT + MAC_LEN;

export class ProtocolError extends Error {
  constructor(code, msg) { super(msg || code); this.code = code; this.name = 'ProtocolError'; }
}

// ───────────────────────────── byte helpers ─────────────────────────────
export function concat(...parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function toBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new ProtocolError('bad-frame', 'Expected binary data');
}
function wipe(u8) { if (u8 && u8.fill) u8.fill(0); }
export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
export async function sha256(bytes) { return new Uint8Array(await subtle.digest('SHA-256', bytes)); }
async function digest(bytes) { return new Uint8Array(await subtle.digest(HASH, bytes)); }
async function hmac(keyBytes, data) {
  const k = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: HASH }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}
async function hmacVerify(keyBytes, data, mac) {
  const k = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: HASH }, false, ['verify']);
  return subtle.verify('HMAC', k, mac, data); // constant-time inside WebCrypto
}
async function hkdf(ikm, salt, info, len) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: HASH, salt, info }, k, len * 8));
}

// ───────────────────────────── room codes ─────────────────────────────
// 32 symbols, no 0/O/1/I so codes survive being read aloud or handwritten.
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_CHARS = 20;
export const ROOM_CHARS = 5;

export function generateCode() {
  const r = rand(CODE_CHARS); // 256 % 32 === 0 → unbiased
  let s = '';
  for (let i = 0; i < CODE_CHARS; i++) s += ALPHABET[r[i] & 31];
  wipe(r);
  return formatCode(s);
}
export function formatCode(raw) { return raw.match(/.{1,5}/g).join('-'); }

/** Accepts a code, a code with spaces/lowercase, or a full invite link. Returns canonical form or null. */
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  const hashAt = s.indexOf('#');
  if (hashAt >= 0) s = s.slice(hashAt + 1);
  s = s.toUpperCase().replace(/[\s\-_.]/g, '');
  if (s.length !== CODE_CHARS) return null;
  for (const c of s) if (!ALPHABET.includes(c)) return null;
  return formatCode(s);
}
export function roomIdFromCode(code) {
  return 'ghostchat-v3-' + code.replace(/-/g, '').slice(0, ROOM_CHARS).toLowerCase();
}
export async function deriveRoomKey(code) {
  const c = normalizeCode(code);
  if (!c) throw new ProtocolError('bad-code', 'Invalid room code');
  return hkdf(te.encode(c), te.encode('ghostchat/v3/room-salt'), te.encode('ghostchat/v3/room-key'), K);
}

// ───────────────────────────── padding ─────────────────────────────
/** Pads to the smallest bucket ≥ max(payload+5, minSize). */
export function pad(kind, payload, minSize = 0) {
  const need = Math.max(payload.length + 5, minSize);
  const size = PAD_BUCKETS.find((b) => b >= need);
  if (!size) throw new ProtocolError('too-large', 'Payload exceeds maximum frame size');
  const buf = new Uint8Array(size); // zero padding: the content is encrypted
  new DataView(buf.buffer).setUint32(0, payload.length, false);
  buf[4] = kind;
  buf.set(payload, 5);
  return buf;
}
export function unpad(buf) {
  if (!PAD_BUCKETS.includes(buf.length)) throw new ProtocolError('bad-padding', 'Bad padded length');
  const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false);
  if (len > buf.length - 5) throw new ProtocolError('bad-padding', 'Bad inner length');
  return { kind: buf[4], payload: buf.slice(5, 5 + len) };
}

// ───────────────────────────── safety number ─────────────────────────────
/**
 * 60 digits in 12 groups, identical on both sides. Binds both ECDH keys and both halves of
 * the ML-KEM exchange, so it also detects interference with the post-quantum part.
 */
export async function safetyNumber(epkJ, epkH, kemPk, kemCt) {
  const h = new Uint8Array(await subtle.digest('SHA-512', concat(te.encode('ghostchat/v3/safety-number'), epkJ, epkH, kemPk, kemCt)));
  const groups = [];
  for (let i = 0; i < 12; i++) {
    let v = 0;
    for (let j = 0; j < 5; j++) v = v * 256 + h[i * 5 + j]; // 40-bit, exact in a double
    groups.push(String(v % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

// ───────────────────────────── handshake ─────────────────────────────
async function genEphemeral() {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: CURVE }, false, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { priv: kp.privateKey, pub };
}
async function importPeerPub(raw) {
  if (raw.length !== PK_LEN || raw[0] !== 0x04) throw new ProtocolError('bad-key', 'Malformed public key');
  try { // WebCrypto rejects points that are not on the curve
    return await subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: CURVE }, false, []);
  } catch { throw new ProtocolError('bad-key', 'Invalid public key'); }
}
async function resumeSalt(roomKey, resumeSecret) {
  return hmac(roomKey, concat(te.encode('ghostchat/v3/resume'), resumeSecret));
}
/** Public identifier of a resumption secret: lets the host pick the right one without trial MACs. */
export async function resumeId(secret) {
  return (await digest(concat(te.encode('ghostchat/v3/resume-id'), secret))).slice(0, KEYID_LEN);
}
const isZero = (u8) => u8.every((b) => b === 0);
function validSecret(s) { return s instanceof Uint8Array && s.length === K && !isZero(s); }

async function deriveSession(ecdhShared, kemShared, salt, transcript) {
  const th = await digest(transcript);
  const okm = await hkdf(concat(ecdhShared, kemShared), salt, concat(te.encode('ghostchat/v3/session'), th), 5 * K);
  const keys = {
    th,
    macH: okm.slice(0, K), macJ: okm.slice(K, 2 * K),
    chainH: okm.slice(2 * K, 3 * K), chainJ: okm.slice(3 * K, 4 * K),
    resume: okm.slice(4 * K, 5 * K),
  };
  wipe(okm); wipe(ecdhShared); wipe(kemShared);
  return keys;
}

/**
 * Two-party authenticated hybrid key exchange.
 *   Joiner → Host : HELLO   'J' ‖ mode ‖ keyId ‖ nonceJ ‖ epkJ(P-384) ‖ kemPk(ML-KEM-1024)
 *   Host  → Joiner: HELLO   'H' ‖ nonceH ‖ epkH ‖ kemCt ‖ macH
 *   Joiner → Host : CONFIRM macJ
 * mode 0 = first join (salt = roomKey, keyId = 0); mode 1 = resume (salt = HMAC(roomKey, secret),
 * keyId = resumeId(secret)).
 * th  = SHA-384(label ‖ mode ‖ keyId ‖ nonceJ ‖ epkJ ‖ kemPk ‖ nonceH ‖ epkH ‖ kemCt)
 * okm = HKDF-SHA-384(ECDH ‖ ML-KEM, salt, label ‖ th) → macH ‖ macJ ‖ chainH ‖ chainJ ‖ resume
 * The host decides whether it is locked, and which secrets a resume may use, when the HELLO
 * ARRIVES (via a policy callback), never earlier: state can change while a connection is open.
 */
export class Handshake {
  /**
   * @param {'host'|'joiner'} role
   * @param {Uint8Array} roomKey 48 bytes from deriveRoomKey
   * @param {object} [opts]
   *   host:   policy() → { locked: boolean, secrets: { secret: Uint8Array, continuity: boolean }[] }
   *           evaluated on HELLO; return copies. continuity=false marks a secret that only proves
   *           "the same joiner as a first join the host never confirmed", not the verified peer.
   *   joiner: resumeSecret — attempt a resume with this secret (copied) instead of a first join.
   */
  constructor(role, roomKey, opts = {}) {
    if (role !== 'host' && role !== 'joiner') throw new Error('role must be host or joiner');
    if (!(roomKey instanceof Uint8Array) || roomKey.length !== K) throw new Error('roomKey must be 48 bytes');
    this.role = role; this.roomKey = roomKey; this.state = 'init';
    if (role === 'host') this.policy = typeof opts.policy === 'function' ? opts.policy : () => ({ locked: false, secrets: [] });
    else if (opts.resumeSecret != null) {
      if (!validSecret(opts.resumeSecret)) throw new ProtocolError('bad-secret', 'Invalid resumption secret');
      this.resumeSecret = opts.resumeSecret.slice();
    }
  }

  /** Joiner only: returns the first frame to send. */
  async start() {
    if (this.role !== 'joiner' || this.state !== 'init') throw new ProtocolError('state', 'Bad handshake state');
    this.mode = this.resumeSecret ? 1 : 0;
    const keyId = this.mode ? await resumeId(this.resumeSecret) : new Uint8Array(KEYID_LEN);
    this.eph = await genEphemeral();
    this.kem = ml_kem1024.keygen();
    this.nonceJ = rand(NONCE_LEN);
    this.helloBody = concat([this.mode], keyId, this.nonceJ, this.eph.pub, this.kem.publicKey);
    this.state = 'sent-hello';
    return concat([MAGIC, T_HELLO, 0x4a], this.helloBody);
  }

  /**
   * Feed a received frame. Returns { send?: Uint8Array, done?: SessionKeys }.
   * Throws ProtocolError on anything unexpected; callers must drop the connection. Any failure
   * wipes the handshake's secrets. A host that refuses because it is locked throws code 'locked'
   * with a `send` property holding the LOCKED frame to deliver first.
   */
  async receive(frameIn) {
    try { return await this._receive(frameIn); }
    catch (e) { this.state = 'failed'; this.forget(); throw e; }
  }

  async _receive(frameIn) {
    const f = toBytes(frameIn);
    if (f.length < 2 || f[0] !== MAGIC) throw new ProtocolError('bad-frame', 'Not a Ghost Chat frame');

    if (this.role === 'host' && this.state === 'init') {
      if (f[1] !== T_HELLO || f.length !== J_HELLO_LEN || f[2] !== 0x4a) throw new ProtocolError('bad-hello', 'Bad hello');
      const helloBody = f.slice(3);
      const mode = helloBody[0];
      if (mode !== 0 && mode !== 1) throw new ProtocolError('bad-hello', 'Bad mode');
      let o = 1;
      const keyId = helloBody.slice(o, o += KEYID_LEN);
      const nonceJ = helloBody.slice(o, o += NONCE_LEN), epkJ = helloBody.slice(o, o += PK_LEN), kemPk = helloBody.slice(o, o += KEM_PK);
      void nonceJ;
      const pol = this.policy() || {};
      const offered = (Array.isArray(pol.secrets) ? pol.secrets : [])
        .map((x) => (x instanceof Uint8Array ? { secret: x, continuity: false } : x))   // untagged: never trusted as continuity
        .filter((x) => x && x.secret instanceof Uint8Array);
      let salt;
      this.continuity = false;
      try {
        if (mode === 0) {
          if (pol.locked) {
            const e = new ProtocolError('locked', 'Room is locked to its current members');
            e.send = Uint8Array.of(MAGIC, T_LOCKED);
            throw e;
          }
          if (!isZero(keyId)) throw new ProtocolError('bad-hello', 'Unexpected key id');
          salt = this.roomKey;
        } else {
          let chosen = null;
          for (const o of offered) if (validSecret(o.secret) && bytesEqual(await resumeId(o.secret), keyId)) { chosen = o; break; }
          if (!chosen) throw new ProtocolError('auth-failed', 'Unknown resumption secret');
          // A secret from an unconfirmed FIRST join proves nothing about the verified peer: it may
          // only be used while the room is unlocked, and never counts as continuity.
          if (!chosen.continuity && pol.locked) throw new ProtocolError('auth-failed', 'Unknown resumption secret');
          this.continuity = !!chosen.continuity;
          // Resuming a first join whose CONFIRM never reached us: the joiner already shows the
          // safety number of that first handshake, so we show the same one (what we would have
          // shown had the CONFIRM arrived), not this handshake's.
          this.priorSn = !chosen.continuity && typeof chosen.sn === 'string' ? chosen.sn : null;
          salt = await resumeSalt(this.roomKey, chosen.secret);
        }
      } finally { for (const o of offered) wipe(o.secret); }

      const peer = await importPeerPub(epkJ);
      let enc;
      try { enc = ml_kem1024.encapsulate(kemPk); } catch { throw new ProtocolError('bad-key', 'Invalid ML-KEM key'); }
      this.eph = await genEphemeral();
      const nonceH = rand(NONCE_LEN);
      const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peer }, this.eph.priv, 384));
      const transcript = concat(te.encode('ghostchat/v3/handshake'), helloBody, nonceH, this.eph.pub, enc.cipherText);
      this.keys = await deriveSession(ecdh, enc.sharedSecret, salt, transcript);
      this.sn = await safetyNumber(epkJ, this.eph.pub, kemPk, enc.cipherText);
      this.mode = mode;
      // If our CONFIRM never arrives, the joiner may still have committed this secret. It carries
      // continuity only if this handshake itself proved continuity.
      this.candidate = this.keys.resume.slice();
      this.candidateContinuity = mode === 1 && this.continuity;
      this.candidateSn = this.priorSn || this.sn;
      const macH = await hmac(this.keys.macH, concat([0x48], this.keys.th));
      this.state = 'sent-hello';
      return { send: concat([MAGIC, T_HELLO, 0x48], nonceH, this.eph.pub, enc.cipherText, macH) };
    }

    if (this.role === 'joiner' && this.state === 'sent-hello') {
      if (f[1] === T_LOCKED && f.length === 2) { this.state = 'failed'; throw new ProtocolError('locked', 'Room is locked to its current members'); }
      if (f[1] !== T_HELLO || f.length !== H_HELLO_LEN || f[2] !== 0x48) throw new ProtocolError('bad-hello', 'Bad hello');
      let o = 3;
      const nonceH = f.slice(o, o += NONCE_LEN), epkH = f.slice(o, o += PK_LEN), kemCt = f.slice(o, o += KEM_CT), macH = f.slice(o);
      const peer = await importPeerPub(epkH);
      const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peer }, this.eph.priv, 384));
      const kemSs = ml_kem1024.decapsulate(kemCt, this.kem.secretKey); // implicit rejection: bad ct → wrong secret → MAC fails
      const transcript = concat(te.encode('ghostchat/v3/handshake'), this.helloBody, nonceH, epkH, kemCt);
      const salt = this.mode ? await resumeSalt(this.roomKey, this.resumeSecret) : this.roomKey;
      const keys = await deriveSession(ecdh, kemSs, salt, transcript);
      if (!(await hmacVerify(keys.macH, concat([0x48], keys.th), macH))) {
        wipe(keys.chainH); wipe(keys.chainJ); wipe(keys.resume);
        throw new ProtocolError('auth-failed', this.mode ? 'Could not prove continuity with this room' : 'Room code mismatch or tampered handshake');
      }
      const macJ = await hmac(keys.macJ, concat([0x4a], keys.th));
      const sn = await safetyNumber(this.eph.pub, epkH, this.kem.publicKey, kemCt);
      this.state = 'done';
      const done = finish(keys, 'joiner', sn, this.mode === 1);
      this.forget();
      return { send: concat([MAGIC, T_CONFIRM], macJ), done };
    }

    if (this.role === 'host' && this.state === 'sent-hello') {
      if (f[1] !== T_CONFIRM || f.length !== 2 + MAC_LEN) throw new ProtocolError('bad-confirm', 'Bad confirm');
      if (!(await hmacVerify(this.keys.macJ, concat([0x4a], this.keys.th), f.slice(2)))) {
        throw new ProtocolError('auth-failed', 'Room code mismatch or tampered handshake');
      }
      this.state = 'done';
      const done = finish(this.keys, 'host', this.sn, this.mode === 1 && this.continuity);
      if (this.priorSn) done.firstSafetyNumber = this.priorSn;
      this.forget();
      return { done };
    }

    throw new ProtocolError('state', 'Unexpected handshake frame');
  }

  /**
   * Drop everything that could re-derive the session keys (ephemeral private keys,
   * ML-KEM secret key, transcript, nonces, room and resumption key references).
   */
  forget() {
    if (this.keys) {
      wipe(this.keys.macH); wipe(this.keys.macJ);
      if (this.state !== 'done') { wipe(this.keys.chainH); wipe(this.keys.chainJ); wipe(this.keys.resume); }
    }
    if (this.kem) wipe(this.kem.secretKey);
    wipe(this.resumeSecret);
    if (this.state !== 'sent-hello') wipe(this.candidate);  // the session keeps its own copy
    this.eph = null; this.kem = null; this.keys = null; this.nonceJ = null; this.helloBody = null;
    this.roomKey = null; this.resumeSecret = null; this.candidate = null;
  }
}

function finish(keys, role, sn, resumed) {
  return {
    send: role === 'host' ? keys.chainH : keys.chainJ,
    recv: role === 'host' ? keys.chainJ : keys.chainH,
    resumeSecret: keys.resume,
    safetyNumber: sn,
    resumed,
    transcriptHash: keys.th.slice(),
  };
}

// ───────────────────────────── secure channel ─────────────────────────────
// Per-direction symmetric ratchet (HMAC-SHA-384):
//   mk_n = HMAC(ck_n, 0x01)[0..32]   (AES-256 key)      ck_{n+1} = HMAC(ck_n, 0x02)
class Chain {
  constructor(ck) { this.ck = ck; this.n = 0; }
  async next() {
    const full = await hmac(this.ck, Uint8Array.of(1));
    const mk = full.slice(0, 32); wipe(full);
    const nk = await hmac(this.ck, Uint8Array.of(2));
    wipe(this.ck); this.ck = nk;
    return { n: this.n++, mk };
  }
  destroy() { wipe(this.ck); this.ck = new Uint8Array(K); }
}

/** Serializes async work so ratchet steps can never interleave. */
class Mutex {
  constructor() { this.p = Promise.resolve(); }
  run(fn) { const r = this.p.then(fn, fn); this.p = r.then(() => {}, () => {}); return r; }
}

export class SecureChannel {
  constructor({ send, recv }) {
    this.tx = new Chain(send); this.rx = new Chain(recv);
    this.txLock = new Mutex(); this.rxLock = new Mutex();
    this.dead = false;
  }

  /** @param {number} [minSize] pad to at least this bucket (constant-size traffic mode) */
  seal(kind, payload, minSize = 0) {
    return this.txLock.run(async () => {
      if (this.dead) throw new ProtocolError('closed', 'Channel closed');
      const body = pad(kind, payload, minSize);
      const { n, mk } = await this.tx.next();
      if (n > 0xffffffff) throw new ProtocolError('exhausted', 'Counter exhausted');
      const hdr = new Uint8Array(HDR);
      hdr[0] = MAGIC; hdr[1] = T_DATA; new DataView(hdr.buffer).setUint32(2, n, false);
      const iv = rand(IVLEN);
      const key = await subtle.importKey('raw', mk, 'AES-GCM', false, ['encrypt']);
      wipe(mk);
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: hdr, tagLength: 128 }, key, body));
      wipe(body);
      return concat(hdr, iv, ct);
    });
  }

  open(frameIn) {
    return this.rxLock.run(async () => {
      if (this.dead) throw new ProtocolError('closed', 'Channel closed');
      const f = toBytes(frameIn);
      if (f.length < HDR + IVLEN + TAGLEN + PAD_BUCKETS[0] || f.length > MAX_FRAME) throw this.kill('bad-frame', 'Bad frame size');
      if (f[0] !== MAGIC || f[1] !== T_DATA) throw this.kill('bad-frame', 'Bad frame type');
      const n = new DataView(f.buffer, f.byteOffset, f.byteLength).getUint32(2, false);
      // Strict ordering on a reliable, ordered channel: anything else is replay/drop/reorder.
      if (n !== this.rx.n) throw this.kill('sequence', `Out-of-order frame (got ${n}, expected ${this.rx.n})`);
      const hdr = f.slice(0, HDR), iv = f.slice(HDR, HDR + IVLEN), ct = f.slice(HDR + IVLEN);
      const { mk } = await this.rx.next();
      const key = await subtle.importKey('raw', mk, 'AES-GCM', false, ['decrypt']);
      wipe(mk);
      let pt;
      try { pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: hdr, tagLength: 128 }, key, ct)); }
      catch { throw this.kill('auth', 'Authentication tag mismatch'); }
      return unpad(pt);
    });
  }

  async sealJSON(obj, minSize = 0) { return this.seal(KIND_JSON, te.encode(JSON.stringify(obj)), minSize); }

  kill(code, msg) { this.destroy(); return new ProtocolError(code, msg); }
  destroy() { this.dead = true; this.tx.destroy(); this.rx.destroy(); }
}

/** Strict JSON decode for inner payloads: must be a plain object with a string `t`. */
const MAX_JSON_DEPTH = 8;   // no Ghost Chat message nests deeper than 4
/** True if the JSON text nests objects/arrays deeper than `max` (strings are skipped). */
export function jsonTooDeep(text, max = MAX_JSON_DEPTH) {
  let depth = 0, inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) { if (c === 92) i++; else if (c === 34) inStr = false; continue; }   // \  and "
    if (c === 34) inStr = true;
    else if (c === 123 || c === 91) { if (++depth > max) return true; }            // { [
    else if (c === 125 || c === 93) depth--;                                        // } ]
  }
  return false;
}
export function decodeJSON(payload) {
  let o;
  const text = td.decode(payload);
  // Deep nesting is never legitimate and can make later JSON.stringify calls throw.
  if (jsonTooDeep(text)) throw new ProtocolError('bad-json', 'JSON nested too deeply');
  try { o = JSON.parse(text); } catch { throw new ProtocolError('bad-json', 'Malformed JSON'); }
  if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.t !== 'string') throw new ProtocolError('bad-json', 'Malformed message');
  return o;
}
