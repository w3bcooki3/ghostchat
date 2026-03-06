<div align="center">

```
 ██████╗ ██╗  ██╗ ██████╗ ███████╗████████╗     ██████╗██╗  ██╗ █████╗ ████████╗
██╔════╝ ██║  ██║██╔═══██╗██╔════╝╚══██╔══╝    ██╔════╝██║  ██║██╔══██╗╚══██╔══╝
██║  ███╗███████║██║   ██║███████╗   ██║       ██║     ███████║███████║   ██║   
██║   ██║██╔══██║██║   ██║╚════██║   ██║       ██║     ██╔══██║██╔══██║   ██║   
╚██████╔╝██║  ██║╚██████╔╝███████║   ██║       ╚██████╗██║  ██║██║  ██║   ██║   
 ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝   ╚═╝        ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝  
```

**Zero-knowledge · Military-grade · Browser-to-browser encrypted chat**

[![License: MIT](https://img.shields.io/badge/License-MIT-00ff88.svg?style=for-the-badge&labelColor=0a1018&color=00ff88)](LICENSE)
[![No Server](https://img.shields.io/badge/No_Server-P2P_Only-00ff88?style=for-the-badge&labelColor=0a1018&color=00ff88)](https://github.com)
[![No Accounts](https://img.shields.io/badge/No_Accounts-Zero_Logs-00ff88?style=for-the-badge&labelColor=0a1018&color=00ff88)](https://github.com)
[![Single File](https://img.shields.io/badge/Single_File-Drop_%26_Go-00ff88?style=for-the-badge&labelColor=0a1018&color=00ff88)](https://github.com)

*One HTML file. No install. No accounts. No trace.*

[🚀 Try it now](#getting-started) · [🔐 How it works](#how-it-works) · [✨ Features](#features) · [🛡️ Security](#security-model)

</div>

---

## 👻 What is Ghost Chat?

Ghost Chat is a **single-file, serverless, end-to-end encrypted** chat app that runs entirely in your browser. Two people can talk privately with military-grade encryption — no sign-up, no data stored anywhere, no middleman.

When you close the tab, **everything is gone. Forever.**

It's not a product. It's a tool — for people who care about privacy.

---

## ✨ Features

### 🔒 Security First
- **AES-256-GCM** app-layer encryption on every single message
- **ECDH P-256** key exchange — keys never leave your device
- **ECDSA P-256** message signing — every message is cryptographically verified
- **Ephemeral forward secrecy** — new key pair every session
- **Safety Numbers** — verify your peer out-of-band (Signal-style)
- **Replay attack protection** — sequence numbers + message ID deduplication

### 💬 Chat Features
- Real-time encrypted messaging with **optimistic delivery** (messages appear instantly)
- **Message queue** — messages are held locally and auto-delivered when connection restores
- **Burn After Read** — set messages to self-destruct after 5s / 10s / 30s / custom
- **Typing indicators** — encrypted so even your metadata is private
- **Read receipts** (✓ / ✓✓) with seen confirmation
- **Reply to messages** — quote any message in thread
- **Emoji reactions** — double-tap to react 👍 ❤️ 😂
- **Right-click context menu** — reply, copy, or delete locally

### 📁 File Sharing
- Send **any file type** up to 25MB
- Images render inline with a click-to-expand preview
- All files are chunked and encrypted before sending

### 🌐 Connection & Network
- **P2P via WebRTC** — traffic goes browser-to-browser, not through a server
- **Live latency indicator** — ping/pong heartbeats show your connection quality
- **Auto-reconnect** — peer reconnects automatically on interruption
- **Cover traffic** — randomized dummy packets make traffic analysis harder
- One-click **room code** or **invite link** sharing

### 🚨 Emergency Features
- **Panic Wipe** 🚨 — one tap destroys everything and redirects to Google
- **End Session** — purges all keys and messages from memory instantly

### 🎨 UX & Design
- Beautiful dark UI with animated particle network background
- Subtle `GHOSTCHAT` watermark throughout the interface
- Smooth message animations (slides in from sender direction)
- Custom emoji picker, avatar selector, status messages
- Fully **mobile responsive**

---

## 🚀 Getting Started

Ghost Chat is a **single HTML file**. That's it.

### Option 1 — Just open it
```bash
# Download the file
curl -O https://raw.githubusercontent.com/w3bcooki3/ghostchat/main/index.html

# Open in your browser
open ghostchat.html       # macOS
xdg-open ghostchat.html   # Linux
start ghostchat.html      # Windows
```

### Option 2 — Host it yourself (recommended for sharing)
```bash
# Any static host works — Python, Netlify, Vercel, GitHub Pages, etc.
python3 -m http.server 8080
# Then visit http://localhost:8080/ghostchat.html
```

### Option 3 — GitHub Pages
1. Fork this repo
2. Go to **Settings → Pages**
3. Set source to `main` branch
4. Your chat lives at `https://w3bcooki3.github.io/ghostchat/`

### Starting a chat
1. **Person A** clicks **Create Private Room** → gets a room code like `XQRT7K2F`
2. **Person A** shares the code (or invite link) with Person B
3. **Person B** pastes the code → clicks **Join**
4. Keys exchange automatically → encrypted channel opens 🔒

> 💡 You can also share a direct invite link: `https://yourhost/ghostchat.html#XQRT7K2F` — the joiner lands straight into the room.

---

## 🔐 How It Works

```
Person A                                    Person B
   │                                           │
   │  1. Generate ECDH keypair                 │  1. Generate ECDH keypair
   │  2. Generate ECDSA keypair                │  2. Generate ECDSA keypair
   │                                           │
   │──── public keys (via PeerJS relay) ──────▶│
   │◀─── public keys (via PeerJS relay) ───────│
   │                                           │
   │  3. Derive shared AES-256 key (ECDH)      │  3. Derive shared AES-256 key (ECDH)
   │     (relay never sees this key)           │     (relay never sees this key)
   │                                           │
   │──── encrypted + signed message ──────────▶│  4. Verify ECDSA signature
   │                                           │  5. Decrypt with AES-256-GCM
```

**The PeerJS relay server only brokers the initial WebRTC connection.** Once the P2P channel is open, all traffic flows directly between browsers. The relay sees encrypted WebRTC packets — it has no access to your messages, keys, or identities.

---

## 🛡️ Security Model

| Property | Details |
|---|---|
| **Transport** | DTLS 1.3 (WebRTC) |
| **App layer** | AES-256-GCM, fresh IV per message |
| **Key exchange** | ECDH P-256 (ephemeral per session) |
| **Signing** | ECDSA P-256 — every message authenticated |
| **Key derivation** | HKDF-SHA256 with domain separation |
| **Forward secrecy** | New keypair every session |
| **Message padding** | Fixed-size buckets (256 / 1KB / 4KB / 16KB) to resist length analysis |
| **Cover traffic** | Random-interval dummy packets |
| **Replay protection** | Sequence numbers + message ID dedup set |
| **Persistence** | Zero — nothing written to disk, localStorage, or IndexedDB |
| **Rate limiting** | 80 messages / 60 seconds per peer |

### What Ghost Chat does NOT protect against
- A compromised browser / device (keylogger, malicious extension)
- Screen recording or shoulder surfing
- Your ISP seeing that you're connected to PeerJS (but not the content)
- A malicious peer (the person you chose to talk to)

---

## 🧱 Tech Stack

Ghost Chat is intentionally minimal. Zero dependencies, zero build step.

| Layer | Technology |
|---|---|
| P2P signaling | [PeerJS](https://peerjs.com/) (WebRTC) |
| Encryption | [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) (native browser) |
| UI | Vanilla JS + CSS (no frameworks) |
| Fonts | Google Fonts (Syne, JetBrains Mono, Bebas Neue) |
| Build | None. It's one file. |

---

## 🗺️ Roadmap

Things that would be cool to add:

- [ ] Voice messages (encrypted audio blobs)
- [ ] Multi-peer rooms (3+ people)
- [ ] Disappearing room codes (time-limited)
- [ ] PWA / installable app
- [ ] Custom STUN/TURN server support for restrictive networks
- [ ] Export encrypted chat log
- [ ] Theming / light mode

---

## 🤝 Contributing

This is a tiny, single-file project so contributing is easy:

```bash
git clone https://github.com/w3bcooki3/ghostchat.git
cd ghost-chat

# Edit ghostchat.html
# Open in browser, test it
# Send a PR!
```

A few guidelines:
- Keep it a single file — that's a core design principle
- No npm, no build step, no frameworks
- Security changes should include a clear explanation of the threat model
- Keep the aesthetic dark, minimal, and cool 👻

---

## ⚠️ Disclaimer

Ghost Chat is built for privacy-conscious people and for fun. It is **not** a replacement for Signal or other production-hardened messengers for high-risk situations. The crypto is solid, but the codebase has not been independently audited.

Use your judgment. Stay safe out there. 👻

---

## 📄 License

MIT — do whatever you want with it. A star ⭐ is always appreciated.

---

*No accounts. No servers. No logs. Close the tab — it never happened.*

</div>
