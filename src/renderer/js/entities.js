/**
 * @file entities.js
 * @brief The object model: how a drawing object looks as data and what can be asked of it.
 *
 * An object is a plain record `{id, type, layer, color, ltype, lw, ltscale, ...type data}`; the
 * types are line, circle, arc, pline, ellipse, spline, text, mtext, dim, leader, hatch, insert,
 * point, xline, ray, donut, viewport, solid3d and others. The functions are grouped in classes (one
 * per theme) and each is also exported by its short name (`prims`, `bbox`, `xformInPlace`, ...),
 * because the other files use them as `E.prims(...)`.
 */

/* ============================================================================================
 * 1. INCLUDES AND HELPERS
 * ========================================================================================== */
import * as G from './geom.js';
import { fmtLen, fmtAng } from './units.js';
import * as K from './kernel3d.js';
import * as S3 from './selection3d.js';
const { TAU, add, sub, mul, dot, cross, dist, ang, polar, norm, perp, normAng, mid, S, A } = G;

/**
 * How wide a text is: the program replaces this with a real measurement (setMeasure); until then a
 * rough estimate is used.
 */
let measureHook = (s, h, st) => s.length * h * 0.6 * ((st && st.wf) || 1);

/** Installs the text width function `(string, height, style) => width`. */
export const setMeasure = (fn) => {
  measureHook = fn;
};

/** The width of a string at a height in a text style. */
export const measure = (s, h, st) => measureHook(s, h, st);

/**
 * The values of a new dimension style (arrow size, text height, gaps, precision, tolerances, ...).
 */
export const DEFAULT_DIMSTYLE = {
  h: 2.5,
  asz: 2.5,
  eo: 0.625,
  ee: 1.25,
  gap: 0.625,
  scale: 1,
  prec: 2,
  prefix: '',
  suffix: '',
  arrow: 'closed',
  useUnits: true,
  color: null,
  // colour of the dimension text (an ACI number); null = the same colour as the dimension (DIMCLRT)
  tcolor: null,
  // lines: suppress extension lines / halves of the dimension line; baseline spacing
  ext1off: false,
  ext2off: false,
  dim1off: false,
  dim2off: false,
  bs: 3.75,
  // symbols and arrows: arrow2 = second arrow (null = same as the first)
  arrow2: null,
  // text: 'above' | 'centered' (dimension line is broken around the text); 'aligned' | 'horizontal'
  tplace: 'above',
  talign: 'aligned',
  // primary units: linear scale factor, rounding, decimal separator, zero suppression 'none' | 'lead' | 'trail' | 'both'
  lfac: 1,
  round: 0,
  dsep: '.',
  zero: 'none',
  // alternate units (shown in [ ] after the primary text)
  alt: false,
  altf: 25.4,
  altPrec: 1,
  altPrefix: '',
  altSuffix: '',
  // tolerances: 'none' | 'symmetrical' | 'deviation' | 'limits' | 'basic'
  tolMode: 'none',
  tolUp: 0.1,
  tolLo: 0.1,
  tolPrec: 2,
  tolScale: 0.7,
};

/** The arrow head types of dimensions and leaders. */
export const ARROW_TYPES = [
  ['closed', 'Closed filled'],
  ['closedblank', 'Closed blank'],
  ['open', 'Open'],
  ['oblique', 'Oblique'],
  ['archtick', 'Architectural tick'],
  ['dot', 'Dot'],
  ['dotsmall', 'Dot small'],
  ['none', 'None'],
];

/** The values of a new text style. */
export const DEFAULT_TEXTSTYLE = { font: 'Arial', wf: 1, obl: 0, h: 0 };

/** @private True for objects (not null, not a number). */
const OWN = (e) => e && typeof e === 'object';

/** The display names of the object types. */
export const TYPE_NAMES = {
  line: 'Line',
  circle: 'Circle',
  arc: 'Arc',
  ellipse: 'Ellipse',
  pline: 'Polyline',
  spline: 'Spline',
  point: 'Point',
  text: 'Text',
  mtext: 'MText',
  xline: 'Xline',
  ray: 'Ray',
  hatch: 'Hatch',
  dim: 'Dimension',
  leader: 'Leader',
  insert: 'Block Reference',
  donut: 'Donut',
  viewport: 'Viewport',
  solid3d: '3D Solid',
};

/** The hatch patterns: name -> pattern lines [{a: angle in degrees, d: spacing, ...}]. */
export const HATCH_PATTERNS = {
  SOLID: null,
  ANSI31: [{ a: 45, d: 3.175 }],
  ANSI32: [
    { a: 45, d: 9.525 },
    { a: 45, d: 9.525, o: 3.175 },
  ],
  ANSI33: [
    { a: 45, d: 6.35 },
    { a: 45, d: 6.35, o: 3.175 },
  ],
  ANSI37: [
    { a: 45, d: 6.35 },
    { a: 135, d: 6.35 },
  ],
  LINE: [{ a: 0, d: 3.175 }],
  NET: [
    { a: 0, d: 3.175 },
    { a: 90, d: 3.175 },
  ],
  EARTH: [
    { a: 0, d: 6.35 },
    { a: 90, d: 6.35 },
    { a: 45, d: 6.35 },
  ],
  DASH: [
    { a: 0, d: 3.175 },
    { a: 90, d: 6.35 },
  ],
};

/** @private The 4x4 identity matrix. */
const ID4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * @private Version counter of the caches: `bump()` raises it, cached primitives and boxes of an
 *     older version are computed again.
 */
let VER = 1;
export const _unused = OWN;

/* ============================================================================================
 * 2. ENTITYFACTORY
 * ========================================================================================== */

/** Creating and copying objects. */
export class EntityFactory {
  /** A deep copy of an object (keys that start with _ are caches and are not copied). */
  static clone(e) {
    return JSON.parse(JSON.stringify(e, (k, v) => (k[0] === '_' ? undefined : v)));
  }

  /** A new object of a type with the default common properties (layer 0, ByLayer colour / linetype / lineweight) and the given properties. */
  static mk(type, props) {
    return { id: 0, type, layer: '0', color: null, ltype: null, lw: null, ltscale: 1, ...props };
  }

  /** The display name of an object's type. */
  static typeName(e) {
    return TYPE_NAMES[e.type] || e.type;
  }
}

/* ============================================================================================
 * 3. POLYLINEGEOMETRY
 * ========================================================================================== */

/** Polylines: segments, primitives, length and area. */
export class PolylineGeometry {
  // ---------------------------------------------------------------- polylines
  /** The segments of a polyline: [{a, b, bulge, i}] (a closing segment is included when the polyline is closed). */
  static plineSegs(e) {
    const n = e.pts.length;
    const out = [];
    const cnt = e.closed ? n : n - 1;
    for (let i = 0; i < cnt; i += 1)
      out.push({ a: e.pts[i], b: e.pts[(i + 1) % n], bulge: e.pts[i].b || 0, i });
    return out;
  }

  /** @private A segment as a primitive (a straight piece, or an arc when it has a bulge). */
  static segPrim(a, b, bulge, extra) {
    if (bulge) {
      const ar = G.bulgeArc(a, b, bulge);
      return A(ar.c, ar.r, ar.a0, ar.a1, { rev: ar.rev, ...extra });
    }
    return S(a, b, extra);
  }

  /** The primitives of a polyline. */
  static plinePrims(e) {
    return PolylineGeometry.plineSegs(e).map((s) =>
      PolylineGeometry.segPrim(s.a, s.b, s.bulge, { e, i: s.i }),
    );
  }

  /** The length of a polyline (arcs included). */
  static plineLength(e) {
    return PolylineGeometry.plineSegs(e).reduce((t, s) => {
      if (!s.bulge) return t + dist(s.a, s.b);
      const ar = G.bulgeArc(s.a, s.b, s.bulge);
      return t + Math.abs(ar.theta) * ar.r;
    }, 0);
  }

  /** The signed area of a polyline including the bulge segments. */
  static plineArea(e) {
    // signed area including bulge segments
    let a = 0;
    const segs = PolylineGeometry.plineSegs(e);
    const pts = e.pts;
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    a /= 2;
    for (const s of segs) {
      if (!s.bulge) continue;
      const ar = G.bulgeArc(s.a, s.b, s.bulge);
      const th = Math.abs(ar.theta);
      const seg = (ar.r * ar.r * (th - Math.sin(th))) / 2; // circular segment area
      a += s.bulge > 0 ? seg : -seg;
    }
    return a;
  }

  /** The vertices of a polyline as plain points. */
  static plineVerts(e) {
    return e.pts.map((p) => ({ x: p.x, y: p.y }));
  }
}

/* ============================================================================================
 * 4. CURVEGEOMETRY
 * ========================================================================================== */

/** Ellipses and splines. */
export class CurveGeometry {
  // ---------------------------------------------------------------- ellipse
  /** The point of an ellipse at parameter t. */
  static ellipsePoint(e, t) {
    return {
      x: e.c.x + e.u.x * Math.cos(t) + e.v.x * Math.sin(t),
      y: e.c.y + e.v.y * Math.sin(t) + e.u.y * Math.cos(t),
    };
  }

  /** The major and minor axis of an ellipse given by two conjugate vectors: {a, b, major, minor, t0}. */
  static ellipseAxes(e) {
    const uu = dot(e.u, e.u);
    const vv = dot(e.v, e.v);
    const uv = dot(e.u, e.v);
    const t0 = 0.5 * Math.atan2(2 * uv, uu - vv);
    const P = (t) => ({
      x: e.u.x * Math.cos(t) + e.v.x * Math.sin(t),
      y: e.u.y * Math.cos(t) + e.v.y * Math.sin(t),
    });
    let m = P(t0);
    let n = P(t0 + Math.PI / 2);
    let tm = t0;
    if (G.len(n) > G.len(m)) {
      const x = m;
      m = n;
      n = x;
      tm = t0 + Math.PI / 2;
    }
    return { major: m, minor: n, a: G.len(m), b: G.len(n), t0: tm };
  }

  /** An ellipse (or elliptical arc) as a list of points. */
  static ellipsePts(e, n) {
    const full = Math.abs(e.a1 - e.a0) >= TAU - 1e-9;
    const s = full ? TAU : G.sweep(e.a0, e.a1);
    const k = n || Math.max(24, Math.min(240, Math.ceil((s / TAU) * 120)));
    const out = [];
    for (let i = 0; i <= k; i += 1) out.push(CurveGeometry.ellipsePoint(e, e.a0 + (s * i) / k));
    return out;
  }

  /** An ellipse object from its centre, the end of the major axis and the ratio of the axes. */
  static makeEllipse(c, majorEnd, ratio, a0 = 0, a1 = TAU) {
    const u = sub(majorEnd, c);
    const v = mul(perp(u), ratio);
    return EntityFactory.mk('ellipse', { c, u, v, a0, a1 });
  }

