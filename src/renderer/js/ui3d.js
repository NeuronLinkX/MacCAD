/**
 * @file ui3d.js
 * @brief The 3D chrome around the drawing area: the WebGL canvas switch, the viewport label
 *        "[-][Custom View][Hidden][Scene]" with its pop-up menus, and the ViewCube.
 *
 * Use `init3DUI(app, h, viewarea, glCanvas, canvas)`; it returns `{syncMode}`.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import { popupMenu } from './dialogs.js';
import { SCENES, SCENE_IDS, MATERIALS, setScene, applyMaterial } from './studio.js';
import { View3D } from './view3d.js';

/* ============================================================================================
 * 2. TABLES AND CONSTANTS
 * ========================================================================================== */

/** Visual styles: [key, menu text]. */
export const VSTYLES = [
  ['2dwireframe', '2D Wireframe'],
  ['wireframe', 'Wireframe'],
  ['hidden', 'Hidden'],
  ['conceptual', 'Conceptual'],
  ['shaded', 'Shaded'],
  ['shadedEdges', 'Shaded with Edges'],
  ['xray', 'X-Ray'],
];

/** Preset views: [key, menu text]. */
export const VIEW_ITEMS = [
  ['top', 'Top'],
  ['bottom', 'Bottom'],
  ['left', 'Left'],
  ['right', 'Right'],
  ['front', 'Front'],
  ['back', 'Back'],
  ['swiso', 'SW Isometric'],
  ['seiso', 'SE Isometric'],
  ['neiso', 'NE Isometric'],
  ['nwiso', 'NW Isometric'],
];

/** Signs of the camera direction (x,y) -> isometric preset name. */
const ISO = { '-1,-1': 'swiso', '1,-1': 'seiso', '1,1': 'neiso', '-1,1': 'nwiso' };

/** ViewCube canvas size (CSS pixels), cube centre and cube radius. */
const CUBE = { S: 128, CX: 64, CY: 66, R: 30 };
/** The home button on the ViewCube. */
const HOME = { x: 14, y: 14, r: 9 };
/** Faces of the cube: outward normal, label and the corners (counter-clockwise seen from outside). */
const FACES = [
  {
    n: [0, 0, 1],
    t: 'TOP',
    q: [
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ],
  },
  {
    n: [0, 0, -1],
    t: 'BOTTOM',
    q: [
      [-1, 1, -1],
      [1, 1, -1],
      [1, -1, -1],
      [-1, -1, -1],
    ],
  },
  {
    n: [0, -1, 0],
    t: 'FRONT',
    q: [
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
      [-1, -1, 1],
    ],
  },
  {
    n: [0, 1, 0],
    t: 'BACK',
    q: [
      [1, 1, -1],
      [-1, 1, -1],
      [-1, 1, 1],
      [1, 1, 1],
    ],
  },
  {
    n: [-1, 0, 0],
    t: 'LEFT',
    q: [
      [-1, 1, -1],
      [-1, -1, -1],
      [-1, -1, 1],
      [-1, 1, 1],
    ],
  },
  {
    n: [1, 0, 0],
    t: 'RIGHT',
    q: [
      [1, -1, -1],
      [1, 1, -1],
      [1, 1, 1],
      [1, -1, 1],
    ],
  },
];

/** @returns {string} the menu text of a visual style key. */
const styleLabel = (k) => (VSTYLES.find((x) => x[0] === k) || [k, k])[1];
/** @returns {number} dot product of two 3D vectors. */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/* ============================================================================================
 * 3. VIEWPORT LABEL
 * ========================================================================================== */

/** The clickable label at the top left of the 3D view: "[-][Top][Hidden][Scene]". */
class ViewportLabel {
  /**
   * @param {object} app the application
   * @param {Function} h element factory
   */
  constructor(app, h) {
    this.app = app;
    this.h = h;
    this.el = h('div', { id: 'vlabel' });
  }

  /** @private A menu item. */
  static item(label, run, extra = {}) {
    return { label, run, ...extra };
  }

