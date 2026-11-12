/**
 * @file commands_misc.js
 * @brief View, inquiry, layer / property, clipboard, file and layout commands.
 *
 * Commands registered here: ZOOM, PAN, REGEN, GRID, GRIDSTYLE, -SNAP, ORTHO, POLAR, OTRACK, DYN,
 * LWT, OSNAP(TOGGLE), DSETTINGS, OPTIONS, UNITS, LTSCALE, DIST, ID, AREA, LIST, STATUS, LAYER and
 * the LAY* layer commands, COLOR, LINETYPE, PROPERTIES, HIDEOBJECTS, SWAPHIDDEN, SHOWALLOBJECTS,
 * UNDO, REDO, SELECTALL, QSELECT, FIND, clipboard commands, file commands, MVIEW, MSPACE, PSPACE,
 * LAYOUT, APPLOAD, VLIDE, LOAD, SCRIPT, XREF and XCLIP.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import { def, alias } from './registry.js';
import * as G from './geom.js';
import * as E from './entities.js';
import * as O from './ops.js';
import { fmtLen, fmtAng } from './units.js';
import { Doc, newLayout, parseMcad } from './doc.js';
import { alignedProps } from './dimmatch.js';

void O;

/* ============================================================================================
 * 2. CONSTANTS AND HELPERS
 * ========================================================================================== */

const { dist, ang } = G;

/** @returns {boolean} true when v is a point {x, y}. */
const isPt = (v) => v && typeof v === 'object' && 'x' in v;

/** The prompt shown while the view is changed in real time (ZOOM, PAN). */
const REAL_TIME_PROMPT = 'Press Esc or Enter to exit, or right-click to display shortcut menu.';

/** Options of ZOOM. */
const ZOOM_OPTIONS = [
  'All',
  'Center',
  'Dynamic',
  'Extents',
  'Previous',
  'Scale',
  'Window',
  'Object',
  'In',
  'Out',
];

/** The width of the column that holds the property names in LIST. */
const LIST_LABEL_WIDTH = 20;

/* ============================================================================================
 * 3. DESCRIBING AN OBJECT (LIST)
 * ========================================================================================== */

/**
 * The lines LIST prints for one object.
 * @param {object} e the object
 * @param {object} c command context
 * @returns {string[]}
 */
export function describe(e, c) {
  const u = c.doc.units;
  const f = (v) => fmtLen(v, u);
  const pt = (p) => `X= ${f(p.x)}  Y= ${f(p.y)}  Z= ${f(0)}`;
  const pad = ''.padEnd(LIST_LABEL_WIDTH);
  const L = [];
  L.push(
    `${E.typeName(e).toUpperCase().padEnd(LIST_LABEL_WIDTH)}Layer: "${e.layer}"`,
    `${pad}Space: ${c.app.space === 'model' ? 'Model space' : 'Paper space'}`,
    `${pad}Handle = ${e.id.toString(16).toUpperCase()}`,
  );
  if (e.color != null) L.push(`${pad}Color: ${typeof e.color === 'number' ? e.color : e.color}`);
  if (e.ltype) L.push(`${pad}Linetype: "${e.ltype}"`);
  switch (e.type) {
    case 'line':
      L.push(
        `from point, ${pt(e.p1)}`,
        `  to point, ${pt(e.p2)}`,
        `Length = ${f(dist(e.p1, e.p2))},  Angle in XY Plane = ${fmtAng(ang(e.p1, e.p2), u, true)}`,
        `Delta X = ${f(e.p2.x - e.p1.x)},  Delta Y = ${f(e.p2.y - e.p1.y)}`,
      );
      break;
    case 'circle':
      L.push(
        `center point, ${pt(e.c)}`,
        `radius ${f(e.r)}`,
        `circumference ${f(E.entLength(e))}`,
        `area ${f(E.entArea(e))}`,
      );
      break;
    case 'arc':
      L.push(
        `center point, ${pt(e.c)}`,
        `radius ${f(e.r)}`,
        `start angle ${fmtAng(e.a0, u, true)}`,
        `end angle ${fmtAng(e.a1, u, true)}`,
        `length ${f(E.entLength(e))}`,
      );
      break;
    case 'pline':
      L.push(
        e.closed ? 'Closed' : 'Open',
        ...e.pts.map((p) => `at point  ${pt(p)}${p.b ? `  bulge ${p.b.toFixed(4)}` : ''}`),
        `area ${f(E.entArea(e))}`,
        `perimeter ${f(E.entLength(e))}`,
      );
      break;
    case 'ellipse': {
      const ax = E.ellipseAxes(e);
      L.push(`center ${pt(e.c)}`, `major axis ${f(ax.a)}  minor axis ${f(ax.b)}`);
      break;
    }
    case 'text':
    case 'mtext':
      L.push(
        `Style = "${e.style || 'Standard'}"`,
        `insertion point ${pt(e.p)}`,
        `height ${f(e.h)}`,
        `text  ${e.str.replace(/\n/g, '\\P')}`,
        `rotation angle ${fmtAng(e.rot || 0, u, true)}`,
      );
      break;
    case 'insert':
      L.push(
        `"${e.name}"`,
        `at point, ${pt(e.p)}`,
        `X scale factor ${e.sx}  Y scale factor ${e.sy}`,
        `rotation angle ${fmtAng(e.rot || 0, u, true)}`,
      );
      break;
    case 'point':
      L.push(`at point, ${pt(e.p)}`);
      break;
    case 'dim':
      L.push(`Measurement: ${E.dimText(e, c.doc)}`);
      break;
    case 'hatch':
      L.push(
        `Pattern: ${e.pattern}  Scale ${e.scale}  Loops ${e.loops.length}`,
        `area ${f(E.entArea(e))}`,
      );
      break;
    default:
      break;
  }
  return L;
}

/* ============================================================================================
 * 4. CLASS
 * ========================================================================================== */

/** The view, inquiry, layer, clipboard, file and layout commands. Every command is a static method `(c) => Promise`. */
export class MiscCommands {
  // ---------------------------------------------------------------- view

