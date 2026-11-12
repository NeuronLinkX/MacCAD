/**
 * @file dimmatch.js
 * @brief Dimension-line matching.
 *
 * Puts a new dimension (or an existing one, via MATCHPROP) on the same dimension line as a
 * reference dimension, and finds the arc behind a pick when an arc / circle / rounded polyline
 * corner is dimensioned.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import * as G from './geom.js';
import * as E from './entities.js';

/* ============================================================================================
 * 2. CLASS
 * ========================================================================================== */

/** Static helpers for aligning dimensions and picking arcs to dimension. */
export class DimMatch {
  /** @returns {{x: number, y: number}} v rotated by +90 degrees. */
  static perp(u) {
    return { x: -u.y, y: u.x };
  }

  /** @returns {number} angle a folded into [0, PI): a line has no direction, so 0 and PI are the same. */
  static lineAngle(a) {
    const t = a % Math.PI;
    return t < 0 ? t + Math.PI : t;
  }

  /** @returns {boolean} true when two angles describe parallel lines (within 0.001 rad). */
  static sameDir(a, b) {
    const d = Math.abs(DimMatch.lineAngle(a) - DimMatch.lineAngle(b));
    return d < 1e-3 || Math.PI - d < 1e-3;
  }

  /**
   * Direction and offset of the dimension line of a linear / aligned dimension.
   * @param {object} d a dimension entity
   * @returns {{rot: number, u: object, n: object, off: number} | null} rot = line angle, u = unit
   *          direction, n = unit normal, off = offset of the line measured along n; null when `d`
   *          has no such line (other kinds of dimension)
   */
  static dimLineOf(d) {
    if (!d || d.type !== 'dim' || (d.kind !== 'lin' && d.kind !== 'ali') || !d.dp) return null;
    const rot = d.kind === 'ali' ? G.ang(d.p1, d.p2) : d.rot || 0;
    const u = { x: Math.cos(rot), y: Math.sin(rot) };
    const n = DimMatch.perp(u);
    return { rot, u, n, off: d.dp.x * n.x + d.dp.y * n.y };
  }

  /** @returns {{x: number, y: number}} the point of line `L` closest to m (m moved along the line's normal). */
  static onLine(L, m) {
    const k = L.off - (m.x * L.n.x + m.y * L.n.y);
    return { x: m.x + L.n.x * k, y: m.y + L.n.y * k };
  }

  /**
   * Properties of a new dimension between p1 and p2 whose dimension line lies on the reference's.
   * @param {object} ref the reference dimension
   * @param {object} p1 first extension-line origin
   * @param {object} p2 second extension-line origin
   * @returns {object | null} `{kind: 'ali', dp}` or `{kind: 'lin', rot, dp}`; null when `ref` has no dimension line
   */
  static alignedProps(ref, p1, p2) {
    const L = DimMatch.dimLineOf(ref);
    if (!L) return null;
    const dp = DimMatch.onLine(L, G.mid(p1, p2));
    return DimMatch.sameDir(G.ang(p1, p2), L.rot) && ref.kind === 'ali'
      ? { kind: 'ali', dp }
      : { kind: 'lin', rot: L.rot, dp };
  }

  /**
   * MATCHPROP between two dimensions: copies the dimension style and, when the dimension lines are
   * parallel, lines the destination up with the source.
   * @param {object} src source dimension
   * @param {object} dst destination dimension (modified)
   * @returns {boolean} true when the dimension lines were aligned
   */
  static matchDimension(src, dst) {
    dst.style = src.style;
    for (const k of ['arrow', 'dimtxt', 'dimscale']) if (src[k] !== undefined) dst[k] = src[k];
    const L = DimMatch.dimLineOf(src);
    const M = DimMatch.dimLineOf(dst);
    if (!L || !M || !DimMatch.sameDir(L.rot, M.rot)) return false;
    dst.dp = DimMatch.onLine(L, G.mid(dst.p1, dst.p2));
    return true;
  }

  /**
   * Filter for the "select arc or circle" prompt: arcs, circles and the ROUND corners of polylines
   * (made by FILLET or rectangles with fillet) can all be dimensioned.
   * @param {object} e entity
   * @returns {boolean}
   */
  static isArcPick(e) {
    return (
      e.type === 'arc' || e.type === 'circle' || (e.type === 'pline' && e.pts.some((p) => p.b))
    );
  }

  /**
   * Finds the arc behind a pick.
   * @param {object} c command context (gives access to the document)
   * @param {{e: object, p: object}} r the pick: entity and pick point
   * @returns {{c: object, r: number, a0: number, a1: number, e: object} | null} centre, radius, angles
   *          and the entity; for a polyline the arc segment nearest to the pick point
   */
  static arcOfPick(c, r) {
    const e = r.e;
    if (e.type === 'arc' || e.type === 'circle') return { c: e.c, r: e.r, a0: e.a0, a1: e.a1, e };
    if (e.type === 'pline') {
      let best = null;
      for (const P of E.prims(e, c.doc)) {
        if (P.k !== 'a') continue;
        const n = G.nearestOnPrim(P, r.p);
        if (!best || n.d < best.d) best = { d: n.d, P };
      }
      return best && { c: best.P.c, r: best.P.r, a0: best.P.a0, a1: best.P.a1, e };
    }
    return null;
  }
}

/* ============================================================================================
 * 3. COMPATIBILITY EXPORTS
 * ========================================================================================== */
export const dimLineOf = DimMatch.dimLineOf;
export const alignedProps = DimMatch.alignedProps;
export const matchDimension = DimMatch.matchDimension;
export const ARC_PICK = DimMatch.isArcPick;
export const arcOfPick = DimMatch.arcOfPick;
