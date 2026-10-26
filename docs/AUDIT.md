# Review of Ghost Chat v1 and what changed in v2

Findings from reviewing the original single-file app. Items marked **confirmed** were reproduced in a real two-browser run against a local PeerJS server before being fixed.

## Security

| # | Severity | Finding in v1 | Fix in v2 |
|---|---|---|---|
| S1 | **Critical** | **Unauthenticated key exchange.** ECDH and ECDSA public keys were sent together over the same channel, so the signatures proved nothing. The PeerJS signaling server (which relays WebRTC setup) or anyone controlling the path could substitute keys undetected. | The handshake is keyed by a 100-bit room secret that never reaches the server, with two-way key confirmation. A MITM without the code fails. *(Unit-tested.)* |
| S2 | **High** | **Safety numbers could never match.** Each side hashed `mine ‖ theirs`, so the numbers always differed and out-of-band verification was impossible. **Confirmed.** | Keys are sorted before hashing; both sides display the same number. *(Unit- and E2E-tested.)* |
| S3 | **High** | **Session hijack / denial of service.** The host accepted every incoming connection, overwrote the active one, and re-derived keys from the newcomer. Anyone who guessed the 4-character code (≈20 bits) could break an ongoing chat. **Confirmed.** | Only peers that prove the code are accepted; failed attempts are counted and shown; at most 3 pending handshakes. *(E2E-tested.)* |
| S4 | **High** | **Script execution from peer files.** Received images, including SVG, were opened with `window.open(blobURL)`, and the blob's MIME type came from the peer. An SVG or an HTML file labeled `image/*` would run script in the app's origin. | Images are identified by magic bytes (PNG/JPEG/GIF/WebP only) and shown in an `<img>` or in-app viewer. Everything else is downloaded as `application/octet-stream`. A strict CSP is a second barrier. *(E2E-tested with SVG and a spoofed JPEG.)* |
| S5 | Medium | **Replay counter outside the ciphertext and updated before verification.** A single forged frame with a huge counter would make every later legitimate message be dropped. | The counter is bound as AEAD associated data and checked for exact sequence; failures close the link. |
| S6 | Medium | **Third-party script from a CDN without Subresource Integrity**, plus Google Fonts (which shares your IP with Google). | PeerJS and fonts are vendored; CSP `script-src 'self'`; no third-party requests other than signaling. |
| S7 | Medium | **Message text shown in OS notifications**, which persist in notification history after the tab is closed. | Notifications are opt-in and say only "New message". |
| S8 | Low | `innerHTML` used for peer reactions (length-limited, but still HTML parsing of peer data). | All peer data goes through `textContent`; bidi-override characters are stripped from names and filenames. |
| S9 | Low | No click-jacking protection. | The app refuses to run in a frame; `_headers` adds `frame-ancestors 'none'`. |
| S10 | Low | One AES key for both directions with random nonces; no forward secrecy within a session. | Per-direction hash ratchet with a fresh key per message. |

## Reliability

| # | Finding in v1 | Fix in v2 |
|---|---|---|
| R1 | **File transfer was broken.** Encrypted chunks were larger than the receiver's 4,500-byte unpad limit, and the JSON channel rejected them ("Message too big for JSON channel"), which closed the connection. **Confirmed.** | Binary frames on a raw channel, 60 KiB chunks, backpressure, size/sequence enforcement. A 5 MB file round-trips byte-identical. |
| R2 | The 80-messages-per-minute rate limit counted every typing keystroke and every file chunk, so real messages were silently dropped. | Limits apply to resources (frame size, file size, concurrent transfers), not to the authenticated peer's message rate. 200 rapid messages arrive complete and in order. |
| R3 | Lost connections were final; there was no reconnect or queue (the README said otherwise). | Automatic reconnection with backoff for 3 minutes, fresh keys each time, an outbox with acknowledgements, and de-duplication. |
| R4 | The canvas particle animation ran an O(n²) loop every frame for the whole session. | Static CSS backdrop; no per-frame work. |
| R5 | Opening an invite link while the page was already open did nothing (`hashchange` was not handled). | Handled; the fragment is erased from the address bar after reading. |

## Claims removed or corrected

The v1 README and UI stated several things the code didn't do or that are not accurate:
"military-grade", "no servers" (a signaling server is required; a TURN relay may carry traffic), "DTLS 1.3", "message queue", "auto-reconnect", "live latency indicator", "GHOSTCHAT watermark", and "ECDSA signed" (the signatures provided no authentication). v2 implements the queue, reconnect and latency features, and the documentation describes the real behavior and its limits in [SECURITY.md](../SECURITY.md).

## Independent review of v2

A separate reviewer audited v2's protocol, session and UI code against SECURITY.md. They found no critical or high issues: no way to complete a handshake, inject frames or read content without the room code. These findings were fixed:

