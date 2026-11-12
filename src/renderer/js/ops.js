/**
 * @file ops.js
 * @brief Geometry editing algorithms: trim, extend, offset, fillet, chamfer, break, join,
 *        lengthen, divide / measure, array and hatch boundary detection.
 *
 * Pure functions on entities (no drawing state). They are grouped in classes (PrimMath,
 * PolylineTools, TrimExtend, OffsetTools, CornerTools, BreakJoin, Lengthening, ArrayTools,
 * HatchBoundary) and each is also exported by its short name (`trim`, `offsetEnt`, ...), because
 * the command files call them as `O.trim(...)`.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import * as G from './geom.js';
import * as E from './entities.js';

/* ============================================================================================
 * 2. CONSTANTS AND HELPERS
 * ========================================================================================== */

const { TAU, add, sub, mul, dot, cross, dist, ang, polar, norm, perp, normAng, mid, S, A } = G;

/** The object types TRIM can cut. */
export const TRIMMABLE = new Set(['line', 'arc', 'circle', 'pline']);

/** The object types that can serve as cutting / boundary edges. */
export const EDGE_TYPES = new Set([
  'line',
  'arc',
  'circle',
  'pline',
  'ellipse',
  'spline',
  'xline',
  'ray',
  'insert',
  'leader',
  'donut',
]);

/**
 * A new object of a type that takes over layer, colour, linetype, lineweight and linetype scale
 * of another object.
 */
const mkLike = (src, type, props) => {
  const k = E.mk(type, props);
  k.layer = src.layer;
  k.color = src.color;
  k.ltype = src.ltype;
  k.lw = src.lw;
  k.ltscale = src.ltscale;
  return k;
};

/** A new polyline that takes over the properties of another object. */
const plineLike = (src, pts, closed) => mkLike(src, 'pline', { pts, closed: !!closed });

/* ============================================================================================
 * 3. PRIMMATH
 * ========================================================================================== */

/** Measuring along a primitive. A primitive is a straight piece `{k: 's', a, b}` or an arc `{k: 'a', c, r, a0, a1, rev}`. */
export class PrimMath {
  /** The fraction (0..1) along the primitive's direction of travel at which point p lies. */
  static param(P, p) {
    if (P.k === 's') {
      const v = sub(P.b, P.a);
      const l2 = dot(v, v);
      return l2 < 1e-18 ? 0 : dot(sub(p, P.a), v) / l2;
    }
    const an = ang(P.c, p);
    const sw = G.sweep(P.a0, P.a1) || TAU;
    const d = P.rev ? normAng(P.a1 - an) : normAng(an - P.a0);
    let f = d / sw;
    const full = TAU / sw;
    if (f > 1 + 1e-9 && f > (1 + full) / 2) f -= full;
    return f;
  }

  /** The length of a primitive. */
  static length(P) {
    return P.k === 's' ? dist(P.a, P.b) : P.r * (G.sweep(P.a0, P.a1) || TAU);
  }
}

/* ============================================================================================
 * 4. POLYLINETOOLS
 * ========================================================================================== */

/** Polyline helpers: slicing, corner rounding, reversing, conversion from lines and arcs. */
export class PolylineTools {
  /** @private The bulge of a part (t0..t1) of a polyline segment. */
  static subBulge(b, t0, t1) {
    return Math.tan(Math.atan(b) * (t1 - t0));
  }

  /** The part of a polyline between two positions u0..u1 (u counts segments; closed polylines may wrap). @returns the vertices, or null when too short */
  static slice(e, u0, u1) {
    const n = e.pts.length;
    const m = e.closed ? n : n - 1;
    const seg = (i) => ({
      a: e.pts[((i % n) + n) % n],
      b: e.pts[(((i + 1) % n) + n) % n],
      bulge: e.pts[((i % n) + n) % n].b || 0,
    });
    const i0 = Math.floor(u0 + 1e-9);
    let t0 = u0 - i0;
    if (t0 < 1e-9) t0 = 0;
    const i1 = Math.ceil(u1 - 1e-9) - 1;
    const t1 = u1 - i1;
    const out = [];
    for (let s = i0; s <= i1; s += 1) {
      const sg = seg(s);
      const ta = s === i0 ? t0 : 0;
      const tb = s === i1 ? Math.min(1, t1) : 1;
      if (tb - ta < 1e-9) continue;
      const pa = G.segPoint(sg.a, sg.b, sg.bulge, ta);
      const pb = G.segPoint(sg.a, sg.b, sg.bulge, tb);
      out.push({ x: pa.x, y: pa.y, b: sg.bulge ? PolylineTools.subBulge(sg.bulge, ta, tb) : 0 });
      if (s === i1 || tb < 1) out.push({ x: pb.x, y: pb.y, b: 0 });
      if (s === i1) break;
    }
    void m;
    return out.length >= 2 ? out : null;
  }

  /** Rounds (or chamfers) every straight-straight vertex of a polyline. @returns the new vertices */
  static corners(e, R, chamfer = false, d2 = null) {
    const n = e.pts.length;
    const segB = (i) => e.pts[((i % n) + n) % n].b || 0;
    const out = [];
    const lo = e.closed ? 0 : 1;
    const hi = e.closed ? n : n - 1;
    const isCorner = (i) =>
      i >= lo && i < hi && !segB(i - 1) && !segB(i) && (e.closed || (i > 0 && i < n - 1));
    for (let i = 0; i < n; i += 1) {
      const V = e.pts[i];
      if (!isCorner(i) || R <= 0) {
        out.push({ x: V.x, y: V.y, b: V.b || 0 });
        continue;
      }
      const P = e.pts[(i - 1 + n) % n];
      const N = e.pts[(i + 1) % n];
      const u1 = norm(sub(P, V));
      const u2 = norm(sub(N, V));
      const phi = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
      if (phi < 1e-6 || Math.abs(phi - Math.PI) < 1e-6) {
        out.push({ x: V.x, y: V.y, b: V.b || 0 });
        continue;
      }
      const t1 = chamfer ? R : R / Math.tan(phi / 2);
      const t2 = chamfer ? (d2 ?? R) : t1;
      if (t1 > dist(P, V) + 1e-9 || t2 > dist(N, V) + 1e-9) {
        out.push({ x: V.x, y: V.y, b: V.b || 0 });
        continue;
      }
      const T1 = add(V, mul(u1, t1));
      const T2 = add(V, mul(u2, t2));
      const turn = cross(sub(V, P), sub(N, V)) > 0 ? 1 : -1;
      out.push({ x: T1.x, y: T1.y, b: chamfer ? 0 : turn * Math.tan((Math.PI - phi) / 4) });
      out.push({ x: T2.x, y: T2.y, b: V.b || 0 });
    }
    return out;
  }

