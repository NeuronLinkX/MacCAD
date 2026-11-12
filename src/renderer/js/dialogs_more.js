/**
 * @file dialogs_more.js
 * @brief More windows: RENAME, VIEW, TOOLBAR, ALIASEDIT, DWGPROPS, QUICKCALC and STUDIO.
 *
 * Registers `dialogs.renameDialog`, `viewDialog`, `toolbarDialog`, `aliasEditDialog`,
 * `dwgPropsDialog`, `quickCalcDialog` and `studioDialog`; the commands call them.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import { dialogs, dialog } from './dialogs.js';
import { renameTargets } from './commands_sys.js';
import { ALIASES, COMMANDS } from './registry.js';
import { evaluate, fmtResult } from './calc.js';
import {
  MATERIALS,
  SCENES,
  SCENE_IDS,
  COLORS,
  LOOKS,
  LOOK_IDS,
  sceneThumb,
  materialSwatch,
  setScene,
  applyMaterial,
  applyPaint,
  applyLook,
} from './studio.js';

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

/** A labelled input row of a form. */
const field = (label, input) => h('div', { class: 'frow' }, h('label', {}, label), input);

/** The toolbars of the Toolbars window: [setting name, text]. */
const TOOLBAR_ITEMS = [
  ['standard', 'Standard (and Styles)'],
  ['layers', 'Layers / Properties'],
  ['draw', 'Draw'],
  ['modify', 'Modify'],
  ['dim', 'Dimension'],
  ['solids', 'Modeling / 3D'],
  ['props', 'Properties palette'],
];
/** Which toolbars are shown when nothing was saved. */
const TOOLBAR_DEFAULTS = {
  standard: true,
  layers: true,
  draw: true,
  modify: true,
  dim: true,
  solids: true,
  props: false,
};
/** The properties of the Drawing Properties window. */
const DWG_PROP_FIELDS = [
  ['title', 'Title:'],
  ['subject', 'Subject:'],
  ['author', 'Author:'],
  ['keywords', 'Keywords:'],
  ['comments', 'Comments:'],
];

/* ============================================================================================
 * 3. RENAME
 * ========================================================================================== */

/** RENAME: renames named objects (layers, blocks, text styles, ...). */
export class RenameDialog {
  /** @param {object} c command context */
  static async show(c) {
    const T = renameTargets(c.doc);
    const kinds = Object.keys(T);
    let kind = kinds[0];
    let old = null;
    const kindList = h('select', { size: 6, style: 'width:150px' });
    kinds.forEach((k) => kindList.append(h('option', { value: k }, k)));
    const nameList = h('select', { size: 6, style: 'width:220px' });
    const nw = h('input', { type: 'text', style: 'width:220px' });
    const fill = () => {
      nameList.innerHTML = '';
      T[kind].list().forEach((n) => nameList.append(h('option', { value: n }, n)));
      old = null;
      nw.value = '';
    };
    kindList.addEventListener('change', () => {
      kind = kindList.value;
      fill();
    });
    nameList.addEventListener('change', () => {
      old = nameList.value;
      nw.value = old;
    });
    kindList.value = kind;
    fill();
    const body = h(
      'div',
      { style: 'display:flex;gap:10px' },
      h('div', {}, h('div', {}, 'Named Objects'), kindList),
      h(
        'div',
        {},
        h('div', {}, 'Items'),
        nameList,
        h('div', { style: 'margin-top:6px' }, 'Rename To:'),
        nw,
      ),
    );
    await dialog({
      title: 'Rename',
      body,
      buttons: [
        { label: 'Rename To', value: 'ren' },
        { label: 'OK', value: true, primary: true },
        { label: 'Cancel', value: null },
      ],
      onButton: (v) => {
        if (v === 'ren') {
          if (!old || !nw.value.trim()) return false;
          try {
            T[kind].ren(old, nw.value.trim());
            fill();
            c.bump();
          } catch (e) {
            dialogs.alert(e.message);
          }
          return false;
        }
        return true;
      },
    });
    c.app.emit('doc');
  }
}

/* ============================================================================================
 * 4. VIEW MANAGER
 * ========================================================================================== */