| Severity | Finding | Fix |
|---|---|---|
| Medium | Ephemeral ECDH private key, transcript and nonces stayed in memory after the handshake. A mid-session memory capture could re-derive the chain keys and decrypt earlier frames, contradicting the forward-secrecy claim. The reviewer demonstrated this with a working probe. | `Handshake.forget()` drops all key-derivation state once complete; the session drops its handshake reference. A unit test asserts nothing is retained, and the probe now fails. |
| Low–medium | When a reconnect replaced a link the host hadn't yet noticed was dead, in-flight incoming files leaked and could exhaust the 4-transfer limit. | Replacing a link fails in-flight transfers and clears typing state. |
| Low | Someone knowing only the public 5-character room ID could hold all 3 pending-handshake slots and block the real peer. | The oldest pending handshake is evicted instead of refusing the newcomer. |
| Low | Reply quotes used peer-supplied name and text, so a peer could fabricate a quote attributed to you. | Replies carry only the message ID; quotes are rendered from your own copy of the conversation. |
| Low | A peer-chosen file ID could collide with an existing message ID and overwrite its record. | Colliding file offers are cancelled. |
| Low | The PeerJS serialization of incoming connections wasn't checked. | Only `raw` connections are accepted. |
| Info | The duplicate-message ID set grew without bound. | Capped at 50,000 entries. |

## v3: post-quantum handshake, room lock, constant-rate traffic

v3 answered the question "what can still see what?" row by row. Changes:

| Gap in v2 | v3 change |
|---|---|
| A leaked room code could be used to connect in place of a peer who dropped. | **Room lock:** after the first join, only reconnects proving a rotating 384-bit resumption secret get in. |
| Key exchange vulnerable to future quantum computers ("harvest now, decrypt later"). | **Hybrid ECDH P-384 + ML-KEM-1024**, HKDF/HMAC-SHA-384 throughout. |
| Relays and networks could see when and how much you talk. | **Constant-rate mode:** identical 4 KB frames every 250 ms, with long messages fragmented. Verified on the wire by the E2E suite. |
| The safety number changed on every reconnect, which trained people to ignore it. | A proven resume keeps the original number and your verification. A fresh join after an unlock changes it and resets verification. |
| IP hidden only through a buried toggle. | **Maximum privacy** preset on the home screen: relay-only, constant-rate traffic, no typing indicator or read receipts, conversation hidden when you switch away. |
| No way to verify what was deployed. | Deterministic single-file build with `dist/SHA256SUMS`. CI fails if the committed build doesn't match the source, and deploys only after all tests pass. |

### Independent review of v3 (two rounds)

A separate reviewer audited the v3 handshake, lock and session code, with working exploit scripts. All findings were fixed, and each has a regression test.

| Severity | Finding | Fix |
|---|---|---|
| **Critical** | Pending handshakes shared the resumption secret by reference, and rotating it zeroed that shared array in place. An attacker with only the room code, holding a half-open connection, could "resume" with an all-zero secret, take over the conversation, and inherit the "Verified" mark. | The host reads its policy when the HELLO arrives and works on copies. All-zero secrets are refused. Every half-open handshake is closed when the secret rotates. |
| High | A connection opened before the room locked could still complete a first join afterwards. | Same fix: the lock is evaluated at HELLO time. |
| High (round 2) | The first fix stored "lost CONFIRM" candidates from first-join attempts too, which a code-holder could replay as proof of continuity while the room was unlocked. | Candidates are tagged. A first-join candidate is accepted only while unlocked and is never treated as continuity; untagged secrets default to untrusted. |
| Medium | A lost CONFIRM left the two sides with different secrets, so the session could never resume. | HELLO names its secret with a key ID. The host keeps uncommitted secrets as candidates, at most 4, cleared on every commit. |
| Medium | Forged LOCKED frames or bad HELLOs permanently ended a resuming session. | Retried within the reconnect window; the session ends after 4 refusals. |
| Medium | Constant-rate mode leaked long messages as larger frames, and timers slowed down in background tabs. | Fragmentation into 4 KB frames, and a Web Worker clock. File transfers and the final goodbye remain visible, as documented. |
| Medium | Toggling constant-rate mode dropped queued messages. | The queue is re-sent in the new mode. |
| Low | Fragments queued for a replaced link could corrupt the new one. Unlock had no confirmation. Some error paths didn't wipe handshake state. | Queues are cleared when a link is replaced. Unlock asks for confirmation with a warning. Every failure path calls `forget()`. |
| Info | Keeping the safety number across resumes means a stolen resumption secret isn't revealed by re-comparing it. | Documented; the panel shows a **Live keys** fingerprint of the current connection. |

## v3.1 review (October 2026)

