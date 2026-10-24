// Small DOM toolkit shared by the interface modules. Text always goes in through
// textContent; nothing here ever parses HTML.

export const $ = (id) => document.getElementById(id);
export const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export const fmtSize = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
export const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const fmtSecs = (s) => s >= 3600 ? Math.round(s / 3600) + ' h' : s >= 60 ? Math.round(s / 60) + ' min' : s + ' s';
export const fmtLeft = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return s >= 60 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : s + 's'; };

let toastTimer;
export function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast is-on' + (bad ? ' is-bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), 2600);
}

export async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(label + ' copied'); }
  catch { toast("Couldn't access the clipboard", true); }
}

// ── confirmation dialog (one at a time) ──
let dialogResolve = null, dialogOpener = null;
/**
 * @param {string} title
 * @param {string} body plain text (rendered with textContent)
 * @param {string} okLabel
 * @param {{ danger?: boolean, cancelLabel?: string, detail?: string }} [o] detail: an extra
 *        monospace line, e.g. the full address of a link
 */
export function confirmDialog(title, body, okLabel, o = {}) {
  dialogResolve?.(false);
  dialogOpener = document.activeElement;
  $('dialogTitle').textContent = title;
  $('dialogBody').textContent = body;
  $('dialogDetail').textContent = o.detail || '';
  $('dialogDetail').hidden = !o.detail;
  $('dialogOk').textContent = okLabel;
  $('dialogOk').className = 'btn ' + (o.danger === false ? 'btn-primary' : 'btn-danger');
  $('dialogCancel').textContent = o.cancelLabel || 'Cancel';
  $('dialog').hidden = false;
  $('dialogCancel').focus();
  return new Promise((r) => { dialogResolve = r; });
}
export function closeDialog(v) {
  if ($('dialog').hidden) return;
  $('dialog').hidden = true;
  dialogResolve?.(v); dialogResolve = null;
  dialogOpener?.focus?.({ preventScroll: true }); dialogOpener = null;
}
export const dialogOpen = () => !$('dialog').hidden;

export function initDialog() {
  $('dialogCancel').onclick = () => closeDialog(false);
  $('dialogOk').onclick = () => closeDialog(true);
  $('dialog').addEventListener('click', (e) => { if (e.target === $('dialog')) closeDialog(false); });
}