  // ---------------------------------------------------------------- spline (Catmull-Rom through fit points)
  /** The points of a spline: dense splines as they are, fit-point splines through a Catmull-Rom curve. */
  static splinePts(e) {
    const P = e.pts;
    const n = P.length;
    if (e.dense) return P.map((p) => ({ x: p.x, y: p.y }));
    if (n < 3) return P.map((p) => ({ x: p.x, y: p.y }));
    const get = (i) => (e.closed ? P[((i % n) + n) % n] : P[Math.max(0, Math.min(n - 1, i))]);
    const out = [];
    const segs = e.closed ? n : n - 1;
    const K = 16;
    for (let i = 0; i < segs; i += 1) {
      const p0 = get(i - 1);
      const p1 = get(i);
      const p2 = get(i + 1);
      const p3 = get(i + 2);
      for (let j = 0; j < K; j += 1) {
        const t = j / K;
        const t2 = t * t;
        const t3 = t2 * t;
        out.push({
          x:
            0.5 *
            (2 * p1.x +
              (-p0.x + p2.x) * t +
              (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
              (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          y:
            0.5 *
            (2 * p1.y +
              (-p0.y + p2.y) * t +
              (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
              (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        });
      }
    }
    out.push(e.closed ? { ...P[0] } : { ...P[n - 1] });
    return out;
  }
}

/* ============================================================================================
 * 5. TEXTGEOMETRY
 * ========================================================================================== */

/** Text layout. */
export class TextGeometry {
  // ---------------------------------------------------------------- text layout
  /** The layout of a text object: lines, width, height, box and the style that applies. */
  static textLayout(e, doc) {
    const base = (doc && doc.textStyles && doc.textStyles[e.style]) || DEFAULT_TEXTSTYLE;
    const st = { ...base, wf: e.wf ?? base.wf ?? 1, obl: e.obl ?? base.obl ?? 0 };
    let lines = String(e.str ?? '').split('\n');
    const h = e.h || 2.5;
    if (e.type === 'mtext' && e.w > 0) {
      const wrapped = [];
      for (const ln of lines) {
        const words = ln.split(' ');
        let cur = '';
        for (const w of words) {
          const t = cur ? cur + ' ' + w : w;
          if (cur && measure(t, h, st) > e.w) {
            wrapped.push(cur);
            cur = w;
          } else cur = t;
        }
        wrapped.push(cur);
      }
      lines = wrapped;
    }
    const widths = lines.map((s) => measure(s, h, st));
    const W = Math.max(0, ...widths);
    if (e.type === 'mtext') {
      const lh = h * 1.4;
      const bw = e.w > 0 ? Math.max(e.w, W) : W;
      const totH = h + (lines.length - 1) * lh + h * 0.3;
      // attachment point 1..9 (top/middle/bottom x left/center/right)
      const att = e.att || 1;
      const col = (att - 1) % 3;
      const row = Math.floor((att - 1) / 3);
      const dx = col === 0 ? 0 : col === 1 ? -bw / 2 : -bw;
      const dy = row === 0 ? 0 : row === 1 ? totH / 2 : totH;
      const items = lines.map((s, i) => {
        const lx = col === 1 ? (bw - widths[i]) / 2 : col === 2 ? bw - widths[i] : 0;
        return { s, x: dx + lx, y: dy - h - i * lh };
      });
      return { items, st, h, box: { x0: dx, x1: dx + bw, y1: dy, y0: dy - totH } };
    }
    const al = e.al || 0;
    const x = al === 1 ? -W / 2 : al === 2 ? -W : 0;
    return {
      items: [{ s: lines.join(' '), x, y: 0 }],
      st,
      h,
      box: { x0: x, x1: x + W, y0: -0.25 * h, y1: h },
    };
  }

  /** The four corners of the box around a text object (rotated). */
  static textBoxPoly(e, doc) {
    const L = TextGeometry.textLayout(e, doc);
    const r = e.rot || 0;
    const c = [
      [L.box.x0, L.box.y0],
      [L.box.x1, L.box.y0],
      [L.box.x1, L.box.y1],
      [L.box.x0, L.box.y1],
    ];
    return c.map(([x, y]) => G.rotate({ x, y }, r, { x: 0, y: 0 })).map((p) => add(p, e.p));
  }
}

/* ============================================================================================
 * 6. DIMENSIONGEOMETRY
 * ========================================================================================== */

/** Dimension geometry: styles, measured values, text, lines, arcs and arrow heads. */
export class DimensionGeometry {
  // ---------------------------------------------------------------- dimension geometry
  /** The dimension style that applies to a dimension: the named style with the object's own overrides. */
  static dimStyleOf(e, doc) {
    const ds = {
      ...DEFAULT_DIMSTYLE,
      ...((doc && doc.dimStyles && doc.dimStyles[e.style || 'Standard']) || {}),
      ...(e.ov || {}),
    }; // e.ov = DIMOVERRIDE
    const sc = ds.scale || 1;
    return {
      ...ds,
      h: ds.h * sc,
      asz: ds.asz * sc,
      eo: ds.eo * sc,
      ee: ds.ee * sc,
      gap: ds.gap * sc,
      bs: (ds.bs || 3.75) * sc,
    };
  }

  /** @private The angles of an angular dimension: the arc that contains the dimension point. */
  static angBetweenRays(e) {
    const a1 = ang(e.c, e.p1);
    const a2 = ang(e.c, e.p2);
    const ad = ang(e.c, e.dp);
    // choose the CCW arc (a1->a2 or a2->a1) that contains the dim point direction
    if (G.inArc(ad, a1, a2)) return { a0: a1, a1: a2 };
    if (G.inArc(ad, a2, a1)) return { a0: a2, a1: a1 };
    return { a0: a1, a1: a2 };
  }

  /** The measured value of a dimension (length, radius, diameter or angle in radians). */
  static dimMeasure(e) {
    switch (e.kind) {
      case 'lin': {
        const u = { x: Math.cos(e.rot || 0), y: Math.sin(e.rot || 0) };
        return Math.abs(dot(sub(e.p2, e.p1), u));
      }
      case 'ali':
        return dist(e.p1, e.p2);
      case 'ang': {
        const r = DimensionGeometry.angBetweenRays(e);
        return G.sweep(r.a0, r.a1);
      }
      case 'rad':
        return e.r;
      case 'dia':
        return 2 * e.r;
      case 'arcl':
        return e.r * G.sweep(e.a0, e.a1);
      default:
        return 0;
    }
  }

  // number formatting of a linear measurement under a dimension style: scale factor, rounding, precision, decimal separator, zero suppression
  /** @private A length as dimension text: scale factor, rounding, precision, decimal separator, zero suppression. */
  static dimNum(v, ds, doc, prec) {
    v *= ds.lfac ?? 1;
    if (ds.round > 0) v = Math.round(v / ds.round) * ds.round;
    const u = {
      ...(doc ? doc.units : {}),
      prec: ds.useUnits && prec === ds.prec ? (doc ? doc.units.prec : prec) : prec,
    };
    if (!doc || doc.units.type === 'decimal') u.prec = prec;
    let s = fmtLen(v, u);
    if (!doc || doc.units.type === 'decimal') {
      if (s.includes('.')) {
        if (ds.zero === 'trail' || ds.zero === 'both')
          s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
        if (ds.zero === 'lead' || ds.zero === 'both') s = s.replace(/^(-?)0\./, '$1.');
      }
      if (ds.dsep && ds.dsep !== '.') s = s.replace('.', ds.dsep);
    }
    return s;
  }

  // tolerance strings for the current style, or null
  /** @private The tolerance strings for the current style, or null. */
  static dimTol(e, doc, ds) {
    if (!ds.tolMode || ds.tolMode === 'none' || e.kind === 'ang') return null;
    const v = DimensionGeometry.dimMeasure(e) * (ds.lfac ?? 1);
    const f = (x) =>
      DimensionGeometry.dimNum(
        x / (ds.lfac ?? 1),
        { ...ds, lfac: ds.lfac ?? 1, zero: 'none' },
        doc,
        ds.tolPrec,
      );
    const sg = (x, plus) =>
      `${plus ? '+' : '-'}${DimensionGeometry.dimNum(Math.abs(x) / (ds.lfac ?? 1), ds, doc, ds.tolPrec)}`;
    switch (ds.tolMode) {
      case 'symmetrical':
        return {
          mode: 'sym',
          up: `±${DimensionGeometry.dimNum(ds.tolUp / (ds.lfac ?? 1), ds, doc, ds.tolPrec)}`,
        };
      case 'deviation':
        return { mode: 'dev', up: sg(ds.tolUp, true), lo: sg(ds.tolLo, false) };
      case 'limits':
        return { mode: 'lim', up: f(v + ds.tolUp), lo: f(v - ds.tolLo) };
      case 'basic':
        return { mode: 'basic' };
      default:
        return null;
    }
  }

  /** The text a dimension shows when it has no text of its own. */
  static dimAutoText(e, doc) {
    const ds = DimensionGeometry.dimStyleOf(e, doc);
    const v = DimensionGeometry.dimMeasure(e);
    if (e.kind === 'ang')
      return ds.prefix + fmtAng(v, doc ? doc.units : undefined, true) + ds.suffix;
    let s =
      (e.kind === 'rad' ? 'R' : e.kind === 'dia' ? 'Ø' : e.kind === 'arcl' ? '⌒' : '') +
      ds.prefix +
      DimensionGeometry.dimNum(v, ds, doc, ds.prec) +
      ds.suffix;
    if (ds.alt)
      s += ` [${ds.altPrefix}${DimensionGeometry.dimNum(v * (ds.altf || 1), { ...ds, lfac: ds.lfac ?? 1, round: 0 }, doc, ds.altPrec)}${ds.altSuffix}]`;
    return s;
  }

  /** The text a dimension shows (its own text, with <> standing for the measured value). */
  static dimText(e, doc) {
    const auto = DimensionGeometry.dimAutoText(e, doc);
    return e.text ? e.text.replace('<>', auto) : auto;
  }

  /** @private Turns a text angle so that the text is not upside down. */
  static readable(r) {
    r = normAng(r);
    if (r > Math.PI / 2 + 1e-9 && r <= (3 * Math.PI) / 2 + 1e-9) r -= Math.PI;
    return r;
  }

  // dimension geometry: lines, arcs, arrow heads, the main text and extra texts (tolerances)
  /** The geometry of a dimension: lines, arcs, arrow heads, the main text and extra texts (tolerances). */
  static dimGeom(e, doc) {
    const g = DimensionGeometry.dimGeomCore(e, doc);
    const ds = g.ds;
    for (const a of g.arrows) a.type ||= ds.arrow;
    const tol = DimensionGeometry.dimTol(e, doc, ds);
    if (tol && g.text) {
      const STD = (doc && doc.textStyles && doc.textStyles.Standard) || DEFAULT_TEXTSTYLE;
      const t = g.text;
      const tw = t.w;
      const td = { x: Math.cos(t.rot), y: Math.sin(t.rot) };
      const up = perp(td);
      const hh = ds.h * (ds.tolScale || 0.7);
      const cen = add(t.p, mul(td, t.al === 1 ? 0 : t.al === 2 ? -tw / 2 : tw / 2)); // centre of the main text on its base line
      if (tol.mode === 'basic') {
        // basic dimension: a frame around the text
        const hw = tw / 2 + ds.gap;
        const P = (x, y) => add(add(cen, mul(td, x)), mul(up, y));
        const y0 = -ds.gap;
        const y1 = ds.h + ds.gap;
        g.lines.push(
          [P(-hw, y0), P(hw, y0)],
          [P(hw, y0), P(hw, y1)],
          [P(hw, y1), P(-hw, y1)],
          [P(-hw, y1), P(-hw, y0)],
        );
        g.text = { ...t, p: cen, al: 1 };
      } else if (tol.mode === 'lim') {
        // limits: upper value above lower value
        g.text = {
          ...t,
          str: tol.up,
          p: add(cen, mul(up, ds.h * 0.12)),
          al: 1,
          w: measure(tol.up, ds.h, STD),
        };
        g.extra.push({
          p: add(cen, mul(up, -ds.h * 1.12)),
          str: tol.lo,
          h: ds.h,
          rot: t.rot,
          al: 1,
        });
      } else {
        // symmetrical / deviation: small text(s) right of the main text
        const w1 = measure(tol.up, hh, STD);
        const w2 = tol.lo ? measure(tol.lo, hh, STD) : 0;
        const tw2 = Math.max(w1, w2);
        const gt = ds.gap * 0.6;
        const shift = (tw2 + gt) / 2;
        g.text = { ...t, p: add(cen, mul(td, -shift)), al: 1 };
        const bx = add(cen, mul(td, tw / 2 - shift + gt + tw2 / 2));
        if (tol.mode === 'sym')
          g.extra.push({
            p: add(bx, mul(up, ds.h / 2 - hh / 2)),
            str: tol.up,
            h: hh,
            rot: t.rot,
            al: 1,
          });
        else
          g.extra.push(
            { p: add(bx, mul(up, ds.h / 2 + hh * 0.05)), str: tol.up, h: hh, rot: t.rot, al: 1 },
            { p: add(bx, mul(up, ds.h / 2 - hh * 1.05)), str: tol.lo, h: hh, rot: t.rot, al: 1 },
          );
      }
    }
    return g;
  }

  /** @private The geometry of a dimension without the tolerance texts. */
  static dimGeomCore(e, doc) {
    const ds = DimensionGeometry.dimStyleOf(e, doc);
    const g = { lines: [], arrows: [], arcs: [], text: null, ds, extra: [] };
    const str = DimensionGeometry.dimText(e, doc);
    const tw = measure(
      str,
      ds.h,
      (doc && doc.textStyles && doc.textStyles.Standard) || DEFAULT_TEXTSTYLE,
    );
    const asz = ds.asz;
    const textAt = (pos, rot, al = 1) => {
      g.text = { p: pos, str, rot, h: ds.h, al, w: tw };
    };

    if (e.kind === 'lin' || e.kind === 'ali') {
      const rot = e.kind === 'ali' ? ang(e.p1, e.p2) : e.rot || 0;
      const u = { x: Math.cos(rot), y: Math.sin(rot) };
      const n = perp(u);
      const off = dot(sub(e.dp, e.p1), n);
      const off2 = dot(sub(e.dp, e.p2), n);
      const d1 = add(e.p1, mul(n, off));
      const d2 = add(e.p2, mul(n, off2));
      [
        [e.p1, d1, ds.ext1off],
        [e.p2, d2, ds.ext2off],
      ].forEach(([p, d, off]) => {
        if (off) return; // extension line suppressed
        const dd = sub(d, p);
        const l = G.len(dd);
        if (l < 1e-9) return;
        const dir = mul(dd, 1 / l);
        g.lines.push([add(p, mul(dir, Math.min(ds.eo, l))), add(d, mul(dir, ds.ee))]);
      });
      const L = dist(d1, d2);
      const dir = L > 1e-9 ? norm(sub(d2, d1)) : u;
      const inside = L >= 2 * asz + 1e-9;
      const A1 = ds.arrow;
      const A2 = ds.arrow2 || ds.arrow;
      // text direction / placement: along the dimension line (readable) or always horizontal; above the line or centred in a gap of the line
      const horiz = ds.talign === 'horizontal';
      const tr = horiz ? 0 : DimensionGeometry.readable(ang({ x: 0, y: 0 }, dir));
      const td = { x: Math.cos(tr), y: Math.sin(tr) };
      const m = mid(d1, d2);
      const centered = inside && (ds.tplace === 'centered' || (horiz && Math.abs(dir.y) > 0.5));
      const bh = centered
        ? (Math.abs(dot(td, dir)) * tw + Math.abs(dot(perp(td), dir)) * ds.h) / 2 + ds.gap
        : 0;
      const brk = centered && bh < L / 2 - asz;
      if (inside) {
        if (!brk && !ds.dim1off && !ds.dim2off) g.lines.push([d1, d2]);
        else {
          if (!ds.dim1off) g.lines.push([d1, brk ? sub(m, mul(dir, bh)) : m]);
          if (!ds.dim2off) g.lines.push([brk ? add(m, mul(dir, bh)) : m, d2]);
        }
        if (!ds.dim1off) g.arrows.push({ tip: d1, dir: mul(dir, -1), type: A1 });
        if (!ds.dim2off) g.arrows.push({ tip: d2, dir, type: A2 });
      } else {
        g.lines.push([add(d1, mul(dir, -asz * 2)), add(d2, mul(dir, asz * 2))]);
        g.arrows.push({ tip: d1, dir, type: A1 }, { tip: d2, dir: mul(dir, -1), type: A2 });
      }
      textAt(
        e.tp || (brk ? sub(m, mul(perp(td), ds.h / 2)) : add(m, mul(perp(td), ds.gap))),
        tr,
        1,
      );
      if (!inside && !e.tp) g.text.p = add(m, mul(perp(td), ds.gap));
      return g;
    }
    if (e.kind === 'ang') {
      const r = DimensionGeometry.angBetweenRays(e);
      const R = dist(e.c, e.dp);
      g.arcs.push({ c: e.c, r: R, a0: r.a0, a1: r.a1 });
      [
        [e.p1, ang(e.c, e.p1)],
        [e.p2, ang(e.c, e.p2)],
      ].forEach(([p, a]) => {
        const dp = dist(e.c, p);
        const far = polar(e.c, a, R + ds.ee);
        if (R > dp) g.lines.push([add(p, mul(norm(sub(far, p)), Math.min(ds.eo, R - dp))), far]);
        else g.lines.push([polar(e.c, a, R), polar(e.c, a, R)]);
      });
      g.lines = g.lines.filter(([a, b]) => dist(a, b) > 1e-9);
      const t0 = r.a0;
      const t1 = r.a1;
      const sw = G.sweep(t0, t1);
      g.arrows.push(
        { tip: polar(e.c, t0, R), dir: { x: Math.sin(t0), y: -Math.cos(t0) } },
        { tip: polar(e.c, t1, R), dir: { x: -Math.sin(t1), y: Math.cos(t1) } },
      );
      const am = t0 + sw / 2;
      const tdir = { x: -Math.sin(am), y: Math.cos(am) };
      const tr = DimensionGeometry.readable(ang({ x: 0, y: 0 }, tdir));
      const td = { x: Math.cos(tr), y: Math.sin(tr) };
      const base = polar(e.c, am, R);
      const upv = perp(td);
      const outward = polar({ x: 0, y: 0 }, am, 1);
      const sgn = dot(upv, outward) >= 0 ? 1 : -1;
      textAt(e.tp || add(base, mul(upv, sgn * ds.gap)), tr, 1);
      if (sgn < 0 && !e.tp) g.text.p = add(base, mul(upv, ds.gap * 0 + -ds.gap - ds.h));
      return g;
    }
    if (e.kind === 'arcl') {
      const R = dist(e.c, e.dp);
      const sw = G.sweep(e.a0, e.a1);
      g.arcs.push({ c: e.c, r: R, a0: e.a0, a1: e.a1 });
      for (const a of [e.a0, e.a1]) {
        const p0 = polar(e.c, a, e.r);
        const p1 = polar(e.c, a, R + ds.ee);
        g.lines.push([add(p0, mul(norm(sub(p1, p0)), Math.min(ds.eo, Math.abs(R - e.r)))), p1]);
      }
      g.arrows.push(
        { tip: polar(e.c, e.a0, R), dir: { x: Math.sin(e.a0), y: -Math.cos(e.a0) } },
        { tip: polar(e.c, e.a1, R), dir: { x: -Math.sin(e.a1), y: Math.cos(e.a1) } },
      );
      const am = e.a0 + sw / 2;
      const tdir = { x: -Math.sin(am), y: Math.cos(am) };
      const tr = DimensionGeometry.readable(ang({ x: 0, y: 0 }, tdir));
      const td = { x: Math.cos(tr), y: Math.sin(tr) };
      const up = perp(td);
      const out = polar({ x: 0, y: 0 }, am, 1);
      textAt(
        e.tp ||
          add(
            polar(e.c, am, R),
            mul(up, (dot(up, out) >= 0 ? 1 : -1) * ds.gap + (dot(up, out) >= 0 ? 0 : -ds.h)),
          ),
        tr,
        1,
      );
      return g;
    }
    if (e.kind === 'rad') {
      const dir = norm(sub(e.p, e.c));
      const tip = add(e.c, mul(dir, e.r));
      const outside = dist(e.p, e.c) > e.r;
      g.lines.push([tip, e.p]);
      g.arrows.push({ tip, dir: mul(dir, outside ? -1 : 1) });
      if (!outside) g.lines[0] = [tip, e.p];
      const right = dir.x >= -1e-9;
      const L = tw + ds.gap;
      const land = add(e.p, { x: right ? L : -L, y: 0 });
      g.lines.push([e.p, land]);
      textAt(
        { x: right ? e.p.x + ds.gap / 2 + 0 : e.p.x - ds.gap / 2, y: e.p.y + ds.gap / 2 },
        0,
        right ? 0 : 2,
      );
      return g;
    }
    if (e.kind === 'dia') {
      const dir = norm(sub(e.p, e.c));
      const t1 = add(e.c, mul(dir, e.r));
      const t2 = add(e.c, mul(dir, -e.r));
      g.lines.push([t1, t2]);
      g.arrows.push({ tip: t1, dir }, { tip: t2, dir: mul(dir, -1) });
      const tr = DimensionGeometry.readable(ang({ x: 0, y: 0 }, dir));
      const td = { x: Math.cos(tr), y: Math.sin(tr) };
      textAt(e.tp || add(e.c, mul(perp(td), ds.gap)), tr, 1);
      return g;
    }
    return g;
  }

  // every arrow head as drawing primitives: fill (closed polygons), stroke (polylines), dots (filled circles)
  /** Every arrow head as drawing primitives: fill (closed polygons), stroke (polylines), dots (filled circles). */
  static arrowShapes(a, size, type = a.type || 'closed') {
    const back = add(a.tip, mul(a.dir, -size));
    const n = mul(perp(a.dir), size / 6);
    switch (type) {
      case 'none':
        return {};
      case 'open':
        return { stroke: [[add(back, n), a.tip, sub(back, n)]] };
      case 'closedblank':
        return { stroke: [[a.tip, add(back, n), sub(back, n), a.tip]] };
      case 'dot':
        return { dots: [{ c: a.tip, r: size / 2 }] };
      case 'dotsmall':
        return { dots: [{ c: a.tip, r: size / 4 }] };
      case 'oblique':
      case 'archtick': {
        const w = norm(add(a.dir, perp(a.dir)));
        const hl = size * (type === 'archtick' ? 0.6 : 0.45);
        return { stroke: [[sub(a.tip, mul(w, hl)), add(a.tip, mul(w, hl))]] };
      }
      default:
        return { fill: [[a.tip, add(back, n), sub(back, n)]] };
    }
  }

  /** The triangle of a closed arrow head. */
  static arrowPoly(a, size) {
    const back = add(a.tip, mul(a.dir, -size));
    const n = mul(perp(a.dir), size / 6);
    return [a.tip, add(back, n), sub(back, n)];
  }
}

/* ============================================================================================
 * 7. HATCHGEOMETRY
 * ========================================================================================== */

/** Hatch pattern lines. */
export class HatchGeometry {
  /** The pattern lines of a hatch, clipped to its boundary (cached until the hatch changes). */
  static hatchLines(e) {
    const key = JSON.stringify([e.loops, e.pattern, e.scale, e.angle]);
    if (e._hlKey === key) return e._hl;
    const fam = HATCH_PATTERNS[e.pattern];
    const out = [];
    if (fam) {
      const edges = [];
      for (const lp of e.loops)
        for (let i = 0; i < lp.length; i += 1) edges.push([lp[i], lp[(i + 1) % lp.length]]);
      let x0 = 1e18;
      let y0 = 1e18;
      let x1 = -1e18;
      let y1 = -1e18;
      for (const lp of e.loops)
        for (const p of lp) {
          x0 = Math.min(x0, p.x);
          y0 = Math.min(y0, p.y);
          x1 = Math.max(x1, p.x);
          y1 = Math.max(y1, p.y);
        }
      const sc = e.scale || 1;
      let budget = 20000;
      for (const f of fam) {
        const a = G.rad(f.a) + (e.angle || 0);
        const u = { x: Math.cos(a), y: Math.sin(a) };
        const n = perp(u);
        const sp = f.d * sc;
        if (!(sp > 0)) continue;
        const corners = [
          { x: x0, y: y0 },
          { x: x1, y: y0 },
          { x: x1, y: y1 },
          { x: x0, y: y1 },
        ];
        const ns = corners.map((c) => dot(c, n));
        const nmin = Math.min(...ns);
        const nmax = Math.max(...ns);
        const first = Math.ceil((nmin + (f.o || 0) * sc) / sp) * sp - (f.o || 0) * sc;
        for (let k = first; k <= nmax; k += sp) {
          if (--budget < 0) break;
          const ts = [];
          for (const [p, q] of edges) {
            const sp1 = dot(p, n) - k;
            const sq1 = dot(q, n) - k;
            if ((sp1 < 0 && sq1 >= 0) || (sq1 < 0 && sp1 >= 0)) {
              const t = sp1 / (sp1 - sq1);
              ts.push(dot(add(p, mul(sub(q, p), t)), u));
            }
          }
          ts.sort((x, y) => x - y);
          for (let i = 0; i + 1 < ts.length; i += 2) {
            out.push([add(mul(n, k), mul(u, ts[i])), add(mul(n, k), mul(u, ts[i + 1]))]);
          }
        }
      }
    }
    e._hlKey = key;
    e._hl = out;
    return out;
  }
}

/* ============================================================================================
 * 8. BLOCKEXPANSION
 * ========================================================================================== */

/** Block insertions: matrices and expansion. */
export class BlockExpansion {
  // ---------------------------------------------------------------- block expansion
  /** The matrix that places a block definition for an insertion (base point, scale, rotation). */
  static insertMatrix(e, base) {
    const b = base || { x: 0, y: 0 };
    return G.Mmul(
      G.Mtranslate(e.p.x, e.p.y),
      G.Mmul(
        G.Mrotate(e.rot || 0),
        G.Mmul(G.Mscale(e.sx ?? 1, e.sy ?? e.sx ?? 1), G.Mtranslate(-b.x, -b.y)),
      ),
    );
  }

  /** The objects of a block insertion, moved to their place (one level). */
  static expandOnce(e, doc) {
    const def = doc && doc.blocks && doc.blocks[e.name];
    if (!def) return [];
    const M = BlockExpansion.insertMatrix(e, def.base);
    const out = [];
    for (const c of def.ents) {
      const k = EntityFactory.clone(c);
      if (k.attdef) {
        const tag = k.attdef.tag;
        k.str = e.attribs && tag in e.attribs ? e.attribs[tag] : k.attdef.def;
        delete k.attdef;
        if (!k.str) continue;
      }
      EntityTransform.xformInPlace(k, M, doc);
      if (k.layer === '0') k.layer = e.layer;
      if (k.color === 'bb') k.color = e.color;
      if (k.ltype === 'bb') k.ltype = e.ltype;
      k.id = 0;
      out.push(k);
    }
    return out;
  }

  /** The objects an insertion finally consists of (blocks inside blocks are expanded); other objects give themselves. */
  static leaves(e, doc, depth = 0) {
    if (e.type !== 'insert') return [e];
    const key =
      JSON.stringify([e.name, e.p, e.rot, e.sx, e.sy, e.layer, e.color, e.ltype, e.attribs]) +
      '|' +
      (doc ? doc.blockVer : 0);
    if (e._lk === key) return e._leaves;
    let out = [];
    if (depth < 8)
      for (const k of BlockExpansion.expandOnce(e, doc))
        out = out.concat(BlockExpansion.leaves(k, doc, depth + 1));
    e._lk = key;
    e._leaves = out;
    return out;
  }
}

/* ============================================================================================
 * 9. SOLIDGEOMETRY
 * ========================================================================================== */

/** 3D solids as seen by the 2D object model: boxes, edges and plan segments. */
export class SolidGeometry {
  // fast: in a big model take the stored box (e.bb) of a part that has not been meshed yet instead of meshing it just to know its size
  /** The 3D box of a solid. `fast`: in a big model take the stored box (e.bb) of a part that has not been meshed yet instead of meshing it just to know its size. */
  static solidBounds(e, fast = false) {
    if (K.kernelReady() && e.brep && !(fast && e.bb && !K.meshReady(e))) {
      try {
        const b = K.solidMesh(e).bounds;
        return { x0: b[0][0], y0: b[0][1], z0: b[0][2], x1: b[1][0], y1: b[1][1], z1: b[1][2] };
      } catch {
        /* fall through */
      }
    }
    const bb = e.bb || { x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0 };
    const M = K.opsMatrix(e.ops || []) || ID4;
    const pts = [];
    for (const x of [bb.x0, bb.x1])
      for (const y of [bb.y0, bb.y1])
        for (const z of [bb.z0, bb.z1]) pts.push(K.applyM(M, [x, y, z]));
    return {
      x0: Math.min(...pts.map((p) => p[0])),
      y0: Math.min(...pts.map((p) => p[1])),
      z0: Math.min(...pts.map((p) => p[2])),
      x1: Math.max(...pts.map((p) => p[0])),
      y1: Math.max(...pts.map((p) => p[1])),
      z1: Math.max(...pts.map((p) => p[2])),
    };
  }

  // edge polylines in world space: [{id, pts:[[x,y,z],...]}]
  /** The edges of a solid in world space: [{id, pts: [[x, y, z], ...]}]. */
  static solidEdges(e) {
    if (!K.kernelReady() || !e.brep) return [];
    if (e._edgesKey === JSON.stringify(e.ops) && e._edges) return e._edges;
    const m = K.solidMesh(e);
    const out = [];
    for (const g of m.edgeGroups) {
      const pts = [];
      for (let i = g.start; i < g.start + g.count; i += 2) {
        const a = [m.lines[i * 3], m.lines[i * 3 + 1], m.lines[i * 3 + 2]];
        const b = [m.lines[(i + 1) * 3], m.lines[(i + 1) * 3 + 1], m.lines[(i + 1) * 3 + 2]];
        if (!pts.length) pts.push(a);
        pts.push(b);
      }
      out.push({ id: g.edgeId, pts });
    }
    e._edges = out;
    e._edgesKey = JSON.stringify(e.ops);
    return out;
  }

  // 2D (plan) segments of a solid: its edges projected on XY
  /** @private The 2D (plan) segments of a solid: its edges projected on XY. */
  static solidPrims(e) {
    const out = [];
    for (const ed of SolidGeometry.solidEdges(e))
      for (let i = 0; i + 1 < ed.pts.length; i += 1) {
        const a = ed.pts[i];
        const b = ed.pts[i + 1];
        if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) > 1e-9)
          out.push(S({ x: a[0], y: a[1] }, { x: b[0], y: b[1] }, { e, i }));
      }
    return out;
  }
}

/* ============================================================================================
 * 10. ENTITYBOUNDS
 * ========================================================================================== */

/** Primitives and bounding boxes of any object, with caches. */
export class EntityBounds {
  // ---------------------------------------------------------------- primitives
  /** @private The primitives of an object (straight pieces and arcs), not cached. */
  static primsRaw(e, doc) {
    switch (e.type) {
      case 'line':
        return [S(e.p1, e.p2, { e })];
      case 'circle':
        return [A(e.c, e.r, 0, TAU, { e })];
      case 'arc':
        return [A(e.c, e.r, e.a0, e.a1, { e })];
      case 'ellipse': {
        const p = CurveGeometry.ellipsePts(e);
        const o = [];
        for (let i = 0; i + 1 < p.length; i += 1) o.push(S(p[i], p[i + 1], { e, i }));
        return o;
      }
      case 'pline':
        return PolylineGeometry.plinePrims(e);
      case 'spline': {
        const p = CurveGeometry.splinePts(e);
        const o = [];
        for (let i = 0; i + 1 < p.length; i += 1) o.push(S(p[i], p[i + 1], { e, i }));
        return o;
      }
      case 'xline':
        return [S(add(e.p, mul(e.dir, -1e6)), add(e.p, mul(e.dir, 1e6)), { e })];
      case 'ray':
        return [S(e.p, add(e.p, mul(e.dir, 1e6)), { e })];
      case 'donut':
        return [A(e.c, e.rin, 0, TAU, { e }), A(e.c, e.rout, 0, TAU, { e })];
      case 'leader': {
        const o = [];
        for (let i = 0; i + 1 < e.pts.length; i += 1) o.push(S(e.pts[i], e.pts[i + 1], { e, i }));
        return o;
      }
      case 'dim':
        return DimensionGeometry.dimGeom(e, doc)
          .lines.map(([a, b]) => S(a, b, { e }))
          .concat(
            DimensionGeometry.dimGeom(e, doc).arcs.map((a) => A(a.c, a.r, a.a0, a.a1, { e })),
          );
      case 'solid3d':
        return SolidGeometry.solidPrims(e);
      case 'viewport': {
        const { p1, p2 } = e;
        const c = [p1, { x: p2.x, y: p1.y }, p2, { x: p1.x, y: p2.y }];
        return c.map((p, i) => S(p, c[(i + 1) % 4], { e }));
      }
      case 'insert':
        return BlockExpansion.leaves(e, doc).flatMap((k) => EntityBounds.prims(k, doc));
      default:
        return [];
    }
  }

  // ---------------------------------------------------------------- bounding boxes
  /** The box around a list of points. */
  static bboxOf(list) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of list) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    return x0 === Infinity ? null : { x0, y0, x1, y1 };
  }

  /** The box around two boxes (either may be null). */
  static bboxMerge(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
      x0: Math.min(a.x0, b.x0),
      y0: Math.min(a.y0, b.y0),
      x1: Math.max(a.x1, b.x1),
      y1: Math.max(a.y1, b.y1),
    };
  }

  /** @private The box around one primitive. */
  static primBox(P) {
    if (P.k === 's') return EntityBounds.bboxOf([P.a, P.b]);
    const pts = [G.arcPt(P, P.a0), G.arcPt(P, P.a1)];
    for (let k = 0; k < 4; k += 1) {
      const a = (k * Math.PI) / 2;
      if (G.inArc(a, P.a0, P.a1)) pts.push(G.arcPt(P, a));
    }
    return EntityBounds.bboxOf(pts);
  }

  /** @private The box around an object, not cached (null for infinite objects). */
  static bboxRaw(e, doc) {
    if (e.type === 'xline' || e.type === 'ray') return null;
    if (e.type === 'solid3d') {
      const b = SolidGeometry.solidBounds(e);
      return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
    }
    if (e.type === 'insert')
      return BlockExpansion.leaves(e, doc).reduce(
        (b, k) => EntityBounds.bboxMerge(b, EntityBounds.bbox(k, doc)),
        null,
      );
    let b = null;
    if (e.type === 'point') return { x0: e.p.x, y0: e.p.y, x1: e.p.x, y1: e.p.y };
    if (e.type === 'text' || e.type === 'mtext')
      return EntityBounds.bboxOf(TextGeometry.textBoxPoly(e, doc));
    if (e.type === 'hatch') return EntityBounds.bboxOf(e.loops.flat());
    if (e.type === 'dim') {
      const g = DimensionGeometry.dimGeom(e, doc);
      b = null;
      for (const [p, q] of g.lines) b = EntityBounds.bboxMerge(b, EntityBounds.bboxOf([p, q]));
      for (const a of g.arcs)
        b = EntityBounds.bboxMerge(b, EntityBounds.primBox(A(a.c, a.r, a.a0, a.a1)));
      for (const t of [g.text, ...g.extra])
        if (t)
          b = EntityBounds.bboxMerge(
            b,
            EntityBounds.bboxOf(
              TextGeometry.textBoxPoly(
                { type: 'text', p: t.p, h: t.h, str: t.str, rot: t.rot, al: t.al },
                doc,
              ),
            ),
          );
      return b;
    }
    if (e.type === 'leader') {
      b = EntityBounds.bboxOf(e.pts);
      if (e.str)
        b = EntityBounds.bboxMerge(
          b,
          EntityBounds.bboxOf(
            TextGeometry.textBoxPoly(
              { type: 'text', p: e.tp, h: e.h, str: e.str, rot: 0, al: 0 },
              doc,
            ),
          ),
        );
      return b;
    }
    for (const P of EntityBounds.prims(e, doc))
      b = EntityBounds.bboxMerge(b, EntityBounds.primBox(P));
    return b;
  }

  /** Tells the caches that objects may have changed: the next prims() / bbox() call computes again. */
  static bump() {
    VER += 1;
  }

  /** The primitives of an object (cached until bump() is called). */
  static prims(e, doc) {
    if (e._pv === VER && e._pr) return e._pr;
    const r = EntityBounds.primsRaw(e, doc);
    e._pv = VER;
    e._pr = r;
    return r;
  }

  /** The bounding box of an object (cached until bump() is called). */
  static bbox(e, doc) {
    if (e._bv === VER) return e._bb;
    const r = EntityBounds.bboxRaw(e, doc);
    e._bv = VER;
    e._bb = r;
    return r;
  }
}

/* ============================================================================================
 * 11. ENTITYTRANSFORM
 * ========================================================================================== */

/** Moving, rotating, scaling and mirroring objects. */
export class EntityTransform {
  // ---------------------------------------------------------------- transforms
  /** @private The direction angle after a matrix has been applied. */
  static vecAngleMap(M, a) {
    const v = G.Mvec(M, { x: Math.cos(a), y: Math.sin(a) });
    return Math.atan2(v.y, v.x);
  }

