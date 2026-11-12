/**
 * @file dialogs.js
 * @brief Pop-up menus and the modal dialogs of the program (XP-classic look).
 *
 * `DialogHost` shows pop-up menus and modal dialogs; `StandardDialogs` holds the windows that
 * commands open (colour, layers, linetypes, units, drafting settings, text and dimension styles,
 * hatch, array, insert, plot, ...). Each of them is also registered in the shared object `dialogs`,
 * which commands reach as `c.ui.<name>`.
 */

/* ============================================================================================
 * 1. INCLUDES AND HELPERS
 * ========================================================================================== */
import { openSettings } from './settings.js';
import { ICONS } from './icons.js';
import { aciHex, colorName, LINEWEIGHTS, LINETYPES, newLayout } from './doc.js';
import * as E from './entities.js';
import { OSNAP_MODES } from './snap.js';
import { toSVG } from './svg.js';
import { defaultUnits } from './units.js';
import { HELP_SHORTCUTS } from './helpdata.js';
import { FONT_CHOICES, fontStack } from './fonts.js';
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
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
// ------------------------------------------------------------------ popup menus
const closers = [];
const field = (label, input) => h('div', { class: 'frow' }, h('label', {}, label), input);
const num = (name, v, extra = {}) =>
  h('input', { type: 'number', name, value: v, step: 'any', ...extra });
const sel = (name, opts, v) => {
  const s = h('select', { name });
  for (const o of opts) {
    const [val, lab] = Array.isArray(o) ? o : [o, o];
    s.append(h('option', { value: val }, lab));
  }
  s.value = v;
  return s;
};
const q = (el, n) => el.querySelector(`[name="${n}"]`);
const swatchHex = (c) =>
  c == null ? '#fff' : c === 'bb' ? '#fff' : c === 7 ? '#ffffff' : aciHex(c);
// ------------------------------------------------------------------ the dialog set
export const dialogs = {};
// MacBook key notation for hints: Windows "Ctrl" means Command here (Ctrl+Z -> ⌘Z), Shift/Alt become ⇧/⌥ and are written before the key in the Mac order ⌃⌥⇧⌘,
// Delete is the ⌫ key, and function keys need the Fn key (Fn+F3 ...)
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
// ---- linetype scale (LTS): the spacing of the dashes of every dashed linetype (centre, hidden, ...)
// whole drawing = LTSCALE, selected objects = their own "Linetype scale"; the dash length of an object is the product of both
const LT_STEPS = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
// ---- drafting settings (AutoCAD layout: Snap and Grid / Polar Tracking / Object Snap / 3D Object Snap / Dynamic Input)
const OS_ICON = (() => {
  const g = (inner) =>
    `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="#a37d00" stroke-width="1.5" stroke-linejoin="miter">${inner}</svg>`;
  return {
    end: g('<rect x="4" y="4" width="12" height="12"/>'),
    mid: g('<path d="M3 16h14L10 4z"/>'),
    cen: g('<circle cx="10" cy="10" r="6.5"/>'),
    gcen: g('<circle cx="10" cy="10" r="6.5"/><path d="M3.5 10h13M10 3.5v13"/>'),
    nod: g('<circle cx="10" cy="10" r="5"/><path d="M5 5l10 10M15 5L5 15"/>'),
    qua: g('<path d="M10 3l7 7-7 7-7-7z"/>'),
    int: g('<path d="M4 4l12 12M16 4L4 16"/>'),
    ext: g('<path d="M2 10h3M8.5 10h3M15 10h3"/>'),
    ins: g('<rect x="3" y="3" width="8" height="8"/><rect x="9" y="9" width="8" height="8"/>'),
    per: g('<path d="M4 4v12h12M4 10h6v6"/>'),
    tan: g('<circle cx="10" cy="11.5" r="5"/><path d="M3 5h14"/>'),
    nea: g('<path d="M4 4h12L4 16h12z"/>'),
    app: g('<rect x="3" y="3" width="14" height="14"/><path d="M5 5l10 10M15 5L5 15"/>'),
    par: g('<path d="M3 13L12 4M8 17L17 8"/>'),
  };
})();
// ---- plot / page setup
export const PAPER = [
  ['ISO A4 (210 x 297 mm)', 210, 297],
  ['ISO A3 (297 x 420 mm)', 297, 420],
  ['ISO A2 (420 x 594 mm)', 420, 594],
  ['ISO A1 (594 x 841 mm)', 594, 841],
  ['ISO A0 (841 x 1189 mm)', 841, 1189],
  ['Letter (215.9 x 279.4 mm)', 215.9, 279.4],
  ['Legal (215.9 x 355.6 mm)', 215.9, 355.6],
  ['Tabloid (279.4 x 431.8 mm)', 279.4, 431.8],
  ['ANSI C (431.8 x 558.8 mm)', 431.8, 558.8],
  ['ANSI D (558.8 x 863.6 mm)', 558.8, 863.6],
];
export const _ = { defaultUnits, LINETYPES };

/* ============================================================================================
 * 2. DIALOGHOST
 * ========================================================================================== */

/** Shows pop-up menus and modal dialogs. */
export class DialogHost {
  /** Closes every open pop-up menu. */
  static closeAll() {
    document.querySelectorAll('.popup').forEach((p) => p.remove());
    while (closers.length) closers.pop()();
  }

  /** Shows a pop-up menu at a screen position. Items: {label, run | cmd, check?, sub?, key?, disabled?} or {sep: true}. */
  static popupMenu(items, x, y, opts = {}) {
    DialogHost.closeAll();
    if (opts.onClose) closers.push(opts.onClose);
    const build = (list, px, py, parentEl) => {
      const el = h('div', { class: 'popup' });
      el.dataset.level = parentEl ? parentEl.dataset.level * 1 + 1 : 0;
      for (const it of list) {
        if (it.sep) {
          el.append(h('div', { class: 'sep' }));
          continue;
        }
        const row = h('div', {
          class: 'it' + (it.disabled ? ' dis' : '') + (it.check && it.check() ? ' chk' : ''),
        });
        row.append(
          h('span', { class: 'ic', html: it.icon ? ICONS[it.icon] || '' : '' }),
          it.swatch ? h('i', { class: 'swatch', style: `background:${it.swatch}` }) : '',
          h('span', {}, it.label),
        );
        if (it.key) row.append(h('span', { class: 'sc' }, KeyNotation.format(it.key)));
        if (it.sub) row.append(h('span', { class: 'ar' }, '►'));
        row.addEventListener('mouseenter', () => {
          el.querySelectorAll(':scope ~ .popup').forEach((p) => {
            if (+p.dataset.level > +el.dataset.level) p.remove();
          });
          document.querySelectorAll('.popup').forEach((p) => {
            if (+p.dataset.level > +el.dataset.level) p.remove();
          });
          if (it.sub && !it.disabled) {
            const r = row.getBoundingClientRect();
            build(it.sub, r.right - 2, r.top - 3, el);
          }
        });
        row.addEventListener('mousedown', (e) => e.preventDefault());
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          if (it.disabled || it.sub) return;
          DialogHost.closeAll();
          if (opts.run) opts.run(it);
        });
        el.append(row);
      }
      document.body.append(el);
      const r = el.getBoundingClientRect();
      el.style.left = `${Math.max(0, Math.min(px, innerWidth - r.width - 2))}px`;
      el.style.top = `${Math.max(0, Math.min(py, innerHeight - r.height - 2))}px`;
      return el;
    };
    build(items, x, y, null);
  }

  // ------------------------------------------------------------------ modal dialog
  /** Shows a modal dialog and waits until a button is pressed. @returns {Promise<*>} the value of the button (or the collected values) */
  static show({ title, body, buttons, width, onOpen, collect, onButton }) {
    return new Promise((resolve) => {
      buttons = buttons || [
        { label: 'OK', value: true, primary: true },
        { label: 'Cancel', value: null },
      ];
      const bg = h('div', { class: 'modal-bg' });
      const box = h('div', { class: 'dlg', style: width ? `width:${width}px` : '' });
      const done = (val) => {
        bg.remove();
        resolve(val);
      };
      const x = h('div', { class: 'x', onclick: () => done(null) }, '×');
      box.append(
        h('div', { class: 'dt' }, h('span', {}, title), x),
        h('div', { class: 'db' }, body),
      );
      const foot = h('div', { class: 'df' });
      for (const b of buttons) {
        const btn = h('button', { class: 'b' + (b.primary ? ' primary' : '') }, b.label);
        btn.addEventListener('click', async () => {
          if (onButton) {
            const keep = await onButton(b.value, box);
            if (keep === false) return;
          }
          done(
            b.value === null || b.value === false
              ? null
              : collect
                ? collect(box, b.value)
                : b.value,
          );
        });
        foot.append(btn);
        btn.dataset.val = String(b.value);
      }
      box.append(foot);
      bg.append(box);
      document.body.append(bg);
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          done(null);
        }
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
          e.preventDefault();
          e.stopPropagation();
          foot.querySelector('.primary')?.click();
        }
      });
      bg.addEventListener('mousedown', (e) => e.stopPropagation());
      if (onOpen) onOpen(box);
      const first = box.querySelector('input,select,textarea');
      if (first) first.focus();
    });
  }
}

/* ============================================================================================
 * 3. KEYNOTATION
 * ========================================================================================== */