A full pass over the code, the deployment files and the documentation, with the existing unit and real-browser suites run before and after every change. Each fix has a regression test.

| Severity | Finding | Fix |
|---|---|---|
| **Critical** (availability) | In the working copy, `js/ice.js` and `js/local.js` had been renamed by a file-sync conflict (`ice (# Name clash …).js`), so `session.js` failed to import and the app could not start at all. | Restored the names. New `tests/project.test.mjs` fails if any module import doesn't resolve, if a module has an unexpected file name, or if a page references a missing file. |
| **High** (privacy) | Any peer could switch off *your* constant-rate traffic: a `shape: off` message (from the toggle, or forged with a modified client) turned it off on both sides, with only a status line to show for it. Someone who chose Maximum privacy could be silently downgraded. | Constant-rate traffic is on while anyone wants it, and each person can only withdraw their own request. E2E test: neither the peer's toggle nor a forged message stops it; only the person who turned it on can. |
| Medium (privacy) | Leaving the page ended the session but left the transcript in the page. Browsers keep recently left pages in the back/forward cache, so navigating away and pressing Back could bring the conversation back on screen. | `pagehide` now wipes the transcript as well as the keys, `pageshow` from the cache reloads a fresh page, and `_headers` sends `Cache-Control: no-store` for the pages. The automated Chromium used by the tests doesn't use the back/forward cache, so the original leak couldn't be reproduced there; the E2E test checks the outcome (Back shows a fresh home screen) and the fix is defensive. |
| Medium (deployment) | `_headers` was missing from the working copy, and the published one listed a CSP without the WebSocket relay's origin. Browsers enforce the header CSP *and* the `<meta>` CSP, so on Netlify or Cloudflare Pages the relay (the fallback for VPNs and mobile data) would have been blocked. SECURITY.md also described a CI check that didn't exist in the repository. | `_headers` restored with the same CSP as `index.html` plus `frame-ancestors 'none'`; a unit test keeps them identical and checks the relay origin is allowed. `.github/workflows/ci.yml` added: unit tests, reproducible-build check against the committed `dist/`, and the real-browser suite. |
| Low–medium (DoS) | A peer could stream unlimited **empty** file chunks for a declared file: each passed the size check, so the chunk list, and the tab's memory, grew without bound. | Chunks must carry 1 byte to 60 KiB; anything else aborts the transfer. Unit tests in `tests/session.test.mjs`. |
| Low (groups) | Every member receives a message under the same ID, so member B could reuse member A's ID to claim it at member C before A's copy arrived. C then dropped A's real message as a "duplicate". | A clash is stored per author instead of being dropped, and edits and unsends resolve to the sender's own message only. E2E test with three browsers. |
| Low (accessibility) | In the light themes the *Join* button was white text on a transparent background until the code was complete; several text colours on the info pages and the TX/RX strip failed WCAG AA contrast; the join and connect screens had no level-one heading; a table header was empty. | Fixed. axe-core reports no violations on the home, join, connect and chat screens (light and dark) or the three info pages. |
| Info | The chat watermark sat behind message text. | It fades out once the conversation has messages. |
| Info | Development dependency `body-parser` (via the local PeerJS test server) had a published DoS advisory. | Updated through `npm audit fix`; `npm audit` is clean. Nothing from `node_modules` ships to users. |

## Chat layout (October 2026)

The chat screen became three columns: room, conversation, details. No protocol, crypto or session code changed. The UI work stays inside the existing rules: peer names and avatars still go into the page as text only, and the new icon buttons are built from fixed SVG paths in `js/app.js`, never from message content. The rail's **Wipe** button runs the same panic routine as the header button, so it's instant with a mouse and needs a hold on touch screens. Theme, message layout and the wire toggle last for the tab only and are never stored. axe-core reports no colour-contrast or ARIA violations on the chat screen in any of the ten themes, in either message layout, on any of the four details tabs.

## Full re-audit (October 2026)

Three independent reviews (crypto and protocol; interface and page security; relay and supply chain) plus automated checks. Each finding was confirmed against the code, or by reproducing it, before it was fixed. Every fix has a test.

**Checks that found nothing:**
- **Vendored code:**
  - `uqr` is byte-identical to the npm package.
  - `peerjs` is byte-identical except for its source-map comment.
  - The ML-KEM bundle produces identical output to npm `@noble/post-quantum@0.7.1` on 200 random seeds, covering key generation, encapsulation, decapsulation and the rejection of tampered ciphertexts.
- **Dependencies:** `npm audit` reports 0 vulnerabilities.
- **Shipped code:** no HTML sinks, `eval` or storage APIs.
- **Content Security Policy:** none of the pages allows `unsafe-inline` or `unsafe-eval`.
- **Test hook:** it cannot appear in a production build.