  /** @private One label part; a click opens the pop-up menu made by `items()`. */
  part(text, items) {
    const h = this.h;
    const m = /^\[(.*)\]$/.exec(text);
    const b = m
      ? h('span', { class: 'vl' }, h('i', {}, '['), m[1], h('i', {}, ']'))
      : h('span', { class: 'vl' }, text);
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = b.getBoundingClientRect();
      popupMenu(items(), r.left, r.bottom, { run: (it) => it.run && it.run() });
    });
    return b;
  }

  /** @private Menu of the "[-]" part: ViewCube, UCS icon, grid, orbit, zoom. */
  controlItems() {
    const app = this.app;
    const M = ViewportLabel.item;
    return [
      M(
        'ViewCube',
        () => {
          app.settings.viewcube = app.settings.viewcube === false;
          app.saveSettings();
          app.emit('view3d');
        },
        { check: () => app.settings.viewcube !== false },
      ),
      M('UCS Icon', () => app.toggle('ucsIcon'), { check: () => !!app.settings.ucsIcon }),
      M('Grid', () => app.toggle('grid'), { check: () => !!app.settings.grid }),
      { sep: true },
      M('3D Orbit', () => app.exec('3DORBIT')),
      M('Zoom Extents', () => app.exec('ZOOM', 'extents')),
    ];
  }

  /** @private Menu of the view part: preset views, perspective / parallel. */
  viewItems() {
    const app = this.app;
    const M = ViewportLabel.item;
    return [
      ...VIEW_ITEMS.map(([k, t]) =>
        M(t, () => app.setPreset3D(k), { check: () => app.v3 && app.v3.preset === k }),
      ),
      { sep: true },
      M('Perspective', () => app.exec('PERSPECTIVE'), { check: () => !!(app.v3 && app.v3.persp) }),
      M('Parallel', () => app.exec('PARALLEL'), { check: () => !!(app.v3 && !app.v3.persp) }),
    ];
  }

  /** @private Menu of the visual style part. */
  styleItems() {
    const app = this.app;
    const M = ViewportLabel.item;
    return VSTYLES.map(([k, t]) =>
      M(t, () => app.setVisualStyle(k), {
        check: () => (app.settings.vstyle || '2dwireframe') === k,
      }),
    );
  }

  /** @private Menu of the scene part: scenes, materials, Studio window. */
  sceneItems() {
    const app = this.app;
    const M = ViewportLabel.item;
    return [
      ...SCENE_IDS.map((id) =>
        M(SCENES[id].label, () => setScene(app, id), {
          check: () => (app.settings.scene || 'none') === id,
        }),
      ),
      { sep: true },
      {
        label: 'Material',
        sub: [
          ...Object.keys(MATERIALS).map((k) =>
            M(MATERIALS[k].label, () =>
              app.edit(`MATERIAL ${MATERIALS[k].label}`, () => applyMaterial(app, k)),
            ),
          ),
          { sep: true },
          M('Default look', () => app.edit('MATERIAL default', () => applyMaterial(app, null))),
        ],
      },
      M('Studio...', () => app.exec('STUDIO')),
    ];
  }

  /** Rebuilds the label texts from the current view, style and scene. */
  sync() {
    const app = this.app;
    this.el.innerHTML = '';
    this.el.append(
      this.part('[−]', () => this.controlItems()),
      this.part(`[${app.presetLabel()}]`, () => this.viewItems()),
      this.part(
        `[${app.v3 && app.v3.persp ? 'Perspective ' : ''}${styleLabel(app.settings.vstyle || '2dwireframe')}]`,
        () => this.styleItems(),
      ),
      this.part(
        `[${app.settings.scene && app.settings.scene !== 'none' && SCENES[app.settings.scene] ? SCENES[app.settings.scene].label : 'Scene'}]`,
        () => this.sceneItems(),
      ),
    );
  }
}

