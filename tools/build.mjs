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
let css = (read('css/themes.css') + '\n' + read('css/app.css')).replace(/url\(\.\.\/fonts\/([^)]+)\)/g, (_, f) =>
  `url(data:font/woff2;base64,${fs.readFileSync(path.join(root, 'fonts', f)).toString('base64')})`);

// --test-signal=PORT produces dist/ghostchat.test.html wired to a local PeerJS server (for CI only).
const testPort = (process.argv.find((a) => a.startsWith('--test-signal=')) || '').split('=')[1];

// Minimal module linker for our own ES modules plus the vendored ML-KEM build.
// Order = dependency order (each module only imports ones listed before it).
const order = ['config', 'protocol', 'local', 'relay', 'ice', 'session', 'room', 'netcheck', 'fx',
  'ui/sanitize', 'ui/dom', 'ui/handshake', 'ui/media', 'app'];
const key = (name) => name.replace(/\//g, '_');
/** Resolves an import specifier relative to the importing module (both under js/). */
function resolve(from, spec) {
  const parts = from.split('/').slice(0, -1);
  for (const seg of spec.replace(/\.js$/, '').split('/')) {
    if (seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
}
let bundle = 'const __mods = {};\n';
{
  const src = read('vendor/noble-ml-kem1024-0.7.1.min.js');
  const m = src.match(/export\{(\w+) as ml_kem1024\};?\s*$/);
  if (!m) throw new Error('unexpected ML-KEM vendor format');
  bundle += `__mods.mlkem = (() => {\n${src.slice(0, m.index)}\nreturn { ml_kem1024: ${m[1]} };\n})();\n`;
}
{
  const src = read('vendor/uqr-0.1.2.js');
  const m = src.match(/export\s*\{([^}]+)\};?\s*$/);
  if (!m) throw new Error('unexpected uqr vendor format');
  bundle += `__mods.uqr = (() => {\n${src.slice(0, m.index)}\nreturn { ${m[1]} };\n})();\n`;
}
for (const name of order) {
  let src = read(`js/${name}.js`);
  if (testPort && name === 'config') src = src
    .replace(/host: '0\.peerjs\.com',\s*port: 443,\s*path: '\/',\s*secure: true,/, `host: '127.0.0.1', port: ${testPort}, path: '/gc', secure: false,`)
    .replace('export const ICE_SERVERS = null;', 'export const ICE_SERVERS = [];').replace('export const PUBLIC_RELAY = true;', 'export const PUBLIC_RELAY = false;').replace(/export const RELAY_URL = [^;]+;/, 'export const RELAY_URL = null;');
  const exported = [];
  src = src.replace(/^import \{ ml_kem1024 \} from '\.\.\/vendor\/noble-ml-kem1024-0\.7\.1\.min\.js';$/m, 'const { ml_kem1024 } = __mods.mlkem;');
  src = src.replace(/^import \{([^}]+)\} from '(?:\.\.\/)+vendor\/uqr-0\.1\.2\.js';$/m, (_, names) => `const {${names}} = __mods.uqr;`);
  const dep = (spec) => {
    const m = resolve(name, spec);
    if (!order.includes(m) || order.indexOf(m) >= order.indexOf(name)) throw new Error(`${name}.js imports ${spec}, which isn't listed before it in the build order`);
    return key(m);
  };
  src = src.replace(/^import \* as (\w+) from '(\.{1,2}\/[\w/.]+\.js)';$/gm, (_, ns, spec) => `const ${ns} = __mods.${dep(spec)};`);
  src = src.replace(/^import \{([^}]+)\} from '(\.{1,2}\/[\w/.]+\.js)';$/gm, (_, names, spec) => `const {${names.replace(/\bas\b/g, ':')}} = __mods.${dep(spec)};`);
  src = src.replace(/^export (async function|function|class|const|let)\s+([\w$]+)/gm, (_, kw, n) => { exported.push(n); return `${kw} ${n}`; });
  if (/^\s*(import|export)\b/m.test(src)) throw new Error(`Unsupported import/export form in ${name}.js`);
  bundle += `__mods.${key(name)} = (() => {\n${src}\nreturn { ${exported.join(', ')} };\n})();\n`;
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
  .replace('<link rel="stylesheet" href="css/themes.css">\n', '')
  .replace('<link rel="stylesheet" href="css/app.css">', () => `<style>${css}</style>`)
  .replace('<script src="vendor/peerjs-1.5.5.min.js" defer></script>\n', '')
  .replace('<script src="js/app.js" type="module"></script>', '')
  .replace('</body>', () => `<script>${peerjs}</script>\n<script type="module">${bundle}</script>\n</body>`);

if (/src="(js|vendor)\//.test(html) || /href="css\//.test(html)) throw new Error('unresolved local reference');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
if (testPort) html = html.replace('<html lang="en">', '<html lang="en" data-test="1">');
const out = testPort ? 'dist/ghostchat.test.html' : 'dist/ghostchat.html';
fs.writeFileSync(path.join(root, out), html);
const digest = crypto.createHash('sha256').update(html, 'utf8').digest('hex');
console.log(`${out}  ${(html.length / 1024).toFixed(0)} KB  sha256 ${digest}`);

// dist/security.html, guide.html, legal.html: the info pages, self-contained the same way,
// so the app's links to them work from the dist folder (and from disk) as well as on the site.
if (!testPort) {
  const sums = [`${digest}  ghostchat.html`];
  const PAGES = [['security.html', 'css/security.css', 'js/security.js'], ['guide.html', 'css/pages.css', 'js/pages.js'], ['legal.html', 'css/pages.css', 'js/pages.js']];
  for (const [file, cssFile, jsFile] of PAGES) {
    // Each page = the shared themes + its own styles, and the shared theme picker + its own script.
    const pcss = (read('css/themes.css') + '\n' + read(cssFile)).replace(/url\(\.\.\/fonts\/([^)]+)\)/g, (_, f) =>
      `url(data:font/woff2;base64,${fs.readFileSync(path.join(root, 'fonts', f)).toString('base64')})`);
    const pjs = read('js/pagetheme.js') + '\n' + read(jsFile);
    let pg = read(file);
    const cspOld = pg.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];
    const pcsp = ["default-src 'none'", `script-src ${sha(pjs)}`, `style-src ${sha(pcss)}`, 'font-src data:', 'img-src data:', "base-uri 'none'", "form-action 'none'"].join('; ');
    pg = pg
      .replace(cspOld, pcsp)
      .replace('<link rel="icon" href="icon.svg" type="image/svg+xml">', `<link rel="icon" href="${icon}" type="image/svg+xml">`)
      .replace('<link rel="stylesheet" href="css/themes.css">\n', '')
      .replace(`<link rel="stylesheet" href="${cssFile}">`, () => `<style>${pcss}</style>`)
      .replace('<script src="js/pagetheme.js" defer></script>\n', '')
      .replace(`<script src="${jsFile}" defer></script>\n`, '')
      .replaceAll('href="index.html"', 'href="ghostchat.html"')
      .replaceAll('href="SECURITY.md"', `href="${REPO}/blob/main/SECURITY.md" target="_blank" rel="noopener noreferrer"`)
      .replaceAll('href="docs/AUDIT.md"', `href="${REPO}/blob/main/docs/AUDIT.md" target="_blank" rel="noopener noreferrer"`)
      .replace('</body>', () => `<script>${pjs}</script>\n</body>`);
    if (/src="js\//.test(pg) || /href="css\//.test(pg)) throw new Error('unresolved local reference in ' + file);
    fs.writeFileSync(path.join(root, 'dist', file), pg);
    const d = crypto.createHash('sha256').update(pg, 'utf8').digest('hex');
    sums.push(`${d}  ${file}`);
    console.log(`dist/${file}  ${(pg.length / 1024).toFixed(0)} KB  sha256 ${d}`);
  }
  fs.writeFileSync(path.join(root, 'dist/SHA256SUMS'), sums.join('\n') + '\n');
}

