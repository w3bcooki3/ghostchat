// Project integrity checks (Node >= 20): node --test tests/project.test.mjs
// Catches the kind of breakage no protocol test sees: a module renamed by a sync tool, a page
// referencing a file that isn't there, or deployment headers drifting from the page's own CSP.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(rel)); else out.push(rel);
  }
  return out;
}

test('every relative import in js/ resolves to a file that exists', () => {
  const files = walk('js').filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 10);
  for (const f of files) {
    assert.match(path.posix.basename(f), /^[a-z][\w-]*\.js$/, `unexpected module file name: ${f} (a sync conflict copy?)`);
    for (const [, spec] of read(f).matchAll(/^\s*import\s[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
      assert.ok(exists(target), `${f} imports ${spec}, but ${target} does not exist`);
    }
  }
});

test('every local script, stylesheet and link in the pages exists', () => {
  for (const page of ['index.html', 'guide.html', 'security.html', 'legal.html']) {
    const html = read(page);
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"#:]+?)"/g)) {
      if (ref.startsWith('//')) continue;
      assert.ok(exists(ref), `${page} references ${ref}, which does not exist`);
    }
  }
});

test('_headers carries the same CSP as index.html, plus frame-ancestors', () => {
  const meta = read('index.html').match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];
  const header = read('_headers').match(/^\s+Content-Security-Policy:\s*(.+)$/m)[1].trim();
  const dirs = (csp) => new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v.sort().join(' ')]; }));
  const m = dirs(meta), h = dirs(header);
  assert.equal(h.get('frame-ancestors'), "'none'");
  h.delete('frame-ancestors');
  assert.deepEqual(h, m, 'browsers enforce both policies; any difference silently breaks a feature');
});

test('the relay origin in config.js is allowed by the CSP', async () => {
  const { RELAY_URL } = await import('../js/config.js');
  if (!RELAY_URL) return;
  const origin = new URL(RELAY_URL).origin.replace(/^http/, 'ws');
  for (const csp of [read('index.html'), read('_headers')]) assert.ok(csp.includes(origin), `connect-src must list ${origin}`);
});
