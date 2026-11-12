/**
 * @file commands_draw.js
 * @brief The Draw commands (LINE, CIRCLE, ARC, PLINE, ELLIPSE, RECTANG, POLYGON, SPLINE, TEXT, HATCH,
 *        BLOCK, INSERT, ...) and the Dimension commands (DIMLINEAR, DIMALIGNED, DIMRADIUS,
 *        DIMDIAMETER, DIMANGULAR, DIMCONTINUE, DIMBASELINE, MLEADER, LEADER, DIMSTYLE).
 */

/* ============================================================================================
 * 1. INCLUDES AND HELPERS
 * ========================================================================================== */
import { def } from './registry.js';
import * as G from './geom.js';
import * as E from './entities.js';
import * as O from './ops.js';
import { ARC_PICK, arcOfPick } from './dimmatch.js';
const { dist, ang, polar, add, sub, mul, norm, perp, TAU } = G;
const isPt = (v) => v && typeof v === 'object' && 'x' in v;
const P0 = (p) => ({ x: p.x, y: p.y });
const bp = (p, b = 0) => ({ x: p.x, y: p.y, b });

/* ============================================================================================
 * 2. CLASS
 * ========================================================================================== */

/** The Draw and Dimension commands. Every command is a static method `(c) => Promise`; `register()` adds them all. */
export class DrawCommands {
  // ------------------------------------------------------------------ LINE
  /** LINE: a chain of straight segments. */
  static async line(c) {
    const first = await c.point('Specify first point');
    if (!isPt(first)) return;
    let prev = first;
    const segs = [];
    for (;;) {
      const kws = [];
      if (segs.length >= 2) kws.push('Close');
      if (segs.length) kws.push('Undo');
      const p = await c.point('Specify next point', {
        base: prev,
        kw: kws,
        preview: (q) => [c.mk('line', { p1: prev, p2: q })],
      });
      if (p === null) break;
      if (p === 'Close') {
        c.add(c.mk('line', { p1: prev, p2: first }));
        break;
      }
      if (p === 'Undo') {
        const l = segs.pop();
        if (l) {
          c.erase([l]);
          prev = l.p1;
        }
        continue;
      }
      segs.push(c.add(c.mk('line', { p1: prev, p2: p })));
      prev = p;
    }
  }

  /** XLINE: an infinite construction line (horizontal, vertical, angle, bisector, offset). */
  static async xline(c) {
    const o = await c.point('Specify a point or [Hor/Ver/Ang/Bisect/Offset]', {
      kw: ['Hor', 'Ver', 'Ang', 'Bisect', 'Offset'],
    });
    if (o === null) return;
    const mkx = (p, dir) => c.mk('xline', { p, dir: norm(dir) });
    if (o === 'Hor' || o === 'Ver') {
      for (;;) {
        const p = await c.point('Specify through point', {
          noSnap: false,
          preview: (q) => [mkx(q, o === 'Hor' ? { x: 1, y: 0 } : { x: 0, y: 1 })],
        });
        if (!isPt(p)) break;
        c.add(mkx(p, o === 'Hor' ? { x: 1, y: 0 } : { x: 0, y: 1 }));
      }
      return;
    }
    if (o === 'Ang') {
      const a = await c.angle('Enter angle of xline (0) or [Reference]', { def: 0 });
      if (typeof a !== 'number') return;
      for (;;) {
        const p = await c.point('Specify through point', {
          preview: (q) => [mkx(q, { x: Math.cos(a), y: Math.sin(a) })],
        });
        if (!isPt(p)) break;
        c.add(mkx(p, { x: Math.cos(a), y: Math.sin(a) }));
      }
      return;
    }
    if (o === 'Bisect') {
      const v = await c.point('Specify angle vertex point');
      if (!isPt(v)) return;
      const s = await c.point('Specify angle start point', { base: v });
      if (!isPt(s)) return;
      for (;;) {
        const e = await c.point('Specify angle end point', {
          base: v,
          preview: (q) => [mkx(v, add(norm(sub(s, v)), norm(sub(q, v))))],
        });
        if (!isPt(e)) break;
        c.add(mkx(v, add(norm(sub(s, v)), norm(sub(e, v)))));
      }
      return;
    }
    if (o === 'Offset') {
      c.echo('Use the OFFSET command on an xline.');
      return;
    }
    const p0 = o;
    for (;;) {
      const p = await c.point('Specify through point', {
        base: p0,
        preview: (q) => [mkx(p0, sub(q, p0))],
      });
      if (!isPt(p)) break;
      c.add(mkx(p0, sub(p, p0)));
    }
  }

  /** RAY: a construction line that starts at a point. */
  static async ray(c) {
    const p0 = await c.point('Specify start point');
    if (!isPt(p0)) return;
    for (;;) {
      const p = await c.point('Specify through point', {
        base: p0,
        preview: (q) => [c.mk('ray', { p: p0, dir: norm(sub(q, p0)) })],
      });
      if (!isPt(p)) break;
      c.add(c.mk('ray', { p: p0, dir: norm(sub(p, p0)) }));
    }
  }

  // ------------------------------------------------------------------ PLINE
  /** @private The rubber band of PLINE: the segments so far plus the next one. */
  static plinePreview(c, pts, closed = false) {
    return c.mk('pline', { pts: pts.map((p) => ({ ...p })), closed });
  }

  /** PLINE: a polyline with straight and arc segments. */
  static async pline(c) {
    const p0 = await c.point('Specify start point');
    if (!isPt(p0)) return;
    const pts = [bp(p0)];
    let arcMode = false;
    let tangent = 0;
    let ent = null;
    const draw = () => {
      if (ent) c.erase([ent]);
      ent = pts.length > 1 ? c.add(DrawCommands.plinePreview(c, pts)) : null;
    };
    const startTan = () => {
      if (pts.length < 2) return tangent;
      const a = pts[pts.length - 2];
      const b = pts[pts.length - 1];
      if (a.b) {
        const ar = G.bulgeArc(a, b, a.b);
        const end = ang(ar.c, b);
        return a.b > 0 ? end + Math.PI / 2 : end - Math.PI / 2;
      }
      return ang(a, b);
    };
    for (;;) {
      const last = pts[pts.length - 1];
      if (!arcMode) {
        const kws = [];
        if (pts.length > 1) kws.push('Close');
        kws.push('Arc');
        if (pts.length > 1) kws.push('Undo');
        const p = await c.point('Specify next point', {
          base: last,
          kw: kws,
          preview: (q) => [DrawCommands.plinePreview(c, [...pts, bp(q)])],
        });
        if (p === null) break;
        if (p === 'Arc') {
          arcMode = true;
          continue;
        }
        if (p === 'Undo') {
          if (pts.length > 1) {
            pts.pop();
            draw();
          }
          continue;
        }
        if (p === 'Close') {
          if (ent) c.erase([ent]);
          ent = c.add(DrawCommands.plinePreview(c, pts, true));
          ent = null;
          break;
        }
        pts.push(bp(p));
        tangent = ang(last, p);
        draw();
      } else {
        const t = startTan();
        const arcPts = (q, tn) => {
          const ch = ang(last, q);
          const phi = G.normAng(ch - tn + Math.PI) - Math.PI;
          return Math.abs(Math.abs(phi) - Math.PI / 2) > 1.55 ? 0 : Math.tan(phi / 2);
        };
        const kws = ['Line', 'Second pt'];
        if (pts.length > 1) kws.push('Close', 'Undo');
        const p = await c.point('Specify endpoint of arc', {
          base: last,
          kw: kws,
          preview: (q) => {
            const l = pts.slice(0, -1).concat([{ ...last, b: arcPts(q, t) }, bp(q)]);
            return [DrawCommands.plinePreview(c, l)];
          },
        });
        if (p === null) break;
        if (p === 'Line') {
          arcMode = false;
          continue;
        }
        if (p === 'Undo') {
          if (pts.length > 1) {
            pts.pop();
            draw();
          }
          continue;
        }
        if (p === 'Close') {
          const q = pts[0];
          last.b = arcPts(q, t);
          if (ent) c.erase([ent]);
          ent = c.add(DrawCommands.plinePreview(c, pts, true));
          ent = null;
          break;
        }
        if (p === 'Second pt') {
          const s = await c.point('Specify second point on arc', {
            base: last,
            noOrtho: true,
            preview: (q) => [DrawCommands.plinePreview(c, [...pts, bp(q)])],
          });
          if (!isPt(s)) continue;
          const e = await c.point('Specify end point of arc', {
            base: s,
            noOrtho: true,
            preview: (q) => {
              const a = DrawCommands.threePointArc(last, s, q);
              return a
                ? [
                    DrawCommands.plinePreview(
                      c,
                      pts.slice(0, -1).concat([{ ...last, b: a.bulge }, bp(q)]),
                    ),
                  ]
                : [];
            },
          });
          if (!isPt(e)) continue;
          const a = DrawCommands.threePointArc(last, s, e);
          if (a) {
            last.b = a.bulge;
            pts.push(bp(e));
            draw();
          }
          continue;
        }
        last.b = arcPts(p, t);
        pts.push(bp(p));
        draw();
      }
    }
    void P0;
  }

