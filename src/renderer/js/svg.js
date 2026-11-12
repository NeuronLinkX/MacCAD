/**
 * @file svg.js
 * @brief SVG export used for plotting (PDF / PNG / SVG).
 *
 * Coordinates are written in paper millimetres. A "map" `{s, ox, oy, mx, my, H}` converts drawing
 * coordinates to paper: X = (x - ox) * s + mx ; Y = H - ((y - oy) * s + my).
 *
 * Contents: SvgExporter (entity -> SVG markup, whole document -> SVG file) and the plot colour
 * helpers.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import * as G from './geom.js';
import * as E from './entities.js';
import { aciHex } from './doc.js';
import { fontStack } from './fonts.js';

/* ============================================================================================
 * 2. CONSTANTS
 * ========================================================================================== */

/** font-size = cap height * FONT_K. */
export const FONT_K = 1 / 0.72;

/**
 * Pure yellow and cyan (ACI 2 / 4) are nearly invisible on white paper: they are plotted in a
 * darker shade of the same colour family.
 */
const PAPER_COLOR = { '#ffff00': '#c9a000', '#00ffff': '#00a5b5' };

/* ============================================================================================
 * 3. CLASS
 * ========================================================================================== */

/** Static functions that turn entities and documents into SVG text. */
export class SvgExporter {
  // ---------------------------------------------------------------- small helpers

  /** @private @returns {string} a number with at most 4 decimals, no trailing zeros. */
  static f(n) {
    return (+n.toFixed(4)).toString();
  }

  /** @private @returns {string} text escaped for use in XML. */
  static esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** @private @returns {number[]} the paper position [X, Y] of a drawing point. */
  static mapPt(m, p) {
    return [(p.x - m.ox) * m.s + m.mx, m.H - ((p.y - m.oy) * m.s + m.my)];
  }

  // ---------------------------------------------------------------- colours

  /**
   * The colour an object is plotted in.
   * @param {number|string} c ACI index or "#rrggbb"
   * @param {boolean} mono true = everything black
   * @returns {string} "#rrggbb"
   */
  static plotColorOf(c, mono) {
    if (mono) return '#000000';
    if (c === 7 || c === '#ffffff') return '#000000';
    const hex = aciHex(c);
    return PAPER_COLOR[String(hex).toLowerCase()] || hex;
  }

  /** @returns {string} the plot colour of an entity (its effective colour, see doc.effColor). */
  static plotColor(doc, e, mono) {
    return SvgExporter.plotColorOf(doc.effColor(e), mono);
  }

  /** @private @returns {string} the stroke-dasharray for the entity's linetype ('' for continuous). */
  static dashFor(doc, e, m) {
    const f = SvgExporter.f;
    const name = doc.effLtype(e);
    const pat = doc.ltypes[name];
    if (!pat || !pat.length) return '';
    const sc = (doc.ltscale || 1) * (e.ltscale || 1) * m.s;
    const arr = pat.map((v) => Math.max(Math.abs(v) * sc, v === 0 ? 0.05 : 0.02));
    return arr.length % 2 ? arr.concat(arr).map(f).join(' ') : arr.map(f).join(' ');
  }

  // ---------------------------------------------------------------- geometry to path data

  /**
   * SVG path data for one primitive.
   * @private
   * @param {object} P the primitive (segment or arc, see geom.js)
   * @param {object} m map
   * @param {boolean} first true = start a new sub-path with "M", false = continue the previous one
   * @returns {string}
   */
  static primPath(P, m, first) {
    const f = SvgExporter.f;
    const mapPt = SvgExporter.mapPt;
    if (P.k === 's') {
      const a = mapPt(m, P.a);
      const b = mapPt(m, P.b);
      return `${first ? `M${f(a[0])} ${f(a[1])}` : ''}L${f(b[0])} ${f(b[1])}`;
    }
    const sw = G.sweep(P.a0, P.a1) || G.TAU;
    const r = P.r * m.s;
    if (Math.abs(P.a1 - P.a0) >= G.TAU - 1e-9) {
      // a full circle is two half arcs
      const a = mapPt(m, G.arcPt(P, 0));
      const b = mapPt(m, G.arcPt(P, Math.PI));
      return `M${f(a[0])} ${f(a[1])}A${f(r)} ${f(r)} 0 1 0 ${f(b[0])} ${f(b[1])}A${f(r)} ${f(r)} 0 1 0 ${f(a[0])} ${f(a[1])}`;
    }
    const from = P.rev ? G.arcPt(P, P.a1) : G.arcPt(P, P.a0);
    const to = P.rev ? G.arcPt(P, P.a0) : G.arcPt(P, P.a1);
    const a = mapPt(m, from);
    const b = mapPt(m, to);
    return `${first ? `M${f(a[0])} ${f(a[1])}` : ''}A${f(r)} ${f(r)} 0 ${sw > Math.PI ? 1 : 0} ${P.rev ? 1 : 0} ${f(b[0])} ${f(b[1])}`;
  }