  /** Applies a matrix to an object, changing it (mirrors, uneven scale and blocks are handled per type). */
  static xformInPlace(e, M, doc) {
    const P = (p) => G.Mapply(M, p);
    const det = G.Mdet(M);
    const s = G.Mscl(M);
    const rot = G.Mangle(M);
    const sim = G.isSim(M);
    const toEllipse = (c, r, a0, a1) => {
      e.type = 'ellipse';
      e.c = c;
      e.u = { x: r, y: 0 };
      e.v = { x: 0, y: r };
      e.a0 = a0;
      e.a1 = a1;
      delete e.r;
      delete e.p1;
    };
    switch (e.type) {
      case 'line':
        e.p1 = P(e.p1);
        e.p2 = P(e.p2);
        break;
      case 'xline':
      case 'ray':
        e.p = P(e.p);
        e.dir = norm(G.Mvec(M, e.dir));
        break;
      case 'circle':
        if (sim) {
          e.c = P(e.c);
          e.r *= s;
        } else {
          toEllipse(e.c, e.r, 0, TAU);
          EntityTransform.xformInPlace(e, M, doc);
        }
        break;
      case 'arc':
        if (sim) {
          e.c = P(e.c);
          e.r *= s;
          const a0 = EntityTransform.vecAngleMap(M, e.a0);
          const a1 = EntityTransform.vecAngleMap(M, e.a1);
          if (det > 0) {
            e.a0 = a0;
            e.a1 = a1;
          } else {
            e.a0 = a1;
            e.a1 = a0;
          }
        } else {
          const c = e.c;
          const r = e.r;
          const a0 = e.a0;
          const a1 = e.a1;
          toEllipse(c, r, a0, a1);
          EntityTransform.xformInPlace(e, M, doc);
        }
        break;
      case 'ellipse':
        e.c = P(e.c);
        e.u = G.Mvec(M, e.u);
        e.v = G.Mvec(M, e.v);
        if (det < 0) {
          e.v = mul(e.v, -1);
          const a0 = e.a0;
          e.a0 = -e.a1;
          e.a1 = -a0;
        }
        break;
      case 'pline':
        e.pts = e.pts.map((p) => ({ ...P(p), b: det < 0 ? -(p.b || 0) : p.b || 0 }));
        break;
      case 'spline':
        e.pts = e.pts.map(P);
        if (e.nurbs) e.nurbs = { ...e.nurbs, ctrl: e.nurbs.ctrl.map(P) };
        break;
      case 'point':
        e.p = P(e.p);
        break;
      case 'donut':
        e.c = P(e.c);
        e.rin *= s;
        e.rout *= s;
        break;
      case 'text':
      case 'mtext':
        e.p = P(e.p);
        e.h *= s;
        if (e.w) e.w *= s;
        if (det > 0) e.rot = (e.rot || 0) + rot;
        else {
          const d = G.Mvec(M, { x: Math.cos(e.rot || 0), y: Math.sin(e.rot || 0) });
          e.rot = Math.atan2(d.y, d.x);
        }
        break;
      case 'hatch':
        e.loops = e.loops.map((l) => l.map(P));
        e.scale = (e.scale || 1) * s;
        e.angle = (e.angle || 0) + rot;
        break;
      case 'leader':
        e.pts = e.pts.map(P);
        if (e.tp) e.tp = P(e.tp);
        e.h *= s;
        break;
      case 'solid3d': {
        // 2D similarity -> rigid ops about Z (+ mirror / uniform scale)
        const ops = e.ops || (e.ops = []);
        if (!sim) break;
        if (det < 0) ops.push({ t: 'M', o: [0, 0, 0], n: [0, 1, 0] });
        if (Math.abs(s - 1) > 1e-12) ops.push({ t: 'S', o: [0, 0, 0], s });
        const ang0 = Math.atan2(M.b, M.a) - (det < 0 ? 0 : 0);
        if (Math.abs(ang0) > 1e-12)
          ops.push({
            t: 'R',
            o: [0, 0, 0],
            a: [0, 0, 1],
            ang: det < 0 ? Math.atan2(M.b, M.a) : ang0,
          });
        if (Math.abs(M.e) + Math.abs(M.f) > 1e-12) ops.push({ t: 'T', v: [M.e, M.f, 0] });
        e._edgesKey = null;
        break;
      }
      case 'viewport': {
        const a = P(e.p1);
        const b = P(e.p2);
        e.p1 = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
        e.p2 = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
        break;
      }
      case 'insert': {
        const L = { a: M.a, b: M.b, c: M.c, d: M.d, e: 0, f: 0 };
        const R = G.Mmul(L, G.Mmul(G.Mrotate(e.rot || 0), G.Mscale(e.sx ?? 1, e.sy ?? e.sx ?? 1)));
        const c1 = { x: R.a, y: R.b };
        const c2 = { x: R.c, y: R.d };
        const l1 = G.len(c1);
        e.p = P(e.p);
        e.rot = Math.atan2(c1.y, c1.x);
        e.sx = l1;
        e.sy = l1 > 1e-12 ? cross(c1, c2) / l1 : 0;
        break;
      }
      case 'dim':
        for (const k of ['p1', 'p2', 'dp', 'c', 'p', 'tp']) if (e[k]) e[k] = P(e[k]);
        if (e.kind === 'lin') {
          const d = G.Mvec(M, { x: Math.cos(e.rot || 0), y: Math.sin(e.rot || 0) });
          e.rot = Math.atan2(d.y, d.x);
        }
        if (e.kind === 'arcl') {
          const a0 = EntityTransform.vecAngleMap(M, e.a0);
          const a1 = EntityTransform.vecAngleMap(M, e.a1);
          if (det > 0) {
            e.a0 = a0;
            e.a1 = a1;
          } else {
            e.a0 = a1;
            e.a1 = a0;
          }
        }
        if (e.r) e.r *= s;
        break;
      default:
        break;
    }
    return e;
  }