  /** @private An arc through three points. */
  static threePointArc(p1, p2, p3) {
    const a = p1;
    const b = p2;
    const d = p3;
    const D = 2 * (a.x * (b.y - d.y) + b.x * (d.y - a.y) + d.x * (a.y - b.y));
    if (Math.abs(D) < 1e-12) return null;
    const ux =
      ((a.x ** 2 + a.y ** 2) * (b.y - d.y) +
        (b.x ** 2 + b.y ** 2) * (d.y - a.y) +
        (d.x ** 2 + d.y ** 2) * (a.y - b.y)) /
      D;
    const uy =
      ((a.x ** 2 + a.y ** 2) * (d.x - b.x) +
        (b.x ** 2 + b.y ** 2) * (a.x - d.x) +
        (d.x ** 2 + d.y ** 2) * (b.x - a.x)) /
      D;
    const c = { x: ux, y: uy };
    const r = dist(c, a);
    const ccw = G.cross(sub(b, a), sub(d, b)) > 0;
    const a0 = ang(c, a);
    const a2 = ang(c, d);
    const th = ccw ? G.sweep(a0, a2) : -G.sweep(a2, a0);
    return { c, r, a0: ccw ? a0 : a2, a1: ccw ? a2 : a0, ccw, bulge: Math.tan(th / 4) };
  }

  // ------------------------------------------------------------------ CIRCLE / ARC / ELLIPSE
  /** CIRCLE: centre + radius / diameter, 2 points, 3 points, tangent-tangent-radius. */
  static async circle(c) {
    const pre = c.arg;
    const o =
      pre === '3p'
        ? '3P'
        : pre === '2p'
          ? '2P'
          : pre === 'ttr'
            ? 'Ttr'
            : await c.point('Specify center point for circle or [3P/2P/Ttr (tan tan radius)]', {
                kw: ['3P', '2P', 'Ttr'],
              });
    if (o === null) return;
    const circ = (cc, r) => c.mk('circle', { c: cc, r });
    if (o === '3P') {
      const a = await c.point('Specify first point on circle');
      if (!isPt(a)) return;
      const b = await c.point('Specify second point on circle', { base: a, noOrtho: true });
      if (!isPt(b)) return;
      const d = await c.point('Specify third point on circle', {
        base: b,
        noOrtho: true,
        rubber: false,
        preview: (q) => {
          const k = DrawCommands.threePointArc(a, b, q);
          return k ? [circ(k.c, k.r)] : [];
        },
      });
      if (!isPt(d)) return;
      const k = DrawCommands.threePointArc(a, b, d);
      if (!k) return c.fail('Points are collinear.');
      c.add(circ(k.c, k.r));
      return;
    }
    if (o === '2P') {
      const a = await c.point("Specify first end point of circle's diameter");
      if (!isPt(a)) return;
      const b = await c.point("Specify second end point of circle's diameter", {
        base: a,
        rubber: false,
        preview: (q) => [circ(G.mid(a, q), dist(a, q) / 2)],
      });
      if (!isPt(b)) return;
      c.add(circ(G.mid(a, b), dist(a, b) / 2));
      return;
    }
    if (o === 'Ttr') {
      const r1 = await c.pick('Specify point on object for first tangent of circle', {
        filter: (e) => ['line', 'circle', 'arc'].includes(e.type),
      });
      if (!r1 || !r1.e) return;
      const r2 = await c.pick('Specify point on object for second tangent of circle', {
        filter: (e) => ['line', 'circle', 'arc'].includes(e.type),
      });
      if (!r2 || !r2.e) return;
      const R = await c.dist('Specify radius of circle', { def: c.app.lastRadius || 10 });
      if (typeof R !== 'number') return;
      const k = O.ttrCircle(r1.e, r1.p, r2.e, r2.p, R);
      if (!k) return c.fail('Circle does not exist.');
      c.app.lastRadius = R;
      c.add(circ(k, R));
      return;
    }
    const center = o;
    const r = await c.dist('Specify radius of circle or [Diameter]', {
      base: center,
      kw: ['Diameter'],
      def: c.app.lastRadius,
      preview: (d) => [circ(center, d)],
    });
    if (r === null) return;
    if (r === 'Diameter') {
      const d = await c.dist('Specify diameter of circle', {
        base: center,
        preview: (dd) => [circ(center, dd / 2)],
      });
      if (typeof d === 'number' && d > 0) {
        c.app.lastRadius = d / 2;
        c.add(circ(center, d / 2));
      }
      return;
    }
    if (typeof r === 'number' && r > 0) {
      c.app.lastRadius = r;
      c.add(circ(center, r));
    }
  }

  /** ARC: three points, or start / centre / end, centre / start / end and the other AutoCAD methods. */
  static async arc(c) {
    const mode = c.arg || '3p';
    const mkarc = (k) => c.mk('arc', { c: k.c, r: k.r, a0: k.a0, a1: k.a1 });
    if (mode === '3p') {
      const a = await c.point('Specify start point of arc or [Center]', { kw: ['Center'] });
      if (a === null) return;
      if (a === 'Center') return DrawCommands.arcSCE(c, null);
      const b = await c.point('Specify second point of arc or [Center/End]', {
        base: a,
        noOrtho: true,
        kw: ['Center', 'End'],
      });
      if (b === null) return;
      if (b === 'Center') return DrawCommands.arcSCE(c, a);
      if (b === 'End') return DrawCommands.arcSER(c, a);
      const d = await c.point('Specify end point of arc', {
        base: b,
        noOrtho: true,
        rubber: false,
        preview: (q) => {
          const k = DrawCommands.threePointArc(a, b, q);
          return k ? [mkarc(k)] : [];
        },
      });
      if (!isPt(d)) return;
      const k = DrawCommands.threePointArc(a, b, d);
      if (!k) return c.fail('Points are collinear.');
      c.add(mkarc(k));
      return;
    }
    if (mode === 'sce' || mode === 'sca' || mode === 'scl')
      return DrawCommands.arcSCE(c, null, mode);
    if (mode === 'cse' || mode === 'csa') return DrawCommands.arcCSE(c, mode);
    if (mode === 'ser' || mode === 'sea' || mode === 'sed')
      return DrawCommands.arcSER(c, null, mode);
    if (mode === 'continue') {
      const last = [...c.app.curEnts()]
        .reverse()
        .find((e) => e.type === 'arc' || e.type === 'line');
      if (!last) return c.fail('No arc or line to continue.');
      const start = last.type === 'line' ? last.p2 : G.arcPt(last, last.a1);
      const tan = last.type === 'line' ? ang(last.p1, last.p2) : last.a1 + Math.PI / 2;
      const e = await c.point('Specify end point of arc', {
        base: start,
        rubber: false,
        preview: (q) => {
          const k = DrawCommands.tangentArc(start, tan, q);
          return k ? [mkarc(k)] : [];
        },
      });
      if (!isPt(e)) return;
      const k = DrawCommands.tangentArc(start, tan, e);
      if (k) c.add(mkarc(k));
      return;
    }
  }

