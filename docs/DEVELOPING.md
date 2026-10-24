# Running your own copy

For developers and self-hosters. If you just want to chat, open [Ghost Chat](https://w3bcooki3.github.io/ghostchat/).

## Host it on GitHub Pages
1. Fork the repository.
2. **Settings → Pages → Deploy from a branch**, then choose `main` and `/ (root)`.
3. Deploy your own relay (see [relay/README.md](../relay/README.md)) and point `js/config.js` at it. Without a relay, people on VPNs and mobile data may not be able to connect.

The site is static: `index.html`, `css/`, `js/`, `fonts/` and `vendor/`. It works on any static host. If your host reads `_headers` (Cloudflare Pages, Netlify), security headers are applied too.

## Single-file build
```bash
npm run build
```
This writes `dist/ghostchat.html`, one self-contained file with everything inlined and a hash-based Content-Security-Policy, plus `dist/SHA256SUMS`. The build is deterministic, so anyone can rebuild and compare hashes against a release.

## Run it locally
```bash
npm install
npm run serve:local     # local signaling server, relay stand-in and the app
```

## Tests
```bash
npm test                # protocol and connectivity unit tests
npm run test:e2e        # real-browser tests: two Chromium windows chatting, plus network failure cases
```

## Project layout
| Path | What's there |
|---|---|
| `index.html`, `css/app.css`, `js/app.js` | The app and its interface |
| `js/protocol.js` | Key exchange, ratchet and message encryption |
| `js/session.js`, `js/relay.js`, `js/local.js`, `js/ice.js` | Connecting: direct WebRTC, the relay fallback and same-device tabs |
| `js/ui/` | Rendering, sanitising and file handling |
| `guide.html`, `security.html`, `legal.html` | How it works, Who can read what, Privacy & terms |
| `relay/` | The Cloudflare Worker relay |
| `vendor/` | Pinned PeerJS, ML-KEM and QR libraries, with their licenses |
| `fonts/` | Doto, Manrope and JetBrains Mono (SIL Open Font License) |
| `tools/build.mjs` | The single-file build |
| `tests/` | Unit and browser tests |

The protocol is specified in [SECURITY.md](../SECURITY.md), and review history is in [AUDIT.md](AUDIT.md).
