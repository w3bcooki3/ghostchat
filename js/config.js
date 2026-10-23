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

// ── Relays (TURN): what makes PC ↔ phone work across mobile data, VPNs and strict NAT ──
// A relay only ever sees encrypted frames. See js/ice.js for how these combine.
//
// TURN_ENDPOINT: a URL that returns fresh TURN credentials as JSON ({ iceServers: [...] } or
// [...]). The dependable option for a public site, and free at small scale:
//   * Cloudflare Realtime TURN (1,000 GB/month free): deploy relay/turn-credentials.js and
//     put its URL here, e.g. 'https://ghostchat-turn.<you>.workers.dev/'
//   * Metered (free tier): 'https://<app>.metered.live/api/v1/turn/credentials?apiKey=<key>'
// Then add the URL's origin to connect-src in index.html's Content-Security-Policy.
export const TURN_ENDPOINT = null;

// RELAY_URL: your Ghost Chat WebSocket relay (relay/ws-relay.js on Cloudflare Workers, free
// plan, no card). The fallback that works on almost any network — VPNs, phones on mobile
// data, strict NAT — because it's ordinary HTTPS on port 443. It only ever carries end-to-end
// encrypted frames. Add its origin (wss://…) to connect-src in index.html's CSP.
export const RELAY_URL = 'wss://ghostchat-relay.mrsaini281-678.workers.dev';
// Joiners try a direct connection first and bring in the relay after this long (or at once
// if the direct attempt fails, or in "Hide my IP" mode, where the relay is what hides it).
export const RELAY_AFTER_MS = 2500;

// PUBLIC_RELAY: also use the free, shared Open Relay project as a fallback (no signup;
// best-effort, limited monthly capacity shared by everyone using it).
export const PUBLIC_RELAY = true;

// ICE_SERVERS: `null` uses Cloudflare + Google STUN. Or list your own, e.g.
// [{ urls: 'stun:stun.example.org:3478' },
//  { urls: 'turns:turn.example.org:443?transport=tcp', username: 'u', credential: 'p' }]
export const ICE_SERVERS = null;

export const LIMITS = {
  maxText: 8000,                 // characters per message
  maxFile: 100 * 1024 * 1024,    // bytes per file
  maxIncomingFiles: 4,           // concurrent incoming transfers
  reconnectWindowMs: 3 * 60_000, // how long to try restoring a dropped link
  inviteTtlMs: 10 * 60_000,      // an unused room code stops working after this long
  inviteMaxMs: 60 * 60_000,      // extending can't push it past this (from creation)
  handshakeTimeoutMs: 30_000,  // relayed connections on phones can take a while to set up
  pingIntervalMs: 4_000,
  deadAfterMs: 25_000,           // no frames for this long → link considered dead
};
