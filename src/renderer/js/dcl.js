/**
 * @file dcl.js
 * @brief Dialog Control Language (DCL): parser, dialog renderer and the AutoLISP dialog API
 *        (load_dialog, new_dialog, set_tile, get_tile, action_tile, mode_tile, start_list ...,
 *        start_dialog, done_dialog).
 *
 * `parseDcl(src)` reads DCL text into definitions; `DclSession` builds one dialog from a
 * definition and runs it; `installDcl(L, app)` adds the AutoLISP functions to the interpreter.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import { LispError, T, R, nv, toStr } from './lisp.js';

/* ============================================================================================
 * 2. PARSER
 * ========================================================================================== */

/** Reads DCL source text into tile definitions. */
export class DclParser {
  /**
   * Splits DCL text into tokens: `{k: 's', v}` string, `{k: '{'|'}'|':'|';'|'='|','}` punctuation,
   * `{k: 'w', v}` word. Comments (// and /* *\/) are dropped.
   * @param {string} src
   * @returns {{k: string, v?: string}[]}
   */
  static tokenize(src) {
    const t = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) {
        i += 1;
        continue;
      }
      if (c === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i += 1;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        const e = src.indexOf('*/', i + 2);
        i = e < 0 ? src.length : e + 2;
        continue;
      }
      if (c === '"') {
        let s = '';
        i += 1;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\') {
            i += 1;
            s += src[i] === 'n' ? '\n' : src[i] === 't' ? '\t' : src[i];
          } else s += src[i];
          i += 1;
        }
        i += 1;
        t.push({ k: 's', v: s });
        continue;
      }
      if ('{}:;=,'.includes(c)) {
        t.push({ k: c });
        i += 1;
        continue;
      }
      const m = /^[^\s{}:;=,"]+/.exec(src.slice(i));
      if (!m) {
        i += 1;
        continue;
      }
      i += m[0].length;
      t.push({ k: 'w', v: m[0] });
    }
    return t;
  }

  /**
   * Parses DCL text.
   * @param {string} src
   * @returns {Object<string, {type: string, name: string, attrs: object, children: object[]}>}
   *          the named definitions, keyed by lower-case name
   */
  static parse(src) {
    const toks = DclParser.tokenize(src);
    let p = 0;
    const defs = {};
    const peek = () => toks[p];
    const parseBody = () => {
      const node = { attrs: {}, children: [] };
      if (peek() && peek().k === '{') p += 1;
      while (p < toks.length && toks[p].k !== '}') {
        const t = toks[p];
        if (t.k === ':') {
          // child tile or reference:  : type { ... }   or   : name ;
          p += 1;
          const type = toks[p++].v;
          if (peek() && peek().k === ';') {
            p += 1;
            node.children.push({ type, attrs: {}, children: [], ref: true });
            continue;
          }
          const child = parseBody();
          child.type = type;
          node.children.push(child);
        } else if (t.k === 'w') {
          // attribute  name = value ;   OR  name : type { ... }  (named definition used as a child)
          const name = t.v;
          p += 1;
          if (peek() && peek().k === '=') {
            p += 1;
            const v = toks[p++];
            node.attrs[name.toLowerCase()] = v.v;
            if (peek() && peek().k === ';') p += 1;
          } else if (peek() && peek().k === ':') {
            p += 1;
            const type = toks[p++].v;
            const child = parseBody();
            child.type = type;
            child.name = name;
            node.children.push(child);
          } else if (peek() && peek().k === ';') {
            p += 1;
            node.children.push({ type: name, attrs: {}, children: [], ref: true });
          }
        } else p += 1;
      }
      if (peek() && peek().k === '}') p += 1;
      return node;
    };
    while (p < toks.length) {
      const t = toks[p];
      if (t.k === 'w' && toks[p + 1] && toks[p + 1].k === ':') {
        const name = t.v;
        p += 2;
        const type = toks[p++].v;
        const node = parseBody();
        node.type = type;
        node.name = name;
        defs[name.toLowerCase()] = node;
      } else if (t.k === 'w' && t.v === '@include') p += 2;
      else p += 1;
    }
    return defs;
  }
}

