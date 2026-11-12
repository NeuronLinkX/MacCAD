/**
 * @file navpanel.js
 * @brief Model History panel (like the Part Navigator of NX / Unigraphics).
 *
 * Every modelling step is listed and a click rolls the drawing back (or forward) to that step. The
 * layers can be shown, hidden, isolated and expanded into their objects.
 *
 * Use `initHistory(app, h, mount, before)`; it returns the panel with `show(on)`, `toggle()` and
 * `visible`.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import * as E from './entities.js';
import { ICONS } from './icons.js';
import { aciHex } from './doc.js';

/* ============================================================================================
 * 2. CONSTANTS
 * ========================================================================================== */

/** Command name -> icon name for the history rows. */
const STEP_ICON = {
  BOX: 'box',
  CYLINDER: 'cylinder',
  CONE: 'cone',
  SPHERE: 'sphere',
  WEDGE: 'wedge',
  TORUS: 'torus',
  PYRAMID: 'pyramid',
  EXTRUDE: 'extrude',
  REVOLVE: 'revolve',
  SLICE: 'slice',
  UNION: 'union',
  SUBTRACT: 'subtract',
  INTERSECT: 'intersect',
  PRESSPULL: 'presspull',
  FILLETEDGE: 'filletedge',
  CHAMFEREDGE: 'chamferedge',
  TAPERFACES: 'extrude',
  DRAFT: 'extrude',
  '3DMOVE': 'move3d',
  ROTATE3D: 'rotate3d',
  '3DMIRROR': 'mirror3d',
  LAYER: 'layermgr',
  CONE_: 'cone',
  MOVE: 'move',
  COPY: 'copy',
  ROTATE: 'rotate',
  ERASE: 'erase',
  LINE: 'line',
  CIRCLE: 'circle',
  PLINE: 'pline',
  RECTANG: 'rect',
};

/** Objects listed under one expanded layer, at most. */
const MAX_OBJECTS_PER_LAYER = 300;
/** Redraw delay after a change (ms), so a burst of changes redraws once. */
const REDRAW_DELAY_MS = 50;

/* ============================================================================================
 * 3. CLASS
 * ========================================================================================== */

/** The Model History panel. */
export class HistoryPanel {
  /**
   * @param {object} app the application
   * @param {Function} h element factory `h(tag, attrs, ...children)`
   * @param {HTMLElement} mount where the panel is inserted
   * @param {HTMLElement|null} [before] insert before this child instead of appending
   */
  constructor(app, h, mount, before = null) {
    this.app = app;
    this.h = h;
    /** Layers whose object list is expanded. */
    this.open = new Set();
    /** Name of the layer currently isolated, or null. */
    this.isolated = null;
    /** Layer visibility before isolating (name -> on). */
    this.saved = null;
    this.timer = 0;
    this.build(mount, before);
    app.on('doc', () => this.later());
    app.on('selection', () => this.later());
    app.on('space', () => this.later());
  }

  /** @private Creates the panel's fixed parts. */
  build(mount, before) {
    const { app, h } = this;
    this.root = h('div', { id: 'hist', class: 'hidden' });
    this.body = h('div', { class: 'hbody' });
    const close = h('b', { title: 'Close', onclick: () => this.show(false) }, '×');
    this.undoBtn = h(
      'button',
      { class: 'hb', title: 'Undo one step', onclick: () => app.exec('UNDO1') },
      '↶ Undo',
    );
    this.redoBtn = h(
      'button',
      { class: 'hb', title: 'Redo one step', onclick: () => app.exec('REDO') },
      '↷ Redo',
    );
    this.root.append(
      h('div', { class: 'hh' }, h('span', {}, 'Model History'), close),
      h('div', { class: 'hbtns' }, this.undoBtn, this.redoBtn),
      this.body,
    );
    if (before) mount.insertBefore(this.root, before);
    else mount.append(this.root);
  }

  // ---------------------------------------------------------------- helpers