  /** @private An arc that continues the direction of the last segment. */
  static tangentArc(start, tan, end) {
    const ch = ang(start, end);
    const phi = G.normAng(ch - tan + Math.PI) - Math.PI;
    if (Math.abs(Math.sin(phi)) < 1e-9) return null;
    const bulge = Math.tan(phi / 2);
    const a = G.bulgeArc(start, end, bulge);
    return { c: a.c, r: a.r, a0: a.a0, a1: a.a1 };
  }

  /** @private ARC with start, centre and end point. */
  static async arcSCE(c, start0, mode = 'sce') {
    const mkarc = (k) => c.mk('arc', { c: k.c, r: k.r, a0: k.a0, a1: k.a1 });
    let start = start0;
    let center;
    if (!start) {
      start = await c.point('Specify start point of arc');
      if (!isPt(start)) return;
    }
    center = await c.point('Specify center point of arc', { base: start });
    if (!isPt(center)) return;
    const r = dist(center, start);
    const a0 = ang(center, start);
    if (mode === 'sca') {
      const a = await c.angle('Specify included angle', {
        base: center,
        preview: (an) => [mkarc({ c: center, r, a0, a1: a0 + an })],
      });
      if (typeof a !== 'number') return;
      return void c.add(
        mkarc(a < 0 ? { c: center, r, a0: a0 + a, a1: a0 } : { c: center, r, a0, a1: a0 + a }),
      );
    }
    if (mode === 'scl') {
      const L = await c.dist('Specify length of chord', { base: start });
      if (typeof L !== 'number' || L > 2 * r) return;
      return void c.add(mkarc({ c: center, r, a0, a1: a0 + 2 * Math.asin(L / (2 * r)) }));
    }
    const e = await c.point('Specify end point of arc or [Angle/chord Length]', {
      base: center,
      kw: ['Angle', 'chord Length'],
      preview: (q) => [mkarc({ c: center, r, a0, a1: ang(center, q) })],
    });
    if (e === 'Angle') {
      const a = await c.angle('Specify included angle', { base: center });
      if (typeof a === 'number')
        c.add(
          mkarc(a < 0 ? { c: center, r, a0: a0 + a, a1: a0 } : { c: center, r, a0, a1: a0 + a }),
        );
      return;
    }
    if (e === 'chord Length') {
      const L = await c.dist('Specify length of chord', { base: start });
      if (typeof L === 'number' && L <= 2 * r)
        c.add(mkarc({ c: center, r, a0, a1: a0 + 2 * Math.asin(L / (2 * r)) }));
      return;
    }
    if (!isPt(e)) return;
    c.add(mkarc({ c: center, r, a0, a1: ang(center, e) }));
  }

  /** @private ARC with centre, start and end point. */
  static async arcCSE(c, mode) {
    const mkarc = (k) => c.mk('arc', { c: k.c, r: k.r, a0: k.a0, a1: k.a1 });
    const center = await c.point('Specify center point of arc');
    if (!isPt(center)) return;
    const start = await c.point('Specify start point of arc', { base: center });
    if (!isPt(start)) return;
    const r = dist(center, start);
    const a0 = ang(center, start);
    if (mode === 'csa') {
      const a = await c.angle('Specify included angle', {
        base: center,
        preview: (an) => [mkarc({ c: center, r, a0, a1: a0 + an })],
      });
      if (typeof a === 'number')
        c.add(
          mkarc(a < 0 ? { c: center, r, a0: a0 + a, a1: a0 } : { c: center, r, a0, a1: a0 + a }),
        );
      return;
    }
    const e = await c.point('Specify end point of arc', {
      base: center,
      preview: (q) => [mkarc({ c: center, r, a0, a1: ang(center, q) })],
    });
    if (isPt(e)) c.add(mkarc({ c: center, r, a0, a1: ang(center, e) }));
  }

  /** @private ARC with start, end and radius. */
  static async arcSER(c, start0, mode = 'ser') {
    const mkarc = (k) => c.mk('arc', { c: k.c, r: k.r, a0: k.a0, a1: k.a1 });
    let start = start0;
    if (!start) {
      start = await c.point('Specify start point of arc');
      if (!isPt(start)) return;
    }
    const end = await c.point('Specify end point of arc', { base: start });
    if (!isPt(end)) return;
    const chord = dist(start, end);
    if (mode === 'sea') {
      const a = await c.angle('Specify included angle', { base: start });
      if (typeof a !== 'number' || !a) return;
      const R = chord / (2 * Math.sin(Math.abs(a) / 2));
      const bulge = Math.tan(a / 4);
      const ar = G.bulgeArc(start, end, bulge);
      void R;
      return void c.add(mkarc(ar));
    }
    const R = await c.dist('Specify radius of arc', {
      base: start,
      preview: (r) => {
        if (r < chord / 2) return [];
        const ar = G.bulgeArc(start, end, Math.tan(Math.asin(chord / (2 * r)) / 2));
        return [mkarc(ar)];
      },
    });
    if (typeof R !== 'number' || R < chord / 2) return;
    const half = Math.asin(chord / (2 * R));
    const ar = G.bulgeArc(start, end, Math.tan(half / 2));
    c.add(mkarc(ar));
  }

  /** ELLIPSE: by axis end points, or by centre; elliptical arcs. */
  static async ellipse(c) {
    const mode = c.arg;
    let center;
    let mjEnd;
    let o;
    const mkEl = (cc, me, ratio) => c.mk('ellipse', { ...E.makeEllipse(cc, me, ratio) });
    if (mode === 'center') o = 'Center';
    else
      o = await c.point('Specify axis endpoint of ellipse or [Arc/Center]', {
        kw: ['Arc', 'Center'],
      });
    if (o === null) return;
    let arc = mode === 'arc';
    if (o === 'Arc') {
      arc = true;
      o = await c.point('Specify axis endpoint of elliptical arc or [Center]', { kw: ['Center'] });
      if (o === null) return;
    }
    if (o === 'Center') {
      center = await c.point('Specify center of ellipse');
      if (!isPt(center)) return;
      mjEnd = await c.point('Specify endpoint of axis', { base: center });
      if (!isPt(mjEnd)) return;
    } else {
      const a = o;
      const b = await c.point('Specify other endpoint of axis', { base: a });
      if (!isPt(b)) return;
      center = G.mid(a, b);
      mjEnd = b;
    }
    const half = dist(center, mjEnd);
    const q = await c.dist('Specify distance to other axis or [Rotation]', {
      base: center,
      kw: ['Rotation'],
      preview: (d) => [mkEl(center, mjEnd, Math.max(1e-6, d / half))],
    });
    let ratio;
    if (q === 'Rotation') {
      // the ellipse is a circle turned about its major axis: minor / major = cos(rotation)
      const ra = await c.angle('Specify rotation around major axis', { base: center, def: 0 });
      if (typeof ra !== 'number') return;
      const deg = ((((ra * 180) / Math.PI) % 360) + 360) % 360;
      if (deg >= 89.5 && deg <= 270.5)
        return c.echo('The rotation must be between 0 and 89.4 degrees.');
      ratio = Math.max(1e-6, Math.cos(ra));
    } else if (typeof q === 'number' && q > 0) ratio = Math.min(q / half, 1000);
    else return;
    const el = mkEl(center, mjEnd, ratio);
    if (arc) {
      const a0 = await c.angle('Specify start angle', { base: center, def: 0 });
      if (typeof a0 !== 'number') return;
      const a1 = await c.angle('Specify end angle', {
        base: center,
        def: TAU,
        preview: (an) => {
          const k = E.clone(el);
          k.a0 = a0;
          k.a1 = an;
          return [k];
        },
      });
      if (typeof a1 !== 'number') return;
      el.a0 = a0;
      el.a1 = a1 <= a0 ? a1 + TAU : a1;
    }
    c.add(el);
  }

