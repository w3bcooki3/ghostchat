// What happens to a file the other person sends, once all of its encrypted chunks arrived.
//
// Nothing is opened automatically. The card shows what the file really is (by its bytes,
// not its name or declared type) and offers actions:
//   View  — images only (PNG/JPEG/GIF/WebP by magic bytes). Decoded only when chosen, then
//           shown in the viewer; never inline in the conversation.
//   Save  — always as opaque bytes (application/octet-stream), under a sanitised name, so the
//           browser can't render or run it. Types that can run code ask for confirmation.
//   Share — the device's share sheet, where supported.
// Blob URLs are page-local, revoked when the conversation is wiped, and the CSP stops the
// page from fetching them (see the e2e tests).
import { h, fmtSize, confirmDialog, toast } from './dom.js';
import { sniffImage, sniffKind, fileRisk, safeFilename } from './sanitize.js';

const KIND_LABEL = { image: 'Photo', video: 'Video', pdf: 'PDF', file: 'File' };

/**
 * @param {object} r     the message record (r.card = the file card, r.sub = its subtitle)
 * @param {{ name: string, size: number, blob: Blob }} f
 * @param {{ track(url): string, openViewer(url, alt): void, onSeen(): void }} ctx
 */
export async function presentReceived(r, f, ctx) {
  const head = new Uint8Array(await f.blob.slice(0, 64).arrayBuffer());
  const imgType = sniffImage(head);
  const kind = sniffKind(head);
  const name = safeFilename(f.name);
  const risk = fileRisk(f.name, head);

  r.sub.replaceChildren(`${KIND_LABEL[kind]} · ${fmtSize(f.size)}`);
  if (risk.risky) { r.sub.append(' · '); r.sub.append(h('span', 'risk', 'can run code')); }
  r.bar?.remove();
  r.card.classList.add('is-received', 'kind-' + kind);
  if (risk.risky) r.card.classList.add('is-risky');

  const row = h('div', 'file-sub file-actions');
  if (imgType) {
    const view = h('button', 'file-act media-view', 'View');
    view.type = 'button';
    view.onclick = async () => {
      const url = ctx.track(URL.createObjectURL(new Blob([f.blob], { type: imgType })));
      r.urls.push(url);
      const ok = await new Promise((res) => { const t = new Image(); t.onload = () => res(true); t.onerror = () => res(false); t.src = url; });
      if (!ok) { toast('That image is damaged and can\'t be shown. You can still save it.', true); return; }
      ctx.openViewer(url, name);
      ctx.onSeen();
    };
    row.append(view);
  }

  // Save: an <a download> of opaque bytes (the browser can't render it); risky types confirm first.
  const url = ctx.track(URL.createObjectURL(new Blob([f.blob], { type: 'application/octet-stream' })));
  r.urls.push(url);
  const save = h('a', 'file-act', 'Save');
  save.href = url; save.download = name; save.rel = 'noopener';
  save.addEventListener('click', async (e) => {
    if (!risk.risky || save.dataset.ok === '1') { delete save.dataset.ok; return; }
    e.preventDefault();
    const go = await confirmDialog('This file could harm your device',
      `${risk.reason} Only open it if you trust the sender and were expecting this exact file.`, 'Save anyway', { detail: name });
    if (go) { save.dataset.ok = '1'; save.click(); }
  });
  row.append(save);

  if (navigator.canShare) {
    const file = new File([f.blob], name, { type: imgType || 'application/octet-stream' });
    if (navigator.canShare({ files: [file] })) {
      const share = h('button', 'file-act', 'Share');
      share.type = 'button';
      share.onclick = async () => {
        if (risk.risky && !(await confirmDialog('Share a file that can run code?', risk.reason, 'Share anyway', { detail: name }))) return;
        try { await navigator.share({ files: [file] }); } catch (e) { if (e?.name !== 'AbortError') toast('Couldn\'t share that file', true); }
      };
      row.append(share);
    }
  }
  r.card.querySelector('.file-info')?.append(row);
  if (!imgType) ctx.onSeen();
}
