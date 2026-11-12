/**
 * @file dwg.js
 * @brief DWG database -> MacCAD document.
 *
 * The main process reads a DWG with LibreDWG (src/main/dwgreader.js) and sends a plain object
 * `{header, layers, ltypes, styles, dimstyles, blocks, entities, layouts}`. `DwgImporter` turns
 * that object into a `Doc`. One damaged object never stops the drawing from opening: it is skipped
 * and counted in the warnings.
 *
 * Entry point: `dwgToDoc(db, name)`.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import * as G from './geom.js';
import * as E from './entities.js';
import { Doc, LINETYPES, newLayout } from './doc.js';
import { decodeText, parseMText } from './textcodes.js';

/* ============================================================================================
 * 2. CONSTANTS AND SMALL HELPERS
 * ========================================================================================== */

/** DWG lineweight index -> millimetres. */
const LW_TABLE = [
  0, 0.05, 0.09, 0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.53, 0.6, 0.7, 0.8, 0.9, 1.0,
  1.06, 1.2, 1.4, 1.58, 2.0, 2.11,
];

/** DWG $LUNITS value -> MacCAD length format. */
const LUNITS_TYPE = {
  1: 'scientific',
  2: 'decimal',
  3: 'engineering',
  4: 'architectural',
  5: 'fractional',
};

/**
 * DWG lineweight value -> MacCAD lineweight.
 * @param {number|null|undefined} i 29 or null = by layer, 30 = by block, 31 or negative = default
 * @returns {number|string|null} millimetres, 'bb' (by block) or null (by layer)
 */
const lwOf = (i) =>
  i === 29 || i == null ? null : i === 30 ? 'bb' : i === 31 || i < 0 ? 0.25 : (LW_TABLE[i] ?? 0.25);

/** @returns {{x: number, y: number}} the 2D part of a DWG point. */
const P = (p) => ({ x: p.x, y: p.y });

/** @returns {string} the font of a text style (Arial when the file names none). */
const fontFor = (name) => name || 'Arial';

/** @returns {object[]} the closed polygon of polyline-style hatch boundary vertices with bulges. */
const bulgeLoop = (verts) =>
  E.closedLoop(
    E.mk('pline', { pts: verts.map((v) => ({ x: v.x, y: v.y, b: v.bulge || 0 })), closed: true }),
  );

/** A layer record with the default look. */
const plainLayer = (name) => ({
  name,
  color: 7,
  ltype: 'Continuous',
  lw: 0.25,
  on: true,
  frozen: false,
  locked: false,
  plot: true,
});

/* ============================================================================================
 * 3. IMPORTER
 * ========================================================================================== */

/** Converts one DWG database into a document. Create one per import and call `convert()`. */
export class DwgImporter {
  /**
   * @param {object} db the object returned by the main-process reader
   * @param {string} name the document name
   */
  constructor(db, name) {
    this.db = db;
    this.doc = new Doc();
    this.doc.name = name;
    this.doc.layers = [];
    this.doc.dirty = false;
    /** @type {Map<string, number>} warning text -> how many objects it concerns */
    this.warn = new Map();
  }

  /** @private Counts one warning of the given kind. */
  count(kind) {
    this.warn.set(kind, (this.warn.get(kind) || 0) + 1);
  }

  /**
   * Runs the whole conversion.
   * @returns {{doc: Doc, warnings: string[]}} the document and one text per skipped object kind
   */
  convert() {
    const { db, doc } = this;
    const h = db.header || {};
    this.loadHeader(h);
    this.loadLinetypes();
    this.loadTextStyles();
    this.loadDimStyles();
    this.loadLayers(h);
    this.loadBlocks();
    for (const e of db.entities || []) {
      const o = this.mapEntity(e);
      if (o) doc.add(o, 'model');
    }
    const ext = this.modelExtents();
    this.loadLayouts(ext);
    if (ext) doc.modelView = { cx: (ext.x0 + ext.x1) / 2, cy: (ext.y0 + ext.y1) / 2, zoom: 1 };
    doc.blockVer += 1;
    doc.dirty = false;
    return {
      doc,
      warnings: [...this.warn].map(
        ([t, n]) => `${n} ${t} object(s) are not supported and were skipped`,
      ),
    };
  }

  // ---------------------------------------------------------------- tables

