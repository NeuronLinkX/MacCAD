/**
 * @file geom.js
 * @brief 2D geometry kernel: vectors, angles, affine matrices, primitive intersection and distance.
 *
 * Layout of this file (top to bottom, like a C header + source):
 *   1. constants
 *   2. data types (documented as typedefs)
 *   3. classes: Vec2, Angle, Mat2D, Intersect, Prim, Polygon, Bulge, Nurbs
 *   4. compatibility exports (flat function names used all over the code base)
 *
 * All classes are static utility classes: they hold no state, every method is a pure function.
 * New code should call the classes (`Vec2.dist(a, b)`); the flat aliases at the bottom exist so
 * the older `import { dist } from './geom.js'` call sites keep working while they are migrated.
 */

/* ============================================================================================
 * 1. CONSTANTS
 * ========================================================================================== */

/** Full turn in radians. */
export const TAU = Math.PI * 2;
/** Generic "close enough to zero" tolerance. */
export const EPS = 1e-9;

/* ============================================================================================
 * 2. DATA TYPES
 * ========================================================================================== */

/**
 * @typedef {{x: number, y: number}} Point  A point or a vector in the drawing plane.
 *
 * @typedef {{a: number, b: number, c: number, d: number, e: number, f: number}} Matrix
 *   Affine matrix: x' = a*x + c*y + e ; y' = b*x + d*y + f.
 *
 * @typedef {{k: 's', a: Point, b: Point}} Segment
 *   Straight primitive from a to b.
 *
 * @typedef {{k: 'a', c: Point, r: number, a0: number, a1: number, rev?: boolean}} ArcPrim
 *   Counter-clockwise arc around c from angle a0 to a1 (a1 = a0 + TAU is a full circle).
 *   `rev` means the arc is walked from a1 back to a0.
 *
 * @typedef {Segment | ArcPrim} Primitive
 */

/* ============================================================================================
 * 3. CLASSES
 * ========================================================================================== */

/** 2D vector / point arithmetic. Points are plain `{x, y}` objects. */
export class Vec2 {
  /** @returns {Point} a new point. */
  static pt(x, y) {
    return { x, y };
  }

  /** @returns {Point} a + b. */
  static add(a, b) {
    return { x: a.x + b.x, y: a.y + b.y };
  }

  /** @returns {Point} a - b. */
  static sub(a, b) {
    return { x: a.x - b.x, y: a.y - b.y };
  }

  /** @returns {Point} vector a scaled by k. */
  static mul(a, k) {
    return { x: a.x * k, y: a.y * k };
  }

  /** @returns {number} dot product a . b. */
  static dot(a, b) {
    return a.x * b.x + a.y * b.y;
  }

  /** @returns {number} z component of the cross product a x b. */
  static cross(a, b) {
    return a.x * b.y - a.y * b.x;
  }

  /** @returns {number} length of vector a. */
  static len(a) {
    return Math.hypot(a.x, a.y);
  }

  /** @returns {number} distance between points a and b. */
  static dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** @returns {Point} unit vector of a (the zero vector when a is shorter than 1e-14). */
  static norm(a) {
    const l = Math.hypot(a.x, a.y);
    return l < 1e-14 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
  }

