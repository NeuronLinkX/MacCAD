/**
 * @file render.js
 * @brief The canvas renderer: entities, grid, selection, grips, snap markers, cursor, UCS icon, and
 *        the 3D view (through the WebGL renderer in gl3d.js).
 *
 * `View` maps between drawing and screen coordinates; `Renderer` draws one frame of the active
 * view when `request()` is called (at most one frame per animation frame).
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */

import * as G from './geom.js';
import * as E from './entities.js';
import { aciHex } from './doc.js';
import { FONT_K } from './svg.js';
import { fontStack } from './fonts.js';
import * as K from './kernel3d.js';
import {
  SCENES,
  sceneOf,
  materialOf,
  DEFAULT_MATERIAL,
  MATERIALS,
  backdrop,
  paintOf,
  hexRgb,
} from './studio.js';
import { GL3D } from './gl3d.js';
import * as S3 from './selection3d.js';

/* ============================================================================================
 * 2. VIEW (DRAWING <-> SCREEN COORDINATES)
 * ========================================================================================== */

/**
 * A view of the drawing: centre (cx, cy) and zoom (pixels per drawing unit) on a canvas of w x h
 * pixels.
 */
export class View {
  /** @param {{cx: number, cy: number, zoom: number}} [v] the view to start from */
  constructor(v = { cx: 0, cy: 0, zoom: 1 }) {
    this.cx = v.cx;
    this.cy = v.cy;
    this.zoom = v.zoom;
    this.w = 800;
    this.h = 600;
  }

  /**
   * Drawing point -> screen pixel.
   * @param {{x: number, y: number}} p
   * @returns {{x: number, y: number}}
   */
  w2s(p) {
    return {
      x: (p.x - this.cx) * this.zoom + this.w / 2,
      y: this.h / 2 - (p.y - this.cy) * this.zoom,
    };
  }

  /**
   * Screen pixel -> drawing point.
   * @returns {{x: number, y: number}}
   */
  s2w(x, y) {
    return { x: (x - this.w / 2) / this.zoom + this.cx, y: (this.h / 2 - y) / this.zoom + this.cy };
  }

  /**
   * @returns {{cx: number, cy: number, zoom: number}} a copy of the view settings (centre and
   *     zoom).
   */
  save() {
    return { cx: this.cx, cy: this.cy, zoom: this.zoom };
  }

  /**
   * A view inside a paper-space viewport: maps model coordinates to screen pixels of that viewport.
   * @param {object} vp the viewport object
   */
  sub(vp) {
    const s = new View({ cx: vp.cx, cy: vp.cy, zoom: this.zoom * vp.scale });
    const m = { x: (vp.p1.x + vp.p2.x) / 2, y: (vp.p1.y + vp.p2.y) / 2 };
    const ms = this.w2s(m);
    s.w = this.w;
    s.h = this.h;
    s.w2s = (p) => ({ x: ms.x + (p.x - vp.cx) * s.zoom, y: ms.y - (p.y - vp.cy) * s.zoom });
    s.s2w = (x, y) => ({ x: (x - ms.x) / s.zoom + vp.cx, y: (ms.y - y) / s.zoom + vp.cy });
    return s;
  }
}

/* ============================================================================================
 * 3. RENDERER
 * ========================================================================================== */

/** Line width in pixels for a lineweight in mm (at least 1 pixel). */
export const LW_PX = (mm) => Math.max(1, mm * 3.78 * 0.9);

/**
 * Object types that get no halo behind their lines (text, hatches, blocks, solids, points, ...).
 */
const HALO_SKIP = new Set([
  'text',
  'mtext',
  'hatch',
  'insert',
  'solid3d',
  'point',
  'viewport',
  'image',
  'wipeout',
]);

/**
 * Draws the drawing on the canvas. Call `request()` after a change; the frame is drawn once per
 * animation frame.
 */