  /** @returns the end point of a line that is nearest to `click` */
  static nearestEnd(e, click) {
    const pts = [];
    if (e.type === 'line') pts.push(e.p1, e.p2);
    return pts.sort((a, b) => dist(a, click) - dist(b, click))[0];
  }

  /** Reverses the direction of a polyline (changes the object). */
  static reverse(e) {
    const n = e.pts.length;
    const pts = e.pts.map((p) => ({ ...p }));
    const out = [];
    for (let i = n - 1; i >= 0; i -= 1) {
      const prev = e.closed ? pts[(i - 1 + n) % n] : pts[i - 1];
      out.push({ x: pts[i].x, y: pts[i].y, b: prev ? -(prev.b || 0) : 0 });
    }
    e.pts = out;
  }

  /** A line as a polyline. */
  static lineToPline(e) {
    return mkLike(e, 'pline', {
      pts: [
        { x: e.p1.x, y: e.p1.y, b: 0 },
        { x: e.p2.x, y: e.p2.y, b: 0 },
      ],
      closed: false,
    });
  }

  /** An arc as a polyline with one bulge segment. */
  static arcToPline(e) {
    const th = G.sweep(e.a0, e.a1);
    return mkLike(e, 'pline', {
      pts: [
        { ...G.arcPt(e, e.a0), b: Math.tan(th / 4) },
        { ...G.arcPt(e, e.a1), b: 0 },
      ],
      closed: false,
    });
  }
}

/* ============================================================================================
 * 5. TRIMEXTEND
 * ========================================================================================== */

/** TRIM and EXTEND. */
export class TrimExtend {
  /** @private Where the primitive P is crossed by the edges: [{p, t}]. */
  static cutParams(P, edges, ext = false) {
    const ts = [];
    for (const Q of edges) {
      if (Q.e === P.e && P.e.type !== 'pline') continue;
      if (Q === P) continue;
      for (const h of G.intersectPrims(P, Q, ext, false))
        ts.push({ p: h, t: PrimMath.param(P, h) });
    }
    return ts;
  }

  /** TRIM: what is left of an object when the part at `click` is cut away at the edges. @returns the remaining pieces, or null when nothing can be trimmed */
  static trim(e, click, edges, doc) {
    if (!TRIMMABLE.has(e.type)) return null;
    const mine = E.prims(e, doc);
    if (e.type === 'line') {
      const P = mine[0];
      const ts = TrimExtend.cutParams(P, edges)
        .map((c) => c.t)
        .filter((t) => t > 1e-9 && t < 1 - 1e-9);
      if (!ts.length) return null;
      const tp = Math.max(0, Math.min(1, PrimMath.param(P, click)));
      const lo = Math.max(0, ...ts.filter((t) => t <= tp + 1e-12));
      const hi = Math.min(1, ...ts.filter((t) => t > tp + 1e-12), 1);
      const out = [];
      if (lo > 1e-9) out.push(mkLike(e, 'line', { p1: e.p1, p2: G.lerp(e.p1, e.p2, lo) }));
      if (hi < 1 - 1e-9) out.push(mkLike(e, 'line', { p1: G.lerp(e.p1, e.p2, hi), p2: e.p2 }));
      return out;
    }
    if (e.type === 'arc') {
      const P = mine[0];
      const sw = G.sweep(e.a0, e.a1);
      const ts = TrimExtend.cutParams(P, edges)
        .map((c) => c.t)
        .filter((t) => t > 1e-9 && t < 1 - 1e-9);
      if (!ts.length) return null;
      const tp = Math.max(0, Math.min(1, PrimMath.param(P, click)));
      const lo = Math.max(0, ...ts.filter((t) => t <= tp));
      const hi = Math.min(1, ...ts.filter((t) => t > tp), 1);
      const out = [];
      if (lo > 1e-9) out.push(mkLike(e, 'arc', { c: e.c, r: e.r, a0: e.a0, a1: e.a0 + sw * lo }));
      if (hi < 1 - 1e-9)
        out.push(mkLike(e, 'arc', { c: e.c, r: e.r, a0: e.a0 + sw * hi, a1: e.a1 }));
      return out;
    }
    if (e.type === 'circle') {
      const P = mine[0];
      const ts = [];
      for (const Q of edges) {
        if (Q.e === e) continue;
        for (const h of G.intersectPrims(P, Q, false, false)) ts.push(normAng(ang(e.c, h)));
      }
      const u = [...new Set(ts.map((t) => t.toFixed(9)))].map(Number).sort((a, b) => a - b);
      if (u.length < 2) return null;
      const ca = normAng(ang(e.c, click));
      const hi = u.find((t) => t > ca) ?? u[0];
      const lo = [...u].reverse().find((t) => t <= ca) ?? u[u.length - 1];
      return [mkLike(e, 'arc', { c: e.c, r: e.r, a0: hi, a1: hi + normAng(lo - hi) })];
    }
    if (e.type === 'pline') {
      const n = e.pts.length;
      const m = e.closed ? n : n - 1;
      const cuts = [];
      mine.forEach((P) => {
        for (const h of TrimExtend.cutParams(P, edges)) {
          const t = PrimMath.param(P, h.p);
          if (t > -1e-9 && t < 1 + 1e-9) cuts.push(P.i + Math.max(0, Math.min(1, t)));
        }
      });
      const cs = [...new Set(cuts.map((c) => (e.closed && c >= m - 1e-9 ? 0 : c).toFixed(9)))]
        .map(Number)
        .sort((a, b) => a - b)
        .filter((c) => e.closed || !(Math.abs(c) < 1e-9 || Math.abs(c - m) < 1e-9));
      if (!cs.length) return null;
      let best = null;
      mine.forEach((P) => {
        const q = G.nearestOnPrim(P, click);
        if (!best || q.d < best.d)
          best = { d: q.d, u: P.i + Math.max(0, Math.min(1, PrimMath.param(P, q.p))) };
      });
      const up = best.u;
      if (e.closed) {
        if (cs.length < 2) return null;
        const hiV = cs.find((c) => c > up);
        const loV = [...cs].reverse().find((c) => c <= up);
        const pts =
          hiV !== undefined && loV !== undefined
            ? PolylineTools.slice(e, hiV, loV + m)
            : PolylineTools.slice(e, cs[0], cs[cs.length - 1]);
        return pts ? [plineLike(e, pts, false)] : [];
      }
      const lo = Math.max(0, ...cs.filter((c) => c <= up));
      const hi = Math.min(m, ...cs.filter((c) => c > up), m);
      const out = [];
      if (lo > 1e-9) {
        const p = PolylineTools.slice(e, 0, lo);
        if (p) out.push(plineLike(e, p, false));
      }
      if (hi < m - 1e-9) {
        const p = PolylineTools.slice(e, hi, m);
        if (p) out.push(plineLike(e, p, false));
      }
      return out;
    }
    return null;
  }

