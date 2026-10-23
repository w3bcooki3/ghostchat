// The handshake stage on the connecting screen: two ghosts, the packets between them and the
// seal. Packets are drawn from the REAL handshake frames this browser sends and receives
// (session 'hs-frame' events), and the safety number shown at the seal is the real one.
import { $ } from './dom.js';
import { scramble, wait, reducedMotion } from '../fx.js';

const LABEL = { 'hello-j': 'HELLO · ML-KEM + P-384 keys', 'hello-h': 'HELLO · ciphertext + proof', confirm: 'CONFIRM · proof', locked: 'LOCKED' };

export class HandshakeStage {
  constructor() { this.queue = []; this.running = null; this.linkedAt = 0; }

  set(state) {
    const st = $('hsStage');
    st.classList.remove('is-waiting', 'is-linking', 'is-sealed', 'is-failed');
    st.classList.add('is-' + state);
  }

  reset(role) {
    this.queue = []; this.linkedAt = 0;
    this.set('waiting');
    $('hsThemName').textContent = role === 'host' ? 'Waiting…' : 'The room';
    $('hsSn').textContent = ''; $('hsSn').classList.remove('is-on');
    $('keycard').classList.remove('is-spent');
    $('hsPkt').getAnimations?.().forEach((a) => a.cancel());
    $('hsPkt').classList.remove('is-on');
  }

  /** A transport opened: the other side is here and the key exchange starts. */
  linked(role) {
    if (this.linkedAt) return;
    this.linkedAt = Date.now();
    this.set('linking');
    $('hsThemName').textContent = role === 'host' ? 'Someone with the code' : 'The room';
  }

  packet(dir, kind) {
    if (!this.linkedAt || !LABEL[kind] || this.queue.length > 6) return;
    this.queue.push({ dir, kind });
    if (!this.running) this.running = this._run();
  }

  async _run() {
    const pkt = $('hsPkt');
    while (this.queue.length) {
      const { dir, kind } = this.queue.shift();
      $('hsPktLabel').textContent = LABEL[kind];
      if (!reducedMotion() && pkt.animate) {
        pkt.classList.add('is-on');
        const from = dir === 'out' ? '0%' : '100%', to = dir === 'out' ? '100%' : '0%';
        await pkt.animate([{ left: from, opacity: 0 }, { opacity: 1, offset: .15 }, { opacity: 1, offset: .85 }, { left: to, opacity: 0 }],
          { duration: 720, easing: 'cubic-bezier(.45,0,.2,1)' }).finished.catch(() => {});
        pkt.classList.remove('is-on');
      }
    }
    this.running = null;
  }

  /** The seal: lock closes, the code is spent, the safety number decrypts into view. */
  async seal(safetyNumber, onSealed) {
    const minLinked = 1300 - (Date.now() - (this.linkedAt || Date.now()));
    if (minLinked > 0) await wait(minLinked);
    await (this.running || Promise.resolve());
    this.set('sealed');
    $('keycard').classList.add('is-spent');
    onSealed?.();
    $('hsSn').classList.add('is-on');
    await scramble($('hsSn'), (safetyNumber || '').split(' ').slice(0, 6).join('  '), { duration: 800 });
    await wait(700);
  }
}
