/**
 * @file dialogs_lisp.js
 * @brief AutoLISP related windows: APPLOAD, the Visual LISP editor (VLIDE) and the manual viewer.
 *
 * Registers `dialogs.appLoadDialog`, `dialogs.vlideDialog` and `dialogs.manualDialog`; the
 * commands in commands_sys.js / commands_more.js call them.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import { dialogs, dialog } from './dialogs.js';
import { parse, parenBalance, toStr } from './lisp.js';
import { DOCS } from './docs_data.js';
import { renderMarkdown } from './markdown.js';

/* ============================================================================================
 * 2. SMALL HELPERS
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

/** @returns {string} the file name part of a path. */
const baseName = (p) => String(p).split(/[\\/]/).pop();

/** Style of the framed list boxes in the APPLOAD window. */
const LIST_BOX_STYLE =
  'overflow:auto;border:1px solid var(--ctl-edge);border-radius:6px;background:var(--panel);padding:2px 4px;font-family:Menlo,monospace;font-size:11px';
/** Style of the small buttons in the APPLOAD window. */
const SMALL_BTN_STYLE = 'height:23px;border:1px solid var(--ctl-edge);margin:4px 0';
/** The editor's start text for a new session. */
const VLIDE_WELCOME =
  ';; MacCAD 2027 Visual LISP editor\n;; Load Active Edit Window runs the whole buffer; select text and use Load Selection for part of it.\n\n(defun c:hello ( / p)\n  (setq p (getpoint "\\nPick a point: "))\n  (if p\n    (progn\n      (command "_.CIRCLE" p 10.0)\n      (princ "\\nCircle created.")\n    )\n  )\n  (princ)\n)\n';
/** localStorage key that keeps the editor text between sessions. */
const VLIDE_BUFFER_KEY = 'maccad.vlide.buffer';

/* ============================================================================================
 * 3. SHARED UI PARTS
 * ========================================================================================== */

/** Pieces shared by the three windows. */
class LispUi {
  /**
   * Lets the user pick a LISP file (native dialog in the app, a file input in a browser).
   * @param {object} app the application
   * @param {object[]} [filters] file filters for the native dialog
   * @returns {Promise<{name: string, path: string, data: string, error?: string}|null>}
   */
  static async pickLisp(app, filters) {
    if (app.api)
      return app.api.openFile({
        filters: filters || [{ name: 'AutoLISP', extensions: ['lsp', 'txt'] }],
      });
    return new Promise((resolve) => {
      const i = document.createElement('input');
      i.type = 'file';
      i.accept = '.lsp,.txt,.scr';
      i.onchange = () => {
        const f = i.files[0];
        if (!f) return resolve(null);
        const r = new FileReader();
        r.onload = () => resolve({ name: f.name, path: f.name, data: r.result });
        r.readAsText(f);
      };
      i.click();
    });
  }

  /**
   * A small movable, resizable window above the drawing (not modal).
   * @param {{title: string, width: number, height: number, x: number, y: number, onClose?: Function}} o
   * @returns {{win: HTMLElement, body: HTMLElement, close: Function}}
   */
  static floatingWindow({ title, width, height, x, y, onClose }) {
    const win = h('div', {
      class: 'dlg',
      style: `position:fixed;z-index:1500;left:${x}px;top:${y}px;width:${width}px;height:${height}px;resize:both;overflow:hidden`,
    });
    const bar = h(
      'div',
      { class: 'dt', style: 'cursor:move' },
      h('span', {}, title),
      h(
        'div',
        {
          class: 'x',
          onclick: () => {
            win.remove();
            onClose && onClose();
          },
        },
        '×',
      ),
    );
    const body = h('div', {
      style: 'flex:1;display:flex;flex-direction:column;min-height:0;padding:6px;gap:4px',
    });
    win.append(bar, body);
    win.style.display = 'flex';
    win.style.flexDirection = 'column';
    let drag = null;
    bar.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('x')) return;
      drag = { dx: e.clientX - win.offsetLeft, dy: e.clientY - win.offsetTop };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (drag) {
        win.style.left = `${e.clientX - drag.dx}px`;
        win.style.top = `${Math.max(0, e.clientY - drag.dy)}px`;
      }
    });
    window.addEventListener('mouseup', () => {
      drag = null;
    });
    document.body.append(win);
    return {
      win,
      body,
      close: () => {
        win.remove();
        onClose && onClose();
      },
    };
  }
}

/* ============================================================================================
 * 4. APPLOAD
 * ========================================================================================== */