/* ============================================================================================
 * 3. DIALOG RENDERER
 * ========================================================================================== */

/**
 * Tiny element factory: `h('div', {class: 'x', onclick: fn}, child, 'text')`.
 * @param {string} tag element name
 * @param {object} [attrs] `class`, `html`, `onxxx` handlers, or plain attributes
 * @param {...(Node|string|Array)} kids children (strings become text nodes)
 * @returns {HTMLElement}
 */
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};

/** A DCL text without the & (the keyboard shortcut marker). */
const clean = (s) => String(s ?? '').replace(/&/g, '');

/** A tile width / height attribute as a number (null when it is not a number). */
const num = (ch) => {
  const v = parseFloat(ch);
  return Number.isNaN(v) ? null : v;
};

/** Pixels per DCL character width unit, and per height unit. */
const PX_PER_WIDTH = 7;
const PX_PER_HEIGHT = 10;

/** One dialog built from a DCL definition; it runs until done_dialog (or OK / Cancel). */
export class DclSession {
  /**
   * @param {object} lisp the AutoLISP interpreter
   * @param {object} def the dialog definition (a node from `DclParser.parse`)
   * @param {object} defs all definitions of the file (for references)
   */
  constructor(lisp, def, defs) {
    this.lisp = lisp;
    this.def = def;
    this.defs = defs;
    /** Tiles by key: {el, node, input}. */
    this.tiles = new Map();
    /** LISP code to run by key (action_tile). */
    this.actions = new Map();
    /** Client data by key (client_data_tile). */
    this.clientData = new Map();
    this.radioGroups = new Map();
    this.result = 0;
    this.resolve = null;
    this.listKey = null;
    this.listOp = 1;
    this.root = null;
    this.counter = 0;
    this.build();
  }

  // ---------------------------------------------------------------- building

  /**
   * The predefined tiles of DCL (ok_cancel, errtile, spacer_0, ...). A new set is made on each
   * call, because tiles are changed while they are built.
   * @private
   */
  static prefab() {
    const prefab = {
      ok_only: {
        type: 'row',
        attrs: { fixed_width: 'true', alignment: 'centered' },
        children: [
          {
            type: 'button',
            attrs: { key: 'accept', label: 'OK', is_default: 'true', width: '10' },
            children: [],
          },
        ],
      },
      ok_cancel: {
        type: 'row',
        attrs: { fixed_width: 'true', alignment: 'centered' },
        children: [
          {
            type: 'button',
            attrs: { key: 'accept', label: 'OK', is_default: 'true', width: '10' },
            children: [],
          },
          {
            type: 'button',
            attrs: { key: 'cancel', label: 'Cancel', is_cancel: 'true', width: '10' },
            children: [],
          },
        ],
      },
      ok_cancel_help: {
        type: 'row',
        attrs: { fixed_width: 'true', alignment: 'centered' },
        children: [
          {
            type: 'button',
            attrs: { key: 'accept', label: 'OK', is_default: 'true', width: '10' },
            children: [],
          },
          {
            type: 'button',
            attrs: { key: 'cancel', label: 'Cancel', is_cancel: 'true', width: '10' },
            children: [],
          },
          { type: 'button', attrs: { key: 'help', label: 'Help', width: '10' }, children: [] },
        ],
      },
      errtile: { type: 'text', attrs: { key: 'error', width: '30' }, children: [] },
      spacer_0: { type: 'spacer', attrs: { width: '0' }, children: [] },
      spacer_1: { type: 'spacer', attrs: { width: '1' }, children: [] },
    };
    prefab.ok_cancel_help_errtile = {
      type: 'column',
      attrs: {},
      children: [
        { type: 'text', attrs: { key: 'error', width: '30' }, children: [] },
        prefab.ok_cancel_help,
      ],
    };
    prefab.ok_cancel_err = prefab.ok_cancel_help_errtile;
    prefab.ok_cancel_help_info = prefab.ok_cancel_help;
    return prefab;
  }