  /** EXTEND: extends the end of an object nearest to `click` to the next edge. Changes the object. @returns true when it changed */
  static extend(e, click, edges, doc) {
    if (e.type === 'line') {
      const P = E.prims(e, doc)[0];
      const tc = PrimMath.param(P, click);
      const atEnd = tc > 0.5;
      let best = null;
      for (const Q of edges) {
        if (Q.e === e) continue;
        for (const h of G.intersectPrims(P, Q, true, false)) {
          const t = PrimMath.param(P, h);
          if (atEnd ? t > 1 + 1e-9 : t < -1e-9) {
            const d = Math.abs(atEnd ? t - 1 : t);
            if (!best || d < best.d) best = { d, h };
          }
        }
      }
      if (!best) return false;
      if (atEnd) e.p2 = best.h;
      else e.p1 = best.h;
      return true;
    }
    if (e.type === 'arc') {
      const P = E.prims(e, doc)[0];
      const ca = normAng(ang(e.c, click));
      const sw = G.sweep(e.a0, e.a1);
      const atEnd =
        normAng(ca - e.a0) > sw / 2 + ((TAU - sw) / 2) * 0 && normAng(ca - e.a0) <= sw
          ? normAng(ca - e.a0) > sw / 2
          : normAng(e.a0 - ca) > normAng(ca - e.a1);
      let best = null;
      for (const Q of edges) {
        if (Q.e === e) continue;
        for (const h of G.intersectPrims({ ...P, a0: 0, a1: TAU }, Q, false, false)) {
          const an = ang(e.c, h);
          const d = atEnd ? normAng(an - e.a1) : normAng(e.a0 - an);
          if (d > 1e-9 && (!best || d < best.d)) best = { d, an };
        }
      }
      if (!best) return false;
      if (atEnd) e.a1 = e.a1 + best.d;
      else e.a0 = e.a0 - best.d;
      return true;
    }
    if (e.type === 'pline' && !e.closed) {
      const segs = E.plineSegs(e);
      const prims = E.prims(e, doc);
      let best = null;
      for (const which of [0, 1]) {
        const i = which ? segs.length - 1 : 0;
        const s = segs[i];
        const P = prims[i];
        if (s.bulge) continue;
        const end = which ? s.b : s.a;
        for (const Q of edges) {
          if (Q.e === e) continue;
          for (const h of G.intersectPrims(P, Q, true, false)) {
            const t = PrimMath.param(P, h);
            if (which ? t > 1 + 1e-9 : t < -1e-9) {
              const d = dist(h, end);
              const dc = dist(end, click);
              const score = dc;
              if (!best || score < best.score || (score === best.score && d < best.d))
                best = { score, d, h, which, i };
            }
          }
        }
      }
      if (!best) return false;
      const target = best.which ? e.pts[e.pts.length - 1] : e.pts[0];
      target.x = best.h.x;
      target.y = best.h.y;
      return true;
    }
    return false;
  }
}

/* ============================================================================================
 * 6. OFFSETTOOLS
 * ========================================================================================== */

/** OFFSET. */
export class OffsetTools {
  /** @private Which side of a primitive a point is on (1 = left / outside). */
  static sideOfPrim(P, p) {
    if (P.k === 's') return cross(sub(P.b, P.a), sub(p, P.a)) >= 0 ? 1 : -1;
    return dist(p, P.c) >= P.r ? 1 : -1; // 1 = outside
  }

  /** OFFSET: a copy of an object at distance d, on the side where `side` is. @returns the new object, or null */
  static offsetEnt(e, d, side, doc) {
    switch (e.type) {
      case 'line': {
        const n = perp(norm(sub(e.p2, e.p1)));
        const s = cross(sub(e.p2, e.p1), sub(side, e.p1)) >= 0 ? 1 : -1;
        const v = mul(n, d * s);
        return mkLike(e, 'line', { p1: add(e.p1, v), p2: add(e.p2, v) });
      }
      case 'xline':
      case 'ray': {
        const n = perp(e.dir);
        const s = dot(sub(side, e.p), n) >= 0 ? 1 : -1;
        return mkLike(e, e.type, { p: add(e.p, mul(n, d * s)), dir: e.dir });
      }
      case 'circle': {
        const r = dist(side, e.c) > e.r ? e.r + d : e.r - d;
        return r > 1e-9 ? mkLike(e, 'circle', { c: e.c, r }) : null;
      }
      case 'arc': {
        const r = dist(side, e.c) > e.r ? e.r + d : e.r - d;
        return r > 1e-9 ? mkLike(e, 'arc', { c: e.c, r: r, a0: e.a0, a1: e.a1 }) : null;
      }
      case 'pline':
        return OffsetTools.offsetPline(e, d, side, doc);
      default:
        return null;
    }
  }

  /** OFFSET with a signed distance: d > 0 offsets to the left of the travel direction, d < 0 to the right. */
  static offsetSigned(e, d, doc) {
    // d > 0 offsets to the left of the travel direction, d < 0 to the right
    const prims = E.prims(e, doc);
    const P = prims[0];
    if (!P) return null;
    const a = G.primStart(P);
    const b = P.k === 's' ? P.b : G.arcPt(P, P.rev ? P.a0 : P.a1);
    const m = G.mid(a, b);
    const nrm = perp(norm(sub(b, a)));
    const side = add(m, mul(nrm, Math.sign(d) * Math.max(Math.abs(d), 1e-6)));
    return OffsetTools.offsetEnt(e, Math.abs(d), side, doc);
  }