/* ============================================================================================
 * 4. VIEWCUBE
 * ========================================================================================== */

/** The ViewCube: a small cube that shows the viewing direction; click a face / edge / corner to look from there. */
class ViewCube {
  /**
   * @param {object} app the application
   * @param {Function} h element factory
   */
  constructor(app, h) {
    this.app = app;
    this.dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    this.el = h('canvas', { id: 'vcube', width: 128, height: 128, title: 'ViewCube' });
    this.el.width = this.el.height = Math.round(CUBE.S * this.dpr); // sharp on a Retina screen
    this.ctx = this.el.getContext('2d');
    /** The 2D drawing view is the plan (TOP) view. */
    this.top = new View3D({ az: -90, el: 90 }).basis();
    /** The cell under the mouse: {f: face, c: [-1|0|1 per axis]} or null. */
    this.hot = null;
    /** The mouse press in progress: {x, y, moved, p}. */
    this.drag = null;
    this.bind();
    /** The coordinate system menu under the cube: [WCS v]. */
    this.ucsBtn = h('button', { id: 'ucsbtn', type: 'button', title: 'Coordinate system' }, 'WCS \u25BE');
    this.ucsBtn.addEventListener('click', () => {
      const r = this.ucsBtn.getBoundingClientRect();
      popupMenu(
        [
          { label: 'WCS', check: () => !app.doc.ucs?.current, run: () => app.exec('UCSWORLD') },
          { sep: true },
          { label: '3 Point UCS', run: () => app.exec('UCS3POINT') },
          { label: 'Face UCS', run: () => app.exec('UCSFACE') },
          { label: 'View UCS', run: () => app.exec('UCSVIEW') },
          { label: 'Previous UCS', run: () => app.exec('UCSPREV') },
          { label: 'UCS Manager', run: () => app.exec('UCSMAN') },
        ],
        r.left,
        r.bottom + 2,
        { run: (it) => it.run() },
      );
    });
  }

  /** @private The camera basis now (the top view while the drawing is 2D). */
  basisNow() {
    return this.app.v3 ? this.app.v3.basis() : this.top;
  }

  // ---------------------------------------------------------------- geometry

  /** @private Projects a cube-space point to canvas pixels; `d` is the depth. */
  static proj(p, bs) {
    return {
      x: CUBE.CX + dot(p, bs.r) * CUBE.R,
      y: CUBE.CY - dot(p, bs.u) * CUBE.R,
      d: dot(p, bs.f),
    };
  }

  /** @private The faces that look towards the viewer, back to front. */
  static visibleFaces(bs) {
    return FACES.filter((f) => dot(f.n, bs.d) > 0.02).sort(
      (a, b) => dot(a.n, bs.d) - dot(b.n, bs.d),
    );
  }

  /** @private The cell (-1..1 per axis) of the cube surface under a pixel, or null. */
  cellAt(px, py) {
    const { R, CX, CY } = CUBE;
    const bs = this.basisNow();
    const sx = (px - CX) / R;
    const sy = -(py - CY) / R;
    for (const f of ViewCube.visibleFaces(bs).reverse()) {
      const nf = dot(f.n, bs.f);
      if (Math.abs(nf) < 1e-6) continue;
      const t = (1 - sx * dot(f.n, bs.r) - sy * dot(f.n, bs.u)) / nf;
      const P = [
        sx * bs.r[0] + sy * bs.u[0] + t * bs.f[0],
        sx * bs.r[1] + sy * bs.u[1] + t * bs.f[1],
        sx * bs.r[2] + sy * bs.u[2] + t * bs.f[2],
      ];
      if (P.every((c) => Math.abs(c) <= 1.001))
        return { f, c: P.map((c, i) => (f.n[i] ? f.n[i] : Math.abs(c) < 0.34 ? 0 : Math.sign(c))) };
    }
    return null;
  }

