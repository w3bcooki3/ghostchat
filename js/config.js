// Deployment configuration.
//
// SIGNALING: the PeerJS server that introduces the two browsers. It sees peer
// IDs, IP addresses and connection timing — never room secrets, keys or content
// (see SECURITY.md). Self-host one with `npx peerjs --port 9000` and point this
// at it; remember to update connect-src in index.html's Content-Security-Policy.
export const SIGNALING = {
  host: '0.peerjs.com',
  port: 443,
  path: '/',
  secure: true,
  key: 'peerjs',
};

// ICE servers. `null` uses PeerJS defaults (Google STUN + PeerJS public TURN).
// Provide your own TURN for reliable connectivity behind strict NATs, e.g.
// [{ urls: 'stun:stun.example.org:3478' },
//  { urls: 'turn:turn.example.org:3478', username: 'u', credential: 'p' }]
export const ICE_SERVERS = null;

export const LIMITS = {
  maxText: 8000,                 // characters per message
  maxFile: 100 * 1024 * 1024,    // bytes per file
  maxIncomingFiles: 4,           // concurrent incoming transfers
  reconnectWindowMs: 3 * 60_000, // how long to try restoring a dropped link
  handshakeTimeoutMs: 15_000,
  pingIntervalMs: 4_000,
  deadAfterMs: 25_000,           // no frames for this long → link considered dead
};
