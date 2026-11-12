/**
 * @file snap.js
 * @brief Object snap engine and the polar / ortho / grid / object-snap-tracking helpers.
 *
 * Contents:
 *   - OSNAP_MODES / OSNAP_LABEL : the snap kinds and their labels (AutoCAD order)
 *   - SnapCollector             : picks the best snap candidate during one search
 *   - SnapEngine                : `find` (object snap), polar / ortho / grid constraints, tracking
 *
 * Points are plain `{x, y}` objects in drawing coordinates, `tol` is the aperture in drawing units.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import * as G from './geom.js';
import * as E from './entities.js';

const { dist, ang, polar, sub, add, mul, dot, norm } = G;

/* ============================================================================================
 * 2. CONSTANTS
 * ========================================================================================== */

/** Snap kinds with their labels; order and labels follow the AutoCAD Drafting Settings > Object Snap tab. */
export const OSNAP_MODES = [
  ['end', 'Endpoint'],
  ['mid', 'Midpoint'],
  ['cen', 'Center'],
  ['gcen', 'Geometric Center'],
  ['nod', 'Node'],
  ['qua', 'Quadrant'],
  ['int', 'Intersection'],
  ['ext', 'Extension'],
  ['ins', 'Insertion'],
  ['per', 'Perpendicular'],
  ['tan', 'Tangent'],
  ['nea', 'Nearest'],
  ['app', 'Apparent Intersection'],
  ['par', 'Parallel'],
];

/** Snap kind -> label. */
export const OSNAP_LABEL = Object.fromEntries(OSNAP_MODES);

/** Priority of each kind when two candidates are equally close (lower wins). */
const PRIORITY = {
  end: 0,
  int: 1,
  mid: 2,
  cen: 3,
  gcen: 3,
  qua: 4,
  nod: 5,
  ins: 6,
  per: 7,
  tan: 8,
  app: 9,
  ext: 10,
  par: 11,
  nea: 12,
};

/** Fall-back kinds: real snap points always win over these when one is inside the aperture, like AutoCAD. */
const WEAK_KINDS = new Set(['nea', 'ext', 'par']);

/** In a crowded drawing only this many objects nearest to the cursor are examined. */
const MAX_NEAR = 400;
/** At most this many objects near the cursor are used for the geometry-based snaps. */
const MAX_CLOSE = 14;
/** Apparent intersection looks at objects up to this many apertures away, at most MAX_APPARENT of them. */
const APPARENT_REACH = 80;
const MAX_APPARENT = 10;

/* ============================================================================================
 * 3. SNAP COLLECTOR
 * ========================================================================================== */

/** Collects snap candidates during one search and keeps the best one. */
class SnapCollector {
  /**
   * @param {{x: number, y: number}} p the cursor position
   * @param {number} tol the aperture
   * @param {Set<string>} modes the enabled snap kinds
   */
  constructor(p, tol, modes) {
    this.p = p;
    this.tol = tol;
    this.modes = modes;
    /** @type {{p: object, t: string, e: object, d: number, rank: number}|null} best candidate so far */
    this.best = null;
  }

  /**
   * Offers a candidate. It is kept when its kind is enabled, it lies inside the aperture and it is
   * better than the current best (real snaps before fall-backs, then nearer, then higher priority).
   * @param {object} q the snap point
   * @param {string} t the snap kind (see OSNAP_MODES)
   * @param {object|null} e the entity it belongs to
   * @param {object} [more] extra fields stored on the result (for example `from`)
   */
  consider(q, t, e, more) {
    if (!this.modes.has(t)) return;
    const d = dist(this.p, q);
    if (d > this.tol) return;
    const rank = WEAK_KINDS.has(t) ? 1 : 0;
    const best = this.best;
    if (
      !best ||
      rank < best.rank ||
      (rank === best.rank &&
        (d < best.d - 1e-12 * this.tol ||
          (Math.abs(d - best.d) < 1e-9 * this.tol && PRIORITY[t] < PRIORITY[best.t])))
    )
      this.best = { p: q, t, e, d, rank, ...more };
  }
}

/* ============================================================================================
 * 4. SNAP ENGINE
 * ========================================================================================== */

