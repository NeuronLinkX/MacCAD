/**
 * @file props.js
 * @brief Properties palette (Ctrl+1).
 *
 * Shows the general properties (layer, colour, linetype, lineweight) of the selected objects and,
 * for one selected object, its geometry. Edits go through `app.edit`, so each one is one undo step.
 *
 * Use `buildProps(app, el, onClose)`; it fills the palette element `el` and is called again
 * whenever the selection changes.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import * as E from './entities.js';
import { colorName, LINEWEIGHTS } from './doc.js';
import { fmtLen, fmtAng, parseDist } from './units.js';
import { rad, deg } from './geom.js';

/* ============================================================================================
 * 2. CONSTANTS
 * ========================================================================================== */

/** [stored value, label] pairs of the colour list ('' = ByLayer, 'bb' = ByBlock, 1..7 = ACI colours). */
const COLOR_CHOICES = [
  ['', 'ByLayer'],
  ['bb', 'ByBlock'],
  ['1', 'Red'],
  ['2', 'Yellow'],
  ['3', 'Green'],
  ['4', 'Cyan'],
  ['5', 'Blue'],
  ['6', 'Magenta'],
  ['7', 'White'],
];

/* ============================================================================================
 * 3. CLASS
 * ========================================================================================== */

/** One build of the Properties palette for the current selection. */
export class PropertiesPalette {
  /**
   * @param {object} app the application
   * @param {HTMLElement} el the palette element (its content is replaced)
   * @param {() => void} onClose called by the × button
   */
  constructor(app, el, onClose) {
    this.app = app;
    this.el = el;
    this.onClose = onClose;
    this.doc = app.doc;
    /** Unit settings used to format lengths and angles. */
    this.u = app.doc.units;
    /** The selected entities. */
    this.ents = app.selectedEnts();
    /** @type {HTMLElement} the scrolling body that holds the rows */
    this.body = null;
  }

  // ---------------------------------------------------------------- element helpers