  /** @private OFFSET of a polyline (arcs and joins are recomputed). */
  static offsetPline(e, d, side, doc) {
    const segs = E.plineSegs(e);
    const prims = E.prims(e, doc);
    if (!segs.length) return null;
    let bestD = Infinity;
    let sgn = 1;
    prims.forEach((P) => {
      const q = G.nearestOnPrim(P, side);
      if (q.d < bestD) {
        bestD = q.d;
        sgn =
          P.k === 's'
            ? OffsetTools.sideOfPrim(P, side)
            : (P.rev ? -1 : 1) * (dist(side, P.c) > P.r ? -1 : 1);
      }
    });
    // sgn: +1 = offset to the left of travel direction
    const off = segs.map((s, i) => {
      const P = prims[i];
      if (P.k === 's') {
        const n = mul(perp(norm(sub(s.b, s.a))), d * sgn);
        return { k: 's', a: add(s.a, n), b: add(s.b, n) };
      }
      // left of travel: CCW travel -> inside (smaller radius)
      const ccw = !P.rev;
      const r = ccw ? (sgn > 0 ? P.r - d : P.r + d) : sgn > 0 ? P.r + d : P.r - d;
      if (r <= 1e-9) return null;
      const a0 = P.a0;
      const a1 = P.a1;
      return {
        k: 'a',
        c: P.c,
        r,
        a0,
        a1,
        rev: P.rev,
        a: polar(P.c, ccw ? a0 : a1, r),
        b: polar(P.c, ccw ? a1 : a0, r),
      };
    });
    if (off.some((o) => !o)) return null;
    const n = off.length;
    const verts = [];
    const join = (o1, o2, orig) => {
      const A1 = o1.k === 's' ? S(o1.a, o1.b) : A(o1.c, o1.r, o1.a0, o1.a1, { rev: o1.rev });
      const B1 = o2.k === 's' ? S(o2.a, o2.b) : A(o2.c, o2.r, o2.a0, o2.a1, { rev: o2.rev });
      const hits = G.intersectPrims(A1, B1, true, true);
      if (!hits.length) return null;
      let best = hits[0];
      let bd = dist(hits[0], orig);
      for (const h of hits) {
        const dd = dist(h, orig);
        if (dd < bd) {
          bd = dd;
          best = h;
        }
      }
      return best;
    };
    const cnt = e.closed ? n : n - 1;
    const jp = [];
    for (let i = 0; i < cnt; i += 1) {
      const o1 = off[i];
      const o2 = off[(i + 1) % n];
      jp.push(join(o1, o2, segs[i].b) || (o1.b && o2.a ? mid(o1.b, o2.a) : o1.b));
    }
    const startPt = e.closed ? jp[n - 1] : off[0].a;
    const endPt = e.closed ? null : off[n - 1].b;
    const pts = [];
    for (let i = 0; i < n; i += 1) {
      const o = off[i];
      const a = i === 0 ? startPt : jp[i - 1];
      const b = e.closed ? jp[i] : i === n - 1 ? endPt : jp[i];
      let bulge = 0;
      if (o.k === 'a') {
        const ccw = !o.rev;
        const a1 = ang(o.c, a);
        const a2 = ang(o.c, b);
        const th = ccw ? G.sweep(a1, a2) : -G.sweep(a2, a1);
        bulge = Math.tan((Math.abs(th) > TAU - 1e-9 ? 0 : th) / 4);
      }
      pts.push({ x: a.x, y: a.y, b: bulge });
    }
    if (!e.closed) pts.push({ x: endPt.x, y: endPt.y, b: 0 });
    verts.push(...pts);
    return plineLike(e, verts, e.closed);
  }
}

/* ============================================================================================
 * 7. CORNERTOOLS
 * ========================================================================================== */

/** FILLET, CHAMFER and CIRCLE Ttr. */
export class CornerTools {
  /** @private A line, arc or circle as a primitive (null for other objects). */
  static curveOf(e) {
    if (e.type === 'line') return { k: 's', a: e.p1, b: e.p2 };
    if (e.type === 'arc') return { k: 'a', c: e.c, r: e.r, a0: e.a0, a1: e.a1 };
    if (e.type === 'circle') return { k: 'a', c: e.c, r: e.r, a0: 0, a1: TAU };
    return null;
  }

  /** @private The two parallel curves of a primitive at distance R. */
  static offsetCurves(C, R) {
    if (C.k === 's') {
      const n = mul(perp(norm(sub(C.b, C.a))), R);
      return [
        { k: 's', a: add(C.a, n), b: add(C.b, n) },
        { k: 's', a: sub(C.a, n), b: sub(C.b, n) },
      ];
    }
    const out = [{ k: 'a', c: C.c, r: C.r + R, a0: 0, a1: TAU }];
    if (C.r - R > 1e-9) out.push({ k: 'a', c: C.c, r: C.r - R, a0: 0, a1: TAU });
    return out;
  }

  /** @private The point where a circle with the centre `center` touches the primitive C. */
  static tanPoint(C, center) {
    if (C.k === 's')
      return G.nearestOnPrim(
        { k: 's', a: add(C.a, mul(sub(C.a, C.b), 1e6)), b: add(C.b, mul(sub(C.b, C.a), 1e6)) },
        center,
      ).p;
    const d = norm(sub(center, C.c));
    return add(C.c, mul(d, C.r));
  }

  /** @private Shortens a line or arc so that it ends at the point T (the side of `click` is kept). */
  static trimToTangent(e, T, click) {
    if (e.type === 'line') {
      const keepA = dot(sub(e.p1, T), sub(click, T)) >= 0 ? true : false;
      const keepB = dot(sub(e.p2, T), sub(click, T)) >= 0 ? true : false;
      if (keepB && !keepA) e.p1 = T;
      else if (keepA && !keepB) e.p2 = T;
      else if (dist(e.p1, click) < dist(e.p2, click)) e.p2 = T;
      else e.p1 = T;
    } else if (e.type === 'arc') {
      const at = ang(e.c, T);
      const ca = ang(e.c, click);
      if (G.inArc(ca, at, e.a1)) e.a0 = at;
      else e.a1 = at;
      if (e.a1 <= e.a0) e.a1 += TAU;
    }
  }