  /** Moves an object by dx, dy. */
  static translateEnt(e, dx, dy, doc) {
    return EntityTransform.xformInPlace(e, G.Mtranslate(dx, dy), doc);
  }

  /** Drawn curves that may carry a saved drawing plane (so they can stand anywhere in 3D). */
  static PLANEABLE = new Set(['line', 'arc', 'circle', 'pline', 'ellipse', 'spline']);

  /** Moves a 3D body in XYZ; a drawn curve that is lifted in Z moves its drawing plane, other drawing objects stay on their XY plane. */
  static translateEnt3d(e, dx, dy, dz, doc) {
    if (e.type !== 'solid3d') {
      // a line, arc, circle or polyline that is lifted in Z (or already lies on a saved plane) moves its drawing plane
      if (EntityTransform.PLANEABLE.has(e.type) && (e.plane || Math.abs(dz) > 1e-12)) {
        const P = e.plane || { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] };
        e.plane = { ...P, o: [P.o[0] + dx, P.o[1] + dy, P.o[2] + dz] };
        return e;
      }
      return EntityTransform.translateEnt(e, dx, dy, doc);
    }
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) <= 1e-15) return e;
    (e.ops ||= []).push({ t: 'T', v: [dx, dy, dz] });
    e._edgesKey = null;
    e._mk = null;
    e._mm = null;
    return e;
  }

  /** A transformed copy of an object (new id 0). */
  static copyXform(e, M, doc) {
    const k = EntityFactory.clone(e);
    EntityTransform.xformInPlace(k, M, doc);
    k.id = 0;
    return k;
  }
}

