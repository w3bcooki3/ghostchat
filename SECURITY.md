# Ghost Chat security model

This document says exactly what Ghost Chat protects, how, and where its limits are. If a claim isn't here, don't assume it. The interactive version is [`security.html`](security.html) ("Who can read your conversation?").

> **Status:** not independently audited. The protocol uses standard primitives: Web Crypto in the browser, plus a vendored ML-KEM implementation. It is covered by unit tests, real-browser end-to-end tests, and two rounds of internal review whose findings are listed in [docs/AUDIT.md](docs/AUDIT.md). For high-risk situations, use Signal.

## What it protects

| Property | Mechanism |
|---|---|
| **Confidentiality of content** | Messages, reactions, receipts, typing state, names and file bytes are encrypted with AES-256-GCM before leaving the browser. |
| **Post-quantum key exchange** | Every connection combines ephemeral ECDH P-384 with ML-KEM-1024 (FIPS 203). An attacker has to break **both**, so traffic recorded today stays protected even if large quantum computers arrive later ("harvest now, decrypt later"). |
| **Only code-holders can connect** | The handshake is keyed by a secret derived from the room code. Without the code, a peer cannot complete it or sit in the middle, and that includes the signaling server. |
| **Room lock** | Once the two people are connected, the room only accepts reconnects that prove a 384-bit resumption secret from that conversation. A full, correct room code is refused after that. |
| **Stable identity across reconnects** | A proven reconnect keeps the original safety number and your "verified" mark. A fresh join gets a new safety number and resets verification. |
| **Integrity, ordering, no replay** | Every frame carries a counter bound as AEAD associated data. A tampered, replayed, dropped, reordered or reflected frame fails, and the link is torn down. |
| **Forward secrecy** | Fresh ephemeral keys for every connection. Within a connection, each direction uses a symmetric hash ratchet with a new key for every message, and old chain keys are overwritten. Handshake secrets are wiped when the handshake ends, whether it succeeds or fails. |
| **Length hiding** | Plaintexts are padded to fixed buckets: 256 B, 1 KB, 4 KB, 16 KB or 64 KB. |
| **Constant-rate traffic (optional)** | Exactly one 4 KB frame every 250 ms in each direction, real or filler. Longer messages are split into 4 KB fragments. Observers can't tell when, or how much, you talk. |
| **No persistence** | Nothing is written to localStorage, IndexedDB, cookies or caches. State lives only in memory. |
| **Peer content can't run code** | Peer text is inserted with `textContent` only. Files are never rendered by MIME type: only PNG, JPEG, GIF and WebP identified by magic bytes display inline (as `<img>`), and everything else downloads as `application/octet-stream`. A strict Content-Security-Policy (`script-src 'self'`, `default-src 'none'`) is a second barrier. |

## What it does **not** protect against

