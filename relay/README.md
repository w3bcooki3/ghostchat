# The Ghost Chat relay

Sometimes two browsers can't reach each other directly. This is common on mobile data, behind VPNs, on office and school networks, and on many home routers. When that happens, Ghost Chat sends its traffic through a **relay**, a small server that passes packets from one browser to the other.

The relay is a go-between, not a participant. Everything it handles has already been sealed by Ghost Chat's end-to-end encryption before it leaves your device.

## When is it used?

- **Usually never.** Your browsers first try to connect directly. If that works, which is the case on most home networks, the relay isn't involved.
- **When a direct connection fails**, or hasn't opened within two and a half seconds, the relay takes over. This usually takes a few seconds and you don't need to do anything.
- **Always, with Maximum privacy.** Choosing *Maximum privacy* (or *Hide my IP address*) before connecting skips the direct attempt entirely, so the other person never learns your IP address.

The relay uses an ordinary secure web connection (HTTPS on port 443), the same as any website. That's why it gets through VPNs and phone networks that block other kinds of connections.

## What the relay can and can't see

| | |
|---|---|
| **Your messages, files, names, reactions** | ✗ Can't see them. They're encrypted before they reach it. |
| **Your encryption keys** | ✗ Never sent to it. They exist only in your two browsers. |
| **The room code** | ✗ Never sent to it. The relay knows a room only by a scrambled 128-bit fingerprint of the full code, which it can't reverse or link to anything else. |
| **Your IP address** | ✓ Yes, like any website you visit. |
| **When you connect, and roughly how much you send** | ✓ Yes. Sizes are rounded up to fixed steps, and *constant-rate traffic* also hides when you talk. |

The relay **can't read, change or fake** anything. If a single packet were altered, Ghost Chat would notice and close the conversation rather than show it.

## What it keeps

Nothing. A room exists on the relay only while someone is connected to it. The relay's code doesn't log rooms or traffic, and logging is switched off for it on Cloudflare. Cloudflare, which runs the servers, still handles connection details on its network under [its own privacy policy](https://www.cloudflare.com/privacypolicy/).

## When the other person isn't there

The relay also helps Ghost Chat tell you what's going on instead of leaving you waiting:

- **If nobody holds the room** (the creator ended the chat, left, or the code expired), you'll see *"This room isn't open"* within a few seconds.
- **If the creator's phone has locked, or the browser was put in the background**, their page can't answer. You'll see *"The room exists, but the person who made it isn't answering"* within about ten seconds. Ask them to open Ghost Chat again, then try again.

---

## Running your own relay

The relay is a [Cloudflare Worker](https://workers.cloudflare.com/) that runs on Cloudflare's **free plan, with no payment card needed**. The code is [`ws-relay.js`](ws-relay.js), and you can read it in a few minutes.

**What it enforces:** only the sites you list may use it; each room is limited to one creator and up to eight joiners at once (in a group room, every pair of people gets its own relay room); frames over 66 KB are rejected; each connection is rate-limited. A creator whose page has gone silent for over two minutes is removed.

### Deploy it from GitHub (recommended)
1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com) and go to **Workers & Pages → Create → Import a repository**.
2. Choose your Ghost Chat repository, and under advanced settings set the **path** to `/relay`.
3. Deploy. Cloudflare reads [`wrangler.toml`](wrangler.toml), which sets up the room storage and your site's address, and redeploys automatically whenever you push.
4. Open `https://ghostchat-relay.<your-subdomain>.workers.dev/health`. It should say `ghostchat relay ok`.

### Or deploy from your computer
```bash
cd relay
npx wrangler deploy
```

### Point Ghost Chat at your relay
1. In `wrangler.toml`, set `ALLOWED_ORIGINS` to your site's address, for example `https://<you>.github.io`. Separate several addresses with commas.
2. In `js/config.js`, set:
   ```js
   export const RELAY_URL = 'wss://ghostchat-relay.<your-subdomain>.workers.dev';
   ```
3. In `index.html`, add the same address to `connect-src` in the Content-Security-Policy.
4. Run `npm run build`, then push.

**Deploy the relay and the site together.** The relay and the app were updated together so a joiner is let in only once the creator's page answers. An older relay still works with the new app, but stuck-host detection needs both updated.

**Free plan limits:** 100,000 requests a day. Each connection counts once, and incoming messages count about 20 to 1, so an hour of chatting uses a few hundred. Keep-alive pings are free.

### Testing it locally
```bash
cd relay && npx wrangler dev --var ALLOWED_ORIGINS:'*'
RELAY_TEST_URL=ws://127.0.0.1:8787 node tests/e2e-connectivity.mjs   # test against your Worker
node tests/e2e-connectivity.mjs                                      # or against the built-in stand-in
```

## Optional: TURN

[`turn-credentials.js`](turn-credentials.js) is an alternative that lets WebRTC relay traffic itself, through Cloudflare's TURN service. It has a large free allowance, but Cloudflare asks for a payment card on file. Setup steps are at the top of that file. Most people don't need it: the WebSocket relay above is enough.