  // ------------------------------------------------------------------ RECTANG / POLYGON / DONUT
  /** RECTANG: a rectangle (chamfer, fillet, area, dimensions and rotation options). */
  static async rectang(c) {
    const st = c.app.rectOpts || (c.app.rectOpts = { fillet: 0, chamfer: 0 });
    // Fillet / Chamfer stay in force for the following rectangles (as in AutoCAD): say so, otherwise rounded rectangles come as a surprise
    const modes = () =>
      [st.fillet > 0 ? `Fillet=${st.fillet}` : '', st.chamfer > 0 ? `Chamfer=${st.chamfer}` : '']
        .filter(Boolean)
        .join(', ');
    if (modes())
      c.echo(
        `Current rectangle modes: ${modes()}  (use the Fillet or Chamfer option with 0 to switch it off)`,
      );
    let p1;
    for (;;) {
      p1 = await c.point('Specify first corner point or [Chamfer/Fillet]', {
        kw: ['Chamfer', 'Fillet'],
      });
      if (p1 === 'Chamfer') {
        const d = await c.dist('Specify chamfer distance for rectangles', { def: st.chamfer });
        if (typeof d === 'number') {
          st.chamfer = d;
          st.fillet = 0;
        }
        continue;
      }
      if (p1 === 'Fillet') {
        const d = await c.dist('Specify fillet radius for rectangles', { def: st.fillet });
        if (typeof d === 'number') {
          st.fillet = d;
          st.chamfer = 0;
        }
        continue;
      }
      break;
    }
    if (!isPt(p1)) return;
    let rot = 0; // rotation of the rectangle about its first corner (radians)
    // the rectangle with corner a, the other corner b given in the (rotated) frame of the rectangle
    const build = (a, b) => {
      const u = { x: Math.cos(rot), y: Math.sin(rot) };
      const v = { x: -Math.sin(rot), y: Math.cos(rot) };
      const d = { x: b.x - a.x, y: b.y - a.y };
      const lx = d.x * u.x + d.y * u.y;
      const ly = d.x * v.x + d.y * v.y;
      const at = (s, t) => bp({ x: a.x + u.x * s + v.x * t, y: a.y + u.y * s + v.y * t });
      const e = c.mk('pline', { pts: [at(0, 0), at(lx, 0), at(lx, ly), at(0, ly)], closed: true });
      e._dims = { lx, ly };
      if (st.fillet > 0) e.pts = O.plineCorners(e, st.fillet);
      else if (st.chamfer > 0) e.pts = O.plineCorners(e, st.chamfer, true);
      return e;
    };
    // the other corner given as a length and a width: the point only chooses the quadrant
    const byDims = async (w, h) => {
      const dirOf = (r) => ({
        x: (r.x - p1.x) * Math.cos(rot) + (r.y - p1.y) * Math.sin(rot) >= 0 ? w : -w,
        y: -(r.x - p1.x) * Math.sin(rot) + (r.y - p1.y) * Math.cos(rot) >= 0 ? h : -h,
      });
      const corner = (r) => {
        const q = dirOf(r);
        return {
          x: p1.x + q.x * Math.cos(rot) - q.y * Math.sin(rot),
          y: p1.y + q.x * Math.sin(rot) + q.y * Math.cos(rot),
        };
      };
      const o = await c.point('Specify other corner point (it only chooses the direction)', {
        base: p1,
        rubber: false,
        noOrtho: true,
        preview: (r) => [build(p1, corner(r))],
      });
      if (!isPt(o)) return;
      finish(build(p1, corner(o)));
    };
    const finish = (e) => {
      const { lx, ly } = e._dims;
      delete e._dims;
      if (Math.abs(lx) < 1e-9 || Math.abs(ly) < 1e-9)
        return c.echo('The rectangle has no width or no height, so nothing was drawn.');
      c.add(e);
    };
    for (;;) {
      const q = await c.point('Specify other corner point or [Area/Dimensions/Rotation]', {
        base: p1,
        kw: ['Area', 'Dimensions', 'Rotation'],
        rubber: false,
        noOrtho: true,
        preview: (r) => [build(p1, r)],
      }); // noOrtho: with F8 (ORTHO) on, the opposite corner must stay free, otherwise the rectangle has no width or no height
      if (q === 'Rotation') {
        const a = await c.angle('Specify rotation angle or [Pick points]', {
          base: p1,
          kw: ['Pick points'],
          def: 0,
        });
        if (a === 'Pick points') {
          const r1 = await c.point('Specify first point', {});
          if (!isPt(r1)) return;
          const r2 = await c.point('Specify second point', { base: r1 });
          if (!isPt(r2)) return;
          rot = G.ang(r1, r2);
        } else if (typeof a === 'number') rot = a;
        else return;
        continue;
      }
      if (q === 'Area') {
        const area = await c.number('Enter area of rectangle in current units', {
          def: c.app.rectArea || 100,
        });
        if (typeof area !== 'number') return;
        if (!(area > 0)) return c.echo('The area must be larger than 0.');
        c.app.rectArea = area;
        const by = await c.keyword(
          'Calculate rectangle dimensions based on [Length/Width] <Length>',
          ['Length', 'Width'],
          'Length',
        );
        if (by === null) return;
        const side = await c.dist(
          by === 'Width' ? 'Enter rectangle width' : 'Enter rectangle length',
          { base: p1 },
        );
        if (typeof side !== 'number' || !(side > 0)) return;
        // fillets / chamfers take area away from the corners: the area includes their effect
        const corner =
          st.fillet > 0
            ? (4 - Math.PI) * st.fillet * st.fillet
            : st.chamfer > 0
              ? 2 * st.chamfer * st.chamfer
              : 0;
        const other = (area + corner) / side;
        return void (await byDims(by === 'Width' ? other : side, by === 'Width' ? side : other));
      }
      if (q === 'Dimensions') {
        const w = await c.dist('Specify length for rectangles', { base: p1 });
        if (typeof w !== 'number') return;
        const h = await c.dist('Specify width for rectangles', { base: p1 });
        if (typeof h !== 'number') return;
        return void (await byDims(w, h));
      }
      if (isPt(q)) return void finish(build(p1, q));
      return;
    }
  }

  /** POLYGON: a regular polygon by centre or by edge. */
  static async polygon(c) {
    const n0 = await c.number('Enter number of sides', { def: c.app.polySides || 4 });
    if (typeof n0 !== 'number') return;
    const n = Math.max(3, Math.min(1024, Math.round(n0)));
    c.app.polySides = n;
    const ctr = await c.point('Specify center of polygon or [Edge]', { kw: ['Edge'] });
    if (ctr === null) return;
    const mk = (pts) => c.mk('pline', { pts: pts.map((p) => bp(p)), closed: true });
    if (ctr === 'Edge') {
      const a = await c.point('Specify first endpoint of edge');
      if (!isPt(a)) return;
      const b = await c.point('Specify second endpoint of edge', {
        base: a,
        preview: (q) => [mk(DrawCommands.polyFromEdge(a, q, n))],
      });
      if (!isPt(b)) return;
      return void c.add(mk(DrawCommands.polyFromEdge(a, b, n)));
    }
    const kind = await c.keyword(
      'Enter an option [Inscribed in circle/Circumscribed about circle]',
      ['Inscribed', 'Circumscribed'],
      c.app.polyKind || 'Inscribed',
    );
    if (kind === null && false) return;
    const k = kind || 'Inscribed';
    c.app.polyKind = k;
    const poly = (center, q) => {
      const r = dist(center, q);
      const a0 = ang(center, q);
      const pts = [];
      const R = k === 'Inscribed' ? r : r / Math.cos(Math.PI / n);
      const start = k === 'Inscribed' ? a0 : a0 - Math.PI / n;
      for (let i = 0; i < n; i += 1) pts.push(polar(center, start + (TAU * i) / n, R));
      return pts;
    };
    const q = await c.point('Specify radius of circle', {
      base: ctr,
      preview: (r) => [mk(poly(ctr, r))],
    });
    if (!isPt(q)) return;
    c.add(mk(poly(ctr, q)));
  }