/** Key hints in the Mac notation. */
export class KeyNotation {
  /** Rewrites key hints for the Mac: Ctrl becomes the Command sign, Shift / Alt become their signs before the key, Del becomes the delete sign. */
  static format(t) {
    if (!IS_MAC) return String(t);
    return String(t)
      .replace(/\b((?:(?:Ctrl|Cmd|Shift|Alt|Opt|Option)\+)+)([^\s+,()|]+|\+)/g, (m, mods, key) => {
        const has = (re) => re.test(mods);
        return (
          (has(/Alt|Opt/i) ? '⌥' : '') +
          (has(/Shift/i) ? '⇧' : '') +
          (has(/Ctrl|Cmd/i) ? '⌘' : '') +
          (/^[a-z]$/.test(key) ? key.toUpperCase() : key)
        );
      })
      .replace(/\bDel\b/g, '⌫')
      .replace(/\bF(1[0-2]|[1-9])\b/g, (m, n, off, str) =>
        str.slice(Math.max(0, off - 3), off) === 'Fn+' ? m : `Fn+F${n}`,
      );
  }
}

/* ============================================================================================
 * 4. STANDARDDIALOGS
 * ========================================================================================== */

/** The standard windows. Each is a static method; `register()` puts them into the shared `dialogs` object. */
export class StandardDialogs {
  // A small "type a name" dialog. window.prompt() is NOT supported in Electron (it throws "prompt() is not supported."), so every place that asks for a name uses this.
  /** A small "type a name" dialog. window.prompt() is NOT supported in Electron, so every place that asks for a name uses this. */
  static async promptText({ title = 'MacCAD', label = 'Name:', value = '' } = {}) {
    const r = await DialogHost.show({
      title,
      body: h(
        'div',
        { style: 'width:340px' },
        field(label, h('input', { type: 'text', name: 'text', value, style: 'width:200px' })),
      ),
      onOpen: (box) => {
        const i = box.querySelector('input');
        if (i) i.select();
      },
      collect: (el) => ({ v: q(el, 'text').value.trim() }),
    });
    return r && r.v ? r.v : null;
  }

  /** A question with buttons (default Yes / No / Cancel). @returns {Promise<string|null>} the label of the pressed button */
  static async confirm({ title = 'MacCAD', message, buttons = ['Yes', 'No', 'Cancel'] }) {
    if (window.api && window.api.message) {
      // native macOS message sheet
      const save = /^Save changes/.test(message);
      const labels = save ? ['Save', "Don't Save", 'Cancel'] : buttons;
      const ci = labels.indexOf('Cancel');
      const i = await window.api.message({
        message,
        buttons: labels,
        defaultId: 0,
        cancelId: ci >= 0 ? ci : labels.length - 1,
        type: 'question',
        title,
      });
      return buttons[i] ?? 'Cancel';
    }
    return dialogs.confirmHtml({ title, message, buttons });
  }

  // ---- colour
  /** The Select Color window (index colours, ByLayer, ByBlock, true colour). */
  static colorDialog(cur) {
    let val = cur;
    const pal = h('div', { class: 'palette' });
    const info = h('div', { style: 'margin:6px 0' });
    const hex = h('input', {
      type: 'text',
      name: 'hex',
      value: typeof cur === 'string' && cur[0] === '#' ? cur : '',
      placeholder: '#rrggbb',
      style: 'width:90px',
    });
    const show = () => {
      pal
        .querySelectorAll('i')
        .forEach((i) => i.classList.toggle('sel', String(val) === i.dataset.c));
      info.innerHTML = `<span class="swatch" style="background:${swatchHex(val)};width:18px;height:18px"></span> ${esc(colorName(val))}`;
    };
    for (let n = 1; n <= 255; n += 1) {
      const i = h('i', { style: `background:${aciHex(n)}`, 'data-c': n, title: `Index ${n}` });
      i.addEventListener('click', () => {
        val = n;
        show();
      });
      i.addEventListener('dblclick', () => {
        val = n;
        document.querySelector('.dlg .primary').click();
      });
      pal.append(i);
    }
    const std = h('div', { style: 'display:flex;gap:4px;margin:6px 0' });
    for (const [t, v] of [
      ['ByLayer', null],
      ['ByBlock', 'bb'],
      ['Red', 1],
      ['Yellow', 2],
      ['Green', 3],
      ['Cyan', 4],
      ['Blue', 5],
      ['Magenta', 6],
      ['White', 7],
    ])
      std.append(
        h(
          'button',
          {
            class: 'b',
            style:
              'min-width:54px;height:21px;border:1px solid var(--ctl-edge);background:var(--ctl)',
            onclick: () => {
              val = v;
              show();
            },
          },
          t,
        ),
      );
    const body = h(
      'div',
      { style: 'width:420px' },
      h('div', {}, 'Index Color:'),
      pal,
      std,
      info,
      h(
        'div',
        { class: 'frow' },
        h('label', { style: 'min-width:70px' }, 'True color:'),
        hex,
        h(
          'button',
          {
            class: 'b',
            style: 'height:21px',
            onclick: () => {
              if (/^#[0-9a-f]{6}$/i.test(hex.value)) {
                val = hex.value.toLowerCase();
                show();
              }
            },
          },
          'Apply',
        ),
      ),
    );
    show();
    return DialogHost.show({ title: 'Select Color', body, collect: () => ({ v: val }) }).then(
      (r) => (r ? r.v : undefined),
    );
  }

  // ---- layers
  /** The Layer Properties Manager. */
  static async layerManager(c) {
    const doc = c.doc;
    let selIdx = Math.max(
      0,
      doc.layers.findIndex((l) => l.name === doc.cur.layer),
    );
    const tbl = h('table', { class: 'tbl' });
    const render = () => {
      tbl.innerHTML =
        '<tr><th>Cur</th><th style="min-width:130px">Name</th><th>On</th><th>Freeze</th><th>Lock</th><th>Color</th><th>Linetype</th><th>Lineweight</th><th>Plot</th></tr>';
      doc.layers.forEach((l, i) => {
        const tr = h('tr', { class: i === selIdx ? 'sel' : '' });
        const cb = (prop, on) => {
          const b = h('input', { type: 'checkbox' });
          b.checked = on;
          b.addEventListener('change', () => {
            l[prop] = prop === 'on' || prop === 'plot' ? b.checked : b.checked;
          });
          return b;
        };
        const nameTd = h('td', {}, l.name);
        nameTd.addEventListener('dblclick', async () => {
          const n = await dialogs.promptText({
            title: 'Rename Layer',
            label: 'Layer name:',
            value: l.name,
          });
          if (n && !doc.hasLayer(n) && l.name !== '0') {
            doc.model.concat(...Object.values(doc.layouts).map((x) => x.ents)).forEach((e) => {
              if (e.layer === l.name) e.layer = n;
            });
            if (doc.cur.layer === l.name) doc.cur.layer = n;
            l.name = n;
            render();
          }
        });
        const colTd = h(
          'td',
          { style: 'cursor:pointer' },
          h('span', { class: 'swatch', style: `background:${swatchHex(l.color)}` }),
          colorName(l.color),
        );
        colTd.addEventListener('click', async () => {
          const r = await dialogs.colorDialog(l.color);
          if (r !== undefined && r !== null && r !== 'bb') {
            l.color = r;
            render();
          }
        });
        const ltSel = sel('lt', Object.keys(doc.ltypes), l.ltype);
        ltSel.addEventListener('change', () => {
          l.ltype = ltSel.value;
        });
        const lwSel = sel(
          'lw',
          LINEWEIGHTS.map((w) => [w, `${w.toFixed(2)} mm`]),
          l.lw,
        );
        lwSel.addEventListener('change', () => {
          l.lw = parseFloat(lwSel.value);
        });
        tr.append(
          h('td', {}, i === doc.layers.findIndex((x) => x.name === doc.cur.layer) ? '✔' : ''),
          nameTd,
          h('td', {}, cb('on', l.on)),
          h('td', {}, cb('frozen', l.frozen)),
          h('td', {}, cb('locked', l.locked)),
          colTd,
          h('td', {}, ltSel),
          h('td', {}, lwSel),
          h('td', {}, cb('plot', l.plot !== false)),
        );
        tr.addEventListener('click', (e) => {
          if (e.target.tagName === 'TD' || e.target.tagName === 'TR') {
            selIdx = i;
            render();
          }
        });
        tbl.append(tr);
      });
    };
    render();
    const body = h('div', { style: 'width:760px;max-height:60vh;overflow:auto' }, tbl);
    await DialogHost.show({
      title: 'Layer Properties Manager',
      body,
      width: 790,
      buttons: [
        { label: 'New Layer', value: 'new' },
        { label: 'Delete Layer', value: 'del' },
        { label: 'Current', value: 'cur' },
        { label: 'OK', value: true, primary: true },
        { label: 'Cancel', value: null },
      ],
      onButton: (v) => {
        if (v === 'new') {
          let n = 1;
          while (doc.hasLayer(`Layer${n}`)) n += 1;
          doc.addLayer(`Layer${n}`);
          selIdx = doc.layers.length - 1;
          render();
          return false;
        }
        if (v === 'del') {
          const l = doc.layers[selIdx];
          if (!l || l.name === '0' || l.name === doc.cur.layer) {
            dialogs.alert('Layer 0 and the current layer cannot be deleted.');
            return false;
          }
          const used =
            doc.model.some((e) => e.layer === l.name) ||
            Object.values(doc.layouts).some((x) => x.ents.some((e) => e.layer === l.name));
          if (used) {
            dialogs.alert(`Layer "${l.name}" is in use and cannot be deleted.`);
            return false;
          }
          doc.layers.splice(selIdx, 1);
          selIdx = Math.max(0, selIdx - 1);
          render();
          return false;
        }
        if (v === 'cur') {
          const l = doc.layers[selIdx];
          if (l && l.on && !l.frozen) {
            doc.cur.layer = l.name;
            render();
          }
          return false;
        }
        return true;
      },
    });
    c.bump();
  }