  /** @private Replaces a reference (`: name ;`) by its definition or a predefined tile. */
  resolveNode(n) {
    if (!n.ref) return n;
    const d = this.defs[n.type.toLowerCase()];
    if (d) return { ...d, attrs: { ...d.attrs, ...n.attrs }, ref: false };
    return DclSession.prefab()[n.type] || { type: 'spacer', attrs: {}, children: [] };
  }

  /** @private Builds the dialog body. */
  build() {
    const root = h('div', { class: 'dcl-root', style: 'min-width:240px' });
    this.root = root;
    this.title = clean(this.def.attrs.label || this.def.name || 'Dialog');
    for (const c of this.def.children) root.append(this.tile(c));
  }

  /** @private A row / column container. */
  flex(n, dir) {
    const a = n.attrs;
    return h(
      'div',
      {
        style: `display:flex;flex-direction:${dir};gap:6px;align-items:${a.alignment === 'centered' ? 'center' : dir === 'row' ? 'flex-start' : 'stretch'};${a.alignment === 'right' ? 'justify-content:flex-end;' : a.alignment === 'centered' ? 'justify-content:center;' : ''}`,
      },
      ...n.children.map((c) => this.tile(c)),
    );
  }

  /**
   * Builds the element of one tile (and its children).
   * @private
   * @param {object} raw the tile node as parsed (may be a reference)
   * @returns {HTMLElement}
   */
  tile(raw) {
    const n = this.resolveNode(raw);
    const a = n.attrs;
    const key = a.key;
    let el;
    switch (n.type) {
      case 'row':
      case 'concatenation':
        el = this.flex(n, 'row');
        break;
      case 'column':
        el = this.flex(n, 'column');
        break;
      case 'boxed_row':
      case 'boxed_column':
      case 'boxed_radio_row':
      case 'boxed_radio_column':
        el = this.boxedTile(n);
        break;
      case 'radio_row':
      case 'radio_column':
        el = this.radioGroupTile(n);
        break;
      case 'text':
      case 'errtile':
        el = this.textTile(a);
        break;
      case 'edit_box':
      case 'integer':
      case 'real':
        el = this.editTile(a, key);
        break;
      case 'toggle':
        el = this.toggleTile(a, key);
        break;
      case 'radio_button':
        el = this.radioButtonTile(a, key, raw);
        break;
      case 'popup_list':
        el = this.popupTile(a, key);
        break;
      case 'list_box':
        el = this.listBoxTile(a, key);
        break;
      case 'button':
        el = this.buttonTile(a, key);
        break;
      case 'slider':
        el = this.sliderTile(a, key);
        break;
      case 'image':
      case 'image_button':
        el = this.imageTile(a);
        break;
      case 'spacer':
      case 'spacer_0':
      case 'spacer_1':
        el = h('div', {
          style: `width:${(num(a.width) ?? 1) * PX_PER_WIDTH}px;height:${(num(a.height) ?? 1) * PX_PER_HEIGHT}px`,
        });
        break;
      default:
        el = this.flex(n, 'column');
    }
    if (a.is_enabled === 'false' && el.__input) el.__input.disabled = true;
    if (key) this.tiles.set(key, { el, node: n, input: el.__input || null });
    if (a.fixed_width === 'true') el.style.flex = '0 0 auto';
    return el;
  }

  /** @private boxed_row / boxed_column / boxed_radio_*: a frame with a title. */
  boxedTile(n) {
    const a = n.attrs;
    const el = h(
      'fieldset',
      { style: 'border:1px solid var(--sep);border-radius:8px;padding:4px 8px 8px;margin:0' },
      h('legend', { style: 'color:var(--txt2)' }, clean(a.label)),
    );
    const inner = h(
      'div',
      { style: `display:flex;flex-direction:${/row/.test(n.type) ? 'row' : 'column'};gap:6px` },
      ...n.children.map((c) => this.tile(c)),
    );
    el.append(inner);
    return el;
  }