  /** @private The corner points of a regular polygon built on one edge. */
  static polyFromEdge(a, b, n) {
    const side = dist(a, b);
    const R = side / (2 * Math.sin(Math.PI / n));
    const dir = ang(a, b);
    const mid = G.mid(a, b);
    const ctr = add(
      mid,
      mul(perp({ x: Math.cos(dir), y: Math.sin(dir) }), R * Math.cos(Math.PI / n)),
    );
    const a0 = ang(ctr, a);
    const pts = [];
    for (let i = 0; i < n; i += 1) pts.push(polar(ctr, a0 - (TAU * i) / n, R));
    return pts;
  }

  /** DONUT: filled rings. */
  static async donut(c) {
    const st = c.app.donut || (c.app.donut = { id: 0, od: 10 });
    const id = await c.dist('Specify inside diameter of donut', { def: st.id });
    if (typeof id !== 'number') return;
    const od = await c.dist('Specify outside diameter of donut', { def: st.od });
    if (typeof od !== 'number' || od <= 0) return;
    st.id = id;
    st.od = od;
    for (;;) {
      const p = await c.point('Specify center of donut or <exit>', {
        preview: (q) => [c.mk('donut', { c: q, rin: id / 2, rout: od / 2 })],
      });
      if (!isPt(p)) break;
      c.add(c.mk('donut', { c: p, rin: id / 2, rout: od / 2 }));
    }
  }

  /** SPLINE: a smooth curve through points. */
  static async spline(c) {
    const p0 = await c.point('Specify first point');
    if (!isPt(p0)) return;
    const pts = [p0];
    for (;;) {
      const kw = pts.length > 2 ? ['Close', 'Undo'] : ['Undo'];
      const p = await c.point('Specify next point', {
        base: pts[pts.length - 1],
        kw,
        preview: (q) => [c.mk('spline', { pts: [...pts, q], closed: false })],
      });
      if (p === null) break;
      if (p === 'Undo') {
        if (pts.length > 1) pts.pop();
        continue;
      }
      if (p === 'Close') {
        c.add(c.mk('spline', { pts, closed: true }));
        return;
      }
      pts.push(p);
    }
    if (pts.length >= 2) c.add(c.mk('spline', { pts, closed: false }));
  }

  /** POINT: point objects. */
  static async point(c) {
    for (;;) {
      const p = await c.point('Specify a point');
      if (!isPt(p)) break;
      c.add(c.mk('point', { p }));
      if (c.arg === 'single') break;
    }
  }

  /** DDPTYPE: the point style and size. */
  static async pointStyle(c) {
    await c.ui.pointStyleDialog(c);
  }

  /** DIVIDE: points that divide an object into equal parts. */
  static async divide(c) {
    const r = await c.pick('Select object to divide', {
      filter: (e) => ['line', 'circle', 'arc', 'pline', 'ellipse', 'spline'].includes(e.type),
    });
    if (!r || !r.e) return;
    const n = await c.number('Enter the number of segments or [Block]', { kw: ['Block'] });
    if (typeof n !== 'number' || n < 2) return;
    for (const p of O.pointsAlong(r.e, c.doc, 0, Math.round(n))) c.add(c.mk('point', { p }));
  }

  /** MEASURE: points at a fixed distance along an object. */
  static async measure(c) {
    const r = await c.pick('Select object to measure', {
      filter: (e) => ['line', 'circle', 'arc', 'pline', 'ellipse', 'spline'].includes(e.type),
    });
    if (!r || !r.e) return;
    const d = await c.dist('Specify length of segment or [Block]', { kw: ['Block'] });
    if (typeof d !== 'number' || d <= 0) return;
    for (const p of O.pointsAlong(r.e, c.doc, d, 0)) c.add(c.mk('point', { p }));
  }

  // ------------------------------------------------------------------ TEXT
  /** TEXT: single-line text. */
  static async text(c) {
    const doc = c.doc;
    const st = doc.textStyles[doc.curTextStyle] || {};
    let al = 0;
    let p = await c.point(
      `Current text style: "${doc.curTextStyle}"  Text height: ${c.fmt(c.app.textH || st.h || 2.5)}\nSpecify start point of text or [Justify/Style]`,
      { kw: ['Justify', 'Style'] },
    );
    if (p === 'Justify') {
      const j = await c.keyword(
        'Enter an option [Left/Center/Right]',
        ['Left', 'Center', 'Right'],
        'Left',
      );
      al = j === 'Center' ? 1 : j === 'Right' ? 2 : 0;
      p = await c.point('Specify start point of text');
    } else if (p === 'Style') {
      const n = await c.string('Enter style name or [?]', { def: doc.curTextStyle });
      if (n && doc.textStyles[n]) doc.curTextStyle = n;
      p = await c.point('Specify start point of text');
    }
    if (!isPt(p)) return;
    let h = st.h > 0 ? st.h : c.app.textH || 2.5;
    if (!(st.h > 0)) {
      const hh = await c.dist('Specify height', {
        base: p,
        def: h,
        preview: (d) => [c.mk('text', { p, h: Math.max(d, 1e-6), str: 'Abc', rot: 0, al })],
      });
      if (typeof hh !== 'number' || hh <= 0) return;
      h = hh;
      c.app.textH = h;
    }
    const rot = await c.angle('Specify rotation angle of text', { base: p, def: 0, defText: '0' });
    if (typeof rot !== 'number') return;
    let pos = p;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    for (;;) {
      const s = await c.string('Enter text', { def: '', showDef: false });
      if (s === null || s === '') break;
      c.add(c.mk('text', { p: { ...pos }, h, str: s, rot, al }));
      pos = { x: pos.x + sin * h * 1.6, y: pos.y - cos * h * 1.6 };
    }
  }

  /** MTEXT: multiline text. */
  static async mtext(c) {
    const doc = c.doc;
    const p1 = await c.point(
      `Current text style: "${doc.curTextStyle}"  Text height: ${c.fmt(c.app.textH || 2.5)}\nSpecify first corner`,
    );
    if (!isPt(p1)) return;
    const p2 = await c.point('Specify opposite corner', {
      base: p1,
      noOrtho: true,
      rubber: false,
      preview: (q) => [
        c.mk('pline', {
          pts: [bp(p1), bp({ x: q.x, y: p1.y }), bp(q), bp({ x: p1.x, y: q.y })],
          closed: true,
        }),
      ],
    });
    if (!isPt(p2)) return;
    const r = await c.ui.mtextEditor({ str: '', h: c.app.textH || 2.5 });
    if (!r || !r.str.trim()) return;
    c.app.textH = r.h;
    c.add(
      c.mk('mtext', {
        p: { x: Math.min(p1.x, p2.x), y: Math.max(p1.y, p2.y) },
        h: r.h,
        str: r.str,
        rot: 0,
        w: Math.abs(p2.x - p1.x),
        style: doc.curTextStyle,
        al: 0,
      }),
    );
  }

  /** STYLE: the text style window. */
  static async textStyle(c) {
    await c.ui.textStyleDialog(c);
  }