| Severity | Finding | Fix |
|---|---|---|
| Medium | **Anyone holding the room code could pose as the host to newcomers.** Every member, including one who had been removed, knew the code. While the host's connection was down, such a person could take over the room's lobby, admit the next newcomer themselves and sit in the middle. | **Invites are single-use.** Once someone is let in and nobody else is waiting, the host's browser moves the lobby to a fresh code. Removing someone, or turning off *members can invite*, also retires the code. Only the host, and members it allows to invite, learn the new one. E2E test: a removed member's code no longer reaches the room. |
| Medium | **The relay's Origin check was its only gate.** Scripts can send any Origin, so the relay could be used as an open pipe to burn through the free daily allowance. | Added a per-IP connection limit (rate-limit binding), a per-connection byte budget, and rate limits that count text frames too. Text frames are capped by size and accepted only from the host. Joiners are dropped if the host never accepts them within 20 s. Nothing reaches the host before it accepts. Comments and the README are corrected. `tests/relay-worker.test.mjs` runs the real Worker against a stand-in for the Cloudflare runtime. |
| Medium | **The third-party Open Relay TURN service (metered.ca) was on by default and not disclosed.** It saw users' IP addresses, and in Maximum mode it could carry the conversation. | Off by default. Ghost Chat's own relay already covers those networks. |
| Medium | **The "can run code" warning could be skipped with trailing dots.** `invoice.pdf.bat.` was judged as having no extension, then saved as `invoice.pdf.bat`. | The check now judges the exact name that will be saved, and ignores trailing dots and spaces itself. More dangerous file types are on the list. |
| Medium | **A peer could call itself "You", or copy another member's name and avatar.** It could also rename itself later, which relabelled its earlier messages. | A name is set once per person and never changes. Reserved names are refused, and duplicates are numbered. Names must contain a letter or digit. Invisible and blank-looking characters are stripped. |
| Medium/Low | **A lost CONFIRM on the first join left the two sides with different safety numbers for good.** A relay could cause this on purpose. | The host keeps that join's safety number with its candidate secret and shows it when the joiner resumes. Unit test with two real sessions. |
| Low | **Deeply nested JSON could freeze a link.** A `JSON.stringify` RangeError while echoing a ping left the link's receive queue rejected. | JSON nested deeper than 8 levels is refused. Ping values are echoed only if they are plain integers. Any error while handling a frame now closes the link instead of leaving it silently frozen. |
| Low | **Handshake secrets weren't wiped when a link closed mid-handshake.** | `Link.close()` now calls `forget()`. |
| Low | **Floods.** Unlimited system notices (unsend-all, timer, shape) and unlimited waiting knocks were possible, and incoming files were capped only per pair. | Room-wide actions are rate-limited per person, and the page keeps at most 300 notices. At most 4 people can wait to be let in, and 8 lobby links can be open at once. Incoming files are capped at 300 MB across the whole room. |
| Low | **Links and Save could be opened without their confirmation.** A middle-click or a drag skipped it, and a disguised address like `https://bank.example@evil.example` wasn't flagged. | Middle-clicks go through the confirmation, and links can't be dragged out. A risky file has no download address until you confirm. The link dialog names the real site and warns about anything before an `@`. |
| Low | **An unsent or expired image could stay open in the viewer**, and the message menu could still copy a removed message. | Both now close along with the message. |
| Low | **Peer names stayed in hidden markup after a session ended.** | Cleared on teardown. E2E test: the other person's name is nowhere in the page afterwards. |
| Low | **A reused joiner id on the relay could get a newcomer dropped**, and the relay could announce that the host left twice. | Ids held by sockets that are still closing aren't reused. A leave is announced only if no live joiner has that id, and each socket's teardown runs once. |
| Low | **`.gitignore` didn't cover Wrangler's local secrets file.** The TURN credential worker had no rate limit and sent `Access-Control-Allow-Origin: null`. | Now ignored. Added an optional per-IP limit and a 2-hour credential lifetime, and the header is left out on refusals. |
| Docs | **Several claims in SECURITY.md and security.html were wrong:** "room lock refuses the full code", "the host can unlock once", "75 bits never leave the browsers", the 15-second window, and "wiped whether it succeeds or fails". | Corrected to match the code. |

**Known and accepted:**
- **Members trusted to invite.** A member the host allows to invite knows the current code, so the host is trusting them with it. Safety numbers still reveal anyone in the middle.
- **Lobby traffic isn't constant-rate.** It is a few small messages while someone waits to be let in.
- **A forged `LOCKED` frame from the relay** can make a first-time joiner fail with "room is full". This is denial of service only, and the relay can drop traffic anyway.
- **Quotes in replies** keep up to 120 characters of the original message, so a quote can outlive a disappearing message.