/** Static functions: object snap search and the other cursor constraints. */
export class SnapEngine {
  /**
   * Finds the best object snap near the cursor.
   * @param {object[]} ents the entities to search
   * @param {object} doc the document (visibility, blocks, styles)
   * @param {{x: number, y: number}} p cursor position
   * @param {number} tol aperture in drawing units
   * @param {Set<string>} modes enabled snap kinds
   * @param {{x: number, y: number}|null} base the previous point of the running command (for per / tan / par)
   * @param {{ext?: Array<{o: object, d: object}>, par?: Array<{d: object}>}} [extra] extension /
   *        parallel rays acquired by hovering (see App.acquireRays)
   * @returns {{p: object, t: string, e: object|null, d: number}|null} the snap, or null
   */
  static find(ents, doc, p, tol, modes, base, extra) {
    if (!modes || !modes.size) return null;
    const c = new SnapCollector(p, tol, modes);
    SnapEngine.addRaySnaps(c, base, extra);
    const near = SnapEngine.nearbyEntities(ents, doc, p, tol);
    SnapEngine.addPointSnaps(c, near, doc);
    const wantGeo = ['int', 'per', 'tan', 'nea', 'app'].some((k) => modes.has(k));
    if (wantGeo) SnapEngine.addGeometrySnaps(c, ents, near, doc, base);
    return c.best;
  }

  /** @private Extension and parallel snaps from rays acquired by hovering. */
  static addRaySnaps(c, base, extra) {
    if (!extra) return;
    const { p, tol, modes } = c;
    if (modes.has('ext'))
      for (const r of extra.ext || []) {
        const t = dot(sub(p, r.o), r.d);
        if (t > tol * 0.5) c.consider(add(r.o, mul(r.d, t)), 'ext', null, { from: r.o });
      }
    if (modes.has('par') && base)
      for (const r of extra.par || []) {
        const t = dot(sub(p, base), r.d);
        c.consider(add(base, mul(r.d, t)), 'par', null, { from: base });
      }
  }

  /**
   * The visible entities whose bounding box is near the cursor. In a crowded drawing only the
   * MAX_NEAR objects nearest to the cursor are kept (the old rule took the first 400 in drawing
   * order, so objects drawn later were never snapped).
   * @private
   */
  static nearbyEntities(ents, doc, p, tol) {
    const near = [];
    for (const e of ents) {
      if (!doc.visible(e)) continue;
      const b = E.bbox(e, doc);
      if (e.type === 'xline' || e.type === 'ray') {
        if (E.distTo(e, p, doc) <= tol * 3) near.push(e);
        continue;
      }
      if (
        !b ||
        p.x < b.x0 - tol * 3 ||
        p.x > b.x1 + tol * 3 ||
        p.y < b.y0 - tol * 3 ||
        p.y > b.y1 + tol * 3
      )
        continue;
      near.push(e);
    }
    if (near.length > MAX_NEAR) {
      const d = new Map(near.map((e) => [e, E.distTo(e, p, doc)]));
      near.sort((a, b) => d.get(a) - d.get(b));
      near.length = MAX_NEAR;
    }
    return near;
  }

  /** @private The snap points each entity offers itself (end, mid, centre, ...), including those inside block references. */
  static addPointSnaps(c, near, doc) {
    for (const e of near) {
      for (const s of E.snapPoints(e, doc)) c.consider(s.p, s.t, e);
      if (e.type === 'insert')
        for (const k of E.leaves(e, doc))
          for (const s of E.snapPoints(k, doc)) c.consider(s.p, s.t, e);
    }
  }

  /**
   * Snaps that need geometry: intersection, apparent intersection, nearest, perpendicular, tangent.
   * @private
   */
  static addGeometrySnaps(c, ents, near, doc, base) {
    const { p, tol, modes } = c;
    // geometry close to the cursor; the objects INSIDE a block reference count one by one (lines of a block cross each other too)
    const close = [];
    for (const e of near) {
      if (e.type === 'insert') {
        for (const k of E.leaves(e, doc))
          if (doc.visible(k) && E.distTo(k, p, doc) <= tol * 4) close.push({ e, ent: k });
      } else if (E.distTo(e, p, doc) <= tol * 4) close.push({ e, ent: e });
      if (close.length >= MAX_CLOSE) break;
    }
    const pr = close.map((x) => E.prims(x.ent, doc));
    if (modes.has('int')) SnapEngine.addIntersections(c, close, pr);
    if (modes.has('app')) SnapEngine.addApparentIntersections(c, ents, doc);
    for (let i = 0; i < close.length; i += 1)
      for (const P of pr[i]) SnapEngine.addPrimitiveSnaps(c, P, close[i].e, base);
  }