/** VIEW: named views (save the current view, restore, delete). */
export class ViewManagerDialog {
  /** @param {object} c command context */
  static async show(c) {
    const doc = c.doc;
    doc.views ||= {};
    let sel = null;
    const list = h('select', { size: 8, style: 'width:300px' });
    const fill = () => {
      list.innerHTML = '';
      Object.keys(doc.views).forEach((n) => list.append(h('option', { value: n }, n)));
    };
    list.addEventListener('change', () => {
      sel = list.value;
    });
    fill();
    await dialog({
      title: 'View Manager',
      body: h('div', {}, h('div', {}, 'Named views:'), list),
      buttons: [
        { label: 'New...', value: 'new' },
        { label: 'Set Current', value: 'set' },
        { label: 'Delete', value: 'del' },
        { label: 'Close', value: true, primary: true },
      ],
      onButton: async (v) => {
        if (v === 'new') {
          const n = await dialogs.promptText({ title: 'New View', label: 'View name:' });
          if (n) {
            const av = c.app.activeView();
            doc.views[n] = { cx: av.cx, cy: av.cy, zoom: av.zoom, space: c.app.space };
            fill();
          }
          return false;
        }
        if (v === 'set') {
          const vw = doc.views[sel];
          if (vw) c.app.setZoom(vw.cx, vw.cy, vw.zoom);
          return false;
        }
        if (v === 'del') {
          delete doc.views[sel];
          fill();
          return false;
        }
        return true;
      },
    });
  }
}

/* ============================================================================================
 * 5. TOOLBARS
 * ========================================================================================== */

/** TOOLBAR: chooses which toolbars are shown. */
export class ToolbarDialog {
  /** @param {object} c command context */
  static async show(c) {
    const s = c.app.settings;
    const t = { ...TOOLBAR_DEFAULTS, ...(s.toolbars || {}) };
    const cbx = (n, label) =>
      h(
        'label',
        { style: 'display:block;margin:3px 0' },
        h('input', { type: 'checkbox', name: n, ...(t[n] ? { checked: true } : {}) }),
        ' ' + label,
      );
    const body = h(
      'div',
      { style: 'width:260px' },
      ...TOOLBAR_ITEMS.map(([n, label]) => cbx(n, label)),
    );
    const r = await dialog({
      title: 'Toolbars',
      body,
      collect: (el) =>
        Object.fromEntries(
          TOOLBAR_ITEMS.map(([n]) => [n, el.querySelector(`[name=${n}]`).checked]),
        ),
    });
    if (r) {
      c.app.set('toolbars', r);
      c.ui.toggleProps(r.props);
    }
  }
}

/* ============================================================================================
 * 6. COMMAND ALIASES
 * ========================================================================================== */

/** ALIASEDIT: the user's own command aliases. */
export class AliasEditDialog {
  /** @param {object} c command context */
  static async show(c) {
    const s = c.app.settings;
    const custom = { ...(s.aliases || {}) };
    const tbl = h('table', { class: 'tbl' });
    const render = () => {
      tbl.innerHTML = '<tr><th>Alias</th><th>Command</th><th></th></tr>';
      Object.entries(custom).forEach(([a, cmd]) =>
        tbl.append(
          h(
            'tr',
            {},
            h('td', {}, a),
            h('td', {}, cmd),
            h(
              'td',
              {},
              h(
                'a',
                {
                  href: '#',
                  onclick: (e) => {
                    e.preventDefault();
                    delete custom[a];
                    delete ALIASES[a.toLowerCase()];
                    render();
                  },
                },
                'remove',
              ),
            ),
          ),
        ),
      );
      if (!Object.keys(custom).length)
        tbl.append(
          h(
            'tr',
            {},
            h('td', { colspan: 3, style: 'color:var(--txt2)' }, 'No custom aliases defined.'),
          ),
        );
    };
    render();
    const a = h('input', { type: 'text', placeholder: 'alias', style: 'width:80px' });
    const cmd = h('input', { type: 'text', placeholder: 'COMMAND', style: 'width:140px' });
    const add = h(
      'button',
      {
        class: 'b',
        style: 'height:22px;border:1px solid var(--ctl-edge)',
        onclick: () => {
          const al = a.value.trim().toLowerCase();
          const cm = cmd.value.trim().toUpperCase();
          const real = ALIASES[cm.toLowerCase()] || cm;
          if (!al || !COMMANDS[real]) return dialogs.alert(`Unknown command "${cm}".`);
          custom[al] = real;
          ALIASES[al] = real;
          a.value = '';
          cmd.value = '';
          render();
        },
      },
      'Add',
    );
    const body = h(
      'div',
      { style: 'width:420px;max-height:50vh;overflow:auto' },
      tbl,
      h('div', { class: 'frow', style: 'margin-top:8px' }, a, cmd, add),
    );
    const r = await dialog({ title: 'Edit Command Aliases', body });
    if (r) {
      c.app.set('aliases', custom);
    }
  }
}

