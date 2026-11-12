/**
 * @file app.js
 * @brief The application core: state, input requests (point / select / keyword ...), cursor
 *        resolution (snap, ortho, polar, tracking), mouse and keyboard input, the command runner
 *        with undo, view control (zoom, pan, 3D) and drawing tabs.
 *
 * `createApp(canvas)` makes the application object that every other file receives as `app`
 * (commands get it as `c.app`). The object is an event source: `app.on('doc' | 'selection' |
 * 'settings' | 'view' | 'view3d' | 'space' | 'prompt' | 'echo', fn)`.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */

import * as G from './geom.js';
import * as E from './entities.js';
import { Doc } from './doc.js';
import { View, Renderer } from './render.js';
import { findSnap, constrainAngle, orthoPoint, gridSnap, trackPoint, OSNAP_LABEL } from './snap.js';
import { parseDist, parseAng, fmtLen, fmtAng } from './units.js';
import { COMMANDS, ALIASES, CANCEL, CmdError } from './commands.js';
import { createLisp } from './lispcad.js';
import { makeFs } from './fsbridge.js';
import { fontStack, loadFonts } from './fonts.js';
import { View3D, PlaneView, PRESETS, PRESET_LABELS, rayTri } from './view3d.js';
import * as K from './kernel3d.js';
import { modelExtents } from './svg.js';
import { license, OUTPUT_COMMANDS, KEEP_COMMANDS } from './license.js';
import * as S3 from './selection3d.js';
import { commandAvailable, unavailableMessage } from './features.js';

export { CANCEL, CmdError };

/* ============================================================================================
 * 2. SETTINGS AND TABLES
 * ========================================================================================== */

/** The settings (saved in localStorage) with their default values. */
const DEFAULT_SETTINGS = {
  ortho: false,
  polar: false,
  snap: false,
  grid: true,
  osnap: true,
  otrack: false,
  dyn: true,
  lwt: false,
  osnapModes: ['end', 'mid', 'cen', 'int'],
  osnap3d: { vertex: true, edgeMid: true, center: true, knot: false, perp: false, near: false },
  polarInc: 90,
  gridSpacing: 10,
  snapSpacing: 10,
  crosshair: 100,
  ucsIcon: true,
  grips: true,
  zoomWheelReverse: false,
  vstyle: '2dwireframe',
  paperBg: true,
  uiMode: 'advanced',
  theme: 'system',
  modelingTolerance: 0.000001,
  keepModelingInputs: false,
  paletteFloat: false,
  uiModeChosen: false,
  whiteBg: false,
  aperture: 10,
  pickbox: 4,
  selectionPreview3d: true,
  faceUcs: true,
  selectionAperture3d: 14,
  scene: 'none',
  studioEdges: false,
  floorReflect: true,
  gridStyle: 'lines',
  gridMajor: 5,
};

// Commands whose geometry can live in a planar local coordinate system while the camera is in a
// front / back / left / right view.  The 2D geometry kernel remains the source of truth; the plane
// only places its result in model space.
const PLANE_DRAW_COMMANDS = new Set([
  'LINE', 'XLINE', 'RAY', 'PLINE', 'MLINE', 'CIRCLE', 'DONUT', 'ARC', 'ELLIPSE', 'RECTANG',
  'POLYGON', 'SPLINE', 'POINT', 'TEXT', 'MTEXT', 'HATCH', 'LEADER', 'MLEADER',
]);
const PLANE_EDIT_COMMANDS = new Set([
  'MOVE', 'COPY', 'ROTATE', 'SCALE', 'MIRROR', 'STRETCH', 'OFFSET', 'ARRAY', 'GRIP',
]);

/* ============================================================================================
 * 3. THE APPLICATION OBJECT
 * ========================================================================================== */

/**
 * The application: state and the methods to change it. Everything the user can do goes through this
 * object (`c.app` in commands).
 */
export class App {
  /**
   * Creates the application state: the open drawings, the active view, settings, selection, the
   * current input request and the transient things drawn while a command waits for input.
   */
  constructor() {
    this.doc = new Doc();
    this.tabs = [{ doc: this.doc, st: null }];
    this.tabIndex = 0; // open drawings (one tab each); this.doc is the active one
    this.space = 'model';
    this.view = new View(this.doc.modelView);
    this.sel = new Set();
    this.preSel = new Set();
    this.prevSel = [];
    this.temp = [];
    this.hidden = new Set();
    this.settings = this.loadSettings();
    this.settings.vstyle = '2dwireframe'; // sessions start in the 2D view; the last 3D style is kept in vstylePref
    this.req = null;
    this.running = null;
    this.cmdName = '';
    this.lastCmd = '';
    this.cmdHistory = [];
    this.cursor = null;
    this.cursorW = { x: 0, y: 0 };
    this.resolved = { x: 0, y: 0 };
    this.mouseIn = false;
    this.hover = null;
    this.snapMarker = null;
    this.acquired = [];
    this.extAcq = [];
    this.parAcq = [];
    this.trackLines = null;
    this.polarLine = null;
    this.rubber = null;
    this.hotGrip = null;
    this.hoverGrip = null;
    this.lastPoint = { x: 0, y: 0 };
    this.mspace = null;
    this.clipboard = null;
    this.viewHistory = [];
    this.log = [];
    this.ui = null; // set by ui.js
    this.listeners = {};
    this.overrideSnap = null;
    this.renderer = null;
    this.keys = { shift: false, ctrl: false };
    this.selDrag = null;
    this.v3 = null;
    this.commandPlane = null;
    this.edgeHl = [];
    this.faceHl = [];
    this.faceHover = null;
    this.planeHover = null;
    this.cv = null;
    this.v3Saved = null;
  }

  // ---------------------------------------------------------------- settings / events

  /** Reads the settings from localStorage (missing values get the defaults). */
  loadSettings() {
    let s = {};
    try {
      s = JSON.parse(localStorage.getItem('maccad.settings') || '{}');
    } catch {
      /* ignore */
    }
    // 2026-10: layouts are drawn as a white sheet by default; an older saved choice of "off" is moved over once
    if (!s.paperBgV2) {
      s.paperBg = true;
      s.paperBgV2 = true;
    }
    return { ...DEFAULT_SETTINGS, ...s };
  }

  /** Writes the settings to localStorage. */
  saveSettings() {
    try {
      localStorage.setItem('maccad.settings', JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
  }

  /**
   * Listens to an application event ('doc', 'selection', 'settings', 'view', 'view3d', 'space',
   * 'prompt', 'echo', ...).
   */
  on(ev, fn) {
    (this.listeners[ev] ||= []).push(fn);
  }

  /** Stops listening to an application event. */
  off(ev, fn) {
    this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn);
  }

  /** Tells the listeners of an event. */
  emit(ev, ...a) {
    (this.listeners[ev] || []).forEach((f) => f(...a));
  }

  /** Switches a boolean setting and redraws. */
  toggle(key) {
    this.settings[key] = !this.settings[key];
    if (key === 'lwt') this.doc.props.lwdisplay = this.settings.lwt;
    this.saveSettings();
    this.emit('settings');
    this.redraw();
    this.echo(`<${key.toUpperCase()} ${this.settings[key] ? 'on' : 'off'}>`);
  }

  /** Changes a setting, saves it and redraws. */
  set(key, val) {
    this.settings[key] = val;
    this.saveSettings();
    this.emit('settings');
    this.redraw();
  }

  /** Writes a line to the command window. */
  echo(msg) {
    this.log.push(msg);
    if (this.log.length > 2000) this.log.shift();
    this.emit('echo', msg);
  }

  /** Asks for a redraw of the canvas. */
  redraw() {
    if (this.renderer) this.renderer.request();
  }

  /** The drawing changed: clears the geometry caches, tells the listeners and redraws. */
  changed() {
    E.bump();
    this.emit('doc');
    this.redraw();
  }

  // ---------------------------------------------------------------- document / space

  /** Replaces the document of the active tab. */
  setDoc(doc) {
    const t = this.tabs[this.tabIndex];
    if (t) {
      t.doc = doc;
      t.st = null;
    }
    this.doc = doc;
    this.space = 'model';
    this.mspace = null;
    this.view = new View(doc.modelView);
    this.view.w = this.cvW || 800;
    this.view.h = this.cvH || 600;
    this.sel.clear();
    this.preSel.clear();
    this.hover = null;
    this.viewHistory = [];
    E.bump();
    this.emit('doc');
    this.emit('space');
    this.zoomExtents(false);
    this.redraw();
  }

  // ---------------------------------------------------------------- drawing tabs

  /**
   * @returns {boolean} true for a new drawing that was never touched (it may be replaced when a
   *     file is opened).
   */
  isPristine(doc) {
    return !doc.dirty && !doc.path && !doc.sourcePath && !doc.model.length && !doc.undoStack.length;
  }

  /** @returns {number} the tab index of a document, -1 when it is not open. */
  tabOf(doc) {
    return this.tabs.findIndex((t) => t.doc === doc);
  }

  /** Leaves the active drawing: remembers its window state (view, space, 3D view, selection). */
  leaveTab() {
    const t = this.tabs[this.tabIndex];
    if (!t) return;
    this.cancelReq();
    this.clearTransient();
    const was3 = !!this.v3;
    const vstyle = this.settings.vstyle;
    if (was3) this.exit3D();
    this.saveView();
    t.st = {
      space: this.space,
      mspace: this.mspace,
      was3,
      vstyle,
      viewHistory: this.viewHistory,
      sel: [...this.sel],
    };
  }

  /** Makes the document of tab `t` the active drawing and restores its window state. */
  enterTab(t, fresh = false) {
    const doc = t.doc;
    const st = t.st;
    this.doc = doc;
    this.hidden = new Set();
    this.temp = [];
    this.edgeHl = [];
    this.faceHl = [];
    this.faceHover = null;
    this.planeHover = null;
    this.v3 = null;
    this.space = st && (st.space === 'model' || doc.layouts[st.space]) ? st.space : 'model';
    this.mspace = st ? st.mspace : null;
    this.view = new View(this.space === 'model' ? doc.modelView : doc.layouts[this.space].view);
    this.view.w = this.cvW || 800;
    this.view.h = this.cvH || 600;
    this.sel = new Set(st ? st.sel.filter((id) => this.curEnts().some((e) => e.id === id)) : []);
    this.preSel = new Set();
    this.hover = null;
    this.viewHistory = st ? st.viewHistory : [];
    this.settings.vstyle = '2dwireframe';
    if (doc.props && typeof doc.props.lwdisplay === 'boolean')
      this.settings.lwt = doc.props.lwdisplay; // LWDISPLAY is saved with the drawing
    // a drawing with solids needs the 3D kernel to show them: it is loaded in the background as soon as such a drawing is shown (it used to wait for the first 3D command)
    if (!K.kernelReady() && doc.model.some((e) => e.type === 'solid3d'))
      K.initKernel()
        .then(() => {
          E.bump();
          this.redraw();
        })
        .catch((err) => this.echo(`The 3D kernel could not be loaded: ${err.message}`));
    E.bump();
    this.emit('doc');
    this.emit('space');
    this.emit('selection');
    this.emit('tabs');
    this.emit('settings');
    if (fresh) this.zoomExtents(false);
    if (st && st.was3) {
      this.settings.vstyle = st.vstyle;
      this.enter3D(null);
    } else if (fresh && doc.props && doc.props.open3d) {
      this.settings.vstyle = this.settings.vstylePref || 'hidden';
      this.enter3D(doc.props.open3d === true ? 'swiso' : doc.props.open3d);
    } else {
      this.emit('view3d');
      this.emit('settings');
    }
    this.redraw();
  }

  /** Switches to tab i. */
  activateTab(i) {
    if (i === this.tabIndex || i < 0 || i >= this.tabs.length) return;
    this.leaveTab();
    this.tabIndex = i;
    this.enterTab(this.tabs[i]);
  }

  /** Switches to the next (or, with -1, the previous) tab. */
  nextTab(d = 1) {
    if (this.tabs.length > 1)
      this.activateTab((this.tabIndex + d + this.tabs.length) % this.tabs.length);
  }

  /**
   * Opens a drawing in a new tab (a pristine, untouched blank drawing is simply replaced); a
   * drawing that is already open is only shown.
   * @returns {Doc} the document that is shown
   */
  openTab(doc, { keepBlank = false } = {}) {
    const key = doc.path || doc.sourcePath;
    if (key) {
      const i = this.tabs.findIndex((t) => (t.doc.path || t.doc.sourcePath) === key);
      if (i >= 0) {
        this.activateTab(i);
        this.echo(`${doc.name} is already open.`);
        return this.tabs[i].doc;
      }
    }
    const cur = this.tabs[this.tabIndex];
    if (cur && !keepBlank && this.isPristine(cur.doc)) {
      cur.doc = doc;
      cur.st = null;
      this.cancelReq();
      this.enterTab(cur, true);
      return doc;
    }
    this.leaveTab();
    const t = { doc, st: null };
    this.tabs.push(t);
    this.tabIndex = this.tabs.length - 1;
    this.enterTab(t, true);
    return doc;
  }

  /** Closes tab i without asking (the caller has handled unsaved changes). */
  dropTab(i) {
    if (this.tabs.length === 1) {
      this.tabs[0] = { doc: new Doc(), st: null };
      this.tabIndex = 0;
      this.cancelReq();
      this.v3 = null;
      this.enterTab(this.tabs[0], true);
      return;
    }
    const wasActive = i === this.tabIndex;
    if (wasActive) {
      this.cancelReq();
      this.clearTransient();
      this.v3 = null;
    }
    this.tabs.splice(i, 1);
    if (!wasActive) {
      if (i < this.tabIndex) this.tabIndex -= 1;
      this.emit('tabs');
      return;
    }
    this.tabIndex = Math.min(i, this.tabs.length - 1);
    this.enterTab(this.tabs[this.tabIndex]);
  }

  /** Moves a tab to another position (drag and drop of the tab strip). */
  moveTab(from, to) {
    if (from === to || from < 0 || to < 0 || from >= this.tabs.length || to >= this.tabs.length)
      return;
    const cur = this.tabs[this.tabIndex];
    const [t] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, t);
    this.tabIndex = this.tabs.indexOf(cur);
    this.emit('tabs');
  }

