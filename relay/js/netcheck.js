// Network check: what can WebRTC on this network actually do? Gathers ICE candidates against
// the configured servers (no data is exchanged with any peer) and reports:
//   host     local candidates exist (mDNS-obfuscated ".local" names in most browsers)
//   srflx    a STUN server saw a public address
//   symmetric the public port changes per destination (symmetric NAT: direct connections
//            between two such networks, or two windows behind it, usually need a relay)
//   relay    a TURN relay allocated an address (the fallback that works almost everywhere)
//   loopback two connections inside this page could connect to each other directly
// Nothing here is sent anywhere except the normal STUN/TURN requests a connection makes.

const typeOf = (c) => (/ typ (\w+)/.exec(c) || [])[1];
const addrOf = (c) => { const p = c.split(' '); return { ip: p[4], port: p[5] }; };

async function gather(config, ms) {
  const pc = new RTCPeerConnection(config);
  const out = [];
  pc.addEventListener('icecandidate', (e) => { if (e.candidate?.candidate) out.push(e.candidate.candidate); });
  pc.createDataChannel('probe');
  await pc.setLocalDescription(await pc.createOffer());
  const t0 = Date.now();
  while (pc.iceGatheringState !== 'complete' && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
  pc.close();
  return out;
}

async function loopback(config, ms) {
  const a = new RTCPeerConnection(config), b = new RTCPeerConnection(config);
  a.addEventListener('icecandidate', (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {}));
  b.addEventListener('icecandidate', (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {}));
  const dc = a.createDataChannel('probe');
  const opened = new Promise((r) => { dc.onopen = () => r(true); setTimeout(() => r(false), ms); });
  try {
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    return await opened;
  } catch { return false; } finally { a.close(); b.close(); }
}

/** @param {RTCIceServer[]} iceServers */
export async function checkNetwork(iceServers, { timeoutMs = 5000 } = {}) {
  if (typeof RTCPeerConnection !== 'function') return { supported: false };
  const stun = iceServers.filter((s) => [].concat(s.urls).some((u) => /^stuns?:/.test(u)));
  const turn = iceServers.filter((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)));
  const [all, relayOnly, loop] = await Promise.all([
    gather({ iceServers: stun }, timeoutMs),
    turn.length ? gather({ iceServers: turn, iceTransportPolicy: 'relay' }, timeoutMs) : Promise.resolve([]),
    loopback({ iceServers: stun }, timeoutMs),
  ]);
  const host = all.filter((c) => typeOf(c) === 'host');
  const srflx = all.filter((c) => typeOf(c) === 'srflx');
  // Same public IP seen with different ports by different STUN servers → symmetric NAT.
  const byIp = new Map();
  for (const c of srflx) { const { ip, port } = addrOf(c); if (!byIp.has(ip)) byIp.set(ip, new Set()); byIp.get(ip).add(port); }
  const symmetric = stun.length > 1 && [...byIp.values()].some((ports) => ports.size > 1);
  return {
    supported: true,
    host: host.length > 0,
    mdns: host.some((c) => addrOf(c).ip?.endsWith('.local')),
    srflx: srflx.length > 0,
    symmetric,
    relay: relayOnly.some((c) => typeOf(c) === 'relay'),
    relayConfigured: turn.length > 0,
    loopback: loop,
  };
}

/** One plain-language verdict + advice for a check result. */
export function explain(r) {
  if (!r.supported) return { ok: false, text: 'This browser has no WebRTC support.' };
  if (r.relay) return { ok: true, text: 'A relay server is reachable, so connections should work from almost any network.' };
  if (!r.srflx && !r.host) return { ok: false, text: 'WebRTC is blocked here (no network candidates at all). A browser setting, extension or firewall is stopping it. Two windows of this same browser can still connect on this device.' };
  if (r.symmetric || !r.srflx) {
    return { ok: false, text: (r.symmetric ? 'Your network uses strict (symmetric) NAT, common with VPNs and mobile carriers' : 'No STUN server answered') +
      (r.relayConfigured ? ', and the relay server isn\'t reachable from here.' : ', and no relay server is configured.') +
      ' Direct connections will often fail. Add a TURN relay under Privacy → Customize, or use two windows of the same browser on this device.' };
  }
  return { ok: true, text: 'Direct connections should work with most networks.' + (r.relayConfigured ? ' The relay server isn\'t reachable, so "Hide my IP" won\'t work.' : ' No relay is configured, so "Hide my IP" won\'t work.') };
}
