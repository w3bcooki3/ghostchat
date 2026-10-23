// Which STUN/TURN servers a connection uses. TURN relays are what make a connection work when
// a direct one can't (phones on mobile data, VPNs, symmetric NAT, strict firewalls). A relay
// only ever carries Ghost Chat's encrypted frames; it can't read them.
//
// Order of preference, all combined so ICE can pick the best path:
//   1. TURN_ENDPOINT (config.js): your own credential endpoint, e.g. the Cloudflare Worker in
//      relay/ or a Metered URL. Dependable, and the recommended setup for a public site.
//   2. ICE_SERVERS (config.js): fixed servers you list yourself.
//   3. PUBLIC_RELAY (config.js): the free Open Relay project (metered.ca), best-effort and
//      shared by everyone using it. Short-lived credentials are derived in the browser with
//      the project's published static-auth secret (standard TURN REST scheme).
//   4. Any relay the person added in the app (Privacy → Customize).
import { ICE_SERVERS, TURN_ENDPOINT, PUBLIC_RELAY } from './config.js';

export const DEFAULT_STUN = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

const OPEN_RELAY_HOST = 'staticauth.openrelay.metered.ca';
const OPEN_RELAY_SECRET = 'openrelayprojectsecret'; // published by the Open Relay project for public use
const CACHE_MS = 30 * 60_000;
let cached = null; // { at, servers } from TURN_ENDPOINT

const validUrl = (u) => typeof u === 'string' && /^(stun|turns?):[^\s]{1,250}$/.test(u) && !/:53(\?|$)/.test(u); // browsers block port 53

/** Keeps only well-formed ICE server entries (anything fetched is treated as untrusted). */
export function sanitizeIce(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list.slice(0, 12) : []) {
    if (!s || typeof s !== 'object') continue;
    const urls = [].concat(s.urls ?? s.url ?? []).filter(validUrl).slice(0, 8);
    if (!urls.length) continue;
    const e = { urls };
    if (urls.some((u) => u.startsWith('turn'))) {
      if (typeof s.username !== 'string' || typeof s.credential !== 'string') continue;
      e.username = s.username.slice(0, 512); e.credential = s.credential.slice(0, 512);
    }
    out.push(e);
  }
  return out;
}

/** TURN REST credentials (draft-uberti-behave-turn-rest): user = expiry:name, pass = b64(HMAC-SHA1(secret, user)). */
export async function restCredential(secret, name = 'ghostchat', ttlSec = 6 * 3600) {
  const username = `${Math.floor(Date.now() / 1000) + ttlSec}:${name}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username)));
  return { username, credential: btoa(String.fromCharCode(...mac)) };
}

async function openRelay() {
  const { username, credential } = await restCredential(OPEN_RELAY_SECRET);
  return {
    urls: [
      `turn:${OPEN_RELAY_HOST}:80`,
      `turn:${OPEN_RELAY_HOST}:80?transport=tcp`,
      `turn:${OPEN_RELAY_HOST}:443`,
      `turns:${OPEN_RELAY_HOST}:443?transport=tcp`,   // TLS on 443: looks like HTTPS, passes most VPNs/firewalls
    ],
    username, credential,
  };
}

async function fromEndpoint() {
  if (!TURN_ENDPOINT) return [];
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.servers;
  try {
    const r = await fetch(TURN_ENDPOINT, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const servers = sanitizeIce(Array.isArray(j) ? j : j?.iceServers);
    if (!servers.length) throw new Error('no usable servers in the response');
    cached = { at: Date.now(), servers };
    return servers;
  } catch (e) {
    console.warn('[ghost] TURN_ENDPOINT unavailable (check the URL and connect-src in the CSP):', e.message);
    return [];
  }
}

/** Everything a new connection should try. Never throws. */
export async function resolveIce(extra = []) {
  const [mine, open] = await Promise.all([
    fromEndpoint(),
    PUBLIC_RELAY ? openRelay().catch(() => null) : null,
  ]);
  const base = ICE_SERVERS ? sanitizeIce(ICE_SERVERS) : DEFAULT_STUN;
  return [...mine, ...base, ...(open ? [open] : []), ...extra];
}

/** Human-readable summary of what's configured (for the network check). */
export function relaySources() {
  return { endpoint: !!TURN_ENDPOINT, fixed: !!(ICE_SERVERS && ICE_SERVERS.some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)))), publicRelay: !!PUBLIC_RELAY };
}
