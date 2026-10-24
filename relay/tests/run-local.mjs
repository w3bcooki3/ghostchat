// Local development: starts a PeerJS signaling server on :9000 and serves the app on :8090
// wired to it, so two browser tabs can chat without any internet access.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kids = [
  spawn('node', ['tests/peerserver.cjs'], { cwd: root, stdio: 'inherit', env: { ...process.env, PORT: '9000' } }),
  spawn('node', ['tests/serve.mjs'], { cwd: root, stdio: 'inherit', env: { ...process.env, PORT: '8090', TEST_SIGNAL_PORT: '9000' } }),
];
console.log('Open http://127.0.0.1:8090 in two tabs (or two browsers). Ctrl+C to stop.');
process.on('SIGINT', () => { kids.forEach((k) => k.kill()); process.exit(0); });