  /** FILLET of two lines / arcs / circles with radius R. @returns {{ok, arc?}|{error}} */
  static fillet(e1, c1, e2, c2, R, trim = true) {
    const C1 = CornerTools.curveOf(e1);
    const C2 = CornerTools.curveOf(e2);
    if (!C1 || !C2) return { error: 'Select lines, arcs or circles' };
    if (R <= 0) {
      // corner: extend / trim both to intersection
      const hits = G.intersectPrims(C1, C2, true, true);
      if (!hits.length) return { error: 'Lines are parallel' };
      const X = hits.reduce(
        (b, h) => (dist(h, c1) + dist(h, c2) < dist(b, c1) + dist(b, c2) ? h : b),
        hits[0],
      );
      if (trim) {
        CornerTools.trimToTangent(e1, X, c1);
        CornerTools.trimToTangent(e2, X, c2);
      }
      return { ok: true };
    }
    let best = null;
    for (const o1 of CornerTools.offsetCurves(C1, R))
      for (const o2 of CornerTools.offsetCurves(C2, R)) {
        for (const ctr of G.intersectPrims(o1, o2, true, true)) {
          const T1 = CornerTools.tanPoint(C1, ctr);
          const T2 = CornerTools.tanPoint(C2, ctr);
          const score = dist(T1, c1) + dist(T2, c2);
          if (!best || score < best.score) best = { score, ctr, T1, T2 };
        }
      }
    if (!best) return { error: 'Fillet radius too large or lines parallel' };
    if (trim && e1.type !== 'circle') CornerTools.trimToTangent(e1, best.T1, c1);
    if (trim && e2.type !== 'circle') CornerTools.trimToTangent(e2, best.T2, c2);
    const a1 = ang(best.ctr, best.T1);
    const a2 = ang(best.ctr, best.T2);
    const arc =
      G.sweep(a1, a2) <= Math.PI
        ? mkLike(e1, 'arc', { c: best.ctr, r: R, a0: a1, a1: a2 })
        : mkLike(e1, 'arc', { c: best.ctr, r: R, a0: a2, a1: a1 });
    return { ok: true, arc };
  }

  /** CIRCLE Ttr: the centre of the circle with radius R that touches two objects (null when none). */
  static ttrCircle(e1, c1, e2, c2, R) {
    const C1 = CornerTools.curveOf(e1);
    const C2 = CornerTools.curveOf(e2);
    if (!C1 || !C2) return null;
    let best = null;
    for (const o1 of CornerTools.offsetCurves(C1, R))
      for (const o2 of CornerTools.offsetCurves(C2, R)) {
        for (const ctr of G.intersectPrims(o1, o2, true, true)) {
          const score =
            dist(CornerTools.tanPoint(C1, ctr), c1) + dist(CornerTools.tanPoint(C2, ctr), c2);
          if (!best || score < best.score) best = { score, ctr };
        }
      }
    return best ? best.ctr : null;
  }

  /** CHAMFER of two lines with the distances d1 and d2. @returns {{ok, line?}|{error}} */
  static chamfer(e1, c1, e2, c2, d1, d2, trim = true) {
    if (e1.type !== 'line' || e2.type !== 'line') return { error: 'Chamfer works on lines' };
    const r = G.lineLine(e1.p1, e1.p2, e2.p1, e2.p2);
    if (!r) return { error: 'Lines are parallel' };
    const X = r.p;
    const u1 = norm(mul(sub(e1.p2, e1.p1), dot(sub(c1, X), sub(e1.p2, e1.p1)) >= 0 ? 1 : -1));
    const u2 = norm(mul(sub(e2.p2, e2.p1), dot(sub(c2, X), sub(e2.p2, e2.p1)) >= 0 ? 1 : -1));
    const T1 = add(X, mul(u1, d1));
    const T2 = add(X, mul(u2, d2));
    if (trim) {
      CornerTools.trimToTangent(e1, T1, c1);
      CornerTools.trimToTangent(e2, T2, c2);
    }
    return { ok: true, line: d1 > 0 || d2 > 0 ? mkLike(e1, 'line', { p1: T1, p2: T2 }) : null };
  }
}

/* ============================================================================================
 * 8. BREAKJOIN
 * ========================================================================================== */

/** BREAK and JOIN. */
export class BreakJoin {
  /** BREAK: what is left of an object when the part between p1 and p2 is removed. @returns the pieces, or null */
  static breakEnt(e, p1, p2, doc) {
    if (e.type === 'line') {
      const P = E.prims(e, doc)[0];
      let t1 = Math.max(0, Math.min(1, PrimMath.param(P, p1)));
      let t2 = Math.max(0, Math.min(1, PrimMath.param(P, p2)));
      if (t1 > t2) [t1, t2] = [t2, t1];
      const out = [];
      if (t1 > 1e-9) out.push(mkLike(e, 'line', { p1: e.p1, p2: G.lerp(e.p1, e.p2, t1) }));
      if (t2 < 1 - 1e-9) out.push(mkLike(e, 'line', { p1: G.lerp(e.p1, e.p2, t2), p2: e.p2 }));
      return out;
    }
    if (e.type === 'arc') {
      const sw = G.sweep(e.a0, e.a1);
      const f = (p) => Math.max(0, Math.min(1, normAng(ang(e.c, p) - e.a0) / sw));
      let t1 = f(p1);
      let t2 = f(p2);
      if (t1 > t2) [t1, t2] = [t2, t1];
      const out = [];
      if (t1 > 1e-9) out.push(mkLike(e, 'arc', { c: e.c, r: e.r, a0: e.a0, a1: e.a0 + sw * t1 }));
      if (t2 < 1 - 1e-9)
        out.push(mkLike(e, 'arc', { c: e.c, r: e.r, a0: e.a0 + sw * t2, a1: e.a1 }));
      return out;
    }
    if (e.type === 'circle') {
      const a = ang(e.c, p1);
      const b = ang(e.c, p2);
      if (Math.abs(normAng(a - b)) < 1e-9) return null;
      return [mkLike(e, 'arc', { c: e.c, r: e.r, a0: b, a1: b + normAng(a - b) })];
    }
    if (e.type === 'pline') {
      const prims = E.prims(e, doc);
      const m = prims.length;
      const u = (p) => {
        let best = null;
        prims.forEach((P) => {
          const q = G.nearestOnPrim(P, p);
          if (!best || q.d < best.d)
            best = { d: q.d, u: P.i + Math.max(0, Math.min(1, PrimMath.param(P, q.p))) };
        });
        return best.u;
      };
      let u1 = u(p1);
      let u2 = u(p2);
      if (u1 > u2) [u1, u2] = [u2, u1];
      if (e.closed) {
        const pts = PolylineTools.slice(e, u2, u1 + m);
        return pts ? [plineLike(e, pts, false)] : [];
      }
      const out = [];
      if (u1 > 1e-9) {
        const p = PolylineTools.slice(e, 0, u1);
        if (p) out.push(plineLike(e, p, false));
      }
      if (u2 < m - 1e-9) {
        const p = PolylineTools.slice(e, u2, m);
        if (p) out.push(plineLike(e, p, false));
      }
      return out;
    }
    return null;
  }