  /** @private Header variables: linetype scale, point style, length units. */
  loadHeader(h) {
    const { doc } = this;
    if (h.LTSCALE) doc.ltscale = h.LTSCALE;
    if (h.PDMODE != null) doc.pdmode = h.PDMODE;
    if (h.PDSIZE != null) doc.pdsize = h.PDSIZE;
    if (h.LUNITS) doc.units.type = LUNITS_TYPE[h.LUNITS] || 'decimal';
    if (h.LUPREC != null) doc.units.prec = h.LUPREC;
  }

  /** @private Linetypes (the built-in ByLayer / ByBlock / Continuous are not copied). */
  loadLinetypes() {
    const { doc, db } = this;
    for (const lt of db.ltypes || []) {
      if (!lt.name || /^by(layer|block)$/i.test(lt.name) || /^continuous$/i.test(lt.name)) continue;
      const pat = (lt.pattern || []).map((p) => p.elementLength);
      if (pat.length) doc.ltypes[lt.name] = pat;
    }
  }

  /** @private Text styles, with a Standard style guaranteed. */
  loadTextStyles() {
    const { doc, db } = this;
    doc.textStyles = {};
    for (const st of db.styles || []) {
      if (!st.name) continue;
      doc.textStyles[st.name] = {
        font: fontFor(st.font),
        big: st.bigFont || '',
        wf: st.widthFactor || 1,
        obl: G.deg(st.obliqueAngle || 0),
        h: st.fixedTextHeight || 0,
      };
      if (Math.abs(st.obliqueAngle || 0) > 6.4) doc.textStyles[st.name].obl = st.obliqueAngle; // already degrees
    }
    if (!doc.textStyles.Standard)
      doc.textStyles.Standard = { font: 'Helvetica Neue', wf: 1, obl: 0, h: 0 };
  }

  /** @private Dimension styles, with a Standard style guaranteed and ISO-25 preferred as the current one. */
  loadDimStyles() {
    const { doc, db } = this;
    doc.dimStyles = {};
    for (const d of db.dimstyles || []) {
      if (!d.name) continue;
      doc.dimStyles[d.name] = {
        h: d.DIMTXT || 2.5,
        asz: d.DIMASZ || 2.5,
        eo: d.DIMEXO || 0.625,
        ee: d.DIMEXE || 1.25,
        gap: d.DIMGAP || 0.625,
        scale: d.DIMSCALE || 1,
        prec: d.DIMDEC ?? 2,
        prefix: '',
        suffix: '',
        arrow: 'closed',
        useUnits: true,
        ...(d.DIMCLRT > 0 && d.DIMCLRT < 256 ? { tcolor: d.DIMCLRT } : {}),
      };
    }
    if (!doc.dimStyles.Standard) doc.dimStyles.Standard = { ...E.DEFAULT_DIMSTYLE };
    doc.curDimStyle = doc.dimStyles['ISO-25'] ? 'ISO-25' : 'Standard';
  }

  /**
   * @private Layers. The lock flag is NOT taken over: the reader (LibreDWG) reports EVERY layer of
   * a DWG as locked (its standardFlag is 16 for all of them, in files from AutoCAD 2018 and in
   * ones we write ourselves), which made all objects impossible to pick and edit. Lock the layer
   * again in MacCAD if it is needed.
   */
  loadLayers(h) {
    const { doc, db } = this;
    for (const l of db.layers || []) {
      doc.layers.push({
        name: l.name,
        color: Math.abs(l.colorIndex) || 7,
        ltype: !l.lineType || /^by/i.test(l.lineType) ? 'Continuous' : l.lineType,
        lw: lwOf(l.lineweight) ?? 0.25,
        on: !l.off && l.colorIndex >= 0,
        frozen: !!l.frozen,
        locked: false,
        plot: l.plotFlag !== 0,
      });
    }
    if (!doc.layers.some((l) => l.name === '0')) doc.layers.unshift(plainLayer('0'));
    doc.cur.layer = doc.layers.some((l) => l.name === h.CLAYER) ? h.CLAYER : '0';
  }

  /** @private Adds a layer the file used without declaring it. */
  ensureLayer(n) {
    if (!this.doc.layers.some((l) => l.name === n)) this.doc.layers.push(plainLayer(n));
  }

  // ---------------------------------------------------------------- common entity properties

  /** @private Copies layer, colour, linetype, lineweight and linetype scale onto the new object. */
  applyCommon(e, out) {
    out.layer = e.layer || '0';
    this.ensureLayer(out.layer);
    const ci = e.colorIndex;
    out.color = ci === 256 || ci == null ? null : ci === 0 ? 'bb' : Math.abs(ci);
    const lt = e.lineType;
    out.ltype = !lt || /^bylayer$/i.test(lt) ? null : /^byblock$/i.test(lt) ? 'bb' : lt;
    out.lw = lwOf(e.lineweight);
    out.ltscale = e.lineTypeScale || 1;
    return out;
  }