  /** @private A dashed rectangle between two corners (the preview of a zoom window). */
  static windowRect(c, a, b) {
    const t = c.mk('pline', {
      pts: [
        { ...a, b: 0 },
        { x: b.x, y: a.y, b: 0 },
        { ...b, b: 0 },
        { x: a.x, y: b.y, b: 0 },
      ],
      closed: true,
    });
    t._dash = [4, 4];
    return t;
  }

  /**
   * @private One option of ZOOM.
   * @returns {Promise<boolean>} false when the option is not known
   */
  static async zoomOption(c, o) {
    const a = c.app;
    switch (o) {
      case 'All':
        a.zoomAll();
        return true;
      case 'Extents':
        a.zoomExtents();
        return true;
      case 'In':
        a.zoomScale(2);
        return true;
      case 'Out':
        a.zoomScale(0.5);
        return true;
      case 'Previous':
        a.zoomPrev();
        return true;
      case 'Window':
      case 'Dynamic': {
        const p1 = await c.point('Specify first corner', { noOrtho: true, noSnap: false });
        if (!isPt(p1)) return true;
        const p2 = await c.point('Specify opposite corner', {
          noOrtho: true,
          base: p1,
          rubber: false,
          preview: (q) => [MiscCommands.windowRect(c, p1, q)],
        });
        if (isPt(p2)) a.zoomWindow(p1, p2);
        return true;
      }
      case 'Center': {
        const p = await c.point('Specify center point');
        if (!isPt(p)) return true;
        const v = a.activeView();
        const h = await c.dist('Enter magnification or height', { def: v.h / v.zoom });
        if (typeof h === 'number' && h > 0) a.setZoom(p.x, p.y, a.view.h / h);
        return true;
      }
      case 'Scale': {
        const s = await c.number('Enter a scale factor (nX or nXP)', { def: 1 });
        if (typeof s === 'number' && s > 0) a.zoomScale(s);
        return true;
      }
      case 'Object': {
        const ents = await c.select('Select objects');
        if (!ents.length) return true;
        let b = null;
        for (const e of ents) b = E.bboxMerge(b, E.bbox(e, c.doc));
        if (b) a.zoomWindow({ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y1 });
        return true;
      }
      default:
        return false;
    }
  }

  /** ZOOM: window, scale, centre, extents, previous, object, or real time. */
  static async zoom(c) {
    const a = c.app;
    if (c.arg) {
      if (await MiscCommands.zoomOption(c, c.arg)) return;
    }
    const r = await c.point(
      'Specify corner of window, enter a scale factor (nX or nXP), or\n[All/Center/Dynamic/Extents/Previous/Scale/Window/Object] <real time>',
      { kw: ZOOM_OPTIONS, noOrtho: true, allowNumber: true, rubber: false },
    );
    if (r === null) {
      await c.app.request('rt', REAL_TIME_PROMPT, { mode: 'zoom' });
      return;
    }
    if (typeof r === 'string') {
      await MiscCommands.zoomOption(c, r);
      return;
    }
    if (r.scale !== undefined) {
      a.zoomScale(r.scale);
      return;
    }
    const p2 = await c.point('Specify opposite corner', {
      base: r,
      noOrtho: true,
      rubber: false,
      preview: (q) => [MiscCommands.windowRect(c, r, q)],
    });
    if (isPt(p2)) a.zoomWindow(r, p2);
  }

  /** PAN: real-time pan. */
  static async pan(c) {
    await c.app.request('rt', REAL_TIME_PROMPT, { mode: 'pan' });
  }

  /** REGEN / REDRAW: redraws the drawing. */
  static async regen(c) {
    c.bump();
    c.echo('Regenerating model.');
  }

  // ---------------------------------------------------------------- grid, snap and drawing aids

  /** GRID: on / off, spacing options, major lines, style. */
  static async grid(c) {
    const o = await c.keyword(
      'Specify grid spacing(X) or [ON/OFF/Snap/Major/STyle]',
      ['ON', 'OFF', 'Snap', 'Major', 'STyle'],
      null,
    );
    const s = c.app.settings;
    if (o === 'ON') c.app.set('grid', true);
    else if (o === 'OFF') c.app.set('grid', false);
    else if (o === 'Snap') c.app.set('gridSpacing', s.snapSpacing);
    else if (o === 'Major') {
      const n = await c.number('Enter a major grid line frequency', { def: s.gridMajor || 5 });
      if (n && n >= 2) c.app.set('gridMajor', Math.round(n));
    } else if (o === 'STyle') await MiscCommands.gridStyle(c);
    else if (o === null) c.app.toggle('grid');
  }

  /**
   * GRIDSTYLE: the grid behind the drawing as lines (like the newer AutoCAD: thin lines, a
   * stronger one every 5th, coloured axes) or as dots.
   */
  static async gridStyle(c) {
    const current = c.app.settings.gridStyle === 'dots' ? 'Dots' : 'Lines';
    const o = await c.keyword(
      `Enter grid style [Lines/Dots] <${current}>`,
      ['Lines', 'Dots'],
      current,
    );
    if (!o) return;
    c.app.set('gridStyle', o === 'Dots' ? 'dots' : 'lines');
    if (!c.app.settings.grid) c.app.set('grid', true);
    c.echo(o === 'Dots' ? 'Grid style: dots.' : 'Grid style: lines.');
  }

  /** -SNAP: snap on / off. */
  static async snapSpacing(c) {
    const o = await c.keyword('Specify snap spacing or [ON/OFF]', ['ON', 'OFF'], null);
    if (o === 'ON') c.app.set('snap', true);
    else if (o === 'OFF') c.app.set('snap', false);
    else c.app.toggle('snap');
  }

  /** LTSCALE: the linetype scale; a window on screen, the command line from a script or LISP. */
  static async lineTypeScale(c) {
    if (!c.app.nested && !c.app.inScript && c.arg === undefined) {
      await c.ui.ltscaleDialog(c);
      return;
    }
    await MiscCommands.askLineTypeScale(c);
  }

  /** -LTSCALE: the linetype scale at the command line. */
  static async askLineTypeScale(c) {
    const v = await c.number('Enter new linetype scale factor', { def: c.doc.ltscale });
    if (typeof v === 'number' && v > 0) {
      c.doc.ltscale = v;
      c.bump();
    }
  }

  // ---------------------------------------------------------------- inquiry