/* ============================================================================================
 * 7. DRAWING PROPERTIES
 * ========================================================================================== */

/** DWGPROPS: title, subject, author, keywords and comments of the drawing. */
export class DwgPropsDialog {
  /** @param {object} c command context */
  static async show(c) {
    const p = c.doc.props || (c.doc.props = {});
    const mk = (n, label, v) =>
      field(label, h('input', { type: 'text', name: n, value: v || '', style: 'width:260px' }));
    const body = h(
      'div',
      {},
      ...DWG_PROP_FIELDS.map(([n, label]) => mk(n, label, p[n])),
      h(
        'div',
        { style: 'color:var(--txt2);margin-top:6px' },
        `Entities: ${c.doc.model.length}   Layers: ${c.doc.layers.length}   Blocks: ${Object.keys(c.doc.blocks).length}`,
      ),
    );
    const r = await dialog({
      title: 'Drawing Properties',
      body,
      collect: (el) =>
        Object.fromEntries(
          DWG_PROP_FIELDS.map(([n]) => [n, el.querySelector(`[name=${n}]`).value]),
        ),
    });
    if (r) {
      Object.assign(p, r);
      c.app.emit('doc');
    }
  }
}

/* ============================================================================================
 * 8. QUICKCALC
 * ========================================================================================== */

/** QUICKCALC: a small calculator window; the command toggles it. */
export class QuickCalcWindow {
  /** The window that is open now, or null. */
  static current = null;

  /** Opens the window, or closes it when it is open already. */
  static toggle() {
    if (QuickCalcWindow.current) {
      QuickCalcWindow.current.remove();
      QuickCalcWindow.current = null;
      return;
    }
    const out = h('pre', {
      style:
        'height:160px;overflow:auto;margin:0;background:var(--panel);border:1px solid var(--ctl-edge);border-radius:6px;padding:4px;font:12px Menlo,monospace;user-select:text;-webkit-user-select:text',
    });
    const inp = h('input', {
      type: 'text',
      style:
        'width:100%;font:13px Menlo,monospace;border:1px solid var(--ctl-edge);border-radius:6px;padding:2px 4px;margin-top:4px',
      placeholder: 'e.g. 2*pi*25   sin(30)   dist([0,0],[3,4])   [1,2]+[3,4]',
    });
    const win = h('div', {
      class: 'dlg',
      style: 'position:fixed;z-index:1500;right:24px;top:90px;width:360px',
    });
    const bar = h(
      'div',
      { class: 'dt' },
      h('span', {}, 'QuickCalc'),
      h(
        'div',
        {
          class: 'x',
          onclick: () => {
            win.remove();
            QuickCalcWindow.current = null;
          },
        },
        '×',
      ),
    );
    const hist = [];
    inp.addEventListener('keydown', async (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && inp.value.trim()) {
        const ex = inp.value;
        inp.value = '';
        try {
          const v = await evaluate(ex, { vars: { ans: hist.length ? hist[hist.length - 1] : 0 } });
          hist.push(v);
          out.textContent += `${ex}\n  = ${fmtResult(v)}\n`;
        } catch (er) {
          out.textContent += `${ex}\n  ! ${er.message}\n`;
        }
        out.scrollTop = out.scrollHeight;
      }
    });
    win.append(
      bar,
      h(
        'div',
        { class: 'db' },
        out,
        inp,
        h(
          'div',
          { style: 'color:var(--txt2);margin-top:4px;font-size:11px' },
          'Functions: sin cos tan asin acos atan sqrt sqr abs log ln exp round trunc rad deg dist ang mee pld vec vec1; constants pi, e, ans; vectors [x,y,z].',
        ),
      ),
    );
    document.body.append(win);
    QuickCalcWindow.current = win;
    setTimeout(() => inp.focus(), 20);
  }
}