/** The Load/Unload Applications window (APPLOAD): loaded files and the startup suite. */
export class AppLoadDialog {
  /**
   * @param {object} app the application
   */
  constructor(app) {
    this.app = app;
    this.loaded = h('div', { style: `height:150px;${LIST_BOX_STYLE}` });
    this.startup = h('div', { style: `height:90px;${LIST_BOX_STYLE}` });
    this.status = h('div', { style: 'margin-top:6px;min-height:16px;color:var(--txt2)' });
  }

  /** @private Fills both lists from the application state. */
  refresh() {
    const { app, loaded, startup } = this;
    loaded.innerHTML = '';
    (app.lispLoaded || []).forEach((f) => loaded.append(h('div', {}, f)));
    if (!(app.lispLoaded || []).length)
      loaded.append(
        h('div', { style: 'color:var(--txt2)' }, 'No AutoLISP files loaded in this session.'),
      );
    startup.innerHTML = '';
    (app.settings.startupLisp || []).forEach((f, i) =>
      startup.append(
        h(
          'div',
          {},
          f,
          ' ',
          h(
            'a',
            {
              href: '#',
              onclick: (e) => {
                e.preventDefault();
                const l = [...(app.settings.startupLisp || [])];
                l.splice(i, 1);
                app.set('startupLisp', l);
                this.refresh();
              },
            },
            '[remove]',
          ),
        ),
      ),
    );
    if (!(app.settings.startupLisp || []).length)
      startup.append(
        h(
          'div',
          { style: 'color:var(--txt2)' },
          'Files listed here are loaded every time MacCAD 2027 starts.',
        ),
      );
  }

  /** @private "Load...": runs a chosen file now. */
  async loadNow() {
    const { app, status } = this;
    const f = await LispUi.pickLisp(app);
    if (!f || f.error) return;
    const name = f.path || f.name;
    await app.lisp.evalString(f.data, { source: name });
    app.lispLoaded = [...new Set([...(app.lispLoaded || []), name])];
    if (!app.api) {
      try {
        localStorage.setItem('maccad.vfs.' + f.name, f.data);
      } catch {
        /* ignore */
      }
    }
    status.textContent = `${baseName(name)} successfully loaded.`;
    this.refresh();
  }

  /** @private "Add to Startup Suite...": remembers a file to load at every start. */
  async addToStartup() {
    const { app } = this;
    const f = await LispUi.pickLisp(app);
    if (!f || f.error) return;
    const l = [...(app.settings.startupLisp || [])];
    const name = f.path || f.name;
    if (!l.includes(name)) l.push(name);
    app.set('startupLisp', l);
    this.refresh();
  }

  /** Shows the window and waits until it is closed. */
  async show() {
    const loadBtn = h(
      'button',
      { class: 'b', style: SMALL_BTN_STYLE, onclick: () => this.loadNow() },
      'Load...',
    );
    const addStart = h(
      'button',
      { class: 'b', style: SMALL_BTN_STYLE, onclick: () => this.addToStartup() },
      'Add to Startup Suite...',
    );
    this.refresh();
    const body = h(
      'div',
      { style: 'width:520px' },
      h('div', {}, 'Loaded applications:'),
      this.loaded,
      loadBtn,
      this.status,
      h('div', { style: 'margin-top:6px' }, 'Startup Suite:'),
      this.startup,
      addStart,
      h(
        'div',
        { style: 'margin-top:8px;color:var(--txt2)' },
        'Files named acad.lsp, acaddoc.lsp and startup.lsp in the support folder lisp/ are loaded automatically.',
      ),
    );
    await dialog({
      title: 'Load/Unload Applications',
      body,
      buttons: [{ label: 'Close', value: true, primary: true }],
    });
  }
}

/* ============================================================================================
 * 5. VISUAL LISP EDITOR
 * ========================================================================================== */

/** The Visual LISP editor window: one buffer, toolbar, status line, console and a one-line REPL. */
export class VlideEditor {
  /** The window that is open now (only one at a time), or null. */
  static current = null;

  /**
   * Opens the editor, or shows the one that is already open.
   * @param {object} c command context
   */
  static open(c) {
    if (VlideEditor.current) {
      VlideEditor.current.win.style.display = 'flex';
      return;
    }
    new VlideEditor(c.app);
  }