  /** JOIN: joins lines, arcs and polylines that touch (collinear lines become one line, arcs of one circle one arc, the rest polylines). @returns the new objects */
  static joinEnts(list, tol = 1e-5) {
    // convert to travel segments
    const pieces = [];
    for (const e of list) {
      if (e.type === 'line') pieces.push({ e, pts: [e.p1, e.p2], b: [0] });
      else if (e.type === 'arc') {
        const p0 = G.arcPt(e, e.a0);
        const p1 = G.arcPt(e, e.a1);
        const th = G.sweep(e.a0, e.a1);
        pieces.push({ e, pts: [p0, p1], b: [Math.tan(th / 4)] });
      } else if (e.type === 'pline' && !e.closed)
        pieces.push({
          e,
          pts: e.pts.map((p) => ({ x: p.x, y: p.y })),
          b: e.pts.slice(0, -1).map((p) => p.b || 0),
        });
    }
    if (!pieces.length) return [];
    // special case: collinear lines -> one line
    const lines = pieces.filter((p) => p.e.type === 'line');
    if (lines.length === pieces.length && lines.length > 1) {
      const d = norm(sub(lines[0].e.p2, lines[0].e.p1));
      if (
        lines.every(
          (p) =>
            Math.abs(cross(d, sub(p.e.p1, lines[0].e.p1))) < tol &&
            Math.abs(cross(d, sub(p.e.p2, lines[0].e.p1))) < tol,
        )
      ) {
        const ts = lines
          .flatMap((p) => [p.e.p1, p.e.p2].map((q) => dot(sub(q, lines[0].e.p1), d)))
          .sort((a, b) => a - b);
        return [
          mkLike(lines[0].e, 'line', {
            p1: add(lines[0].e.p1, mul(d, ts[0])),
            p2: add(lines[0].e.p1, mul(d, ts[ts.length - 1])),
          }),
        ];
      }
    }
    // same-circle arcs -> one arc
    const arcs = pieces.filter((p) => p.e.type === 'arc');
    if (
      arcs.length === pieces.length &&
      arcs.length > 1 &&
      arcs.every((p) => dist(p.e.c, arcs[0].e.c) < tol && Math.abs(p.e.r - arcs[0].e.r) < tol)
    ) {
      // chain by angle
      const cur = arcs[0].e;
      let a0 = cur.a0;
      let sw = G.sweep(cur.a0, cur.a1);
      const rest = arcs.slice(1).map((p) => p.e);
      let progress = true;
      while (rest.length && progress) {
        progress = false;
        for (let i = 0; i < rest.length; i += 1) {
          const r = rest[i];
          if (Math.abs(normAng(r.a0 - (a0 + sw))) < 1e-7) {
            sw += G.sweep(r.a0, r.a1);
            rest.splice(i, 1);
            progress = true;
            break;
          }
          if (Math.abs(normAng(a0 - r.a1)) < 1e-7) {
            a0 = r.a0;
            sw += G.sweep(r.a0, r.a1);
            rest.splice(i, 1);
            progress = true;
            break;
          }
        }
      }
      if (!rest.length)
        return sw >= TAU - 1e-7
          ? [mkLike(cur, 'circle', { c: cur.c, r: cur.r })]
          : [mkLike(cur, 'arc', { c: cur.c, r: cur.r, a0, a1: a0 + sw })];
    }
    // chain into polylines
    const used = new Array(pieces.length).fill(false);
    const out = [];
    for (let s = 0; s < pieces.length; s += 1) {
      if (used[s]) continue;
      used[s] = true;
      let pts = pieces[s].pts.map((p, i) => ({ x: p.x, y: p.y, b: pieces[s].b[i] || 0 }));
      let grew = true;
      while (grew) {
        grew = false;
        for (let j = 0; j < pieces.length; j += 1) {
          if (used[j]) continue;
          const q = pieces[j];
          const qp = q.pts;
          const last = pts[pts.length - 1];
          const first = pts[0];
          if (dist(last, qp[0]) < tol) {
            pts[pts.length - 1].b = q.b[0] || 0;
            for (let k = 1; k < qp.length; k += 1)
              pts.push({ x: qp[k].x, y: qp[k].y, b: q.b[k] || 0 });
          } else if (dist(last, qp[qp.length - 1]) < tol) {
            pts[pts.length - 1].b = -(q.b[q.b.length - 1] || 0);
            for (let k = qp.length - 2; k >= 0; k -= 1)
              pts.push({ x: qp[k].x, y: qp[k].y, b: k > 0 ? -(q.b[k - 1] || 0) : 0 });
          } else if (dist(first, qp[qp.length - 1]) < tol) {
            const nw = qp.slice(0, -1).map((p, k) => ({ x: p.x, y: p.y, b: q.b[k] || 0 }));
            nw.push({ x: first.x, y: first.y, b: first.b });
            pts = nw.concat(pts.slice(1));
          } else if (dist(first, qp[0]) < tol) {
            const nw = [];
            for (let k = qp.length - 1; k > 0; k -= 1)
              nw.push({ x: qp[k].x, y: qp[k].y, b: -(q.b[k - 1] || 0) });
            nw.push({ x: first.x, y: first.y, b: first.b });
            pts = nw.concat(pts.slice(1));
          } else continue;
          used[j] = true;
          grew = true;
        }
      }
      let closed = false;
      if (pts.length > 2 && dist(pts[0], pts[pts.length - 1]) < tol) {
        closed = true;
        pts.pop();
      }
      out.push(plineLike(pieces[s].e, pts, closed));
    }
    return out;
  }
}