  /**
   * Turns the camera to look from the given direction (preset when it is a face or corner, a free
   * view otherwise).
   * @param {object} app
   * @param {number} dx @param {number} dy @param {number} dz unit direction from the target to the eye
   */
  static viewFromDir(app, dx, dy, dz) {
    const nz = Math.abs(dz);
    const n = Math.abs(dx) + Math.abs(dy) + nz;
    if (n === 1) {
      const name =
        dz > 0
          ? 'top'
          : dz < 0
            ? 'bottom'
            : dx > 0
              ? 'right'
              : dx < 0
                ? 'left'
                : dy > 0
                  ? 'back'
                  : 'front';
      app.setPreset3D(name);
      return;
    }
    if (dz > 0 && dx && dy) {
      app.setPreset3D(ISO[`${Math.sign(dx)},${Math.sign(dy)}`]);
      return;
    }
    if (!app.v3) app.enter3D(null);
    const v = app.v3;
    v.az = (Math.atan2(dy, dx) * 180) / Math.PI;
    v.el = (Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI;
    v.preset = '';
    app.emit('view3d');
    app.changed();
  }

  // ---------------------------------------------------------------- drawing

  /** Redraws the cube (hidden in paper space or when switched off). */
  draw() {
    const { ctx, app } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, CUBE.S, CUBE.S);
    if (app.settings.viewcube === false || app.space !== 'model') {
      this.el.style.display = 'none';
      this.ucsBtn.style.display = 'none';
      return;
    }
    this.el.style.display = 'block';
    this.ucsBtn.style.display = 'block';
    this.ucsBtn.textContent = `${app.doc.ucs?.current?.name || 'WCS'} \u25BE`;
    const bs = this.basisNow();
    const dark = app.renderer.dark !== false;
    this.drawShadow(bs, dark);
    this.drawCompass(bs, dark);
    for (const f of ViewCube.visibleFaces(bs)) this.drawFace(f, bs, dark);
    this.drawHome();
  }

  /** @private The soft shadow under the cube. */
  drawShadow(bs, dark) {
    const { ctx } = this;
    const sp = ViewCube.proj([0, 0, -1], bs);
    ctx.save();
    ctx.filter = 'blur(5px)';
    ctx.fillStyle = dark ? 'rgba(0,0,0,.42)' : 'rgba(30,40,70,.22)';
    ctx.beginPath();
    ctx.ellipse(sp.x + 2, sp.y + 9, CUBE.R * 1.08, CUBE.R * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** @private The compass ring on the ground: a thin double ring with tick marks, North in red. */
  drawCompass(bs, dark) {
    const { ctx } = this;
    const proj = ViewCube.proj;
    ctx.save();
    ctx.lineCap = 'round';
    const ring = (rad, w, col) => {
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      ctx.beginPath();
      for (let i = 0; i <= 64; i += 1) {
        const a = (i / 64) * Math.PI * 2;
        const p = proj([Math.cos(a) * rad, Math.sin(a) * rad, -1], bs);
        if (i) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      }
      ctx.stroke();
    };
    ring(1.46, 3.2, dark ? 'rgba(255,255,255,.07)' : 'rgba(20,30,50,.08)');
    ring(1.46, 1, dark ? 'rgba(220,226,238,.62)' : 'rgba(40,50,70,.55)');
    ring(1.66, 0.8, dark ? 'rgba(220,226,238,.28)' : 'rgba(40,50,70,.26)');
    ctx.strokeStyle = dark ? 'rgba(220,226,238,.55)' : 'rgba(40,50,70,.5)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 24; i += 1) {
      const a = (i / 24) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const r0 = 1.46;
      const r1 = i % 6 === 0 ? 1.66 : 1.56;
      const p0 = proj([c * r0, sn * r0, -1], bs);
      const p1 = proj([c * r1, sn * r1, -1], bs);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
    ctx.font = '700 9px -apple-system, "SF Pro Text", Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [lab, v] of [
      ['N', [0, 1.9, -1]],
      ['E', [1.9, 0, -1]],
      ['S', [0, -1.9, -1]],
      ['W', [-1.9, 0, -1]],
    ]) {
      const p = proj(v, bs);
      ctx.fillStyle =
        lab === 'N' ? '#ff6a5c' : dark ? 'rgba(232,236,245,.88)' : 'rgba(30,38,56,.85)';
      ctx.fillText(lab, p.x, p.y);
    }
    ctx.restore();
  }