/* ============================================================================================
 * 9. STUDIO
 * ========================================================================================== */

/**
 * STUDIO: a floating window at the right edge (like QuickCalc) so that the model stays in view:
 * pick a scene (backdrop + floor + light) and a material; each click applies at once.
 */
export class StudioWindow {
  /** The window that is open now, or null. */
  static current = null;

  /** Opens the window, or closes it when it is open already. @param {object} c command context */
  static toggle(c) {
    if (StudioWindow.current) {
      StudioWindow.current.remove();
      StudioWindow.current = null;
      return;
    }
    new StudioWindow(c.app).open();
  }

  /** @param {object} app the application */
  constructor(app) {
    this.app = app;
    this.sceneBox = h('div', { class: 'stu-grid' });
    this.matBox = h('div', { class: 'stu-grid stu-mats' });
    this.target = h('div', { class: 'stu-note' });
    this.refreshTarget = () => this.showTarget();
  }

  /** @private Says which solids a choice goes to (the selected ones, or all). */
  showTarget() {
    if (!StudioWindow.current) return;
    const app = this.app;
    const sel = app.selectedEnts().filter((e) => e.type === 'solid3d').length;
    const all = app.solids().length;
    this.target.textContent = !all
      ? 'There are no 3D solids in this drawing.'
      : sel
        ? `A material, colour or look goes to the ${sel} selected solid(s).`
        : `Nothing is selected: it goes to all ${all} solid(s).`;
  }

  /** @private Marks the button of the scene that is in use. */
  markScene() {
    for (const b of this.sceneBox.children)
      b.classList.toggle('on', b.dataset.id === (this.app.settings.scene || 'none'));
  }

  /** @private Fills the scene grid. */
  buildScenes() {
    const app = this.app;
    for (const id of SCENE_IDS) {
      const b = h(
        'button',
        { class: 'stu-item', 'data-id': id, title: SCENES[id].label },
        sceneThumb(id),
        h('span', {}, SCENES[id].label),
      );
      b.addEventListener('click', () => {
        setScene(app, id);
        this.markScene();
      });
      this.sceneBox.append(b);
    }
  }

  /** @private Fills the material grid ("Default look" last). */
  buildMaterials() {
    const app = this.app;
    const apply = (key) => {
      app.edit(key ? `MATERIAL ${MATERIALS[key].label}` : 'MATERIAL default', () =>
        applyMaterial(app, key),
      );
      this.refreshTarget();
    };
    for (const key of Object.keys(MATERIALS)) {
      const b = h(
        'button',
        { class: 'stu-item', title: MATERIALS[key].label },
        materialSwatch(
          key,
          MATERIALS[key].coat || MATERIALS[key].glow ? [0.94, 0.4, 0.11] : undefined,
        ),
        h('span', {}, MATERIALS[key].label),
      );
      b.addEventListener('click', () => apply(key));
      this.matBox.append(b);
    }
    const none = h(
      'button',
      { class: 'stu-item', title: 'Remove the material' },
      materialSwatch(null),
      h('span', {}, 'Default look'),
    );
    none.addEventListener('click', () => apply(null));
    this.matBox.append(none);
  }

  /** @private The colours for single parts (PAINT). @returns {HTMLElement} */
  buildColors() {
    const app = this.app;
    const paint = (hex) => {
      app.edit(hex ? `PAINT ${hex}` : 'PAINT default', () => applyPaint(app, hex));
      this.refreshTarget();
    };
    const colorBox = h('div', { class: 'stu-colors' });
    for (const [name, hex] of Object.entries(COLORS)) {
      const b = h('button', { class: 'stu-sw', title: name, style: `background:${hex}` });
      b.addEventListener('click', () => paint(hex));
      colorBox.append(b);
    }
    const pick = h('input', {
      type: 'color',
      class: 'stu-pick',
      title: 'Any colour',
      value: '#f0661c',
    });
    pick.addEventListener('change', () => paint(pick.value));
    const own = h('button', { class: 'stu-sw own', title: 'Give the parts their own colour back' });
    own.addEventListener('click', () => paint(null));
    colorBox.append(pick, own);
    return colorBox;
  }

