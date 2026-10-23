# Ghost Chat relays

Browsers try to connect directly first. On many real networks that's impossible: phones on mobile data, VPNs, symmetric NAT, offices, and networks that block TURN servers. Then a relay forwards Ghost Chat's frames, which are **already end-to-end encrypted**. A relay can't read, change or forge anything; tampering is detected and closes the chat.

## 1. WebSocket relay (recommended, free, no card)

`ws-relay.js` is a Cloudflare Worker with a Durable Object. It runs on the **Workers Free plan**, which doesn't ask for payment details. Traffic is ordinary HTTPS/WebSocket on port 443, so it gets through VPNs and phone networks.

**What it sees:** IP addresses, timing, message sizes, and ciphertext. **What it never sees:** the room code, keys, names or content. Rooms on the relay are named by a 128-bit hash of the room key (derived from the full 20-character code), so nobody without the code can find, squat or watch a room, and the relay can't link a room to the public signaling ID.

### Deploy from the dashboard (no tools needed)
1. Sign in at dash.cloudflare.com and go to **Workers & Pages → Create → Create Worker**. Name it `ghostchat-relay`, then **Deploy**.
2. Click **Edit code**, replace everything with the contents of `ws-relay.js`, then **Deploy**.
3. **Settings → Bindings → Add → Durable Object**. Set the variable name to `ROOMS` and the class to `Room` (from this Worker).
4. **Settings → Variables and secrets → Add**. Name: `ALLOWED_ORIGINS`, type: text, value: your site's origin, e.g. `https://<you>.github.io` (comma-separate several).
5. Open `https://ghostchat-relay.<your-subdomain>.workers.dev/health`. It should say `ghostchat relay ok`.

### Or deploy with Wrangler
```bash
cd relay
npx wrangler deploy          # uses wrangler.toml: Durable Object binding + SQLite migration
```

### Point Ghost Chat at it
In `js/config.js`:
```js
export const RELAY_URL = 'wss://ghostchat-relay.<your-subdomain>.workers.dev';
```
In `index.html`, add the same origin to `connect-src` in the Content-Security-Policy:
```
connect-src https://0.peerjs.com wss://0.peerjs.com wss://ghostchat-relay.<your-subdomain>.workers.dev
```
Then `npm run build` and push.

**Limits on the free plan:** 100,000 requests per day. Each connection is one request, and incoming messages count 20:1, so an hour of chatting costs a few hundred. Keep-alive pings are free. The Worker also enforces a 66 KB frame cap, a per-socket rate limit and an origin check.

## 2. TURN credentials (optional)

`turn-credentials.js` hands browsers short-lived credentials for Cloudflare Realtime TURN (1,000 GB/month free, but Cloudflare asks for a payment method on file). TURN lets WebRTC itself relay. Set `TURN_ENDPOINT` in `js/config.js` to the Worker's URL. Setup steps are at the top of the file.

## Testing locally
```bash
cd relay && npx wrangler dev --var ALLOWED_ORIGINS:'*'
RELAY_TEST_URL=ws://127.0.0.1:8787 node tests/e2e-connectivity.mjs   # against the real Worker
node tests/e2e-connectivity.mjs                                      # against tests/relay-mock.mjs
```