/* ============================================================================================
 * 12. ENTITYGRIPS
 * ========================================================================================== */

/** Grips. */
export class EntityGrips {
  // ---------------------------------------------------------------- grips
  // kind 'm' = move whole entity; 'v' = vertex/stretch handle. s:true = used by STRETCH
  /** The grips of an object: [{id, p, kind, s}]; kind 'm' = move the whole object, 'v' = vertex / stretch handle; s = used by STRETCH. */
  static grips(e, doc) {
    const g = [];
    const V = (id, p, s = true) => g.push({ id, p, kind: 'v', s });
    const Mv = (id, p) => g.push({ id, p, kind: 'm', s: false });
    switch (e.type) {
      case 'line':
        V('p1', e.p1);
        Mv('mid', mid(e.p1, e.p2));
        V('p2', e.p2);
        break;
      case 'circle':
        g.push({ id: 'c', p: e.c, kind: 'm', s: true });
        for (let k = 0; k < 4; k += 1)
          g.push({ id: 'q' + k, p: polar(e.c, (k * Math.PI) / 2, e.r), kind: 'v', s: false });
        break;
      case 'arc':
        V('start', G.arcPt(e, e.a0));
        Mv('c', e.c);
        V('end', G.arcPt(e, e.a1));
        g.push({ id: 'amid', p: G.arcPt(e, e.a0 + G.sweep(e.a0, e.a1) / 2), kind: 'v', s: false });
        break;
      case 'ellipse': {
        g.push({ id: 'c', p: e.c, kind: 'm', s: true });
        const ax = CurveGeometry.ellipseAxes(e);
        V('ax0', add(e.c, ax.major), false);
        V('ax1', add(e.c, ax.minor), false);
        break;
      }
      case 'pline':
        e.pts.forEach((p, i) => V('v' + i, p));
        break;
      case 'spline':
        e.pts.forEach((p, i) => V('v' + i, p));
        break;
      case 'leader':
        e.pts.forEach((p, i) => V('v' + i, p));
        if (e.tp) V('tp', e.tp);
        break;
      case 'point':
      case 'insert':
      case 'text':
      case 'mtext':
      case 'xline':
      case 'ray':
        g.push({ id: 'p', p: e.p, kind: 'm', s: true });
        break;
      case 'donut':
        g.push({ id: 'c', p: e.c, kind: 'm', s: true });
        break;
      case 'solid3d': {
        const b = SolidGeometry.solidBounds(e);
        g.push({
          id: 'c',
          p: { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z: (b.z0 + b.z1) / 2 },
          kind: 'm',
          s: true,
        });
        break;
      }
      case 'hatch': {
        const b = EntityBounds.bbox(e, doc);
        if (b)
          g.push({
            id: 'h',
            p: { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 },
            kind: 'm',
            s: true,
          });
        break;
      }
      case 'dim':
        if (e.p1) V('p1', e.p1);
        if (e.p2) V('p2', e.p2);
        if (e.dp) V('dp', e.dp);
        if (e.tp) V('tp', e.tp);
        if (e.c) g.push({ id: 'c', p: e.c, kind: 'v', s: true });
        if (e.p && (e.kind === 'rad' || e.kind === 'dia')) V('p', e.p);
        break;
      case 'viewport':
        V('p1', e.p1);
        V('p2', e.p2);
        V('p3', { x: e.p2.x, y: e.p1.y });
        V('p4', { x: e.p1.x, y: e.p2.y });
        Mv('mid', mid(e.p1, e.p2));
        break;
      default:
        break;
    }
    return g;
  }