export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas the 2D canvas
   * @param {object} app the application
   */
  constructor(canvas, app) {
    this.cv = canvas;
    this.app = app;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this._raf = 0;
    this.gl = null;
  }

  /**
   * Connects the WebGL canvas of the 3D view. When WebGL2 is not available the 3D view is drawn on
   * the 2D canvas.
   */
  attachGL(canvas) {
    try {
      this.gl = new GL3D(canvas);
      if (!this.gl.ok) this.gl = null;
    } catch {
      this.gl = null;
    }
  }

  /** Sizes the canvas to w x h CSS pixels (sharp on Retina screens) and tells the application. */
  resize(w, h) {
    this.dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.round(w * this.dpr);
    this.cv.height = Math.round(h * this.dpr);
    this.cv.style.width = w + 'px';
    this.cv.style.height = h + 'px';
    this.app.view.w = w;
    this.app.view.h = h;
    if (this.app.v3) {
      this.app.v3.w = w;
      this.app.v3.h = h;
    }
    if (this.gl) this.gl.resize(w, h, this.dpr);
    this.request();
  }

  /** Asks for a redraw; many requests in one animation frame make one redraw. */
  request() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.draw();
    });
  }

  // ---------------------------------------------------------------- colours

  /**
   * The screen colour of an AutoCAD colour: colour 7 is white on the dark background and black on
   * the white one.
   */
  fg(c) {
    return c === 7 || c === '#ffffff' || c === '#FFFFFF'
      ? this.dark
        ? '#ffffff'
        : '#000000'
      : aciHex(c);
  }

  /**
   * Draws one frame: background, paper, grid, objects, selection, grips and the overlays (snap,
   * cursor, UCS icon).
   */
  draw() {
    const { app, ctx } = this;
    const v = app.activeViewDraw();
    const doc = app.doc;
    const is3 = !!app.v3;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const inLayout = app.space !== 'model';
    this.dark = !(inLayout && app.settings.paperBg) && !app.settings.whiteBg;
    if (is3 && this.studioScene(app)) this.dark = !!this.studioScene(app).dark; // overlays (cursor, axes) must show on the scene picture
    const bgCol = inLayout && app.settings.paperBg ? '#a9a9a9' : this.dark ? '#000000' : '#ffffff';
    let glGrid = false; // the 3D grid is drawn by WebGL (behind the solids) whenever there are solids
    if (is3) {
      if (app.cv) app.cv.style.background = 'transparent';
      ctx.clearRect(0, 0, v.w, v.h);
      glGrid = this.drawSolids3D(app, v, bgCol);
    } else {
      if (app.cv) app.cv.style.background = '';
      if (this.gl) {
        this.gl.gl.clearColor(0, 0, 0, 0);
      }
      ctx.fillStyle = bgCol;
      ctx.fillRect(0, 0, v.w, v.h);
    }

    if (inLayout) this.drawPaper(ctx, v);
    if (app.settings.grid && !glGrid) is3 ? this.drawGrid3D(ctx, v) : this.drawGrid(ctx, v);

    ctx.save();
    if (!inLayout) {
      this.drawEnts(ctx, v, doc.model, {});
    } else {
      const lay = doc.layouts[app.space];
      for (const e of lay.ents) {
        if (e.type === 'viewport') this.drawViewport(ctx, v, e);
        else if (doc.visible(e) && !this.app.hidden.has(e.id)) this.drawEntity(ctx, e, v, {});
      }
    }
    ctx.restore();

    // selection highlight
    const ents = app.curEnts();
    if (app.sel.size || app.preSel.size) {
      ctx.save();
      for (const e of ents)
        if ((app.sel.has(e.id) || app.preSel.has(e.id)) && doc.visible(e) && !app.hidden.has(e.id))
          this.drawEntity(ctx, e, app.entView(e) || v, { hl: true });
      ctx.restore();
    }
    // hover highlight
    if (app.hover && !app.sel.has(app.hover.id))
      this.drawEntity(ctx, app.hover, app.entView(app.hover) || v, { hover: true });

    // temporary / rubber-band entities
    for (const t of app.temp) this.drawEntity(ctx, t, app.entView?.(t) || v, { temp: true });

    if (app.lispOverlay && app.lispOverlay.length) {
      ctx.save();
      ctx.lineWidth = 1;
      for (const o of app.lispOverlay) {
        const a = v.w2s(o.a);
        const b = v.w2s(o.b);
        ctx.strokeStyle = typeof o.col === 'number' ? aciHex(o.col === 7 ? 7 : o.col) : '#fff';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.restore();
    }
    this.drawGrips(ctx, v);
    this.drawTrack(ctx, v);
    this.drawRubber(ctx);
    if (app.settings.ucsIcon) is3 ? this.drawUCS3D(ctx, v) : this.drawUCS(ctx, v, inLayout);
    if (is3) {
      this.drawPlanePicker(ctx, v);
      this.drawFaceHighlights(ctx, v);
      this.drawEdgeHighlights(ctx, v);
      if (app.settings.faceUcs !== false) this.drawFaceUCS(ctx, v);
    }
    this.drawSnap(ctx, v);
    this.drawCrosshair(ctx, v);
  }

  /** Draws the sheet of a layout (shadow, paper, border). */
  drawPaper(ctx, v) {
    const lay = this.app.doc.layouts[this.app.space];
    const W = lay.paper.w;
    const H = lay.paper.h;
    const a = v.w2s({ x: 0, y: H });
    const b = v.w2s({ x: W, y: 0 });
    if (this.app.settings.paperBg) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(a.x + 4, a.y + 4, b.x - a.x, b.y - a.y);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
    } else {
      ctx.strokeStyle = '#ff0000';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }
    const m = 5;
    const c = v.w2s({ x: m, y: H - m });
    const d = v.w2s({ x: W - m, y: m });
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = this.app.settings.paperBg ? '#999' : '#8a8a8a';
    ctx.lineWidth = 1;
    ctx.strokeRect(c.x, c.y, d.x - c.x, d.y - c.y);
    ctx.restore();
  }

  /** Clickable, target-sized XY/YZ/ZX cards used while a split/trim plane is being chosen. */
  drawPlanePicker(ctx, v) {
    const app = this.app, picker = app.req?.opts?.planePicker;
    if (!picker?.choices?.length) return;
    const hovered = app.planeHover?.name;
    ctx.save();
    for (const choice of picker.choices) {
      const hot = choice.name === hovered, scale = hot ? 1.1 : 1;
      const world = choice.corners.map((p) => p.map((x, i) => choice.center[i] + (x - choice.center[i]) * scale));
      const poly = world.map((p) => v.w2s({ x: p[0], y: p[1], z: p[2] }));
      ctx.beginPath();
      poly.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = hot ? 'rgba(40,160,255,.30)' : 'rgba(80,145,225,.085)';
      ctx.strokeStyle = hot ? 'rgba(120,215,255,.98)' : 'rgba(130,185,245,.48)';
      ctx.lineWidth = hot ? 3.5 : 1.25;
      ctx.fill(); ctx.stroke();
      ctx.setLineDash(hot ? [7, 4] : [3, 5]);
      ctx.lineWidth = hot ? 1.7 : 1;
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y); ctx.lineTo(poly[2].x, poly[2].y);
      ctx.moveTo(poly[1].x, poly[1].y); ctx.lineTo(poly[3].x, poly[3].y);
      ctx.stroke(); ctx.setLineDash([]);
      const li = choice.name === 'XY' ? 1 : choice.name === 'YZ' ? 2 : 3;
      const lab = poly[li], text = hot ? `${choice.name} cutting plane · click` : choice.name;
      ctx.font = `${hot ? 'bold ' : ''}12px -apple-system, BlinkMacSystemFont, sans-serif`;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = hot ? 'rgba(16,42,68,.94)' : 'rgba(25,37,55,.78)';
      ctx.fillRect(lab.x - tw / 2 - 7, lab.y - 23, tw + 14, 20);
      ctx.fillStyle = hot ? '#e9f8ff' : '#c9e5ff';
      ctx.fillText(text, lab.x - tw / 2, lab.y - 9);
    }
    if (app.planeHover) {
      const choice = app.planeHover, axes = S3.faceAxes(choice.normal);
      const o = v.w2s({ x: choice.center[0], y: choice.center[1], z: choice.center[2] });
      const axis = (a, color, label) => {
        const q = v.w2s({ x: choice.center[0] + a[0], y: choice.center[1] + a[1], z: choice.center[2] + a[2] });
        const dx = q.x - o.x, dy = q.y - o.y, l = Math.hypot(dx, dy) || 1, ex = o.x + dx / l * 48, ey = o.y + dy / l * 48;
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, sans-serif'; ctx.fillText(label, ex + 5, ey + 4);
      };
      if (axes) { axis(axes.x, '#ff5a52', 'X'); axis(axes.y, '#39d353', 'Y'); axis(axes.z, '#4ba3ff', 'Z'); }
    }
    ctx.restore();
  }

  /**
   * The grid behind the drawing in the two styles of AutoCAD: lines (thin lines with a stronger
   * line every GRIDMAJOR-th one, red and green axes at the origin) or dots.
   */
  drawGrid(ctx, v) {
    const app = this.app;
    const sp = app.settings.gridSpacing;
    let step = sp;
    while (step * v.zoom < 7) step *= 5;
    const lim =
      app.space === 'model' && app.settings.limitsOn !== false && app.doc.limits
        ? app.doc.limits
        : null;
    const lay = app.space !== 'model' ? app.doc.layouts[app.space] : null;
    if (app.settings.gridStyle !== 'dots') return this.drawGridLines(ctx, v, step, lim, lay);
    const w0 = v.s2w(0, v.h);
    const w1 = v.s2w(v.w, 0);
    const x0 = Math.floor(w0.x / step) * step;
    const y0 = Math.floor(w0.y / step) * step;
    const nx = Math.ceil((w1.x - x0) / step) + 1;
    const ny = Math.ceil((w1.y - y0) / step) + 1;
    if (nx * ny > 90000) return;
    ctx.fillStyle = this.dark ? '#5a6a7a' : '#7a7a7a';
    for (let i = 0; i < nx; i += 1)
      for (let j = 0; j < ny; j += 1) {
        const p = v.w2s({ x: x0 + i * step, y: y0 + j * step });
        if (lay) {
          const wx = x0 + i * step;
          const wy = y0 + j * step;
          if (wx < 0 || wy < 0 || wx > lay.paper.w || wy > lay.paper.h) continue;
        }
        if (lim) {
          const wx = x0 + i * step;
          const wy = y0 + j * step;
          if (wx < lim.x0 - 1e-9 || wy < lim.y0 - 1e-9 || wx > lim.x1 + 1e-9 || wy > lim.y1 + 1e-9)
            continue;
        }
        ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
      }
  }

  /** The grid as lines. */
  drawGridLines(ctx, v, step, lim, lay) {
    const app = this.app;
    const major = Math.max(2, Math.round(app.settings.gridMajor || 5));
    const dark = this.dark;
    const w0 = v.s2w(0, v.h);
    const w1 = v.s2w(v.w, 0);
    // the part of the plane that has a grid: the whole window, the drawing limits, or the sheet of a layout
    const r = lay
      ? { x0: 0, y0: 0, x1: lay.paper.w, y1: lay.paper.h }
      : lim
        ? { x0: lim.x0, y0: lim.y0, x1: lim.x1, y1: lim.y1 }
        : { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity };
    const ax0 = Math.max(w0.x, r.x0);
    const ax1 = Math.min(w1.x, r.x1);
    const ay0 = Math.max(w0.y, r.y0);
    const ay1 = Math.min(w1.y, r.y1);
    if (!(ax0 < ax1 && ay0 < ay1)) return;
    const i0 = Math.ceil(ax0 / step - 1e-9);
    const i1 = Math.floor(ax1 / step + 1e-9);
    const j0 = Math.ceil(ay0 / step - 1e-9);
    const j1 = Math.floor(ay1 / step + 1e-9);
    if (i1 - i0 + 1 + (j1 - j0 + 1) > 2000) return;
    const px = step * v.zoom;
    const fade = Math.max(0, Math.min(1, (px - 6) / 10)); // thin lines fade out as they get close together; the strong ones stay
    const path = () => {
      const p = new Path2D();
      return p;
    };
    const minor = path();
    const strong = path();
    // a line between two world points; a vertical or horizontal one sits on the middle of a pixel so that it stays sharp
    const seg = (p, ax, ay, bx, by) => {
      const a = v.w2s({ x: ax, y: ay });
      const b = v.w2s({ x: bx, y: by });
      if (Math.abs(a.x - b.x) < 0.01) {
        const x = Math.round(a.x) + 0.5;
        p.moveTo(x, a.y);
        p.lineTo(x, b.y);
      } else if (Math.abs(a.y - b.y) < 0.01) {
        const y = Math.round(a.y) + 0.5;
        p.moveTo(a.x, y);
        p.lineTo(b.x, y);
      } else {
        p.moveTo(a.x, a.y);
        p.lineTo(b.x, b.y);
      }
    };
    const ex0 = Math.max(ax0, r.x0);
    const ex1 = Math.min(ax1, r.x1);
    for (let i = i0; i <= i1; i += 1)
      seg(i % major === 0 ? strong : minor, i * step, ay0, i * step, ay1);
    for (let j = j0; j <= j1; j += 1)
      seg(j % major === 0 ? strong : minor, ex0, j * step, ex1, j * step);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';
    if (fade > 0) {
      ctx.strokeStyle = dark ? `rgba(130,150,175,${0.2 * fade})` : `rgba(0,0,0,${0.11 * fade})`;
      ctx.stroke(minor);
    }
    ctx.strokeStyle = dark ? 'rgba(130,150,175,0.44)' : 'rgba(0,0,0,0.28)';
    ctx.stroke(strong);
    // the axes of the world: X red, Y green, as in the newer AutoCAD
    if (!lay) {
      const axes = (p, c) => {
        ctx.strokeStyle = c;
        ctx.lineWidth = 1.5;
        ctx.stroke(p);
      };
      if (ax0 <= 0 && ax1 >= 0) {
        const p = path();
        seg(p, 0, ay0, 0, ay1);
        axes(p, dark ? 'rgba(80,210,110,0.62)' : 'rgba(30,150,60,0.6)');
      }
      if (ay0 <= 0 && ay1 >= 0) {
        const p = path();
        seg(p, ax0, 0, ax1, 0);
        axes(p, dark ? 'rgba(240,90,90,0.62)' : 'rgba(210,50,50,0.6)');
      }
    }
    ctx.restore();
  }

  /**
   * Draws a list of objects. Objects outside the window are skipped; in a 3D view everything is
   * drawn and the canvas clips.
   */
  drawEnts(ctx, v, list, o) {
    const doc = this.app.doc;
    // objects outside the window are skipped. In a 3D view the window on the ground is a rotated parallelogram, so two corners say nothing about it
    // (objects away from the middle disappeared in the isometric views): there everything is drawn and the canvas clips.
    const cull = !v.is3d;
    const w0 = cull ? v.s2w(0, v.h) : null;
    const w1 = cull ? v.s2w(v.w, 0) : null;
    const pad = 2 / v.zoom;
    for (const e of list) {
      if (!doc.visible(e) || this.app.hidden.has(e.id)) continue;
      if (cull && e.type !== 'xline' && e.type !== 'ray') {
        const b = E.bbox(e, doc);
        if (b && (b.x1 < w0.x - pad || b.x0 > w1.x + pad || b.y1 < w0.y - pad || b.y0 > w1.y + pad))
          continue;
      }
      this.drawEntity(ctx, e, this.app.entView?.(e) || v, o);
    }
  }

  /** Draws a layout viewport: its frame and the model space seen through it. */
  drawViewport(ctx, v, vp) {
    const a = v.w2s({ x: vp.p1.x, y: vp.p2.y });
    const b = v.w2s({ x: vp.p2.x, y: vp.p1.y });
    const active = this.app.mspace === vp.id;
    ctx.save();
    ctx.beginPath();
    ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.clip();
    const sv = v.sub(vp);
    this.drawEnts(ctx, sv, this.app.doc.model, { inVp: true });
    ctx.restore();
    if (this.app.doc.visible(vp)) {
      ctx.save();
      ctx.strokeStyle = active
        ? this.dark
          ? '#ffffff'
          : '#000'
        : this.fg(this.app.doc.effColor(vp));
      ctx.lineWidth = active ? 3 : 1;
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------- entity drawing

  /**
   * Draws one object with its colour, lineweight and linetype (hover, selection and temporary
   * objects look different).
   */
  drawEntity(ctx, e, v, o) {
    const doc = this.app.doc;
    if (e.type === 'viewport') return;
    const settings = this.app.settings;
    let col = this.fg(doc.effColor(e));
    if (o.temp) col = this.dark ? '#ffffff' : '#000000';
    if (o.hover) col = '#9fc5ff';
    const lw = settings.lwt ? LW_PX(doc.effLw(e) || 0.25) : 1;
    if ((o.hl || o.hover) && !HALO_SKIP.has(e.type)) {
      // soft halo under the highlight so selected / pre-selected objects stand out
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([]);
      ctx.lineWidth = Math.max(1, lw) + (o.hl ? 5 : 4);
      const hc = o.hl ? 'rgba(70,140,255,0.34)' : 'rgba(150,205,255,0.42)';
      ctx.strokeStyle = hc;
      ctx.fillStyle = 'rgba(0,0,0,0)';
      this.drawGeom(ctx, e, v, { ...o, halo: true }, hc);
      ctx.restore();
    }
    ctx.save();
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = o.hl ? Math.max(1, lw) : lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (o.hl) {
      ctx.strokeStyle = col;
      ctx.setLineDash([7, 4]);
      ctx.globalAlpha = 0.95;
    } else if (!o.temp || e.ltype) {
      const dash = this.dashFor(e, v);
      if (dash) ctx.setLineDash(dash);
    }
    if (o.temp) ctx.setLineDash(e._dash || []);
    this.drawGeom(ctx, e, v, o, col);
    ctx.restore();
  }

  /**
   * The canvas dash pattern of an object's linetype at the current zoom (null for a continuous
   * line).
   */
  dashFor(e, v) {
    const doc = this.app.doc;
    const name = doc.effLtype(e);
    const pat = doc.ltypes[name];
    if (!pat || !pat.length) return null;
    const sc = (doc.ltscale || 1) * (e.ltscale || 1) * v.zoom;
    const arr = pat.map((x) => (x === 0 ? 1.2 : Math.abs(x) * sc));
    const period = pat.reduce((t, x) => t + Math.abs(x), 0) * sc;
    if (period < 3) return null;
    return arr.map((n, i) => (pat[i] < 0 ? n : Math.max(n, 1)));
  }

  /**
   * Adds primitives (straight pieces and arcs) to the canvas path; pieces that join stay one
   * subpath.
   */
  pathPrims(ctx, prims, v) {
    let last = null;
    ctx.beginPath();
    for (const P of prims) {
      const st = G.primStart(P);
      const cont = last && G.dist(last, st) < 1e-9 * Math.max(1, Math.abs(st.x) + Math.abs(st.y));
      if (P.k === 's') {
        const a = v.w2s(P.a);
        const b = v.w2s(P.b);
        if (!cont) ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      } else if (v.is3d) {
        const pts = G.arcPoints(P.c, P.r, P.a0, P.a1, Math.max(P.r / 200, 1e-6));
        if (P.rev) pts.reverse();
        pts.forEach((q, i) => {
          const s = v.w2s(q);
          if (i === 0 && !cont) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
      } else {
        const c = v.w2s(P.c);
        const r = P.r * v.zoom;
        const full = Math.abs(P.a1 - P.a0) >= G.TAU - 1e-9;
        if (full) {
          ctx.moveTo(c.x + r, c.y);
          ctx.arc(c.x, c.y, r, 0, G.TAU);
        } else {
          const s = v.w2s(G.arcPt(P, P.rev ? P.a1 : P.a0));
          if (!cont) ctx.moveTo(s.x, s.y);
          if (P.rev) ctx.arc(c.x, c.y, r, -P.a1, -P.a0, false);
          else ctx.arc(c.x, c.y, r, -P.a0, -P.a1, true);
        }
      }
      last = G.primEnd(P);
    }
    ctx.stroke();
  }

  /** Draws single-line and multiline text. Very small text is drawn as a box. */
  drawText(ctx, t, v, col, doc) {
    const L = E.textLayout(t, doc);
    const fs = t.h * v.zoom * FONT_K;
    const p = v.w2s(t.p);
    if (fs < 2.5) {
      const poly = E.textBoxPoly(t, doc).map((q) => v.w2s(q));
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = col;
      ctx.beginPath();
      poly.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      return;
    }
    ctx.save();
    if (v.is3d) {
      const k = 1 / v.zoom;
      const ex = v.w2s({
        x: t.p.x + Math.cos(t.rot || 0),
        y: t.p.y + Math.sin(t.rot || 0),
        z: t.p.z || 0,
      });
      const ey = v.w2s({
        x: t.p.x - Math.sin(t.rot || 0),
        y: t.p.y + Math.cos(t.rot || 0),
        z: t.p.z || 0,
      });
      ctx.transform(
        (ex.x - p.x) * k,
        (ex.y - p.y) * k,
        -(ey.x - p.x) * k,
        -(ey.y - p.y) * k,
        p.x,
        p.y,
      );
    } else {
      ctx.translate(p.x, p.y);
      ctx.rotate(-(t.rot || 0));
    }
    const st = L.st || {};
    if (st.obl) ctx.transform(1, 0, -Math.tan((st.obl * Math.PI) / 180), 1, 0, 0);
    ctx.scale(st.wf || 1, 1);
    ctx.font = `${fs}px ${fontStack(st.font)}`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = col;
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, fs / 18);
    for (const it of L.items) {
      ctx.fillText(it.s, it.x * v.zoom, -it.y * v.zoom);
      if (t.u || t.o) {
        const w = ctx.measureText(it.s).width;
        const x = it.x * v.zoom;
        const y = -it.y * v.zoom;
        ctx.beginPath();
        if (t.u) {
          ctx.moveTo(x, y + fs * 0.12);
          ctx.lineTo(x + w, y + fs * 0.12);
        }
        if (t.o) {
          ctx.moveTo(x, y - fs * 0.85);
          ctx.lineTo(x + w, y - fs * 0.85);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Draws the geometry of one object by type. */
  drawGeom(ctx, e, v, o, col) {
    const doc = this.app.doc;
    switch (e.type) {
      case 'line':
      case 'circle':
      case 'arc':
      case 'ellipse':
      case 'pline':
      case 'spline':
      case 'xline':
      case 'ray':
        this.pathPrims(ctx, E.prims(e, doc), v);
        break;
      case 'leader': {
        this.pathPrims(ctx, E.prims(e, doc), v);
        if (e.pts.length > 1 && !e.noArrow) {
          const a = { tip: e.pts[0], dir: G.norm(G.sub(e.pts[0], e.pts[1])) };
          this.fillPoly(ctx, E.arrowPoly({ tip: a.tip, dir: G.mul(a.dir, -1) }, e.h || 2.5), v);
        }
        if (e.str && e.tp)
          this.drawText(
            ctx,
            { type: 'text', p: e.tp, h: e.h, str: e.str, rot: 0, al: 0, style: e.style },
            v,
            col,
            doc,
          );
        break;
      }
      case 'donut': {
        const c = v.w2s(e.c);
        ctx.beginPath();
        ctx.arc(c.x, c.y, e.rout * v.zoom, 0, G.TAU);
        ctx.arc(c.x, c.y, e.rin * v.zoom, 0, G.TAU, true);
        ctx.fill('evenodd');
        ctx.stroke();
        break;
      }
      case 'point':
        this.drawPoint(ctx, e.p, v);
        break;
      case 'solid3d': {
        if (v.is3d && !o.hl && !o.hover && !o.temp) break;
        this.drawSolidEdges(ctx, e, v);
        break;
      }
      case 'text':
      case 'mtext':
        this.drawText(ctx, e, v, col, doc);
        break;
      case 'hatch': {
        if (e.pattern === 'SOLID' || e.pattern === 'WIPE') {
          if (e.pattern === 'WIPE') ctx.fillStyle = this.dark ? '#000000' : '#ffffff';
          ctx.beginPath();
          for (const l of e.loops)
            (l.forEach((q, i) => {
              const s = v.w2s(q);
              if (i) ctx.lineTo(s.x, s.y);
              else ctx.moveTo(s.x, s.y);
            }),
              ctx.closePath());
          ctx.fill('evenodd');
        } else {
          const lines = E.hatchLines(e);
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (const [a, b] of lines) {
            const p = v.w2s(a);
            const q = v.w2s(b);
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
          }
          ctx.stroke();
        }
        break;
      }
      case 'dim': {
        const g = E.dimGeom(e, doc);
        ctx.beginPath();
        for (const [a, b] of g.lines) {
          const p = v.w2s(a);
          const q = v.w2s(b);
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();
        for (const a of g.arcs) this.pathPrims(ctx, [G.A(a.c, a.r, a.a0, a.a1)], v);
        ctx.setLineDash([]);
        for (const ar of g.arrows) {
          const sh = E.arrowShapes(ar, g.ds.asz);
          for (const poly of sh.fill || []) this.fillPoly(ctx, poly, v);
          for (const pl of sh.stroke || []) {
            ctx.beginPath();
            pl.forEach((q, i) => {
              const s = v.w2s(q);
              if (i) ctx.lineTo(s.x, s.y);
              else ctx.moveTo(s.x, s.y);
            });
            ctx.stroke();
          }
          for (const d of sh.dots || []) {
            const c0 = v.w2s(d.c);
            const c1 = v.w2s({ x: d.c.x + d.r, y: d.c.y, z: d.c.z });
            ctx.beginPath();
            ctx.arc(c0.x, c0.y, Math.hypot(c1.x - c0.x, c1.y - c0.y), 0, G.TAU);
            ctx.fill();
          }
        }
        const tcol = g.ds.tcolor != null && !o.hl ? this.fg(g.ds.tcolor) : col; // dimension text colour (DIMCLRT)
        for (const t of [g.text, ...g.extra])
          if (t)
            this.drawText(
              ctx,
              { type: 'text', p: t.p, h: t.h, str: t.str, rot: t.rot, al: t.al, style: 'Standard' },
              v,
              tcol,
              doc,
            );
        break;
      }
      case 'insert':
        if(e.clip?.pts?.length){ctx.save();ctx.beginPath();e.clip.pts.forEach((q,i)=>{const s=v.w2s(q);if(i)ctx.lineTo(s.x,s.y);else ctx.moveTo(s.x,s.y);});ctx.closePath();ctx.clip();}
        for (const k of E.leaves(e, doc)) {
          if (doc.visible(k)) this.drawEntity(ctx, k, v, { ...o, inherit: true });
        }
        if(e.clip?.pts?.length)ctx.restore();
        break;
      default:
        break;
    }
  }

  /** Fills a polygon given in drawing coordinates. */
  fillPoly(ctx, pts, v) {
    ctx.beginPath();
    pts.forEach((q, i) => {
      const s = v.w2s(q);
      if (i) ctx.lineTo(s.x, s.y);
      else ctx.moveTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.fill();
  }

  /** Draws a POINT object in the current point style (PDMODE) and size (PDSIZE). */
  drawPoint(ctx, p, v) {
    const doc = this.app.doc;
    const mode = doc.pdmode;
    const s = v.w2s(p);
    let size =
      doc.pdsize > 0
        ? doc.pdsize * v.zoom
        : doc.pdsize < 0
          ? (-doc.pdsize / 100) * v.h
          : 0.05 * v.h;
    size = Math.max(size, 2);
    const base = mode & 7;
    const h = size / 2;
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    if (base === 0) ctx.fillRect(s.x - 1, s.y - 1, 2, 2);
    ctx.beginPath();
    if (base === 2 || (base === 4 && false)) {
      ctx.moveTo(s.x - h, s.y);
      ctx.lineTo(s.x + h, s.y);
      ctx.moveTo(s.x, s.y - h);
      ctx.lineTo(s.x, s.y + h);
    }
    if (base === 3) {
      ctx.moveTo(s.x - h, s.y - h);
      ctx.lineTo(s.x + h, s.y + h);
      ctx.moveTo(s.x - h, s.y + h);
      ctx.lineTo(s.x + h, s.y - h);
    }
    if (base === 4) {
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x, s.y - h);
    }
    ctx.stroke();
    ctx.beginPath();
    if (mode & 32) ctx.arc(s.x, s.y, h, 0, G.TAU);
    if (mode & 64) ctx.rect(s.x - h, s.y - h, size, size);
    ctx.stroke();
  }

  // ---------------------------------------------------------------- 3D

  /** Draws the edges of a 3D solid on the 2D canvas. */
  drawSolidEdges(ctx, e, v) {
    ctx.beginPath();
    for (const ed of E.solidEdges(e))
      ed.pts.forEach((q, i) => {
        const s = v.w2s({ x: q[0], y: q[1], z: q[2] });
        if (i) ctx.lineTo(s.x, s.y);
        else ctx.moveTo(s.x, s.y);
      });
    ctx.stroke();
  }

  /**
   * The scene of the Studio look, when it is on: a scene is chosen, the visual style is a shaded
   * one and there are solids.
   */
  studioScene(app) {
    const st = app.settings.vstyle;
    if (st !== 'shaded' && st !== 'shadedEdges') return null;
    const sc = sceneOf(app.settings.scene);
    if (!sc) return null;
    return app.solids().length ? sc : null;
  }

  /**
   * Draws the solids with WebGL (visual style, Studio scene, grid, edges).
   * @returns {boolean} false when WebGL is not available
   */
  drawSolids3D(app, v, bgCol) {
    const gl = this.gl;
    if (!gl) return false;
    const style =
      app.settings.vstyle === '2dwireframe' ? 'hidden' : app.settings.vstyle || 'hidden';
    const studioStyle = style === 'shaded' || style === 'shadedEdges';
    const scn = studioStyle ? sceneOf(app.settings.scene) : null;
    const solids = [];
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    const list = [
      ...app
        .curEnts()
        .filter((e) => e.type === 'solid3d' && app.doc.visible(e) && !app.hidden.has(e.id)),
      ...app.temp.filter((e) => e.type === 'solid3d'),
    ];
    if (!K.kernelReady()) return false;
    // a big model is meshed a little in every frame (about 40 ms) instead of all at once, so the window stays alive while it fills in
    const big = list.length > 60;
    const t0 = performance.now();
    let waiting = 0;
    for (const e of list) {
      if (big && !K.meshReady(e) && performance.now() - t0 > 40) {
        waiting += 1;
        continue;
      }
      let m;
      try {
        m = K.solidMesh(e);
      } catch {
        continue;
      }
      let c = app.doc.effColor(e);
      c = c === 7 || c === '#ffffff' ? '#c9ccd6' : aciHex(c);
      const pc = paintOf(e);
      const rgb = hexRgb(pc || c); // a colour painted on the part (PAINT, LOOK) wins over the layer colour
      // the Studio look: a solid with a material (or any solid while a scene is on, as glossy plastic) is shaded by the material shader
      let mat = studioStyle ? materialOf(e) || (scn ? MATERIALS[DEFAULT_MATERIAL] : null) : null;
      if (mat && pc) mat = { ...mat, color: rgb }; // the painted colour replaces the fixed colour of a material (tinted glass, painted aluminum ...)
      solids.push({
        key: `${app.doc.uid}|${e.id}|${e.brep ? e.brep.length : 0}`,
        mesh: m,
        color: rgb,
        temp: e._temp,
        studio: mat && !e._temp ? mat : null,
      });
      for (let k = 0; k < 3; k += 1) {
        lo[k] = Math.min(lo[k], m.bounds[0][k]);
        hi[k] = Math.max(hi[k], m.bounds[1][k]);
      }
    }
    const bg = [1, 3, 5].map((i) => parseInt(bgCol.slice(i, i + 2), 16) / 255);
    const center = solids.length ? lo.map((x, i) => (x + hi[i]) / 2) : v.target;
    const radius = solids.length
      ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 + 1
      : 100;
    const sceneOn = !!(scn && solids.length);
    const anyStudio = solids.some((x) => x.studio);
    const grid = app.settings.grid && solids.length && !sceneOn ? this.gridLines3D(v) : null;
    let studio = null;
    if (anyStudio || sceneOn) {
      const S = scn || SCENES.white;
      const kd = S.key.dir;
      const kl = Math.hypot(...kd);
      studio = {
        id: sceneOn ? app.settings.scene : null,
        backdrop: sceneOn ? backdrop(app.settings.scene) : null,
        ground: sceneOn ? S.ground : null,
        reflect: sceneOn && app.settings.floorReflect !== false,
        noEdges: style !== 'shadedEdges' && !app.settings.studioEdges,
        env: {
          sky: S.sky,
          hor: S.hor,
          gnd: S.gnd,
          keyDir: kd.map((x) => x / kl),
          keyCol: S.key.col,
        },
      };
    }
    if (waiting) {
      app.loadingParts = waiting;
      clearTimeout(this._more);
      this._more = setTimeout(() => app.redraw(), 0);
    } else app.loadingParts = 0;
    gl.render({
      solids,
      cam: v,
      style,
      bg: sceneOn ? scn.bg : bg,
      edge: this.dark ? [0.92, 0.92, 0.92] : [0.05, 0.05, 0.05],
      center,
      radius: Math.max(radius, v.dist),
      grid,
      studio,
      bounds: solids.length ? [lo[0], lo[1], lo[2], hi[0], hi[1]] : null,
      radius0: radius,
      eyeZ: v.eye()[2],
    });
    return sceneOn || !!(grid && gl.ok);
  }

  /**
   * The part of the ground plane that gets a grid in the 3D view: spacing, first line and number of
   * lines.
   */
  gridExtent3D(v) {
    let sp = this.app.settings.gridSpacing;
    while (sp * v.zoom < 10) sp *= 5;
    const R = Math.max(10, v.dist * 1.2);
    const x0 = Math.floor((v.target[0] - R) / sp) * sp;
    const y0 = Math.floor((v.target[1] - R) / sp) * sp;
    const n = Math.min(80, Math.ceil((2 * R) / sp));
    return { sp, x0, y0, n };
  }

  /** The 3D grid as WebGL line vertices (cached until the extent changes). */
  gridLines3D(v) {
    const { sp, x0, y0, n } = this.gridExtent3D(v);
    const key = `${sp}|${x0}|${y0}|${n}`;
    if (!this._gl3 || this._gl3.key !== key) {
      const a = [];
      for (let i = 0; i <= n; i += 1)
        a.push(
          x0 + i * sp,
          y0,
          0,
          x0 + i * sp,
          y0 + n * sp,
          0,
          x0,
          y0 + i * sp,
          0,
          x0 + n * sp,
          y0 + i * sp,
          0,
        );
      this._gl3 = { key, lines: new Float32Array(a), n: a.length / 3 };
    }
    return {
      ...this._gl3,
      color: this.dark ? [120 / 255, 140 / 255, 160 / 255, 0.28] : [0, 0, 0, 0.18],
    };
  }

  /** The grid on the ground plane of the 3D view, on the 2D canvas. */
  drawGrid3D(ctx, v) {
    const { sp, x0, y0, n } = this.gridExtent3D(v);
    ctx.save();
    ctx.strokeStyle = this.dark ? 'rgba(120,140,160,0.28)' : 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= n; i += 1) {
      const a = v.w2s({ x: x0 + i * sp, y: y0, z: 0 });
      const b = v.w2s({ x: x0 + i * sp, y: y0 + n * sp, z: 0 });
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      const c = v.w2s({ x: x0, y: y0 + i * sp, z: 0 });
      const d = v.w2s({ x: x0 + n * sp, y: y0 + i * sp, z: 0 });
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** The axis icon in the corner of the 3D view. */
  drawUCS3D(ctx, v) {
    const { r, u, f } = v.basis();
    const ox = 46;
    const oy = v.h - 46;
    const L = 34;
    const proj = (a) => ({
      x: ox + (a[0] * r[0] + a[1] * r[1] + a[2] * r[2]) * L,
      y: oy - (a[0] * u[0] + a[1] * u[1] + a[2] * u[2]) * L,
      d: a[0] * f[0] + a[1] * f[1] + a[2] * f[2],
    });
    ctx.save();
    ctx.lineWidth = 2;
    ctx.font = '11px Arial';
    for (const [ax, col, lab] of [
      [[1, 0, 0], '#ff4040', 'X'],
      [[0, 1, 0], '#3cd83c', 'Y'],
      [[0, 0, 1], '#4aa0ff', 'Z'],
    ]) {
      const q = proj(ax);
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
      ctx.fillText(lab, q.x + (q.x >= ox ? 4 : -12), q.y + 4);
    }
    ctx.restore();
  }

  /**
   * Faces being picked (hover = blue, chosen = orange): the triangles of the face, filled as one
   * path.
   */
  drawFaceHighlights(ctx, v) {
    const app = this.app;
    const list = [
      ...(app.faceHl || []).map((f) => ({ ...f, pick: true })),
      ...(app.faceHover || []),
    ];
    if (!list.length) return;
    ctx.save();
    for (const f of list) {
      let m;
      try {
        m = K.solidMesh(f.e);
      } catch {
        continue;
      }
      ctx.fillStyle = f.pick ? 'rgba(255,154,0,0.52)' : 'rgba(120,180,255,0.40)';
      ctx.beginPath();
      for (let i = f.face.start; i < f.face.start + f.face.count; i += 3) {
        for (let k = 0; k < 3; k += 1) {
          const ix = m.idx[i + k];
          const s = v.w2s({ x: m.pos[ix * 3], y: m.pos[ix * 3 + 1], z: m.pos[ix * 3 + 2] });
          if (k) ctx.lineTo(s.x, s.y);
          else ctx.moveTo(s.x, s.y);
        }
        ctx.closePath();
      }
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * A local UCS on the face under the cursor (or the last explicitly chosen face). It makes the
   * active modelling plane visible before a click: X/Y lie on the face and Z follows its normal.
   */
  drawFaceUCS(ctx, v) {
    const app = this.app;
    const hit = (app.faceHover && app.faceHover[0]) || (app.faceHl && app.faceHl.at(-1));
    if (!hit) return;
    let p = hit.p, n = hit.n;
    if (!p || !n) {
      try {
        const frame = S3.faceFrame(K.solidMesh(hit.e), hit.face);
        if (!frame) return;
        p = frame.p; n = frame.n;
      } catch { return; }
    }
    const pp = Array.isArray(p) ? p : [p.x, p.y, p.z || 0];
    const nn = Array.isArray(n) ? n : [n.x, n.y, n.z];
    const axes = S3.faceAxes(nn);
    if (!axes) return;
    const { x, y, z } = axes;
    const origin = v.w2s({ x: pp[0], y: pp[1], z: pp[2] });
    const screenDir = (axis, fallback) => {
      const q = v.w2s({ x: pp[0] + axis[0], y: pp[1] + axis[1], z: pp[2] + axis[2] });
      const dx = q.x - origin.x, dy = q.y - origin.y, l = Math.hypot(dx, dy);
      return l > 1e-4 ? [dx / l, dy / l] : fallback;
    };
    const sx = screenDir(x, [1, 0]), sy = screenDir(y, [0, -1]), sz = screenDir(z, [-0.7, -0.7]);
    ctx.save();
    // A small translucent patch shows the face's local XY plane even on a similarly coloured body.
    ctx.fillStyle = 'rgba(40,150,255,.16)'; ctx.strokeStyle = 'rgba(120,205,255,.85)';
    ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [i, j, first] of [[-1, -1, 1], [1, -1, 0], [1, 1, 0], [-1, 1, 0]]) {
      const qx = origin.x + (sx[0] * i + sy[0] * j) * 12, qy = origin.y + (sx[1] * i + sy[1] * j) * 12;
      first ? ctx.moveTo(qx, qy) : ctx.lineTo(qx, qy);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
    const axis = (d, color, label, length = 34) => {
      const ex = origin.x + d[0] * length, ey = origin.y + d[1] * length;
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(origin.x, origin.y); ctx.lineTo(ex, ey); ctx.stroke();
      const px = -d[1], py = d[0];
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - d[0] * 7 + px * 3.5, ey - d[1] * 7 + py * 3.5); ctx.lineTo(ex - d[0] * 7 - px * 3.5, ey - d[1] * 7 - py * 3.5); ctx.closePath(); ctx.fill();
      ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, sans-serif'; ctx.fillText(label, ex + d[0] * 5 - 3, ey + d[1] * 5 + 4);
    };
    axis(sx, '#ff5a52', 'X'); axis(sy, '#39d353', 'Y'); axis(sz, '#4ba3ff', 'Z', 38);
    ctx.fillStyle = this.dark ? 'rgba(20,22,28,.88)' : 'rgba(255,255,255,.92)';
    ctx.strokeStyle = 'rgba(100,170,255,.9)'; ctx.lineWidth = 1;
    ctx.fillRect(origin.x + 14, origin.y + 15, 68, 20); ctx.strokeRect(origin.x + 14.5, origin.y + 15.5, 67, 19);
    ctx.fillStyle = this.dark ? '#eaf4ff' : '#174a7a'; ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText('Face UCS', origin.x + 24, origin.y + 29);
    ctx.restore();
  }

  /** Edges being picked (hover and chosen) as thick orange lines. */
  drawEdgeHighlights(ctx, v) {
    const app = this.app;
    const list = [...(app.edgeHl || []), ...(app.edgeHover || [])];
    if (!list.length) return;
    ctx.save();
    for (const h of list) {
      ctx.strokeStyle = h.hover ? '#78baff' : '#ff9a00';
      ctx.lineWidth = h.hover ? 3 : 3.5;
      ctx.beginPath();
      h.pts.forEach((q, i) => {
        const s = v.w2s({ x: q[0], y: q[1], z: q[2] });
        if (i) ctx.lineTo(s.x, s.y);
        else ctx.moveTo(s.x, s.y);
      });
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- overlays

  /** Draws the grips of the selected objects (no grips for a big selection, like GRIPOBJLIMIT). */
  drawGrips(ctx, v) {
    const app = this.app;
    if (app.req || !app.settings.grips) return;
    const doc = app.doc;
    // like AutoCAD's GRIPOBJLIMIT: with a big selection no grips are shown (a square on every vertex of hundreds of objects only hides the drawing)
    if (app.sel.size > (app.settings.gripLimit ?? 100)) return;
    ctx.save();
    let budget = 4000;
    for (const id of app.sel) {
      if (budget <= 0) break;
      const e = app.curEnts().find((x) => x.id === id);
      if (!e || !doc.visible(e)) continue;
      const gv = app.entView(e) || v;
      for (const g of E.grips(e, doc)) {
        if (--budget < 0) break;
        const s = gv.w2s(g.p);
        const hot = app.hotGrip && app.hotGrip.e === e && app.hotGrip.g.id === g.id;
        const warm = app.hoverGrip && app.hoverGrip.e === e && app.hoverGrip.g.id === g.id;
        ctx.fillStyle = hot ? '#ff0000' : warm ? '#43c000' : '#1e6fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.fillRect(Math.round(s.x) - 3, Math.round(s.y) - 3, 7, 7);
        ctx.strokeRect(Math.round(s.x) - 3.5, Math.round(s.y) - 3.5, 7, 7);
      }
    }
    ctx.restore();
  }

  /** Draws the object snap tracking: acquired points and the tracking lines. */
  drawTrack(ctx, v) {
    const app = this.app;
    const iv = app.inputView ? app.inputView() : v;
    ctx.save();
    for (const a of app.acquired) {
      const s = iv.w2s(a.p);
      ctx.strokeStyle = '#ffd400';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(s.x - 4, s.y);
      ctx.lineTo(s.x + 4, s.y);
      ctx.moveTo(s.x, s.y - 4);
      ctx.lineTo(s.x, s.y + 4);
      ctx.stroke();
    }
    if (app.trackLines) {
      ctx.strokeStyle = '#9a9a9a';
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      for (const L of app.trackLines) {
        const s = iv.w2s(L.o);
        const d = { x: Math.cos(L.ang), y: -Math.sin(L.ang) };
        ctx.beginPath();
        ctx.moveTo(s.x - d.x * 4000, s.y - d.y * 4000);
        ctx.lineTo(s.x + d.x * 4000, s.y + d.y * 4000);
        ctx.stroke();
      }
    }
    if (app.polarLine) {
      const a = iv.w2s(app.polarLine.o);
      const b = iv.w2s(app.polarLine.p);
      const d = G.norm({ x: b.x - a.x, y: b.y - a.y });
      ctx.strokeStyle = '#9a9a9a';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x + d.x * 3000, b.y + d.y * 3000);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Draws the selection window (rubber band). */
  drawRubber(ctx) {
    const r = this.app.rubber;
    if (!r) return;
    ctx.save();
    const x = Math.min(r.x0, r.x1);
    const y = Math.min(r.y0, r.y1);
    const w = Math.abs(r.x1 - r.x0);
    const h = Math.abs(r.y1 - r.y0);
    const crossing = r.crossing;
    ctx.fillStyle = crossing ? 'rgba(60,180,60,0.18)' : 'rgba(60,110,255,0.18)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = crossing ? '#4bd04b' : '#6e9bff';
    ctx.lineWidth = 1;
    if (crossing) ctx.setLineDash([5, 4]);
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.restore();
  }

  /** The coordinate system icon in the corner of the 2D view (a sheet icon in a layout). */
  drawUCS(ctx, v, inLayout) {
    ctx.save();
    const ox = 34;
    const oy = v.h - 34;
    const L = 38;
    ctx.translate(0.5, 0.5);
    if (inLayout) {
      ctx.strokeStyle = '#2f6bff';
      ctx.fillStyle = 'rgba(47,107,255,0.25)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ox - 14, oy + 14);
      ctx.lineTo(ox + 24, oy + 14);
      ctx.lineTo(ox - 14, oy - 34);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      return;
    }
    const col = this.dark ? '#ffffff' : '#000000';
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox + L, oy);
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox, oy - L);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ox + L, oy);
    ctx.lineTo(ox + L - 6, oy - 3);
    ctx.lineTo(ox + L - 6, oy + 3);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(ox, oy - L);
    ctx.lineTo(ox - 3, oy - L + 6);
    ctx.lineTo(ox + 3, oy - L + 6);
    ctx.closePath();
    ctx.fill();
    ctx.font = '11px Arial';
    ctx.fillText('X', ox + L + 4, oy + 4);
    ctx.fillText('Y', ox - 4, oy - L - 5);
    ctx.strokeRect(ox - 4, oy - 4, 8, 8);
    ctx.restore();
  }

  /** Draws the object snap marker, its tooltip and the extension / polar tracking lines. */
  drawSnap(ctx, v) {
    const iv = this.app.inputView ? this.app.inputView() : v;
    const ex = this.app.extAcq;
    if (ex && ex.length) {
      ctx.save();
      ctx.strokeStyle = this.dark ? '#ffee00' : '#c9a000';
      ctx.lineWidth = 1;
      for (const r of ex) {
        const q = v.w2s(r.o);
        ctx.beginPath();
        ctx.moveTo(q.x - 3.5, q.y);
        ctx.lineTo(q.x + 3.5, q.y);
        ctx.moveTo(q.x, q.y - 3.5);
        ctx.lineTo(q.x, q.y + 3.5);
        ctx.stroke();
      }
      ctx.restore();
    }
    const m = this.app.snapMarker;
    if (!m) return;
    const s = m.world ? v.w2s(m.world) : iv.w2s(m.p);
    const h = 6;
    ctx.save();
    ctx.strokeStyle = this.dark ? '#ffee00' : '#c9a000';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    switch (m.t) {
      case 'end':
        ctx.rect(s.x - h, s.y - h, 2 * h, 2 * h);
        break;
      case 'mid':
        ctx.moveTo(s.x - h, s.y + h - 1);
        ctx.lineTo(s.x + h, s.y + h - 1);
        ctx.lineTo(s.x, s.y - h);
        ctx.closePath();
        break;
      case 'cen':
        ctx.arc(s.x, s.y, h, 0, G.TAU);
        break;
      case 'nod':
        ctx.arc(s.x, s.y, h - 1, 0, G.TAU);
        ctx.moveTo(s.x - h, s.y - h);
        ctx.lineTo(s.x + h, s.y + h);
        ctx.moveTo(s.x - h, s.y + h);
        ctx.lineTo(s.x + h, s.y - h);
        break;
      case 'qua':
        ctx.moveTo(s.x, s.y - h - 1);
        ctx.lineTo(s.x + h + 1, s.y);
        ctx.lineTo(s.x, s.y + h + 1);
        ctx.lineTo(s.x - h - 1, s.y);
        ctx.closePath();
        break;
      case 'int':
        ctx.moveTo(s.x - h, s.y - h);
        ctx.lineTo(s.x + h, s.y + h);
        ctx.moveTo(s.x - h, s.y + h);
        ctx.lineTo(s.x + h, s.y - h);
        break;
      case 'ins':
        ctx.rect(s.x - h, s.y - h, h + 1, h + 1);
        ctx.rect(s.x - 1, s.y - 1, h + 1, h + 1);
        break;
      case 'per':
        ctx.moveTo(s.x - h, s.y - h);
        ctx.lineTo(s.x - h, s.y + h);
        ctx.lineTo(s.x + h, s.y + h);
        ctx.moveTo(s.x - h, s.y);
        ctx.lineTo(s.x, s.y);
        ctx.lineTo(s.x, s.y + h);
        break;
      case 'tan':
        ctx.arc(s.x, s.y, h - 1, 0, G.TAU);
        ctx.moveTo(s.x - h - 1, s.y - h - 2);
        ctx.lineTo(s.x + h + 1, s.y - h - 2);
        break;
      case 'nea':
        ctx.moveTo(s.x - h, s.y - h);
        ctx.lineTo(s.x + h, s.y - h);
        ctx.lineTo(s.x - h, s.y + h);
        ctx.lineTo(s.x + h, s.y + h);
        ctx.closePath();
        break;
      case 'gcen':
        ctx.arc(s.x, s.y, h, 0, G.TAU);
        ctx.moveTo(s.x - h, s.y);
        ctx.lineTo(s.x + h, s.y);
        ctx.moveTo(s.x, s.y - h);
        ctx.lineTo(s.x, s.y + h);
        break;
      case 'app':
        ctx.rect(s.x - h, s.y - h, 2 * h, 2 * h);
        ctx.moveTo(s.x - h, s.y - h);
        ctx.lineTo(s.x + h, s.y + h);
        ctx.moveTo(s.x - h, s.y + h);
        ctx.lineTo(s.x + h, s.y - h);
        break;
      case 'ext':
        ctx.moveTo(s.x - h, s.y);
        ctx.lineTo(s.x - h + 3, s.y);
        ctx.moveTo(s.x - 1.5, s.y);
        ctx.lineTo(s.x + 1.5, s.y);
        ctx.moveTo(s.x + h - 3, s.y);
        ctx.lineTo(s.x + h, s.y);
        break;
      case 'par':
        ctx.moveTo(s.x - h, s.y + 2);
        ctx.lineTo(s.x + 2, s.y - h);
        ctx.moveTo(s.x - 2, s.y + h);
        ctx.lineTo(s.x + h, s.y - 2);
        break;
      default:
        ctx.rect(s.x - h, s.y - h, 2 * h, 2 * h);
    }
    ctx.stroke();
    if (m.from && (m.t === 'ext' || m.t === 'par')) {
      // dotted guide back to the point the ray comes from
      const f = v.w2s(m.from);
      ctx.setLineDash([2, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(f.x, f.y);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Draws the crosshair cursor and the pick box. */
  drawCrosshair(ctx, v) {
    const app = this.app;
    const c = app.cursor;
    if (!c || !app.mouseIn) return;
    const col = this.dark ? '#ffffff' : '#000000';
    ctx.save();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    const size = app.settings.crosshair;
    const x = Math.round(c.sx) + 0.5;
    const y = Math.round(c.sy) + 0.5;
    const L = size >= 100 ? 5000 : (Math.min(v.w, v.h) * size) / 200;
    if (app.v3 && v.basis) {
      // 3D view: the cursor is the three axes of the world, X red, Y green, Z blue, seen from where the camera is
      const { r, u } = v.basis();
      const arm = Math.min(110, Math.min(v.w, v.h) * 0.22);
      ctx.lineWidth = 1.4;
      [
        [[1, 0, 0], '#ff6b6b'],
        [[0, 1, 0], '#6bdc6b'],
        [[0, 0, 1], '#5b95ff'],
      ].forEach(([a, color]) => {
        let dx = a[0] * r[0] + a[1] * r[1] + a[2] * r[2];
        let dy = -(a[0] * u[0] + a[1] * u[1] + a[2] * u[2]);
        const n = Math.hypot(dx, dy);
        if (n < 0.05) return; // the axis points at the viewer
        dx /= n;
        dy /= n;
        const len = arm * Math.min(1, n * 1.3 + 0.35);
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(x - dx * len, y - dy * len);
        ctx.lineTo(x + dx * len, y + dy * len);
        ctx.stroke();
      });
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
    } else {
      ctx.beginPath();
      ctx.moveTo(x - L, y);
      ctx.lineTo(x + L, y);
      ctx.moveTo(x, y - L);
      ctx.lineTo(x, y + L);
      ctx.stroke();
    }
    const pick = app.pickboxVisible();
    // something can be picked under the cursor (an object, a grip, a solid edge or face): the pick box turns into an open hand that closes into a fist while you click
    const grab = app.grabTarget() || !!app.grabAnim;
    const k = grab ? app.grabClose() : 0; // while the closing/opening runs the hand stays even though the mouse button is down (a pressed button hides the normal hover target)
    if (!grab) app.grabAnim = null;
    else if (app.grabAnim && (app.grabAnim.up != null || k < 1)) app.redraw(); // keep animating until the hand has opened again
    if (pick && grab) this.drawGrabHand(ctx, x, y, k);
    else if (pick) {
      ctx.strokeRect(x - 4.5, y - 4.5, 9, 9);
    } else if (grab && app.req && (app.req.type === 'edge' || app.req.type === 'face'))
      this.drawGrabHand(ctx, x, y, k);
    ctx.restore();
  }

  /**
   * A hand centred on (x, y), closed by k (0 = open hand with the fingers up, 1 = fist). The shapes
   * are stroked black first, then filled, so the outline surrounds the fill.
   */
  drawGrabHand(ctx, x, y, k = 1) {
    const lerp = (a, b) => a + (b - a) * k;
    ctx.save();
    ctx.translate(x - 12.5, y - 12.5);
    ctx.scale(1.05, 1.05);
    ctx.setLineDash([]);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const FX = [
      [7.4, 7.6],
      [11.0, 11.2],
      [14.6, 14.8],
      [18.2, 18.2],
    ];
    const FY = [
      [10.6, 10.2],
      [10.6, 8.9],
      [10.6, 8.9],
      [10.6, 10.4],
    ];
    const FL = [6.2, 8.4, 7.6, 5.6];
    const FR = [1.55, 2.5]; // fingers: x and base y (open, closed), length when open, radius
    const fingers = FX.map((fx, i) => ({
      x: lerp(fx[0], fx[1]),
      y: lerp(FY[i][0], FY[i][1]),
      len: Math.max(0.01, FL[i] * (1 - k)),
    }));
    const fr = lerp(FR[0], FR[1]);
    const palm = (c) => c.roundRect(5, 10.5, 14, 10.5, 4);
    const thumb = (c) =>
      c.ellipse(
        lerp(3.9, 5.2),
        lerp(14.4, 15.4),
        lerp(1.9, 2.3),
        lerp(4.0, 3.6),
        lerp(-0.75, -0.35),
        0,
        Math.PI * 2,
      ); // out to the side when open, folded over the fingers when closed
    const finger = (c, f) => {
      c.moveTo(f.x, f.y);
      c.lineTo(f.x, f.y - f.len);
    };
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 3;
    ctx.beginPath();
    palm(ctx);
    ctx.stroke();
    ctx.beginPath();
    thumb(ctx);
    ctx.stroke();
    ctx.lineWidth = 2 * fr + 3;
    for (const f of fingers) {
      ctx.beginPath();
      finger(ctx, f);
      ctx.stroke();
    }
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    palm(ctx);
    ctx.fill();
    ctx.beginPath();
    thumb(ctx);
    ctx.fill();
    ctx.lineWidth = 2 * fr;
    for (const f of fingers) {
      ctx.beginPath();
      finger(ctx, f);
      ctx.stroke();
    }
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const fx of [9.4, 13, 16.5]) {
      ctx.moveTo(fx, 10.4);
      ctx.lineTo(fx, 10.4 + 3 * k);
    } // the fingers folded against the palm
    ctx.stroke();
    ctx.beginPath();
    thumb(ctx);
    ctx.stroke();
    ctx.restore();
  }
}
