/**
 * @file doc.js
 * @brief The drawing document: layers, linetypes, styles, blocks, spaces (model + layouts), the
 *        undo history and the (de)serialisation of the .mcad file.
 *
 * Also the colour helpers (AutoCAD colour index -> CSS colour) and the standard linetype table.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import { clone, mk, DEFAULT_DIMSTYLE, DEFAULT_TEXTSTYLE } from './entities.js';
import { defaultUnits } from './units.js';

/* ============================================================================================
 * 2. TABLES AND CONSTANTS
 * ========================================================================================== */

/** The standard linetypes: pattern lengths in mm (positive = dash, negative = gap, 0 = dot). */
export const LINETYPES = {
  Continuous: [],
  DASHED: [12.7, -6.35],
  DASHED2: [6.35, -3.175],
  HIDDEN: [6.35, -3.175],
  HIDDEN2: [3.175, -1.5875],
  CENTER: [31.75, -6.35, 6.35, -6.35],
  CENTER2: [19.05, -3.175, 3.175, -3.175],
  PHANTOM: [31.75, -6.35, 6.35, -6.35, 6.35, -6.35],
  DASHDOT: [12.7, -6.35, 0, -6.35],
  DOT: [0, -6.35],
  BORDER: [12.7, -6.35, 12.7, -6.35, 0, -6.35],
  DIVIDE: [12.7, -6.35, 0, -6.35, 0, -6.35],
};

/** The standard lineweights in mm. */
export const LINEWEIGHTS = [
  0, 0.05, 0.09, 0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.53, 0.6, 0.7, 0.8, 0.9, 1.0,
  1.06, 1.2, 1.4, 1.58, 2.0, 2.11,
];

/** Names of the seven basic colours (AutoCAD colour index 1..7). */
export const ACI_NAMES = {
  1: 'Red',
  2: 'Yellow',
  3: 'Green',
  4: 'Cyan',
  5: 'Blue',
  6: 'Magenta',
  7: 'White',
};

/** Colours 0..9 of the AutoCAD colour index. */
const ACI_BASE = [
  '#000000',
  '#ff0000',
  '#ffff00',
  '#00ff00',
  '#00ffff',
  '#0000ff',
  '#ff00ff',
  '#ffffff',
  '#808080',
  '#c0c0c0',
];

/** Solid data (BREP text) longer than this is kept once per drawing, not inside every snapshot / file piece. */
const BIG_BREP = 20000;
/** Most undo steps that are kept. */
const MAX_UNDO_STEPS = 200;
/** After how many undo steps the table of big BREP texts is cleaned of unused entries. */
const SWEEP_EVERY_STEPS = 20;
/** The table is not cleaned while it holds fewer entries than this. */
const SWEEP_MIN_ENTRIES = 64;

/** What a new layer looks like (the name is added first, extra properties last). */
const LAYER_DEFAULTS = {
  color: 7,
  ltype: 'Continuous',
  lw: 0.25,
  on: true,
  frozen: false,
  locked: false,
  plot: true,
};

/* ============================================================================================
 * 3. COLOURS
 * ========================================================================================== */