  /** @private One face: gradient fill, bevel, outline, highlighted cell and text. */
  drawFace(f, bs, dark) {
    const { ctx, hot } = this;
    const proj = ViewCube.proj;
    const q = f.q.map((p) => proj(p, bs));
    const shade = 0.62 + 0.38 * dot(f.n, bs.d);
    ctx.beginPath();
    q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    const isHot = hot && hot.f === f && !hot.c.some((c, i) => c && !f.n[i]);
    const lt = Math.round(236 * shade + 12);
    const dk = Math.round(176 * shade + 30);
    const xs = q.map((p) => p.x);
    const ys = q.map((p) => p.y);
    const gr = ctx.createLinearGradient(
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ); // light from the upper left
    gr.addColorStop(0, isHot ? '#c4e0ff' : `rgb(${lt},${lt + 2},${Math.min(255, lt + 8)})`);
    gr.addColorStop(1, isHot ? '#6fa8f2' : `rgb(${dk},${dk + 4},${Math.min(255, dk + 14)})`);
    ctx.fillStyle = gr;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,.7)';
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore(); // a light bevel inside the edge
    ctx.lineJoin = 'round';
    ctx.strokeStyle = dark ? 'rgba(52,60,80,.9)' : 'rgba(70,80,100,.8)';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (hot && hot.f === f) this.drawHotCell(f, bs);
    if (dot(f.n, bs.d) > 0.35) this.drawFaceText(f, q);
  }

  /** @private Highlights the hovered edge / corner cell of a face. */
  drawHotCell(f, bs) {
    const { ctx, hot } = this;
    const c = hot.c;
    if (!c.some((v, i) => v && !f.n[i])) return;
    const pts = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([sa, sb]) => {
      const P = f.n.map((nv) => (nv ? nv : 0));
      const ax = [0, 1, 2].filter((i) => !f.n[i]);
      const a0 = c[ax[0]] ? (c[ax[0]] > 0 ? 0.33 : -1) : -0.33;
      const a1 = c[ax[0]] ? (c[ax[0]] > 0 ? 1 : -0.33) : 0.33;
      const b0 = c[ax[1]] ? (c[ax[1]] > 0 ? 0.33 : -1) : -0.33;
      const b1 = c[ax[1]] ? (c[ax[1]] > 0 ? 1 : -0.33) : 0.33;
      P[ax[0]] = sa < 0 ? a0 : a1;
      P[ax[1]] = sb < 0 ? b0 : b1;
      return ViewCube.proj(P, bs);
    });
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(64,140,255,.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.75)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /** @private The face name; the text follows the face orientation. */
  drawFaceText(f, q) {
    const { ctx } = this;
    const cx = q.reduce((s, p) => s + p.x, 0) / 4;
    const cy = q.reduce((s, p) => s + p.y, 0) / 4;
    const a = q[0];
    const b = q[1];
    let ang = Math.atan2(b.y - a.y, b.x - a.x);
    if (ang > Math.PI / 2) ang -= Math.PI;
    if (ang < -Math.PI / 2) ang += Math.PI;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.font = '650 9.5px -apple-system, "SF Pro Text", Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    try {
      ctx.letterSpacing = '0.7px';
    } catch {
      /* older engines */
    }
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.fillText(f.t, 0, 0.8);
    ctx.fillStyle = '#233049';
    ctx.fillText(f.t, 0, 0);
    ctx.restore();
  }

  /** @private The home button: a small glass disc with a house on it. */
  drawHome() {
    const { ctx } = this;
    const g = ctx.createRadialGradient(HOME.x - 3, HOME.y - 4, 1, HOME.x, HOME.y, HOME.r + 1);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, '#bcc6d8');
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1.5;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(HOME.x, HOME.y, HOME.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(70,84,112,.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(HOME.x, HOME.y, HOME.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#34507f';
    ctx.beginPath();
    ctx.moveTo(HOME.x - 5, HOME.y + 0.5);
    ctx.lineTo(HOME.x, HOME.y - 4.5);
    ctx.lineTo(HOME.x + 5, HOME.y + 0.5);
    ctx.lineTo(HOME.x + 3.5, HOME.y + 0.5);
    ctx.lineTo(HOME.x + 3.5, HOME.y + 4);
    ctx.lineTo(HOME.x - 3.5, HOME.y + 4);
    ctx.lineTo(HOME.x - 3.5, HOME.y + 0.5);
    ctx.closePath();
    ctx.fill();
  }

  // ---------------------------------------------------------------- mouse

  /** @private The mouse position in cube pixels. */
  loc(e) {
    const r = this.el.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * CUBE.S,
      y: ((e.clientY - r.top) / r.height) * CUBE.S,
    };
  }

  /** @private Connects the mouse handlers: hover, drag to orbit, click to turn the view. */
  bind() {
    const { el, app } = this;
    el.addEventListener('mousemove', (e) => {
      const p = this.loc(e);
      const drag = this.drag;
      if (drag) {
        if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
        if (drag.moved) {
          if (!app.v3) app.enter3D('top');
          app.orbitBy(e.clientX - drag.x, e.clientY - drag.y);
          drag.x = e.clientX;
          drag.y = e.clientY;
        }
        return;
      }
      this.hot = this.cellAt(p.x, p.y);
      this.draw();
    });
    el.addEventListener('mouseleave', () => {
      this.hot = null;
      this.draw();
    });
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.drag = { x: e.clientX, y: e.clientY, moved: false, p: this.loc(e) };
    });
    window.addEventListener('mouseup', () => {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      if (d.moved) return;
      if (Math.hypot(d.p.x - HOME.x, d.p.y - HOME.y) <= HOME.r) {
        app.setPreset3D('swiso');
        app.zoomExtents(false);
        return;
      }
      const hit = this.cellAt(d.p.x, d.p.y);
      if (!hit) return;
      if (!app.v3 && !hit.c[0] && !hit.c[1] && hit.c[2] === 1) return; // already looking at TOP in 2D
      ViewCube.viewFromDir(app, hit.c[0], hit.c[1], hit.c[2]);
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
      },
      { passive: false },
    );
  }
}