  // ---------------------------------------------------------------- entity mapping

  /**
   * Maps one DWG entity. One damaged object must not stop the whole drawing from opening, so an
   * error only counts a warning.
   * @param {object} e DWG entity
   * @returns {object|null} the MacCAD entity, or null when it is skipped
   */
  mapEntity(e) {
    try {
      return this.mapEntityUnsafe(e);
    } catch (err) {
      this.count(`damaged ${e && e.type}`);
      return null;
    }
  }

  /** @private Converts by entity type. @returns {object|null} */
  mapEntityUnsafe(e) {
    if (e.isVisible === false) return null;
    let o = null;
    switch (e.type) {
      case 'LINE':
        o = E.mk('line', { p1: P(e.startPoint), p2: P(e.endPoint) });
        break;
      case 'CIRCLE':
        o = E.mk('circle', { c: P(e.center), r: e.radius });
        break;
      case 'ARC': {
        let a1 = e.endAngle;
        if (a1 === e.startAngle) a1 += G.TAU;
        o = E.mk('arc', { c: P(e.center), r: e.radius, a0: e.startAngle, a1 });
        break;
      }
      case 'ELLIPSE':
        o = this.ellipse(e);
        break;
      case 'LWPOLYLINE':
        o = E.mk('pline', {
          pts: (e.vertices || []).map((v) => ({ x: v.x, y: v.y, b: v.bulge || 0 })),
          closed: !!(e.flag & 1),
        });
        if (o.pts.length < 2) o = null;
        break;
      case 'POLYLINE2D': {
        const vs = (e.vertices || []).filter((v) => !(v.flag & 16)); // spline-frame vertices are dropped
        o = E.mk('pline', {
          pts: vs.map((v) => ({ x: v.x, y: v.y, b: v.bulge || 0 })),
          closed: !!(e.flag & 1),
        });
        if (o.pts.length < 2) o = null;
        break;
      }
      case 'POINT':
        o = E.mk('point', { p: P(e.position) });
        break;
      case 'TEXT':
      case 'ATTRIB':
        o = this.text(e);
        break;
      case 'MTEXT':
        o = this.mtext(e);
        break;
      case 'SOLID':
      case 'TRACE':
        o = this.solid(e);
        break;
      case 'HATCH':
        o = this.hatch(e);
        break;
      case 'INSERT':
        o = E.mk('insert', {
          name: e.name,
          p: P(e.insertionPoint),
          rot: e.rotation || 0,
          sx: e.xScale ?? 1,
          sy: e.yScale ?? e.xScale ?? 1,
        });
        break;
      case 'DIMENSION':
        // a dimension is stored as an anonymous block: it comes in as a block reference at the origin
        if (e.name) o = E.mk('insert', { name: e.name, p: { x: 0, y: 0 }, rot: 0, sx: 1, sy: 1 });
        break;
      case 'SPLINE':
        o = this.spline(e);
        break;
      case 'LEADER': {
        const vs = (e.vertices || []).map(P);
        if (vs.length >= 2) o = E.mk('leader', { pts: vs, str: '', h: 2.5, tp: null });
        break;
      }
      case 'XLINE':
      case 'RAY':
        o = E.mk(e.type === 'XLINE' ? 'xline' : 'ray', {
          p: P(e.firstPoint || e.basePoint),
          dir: G.norm(P(e.unitDirection || e.direction)),
        });
        break;
      case 'ATTDEF':
      case 'VIEWPORT':
        break; // not drawn objects
      default:
        this.count(e.type);
    }
    return o ? this.applyCommon(e, o) : null;
  }

  /** @private ELLIPSE (also elliptical arcs). */
  ellipse(e) {
    const a0 = e.startAngle ?? 0;
    let a1 = e.endAngle ?? G.TAU;
    if (a1 <= a0) a1 += G.TAU;
    const u = P(e.majorAxisEndPoint);
    return E.mk('ellipse', { c: P(e.center), u, v: G.mul(G.perp(u), e.axisRatio ?? 1), a0, a1 });
  }