  /**
   * SVG for a TEXT / MTEXT entity (one <text> element per line).
   * @private
   */
  static textSvg(doc, t, m, color) {
    const f = SvgExporter.f;
    const p = SvgExporter.mapPt(m, t.p);
    const L = E.textLayout(t, doc);
    const fs = t.h * m.s * FONT_K;
    const rot = -(t.rot || 0) * (180 / Math.PI);
    const st = L.st || {};
    let out = '';
    for (const it of L.items) {
      const anchor =
        t.type === 'mtext' ? 'start' : t.al === 1 ? 'middle' : t.al === 2 ? 'end' : 'start';
      const x = t.type === 'mtext' ? it.x * m.s : 0;
      const y = -it.y * m.s;
      const skew = st.obl ? ` skewX(${f(-st.obl)})` : '';
      const wfs = st.wf && st.wf !== 1 ? ` scale(${f(st.wf)} 1)` : '';
      const deco =
        t.u || t.o
          ? ` text-decoration="${[t.u ? 'underline' : '', t.o ? 'overline' : ''].filter(Boolean).join(' ')}"`
          : '';
      out += `<text transform="translate(${f(p[0])} ${f(p[1])}) rotate(${f(rot)})${skew}${wfs}" x="${f(x)}" y="${f(y)}" font-size="${f(fs)}" font-family="${SvgExporter.esc(fontStack(st.font).replace(/"/g, "'"))}" text-anchor="${anchor}" fill="${color}"${deco}>${SvgExporter.esc(it.s)}</text>`;
    }
    return out;
  }

  // ---------------------------------------------------------------- one entity

  /**
   * SVG markup for one entity.
   * @param {object} doc the document
   * @param {object} e the entity
   * @param {object} m map (see the file header)
   * @param {{mono?: boolean, lw?: boolean, lwScale?: number}} opts plot options
   * @returns {string} '' for hidden entities, non-plot layers and unsupported types
   */
  static entity(doc, e, m, opts) {
    const f = SvgExporter.f;
    const mapPt = SvgExporter.mapPt;
    if (!doc.visible(e) || doc.layer(e.layer).plot === false) return '';
    const color = SvgExporter.plotColor(doc, e, opts.mono);
    const lw =
      opts.lw === false ? 0.18 : Math.max(0.05, doc.effLw(e) || 0.25) * (opts.lwScale ?? 1);
    const dash = SvgExporter.dashFor(doc, e, m);
    const stroke = `stroke="${color}" stroke-width="${f(lw)}" fill="none" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}`;
    switch (e.type) {
      case 'line':
      case 'circle':
      case 'arc':
      case 'ellipse':
      case 'pline':
      case 'spline':
      case 'xline':
      case 'ray':
      case 'leader': {
        if (e.type === 'xline' || e.type === 'ray') return ''; // infinite lines are not plotted
        let d = '';
        let last = null;
        for (const P of E.prims(e, doc)) {
          const start = G.primStart(P);
          const cont = last && G.dist(last, start) < 1e-9; // continue the path when the pieces touch
          d += SvgExporter.primPath(P, m, !cont);
          last = G.primEnd(P);
        }
        let out = `<path d="${d}" ${stroke}/>`;
        if (e.type === 'leader' && e.str && e.tp)
          out += SvgExporter.textSvg(
            doc,
            { type: 'text', p: e.tp, h: e.h, str: e.str, rot: 0, al: 0 },
            m,
            color,
          );
        return out;
      }
      case 'donut': {
        const c = mapPt(m, e.c);
        const ro = e.rout * m.s;
        const ri = e.rin * m.s;
        return `<path fill-rule="evenodd" fill="${color}" d="M${f(c[0] - ro)} ${f(c[1])}a${f(ro)} ${f(ro)} 0 1 0 ${f(2 * ro)} 0a${f(ro)} ${f(ro)} 0 1 0 ${f(-2 * ro)} 0M${f(c[0] - ri)} ${f(c[1])}a${f(ri)} ${f(ri)} 0 1 0 ${f(2 * ri)} 0a${f(ri)} ${f(ri)} 0 1 0 ${f(-2 * ri)} 0Z"/>`;
      }
      case 'point': {
        const p = mapPt(m, e.p);
        return `<circle cx="${f(p[0])}" cy="${f(p[1])}" r="0.3" fill="${color}"/>`;
      }
      case 'text':
      case 'mtext':
        return SvgExporter.textSvg(doc, e, m, color);
      case 'hatch':
        return SvgExporter.hatchSvg(e, m, color, lw);
      case 'dim':
        return SvgExporter.dimSvg(doc, e, m, color, lw, opts);
      case 'insert':
        return E.leaves(e, doc)
          .map((k) => SvgExporter.entity(doc, k, m, opts))
          .join('');
      default:
        return '';
    }
  }