  /**
   * @returns {object[]} the objects of the space that is being worked in (model space inside a
   *     viewport).
   */
  curEnts() {
    return this.mspace ? this.doc.model : this.doc.spaceList(this.space);
  }

  /** @returns {string} the space new objects go to. */
  targetSpace() {
    return this.mspace ? 'model' : this.space;
  }

  /** @returns {object|null} the layout viewport that is active for editing (MSPACE), or null. */
  viewport() {
    return this.mspace ? this.doc.spaceList(this.space).find((e) => e.id === this.mspace) : null;
  }

  /** @returns the view that maps the cursor: the 3D view, the viewport view or the main view. */
  activeView() {
    if (this.v3) return this.v3;
    const vp = this.viewport();
    return vp ? this.view.sub(vp) : this.view;
  }

  /** @returns the view the renderer draws with (the 3D view or the main view). */
  activeViewDraw() {
    return this.v3 || this.view;
  }

  /** Plane parallel to the current orthographic side view, through the camera target. */
  sideDrawingPlane() {
    if (!this.v3 || !['front', 'back', 'left', 'right'].includes(this.v3.preset)) return null;
    const { r, u } = this.v3.basis();
    const n = [
      r[1] * u[2] - r[2] * u[1],
      r[2] * u[0] - r[0] * u[2],
      r[0] * u[1] - r[1] * u[0],
    ];
    const o = this.v3.preset === 'front' || this.v3.preset === 'back'
      ? [0, this.v3.target[1], 0]
      : [this.v3.target[0], 0, 0];
    return { o, x: [...r], y: [...u], n };
  }

  /** A plane through the view target, perpendicular to the viewing direction (X right, Y up on the screen) in any 3D view. */
  viewPlane() {
    if (!this.v3) return null;
    const { r, u } = this.v3.basis();
    const n = [r[1] * u[2] - r[2] * u[1], r[2] * u[0] - r[0] * u[2], r[0] * u[1] - r[1] * u[0]];
    return { o: [...this.v3.target], x: [...r], y: [...u], n };
  }

  /** Plane of the picked solid face, oriented so local X/Y follow screen right/up. */
  faceDrawingPlane(hit) {
    if (!hit || !this.v3) return null;
    const n0 = hit.n;
    const nl = Math.hypot(...n0) || 1;
    const n = n0.map((q) => q / nl);
    const { r, u } = this.v3.basis();
    let x = r.map((q, i) => q - n[i] * (r[0] * n[0] + r[1] * n[1] + r[2] * n[2]));
    let xl = Math.hypot(...x);
    if (xl < 1e-8) {
      const a = S3.faceAxes(n);
      if (!a) return null;
      x = a.x;
      xl = 1;
    }
    x = x.map((q) => q / xl);
    let y = [
      n[1] * x[2] - n[2] * x[1],
      n[2] * x[0] - n[0] * x[2],
      n[0] * x[1] - n[1] * x[0],
    ];
    if (y[0] * u[0] + y[1] * u[1] + y[2] * u[2] < 0) {
      x = x.map((q) => -q);
      y = y.map((q) => -q);
    }
    return { o: [...hit.p], x, y, n };
  }

  /** The plane used by the current draw/edit command, if it is working on planar 3D geometry. */
  activeDrawingPlane() {
    if (!this.v3) return null;
    if (this.commandPlane) return this.commandPlane;
    if (PLANE_EDIT_COMMANDS.has(this.cmdName)) {
      const picked = this.curEnts().filter((e) => this.preSel.has(e.id) || this.sel.has(e.id));
      const planes = picked.map((e) => e.plane).filter(Boolean);
      if (planes.length && planes.length === picked.length) {
        const key = JSON.stringify(planes[0]);
        if (planes.every((p) => JSON.stringify(p) === key)) return planes[0];
      }
    }
    if ((PLANE_DRAW_COMMANDS.has(this.cmdName) || PLANE_EDIT_COMMANDS.has(this.cmdName)) && this.doc.ucs?.current)
      return this.doc.ucs.current;
    return PLANE_DRAW_COMMANDS.has(this.cmdName) ? this.sideDrawingPlane() : null;
  }

  /** View used for command points and temporary geometry. */
  inputView() {
    const p = this.activeDrawingPlane();
    return p && this.v3 ? new PlaneView(this.v3, p) : this.activeView();
  }

  // ---------------------------------------------------------------- 3D view state

  /** @returns {object[]} the visible 3D solids of the current space. */
  solids() {
    return this.curEnts().filter((e) => e.type === 'solid3d' && this.doc.visible(e));
  }

  /** Switches to a 3D view with a preset (default SW isometric). */
  enter3D(preset = 'swiso') {
    if (this.space !== 'model') this.switchSpace('model');
    if (!this.v3) {
      const v = new View3D({
        w: this.view.w,
        h: this.view.h,
        persp: false,
        elev: this.doc.elev || 0,
      });
      if (this.doc.view3d)
        Object.assign(v, this.doc.view3d, {
          target: [...this.doc.view3d.target],
          w: this.view.w,
          h: this.view.h,
        });
      else v.dist = (this.view.h / this.view.zoom / 2 / Math.tan(v.fov / 2)) * 1.0;
      v.target = [this.view.cx, this.view.cy, 0];
      this.v3 = v;
      if (!this.doc.view3d) this.zoomExtents(false);
    }
    if (preset) this.v3.setPreset(preset);
    if (this.settings.vstyle === '2dwireframe')
      this.settings.vstyle = this.settings.vstylePref || 'hidden';
    this.emit('view3d');
    this.emit('settings');
    this.changed();
  }

  /** Goes back to the plan (2D) view and remembers the 3D view. */
  exit3D() {
    if (!this.v3) return;
    this.doc.view3d = this.v3.save();
    this.doc.elev = this.v3.elev;
    this.view.cx = this.v3.target[0];
    this.view.cy = this.v3.target[1];
    this.view.zoom = this.v3.zoom;
    this.v3 = null;
    this.settings.vstyle = '2dwireframe';
    this.edgeHl = [];
    this.emit('view3d');
    this.emit('settings');
    this.changed();
  }

  /**
   * Sets the visual style (2D wireframe, wireframe, hidden, conceptual, shaded, shaded with edges,
   * x-ray). 2D wireframe leaves the 3D view.
   */
  setVisualStyle(name) {
    if (name === '2dwireframe') {
      this.settings.vstyle = '2dwireframe';
      this.exit3D();
      this.saveSettings();
      this.emit('settings');
      this.changed();
      return;
    }
    this.settings.vstyle = name;
    this.settings.vstylePref = name;
    this.saveSettings();
    if (!this.v3) this.enter3D('top');
    else {
      this.emit('view3d');
      this.emit('settings');
      this.changed();
    }
  }

  /** Turns the 3D view to a preset (top, front, SW isometric, ...). */
  setPreset3D(name) {
    if (!this.v3) this.enter3D(name);
    else {
      this.v3.setPreset(name);
      this.emit('view3d');
      this.changed();
    }
    if (this.v3.preset === 'top' && this.settings.vstyle === 'hidden') {
      /* stays 3D so solids shade */
    }
  }

  /** @returns {string} the name of the current view for the viewport label. */
  presetLabel() {
    return this.v3 ? PRESET_LABELS[this.v3.preset] || 'Custom View' : '2D Wireframe';
  }

  /** @returns the ray through a screen pixel in the 3D view (null in 2D). */
  ray(sx, sy) {
    return this.v3 ? this.v3.ray(sx, sy) : null;
  }

  /**
   * The nearest solid under a pixel (ray cast against the triangles).
   * @returns {{e, t, point}|null}
   */
  pickSolid(sx, sy, only) {
    if (!this.v3 || !K.kernelReady()) return null;
    const { o, d } = this.v3.ray(sx, sy);
    let best = null;
    for (const e of this.solids()) {
      if (this.doc.locked(e) || (only && !only.includes(e))) continue;
      let m;
      try {
        m = K.solidMesh(e);
      } catch {
        continue;
      }
      const b = m.bounds;
      if (!rayBoxHit(o, d, b)) continue;
      for (let i = 0; i < m.idx.length; i += 3) {
        const a = vtx(m.pos, m.idx[i]);
        const bb = vtx(m.pos, m.idx[i + 1]);
        const c = vtx(m.pos, m.idx[i + 2]);
        const t = rayTri(o, d, a, bb, c);
        if (t !== null && (!best || t < best.t))
          best = { e, t, tri: i, p: [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t] };
      }
    }
    return best;
  }

  /**
   * The face of a solid under a pixel.
   * @returns {{e, face: {start, count, faceId}, p, n}|null} face = index range in the solid's mesh,
   *     p = point on the face, n = outward normal
   */
  pickFace(sx, sy, only) {
    const hit = this.pickSolid(sx, sy, only);
    if (!hit) return null;
    const m = K.solidMesh(hit.e);
    const g = m.faceGroups.find((f) => hit.tri >= f.start && hit.tri < f.start + f.count);
    if (!g) return null;
    return { e: hit.e, face: g, p: hit.p, n: vtx(m.nrm, m.idx[hit.tri]) };
  }

  /** The clickable XY/YZ/ZX cutting-plane card under a screen pixel. */
  pickPlaneChoice(sx, sy, picker = this.req && this.req.opts.planePicker) {
    if (!this.v3 || !picker?.choices?.length) return null;
    return S3.pickPlaneChoice(
      picker.choices,
      (p) => this.v3.w2s({ x: p[0], y: p[1], z: p[2] }),
      sx,
      sy,
      picker.margin ?? 12,
    );
  }

  /**
   * The nearest solid edge to a pixel.
   * @returns {{e, edge: {id, pts}, dist}|null}
   */
  pickEdge(sx, sy, tolPx = 9, only) {
    if (!K.kernelReady()) return null;
    const v = this.activeView();
    let best = null;
    for (const e of this.solids()) {
      if (this.doc.locked(e) || (only && !only.includes(e))) continue;
      for (const ed of E.solidEdges(e))
        for (let i = 0; i + 1 < ed.pts.length; i += 1) {
          const a = v.w2s({ x: ed.pts[i][0], y: ed.pts[i][1], z: ed.pts[i][2] });
          const b = v.w2s({ x: ed.pts[i + 1][0], y: ed.pts[i + 1][1], z: ed.pts[i + 1][2] });
          const d = G.segDist({ x: sx, y: sy }, a, b);
          if (d <= tolPx && (!best || d < best.dist)) best = { e, edge: ed, dist: d };
        }
    }
    return best;
  }

  /**
   * @returns the viewport view an object of the model is seen through in a layout (null otherwise).
   */
  entView(e) {
    if (this.v3 && e?.plane) return new PlaneView(this.v3, e.plane);
    const vp = this.viewport();
    return vp && this.doc.model.includes(e) ? this.view.sub(vp) : null;
  }

  /** Stores the main view in the drawing (model view or layout view). */
  saveView() {
    const v = this.view.save();
    if (this.space === 'model') this.doc.modelView = v;
    else this.doc.layouts[this.space].view = v;
  }

  /** Switches between model space and a layout. */
  switchSpace(name) {
    if (name === this.space) return;
    this.cancelReq();
    this.saveView();
    this.space = name;
    this.mspace = null;
    const sv = name === 'model' ? this.doc.modelView : this.doc.layouts[name].view;
    this.view = new View(sv);
    this.view.w = this.cvW || 800;
    this.view.h = this.cvH || 600;
    this.sel.clear();
    this.preSel.clear();
    this.viewHistory = [];
    this.emit('space');
    this.changed();
  }

  /** Makes a layout viewport active for editing the model through it (MSPACE). */
  activateViewport(vp) {
    this.mspace = vp.id;
    this.sel.clear();
    this.emit('space');
    this.emit('selection');
    this.redraw();
  }

  /** Remembers the current view for ZOOM Previous. */
  pushView() {
    this.viewHistory.push(this.activeViewState());
    if (this.viewHistory.length > 30) this.viewHistory.shift();
  }

  /**
   * @returns the state of the active view (viewport centre and scale, or the main view) for ZOOM
   *     Previous.
   */
  activeViewState() {
    const vp = this.viewport();
    return vp ? { vp: vp.id, cx: vp.cx, cy: vp.cy, scale: vp.scale } : { ...this.view.save() };
  }

  /** ZOOM Previous: goes back to the previous view. */
  zoomPrev() {
    const s = this.viewHistory.pop();
    if (!s) return this.echo('No previous view saved.');
    if (s.vp) {
      const vp = this.doc.spaceList(this.space).find((e) => e.id === s.vp);
      if (vp) {
        vp.cx = s.cx;
        vp.cy = s.cy;
        vp.scale = s.scale;
      }
    } else {
      this.view.cx = s.cx;
      this.view.cy = s.cy;
      this.view.zoom = s.zoom;
    }
    this.changed();
    this.emit('view');
  }

  // ---------------------------------------------------------------- view and zoom

  /**
   * Sets centre and zoom of the active view.
   * @param {boolean} [remember] false = do not add the old view to the history
   */
  setZoom(cx, cy, zoom, remember = true) {
    if (this.v3) {
      this.v3.target[0] = cx;
      this.v3.target[1] = cy;
      this.v3.zoom = zoom;
      this.changed();
      this.emit('view');
      return;
    }
    if (remember) this.pushView();
    const vp = this.viewport();
    if (vp) {
      const base = this.view.zoom;
      vp.cx = cx;
      vp.cy = cy;
      vp.scale = zoom / base;
    } else {
      this.view.cx = cx;
      this.view.cy = cy;
      this.view.zoom = Math.max(1e-6, Math.min(1e8, zoom));
    }
    this.changed();
    this.emit('view');
  }

  /** Zooms to a window given by two corners. */
  zoomWindow(a, b) {
    const w = Math.abs(a.x - b.x) || 1e-6;
    const h = Math.abs(a.y - b.y) || 1e-6;
    const v = this.view;
    const z = (Math.min(v.w / w, v.h / h) / (this.viewport() ? 1 : 1)) * 0.98;
    const vp = this.viewport();
    if (vp) {
      const pw = Math.abs(vp.p2.x - vp.p1.x);
      const ph = Math.abs(vp.p2.y - vp.p1.y);
      this.setZoom((a.x + b.x) / 2, (a.y + b.y) / 2, Math.min(pw / w, ph / h) * 0.98 * v.zoom);
    } else this.setZoom((a.x + b.x) / 2, (a.y + b.y) / 2, z);
  }