  /** DIST: distance and angle between two points; the result can become a dimension. */
  static async distance(c) {
    const a = await c.point('Specify first point');
    if (!isPt(a)) return;
    const b = await c.point('Specify second point', { base: a });
    if (!isPt(b)) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    c.echo(
      `Distance = ${c.fmt(dist(a, b))},  Angle in XY Plane = ${c.fmtA(ang(a, b))},  Angle from XY Plane = 0`,
    );
    c.echo(`  Delta X = ${c.fmt(dx)},  Delta Y = ${c.fmt(dy)},  Delta Z = ${c.fmt(0)}`);
    // pull the measured distance out into a dimension: drag to place the dimension line, or Match an existing one
    const make = (props, like) => {
      const d = c.stamp(E.mk('dim', props));
      if (like) {
        d.style = like.style;
        d.layer = like.layer;
        d.color = like.color;
      }
      return d;
    };
    const horiz = Math.abs(dy) < 1e-9;
    const vert = Math.abs(dx) < 1e-9;
    const byPoint = (loc) =>
      make(
        horiz || vert
          ? { kind: 'lin', p1: a, p2: b, dp: loc, rot: horiz ? 0 : Math.PI / 2 }
          : { kind: 'ali', p1: a, p2: b, dp: loc },
      );
    for (;;) {
      const loc = await c.point(
        'Specify dimension line location to insert a dimension [Match/eXit] <eXit>',
        { base: G.mid(a, b), rubber: false, kw: ['Match', 'eXit'], preview: (q) => [byPoint(q)] },
      );
      if (loc === 'Match') {
        const r = await c.pick('Select the existing dimension to match', {
          filter: (e) => e.type === 'dim',
        });
        if (!r || !r.e) continue;
        const al = alignedProps(r.e, a, b);
        if (!al) {
          c.echo('Only linear and aligned dimensions can be matched.');
          continue;
        }
        c.app.lastDim = c.add(make({ p1: a, p2: b, ...al }, r.e));
        c.echo('Dimension placed on the dimension line of the selected dimension.');
        return;
      }
      if (!isPt(loc)) return;
      c.app.lastDim = c.add(byPoint(loc));
      return;
    }
  }

  /** ID: the coordinates of a point. */
  static async id(c) {
    const p = await c.point('Specify point');
    if (isPt(p)) c.echo(`X = ${c.fmt(p.x)}  Y = ${c.fmt(p.y)}  Z = ${c.fmt(0)}`);
  }

  /** AREA: area and perimeter from points or objects, with add / subtract totals. */
  static async area(c) {
    let mode = 'points';
    let total = 0;
    let sign = 1;
    for (;;) {
      if (mode === 'points') {
        const p = await c.point('Specify first corner point or [Object/Add area/Subtract area]', {
          kw: ['Object', 'Add area', 'Subtract area'],
        });
        if (p === 'Object') {
          mode = 'object';
          continue;
        }
        if (p === 'Add area') {
          sign = 1;
          continue;
        }
        if (p === 'Subtract area') {
          sign = -1;
          continue;
        }
        if (!isPt(p)) return;
        const pts = [p];
        for (;;) {
          const q = await c.point('Specify next corner point or press ENTER for total', {
            base: pts[pts.length - 1],
            preview: (r) => [
              c.mk('pline', { pts: [...pts, r].map((x) => ({ ...x, b: 0 })), closed: true }),
            ],
          });
          if (!isPt(q)) break;
          pts.push(q);
        }
        if (pts.length < 3) return;
        const area = Math.abs(G.polyArea(pts));
        let per = 0;
        pts.forEach((q, i) => {
          per += dist(q, pts[(i + 1) % pts.length]);
        });
        total += sign * area;
        c.echo(`Area = ${c.fmt(area)},  Perimeter = ${c.fmt(per)}`);
        if (sign) c.echo(`Total area = ${c.fmt(total)}`);
        return;
      }
      const r = await c.pick('Select objects', {
        filter: (e) => E.isClosed(e) || e.type === 'pline' || e.type === 'hatch',
        kw: ['Add area', 'Subtract area'],
      });
      if (r === 'Add area') {
        sign = 1;
        continue;
      }
      if (r === 'Subtract area') {
        sign = -1;
        continue;
      }
      if (!r || !r.e) return;
      const ar = E.entArea(r.e);
      total += sign * ar;
      const openClosing =
        r.e.type === 'pline' && !r.e.closed ? dist(r.e.pts[0], r.e.pts[r.e.pts.length - 1]) : 0;
      c.echo(
        `Area = ${c.fmt(ar)},  ${r.e.type === 'circle' ? 'Circumference' : 'Perimeter'} = ${c.fmt(E.entLength(r.e) + openClosing)}`,
      );
      c.echo(`Total area = ${c.fmt(total)}`);
    }
  }

  /** LIST: the data of the selected objects. */
  static async list(c) {
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    for (const e of ents) describe(e, c).forEach((l) => c.echo(l));
    c.ui.showTextWindow(true);
  }

  /** STATUS: the number of objects, layers and blocks. */
  static async status(c) {
    c.echo(`${c.doc.model.length} objects in model space`);
    c.echo(`Layers: ${c.doc.layers.length}   Blocks: ${Object.keys(c.doc.blocks).length}`);
    c.ui.showTextWindow(true);
  }

  // ---------------------------------------------------------------- layers and properties

  /** COLOR: chooses the current colour. */
  static async color(c) {
    const r = await c.ui.colorDialog(c.doc.cur.color);
    if (r !== undefined) {
      c.doc.cur.color = r;
      c.app.emit('doc');
    }
  }

  /** @private Asks for an object and returns it (null when none was picked). */
  static async pickOnLayer(c, prompt) {
    const r = await c.pick(prompt, { filter: () => true });
    return r && r.e ? r.e : null;
  }

  /** LAYISO: shows only the layer of the picked object (and the current layer). */
  static async layerIsolate(c) {
    const e = await MiscCommands.pickOnLayer(c, 'Select object on layer to be isolated');
    if (!e) return;
    c.doc.layers.forEach((l) => {
      l.on = l.name === e.layer || l.name === c.doc.cur.layer;
    });
    c.echo(`Layer "${e.layer}" has been isolated.`);
  }