  /** @private SVG for a hatch: solid / wipe fills, otherwise the pattern lines. */
  static hatchSvg(e, m, color, lw) {
    const f = SvgExporter.f;
    const mapPt = SvgExporter.mapPt;
    if (e.pattern === 'SOLID' || e.pattern === 'WIPE') {
      const d = e.loops
        .map((l) => 'M' + l.map((p) => mapPt(m, p).map(f).join(' ')).join('L') + 'Z')
        .join('');
      return `<path d="${d}" fill="${e.pattern === 'WIPE' ? '#ffffff' : color}" fill-rule="evenodd" stroke="none"/>`;
    }
    const d = E.hatchLines(e)
      .map(([a, b]) => `M${mapPt(m, a).map(f).join(' ')}L${mapPt(m, b).map(f).join(' ')}`)
      .join('');
    return `<path d="${d}" stroke="${color}" stroke-width="${f(Math.min(lw, 0.18))}" fill="none"/>`;
  }

  /** @private SVG for a dimension: lines, arcs, arrow heads and texts. */
  static dimSvg(doc, e, m, color, lw, opts) {
    const f = SvgExporter.f;
    const mapPt = SvgExporter.mapPt;
    const g = E.dimGeom(e, doc);
    let out = '';
    const d =
      g.lines
        .map(([a, b]) => `M${mapPt(m, a).map(f).join(' ')}L${mapPt(m, b).map(f).join(' ')}`)
        .join('') +
      g.arcs.map((a) => SvgExporter.primPath(G.A(a.c, a.r, a.a0, a.a1), m, true)).join('');
    out += `<path d="${d}" stroke="${color}" stroke-width="${f(lw)}" fill="none"/>`;
    for (const ar of g.arrows) {
      const sh = E.arrowShapes(ar, g.ds.asz);
      const P = (p) => mapPt(m, p).map(f).join(' ');
      for (const poly of sh.fill || [])
        out += `<path d="M${poly.map(P).join('L')}Z" fill="${color}"/>`;
      for (const pl of sh.stroke || [])
        out += `<path d="M${pl.map(P).join('L')}" stroke="${color}" stroke-width="${f(lw)}" fill="none"/>`;
      for (const dot of sh.dots || []) {
        const c0 = mapPt(m, dot.c);
        const c1 = mapPt(m, { x: dot.c.x + dot.r, y: dot.c.y });
        out += `<circle cx="${f(c0[0])}" cy="${f(c0[1])}" r="${f(Math.hypot(c1[0] - c0[0], c1[1] - c0[1]))}" fill="${color}"/>`;
      }
    }
    const tcolor = g.ds.tcolor != null ? SvgExporter.plotColorOf(g.ds.tcolor, opts.mono) : color; // dimension text colour (DIMCLRT)
    for (const t of [g.text, ...g.extra])
      if (t)
        out += SvgExporter.textSvg(
          doc,
          { type: 'text', p: t.p, h: t.h, str: t.str, rot: t.rot, al: t.al, style: 'Standard' },
          m,
          tcolor,
        );
    return out;
  }