  /** @private Real intersections between the close objects, and self-intersections of polylines. */
  static addIntersections(c, close, pr) {
    for (let i = 0; i < close.length; i += 1)
      for (let j = i + 1; j < close.length; j += 1)
        for (const a of pr[i])
          for (const b of pr[j])
            for (const h of G.intersectPrims(a, b)) c.consider(h, 'int', close[i].e);
    for (let i = 0; i < close.length; i += 1)
      if (close[i].ent.type === 'pline' && pr[i].length < 60)
        for (let a = 0; a < pr[i].length; a += 1)
          for (let b = a + 2; b < pr[i].length; b += 1)
            for (const h of G.intersectPrims(pr[i][a], pr[i][b])) c.consider(h, 'int', close[i].e);
  }

  /**
   * @private
   * Apparent intersection: where the objects WOULD cross if they were extended (candidates can be
   * farther away than for real snaps).
   */
  static addApparentIntersections(c, ents, doc) {
    const { p, tol } = c;
    const cand = ents
      .filter(
        (e) =>
          doc.visible(e) &&
          (e.type === 'line' || e.type === 'pline' || e.type === 'arc' || e.type === 'circle'),
      )
      .map((e) => ({ e, d: E.distTo(e, p, doc) }))
      .filter((x) => x.d <= tol * APPARENT_REACH)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_APPARENT);
    const pc = cand.map((x) => E.prims(x.e, doc));
    for (let i = 0; i < cand.length; i += 1)
      for (let j = i + 1; j < cand.length; j += 1)
        for (const a of pc[i])
          for (const b of pc[j])
            for (const h of G.intersectPrims(a, b, true, true)) c.consider(h, 'app', cand[i].e);
  }

  /** @private Nearest, perpendicular and tangent snaps on one primitive. */
  static addPrimitiveSnaps(c, P, owner, base) {
    const { p, modes } = c;
    if (modes.has('nea')) {
      const q = G.nearestOnPrim(P, p);
      c.consider(q.p, 'nea', owner);
    }
    if (base && modes.has('per')) {
      if (P.k === 's') {
        const v = sub(P.b, P.a);
        const l2 = dot(v, v);
        if (l2 > 1e-18) {
          const t = dot(sub(base, P.a), v) / l2;
          if (t >= -1e-9 && t <= 1 + 1e-9)
            c.consider({ x: P.a.x + v.x * t, y: P.a.y + v.y * t }, 'per', owner);
        }
      } else {
        const a = ang(P.c, base);
        for (const an of [a, a + Math.PI])
          if (G.inArc(an, P.a0, P.a1)) c.consider(polar(P.c, an, P.r), 'per', owner);
      }
    }
    if (base && modes.has('tan') && P.k === 'a') {
      const d = dist(base, P.c);
      if (d > P.r) {
        const al = Math.acos(P.r / d);
        const a0 = ang(P.c, base);
        for (const an of [a0 + al, a0 - al])
          if (G.inArc(an, P.a0, P.a1)) c.consider(polar(P.c, an, P.r), 'tan', owner);
      }
    }
  }

  // ---------------------------------------------------------------- polar / ortho / grid

  /**
   * Polar constraint relative to a base point.
   * @param {{x: number, y: number}} base the previous point
   * @param {{x: number, y: number}} p the cursor position
   * @param {number} increment polar angle step in radians
   * @param {number} [tolRad=0.1] how close (radians) the cursor must be to a polar direction
   * @returns {{p: object, angle: number}|null} the constrained point, or null when not near a polar direction
   */
  static constrainAngle(base, p, increment, tolRad = 0.1) {
    const d = dist(base, p);
    if (d < 1e-12) return null;
    const a = ang(base, p);
    const step = increment;
    const k = Math.round(a / step);
    const snapA = k * step;
    if (
      Math.abs(a - snapA) <= tolRad * (step >= Math.PI / 2 ? 0.5 : 1) * 0.5 ||
      Math.abs(Math.sin(a - snapA)) < Math.sin(0.08)
    ) {
      return { p: polar(base, snapA, d), angle: snapA };
    }
    return null;
  }

  /** @returns {{x: number, y: number}} the cursor moved onto the horizontal or vertical line through `base` (whichever is nearer). */
  static orthoPoint(base, p) {
    const dx = p.x - base.x;
    const dy = p.y - base.y;
    return Math.abs(dx) >= Math.abs(dy) ? { x: p.x, y: base.y } : { x: base.x, y: p.y };
  }

  /**
   * Snap to the grid.
   * @param {{x: number, y: number}} p the cursor position
   * @param {{x: number, y: number}} spacing grid spacing in x and y
   * @param {{x: number, y: number}} [origin] grid origin
   * @returns {{x: number, y: number}}
   */
  static gridSnap(p, spacing, origin = { x: 0, y: 0 }) {
    return {
      x: origin.x + Math.round((p.x - origin.x) / spacing.x) * spacing.x,
      y: origin.y + Math.round((p.y - origin.y) / spacing.y) * spacing.y,
    };
  }

  // ---------------------------------------------------------------- object snap tracking

  /**
   * Object snap tracking: given the acquired points, finds the crossing of two tracking lines, or
   * else a single tracking line, near the cursor.
   * @param {object[]} acquired the points acquired by hovering
   * @param {{x: number, y: number}} p the cursor position
   * @param {number} tol aperture
   * @param {number} increment polar step in radians (tracking lines run at every multiple)
   * @param {object} [base] unused, kept for the call sites
   * @returns {{p: object, d: number, lines: object[]}|null}
   */
  static trackPoint(acquired, p, tol, increment, base) {
    if (!acquired.length) return null;
    const dirs = [];
    for (const a of acquired)
      for (let k = 0; k < Math.round((Math.PI * 2) / increment); k += 1)
        dirs.push({ o: a, ang: k * increment });
    let best = null;
    const lineDist = (L, q) => {
      const d = { x: Math.cos(L.ang), y: Math.sin(L.ang) };
      const v = sub(q, L.o);
      const t = dot(v, d);
      return { dist: Math.abs(v.x * d.y - v.y * d.x), t };
    };
    // intersections of two tracking lines
    for (let i = 0; i < dirs.length; i += 1)
      for (let j = i + 1; j < dirs.length; j += 1) {
        if (dirs[i].o === dirs[j].o) continue;
        const d1 = { x: Math.cos(dirs[i].ang), y: Math.sin(dirs[i].ang) };
        const d2 = { x: Math.cos(dirs[j].ang), y: Math.sin(dirs[j].ang) };
        const r = G.lineLine(dirs[i].o, add(dirs[i].o, d1), dirs[j].o, add(dirs[j].o, d2));
        if (!r) continue;
        const dd = dist(r.p, p);
        if (dd <= tol && (!best || dd < best.d))
          best = { p: r.p, d: dd, lines: [dirs[i], dirs[j]] };
      }
    if (best) return best;
    for (const L of dirs) {
      const q = lineDist(L, p);
      if (q.dist <= tol && q.t > tol * 0.5) {
        const d = { x: Math.cos(L.ang), y: Math.sin(L.ang) };
        const pp = add(L.o, mul(d, q.t));
        if (!best || q.dist < best.d) best = { p: pp, d: q.dist, lines: [L] };
      }
    }
    void base;
    void norm;
    return best;
  }
}

/* ============================================================================================
 * 5. COMPATIBILITY EXPORTS
 * ========================================================================================== */
export const findSnap = SnapEngine.find;
export const constrainAngle = SnapEngine.constrainAngle;
export const orthoPoint = SnapEngine.orthoPoint;
export const gridSnap = SnapEngine.gridSnap;
export const trackPoint = SnapEngine.trackPoint;