  // ---- linetype
  /** The Linetype Manager. */
  static async linetypeDialog(c) {
    const doc = c.doc;
    let cur = doc.cur.ltype || 'bylayer';
    const tbl = h('table', { class: 'tbl' });
    const render = () => {
      tbl.innerHTML = '<tr><th>Linetype</th><th>Appearance</th><th>Description</th></tr>';
      const rows = [
        ['bylayer', 'ByLayer'],
        ['bb', 'ByBlock'],
        ...Object.keys(doc.ltypes).map((n) => [n, n]),
      ];
      for (const [k, label] of rows) {
        const pat = doc.ltypes[k] || [];
        const dash = pat.map((v) => (v === 0 ? 1 : Math.abs(v) * 0.9)).join(' ');
        const tr = h(
          'tr',
          { class: cur === k ? 'sel' : '' },
          h('td', {}, label),
          h('td', {
            html: `<svg width="150" height="12"><line x1="0" y1="6" x2="150" y2="6" stroke="${cur === k ? '#fff' : '#000'}" stroke-width="2" stroke-dasharray="${dash}"/></svg>`,
          }),
          h('td', {}, k === 'bylayer' || k === 'bb' ? '' : k),
        );
        tr.addEventListener('click', () => {
          cur = k;
          render();
        });
        tbl.append(tr);
      }
    };
    render();
    const scale = num('ltscale', doc.ltscale, { min: 0.0001 });
    const body = h(
      'div',
      { style: 'width:460px;max-height:55vh;overflow:auto' },
      tbl,
      h(
        'div',
        { class: 'frow', style: 'margin-top:8px' },
        h('label', {}, 'Global scale factor:'),
        scale,
      ),
    );
    const r = await DialogHost.show({
      title: 'Linetype Manager',
      body,
      collect: () => ({ scale: parseFloat(scale.value) }),
    });
    if (r) {
      doc.cur.ltype = cur === 'bylayer' ? null : cur;
      if (r.scale > 0) doc.ltscale = r.scale;
      c.bump();
      c.app.emit('doc');
    }
  }