  // ------------------------------------------------------------------ HATCH
  /** HATCH: fills an area with a pattern. */
  static async hatch(c) {
    const st = c.app.hatchOpts || (c.app.hatchOpts = { pattern: 'ANSI31', scale: 1, angle: 0 });
    const ok = await c.ui.hatchDialog(st);
    if (!ok) return;
    for (;;) {
      const r = await c.point(`Pick internal point or [Select objects/Properties]`, {
        kw: ['Select objects', 'Properties'],
        rubber: false,
        noOrtho: true,
        noSnap: true,
      });
      if (r === null) break;
      if (r === 'Properties') {
        if (!(await c.ui.hatchDialog(st))) break;
        continue;
      }
      let loops = null;
      if (r === 'Select objects') {
        const ents = await c.select('Select objects', { pre: false, filter: (e) => E.isClosed(e) });
        if (!ents.length) continue;
        loops = ents.map((e) => E.closedLoop(e)).filter(Boolean);
      } else
        loops = O.findBoundary(
          c.app.curEnts().filter((e) => c.doc.visible(e)),
          c.doc,
          r,
        );
      if (!loops || !loops.length) {
        c.echo('Valid hatch boundary not found.');
        continue;
      }
      const h = c.add(
        c.mk('hatch', { loops, pattern: st.pattern, scale: st.scale, angle: G.rad(st.angle) }),
      );
      if (st.color) h.color = st.color;
      c.echo(`1 loop extracted${loops.length > 1 ? 's (' + loops.length + ')' : ''}.`);
    }
  }

  // ------------------------------------------------------------------ REVCLOUD / TABLE / DRAW MISC
  /** REVCLOUD: a revision cloud. */
  static async revcloud(c) {
    let al = c.app.arcLen || 15;
    let p0;
    for (;;) {
      al = c.app.arcLen || 15;
      p0 = await c.point(
        `Minimum arc length: ${al}  Maximum arc length: ${al}\nSpecify start point or [Arc length/Object] <Object>`,
        { kw: ['Arc length', 'Object'] },
      );
      if (p0 !== 'Arc length') break;
      const d = await c.dist('Specify approximate arc length', { def: al });
      if (typeof d === 'number' && d > 0) c.app.arcLen = d;
    }
    if (p0 === 'Object' || p0 === null) {
      const r = await c.pick('Select object', { filter: (e) => E.isClosed(e) });
      if (!r || !r.e) return;
      const loop = E.closedLoop(r.e);
      return void c.add(
        DrawCommands.cloudFrom(
          c,
          loop,
          al,
          (await c.keyword('Reverse direction [Yes/No]', ['Yes', 'No'], 'No')) === 'Yes',
        ),
      );
    }
    // click the corners of the cloud; clicking the START point again (it is a snap target) or Enter closes it
    const pts = [p0];
    const tol = () => (c.app.settings.aperture || 10) / c.app.activeView().zoom;
    for (;;) {
      const q = await c.point(
        'Specify next point (click the start point or press Enter to close)  [Undo]',
        {
          base: pts[pts.length - 1],
          kw: ['Undo'],
          snapPts: pts,
          rubber: false,
          preview: (p) =>
            pts.length >= 2
              ? [DrawCommands.cloudFrom(c, [...pts, p], al)]
              : [c.mk('pline', { pts: [...pts, p].map((x) => bp(x)), closed: false })],
        },
      );
      if (q === 'Undo') {
        if (pts.length > 1) pts.pop();
        continue;
      }
      if (!isPt(q)) break;
      if (pts.length >= 3 && dist(q, pts[0]) <= tol()) break; // back on the start point: done
      pts.push(q);
    }
    if (pts.length >= 3)
      c.add(
        DrawCommands.cloudFrom(
          c,
          pts,
          al,
          (await c.keyword('Reverse direction [Yes/No]', ['Yes', 'No'], 'No')) === 'Yes',
        ),
      );
    else if (pts.length > 1) c.echo('A revision cloud needs at least three points.');
  }