  /** @private TEXT and ATTRIB: alignment, escape codes, width factor and oblique angle. */
  text(e) {
    const { doc } = this;
    const hal = e.halign || 0;
    const val = e.valign || 0;
    const aligned = hal !== 0 || val !== 0;
    const pos = aligned && e.endPoint ? e.endPoint : e.startPoint;
    const rot = e.rotation || 0;
    const hgt = e.textHeight || 2.5;
    const up = { x: -Math.sin(rot), y: Math.cos(rot) };
    let p = P(pos);
    if (val === 2) p = G.add(p, G.mul(up, -hgt * 0.5));
    else if (val === 3) p = G.add(p, G.mul(up, -hgt));
    const al = hal === 1 || hal === 4 ? 1 : hal === 2 ? 2 : 0;
    const dt = decodeText(e.text);
    let o = E.mk('text', { p, h: hgt, str: dt.text, rot, style: e.styleName || 'Standard', al });
    if (dt.u) o.u = true;
    if (dt.o) o.o = true;
    if (e.xScale && e.xScale !== 1) o.wf = e.xScale;
    if (e.obliqueAngle) o.obl = G.deg(e.obliqueAngle);
    if (!doc.textStyles[o.style]) o.style = 'Standard';
    if (!o.str) o = null;
    return o;
  }

  /** @private MTEXT: rotation from the direction vector, format codes removed. */
  mtext(e) {
    const { doc } = this;
    const dir = e.direction;
    const rot = dir && (dir.x || dir.y) ? Math.atan2(dir.y, dir.x) : e.rotation || 0;
    const pm = parseMText(e.text || '');
    let o = E.mk('mtext', {
      p: P(e.insertionPoint),
      h: e.textHeight || 2.5,
      str: pm.text,
      rot,
      w: e.rectWidth || 0,
      style: e.styleName || 'Standard',
      al: 0,
      att: e.attachmentPoint || 1,
    });
    if (pm.u) o.u = true;
    if (pm.o) o.o = true;
    if (!doc.textStyles[o.style]) o.style = 'Standard';
    if (!o.str.trim()) o = null;
    return o;
  }

  /** @private SOLID / TRACE: a filled polygon of 3 or 4 corners (stored in crossed order). */
  solid(e) {
    const c = [e.corner1, e.corner2, e.corner4, e.corner3].filter(Boolean).map(P);
    const loop = c.filter((q, i) => i === 0 || G.dist(q, c[i - 1]) > 1e-12);
    return loop.length >= 3
      ? E.mk('hatch', { loops: [loop], pattern: 'SOLID', scale: 1, angle: 0 })
      : null;
  }

  /** @private HATCH: boundary loops, solid or pattern fill. */
  hatch(e) {
    const loops = [];
    for (const bp of e.boundaryPaths || []) {
      let loop = null;
      if (bp.vertices && bp.vertices.length) loop = bulgeLoop(bp.vertices);
      else if (bp.edges && bp.edges.length) loop = DwgImporter.edgesToLoop(bp.edges);
      if (loop && loop.length >= 3) loops.push(loop.map(P));
    }
    if (!loops.length) return null;
    const solid = e.solidFill === 1 || /^solid$/i.test(e.patternName || '');
    const pn = String(e.patternName || 'ANSI31').toUpperCase();
    return E.mk('hatch', {
      loops,
      pattern: solid ? 'SOLID' : E.HATCH_PATTERNS[pn] !== undefined ? pn : 'ANSI31',
      scale: e.patternScale || 1,
      angle: e.patternAngle || 0,
    });
  }

  /** @private SPLINE: a NURBS curve when the knot vector fits, else the fit / control points. */
  spline(e) {
    const fit = e.fitPoints && e.fitPoints.length ? e.fitPoints.map(P) : null;
    const ctrl = (e.controlPoints || []).map(P);
    const useNurbs =
      ctrl.length > (e.degree || 3) &&
      e.knots &&
      e.knots.length === ctrl.length + (e.degree || 3) + 1;
    const pts = useNurbs ? G.nurbsPoints(ctrl, e.degree || 3, e.knots, e.weights, 16) : fit || ctrl;
    if (pts.length < 2) return null;
    const o = E.mk('spline', { pts, closed: false, dense: useNurbs });
    if (useNurbs)
      o.nurbs = {
        deg: e.degree || 3,
        knots: e.knots,
        ctrl,
        w: e.weights && e.weights.length === ctrl.length ? e.weights : null,
      };
    return o;
  }