  /**
   * Tiny element factory: `h('div', {class: 'x', onclick: fn}, child, 'text')`.
   * @param {string} tag
   * @param {object} [attrs] `class`, `onxxx` handlers, or plain attributes
   * @param {...(Node|string|Array)} kids
   * @returns {HTMLElement}
   */
  static h(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat())
      if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
    return e;
  }

  /** Adds one labelled row to the body. */
  row(label, node) {
    const h = PropertiesPalette.h;
    this.body.append(
      h(
        'div',
        { class: 'row' },
        h('label', { title: label }, label),
        h('div', { class: 'v' }, node),
      ),
    );
  }

  /** Adds a group heading to the body. */
  grp(t) {
    this.body.append(PropertiesPalette.h('div', { class: 'grp' }, t));
  }

  /** Adds a read-only row. */
  ro(label, value) {
    this.row(label, PropertiesPalette.h('div', { class: 'ro' }, value));
  }

  /** Runs `fn` on every selected entity as one undo step called `label`. */
  apply(label, fn) {
    this.app.edit(label, () => {
      this.ents.forEach(fn);
    });
  }

  /** @returns {*} the value `get(e)` has in common for all selected entities, or null when they differ. */
  common(get) {
    const s = new Set(this.ents.map(get));
    return s.size === 1 ? [...s][0] : null;
  }

  /**
   * A text field: Enter applies, typing never reaches the drawing shortcuts.
   * @param {*} value initial text
   * @param {(text: string) => void} onChange called when the text is committed
   * @returns {HTMLInputElement}
   */
  input(value, onChange) {
    const i = PropertiesPalette.h('input', { type: 'text', value: value ?? '' });
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') i.blur();
      e.stopPropagation();
    });
    i.addEventListener('change', () => onChange(i.value));
    return i;
  }

  // ---------------------------------------------------------------- building

  /** Builds the whole palette. */
  build() {
    const h = PropertiesPalette.h;
    const { el, ents } = this;
    el.innerHTML = '';
    el.append(
      h(
        'div',
        { class: 'ph' },
        h('span', {}, 'Properties'),
        h('b', { onclick: this.onClose }, '×'),
      ),
    );
    this.body = h('div', { class: 'pb' });
    this.body.append(this.typeSelector());
    if (!ents.length) this.noSelectionRows();
    else {
      this.generalRows();
      if (ents.length === 1) this.geometryRows(ents[0]);
    }
    el.append(this.body);
  }

  /** @private The drop-down at the top that names the selection ("Line", "All (3)", ...). */
  typeSelector() {
    const h = PropertiesPalette.h;
    const { ents } = this;
    const head = h('select', { class: 'pt' });
    if (!ents.length) head.append(h('option', {}, 'No selection'));
    else {
      const types = {};
      ents.forEach((e) => {
        types[E.typeName(e)] = (types[E.typeName(e)] || 0) + 1;
      });
      head.append(
        h('option', {}, ents.length === 1 ? E.typeName(ents[0]) : `All (${ents.length})`),
      );
      Object.entries(types).forEach(([t, n]) => head.append(h('option', {}, `${t} (${n})`)));
    }
    return head;
  }

  /** @private Rows shown when nothing is selected: the current settings and the view. */
  noSelectionRows() {
    const { doc, u, app } = this;
    this.grp('General');
    this.ro('Color', colorName(doc.cur.color));
    this.ro('Layer', doc.cur.layer);
    this.ro('Linetype', doc.cur.ltype || 'ByLayer');
    this.ro('Linetype scale', String(doc.ltscale));
    this.grp('View');
    this.ro('Center X', fmtLen(app.view.cx, u));
    this.ro('Center Y', fmtLen(app.view.cy, u));
    this.ro('Zoom', app.view.zoom.toFixed(4));
  }

  /** @private Layer, colour, linetype, linetype scale and lineweight of the selection. */
  generalRows() {
    const h = PropertiesPalette.h;
    const { doc, ents } = this;
    this.grp('General');

    // layer
    const lay = h('select', {});
    doc.layers.forEach((l) => lay.append(h('option', { value: l.name }, l.name)));
    const lv = this.common((e) => e.layer);
    if (lv) lay.value = lv;
    else lay.append(h('option', { value: '', selected: 'true' }, '*VARIES*'));
    lay.addEventListener(
      'change',
      () =>
        lay.value &&
        this.apply('LAYER', (e) => {
          e.layer = lay.value;
        }),
    );
    this.row('Layer', lay);

    // colour
    const col = h('select', {});
    COLOR_CHOICES.forEach(([v, t]) => col.append(h('option', { value: v }, t)));
    const cv = this.common((e) => (e.color == null ? '' : String(e.color)));
    if (cv === null) col.append(h('option', { value: '~', selected: 'true' }, '*VARIES*'));
    else {
      if (![...col.options].some((o) => o.value === cv)) col.append(h('option', { value: cv }, cv));
      col.value = cv;
    }
    col.addEventListener('change', () => {
      if (col.value === '~') return;
      this.apply('COLOR', (e) => {
        e.color =
          col.value === ''
            ? null
            : col.value === 'bb'
              ? 'bb'
              : /^#/.test(col.value)
                ? col.value
                : +col.value;
      });
    });
    this.row('Color', col);

    // linetype
    const lt = h('select', {});
    lt.append(h('option', { value: '' }, 'ByLayer'));
    Object.keys(doc.ltypes).forEach((n) => lt.append(h('option', { value: n }, n)));
    const tv = this.common((e) => e.ltype || '');
    if (tv !== null) lt.value = tv;
    else lt.append(h('option', { selected: 'true', value: '~' }, '*VARIES*'));
    lt.addEventListener(
      'change',
      () =>
        lt.value !== '~' &&
        this.apply('LINETYPE', (e) => {
          e.ltype = lt.value || null;
        }),
    );
    this.row('Linetype', lt);

    // linetype scale
    this.row(
      'Linetype scale',
      this.input(this.common((e) => e.ltscale) ?? '', (v) => {
        const n = parseFloat(v);
        if (n > 0)
          this.apply('LTSCALE', (e) => {
            e.ltscale = n;
          });
      }),
    );

    // lineweight
    const lw = h('select', {});
    lw.append(h('option', { value: '' }, 'ByLayer'));
    LINEWEIGHTS.forEach((w) => lw.append(h('option', { value: w }, `${w.toFixed(2)} mm`)));
    const wv = this.common((e) => (e.lw == null ? '' : e.lw));
    if (wv !== null) lw.value = String(wv);
    lw.addEventListener('change', () =>
      this.apply('LWEIGHT', (e) => {
        e.lw = lw.value === '' ? null : parseFloat(lw.value);
      }),
    );
    this.row('Lineweight', lw);
    void ents;
  }

  // ---------------------------------------------------------------- geometry rows

  /** @private A length field that edits `set(n)` with the parsed value. */
  numberRow(label, get, set) {
    this.row(
      label,
      this.input(fmtLen(get(), this.u), (v) => {
        const n = parseDist(v);
        if (!isNaN(n))
          this.apply('PROPERTIES', () => {
            set(n);
          });
      }),
    );
  }

  /** @private X and Y fields for the point stored in `e[key]`. */
  pointRows(e, label, key) {
    this.numberRow(
      `${label} X`,
      () => e[key].x,
      (n) => {
        e[key] = { ...e[key], x: n };
      },
    );
    this.numberRow(
      `${label} Y`,
      () => e[key].y,
      (n) => {
        e[key] = { ...e[key], y: n };
      },
    );
  }

  /** @private A free text field that sets `e[key]` through `parse(text)` as one undo step. */
  textRow(label, text, set) {
    this.row(
      label,
      this.input(text, (v) =>
        this.apply('PROPERTIES', () => {
          set(v);
        }),
      ),
    );
  }

  /**
   * The geometry rows of one selected entity (what is editable and what is only shown depends on
   * its type).
   * @private
   * @param {object} e the entity
   */
  geometryRows(e) {
    const { doc, u } = this;
    const ro = (l, v) => this.ro(l, v);
    this.grp('Geometry');
    switch (e.type) {
      case 'solid3d':
        ro('Body type', e.bodyKind || 'solid');
        if (e.feature) {
          ro('Feature', e.feature.operation);
          for (const [name, value] of Object.entries(e.feature.parameters || {}))
            if (typeof value === 'number' || typeof value === 'string') ro(name, String(value));
          if (e.feature.inputs) ro('Edit parameters', 'Modeling → Edit Parameters (EDITFEATURE)');
        }
        break;
      case 'line':
        this.pointRows(e, 'Start', 'p1');
        this.pointRows(e, 'End', 'p2');
        ro('Length', fmtLen(E.entLength(e), u));
        ro('Angle', fmtAng(Math.atan2(e.p2.y - e.p1.y, e.p2.x - e.p1.x), u, true));
        break;
      case 'circle':
        this.pointRows(e, 'Center', 'c');
        this.numberRow(
          'Radius',
          () => e.r,
          (n) => {
            if (n > 0) e.r = n;
          },
        );
        ro('Diameter', fmtLen(e.r * 2, u));
        ro('Circumference', fmtLen(E.entLength(e), u));
        ro('Area', fmtLen(E.entArea(e), u));
        break;
      case 'arc':
        this.pointRows(e, 'Center', 'c');
        this.numberRow(
          'Radius',
          () => e.r,
          (n) => {
            if (n > 0) e.r = n;
          },
        );
        this.textRow('Start angle', fmtAng(e.a0, u), (v) => {
          e.a0 = rad(parseFloat(v));
        });
        this.textRow('End angle', fmtAng(e.a1, u), (v) => {
          e.a1 = rad(parseFloat(v));
        });
        ro('Arc length', fmtLen(E.entLength(e), u));
        break;
      case 'pline':
        ro('Closed', e.closed ? 'Yes' : 'No');
        ro('Vertices', String(e.pts.length));
        ro('Length', fmtLen(E.entLength(e), u));
        ro('Area', fmtLen(E.entArea(e), u));
        break;
      case 'ellipse': {
        const ax = E.ellipseAxes(e);
        this.pointRows(e, 'Center', 'c');
        ro('Major radius', fmtLen(ax.a, u));
        ro('Minor radius', fmtLen(ax.b, u));
        ro('Radius ratio', (ax.b / ax.a).toFixed(4));
        break;
      }
      case 'text':
      case 'mtext':
        this.textRow('Contents', e.str.replace(/\n/g, '\\P'), (v) => {
          e.str = v.replace(/\\P/g, '\n');
        });
        this.pointRows(e, 'Position', 'p');
        this.numberRow(
          'Height',
          () => e.h,
          (n) => {
            if (n > 0) e.h = n;
          },
        );
        this.textRow('Rotation', deg(e.rot || 0).toFixed(2), (v) => {
          e.rot = rad(parseFloat(v) || 0);
        });
        this.styleRow(e, doc);
        break;
      case 'insert':
        ro('Name', e.name);
        this.pointRows(e, 'Position', 'p');
        this.textRow('Scale X', String(e.sx), (v) => {
          e.sx = parseFloat(v) || 1;
        });
        this.textRow('Scale Y', String(e.sy), (v) => {
          e.sy = parseFloat(v) || 1;
        });
        this.textRow('Rotation', deg(e.rot || 0).toFixed(2), (v) => {
          e.rot = rad(parseFloat(v) || 0);
        });
        break;
      case 'point':
        this.pointRows(e, 'Position', 'p');
        break;
      case 'hatch':
        ro('Pattern', e.pattern);
        this.textRow('Scale', String(e.scale), (v) => {
          e.scale = parseFloat(v) || 1;
        });
        ro('Area', fmtLen(E.entArea(e), u));
        break;
      case 'dim':
        ro('Measurement', E.dimText({ ...e, text: null }, doc));
        this.textRow('Text override', e.text || '', (v) => {
          e.text = v || null;
        });
        break;
      case 'donut':
        this.pointRows(e, 'Center', 'c');
        this.numberRow(
          'Inside radius',
          () => e.rin,
          (n) => {
            e.rin = n;
          },
        );
        this.numberRow(
          'Outside radius',
          () => e.rout,
          (n) => {
            e.rout = n;
          },
        );
        break;
      case 'viewport':
        this.textRow('Scale (paper/model)', String(+e.scale.toFixed(6)), (v) => {
          const n = parseFloat(v);
          if (n > 0) e.scale = n;
        });
        break;
      default:
        ro('Type', E.typeName(e));
    }
  }

  /** @private The text style drop-down of a text entity. */
  styleRow(e, doc) {
    const h = PropertiesPalette.h;
    const st = h('select', {});
    Object.keys(doc.textStyles).forEach((n) => st.append(h('option', { value: n }, n)));
    st.value = e.style || 'Standard';
    st.addEventListener('change', () =>
      this.apply('PROPERTIES', () => {
        e.style = st.value;
      }),
    );
    this.row('Style', st);
  }
}

/* ============================================================================================
 * 4. FACTORY
 * ========================================================================================== */

/**
 * Fills the palette element for the current selection.
 * @param {object} app the application
 * @param {HTMLElement} el the palette element
 * @param {() => void} onClose called by the × button
 */
export function buildProps(app, el, onClose) {
  new PropertiesPalette(app, el, onClose).build();
}