/** AutoCAD colour index helpers. */
export class AciColor {
  /**
   * The CSS colour for an AutoCAD colour index (0..255); a string is returned unchanged
   * (true colour such as "#ff8800").
   * @param {number|string} n
   * @returns {string} "#rrggbb"
   */
  static hex(n) {
    if (typeof n === 'string') return n;
    n = n | 0;
    if (n >= 0 && n <= 9) return ACI_BASE[n];
    if (n >= 250 && n <= 255) {
      const v = [51, 91, 132, 173, 214, 255][n - 250];
      return '#' + [v, v, v].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
    const i = n - 10;
    const hue = Math.floor(i / 10) * 15;
    const k = i % 10;
    const sat = k % 2 === 0 ? 1 : 0.5;
    const val = [1, 0.65, 0.5, 0.3, 0.15][Math.floor(k / 2)];
    const c = val * sat;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = val - c;
    const [r, g, b] =
      hue < 60
        ? [c, x, 0]
        : hue < 120
          ? [x, c, 0]
          : hue < 180
            ? [0, c, x]
            : hue < 240
              ? [0, x, c]
              : hue < 300
                ? [x, 0, c]
                : [c, 0, x];
    return (
      '#' +
      [r + m, g + m, b + m]
        .map((v) =>
          Math.round(v * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')
    );
  }

  /**
   * The display name of a colour setting.
   * @param {number|string|null} c null = ByLayer, 'bb' = ByBlock, a number = colour index, a string = true colour
   * @returns {string}
   */
  static label(c) {
    if (c == null) return 'ByLayer';
    if (c === 'bb') return 'ByBlock';
    if (typeof c === 'number') return ACI_NAMES[c] || String(c);
    return c.toUpperCase();
  }
}

/* ============================================================================================
 * 4. LAYOUTS
 * ========================================================================================== */

/**
 * A new paper-space layout with one viewport that fills the sheet (10 mm margin).
 * @param {string} name layout name
 * @param {number} [w] paper width in mm
 * @param {number} [h] paper height in mm
 * @returns {{name: string, paper: object, ents: object[], view: object}}
 */
export function newLayout(name, w = 420, h = 297) {
  return {
    name,
    paper: { w, h, size: 'ISO A3 (420.00 x 297.00 MM)', landscape: true },
    ents: [
      {
        id: 0,
        type: 'viewport',
        layer: '0',
        color: null,
        ltype: null,
        lw: null,
        ltscale: 1,
        p1: { x: 10, y: 10 },
        p2: { x: w - 10, y: h - 10 },
        cx: w / 2,
        cy: h / 2,
        scale: 1,
        locked: false,
      },
    ],
    view: { cx: w / 2, cy: h / 2, zoom: 1.5 },
  };
}

/* ============================================================================================
 * 5. THE DOCUMENT
 * ========================================================================================== */

/** One drawing: everything that is saved in a .mcad file plus the undo / redo history. */
export class Doc {
  /** Counts the documents created, so that each gets its own `uid`. */
  static uidCounter = 0;

  constructor() {
    this.reset();
  }

  /** Puts the document into the state of a new, empty drawing. */
  reset() {
    this.uid = ++Doc.uidCounter; // identifies the document in caches shared by all open drawings
    this.name = 'Drawing1';
    this.path = null;
    this.layers = [{ name: '0', ...LAYER_DEFAULTS }];
    this.cur = { layer: '0', color: null, ltype: null, lw: null };
    this.ltypes = { ...LINETYPES };
    this.textStyles = {
      Standard: { ...DEFAULT_TEXTSTYLE },
      Simplex: { font: 'simplex.shx', wf: 1, obl: 0, h: 0 },
      Romans: { font: 'romans.shx', wf: 1, obl: 0, h: 0 },
      Hangul: { font: 'NanumGothic', wf: 1, obl: 0, h: 0 },
    };
    this.curTextStyle = 'Standard';
    this.dimStyles = { Standard: { ...DEFAULT_DIMSTYLE } };
    this.curDimStyle = 'Standard';
    this.blocks = {};
    this.groups = {};
    this.limits = null;
    this.views = {};
    this.ucs = { current: null, previous: null, named: {} };
    this.props = {};
    this.blockVer = 0;
    this.units = defaultUnits();
    this.ltscale = 1;
    this.pdmode = 0;
    this.pdsize = 0;
    this.model = [];
    this.layouts = { Layout1: newLayout('Layout1'), Layout2: newLayout('Layout2') };
    this.modelView = { cx: 210, cy: 148.5, zoom: 2.2 };
    this.nextId = 1;
    this.undoStack = [];
    this.redoStack = [];
    this.layouts.Layout1.ents.forEach((e) => {
      e.id = this.nextId++;
    });
    this.layouts.Layout2.ents.forEach((e) => {
      e.id = this.nextId++;
    });
    this.dirty = false;
  }

  // ---------------------------------------------------------------- spaces and objects

  /** @returns {object[]} the objects of a space ('model' or a layout name). */
  spaceList(space) {
    return space === 'model' ? this.model : (this.layouts[space] || { ents: [] }).ents;
  }

  /** Adds an object to a space and gives it the next id. @returns {object} the object */
  add(e, space = 'model') {
    e.id = this.nextId++;
    this.spaceList(space).push(e);
    return e;
  }

  /** Adds several objects. @returns {object[]} the list */
  addMany(list, space) {
    list.forEach((e) => this.add(e, space));
    return list;
  }

  /** Removes the objects with the given ids from a space. */
  remove(ids, space) {
    const set = new Set(ids);
    const arr = this.spaceList(space);
    for (let i = arr.length - 1; i >= 0; i -= 1) if (set.has(arr[i].id)) arr.splice(i, 1);
  }

  /** Replaces one object by a list of new objects (which get new ids). */
  replace(old, repl, space) {
    const arr = this.spaceList(space);
    const i = arr.indexOf(old);
    if (i < 0) return;
    repl.forEach((e) => {
      e.id = this.nextId++;
    });
    arr.splice(i, 1, ...repl);
  }

  /** @returns {object|undefined} the object with this id in a space. */
  byId(id, space) {
    return this.spaceList(space).find((e) => e.id === id);
  }

  // ---------------------------------------------------------------- layers and properties

  /** @returns {object} the layer with this name (the first layer when there is none). */
  layer(name) {
    return this.layers.find((l) => l.name === name) || this.layers[0];
  }

  /** @returns {boolean} true when a layer of this name exists (case-insensitive). */
  hasLayer(name) {
    return this.layers.some((l) => l.name.toLowerCase() === String(name).toLowerCase());
  }

  /** Adds a layer, or returns the existing one of that name. @returns {object} the layer */
  addLayer(name, props = {}) {
    if (this.hasLayer(name))
      return this.layers.find((l) => l.name.toLowerCase() === name.toLowerCase());
    const l = { name, ...LAYER_DEFAULTS, ...props };
    this.layers.push(l);
    return l;
  }

  /**
   * Is the object shown? `e.hid`: the object was sent to the hidden space one by one
   * (HIDEOBJECTS, Cmd+B); a layer that is off or frozen hides it as well.
   */
  visible(e) {
    if (e.hid) return false;
    const l = this.layer(e.layer);
    return l.on && !l.frozen;
  }

  /** @returns {boolean} true when the object's layer is locked. */
  locked(e) {
    return this.layer(e.layer).locked;
  }

  /** @returns {number|string} the colour an object is drawn with (ByLayer / ByBlock resolved). */
  effColor(e) {
    const c = e.color;
    if (c == null) return this.layer(e.layer).color;
    if (c === 'bb') return 7;
    return c;
  }

  /** @returns {string} the linetype name an object is drawn with. */
  effLtype(e) {
    const t = e.ltype;
    return !t || t === 'bb' ? this.layer(e.layer).ltype : t;
  }

  /** @returns {number} the lineweight (mm) an object is drawn with. */
  effLw(e) {
    return e.lw == null ? this.layer(e.layer).lw : e.lw === 'bb' ? 0.25 : e.lw;
  }

  /** Applies the current drawing properties (layer, colour, ...) to a new object. @returns {object} the object */
  stamp(e) {
    e.layer = this.cur.layer;
    e.color = this.cur.color;
    e.ltype = this.cur.ltype;
    e.lw = this.cur.lw;
    if (e.type === 'text' || e.type === 'mtext') e.style = e.style || this.curTextStyle;
    if (e.type === 'dim' || e.type === 'leader') e.style = this.curDimStyle;
    return e;
  }

  // ---------------------------------------------------------------- blocks

  /** Defines (or redefines) a block from a list of objects. */
  defineBlock(name, base, ents) {
    this.blocks[name] = {
      name,
      base,
      ents: ents.map((e) => {
        const k = clone(e);
        k.id = 0;
        return k;
      }),
    };
    this.blockVer += 1;
  }

  // ---------------------------------------------------------------- history (snapshots)

  /** @returns {string} the whole drawing state as one JSON string (for one undo step). */
  snapshot() {
    return JSON.stringify(
      {
        l: this.layers,
        c: this.cur,
        t: this.ltypes,
        ts: this.textStyles,
        cts: this.curTextStyle,
        ds: this.dimStyles,
        cds: this.curDimStyle,
        b: this.blocks,
        g: this.groups,
        lm: this.limits,
        vw: this.views,
        uc: this.ucs,
        u: this.units,
        lt: this.ltscale,
        pm: this.pdmode,
        ps: this.pdsize,
        m: this.model,
        ly: this.layouts,
        n: this.nextId,
      },
      (k, v) =>
        k[0] === '_'
          ? undefined
          : k === 'brep' && typeof v === 'string' && v.length > BIG_BREP
            ? this._internBrep(v)
            : v,
    );
  }

  /** Puts the drawing back into the state of a snapshot. */
  restore(s) {
    const o = JSON.parse(
      s,
      s.includes('"$b"')
        ? (k, v) => (v && typeof v === 'object' && v.$b !== undefined ? this._bs.strs[v.$b] : v)
        : undefined,
    );
    this.layers = o.l;
    this.cur = o.c;
    this.ltypes = o.t;
    this.textStyles = o.ts;
    this.curTextStyle = o.cts;
    this.dimStyles = o.ds;
    this.curDimStyle = o.cds;
    this.blocks = o.b;
    this.groups = o.g || {};
    this.limits = o.lm || null;
    this.views = o.vw || {};
    this.ucs = o.uc || { current: null, previous: null, named: {} };
    this.units = o.u;
    this.ltscale = o.lt;
    this.pdmode = o.pm;
    this.pdsize = o.ps;
    this.model = o.m;
    this.layouts = o.ly;
    this.nextId = o.n;
    this.blockVer += 1;
  }

  /**
   * The BREP text of a solid is large (a 45 MB STEP file gives 60 MB of it) and a whole drawing is
   * turned into ONE string for every undo step and for saving, which a JavaScript string cannot
   * hold beyond about 512 MB. So big solid data is kept once in a per-drawing table and a snapshot
   * only holds `{ $b: id }`.
   * @private
   */
  _internBrep(v) {
    const st = this._bs || (this._bs = { ids: new Map(), strs: [] });
    let id = st.ids.get(v);
    if (id === undefined) {
      id = st.strs.length;
      st.strs.push(v);
      st.ids.set(v, id);
    }
    return { $b: id };
  }

  /** Forgets the table entries that no undo / redo step refers to any more. @private */
  _sweepBreps() {
    const st = this._bs;
    if (!st || st.strs.length < SWEEP_MIN_ENTRIES) return;
    const used = new Set();
    const re = /"\$b":(\d+)/g;
    for (const u of [...this.undoStack, ...this.redoStack]) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(u.s))) used.add(+m[1]);
    }
    st.strs.forEach((v, i) => {
      if (v !== null && !used.has(i)) {
        st.ids.delete(v);
        st.strs[i] = null;
      }
    });
  }

