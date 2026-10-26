// Input hygiene for everything the other person sends that reaches the screen or the disk.
// Pure functions, no DOM: unit-tested in tests/connectivity.test.mjs.
//
// Rules the interface relies on:
//   * Peer text only ever reaches the DOM through textContent / attribute setters.
//   * Names and file names lose control characters and all bidirectional-override/isolate
//     characters (so "photo‮gpj.exe" can't pose as a .jpg); message text loses the
//     override/isolate controls too, so a link can't display one address and point at another.
//   * Only http(s) links are clickable, and opening one shows the real host first.
//   * Files are never rendered from the peer's declared type: images are recognised by their
//     magic bytes and decoded only when the person chooses to view them; everything else is
//     saved as opaque bytes, with a warning for types that can run code.

// C0/C1 controls, zero-width & bidi marks/overrides/isolates, BOM, every other
// default-ignorable code point (soft hyphen, word joiners, tag characters, variation
// selectors…) and the blank-looking fillers (Hangul fillers, braille blank).
const LABEL_STRIP = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿\u115f\u1160\u3164\uffa0\u2800]|\p{Default_Ignorable_Code_Point}/gu;
// In message text, keep tabs/newlines and ordinary marks; drop the explicit overrides/isolates.
const TEXT_STRIP = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g;

export const cleanLabel = (s, max) => String(s ?? '').replace(LABEL_STRIP, '').trim().slice(0, max);
// Names that would let someone pose as you, the host or the app itself.
const RESERVED_NAMES = new Set(['you', 'me', 'host', 'the host', 'ghost chat', 'ghostchat', 'someone', 'system', 'admin', 'moderator']);
/** A display name from someone else: cleaned, must contain a letter or digit, never a reserved word. */
export function cleanName(s, max = 24) {
  const n = cleanLabel(String(s ?? '').normalize('NFKC'), max);
  if (!/[\p{L}\p{N}]/u.test(n)) return '';
  const key = n.toLowerCase().replace(/[\s._\-()[\]]+/g, ' ').trim();
  if (RESERVED_NAMES.has(key) || /^(you|host)\b/.test(key)) return '';
  return n;
}
export const cleanText = (s, max) => String(s ?? '').replace(TEXT_STRIP, '').slice(0, max);
export const isMid = (s) => typeof s === 'string' && /^[0-9a-f]{16}$/.test(s);

/** Magic-byte sniffing: only these raster formats may ever be shown as images. */
export function sniffImage(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** Coarse kind for labelling a received file (never used to render it). */
export function sniffKind(b) {
  if (sniffImage(b)) return 'image';
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'video'; // ISO-BMFF (mp4/mov)
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video';   // Matroska/WebM
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
  return 'file';
}

// Types that can execute code or script when opened (or are commonly used to smuggle it).
const RISKY_EXT = new Set(('exe msi msp com scr pif bat cmd ps1 psm1 vbs vbe js jse mjs wsf wsh hta cpl msc jar ' +
  'apk aab xapk ipa app dmg pkg deb rpm run sh bash zsh command bin elf so dll sys drv ocx lnk url scf reg inf ' +
  'html htm xhtml shtml mht mhtml svg svgz xml xsl swf docm dotm xlsm xltm xlam pptm potm ppam sldm iso img vhd vhdx ' +
  'appx msix appinstaller library-ms settingcontent-ms gadget workflow action terminal ' +
  'chm hlp xll jnlp desktop appref-ms application xbap py pyw pyc pyz one iqy slk wsc sct msh ps1xml psc1 psd1 vb ins isp').split(' '));

/**
 * Risk assessment for saving a received file.
 * @returns {{ risky: boolean, reason: string }}
 */
export function fileRisk(name, head = new Uint8Array(0)) {
  // Judge the name the way it will be saved: trailing dots and spaces are dropped on save
  // (and by Windows), so "invoice.pdf.bat." must count as a .bat.
  const n = String(name || '').toLowerCase().replace(/[.\s]+$/, '');
  const parts = n.split('.');
  const ext = parts.length > 1 ? parts.pop() : '';
  if (RISKY_EXT.has(ext)) return { risky: true, reason: `.${ext} files can run code on your device when opened.` };
  // Executable content regardless of the name.
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return { risky: true, reason: 'This file is a Windows program, whatever its name says.' };
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return { risky: true, reason: 'This file is a Linux program, whatever its name says.' };
  if (head.length >= 4 && ((head[0] === 0xcf && head[1] === 0xfa && head[2] === 0xed && head[3] === 0xfe) || (head[0] === 0xca && head[1] === 0xfe && head[2] === 0xba && head[3] === 0xbe))) return { risky: true, reason: 'This file is a macOS program, whatever its name says.' };
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) return { risky: true, reason: 'This file is a script that can run code.' };
  // Double extensions like "invoice.pdf.exe" are caught above; flag lookalike padding too.
  if (/\s{3,}\.\w+$/.test(name || '')) return { risky: true, reason: 'The name hides its real extension behind spaces.' };
  return { risky: false, reason: '' };
}

/** A file name that is safe to hand to the browser's download (no paths, reserved chars or dot tricks). */
export function safeFilename(name) {
  let n = cleanLabel(name, 200).replace(/[\\/:*?"<>|]+/g, '_').replace(/\.{2,}/g, '.').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n;
  return n || 'file';
}

/** http(s) only; returns the parsed URL or null. Hostnames come back in ASCII (punycode). */
export function parseLink(raw) {
  try { const u = new URL(raw); return u.protocol === 'http:' || u.protocol === 'https:' ? u : null; } catch { return null; }
}