  /**
   * Joins the edges of a hatch boundary path (lines, arcs, ellipse arcs, splines) into one point list.
   * @param {object[]} edges DWG hatch edges
   * @returns {{x: number, y: number}[]}
   */
  static edgesToLoop(edges) {
    const pts = [];
    for (const ed of edges) {
      if (!ed || typeof ed !== 'object') continue; // a damaged boundary path can contain empty entries
      let seg = [];
      if (ed.type === 1 || (ed.start && ed.end && ed.type === undefined))
        seg = [P(ed.start), P(ed.end)];
      else if (ed.center && ed.radius !== undefined) {
        let a0 = ed.startAngle ?? 0;
        let a1 = ed.endAngle ?? G.TAU;
        if (ed.isCCW === false || ed.counterClockwise === false) {
          const t = a0;
          a0 = -a1;
          a1 = -t;
        }
        if (a1 <= a0) a1 += G.TAU;
        seg = G.arcPoints(P(ed.center), ed.radius, a0, a1, Math.max(ed.radius / 300, 1e-6));
        if (ed.isCCW === false || ed.counterClockwise === false)
          seg = seg.map((p) => ({ x: p.x, y: -p.y + 2 * ed.center.y })).reverse();
      } else if (ed.majorAxisEndPoint) {
        const el = E.makeEllipse(
          P(ed.center),
          G.add(P(ed.center), P(ed.majorAxisEndPoint)),
          ed.axisRatio ?? ed.minorToMajorRatio ?? 1,
          ed.startAngle ?? 0,
          ed.endAngle ?? G.TAU,
        );
        seg = E.ellipsePts(el, 64);
      } else if (ed.controlPoints) seg = ed.controlPoints.map(P);
      // keep the path continuous: turn the piece around when its far end touches the path
      if (
        pts.length &&
        seg.length &&
        G.dist(pts[pts.length - 1], seg[0]) > G.dist(pts[pts.length - 1], seg[seg.length - 1])
      )
        seg.reverse();
      for (const q of seg) if (!pts.length || G.dist(pts[pts.length - 1], q) > 1e-9) pts.push(q);
    }
    return pts;
  }

  // ---------------------------------------------------------------- blocks, model space, layouts

  /** @private Block definitions (model and paper space records are not blocks). */
  loadBlocks() {
    const { doc, db } = this;
    for (const b of db.blocks || []) {
      if (/^\*(Model|Paper)_Space/i.test(b.name)) continue;
      const ents = (b.entities || []).map((x) => this.mapEntity(x)).filter(Boolean);
      doc.defineBlock(b.name, P(b.basePoint || { x: 0, y: 0 }), ents);
    }
  }

  /** @private @returns {object|null} the bounding box of the visible model space objects. */
  modelExtents() {
    const { doc } = this;
    let b = null;
    for (const e of doc.model) if (doc.visible(e)) b = E.bboxMerge(b, E.bbox(e, doc));
    return b;
  }

  /**
   * @private Paper-space layouts with their objects; a viewport is fitted to the whole model.
   * Without layouts in the file, Layout1 and Layout2 are created.
   * @param {object|null} ext the model extents
   */
  loadLayouts(ext) {
    const { doc, db } = this;
    const names = (db.layouts || [])
      .filter((l) => !/^model$/i.test(l.name))
      .sort((a, b) => a.tab - b.tab);
    doc.layouts = {};
    for (const l of names.length ? names : [{ name: 'Layout1' }, { name: 'Layout2' }]) {
      const lay = newLayout(l.name);
      lay.ents.forEach((x) => {
        x.id = doc.nextId++;
      });
      const blk = (db.blocks || []).find((b) => b.handle === l.block);
      if (blk && blk.entities && blk.entities.length)
        for (const e of blk.entities) {
          const o = this.mapEntity(e);
          if (o) {
            o.id = doc.nextId++;
            lay.ents.push(o);
          }
        }
      const vp = lay.ents.find((x) => x.type === 'viewport');
      if (vp && ext) {
        const w = vp.p2.x - vp.p1.x;
        const hh = vp.p2.y - vp.p1.y;
        vp.cx = (ext.x0 + ext.x1) / 2;
        vp.cy = (ext.y0 + ext.y1) / 2;
        vp.scale =
          Math.min(w / Math.max(1e-9, ext.x1 - ext.x0), hh / Math.max(1e-9, ext.y1 - ext.y0)) *
          0.95;
      }
      doc.layouts[l.name] = lay;
    }
  }
}

/* ============================================================================================
 * 4. ENTRY POINT AND COMPATIBILITY EXPORTS
 * ========================================================================================== */

/**
 * Converts a DWG database to a document.
 * @param {object} db the object returned by the main-process reader
 * @param {string} [name='Drawing1'] the document name
 * @returns {{doc: Doc, warnings: string[]}}
 */
export function dwgToDoc(db, name = 'Drawing1') {
  return new DwgImporter(db, name).convert();
}

export const _l = LINETYPES;