  // ---------------------------------------------------------------- history (undo / redo)

  /**
   * Remembers the state before a change as an undo step.
   * @param {string} before a snapshot taken before the change
   * @param {string} label what the change was (shown in the Model History)
   */
  pushUndo(before, label) {
    this.undoStack.push({ s: before, label, t: Date.now() });
    if (this.undoStack.length > MAX_UNDO_STEPS) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
    if (this._bs && this.undoStack.length % SWEEP_EVERY_STEPS === 0) this._sweepBreps();
  }

  /** Takes one step back. @returns {string|null} the label of the undone step, or null */
  undo() {
    const u = this.undoStack.pop();
    if (!u) return null;
    this.redoStack.push({ s: this.snapshot(), label: u.label, t: u.t });
    this.restore(u.s);
    this.dirty = true;
    return u.label;
  }

  /** Takes one step forward again. @returns {string|null} the label of the redone step, or null */
  redo() {
    const r = this.redoStack.pop();
    if (!r) return null;
    this.undoStack.push({ s: this.snapshot(), label: r.label, t: r.t });
    this.restore(r.s);
    this.dirty = true;
    return r.label;
  }

  // ---------------------------------------------------------------- file format (.mcad)

  /**
   * What a .mcad file holds (the order of the keys is the order in the file).
   * @private
   */
  fileObject() {
    return {
      format: 'maccad',
      version: 1,
      name: this.name,
      layers: this.layers,
      cur: this.cur,
      ltypes: this.ltypes,
      textStyles: this.textStyles,
      curTextStyle: this.curTextStyle,
      dimStyles: this.dimStyles,
      curDimStyle: this.curDimStyle,
      blocks: this.blocks,
      groups: this.groups,
      limits: this.limits,
      views: this.views,
      ucs: this.ucs,
      props: this.props,
      units: this.units,
      ltscale: this.ltscale,
      pdmode: this.pdmode,
      pdsize: this.pdsize,
      model: this.model,
      layouts: this.layouts,
      modelView: this.modelView,
      nextId: this.nextId,
    };
  }