  /** @returns {Point} linear interpolation between a and b at parameter t (0..1). */
  static lerp(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  /** @returns {Point} midpoint of a and b. */
  static mid(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  /** @returns {Point} a rotated by +90 degrees. */
  static perp(a) {
    return { x: -a.y, y: a.x };
  }

  /** @returns {number} direction angle of the line a -> b in radians. */
  static ang(a, b) {
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  /** @returns {Point} the point at angle `a` and distance `d` from centre `c`. */
  static polar(c, a, d) {
    return { x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d };
  }

  /**
   * Rotates point p by angle a around centre c.
   * @param {Point} p
   * @param {number} a angle in radians
   * @param {Point} [c] centre, default the origin
   * @returns {Point}
   */
  static rotate(p, a, c = { x: 0, y: 0 }) {
    const co = Math.cos(a);
    const si = Math.sin(a);
    const x = p.x - c.x;
    const y = p.y - c.y;
    return { x: c.x + x * co - y * si, y: c.y + x * si + y * co };
  }

  /** @returns {boolean} true when both coordinates differ by less than `e`. */
  static eq(a, b, e = 1e-7) {
    return Math.abs(a.x - b.x) < e && Math.abs(a.y - b.y) < e;
  }

  /** @returns {Point} a copy of p without any extra properties. */
  static clone(p) {
    return { x: p.x, y: p.y };
  }
}

/** Angle helpers (radians unless the name says otherwise). */
export class Angle {
  /** @returns {number} a folded into [0, TAU). */
  static normalize(a) {
    a %= TAU;
    if (a < 0) a += TAU;
    return a;
  }

  /**
   * Counter-clockwise sweep from a0 to a1 in [0, TAU]. Equal angles give 0, except when the two
   * inputs really differ by a whole turn, which gives TAU.
   */
  static sweep(a0, a1) {
    let s = Angle.normalize(a1 - a0);
    if (s < 1e-12 && Math.abs(a1 - a0) > 1e-9) s = TAU;
    return s;
  }

  /** @returns {boolean} true when angle `a` lies on the counter-clockwise arc a0 -> a1. */
  static inArc(a, a0, a1) {
    const s = Angle.sweep(a0, a1);
    const d = Angle.normalize(a - a0);
    return d <= s + 1e-9 || d >= TAU - 1e-9;
  }

  /** @returns {number} radians to degrees. */
  static deg(r) {
    return (r * 180) / Math.PI;
  }

  /** @returns {number} degrees to radians. */
  static rad(d) {
    return (d * Math.PI) / 180;
  }
}

/**
 * Affine 2D matrices {a,b,c,d,e,f}: x' = a*x + c*y + e ; y' = b*x + d*y + f.
 * Composition order: `Mat2D.mul(m, n)` applies n first, then m.
 */
export class Mat2D {
  /** The identity matrix. */
  static ID = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  /** @returns {Matrix} m after n (apply n first, then m). */
  static mul(m, n) {
    return {
      a: m.a * n.a + m.c * n.b,
      b: m.b * n.a + m.d * n.b,
      c: m.a * n.c + m.c * n.d,
      d: m.b * n.c + m.d * n.d,
      e: m.a * n.e + m.c * n.f + m.e,
      f: m.b * n.e + m.d * n.f + m.f,
    };
  }

  /** @returns {Matrix} translation by (dx, dy). */
  static translate(dx, dy) {
    return { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy };
  }

  /** @returns {Matrix} rotation by `an` radians around centre c (default origin). */
  static rotate(an, c = { x: 0, y: 0 }) {
    const co = Math.cos(an);
    const si = Math.sin(an);
    return {
      a: co,
      b: si,
      c: -si,
      d: co,
      e: c.x - co * c.x + si * c.y,
      f: c.y - si * c.x - co * c.y,
    };
  }

  /** @returns {Matrix} scale by sx, sy (sy defaults to sx) around centre c (default origin). */
  static scale(sx, sy = sx, c = { x: 0, y: 0 }) {
    return { a: sx, b: 0, c: 0, d: sy, e: c.x - sx * c.x, f: c.y - sy * c.y };
  }

  /** @returns {Matrix} reflection across the line through p and q. */
  static mirror(p, q) {
    const an = Vec2.ang(p, q);
    const co = Math.cos(2 * an);
    const si = Math.sin(2 * an);
    return {
      a: co,
      b: si,
      c: si,
      d: -co,
      e: p.x - co * p.x - si * p.y,
      f: p.y - si * p.x + co * p.y,
    };
  }

  /** @returns {Point} point p transformed by m. */
  static apply(m, p) {
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
  }

  /** @returns {Point} direction vector v transformed by m (translation ignored). */
  static vec(m, v) {
    return { x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y };
  }

  /** @returns {number} determinant of the linear part. */
  static det(m) {
    return m.a * m.d - m.b * m.c;
  }

  /** @returns {number} rotation angle of the x axis image. */
  static angle(m) {
    return Math.atan2(m.b, m.a);
  }

  /** @returns {number} uniform scale factor (square root of the absolute determinant). */
  static scl(m) {
    return Math.sqrt(Math.abs(Mat2D.det(m)));
  }

  /** @returns {boolean} true for a similarity transform (rotation + uniform scale + optional flip). */
  static isSimilarity(m) {
    const l1 = Math.hypot(m.a, m.b);
    const l2 = Math.hypot(m.c, m.d);
    return (
      Math.abs(l1 - l2) < 1e-9 * Math.max(1, l1) &&
      Math.abs(m.a * m.c + m.b * m.d) < 1e-9 * Math.max(1, l1 * l2)
    );
  }
}

/** Basic intersections between lines, circles and primitives. */
export class Intersect {
  /**
   * Infinite-line intersection of a-b with c-d.
   * @returns {{t: number, u: number, p: Point} | null} parameters along a-b and c-d plus the
   *          crossing point, or null when the lines are parallel.
   */
  static lineLine(a, b, c, d) {
    const r = Vec2.sub(b, a);
    const s = Vec2.sub(d, c);
    const den = Vec2.cross(r, s);
    if (Math.abs(den) < 1e-12 * (Vec2.len(r) * Vec2.len(s) || 1)) return null;
    const qp = Vec2.sub(c, a);
    const t = Vec2.cross(qp, s) / den;
    const u = Vec2.cross(qp, r) / den;
    return { t, u, p: { x: a.x + r.x * t, y: a.y + r.y * t } };
  }

  /**
   * Infinite line a-b against circle (c, r).
   * @returns {Array<{t: number, p: Point}>} 0, 1 (tangent) or 2 hits, with the parameter t along a-b.
   */
  static lineCircle(a, b, c, r) {
    const d = Vec2.sub(b, a);
    const f = Vec2.sub(a, c);
    const A = Vec2.dot(d, d);
    if (A < 1e-18) return [];
    const B = 2 * Vec2.dot(f, d);
    const C = Vec2.dot(f, f) - r * r;
    let D = B * B - 4 * A * C;
    const tol = 1e-9 * Math.max(1, B * B);
    if (D < -tol) return [];
    if (D < 0) D = 0;
    const sq = Math.sqrt(D);
    const ts =
      sq < 1e-9 * Math.sqrt(Math.max(1, A))
        ? [-B / (2 * A)]
        : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
    return ts.map((t) => ({ t, p: { x: a.x + d.x * t, y: a.y + d.y * t } }));
  }

  /** @returns {Point[]} 0, 1 (tangent) or 2 crossing points of circles (c1, r1) and (c2, r2). */
  static circleCircle(c1, r1, c2, r2) {
    const d = Vec2.dist(c1, c2);
    if (d < 1e-12) return [];
    if (d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
    const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
    const h2 = r1 * r1 - a * a;
    const h = h2 > 0 ? Math.sqrt(h2) : 0;
    const m = { x: c1.x + ((c2.x - c1.x) * a) / d, y: c1.y + ((c2.y - c1.y) * a) / d };
    if (h < 1e-9) return [m];
    const ox = (-(c2.y - c1.y) * h) / d;
    const oy = ((c2.x - c1.x) * h) / d;
    return [
      { x: m.x + ox, y: m.y + oy },
      { x: m.x - ox, y: m.y - oy },
    ];
  }

  /**
   * Intersections of two primitives (segment or arc).
   * @param {Primitive} P
   * @param {Primitive} Q
   * @param {boolean} [extP=false] treat P as unbounded (infinite line / full circle)
   * @param {boolean} [extQ=false] treat Q as unbounded
   * @returns {Point[]}
   */
  static prims(P, Q, extP = false, extQ = false) {
    const out = [];
    const okSeg = (t, ext) => ext || (t >= -1e-9 && t <= 1 + 1e-9);
    if (P.k === 's' && Q.k === 's') {
      const r = Intersect.lineLine(P.a, P.b, Q.a, Q.b);
      if (r && okSeg(r.t, extP) && okSeg(r.u, extQ)) out.push(r.p);
    } else if (P.k === 's' && Q.k === 'a') {
      for (const h of Intersect.lineCircle(P.a, P.b, Q.c, Q.r)) {
        if (!okSeg(h.t, extP)) continue;
        if (!extQ && !Angle.inArc(Vec2.ang(Q.c, h.p), Q.a0, Q.a1)) continue;
        out.push(h.p);
      }
    } else if (P.k === 'a' && Q.k === 's') {
      return Intersect.prims(Q, P, extQ, extP);
    } else {
      for (const h of Intersect.circleCircle(P.c, P.r, Q.c, Q.r)) {
        if (!extP && !Angle.inArc(Vec2.ang(P.c, h), P.a0, P.a1)) continue;
        if (!extQ && !Angle.inArc(Vec2.ang(Q.c, h), Q.a0, Q.a1)) continue;
        out.push(h);
      }
    }
    return out;
  }
}

/** Constructors and queries for primitives (segments and counter-clockwise arcs). */
export class Prim {
  /** @returns {Segment} a segment a -> b; `extra` properties are copied onto it. */
  static segment(a, b, extra) {
    return { k: 's', a, b, ...extra };
  }

  /** @returns {ArcPrim} a counter-clockwise arc; `extra` properties are copied onto it. */
  static arc(c, r, a0, a1, extra) {
    return { k: 'a', c, r, a0, a1, ...extra };
  }

  /** @returns {Point} the point of arc p at angle `an`. */
  static arcPoint(p, an) {
    return { x: p.c.x + Math.cos(an) * p.r, y: p.c.y + Math.sin(an) * p.r };
  }

  /** @returns {Point} where the primitive starts, honouring `rev` on arcs. */
  static start(p) {
    return p.k === 's' ? p.a : Prim.arcPoint(p, p.rev ? p.a1 : p.a0);
  }

  /** @returns {Point} where the primitive ends, honouring `rev` on arcs. */
  static end(p) {
    return p.k === 's' ? p.b : Prim.arcPoint(p, p.rev ? p.a0 : p.a1);
  }

  /** @returns {boolean} true for an arc that is a complete circle. */
  static isFull(p) {
    return p.k === 'a' && Math.abs(p.a1 - p.a0) >= TAU - 1e-9;
  }

  /**
   * Nearest point on a primitive.
   * @returns {{p: Point, d: number, t: number}} the point, its distance from `p`, and `t`
   *          (0..1 along a segment, the angle for an arc).
   */
  static nearest(P, p) {
    if (P.k === 's') {
      const v = Vec2.sub(P.b, P.a);
      const l2 = Vec2.dot(v, v);
      let t = l2 < 1e-18 ? 0 : Vec2.dot(Vec2.sub(p, P.a), v) / l2;
      t = Math.max(0, Math.min(1, t));
      const q = { x: P.a.x + v.x * t, y: P.a.y + v.y * t };
      return { p: q, d: Vec2.dist(p, q), t };
    }
    const an = Vec2.ang(P.c, p);
    if (Vec2.dist(p, P.c) > 1e-12 && Angle.inArc(an, P.a0, P.a1)) {
      const q = Vec2.polar(P.c, an, P.r);
      return { p: q, d: Math.abs(Vec2.dist(p, P.c) - P.r), t: an };
    }
    const e0 = Prim.arcPoint(P, P.a0);
    const e1 = Prim.arcPoint(P, P.a1);
    const d0 = Vec2.dist(p, e0);
    const d1 = Vec2.dist(p, e1);
    return d0 <= d1 ? { p: e0, d: d0, t: P.a0 } : { p: e1, d: d1, t: P.a1 };
  }

  /** @returns {number} distance from point p to the segment a-b. */
  static segDist(p, a, b) {
    return Prim.nearest({ k: 's', a, b }, p).d;
  }

  /**
   * Samples an arc into points (both end points included).
   * @param {Point} c centre
   * @param {number} r radius
   * @param {number} a0 start angle
   * @param {number} a1 end angle
   * @param {number} [maxErr=0.01] largest allowed distance between arc and chord
   * @returns {Point[]}
   */
  static arcPoints(c, r, a0, a1, maxErr = 0.01) {
    const sw = Angle.sweep(a0, a1) || TAU;
    const full = Math.abs(a1 - a0) >= TAU - 1e-9;
    const s = full ? TAU : sw;
    const step = r > maxErr ? 2 * Math.acos(Math.max(0, 1 - maxErr / r)) : 0.5;
    const n = Math.max(8, Math.min(720, Math.ceil(s / Math.max(0.02, Math.min(step, 0.3)))));
    const pts = [];
    for (let i = 0; i <= n; i += 1) pts.push(Vec2.polar(c, a0 + (s * i) / n, r));
    return pts;
  }
}

/** Polygon measurements. */
export class Polygon {
  /** @returns {number} signed area (positive for counter-clockwise vertex order). */
  static area(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  /** @returns {boolean} true when p lies inside the polygon (even-odd rule). */
  static contains(p, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i];
      const b = pts[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
        inside = !inside;
    }
    return inside;
  }
}

/** Polyline "bulge" segments (AutoCAD style): bulge = tan(theta / 4) for an arc of angle theta. */
export class Bulge {
  /**
   * The arc a polyline segment a -> b describes for a given bulge.
   * @returns {{c: Point, r: number, a0: number, a1: number, rev: boolean, theta: number}}
   */
  static arc(a, b, bulge) {
    const th = 4 * Math.atan(bulge);
    const L = Vec2.dist(a, b);
    const r = L / (2 * Math.sin(Math.abs(th) / 2));
    const d = L / 2 / Math.tan(th / 2);
    const m = Vec2.mid(a, b);
    const n = Vec2.perp(Vec2.norm(Vec2.sub(b, a)));
    const c = { x: m.x + n.x * d, y: m.y + n.y * d };
    const ccw = bulge > 0;
    return {
      c,
      r,
      a0: ccw ? Vec2.ang(c, a) : Vec2.ang(c, b),
      a1: ccw ? Vec2.ang(c, b) : Vec2.ang(c, a),
      rev: !ccw,
      theta: th,
    };
  }

  /** @returns {Point} the point at parameter t (0..1, by angle) on the segment a -> b with this bulge. */
  static point(a, b, bulge, t) {
    if (!bulge) return Vec2.lerp(a, b, t);
    const ar = Bulge.arc(a, b, bulge);
    const an0 = Vec2.ang(ar.c, a);
    return Vec2.polar(ar.c, an0 + ar.theta * t, ar.r);
  }

  /** @returns {number} the bulge value for a swept angle `theta` (c, r and a0 are not needed). */
  static forAngle(c, r, a0, theta) {
    return Math.tan(theta / 4);
  }
}

/** Rational B-splines (NURBS). */
export class Nurbs {
  /**
   * Samples a rational B-spline into points (de Boor evaluation).
   * @param {Point[]} ctrl control points
   * @param {number} degree curve degree
   * @param {number[]} knots knot vector, length ctrl.length + degree + 1
   * @param {number[]} [weights] one weight per control point (default all 1)
   * @param {number} [perSpan=16] samples per knot span
   * @returns {Point[]} the control polygon itself when the knot vector does not fit
   */
  static sample(ctrl, degree, knots, weights, perSpan = 16) {
    const n = ctrl.length;
    if (!knots || knots.length !== n + degree + 1 || n <= degree)
      return ctrl.map((p) => ({ x: p.x, y: p.y }));
    const w = weights && weights.length === n ? weights : ctrl.map(() => 1);
    const t0 = knots[degree];
    const t1 = knots[n];
    const out = [];
    const spans = Math.max(1, n - degree);
    const steps = Math.max(12, Math.min(4000, spans * perSpan));
    for (let s = 0; s <= steps; s += 1) {
      const t = s === steps ? t1 - 1e-12 : t0 + ((t1 - t0) * s) / steps;
      let k = degree;
      while (k < n - 1 && t >= knots[k + 1]) k += 1;
      const d = [];
      for (let j = 0; j <= degree; j += 1) {
        const i = j + k - degree;
        d.push({ x: ctrl[i].x * w[i], y: ctrl[i].y * w[i], w: w[i] });
      }
      for (let r = 1; r <= degree; r += 1)
        for (let j = degree; j >= r; j -= 1) {
          const den = knots[j + 1 + k - r] - knots[j + k - degree];
          const a = den === 0 ? 0 : (t - knots[j + k - degree]) / den;
          d[j] = {
            x: (1 - a) * d[j - 1].x + a * d[j].x,
            y: (1 - a) * d[j - 1].y + a * d[j].y,
            w: (1 - a) * d[j - 1].w + a * d[j].w,
          };
        }
      out.push({ x: d[degree].x / d[degree].w, y: d[degree].y / d[degree].w });
    }
    return out;
  }
}

/* ============================================================================================
 * 4. COMPATIBILITY EXPORTS
 *    Flat names kept for existing call sites. Each one is just a class method under another name.
 * ========================================================================================== */

// vectors and points
export const pt = Vec2.pt;
export const add = Vec2.add;
export const sub = Vec2.sub;
export const mul = Vec2.mul;
export const dot = Vec2.dot;
export const cross = Vec2.cross;
export const len = Vec2.len;
export const dist = Vec2.dist;
export const norm = Vec2.norm;
export const lerp = Vec2.lerp;
export const mid = Vec2.mid;
export const perp = Vec2.perp;
export const ang = Vec2.ang;
export const polar = Vec2.polar;
export const rotate = Vec2.rotate;
export const eq = Vec2.eq;
export const clone = Vec2.clone;

// angles
export const normAng = Angle.normalize;
export const sweep = Angle.sweep;
export const inArc = Angle.inArc;
export const deg = Angle.deg;
export const rad = Angle.rad;

// matrices
export const M_ID = Mat2D.ID;
export const Mmul = Mat2D.mul;
export const Mtranslate = Mat2D.translate;
export const Mrotate = Mat2D.rotate;
export const Mscale = Mat2D.scale;
export const Mmirror = Mat2D.mirror;
export const Mapply = Mat2D.apply;
export const Mvec = Mat2D.vec;
export const Mdet = Mat2D.det;
export const Mangle = Mat2D.angle;
export const Mscl = Mat2D.scl;
export const isSim = Mat2D.isSimilarity;

// intersections
export const lineLine = Intersect.lineLine;
export const lineCircle = Intersect.lineCircle;
export const circleCircle = Intersect.circleCircle;
export const intersectPrims = Intersect.prims;

// primitives
export const S = Prim.segment;
export const A = Prim.arc;
export const arcPt = Prim.arcPoint;
export const primStart = Prim.start;
export const primEnd = Prim.end;
export const isFull = Prim.isFull;
export const nearestOnPrim = Prim.nearest;
export const segDist = Prim.segDist;
export const arcPoints = Prim.arcPoints;

// polygons, bulges, splines
export const polyArea = Polygon.area;
export const pointInPoly = Polygon.contains;
export const bulgeArc = Bulge.arc;
export const segPoint = Bulge.point;
export const bulgeFor = Bulge.forAngle;
export const nurbsPoints = Nurbs.sample;