  /** @private The looks for the whole model (LOOK): finish and colour for every part, by size and layer. @returns {HTMLElement} */
  buildLooks() {
    const app = this.app;
    const lookBox = h('div', { class: 'stu-looks' });
    for (const id of LOOK_IDS) {
      const b = h(
        'button',
        { class: 'stu-look', title: LOOKS[id].note },
        h('b', {}, LOOKS[id].label),
        h('span', {}, LOOKS[id].note),
      );
      b.addEventListener('click', async () => {
        await app.editAsync(`LOOK ${LOOKS[id].label}`, () => applyLook(app, id));
        this.refreshTarget();
      });
      lookBox.append(b);
    }
    return lookBox;
  }

  /** @private A checkbox that stores a setting and redraws. @returns {HTMLInputElement} */
  settingCheckbox(key, checked) {
    const app = this.app;
    const box = h('input', { type: 'checkbox' });
    box.checked = checked;
    box.addEventListener('change', () => {
      app.settings[key] = box.checked;
      app.saveSettings();
      app.changed();
    });
    return box;
  }

  /** @private Builds the window and shows it. */
  open() {
    const app = this.app;
    this.buildScenes();
    this.buildMaterials();
    const colorBox = this.buildColors();
    const lookBox = this.buildLooks();
    const reflect = this.settingCheckbox('floorReflect', app.settings.floorReflect !== false);
    const edges = this.settingCheckbox('studioEdges', !!app.settings.studioEdges);
    const body = h(
      'div',
      { class: 'stu' },
      h('div', { class: 'stu-h' }, 'Scene'),
      this.sceneBox,
      h('div', { class: 'stu-h' }, 'Material'),
      this.matBox,
      h('div', { class: 'stu-h' }, 'Colour'),
      colorBox,
      h('div', { class: 'stu-h' }, 'Look for the whole model'),
      lookBox,
      this.target,
      h('label', { class: 'stu-edges' }, reflect, ' Mirror the model in the floor'),
      h('label', { class: 'stu-edges' }, edges, ' Show the outline (edges) of the solids'),
      h(
        'div',
        { class: 'stu-note' },
        'The scene pictures are simple drawings made by the program. Scenes and materials are shown in the Shaded visual styles; choosing one switches to Shaded.',
      ),
    );
    const win = h('div', {
      class: 'dlg',
      style:
        'position:fixed;z-index:1500;right:16px;top:80px;width:350px;max-height:calc(100vh - 150px);overflow:auto',
    });
    const close = () => {
      win.remove();
      StudioWindow.current = null;
    };
    win.append(
      h(
        'div',
        { class: 'dt' },
        h('span', {}, 'Studio'),
        h('div', { class: 'x', onclick: close }, '×'),
      ),
      h('div', { class: 'db' }, body),
    );
    win.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    });
    document.body.append(win);
    StudioWindow.current = win;
    this.markScene();
    this.refreshTarget();
    app.on('selection', this.refreshTarget);
    app.on('doc', this.refreshTarget);
  }
}

/* ============================================================================================
 * 10. REGISTRATION
 * ========================================================================================== */
dialogs.renameDialog = (c) => RenameDialog.show(c);
dialogs.viewDialog = (c) => ViewManagerDialog.show(c);
dialogs.toolbarDialog = (c) => ToolbarDialog.show(c);
dialogs.aliasEditDialog = (c) => AliasEditDialog.show(c);
dialogs.dwgPropsDialog = (c) => DwgPropsDialog.show(c);
dialogs.quickCalcDialog = async () => QuickCalcWindow.toggle();
dialogs.studioDialog = async (c) => StudioWindow.toggle(c);