  /** Moves a grip to a new point and changes the object accordingly. */
  static setGrip(e, g, np, doc) {
    if (g.kind === 'm') {
      EntityTransform.translateEnt(e, np.x - g.p.x, np.y - g.p.y, doc);
      return;
    }
    const id = g.id;
    switch (e.type) {
      case 'line':
        e[id] = { ...np };
        break;
      case 'circle':
        e.r = Math.max(1e-9, dist(e.c, np));
        break;
      case 'arc':
        if (id === 'start') e.a0 = ang(e.c, np);
        else if (id === 'end') e.a1 = ang(e.c, np);
        else e.r = Math.max(1e-9, dist(e.c, np));
        break;
      case 'ellipse': {
        const ax = CurveGeometry.ellipseAxes(e);
        const v = sub(np, e.c);
        if (id === 'ax0') {
          const k = G.len(v) / (ax.a || 1);
          const r = ax.b / (ax.a || 1);
          const nu = mul(norm(v), G.len(v));
          e.u = nu;
          e.v = mul(perp(nu), r);
          e.a0 = 0;
          e.a1 = Math.abs(e.a1 - e.a0) >= TAU - 1e-9 ? TAU : e.a1;
          void k;
        } else {
          const b = G.len(v);
          e.v = mul(perp(norm(ax.major)), b);
          e.u = ax.major;
        }
        break;
      }
      case 'pline':
      case 'spline': {
        const i = parseInt(id.slice(1), 10);
        e.pts[i] = { ...e.pts[i], x: np.x, y: np.y };
        if (e.type === 'spline') {
          delete e.nurbs;
          e.dense = false;
        }
        break;
      }
      case 'leader':
        if (id === 'tp') e.tp = { ...np };
        else e.pts[parseInt(id.slice(1), 10)] = { ...np };
        break;
      case 'dim':
        e[id] = { ...np };
        if (id === 'p' && (e.kind === 'rad' || e.kind === 'dia')) {
          /* direction only */
        }
        break;
      case 'viewport': {
        let { p1, p2 } = e;
        if (id === 'p1') p1 = np;
        else if (id === 'p2') p2 = np;
        else if (id === 'p3') {
          p2 = { x: np.x, y: p2.y };
          p1 = { x: p1.x, y: np.y };
        } else if (id === 'p4') {
          p1 = { x: np.x, y: p1.y };
          p2 = { x: p2.x, y: np.y };
        }
        e.p1 = { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y) };
        e.p2 = { x: Math.max(p1.x, p2.x), y: Math.max(p1.y, p2.y) };
        break;
      }
      default:
        break;
    }
  }
}

/* ============================================================================================
 * 13. ENTITYSNAP
 * ========================================================================================== */