  /** @private @returns {string} the icon markup for a history step label ('' when none fits). */
  static iconFor(label) {
    const k = String(label).split(/[\s(]/)[0].toUpperCase();
    return ICONS[STEP_ICON[k]] || '';
  }

  /** @private @returns {string} a time stamp as HH:MM:SS ('' without a time). */
  static clock(t) {
    return t ? new Date(t).toLocaleTimeString('en-GB') : '';
  }

  /** @private Redraws shortly after the last change. */
  later() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render(), REDRAW_DELAY_MS);
  }

  /** @private Rolls the drawing back (negative) or forward (positive) by `steps`. */
  jump(steps) {
    return this.app.historyJump(steps);
  }

  // ---------------------------------------------------------------- drawing the panel

  /** @private Redraws the whole panel (does nothing while it is hidden). */
  render() {
    if (this.root.classList.contains('hidden')) return;
    const { app, h, body } = this;
    const d = app.doc;
    const n = d.undoStack.length;
    const rn = d.redoStack.length;
    this.undoBtn.disabled = !n;
    this.redoBtn.disabled = !rn;
    const keep = body.querySelector('.hlist') ? body.querySelector('.hlist').scrollTop : null;
    body.innerHTML = '';
    body.append(h('div', { class: 'sec' }, `History  (${n} step${n === 1 ? '' : 's'})`));
    const list = this.renderHistory(d, n, rn);
    body.append(list);
    if (keep !== null) list.scrollTop = keep;
    else list.scrollTop = list.scrollHeight;
    const cur = list.querySelector('.cur');
    if (cur && keep === null) cur.scrollIntoView({ block: 'nearest' });
    body.append(h('div', { class: 'sec' }, 'Layers'));
    body.append(this.renderLayers(d));
  }

  /** @private The list of steps: start row, done steps, then undone steps ("future"). */
  renderHistory(d, n, rn) {
    const h = this.h;
    const list = h('div', { class: 'hlist' });
    list.append(
      h(
        'div',
        { class: 'hrow' + (n === 0 ? ' cur' : ''), onclick: () => this.jump(-n) },
        h('span', { class: 'hi' }),
        h('span', { class: 'hl' }, 'Start (empty drawing)'),
      ),
    );
    d.undoStack.forEach((u, i) =>
      list.append(
        h(
          'div',
          {
            class: 'hrow' + (i === n - 1 ? ' cur' : ''),
            title: 'Go back to the state after this step',
            onclick: () => this.jump(-(n - 1 - i)),
          },
          h('span', { class: 'hi', html: HistoryPanel.iconFor(u.label) }),
          h('span', { class: 'hl' }, `${i + 1}  ${u.label}`),
          h('span', { class: 'ht' }, HistoryPanel.clock(u.t)),
        ),
      ),
    );
    for (let r = rn - 1, k = 1; r >= 0; r -= 1, k += 1) {
      const u = d.redoStack[r];
      list.append(
        h(
          'div',
          { class: 'hrow future', title: 'Redo up to this step', onclick: () => this.jump(k) },
          h('span', { class: 'hi', html: HistoryPanel.iconFor(u.label) }),
          h('span', { class: 'hl' }, `${n + k}  ${u.label}`),
          h('span', { class: 'ht' }, 'undone'),
        ),
      );
    }
    return list;
  }

  /** @private The layer list: visibility, colour, name, object count, isolate button, optional object rows. */
  renderLayers(d) {
    const { app, h } = this;
    const ents = app.curEnts();
    const by = new Map();
    for (const l of d.layers) by.set(l.name, []);
    for (const e of ents) {
      if (!by.has(e.layer)) by.set(e.layer, []);
      by.get(e.layer).push(e);
    }
    const lay = h('div', { class: 'llist' });
    for (const l of d.layers) {
      const objs = by.get(l.name) || [];
      const isOpen = this.open.has(l.name);
      const col =
        typeof l.color === 'number' ? (l.color === 7 ? '#cfd3da' : aciHex(l.color)) : l.color;
      lay.append(
        h(
          'div',
          { class: 'lrow' + (l.on ? '' : ' off') + (l.name === d.cur.layer ? ' curl' : '') },
          h(
            'span',
            {
              class: 'lt',
              onclick: () => {
                isOpen ? this.open.delete(l.name) : this.open.add(l.name);
                this.render();
              },
            },
            isOpen ? '▾' : '▸',
          ),
          h(
            'button',
            {
              class: 'eye',
              title: l.on ? 'Hide this layer' : 'Show this layer',
              onclick: () => {
                app.edit(`LAYER ${l.name} ${l.on ? 'off' : 'on'}`, () => {
                  l.on = !l.on;
                });
              },
            },
            l.on ? '●' : '○',
          ),
          h('span', { class: 'sw', style: `background:${col}` }),
          h(
            'span',
            {
              class: 'ln',
              title: 'Make this the current layer',
              onclick: () => {
                d.cur.layer = l.name;
                app.emit('doc');
              },
            },
            l.name,
          ),
          h('span', { class: 'lc' }, String(objs.length)),
          h(
            'button',
            {
              class: 'iso' + (this.isolated === l.name ? ' on' : ''),
              title:
                this.isolated === l.name
                  ? 'Show all layers again'
                  : 'Isolate: show only this layer',
              onclick: () => this.isolate(l.name),
            },
            '◎',
          ),
        ),
      );
      if (isOpen)
        for (const e of objs.slice(0, MAX_OBJECTS_PER_LAYER))
          lay.append(
            h(
              'div',
              { class: 'orow' + (app.sel.has(e.id) ? ' sel' : ''), onclick: () => app.setSel([e]) },
              h('span', { class: 'ol' }, `${E.TYPE_NAMES[e.type] || e.type}  #${e.id}`),
            ),
          );
    }
    return lay;
  }

  /**
   * Shows only one layer (or, when it is the isolated one already, restores the earlier visibility).
   * @private
   * @param {string} name layer name
   */
  isolate(name) {
    const { app } = this;
    const d = app.doc;
    if (this.isolated === name && this.saved) {
      app.edit('LAYER show all', () => {
        for (const l of d.layers) if (this.saved.has(l.name)) l.on = this.saved.get(l.name);
      });
      this.isolated = null;
      this.saved = null;
      return;
    }
    this.saved = new Map(d.layers.map((l) => [l.name, l.on]));
    this.isolated = name;
    app.edit(`LAYER isolate ${name}`, () => {
      for (const l of d.layers) l.on = l.name === name;
    });
  }

  // ---------------------------------------------------------------- public API

  /** Shows or hides the panel (and tells the app, so toolbars can follow). */
  show(on) {
    this.root.classList.toggle('hidden', !on);
    if (on) this.render();
    this.app.emit('historyPanel', on);
  }

  /** Switches between shown and hidden. */
  toggle() {
    this.show(this.root.classList.contains('hidden'));
  }

  /** @returns {boolean} true while the panel is shown. */
  get visible() {
    return !this.root.classList.contains('hidden');
  }
}

/* ============================================================================================
 * 4. FACTORY
 * ========================================================================================== */

/**
 * Creates the Model History panel.
 * @param {object} app the application
 * @param {Function} h element factory
 * @param {HTMLElement} mount where to insert the panel
 * @param {HTMLElement|null} [before] insert before this child
 * @returns {HistoryPanel}
 */
export function initHistory(app, h, mount, before = null) {
  return new HistoryPanel(app, h, mount, before);
}