  /** @returns the box around the drawing (the sheet in a layout). */
  extentsBox() {
    if (this.space !== 'model' && !this.mspace) {
      const p = this.doc.layouts[this.space].paper;
      return { x0: 0, y0: 0, x1: p.w, y1: p.h };
    }
    return modelExtents(this.doc, 'model');
  }

  /** ZOOM All: the drawing limits or the extents, whichever is bigger. */
  zoomAll() {
    let b = this.extentsBox();
    const l = this.doc.limits;
    if (l && this.space === 'model')
      b = b
        ? {
            x0: Math.min(b.x0, l.x0),
            y0: Math.min(b.y0, l.y0),
            x1: Math.max(b.x1, l.x1),
            y1: Math.max(b.y1, l.y1),
          }
        : { x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 };
    if (!b) b = { x0: 0, y0: 0, x1: 420, y1: 297 };
    const w = Math.max(b.x1 - b.x0, 1e-6);
    const h = Math.max(b.y1 - b.y0, 1e-6);
    const v = this.view;
    this.setZoom((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, Math.min(v.w / w, v.h / h) * 0.92);
  }

  /** ZOOM Extents: the box around the visible objects. */
  zoomExtents(remember = true) {
    if (this.v3) {
      let bb = null;
      const big = this.curEnts().filter((x) => x.type === 'solid3d').length > 60;
      for (const e of this.curEnts())
        if (this.doc.visible(e)) {
          const b = e.type === 'solid3d' ? E.solidBounds(e, big) : E.bbox(e, this.doc);
          if (!b) continue;
          bb = bb
            ? {
                x0: Math.min(bb.x0, b.x0),
                y0: Math.min(bb.y0, b.y0),
                z0: Math.min(bb.z0 ?? 0, b.z0 ?? 0),
                x1: Math.max(bb.x1, b.x1),
                y1: Math.max(bb.y1, b.y1),
                z1: Math.max(bb.z1 ?? 0, b.z1 ?? 0),
              }
            : { ...b, z0: b.z0 ?? 0, z1: b.z1 ?? 0 };
        }
      this.v3.fit(bb || { x0: 0, y0: 0, x1: 420, y1: 297, z0: 0, z1: 0 });
      this.changed();
      this.emit('view');
      return;
    }
    const b = this.extentsBox() || { x0: 0, y0: 0, x1: 420, y1: 297 };
    const w = Math.max(b.x1 - b.x0, 1e-6);
    const h = Math.max(b.y1 - b.y0, 1e-6);
    const v = this.view;
    const z = Math.min(v.w / w, v.h / h) * 0.97;
    if (this.viewport()) {
      const vp = this.viewport();
      const pw = Math.abs(vp.p2.x - vp.p1.x);
      const ph = Math.abs(vp.p2.y - vp.p1.y);
      this.setZoom(
        (b.x0 + b.x1) / 2,
        (b.y0 + b.y1) / 2,
        Math.min(pw / w, ph / h) * 0.97 * v.zoom,
        remember,
      );
    } else this.setZoom((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, z, remember);
  }

  /** Zooms by a factor about the centre of the view. */
  zoomScale(f) {
    const v = this.activeView();
    this.setZoom(
      v.cx,
      v.cy,
      (this.viewport() ? this.view.zoom : v.zoom) *
        f *
        (this.viewport() ? this.viewport().scale : 1),
    );
  }

  /** Zooms by a factor about a screen pixel (mouse wheel). */
  zoomAt(sx, sy, factor) {
    if (this.v3) {
      this.v3.zoomAt(sx, sy, factor);
      this.changed();
      this.emit('view');
      return;
    }
    const v = this.activeView();
    const w = v.s2w(sx, sy);
    const vp = this.viewport();
    if (vp) {
      const s = Math.max(1e-8, vp.scale * factor);
      const nz = this.view.zoom * s;
      const m = { x: (vp.p1.x + vp.p2.x) / 2, y: (vp.p1.y + vp.p2.y) / 2 };
      void m;
      vp.scale = s;
      vp.cx = w.x - (w.x - vp.cx) / factor;
      vp.cy = w.y - (w.y - vp.cy) / factor;
      void nz;
    } else {
      const z = Math.max(1e-6, Math.min(1e8, v.zoom * factor));
      v.cx = w.x - (sx - v.w / 2) / z;
      v.cy = w.y + (sy - v.h / 2) / z;
      v.zoom = z;
    }
    this.changed();
    this.emit('view');
  }

  /** Turns the 3D view by a mouse movement. */
  orbitBy(dx, dy) {
    if (!this.v3) return;
    this.v3.orbit(dx, dy);
    this.changed();
    this.emit('view3d');
  }

  /**
   * Cmd + wheel: orbit. The model follows the fingers like a pan; one notch of a mouse wheel turns
   * about 12 degrees. Out of 3D the wheel pans.
   */
  wheelOrbit(dx, dy, mouse, shift) {
    if (shift && !dx) {
      dx = dy;
      dy = 0;
    } // a mouse wheel has only an up / down axis: Shift turns it into the left / right one
    if (mouse) {
      dx = Math.sign(dx) * 30;
      dy = Math.sign(dy) * 30;
    }
    if (!dx && !dy) return;
    if (!this.v3) this.enter3D(this.solids().length ? 'swiso' : 'top');
    this.orbitBy(-dx, -dy);
  }

  /** Pans the view by a mouse movement. */
  panBy(dx, dy) {
    if (this.v3) {
      this.v3.pan(dx, dy);
      this.changed();
      this.emit('view');
      return;
    }
    const vp = this.viewport();
    if (vp) {
      const z = this.view.zoom * vp.scale;
      vp.cx -= dx / z;
      vp.cy += dy / z;
    } else {
      this.view.cx -= dx / this.view.zoom;
      this.view.cy += dy / this.view.zoom;
    }
    this.changed();
    this.emit('view');
  }

  // ---------------------------------------------------------------- selection helpers

  /**
   * @returns {boolean} true when an object can be selected (visible, unlocked, not a viewport in
   *     the wrong space).
   */
  selectable(e) {
    return (
      (this.doc.visible(e) && !this.doc.locked(e) && e.type !== 'viewport') ||
      (e.type === 'viewport' && !this.mspace && this.space !== 'model')
    );
  }

  /** @returns {object[]} the selected objects of the current space. */
  selectedEnts() {
    return this.curEnts().filter((e) => this.sel.has(e.id));
  }

  /** Replaces the selection. */
  setSel(ents) {
    this.sel = new Set(ents.map((e) => e.id));
    this.emit('selection');
    this.redraw();
  }

  /** Clears the selection. */
  clearSel() {
    if (this.sel.size) {
      this.sel.clear();
      this.emit('selection');
    }
    this.redraw();
  }

  /**
   * The object under a drawing point (3D solids under the cursor first), within the pick box.
   * @returns {{e, p}|null}
   */
  pickAt(w, v = this.activeView(), filter, tolPx = this.settings.pickbox + 2) {
    let best = null;
    if (v.is3d && this.cursor) {
      // Planar drawings placed on a solid face are rendered after the solid and must remain
      // directly selectable.  Test them in screen space before the solid ray cast.
      for (let i = this.curEnts().length - 1; i >= 0; i -= 1) {
        const e = this.curEnts()[i];
        if (!e.plane || !this.selectable(e) || (filter && !filter(e))) continue;
        const ev = this.entView(e);
        const p = ev.s2w(this.cursor.sx, this.cursor.sy);
        const d = E.distTo(e, p, this.doc);
        if (d <= tolPx / ev.zoom) return e;
      }
      const hit = this.pickSolid(this.cursor.sx, this.cursor.sy);
      if (hit && (!filter || filter(hit.e))) {
        best = { e: hit.e, d: 0 };
        const sol3 = hit.t;
        this._lastHit = hit;
        void sol3;
        return hit.e;
      }
      w = v.s2w(this.cursor.sx, this.cursor.sy, 0);
    }
    const ents = this.curEnts();
    for (let i = ents.length - 1; i >= 0; i -= 1) {
      const e = ents[i];
      if (!this.selectable(e) || (filter && !filter(e))) continue;
      const ev = this.entView(e);
      const ew = v.is3d && ev && this.cursor ? ev.s2w(this.cursor.sx, this.cursor.sy) : w;
      const etol = tolPx / (ev?.zoom || v.zoom);
      const d = E.distTo(e, ew, this.doc);
      if (d <= etol && (!best || d < best.d - 1e-12)) best = { e, d };
    }
    return best ? best.e : null;
  }

  /** A 2D curve under a pixel in a 3D view, using the larger modeling-selection aperture. */
  pickCurveAt(sx, sy, filter) {
    const v = this.activeView();
    const aperture = v.is3d
      ? Math.max(10, this.settings.selectionAperture3d || 14)
      : this.settings.pickbox + 2;
    return this.pickAt(v.s2w(sx, sy), v, filter, aperture);
  }

  /**
   * The objects inside (or, with `crossing`, touching) a rectangle in screen pixels, in a 3D view.
   */
  inRectScreen(x0, y0, x1, y1, crossing, filter) {
    const v = this.v3;
    const r = {
      x0: Math.min(x0, x1),
      y0: Math.min(y0, y1),
      x1: Math.max(x0, x1),
      y1: Math.max(y0, y1),
    };
    return this.curEnts().filter((e) => {
      if (!this.selectable(e) || (filter && !filter(e))) return false;
      let pts;
      if (e.type === 'solid3d') {
        const b = E.solidBounds(e);
        pts = [];
        for (const x of [b.x0, b.x1])
          for (const y of [b.y0, b.y1]) for (const z of [b.z0, b.z1]) pts.push(v.w2s({ x, y, z }));
      } else {
        const b = E.bbox(e, this.doc);
        if (!b) return false;
        const ev = this.entView(e) || v;
        pts = [
          ev.w2s({ x: b.x0, y: b.y0 }),
          ev.w2s({ x: b.x1, y: b.y0 }),
          ev.w2s({ x: b.x1, y: b.y1 }),
          ev.w2s({ x: b.x0, y: b.y1 }),
        ];
      }
      const bx0 = Math.min(...pts.map((p) => p.x));
      const bx1 = Math.max(...pts.map((p) => p.x));
      const by0 = Math.min(...pts.map((p) => p.y));
      const by1 = Math.max(...pts.map((p) => p.y));
      if (!crossing) return bx0 >= r.x0 && bx1 <= r.x1 && by0 >= r.y0 && by1 <= r.y1;
      return !(bx1 < r.x0 || bx0 > r.x1 || by1 < r.y0 || by0 > r.y1);
    });
  }

  /** The objects inside (or, with `crossing`, touching) a rectangle in drawing coordinates. */
  inRect(a, b, crossing, v = this.activeView(), filter) {
    const r = {
      x0: Math.min(a.x, b.x),
      y0: Math.min(a.y, b.y),
      x1: Math.max(a.x, b.x),
      y1: Math.max(a.y, b.y),
    };
    return this.curEnts().filter(
      (e) => this.selectable(e) && (!filter || filter(e)) && E.inRect(e, r, crossing, this.doc),
    );
  }

  // ---------------------------------------------------------------- requests

  /**
   * @returns {boolean} true when the pick box is drawn at the cursor (no input request, or
   *     selecting objects).
   */
  pickboxVisible() {
    return !this.req || this.req.type === 'select' || this.req.type === 'pick';
  }

  /**
   * Is there something to grab under the cursor right now? (hover highlight of an object, a hot
   * grip, a 3D edge or face while picking one)
   */
  grabTarget() {
    if (this.selDrag || !this.cursor) return false;
    const r = this.req;
    if (r && (r.type === 'edge' || r.type === 'face'))
      return !!(
        (this.edgeHover && this.edgeHover.length) ||
        (this.faceHover && this.faceHover.length) ||
        this.hover
      );
    if (r && r.type === 'keyword' && r.opts.planePicker) return !!this.planeHover;
    if (r && r.type !== 'select' && r.type !== 'pick') return false;
    return !!(this.hover || this.hoverGrip);
  }

  /**
   * The hand closes when something is clicked: grabPress() starts the closing, grabRelease() lets
   * it open again after a short hold; grabClose() = how closed the hand is now (0..1).
   */
  grabPress() {
    if (this.grabTarget()) {
      this.grabAnim = { down: performance.now(), up: null };
      this.redraw();
    }
  }

  /** Lets the hand open again after the mouse button goes up. */
  grabRelease() {
    if (this.grabAnim && this.grabAnim.up == null) {
      this.grabAnim.up = performance.now();
      this.redraw();
    }
  }

  /** @returns {number} how closed the hand is at time `now` (0 open .. 1 fist). */
  grabClose(now = performance.now()) {
    const a = this.grabAnim;
    if (!a) return 0;
    const CLOSE = 130;
    const HOLD = 70;
    const OPEN = 210;
    const ease = (t) => 1 - (1 - t) * (1 - t);
    const closed = ease(Math.min(1, Math.max(0, (now - a.down) / CLOSE)));
    if (a.up == null) return closed;
    const t = (now - Math.max(a.up, a.down + CLOSE + HOLD)) / OPEN;
    if (t >= 1) {
      this.grabAnim = null;
      return 0;
    }
    return t <= 0 ? closed : closed * (1 - ease(t));
  }

  /**
   * Starts an input request (point, dist, angle, number, string, keyword, pick, select, ...) and
   * waits for the answer.
   * @returns {Promise<*>}
   */
  request(type, prompt, opts = {}) {
    return new Promise((res, rej) => {
      this.req = { type, prompt, opts, res, rej, kws: opts.kw || [] };
      if (type === 'select') this.req.picked = new Map();
      this.acquired = [];
      this.refreshPrompt();
      this.updatePreview();
      this.redraw();
    });
  }

  /** The text of the command line prompt for a request (keywords and default value included). */
  composePrompt(r) {
    const kws = r.kws.length && !r.prompt.includes('[') ? ` [${r.kws.join('/')}]` : '';
    const d =
      r.opts.def !== undefined && r.opts.def !== null && r.opts.showDef !== false
        ? ` <${r.opts.defText ?? r.opts.def}>`
        : '';
    return `${r.prompt}${kws}${d}: `;
  }

  /** Tells the command line to show the prompt of the current request. */
  refreshPrompt() {
    this.emit('prompt', this.req ? this.composePrompt(this.req) : '');
  }

  /** Answers the current request with a value. */
  finish(val) {
    const r = this.req;
    if (!r) return;
    this.req = null;
    this.clearTransient();
    this.emit('prompt', this.cmdName ? `${this.cmdName}: ` : 'Command: ');
    r.res(val);
  }

  /**
   * Clears everything that is drawn only while a command waits (preview, rubber band, markers,
   * tracking lines).
   */
  clearTransient() {
    this.temp = [];
    this.snapMarker = null;
    this.trackLines = null;
    this.polarLine = null;
    this.rubber = null;
    this.selDrag = null;
    this.planeHover = null;
    this.acquired = [];
    this.extAcq = [];
    this.parAcq = [];
    clearTimeout(this._hovT);
    this.overrideSnap = null;
    this.dyn = null;
    this.emit('dyn');
    this.redraw();
  }

  /** Cancels the current request (Esc): the waiting command ends. */
  cancelReq() {
    this.cBox = null;
    this.rubber = null;
    const r = this.req;
    if (r) {
      this.req = null;
      this.clearTransient();
      r.rej(CANCEL);
    }
    this.preSel = new Set();
    this.hotGrip = null;
    this.redraw();
  }

  /**
   * Asks for a point.
   * @returns {Promise<{x, y}|string|null>} a point, a keyword, or null
   */
  async point(prompt, opts) {
    for (;;) {
      const v = await this.request('point', prompt, opts);
      if (v === '__FROM') {
        const base = await this.request('point', 'Base point', { noOrtho: true });
        if (!base || typeof base !== 'object') return null;
        this.lastPoint = { x: base.x, y: base.y };
        const off = await this.request('point', '<Offset>', { base, rubber: true });
        if (!off || typeof off !== 'object') return null;
        this.lastPoint = { x: off.x, y: off.y };
        return off;
      }
      if (v === '__M2P') {
        const a = await this.request('point', 'First point of mid', { noOrtho: true });
        if (!a || typeof a !== 'object') return null;
        const b = await this.request('point', 'Second point of mid', { base: a });
        if (!b || typeof b !== 'object') return null;
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.lastPoint = m;
        return m;
      }
      if (v && typeof v === 'object' && 'x' in v) this.lastPoint = { x: v.x, y: v.y };
      return v;
    }
  }

  /** Asks for a distance. */
  dist(prompt, opts) {
    return this.request('dist', prompt, opts);
  }

  /** Asks for an angle (radians). */
  angle(prompt, opts) {
    return this.request('angle', prompt, opts);
  }

  /** Asks for a number. */
  number(prompt, opts) {
    return this.request('number', prompt, opts);
  }

  /** Asks for a text. */
  string(prompt, opts) {
    return this.request('string', prompt, opts);
  }

  /** Asks for one of the keywords. */
  keyword(prompt, kws, def) {
    return this.request('keyword', prompt, { kw: kws, def });
  }

  /** Asks to pick one object. */
  pick(prompt, opts) {
    return this.request('pick', prompt, opts);
  }

  /**
   * Remembers the bounding rectangle of the window / crossing selections made during the current
   * select request (used by STRETCH).
   */
  noteSelRect(a, b) {
    const r = {
      x0: Math.min(a.x, b.x),
      y0: Math.min(a.y, b.y),
      x1: Math.max(a.x, b.x),
      y1: Math.max(a.y, b.y),
    };
    const o = this.lastSelRect;
    this.lastSelRect = o
      ? {
          x0: Math.min(o.x0, r.x0),
          y0: Math.min(o.y0, r.y0),
          x1: Math.max(o.x1, r.x1),
          y1: Math.max(o.y1, r.y1),
        }
      : r;
  }

  /**
   * Asks for a selection of objects (the selection that exists already is used first unless `pre`
   * is false).
   * @returns {Promise<object[]>}
   */
  async select(prompt, opts = {}) {
    this.lastSelRect = null;
    if (opts.pre !== false && this.sel.size && !opts.noPre) {
      const ents = this.selectedEnts().filter((e) => !opts.filter || opts.filter(e));
      if (ents.length) {
        this.echo(`${ents.length} found`);
        this.preSel = new Set(ents.map((e) => e.id));
        return ents;
      }
    }
    const r = await this.request('select', prompt, { ...opts, kw: opts.kw || [] });
    this.prevSel = r;
    return r;
  }

  /** Finds the keyword that the typed text stands for (full word, or a unique start of one). */
  matchKw(text, kws) {
    const t = text.toLowerCase();
    if (!t) return null;
    let k = kws.find((x) => x.toLowerCase() === t);
    if (k) return k;
    k = kws.find((x) => x.toLowerCase().startsWith(t));
    if (k) return k;
    return (
      kws.find((x) => {
        const i = x.search(/[A-Z]/);
        return i > 0 && x.slice(i).toLowerCase().startsWith(t);
      }) || null
    ); // "mOde" is also reached by typing O, "DYnamic" by DY
  }

  /**
   * Reads a typed point: x,y @x,y @dist<angle #x,y and the object snap words.
   * @returns {{x, y}|null}
   */
  parsePoint(text, base) {
    let s = text.trim();
    let rel = false;
    let abs = false;
    if (s[0] === '@') {
      rel = true;
      s = s.slice(1);
    }
    if (s[0] === '#') {
      abs = true;
      s = s.slice(1);
    }
    void abs;
    const origin = rel ? this.lastPoint : { x: 0, y: 0 };
    if (s === '' && rel) return { ...this.lastPoint };
    if (s.includes('<')) {
      const [d, a] = s.split('<');
      const dd = parseDist(d);
      const aa = parseAng(a);
      if (isNaN(dd) || isNaN(aa)) return null;
      return G.polar(rel ? this.lastPoint : base || { x: 0, y: 0 }, aa, dd);
    }
    const parts = s.split(',').map((x) => x.trim());
    if (parts.length >= 2 && parts.length <= 3) {
      const x = parseDist(parts[0]);
      const y = parseDist(parts[1]);
      const z = parts[2] !== undefined ? parseDist(parts[2]) : 0;
      if (isNaN(x) || isNaN(y) || isNaN(z)) return null;
      const pz = (origin.z || 0) + z;
      return pz
        ? { x: origin.x + x, y: origin.y + y, z: pz }
        : { x: origin.x + x, y: origin.y + y };
    }
    return null;
  }

  /** What happens when text is typed or Enter is pressed while a request waits. */
  handleTyped(text) {
    const r = this.req;
    const t = text.trim();
    this.echo(`${this.composePrompt(r)}${text}`);
    const kwHit = t ? this.matchKw(t.replace(/^_+(?=[A-Za-z])/, ''), r.kws) : null; // "_E" = the English keyword E, as in AutoCAD
    if (
      /^[(!]/.test(t) &&
      this.lisp &&
      ['point', 'dist', 'angle', 'number', 'string', 'keyword'].includes(r.type)
    ) {
      this.lispValue(t.startsWith('!') ? t.slice(1) : t).then((v) => {
        if (!this.req || this.req !== r) return;
        const num = (x) => (typeof x === 'number' ? x : x && x.v !== undefined ? x.v : NaN);
        if (Array.isArray(v) && r.type === 'point') this.finish({ x: num(v[0]), y: num(v[1]) });
        else if (r.type === 'dist' || r.type === 'number') {
          const n = num(v);
          if (!Number.isNaN(n)) this.finish(n);
          else this.echo('Requires numeric value.');
        } else if (r.type === 'angle') {
          const n = num(v);
          if (!Number.isNaN(n)) this.finish(n);
          else this.echo('Requires numeric angle.');
        } else if (typeof v === 'string') this.handleTyped(v);
        else this.echo('Invalid value.');
      });
      return undefined;
    }
    switch (r.type) {
      case 'point': {
        if (kwHit) return this.finish(kwHit);
        if (!t)
          return this.finish(r.opts.def !== undefined && r.opts.def !== null ? r.opts.def : null);
        if (/^(fro|from)$/i.test(t)) return this.finish('__FROM');
        if (/^m2p$/i.test(t)) return this.finish('__M2P');
        const osn = OSNAP_TYPED[t.toLowerCase()];
        if (osn) {
          this.overrideSnap = osn;
          this.echo(`${OSNAP_LABEL[osn]} of`);
          this.updateCursorPoint();
          return;
        }
        let p = this.parsePoint(t, r.opts.base);
        if (!p && r.opts.base && !/[,<]/.test(t)) {
          const d = parseDist(t);
          if (!isNaN(d)) {
            const dir = this.directionFrom(r.opts.base);
            p = G.polar(r.opts.base, dir, d);
          }
        }
        if (!p && r.opts.allowNumber) {
          const m = t.match(/^([-+]?[\d.]+)\s*(xp|x)?$/i);
          if (m)
            return this.finish({ scale: parseFloat(m[1]), rel: m[2] ? m[2].toLowerCase() : null });
        }
        if (!p) return this.echo('Point or option keyword required.');
        return this.finish(p);
      }
      case 'dist': {
        if (kwHit) return this.finish(kwHit);
        if (!t) return this.finish(r.opts.def ?? null);
        let d = parseDist(t);
        if (isNaN(d)) {
          const p = this.parsePoint(t, r.opts.base);
          if (p && r.opts.base) d = G.dist(p, r.opts.base);
        }
        if (isNaN(d)) return this.echo('Requires a numeric distance or two points.');
        return this.finish(d);
      }
      case 'angle': {
        if (kwHit) return this.finish(kwHit);
        if (!t) return this.finish(r.opts.def ?? null);
        let a = parseAng(t);
        if (isNaN(a)) {
          const p = this.parsePoint(t, r.opts.base);
          if (p && r.opts.base) a = G.ang(r.opts.base, p);
        }
        if (isNaN(a)) return this.echo('Requires numeric angle or two points.');
        return this.finish(a);
      }
      case 'number': {
        if (kwHit) return this.finish(kwHit);
        if (!t) return this.finish(r.opts.def ?? null);
        const n = parseDist(t);
        if (isNaN(n)) return this.echo('Requires numeric value.');
        return this.finish(n);
      }
      case 'string':
        return this.finish(text === '' && r.opts.def !== undefined ? r.opts.def : text);
      case 'keyword': {
        if (!t) return this.finish(r.opts.def ?? null);
        if (kwHit) return this.finish(kwHit);
        return this.echo('Invalid option keyword.');
      }
      case 'pick': {
        if (kwHit) return this.finish(kwHit);
        if (!t) return this.finish(null);
        return this.echo('Select object or option.');
      }
      case 'rt':
        return this.finish(null);
      case 'edge': {
        if (kwHit) return this.finish(kwHit);
        if (!t) return this.finish(null);
        return this.echo('Select an edge or option.');
      }
      case 'face': {
        if (kwHit) return this.finish(kwHit);
        if (!t) return this.finish(null);
        return this.echo('Select a face or option.');
      }
      case 'select':
        return this.selectTyped(t, kwHit);
      default:
        return undefined;
    }
  }

  /**
   * Typed input while objects are selected: All, Last, Previous, Window, Crossing, Fence, WPolygon,
   * CPolygon, Add, Remove, Group, ...
   */
  selectTyped(t, kwHit) {
    const r = this.req;
    const lt = t.toLowerCase();
    if (!t) {
      if (r.poly) return this.finishPoly(r);
      return this.finish([...r.picked.values()]);
    }
    const sel = (list, label = '') => {
      const f = r.opts.filter;
      let n = 0;
      r.history.push([...r.picked.keys()]);
      for (const e of this.expandGroups(list)) {
        if (f && !f(e)) continue;
        if (r.mode === 'remove') r.picked.delete(e.id);
        else r.picked.set(e.id, e);
        n += 1;
      }
      this.preSel = new Set(r.picked.keys());
      this.echo(`${n} found${r.picked.size !== n ? `, ${r.picked.size} total` : ''}${label}`);
      this.redraw();
    };
    r.history ||= [];
    const all = () => this.curEnts().filter((e) => this.selectable(e));
    if (kwHit && !SELECT_WORDS.includes(kwHit.toLowerCase()) && !['all', 'al'].includes(lt))
      return this.finish(kwHit);
    if (lt === 'al' || lt === 'all') {
      sel(all());
      return undefined;
    }
    if (lt === 'l' || lt === 'last') {
      const es = all();
      if (es.length) sel([es[es.length - 1]]);
      return undefined;
    }
    if (lt === 'p' || lt === 'previous') {
      const ids = new Set(this.prevSel.map((e) => e.id));
      sel(all().filter((e) => ids.has(e.id)));
      return undefined;
    }
    if (lt === 'r' || lt === 'remove') {
      r.mode = 'remove';
      r.prompt = 'Remove objects';
      this.refreshPrompt();
      return undefined;
    }
    if (lt === 'a' || lt === 'add') {
      r.mode = 'add';
      r.prompt = 'Select objects';
      this.refreshPrompt();
      return undefined;
    }
    if (lt === 'm' || lt === 'multiple') return undefined;
    if (lt === 'si' || lt === 'single') {
      r.opts.single = true;
      return undefined;
    }
    if (lt === 'u' || lt === 'undo') {
      const prev = r.history.pop();
      if (prev) {
        r.picked = new Map([...r.picked].filter(([id]) => prev.includes(id)));
        this.preSel = new Set(r.picked.keys());
        this.echo('Undo');
        this.redraw();
      }
      return undefined;
    }
    if (lt === 'w' || lt === 'window') {
      r.box = { crossing: false, p0: null };
      this.echo('Specify first corner');
      return undefined;
    }
    if (lt === 'c' || lt === 'crossing') {
      r.box = { crossing: true, p0: null };
      this.echo('Specify first corner');
      return undefined;
    }
    if (lt === 'bo' || lt === 'box') {
      r.box = { crossing: null, p0: null };
      this.echo('Specify first corner');
      return undefined;
    }
    if (lt === 'f' || lt === 'fence') {
      r.poly = { type: 'F', pts: [] };
      this.echo('First fence point');
      return undefined;
    }
    if (lt === 'wp' || lt === 'wpolygon') {
      r.poly = { type: 'WP', pts: [] };
      this.echo('First polygon point');
      return undefined;
    }
    if (lt === 'cp' || lt === 'cpolygon') {
      r.poly = { type: 'CP', pts: [] };
      this.echo('First polygon point');
      return undefined;
    }
    if (lt === 'g' || lt === 'group') {
      this.echo(
        'Enter group name via the GROUP command; picking a group member selects the entire group.',
      );
      return undefined;
    }
    return this.echo(
      'Invalid selection. Expects a point or Window/Last/Crossing/BOX/ALL/Fence/WPolygon/CPolygon/Add/Remove/Multiple/Previous/Undo/SIngle.',
    );
  }

  /** Ends a window / crossing polygon or fence selection. */
  finishPoly(r) {
    const poly = r.poly;
    r.poly = null;
    this.rubber = null;
    this.temp = [];
    if (poly.pts.length < (poly.type === 'F' ? 2 : 3)) {
      this.echo('Not enough points.');
      return undefined;
    }
    const list = this.curEnts().filter(
      (e) =>
        this.selectable(e) &&
        (poly.type === 'F'
          ? E.crossFence(e, poly.pts, this.doc)
          : E.inPoly(e, poly.pts, poly.type === 'CP', this.doc)),
    );
    this.addToSel(list);
    return undefined;
  }

  /** Adds the other members of the groups that the objects belong to. */
  expandGroups(list) {
    const groups = this.doc.groups;
    if (!groups || !Object.keys(groups).length) return list;
    const out = new Set(list.map((e) => e.id));
    for (const ids of Object.values(groups))
      if (ids.some((id) => out.has(id))) ids.forEach((id) => out.add(id));
    return this.curEnts().filter((e) => out.has(e.id) && this.selectable(e));
  }

  /** @returns {number} the angle from a base point to the cursor. */
  directionFrom(base) {
    const c = this.resolved;
    return G.dist(c, base) > 1e-9 ? G.ang(base, c) : 0;
  }

  // ---------------------------------------------------------------- cursor resolution

  /** The mouse moved to a pixel: resolves the point under it (snap, ortho, polar, tracking). */
  updateCursor(sx, sy, shift = false) {
    this.cursor = { sx, sy };
    this.keys.shift = shift;
    this.updateCursorPoint();
  }

  /**
   * Resolves the cursor into a drawing point for the current request, with snapping, ortho, polar
   * tracking and object snap tracking.
   */
  updateCursorPoint() {
    if (!this.cursor) return;
    const v = this.activeView();
    const r = this.req;
    // During a 3D move, drag on the horizontal plane through the picked base point. Previously all
    // drags were projected onto the world floor, which made an elevated sheet jump down to Z=0.
    const baseZ = v.is3d && r && r.opts.base && Number.isFinite(r.opts.base.z) ? r.opts.base.z : null;
    // MOVE/COPY can request true model-space coordinates.  This is essential when an endpoint on
    // another face is the destination: converting that endpoint back into the source entity's
    // local plane would discard the normal component and can reduce the displacement to zero.
    const iv = v.is3d && r?.opts.world3d ? v : this.inputView();
    const onWorkPlane = v.is3d && r?.opts.workPlane
      ? S3.rayPlanePoint(v.ray(this.cursor.sx, this.cursor.sy), r.opts.workPlane)
      : null;
    const raw = onWorkPlane || (baseZ === null ? iv.s2w(this.cursor.sx, this.cursor.sy) : iv.s2w(this.cursor.sx, this.cursor.sy, baseZ));
    this.cursorW = iv instanceof PlaneView ? iv.toWorld(raw) : raw;
    const wantsPoint =
      r &&
      (r.type === 'point' ||
        r.type === 'dist' ||
        r.type === 'angle' ||
        (r.type === 'select' && (r.box || r.poly)) ||
        (r.type === 'edge' && !!r.opts.curves));
    let p = raw;
    let marker = null;
    this.polarLine = null;
    this.trackLines = null;
    if (wantsPoint) {
      const base = r.opts.base || (r.type === 'select' ? null : null);
      const tol = this.settings.aperture / v.zoom;
      let modes = null;
      if (this.overrideSnap) modes = new Set([this.overrideSnap]);
      else if (this.settings.osnap) modes = new Set(this.settings.osnapModes);
      if (r.opts.noSnap) modes = null;
      let hit = modes
        ? v.is3d
          ? this.snap3d(this.cursor.sx, this.cursor.sy, modes, base)
          : findSnap(this.snapEnts(), this.doc, raw, tol, modes, base, {
              ext: this.extAcq,
              par: this.parAcq,
            })
        : null;
      if (hit && iv instanceof PlaneView) {
        const world = hit.world || hit.p;
        const local = iv.fromWorld(world);
        hit = { ...hit, world, p: { x: local.x, y: local.y } };
      }
      // points of the object being drawn right now (e.g. the start of a revision cloud) are snap targets too, with or without OSNAP
      if (r.opts.snapPts && !v.is3d)
        for (const q of r.opts.snapPts) {
          const d = G.dist(raw, q);
          if (d <= tol && (!hit || d < hit.d))
            hit = { p: { x: q.x, y: q.y }, t: 'end', e: null, d };
        }
      if (hit) {
        p = hit.p;
        marker = hit;
        if (this.settings.otrack && hit.t !== 'nea' && hit.t !== 'per') this.scheduleAcquire(hit);
      } else {
        const keyShift = this.keys.shift;
        let done = false;
        if (this.settings.otrack && this.acquired.length) {
          const tr = trackPoint(
            this.acquired.map((a) => a.p),
            raw,
            tol,
            this.settings.polarInc ? G.rad(this.settings.polarInc) : Math.PI / 2,
            base,
          );
          if (tr) {
            p = tr.p;
            this.trackLines = tr.lines;
            done = true;
          }
        }
        if (!done && base && !r.opts.noOrtho) {
          const ortho = this.settings.ortho !== keyShift;
          if (ortho) {
            p = orthoPoint(base, raw);
            this.polarLine = { o: base, p };
            done = true;
          } else if (this.settings.polar) {
            const c = constrainAngle(base, raw, G.rad(this.settings.polarInc));
            if (c) {
              p = c.p;
              this.polarLine = { o: base, p };
              done = true;
            }
          }
        }
        if (!done && this.settings.snap && !r.opts.noGrid)
          p = gridSnap(p, { x: this.settings.snapSpacing, y: this.settings.snapSpacing });
      }
    }
    if (v.is3d && r && r.type === 'dist' && r.opts.vertical && r.opts.base) {
      this.vertH = this.verticalHeight(v, this.cursor.sx, this.cursor.sy, r.opts.base);
      p = { x: r.opts.base.x, y: r.opts.base.y, z: (r.opts.base.z || 0) + this.vertH };
    } else this.vertH = 0;
    if (v.is3d && !(iv instanceof PlaneView) && p.z === undefined) p = { x: p.x, y: p.y, z: v.elev };
    this.resolved = p;
    this.snapMarker = marker;
    this.scheduleHoverAcquire(
      wantsPoint && !r.opts.noSnap
        ? this.overrideSnap
          ? new Set([this.overrideSnap])
          : this.settings.osnap
            ? new Set(this.settings.osnapModes)
            : null
        : null,
      r && r.opts.base,
    );
    this.updateHover();
    this.updatePreview();
    this.updateDyn();
    this.emit('cursor');
    this.redraw();
  }

  /**
   * The signed height along the vertical through `base` that is closest to the cursor ray (used for
   * BOX / CYLINDER heights).
   */
  verticalHeight(v, sx, sy, base) {
    const { o, d } = v.ray(sx, sy);
    const w0 = [base.x - o[0], base.y - o[1], (base.z || 0) - o[2]];
    const b = d[2];
    const den = 1 - b * b;
    if (den < 1e-4) return 0;
    const dd = w0[2];
    const e = d[0] * w0[0] + d[1] * w0[1] + d[2] * w0[2];
    return (b * e - dd) / den;
  }

  /**
   * Signed distance on an arbitrary 3D axis at the point closest to the cursor ray. This lets a
   * face-normal operation follow the mouse in any camera view instead of being limited to world Z.
   */
  axisDistance3d(v, sx, sy, base, direction) {
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    if (!(length > 1e-12)) return null;
    const a = direction.map((value) => value / length);
    const { o, d } = v.ray(sx, sy);
    const w = [(base.x || 0) - o[0], (base.y || 0) - o[1], (base.z || 0) - o[2]];
    const c = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
    const den = 1 - c * c;
    if (den < 1e-6) return null; // axis is viewed end-on; numeric input remains available
    const alongRay = d[0] * w[0] + d[1] * w[1] + d[2] * w[2];
    const alongAxis = a[0] * w[0] + a[1] * w[1] + a[2] * w[2];
    return (c * alongRay - alongAxis) / den;
  }

  /** @returns {number} the distance a dist request would answer with at point p. */
  distValue(r, p) {
    if (r.opts.vertical && this.v3 && r.opts.base) return this.vertH || 0;
    if (r.opts.direction3d && r.opts.base) {
      const axisDistance = this.v3 && this.cursor
        ? this.axisDistance3d(this.v3, this.cursor.sx, this.cursor.sy, r.opts.base, r.opts.direction3d)
        : null;
      if (Number.isFinite(axisDistance)) return axisDistance;
      const d=r.opts.direction3d,n=Math.hypot(d[0],d[1],d[2])||1,b=r.opts.base;
      return ((p.x-b.x)*d[0]+(p.y-b.y)*d[1]+((p.z||0)-(b.z||0))*d[2])/n;
    }
    return r.opts.base ? G.dist(r.opts.base, p) : this.lastPoint ? G.dist(this.lastPoint, p) : 0;
  }

  /** Object snap for 3D views: compares the projected vertices with the cursor in screen space. */
  snap3d(sx, sy, modes, base = null) {
    const v = this.v3;
    const ap = this.settings.aperture;
    const o3 = this.settings.osnap3d || {};
    let best = null;
    const PRI = { end: 0, int: 1, mid: 2, cen: 3, gcen: 4, qua: 5, nod: 6, ins: 7, per: 8, nea: 20 };
    for (const e of this.curEnts()) {
      if (!this.doc.visible(e)) continue;
      if (e.type !== 'solid3d') {
        const b = E.bbox(e, this.doc);
        if (!b) continue;
        const ev = this.entView(e) || v;
        const q = [
          ev.w2s({ x: b.x0, y: b.y0 }),
          ev.w2s({ x: b.x1, y: b.y1 }),
          ev.w2s({ x: b.x0, y: b.y1 }),
          ev.w2s({ x: b.x1, y: b.y0 }),
        ];
        if (
          sx < Math.min(...q.map((p) => p.x)) - ap ||
          sx > Math.max(...q.map((p) => p.x)) + ap ||
          sy < Math.min(...q.map((p) => p.y)) - ap ||
          sy > Math.max(...q.map((p) => p.y)) + ap
        )
          continue;
      }
      for (const s of E.snapPoints(e, this.doc)) {
        if (!modes.has(s.t) && !(e.type === 'solid3d' && s.t === 'gcen' && modes.has('cen'))) continue;
        if (e.type === 'solid3d' && s.t === 'end' && o3.vertex === false) continue;
        if (e.type === 'solid3d' && s.t === 'mid' && o3.edgeMid === false) continue;
        if (e.type === 'solid3d' && s.t === 'gcen' && o3.center === false) continue;
        const ev = this.entView(e) || v;
        const q = ev.w2s(s.p);
        const d = Math.hypot(q.x - sx, q.y - sy);
        if (
          d <= S3.snapReach(ap, s.t) &&
          (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) < 1e-9 && PRI[s.t] < PRI[best.t]))
        )
          best = {
            p: ev instanceof PlaneView ? ev.toWorld(s.p) : { x: s.p.x, y: s.p.y, z: s.p.z ?? 0 },
            t: s.t, e, d,
          };
      }
    }
    // Curved B-Rep edges expose their tessellation knots even when an imported surface does not
    // expose a NURBS parameter table to the renderer.
    if (modes.has('nod') && o3.knot) {
      for (const e of this.solids()) {
        if (!this.doc.visible(e)) continue;
        for (const ed of E.solidEdges(e)) for (const p of ed.pts.slice(1,-1)) {
          const q=v.w2s({x:p[0],y:p[1],z:p[2]}),d=Math.hypot(q.x-sx,q.y-sy);
          if(d<=S3.snapReach(ap,'nod')&&(!best||d<best.d))best={p:{x:p[0],y:p[1],z:p[2]},t:'nod',e,d};
        }
      }
    }
    // A perpendicular snap is the closest point from the command's base point to a visible face.
    if (base && modes.has('per') && o3.perp) {
      for (const e of this.solids()) {
        if (!this.doc.visible(e)) continue;let m;try{m=K.solidMesh(e);}catch{continue;}
        for(const f of m.faceGroups){const hit=S3.closestPointOnFace(m,f,[base.x,base.y,base.z||0]);if(!hit)continue;const q=v.w2s({x:hit.p[0],y:hit.p[1],z:hit.p[2]}),d=Math.hypot(q.x-sx,q.y-sy);if(d<=S3.snapReach(ap,'per')&&(!best||PRI.per<(PRI[best.t]??99)||best.t==='per'&&d<best.d))best={p:{x:hit.p[0],y:hit.p[1],z:hit.p[2]},t:'per',e,d};}
      }
    }
    // Nearest-on-edge is evaluated in screen space. This keeps curved and tilted 3D edges easy to
    // acquire: measuring in the XY work plane made vertical edges almost impossible to find.
    if (modes.has('nea')) {
      for (const e of this.solids()) {
        if (!this.doc.visible(e)) continue;
        for (const ed of E.solidEdges(e))
          {
            const q = S3.nearestProjectedPoint(ed.pts, (p) => v.w2s({ x: p[0], y: p[1], z: p[2] }), sx, sy);
            if (!q) continue;
            const { p, d } = q;
            if (d <= ap * 1.25 && (!best || PRI.nea < (PRI[best.t] ?? 99) || best.t === 'nea' && d < best.d))
              best = { p: { x: p[0], y: p[1], z: p[2] }, t: 'nea', e, d };
          }
      }
      if(o3.near&&!best){const hit=this.pickFace(sx,sy);if(hit)best={p:{x:hit.p[0],y:hit.p[1],z:hit.p[2]},t:'nea',e:hit.e,d:0};}
    }
    return best;
  }

  /** @returns {object[]} the objects the object snap looks at. */
  snapEnts() {
    const ents = this.curEnts();
    if (this.space !== 'model' && !this.mspace) return ents;
    return ents;
  }

  /**
   * Extension / Parallel snaps need the cursor to PAUSE over an endpoint / a line first (AutoCAD
   * behaviour): the ray is then acquired.
   */
  scheduleHoverAcquire(modes, base) {
    clearTimeout(this._hovT);
    if (!modes || !(modes.has('ext') || modes.has('par')) || this.v3) return;
    this._hovT = setTimeout(() => {
      const r = this.req;
      if (!r || !['point', 'dist', 'angle'].includes(r.type)) return;
      const m = this.snapMarker;
      const same = (a, b) =>
        G.dist(a.o || a.p || { x: 0, y: 0 }, b.o || b.p || { x: 0, y: 0 }) < 1e-9 &&
        Math.abs(a.d.x - b.d.x) + Math.abs(a.d.y - b.d.y) < 1e-9;
      if (modes.has('ext') && m && m.t === 'end' && m.e) {
        for (const ray of this.endRays(m.e, m.p))
          if (!this.extAcq.some((a) => same(a, ray))) this.extAcq.push(ray);
        if (this.extAcq.length > 6) this.extAcq.splice(0, this.extAcq.length - 6);
      }
      if (modes.has('par') && base && this.cursorW) {
        const e = this.pickAt(this.cursorW, this.activeView());
        const d = e && this.segDirAt(e, this.cursorW);
        if (d && !this.parAcq.some((a) => Math.abs(a.d.x - d.x) + Math.abs(a.d.y - d.y) < 1e-9)) {
          this.parAcq.push({ d });
          if (this.parAcq.length > 3) this.parAcq.shift();
        }
      }
      this.redraw();
    }, 350);
  }

  /**
   * The outward rays at the end of a straight line / open polyline segment (for extension snap).
   */
  endRays(e, p) {
    const out = [];
    const ray = (o, from) => {
      const l = G.dist(o, from);
      if (l > 1e-12)
        out.push({ o: { x: o.x, y: o.y }, d: { x: (o.x - from.x) / l, y: (o.y - from.y) / l } });
    };
    if (e.type === 'line') {
      if (G.dist(p, e.p1) < 1e-9) ray(e.p1, e.p2);
      else if (G.dist(p, e.p2) < 1e-9) ray(e.p2, e.p1);
    } else if (e.type === 'pline' && !e.closed && e.pts.length > 1) {
      const n = e.pts.length;
      if (G.dist(p, e.pts[0]) < 1e-9 && !e.pts[0].b) ray(e.pts[0], e.pts[1]);
      else if (G.dist(p, e.pts[n - 1]) < 1e-9 && !e.pts[n - 2].b) ray(e.pts[n - 1], e.pts[n - 2]);
    }
    return out;
  }

  /** @returns the direction of a straight segment at a point. */
  segDirAt(e, p) {
    let best = null;
    for (const P of E.prims(e, this.doc)) {
      if (P.k !== 's') continue;
      const n = G.nearestOnPrim(P, p);
      const l = G.dist(P.a, P.b);
      if (l > 1e-12 && (!best || n.d < best.d))
        best = { d: n.d, v: { x: (P.b.x - P.a.x) / l, y: (P.b.y - P.a.y) / l } };
    }
    return best ? best.v : null;
  }

  /** Acquires a point for object snap tracking after the cursor rests on it. */
  scheduleAcquire(hit) {
    const key = `${hit.p.x.toFixed(6)},${hit.p.y.toFixed(6)}`;
    if (this._acqKey === key) return;
    this._acqKey = key;
    clearTimeout(this._acqT);
    this._acqT = setTimeout(() => {
      if (
        this.snapMarker &&
        this.snapMarker.p === hit.p &&
        !this.acquired.some((a) => G.dist(a.p, hit.p) < 1e-9)
      ) {
        this.acquired.push({ p: hit.p });
        if (this.acquired.length > 4) this.acquired.shift();
        this.redraw();
      }
    }, 350);
  }

  // ---------------------------------------------------------------- hover, preview and dynamic input

  /** Finds the object (or 3D face / edge) under the cursor for the hover highlight. */
  updateHover() {
    const r = this.req;
    if (r && r.type === 'keyword' && r.opts.planePicker) {
      this.planeHover = this.cursor
        ? this.pickPlaneChoice(this.cursor.sx, this.cursor.sy, r.opts.planePicker)
        : null;
      this.faceHover = null;
      this.edgeHover = null;
      this.hover = null;
      return;
    }
    this.planeHover = null;
    if (r && r.type === 'face') {
      const h = this.cursor ? this.pickFace(this.cursor.sx, this.cursor.sy, r.opts.solids) : null;
      this.faceHover = h ? [h] : [];
      this.hover = null;
      return;
    }
    this.faceHover = null;
    if (r && r.type === 'edge') {
      // TRIM's drawn cutting line must win over a coincident solid edge/face.  It also gets the
      // larger 3D modeling aperture so users do not have to hunt for a one-pixel wire.
      const curve = this.cursor && r.opts.curves
        ? this.pickCurveAt(this.cursor.sx, this.cursor.sy, r.opts.curves)
        : null;
      const h =
        !curve && this.cursor && r.opts.mode !== 'loop'
          ? this.pickEdge(this.cursor.sx, this.cursor.sy, 9, r.opts.solids)
          : null;
      this.edgeHover = h
        ? (r.opts.expand ? r.opts.expand(h.e, h.edge) : [h.edge]).map((x) => ({ pts: x.pts }))
        : [];
      const fh =
        !curve && !h && r.opts.faces && this.cursor
          ? this.pickFace(this.cursor.sx, this.cursor.sy, r.opts.solids)
          : null;
      this.faceHover = fh ? [fh] : [];
      this.hover = curve;
      return;
    }
    this.edgeHover = null;
    if ((r && r.type !== 'select' && r.type !== 'pick') || this.selDrag) {
      this.hover = null;
      return;
    }
    const v = this.activeView();
    if (v.is3d && this.cursor && this.settings.selectionPreview3d !== false) {
      const tol = Math.max(10, this.settings.selectionAperture3d || 14, (this.settings.pickbox || 4) * 2 + 4);
      const eh = this.pickEdge(this.cursor.sx, this.cursor.sy, tol, r && r.opts.filter ? this.solids().filter(r.opts.filter) : null);
      const fh = this.pickFace(this.cursor.sx, this.cursor.sy, r && r.opts.filter ? this.solids().filter(r.opts.filter) : null);
      this.edgeHover = eh ? [{ pts: eh.edge.pts, hover: true }] : [];
      this.faceHover = fh ? [fh] : [];
    } else this.faceHover = null;
    const e = this.cursor
      ? this.pickAt(v.s2w(this.cursor.sx, this.cursor.sy), v, r && r.opts.filter)
      : null;
    this.hover = e && !this.sel.has(e.id) && !this.preSel.has(e.id) ? e : null;
    // grip hover
    this.hoverGrip = null;
    if (
      !r &&
      this.settings.grips &&
      this.cursor &&
      this.sel.size <= (this.settings.gripLimit ?? 100)
    ) {
      for (const e2 of this.selectedEnts()) {
        const gv = this.entView(e2) || this.activeView();
        for (const g of E.grips(e2, this.doc)) {
          const s = gv.w2s(g.p);
          if (Math.abs(s.x - this.cursor.sx) <= 5 && Math.abs(s.y - this.cursor.sy) <= 5) {
            this.hoverGrip = { e: e2, g };
            break;
          }
        }
        if (this.hoverGrip) break;
      }
    }
  }

  /** Builds the preview objects that the current request shows at the cursor. */
  updatePreview() {
    const r = this.req;
    if (!r) return;
    const o = r.opts;
    const p = this.resolved;
    let temp = [];
    if (r.type === 'point' && o.preview) temp = o.preview(p) || [];
    else if (r.type === 'dist' && o.preview) temp = o.preview(this.distValue(r, p), p) || [];
    else if (r.type === 'angle' && o.preview)
      temp = o.preview(o.base ? G.ang(o.base, p) : 0, p) || [];
    else if (
      (r.type === 'point' || r.type === 'dist' || r.type === 'angle') &&
      o.base &&
      o.rubber !== false
    ) {
      const l = E.mk('line', { p1: o.base, p2: p });
      l._dash = [5, 4];
      temp = [l];
    }
    if (r.type === 'select' && r.poly) {
      const pts = [...r.poly.pts, p].map((q) => ({ x: q.x, y: q.y, b: 0 }));
      const t = E.mk('pline', { pts, closed: r.poly.type !== 'F' });
      t._dash = r.poly.type === 'CP' || r.poly.type === 'F' ? [5, 4] : [];
      temp = [t];
    }
    if (r.type === 'select' && r.box && r.box.p0) {
      const v = this.activeView();
      const s0 = r.box.s0;
      const cur = this.cursor;
      const a = s0 ? { x: s0.sx, y: s0.sy } : v.w2s(r.box.p0);
      const b = s0 && cur ? { x: cur.sx, y: cur.sy } : v.w2s(p);
      this.rubber = {
        x0: a.x,
        y0: a.y,
        x1: b.x,
        y1: b.y,
        crossing:
          !!o.crossing ||
          (r.box.crossing === null ? (s0 ? b.x < a.x : p.x < r.box.p0.x) : r.box.crossing),
      };
    }
    this.temp = temp;
  }

  /** Updates the dynamic input boxes at the cursor (dimensions of the rubber band). */
  updateDyn() {
    const r = this.req;
    const c = this.cursor;
    if (!this.settings.dyn || !c || !this.mouseIn) {
      this.dyn = null;
      this.emit('dyn');
      return;
    }
    const lines = [];
    if (
      r &&
      (r.type === 'point' ||
        r.type === 'dist' ||
        r.type === 'angle' ||
        r.type === 'pick' ||
        r.type === 'select')
    ) {
      const u = this.doc.units;
      if (r.opts.base && r.type !== 'select') {
        const d =
          r.type==='dist'
            ? Math.abs(this.distValue(r,this.resolved))
            : G.dist(r.opts.base, this.resolved);
        const a = G.ang(r.opts.base, this.resolved);
        lines.push(`${fmtLen(d, u)} < ${fmtAng(a, u, true)}`);
      } else if (r.type === 'point')
        lines.push(`${fmtLen(this.resolved.x, u)}, ${fmtLen(this.resolved.y, u)}`);
      lines.push(
        r.prompt.split('\n').pop() +
          (r.kws.length && !r.prompt.includes('[') ? '  [' + r.kws.join('/') + ']' : ''),
      );
    } else if (!r) {
      this.dyn = null;
      this.emit('dyn');
      return;
    } else lines.push(r.prompt);
    this.dyn = {
      x: c.sx,
      y: c.sy,
      lines,
      snap: this.snapMarker ? OSNAP_LABEL[this.snapMarker.t] : null,
    };
    this.emit('dyn');
  }

  // ---------------------------------------------------------------- mouse input

  /** A mouse button went down at a pixel. */
  mouseDown(sx, sy, button, shift) {
    this.cursor = { sx, sy };
    this.keys.shift = shift;
    this.press = null;
    if (button === 1 || button === 2) return;
    if (button === 0) this.grabPress();
    const r = this.req;
    const v = this.activeView();
    if (this.cBox && (!r || (r.type === 'pick' && r.opts.drag)))
      return this.finishClickBox(sx, sy, shift); // second corner of a click-click window
    if (r) {
      if (r.type === 'rt') {
        this.rtDrag = { sx, sy };
        return;
      }
      if (
        r.type === 'point' &&
        v.is3d &&
        PLANE_DRAW_COMMANDS.has(this.cmdName) &&
        !this.commandPlane &&
        !this.doc.ucs?.current
      ) {
        this.commandPlane = this.faceDrawingPlane(this.pickFace(sx, sy)) || this.sideDrawingPlane();
      }
      this.updateCursorPoint();
      if (r.type === 'keyword' && r.opts.planePicker) {
        const plane = this.pickPlaneChoice(sx, sy, r.opts.planePicker);
        if (plane) return this.finish(plane.name);
        return this.echo('Click the highlighted XY, YZ or ZX plane, or type an option.');
      }
      if (r.type === 'point' || r.type === 'dist' || r.type === 'angle') {
        const p = this.resolved;
        if (r.type === 'point') {
          if (this.cmdName === 'RECTANG') this.press = { sx, sy };
          return this.finish(p.z ? { x: p.x, y: p.y, z: p.z } : { x: p.x, y: p.y });
        } // RECTANG: press, drag and release also draws (the release is the opposite corner, see mouseUp)
        if (r.type === 'dist') return this.finish(this.distValue(r, p));
        return this.finish(r.opts.base ? G.ang(r.opts.base, p) : G.ang(this.lastPoint, p));
      }
      if (r.type === 'face') {
        const hit = this.pickFace(sx, sy, r.opts.solids);
        if (hit) return this.finish(hit);
        return this.echo('No face found.');
      }
      if (r.type === 'edge') {
        const curve = r.opts.curves ? this.pickCurveAt(sx, sy, r.opts.curves) : null;
        if (curve) {
          const ev = this.entView(curve);
          const local = ev ? ev.s2w(sx, sy) : v.s2w(sx, sy);
          const p = ev?.toWorld ? ev.toWorld(local) : local;
          return this.finish({ e: curve, curve, p });
        }
        // Loop mode (or a click that is not near an edge) takes the FACE under the cursor: all the edges around it
        const hit = r.opts.mode === 'loop' ? null : this.pickEdge(sx, sy, 9, r.opts.solids);
        if (hit) return this.finish({ e: hit.e, edge: hit.edge });
        if (r.opts.faces) {
          const fh = this.pickFace(sx, sy, r.opts.solids);
          if (fh) return this.finish({ e: fh.e, face: fh.face });
        }
        return this.echo('No edge found.');
      }
      if (r.type === 'pick') {
        if (r.opts.drag) {
          this.selDrag = { sx, sy, moved: false, shift, pick: true };
          return;
        } // click picks one object, drag sweeps a crossing window (TRIM / EXTEND)
        const e = this.pickAt(v.s2w(sx, sy), v, r.opts.filter);
        if (e) return this.finish({ e, p: v.s2w(sx, sy) });
        return this.echo('Nothing selected');
      }
      if (r.type === 'select') {
        if (r.poly) {
          r.poly.pts.push({ x: this.resolved.x, y: this.resolved.y });
          this.echo(
            r.poly.type === 'F'
              ? 'Specify endpoint of line or [Undo]'
              : 'Specify endpoint of line or [Undo]',
          );
          return;
        }
        if (r.box) {
          const p = this.resolved;
          if (!r.box.p0) {
            r.box.p0 = p;
            if (v.is3d) r.box.s0 = { sx, sy };
            this.echo('Specify opposite corner');
            return;
          }
          let list;
          if (r.box.s0) {
            // 3D view: the window is a rectangle on the screen
            const crossing3 =
              !!r.opts.crossing || (r.box.crossing === null ? sx < r.box.s0.sx : r.box.crossing);
            list = this.inRectScreen(r.box.s0.sx, r.box.s0.sy, sx, sy, crossing3, r.opts.filter);
          } else {
            const crossing =
              !!r.opts.crossing || (r.box.crossing === null ? p.x < r.box.p0.x : r.box.crossing); // STRETCH always uses crossing
            list = this.inRect(r.box.p0, p, crossing, v, r.opts.filter);
            this.noteSelRect(r.box.p0, p);
          }
          r.box = null;
          this.rubber = null;
          this.addToSel(list);
          return;
        }
        this.selDrag = { sx, sy, moved: false, shift };
        return;
      }
      return;
    }
    // idle: grips first
    if (this.hoverGrip) {
      const { e, g } = this.hoverGrip;
      this.hotGrip = { e, g };
      this.runInternal('GRIP', (ctx) => this.gripEdit(ctx, e, g));
      return;
    }
    this.selDrag = { sx, sy, moved: false, shift };
  }

  /** The mouse moved to a pixel. */
  mouseMove(sx, sy, shift) {
    this.mouseIn = true;
    if (this.cBox)
      this.rubber = {
        x0: this.cBox.sx,
        y0: this.cBox.sy,
        x1: sx,
        y1: sy,
        crossing: sx < this.cBox.sx || !!this.cBox.pick,
      };
    if (this.rtDrag && this.req && this.req.type === 'rt') {
      const dx = sx - this.rtDrag.sx;
      const dy = sy - this.rtDrag.sy;
      if (this.req.opts.mode === 'orbit') {
        if (!this.v3) this.enter3D('swiso');
        this.orbitBy(dx, dy);
      } else if (this.req.opts.mode === 'pan') this.panBy(dx, dy);
      else this.zoomAt(this.view.w / 2, this.view.h / 2, Math.exp(-dy * 0.01));
      this.rtDrag = { sx, sy };
      this.cursor = { sx, sy };
      this.redraw();
      return;
    }
    if (this.selDrag) {
      const d = this.selDrag;
      if (!d.moved && (Math.abs(sx - d.sx) > 4 || Math.abs(sy - d.sy) > 4)) d.moved = true;
      if (d.moved)
        this.rubber = {
          x0: d.sx,
          y0: d.sy,
          x1: sx,
          y1: sy,
          crossing: sx < d.sx || !!(this.req && this.req.opts.crossing),
        };
    }
    this.updateCursor(sx, sy, shift);
  }

  /**
   * A mouse button went up at a pixel (picks, ends a window selection, answers a point request).
   */
  mouseUp(sx, sy, button) {
    this.rtDrag = null;
    this.cursor = { sx, sy };
    if (button === 0) this.grabRelease();
    // a rectangle drawn in one stroke: press at the first corner, drag, release at the opposite corner (a click that only wobbles a few pixels is still a plain click)
    if (button === 0 && this.press) {
      const pr = this.press;
      this.press = null;
      if (
        this.cmdName === 'RECTANG' &&
        this.req &&
        this.req.type === 'point' &&
        Math.hypot(sx - pr.sx, sy - pr.sy) >= 12
      ) {
        this.mouseDown(sx, sy, 0, false);
        return;
      }
    }
    if (button !== 0 || !this.selDrag) return;
    const d = this.selDrag;
    this.selDrag = null;
    this.rubber = null;
    const v = this.activeView();
    const r = this.req;
    const filter = r && r.opts.filter;
    if (d.pick && r && r.type === 'pick') {
      if (d.moved) {
        const a = v.s2w(d.sx, d.sy);
        const b = v.s2w(sx, sy);
        const hit = v.is3d
          ? this.inRectScreen(d.sx, d.sy, sx, sy, true, filter)
          : this.inRect(a, b, true, v, filter);
        if (!hit.length) {
          this.echo('Nothing selected');
          return;
        }
        return this.finish({ drag: true, list: hit, a, b });
      }
      const pe = this.pickAt(v.s2w(sx, sy), v, filter);
      if (pe) return this.finish({ e: pe, p: v.s2w(sx, sy) });
      this.cBox = { sx, sy, pick: true };
      this.echo('Specify opposite corner');
      this.redraw();
      return; // first corner of a click-click crossing window
    }
    let list;
    if (d.moved) {
      const a = v.s2w(d.sx, d.sy);
      const b = v.s2w(sx, sy);
      const cross = sx < d.sx || !!(r && r.opts.crossing);
      list = v.is3d
        ? this.inRectScreen(d.sx, d.sy, sx, sy, cross, filter)
        : this.inRect(a, b, cross, v, filter);
      if (!v.is3d) this.noteSelRect(a, b);
    } else {
      const e = this.pickAt(v.s2w(sx, sy), v, filter);
      list = e ? [e] : [];
      if (!e && !r && !d.shift) {
        this.cBox = { sx, sy, pick: false };
        this.echo('Specify opposite corner  (click the same spot again to deselect all)');
        this.redraw();
        return;
      } // first corner of a click-click window
      // first corner of a click-click window / crossing selection (the second click completes it; right to left = crossing)
      if (!e && r && r.type === 'select' && !d.shift && !r.box && !r.poly) {
        r.box = { crossing: null, p0: v.s2w(sx, sy), ...(v.is3d ? { s0: { sx, sy } } : {}) };
        this.echo('Specify opposite corner');
        this.updatePreview();
        this.redraw();
        return;
      }
    }
    if (r && r.type === 'select') {
      this.addToSel(list, d.shift);
      return;
    }
    // idle selection
    // AutoCAD behaviour (PICKADD): click / window ADD to the selection, Shift removes (Shift+click toggles); clicking empty space or Esc clears
    list = this.expandGroups(list);
    if (d.shift) {
      if (d.moved) {
        for (const e of list) this.sel.delete(e.id);
      } else
        for (const e of list) {
          if (this.sel.has(e.id)) this.sel.delete(e.id);
          else this.sel.add(e.id);
        }
    } else for (const e of list) this.sel.add(e.id);
    this.emit('selection');
    this.redraw();
  }

  /**
   * Second click of a click-click window selection (no need to hold the mouse button while
   * dragging).
   */
  finishClickBox(sx, sy, shift) {
    const b = this.cBox;
    this.cBox = null;
    this.rubber = null;
    const v = this.activeView();
    const r = this.req;
    const moved = Math.hypot(sx - b.sx, sy - b.sy) > 4;
    if (!moved) {
      if (r) {
        const e = this.pickAt(v.s2w(sx, sy), v, r.opts.filter);
        if (e) return this.finish({ e, p: v.s2w(sx, sy) });
        this.echo('Nothing selected');
        this.redraw();
        return undefined;
      }
      if (!shift) this.clearSel();
      this.redraw();
      return undefined;
    }
    const a = v.s2w(b.sx, b.sy);
    const c2 = v.s2w(sx, sy);
    if (r) {
      const hit = v.is3d
        ? this.inRectScreen(b.sx, b.sy, sx, sy, true, r.opts.filter)
        : this.inRect(a, c2, true, v, r.opts.filter);
      if (!hit.length) {
        this.echo('Nothing selected');
        this.redraw();
        return undefined;
      }
      return this.finish({ drag: true, list: hit, a, b: c2 });
    }
    const cross = sx < b.sx;
    let list = v.is3d ? this.inRectScreen(b.sx, b.sy, sx, sy, cross) : this.inRect(a, c2, cross, v);
    list = this.expandGroups(list);
    if (shift) for (const e of list) this.sel.delete(e.id);
    else for (const e of list) this.sel.add(e.id);
    this.emit('selection');
    this.redraw();
    return undefined;
  }

  /**
   * Adds objects to the selection of the running select request (or removes them with Shift /
   * Remove).
   */
  addToSel(list, shift = false) {
    const r = this.req;
    const f = r.opts.filter;
    let n = 0;
    for (const e of this.expandGroups(list)) {
      if (f && !f(e)) continue;
      if (r.mode === 'remove' || shift) r.picked.delete(e.id);
      else r.picked.set(e.id, e);
      n += 1;
    }
    this.preSel = new Set(r.picked.keys());
    if (n) this.echo(`${n} found${r.picked.size !== n ? `, ${r.picked.size} total` : ''}`);
    this.redraw();
    if (r.opts.single && r.picked.size) this.finish([...r.picked.values()]);
  }

  /**
   * The mouse wheel. ZOOMWHEEL: by default the wheel zooms IN when deltaY > 0 (system scroll
   * direction); the option reverses it.
   */
  wheel(sx, sy, dy, notched = true) {
    const zin = dy > 0 !== !!this.settings.zoomWheelReverse;
    // a notched wheel zooms one step per click; a smooth wheel or trackpad sends many small events, so the step follows the amount
    const step = notched ? 1 : Math.min(1, Math.max(0.04, Math.abs(dy) / 60));
    this.zoomAt(sx, sy, 1.25 ** (zin ? step : -step));
    this.updateCursor(sx, sy, this.keys.shift);
  }

  /** Enter / Space / right click: ends the request, or repeats the last command. */
  enter() {
    // Enter / Space / right click
    if (this.req) return this.handleTyped('');
    if (this.lastCmd) this.exec(this.lastCmd);
  }

  // ---------------------------------------------------------------- keyboard / text commands

  /**
   * Text entered on the command line: answers the waiting request or runs a command or an AutoLISP
   * expression.
   */
  submit(text) {
    const t = text.trim();
    if (this.req) return this.handleTyped(text);
    if (!t) {
      if (this.lastCmd) {
        this.echo(`Command: ${this.lastCmd}`);
        this.exec(this.lastCmd);
      }
      return undefined;
    }
    this.echo(`Command: ${t}`);
    this.cmdHistory.push(t);
    if (/^[(!]/.test(t)) return this.runLisp(t);
    return this.execText(t);
  }

  /** Runs a command typed by name (aliases and a leading _ . ' - are understood). */
  execText(t) {
    let name = t.replace(/^[_.']/, '').toLowerCase();
    if (!name) return undefined;
    name =
      ALIASES[name] ||
      ALIASES[name.replace(/^-/, '')] ||
      name.toUpperCase().replace(/^-/, COMMANDS[name.toUpperCase()] ? '-' : '');
    if (!COMMANDS[name]) {
      this.echo(`Unknown command "${t.toUpperCase()}".  Press F1 for help.`);
      return undefined;
    }
    return this.exec(name);
  }

  /** Runs a command by name; a running command is cancelled first. */
  async exec(name, arg) {
    this.cBox = null;
    this.rubber = null;
    if (this.running) {
      this.cancelReq();
      await this.running.catch(() => {});
    }
    this.running = this.runCommand(name, undefined, arg);
    return this.running;
  }

  /**
   * Runs a function as if it were a command (undo step, errors reported) without a command name
   * from the user.
   */
  async runInternal(name, fn) {
    if (this.running) {
      this.cancelReq();
      await this.running.catch(() => {});
    }
    this.running = this.runCommand(name, fn);
    return this.running;
  }

  /**
   * Runs a command function: sets up the context, records one undo step, reports errors and ends
   * the request.
   */
  async runCommand(name, fnOverride, arg) {
    const def = fnOverride ? { fn: fnOverride } : COMMANDS[name];
    if (!def) return;
    if (!commandAvailable(def)) {
      this.echo(unavailableMessage());
      return;
    }
    const doc0 = this.doc;
    const before = doc0.snapshot(); // a command can open / switch drawings: its undo step belongs to the drawing it started in
    const ctx = this.makeCtx();
    ctx.arg = arg;
    this.commandPlane = null;
    this.cmdName = name === 'GRIP' ? '' : name;
    if (name !== 'GRIP') this.lastCmd = name;
    this.emit('prompt', this.cmdName ? `${this.cmdName}: ` : 'Command: ');
    this.emit('running', true);
    try {
      if (license.restricted && OUTPUT_COMMANDS.has(name)) {
        this.echo(license.blockedMessage());
        setTimeout(() => this.exec('LICENSE'), 0);
      } // trial ended: nothing is written
      else await def.fn(ctx);
    } catch (e) {
      if (e === CANCEL) this.echo('*Cancel*');
      else if (e instanceof CmdError) this.echo(e.message);
      else {
        console.error(e);
        this.echo(`Error in ${name}: ${e.message}`);
      }
    } finally {
      this.req = null;
      this.clearTransient();
      this.preSel = new Set();
      this.hidden.clear();
      this.hotGrip = null;
      this.cmdName = '';
      this.commandPlane = null;
      this.running = null;
      E.bump();
      const after = doc0.snapshot();
      if (after !== before) {
        if (license.restricted && !KEEP_COMMANDS.has(name)) {
          doc0.restore(before);
          E.bump();
          this.echo(license.blockedMessage());
          this.emit('doc');
        } // trial ended: the change is taken back
        else {
          doc0.pushUndo(before, name);
          this.emit('doc');
        }
      }
      this.sel = new Set([...this.sel].filter((id) => this.curEnts().some((e) => e.id === id)));
      this.emit('selection');
      this.emit('running', false);
      this.emit('prompt', 'Command: ');
      this.updateCursorPoint();
      this.redraw();
    }
  }

  // ---------------------------------------------------------------- nested commands (used by the AutoLISP "command" function)

  /** Runs a command from AutoLISP (command "LINE" ...) inside the running one. */
  runNested(name) {
    const def = COMMANDS[name];
    if (!def) throw new CmdError(`Unknown command "${name}"`);
    if (!commandAvailable(def)) throw new CmdError(unavailableMessage());
    if (license.restricted && OUTPUT_COMMANDS.has(name))
      throw new CmdError(license.blockedMessage());
    const ctx = this.makeCtx();
    const nested = { name, done: false, cancelled: false };
    const prev = this.cmdName;
    this.nested = nested;
    this.cmdName = name;
    this.emit('prompt', `${name}: `);
    nested.promise = (async () => {
      try {
        await def.fn(ctx);
      } catch (e) {
        if (e === CANCEL) {
          nested.cancelled = true;
          this.echo('*Cancel*');
        } else if (e instanceof CmdError) this.echo(e.message);
        else {
          console.error(e);
          this.echo(`Error in ${name}: ${e.message}`);
        }
      } finally {
        nested.done = true;
        this.cmdName = prev;
        if (this.nested === nested) this.nested = null;
        this.req = null;
        this.clearTransient();
        E.bump();
        this.emit('doc');
        this.redraw();
      }
    })();
    return nested;
  }

  /** Waits until the nested command asked for input or ended. */
  async waitSettled(forUser = false) {
    const n = this.nested;
    const start = this.req;
    for (;;) {
      await new Promise((r) => setTimeout(r, forUser ? 20 : 0));
      if (!n || n.done) return;
      if (this.req && (!forUser || this.req !== start)) return;
    }
  }

  // ---------------------------------------------------------------- scripts (.scr): every whitespace separated token is typed input, an empty line is Enter

  /**
   * Runs a script (.scr): every whitespace separated token is typed input, an empty line is Enter.
   */
  async runScript(text) {
    this.inScript = true;
    try {
      await this.runScriptLines(text);
    } finally {
      this.inScript = false;
    }
  }

  /** @private Runs the lines of a script one after the other. */
  async runScriptLines(text) {
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.replace(/;.*$/, '');
      if (!raw.trim() && !raw.length) {
        this.submit('');
        await this.settleTop();
        continue;
      }
      if (!line.trim()) continue;
      const toks = line.match(/"[^"]*"|\S+/g) || [];
      for (let i = 0; i < toks.length; i += 1) {
        const tk = toks[i];
        if (/^delay$/i.test(tk) && toks[i + 1]) {
          await new Promise((r) => setTimeout(r, parseInt(toks[++i], 10) || 0));
          continue;
        }
        if (/^resume$/i.test(tk)) continue;
        this.submit(tk.replace(/^"|"$/g, ''));
        await this.settleTop();
      }
    }
  }

  /** Waits until the top-level command asked for input or ended. */
  async settleTop() {
    for (let i = 0; ; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      if (this.req || !this.running) return;
      if (i > 2e6) return;
    }
  }

  // ---------------------------------------------------------------- AutoLISP

  /** Loads the AutoLISP files of the startup suite and acad.lsp / acaddoc.lsp / startup.lsp. */
  async loadStartupLisp() {
    const dir = await this.fs.supportDir();
    const names = ['acad.lsp', 'acaddoc.lsp', 'startup.lsp'];
    const files = [];
    if (dir) for (const n of names) files.push(`${dir}/lisp/${n}`);
    for (const f of this.settings.startupLisp || []) files.push(f);
    for (const f of files) {
      const t = await this.fs.readText(f);
      if (t !== null) {
        await this.lisp.evalString(t, { source: f });
        this.lispLoaded = [...new Set([...(this.lispLoaded || []), f])];
      }
    }
  }

  /** Runs AutoLISP source text typed in the command line or the editor. */
  runLisp(src) {
    return this.runInternal('LISP', async () => {
      await this.lisp.evalString(src, { print: true });
    });
  }

  /** Evaluates AutoLISP source and returns its value. */
  async lispValue(text) {
    const v = await this.lisp.evalString(text, { print: false });
    return v;
  }

  // ---------------------------------------------------------------- edits outside commands, undo and redo

  /**
   * Runs a small edit outside the command runner (toolbar combos, properties palette) with undo
   * support.
   */
  edit(label, fn) {
    if (license.restricted) {
      this.echo(license.blockedMessage());
      return;
    } // trial ended: view only
    const before = this.doc.snapshot();
    fn();
    E.bump();
    if (this.doc.snapshot() !== before) this.doc.pushUndo(before, label);
    this.emit('doc');
    this.emit('selection');
    this.redraw();
  }

  /** The same for an edit that has to wait for something (LOOK measures every part first). */
  async editAsync(label, fn) {
    if (license.restricted) {
      this.echo(license.blockedMessage());
      return;
    }
    const before = this.doc.snapshot();
    await fn();
    E.bump();
    if (this.doc.snapshot() !== before) this.doc.pushUndo(before, label);
    this.emit('doc');
    this.emit('selection');
    this.redraw();
  }

  /** Undoes one step. */
  undo() {
    if (this.running) this.cancelReq();
    const l = this.doc.undo();
    if (l === null) return this.echo('Everything has been undone');
    this.afterHistory(`UNDO ${l}`);
  }

  /** Redoes one step. */
  redo() {
    const l = this.doc.redo();
    if (l === null) return this.echo('Nothing to redo');
    this.afterHistory(`REDO ${l}`);
  }

  /**
   * Goes back (negative) or forward (positive) by several steps at once, e.g. from the Model
   * History panel.
   */
  historyJump(steps) {
    if (this.running) this.cancelReq();
    let n = 0;
    for (let i = 0; i < Math.abs(steps); i += 1) {
      const l = steps < 0 ? this.doc.undo() : this.doc.redo();
      if (l === null) break;
      n += 1;
    }
    if (n) this.afterHistory(`${steps < 0 ? 'UNDO' : 'REDO'} ${n} step${n === 1 ? '' : 's'}`);
  }

  /**
   * Clears the selection and hover after undo / redo / jump, echoes the message and refreshes the panels.
   */
  afterHistory(msg) {
    this.sel.clear();
    this.hover = null;
    this.echo(msg);
    if (this.space !== 'model' && !this.doc.layouts[this.space]) this.space = 'model';
    E.bump();
    this.emit('doc');
    this.emit('selection');
    this.emit('space');
    this.redraw();
  }

  // ---------------------------------------------------------------- command context

  /**
   * Builds the command context `c` that commands get: prompts (point, select, keyword, ...),
   * drawing helpers (mk, add, erase, replace), echo and ui.
   */
  makeCtx() {
    const app = this;
    const doc = this.doc;
    const ctx = {
      app,
      doc,
      get space() {
        return app.targetSpace();
      },
      echo: (m) => app.echo(m),
      point: (p, o) => app.point(p, o),
      dist: (p, o) => app.dist(p, o),
      angle: (p, o) => app.angle(p, o),
      number: (p, o) => app.number(p, o),
      string: (p, o) => app.string(p, o),
      keyword: (p, k, d) => app.keyword(p, k, d),
      pick: (p, o) => app.pick(p, o),
      select: (p, o) => app.select(p, o),
      stamp: (e) => doc.stamp(e),
      mk: (type, props) => {
        const plane = type !== 'solid3d' && type !== 'viewport' ? app.activeDrawingPlane() : null;
        return doc.stamp(E.mk(type, plane ? { ...props, plane: E.clone(plane) } : props));
      },
      add(e) {
        if (!e.layer || e.layer === '0') {
          /* keep stamped */
        }
        doc.add(e, app.targetSpace());
        E.bump();
        app.emit('doc');
        return e;
      },
      addAll(list) {
        list.forEach((e) => doc.add(e, app.targetSpace()));
        E.bump();
        app.emit('doc');
        return list;
      },
      erase(list) {
        doc.remove(
          list.map((e) => e.id),
          app.targetSpace(),
        );
        E.bump();
      },
      replace(old, repl) {
        doc.replace(old, repl, app.targetSpace());
        E.bump();
      },
      tmp: (list) => {
        app.temp = list;
        app.redraw();
      },
      hide: (list) => {
        app.hidden = new Set(list.map((e) => e.id));
        app.redraw();
      },
      bump: () => {
        E.bump();
        app.redraw();
      },
      fail: (msg) => {
        throw new CmdError(msg);
      },
      dialog: (o) => app.ui.dialog(o),
      ui: app.ui,
      units: doc.units,
      fmt: (v) => fmtLen(v, doc.units),
      fmtA: (a) => fmtAng(a, doc.units, true),
      setSel: (list) => app.setSel(list),
    };
    return ctx;
  }

  /** Edits a grip: stretch, move, rotate, scale, mirror or the shape of an object. */
  async gripEdit(ctx, e, g) {
    const doc = this.doc;
    if (g.kind === 'm') {
      const targets = this.sel.has(e.id) ? this.selectedEnts() : [e];
      this.hidden = new Set(targets.map((t) => t.id));
      const movePreview = (dx, dy, dz = 0) =>
        targets.map((t) => {
          const k = E.clone(t);
          E.translateEnt3d(k, dx, dy, dz, doc);
          return k;
        });
      const np = await ctx.point('** MOVE **  Specify move point or [Vertical]', {
        base: g.p,
        kw: e.type === 'solid3d' ? ['Vertical'] : ['Base point', 'Copy'],
        preview: (p) => movePreview(p.x - g.p.x, p.y - g.p.y, (p.z ?? g.p.z ?? 0) - (g.p.z ?? 0)),
      });
      if (np === 'Vertical') {
        const dz = await ctx.dist('Specify vertical displacement', {
          base: g.p,
          vertical: true,
          preview: (distance) => movePreview(0, 0, distance),
        });
        if (Number.isFinite(dz)) {
          for (const t of targets) E.translateEnt3d(t, 0, 0, dz, doc);
          ctx.bump();
        }
        return;
      }
      if (np && typeof np === 'object') {
        for (const t of targets)
          E.translateEnt3d(
            t,
            np.x - g.p.x,
            np.y - g.p.y,
            (np.z ?? g.p.z ?? 0) - (g.p.z ?? 0),
            doc,
          );
        ctx.bump();
      }
      return;
    }
    this.hidden = new Set([e.id]);
    const np = await ctx.point('** STRETCH **  Specify stretch point', {
      base: g.p,
      preview: (p) => {
        const k = E.clone(e);
        E.setGrip(k, g, p, doc);
        return [k];
      },
    });
    if (np && typeof np === 'object') {
      E.setGrip(e, g, np, doc);
      ctx.bump();
    }
  }
}

/* ============================================================================================
 * 4. HELPERS
 * ========================================================================================== */

/** The words that are understood while objects are selected (All, Last, Window, ...). */
const SELECT_WORDS = [
  'all',
  'last',
  'previous',
  'window',
  'crossing',
  'remove',
  'add',
  'multiple',
  'single',
  'undo',
  'box',
  'fence',
  'wpolygon',
  'cpolygon',
  'group',
];

/** @private A vertex of a flat xyz array. */
function vtx(arr, i) {
  return [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];
}

/** @private Does a ray hit a box? (a quick test before the triangles are checked) */
function rayBoxHit(o, d, b) {
  let t0 = 0;
  let t1 = 1e18;
  for (let k = 0; k < 3; k += 1) {
    if (Math.abs(d[k]) < 1e-12) {
      if (o[k] < b[0][k] - 1e-9 || o[k] > b[1][k] + 1e-9) return false;
    } else {
      let a = (b[0][k] - o[k]) / d[k];
      let c = (b[1][k] - o[k]) / d[k];
      if (a > c) [a, c] = [c, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, c);
      if (t0 > t1) return false;
    }
  }
  return true;
}

/** Object snap words that can be typed (end, endp, endpoint, ... -> the snap mode). */
const OSNAP_TYPED = {
  gce: 'gcen',
  gcen: 'gcen',
  ext: 'ext',
  extension: 'ext',
  app: 'app',
  appint: 'app',
  par: 'par',
  parallel: 'par',
  end: 'end',
  endp: 'end',
  endpoint: 'end',
  mid: 'mid',
  midpoint: 'mid',
  cen: 'cen',
  center: 'cen',
  nod: 'nod',
  node: 'nod',
  qua: 'qua',
  quadrant: 'qua',
  int: 'int',
  intersection: 'int',
  ins: 'ins',
  insertion: 'ins',
  per: 'per',
  perpendicular: 'per',
  tan: 'tan',
  tangent: 'tan',
  nea: 'nea',
  nearest: 'nea',
};

/* ============================================================================================
 * 5. FACTORY
 * ========================================================================================== */

/**
 * Creates the application object for a canvas: renderer, file system bridge, AutoLISP interpreter,
 * text measuring (cached) and fonts.
 */
export function createApp(canvas) {
  const app = new App();
  app.renderer = new Renderer(canvas, app);
  app.fs = makeFs(app);
  app.lisp = createLisp(app);
  const mc = document.createElement('canvas').getContext('2d');
  const cache = new Map();
  E.setMeasure((s, h, st) => {
    const font = (st && st.font) || 'Arial';
    const key = font + '|' + s;
    let w = cache.get(key);
    if (w === undefined) {
      mc.font = `100px ${fontStack(font)}`;
      w = mc.measureText(s).width / 100;
      if (cache.size > 8000) cache.clear();
      cache.set(key, w);
    }
    return w * h * 1.3889 * ((st && st.wf) || 1);
  });
  // bundled fonts load asynchronously: re-measure and redraw once they are available
  loadFonts()
    .then(() => {
      cache.clear();
      E.bump();
      app.redraw();
    })
    .catch(() => {});
  return app;
}
export const _G = G;