  /** @returns {object} a deep copy of the drawing as plain data (the .mcad content). */
  toJSON() {
    return JSON.parse(JSON.stringify(this.fileObject(), (k, v) => (k[0] === '_' ? undefined : v)));
  }

  /**
   * The .mcad text as a list of strings whose concatenation is the file: the BREP text of each big
   * solid is a chunk of its own, so no single string has to hold the whole drawing.
   * @returns {string[]}
   */
  fileChunks() {
    const breps = [];
    const head = JSON.stringify(this.fileObject(), (k, v) =>
      k[0] === '_'
        ? undefined
        : k === 'brep' && typeof v === 'string' && v.length > BIG_BREP
          ? `\u0001${breps.push(v) - 1}\u0001`
          : v,
    );
    if (!breps.length) return [head];
    const out = [];
    const re = /"\\u0001(\d+)\\u0001"/g;
    let last = 0;
    let m;
    while ((m = re.exec(head))) {
      out.push(head.slice(last, m.index));
      out.push(JSON.stringify(breps[+m[1]]));
      last = m.index + m[0].length;
    }
    out.push(head.slice(last));
    return out;
  }

  /**
   * Builds a document from the content of a .mcad file.
   * @param {object} o the parsed file
   * @returns {Doc}
   * @throws {Error} when the data is not a MacCAD drawing
   */
  static fromJSON(o) {
    const d = new Doc();
    if (!o || o.format !== 'maccad') throw new Error('Not a MacCAD drawing');
    Object.assign(d, {
      name: o.name || 'Drawing1',
      layers: o.layers,
      cur: o.cur,
      ltypes: { ...LINETYPES, ...(o.ltypes || {}) },
      textStyles: o.textStyles,
      curTextStyle: o.curTextStyle || 'Standard',
      dimStyles: o.dimStyles,
      curDimStyle: o.curDimStyle || 'Standard',
      blocks: o.blocks || {},
      groups: o.groups || {},
      limits: o.limits || null,
      views: o.views || {},
      ucs: o.ucs || { current: null, previous: null, named: {} },
      props: o.props || {},
      units: { ...defaultUnits(), ...o.units },
      ltscale: o.ltscale ?? 1,
      pdmode: o.pdmode ?? 0,
      pdsize: o.pdsize ?? 0,
      model: o.model || [],
      layouts: o.layouts || {},
      modelView: o.modelView || d.modelView,
      nextId: o.nextId || 1,
    });
    d.dirty = false;
    d.blockVer += 1;
    return d;
  }

  /** Computed by the view helpers (they know the bounding boxes); the document itself has none. */
  extents(space = 'model') {
    return null;
  }
}

/* ============================================================================================
 * 6. READING A .mcad FILE
 * ========================================================================================== */

/**
 * Parses the text of a .mcad that was read in pieces (see `Doc.fileChunks`): the big BREP strings
 * come separately and replace their placeholders.
 * @param {{data: string, breps?: string[]}} f the file as delivered by the main process
 * @returns {object} the parsed content
 */
export function parseMcad(f) {
  if (!f.breps) return JSON.parse(f.data);
  return JSON.parse(f.data, (k, v) =>
    k === 'brep' && typeof v === 'string' && v.charCodeAt(0) === 1 ? f.breps[+v.slice(1, -1)] : v,
  );
}

/* ============================================================================================
 * 7. COMPATIBILITY EXPORTS
 * ========================================================================================== */
export const aciHex = AciColor.hex;
export const colorName = AciColor.label;
export const _mk = mk;