  /** @private radio_row / radio_column: the buttons inside share one group. */
  radioGroupTile(n) {
    const key = n.attrs.key;
    const grp = key || `rg${this.counter++}`;
    this.radioGroups.set(grp, []);
    n.children.forEach((c) => {
      c.__group = grp;
    });
    return h(
      'div',
      {
        style: `display:flex;flex-direction:${n.type === 'radio_row' ? 'row' : 'column'};gap:4px`,
      },
      ...n.children.map((c) => this.tile(c)),
    );
  }

  /** @private text / errtile. */
  textTile(a) {
    return h(
      'div',
      {
        style: `${num(a.width) ? `min-width:${num(a.width) * PX_PER_WIDTH}px;` : ''}white-space:pre-wrap`,
      },
      clean(a.value || a.label),
    );
  }

  /** @private edit_box / integer / real. */
  editTile(a, key) {
    const inp = h('input', {
      type: 'text',
      value: a.value ?? '',
      style: `width:${Math.max(40, (num(a.edit_width) ?? num(a.width) ?? 12) * PX_PER_WIDTH)}px`,
    });
    if (a.edit_limit) inp.maxLength = parseInt(a.edit_limit, 10);
    inp.addEventListener('change', () => this.fire(key, inp.value, 1));
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        inp.blur();
      }
    });
    const el = h(
      'label',
      { style: 'display:flex;gap:6px;align-items:center' },
      a.label
        ? h(
            'span',
            { style: num(a.width) ? `min-width:${num(a.width) * PX_PER_WIDTH}px` : '' },
            clean(a.label),
          )
        : null,
      inp,
    );
    el.__input = inp;
    return el;
  }

  /** @private toggle (check box). */
  toggleTile(a, key) {
    const cb = h('input', { type: 'checkbox' });
    if (a.value === '1') cb.checked = true;
    cb.addEventListener('change', () => this.fire(key, cb.checked ? '1' : '0', 1));
    const el = h('label', { style: 'display:flex;gap:4px;align-items:center' }, cb, clean(a.label));
    el.__input = cb;
    return el;
  }

  /** @private radio_button. */
  radioButtonTile(a, key, raw) {
    const grp = raw.__group || 'rg0';
    const rb = h('input', { type: 'radio', name: `dcl_${grp}_${this.id || 0}` });
    if (a.value === '1') rb.checked = true;
    rb.addEventListener('change', () => {
      if (rb.checked) this.fire(key, '1', 1);
    });
    (this.radioGroups.get(grp) || this.radioGroups.set(grp, []).get(grp)).push({ key, rb });
    const el = h('label', { style: 'display:flex;gap:4px;align-items:center' }, rb, clean(a.label));
    el.__input = rb;
    return el;
  }

  /** @private popup_list (drop-down list). */
  popupTile(a, key) {
    const sel = h('select', {
      style: `${num(a.width) ? `min-width:${num(a.width) * PX_PER_WIDTH}px` : ''}`,
    });
    sel.addEventListener('change', () => this.fire(key, String(sel.selectedIndex), 1));
    const el = h(
      'label',
      { style: 'display:flex;gap:6px;align-items:center' },
      a.label ? h('span', {}, clean(a.label)) : null,
      sel,
    );
    el.__input = sel;
    el.__list = true;
    return el;
  }

  /** @private list_box. */
  listBoxTile(a, key) {
    const sel = h('select', {
      size: Math.max(4, Math.round(num(a.height) ?? 8)),
      style: `min-width:${(num(a.width) ?? 20) * PX_PER_WIDTH}px`,
      ...(a.multiple_select === 'true' ? { multiple: true } : {}),
    });
    sel.addEventListener('change', () => this.fire(key, this.getValue(sel), 1));
    sel.addEventListener('dblclick', () => this.fire(key, this.getValue(sel), 4));
    const el = h(
      'label',
      { style: 'display:flex;flex-direction:column;gap:2px' },
      a.label ? h('span', {}, clean(a.label)) : null,
      sel,
    );
    el.__input = sel;
    el.__list = true;
    return el;
  }

  /** @private button. */
  buttonTile(a, key) {
    const b = h(
      'button',
      {
        class: 'b' + (a.is_default === 'true' ? ' primary' : ''),
        style: `${num(a.width) ? `min-width:${num(a.width) * PX_PER_WIDTH}px;` : ''}height:23px;border:1px solid var(--ctl-edge);border-radius:6px;background:var(--ctl)`,
      },
      clean(a.label),
    );
    b.addEventListener('click', () => this.fire(key, '', 1));
    if (a.is_cancel === 'true') b.dataset.cancel = '1';
    b.__input = b;
    return b;
  }

  /** @private slider. */
  sliderTile(a, key) {
    const s = h('input', {
      type: 'range',
      min: a.min_value ?? 0,
      max: a.max_value ?? 10000,
      value: a.value ?? 0,
      step: a.small_increment ?? 1,
    });
    s.addEventListener('change', () => this.fire(key, s.value, 3));
    const el = h(
      'label',
      { style: 'display:flex;gap:6px;align-items:center' },
      a.label ? h('span', {}, clean(a.label)) : null,
      s,
    );
    el.__input = s;
    return el;
  }

  /** @private image / image_button: an empty canvas (slide images are not drawn). */
  imageTile(a) {
    const el = h('canvas', {
      width: Math.max(40, (num(a.width) ?? 20) * PX_PER_WIDTH),
      height: Math.max(30, (num(a.height) ?? 6) * 14),
      style: `background:${a.color === '-2' || !a.color ? '#222' : '#ccc'};border:1px solid #666`,
    });
    el.__input = el;
    return el;
  }

  // ---------------------------------------------------------------- values

  /** @private The value of an input as DCL gives it to LISP (a string). */
  getValue(el) {
    if (el.tagName === 'SELECT') {
      if (el.multiple) return [...el.selectedOptions].map((o) => o.index).join(' ');
      return el.selectedIndex < 0 ? '' : String(el.selectedIndex);
    }
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? '1' : '0';
    return el.value;
  }

  /** get_tile: the value of a tile (null when there is no such tile). */
  get(key) {
    const t = this.tiles.get(key);
    if (!t) return null;
    if (!t.input) return t.el.textContent;
    return this.getValue(t.input);
  }

  /** set_tile: sets the value of a tile. @returns {boolean} false when there is no such tile */
  set(key, val) {
    const t = this.tiles.get(key);
    if (!t) return false;
    if (!t.input) {
      t.el.textContent = clean(val);
      return true;
    }
    const el = t.input;
    if (el.tagName === 'SELECT') {
      if (el.multiple) {
        const idx = String(val).split(/\s+/).map(Number);
        [...el.options].forEach((o, i) => {
          o.selected = idx.includes(i);
        });
      } else el.selectedIndex = parseInt(val, 10);
    } else if (el.type === 'checkbox' || el.type === 'radio') el.checked = String(val) === '1';
    else if (el.tagName === 'BUTTON') el.textContent = clean(val);
    else el.value = val;
    return true;
  }

  /** mode_tile: 0 enable, 1 disable, 2 focus, 3 focus + select, 4 show / hide. */
  mode(key, m) {
    const t = this.tiles.get(key);
    if (!t || !t.input) return;
    const el = t.input;
    if (m === 0) el.disabled = false;
    else if (m === 1) el.disabled = true;
    else if (m === 2) el.focus();
    else if (m === 3) {
      el.focus();
      if (el.select) el.select();
    } else if (m === 4) el.style.visibility = el.style.visibility === 'hidden' ? '' : 'hidden';
  }

  // ---------------------------------------------------------------- running

  /**
   * A tile was used: runs its action_tile code, or ends the dialog for accept / cancel.
   * @param {string} key the tile key
   * @param {string} value the new value
   * @param {number} reason the DCL reason code (1 selected, 3 slider, 4 double click)
   */
  async fire(key, value, reason) {
    const act = this.actions.get(key);
    if (act) {
      const L = this.lisp;
      L.set('$KEY', key);
      L.set('$VALUE', value);
      L.set('$REASON', reason);
      L.set('$DATA', this.clientData.get(key) ?? null);
      L.set('$X', 0);
      L.set('$Y', 0);
      try {
        await L.evalString(act);
        L.flush();
      } catch (e) {
        L.reportError(e);
      }
      return;
    }
    if (key === 'accept') this.done(1);
    else if (key === 'cancel') this.done(0);
  }

  /** Ends the dialog with a status (1 = OK, 0 = Cancel, or the value given to done_dialog). */
  done(status = 1) {
    this.result = status;
    if (this.overlay) this.overlay.remove();
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r(status);
    }
  }

  /** Shows the dialog. @returns {Promise<number>} resolves with the status when it ends */
  start() {
    return new Promise((resolve) => {
      this.resolve = resolve;
      const bg = h('div', { class: 'modal-bg', style: 'z-index:2500' });
      this.overlay = bg;
      const x = h('div', { class: 'x', onclick: () => this.fire('cancel', '', 1) }, '×');
      const box = h(
        'div',
        { class: 'dlg' },
        h('div', { class: 'dt' }, h('span', {}, this.title), x),
        h('div', { class: 'db' }, this.root),
      );
      bg.append(box);
      document.body.append(bg);
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          this.fire('cancel', '', 1);
        }
        if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type === 'text') {
          e.preventDefault();
          const def = this.root.querySelector('.primary');
          if (def) def.click();
        }
      });
      bg.addEventListener('mousedown', (e) => e.stopPropagation());
      const first = this.root.querySelector('input,select,button');
      if (first) first.focus();
    });
  }
}

