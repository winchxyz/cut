import { ASSETS } from './lexicon.js';

/**
 * DOM side of the sandbox: the asset shelf, the readout, the help sheet.
 *
 * There is no text input. The set of objects is fixed and curated, so the
 * interface is a shelf you pick from rather than a box you type into.
 *
 * The simulation never touches the DOM — it calls in through a handful of
 * methods — which is what lets the slicer, forge and physics run headless
 * under Node in the test suites.
 */

export class UI {
  constructor({ onPick, onReroll, onRestore, onNudge }) {
    this.cb = { onPick, onReroll, onRestore, onNudge };

    this.el = {
      preboot: document.getElementById('preboot'),
      shelf: document.getElementById('shelf'),
      readout: document.getElementById('readout'),
      name: document.getElementById('rdName'),
      mat: document.getElementById('rdMat'),
      tris: document.getElementById('rdTris'),
      cuts: document.getElementById('rdCuts'),
      pieces: document.getElementById('rdPieces'),
      hint: document.getElementById('hint'),
      help: document.getElementById('helpSheet'),
    };

    this.buttons = new Map();
    this.selected = null;

    this._buildShelf();
    this._bind();
  }

  _buildShelf() {
    for (const asset of ASSETS) {
      const b = document.createElement('button');
      b.className = 'asset';
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', 'false');
      b.innerHTML = `<b></b><span></span>`;
      b.querySelector('b').textContent = asset.label;
      b.querySelector('span').textContent = asset.note;
      b.onclick = () => this.pick(asset.id);
      this.el.shelf.appendChild(b);
      this.buttons.set(asset.id, b);
    }
  }

  /** Single entry point for "put this on the bench". */
  pick(id) {
    const asset = ASSETS.find((a) => a.id === id);
    if (!asset) return;
    this.select(id);
    this.cb.onPick?.(asset);
  }

  select(id) {
    this.selected = id;
    for (const [key, btn] of this.buttons) {
      btn.setAttribute('aria-selected', String(key === id));
    }
  }

  _bind() {
    document.getElementById('btnReroll').onclick = () => this.cb.onReroll?.();
    document.getElementById('btnRestore').onclick = () => this.cb.onRestore?.();
    document.getElementById('btnNudge').onclick = () => this.cb.onNudge?.();
    document.getElementById('btnInfo').onclick = () => this.toggleHelp(true);

    this.el.help.addEventListener('click', (e) => {
      if (e.target === this.el.help || e.target.closest('[data-close]')) this.toggleHelp(false);
    });
  }

  toggleHelp(on) { this.el.help.hidden = !on; }
  get helpOpen() { return !this.el.help.hidden; }

  /** No text fields any more, so nothing can swallow a shortcut. */
  get typing() { return false; }

  bootProgress(msg) {
    const m = this.el.preboot?.querySelector('.m');
    if (m) m.textContent = msg;
  }

  bootDone() {
    this.el.preboot?.classList.add('gone');
    setTimeout(() => this.el.preboot?.remove(), 500);
  }

  onPlaced(meta) {
    this.el.readout.classList.add('on');
    this.el.name.textContent = meta.label;
    this.el.mat.textContent = meta.family;
    this.el.tris.textContent = meta.triangles.toLocaleString();
    this.el.cuts.textContent = '0';
    this.el.pieces.textContent = '1';
    this.el.hint.classList.remove('dim');
  }

  onCut(stats) {
    this.el.cuts.textContent = String(stats.cuts);
    this.el.pieces.textContent = String(stats.pieces);
    this.el.hint.classList.add('dim');
  }
}