  /** @param {object} app the application */
  constructor(app) {
    this.app = app;
    this.fileName = 'Untitled.lsp';
    this.filePath = null;
    this.echoHook = (m) => this.log(m);
    const W = Math.min(960, innerWidth - 40);
    const H = Math.min(660, innerHeight - 60);
    const fw = LispUi.floatingWindow({
      title: 'Visual LISP Editor - MacCAD 2027',
      width: W,
      height: H,
      x: Math.max(10, (innerWidth - W) / 2),
      y: 40,
      onClose: () => {
        app.off && app.off('echo', this.echoHook);
        VlideEditor.current = null;
      },
    });
    VlideEditor.current = fw;
    this.build(fw);
    app.on('echo', this.echoHook);
    this.update();
    setTimeout(() => this.ed.focus(), 30);
  }

  /** @private Creates the controls and puts them into the window. */
  build(fw) {
    this.tb = h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' });
    this.ed = h('textarea', {
      spellcheck: 'false',
      style:
        'flex:1;min-height:120px;font:12px Menlo,"Courier New",monospace;tab-size:2;white-space:pre;overflow:auto;resize:none;border:1px solid var(--ctl-edge);border-radius:6px;user-select:text;-webkit-user-select:text',
    });
    this.status = h('div', { style: 'font-size:11px;color:var(--txt)' }, 'Ln 1, Col 1');
    this.con = h('pre', {
      style:
        'height:150px;margin:0;border:1px solid var(--ctl-edge);border-radius:6px;background:var(--panel);overflow:auto;padding:3px 5px;font:12px Menlo,"Courier New",monospace;user-select:text;-webkit-user-select:text',
    });
    this.repl = h('input', {
      type: 'text',
      placeholder: '_$  type an expression and press Enter',
      style:
        'width:100%;font:12px Menlo,"Courier New",monospace;border:1px solid var(--ctl-edge);border-radius:6px',
    });
    try {
      this.ed.value = localStorage.getItem(VLIDE_BUFFER_KEY) || VLIDE_WELCOME;
    } catch {
      /* ignore */
    }
    this.ed.addEventListener('input', () => this.update());
    this.ed.addEventListener('keyup', () => this.update());
    this.ed.addEventListener('click', () => this.update());
    this.ed.addEventListener('keydown', (e) => this.onKey(e));
    this.buildToolbar();
    this.repl.addEventListener('keydown', async (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && this.repl.value.trim()) {
        const v = this.repl.value;
        this.repl.value = '';
        this.log(`_$ ${v}`);
        await this.app.runLisp(v);
      }
    });
    fw.body.append(this.tb, this.ed, this.status, this.con, this.repl);
  }

  /** @private Creates a toolbar button. */
  static btn(label, fn, title) {
    return h(
      'button',
      {
        class: 'b',
        title,
        style:
          'height:22px;min-width:0;padding:0 8px;border:1px solid var(--ctl-edge);border-radius:6px;background:var(--ctl)',
        onclick: fn,
      },
      label,
    );
  }

  /** @private Fills the toolbar. */
  buildToolbar() {
    const { app, ed } = this;
    const btn = VlideEditor.btn;
    this.tb.append(
      btn('New', () => {
        ed.value = '';
        this.fileName = 'Untitled.lsp';
        this.filePath = null;
        this.update();
      }),
      btn('Open...', async () => {
        const f = await LispUi.pickLisp(app);
        if (f && !f.error) {
          ed.value = f.data;
          this.fileName = baseName(f.path || f.name);
          this.filePath = f.path || null;
          this.update();
        }
      }),
      btn('Save', () => this.save(false)),
      btn('Save As...', () => this.save(true)),
      h('span', { style: 'width:8px' }),
      btn(
        'Load Active Edit Window',
        () => this.run(ed.value),
        'Evaluate the whole buffer (like Tools > Load Text in Editor)',
      ),
      btn('Load Selection', () => {
        const sel = ed.value.slice(ed.selectionStart, ed.selectionEnd);
        if (sel.trim()) this.run(sel);
        else this.log('; select some text first');
      }),
      btn('Check Syntax', () => this.check()),
      btn('Clear Console', () => {
        this.con.textContent = '';
      }),
      btn('Manual', () => dialogs.manualDialog('guide')),
    );
  }

  /** @private Writes a line into the console. */
  log(t) {
    this.con.textContent += t + '\n';
    this.con.scrollTop = this.con.scrollHeight;
  }

  /** @private Refreshes the status line and keeps the buffer for the next session. */
  update() {
    const { ed } = this;
    const pre = ed.value.slice(0, ed.selectionStart);
    const ln = pre.split('\n').length;
    const col = pre.length - pre.lastIndexOf('\n');
    const bal = parenBalance(ed.value);
    this.status.textContent = `${this.fileName}   Ln ${ln}, Col ${col}   ${bal === 0 ? 'Parentheses balanced' : bal > 0 ? `${bal} unclosed "("` : `${-bal} extra ")"`}`;
    try {
      localStorage.setItem(VLIDE_BUFFER_KEY, ed.value);
    } catch {
      /* ignore */
    }
  }

  /** @private Tab inserts two spaces; Enter indents to the nesting depth. */
  onKey(e) {
    const { ed } = this;
    e.stopPropagation();
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ed.selectionStart;
      ed.setRangeText('  ', s, ed.selectionEnd, 'end');
      this.update();
    }
    if (e.key === 'Enter') {
      // auto-indent to the current nesting depth
      e.preventDefault();
      const s = ed.selectionStart;
      const before = ed.value.slice(0, s);
      const line = before.slice(before.lastIndexOf('\n') + 1);
      let depth = 0;
      for (const ch of before) {
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
      }
      const lead = /^\s*/.exec(line)[0];
      const ind =
        depth > 0
          ? Math.max(lead.length, 0) +
            (/\(\s*[^\s()]+\s*$/.test(line) || /\($/.test(line.trim()) ? 2 : 0)
          : 0;
      ed.setRangeText('\n' + ' '.repeat(ind), s, ed.selectionEnd, 'end');
      this.update();
    }
  }

  /** @private Saves the buffer (native dialog in the app, a download in a browser). */
  async save(asNew) {
    const { app, ed } = this;
    if (app.api) {
      const p = await app.api.saveFile({
        path: asNew ? null : this.filePath,
        defaultName: this.fileName,
        data: ed.value,
        filters: [{ name: 'AutoLISP', extensions: ['lsp'] }],
      });
      if (p) {
        this.filePath = p;
        this.fileName = baseName(p);
        if (!asNew) this.log(`; saved ${p}`);
        this.update();
      }
    } else if (!asNew) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([ed.value], { type: 'text/plain' }));
      a.download = this.fileName;
      a.click();
    }
  }

  /** @private Checks the parentheses and the syntax of the buffer. @returns {boolean} true when it is fine. */
  check() {
    const bal = parenBalance(this.ed.value);
    if (bal !== 0) {
      this.log(`; check: ${bal > 0 ? bal + ' unclosed "("' : -bal + ' extra ")"'}`);
      return false;
    }
    try {
      const f = parse(this.ed.value);
      this.log(`; check: OK, ${f.length} top-level form(s)`);
      return true;
    } catch (e) {
      this.log(`; check failed: ${e.lispMessage || e.message}`);
      return false;
    }
  }

  /** @private Checks, then evaluates the given source. */
  async run(src) {
    if (!this.check()) return;
    await this.app.runLisp(src);
  }
}

