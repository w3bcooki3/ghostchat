// Local test/dev server: static files + an embedded PeerJS signaling server.
// `node tests/serve.mjs [appPort] [signalPort]`. Rewrites config.js and the CSP so the app
// talks to 127.0.0.1 instead of the public PeerJS server. Development only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PeerServer } from 'peer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };

export async function startServers({ appPort = 0, signalPort = 0, test = true, deadSignal = false } = {}) {
  const signal = await new Promise((resolve) => {
    const s = PeerServer({ port: signalPort, host: '127.0.0.1', path: '/gc', allow_discovery: false }, (srv) => resolve(srv));
    void s;
  });
  // deadSignal: point the app at a port nothing listens on (signaling server unreachable).
  const sPort = deadSignal ? 9 : signal.address().port;
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(root, p));
    if (!file.startsWith(root + path.sep) || /[\\/](node_modules|tests|\.git)[\\/]/.test(file.slice(root.length))) { res.writeHead(404); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      let body = buf;
      const rel = path.relative(root, file).replaceAll('\\', '/');
      if (rel === 'js/config.js') {
        body = buf.toString('utf8')
          .replace(/host: '0\.peerjs\.com',\s*port: 443,\s*path: '\/',\s*secure: true,/, `host: '127.0.0.1', port: ${sPort}, path: '/gc', secure: false,`)
          .replace('export const ICE_SERVERS = null;', 'export const ICE_SERVERS = [];');
      }
      if (rel.endsWith('.html')) {
        let html = buf.toString('utf8').replace(/connect-src [^;"]+/, `connect-src http://127.0.0.1:${sPort} ws://127.0.0.1:${sPort}`);
        if (test) html = html.replace('<html lang="en">', '<html lang="en" data-test="1">');
        body = html;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    });
  });
  await new Promise((r) => server.listen(appPort, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  return { url, signalPort: sPort, close: () => { server.close(); signal.close?.(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startServers({ appPort: +process.argv[2] || 8090, signalPort: +process.argv[3] || 9000, test: false });
  console.log(`Ghost Chat (local signaling on :${s.signalPort}) → ${s.url}`);
}