/* ============================================================================================
 * 9. LENGTHENING
 * ========================================================================================== */

/** LENGTHEN, DIVIDE and MEASURE. */
export class Lengthening {
  /** LENGTHEN: changes the length of a line or arc by delta / total / percent. Changes the object. @returns true when it changed */
  static lengthen(e, mode, value, click) {
    const cur = E.entLength(e);
    let delta = 0;
    if (mode === 'delta') delta = value;
    else if (mode === 'total') delta = value - cur;
    else if (mode === 'percent') delta = (cur * value) / 100 - cur;
    if (e.type === 'line') {
      const d = norm(sub(e.p2, e.p1));
      const atEnd = dist(click, e.p2) < dist(click, e.p1);
      if (cur + delta <= 0) return false;
      if (atEnd) e.p2 = add(e.p2, mul(d, delta));
      else e.p1 = sub(e.p1, mul(d, delta));
      return true;
    }
    if (e.type === 'arc') {
      const dA = delta / e.r;
      const atEnd = normAng(ang(e.c, click) - e.a0) > G.sweep(e.a0, e.a1) / 2;
      if (G.sweep(e.a0, e.a1) + dA <= 0) return false;
      if (atEnd) e.a1 += dA;
      else e.a0 -= dA;
      return true;
    }
    return false;
  }

  /** DIVIDE / MEASURE: points along an object, `count` equal parts or every `spacing` units. */
  static pointsAlong(e, doc, spacing, count) {
    const prims = E.prims(e, doc);
    if (!prims.length) return [];
    const ordered = prims;
    const lens = ordered.map(PrimMath.length);
    const total = lens.reduce((a, b) => a + b, 0);
    const closed = E.isClosed(e);
    const at = (L) => {
      let acc = 0;
      for (let i = 0; i < ordered.length; i += 1) {
        if (L <= acc + lens[i] + 1e-9) {
          const f = lens[i] ? Math.max(0, Math.min(1, (L - acc) / lens[i])) : 0;
          const P = ordered[i];
          if (P.k === 's') return G.lerp(P.a, P.b, f);
          const sw = G.sweep(P.a0, P.a1) || TAU;
          return polar(P.c, P.rev ? P.a1 - sw * f : P.a0 + sw * f, P.r);
        }
        acc += lens[i];
      }
      return E.isClosed(e) ? E.prims(e, doc)[0].a : null;
    };
    const pts = [];
    if (count) {
      const n = count;
      for (let k = closed ? 0 : 1; k < n; k += 1) {
        const p = at((total * k) / n);
        if (p) pts.push(p);
      }
    } else if (spacing > 0)
      for (let L = spacing; L <= total + 1e-9 && pts.length < 100000; L += spacing) {
        const p = at(L);
        if (p) pts.push(p);
      }
    return pts;
  }
}

/* ============================================================================================
 * 10. ARRAYTOOLS
 * ========================================================================================== */

/** ARRAY. */
export class ArrayTools {
  /** ARRAY (rectangular): the copies of ents, not counting the originals. */
  static rect(ents, rows, cols, dy, dx, angle, doc) {
    const out = [];
    const u = { x: Math.cos(angle), y: Math.sin(angle) };
    const v = perp(u);
    for (let r = 0; r < rows; r += 1)
      for (let c = 0; c < cols; c += 1) {
        if (!r && !c) continue;
        const off = add(mul(u, dx * c), mul(v, dy * r));
        for (const e of ents) out.push(E.copyXform(e, G.Mtranslate(off.x, off.y), doc));
      }
    return out;
  }

  /** ARRAY (polar): the copies of ents around a centre, not counting the originals. */
  static polar(ents, center, count, fill, rotateItems, doc) {
    const out = [];
    const step =
      Math.abs(fill - TAU) < 1e-9 || Math.abs(fill + TAU) < 1e-9
        ? fill / count
        : fill / (count - 1);
    for (let i = 1; i < count; i += 1) {
      const M = G.Mrotate(step * i, center);
      for (const e of ents) {
        if (rotateItems) out.push(E.copyXform(e, M, doc));
        else {
          const b = E.bbox(e, doc) || { x0: 0, y0: 0, x1: 0, y1: 0 };
          const bc = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
          const nb = G.Mapply(M, bc);
          out.push(E.copyXform(e, G.Mtranslate(nb.x - bc.x, nb.y - bc.y), doc));
        }
      }
    }
    return out;
  }
}

/* ============================================================================================
 * 11. HATCHBOUNDARY
 * ========================================================================================== */

