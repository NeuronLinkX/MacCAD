/** macOS-style welcome screen. Recent files and previews stay in the user's local profile. */
import { FileIo } from './io.js';
import { def } from './registry.js';
import { api } from './apibridge.js';
const dateText = (ms) => ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
const sizeText = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  children.forEach((child) => node.append(child));
  return node;
}
export class StartScreen {
  constructor(app) {
    this.app = app; this.tab = 'recent'; this.sort = 'opened'; this.view = 'grid';
    this.root = null; this.recent = []; this.samples = []; this.generation = 0;
  }
  get visible() { return !!this.root; }
  async show() {
    if (this.root || !api?.recentList) return;
    const generation = ++this.generation;
    this.root = el('section', { id: 'startscreen', 'aria-label': 'MacCAD welcome', onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.hide(); } } });
    document.querySelector('#app').append(this.root);
    this.render();
    try {
      const [recent, samples] = await Promise.all([api.recentList(), api.samplesList()]);
      if (generation !== this.generation || !this.root) return;
      this.recent = recent; this.samples = samples; this.render();
    } catch { if (generation === this.generation) this.message('The document list could not be loaded. You can still open a drawing.'); }
  }
  hide() { ++this.generation; this.root?.remove(); this.root = null; }
  message(text) { const status = this.root?.querySelector('.ss-status'); if (status) status.textContent = text; }
  async openPath(p) {
    if (this.busy) return;
    this.busy = true;
    this.root?.setAttribute('aria-busy', 'true');
    this.message('Opening drawing…');
    try {
      const f = await api.readFile(p);
      if (!f || f.error) throw new Error(f?.error || 'The file is unavailable.');
      this.hide();
      await FileIo.openData(this.app, f);
    } catch (error) { this.message(`Cannot open drawing: ${error.message}`); }
    finally { this.busy = false; this.root?.removeAttribute('aria-busy'); }
  }
  render() {
    if (!this.root) return;
    const side = el('aside', { class: 'ss-side' },
      el('img', { class: 'ss-logo', src: 'splash/icon.png', alt: '' }),
      el('div', { class: 'ss-brand' }, 'MacCAD', el('span', {}, '2026')),
      el('p', { class: 'ss-tagline' }, 'Make room for your next idea.'),
      el('button', { class: 'ss-btn primary', onclick: () => { this.hide(); this.app.exec('NEW'); } }, 'New drawing', el('kbd', {}, '⌘N')),
      el('button', { class: 'ss-btn', onclick: async () => {
        await FileIo.openFile(this.app);
      } }, 'Open drawing…', el('kbd', {}, '⌘O')),
      el('div', { class: 'ss-section-label' }, 'LIBRARY'),
      ...[['recent', '◷', 'Recent drawings'], ['samples', '◇', 'Sample gallery']].map(([key, icon, title]) =>
        el('button', { class: `ss-nav${this.tab === key ? ' on' : ''}`, 'aria-pressed': String(this.tab === key), onclick: () => { this.tab = key; this.render(); } }, el('span', { class: 'ss-nav-icon', 'aria-hidden': 'true' }, icon), title)),
      el('div', { class: 'ss-side-foot' }, el('p', {}, 'Designed for precision.\nMade for Mac.'),
        el('button', { class: 'ss-skip', onclick: () => this.app.exec('OPTIONS') }, 'Settings…'),
        el('button', { class: 'ss-skip', onclick: () => this.hide() }, 'Continue to workspace →')));
    const items = [...(this.tab === 'recent' ? this.recent : this.samples)];
    items.sort(this.sort === 'name' || this.tab === 'samples' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.opened - a.opened);
    const sort = el('select', { 'aria-label': 'Sort drawings', onchange: (e) => { this.sort = e.target.value; this.render(); } },
      el('option', { value: 'opened' }, 'Last opened'), el('option', { value: 'name' }, 'Name'));
    sort.value = this.sort;
    const bar = el('div', { class: 'ss-bar' }, el('span', { class: 'ss-count' }, `${items.length} drawing${items.length === 1 ? '' : 's'}`),
      ...(this.tab === 'recent' ? [sort] : []),
      el('div', { class: 'ss-segment', role: 'group', 'aria-label': 'Document view' },
        ...[['grid', '▦'], ['list', '☰']].map(([view, icon]) => el('button', { class: `ss-ic${this.view === view ? ' on' : ''}`, title: `${view} view`, 'aria-label': `${view} view`, 'aria-pressed': String(this.view === view), onclick: () => { this.view = view; this.render(); } }, icon))));
    const cards = el('div', { class: `ss-cards ${this.view}` });
    items.forEach((it) => cards.append(this.card(it)));
    if (!items.length) cards.append(el('div', { class: 'ss-empty' }, el('span', { class: 'ss-empty-icon', 'aria-hidden': 'true' }, '◇'),
      el('h2', {}, this.tab === 'recent' ? 'Your next drawing starts here.' : 'No samples available'),
      el('p', {}, this.tab === 'recent' ? 'Open a drawing to keep it close at hand, or explore the sample gallery.' : 'Sample drawings will appear here after installation.'),
      ...(this.tab === 'recent' ? [el('button', { class: 'ss-btn', onclick: () => { this.tab = 'samples'; this.render(); } }, 'Explore samples →')] : [])));
    const main = el('main', { class: 'ss-main' }, el('div', { class: 'ss-eyebrow' }, 'YOUR WORKSPACE'),
      el('h1', {}, this.tab === 'recent' ? 'Welcome back.' : 'A little inspiration.'),
      el('p', { class: 'ss-subtitle' }, this.tab === 'recent' ? 'Pick up where you left off.' : 'Explore the included drawings. Save your changes as a new file.'),
      bar, cards, el('p', { class: 'ss-status', role: 'status', 'aria-live': 'polite' }));
    this.root.replaceChildren(side, main);
  }
  card(it) {
    const pic = el('span', { class: 'ss-pic' });
    if (it.thumb) pic.append(el('img', { src: it.thumb, alt: '', loading: 'lazy' }));
    else pic.append(el('span', { class: 'ss-file-mark', 'aria-hidden': 'true' }, '◇'), el('span', { class: 'ss-ext' }, (it.name.split('.').pop() || '').toUpperCase()));
    const card = el('article', { class: 'ss-card' }, el('button', { class: 'ss-open', title: it.path, onclick: () => this.openPath(it.path) }, pic,
      el('span', { class: 'ss-info' }, el('span', { class: 'ss-name' }, it.name.replace(/\.[^.]+$/, '')),
        el('span', { class: 'ss-date' }, this.tab === 'recent' ? dateText(it.opened) : sizeText(it.size)))));
    if (this.tab === 'recent') card.append(el('button', { class: 'ss-x', 'aria-label': `Remove ${it.name} from recent drawings`, title: 'Remove from recent drawings', onclick: async () => {
      try { await api.recentRemove(it.path); this.recent = await api.recentList(); this.render(); }
      catch { this.message('Could not update recent drawings.'); }
    } }, '×'));
    return card;
  }
  static async record(app, file) {
    if (!api?.recentAdd || !file) return;
    const doc = app.doc;
    try {
      if (!(await api.recentAdd({ path: file }))) return;
      await new Promise((r) => setTimeout(r, 700));
      if (app.doc !== doc || app.startScreen?.visible) return;
      const canvas = app.cv;
      if (!canvas?.width || !canvas.height) return;
      const out = document.createElement('canvas'); out.width = 440; out.height = 270;
      const g = out.getContext('2d'); g.fillStyle = '#151c27'; g.fillRect(0, 0, out.width, out.height);
      const k = Math.min(out.width / canvas.width, out.height / canvas.height);
      // Ask the renderer for a fresh frame before sampling the WebGL canvas.
      app.renderer?.draw();
      for (const c of [document.querySelector('#gl'), canvas]) {
        if (c?.width && c.style.display !== 'none') g.drawImage(c, (out.width - canvas.width * k) / 2, (out.height - canvas.height * k) / 2, canvas.width * k, canvas.height * k);
      }
      await api.recentThumbnail({ path: file, thumb: out.toDataURL('image/png') });
    } catch { /* A failed thumbnail must never interrupt opening or saving a drawing. */ }
  }
}
def('START', async (c) => { await c.app.startScreen?.show(); });