/* ============================================================================================
 * 5. FACTORY
 * ========================================================================================== */

/**
 * Creates the 3D chrome and connects it to the application.
 * @param {object} app the application
 * @param {Function} h element factory `h(tag, attrs, ...children)`
 * @param {HTMLElement} viewarea the drawing area the label and the cube are put into
 * @param {HTMLCanvasElement} glCanvas the WebGL canvas
 * @param {HTMLCanvasElement} canvas the 2D drawing canvas
 * @returns {{syncMode: Function}} `syncMode()` refreshes the chrome after a mode change
 */
export function init3DUI(app, h, viewarea, glCanvas, canvas) {
  app.cv = canvas;
  app.renderer.attachGL(glCanvas);
  const label = new ViewportLabel(app, h);
  const cube = new ViewCube(app, h);
  viewarea.append(label.el, cube.el, cube.ucsBtn);

  // 3D mode shows the GL canvas and the label; both modes show the cube
  const syncMode = () => {
    const is3 = !!app.v3;
    glCanvas.style.display = is3 ? 'block' : 'none';
    label.el.style.display = is3 ? 'block' : 'none';
    label.sync();
    cube.draw();
  };
  app.on('view3d', syncMode);
  app.on('settings', syncMode);
  app.on('space', syncMode);
  app.on('view', () => cube.draw());
  app.on('doc', () => cube.draw());
  syncMode();
  return { syncMode };
}