/** HATCH boundary detection: finds the closed area around a point from the lines that cross. */
export class HatchBoundary {
  /** HATCH: finds the closed boundary around the point p (and the islands inside it). @returns the loops, or null */
  static findBoundary(ents, doc, p) {
    const segs = [];
    const islands = [];
    for (const e of ents) {
      if (e.type === 'xline' || e.type === 'ray' || e.type === 'viewport') continue;
      if (
        !['line', 'circle', 'arc', 'pline', 'ellipse', 'spline', 'donut', 'insert'].includes(e.type)
      )
        continue;
      for (const P of E.prims(e, doc)) {
        if (P.k === 's') segs.push([P.a, P.b]);
        else {
          const pts = G.arcPoints(P.c, P.r, P.a0, P.a1, Math.max(P.r / 500, 1e-6));
          for (let i = 0; i + 1 < pts.length; i += 1) segs.push([pts[i], pts[i + 1]]);
        }
      }
      if (E.isClosed(e)) {
        const l = E.closedLoop(e);
        if (l) islands.push(l);
      }
    }
    if (!segs.length || segs.length > 6000) return null;
    // split at intersections (sweep & prune)
    const order = segs
      .map((s, i) => ({
        i,
        x0: Math.min(s[0].x, s[1].x),
        x1: Math.max(s[0].x, s[1].x),
        y0: Math.min(s[0].y, s[1].y),
        y1: Math.max(s[0].y, s[1].y),
      }))
      .sort((a, b) => a.x0 - b.x0);
    const cuts = segs.map(() => [0, 1]);
    for (let ii = 0; ii < order.length; ii += 1) {
      const a = order[ii];
      for (let jj = ii + 1; jj < order.length; jj += 1) {
        const b = order[jj];
        if (b.x0 > a.x1 + 1e-9) break;
        if (b.y0 > a.y1 + 1e-9 || b.y1 < a.y0 - 1e-9) continue;
        const s1 = segs[a.i];
        const s2 = segs[b.i];
        const r = G.lineLine(s1[0], s1[1], s2[0], s2[1]);
        if (r) {
          if (r.t > -1e-9 && r.t < 1 + 1e-9 && r.u > -1e-9 && r.u < 1 + 1e-9) {
            cuts[a.i].push(Math.max(0, Math.min(1, r.t)));
            cuts[b.i].push(Math.max(0, Math.min(1, r.u)));
          }
        } else {
          // collinear overlap: split at endpoints
          const l1 = sub(s1[1], s1[0]);
          if (Math.abs(cross(norm(l1), sub(s2[0], s1[0]))) < 1e-9) {
            const l2 = dot(l1, l1);
            if (l2 > 0)
              for (const q of s2) {
                const t = dot(sub(q, s1[0]), l1) / l2;
                if (t > 0 && t < 1) cuts[a.i].push(t);
              }
            const m2 = sub(s2[1], s2[0]);
            const l22 = dot(m2, m2);
            if (l22 > 0)
              for (const q of s1) {
                const t = dot(sub(q, s2[0]), m2) / l22;
                if (t > 0 && t < 1) cuts[b.i].push(t);
              }
          }
        }
      }
    }
    const verts = new Map();
    const V = [];
    const vid = (q) => {
      const k = HatchBoundary.ptKey(q);
      let id = verts.get(k);
      if (id === undefined) {
        id = V.length;
        verts.set(k, id);
        V.push({ p: q, out: [] });
      }
      return id;
    };
    const HE = [];
    const addEdge = (u, v) => {
      if (u === v) return;
      if (V[u].out.some((h) => HE[h].v === v)) return;
      const h1 = HE.length;
      HE.push({ u, v, tw: h1 + 1 });
      HE.push({ u: v, v: u, tw: h1 });
      V[u].out.push(h1);
      V[v].out.push(h1 + 1);
    };
    segs.forEach((s, i) => {
      const ts = [...new Set(cuts[i].map((t) => t.toFixed(10)))].map(Number).sort((a, b) => a - b);
      for (let k = 0; k + 1 < ts.length; k += 1)
        addEdge(vid(G.lerp(s[0], s[1], ts[k])), vid(G.lerp(s[0], s[1], ts[k + 1])));
    });
    for (const v of V) v.out.sort((h1, h2) => ang(v.p, V[HE[h1].v].p) - ang(v.p, V[HE[h2].v].p));
    // ray to +x
    let hit = null;
    for (let h = 0; h < HE.length; h += 2) {
      const a = V[HE[h].u].p;
      const b = V[HE[h].v].p;
      if (a.y > p.y === b.y > p.y) continue;
      const x = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (x > p.x && (!hit || x < hit.x)) hit = { x, h };
    }
    if (!hit) return null;
    let h0 = hit.h;
    {
      const a = V[HE[h0].u].p;
      const b = V[HE[h0].v].p;
      if (cross(sub(b, a), sub(p, a)) < 0) h0 = HE[h0].tw;
    }
    const loop = [];
    let h = h0;
    let guard = 0;
    do {
      loop.push(V[HE[h].u].p);
      const tw = HE[h].tw;
      const v = HE[h].v;
      const list = V[v].out;
      const k = list.indexOf(tw);
      h = list[(k - 1 + list.length) % list.length];
    } while (h !== h0 && ++guard < HE.length + 5);
    if (guard >= HE.length + 5) return null;
    if (G.polyArea(loop) <= 1e-12 || !G.pointInPoly(p, loop)) return null;
    const loops = [loop.map((q) => ({ x: q.x, y: q.y }))];
    // islands: closed entities fully inside the outer loop and not containing the pick point
    const onB = (q) => {
      for (let i = 0; i < loop.length; i += 1)
        if (G.segDist(q, loop[i], loop[(i + 1) % loop.length]) < 1e-6) return true;
      return false;
    };
    for (const il of islands) {
      if (il.some(onB)) continue;
      if (il.every((q) => G.pointInPoly(q, loop)) && !G.pointInPoly(p, il))
        loops.push(il.map((q) => ({ x: q.x, y: q.y })));
    }
    return loops;
  }

  /** @private A key for a point (rounded, so that equal points get the same key). */
  static ptKey(p) {
    return `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)}`;
  }
}

/* ============================================================================================
 * 12. SHORT-NAME EXPORTS
 * ========================================================================================== */
export const primParam = PrimMath.param;
export const primLength = PrimMath.length;
export const plineSlice = PolylineTools.slice;
export const plineCorners = PolylineTools.corners;
export const nearestEnd = PolylineTools.nearestEnd;
export const reversePline = PolylineTools.reverse;
export const lineToPline = PolylineTools.lineToPline;
export const arcToPline = PolylineTools.arcToPline;
export const trim = TrimExtend.trim;
export const extend = TrimExtend.extend;
export const offsetEnt = OffsetTools.offsetEnt;
export const offsetSigned = OffsetTools.offsetSigned;
export const filletTwo = CornerTools.fillet;
export const ttrCircle = CornerTools.ttrCircle;
export const chamferTwo = CornerTools.chamfer;
export const breakEnt = BreakJoin.breakEnt;
export const joinEnts = BreakJoin.joinEnts;
export const lengthen = Lengthening.lengthen;
export const pointsAlong = Lengthening.pointsAlong;
export const arrayRect = ArrayTools.rect;
export const arrayPolar = ArrayTools.polar;
export const findBoundary = HatchBoundary.findBoundary;
export const _geom = { cross };