  /** LTSCALE options: whole drawing, selected objects, with a preview. */
  static async ltscaleDialog(c) {
    const doc = c.doc;
    const app = c.app;
    const sel = app.selectedEnts();
    const orig = { g: doc.ltscale, objs: sel.map((e) => [e, e.ltscale]) };
    // a scale that suits the drawing: the long dash of a centre line (31.75 x scale) about 1/8 of the drawing's larger side, on the 1-2-5 series
    let ext = null;
    for (const e of app.curEnts())
      if (doc.visible(e) && e.type !== 'viewport') ext = E.bboxMerge(ext, E.bbox(e, doc));
    const side = ext ? Math.max(ext.x1 - ext.x0, ext.y1 - ext.y0) : 0;
    const ideal = side > 0 ? side / 8 / 31.75 : 1;
    const suggested = LT_STEPS.reduce(
      (b, v) => (Math.abs(Math.log(v / ideal)) < Math.abs(Math.log(b / ideal)) ? v : b),
      1,
    );
    const zoom = () => (app.v3 ? app.v3.zoom : app.view.zoom);
    const gIn = num('g', doc.ltscale, { min: 0.0001, style: 'width:90px' });
    const oIn = num(
      'o',
      sel.length ? (sel.every((e) => e.ltscale === sel[0].ltscale) ? sel[0].ltscale || 1 : '') : '',
      {
        min: 0.0001,
        style: 'width:90px',
        placeholder: sel.length ? 'varies' : '',
        disabled: !sel.length,
      },
    );
    const prev = h('div', { style: 'margin-top:6px' });
    const gVal = () => {
      const v = parseFloat(gIn.value);
      return v > 0 ? v : doc.ltscale;
    };
    const oVal = () => {
      const v = parseFloat(oIn.value);
      return v > 0 ? v : null;
    };
    const drawPreview = () => {
      const sc = gVal() * (oVal() || 1);
      const z = zoom();
      const W = 300;
      let svg = `<svg width="${W + 90}" height="${5 * 20 + 4}" style="display:block">`;
      ['CENTER', 'HIDDEN', 'DASHED', 'PHANTOM', 'DASHDOT'].forEach((n, i) => {
        const pat = doc.ltypes[n] || [];
        const y = 12 + i * 20;
        const period = pat.reduce((t, x) => t + Math.abs(x), 0) * sc * z;
        const arr =
          period < 3
            ? ''
            : pat
                .map((x) => (x === 0 ? 1.2 : Math.max(Math.abs(x) * sc * z, x < 0 ? 0.5 : 1)))
                .join(' ');
        svg += `<text x="0" y="${y + 4}" font-size="11" fill="currentColor">${n}</text><line x1="80" y1="${y}" x2="${80 + W}" y2="${y}" stroke="#d33" stroke-width="1.6" ${arr ? `stroke-dasharray="${arr}"` : ''}/>`;
      });
      prev.innerHTML = svg + '</svg>';
    };
    const live = () => {
      doc.ltscale = gVal();
      const o = oVal();
      if (o) for (const e of sel) e.ltscale = o;
      drawPreview();
      c.bump();
    };
    gIn.addEventListener('input', live);
    oIn.addEventListener('input', live);
    const chip = (v) =>
      h(
        'button',
        {
          type: 'button',
          class: 'b',
          style: 'padding:1px 7px;margin:0 2px 3px 0;min-width:0',
          onclick: () => {
            gIn.value = v;
            live();
          },
        },
        String(v),
      );
    const chips = h('div', {}, ...[0.1, 0.25, 0.5, 1, 2, 5, 10, 50, 100].map(chip));
    const note = (t) => h('div', { style: 'color:var(--txt2);font-size:11px;margin:2px 0 6px' }, t);
    const body = h(
      'div',
      { style: 'width:470px' },
      h(
        'fieldset',
        {},
        h('legend', {}, 'Whole drawing  (LTSCALE)'),
        field('Scale factor:', gIn),
        chips,
        h(
          'div',
          { style: 'margin:2px 0' },
          `Suggested for this drawing: `,
          h('b', {}, String(suggested)),
          ' ',
          h(
            'button',
            {
              type: 'button',
              class: 'b',
              style: 'padding:1px 8px;min-width:0',
              onclick: () => {
                gIn.value = suggested;
                live();
              },
            },
            'Use',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'b',
              style: 'padding:1px 8px;min-width:0;margin-left:6px',
              onclick: () => {
                gIn.value = +(gVal() / 2).toPrecision(4);
                live();
              },
            },
            '\u00f7 2',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'b',
              style: 'padding:1px 8px;min-width:0;margin-left:4px',
              onclick: () => {
                gIn.value = +(gVal() * 2).toPrecision(4);
                live();
              },
            },
            '\u00d7 2',
          ),
        ),
        note(
          'Larger = longer dashes and gaps. If a centre line looks solid or has no gaps, make the scale smaller.',
        ),
      ),
      h(
        'fieldset',
        {},
        h('legend', {}, sel.length ? `Selected objects (${sel.length})` : 'Selected objects'),
        field('Object scale:', oIn),
        note(
          sel.length
            ? 'Only these objects change. The spacing on screen and in the plot = drawing scale x object scale.'
            : 'Select objects first (or use the Properties palette) to give single lines, for example the centre line of a small hole, their own scale.',
        ),
      ),
      h('fieldset', {}, h('legend', {}, 'Preview at the current zoom'), prev),
    );
    drawPreview();
    const r = await DialogHost.show({ title: 'Linetype Scale (LTS)', body, collect: () => true });
    if (!r) {
      doc.ltscale = orig.g;
      for (const [e, v] of orig.objs) e.ltscale = v;
      c.bump();
      return;
    }
    c.echo(
      `Linetype scale = ${doc.ltscale}${sel.length && oVal() ? `, ${sel.length} object(s) at ${oVal()}` : ''}`,
    );
  }

  // ---- units
  /** The Drawing Units window. */
  static async unitsDialog(c) {
    const u = c.doc.units;
    const body = h(
      'div',
      { style: 'width:340px' },
      h(
        'fieldset',
        {},
        h('legend', {}, 'Length'),
        field(
          'Type:',
          sel(
            'type',
            [
              ['decimal', 'Decimal'],
              ['engineering', 'Engineering'],
              ['architectural', 'Architectural'],
              ['fractional', 'Fractional'],
              ['scientific', 'Scientific'],
            ],
            u.type,
          ),
        ),
        field('Precision:', sel('prec', [0, 1, 2, 3, 4, 5, 6, 7, 8], u.prec)),
      ),
      h(
        'fieldset',
        {},
        h('legend', {}, 'Angle'),
        field(
          'Type:',
          sel(
            'angType',
            [
              ['deg', 'Decimal Degrees'],
              ['dms', 'Deg/Min/Sec'],
              ['grad', 'Grads'],
              ['rad', 'Radians'],
            ],
            u.angType,
          ),
        ),
        field('Precision:', sel('aprec', [0, 1, 2, 3, 4, 5, 6, 7, 8], u.aprec)),
      ),
      h(
        'div',
        { style: 'color:var(--txt2)' },
        'Architectural and engineering units treat one drawing unit as one inch.',
      ),
    );
    const r = await DialogHost.show({
      title: 'Drawing Units',
      body,
      collect: (el) => ({
        type: q(el, 'type').value,
        prec: +q(el, 'prec').value,
        angType: q(el, 'angType').value,
        aprec: +q(el, 'aprec').value,
      }),
    });
    if (r) {
      Object.assign(c.doc.units, r);
      c.bump();
    }
  }

  /** The Drafting Settings window (snap and grid, polar tracking, object snap, dynamic input). @param {number} [startTab] */
  static async draftingDialog(c, startTab = 0) {
    const s = c.app.settings;
    const tabsEl = h('div', { class: 'tabs' });
    const pane = h('div', { class: 'tabpane dsPane' });
    const names = [
      'Snap and Grid',
      'Polar Tracking',
      'Object Snap',
      '3D Object Snap',
      'Dynamic Input',
    ];
    const cbx = (n, label, on, extra = {}) =>
      h(
        'label',
        { class: 'chk' },
        h('input', { type: 'checkbox', name: n, ...(on ? { checked: true } : {}), ...extra }),
        ' ' + label,
      );
    const os3 = { vertex: true, edgeMid: true, ...(s.osnap3d || {}) };
    const modeRow = ([k, l]) =>
      h(
        'label',
        { class: 'osrow' },
        h('span', { class: 'osico', html: OS_ICON[k] }),
        h('input', {
          type: 'checkbox',
          name: `os_${k}`,
          ...(s.osnapModes.includes(k) ? { checked: true } : {}),
        }),
        h('span', {}, l),
      );
    const left = OSNAP_MODES.slice(0, 7);
    const right = OSNAP_MODES.slice(7);
    const setAll = (el, on) =>
      el
        .closest('.tabpane, .dsPane')
        .querySelectorAll('input[name^=os_]')
        .forEach((i) => {
          i.checked = on;
        });
    const osPane = h(
      'div',
      { class: 'osPane' },
      h(
        'div',
        { class: 'osTop' },
        cbx('osnap', 'Object Snap On (Fn+F3)', s.osnap),
        cbx('otrack2', 'Object Snap Tracking On (Fn+F11)', s.otrack),
      ),
      h('div', { class: 'osHead' }, 'Object Snap modes'),
      h(
        'div',
        { class: 'osGrid' },
        h('div', { class: 'osCol' }, ...left.map(modeRow)),
        h('div', { class: 'osCol' }, ...right.map(modeRow)),
        h(
          'div',
          { class: 'osBtns' },
          h('button', { class: 'b', onclick: (e) => setAll(e.target, true) }, 'Select All'),
          h('button', { class: 'b', onclick: (e) => setAll(e.target, false) }, 'Clear All'),
        ),
      ),
      h(
        'div',
        { class: 'osTip' },
        h('span', { class: 'bulb', html: '&#128161;' }),
        h(
          'span',
          {},
          'To track from an Osnap point, pause over the point while in a command. A tracking vector appears when you move the cursor. To stop tracking, pause over the point again. Extension and Parallel work the same way: pause over an endpoint or a line first.',
        ),
      ),
      h(
        'div',
        { class: 'osFoot' },
        h(
          'button',
          {
            class: 'b',
            onclick: () => {
              c.app.exec('OPTIONS');
            },
          },
          'Options...',
        ),
      ),
    );
    const panes = [
      h(
        'div',
        {},
        h(
          'fieldset',
          {},
          h('legend', {}, 'Snap'),
          cbx('snap', 'Snap On (Fn+F9)', s.snap),
          field('Snap spacing:', num('snapSpacing', s.snapSpacing, { min: 0.0001 })),
        ),
        h(
          'fieldset',
          {},
          h('legend', {}, 'Grid'),
          cbx('grid', 'Grid On (Fn+F7)', s.grid),
          field('Grid spacing:', num('gridSpacing', s.gridSpacing, { min: 0.0001 })),
          field(
            'Grid style:',
            sel('gridStyle', ['Lines', 'Dots'], s.gridStyle === 'dots' ? 'Dots' : 'Lines'),
          ),
          field('Major line every:', num('gridMajor', s.gridMajor || 5, { min: 2 })),
        ),
      ),
      h(
        'div',
        {},
        h(
          'fieldset',
          {},
          h('legend', {}, 'Polar Angle Settings'),
          cbx('polar', 'Polar Tracking On (Fn+F10)', s.polar),
          field('Increment angle:', sel('polarInc', [90, 45, 30, 22.5, 18, 15, 10, 5], s.polarInc)),
        ),
        h('fieldset', {}, h('legend', {}, 'Ortho'), cbx('ortho', 'Ortho Mode On (Fn+F8)', s.ortho)),
      ),
      osPane,
      h(
        'div',
        {},
        h(
          'fieldset',
          {},
          h('legend', {}, '3D Object Snap Modes'),
          cbx('os3_vertex', 'Vertex', os3.vertex),
          cbx('os3_edgeMid', 'Midpoint on Edge', os3.edgeMid),
          cbx('os3_center', 'Center of Face', os3.center !== false),
          cbx('os3_knot', 'Knot', !!os3.knot),
          cbx('os3_perp', 'Perpendicular to Face', !!os3.perp),
          cbx('os3_near', 'Nearest to Face', !!os3.near),
        ),
        h(
          'div',
          { class: 'osTip' },
          'Face center, curved-edge knots, perpendicular foot and the nearest point on a visible face can be snapped directly.',
        ),
      ),
      h(
        'div',
        {},
        cbx('dyn', 'Enable Pointer Input / dimension input (Fn+F12)', s.dyn),
        h(
          'div',
          { class: 'osTip', style: 'margin-top:8px' },
          'Shows distance, angle and the command prompt next to the cursor.',
        ),
      ),
    ];
    const all = h('div', { class: 'dsDialog' });
    const show = (i) => {
      [...tabsEl.children].forEach((t, j) => t.classList.toggle('on', j === i));
      pane.innerHTML = '';
      pane.append(panes[i]);
    };
    names.forEach((n, i) => tabsEl.append(h('span', { onclick: () => show(i) }, n)));
    all.append(tabsEl, pane);
    show(Math.max(0, Math.min(startTab, names.length - 1)));
    const r = await DialogHost.show({
      title: 'Drafting Settings',
      body: all,
      collect: () => {
        const g = (n) => {
          for (const p of panes) {
            const e = p.querySelector(`[name="${n}"]`);
            if (e) return e;
          }
          return null;
        };
        return {
          snap: g('snap').checked,
          snapSpacing: parseFloat(g('snapSpacing').value) || s.snapSpacing,
          grid: g('grid').checked,
          gridSpacing: parseFloat(g('gridSpacing').value) || s.gridSpacing,
          gridStyle: g('gridStyle').value === 'Dots' ? 'dots' : 'lines',
          gridMajor: Math.max(2, Math.round(parseFloat(g('gridMajor').value)) || 5),
          polar: g('polar').checked,
          polarInc: parseFloat(g('polarInc').value),
          ortho: g('ortho').checked,
          otrack: g('otrack2').checked,
          osnap: g('osnap').checked,
          dyn: g('dyn').checked,
          osnapModes: OSNAP_MODES.map(([k]) => k).filter((k) => g(`os_${k}`).checked),
          osnap3d: { vertex: g('os3_vertex').checked, edgeMid: g('os3_edgeMid').checked, center:g('os3_center').checked, knot:g('os3_knot').checked, perp:g('os3_perp').checked, near:g('os3_near').checked },
        };
      },
    });
    if (r) {
      Object.assign(s, r);
      c.app.saveSettings();
      c.app.emit('settings');
      c.app.redraw();
    }
  }

  // ---- options
  /** The Options window (display, selection, system). */
  static async optionsDialog(c) {
    return openSettings(c.app);
  }

  // ---- text style
  /** The Text Style window. */
  static async textStyleDialog(c) {
    const doc = c.doc;
    let name = doc.curTextStyle;
    const body = h('div', { style: 'width:420px' });
    const form = h('div');
    const list = sel('style', Object.keys(doc.textStyles), name);
    list.size = 5;
    list.style.width = '100%';
    const fill = () => {
      const st = doc.textStyles[name];
      form.innerHTML = '';
      const fontOpts = [...FONT_CHOICES.map(([l, v]) => [v, l])];
      if (!fontOpts.some(([v]) => v === st.font)) fontOpts.unshift([st.font, st.font]);
      form.append(
        field('Font:', sel('font', fontOpts, st.font)),
        field('Height (0 = prompt):', num('height', st.h || 0)),
        field('Width factor:', num('wf', st.wf || 1)),
        field('Oblique angle:', num('obl', st.obl || 0)),
        h(
          'div',
          {
            class: 'preview',
            style: `border:1px solid var(--ctl-edge);background:var(--panel);height:46px;display:flex;align-items:center;padding:0 10px;font-size:22px;font-family:${fontStack(st.font)}`,
          },
          'AaBbCcD 123 한글 Ø50 ±0.1 45°',
        ),
      );
    };
    const save = () => {
      const st = doc.textStyles[name];
      if (!st || !q(form, 'font')) return;
      st.font = q(form, 'font').value;
      st.h = +q(form, 'height').value || 0;
      st.wf = +q(form, 'wf').value || 1;
      st.obl = +q(form, 'obl').value || 0;
    };
    list.addEventListener('change', () => {
      save();
      name = list.value;
      fill();
    });
    form.addEventListener('change', (e) => {
      if (e.target.name === 'font') {
        const p = form.querySelector('.preview');
        if (p) p.style.fontFamily = fontStack(e.target.value);
      }
    });
    fill();
    body.append(h('div', {}, 'Styles:'), list, form);
    await DialogHost.show({
      title: 'Text Style',
      body,
      buttons: [
        { label: 'New...', value: 'new' },
        { label: 'Delete', value: 'del' },
        { label: 'Set Current', value: 'cur' },
        { label: 'OK', value: true, primary: true },
        { label: 'Cancel', value: null },
      ],
      onButton: async (v) => {
        save();
        if (v === 'new') {
          const n = await dialogs.promptText({
            title: 'New Text Style',
            label: 'Style name:',
            value: `Style${Object.keys(doc.textStyles).length}`,
          });
          if (n && !doc.textStyles[n]) {
            doc.textStyles[n] = { ...doc.textStyles[name] };
            name = n;
            list.append(h('option', { value: n }, n));
            list.value = n;
            fill();
          }
          return false;
        }
        if (v === 'del') {
          if (name !== 'Standard' && name !== doc.curTextStyle) {
            delete doc.textStyles[name];
            list.querySelector(`option[value="${name}"]`).remove();
            name = 'Standard';
            list.value = name;
            fill();
          }
          return false;
        }
        if (v === 'cur') {
          doc.curTextStyle = name;
          return false;
        }
        return true;
      },
    });
    c.bump();
    c.app.emit('doc');
  }

  // ---- dimension style
  // live preview of a dimension style: a linear, an aligned and a radius dimension drawn with the real dimension code
  /** @private A small drawing of a dimension in a dimension style (the preview of the style window). */
  static dimPreviewSvg(doc, style) {
    const fake = { dimStyles: { __p: style }, textStyles: doc.textStyles, units: doc.units };
    const items = [
      E.mk('dim', {
        kind: 'lin',
        p1: { x: 0, y: 0 },
        p2: { x: 60, y: 0 },
        dp: { x: 30, y: -12 },
        rot: 0,
        style: '__p',
      }),
      E.mk('dim', {
        kind: 'ali',
        p1: { x: 70, y: 0 },
        p2: { x: 100, y: 38 },
        dp: { x: 112, y: 14 },
        style: '__p',
      }),
      E.mk('dim', { kind: 'rad', c: { x: 20, y: 36 }, r: 12, p: { x: 38, y: 52 }, style: '__p' }),
    ];
    const gs = items.map((e) => E.dimGeom(e, fake));
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const grow = (p) => {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    };
    [
      [0, 0],
      [100, 38],
      [8, 24],
      [32, 48],
    ].forEach(([x, y]) => grow({ x, y }));
    for (const g of gs) {
      g.lines.forEach(([a, b2]) => {
        grow(a);
        grow(b2);
      });
      for (const t of [g.text, ...g.extra])
        if (t) {
          grow(t.p);
          grow({ x: t.p.x + t.w * 1.2 || t.p.x, y: t.p.y + t.h });
        }
    }
    const pad = 8;
    const W = 420;
    const H = 190;
    const sc = Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - 2 * pad) / (y1 - y0 || 1));
    const X = (p) => ((p.x - x0) * sc + pad + (W - 2 * pad - (x1 - x0) * sc) / 2).toFixed(1);
    const Y = (p) => (H - ((p.y - y0) * sc + pad + (H - 2 * pad - (y1 - y0) * sc) / 2)).toFixed(1);
    let out = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="color:var(--txt)" fill="none" stroke="currentColor" stroke-width="1">`;
    out += `<path d="M${X({ x: 0, y: 0 })} ${Y({ x: 0, y: 0 })}L${X({ x: 60, y: 0 })} ${Y({ x: 60, y: 0 })}M${X({ x: 70, y: 0 })} ${Y({ x: 70, y: 0 })}L${X({ x: 100, y: 38 })} ${Y({ x: 100, y: 38 })}" stroke="#888" stroke-width="1.6"/>`;
    {
      const c = { x: 20, y: 36 };
      out += `<ellipse cx="${X(c)}" cy="${Y(c)}" rx="${(12 * sc).toFixed(1)}" ry="${(12 * sc).toFixed(1)}" stroke="#888" stroke-width="1.6"/>`;
    }
    for (const g of gs) {
      out += `<path d="${g.lines.map(([a, b2]) => `M${X(a)} ${Y(a)}L${X(b2)} ${Y(b2)}`).join('')}"/>`;
      for (const ar of g.arrows) {
        const sh = E.arrowShapes(ar, g.ds.asz);
        for (const poly of sh.fill || [])
          out += `<path d="M${poly.map((q) => `${X(q)} ${Y(q)}`).join('L')}Z" fill="currentColor" stroke="none"/>`;
        for (const pl of sh.stroke || [])
          out += `<path d="M${pl.map((q) => `${X(q)} ${Y(q)}`).join('L')}"/>`;
        for (const d of sh.dots || [])
          out += `<circle cx="${X(d.c)}" cy="${Y(d.c)}" r="${(d.r * sc).toFixed(1)}" fill="currentColor" stroke="none"/>`;
      }
      for (const t of [g.text, ...g.extra])
        if (t)
          out += `<text x="${X(t.p)}" y="${Y(t.p)}" font-size="${(t.h * sc * 0.95).toFixed(1)}" font-family="Helvetica, Arial, sans-serif" fill="currentColor" stroke="none" text-anchor="${t.al === 1 ? 'middle' : t.al === 2 ? 'end' : 'start'}" transform="rotate(${((-t.rot * 180) / Math.PI).toFixed(1)} ${X(t.p)} ${Y(t.p)})">${String(t.str).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`;
    }
    return `${out}</svg>`;
  }

  /** The Dimension Style Manager with a live preview. */
  static async dimStyleDialog(c) {
    const doc = c.doc;
    let name = doc.curDimStyle;
    const list = sel('style', Object.keys(doc.dimStyles), name);
    list.size = 4;
    list.style.width = '100%';
    const form = h('div');
    const prev = h('div', { class: 'dimPrev' });
    const chk = (n, label, on) =>
      h(
        'label',
        { class: 'chk' },
        h('input', { type: 'checkbox', name: n, ...(on ? { checked: true } : {}) }),
        ' ' + label,
      );
    const arrowSel = (n, v, same) =>
      sel(
        n,
        [...(same ? [['', 'Same as the first']] : []), ...E.ARROW_TYPES],
        v || (same ? '' : 'closed'),
      );
    const NUMS = [
      'eo',
      'ee',
      'bs',
      'asz',
      'h',
      'gap',
      'scale',
      'round',
      'lfac',
      'altf',
      'tolUp',
      'tolLo',
      'tolScale',
    ];
    const SELS = ['prec', 'altPrec', 'tolPrec'];
    const tabNames = [
      'Lines',
      'Symbols and Arrows',
      'Text',
      'Fit',
      'Primary Units',
      'Alternate Units',
      'Tolerances',
    ];
    let tabIdx = 0;
    const tabsEl = h('div', { class: 'tabs' });
    const pane = h('div', { class: 'tabpane dimPane' });
    const panes = [];
    const getEl = (k) => {
      for (const pn of panes) {
        const el = pn.querySelector(`[name="${k}"]`);
        if (el) return el;
      }
      return null;
    }; // fields of ALL tabs, not just the visible one
    const readForm = () => {
      const s = { ...doc.dimStyles[name] };
      for (const k of NUMS) {
        const el = getEl(k);
        if (el) {
          const v = parseFloat(el.value);
          if (!Number.isNaN(v)) s[k] = v;
        }
      }
      for (const k of SELS) {
        const el = getEl(k);
        if (el) s[k] = +el.value;
      }
      for (const k of ['ext1off', 'ext2off', 'dim1off', 'dim2off', 'alt']) {
        const el = getEl(k);
        if (el) s[k] = el.checked;
      }
      for (const k of ['arrow', 'tplace', 'talign', 'dsep', 'zero', 'tolMode']) {
        const el = getEl(k);
        if (el) s[k] = el.value;
      }
      {
        const el = getEl('arrow2');
        if (el) s.arrow2 = el.value || null;
      }
      {
        const el = getEl('tcolor');
        if (el) s.tcolor = el.value ? +el.value : null;
      }
      for (const k of ['prefix', 'suffix', 'altPrefix', 'altSuffix']) {
        const el = getEl(k);
        if (el) s[k] = el.value;
      }
      return s;
    };
    const refresh = () => {
      try {
        prev.innerHTML = StandardDialogs.dimPreviewSvg(doc, readForm());
      } catch (err) {
        prev.textContent = err.message;
      }
    };
    const fill = () => {
      const s = { ...E.DEFAULT_DIMSTYLE, ...doc.dimStyles[name] };
      form.innerHTML = '';
      panes.length = 0;
      panes.push(
        h(
          'div',
          {},
          h(
            'fieldset',
            {},
            h('legend', {}, 'Extension lines'),
            chk('ext1off', 'Suppress extension line 1', s.ext1off),
            chk('ext2off', 'Suppress extension line 2', s.ext2off),
            field('Margin from the measured point (offset from origin):', num('eo', s.eo)),
            field('Extend beyond the dimension line:', num('ee', s.ee)),
          ),
          h(
            'fieldset',
            {},
            h('legend', {}, 'Dimension lines'),
            chk('dim1off', 'Suppress dimension line 1 (and its arrow)', s.dim1off),
            chk('dim2off', 'Suppress dimension line 2 (and its arrow)', s.dim2off),
            field('Baseline spacing:', num('bs', s.bs)),
          ),
        ),
        h(
          'div',
          {},
          h(
            'fieldset',
            {},
            h('legend', {}, 'Arrowheads'),
            field('First:', arrowSel('arrow', s.arrow)),
            field('Second:', arrowSel('arrow2', s.arrow2, true)),
            field('Arrow size:', num('asz', s.asz)),
          ),
        ),
        h(
          'div',
          {},
          h(
            'fieldset',
            {},
            h('legend', {}, 'Text appearance'),
            field('Text height:', num('h', s.h)),
            field(
              'Text color:',
              sel(
                'tcolor',
                [
                  ['', 'Same as dimension'],
                  ['1', '1  Red'],
                  ['2', '2  Yellow'],
                  ['3', '3  Green'],
                  ['4', '4  Cyan'],
                  ['5', '5  Blue'],
                  ['6', '6  Magenta'],
                  ['7', '7  White / Black'],
                ],
                s.tcolor == null ? '' : String(s.tcolor),
              ),
            ),
            field('Offset from dim line:', num('gap', s.gap)),
          ),
          h(
            'fieldset',
            {},
            h('legend', {}, 'Text placement'),
            field(
              'Vertical:',
              sel(
                'tplace',
                [
                  ['above', 'Above the dimension line'],
                  ['centered', 'Centered (line is broken)'],
                ],
                s.tplace,
              ),
            ),
            field(
              'Alignment:',
              sel(
                'talign',
                [
                  ['aligned', 'Aligned with dimension line'],
                  ['horizontal', 'Horizontal'],
                ],
                s.talign,
              ),
            ),
          ),
        ),
        h(
          'div',
          {},
          h(
            'fieldset',
            {},
            h('legend', {}, 'Scale for dimension features'),
            field('Use overall scale of:', num('scale', s.scale)),
            h(
              'div',
              { class: 'osTip' },
              'The overall scale multiplies text height, arrow size, offsets and gaps (use the plot scale reciprocal for dimensions placed in model space).',
            ),
          ),
        ),
        h(
          'div',
          {},
          h(
            'fieldset',
            {},
            h('legend', {}, 'Linear dimensions'),
            field('Precision:', sel('prec', [0, 1, 2, 3, 4, 5, 6, 7, 8], s.prec)),
            field(
              'Decimal separator:',
              sel(
                'dsep',
                [
                  ['.', '. (Period)'],
                  [',', ', (Comma)'],
                ],
                s.dsep,
              ),
            ),
            field('Round off:', num('round', s.round)),
            field(
              'Zero suppression:',
              sel(
                'zero',
                [
                  ['none', 'None'],
                  ['lead', 'Leading'],
                  ['trail', 'Trailing'],
                  ['both', 'Leading and trailing'],
                ],
                s.zero,
              ),
            ),
            field('Measurement scale factor:', num('lfac', s.lfac)),
            field('Prefix:', h('input', { type: 'text', name: 'prefix', value: s.prefix })),
            field('Suffix:', h('input', { type: 'text', name: 'suffix', value: s.suffix })),
          ),
        ),
        h(
          'div',
          {},
          h(
            'fieldset',
            {},
            h('legend', {}, 'Alternate units'),
            chk('alt', 'Display alternate units  [ ] after the primary text', s.alt),
            field('Multiplier for alternate units:', num('altf', s.altf)),
            field('Precision:', sel('altPrec', [0, 1, 2, 3, 4, 5, 6], s.altPrec)),
            field('Prefix:', h('input', { type: 'text', name: 'altPrefix', value: s.altPrefix })),
            field('Suffix:', h('input', { type: 'text', name: 'altSuffix', value: s.altSuffix })),
            h(
              'div',
              { class: 'osTip' },
              'For inch to millimetre use 25.4; for millimetre to inch use 0.03937.',
            ),
          ),
        ),
        h(
          'div',
          {},
          h(
            'fieldset',
            {},
            h('legend', {}, 'Tolerance format'),
            field(
              'Method:',
              sel(
                'tolMode',
                [
                  ['none', 'None'],
                  ['symmetrical', 'Symmetrical (±)'],
                  ['deviation', 'Deviation (+ / -)'],
                  ['limits', 'Limits (upper / lower)'],
                  ['basic', 'Basic (framed)'],
                ],
                s.tolMode,
              ),
            ),
            field('Upper value:', num('tolUp', s.tolUp)),
            field('Lower value:', num('tolLo', s.tolLo)),
            field('Precision:', sel('tolPrec', [0, 1, 2, 3, 4, 5, 6], s.tolPrec)),
            field('Height scaling:', num('tolScale', s.tolScale)),
          ),
        ),
      );
      form.append(tabsEl, pane);
      showTab(tabIdx);
      refresh();
    };
    const showTab = (i) => {
      tabIdx = i;
      [...tabsEl.children].forEach((t, j) => t.classList.toggle('on', j === i));
      pane.innerHTML = '';
      pane.append(panes[i]);
    };
    tabNames.forEach((n, i) => tabsEl.append(h('span', { onclick: () => showTab(i) }, n)));
    const save = () => {
      if (doc.dimStyles[name] && panes.length) doc.dimStyles[name] = readForm();
    };
    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    list.addEventListener('change', () => {
      save();
      name = list.value;
      fill();
    });
    fill();
    await DialogHost.show({
      title: 'Dimension Style Manager',
      body: h(
        'div',
        { class: 'dimDlg' },
        h(
          'div',
          { class: 'dimTop' },
          h('div', {}, h('div', { class: 'osHead' }, 'Styles'), list),
          prev,
        ),
        form,
      ),
      buttons: [
        { label: 'New...', value: 'new' },
        { label: 'Set Current', value: 'cur' },
        { label: 'OK', value: true, primary: true },
        { label: 'Cancel', value: null },
      ],
      onButton: async (v) => {
        if (v === null || v === false) return true;
        save();
        if (v === 'new') {
          const n = await dialogs.promptText({
            title: 'New Dimension Style',
            label: 'New style name:',
            value: `Copy of ${name}`,
          });
          if (n && !doc.dimStyles[n]) {
            doc.dimStyles[n] = { ...doc.dimStyles[name] };
            name = n;
            list.append(h('option', { value: n }, n));
            list.value = n;
            fill();
          }
          return false;
        }
        if (v === 'cur') {
          doc.curDimStyle = name;
          return false;
        }
        return true;
      },
    });
    c.bump();
    c.app.emit('doc');
  }

  // ---- point style
  /** The Point Style window. */
  static async pointStyleDialog(c) {
    const doc = c.doc;
    let mode = doc.pdmode & 7;
    const circ = !!(doc.pdmode & 32);
    const box = !!(doc.pdmode & 64);
    const cells = h('div', { style: 'display:grid;grid-template-columns:repeat(4,54px);gap:3px' });
    const draw = (m) =>
      `<svg width="40" height="40" viewBox="-10 -10 20 20" fill="none" stroke="#000" stroke-width="1">${m === 0 ? '<circle r="0.8" fill="#000"/>' : m === 2 ? '<path d="M-6 0H6M0-6V6"/>' : m === 3 ? '<path d="M-6-6L6 6M-6 6L6-6"/>' : m === 4 ? '<path d="M0 0V-6"/>' : ''}</svg>`;
    const render = () => {
      cells.innerHTML = '';
      for (const m of [0, 1, 2, 3, 4]) {
        const b = h('button', {
          style: `width:54px;height:48px;border:2px solid ${m === mode ? '#316ac5' : '#bbb'};background:var(--panel)`,
          html: m === 1 ? '<span style="color:var(--txt2)">none</span>' : draw(m),
        });
        b.addEventListener('click', () => {
          mode = m;
          render();
        });
        cells.append(b);
      }
    };
    render();
    const size = num('size', doc.pdsize, { step: 'any' });
    const body = h(
      'div',
      { style: 'width:330px' },
      cells,
      h(
        'label',
        { style: 'display:block;margin-top:8px' },
        h('input', { type: 'checkbox', name: 'circ', ...(circ ? { checked: true } : {}) }),
        ' Circle',
      ),
      h(
        'label',
        { style: 'display:block' },
        h('input', { type: 'checkbox', name: 'box', ...(box ? { checked: true } : {}) }),
        ' Square',
      ),
      field('Point size (0 = 5% of screen, negative = %):', size),
    );
    const r = await DialogHost.show({
      title: 'Point Style',
      body,
      collect: (el) => ({
        circ: q(el, 'circ').checked,
        box: q(el, 'box').checked,
        size: parseFloat(q(el, 'size').value) || 0,
      }),
    });
    if (r) {
      doc.pdmode = mode | (r.circ ? 32 : 0) | (r.box ? 64 : 0);
      doc.pdsize = r.size;
      c.bump();
    }
  }

  // ---- hatch
  /** The Hatch window (pattern, scale, angle, boundary). */
  static async hatchDialog(st) {
    const names = Object.keys(E.HATCH_PATTERNS);
    const prev = h('canvas', {
      width: 140,
      height: 90,
      style: 'border:1px solid var(--ctl-edge);background:var(--panel)',
    });
    const draw = (pattern, scale, angle) => {
      const ctx = prev.getContext('2d');
      ctx.clearRect(0, 0, 140, 90);
      const e = {
        loops: [
          [
            { x: 0, y: 0 },
            { x: 140, y: 0 },
            { x: 140, y: 90 },
            { x: 0, y: 90 },
          ],
        ],
        pattern,
        scale: Math.max(0.05, scale) * 2.2,
        angle: (angle * Math.PI) / 180,
      };
      if (pattern === 'SOLID') {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, 140, 90);
        return;
      }
      ctx.strokeStyle = '#000';
      ctx.beginPath();
      for (const [a, b] of E.hatchLines(e)) {
        ctx.moveTo(a.x, 90 - a.y);
        ctx.lineTo(b.x, 90 - b.y);
      }
      ctx.stroke();
    };
    const body = h(
      'div',
      { style: 'width:340px;display:flex;gap:10px' },
      h(
        'div',
        { style: 'flex:1' },
        field('Pattern:', sel('pattern', names, st.pattern)),
        field('Scale:', num('scale', st.scale, { min: 0.01 })),
        field('Angle:', num('angle', st.angle)),
        field(
          'Color (ACI 0-255, blank = layer):',
          h('input', {
            type: 'number',
            name: 'color',
            min: 0,
            max: 255,
            value: typeof st.color === 'number' ? st.color : '',
            style: 'width:60px',
          }),
        ),
      ),
      h('div', {}, h('div', {}, 'Swatch:'), prev),
    );
    const upd = (el) =>
      draw(q(el, 'pattern').value, +q(el, 'scale').value || 1, +q(el, 'angle').value || 0);
    const r = await DialogHost.show({
      title: 'Boundary Hatch',
      body,
      collect: (el) => ({
        pattern: q(el, 'pattern').value,
        scale: +q(el, 'scale').value || 1,
        angle: +q(el, 'angle').value || 0,
        color: q(el, 'color').value === '' ? null : +q(el, 'color').value,
      }),
      onOpen: (el) => {
        el.addEventListener('input', () => upd(el));
        upd(el);
      },
    });
    if (!r) return false;
    Object.assign(st, r);
    return true;
  }

  // ---- array
  /** The Array window (rectangular and polar). */
  static async arrayDialog() {
    const rect = h(
      'div',
      {},
      field('Rows:', num('rows', 3)),
      field('Columns:', num('cols', 4)),
      field('Row offset:', num('rdist', 10)),
      field('Column offset:', num('cdist', 10)),
      field('Angle of array:', num('angle', 0)),
    );
    const polar = h(
      'div',
      { style: 'display:none' },
      field('Total number of items:', num('count', 6)),
      field('Angle to fill (+ccw, -cw):', num('fill', 360)),
      h(
        'label',
        { style: 'display:block' },
        h('input', { type: 'checkbox', name: 'rotate', checked: true }),
        ' Rotate items as copied',
      ),
    );
    const mode = sel(
      'mode',
      [
        ['rect', 'Rectangular Array'],
        ['polar', 'Polar Array'],
      ],
      'rect',
    );
    mode.addEventListener('change', () => {
      rect.style.display = mode.value === 'rect' ? '' : 'none';
      polar.style.display = mode.value === 'polar' ? '' : 'none';
    });
    return DialogHost.show({
      title: 'Array',
      body: h(
        'div',
        { style: 'width:340px' },
        mode,
        h('div', { style: 'height:8px' }),
        rect,
        polar,
      ),
      collect: (el) => ({
        polar: q(el, 'mode').value === 'polar',
        rows: +q(el, 'rows').value,
        cols: +q(el, 'cols').value,
        rdist: +q(el, 'rdist').value,
        cdist: +q(el, 'cdist').value,
        angle: +q(el, 'angle').value,
        count: +q(el, 'count').value,
        fill: +q(el, 'fill').value,
        rotate: q(el, 'rotate').checked,
      }),
    });
  }

  // ---- insert block
  /** The Insert Block window. */
  static async insertDialog(c) {
    const names = Object.keys(c.doc.blocks);
    if (!names.length) {
      await dialogs.alert(
        'There are no blocks in this drawing.\nUse BLOCK to define one, or Browse to load a drawing as a block.',
      );
    }
    const nameSel = sel('name', names, names[0] || '');
    const body = h(
      'div',
      { style: 'width:340px' },
      field('Name:', nameSel),
      field('Scale X:', num('sx', 1)),
      field('Scale Y:', num('sy', 1)),
      field('Rotation:', num('rot', 0)),
      h(
        'button',
        {
          class: 'b',
          style: 'height:21px;min-width:90px;border:1px solid var(--ctl-edge)',
          onclick: async () => {
            const r = await c.ui.io.pickBlockFile(c);
            if (r) {
              if (![...nameSel.options].some((o) => o.value === r))
                nameSel.append(h('option', { value: r }, r));
              nameSel.value = r;
            }
          },
        },
        'Browse...',
      ),
    );
    const r = await DialogHost.show({
      title: 'Insert',
      body,
      collect: (el) => ({
        name: q(el, 'name').value,
        sx: +q(el, 'sx').value || 1,
        sy: +q(el, 'sy').value || 1,
        rot: +q(el, 'rot').value || 0,
      }),
    });
    return r && r.name ? r : null;
  }

  /** The multiline text editor. @returns {Promise<{str, h}|null>} */
  static mtextEditor({ str, h: ht }) {
    const ta = h('textarea', { rows: 8, style: 'width:420px' });
    ta.value = str || '';
    return DialogHost.show({
      title: 'Multiline Text Editor',
      body: h('div', {}, ta, field('Text height:', num('th', ht || 2.5, { min: 0.0001 }))),
      collect: (el) => ({ str: ta.value, h: +q(el, 'th').value || ht || 2.5 }),
      onOpen: () => setTimeout(() => ta.focus(), 10),
    });
  }

  // ---- quick select / find
  /** Quick Select: selects the objects that match a property. */
  static async qselectDialog(c) {
    const ents = c.app.curEnts();
    const types = [...new Set(ents.map((e) => e.type))];
    const body = h(
      'div',
      { style: 'width:340px' },
      field(
        'Object type:',
        sel('type', [['*', 'Multiple'], ...types.map((t) => [t, E.TYPE_NAMES[t] || t])], '*'),
      ),
      field(
        'Property:',
        sel(
          'prop',
          [
            ['layer', 'Layer'],
            ['color', 'Color'],
            ['ltype', 'Linetype'],
            ['none', '(any)'],
          ],
          'layer',
        ),
      ),
      field(
        'Operator:',
        sel(
          'op',
          [
            ['=', 'Equals'],
            ['!=', 'Not Equal to'],
          ],
          '=',
        ),
      ),
      field('Value:', h('input', { type: 'text', name: 'val', value: c.doc.cur.layer })),
    );
    const r = await DialogHost.show({
      title: 'Quick Select',
      body,
      collect: (el) => ({
        type: q(el, 'type').value,
        prop: q(el, 'prop').value,
        op: q(el, 'op').value,
        val: q(el, 'val').value,
      }),
    });
    if (!r) return;
    const get = (e) =>
      r.prop === 'layer'
        ? e.layer
        : r.prop === 'color'
          ? e.color == null
            ? 'ByLayer'
            : String(e.color)
          : r.prop === 'ltype'
            ? e.ltype || 'ByLayer'
            : null;
    const out = ents.filter(
      (e) =>
        c.app.selectable(e) &&
        (r.type === '*' || e.type === r.type) &&
        (r.prop === 'none' || (get(e) === r.val) === (r.op === '=')),
    );
    c.setSel(out);
    c.echo(`${out.length} found`);
  }

  /** Find and Replace for texts. */
  static async findDialog(c) {
    const body = h(
      'div',
      { style: 'width:340px' },
      field('Find text string:', h('input', { type: 'text', name: 'find' })),
      field('Replace with:', h('input', { type: 'text', name: 'repl' })),
    );
    const r = await DialogHost.show({
      title: 'Find and Replace',
      body,
      buttons: [
        { label: 'Find All', value: 'find', primary: true },
        { label: 'Replace All', value: 'repl' },
        { label: 'Cancel', value: null },
      ],
      collect: (el, v) => ({ v, find: q(el, 'find').value, repl: q(el, 'repl').value }),
    });
    if (!r || !r.find) return;
    const hits = c.app
      .curEnts()
      .filter((e) => ['text', 'mtext'].includes(e.type) && e.str.includes(r.find));
    if (r.v === 'repl') {
      hits.forEach((e) => {
        e.str = e.str.split(r.find).join(r.repl);
      });
      c.bump();
      c.echo(`${hits.length} text object(s) updated.`);
    } else {
      c.setSel(hits);
      c.echo(`${hits.length} text object(s) found.`);
    }
  }

  /** The Page Setup window of a layout (paper size, orientation). */
  static async pageSetupDialog(c) {
    if (c.app.space === 'model') {
      await dialogs.alert('Select a layout tab first.');
      return;
    }
    const lay = c.doc.layouts[c.app.space];
    const cur =
      PAPER.find(
        ([, w, hh]) =>
          Math.abs(w - Math.min(lay.paper.w, lay.paper.h)) < 1 &&
          Math.abs(hh - Math.max(lay.paper.w, lay.paper.h)) < 1,
      ) || PAPER[1];
    const body = h(
      'div',
      { style: 'width:340px' },
      field(
        'Paper size:',
        sel(
          'size',
          PAPER.map(([l]) => l),
          cur[0],
        ),
      ),
      field(
        'Orientation:',
        sel(
          'orient',
          [
            ['land', 'Landscape'],
            ['port', 'Portrait'],
          ],
          lay.paper.w >= lay.paper.h ? 'land' : 'port',
        ),
      ),
    );
    const r = await DialogHost.show({
      title: `Page Setup - ${lay.name}`,
      body,
      collect: (el) => ({ size: q(el, 'size').value, orient: q(el, 'orient').value }),
    });
    if (!r) return;
    const p = PAPER.find(([l]) => l === r.size);
    const w = Math.min(p[1], p[2]);
    const hh = Math.max(p[1], p[2]);
    const [nw, nh] = r.orient === 'land' ? [hh, w] : [w, hh];
    const fresh = newLayout(lay.name, nw, nh);
    lay.paper = { ...fresh.paper, size: r.size };
    lay.view = fresh.view;
    c.app.view.cx = nw / 2;
    c.app.view.cy = nh / 2;
    c.bump();
  }

  /** The Plot window (paper, area, scale, preview, PDF). @param {boolean} [previewOnly] */
  static async plotDialog(c, previewOnly) {
    const app = c.app;
    const doc = c.doc;
    const inLayout = app.space !== 'model';
    const lay = inLayout ? doc.layouts[app.space] : null;
    const initial = lay
      ? PAPER.find(
          ([, w, hh]) =>
            Math.abs(w - Math.min(lay.paper.w, lay.paper.h)) < 1 &&
            Math.abs(hh - Math.max(lay.paper.w, lay.paper.h)) < 1,
        ) || PAPER[1]
      : PAPER[1];
    const body = h(
      'div',
      { style: 'width:430px' },
      h(
        'fieldset',
        {},
        h('legend', {}, 'Paper size and orientation'),
        field(
          'Paper size:',
          sel(
            'size',
            PAPER.map(([l]) => l),
            initial[0],
          ),
        ),
        field(
          'Orientation:',
          sel(
            'orient',
            [
              ['land', 'Landscape'],
              ['port', 'Portrait'],
            ],
            !lay || lay.paper.w >= lay.paper.h ? 'land' : 'port',
          ),
        ),
      ),
      h(
        'fieldset',
        {},
        h('legend', {}, 'Plot area'),
        field(
          'What to plot:',
          sel(
            'area',
            inLayout
              ? [['layout', 'Layout']]
              : [
                  ['extents', 'Extents'],
                  ['display', 'Display'],
                ],
            inLayout ? 'layout' : 'extents',
          ),
        ),
      ),
      h(
        'fieldset',
        {},
        h('legend', {}, 'Plot scale'),
        field(
          'Scale:',
          sel(
            'scale',
            inLayout
              ? [['1', '1:1']]
              : [
                  ['fit', 'Fit to paper'],
                  ['1', '1:1'],
                  ['0.5', '1:2'],
                  ['0.2', '1:5'],
                  ['0.1', '1:10'],
                  ['0.05', '1:20'],
                  ['0.01', '1:100'],
                  ['2', '2:1'],
                ],
            inLayout ? '1' : 'fit',
          ),
        ),
      ),
      h(
        'fieldset',
        {},
        h('legend', {}, 'Plot options'),
        h(
          'label',
          { style: 'display:block' },
          h('input', { type: 'checkbox', name: 'mono' }),
          ' Plot in monochrome',
        ),
        h(
          'label',
          { style: 'display:block' },
          h('input', { type: 'checkbox', name: 'lw', checked: true }),
          ' Plot with lineweights',
        ),
        field(
          'Output:',
          sel(
            'fmt',
            [
              ['pdf', 'PDF'],
              ['png', 'PNG image'],
              ['svg', 'SVG'],
            ],
            'pdf',
          ),
        ),
      ),
    );
    const mk = (el) => {
      const p = PAPER.find(([l]) => l === q(el, 'size').value);
      const w = Math.min(p[1], p[2]);
      const hh = Math.max(p[1], p[2]);
      const land = q(el, 'orient').value === 'land';
      const [W, H] = inLayout ? [lay.paper.w, lay.paper.h] : land ? [hh, w] : [w, hh];
      const sc = q(el, 'scale').value;
      const opts = {
        paperW: W,
        paperH: H,
        mono: q(el, 'mono').checked,
        lw: q(el, 'lw').checked,
        background: '#ffffff',
      };
      if (!inLayout && sc !== 'fit') opts.scale = parseFloat(sc);
      if (!inLayout && q(el, 'area').value === 'display') {
        const v = app.view;
        opts.window = {
          x0: v.cx - v.w / 2 / v.zoom,
          x1: v.cx + v.w / 2 / v.zoom,
          y0: v.cy - v.h / 2 / v.zoom,
          y1: v.cy + v.h / 2 / v.zoom,
        };
      }
      return {
        svg: toSVG(doc, inLayout ? app.space : 'model', opts),
        W,
        H,
        fmt: q(el, 'fmt').value,
      };
    };
    const r = await DialogHost.show({
      title: `Plot - ${inLayout ? app.space : 'Model'}`,
      body,
      buttons: [
        { label: 'Preview...', value: 'prev' },
        { label: previewOnly ? 'Plot' : 'OK', value: true, primary: true },
        { label: 'Cancel', value: null },
      ],
      onButton: async (v, el) => {
        if (v === 'prev') {
          const o = mk(el);
          await DialogHost.show({
            title: 'Plot Preview',
            body: h(
              'div',
              {
                style:
                  'background:var(--face);padding:12px;max-width:80vw;max-height:70vh;overflow:auto',
              },
              h('div', {
                style:
                  'background:var(--panel);box-shadow:2px 2px 8px #000;margin:auto;width:min(70vw,900px)',
                html: o.svg.replace(/width="[^"]+mm" height="[^"]+mm"/, 'width="100%"'),
              }),
            ),
            buttons: [{ label: 'Close', value: true, primary: true }],
          });
          return false;
        }
        return true;
      },
      collect: (el) => mk(el),
    });
    if (r) await c.ui.io.plot(c.app, r);
  }

  /** The Help window (shortcuts, commands). */
  static helpDialog() {
    const rows = h(
      'table',
      { class: 'tbl' },
      h('tr', {}, h('th', {}, 'Command'), h('th', {}, 'Alias'), h('th', {}, 'Command (Korean)')),
    );
    for (const [ko, al, en] of HELP_SHORTCUTS)
      rows.append(
        h(
          'tr',
          {},
          h('td', {}, KeyNotation.format(en)),
          h(
            'td',
            { style: 'color:#c00;font-weight:bold;white-space:nowrap' },
            KeyNotation.format(al),
          ),
          h('td', {}, ko),
        ),
      );
    return DialogHost.show({
      title: 'Keyboard Shortcuts and Command Aliases',
      body: h(
        'div',
        { style: 'width:560px;max-height:62vh;overflow:auto' },
        rows,
        h(
          'p',
          {},
          KeyNotation.format(
            'F2 text window | F3 object snap | F7 grid | F8 ortho | F9 snap | F10 polar | F11 object snap tracking | F12 dynamic input',
          ),
        ),
        h(
          'p',
          {},
          KeyNotation.format(
            'Shortcuts: Ctrl+N new | Ctrl+O open | Ctrl+W close drawing | Ctrl+S save | Ctrl+Shift+S save as | Ctrl+Z undo | Ctrl+Y redo | Ctrl+A select all | Ctrl+1 properties | Ctrl+B hide the selected parts | Ctrl+Shift+B swap hidden and shown parts | Ctrl+Shift+U show all parts | Ctrl+Shift+] next drawing | Ctrl+Shift+[ previous drawing | Del erase',
          ),
        ),
        h(
          'p',
          {},
          'Mouse: wheel = zoom, middle button = pan, double-click middle = zoom extents, right click = context menu / Enter. Ctrl+wheel (two fingers on the trackpad) = turn the 3D model, Ctrl+Shift+wheel = turn it round (plain mouse wheel).',
        ),
      ),
      buttons: [{ label: 'Close', value: true, primary: true }],
    });
  }

  /** Registers the commands of this file in their original order (a later definition of a name wins). */
  static register() {
    dialogs.promptText = StandardDialogs.promptText;
    dialogs.confirm = StandardDialogs.confirm;
    dialogs.confirmHtml = ({ title = 'MacCAD', message, buttons = ['Yes', 'No', 'Cancel'] }) =>
      DialogHost.show({
        title,
        body: h('div', { style: 'min-width:300px;padding:6px 4px;white-space:pre-wrap' }, message),
        buttons: buttons.map((b, i) => ({ label: b, value: b, primary: i === 0 })),
      }).then((v) => (v === null ? 'Cancel' : v));
    dialogs.alert = (message, title = 'MacCAD') =>
      window.api && window.api.message
        ? window.api.message({ message: String(message), buttons: ['OK'], type: 'info', title })
        : DialogHost.show({
            title,
            body: h(
              'div',
              { style: 'min-width:280px;padding:6px 4px;white-space:pre-wrap' },
              message,
            ),
            buttons: [{ label: 'OK', value: true, primary: true }],
          });
    dialogs.colorDialog = StandardDialogs.colorDialog;
    dialogs.layerManager = StandardDialogs.layerManager;
    dialogs.linetypeDialog = StandardDialogs.linetypeDialog;
    dialogs.ltscaleDialog = StandardDialogs.ltscaleDialog;
    dialogs.unitsDialog = StandardDialogs.unitsDialog;
    dialogs.draftingDialog = StandardDialogs.draftingDialog;
    dialogs.optionsDialog = StandardDialogs.optionsDialog;
    dialogs.textStyleDialog = StandardDialogs.textStyleDialog;
    dialogs.dimStyleDialog = StandardDialogs.dimStyleDialog;
    dialogs.pointStyleDialog = StandardDialogs.pointStyleDialog;
    dialogs.hatchDialog = StandardDialogs.hatchDialog;
    dialogs.arrayDialog = StandardDialogs.arrayDialog;
    dialogs.insertDialog = StandardDialogs.insertDialog;
    dialogs.tableDialog = () =>
      DialogHost.show({
        title: 'Insert Table',
        body: h(
          'div',
          { style: 'width:320px' },
          field('Columns:', num('cols', 4)),
          field('Data rows:', num('rows', 5)),
          field('Column width:', num('cw', 40)),
          field('Row height:', num('rh', 8)),
          field('Title (optional):', h('input', { type: 'text', name: 'title' })),
        ),
        collect: (el) => ({
          cols: +q(el, 'cols').value || 1,
          rows: +q(el, 'rows').value || 1,
          cw: +q(el, 'cw').value || 40,
          rh: +q(el, 'rh').value || 8,
          title: q(el, 'title').value,
        }),
      });
    dialogs.mtextEditor = StandardDialogs.mtextEditor;
    dialogs.qselectDialog = StandardDialogs.qselectDialog;
    dialogs.findDialog = StandardDialogs.findDialog;
    dialogs.pageSetupDialog = StandardDialogs.pageSetupDialog;
    dialogs.plotDialog = StandardDialogs.plotDialog;
    // ---- about / help / hatch etc.
    dialogs.aboutDialog = () =>
      DialogHost.show({
        title: 'About MacCAD 2027',
        body: h(
          'div',
          { style: 'width:340px;text-align:center;line-height:1.6' },
          h('div', {
            html: ICONS.acad.replace('width="18" height="18"', 'width="56" height="56"'),
          }),
          h('b', { style: 'font-size:15px' }, 'MacCAD 2027'),
          h('div', {}, 'An AutoCAD-style 2D drafting application for macOS.'),
          h(
            'div',
            { style: 'color:var(--txt2)' },
            'Files: .mcad (native), DXF import / export, SVG / PNG / PDF plot.',
          ),
          h('div', { style: 'color:var(--txt2)' }, 'Not affiliated with or endorsed by Autodesk.'),
        ),
        buttons: [{ label: 'OK', value: true, primary: true }],
      });
    dialogs.helpDialog = StandardDialogs.helpDialog;
  }
}

StandardDialogs.register();

export const closePopups = DialogHost.closeAll;
export const popupMenu = DialogHost.popupMenu;
export const dialog = DialogHost.show;
export const macKeys = KeyNotation.format;