  /** LAYUNISO / LAYON: turns every layer on. */
  static layersOn(message) {
    return async (c) => {
      c.doc.layers.forEach((l) => {
        l.on = true;
      });
      c.echo(message);
    };
  }

  /** LAYOFF: turns off the layer of the picked object. */
  static async layerOff(c) {
    const e = await MiscCommands.pickOnLayer(c, 'Select object on layer to be turned off');
    if (e && e.layer !== c.doc.cur.layer) {
      c.doc.layer(e.layer).on = false;
      c.echo(`Layer "${e.layer}" has been turned off.`);
    }
  }

  /** LAYFRZ: freezes the layer of the picked object. */
  static async layerFreeze(c) {
    const e = await MiscCommands.pickOnLayer(c, 'Select object on layer to be frozen');
    if (e && e.layer !== c.doc.cur.layer) {
      c.doc.layer(e.layer).frozen = true;
      c.echo(`Layer "${e.layer}" has been frozen.`);
    }
  }

  /** LAYTHW: thaws every layer. */
  static async layersThaw(c) {
    c.doc.layers.forEach((l) => {
      l.frozen = false;
    });
    c.echo('All layers thawed.');
  }

  /** LAYLCK: locks the layer of the picked object. */
  static async layerLock(c) {
    const e = await MiscCommands.pickOnLayer(c, 'Select object on layer to be locked');
    if (e) {
      c.doc.layer(e.layer).locked = true;
      c.echo(`Layer "${e.layer}" has been locked.`);
    }
  }

  /** LAYULK: unlocks the layer of the picked object. */
  static async layerUnlock(c) {
    const e = await MiscCommands.pickOnLayer(c, 'Select object on layer to be unlocked');
    if (e) {
      c.doc.layer(e.layer).locked = false;
      c.echo(`Layer "${e.layer}" has been unlocked.`);
    }
  }

  /** LAYMCUR: makes the layer of the picked object current. */
  static async layerMakeCurrent(c) {
    const e = await MiscCommands.pickOnLayer(c, 'Select object whose layer will become current');
    if (e) {
      c.doc.cur.layer = e.layer;
      c.echo(`${e.layer} is now the current layer.`);
    }
  }

  // ---------------------------------------------------------------- hiding single objects
  // (NX / Unigraphics: Hide Ctrl+B, Invert Shown and Hidden Ctrl+Shift+B, Show All Ctrl+Shift+U).
  // A part sent to the hidden space is not drawn, picked, snapped to, plotted or exported; the
  // flag e.hid is saved with the drawing and is part of the undo step.

  /** @private Objects on an off / frozen layer keep their state when hidden and shown are swapped. */
  static swappable(c, e) {
    const l = c.doc.layer(e.layer);
    return e.type !== 'viewport' && l.on && !l.frozen;
  }

  /** @private How many objects of the current space are hidden. */
  static hiddenCount(c) {
    return c.app.curEnts().filter((e) => e.hid && e.type !== 'viewport').length;
  }

  /** @private Takes objects out of the selection. */
  static dropFromSelection(c, ents) {
    for (const e of ents) c.app.sel.delete(e.id);
    c.app.preSel = new Set();
  }

  /** HIDEOBJECTS: sends the selected objects to the hidden space. */
  static async hideObjects(c) {
    const ents = (await c.select('Select objects to hide')).filter(
      (e) => !e.hid && e.type !== 'viewport',
    );
    if (!ents.length) return;
    for (const e of ents) e.hid = true;
    MiscCommands.dropFromSelection(c, ents);
    c.bump();
    c.echo(
      `${ents.length} object(s) sent to the hidden space (${MiscCommands.hiddenCount(c)} hidden in total). Cmd+Shift+B swaps hidden and shown, Cmd+Shift+U shows all.`,
    );
  }

  /** SWAPHIDDEN: shows what is hidden and hides what is shown. */
  static async swapHidden(c) {
    if (!MiscCommands.hiddenCount(c)) {
      c.echo('Nothing is hidden yet: select parts and press Cmd+B (HIDEOBJECTS) first.');
      return;
    }
    const list = c.app.curEnts().filter((e) => MiscCommands.swappable(c, e));
    let shown = 0;
    let hid = 0;
    for (const e of list) {
      if (e.hid) {
        delete e.hid;
        shown += 1;
      } else {
        e.hid = true;
        hid += 1;
      }
    }
    c.app.sel = new Set();
    c.app.preSel = new Set();
    c.bump();
    c.echo(
      `Swapped: ${shown} object(s) are shown now, ${hid} went to the hidden space. Cmd+Shift+B swaps back.`,
    );
  }

  /** SHOWALLOBJECTS: shows everything again. */
  static async showAllObjects(c) {
    let n = 0;
    for (const e of c.app.curEnts()) {
      if (e.hid) {
        delete e.hid;
        n += 1;
      }
    }
    c.bump();
    c.echo(n ? `${n} hidden object(s) shown again.` : 'No object is hidden.');
  }

  // ---------------------------------------------------------------- selection and clipboard

  /** SELECTALL */
  static async selectAll(c) {
    const ents = c.app.curEnts().filter((e) => c.app.selectable(e));
    c.setSel(ents);
    c.echo(`${ents.length} found`);
  }

  /** @private Puts objects on the clipboard. */
  static copyToClipboard(c, ents, base) {
    c.app.clipboard = { base, ents: ents.map((e) => E.clone(e)), blocks: c.doc.blocks };
    c.echo(`${ents.length} object(s) copied to clipboard.`);
  }

  /** @private The lower left corner of the box around objects. */
  static lowerLeft(c, ents) {
    let b = null;
    for (const e of ents) b = E.bboxMerge(b, E.bbox(e, c.doc));
    return b ? { x: b.x0, y: b.y0 } : { x: 0, y: 0 };
  }

  /** @private Copies of the clipboard objects moved to the point p (or left in place when `orig`). */
  static clipboardCopies(c, p, orig) {
    const cb = c.app.clipboard;
    return cb.ents.map((e) => {
      const k = E.clone(e);
      E.xformInPlace(k, orig ? G.M_ID : G.Mtranslate(p.x - cb.base.x, p.y - cb.base.y), c.doc);
      k.id = 0;
      return k;
    });
  }