  // ---------------------------------------------------------------- whole document

  /**
   * Renders a whole space to an SVG file text.
   * @param {object} doc the document
   * @param {string} space 'model' or a layout name
   * @param {object} [o] options: `mono`, `lw` (false = hairlines), `window` (model-space box to
   *        plot), `paperW` / `paperH` (mm), `margin` (mm), `scale`, `background` (CSS colour)
   * @returns {string} the SVG document
   */
  static toSVG(doc, space, o = {}) {
    const f = SvgExporter.f;
    const mapPt = SvgExporter.mapPt;
    const opts = { mono: !!o.mono, lw: o.lw !== false, lwScale: 1 };
    let inner = '';
    let W;
    let H;
    if (space === 'model') {
      const b = o.window || SvgExporter.modelExtents(doc) || { x0: 0, y0: 0, x1: 100, y1: 100 };
      W = o.paperW ?? 297;
      H = o.paperH ?? 210;
      const margin = o.margin ?? 5;
      const sx = (W - 2 * margin) / Math.max(1e-9, b.x1 - b.x0);
      const sy = (H - 2 * margin) / Math.max(1e-9, b.y1 - b.y0);
      const s = o.scale || Math.min(sx, sy);
      const cx = (b.x0 + b.x1) / 2;
      const cy = (b.y0 + b.y1) / 2;
      const m = { s, ox: cx, oy: cy, mx: W / 2, my: H / 2, H };
      inner = doc.model.map((e) => SvgExporter.entity(doc, e, m, opts)).join('');
    } else {
      const lay = doc.layouts[space];
      W = lay.paper.w;
      H = lay.paper.h;
      const m0 = { s: 1, ox: 0, oy: 0, mx: 0, my: 0, H };
      let clips = '';
      lay.ents.forEach((e, i) => {
        if (e.type === 'viewport') {
          // a viewport shows model space through a clipped window at its own scale
          const a = mapPt(m0, e.p1);
          const b = mapPt(m0, e.p2);
          const x = Math.min(a[0], b[0]);
          const y = Math.min(a[1], b[1]);
          const w = Math.abs(a[0] - b[0]);
          const h = Math.abs(a[1] - b[1]);
          clips += `<clipPath id="vp${i}"><rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}"/></clipPath>`;
          const mid = { x: (e.p1.x + e.p2.x) / 2, y: (e.p1.y + e.p2.y) / 2 };
          const m = { s: e.scale, ox: e.cx, oy: e.cy, mx: mid.x, my: mid.y, H };
          inner += `<g clip-path="url(#vp${i})">${doc.model.map((k) => SvgExporter.entity(doc, k, m, opts)).join('')}</g>`;
        } else inner += SvgExporter.entity(doc, e, m0, opts);
      });
      inner = `<defs>${clips}</defs>` + inner;
    }
    const bg = o.background
      ? `<rect width="${f(W)}" height="${f(H)}" fill="${o.background}"/>`
      : '';
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}">${bg}${inner}</svg>`;
  }

  /**
   * The bounding box of everything visible in a space (viewports excluded).
   * @param {object} doc
   * @param {string} [space='model']
   * @returns {{x0: number, y0: number, x1: number, y1: number}|null} null for an empty space
   */
  static modelExtents(doc, space = 'model') {
    let b = null;
    for (const e of doc.spaceList(space))
      if (doc.visible(e) && e.type !== 'viewport') b = E.bboxMerge(b, E.bbox(e, doc));
    return b;
  }
}

/* ============================================================================================
 * 4. COMPATIBILITY EXPORTS
 * ========================================================================================== */
export const plotColorOf = SvgExporter.plotColorOf;
export const plotColor = SvgExporter.plotColor;
export const entSvg = SvgExporter.entity;
export const toSVG = SvgExporter.toSVG;
export const modelExtents = SvgExporter.modelExtents;