/* ============================================================================================
 * 4. AUTOLISP DIALOG API
 * ========================================================================================== */

/** The AutoLISP functions for dialogs; one instance per interpreter. */
export class DclLispApi {
  /**
   * @param {object} L the AutoLISP interpreter
   * @param {object} app the application
   */
  constructor(L, app) {
    this.L = L;
    this.app = app;
    /** Parsed DCL files by id (load_dialog). */
    this.files = new Map();
    this.nextId = 1;
    /** The dialog that is open now, or null. */
    this.session = null;
  }

  /** load_dialog: reads and parses a .dcl file. @returns {Promise<number>} the file id, -1 when not found */
  async loadDialog(name) {
    const cands = await this.app.fs.candidates(String(name).replace(/\.dcl$/i, '') + '.dcl');
    for (const c of cands) {
      const t = await this.app.fs.readText(c);
      if (t !== null) {
        const id = this.nextId++;
        this.files.set(id, parseDcl(t));
        return id;
      }
    }
    return -1;
  }

  /** unload_dialog */
  unloadDialog(id) {
    this.files.delete(id);
    return null;
  }

  /** new_dialog: builds a dialog from a loaded file. @returns {*} T, or nil when not found */
  newDialog(name, id) {
    const defs = this.files.get(id);
    if (!defs) return null;
    const def = defs[String(name).toLowerCase()];
    if (!def) return null;
    this.session = new DclSession(this.L, def, defs);
    return T;
  }