  /** COPYCLIP */
  static async copyClip(c) {
    const ents = await c.select('Select objects');
    if (ents.length) MiscCommands.copyToClipboard(c, ents, MiscCommands.lowerLeft(c, ents));
  }

  /** COPYBASE: copies with a base point of your choice. */
  static async copyBase(c) {
    const base = await c.point('Specify base point');
    if (!isPt(base)) return;
    const ents = await c.select('Select objects');
    if (ents.length) MiscCommands.copyToClipboard(c, ents, base);
  }

  /** COPYLINK: copies a stable link to the selected entities to the system clipboard. */
  static async copyLink(c){
    const ents=await c.select('Select objects to link');if(!ents.length)return;
    const drawing=encodeURIComponent(c.doc.path||c.doc.name||'Drawing'),ids=ents.map(e=>e.id).join(','),link=`maccad://${drawing}#ids=${ids}`;
    c.app.clipboardText=link;
    try{await globalThis.navigator?.clipboard?.writeText(link);}catch{/* sandbox/browser fallback remains in clipboardText */}
    c.echo(`Link copied for ${ents.length} object(s).`);
  }

  /** CUTCLIP */
  static async cutClip(c) {
    const ents = await c.select('Select objects');
    if (ents.length) {
      MiscCommands.copyToClipboard(c, ents, MiscCommands.lowerLeft(c, ents));
      c.erase(ents);
      c.app.sel.clear();
    }
  }

  /** PASTECLIP: pastes at a point (block definitions the objects need are copied too). */
  static async pasteClip(c) {
    if (!c.app.clipboard) return c.fail('Clipboard is empty.');
    for (const [n, b] of Object.entries(c.app.clipboard.blocks || {})) {
      if (!c.doc.blocks[n]) {
        c.doc.blocks[n] = JSON.parse(JSON.stringify(b));
        c.doc.blockVer += 1;
      }
    }
    const p = await c.point('Specify insertion point', {
      base: c.app.clipboard.base,
      rubber: false,
      preview: (q) => MiscCommands.clipboardCopies(c, q),
    });
    if (!isPt(p)) return undefined;
    c.addAll(MiscCommands.clipboardCopies(c, p));
    return undefined;
  }

  /** PASTEORIG: pastes at the original coordinates. */
  static async pasteOrig(c) {
    if (!c.app.clipboard) return c.fail('Clipboard is empty.');
    c.addAll(MiscCommands.clipboardCopies(c, null, true));
    return undefined;
  }

