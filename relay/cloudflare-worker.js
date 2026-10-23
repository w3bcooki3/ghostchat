// Ghost Chat TURN credential endpoint — a Cloudflare Worker.
//
// Hands browsers short-lived credentials for Cloudflare Realtime TURN (1,000 GB/month free).
// Your TURN API token stays here, server-side; browsers only ever get credentials that
// expire. The relay carries Ghost Chat's encrypted frames and can't read them.
//
// Setup (about 10 minutes, free):
//   1. Cloudflare dashboard → Realtime → TURN → Create a TURN key. Note its Key ID and API token.
//   2. Workers & Pages → Create → Worker → paste this file → Deploy.
//   3. Worker → Settings → Variables and secrets:
//        TURN_KEY_ID          (text)    the Key ID
//        TURN_KEY_API_TOKEN   (secret)  the API token
//        ALLOWED_ORIGINS      (text)    e.g. https://<you>.github.io   (comma-separate several)
//   4. In Ghost Chat's js/config.js set TURN_ENDPOINT to the worker URL, and add the worker's
//      origin (https://<name>.<you>.workers.dev) to connect-src in index.html's CSP.
//
// Optional hardening: Workers → your worker → Settings → add a Rate Limiting rule.

const TTL_SECONDS = 6 * 3600;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const ok = allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': ok ? origin : 'null',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: ok ? 204 : 403, headers: cors });
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers: cors });
    if (!ok) return new Response('origin not allowed', { status: 403, headers: cors });

    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    });
    if (!r.ok) return new Response('upstream error', { status: 502, headers: cors });
    const { iceServers } = await r.json();
    // Browsers block port 53; drop those URLs so ICE doesn't wait on them.
    const clean = (iceServers || []).map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
      .filter((s) => s.urls.length);
    return new Response(JSON.stringify({ iceServers: clean }), { headers: { ...cors, 'Content-Type': 'application/json' } });
  },
};