  /** set_tile */
  setTile(k, v) {
    if (!this.session) throw new LispError('no dialog is active');
    this.session.set(String(k), String(v));
    return v;
  }

  /** get_tile */
  getTile(k) {
    return this.session ? this.session.get(String(k)) : null;
  }

  /** mode_tile */
  modeTile(k, m) {
    this.session && this.session.mode(String(k), nv(m));
    return null;
  }

  /** action_tile: the LISP code to run when a tile is used. */
  actionTile(k, code) {
    if (this.session) this.session.actions.set(String(k), String(code));
    return code;
  }

  /** client_data_tile */
  clientDataTile(k, d) {
    if (this.session) this.session.clientData.set(String(k), d);
    return d;
  }

  /** get_attr / get_attr_string: an attribute of a tile as written in the DCL file. */
  getAttr(k, a) {
    const t = this.session && this.session.tiles.get(String(k));
    const v = t && t.node.attrs[String(a).toLowerCase()];
    return v === undefined ? null : v;
  }

  /** dimx_tile: the width of a tile in DCL units. */
  dimxTile(k) {
    const t = this.session && this.session.tiles.get(String(k));
    return t ? Math.round(t.el.getBoundingClientRect().width / PX_PER_WIDTH) || 100 : 0;
  }

  /** dimy_tile: the height of a tile in DCL units. */
  dimyTile(k) {
    const t = this.session && this.session.tiles.get(String(k));
    return t ? Math.round(t.el.getBoundingClientRect().height / PX_PER_HEIGHT) || 50 : 0;
  }

