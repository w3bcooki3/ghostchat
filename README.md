<div align="center">

<img src="icon.svg" width="76" alt="">

# Ghost Chat

**Private, end-to-end encrypted chat between two browsers.**
Post-quantum key exchange. No accounts. Nothing stored. Close the tab and it's gone.

[![CI](https://github.com/w3bcooki3/ghostchat/actions/workflows/ci.yml/badge.svg)](https://github.com/w3bcooki3/ghostchat/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-62F2B4?labelColor=0C1216)](LICENSE)

[**Open Ghost Chat**](https://w3bcooki3.github.io/ghostchat/) · [Who can read what](https://w3bcooki3.github.io/ghostchat/security.html) · [Security model](SECURITY.md) · [Review history](docs/AUDIT.md)

![Ghost Chat home screen](docs/screenshots/home.png)

</div>

## How it works

1. **Start a private chat.** You get a 20-character code like `TZQFM-EQZPL-3JMHC-465QY` and an invite link.
2. **Share it with one person**, over a channel you trust.
3. They open the link (or tap **Join with a code** and paste it). Your browsers prove they hold the same code, agree on fresh post-quantum keys, and connect directly. **The room then locks**: the code stops working, even for someone who has all 20 characters.
4. Optionally **compare the 60-digit safety number** by voice. If both screens match, nobody is in the middle.

![Conversation on desktop](docs/screenshots/chat-desktop.png)

## Features

**Security**
- **Hybrid post-quantum key exchange:** ECDH P-384 + ML-KEM-1024 (FIPS 203). An attacker has to break both.
- **AES-256-GCM with a new key for every message** (HMAC-SHA-384 ratchet). Tampering, replay and reordering are detected and close the connection.
- **The room code is the only way in.** The server that introduces your browsers can't join, read, or sit in the middle.
- **Room lock:** after the first join, only reconnects that prove a secret from this conversation get in.
- **Safety numbers** that stay stable across reconnects, plus a "verified" mark that survives them.
- **Maximum privacy:** one tap for relay-only routing (hides your IP from the other person), constant-rate traffic (hides when you type and send), and no typing indicator or read receipts.
- Messages padded to fixed sizes. Nothing written to disk. Strict Content-Security-Policy. No third-party CDNs. Refuses to run inside frames.
- **Panic wipe:** press <kbd>Esc</kbd> three times, or tap the button in the session sheet on phones. It destroys everything and leaves the page.

**Conversation**
- Delivered and read receipts; read receipts are optional.
- Disappearing messages (10 s to 1 h), synced between both people.
- Replies, reactions, unsend for both, remove for me.
- Typing indicator (optional).
- Files up to 100 MB, streamed in encrypted chunks with progress and cancel. Images preview inline; everything else downloads.
- Drag and drop, or paste images.
- **Automatic reconnection:** messages you send while offline are queued and delivered when the link returns.

**Phones**
- An app-style launcher: the brand glows in the fog, with **Start a private chat** and **Join with a code** in thumb reach. Your name and privacy level are chips that open bottom sheets.
- **Join with a code** opens a dedicated code pad: four boxes that accept a pasted code or a whole invite link, a Paste button, and look-alike warnings (no 0, 1, I or O). Invite links open it already filled in, so joining is one tap. The phone's back button returns home.
- Bottom sheets for session settings and message actions; swipe a message right to reply, long-press for actions.
- Native share sheet for invites, a keyboard-aware composer, safe-area insets, and 44-pixel touch targets throughout.

![On a phone](docs/screenshots/mobile.png)

## Who can read what

Ghost Chat protects **content** completely and narrows **metadata** where a web app can. The [interactive page](security.html) lets you pick any observer and see a sample conversation through their eyes. Here is the summary, with **Maximum privacy** on (highlighted cells are what it changes):

![Who can read what, with Maximum privacy](docs/screenshots/security-matrix.png)

Some things no web app can fix:
- **A compromised device:** malware sees your screen.
- **The other person:** they can keep a copy of anything.
- **Metadata at the signaling server:** it sees your IP address and when you connect, unless you [run your own](#run-your-own-servers) and use a VPN or Tor.
- **A code that leaks before your peer joins:** whoever has it could get in first. The safety number exposes that.

### Is it "military grade"?

Nobody certifies apps as military grade, so the phrase means nothing on its own. Ghost Chat uses the **same algorithms and key sizes as the NSA's CNSA 2.0 suite**: AES-256, ML-KEM-1024 and SHA-384, plus P-384 during the transition period. That's a statement about algorithm choice, not a certification. It isn't FIPS-validated or independently audited, and a website isn't a classified environment. Details are in [SECURITY.md](SECURITY.md).

## Deploy to GitHub Pages

1. Push this repository to GitHub.
2. Go to **Settings → Pages → Build and deployment**, and set **Source** to **GitHub Actions**.
3. Push to `main`. The [CI workflow](.github/workflows/ci.yml) runs the unit tests and the real-browser end-to-end suite, and checks that the committed single-file build matches the source. **It deploys only if all of that passes.**

Your chat is then live at `https://<user>.github.io/<repo>/`, and the single file is at `/ghostchat.html`.

GitHub Pages can't set HTTP headers. The CSP still applies through a `<meta>` tag, and the app refuses to run inside frames. On Netlify or Cloudflare Pages, [`_headers`](_headers) adds the full header set.

## Other ways to run it

**One file.** [`dist/ghostchat.html`](dist/ghostchat.html) has everything inlined: fonts, styles, PeerJS, ML-KEM and the app, with a hash-based CSP. Open it from disk or host it anywhere.

**Verify it first:**
```bash
sha256sum ghostchat.html     # must match dist/SHA256SUMS from the commit you trust
```
The build is deterministic, so you can also rebuild it yourself and compare: `node tools/build.mjs`.

**Fully offline, on one machine or a LAN** (for development):
```bash
npm install
npm run serve:local          # signaling on :9000, app on http://127.0.0.1:8090
```

### Run your own servers
The default introduction server is the public `0.peerjs.com`, and the default relay is PeerJS's public TURN server. For real metadata privacy, run your own:
```bash
npx peerjs --port 9000       # signaling
# plus a TURN server such as coturn, for relay-only mode
```
Then edit [`js/config.js`](js/config.js) (`SIGNALING`, `ICE_SERVERS`) and the `connect-src` entry of the CSP in `index.html`.

## Development

```bash
npm install
npm test               # 27 protocol unit tests (Node): handshake, hybrid KEM, lock, resume, ratchet, padding
npm run test:e2e       # 26 end-to-end scenarios in real Chromium over real WebRTC
npm run build          # → dist/ghostchat.html + dist/SHA256SUMS (commit both)
```

The end-to-end suite covers, among other things:
- **Security:**
  - wrong codes and a locked room refusing a correct code;
  - resume with the safety number kept;
  - unlock with re-verification;
  - constant-rate mode, verified on the wire (every frame exactly 4,130 bytes);
  - script injection, SVG and spoofed-MIME files;
  - panic wipe and the frame guard.
- **Delivery:** byte-exact file transfer and 200-message ordering.
- **Phone layout:** the action sheet, swipe-to-reply, and the bottom sheet.

### Project layout
```
index.html             app markup + Content-Security-Policy
security.html          "Who can read your conversation?" (css/security.css, js/security.js)
css/app.css            styles (desktop + phone layer)
js/protocol.js         crypto protocol v3: codes, hybrid handshake, lock/resume, ratchet, padding (no DOM)
js/session.js          transport: PeerJS, reconnection, delivery, constant-rate traffic, files (no DOM)
js/app.js              interface
js/fog.js              home-screen WebGL atmosphere
js/config.js           signaling, ICE servers, limits
vendor/                PeerJS 1.5.5 and ML-KEM-1024 from noble-post-quantum 0.7.1 (MIT)
fonts/                 Space Grotesk, JetBrains Mono, Bebas Neue (SIL OFL)
tests/                 unit tests, end-to-end tests, local servers
tools/build.mjs        deterministic single-file build
.github/workflows/     CI + GitHub Pages deployment
```

## Status

Ghost Chat has had two rounds of internal security review, recorded in [docs/AUDIT.md](docs/AUDIT.md), but **no independent audit**. It's a good tool for private conversations with people you trust. For high-risk situations, use Signal.

Found a security problem? Please open a **private security advisory** on this repository rather than a public issue.

## License

MIT. PeerJS and noble-post-quantum are MIT; the fonts are under the SIL Open Font License (see `fonts/`).