- **A compromised device or browser:** malware, malicious extensions, screen capture, someone looking over your shoulder. No app can fix this.
- **A room code that leaks before your peer joins.** The first person to prove the code is let in automatically (that's who the invite was for), so whoever holds a leaked code could get there first. After that, everyone who proves the code waits until the host admits them. Share codes over a channel you trust and compare safety numbers when it matters.
- **Someone who steals a resumption secret from memory.** A device or memory compromise mid-conversation could let the attacker reconnect as either side later. The stable safety number would not reveal that. The panel's **Live keys** fingerprint shows the keys of the current connection.
- **Metadata at the signaling server.** The default PeerJS server (`0.peerjs.com`) sees both IP addresses, the 5-character room ID, and when browsers connect. Run your own signaling server, and a VPN or Tor, to reduce this.
- **That you're connected at all.** Relays and your network see that a conversation exists, between which addresses, and for how long. Constant-rate mode hides the timing and amount of activity, not the session itself.
- **Your IP address from your peer, by default.** Direct connections reveal each side's IP. **Maximum privacy** routes through a TURN relay instead.
- **The other person.** They can screenshot or copy anything. Disappearing messages clear both screens; they can't stop a determined recipient.
- **Guaranteed memory erasure.** JavaScript cannot securely zero memory. Keys are non-extractable `CryptoKey`s where possible, and raw key bytes are overwritten after use. The garbage collector, JIT, swap and crash dumps are outside the app's control.
- **Whoever serves the page.** The host of `index.html` controls the code you run. Use the single-file build from a release you've verified ([below](#verifying-a-release)), or host it yourself.

### "Military grade"?

Nobody certifies apps as "military grade", so the phrase means nothing on its own. Ghost Chat uses the same algorithms and key sizes as the NSA's CNSA 2.0 suite for classified information: AES-256, ML-KEM-1024 and SHA-384, plus P-384 during the transition period. That is a statement about algorithm choice only. The implementation is not certified, FIPS 140-3 validated, or independently audited, and a web page served from a website is not a classified-grade environment.

## Protocol (v3)

### Room codes
- 20 symbols from a 32-character alphabet (`A–Z` without `I` and `O`, digits `2–9`), drawn from `crypto.getRandomValues` without modulo bias: **100 bits**.
- The first 5 symbols (25 bits) form the public signaling ID `ghostchat-v3-xxxxx`. The remaining **75 bits never leave the two browsers**. Invite links carry the code in the URL fragment, which browsers don't send to servers, and the app erases it from the address bar on load.
- `roomKey = HKDF-SHA-384(ikm = code, salt = "ghostchat/v3/room-salt", info = "ghostchat/v3/room-key")`, 48 bytes.

### Handshake

```
J → H   HELLO   'J' ‖ mode ‖ keyId(8) ‖ nonceJ(32) ‖ epkJ(P-384, 97) ‖ kemPk(ML-KEM-1024, 1568)
H → J   HELLO   'H' ‖ nonceH(32) ‖ epkH(97) ‖ kemCt(1568) ‖ macH(48)
J → H   CONFIRM macJ(48)
(H → J  LOCKED  — instead of HELLO when a locked host receives mode 0)

mode 0 (first join): salt = roomKey,                               keyId = 0^8
mode 1 (resume):     salt = HMAC-SHA-384(roomKey, "…/resume" ‖ S),  keyId = SHA-384("…/resume-id" ‖ S)[0..8]

th   = SHA-384("ghostchat/v3/handshake" ‖ mode ‖ keyId ‖ nonceJ ‖ epkJ ‖ kemPk ‖ nonceH ‖ epkH ‖ kemCt)
okm  = HKDF-SHA-384(ikm = ECDH(48) ‖ ML-KEM(32), salt, info = "ghostchat/v3/session" ‖ th, 240 bytes)
       → macKeyH ‖ macKeyJ ‖ chainH ‖ chainJ ‖ resumeSecret   (48 bytes each)
macH = HMAC-SHA-384(macKeyH, "H" ‖ th)        macJ = HMAC-SHA-384(macKeyJ, "J" ‖ th)
```

- **Hybrid:** both shared secrets feed one HKDF, and the transcript binds both ECDH keys and both halves of the ML-KEM exchange. There is no negotiation and every field has a fixed length, so there is nothing to downgrade. ML-KEM's implicit rejection turns a tampered ciphertext into a MAC failure.
- **Key confirmation:** MACs are verified with WebCrypto's constant-time `verify`. Without the room code (and, for mode 1, the resumption secret), an active attacker cannot produce them. An attacker could try to guess the 75 secret code bits offline against `macH`, but 2⁷⁵ candidates is not feasible within the 15-second handshake window, or at all with current hardware.
- **Points** are validated: length, prefix, and WebCrypto's on-curve check on import.

### Room lock and resumption
- After a successful handshake both sides hold `resumeSecret`. It rotates on every successful (re)connection, and the old value is overwritten.
- The host reads its policy when the HELLO **arrives**, never when the connection opened: whether it is locked, and which secrets are acceptable (copies, wiped after use). A locked host refuses mode 0 with a LOCKED frame. Completing a handshake closes every other half-open handshake.
- **Lost CONFIRM:** if the joiner committed a new secret but the host never saw its CONFIRM, the host keeps that secret as a *candidate* (at most 4, cleared on every commit). A candidate from a resume still proves continuity. A candidate from a **first join** may only be used while the room is unlocked, and never counts as continuity.
- **Joiner behaviour:** a joiner that has been connected before only ever resumes. LOCKED frames are unauthenticated, so refusals during a resume are retried. The session ends after 4 refusals or when the 3-minute reconnect window closes. A forged LOCKED frame can therefore cause denial of service, never access.
- **Unlocking:** if the peer reloaded and lost its secret, the host can **unlock once**, after a warning. The next fresh join gets a new safety number, and verification resets.

### Safety numbers
- `SHA-512("ghostchat/v3/safety-number" ‖ epkJ ‖ epkH ‖ kemPk ‖ kemCt)`. The first 60 bytes are rendered as 12 groups of 5 digits, identical on both sides.
- The number shown is the one from the conversation's first handshake. It changes only when a new browser joins after an unlock.
- The panel also shows a **live** fingerprint of the current connection's keys, which changes on every reconnect.

### Data frames
```
frame  = 0x47 ‖ 0x10 ‖ counter(u32) ‖ iv(12) ‖ AES-256-GCM(mk_n, iv, aad = first 6 bytes, padded)
padded = len(u32) ‖ kind(u8) ‖ payload ‖ zero padding   → 256 / 1024 / 4096 / 16384 / 65536 bytes
mk_n   = HMAC-SHA-384(ck_n, 0x01)[0..32]                ck_{n+1} = HMAC-SHA-384(ck_n, 0x02)
kind   = 1 JSON message · 2 file chunk (fileId ‖ seq ‖ bytes) · 3 fragment (id u32 ‖ index u16 ‖ count u16 ‖ bytes)
```
The receiver accepts only `counter == expected`, because the WebRTC data channels here are reliable and ordered. Any deviation is an attack or a bug, and it closes the link.

### Constant-rate traffic
- When either person turns it on, both sides send one frame padded to 4 KB every 250 ms. A frame carries the next queued message or a filler. That is 4,130 bytes on the wire per frame, about 59.5 MB per hour in each direction.
- JSON messages larger than one slot are split into up to 16 fragments.
- The clock runs in a Web Worker, so browsers' background-tab timer throttling doesn't change the rhythm. Some browsers may still slow a hidden tab.
- **Still visible:** file transfers (their chunks and control messages are sent directly, so a file's approximate size and timing show), the final goodbye when a session ends, and connection setup and teardown.

### Delivery
Messages carry a random 64-bit `mid`. The sender keeps each one in an outbox until it is acknowledged, and resends after a reconnect. The receiver de-duplicates by `mid`.

Files stream in 60 KiB chunks with backpressure. Receivers enforce the declared size, chunk order, a 100 MB cap, and at most 4 concurrent transfers.

## Verifying a release

The single-file build is deterministic: the same source always produces byte-identical output, and CI fails if the committed `dist/ghostchat.html` doesn't match a fresh build. To check a copy you downloaded:

```bash
sha256sum ghostchat.html          # compare with dist/SHA256SUMS in the release/commit you trust
# or rebuild it yourself:
git clone https://github.com/w3bcooki3/ghostchat && cd ghostchat && node tools/build.mjs && cat dist/SHA256SUMS
```

## Hosting recommendations
- Serve over HTTPS with the headers in [`_headers`](./_headers). They add `frame-ancestors 'none'`, which a `<meta>` CSP cannot set; the app also refuses to run inside a frame. GitHub Pages can't set headers; the CSP `<meta>` still applies there.
- For privacy from the public signaling service, run your own signaling server (`npx peerjs --port 9000`) and your own TURN server (for example coturn). Then update `js/config.js` and the CSP `connect-src`.
- Vendored code (no CDN in the trust path):
  - `vendor/peerjs-1.5.5.min.js`: npm `peerjs@1.5.5`, MIT.
  - `vendor/noble-ml-kem1024-0.7.1.min.js`: npm `@noble/post-quantum@0.7.1`, only ML-KEM-1024, bundled with esbuild, MIT. The header records the source package's npm integrity hash.
  - noble-post-quantum is self-audited by its author and tested against official NIST test vectors. It has not been independently audited. Because the key exchange is hybrid, a cryptographic weakness in ML-KEM or in this implementation cannot reduce key secrecy below ECDH P-384. Like any dependency, though, vendored code runs with the page's full privileges.

## Reporting a vulnerability
Please open a private security advisory on the repository rather than a public issue.


## Group rooms (up to 6 people)

A room can hold up to six browsers. It is built from the same two-party protocol, one instance per pair of people, so nothing above changes for any single pair.

**Admission.** The creator's browser (the host) listens on the room code with a *lobby*. Anyone who completes the code-authenticated handshake against the lobby has proved they hold the full code, and gets an encrypted channel to the host, but is not yet in the room. The first such browser is admitted automatically. Every later one waits ("knocks") until the host taps *Let in* or *Deny*; an unanswered knock is turned away after 3 minutes. The lobby refuses new handshakes with `LOCKED` once the room is full. Lobby links never resume.

**Pairs.** On admission the host generates a fresh random 20-character *pair code* for the newcomer and itself, and one for the newcomer and each existing member. Pair codes travel only inside existing end-to-end encrypted channels (the lobby link to the newcomer, and each member's pair session with the host). Each pair then runs an independent session on its own code: its own hybrid handshake, its own ratchet, its own resumption secret and its own **safety number**. Messages, files, receipts and typing between two members are encrypted between those two browsers only; the host's browser never relays or decrypts them.

**What the host could do.** The host chooses every pair code, so a malicious host could try to place itself in the middle of a pair it introduced. It cannot do so silently: the two members' safety number for each other would then differ. Verify each person you share sensitive things with. A host also sees who is in the room, and can remove people.

**Identity.** A message's author is the pair session it arrived on, never a field in the message, so one member cannot pose as another. Only the author can edit or unsend a message. Room-control messages (introductions, settings, removals, "clear for everyone") are accepted only from the host's pair session.

**Removing someone.** The host tells every member to hang up on that person, then hangs up itself. Each member's browser closes its pair with them, so they receive nothing more. A modified client could ignore the instruction; a member who keeps talking to a removed person is choosing to.

**Unsend all / clear for everyone.** These ask the other browsers to delete messages from their screens. An unmodified Ghost Chat honours them. They can't reach copies someone already made (screenshots, copied text, saved files).

**Invites.** The invite is the same room code. By default only the host can see and share it from the session panel; the host can let members share it too. Either way, the host admits each newcomer.