/** Object snap points. */
export class EntitySnap {
  // ---------------------------------------------------------------- snap points
  /** The object snap points of an object: [{p, t, e}] with the snap type t. */
  static snapPoints(e, doc) {
    const o = [];
    const P = (p, t) => o.push({ p, t, e });
    switch (e.type) {
      case 'line':
        P(e.p1, 'end');
        P(e.p2, 'end');
        P(mid(e.p1, e.p2), 'mid');
        break;
      case 'circle':
        P(e.c, 'cen');
        for (let k = 0; k < 4; k += 1) P(polar(e.c, (k * Math.PI) / 2, e.r), 'qua');
        break;
      case 'arc': {
        P(G.arcPt(e, e.a0), 'end');
        P(G.arcPt(e, e.a1), 'end');
        P(G.arcPt(e, e.a0 + G.sweep(e.a0, e.a1) / 2), 'mid');
        P(e.c, 'cen');
        for (let k = 0; k < 4; k += 1) {
          const a = (k * Math.PI) / 2;
          if (G.inArc(a, e.a0, e.a1)) P(G.arcPt(e, a), 'qua');
        }
        break;
      }
      case 'ellipse': {
        P(e.c, 'cen');
        const ax = CurveGeometry.ellipseAxes(e);
        for (const v of [ax.major, ax.minor]) {
          P(add(e.c, v), 'qua');
          P(sub(e.c, v), 'qua');
        }
        if (Math.abs(e.a1 - e.a0) < TAU - 1e-9) {
          P(CurveGeometry.ellipsePoint(e, e.a0), 'end');
          P(CurveGeometry.ellipsePoint(e, e.a1), 'end');
        }
        break;
      }
      case 'pline': {
        e.pts.forEach((p) => P({ x: p.x, y: p.y }, 'end'));
        for (const s of PolylineGeometry.plineSegs(e)) P(G.segPoint(s.a, s.b, s.bulge, 0.5), 'mid');
        for (const s of PolylineGeometry.plineSegs(e))
          if (s.bulge) P(G.bulgeArc(s.a, s.b, s.bulge).c, 'cen');
        break;
      }
      case 'spline': {
        P(e.pts[0], 'end');
        if (!e.closed) P(e.pts[e.pts.length - 1], 'end');
        e.pts.forEach((p) => P(p, 'nod'));
        break;
      }
      case 'point':
        P(e.p, 'nod');
        break;
      case 'text':
      case 'mtext':
        P(e.p, 'ins');
        break;
      case 'insert':
        P(e.p, 'ins');
        break;
      case 'donut':
        P(e.c, 'cen');
        for (let k = 0; k < 4; k += 1) {
          P(polar(e.c, (k * Math.PI) / 2, e.rout), 'qua');
          P(polar(e.c, (k * Math.PI) / 2, e.rin), 'qua');
        }
        break;
      case 'xline':
      case 'ray':
        P(e.p, 'end');
        break;
      case 'solid3d': {
        const seen = new Set();
        const edges = SolidGeometry.solidEdges(e);
        for (const ed of edges)
          for (const q of [ed.pts[0], ed.pts[ed.pts.length - 1]]) {
            // Include Z: top and bottom vertices often share X/Y and must remain separate snap targets.
            const k = `${q[0].toFixed(5)},${q[1].toFixed(5)},${q[2].toFixed(5)}`;
            if (!seen.has(k)) {
              seen.add(k);
              P({ x: q[0], y: q[1], z: q[2] }, 'end');
            }
          }
        // Midpoint by accumulated 3D arc length. Curved B-rep edges contain several display
        // segments, so averaging only their first and last vertices does not locate the real half.
        for (const ed of edges) {
          const q = S3.polylineMidpoint(ed.pts);
          if (q) P({ x: q[0], y: q[1], z: q[2] }, 'mid');
        }
        // Body centre and area-weighted face centres make top, side and curved faces directly
        // addressable without hunting for a corner first.
        const b = SolidGeometry.solidBounds(e);
        P({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z: (b.z0 + b.z1) / 2 }, 'gcen');
        try {
          const m = K.solidMesh(e);
          for (const f of m.faceGroups) {
            const frame = S3.faceFrame(m, f);
            if (frame) P({ x: frame.p[0], y: frame.p[1], z: frame.p[2] }, 'gcen');
          }
        } catch { /* a not-yet-loaded kernel still exposes its stored body centre */ }
        break;
      }
      case 'leader':
        e.pts.forEach((p) => P(p, 'end'));
        break;
      case 'dim': {
        // the real geometry of the dimension: ends and middle of the dimension line / extension lines, arrow tips (to line new dimensions up with it)
        for (const k of ['p1', 'p2', 'dp']) if (e[k]) P(e[k], 'end');
        const g = DimensionGeometry.dimGeom(e, doc);
        const seen = new Set();
        const add1 = (q, t) => {
          const k = `${t}${q.x.toFixed(6)},${q.y.toFixed(6)}`;
          if (!seen.has(k)) {
            seen.add(k);
            P(q, t);
          }
        };
        for (const [a, b] of g.lines) {
          add1(a, 'end');
          add1(b, 'end');
          add1(mid(a, b), 'mid');
        }
        for (const ar of g.arrows) {
          add1(ar.tip, 'end');
          add1(ar.tip, 'int');
        } // the arrow tip is where the dimension line meets the extension line: both Endpoint and Intersection
        if (g.text) add1(g.text.p, 'ins');
        if (e.c) P(e.c, 'cen');
        break;
      }
      case 'viewport': {
        const c = [e.p1, { x: e.p2.x, y: e.p1.y }, e.p2, { x: e.p1.x, y: e.p2.y }];
        c.forEach((p) => P(p, 'end'));
        break;
      }
      default:
        break;
    }
    // the corners of a small solid fill (an arrow head, a SOLID) are end points
    if (
      e.type === 'hatch' &&
      e.pattern === 'SOLID' &&
      e.loops &&
      e.loops.length === 1 &&
      e.loops[0].length <= 4
    )
      for (const q of e.loops[0]) P({ x: q.x, y: q.y }, 'end');
    // geometric center (centroid) of closed shapes
    if ((e.type === 'pline' && e.closed) || e.type === 'hatch') {
      const loop = e.type === 'hatch' ? e.loops && e.loops[0] : EntityMeasure.closedLoop(e);
      if (loop && loop.length >= 3) {
        let A = 0;
        let cx = 0;
        let cy = 0;
        for (let i = 0; i < loop.length; i += 1) {
          const p = loop[i];
          const q = loop[(i + 1) % loop.length];
          const cr = p.x * q.y - q.x * p.y;
          A += cr;
          cx += (p.x + q.x) * cr;
          cy += (p.y + q.y) * cr;
        }
        if (Math.abs(A) > 1e-12) P({ x: cx / (3 * A), y: cy / (3 * A) }, 'gcen');
      }
    }
    return o;
  }
}

/* ============================================================================================
 * 14. ENTITYHITTEST
 * ========================================================================================== */

/** Hit testing: picking, window / crossing / fence selection. */
export class EntityHitTest {
  // ---------------------------------------------------------------- hit testing
  /** The distance from a point to an object (for picking). */
  static distTo(e, p, doc) {
    switch (e.type) {
      case 'point':
        return dist(e.p, p);
      case 'text':
      case 'mtext': {
        const poly = TextGeometry.textBoxPoly(e, doc);
        if (G.pointInPoly(p, poly)) return 0;
        let d = Infinity;
        for (let i = 0; i < 4; i += 1) d = Math.min(d, G.segDist(p, poly[i], poly[(i + 1) % 4]));
        return d;
      }
      case 'hatch': {
        let ins = false;
        for (const lp of e.loops) if (G.pointInPoly(p, lp)) ins = !ins;
        if (ins) return 0;
        let d = Infinity;
        for (const lp of e.loops)
          for (let i = 0; i < lp.length; i += 1)
            d = Math.min(d, G.segDist(p, lp[i], lp[(i + 1) % lp.length]));
        return d;
      }
      case 'dim': {
        let d = Infinity;
        for (const P of EntityBounds.prims(e, doc)) d = Math.min(d, G.nearestOnPrim(P, p).d);
        const g = DimensionGeometry.dimGeom(e, doc);
        for (const t of [g.text, ...g.extra])
          if (t)
            d = Math.min(
              d,
              EntityHitTest.distTo(
                { type: 'text', p: t.p, h: t.h, str: t.str, rot: t.rot, al: t.al },
                p,
                doc,
              ),
            );
        for (const a of g.arrows) d = Math.min(d, dist(a.tip, p));
        return d;
      }
      case 'leader': {
        let d = Infinity;
        for (const P of EntityBounds.prims(e, doc)) d = Math.min(d, G.nearestOnPrim(P, p).d);
        if (e.str && e.tp)
          d = Math.min(
            d,
            EntityHitTest.distTo(
              { type: 'text', p: e.tp, h: e.h, str: e.str, rot: 0, al: 0 },
              p,
              doc,
            ),
          );
        return d;
      }
      case 'solid3d': {
        let d = Infinity;
        for (const P of EntityBounds.prims(e, doc)) d = Math.min(d, G.nearestOnPrim(P, p).d);
        return d;
      }
      case 'donut': {
        const r = dist(e.c, p);
        return r >= e.rin && r <= e.rout ? 0 : Math.min(Math.abs(r - e.rin), Math.abs(r - e.rout));
      }
      case 'insert': {
        let d = Infinity;
        for (const k of BlockExpansion.leaves(e, doc))
          d = Math.min(d, EntityHitTest.distTo(k, p, doc));
        return Math.min(d, dist(e.p, p));
      }
      default: {
        let d = Infinity;
        for (const P of EntityBounds.prims(e, doc)) d = Math.min(d, G.nearestOnPrim(P, p).d);
        return d;
      }
    }
  }

  /** @private Does a segment touch a rectangle? */
  static segHitsRect(a, b, r) {
    const inside = (p) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
    if (inside(a) || inside(b)) return true;
    const c = [
      { x: r.x0, y: r.y0 },
      { x: r.x1, y: r.y0 },
      { x: r.x1, y: r.y1 },
      { x: r.x0, y: r.y1 },
    ];
    for (let i = 0; i < 4; i += 1) {
      const h = G.lineLine(a, b, c[i], c[(i + 1) % 4]);
      if (h && h.t >= 0 && h.t <= 1 && h.u >= 0 && h.u <= 1) return true;
    }
    return false;
  }

  // window = fully inside, crossing = touches
  /** Is the object inside a rectangle (window) or, with `crossing`, does it touch it? */
  static inRect(e, r, crossing, doc) {
    const b = EntityBounds.bbox(e, doc);
    if (e.type === 'xline' || e.type === 'ray')
      return (
        crossing && EntityBounds.prims(e, doc).some((P) => EntityHitTest.segHitsRect(P.a, P.b, r))
      );
    if (!b) return false;
    const full = b.x0 >= r.x0 && b.x1 <= r.x1 && b.y0 >= r.y0 && b.y1 <= r.y1;
    if (!crossing) return full;
    if (full) return true;
    if (b.x1 < r.x0 || b.x0 > r.x1 || b.y1 < r.y0 || b.y0 > r.y1) return false;
    if (e.type === 'point' || e.type === 'text' || e.type === 'mtext' || e.type === 'hatch')
      return true;
    for (const P of EntityBounds.prims(e, doc)) {
      if (P.k === 's') {
        if (EntityHitTest.segHitsRect(P.a, P.b, r)) return true;
      } else {
        const pts = G.arcPoints(P.c, P.r, P.a0, P.a1, Math.max(P.r / 200, 1e-6));
        for (let i = 0; i + 1 < pts.length; i += 1)
          if (EntityHitTest.segHitsRect(pts[i], pts[i + 1], r)) return true;
      }
    }
    if (e.type === 'dim' || e.type === 'insert' || e.type === 'leader') return true;
    return false;
  }

  // polygon (window / crossing polygon) and fence selection tests
  /** The same for a polygon (window polygon / crossing polygon). */
  static inPoly(e, poly, crossing, doc) {
    const b = EntityBounds.bbox(e, doc);
    if (!b) return false;
    const corners = [
      { x: b.x0, y: b.y0 },
      { x: b.x1, y: b.y0 },
      { x: b.x1, y: b.y1 },
      { x: b.x0, y: b.y1 },
    ];
    if (!crossing) return corners.every((c) => G.pointInPoly(c, poly));
    if (corners.some((c) => G.pointInPoly(c, poly))) return true;
    if (poly.some((p) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1)) return true;
    return EntityHitTest.crossFence(e, [...poly, poly[0]], doc);
  }

