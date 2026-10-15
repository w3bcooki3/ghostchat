// Static server for local testing. With TEST_SIGNAL_PORT set it rewrites config.js
// to use a local PeerJS server and widens the CSP connect-src accordingly.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = +(process.env.PORT || 8090);
const sig = process.env.TEST_SIGNAL_PORT;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.md': 'text/plain; charset=utf-8' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (!p || p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    let body = buf;
    if (sig && p === 'js/config.js') {
      body = buf.toString()
        .replace(/host: '0\.peerjs\.com',\s*port: 443,\s*path: '\/',\s*secure: true,/, `host: '127.0.0.1', port: ${sig}, path: '/gc', secure: false,`)
        .replace('export const ICE_SERVERS = null;', 'export const ICE_SERVERS = [];')
        .replace('reconnectWindowMs: 3 * 60_000', `reconnectWindowMs: ${process.env.TEST_RECONNECT_MS || 180000}`)
        .replace('deadAfterMs: 25_000', `deadAfterMs: ${process.env.TEST_DEAD_MS || 25000}`);
    }
    if (sig && p === 'index.html') {
      body = buf.toString()
        .replace('connect-src https://0.peerjs.com wss://0.peerjs.com', `connect-src http://127.0.0.1:${sig} ws://127.0.0.1:${sig}`)
        .replace('<html lang="en">', '<html lang="en" data-test="1">');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  });
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}` + (sig ? ` (test signaling :${sig})` : '')));
