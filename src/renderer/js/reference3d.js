/**
 * @file reference3d.js
 * @brief A drawing as a REFERENCE for the AI 3D modeller.
 *
 * The selected 2D objects become named outlines (P1, P2, ...), circles (C1, C2, ...) and texts. The
 * model gets a short description and can build with them (extrude_outline / extrude_circle in
 * plan3d.js), so a 2D plate drawing turns into a solid with its holes at the right places.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import * as E from './entities.js';
import * as O from './ops.js';

/* ============================================================================================
 * 2. CLASS
 * ========================================================================================== */

/** Static functions that describe a 2D drawing for the AI modeller. */
export class ReferenceDrawing {
  /** @private @returns {{x: number, y: number}[]} the outline of a closed polyline (bulges flattened). */
  static polyOf(pts) {
    return E.closedLoop(E.mk('pline', { pts, closed: true })).map((p) => ({ x: p.x, y: p.y }));
  }

  /** @private @returns {number} signed polygon area. */
  static areaOf(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i += 1) {
      const q = poly[(i + 1) % poly.length];
      a += poly[i].x * q.y - q.x * poly[i].y;
    }
    return a / 2;
  }

  /** @private @returns {{x0: number, y0: number, x1: number, y1: number}} the bounding box of a polygon. */
  static bboxOf(poly) {
    return poly.reduce(
      (b, p) => ({
        x0: Math.min(b.x0, p.x),
        y0: Math.min(b.y0, p.y),
        x1: Math.max(b.x1, p.x),
        y1: Math.max(b.y1, p.y),
      }),
      { x0: 1e18, y0: 1e18, x1: -1e18, y1: -1e18 },
    );
  }

  /** @returns {boolean} true when point p lies inside the polygon (even-odd rule). */
  static insidePoly(p, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
      if (
        poly[i].y > p.y !== poly[j].y > p.y &&
        p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x
      )
        c = !c;
    return c;
  }

  /** @private @returns {number} a number rounded to 3 decimals. */
  static r2(v) {
    return +Number(v).toFixed(3);
  }

  /**
   * Collects outlines, circles and texts from drawing objects (blocks are searched, lines and arcs
   * that join into closed shapes become outlines).
   * @private
   * @param {object} doc the document
   * @param {object[]} ents the objects
   * @returns {{loops: object[], joinables: object[], circles: object[], texts: string[], layers: Set<string>}}
   */
  static collect(doc, ents) {
    const loops = [];
    const joinables = [];
    const circles = [];
    const texts = [];
    const layers = new Set();
    const take = (e, depth = 0) => {
      if (!e || (doc.visible && !doc.visible(e))) return;
      layers.add(e.layer);
      switch (e.type) {
        case 'pline':
          if (e.closed && e.pts.length >= 3)
            loops.push(e.pts.map((p) => ({ x: p.x, y: p.y, b: p.b || 0 })));
          else joinables.push(e);
          break;
        case 'line':
        case 'arc':
          joinables.push(e);
          break;
        case 'circle':
          circles.push({ c: { x: e.c.x, y: e.c.y }, r: e.r });
          break;
        case 'ellipse':
        case 'spline': {
          const l = E.closedLoop(e);
          if (
            l &&
            l.length >= 3 &&
            (e.type === 'ellipse'
              ? Math.abs((e.a1 - e.a0) % (Math.PI * 2)) < 1e-6 || e.a1 - e.a0 >= Math.PI * 2 - 1e-6
              : e.closed)
          )
            loops.push(l.map((p) => ({ x: p.x, y: p.y, b: 0 })));
          break;
        }
        case 'text':
        case 'mtext':
          if (String(e.str || '').trim())
            texts.push(String(e.str).replace(/\s+/g, ' ').trim().slice(0, 60));
          break;
        case 'dim': {
          try {
            texts.push(`dimension ${E.dimText(e, doc)}`);
          } catch {
            /* ignore */
          }
          break;
        }
        case 'insert':
          if (depth < 4) for (const k of E.leaves(e, doc)) take(k, depth + 1);
          break;
        default:
          break;
      }
    };
    for (const e of ents) take(e);
    return { loops, joinables, circles, texts, layers };
  }

  /**
   * Builds the reference description of a drawing.
   * @param {object} doc the document
   * @param {object[]} ents MacCAD entities (a drawing's objects)
   * @param {{maxOutlines?: number, maxCircles?: number, maxTexts?: number}} [limits]
   * @returns {{outlines: object, circles: object, texts: string[], layers: string[], summary: string,
   *           empty: boolean, label: string}} `outlines` = `{P1: {pts, poly, bbox, area}}`,
   *           `circles` = `{C1: {c, r}}`, `summary` = the text given to the model
   */
  static build(doc, ents, { maxOutlines = 8, maxCircles = 40, maxTexts = 24 } = {}) {
    const r2 = ReferenceDrawing.r2;
    const { loops, joinables, circles, texts, layers } = ReferenceDrawing.collect(doc, ents);

    // lines and arcs that join into closed shapes become outlines
    let size = 0;
    {
      let b = null;
      for (const e of ents) {
        const x = E.bbox(e, doc);
        if (x) b = E.bboxMerge(b, x);
      }
      if (b) size = Math.max(b.x1 - b.x0, b.y1 - b.y0);
    }
    let openChains = 0;
    if (joinables.length)
      for (const j of O.joinEnts(joinables, Math.max(1e-6, size * 1e-5))) {
        if (j.type === 'pline' && j.closed && j.pts.length >= 3)
          loops.push(j.pts.map((p) => ({ x: p.x, y: p.y, b: p.b || 0 })));
        else if (j.type === 'circle') circles.push({ c: { x: j.c.x, y: j.c.y }, r: j.r });
        else openChains += 1;
      }

    // name the biggest outlines P1.. and the circles C1.. (left to right)
    const outlines = loops
      .map((pts) => {
        const poly = ReferenceDrawing.polyOf(pts);
        return {
          pts,
          poly,
          bbox: ReferenceDrawing.bboxOf(poly),
          area: Math.abs(ReferenceDrawing.areaOf(poly)),
        };
      })
      .filter((o) => o.area > 1e-9)
      .sort((a, b) => b.area - a.area)
      .slice(0, maxOutlines);
    const cs = circles.sort((a, b) => a.c.x - b.c.x || a.c.y - b.c.y).slice(0, maxCircles);
    const O1 = {};
    const C1 = {};
    outlines.forEach((o, i) => {
      O1[`P${i + 1}`] = o;
    });
    cs.forEach((c, i) => {
      C1[`C${i + 1}`] = c;
    });

    // the text description for the model
    const lines = [];
    for (const [id, o] of Object.entries(O1)) {
      const nArc = o.pts.filter((p) => p.b).length;
      lines.push(
        `${id}: closed outline ${r2(o.bbox.x1 - o.bbox.x0)} x ${r2(o.bbox.y1 - o.bbox.y0)}, x ${r2(o.bbox.x0)}..${r2(o.bbox.x1)}, y ${r2(o.bbox.y0)}..${r2(o.bbox.y1)}, ${o.pts.length} corners${nArc ? `, ${nArc} arcs` : ''}, area ${r2(o.area)}`,
      );
    }
    for (const [id, c] of Object.entries(C1))
      lines.push(
        `${id}: circle centre (${r2(c.c.x)}, ${r2(c.c.y)}) radius ${r2(c.r)} (diameter ${r2(2 * c.r)})`,
      );
    const keep = [...new Set(texts)].slice(0, maxTexts);
    if (keep.length)
      lines.push(
        `Texts and dimensions in the drawing: ${keep.map((t) => JSON.stringify(t)).join(', ')}`,
      );
    if (openChains)
      lines.push(`${openChains} open line/arc chain(s) are not closed shapes and were left out.`);
    const empty = !Object.keys(O1).length && !Object.keys(C1).length;
    const summary = empty
      ? ''
      : `Reference drawing (2D objects the user selected; millimetres; drawing coordinates, Z = 0):\n${lines.join('\n')}`;
    return {
      outlines: O1,
      circles: C1,
      texts: keep,
      layers: [...layers],
      summary,
      empty,
      label: `${Object.keys(O1).length} outline(s), ${Object.keys(C1).length} circle(s), ${keep.length} text(s)`,
    };
  }

  /**
   * The outlines and circles that lie inside the outline `outerId` (the holes of an extruded plate).
   * @param {object} ref a reference made by `build`
   * @param {string} outerId the outline id, for example "P1"
   * @returns {{outlines: string[], circles: string[]}} ids of the holes
   */
  static holesOf(ref, outerId) {
    const outer = ref.outlines[outerId];
    if (!outer) return { outlines: [], circles: [] };
    const inside = (p) => ReferenceDrawing.insidePoly(p, outer.poly);
    const outs = Object.entries(ref.outlines).filter(
      ([id, o]) =>
        id !== outerId &&
        o.area < outer.area &&
        inside({ x: (o.bbox.x0 + o.bbox.x1) / 2, y: (o.bbox.y0 + o.bbox.y1) / 2 }) &&
        inside(o.poly[0]),
    );
    const holeBoxes = outs.map(([, o]) => o.bbox);
    const circs = Object.entries(ref.circles).filter(
      ([, c]) =>
        inside(c.c) &&
        inside({ x: c.c.x + c.r, y: c.c.y }) &&
        inside({ x: c.c.x - c.r, y: c.c.y }) &&
        !holeBoxes.some((b) => c.c.x >= b.x0 && c.c.x <= b.x1 && c.c.y >= b.y0 && c.c.y <= b.y1),
    ); // a circle that is itself the outline of a counted shape is not a second hole
    return { outlines: outs.map(([id]) => id), circles: circs.map(([id]) => id) };
  }
}

/* ============================================================================================
 * 3. COMPATIBILITY EXPORTS
 * ========================================================================================== */
export const insidePoly = ReferenceDrawing.insidePoly;
export const buildReference = ReferenceDrawing.build;
export const holesOf = ReferenceDrawing.holesOf;