  /** Does the object cross the fence polyline? */
  static crossFence(e, pts, doc) {
    for (const P of EntityBounds.prims(e, doc)) {
      const segs =
        P.k === 's'
          ? [[P.a, P.b]]
          : (() => {
              const ps = G.arcPoints(P.c, P.r, P.a0, P.a1, Math.max(P.r / 100, 1e-6));
              const o = [];
              for (let i = 0; i + 1 < ps.length; i += 1) o.push([ps[i], ps[i + 1]]);
              return o;
            })();
      for (const [a, b] of segs)
        for (let i = 0; i + 1 < pts.length; i += 1) {
          const h = G.lineLine(a, b, pts[i], pts[i + 1]);
          if (h && h.t >= -1e-9 && h.t <= 1 + 1e-9 && h.u >= -1e-9 && h.u <= 1 + 1e-9) return true;
        }
    }
    if (e.type === 'text' || e.type === 'mtext') {
      const poly = TextGeometry.textBoxPoly(e, doc);
      return poly.some((p, i) => {
        for (let k = 0; k + 1 < pts.length; k += 1) {
          const h = G.lineLine(p, poly[(i + 1) % 4], pts[k], pts[k + 1]);
          if (h && h.t >= 0 && h.t <= 1 && h.u >= 0 && h.u <= 1) return true;
        }
        return false;
      });
    }
    return false;
  }
}

/* ============================================================================================
 * 15. ENTITYMEASURE
 * ========================================================================================== */

/** Length, area and closed shapes. */
export class EntityMeasure {
  /** The length of an object (perimeter of closed ones, circumference of a circle). */
  static entLength(e) {
    switch (e.type) {
      case 'line':
        return dist(e.p1, e.p2);
      case 'circle':
        return TAU * e.r;
      case 'arc':
        return e.r * G.sweep(e.a0, e.a1);
      case 'pline':
        return PolylineGeometry.plineLength(e);
      case 'ellipse':
        return CurveGeometry.ellipsePts(e, 240).reduce(
          (t, p, i, a) => (i ? t + dist(a[i - 1], p) : 0),
          0,
        );
      case 'spline':
        return CurveGeometry.splinePts(e).reduce(
          (t, p, i, a) => (i ? t + dist(a[i - 1], p) : 0),
          0,
        );
      default:
        return 0;
    }
  }

  /** The area of a closed object (0 for others). */
  static entArea(e) {
    switch (e.type) {
      case 'circle':
        return Math.PI * e.r * e.r;
      case 'pline':
        return Math.abs(PolylineGeometry.plineArea(e));
      case 'ellipse': {
        const ax = CurveGeometry.ellipseAxes(e);
        return Math.PI * ax.a * ax.b;
      }
      case 'donut':
        return Math.PI * (e.rout * e.rout - e.rin * e.rin);
      case 'spline':
        return Math.abs(G.polyArea(CurveGeometry.splinePts(e)));
      case 'hatch':
        return e.loops.reduce((t, l, i) => t + (i === 0 ? 1 : -1) * Math.abs(G.polyArea(l)), 0);
      default:
        return 0;
    }
  }

  /** Is the object a closed shape (circle, closed polyline, full ellipse, ...)? */
  static isClosed(e) {
    return (
      e.type === 'circle' ||
      e.type === 'donut' ||
      ((e.type === 'pline' || e.type === 'spline') && e.closed) ||
      (e.type === 'ellipse' && Math.abs(e.a1 - e.a0) >= TAU - 1e-9)
    );
  }

  // polygon approximation of a closed entity (for hatch / area / region)
  /** A closed object as a polygon (for hatch, area and region). */
  static closedLoop(e) {
    switch (e.type) {
      case 'circle':
        return G.arcPoints(e.c, e.r, 0, TAU, e.r / 400 + 1e-6).slice(0, -1);
      case 'ellipse':
        return CurveGeometry.ellipsePts(e, 120).slice(0, -1);
      case 'spline':
        return CurveGeometry.splinePts(e).slice(0, -1);
      case 'pline': {
        const out = [];
        for (const s of PolylineGeometry.plineSegs(e)) {
          if (!s.bulge) out.push({ x: s.a.x, y: s.a.y });
          else {
            const ar = G.bulgeArc(s.a, s.b, s.bulge);
            const n = Math.max(6, Math.ceil(Math.abs(ar.theta) / 0.12));
            for (let i = 0; i < n; i += 1) out.push(G.segPoint(s.a, s.b, s.bulge, i / n));
          }
        }
        return out;
      }
      default:
        return null;
    }
  }
}

/* ============================================================================================
 * 16. ENTITYEXPLODE
 * ========================================================================================== */

/** Exploding objects. */
export class EntityExplode {
  // ---------------------------------------------------------------- explode
  /** The simpler objects an object breaks into (null when it cannot be exploded). */
  static explode(e, doc) {
    const inherit = (k) => {
      k.layer = e.layer;
      k.color = e.color;
      k.ltype = e.ltype;
      k.lw = e.lw;
      k.ltscale = e.ltscale;
      return k;
    };
    switch (e.type) {
      case 'pline':
        return PolylineGeometry.plineSegs(e).map((s) =>
          inherit(
            s.bulge
              ? (() => {
                  const a = G.bulgeArc(s.a, s.b, s.bulge);
                  return EntityFactory.mk('arc', { c: a.c, r: a.r, a0: a.a0, a1: a.a1 });
                })()
              : EntityFactory.mk('line', {
                  p1: { x: s.a.x, y: s.a.y },
                  p2: { x: s.b.x, y: s.b.y },
                }),
          ),
        );
      case 'insert':
        return BlockExpansion.expandOnce(e, doc);
      case 'mtext': {
        const L = TextGeometry.textLayout(e, doc);
        return L.items.map((it) =>
          inherit(
            EntityFactory.mk('text', {
              p: add(e.p, G.rotate({ x: it.x, y: it.y }, e.rot || 0)),
              h: e.h,
              str: it.s,
              rot: e.rot || 0,
              style: e.style,
              al: 0,
            }),
          ),
        );
      }
      case 'donut':
        return [
          inherit(EntityFactory.mk('circle', { c: e.c, r: e.rin })),
          inherit(EntityFactory.mk('circle', { c: e.c, r: e.rout })),
        ];
      case 'leader':
        return EntityBounds.prims(e, doc).map((P) =>
          inherit(EntityFactory.mk('line', { p1: P.a, p2: P.b })),
        );
      case 'hatch':
        return HatchGeometry.hatchLines(e).map(([a, b]) =>
          inherit(EntityFactory.mk('line', { p1: a, p2: b })),
        );
      case 'dim': {
        const g = DimensionGeometry.dimGeom(e, doc);
        const out = [];
        for (const [a, b] of g.lines) out.push(inherit(EntityFactory.mk('line', { p1: a, p2: b })));
        for (const a of g.arcs)
          out.push(inherit(EntityFactory.mk('arc', { c: a.c, r: a.r, a0: a.a0, a1: a.a1 })));
        for (const ar of g.arrows) {
          const sh = DimensionGeometry.arrowShapes(ar, g.ds.asz);
          for (const poly of sh.fill || [])
            out.push(
              inherit(
                EntityFactory.mk('hatch', { loops: [poly], pattern: 'SOLID', scale: 1, angle: 0 }),
              ),
            );
          for (const pl of sh.stroke || [])
            for (let i = 0; i + 1 < pl.length; i += 1)
              out.push(inherit(EntityFactory.mk('line', { p1: pl[i], p2: pl[i + 1] })));
          for (const d of sh.dots || [])
            out.push(
              inherit(
                EntityFactory.mk('hatch', {
                  loops: [Array.from({ length: 16 }, (_, k) => polar(d.c, (k * TAU) / 16, d.r))],
                  pattern: 'SOLID',
                  scale: 1,
                  angle: 0,
                }),
              ),
            );
        }
        for (const t of [g.text, ...g.extra])
          if (t) {
            const tx = inherit(
              EntityFactory.mk('text', {
                p: t.p,
                h: t.h,
                str: t.str,
                rot: t.rot,
                style: 'Standard',
                al: t.al,
              }),
            );
            if (g.ds.tcolor != null) tx.color = g.ds.tcolor;
            out.push(tx);
          }
        return out;
      }
      default:
        return null;
    }
  }
}

export const clone = EntityFactory.clone;
export const mk = EntityFactory.mk;
export const typeName = EntityFactory.typeName;
export const plineSegs = PolylineGeometry.plineSegs;
export const plinePrims = PolylineGeometry.plinePrims;
export const plineLength = PolylineGeometry.plineLength;
export const plineArea = PolylineGeometry.plineArea;
export const plineVerts = PolylineGeometry.plineVerts;
export const ellipsePoint = CurveGeometry.ellipsePoint;
export const ellipseAxes = CurveGeometry.ellipseAxes;
export const ellipsePts = CurveGeometry.ellipsePts;
export const makeEllipse = CurveGeometry.makeEllipse;
export const splinePts = CurveGeometry.splinePts;
export const textLayout = TextGeometry.textLayout;
export const textBoxPoly = TextGeometry.textBoxPoly;
export const dimStyleOf = DimensionGeometry.dimStyleOf;
export const dimMeasure = DimensionGeometry.dimMeasure;
export const dimAutoText = DimensionGeometry.dimAutoText;
export const dimText = DimensionGeometry.dimText;
export const dimGeom = DimensionGeometry.dimGeom;
export const arrowShapes = DimensionGeometry.arrowShapes;
export const arrowPoly = DimensionGeometry.arrowPoly;
export const hatchLines = HatchGeometry.hatchLines;
export const insertMatrix = BlockExpansion.insertMatrix;
export const expandOnce = BlockExpansion.expandOnce;
export const leaves = BlockExpansion.leaves;
export const solidBounds = SolidGeometry.solidBounds;
export const solidEdges = SolidGeometry.solidEdges;
export const bboxOf = EntityBounds.bboxOf;
export const bboxMerge = EntityBounds.bboxMerge;
export const bump = EntityBounds.bump;
export const prims = EntityBounds.prims;
export const bbox = EntityBounds.bbox;
export const xformInPlace = EntityTransform.xformInPlace;
export const translateEnt = EntityTransform.translateEnt;
export const translateEnt3d = EntityTransform.translateEnt3d;
export const PLANEABLE = EntityTransform.PLANEABLE;
export const copyXform = EntityTransform.copyXform;
export const grips = EntityGrips.grips;
export const setGrip = EntityGrips.setGrip;
export const snapPoints = EntitySnap.snapPoints;
export const distTo = EntityHitTest.distTo;
export const inRect = EntityHitTest.inRect;
export const inPoly = EntityHitTest.inPoly;
export const crossFence = EntityHitTest.crossFence;
export const entLength = EntityMeasure.entLength;
export const entArea = EntityMeasure.entArea;
export const isClosed = EntityMeasure.isClosed;
export const closedLoop = EntityMeasure.closedLoop;
export const explode = EntityExplode.explode;