  /** @private A revision cloud along a list of points. */
  static cloudFrom(c, loop, al, flip = false) {
    // arcs bulge OUTWARD (positive bulge = counter-clockwise = to the right of travel for a counter-clockwise loop)
    const area = G.polyArea(loop);
    const sign = (area > 0 ? 1 : -1) * (flip ? -1 : 1);
    const pts = [];
    for (let i = 0; i < loop.length; i += 1) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      const L = dist(a, b);
      const n = Math.max(1, Math.round(L / al));
      for (let k = 0; k < n; k += 1) pts.push({ ...G.lerp(a, b, k / n), b: 0.5 * sign });
    }
    return c.mk('pline', { pts, closed: true });
  }

  /** TABLE: a table of lines and text. */
  static async table(c) {
    const o = await c.ui.tableDialog();
    if (!o) return;
    const p = await c.point('Specify insertion point', {
      preview: (q) => [
        c.mk('pline', {
          pts: [
            bp(q),
            bp({ x: q.x + o.cols * o.cw, y: q.y }),
            bp({ x: q.x + o.cols * o.cw, y: q.y - o.rows * o.rh }),
            bp({ x: q.x, y: q.y - o.rows * o.rh }),
          ],
          closed: true,
        }),
      ],
    });
    if (!isPt(p)) return;
    for (let r = 0; r <= o.rows; r += 1)
      c.add(
        c.mk('line', {
          p1: { x: p.x, y: p.y - r * o.rh },
          p2: { x: p.x + o.cols * o.cw, y: p.y - r * o.rh },
        }),
      );
    for (let k = 0; k <= o.cols; k += 1)
      c.add(
        c.mk('line', {
          p1: { x: p.x + k * o.cw, y: p.y },
          p2: { x: p.x + k * o.cw, y: p.y - o.rows * o.rh },
        }),
      );
    if (o.title)
      c.add(
        c.mk('text', {
          p: { x: p.x + (o.cw * o.cols) / 2, y: p.y - o.rh * 0.65 },
          h: o.rh * 0.45,
          str: o.title,
          rot: 0,
          al: 1,
        }),
      );
  }

  // ------------------------------------------------------------------ BLOCK / INSERT / WBLOCK
  /** BLOCK: makes a block from objects. */
  static async block(c) {
    const name = await c.string('Enter block name', { def: '' });
    if (!name) return;
    if (c.doc.blocks[name]) {
      const y = await c.keyword(
        `Block "${name}" already exists. Redefine it?`,
        ['Yes', 'No'],
        'No',
      );
      if (y !== 'Yes') return;
    }
    const base = await c.point('Specify insertion base point');
    if (!isPt(base)) return;
    const ents = await c.select('Select objects', { pre: true });
    if (!ents.length) return;
    c.doc.defineBlock(name, base, ents);
    c.erase(ents);
    c.add(c.mk('insert', { name, p: { ...base }, rot: 0, sx: 1, sy: 1 }));
    c.echo(`Block "${name}" defined.`);
  }

  /** WBLOCK: writes objects to a file as a drawing. */
  static async wblock(c) {
    const base = await c.point('Specify insertion base point');
    if (!isPt(base)) return;
    const ents = await c.select('Select objects', { pre: true });
    if (!ents.length) return;
    await c.ui.io.writeBlockFile(c, base, ents);
  }

  /** INSERT: inserts a block. */
  static async insert(c) {
    const o = await c.ui.insertDialog(c);
    if (!o) return;
    const mk = (p) => c.mk('insert', { name: o.name, p, rot: G.rad(o.rot), sx: o.sx, sy: o.sy });
    const p = await c.point('Specify insertion point or [Scale/Rotate]', {
      preview: (q) => [mk(q)],
    });
    if (!isPt(p)) return;
    const ins = mk(p);
    const defs = (c.doc.blocks[o.name] ? c.doc.blocks[o.name].ents : []).filter((x) => x.attdef);
    if (defs.length) {
      ins.attribs = {};
      for (const x of defs) {
        const v = await c.string(`${x.attdef.prompt}`, {
          def: x.attdef.def,
          defText: x.attdef.def,
        });
        ins.attribs[x.attdef.tag] = v === null ? x.attdef.def : v;
      }
    }
    c.add(ins);
  }

  /** PURGE: removes unused blocks, layers and styles. */
  static async purge(c) {
    const used = new Set();
    let n = 0;
    const scan = (ents) =>
      ents.forEach((e) => {
        used.add(e.layer);
        if (e.type === 'insert') used.add('blk:' + e.name);
      });
    scan(c.doc.model);
    Object.values(c.doc.layouts).forEach((l) => scan(l.ents));
    Object.values(c.doc.blocks).forEach((b) => scan(b.ents));
    c.doc.layers = c.doc.layers.filter((l) => {
      const keep = l.name === '0' || used.has(l.name) || l.name === c.doc.cur.layer;
      if (!keep) n += 1;
      return keep;
    });
    for (const nm of Object.keys(c.doc.blocks))
      if (!used.has('blk:' + nm)) {
        delete c.doc.blocks[nm];
        n += 1;
      }
    c.doc.blockVer += 1;
    c.echo(`${n} unused item(s) purged.`);
  }

  // ------------------------------------------------------------------ DIMENSIONS
  /** @private The first dimension line location for the dimension commands. */
  static dimBase(c, props) {
    return c.stamp(E.mk('dim', props));
  }

  /** @private The direction (horizontal / vertical) a linear dimension takes from the dimension line location. */
  static autoRot(p1, p2, loc) {
    const x0 = Math.min(p1.x, p2.x);
    const x1 = Math.max(p1.x, p2.x);
    const y0 = Math.min(p1.y, p2.y);
    const y1 = Math.max(p1.y, p2.y);
    const dxOut = loc.x < x0 ? x0 - loc.x : loc.x > x1 ? loc.x - x1 : 0;
    const dyOut = loc.y < y0 ? y0 - loc.y : loc.y > y1 ? loc.y - y1 : 0;
    return dyOut >= dxOut ? 0 : Math.PI / 2;
  }

  /** @private Asks for the two extension line origins (or an object to take them from). */
  static async dimOrigins(c, prompt) {
    const p1 = await c.point(`Specify first extension line origin or <select object>`);
    if (isPt(p1)) {
      const p2 = await c.point('Specify second extension line origin', { base: p1 });
      if (!isPt(p2)) return null;
      return { p1, p2 };
    }
    const r = await c.pick(prompt || 'Select object to dimension', {
      filter: (e) => e.type === 'line' || e.type === 'arc',
    });
    if (!r || !r.e) return null;
    const e = r.e;
    return e.type === 'line'
      ? { p1: e.p1, p2: e.p2 }
      : { p1: G.arcPt(e, e.a0), p2: G.arcPt(e, e.a1) };
  }

  /** @private DIMLINEAR and DIMALIGNED. */
  static async dimLinearLike(c, aligned) {
    const org = await DrawCommands.dimOrigins(c);
    if (!org) return;
    let forced = aligned ? null : c.arg === 'h' ? 0 : c.arg === 'v' ? Math.PI / 2 : null;
    let text = null;
    let fixedRot = null;
    const mkd = (loc) => {
      const rot = aligned ? 0 : (fixedRot ?? forced ?? DrawCommands.autoRot(org.p1, org.p2, loc));
      const d = DrawCommands.dimBase(c, {
        kind: aligned ? 'ali' : 'lin',
        p1: org.p1,
        p2: org.p2,
        dp: loc,
        rot,
      });
      if (text) d.text = text;
      return d;
    };
    for (;;) {
      const kws = aligned
        ? ['Mtext', 'Text', 'Angle']
        : ['Mtext', 'Text', 'Angle', 'Horizontal', 'Vertical', 'Rotated'];
      const loc = await c.point(`Specify dimension line location or [${kws.join('/')}]`, {
        base: G.mid(org.p1, org.p2),
        rubber: false,
        kw: kws,
        preview: (q) => [mkd(q)],
      });
      if (loc === 'Horizontal') {
        forced = 0;
        fixedRot = null;
        continue;
      }
      if (loc === 'Vertical') {
        forced = Math.PI / 2;
        fixedRot = null;
        continue;
      }
      if (loc === 'Rotated') {
        const a = await c.angle('Specify angle of dimension line', { def: 0 });
        if (typeof a === 'number') fixedRot = a;
        continue;
      }
      if (loc === 'Text') {
        const t = await c.string('Enter dimension text', { def: '<>' });
        if (t !== null) text = t;
        continue;
      }
      if (loc === 'Mtext') {
        const r = await c.ui.mtextEditor({ str: '<>', h: c.app.textH || 2.5 });
        if (r && r.str.trim()) text = r.str.trim().replace(/\s*\n\s*/g, ' ');
        continue;
      } // <> stands for the measured value
      if (loc === 'Angle') {
        c.echo('Text angle is automatic in this version.');
        continue;
      }
      if (!isPt(loc)) return;
      const d = c.add(mkd(loc));
      c.app.lastDim = d;
      return;
    }
  }

  /** @private DIMRADIUS and DIMDIAMETER. */
  static async dimRadDia(c, kind) {
    const r = await c.pick('Select arc, circle or rounded corner', { filter: ARC_PICK });
    if (!r || !r.e) return;
    const e = arcOfPick(c, r);
    if (!e) return c.fail('There is no arc at that point.');
    const mkd = (loc) => DrawCommands.dimBase(c, { kind, c: e.c, r: e.r, p: loc });
    const loc = await c.point(`Specify dimension line location or [Mtext/Text/Angle]`, {
      base: e.c,
      preview: (q) => [mkd(q)],
    });
    if (!isPt(loc)) return;
    c.app.lastDim = c.add(mkd(loc));
  }

  /** DIMANGULAR: the angle between two lines, at an arc or at three points. */
  static async dimAngular(c) {
    const r = await c.pick('Select arc, circle, rounded corner, line, or <specify vertex>', {
      filter: (e) => ['arc', 'circle', 'line'].includes(e.type) || ARC_PICK(e),
    });
    let vertex;
    let a;
    let b;
    if (r === null) {
      vertex = await c.point('Specify angle vertex');
      if (!isPt(vertex)) return;
      a = await c.point('Specify first angle endpoint', { base: vertex });
      if (!isPt(a)) return;
      b = await c.point('Specify second angle endpoint', { base: vertex });
      if (!isPt(b)) return;
    } else if (r.e) {
      const e = r.e;
      if (e.type === 'arc' || e.type === 'pline') {
        const g = arcOfPick(c, r);
        if (!g) return c.fail('There is no arc at that point.');
        vertex = g.c;
        a = G.arcPt(g, g.a0);
        b = G.arcPt(g, g.a1);
      } else if (e.type === 'circle') {
        vertex = e.c;
        a = r.p;
        const p2 = await c.point('Specify second angle endpoint', { base: e.c });
        if (!isPt(p2)) return;
        b = p2;
      } else {
        const r2 = await c.pick('Select second line', { filter: (x) => x.type === 'line' });
        if (!r2 || !r2.e) return;
        const h = G.lineLine(e.p1, e.p2, r2.e.p1, r2.e.p2);
        if (!h) return c.fail('Lines are parallel.');
        vertex = h.p;
        const far = (l, click) => (dist(l.p1, click) < dist(l.p2, click) ? l.p1 : l.p2);
        a = far(e, r.p);
        b = far(r2.e, r2.p);
        // pick the ends such that rays go away from vertex
        const dirA =
          dist(a, vertex) < 1e-9 ? sub(a === e.p1 ? e.p2 : e.p1, vertex) : sub(a, vertex);
        const dirB =
          dist(b, vertex) < 1e-9 ? sub(b === r2.e.p1 ? r2.e.p2 : r2.e.p1, vertex) : sub(b, vertex);
        a = add(vertex, dirA);
        b = add(vertex, dirB);
      }
    } else return;
    const mkd = (loc) => DrawCommands.dimBase(c, { kind: 'ang', c: vertex, p1: a, p2: b, dp: loc });
    const loc = await c.point(
      'Specify dimension arc line location or [Mtext/Text/Angle/Quadrant]',
      {
        base: vertex,
        preview: (q) => [mkd(q)],
      },
    );
    if (!isPt(loc)) return;
    c.app.lastDim = c.add(mkd(loc));
  }

  /** @private DIMCONTINUE and DIMBASELINE. */
  static async dimChain(c, baseline) {
    let d = c.app.lastDim && c.app.curEnts().includes(c.app.lastDim) ? c.app.lastDim : null;
    if (!d) {
      const r = await c.pick(`Select ${baseline ? 'base' : 'continued'} dimension`, {
        filter: (e) => e.type === 'dim' && (e.kind === 'lin' || e.kind === 'ali'),
      });
      if (!r || !r.e) return;
      d = r.e;
    }
    if (d.kind !== 'lin' && d.kind !== 'ali')
      return c.fail('Select a linear or aligned dimension.');
    const ds = E.dimStyleOf(d, c.doc);
    let cur = d;
    let anchor = baseline ? d.p1 : d.p2;
    for (;;) {
      const p = await c.point(`Specify a second extension line origin or [Undo/Select]`, {
        base: cur.p2,
        kw: ['Undo', 'Select'],
        rubber: false,
      });
      if (p === null) break;
      if (p === 'Select') {
        const r = await c.pick('Select continued dimension', { filter: (e) => e.type === 'dim' });
        if (r && r.e) {
          cur = r.e;
          anchor = baseline ? cur.p1 : cur.p2;
        }
        continue;
      }
      if (!isPt(p)) break;
      const rot = d.kind === 'ali' ? 0 : d.rot;
      const n = DrawCommands.dimBase(c, {
        kind: d.kind,
        p1: anchor,
        p2: p,
        dp: { ...cur.dp },
        rot,
      });
      if (baseline) {
        const u = d.kind === 'ali' ? ang(cur.p1, cur.p2) : cur.rot;
        const nn = { x: -Math.sin(u), y: Math.cos(u) };
        const off = G.dot(sub(cur.dp, cur.p1), nn);
        const step = ds.bs || ds.h * 1.5 + ds.gap * 2.4; // baseline spacing from the dimension style
        n.dp = add(
          cur.p1,
          add(
            mul(nn, off + Math.sign(off || 1) * step),
            mul({ x: Math.cos(u), y: Math.sin(u) }, 0),
          ),
        );
        n.dp = add(n.p1, mul(nn, off + Math.sign(off || 1) * step));
      }
      c.add(n);
      c.app.lastDim = n;
      cur = baseline ? n : n;
      if (!baseline) anchor = p;
      if (baseline) cur = n;
    }
  }

  /** MLEADER: a leader with multiline text. */
  static async mleader(c) {
    const a = await c.point('Specify leader arrowhead location');
    if (!isPt(a)) return;
    const b = await c.point('Specify leader landing location', { base: a });
    if (!isPt(b)) return;
    const ds = E.dimStyleOf({ style: c.doc.curDimStyle }, c.doc);
    const t = await c.ui.mtextEditor({ str: '', h: ds.h });
    if (!t || !t.str.trim()) return;
    const dirx = b.x >= a.x ? 1 : -1;
    const sh = ds.asz * 1.2;
    const land = { x: b.x + dirx * sh, y: b.y };
    const tp = {
      x: land.x + dirx * ds.gap,
      y: land.y - (t.str.split('\n').length === 1 ? ds.h / 2 : 0),
    };
    const e = c.mk('leader', {
      pts: [a, b, land],
      str: t.str,
      h: t.h,
      tp: dirx > 0 ? tp : { x: tp.x - E.measure(t.str.split('\n')[0], t.h, null), y: tp.y },
      style: c.doc.curDimStyle,
    });
    c.add(e);
  }

  /** LEADER: a leader line with text. */
  static async leader(c) {
    const a = await c.point('Specify leader start point');
    if (!isPt(a)) return;
    const pts = [a];
    for (;;) {
      const p = await c.point('Specify next point', {
        base: pts[pts.length - 1],
        preview: (q) => [c.mk('leader', { pts: [...pts, q], str: '', h: 2.5, tp: null })],
      });
      if (!isPt(p)) break;
      pts.push(p);
    }
    if (pts.length < 2) return;
    const ds = E.dimStyleOf({ style: c.doc.curDimStyle }, c.doc);
    const t = await c.ui.mtextEditor({ str: '', h: ds.h });
    const last = pts[pts.length - 1];
    c.add(
      c.mk('leader', {
        pts,
        str: t ? t.str : '',
        h: t ? t.h : ds.h,
        tp: { x: last.x + ds.gap, y: last.y },
        style: c.doc.curDimStyle,
      }),
    );
  }

  /** DIMSTYLE: the dimension style window. */
  static async dimStyle(c) {
    await c.ui.dimStyleDialog(c);
  }

  /** MLEADERSTYLE: opens the dimension style window. */
  static async mleaderStyle(c) {
    await c.ui.dimStyleDialog(c);
  }

  /** Registers the commands of this file in their original order (a later definition of a name wins). */
  static register() {
    def('LINE L', DrawCommands.line);
    def('XLINE XL', DrawCommands.xline);
    def('RAY', DrawCommands.ray);
    def('PLINE PL', DrawCommands.pline);
    def('CIRCLE C', DrawCommands.circle);
    def('ARC A', DrawCommands.arc);
    def('ELLIPSE EL', DrawCommands.ellipse);
    def('RECTANG REC', DrawCommands.rectang);
    def('POLYGON POL', DrawCommands.polygon);
    def('DONUT DO DOUGHNUT', DrawCommands.donut);
    def('SPLINE SPL', DrawCommands.spline);
    def('POINT PO', DrawCommands.point);
    def('DDPTYPE', DrawCommands.pointStyle);
    def('DIVIDE DIV', DrawCommands.divide);
    def('MEASURE ME', DrawCommands.measure);
    def('TEXT DT DTEXT', DrawCommands.text);
    def('MTEXT MT T', DrawCommands.mtext);
    def('STYLE ST', DrawCommands.textStyle);
    def('HATCH H BHATCH BH', DrawCommands.hatch);
    def('REVCLOUD', DrawCommands.revcloud);
    def('TABLE TB', DrawCommands.table);
    def('BLOCK B', DrawCommands.block);
    def('WBLOCK W', DrawCommands.wblock);
    def('INSERT I DDINSERT', DrawCommands.insert);
    def('PURGE PU', DrawCommands.purge);
    def('DIMLINEAR DLI DIMLIN', (c) => DrawCommands.dimLinearLike(c, false));
    def('DIMALIGNED DAL DIMALI', (c) => DrawCommands.dimLinearLike(c, true));
    def('DIMRADIUS DRA DIMRAD', (c) => DrawCommands.dimRadDia(c, 'rad'));
    def('DIMDIAMETER DDI DIMDIA', (c) => DrawCommands.dimRadDia(c, 'dia'));
    def('DIMANGULAR DAN DIMANG', DrawCommands.dimAngular);
    def('DIMCONTINUE DCO DIMCONT', async (c) => DrawCommands.dimChain(c, false));
    def('DIMBASELINE DBA DIMBASE', async (c) => DrawCommands.dimChain(c, true));
    def('MLEADER MLD MLEA', DrawCommands.mleader);
    def('LEADER LEAD LE', DrawCommands.leader);
    def('DIMSTYLE D DIMSTY DDIM', DrawCommands.dimStyle);
    def('MLEADERSTYLE MLS', DrawCommands.mleaderStyle);
    def('MLEADEREDIT MLE', async (c) =>
      c.echo(
        'MLEADEREDIT: use grips to move the arrowhead, landing or text; DDEDIT edits the text.',
      ),
    );
  }
}

DrawCommands.register();
