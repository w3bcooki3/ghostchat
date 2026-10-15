// Builds dist/ghostchat.html: one self-contained file (fonts, styles, PeerJS, ML-KEM and the
// app inlined) with a hash-based Content-Security-Policy, plus dist/SHA256SUMS.
// Deterministic: the same sources always produce byte-identical output, so anyone can
// rebuild and compare against a published release (CI checks this on every push).
// No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const REPO = 'https://github.com/w3bcooki3/ghostchat';

// CSS with fonts as data: URIs
let css = read('css/app.css').replace(/url\(\.\.\/fonts\/([^)]+)\)/g, (_, f) =>
  `url(data:font/woff2;base64,${fs.readFileSync(path.join(root, 'fonts', f)).toString('base64')})`);

// --test-signal=PORT produces dist/ghostchat.test.html wired to a local PeerJS server (for CI only).
const testPort = (process.argv.find((a) => a.startsWith('--test-signal=')) || '').split('=')[1];

// Minimal module linker for our own ES modules plus the vendored ML-KEM build.
const order = ['config', 'protocol', 'session', 'fog', 'app'];
let bundle = 'const __mods = {};\n';
{
  const src = read('vendor/noble-ml-kem1024-0.7.1.min.js');
  const m = src.match(/export\{(\w+) as ml_kem1024\};?\s*$/);
  if (!m) throw new Error('unexpected ML-KEM vendor format');
  bundle += `__mods.mlkem = (() => {\n${src.slice(0, m.index)}\nreturn { ml_kem1024: ${m[1]} };\n})();\n`;
}
for (const name of order) {
  let src = read(`js/${name}.js`);
  if (testPort && name === 'config') src = src
    .replace(/host: '0\.peerjs\.com',\s*port: 443,\s*path: '\/',\s*secure: true,/, `host: '127.0.0.1', port: ${testPort}, path: '/gc', secure: false,`)
    .replace('export const ICE_SERVERS = null;', 'export const ICE_SERVERS = [];');
  const exported = [];
  src = src.replace(/^import \{ ml_kem1024 \} from '\.\.\/vendor\/noble-ml-kem1024-0\.7\.1\.min\.js';$/m, 'const { ml_kem1024 } = __mods.mlkem;');
  src = src.replace(/^import \* as (\w+) from '\.\/(\w+)\.js';$/gm, (_, ns, m) => `const ${ns} = __mods.${m};`);
  src = src.replace(/^import \{([^}]+)\} from '\.\/(\w+)\.js';$/gm, (_, names, m) => `const {${names.replace(/\bas\b/g, ':')}} = __mods.${m};`);
  src = src.replace(/^export (async function|function|class|const|let)\s+(\w+)/gm, (_, kw, n) => { exported.push(n); return `${kw} ${n}`; });
  if (/^\s*(import|export)\b/m.test(src)) throw new Error(`Unsupported import/export form in ${name}.js`);
  bundle += `__mods.${name} = (() => {\n${src}\nreturn { ${exported.join(', ')} };\n})();\n`;
}
const peerjs = read('vendor/peerjs-1.5.5.min.js');
const sha = (s) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const icon = `data:image/svg+xml;base64,${fs.readFileSync(path.join(root, 'icon.svg')).toString('base64')}`;

let html = read('index.html');
const cspOld = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];
const connect = testPort ? `http://127.0.0.1:${testPort} ws://127.0.0.1:${testPort}` : cspOld.match(/connect-src ([^;]+)/)[1];
const csp = [
  "default-src 'none'",
  `script-src ${sha(peerjs)} ${sha(bundle)}`,
  `style-src ${sha(css)}`,
  "font-src data:",
  "img-src blob: data:",
  "media-src 'none'",
  `connect-src ${connect}`,
  "worker-src blob:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

html = html
  .replace(cspOld, csp)
  .replace('<link rel="icon" href="icon.svg" type="image/svg+xml">', `<link rel="icon" href="${icon}" type="image/svg+xml">`)
  .replace('<link rel="manifest" href="manifest.webmanifest">\n', '')
  .replace('<link rel="stylesheet" href="css/app.css">', () => `<style>${css}</style>`)
  .replace('<script src="vendor/peerjs-1.5.5.min.js" defer></script>\n', '')
  .replace('<script src="js/app.js" type="module"></script>', '')
  .replaceAll('href="security.html"', `href="${REPO}/blob/main/SECURITY.md" target="_blank" rel="noopener noreferrer"`)
  .replace('</body>', () => `<script>${peerjs}</script>\n<script type="module">${bundle}</script>\n</body>`);

if (/src="(js|vendor)\//.test(html) || /href="css\//.test(html)) throw new Error('unresolved local reference');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
if (testPort) html = html.replace('<html lang="en">', '<html lang="en" data-test="1">');
const out = testPort ? 'dist/ghostchat.test.html' : 'dist/ghostchat.html';
fs.writeFileSync(path.join(root, out), html);
const digest = crypto.createHash('sha256').update(html, 'utf8').digest('hex');
if (!testPort) fs.writeFileSync(path.join(root, 'dist/SHA256SUMS'), `${digest}  ghostchat.html\n`);
console.log(`${out}  ${(html.length / 1024).toFixed(0)} KB  sha256 ${digest}`);