/* ============================================================================================
 * 6. MANUAL VIEWER
 * ========================================================================================== */

/** The manual window with a topic list. */
export class ManualDialog {
  /**
   * @param {string} [key] the topic to show first (a key of DOCS)
   * @returns {Promise<unknown>} resolves when the window is closed
   */
  static show(key = 'guide') {
    const doc = DOCS[key] || DOCS.guide;
    const box = h('div', {
      class: 'manual',
      style:
        'width:min(900px,86vw);height:min(70vh,640px);overflow:auto;padding:4px 14px;background:var(--panel);border:1px solid var(--ctl-edge);border-radius:6px;user-select:text;-webkit-user-select:text;line-height:1.55;font:13px/1.55 -apple-system,"Helvetica Neue","Apple SD Gothic Neo",sans-serif',
    });
    box.innerHTML = renderMarkdown(doc.text);
    const sel = h('select', { style: 'margin-bottom:6px' });
    for (const [k, d] of Object.entries(DOCS)) sel.append(h('option', { value: k }, d.title));
    sel.value = key;
    sel.addEventListener('change', () => {
      box.innerHTML = renderMarkdown(DOCS[sel.value].text);
      box.scrollTop = 0;
    });
    return dialog({
      title: 'MacCAD 2027 Manual',
      body: h('div', {}, sel, box),
      buttons: [{ label: 'Close', value: true, primary: true }],
    });
  }
}

/* ============================================================================================
 * 7. REGISTRATION
 * ========================================================================================== */
dialogs.appLoadDialog = (c) => new AppLoadDialog(c.app).show();
dialogs.vlideDialog = (c) => VlideEditor.open(c);
dialogs.manualDialog = (key = 'guide') => ManualDialog.show(key);
export const _x = toStr;