  /** start_list: begins filling a list box / popup list (operation 3 = new list). */
  startList(k, op) {
    const session = this.session;
    if (!session) return null;
    session.listKey = String(k);
    session.listOp = op === undefined || op === null ? 3 : nv(op);
    const t = session.tiles.get(session.listKey);
    if (t && t.input && session.listOp === 3) t.input.innerHTML = '';
    return k;
  }

  /** add_list: adds a line to the list that start_list opened. */
  addList(s) {
    const session = this.session;
    const t = session && session.tiles.get(session.listKey);
    if (!t || !t.input) return null;
    const o = document.createElement('option');
    o.textContent = String(s);
    t.input.append(o);
    return s;
  }

  /** end_list */
  endList() {
    if (this.session) this.session.listKey = null;
    return null;
  }

  /** done_dialog: ends the dialog with a status (default 1). */
  doneDialog(st) {
    if (this.session) {
      const status = st === undefined || st === null ? 1 : nv(st);
      this.session.done(status);
    }
    return null;
  }

  /** start_dialog: shows the dialog and waits until it ends. @returns {Promise<number>} the status */
  async startDialog() {
    if (!this.session) throw new LispError('no dialog is active');
    const s = this.session;
    const r = await s.start();
    this.session = null;
    return r;
  }

  /** term_dialog: ends the dialog with status 0. */
  termDialog() {
    if (this.session) this.session.done(0);
    return null;
  }

  /** mac-dcl-parse: how many definitions a DCL text holds (nil when it cannot be read). */
  parseCount(src) {
    try {
      return Object.keys(parseDcl(String(src))).length;
    } catch {
      return null;
    }
  }

  /** Adds all functions to the interpreter. */
  register() {
    const D = (n, f) => this.L.def(n, f);
    D('load_dialog', (name) => this.loadDialog(name));
    D('unload_dialog', (id) => this.unloadDialog(id));
    D('new_dialog', (name, id) => this.newDialog(name, id));
    D('set_tile', (k, v) => this.setTile(k, v));
    D('get_tile', (k) => this.getTile(k));
    D('mode_tile', (k, m) => this.modeTile(k, m));
    D('action_tile', (k, code) => this.actionTile(k, code));
    D('client_data_tile', (k, d) => this.clientDataTile(k, d));
    D('get_attr', (k, a) => this.getAttr(k, a));
    D('get_attr_string', (k, a) => this.getAttr(k, a));
    D('dimx_tile', (k) => this.dimxTile(k));
    D('dimy_tile', (k) => this.dimyTile(k));
    D('start_list', (k, op) => this.startList(k, op));
    D('add_list', (s) => this.addList(s));
    D('end_list', () => this.endList());
    // slide images are not drawn: these only have to exist
    D('start_image', () => null);
    D('end_image', () => null);
    D('slide_image', () => null);
    D('vector_image', () => null);
    D('fill_image', () => null);
    D('dimx_image', () => 100);
    D('done_dialog', (st) => this.doneDialog(st));
    D('start_dialog', () => this.startDialog());
    D('term_dialog', () => this.termDialog());
    D('mac-dcl-parse', (src) => this.parseCount(src));
  }
}

/* ============================================================================================
 * 5. COMPATIBILITY EXPORTS
 * ========================================================================================== */

/** Parses DCL text. @see DclParser.parse */
export const parseDcl = DclParser.parse;

/**
 * Adds the AutoLISP dialog functions to an interpreter.
 * @param {object} L the AutoLISP interpreter
 * @param {object} app the application
 */
export function installDcl(L, app) {
  new DclLispApi(L, app).register();
}
export const _t = { R, toStr };