  /** PASTEBLOCK: pastes the clipboard as a block. */
  static async pasteBlock(c) {
    if (!c.app.clipboard) return c.fail('Clipboard is empty.');
    const p = await c.point('Specify insertion point', { rubber: false });
    if (!isPt(p)) return undefined;
    const name = `A$C${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
    c.doc.defineBlock(name, c.app.clipboard.base, c.app.clipboard.ents);
    c.add(c.mk('insert', { name, p, rot: 0, sx: 1, sy: 1 }));
    return undefined;
  }

  /** PASTESPECIAL: exposes the three lossless internal paste modes in one command. */
  static async pasteSpecial(c){
    const mode=await c.keyword('Paste as [Objects/Block/Original] <Objects>',['Objects','Block','Original'],'Objects');
    if(mode==='Block')return MiscCommands.pasteBlock(c);if(mode==='Original')return MiscCommands.pasteOrig(c);if(mode)return MiscCommands.pasteClip(c);
  }

  /** PASTEHYPERLINK: attaches the URL/text currently on the clipboard to selected entities. */
  static async pasteHyperlink(c){
    let link='';try{link=await globalThis.navigator?.clipboard?.readText()||'';}catch{link=c.app.clipboardText||'';}
    if(!link)link=c.app.clipboardText||'';
    if(!link)link=await c.string('Enter hyperlink',{});if(!link)return;
    const ents=await c.select('Select objects for hyperlink');if(!ents.length)return;for(const e of ents)e.hyperlink=link;c.bump();c.echo(`Hyperlink attached to ${ents.length} object(s).`);
  }

  /** HYPERLINK: opens, attaches or removes an entity hyperlink. */
  static async hyperlink(c){
    const hit=await c.pick('Select object',{filter:e=>!!e});if(!hit?.e)return;const e=hit.e;
    const option=await c.keyword('Hyperlink [Open/Attach/Remove] <Open>',['Open','Attach','Remove'],'Open');if(!option)return;
    if(option==='Remove'){delete e.hyperlink;c.bump();return c.echo('Hyperlink removed.');}
    if(option==='Attach'){const value=await c.string('Enter hyperlink',{def:e.hyperlink||''});if(value){e.hyperlink=value;c.bump();}return;}
    if(!e.hyperlink)return c.fail('The selected object has no hyperlink.');window.open(e.hyperlink,'_blank','noopener');
  }

  // ---------------------------------------------------------------- layouts and viewports

  /** @private The box around the visible model space objects. */
  static modelExtents(c) {
    let b = null;
    for (const e of c.doc.model) if (c.doc.visible(e)) b = E.bboxMerge(b, E.bbox(e, c.doc));
    return b;
  }

  /** MVIEW: makes layout viewports (fit, 2 / 3 / 4 viewports, or a corner pair). */
  static async makeViewport(c) {
    if (c.app.space === 'model') return c.fail('MVIEW works in a layout. Switch to a Layout tab.');
    const lay = c.doc.layouts[c.app.space];
    if (c.app.mspace) c.app.mspace = null;
    const a = await c.point(
      'Specify corner of viewport or\n[ON/OFF/Fit/Hideplot/Lock/Object/Polygonal/Restore/LAyer/2/3/4] <Fit>',
      { kw: ['Fit', '2', '3', '4'], noOrtho: true },
    );
    const mkvp = (p1, p2) => {
      const v = E.mk('viewport', {
        p1: { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y) },
        p2: { x: Math.max(p1.x, p2.x), y: Math.max(p1.y, p2.y) },
        cx: c.doc.modelView.cx,
        cy: c.doc.modelView.cy,
        scale: 1,
        locked: false,
      });
      c.doc.add(v, c.app.space);
      return v;
    };
    const fit = (v) => {
      const b = E.bboxMerge(null, MiscCommands.modelExtents(c));
      if (!b) return;
      const w = v.p2.x - v.p1.x;
      const h = v.p2.y - v.p1.y;
      v.cx = (b.x0 + b.x1) / 2;
      v.cy = (b.y0 + b.y1) / 2;
      v.scale = Math.min(w / Math.max(1e-9, b.x1 - b.x0), h / Math.max(1e-9, b.y1 - b.y0)) * 0.95;
    };
    if (a === null || a === 'Fit') {
      const v = mkvp({ x: 10, y: 10 }, { x: lay.paper.w - 10, y: lay.paper.h - 10 });
      fit(v);
      return undefined;
    }
    if (a === '2' || a === '3' || a === '4') {
      const n = parseInt(a, 10);
      const W = lay.paper.w - 20;
      const H = lay.paper.h - 20;
      const cells = MiscCommands.viewportCells(n);
      for (const [x0, y0, x1, y1] of cells)
        fit(mkvp({ x: 10 + W * x0, y: 10 + H * y0 }, { x: 10 + W * x1, y: 10 + H * y1 }));
      return undefined;
    }
    if (!isPt(a)) return undefined;
    const b = await c.point('Specify opposite corner', {
      base: a,
      rubber: false,
      noOrtho: true,
      preview: (q) => [MiscCommands.windowRect(c, a, q)],
    });
    if (!isPt(b)) return undefined;
    fit(mkvp(a, b));
    return undefined;
  }

  /** @private The viewport cells of MVIEW 2 / 3 / 4 as fractions of the sheet: [x0, y0, x1, y1]. */
  static viewportCells(n) {
    if (n === 2) {
      return [
        [0, 0, 0.5, 1],
        [0.5, 0, 1, 1],
      ];
    }
    if (n === 3) {
      return [
        [0, 0, 0.5, 1],
        [0.5, 0.5, 1, 1],
        [0.5, 0, 1, 0.5],
      ];
    }
    return [
      [0, 0, 0.5, 0.5],
      [0.5, 0, 1, 0.5],
      [0, 0.5, 0.5, 1],
      [0.5, 0.5, 1, 1],
    ];
  }

  /** MSPACE: works inside a layout viewport. */
  static async modelSpace(c) {
    if (c.app.space === 'model') return c.fail('MSPACE works in a layout.');
    const vps = c.doc.spaceList(c.app.space).filter((e) => e.type === 'viewport');
    if (!vps.length) return c.fail('No viewports. Use MVIEW first.');
    let vp = vps[0];
    if (vps.length > 1) {
      const r = await c.pick('Select viewport', { filter: (e) => e.type === 'viewport' });
      if (!r || !r.e) return undefined;
      vp = r.e;
    }
    c.app.activateViewport(vp);
    return undefined;
  }

  /** PSPACE: back to the sheet. */
  static async paperSpace(c) {
    c.app.mspace = null;
    c.app.sel.clear();
    c.app.emit('space');
    c.app.redraw();
  }

  /** @private The layout name to start from: the current layout, or the first one. */
  static defaultLayout(c, names) {
    return c.app.space === 'model' ? names[0] : c.app.space;
  }

  /** LAYOUT: new, delete, rename, copy, set current. */
  static async layout(c) {
    const o = await c.keyword(
      'Enter layout option [Copy/Delete/New/Rename/Set]',
      ['Copy', 'Delete', 'New', 'Rename', 'Set'],
      'Set',
    );
    const names = Object.keys(c.doc.layouts);
    if (o === 'New') {
      const n = await c.string('Enter new layout name', { def: `Layout${names.length + 1}` });
      if (n && !c.doc.layouts[n]) {
        const l = newLayout(n);
        l.ents.forEach((e) => {
          e.id = c.doc.nextId;
          c.doc.nextId += 1;
        });
        c.doc.layouts[n] = l;
        c.app.emit('space');
      }
    } else if (o === 'Delete') {
      const n = await c.string('Enter name of layout to delete', {
        def: MiscCommands.defaultLayout(c, names),
      });
      if (n && c.doc.layouts[n] && names.length > 1) {
        if (c.app.space === n) c.app.switchSpace('model');
        delete c.doc.layouts[n];
        c.app.emit('space');
      }
    } else if (o === 'Rename') {
      const n = await c.string('Enter layout to rename', {
        def: MiscCommands.defaultLayout(c, names),
      });
      if (!c.doc.layouts[n]) return;
      const nn = await c.string('Enter new layout name', {});
      if (nn && !c.doc.layouts[nn]) {
        const l = c.doc.layouts[n];
        l.name = nn;
        const out = {};
        for (const k of Object.keys(c.doc.layouts)) out[k === n ? nn : k] = c.doc.layouts[k];
        c.doc.layouts = out;
        if (c.app.space === n) c.app.space = nn;
        c.app.emit('space');
      }
    } else if (o === 'Copy') {
      const n = await c.string('Enter layout to copy', {
        def: MiscCommands.defaultLayout(c, names),
      });
      if (!c.doc.layouts[n]) return;
      const nn = `${n} (2)`;
      const l = JSON.parse(JSON.stringify(c.doc.layouts[n]));
      l.name = nn;
      l.ents.forEach((e) => {
        e.id = c.doc.nextId;
        c.doc.nextId += 1;
      });
      c.doc.layouts[nn] = l;
      c.app.emit('space');
    } else {
      const n = await c.string('Enter layout to make current', { def: names[0] });
      if (c.doc.layouts[n]) c.app.switchSpace(n);
    }
  }

  /** LAYOUTTEMPLATE: imports one paper-space layout from another MCAD drawing. */
  static async layoutTemplate(c){
    if(!c.app.api)return c.fail('Layout templates require the desktop app.');
    const f=await c.app.api.openFile({filters:[{name:'MacCAD drawing',extensions:['mcad','json']}]});if(!f)return;
    const source=Doc.fromJSON(parseMcad(f)),names=Object.keys(source.layouts);if(!names.length)return c.fail('The selected drawing has no layouts.');
    const picked=await c.string(`Layout name [${names.join('/')}]`,{def:names[0]});if(!source.layouts[picked])return c.fail(`Layout not found: ${picked}`);
    let name=await c.string('New layout name',{def:picked});if(!name)return;for(let n=2;c.doc.layouts[name];n++)name=`${picked} (${n})`;
    const layout=E.clone(source.layouts[picked]);layout.name=name;for(const e of layout.ents)e.id=c.doc.nextId++;
    c.doc.layouts[name]=layout;c.app.switchSpace(name);c.bump();c.echo(`Layout imported: ${name}`);
  }

  // ---------------------------------------------------------------- AutoLISP files and scripts

  /** LOAD: loads an AutoLISP file. */
  static async loadLisp(c) {
    let f = c.arg;
    if (!f) {
      const r = c.app.api
        ? await c.app.api.openFile({
            filters: [{ name: 'AutoLISP', extensions: ['lsp', 'fas', 'vlx'] }],
          })
        : null;
      if (!r) return undefined;
      f = r.path;
    }
    const t = await c.app.fs.readLisp(f);
    if (t === null) return c.fail(`Cannot open ${f}`);
    await c.app.lisp.evalString(t, { source: f });
    c.echo(`AutoLISP file loaded: ${f}`);
    return undefined;
  }

  /** SCRIPT: runs a script file (a list of commands). */
  static async script(c) {
    let text = null;
    let name = c.arg;
    if (name) text = await c.app.fs.readText(name);
    else {
      const r = c.app.api
        ? await c.app.api.openFile({ filters: [{ name: 'Script', extensions: ['scr', 'txt'] }] })
        : null;
      if (r) {
        text = r.data;
        name = r.path;
      }
    }
    if (text === null) return;
    c.echo(`Running script ${name}`);
    c.app.cancelReq();
    setTimeout(() => c.app.runScript(text), 0);
  }

  // ---------------------------------------------------------------- registration

  /** Registers the commands of this file, in the order they were defined before the reorganisation (a later definition of a name wins). */
  static register() {
    MiscCommands.registerView();
    MiscCommands.registerSettings();
    MiscCommands.registerInquiry();
    MiscCommands.registerLayers();
    MiscCommands.registerSelectionAndClipboard();
    MiscCommands.registerFiles();
    MiscCommands.registerLayouts();
    MiscCommands.registerLisp();
  }

  /** @private ZOOM, PAN, REGEN. */
  static registerView() {
    def('ZOOM Z', MiscCommands.zoom);
    def('PAN P', MiscCommands.pan);
    def('REGEN RE REGENALL REDRAW R', MiscCommands.regen);
  }

  /** @private Grid, snap, toggles, settings windows, linetype scale. */
  static registerSettings() {
    def('GRID', MiscCommands.grid);
    def('GRIDSTYLE', MiscCommands.gridStyle);
    def('-SNAP SNAPSPACING', MiscCommands.snapSpacing);
    def('ORTHO', async (c) => c.app.toggle('ortho'));
    def('POLAR', async (c) => c.app.toggle('polar'));
    def('OTRACK', async (c) => c.app.toggle('otrack'));
    def('DYN', async (c) => c.app.toggle('dyn'));
    def('LWT', async (c) => c.app.toggle('lwt'));
    def('OSNAPTOGGLE', async (c) => c.app.toggle('osnap'));
    def('OSNAP OS SNAP DDOSNAP', async (c) => {
      await c.ui.draftingDialog(c, 2);
    }); // opens the Object Snap tab; `snap` is the shortcut
    def('DSETTINGS DS SE', async (c) => {
      await c.ui.draftingDialog(c, 0);
    });
    def('OPTIONS OP SETTINGS', async (c) => {
      await c.ui.optionsDialog(c);
    });
    def('UNITS UN DDUNITS', async (c) => {
      await c.ui.unitsDialog(c);
    });
    def('LTSCALE LTS', MiscCommands.lineTypeScale);
    def('-LTSCALE -LTS', MiscCommands.askLineTypeScale);
  }

  /** @private DIST, ID, AREA, LIST, STATUS. */
  static registerInquiry() {
    def('DIST DI DISTANCE', MiscCommands.distance);
    def('ID', MiscCommands.id);
    def('AREA AA', MiscCommands.area);
    def('LIST LI LS', MiscCommands.list);
    def('STATUS', MiscCommands.status);
  }

  /** @private Layers, properties and hiding single objects. */
  static registerLayers() {
    def('LAYER LA DDLMODES', async (c) => {
      await c.ui.layerManager(c);
    });
    def('COLOR COL DDCOLOR', MiscCommands.color);
    def('LINETYPE LT LTYPE', async (c) => {
      await c.ui.linetypeDialog(c);
    });
    def('LWEIGHT LW LINEWEIGHT', async (c) => {
      c.app.toggle('lwt');
    });
    def('PROPERTIES CH PR DDCHPROP MO', async (c) => {
      c.ui.toggleProps();
    });
    def('CLOSE_PROPS', async (c) => {
      c.ui.toggleProps(false);
    });
    def('LAYISO', MiscCommands.layerIsolate);
    def('LAYUNISO', MiscCommands.layersOn('All layers restored.'));
    def('LAYOFF', MiscCommands.layerOff);
    def('LAYON', MiscCommands.layersOn('All layers are on.'));
    def('LAYFRZ', MiscCommands.layerFreeze);
    def('LAYTHW', MiscCommands.layersThaw);
    def('LAYLCK', MiscCommands.layerLock);
    def('LAYULK', MiscCommands.layerUnlock);
    def('HIDEOBJECTS HIDEOBJ', MiscCommands.hideObjects);
    def('SWAPHIDDEN HIDESWAP', MiscCommands.swapHidden);
    def('SHOWALLOBJECTS UNHIDEALL', MiscCommands.showAllObjects);
    def('LAYMCUR', MiscCommands.layerMakeCurrent);
  }

  /** @private UNDO, REDO, selection, clipboard. */
  static registerSelectionAndClipboard() {
    def('UNDO U', async (c) => {
      c.app.undo();
    });
    def('REDO', async (c) => {
      setTimeout(() => c.app.redo(), 0);
    }); // after the command wrapper has finished, otherwise it would record itself as a new undo step and wipe the redo list
    def('SELECTALL AI_SELALL', MiscCommands.selectAll);
    def('QSELECT', async (c) => {
      await c.ui.qselectDialog(c);
    });
    def('FIND', async (c) => {
      await c.ui.findDialog(c);
    });
    def('COPYCLIP', MiscCommands.copyClip);
    def('COPYBASE', MiscCommands.copyBase);
    def('CUTCLIP', MiscCommands.cutClip);
    def('PASTECLIP', MiscCommands.pasteClip);
    def('PASTEORIG', MiscCommands.pasteOrig);
    def('PASTEBLOCK', MiscCommands.pasteBlock);
    def('COPYLINK', MiscCommands.copyLink);
    def('PASTEHYPERLINK', MiscCommands.pasteHyperlink);
    def('PASTESPECIAL', MiscCommands.pasteSpecial);
    def('HYPERLINK', MiscCommands.hyperlink);
  }

  /** @private File, plot and help commands. */
  static registerFiles() {
    def('NEW', async (c) => {
      await c.ui.io.newDrawing(c.app);
    });
    def('OPEN', async (c) => {
      await c.ui.io.openFile(c.app);
    });
    def('SAVE QSAVE', async (c) => {
      await c.ui.io.saveFile(c.app, false);
    });
    def('SAVEAS', async (c) => {
      await c.ui.io.saveFile(c.app, true);
    });
    def('CLOSE CL', async (c) => {
      await c.ui.io.newDrawing(c.app, true);
    });
    def('QUIT EXIT', async (c) => {
      await c.ui.io.quit(c.app);
    });
    def('EXPORT EXP DXFOUT', async (c) => {
      await c.ui.io.exportDialog(c);
    });
    def('DXFIN IMPORT IMP', async (c) => {
      await c.ui.io.importDxf(c.app);
    });
    def('PLOT PRINT', async (c) => {
      await c.ui.plotDialog(c);
    });
    def('PREVIEW PRE', async (c) => {
      await c.ui.plotDialog(c, true);
    });
    def('PAGESETUP', async (c) => {
      await c.ui.pageSetupDialog(c);
    });
    def('ABOUT', async (c) => {
      await c.ui.aboutDialog();
    });
    def('HELP', async (c) => {
      await c.ui.helpDialog();
    });
    def('TEXTSCR', async (c) => c.ui.showTextWindow(true));
    def('GRAPHSCR', async (c) => c.ui.showTextWindow(false));
  }

  /** @private Layouts and viewports. */
  static registerLayouts() {
    def('MVIEW MV', MiscCommands.makeViewport);
    def('MSPACE MS', MiscCommands.modelSpace);
    def('PSPACE PS', MiscCommands.paperSpace);
    def('LAYOUT', MiscCommands.layout);
    def('LAYOUTTEMPLATE', MiscCommands.layoutTemplate);
  }

  /** @private AutoLISP windows and files, and scripts. */
  static registerLisp() {
    def('APPLOAD AP APLOAD', async (c) => {
      await c.ui.appLoadDialog(c);
    });
    def('VLIDE VLISP VLIDE_OPEN', async (c) => {
      c.ui.vlideDialog(c);
    });
    def('LOAD', MiscCommands.loadLisp);
    def('SCRIPT SCR', MiscCommands.script);
    alias('DIM', 'DIMSTYLE');
  }

  /** XREF / ATTACH: attaches a drawing file as a tracked block reference. */
  static async xref(c) {
    const option=await c.keyword('External reference [Attach/Detach/List] <Attach>',['Attach','Detach','List'],'Attach');if(!option)return;
    const refs=()=>c.doc.model.filter(e=>e.type==='insert'&&e.xref);
    if(option==='List'){const list=refs();if(!list.length)return c.echo('External references: none.');for(const e of list)c.echo(`${e.name}: ${c.doc.blocks[e.name]?.sourcePath||'(embedded source)'}`);return;}
    if(option==='Detach'){const chosen=await c.select('Select external references to detach',{filter:e=>e.type==='insert'&&e.xref});if(!chosen.length)return;c.erase(chosen);for(const e of chosen)if(!c.doc.model.some(x=>x.type==='insert'&&x.name===e.name))delete c.doc.blocks[e.name];c.bump();return c.echo(`${chosen.length} external reference(s) detached.`);}
    const name=await c.ui.io.pickBlockFile(c);if(!name)return;const p=await c.point('Specify insertion point',{preview:q=>[c.mk('insert',{name,p:q,rot:0,sx:1,sy:1,xref:true})]});if(!isPt(p))return;
    c.add(c.mk('insert',{name,p:{...p},rot:0,sx:1,sy:1,xref:true}));c.echo(`External reference attached: ${name}`);
  }

  /** XCLIP: stores a rectangular or polygon clipping boundary on a block/xref insertion. */
  static async xclip(c){
    const hit=await c.pick('Select block or external reference',{filter:e=>e.type==='insert'});if(!hit?.e)return;
    const option=await c.keyword('Clip option [New/Delete] <New>',['New','Delete'],'New');if(!option)return;
    if(option==='Delete'){delete hit.e.clip;c.bump();return c.echo('Clipping boundary removed.');}
    const shape=await c.keyword('Boundary [Rectangular/Polygonal] <Rectangular>',['Rectangular','Polygonal'],'Rectangular');if(!shape)return;let pts=[];
    if(shape==='Rectangular'){const a=await c.point('Specify first corner');if(!isPt(a))return;const b=await c.point('Specify opposite corner',{base:a});if(!isPt(b))return;pts=[{x:a.x,y:a.y},{x:b.x,y:a.y},{x:b.x,y:b.y},{x:a.x,y:b.y}];}
    else for(;;){const p=await c.point(pts.length?'Specify next clipping point; Enter finishes':'Specify first clipping point',{base:pts.at(-1)});if(!isPt(p))break;pts.push({x:p.x,y:p.y});}
    if(pts.length<3)throw new Error('A clipping boundary needs at least three points.');hit.e.clip={pts};c.bump();c.echo('Block clipping boundary applied.');
  }
}

MiscCommands.register();

def('XREF XR ATTACH AT',MiscCommands.xref);
def('XCLIP XC',MiscCommands.xclip);
