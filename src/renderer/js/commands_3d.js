/**
 * @file commands_3d.js
 * @brief The 3D solid and 3D view commands: BOX, CYLINDER, SPHERE, CONE, WEDGE, TORUS, PYRAMID,
 *        EXTRUDE, REVOLVE, UNION / SUBTRACT / INTERSECT, FILLETEDGE, CHAMFEREDGE, SLICE, 3DMOVE,
 *        ROTATE3D, 3DMIRROR, 3DARRAY, TAPERFACES, VIEW3D, 3D / 2D, VSCURRENT, MASSPROP, FLATSHOT.
 *
 * The kernel calls are in kernel3d.js; the commands ask for the points and values.
 */

/* ============================================================================================
 * 1. INCLUDES AND HELPERS
 * ========================================================================================== */
import { def, alias, COMMANDS } from './registry.js';
import * as G from './geom.js';
import * as E from './entities.js';
import * as K from './kernel3d.js';
import * as H from './hybrid3d.js';
import * as CV from './curve3d.js';
import { canStand3d, rotateCurve3d, mirrorCurve3d } from './xform3d.js';
import { PRESET_LABELS } from './view3d.js';
import { flatten, fitInto, place } from './flatshot.js';
import * as O from './ops.js';
import * as S3 from './selection3d.js';
import { union2D, subtract2D, intersect2D } from './commands_more.js';
const def3d = (names, fn, opts = {}) => def(names, fn, { ...opts, feature: '3d' });
const masspropRegions = COMMANDS.MASSPROP && COMMANDS.MASSPROP.fn;
const isPt = (v) => v && typeof v === 'object' && 'x' in v;
const zOf = (p) => p.z || 0;
const bp = (p, b = 0) => ({ x: p.x, y: p.y, b });
const modelBody = (e) => e.type === 'solid3d';
const solidsOnly = (e) => e.type === 'solid3d' && e.bodyKind !== 'sheet';
// ------------------------------------------------------------------ vertical drag for heights in 3D views
const HEIGHT_OPTS = (base) => ({ base, vertical: true });
const profileEntities = (e) => E.isClosed(e) && e.type !== 'hatch';
const looseEntities = (e) =>
  e.type === 'line' || e.type === 'arc' || (e.type === 'pline' && !e.closed);
// ------------------------------------------------------------------ booleans (3D, falling back to the 2D polygon versions)
const baked = (e) => K.bakedShape(e);
/** Actual topology is authoritative; bodyKind may be stale in drawings saved by older versions. */
const booleanShapes = (c, ents, operation) => {
  const shapes = ents.map(baked), bad = [];
  shapes.forEach((shape, index) => {
    const status = H.topologyStatus(shape, c.app.settings.modelingTolerance ?? 1e-6);
    if (!status.booleanReady) bad.push({ entity: ents[index], status });
  });
  if (bad.length) {
    const first = bad[0].status;
    c.fail(`${operation}: ${bad.length} selected 3D body/bodies are open sheets, not watertight solids (${first.freeEdges} free boundary edge(s), ${first.multipleEdges} non-manifold edge(s)). Finish them with Fill Boundary + SEW or PATCH, then retry.`);
  }
  return shapes;
};
// ------------------------------------------------------------------ draft (taper) of the side faces
// rebuild a prism (box / extrusion) so that every side face leans by `ang` degrees; positive = inward toward the top
// angles = one number for every side face, or [[angle per profile edge] per loop] for individual faces
const anglesOf = (e) =>
  e.src.angles
    ? e.src.angles.map((l) => [...l])
    : e.src.loops.map((l) => l.map(() => e.src.taper || 0));
// ------------------------------------------------------------------ views, visual styles
const VIEW_KW = {
  Top: 'top',
  Bottom: 'bottom',
  Front: 'front',
  Back: 'back',
  Left: 'left',
  Right: 'right',
  'SW Isometric': 'swiso',
  'SE Isometric': 'seiso',
  'NE Isometric': 'neiso',
  'NW Isometric': 'nwiso',
};

/* ============================================================================================
 * 2. CLASS
 * ========================================================================================== */

/** The 3D solid and 3D view commands. Every command is a static method `(c) => Promise`; `register()` adds them all. */
export class Solid3dCommands {
  /** @private Loads the 3D kernel when it is not loaded yet. */
  static async ensureKernel(c) {
    if (K.kernelReady()) return;
    c.echo('Loading the 3D solid kernel (OpenCascade)...');
    try {
      await K.initKernel();
    } catch (e) {
      c.fail(`The 3D kernel could not be loaded: ${e.message}`);
    }
  }

  /** @private The bounding box of a shape as {x0, y0, z0, x1, y1, z1}. */
  static boundsOf(shape) {
    const b = shape.boundingBox.bounds;
    return { x0: b[0][0], y0: b[0][1], z0: b[0][2], x1: b[1][0], y1: b[1][1], z1: b[1][2] };
  }

  // src = how a prism was made ({kind:'prism', loops, z0, h, taper}): lets TAPERFACES rebuild it with a draft angle
  /** @private A new solid entity for a shape (`src` tells how a prism was made, so TAPERFACES can rebuild it with a draft angle). */
  static solidEntity(c, shape, like, src) {
    const e = c.mk('solid3d', {
      ...K.solidProps(shape),
      bodyKind: H.kind(shape),
      bb: Solid3dCommands.boundsOf(shape),
      ...(src ? { src } : {}),
    });
    if (like) {
      e.layer = like.layer;
      e.color = like.color;
      e.ltype = like.ltype;
      e.lw = like.lw;
    }
    return e;
  }

  /** @private A temporary solid entity for the preview of a command. */
  static tempEntity(shape) {
    const e = E.mk('solid3d', { ...K.solidProps(shape), bb: Solid3dCommands.boundsOf(shape) });
    e.id = -1;
    e._temp = true;
    return e;
  }

  /** @private Runs a function and returns `fallback` when it throws. */
  static safely(fn, fallback = []) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  // ------------------------------------------------------------------ primitives
  /** BOX: a box from a corner (or the centre) with width, depth and height. */
  static async box(c) {
    await Solid3dCommands.ensureKernel(c);
    let center = false;
    let p1 = await c.point('Specify first corner or [Center]', { kw: ['Center'], noOrtho: true });
    if (p1 === 'Center') {
      center = true;
      p1 = await c.point('Specify center');
    }
    if (!isPt(p1)) return;
    const rect = (q) => {
      const x0 = center ? p1.x - Math.abs(q.x - p1.x) : Math.min(p1.x, q.x);
      const y0 = center ? p1.y - Math.abs(q.y - p1.y) : Math.min(p1.y, q.y);
      return {
        x0,
        y0,
        w: center ? 2 * Math.abs(q.x - p1.x) : Math.abs(q.x - p1.x),
        d: center ? 2 * Math.abs(q.y - p1.y) : Math.abs(q.y - p1.y),
      };
    };
    const prev = (q) => {
      const r = rect(q);
      const t = E.mk('pline', {
        pts: [
          bp({ x: r.x0, y: r.y0 }),
          bp({ x: r.x0 + r.w, y: r.y0 }),
          bp({ x: r.x0 + r.w, y: r.y0 + r.d }),
          bp({ x: r.x0, y: r.y0 + r.d }),
        ],
        closed: true,
      });
      t._dash = [4, 4];
      return [t];
    };
    let p2 = await c.point(`Specify ${center ? 'a' : 'other'} corner or [Cube/Length]`, {
      base: p1,
      noOrtho: true,
      kw: ['Cube', 'Length'],
      rubber: false,
      preview: prev,
    });
    if (p2 === null) return;
    let w;
    let d;
    let cube = false;
    if (p2 === 'Cube') {
      cube = true;
      const L = await c.dist('Specify length', { base: p1 });
      if (typeof L !== 'number') return;
      w = d = Math.abs(L);
      p2 = { x: p1.x + w, y: p1.y + d };
    } else if (p2 === 'Length') {
      const L = await c.dist('Specify length', { base: p1 });
      const W = await c.dist('Specify width', { base: p1 });
      if (typeof L !== 'number' || typeof W !== 'number') return;
      w = Math.abs(L);
      d = Math.abs(W);
      p2 = { x: p1.x + w, y: p1.y + d };
    } else if (!isPt(p2)) return;
    const r =
      center && !(w && d)
        ? rect(p2)
        : center
          ? { x0: p1.x - w / 2, y0: p1.y - d / 2, w, d }
          : rect(p2);
    if (w && !center) {
      r.x0 = p1.x;
      r.y0 = p1.y;
      r.w = w;
      r.d = d;
    }
    if (r.w < 1e-9 || r.d < 1e-9) return c.fail('The base is degenerate.');
    const z0 = zOf(p1);
    // a cube has equal sides: the height is the length already given
    const h = cube ? w : await c.dist('Specify height', {
      ...HEIGHT_OPTS({ x: p2.x ?? p1.x, y: p2.y ?? p1.y, z: z0 }),
      preview: (dd) =>
        Math.abs(dd) > 1e-9
          ? [
              Solid3dCommands.tempEntity(
                K.makeBox(r.w, r.d, Math.abs(dd), r.x0, r.y0, dd < 0 ? z0 + dd : z0),
              ),
            ]
          : [],
    });
    if (typeof h !== 'number' || Math.abs(h) < 1e-9) return;
    const zb = h < 0 ? z0 + h : z0;
    const hh = Math.abs(h);
    const loop = [
      { x: r.x0, y: r.y0, b: 0 },
      { x: r.x0 + r.w, y: r.y0, b: 0 },
      { x: r.x0 + r.w, y: r.y0 + r.d, b: 0 },
      { x: r.x0, y: r.y0 + r.d, b: 0 },
    ];
    c.add(
      Solid3dCommands.solidEntity(c, K.makeBox(r.w, r.d, hh, r.x0, r.y0, zb), null, {
        kind: 'prism',
        loops: [loop],
        z0: zb,
        h: hh,
        taper: 0,
      }),
    );
  }

  /** CYLINDER: a cylinder from a centre, a radius and a height. */
  static async cylinder(c) {
    await Solid3dCommands.ensureKernel(c);
    const ctr = await c.point('Specify center point of base');
    if (!isPt(ctr)) return;
    const z0 = zOf(ctr);
    const r = await c.dist('Specify base radius or [Diameter]', {
      base: ctr,
      kw: ['Diameter'],
      def: c.app.cylR,
    });
    let R;
    if (r === 'Diameter') {
      const d = await c.dist('Specify diameter', { base: ctr });
      if (typeof d !== 'number') return;
      R = d / 2;
    } else if (typeof r === 'number') R = r;
    else return;
    if (R <= 0) return c.fail('The radius must be positive.');
    c.app.cylR = R;
    const h = await c.dist('Specify height', {
      ...HEIGHT_OPTS({ x: ctr.x, y: ctr.y, z: z0 }),
      preview: (dd) =>
        Math.abs(dd) > 1e-9
          ? [
              Solid3dCommands.tempEntity(
                K.makeCylinder(R, Math.abs(dd), ctr.x, ctr.y, dd < 0 ? z0 + dd : z0),
              ),
            ]
          : [],
    });
    if (typeof h !== 'number' || Math.abs(h) < 1e-9) return;
    c.add(
      Solid3dCommands.solidEntity(
        c,
        K.makeCylinder(R, Math.abs(h), ctr.x, ctr.y, h < 0 ? z0 + h : z0),
      ),
    );
  }

  /** SPHERE: a sphere from a centre and a radius. */
  static async sphere(c) {
    await Solid3dCommands.ensureKernel(c);
    const ctr = await c.point('Specify center point');
    if (!isPt(ctr)) return;
    const r = await c.dist('Specify radius or [Diameter]', {
      base: ctr,
      kw: ['Diameter'],
      preview: (d) =>
        d > 1e-9 ? [Solid3dCommands.tempEntity(K.makeSphere(d, ctr.x, ctr.y, zOf(ctr)))] : [],
    });
    let R;
    if (r === 'Diameter') {
      const d = await c.dist('Specify diameter', { base: ctr });
      if (typeof d !== 'number') return;
      R = d / 2;
    } else if (typeof r === 'number') R = r;
    else return;
    if (R <= 0) return c.fail('The radius must be positive.');
    c.add(Solid3dCommands.solidEntity(c, K.makeSphere(R, ctr.x, ctr.y, zOf(ctr))));
  }

  /** CONE: a cone or cone frustum. */
  static async cone(c) {
    await Solid3dCommands.ensureKernel(c);
    const ctr = await c.point('Specify center point of base');
    if (!isPt(ctr)) return;
    const z0 = zOf(ctr);
    const r1 = await c.dist('Specify base radius or [Diameter]', { base: ctr, kw: ['Diameter'] });
    let R1;
    if (r1 === 'Diameter') {
      const d = await c.dist('Specify diameter', { base: ctr });
      if (typeof d !== 'number') return;
      R1 = d / 2;
    } else if (typeof r1 === 'number') R1 = r1;
    else return;
    let R2 = 0;
    for (;;) {
      const h = await c.dist('Specify height or [Top radius]', {
        ...HEIGHT_OPTS({ x: ctr.x, y: ctr.y, z: z0 }),
        kw: ['Top radius'],
        preview: (dd) =>
          Math.abs(dd) > 1e-9
            ? [
                Solid3dCommands.tempEntity(
                  K.makeCone(R1, R2, Math.abs(dd), ctr.x, ctr.y, dd < 0 ? z0 + dd : z0),
                ),
              ]
            : [],
      });
      if (h === 'Top radius') {
        const t = await c.dist('Specify top radius', { base: ctr, def: 0 });
        if (typeof t === 'number') R2 = Math.abs(t);
        continue;
      }
      if (typeof h !== 'number' || Math.abs(h) < 1e-9) return;
      c.add(
        Solid3dCommands.solidEntity(
          c,
          K.makeCone(R1, R2, Math.abs(h), ctr.x, ctr.y, h < 0 ? z0 + h : z0),
        ),
      );
      return;
    }
  }

  /** WEDGE: a wedge from a corner, width, depth and height. */
  static async wedge(c) {
    await Solid3dCommands.ensureKernel(c);
    const p1 = await c.point('Specify first corner');
    if (!isPt(p1)) return;
    const p2 = await c.point('Specify other corner', { base: p1, noOrtho: true, rubber: false });
    if (!isPt(p2)) return;
    const w = Math.abs(p2.x - p1.x);
    const d = Math.abs(p2.y - p1.y);
    if (w < 1e-9 || d < 1e-9) return c.fail('The base is degenerate.');
    const x0 = Math.min(p1.x, p2.x);
    const y0 = Math.min(p1.y, p2.y);
    const z0 = zOf(p1);
    const h = await c.dist('Specify height', {
      ...HEIGHT_OPTS({ x: p2.x, y: p2.y, z: z0 }),
      preview: (dd) =>
        Math.abs(dd) > 1e-9
          ? [
              Solid3dCommands.tempEntity(
                K.makeWedge(w, d, Math.abs(dd), x0, y0, dd < 0 ? z0 + dd : z0),
              ),
            ]
          : [],
    });
    if (typeof h !== 'number' || Math.abs(h) < 1e-9) return;
    c.add(
      Solid3dCommands.solidEntity(c, K.makeWedge(w, d, Math.abs(h), x0, y0, h < 0 ? z0 + h : z0)),
    );
  }

  /** TORUS: a ring from a centre, a ring radius and a tube radius. */
  static async torus(c) {
    await Solid3dCommands.ensureKernel(c);
    const ctr = await c.point('Specify center point');
    if (!isPt(ctr)) return;
    const R1 = await c.dist('Specify radius or [Diameter]', { base: ctr, kw: ['Diameter'] });
    if (typeof R1 !== 'number') return;
    const r = await c.dist('Specify tube radius', {
      base: ctr,
      preview: (d) =>
        d > 1e-9 && d < R1
          ? [Solid3dCommands.tempEntity(K.makeTorus(R1, d, ctr.x, ctr.y, zOf(ctr)))]
          : [],
    });
    if (typeof r !== 'number') return;
    if (r <= 0 || r >= R1) return c.fail('The tube radius must be smaller than the torus radius.');
    c.add(Solid3dCommands.solidEntity(c, K.makeTorus(R1, r, ctr.x, ctr.y, zOf(ctr))));
  }

  /** PYRAMID: a pyramid with 3 or more sides. */
  static async pyramid(c) {
    await Solid3dCommands.ensureKernel(c);
    const ctr = await c.point('Specify center point of base or [Sides]', { kw: ['Sides'] });
    let sides = c.app.pyrSides || 4;
    let p = ctr;
    if (ctr === 'Sides') {
      const n = await c.number('Enter number of sides', { def: sides });
      if (typeof n === 'number') sides = Math.max(3, Math.min(32, Math.round(n)));
      p = await c.point('Specify center point of base');
    }
    if (!isPt(p)) return;
    c.app.pyrSides = sides;
    const z0 = zOf(p);
    const R = await c.dist('Specify base radius', { base: p });
    if (typeof R !== 'number' || R <= 0) return;
    const h = await c.dist('Specify height', {
      ...HEIGHT_OPTS({ x: p.x, y: p.y, z: z0 }),
      preview: (dd) =>
        Math.abs(dd) > 1e-9
          ? [Solid3dCommands.tempEntity(K.makePyramid(R, sides, Math.abs(dd), p.x, p.y, z0))]
          : [],
    });
    if (typeof h !== 'number' || Math.abs(h) < 1e-9) return;
    c.add(
      Solid3dCommands.solidEntity(
        c,
        K.makePyramid(R, sides, Math.abs(h), p.x, p.y, h < 0 ? z0 + h : z0),
      ),
    );
  }

  // ------------------------------------------------------------------ profiles from 2D objects
  /** @private The outline points of a closed 2D object. */
  static loopOf(e, doc) {
    if (e.type === 'circle')
      return {
        pts: [
          { x: e.c.x - e.r, y: e.c.y, b: 1 },
          { x: e.c.x + e.r, y: e.c.y, b: 1 },
        ],
        poly: E.closedLoop(e),
        circle: e,
      };
    if (e.type === 'pline' && e.closed)
      return { pts: e.pts.map((p) => ({ x: p.x, y: p.y, b: p.b || 0 })), poly: E.closedLoop(e) };
    const poly = E.closedLoop(e);
    return poly ? { pts: poly.map((p) => ({ x: p.x, y: p.y, b: 0 })), poly } : null;
  }

  // nested loops become holes
  /** @private Sorts closed outlines into outer outlines and the holes inside them. */
  static groupProfiles(loops) {
    const area = (l) => Math.abs(G.polyArea(l.poly));
    const sorted = [...loops].sort((a, b) => area(b) - area(a));
    const profiles = [];
    for (const l of sorted) {
      const host = [...profiles]
        .reverse()
        .find(
          (p) =>
            p.outer.poly.length &&
            G.pointInPoly(l.poly[0], p.outer.poly) &&
            l.poly.every((q) => G.pointInPoly(q, p.outer.poly)),
        );
      if (host) host.holes.push(l);
      else profiles.push({ outer: l, holes: [] });
    }
    return profiles;
  }

  // profiles for EXTRUDE / REVOLVE: closed shapes are taken as they are, and loose lines / arcs / open polylines that make closed shapes are JOINED first (no need to run JOIN)
  /** @private Asks for the closed 2D objects EXTRUDE and REVOLVE work on. */
  static async pickProfiles(c, prompt) {
    const picked = await c.select(prompt, {
      filter: (e) => profileEntities(e) || looseEntities(e),
    });
    if (!picked.length) return null;
    const closed = picked.filter(profileEntities);
    const loose = picked.filter((e) => !profileEntities(e));
    let joined = [];
    if (loose.length) {
      let bb = null;
      for (const e of loose) bb = E.bboxMerge(bb, E.bbox(e, c.doc));
      const res = O.joinEnts(loose, Math.max(1e-6, Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) * 1e-5));
      joined = res.filter((j) => (j.type === 'pline' && j.closed) || j.type === 'circle');
      if (res.length > joined.length)
        return c.fail(
          `${res.length - joined.length} chain(s) of the selected lines and arcs are not closed (there is a gap or an end point does not meet). Close them first.`,
        );
      c.echo(`${loose.length} line / arc object(s) joined into ${joined.length} closed shape(s).`);
    }
    return { ents: [...closed, ...joined], sources: [...closed, ...loose] };
  }

  /**
   * @private Asks for the objects EXTRUDE / REVOLVE work on. Loose lines and arcs that meet are
   * joined; each result is `{e, closed, sources}` (a closed shape or an open path).
   */
  static async collectCurves(c, prompt) {
    const picked = await c.select(prompt, {
      filter: (e) => profileEntities(e) || looseEntities(e) || CV.isCurve(e),
    });
    if (!picked.length) return null;
    const closed = picked.filter((e) => profileEntities(e) || (CV.isCurve(e) && !looseEntities(e) && CV.isClosedCurve(e)));
    const loose = picked.filter((e) => !closed.includes(e));
    const curves = closed.map((e) => ({ e, closed: true, sources: [e] }));
    if (loose.length) {
      let bb = null;
      for (const e of loose) bb = E.bboxMerge(bb, E.bbox(e, c.doc));
      const res = O.joinEnts(loose, Math.max(1e-6, Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) * 1e-5));
      for (const j of res) {
        if (loose[0].plane && !j.plane) j.plane = JSON.parse(JSON.stringify(loose[0].plane));
        curves.push({ e: j, closed: (j.type === 'pline' && j.closed) || j.type === 'circle', sources: loose });
      }
      if (res.length < loose.length) c.echo(`${loose.length} line / arc object(s) joined into ${res.length} path(s).`);
    }
    return curves;
  }

  /**
   * EXTRUDE: closed 2D objects make solids (with an optional taper angle), open lines / arcs /
   * polylines make surfaces. Objects drawn on a face or side plane are extruded along that plane's
   * normal. [MOde] switches closed shapes between solid and surface, [Direction] picks a direction.
   */
  static async extrude(c) {
    await Solid3dCommands.ensureKernel(c);
    const curves = await Solid3dCommands.collectCurves(c, 'Select objects to extrude (closed shapes make solids, open lines and curves make surfaces)');
    if (!curves) return;
    const planar = curves.some((x) => x.e.plane);
    let mode = curves.every((x) => x.closed) ? 'Solid' : 'Surface';
    if (mode === 'Surface' && curves.some((x) => x.closed)) c.echo('Open shapes make surfaces; closed shapes will also become surfaces.');
    let dir = curves[0].e.plane ? [...curves[0].e.plane.n] : [0, 0, 1];
    let customDir = false;
    const b0 = E.bbox(curves[0].e, c.doc);
    const base = CV.worldPoint(curves[0].e, { x: (b0.x0 + b0.x1) / 2, y: (b0.y0 + b0.y1) / 2, z: 0 });
    let taper = 0;
    let h;
    for (;;) {
      h = await c.dist(`Specify height of extrusion [Direction/MOde/Taper angle] <${mode}>`, {
        ...(planar || customDir
          ? { base: { x: base[0], y: base[1], z: base[2] }, direction3d: dir, noOrtho: true, noSnap: true, rubber: false }
          : HEIGHT_OPTS({ x: base[0], y: base[1], z: 0 })),
        kw: ['Direction', 'MOde', 'Taper angle'],
        def: c.app.extHeight,
      });
      if (h === 'MOde') {
        if (curves.some((x) => !x.closed)) c.echo('Open shapes can only make surfaces.');
        else mode = mode === 'Solid' ? 'Surface' : 'Solid';
        c.echo(`Mode: ${mode}.`);
        continue;
      }
      if (h === 'Direction') {
        const p1 = await c.point('Specify the first point of the direction', { world3d: true, noOrtho: true });
        if (!isPt(p1)) return;
        const p2 = await c.point('Specify the second point of the direction', { base: p1, world3d: true, noOrtho: true });
        if (!isPt(p2)) return;
        const v = [p2.x - p1.x, p2.y - p1.y, zOf(p2) - zOf(p1)];
        const l = Math.hypot(...v);
        if (l < 1e-9) return c.fail('The two direction points must be different.');
        dir = v.map((x) => x / l);
        customDir = true;
        continue;
      }
      if (h === 'Taper angle') {
        const t = await c.angle('Specify angle of taper for extrusion', { def: 0 });
        if (typeof t === 'number') taper = G.deg(t);
        continue;
      }
      break;
    }
    if (typeof h !== 'number' || Math.abs(h) < 1e-9) return;
    c.app.extHeight = h;
    const made = [];
    const general = mode === 'Surface' || planar || customDir || curves.some((x) => !x.closed);
    if (general) {
      if (taper) c.echo('Taper is only used for solids drawn on the ground plane; it was ignored.');
      for (const x of curves) {
        const e = x.e;
        const vec = dir.map((v) => v * h);
        const shape = CV.extrudeCurve(e, c.doc, vec, { solid: mode === 'Solid' && x.closed });
        made.push(Solid3dCommands.solidEntity(c, shape, x.sources[0] || e));
      }
      c.erase([...new Set(curves.flatMap((x) => x.sources))]);
      c.addAll(made);
      c.echo(`${made.length} ${mode === 'Solid' ? 'solid(s)' : 'surface(s)'} created.`);
      return;
    }
    const ents = curves.map((x) => x.e);
    const loops = ents.map((e) => Solid3dCommands.loopOf(e, c.doc)).filter(Boolean);
    if (!loops.length) return c.fail('No closed profile was selected.');
    const profiles = Solid3dCommands.groupProfiles(loops);
    for (const p of profiles) {
      const sk = K.profileToSketch([p.outer.pts, ...p.holes.map((x) => x.pts)], 0);
      let sh = K.extrudeSketch(sk, Math.abs(h), taper);
      if (h < 0) sh = sh.translate(0, 0, h);
      made.push(
        Solid3dCommands.solidEntity(c, sh, ents[0], {
          kind: 'prism',
          loops: [p.outer.pts, ...p.holes.map((x) => x.pts)],
          z0: h < 0 ? h : 0,
          h: Math.abs(h),
          taper,
        }),
      );
    }
    c.erase([...new Set(curves.flatMap((x) => x.sources))]);
    c.addAll(made);
    c.echo(`${made.length} solid(s) created.`);
  }

  /** REVOLVE: turns closed 2D objects into solids and open lines / curves into surfaces, around an axis. */
  static async revolve(c) {
    await Solid3dCommands.ensureKernel(c);
    const curves = await Solid3dCommands.collectCurves(c, 'Select objects to revolve (closed shapes make solids, open lines and curves make surfaces)');
    if (!curves) return;
    const general = curves.some((x) => !x.closed || x.e.plane);
    const a = await c.point('Specify axis start point or define axis by [X/Y/Z]', {
      kw: ['X', 'Y', 'Z'],
    });
    let o;
    let dir;
    if (a === 'X') {
      o = [0, 0, 0];
      dir = [1, 0, 0];
    } else if (a === 'Y') {
      o = [0, 0, 0];
      dir = [0, 1, 0];
    } else if (a === 'Z') {
      if (!general) return c.fail('The Z axis is not in the plane of a 2D profile on the ground. Draw the profile on a side plane, or use X, Y or two points.');
      o = [0, 0, 0];
      dir = [0, 0, 1];
    } else if (isPt(a)) {
      const b = await c.point('Specify axis endpoint', { base: a });
      if (!isPt(b)) return;
      o = [a.x, a.y, general ? zOf(a) : 0];
      dir = [b.x - a.x, b.y - a.y, general ? zOf(b) - zOf(a) : 0];
      if (Math.hypot(...dir) < 1e-9) return c.fail('The axis is degenerate.');
    } else return;
    const ang = await c.angle('Specify angle of revolution <360>', { def: G.TAU, defText: '360' });
    if (typeof ang !== 'number') return;
    const deg = Math.min(360, Math.abs(G.deg(ang)) || 360);
    const made = [];
    if (general) {
      for (const x of curves) {
        try {
          made.push(Solid3dCommands.solidEntity(c, CV.revolveCurve(x.e, c.doc, o, dir, deg, { solid: x.closed }), x.sources[0] || x.e));
        } catch (e) {
          return c.fail(`Revolve failed: ${e.message}`);
        }
      }
    } else {
      const loops = curves.map((x) => Solid3dCommands.loopOf(x.e, c.doc)).filter(Boolean);
      for (const p of Solid3dCommands.groupProfiles(loops)) {
        const sk = K.profileToSketch([p.outer.pts, ...p.holes.map((x) => x.pts)], 0);
        try {
          made.push(Solid3dCommands.solidEntity(c, sk.revolve(dir, { origin: o, angle: deg }), curves[0].e));
        } catch (e) {
          return c.fail(`Revolve failed: ${e.message}`);
        }
      }
    }
    c.erase([...new Set(curves.flatMap((x) => x.sources))]);
    c.addAll(made);
    c.echo(`${made.length} ${general && curves.some((x) => !x.closed) ? 'solid(s) / surface(s)' : 'solid(s)'} created.`);
  }

  /** UNION: unites solids (2D regions when there are no solids). */
  static async union(c) {
    const ents = await c.select('Select objects', {
      filter: (e) => modelBody(e) || E.isClosed(e),
    });
    if (ents.length < 2) return c.fail('Select at least two objects.');
    if (!ents.every(modelBody)) {
      if (ents.some(modelBody)) return c.fail('Cannot combine 2D objects with 3D bodies.');
      return union2D(c, ents);
    }
    await Solid3dCommands.ensureKernel(c);
    const acc = H.unionBodies(booleanShapes(c,ents,'UNION'));
    c.erase(ents);
    c.add(Solid3dCommands.solidEntity(c, acc, ents[0]));
    c.echo(`Union of ${ents.length} solids: volume ${c.fmt(K.volume(acc))}`);
  }

  /** SUBTRACT: subtracts solids (2D regions when there are no solids). */
  static async subtract(c) {
    const a = await c.select('Select solids and regions to subtract from', {
      filter: (e) => modelBody(e) || E.isClosed(e),
      pre: false,
    });
    if (!a.length) return;
    const b = await c.select('Select solids and regions to subtract', {
      filter: (e) => modelBody(e) || E.isClosed(e),
      pre: false,
    });
    if (!b.length) return;
    if (!a.every(modelBody) || !b.every(modelBody)) {
      if (a.some(modelBody) || b.some(modelBody))
        return c.fail('Cannot mix 2D objects and 3D bodies.');
      return subtract2D(c, a, b);
    }
    await Solid3dCommands.ensureKernel(c);
    const targets=booleanShapes(c,a,'SUBTRACT'),tools=booleanShapes(c,b,'SUBTRACT');
    let acc = targets[0];
    for (const shape of targets.slice(1)) acc = K.fuse(acc, shape);
    for (const shape of tools) acc = K.cut(acc, shape);
    c.erase([...a, ...b]);
    c.add(Solid3dCommands.solidEntity(c, acc, a[0]));
    c.echo(`Subtract: volume ${c.fmt(K.volume(acc))}`);
  }

  /** INTERSECT: keeps the common part of solids (2D regions when there are no solids). */
  static async intersect(c) {
    const ents = await c.select('Select objects', {
      filter: (e) => modelBody(e) || E.isClosed(e),
    });
    if (ents.length < 2) return c.fail('Select at least two objects.');
    if (!ents.every(modelBody)) {
      if (ents.some(modelBody)) return c.fail('Cannot mix 2D objects and 3D bodies.');
      return intersect2D(c, ents);
    }
    await Solid3dCommands.ensureKernel(c);
    const shapes=booleanShapes(c,ents,'INTERSECT');let acc=shapes[0];
    for (const shape of shapes.slice(1)) acc = K.common(acc, shape);
    const vol = K.volume(acc);
    if (!(vol > 1e-9)) return c.fail('The solids do not intersect.');
    c.erase(ents);
    c.add(Solid3dCommands.solidEntity(c, acc, ents[0]));
    c.echo(`Intersect: volume ${c.fmt(vol)}`);
  }

  /** INTERFERE: finds the volume that two solids share. */
  static async interfere(c) {
    await Solid3dCommands.ensureKernel(c);
    const a = await c.select('Select first set of solids', { filter: solidsOnly, pre: false });
    if (!a.length) return;
    const list =
      a.length > 1
        ? a
        : await (async () => {
            const b = await c.select('Select second set of solids', {
              filter: solidsOnly,
              pre: false,
            });
            return [...a, ...b];
          })();
    let n = 0;
    const made = [];
    for (let i = 0; i < list.length; i += 1)
      for (let j = i + 1; j < list.length; j += 1) {
        const v = Solid3dCommands.safely(() => {
          const x = K.common(baked(list[i]), baked(list[j]));
          return { x, vol: K.volume(x) };
        }, null);
        if (v && v.vol > 1e-9) {
          n += 1;
          c.echo(`Solids ${i + 1} and ${j + 1} interfere: volume ${c.fmt(v.vol)}`);
          made.push(Solid3dCommands.solidEntity(c, v.x));
        }
      }
    if (!n) return c.echo('Interfering pairs: 0');
    const y = await c.keyword('Create interference solids? [Yes/No]', ['Yes', 'No'], 'No');
    if (y === 'Yes') c.addAll(made);
  }

  // ------------------------------------------------------------------ edge fillet / chamfer
  /** @private An edge of a solid with its two ends and its middle. */
  static edgeInfo(ed) {
    const p = ed.pts;
    const a = p[0];
    const b = p[p.length - 1];
    const seg = Math.floor((p.length - 1) / 2);
    const mid =
      p.length % 2 === 1
        ? p[seg]
        : [
            (p[seg][0] + p[seg + 1][0]) / 2,
            (p[seg][1] + p[seg + 1][1]) / 2,
            (p[seg][2] + p[seg + 1][2]) / 2,
          ];
    return { a, b, mid, id: ed.id, pts: p };
  }

  // edges that follow the clicked edge smoothly (tangent chain), and all edges around a face
  /** @private The edges that follow the clicked edge smoothly (the tangent chain). */
  static chainOf(e, ed) {
    const all = E.solidEdges(e);
    const ids = new Set(K.tangentChain(all, ed.id));
    return all.filter((x) => ids.has(x.id));
  }

  /** @private All edges around a face. */
  static faceEdgesOf(e, face) {
    const ids = new Set(K.faceEdgeIds(e, face.faceId));
    return E.solidEdges(e).filter((x) => ids.has(x.id));
  }

  // Select edges like a real CAD program: a click takes the whole tangent CHAIN (default), a click on a FACE takes every edge around it,
  // [Edge] = just the clicked edge, [Loop] = all edges around the face under the cursor. Clicking again removes.
  /** @private Selects edges like a real CAD program: a click takes the whole tangent chain, a click on a face takes every edge around it, and a window takes every edge inside. */
  static async pickEdges(c, prompt, kws = []) {
    const picks = [];
    c.app.edgeHl = [];
    for (;;) {
      const mode = c.app.edgeMode || 'chain';
      const expand = (e, ed) => (mode === 'edge' ? [ed] : Solid3dCommands.chainOf(e, ed));
      const r = await c.app.request(
        'edge',
        `${prompt.replace('<mode>', mode[0].toUpperCase() + mode.slice(1))}`,
        { kw: ['Chain', 'Edge', 'Loop', ...kws], faces: true, mode, expand },
      );
      if (r === null) break;
      if (typeof r === 'string') {
        if (r === 'Chain' || r === 'Edge' || r === 'Loop') {
          c.app.edgeMode = r.toLowerCase();
          c.echo(
            r === 'Chain'
              ? 'Chain: a click selects every edge that continues smoothly. Click a face to select all of its edges.'
              : r === 'Edge'
                ? 'Edge: a click selects only that edge.'
                : 'Loop: a click selects all edges around the face under the cursor.',
          );
          continue;
        }
        picks.kw = r;
        break;
      }
      const eds = r.face ? Solid3dCommands.faceEdgesOf(r.e, r.face) : expand(r.e, r.edge);
      const has = (ed) => picks.some((p) => p.e === r.e && p.info.id === ed.id);
      if (eds.every(has)) {
        for (const ed of eds) {
          const i = picks.findIndex((p) => p.e === r.e && p.info.id === ed.id);
          if (i >= 0) picks.splice(i, 1);
        }
      } else
        for (const ed of eds)
          if (!has(ed)) picks.push({ e: r.e, info: Solid3dCommands.edgeInfo(ed) });
      c.app.edgeHl = picks.map((p) => ({ pts: p.info.pts }));
      c.app.redraw();
      c.echo(`${picks.length} edge(s) selected.`);
    }
    return picks;
  }

  /** @private FILLETEDGE and CHAMFEREDGE: pick edges, ask for the value, apply. */
  static async edgeOp(c, kind) {
    await Solid3dCommands.ensureKernel(c);
    if (!c.app.v3) c.app.enter3D('swiso');
    const picks = await Solid3dCommands.pickEdges(
      c,
      `Select an edge or face [Chain/Edge/Loop/${kind === 'fillet' ? 'Radius' : 'Distance'}] <mode>  (Enter to finish)`,
      [kind === 'fillet' ? 'Radius' : 'Distance'],
    );
    if (!picks.length) {
      c.app.edgeHl = [];
      return;
    }
    const st = c.app.edgeOpts || (c.app.edgeOpts = { r: 2, d: 2 });
    const val = await c.dist(
      kind === 'fillet' ? 'Specify fillet radius' : 'Specify chamfer distance',
      { def: kind === 'fillet' ? st.r : st.d },
    );
    if (typeof val !== 'number' || val <= 0) {
      c.app.edgeHl = [];
      return;
    }
    if (kind === 'fillet') st.r = val;
    else st.d = val;
    const groups = new Map();
    for (const p of picks) {
      if (!groups.has(p.e)) groups.set(p.e, []);
      groups.get(p.e).push(p.info);
    }
    let ok = 0;
    for (const [e, infos] of groups) {
      try {
        const res = K.dressEdges(
          e,
          kind,
          val,
          infos.map((i) => i.id),
        );
        const ne = Solid3dCommands.solidEntity(c, res, e);
        c.replace(e, [ne]);
        ok += 1;
      } catch (err) {
        c.echo(
          `${kind === 'fillet' ? 'Fillet' : 'Chamfer'} failed: ${err.message || 'the value is too large for the selected edges.'}`,
        );
      }
    }
    c.app.edgeHl = [];
    c.echo(`${ok} solid(s) ${kind === 'fillet' ? 'rounded' : 'chamfered'}.`);
  }

  // ------------------------------------------------------------------ slice / section planes
  /** Shows target-sized XY/YZ/ZX cards that can be clicked as well as typed. */
  static planeKeyword(c, ents, prompt, kws = ['XY', 'YZ', 'ZX', '3points'], def = 'XY') {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const e of ents) {
      const b = K.solidMesh(e).bounds;
      for (let i = 0; i < 3; i += 1) { lo[i] = Math.min(lo[i], b[0][i]); hi[i] = Math.max(hi[i], b[1][i]); }
    }
    const choices = S3.planePickerChoices([lo, hi]);
    return c.app.request('keyword', prompt, { kw: kws, def, planePicker: { choices, margin: 14 } });
  }

  /** @private A cutting plane from a keyword (XY, YZ, ZX, three points, object, ...). */
  static async planeFromKeyword(c, kw) {
    if (kw === 'XY') {
      const p = await c.point('Specify a point on the XY plane <0,0,0>', {
        def: { x: 0, y: 0, z: 0 },
      });
      return { o: [0, 0, isPt(p) ? zOf(p) : 0], n: [0, 0, 1] };
    }
    if (kw === 'YZ') {
      const p = await c.point('Specify a point on the YZ plane <0,0,0>', { def: { x: 0, y: 0 } });
      return { o: [isPt(p) ? p.x : 0, 0, 0], n: [1, 0, 0] };
    }
    if (kw === 'ZX') {
      const p = await c.point('Specify a point on the ZX plane <0,0,0>', { def: { x: 0, y: 0 } });
      return { o: [0, isPt(p) ? p.y : 0, 0], n: [0, 1, 0] };
    }
    if (kw === '3points') {
      const a = await c.point('Specify first point on plane');
      if (!isPt(a)) return null;
      const b = await c.point('Specify second point on plane', { base: a });
      if (!isPt(b)) return null;
      const d = await c.point('Specify third point on plane', { base: b });
      if (!isPt(d)) return null;
      const u = [b.x - a.x, b.y - a.y, zOf(b) - zOf(a)];
      const v = [d.x - a.x, d.y - a.y, zOf(d) - zOf(a)];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      if (Math.hypot(...n) < 1e-9) return null;
      return { o: [a.x, a.y, zOf(a)], n };
    }
    return null;
  }

  /** SLICE: cuts solids with a plane. */
  static async slice(c) {
    await Solid3dCommands.ensureKernel(c);
    const ents = await c.select('Select solids to slice', { filter: solidsOnly });
    if (!ents.length) return;
    const kw = await Solid3dCommands.planeKeyword(
      c,
      ents,
      'Specify slicing plane [XY/YZ/ZX/3points] <3points>',
      ['XY', 'YZ', 'ZX', '3points'],
      '3points',
    );
    const pl = await Solid3dCommands.planeFromKeyword(c, kw);
    if (!pl) return c.fail('The slicing plane is not valid.');
    const made = [];
    for (const e of ents)
      for (const s of H.splitPlane(baked(e), pl.o, pl.n))
        if (K.volume(s) > 1e-9) made.push(Solid3dCommands.solidEntity(c, s, e));
    c.erase(ents);
    c.addAll(made);
    c.app.sel = new Set(made.map((e) => e.id));
    c.echo(`${made.length} solid(s) after slicing. All cut parts were kept; erase unwanted parts manually.`);
  }

  // ------------------------------------------------------------------ 3D move / rotate / mirror / array
  /** @private Adds a pending operation (move, rotate, scale, mirror) to solids. */
  static pushOp(e, op) {
    if (e.type === 'solid3d') {
      (e.ops ||= []).push(op);
      e._edgesKey = null;
    }
  }

  /** 3DMOVE: moves solids in 3D. */
  static async move3d(c) {
    await Solid3dCommands.ensureKernel(c);
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    const base = await c.point('Specify base point');
    if (!isPt(base)) return;
    c.hide(ents);
    const preview = (dx, dy, dz = 0) =>
      ents.map((e) => {
        const k = E.clone(e);
        E.translateEnt3d(k, dx, dy, dz, c.doc);
        return k;
      });
    const q = await c.point('Specify second point or [Vertical]', {
      base,
      kw: ['Vertical'],
      preview: (p) => preview(p.x - base.x, p.y - base.y, zOf(p) - zOf(base)),
    });
    if (q === 'Vertical') {
      const dz = await c.dist('Specify vertical displacement (up + / down -)', {
        base,
        vertical: true,
        preview: (distance) => preview(0, 0, distance),
      });
      if (!Number.isFinite(dz)) return;
      for (const e of ents) E.translateEnt3d(e, 0, 0, dz, c.doc);
      c.bump();
      return;
    }
    if (!isPt(q)) return;
    for (const e of ents) E.translateEnt3d(e, q.x - base.x, q.y - base.y, zOf(q) - zOf(base), c.doc);
    c.bump();
  }

  /** ROTATE3D: rotates solids about an axis. */
  static async rotate3d(c) {
    await Solid3dCommands.ensureKernel(c);
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    const ax = await c.keyword(
      'Specify first point on axis or define axis by [Object/Last/View/Xaxis/Yaxis/Zaxis/2points] <2points>',
      ['Xaxis', 'Yaxis', 'Zaxis', '2points'],
      '2points',
    );
    let o;
    let a;
    if (ax === 'Xaxis' || ax === 'Yaxis' || ax === 'Zaxis') {
      const p = await c.point(`Specify a point on the ${ax[0]} axis <0,0,0>`, {
        def: { x: 0, y: 0, z: 0 },
      });
      o = isPt(p) ? [p.x, p.y, zOf(p)] : [0, 0, 0];
      a = ax === 'Xaxis' ? [1, 0, 0] : ax === 'Yaxis' ? [0, 1, 0] : [0, 0, 1];
    } else {
      const p1 = await c.point('Specify first point on axis');
      if (!isPt(p1)) return;
      const p2 = await c.point('Specify second point on axis', { base: p1 });
      if (!isPt(p2)) return;
      o = [p1.x, p1.y, zOf(p1)];
      a = [p2.x - p1.x, p2.y - p1.y, zOf(p2) - zOf(p1)];
      if (Math.hypot(...a) < 1e-9) return c.fail('The axis is degenerate.');
    }
    const flat = Math.abs(a[0]) + Math.abs(a[1]) < 1e-9;
    if (!flat && ents.some((e) => e.type !== 'solid3d' && !canStand3d(e)))
      return c.fail(
        'Only solids, lines, arcs, circles and polylines can rotate about an axis that is not vertical (other 2D objects live in the XY plane).',
      );
    const ang = await c.angle('Specify rotation angle', { def: 0 });
    if (typeof ang !== 'number') return;
    for (const e of ents) {
      if (e.type === 'solid3d') Solid3dCommands.pushOp(e, { t: 'R', o, a, ang });
      else if (!flat || e.plane) rotateCurve3d(e, o, a, ang);
      else E.xformInPlace(e, G.Mrotate(a[2] < 0 ? -ang : ang, { x: o[0], y: o[1] }), c.doc);
    }
    c.bump();
  }

  /** 3DMIRROR: mirrors solids about a plane. */
  static async mirror3d(c) {
    await Solid3dCommands.ensureKernel(c);
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    const kw = await c.keyword(
      'Specify mirror plane [XY/YZ/ZX/3points] <3points>',
      ['XY', 'YZ', 'ZX', '3points'],
      '3points',
    );
    const pl = await Solid3dCommands.planeFromKeyword(c, kw);
    if (!pl) return c.fail('The mirror plane is not valid.');
    const del = await c.keyword('Delete source objects? [Yes/No]', ['Yes', 'No'], 'No');
    const made = [];
    for (const e of ents) {
      const k = E.clone(e);
      k.id = 0;
      if (k.type === 'solid3d') Solid3dCommands.pushOp(k, { t: 'M', o: pl.o, n: pl.n });
      else if (canStand3d(k) && (k.plane || Math.abs(pl.n[2]) >= 1e-9)) mirrorCurve3d(k, pl.o, pl.n);
      else if (Math.abs(pl.n[2]) < 1e-9) {
        const ln = G.norm({ x: -pl.n[1], y: pl.n[0] });
        E.xformInPlace(
          k,
          G.Mmirror({ x: pl.o[0], y: pl.o[1] }, { x: pl.o[0] + ln.x, y: pl.o[1] + ln.y }),
          c.doc,
        );
      }
      made.push(k);
    }
    if (del === 'Yes') c.erase(ents);
    c.addAll(made);
  }

  /** 3DARRAY: rectangular or polar array of solids. */
  static async array3d(c) {
    await Solid3dCommands.ensureKernel(c);
    const ents = await c.select('Select objects');
    if (!ents.length) return;
    const rows = await c.number('Enter the number of rows (---)', { def: 2 });
    const cols = await c.number('Enter the number of columns (|||)', { def: 2 });
    const lev = await c.number('Enter the number of levels (...)', { def: 1 });
    const dy = await c.dist('Specify the distance between rows (---)', { def: 10 });
    const dx = await c.dist('Specify the distance between columns (|||)', { def: 10 });
    const dz = lev > 1 ? await c.dist('Specify the distance between levels (...)', { def: 10 }) : 0;
    if ([rows, cols, lev, dy, dx, dz].some((v) => typeof v !== 'number')) return;
    const made = [];
    for (let l = 0; l < lev; l += 1)
      for (let r = 0; r < rows; r += 1)
        for (let k = 0; k < cols; k += 1) {
          if (!l && !r && !k) continue;
          for (const e of ents) {
            const n = E.clone(e);
            n.id = 0;
            E.translateEnt(n, k * dx, r * dy, c.doc);
            if (n.type === 'solid3d' && l) Solid3dCommands.pushOp(n, { t: 'T', v: [0, 0, l * dz] });
            made.push(n);
          }
        }
    c.addAll(made);
    c.echo(`${made.length} copies created.`);
  }

  /** @private Rebuilds a prism with leaning side faces. */
  static draftSolid(c, e, angles) {
    const s = e.src;
    if (!s || s.kind !== 'prism')
      throw new Error('DRAFT works on boxes and extruded solids made in this program.');
    const all = Array.isArray(angles) ? angles : s.loops.map((l) => l.map(() => angles));
    const ne = Solid3dCommands.solidEntity(c, K.draftPrism(s.loops, s.z0, s.h, all), e, {
      ...s,
      angles: all,
      taper: Array.isArray(angles) ? s.taper : angles,
    });
    ne.ops = e.ops ? JSON.parse(JSON.stringify(e.ops)) : [];
    return ne;
  }

  /** TAPERFACES / DRAFT: leans the side faces of a prism by an angle. */
  static async taperFaces(c) {
    await Solid3dCommands.ensureKernel(c);
    let ents = await c.select('Select boxes or extruded solids to draft', { filter: solidsOnly });
    if (!ents.length) return;
    if (!c.app.v3) c.app.enter3D('swiso'); // faces are picked in a 3D view
    const apply = (old, angles) => {
      const ne = Solid3dCommands.draftSolid(c, old, angles);
      c.replace(old, [ne]);
      ents = ents.map((x) => (x === old ? ne : x));
      return ne;
    };
    c.echo(
      'Click a side face, then give its draft angle. Each face can lean by its own angle. Enter finishes; "All" drafts every side face with one angle.',
    );
    let n = 0;
    try {
      for (;;) {
        c.app.faceHl = [];
        const r = await c.app.request(
          'face',
          'Select a side face to draft [All sides]  (Enter to finish)',
          { kw: ['All'], solids: ents },
        );
        if (r === null) break;
        if (r === 'All') {
          const ang = await c.number('Specify the draft angle for all side faces', {
            def: c.app.draftAng ?? 5,
          });
          if (typeof ang !== 'number') continue;
          c.app.draftAng = ang;
          for (const e of [...ents]) {
            try {
              apply(e, ang);
              n += 1;
            } catch (err) {
              c.echo(err.message);
            }
          }
          continue;
        }
        if (typeof r === 'string') continue;
        const hit = K.prismEdgeOfFace(r.e, r.p, r.n);
        if (!hit) {
          const neutral=await c.app.request('face','Select a planar neutral face on the same solid',{solids:[r.e]});
          if(!neutral||neutral.e!==r.e){c.echo('The neutral face must belong to the same solid.');continue;}
          const selected=H.faceOf(r.e,r.face.faceId),neutralFace=H.faceOf(r.e,neutral.face.faceId);
          const ang=await c.number('Specify draft angle for this face',{def:c.app.draftAng??5});if(typeof ang!=='number')continue;
          try{const result=H.draftFaces(K.bakedShape(r.e),[selected],ang,neutralFace),ne=Solid3dCommands.solidEntity(c,result,r.e);c.replace(r.e,[ne]);ents=ents.map(x=>x===r.e?ne:x);c.app.draftAng=ang;n+=1;c.echo(`General face drafted by ${ang} degrees.`);}catch(err){c.echo(err.message);}
          continue;
        }
        c.app.faceHl = [{ e: r.e, face: r.face }];
        const angles = anglesOf(r.e);
        const now = angles[hit.loop][hit.idx];
        const ang = await c.number(`Specify the draft angle for this face`, { def: now });
        c.app.faceHl = [];
        if (typeof ang !== 'number') continue;
        angles[hit.loop][hit.idx] = ang;
        c.app.draftAng = ang;
        try {
          apply(r.e, angles);
          n += 1;
          c.echo(`Face drafted by ${ang} degrees.`);
        } catch (err) {
          c.echo(err.message);
        }
      }
    } finally {
      c.app.faceHl = [];
    }
    if (n) c.echo(`${n} draft operation(s) applied.`);
  }

  // DRAFTDEMO: builds the sample step by step (each step is its own undo entry, shown in the Model History panel)
  /** DRAFTDEMO: builds a sample part with drafted faces. */
  static async draftDemo(c) {
    await Solid3dCommands.ensureKernel(c);
    const app = c.app;
    setTimeout(() => Solid3dCommands.buildDraftSample(app), 0);
  }

  /** @private The sample part of DRAFTDEMO. */
  static buildDraftSample(app) {
    const doc = app.doc;
    const d5 = Math.tan((5 * Math.PI) / 180);
    const W = 100;
    const D = 60;
    const H = 40;
    const mk = (shape, layer, src) => {
      const e = doc.stamp(
        E.mk('solid3d', {
          ...K.solidProps(shape),
          bb: Solid3dCommands.boundsOf(shape),
          ...(src ? { src } : {}),
        }),
      );
      e.layer = layer;
      return e;
    };
    const loop = [
      { x: 0, y: 0, b: 0 },
      { x: W, y: 0, b: 0 },
      { x: W, y: D, b: 0 },
      { x: 0, y: D, b: 0 },
    ];
    const src = { kind: 'prism', loops: [loop], z0: 0, h: H, taper: 0 };
    app.edit('LAYER BODY / TOOL / OUTLINE', () => {
      for (const [n, col] of [
        ['BODY', 4],
        ['TOOL', 6],
        ['OUTLINE', 2],
      ])
        if (!doc.hasLayer(n)) doc.addLayer(n, { color: col });
      doc.cur.layer = 'BODY';
    });
    app.edit('BOX 100 x 60 x 40', () => {
      doc.add(mk(K.makeBox(W, D, H), 'BODY', src), 'model');
    });
    app.edit('DRAFT side faces 5 deg', () => {
      const b = doc.model.find((e) => e.type === 'solid3d');
      const ne = mk(K.draftPrism(src.loops, 0, H, 5), 'BODY', { ...src, taper: 5 });
      doc.replace(b, [ne], 'model');
    });
    // drafted tool cone for the centre hole (the hole walls lean 5 degrees too: it widens toward the top)
    app.edit('CONE tool, hole R12 (TOOL layer)', () => {
      const r0 = 12;
      const z0 = -2;
      const z1 = H + 2;
      doc.add(
        mk(K.makeCone(r0 + z0 * d5, r0 + z1 * d5, z1 - z0, W / 2, D / 2, z0), 'TOOL'),
        'model',
      );
    });
    app.edit('SUBTRACT hole from body', () => {
      const sols = doc.model.filter((e) => e.type === 'solid3d');
      const body = sols.find((e) => e.layer === 'BODY');
      const tool = sols.find((e) => e.layer === 'TOOL');
      const res = mk(K.cut(K.bakedShape(body), K.bakedShape(tool)), 'BODY');
      doc.remove([body.id, tool.id], 'model');
      doc.add(res, 'model');
    });
    app.edit('OUTLINE plan footprint', () => {
      const p = doc.stamp(
        E.mk('pline', { pts: loop.map((q) => ({ x: q.x, y: q.y, b: 0 })), closed: true }),
      );
      p.layer = 'OUTLINE';
      doc.add(p, 'model');
    });
    app.setVisualStyle('conceptual');
    app.setPreset3D('swiso');
    app.zoomExtents(false);
    if (app.ui && app.ui.showHistory) app.ui.showHistory(true);
    app.echo(
      'Sample built: box 100 x 60 x 40, 5 degree draft on every side face, drafted hole in the centre. Click a step in the Model History panel to go back to it.',
    );
  }

  /** VIEW3D: switches to a preset 3D view. */
  static async view3d(c) {
    let name = c.arg;
    if (!name) {
      const k = await c.keyword(
        `Enter an option [${Object.keys(VIEW_KW).join('/')}]`,
        Object.keys(VIEW_KW),
        'SW Isometric',
      );
      name = VIEW_KW[k];
    }
    if (!name) return;
    await Solid3dCommands.ensureKernel(c).catch(() => {});
    c.app.setPreset3D(name);
    c.app.zoomExtents(false);
  }

  // one-step switch from 2D drafting to the 3D view: SW isometric, hidden-line style, zoomed to fit (return with VSCURRENT > 2dwireframe)
  /** 3D: goes to the 3D view. */
  static async go3d(c) {
    await Solid3dCommands.ensureKernel(c).catch(() => {});
    c.app.setVisualStyle(c.app.settings.vstylePref || 'hidden');
    c.app.setPreset3D('swiso');
    c.app.zoomExtents(false);
    c.echo('3D view (SW Isometric). Type 2D to return to the 2D wireframe view.');
  }

  /** 2D: goes back to the plan view. */
  static async go2d(c) {
    c.app.setVisualStyle('2dwireframe');
    c.app.zoomExtents(false);
    c.echo('2D wireframe view.');
  }

  /** VPOINT: sets the viewing direction. */
  static async vpoint(c) {
    const o = await c.keyword(
      'Specify a view point or [Rotate] <display compass and tripod>',
      ['Rotate'],
      'Rotate',
    );
    if (o !== 'Rotate') return;
    const az = await c.angle('Enter angle in XY plane from X axis', { def: G.rad(-135) });
    if (typeof az !== 'number') return;
    const el = await c.angle('Enter angle from XY plane', { def: G.rad(35) });
    if (typeof el !== 'number') return;
    if (!c.app.v3) c.app.enter3D(null);
    c.app.v3.az = G.deg(az);
    c.app.v3.el = G.deg(el);
    c.app.v3.preset = '';
    c.app.emit('view3d');
    c.app.zoomExtents(false);
  }

  /** 3DORBIT: turns the view in real time. */
  static async orbit3d(c) {
    if (!c.app.v3) c.app.enter3D('swiso');
    await c.app.request(
      'rt',
      'Press Esc or Enter to exit, or right-click to display shortcut menu.',
      { mode: 'orbit' },
    );
  }

  /** VSCURRENT: sets the visual style (wireframe, hidden, shaded, ...). */
  static async visualStyle(c) {
    const opts = [
      '2dwireframe',
      'Wireframe',
      'Hidden',
      'Conceptual',
      'Realistic',
      'Shaded',
      'shaded with Edges',
      'Xray',
    ];
    let k = c.arg;
    if (!k) {
      const r = await c.keyword(`Enter an option [${opts.join('/')}]`, opts, 'Hidden');
      k = r;
    }
    const map = {
      '2dwireframe': '2dwireframe',
      wireframe: 'wireframe',
      hidden: 'hidden',
      conceptual: 'conceptual',
      realistic: 'shaded',
      shaded: 'shaded',
      'shaded with edges': 'shadedEdges',
      xray: 'xray',
    };
    const key = map[String(k).toLowerCase()];
    if (!key) return;
    await Solid3dCommands.ensureKernel(c).catch(() => {});
    c.app.setVisualStyle(key);
  }

  /** PERSPECTIVE: perspective projection. */
  static async perspective(c) {
    if (!c.app.v3) c.app.enter3D('swiso');
    c.app.v3.persp = true;
    c.app.changed();
    c.echo('Perspective projection.');
  }

  /** PARALLEL: parallel projection. */
  static async parallel(c) {
    if (!c.app.v3) c.app.enter3D('swiso');
    c.app.v3.persp = false;
    c.app.changed();
    c.echo('Parallel projection.');
  }

  /** PLAN: back to the plan view. */
  static async plan(c) {
    if (c.app.v3) c.app.setPreset3D('top');
    c.app.zoomExtents();
  }

  /** ELEV: sets the elevation and thickness of new 2D objects. */
  static async elev(c) {
    const cur = c.app.v3 ? c.app.v3.elev : c.doc.elev || 0;
    const v = await c.dist('Specify new default elevation', { def: cur });
    if (typeof v !== 'number') return;
    c.doc.elev = v;
    if (c.app.v3) c.app.v3.elev = v;
    c.echo(`Elevation = ${v}`);
  }

  // ------------------------------------------------------------------ properties
  /** MASSPROP: volume, area and centre of solids (2D regions when there are no solids). */
  static async massProp(c) {
    const ents = await c.select('Select objects', {
      filter: (e) => solidsOnly(e) || E.isClosed(e) || e.type === 'hatch',
    });
    if (!ents.length) return;
    const solids = ents.filter(solidsOnly);
    if (solids.length) {
      await Solid3dCommands.ensureKernel(c);
      for (const e of solids) {
        const s = baked(e);
        const b = Solid3dCommands.boundsOf(s);
        const cm = Solid3dCommands.safely(() => K.centroid(s), null);
        c.echo('---------------- SOLIDS ----------------');
        c.echo(`Volume:               ${c.fmt(K.volume(s))}`);
        c.echo(`Surface area:         ${c.fmt(K.area(s))}`);
        c.echo(
          `Bounding box:         X: ${c.fmt(b.x0)} -- ${c.fmt(b.x1)}   Y: ${c.fmt(b.y0)} -- ${c.fmt(b.y1)}   Z: ${c.fmt(b.z0)} -- ${c.fmt(b.z1)}`,
        );
        if (cm)
          c.echo(
            `Centroid:             X: ${c.fmt(cm[0])}   Y: ${c.fmt(cm[1])}   Z: ${c.fmt(cm[2])}`,
          );
      }
      c.ui.showTextWindow(true);
      return;
    }
    if (masspropRegions) {
      c.setSel(ents);
      return masspropRegions(c);
    }
  }

  // FLATSHOT (SOLVIEW / SOLDRAW in AutoCAD 2006): turn the 3D model to the angle you want, then send what you see to the 2D drawing: the visible edges as solid lines
  // and the hidden edges as dashed lines, fitted into a rectangle you draw (or at a scale you give).
  /** FLATSHOT: a 2D drawing of the visible and hidden lines of the solids. */
  static async flatShot(c) {
    await Solid3dCommands.ensureKernel(c);
    const app = c.app;
    if (!app.v3)
      return c.echo(
        'FLATSHOT sends the solids, as they look in the 3D view, to the 2D drawing. Type 3D (or use the ViewCube / 3DORBIT) and turn the model to the angle you want, then run FLATSHOT.',
      );
    const all = app.solids();
    if (!all.length) return c.echo('There are no solids to project.');
    let solids = app.selectedEnts().filter((e) => e.type === 'solid3d');
    if (!solids.length) {
      const picked = await c.select('Select the solids to project <Enter = all visible solids>', {
        filter: (e) => e.type === 'solid3d',
      });
      solids = picked.length ? picked : all;
    }
    const b = app.v3.basis();
    const flat = flatten(solids, { r: b.r, u: b.u, f: b.f });
    if (!flat.bbox) return c.echo('Nothing to project.');
    c.echo(
      `View projected: ${flat.visible.length} visible and ${flat.hidden.length} hidden line(s). Now draw the rectangle for it.`,
    );
    app.exit3D(); // the rectangle is picked on the sheet in the plan view; the 3D view comes back with the 3D command
    const doc = c.doc;
    if (!doc.hasLayer('VISIBLE'))
      doc.addLayer('VISIBLE', { color: 7, ltype: 'Continuous', lw: 0.5 });
    if (!doc.hasLayer('HIDDEN')) doc.addLayer('HIDDEN', { color: 2, ltype: 'HIDDEN', lw: 0.25 });
    const mkLine = (pl, layer) => {
      const e =
        pl.length === 2
          ? E.mk('line', { p1: pl[0], p2: pl[1] })
          : E.mk('pline', { pts: pl.map((q) => ({ x: q.x, y: q.y, b: 0 })), closed: false });
      e.layer = doc.layer(layer).name;
      return e;
    };
    const ents = (pl) => [
      ...pl.visible.map((x) => mkLine(x, 'VISIBLE')),
      ...pl.hidden.map((x) => mkLine(x, 'HIDDEN')),
    ];
    let placed;
    let scale;
    const p1 = await c.point('Specify the first corner of the rectangle for the view [Scale]', {
      kw: ['Scale'],
    });
    if (p1 === 'Scale') {
      const s = await c.number('Scale of the view (1 = full size)', { def: 1 });
      if (typeof s !== 'number' || !(s > 0)) return;
      const at = await c.point('Specify the lower-left corner of the view', {
        preview: (q) => ents(place(flat, s, q.x, q.y)),
      });
      if (!isPt(at)) return;
      placed = place(flat, s, at.x, at.y);
      scale = s;
    } else {
      if (!isPt(p1)) return;
      const p2 = await c.point('Specify the opposite corner', {
        base: p1,
        noOrtho: true,
        rubber: false,
        preview: (q) => {
          const f = fitInto(flat, p1.x, p1.y, q.x, q.y);
          const r = E.mk('pline', {
            pts: [
              [p1.x, p1.y],
              [q.x, p1.y],
              [q.x, q.y],
              [p1.x, q.y],
            ].map(([x, y]) => ({ x, y, b: 0 })),
            closed: true,
          });
          r._dash = [5, 4];
          return [r, ...ents(f)];
        },
      });
      if (!isPt(p2)) return;
      if (Math.abs(p2.x - p1.x) < 1e-9 || Math.abs(p2.y - p1.y) < 1e-9)
        return c.echo('The rectangle has no size.');
      const f = fitInto(flat, p1.x, p1.y, p2.x, p2.y);
      placed = f;
      scale = f.scale;
    }
    c.addAll(ents(placed));
    c.echo(
      `FLATSHOT: ${placed.visible.length} visible and ${placed.hidden.length} hidden line(s) on layers VISIBLE and HIDDEN, scale ${+scale.toPrecision(4)}:1. Type 3D to go back to the 3D view.`,
    );
  }

  /** Registers the commands of this file in their original order (a later definition of a name wins). */
  static register() {
    def3d('BOX', Solid3dCommands.box);
    def3d('CYLINDER CYL', Solid3dCommands.cylinder);
    def3d('SPHERE', Solid3dCommands.sphere);
    def3d('CONE', Solid3dCommands.cone);
    def3d('WEDGE WE', Solid3dCommands.wedge);
    def3d('TORUS TOR', Solid3dCommands.torus);
    def3d('PYRAMID PYR', Solid3dCommands.pyramid);
    def3d('EXTRUDE EXT', Solid3dCommands.extrude);
    def3d('REVOLVE REV', Solid3dCommands.revolve);
    def('UNION UNI', Solid3dCommands.union);
    def('SUBTRACT SU', Solid3dCommands.subtract);
    def('INTERSECT IN', Solid3dCommands.intersect);
    def3d('INTERFERE INF', Solid3dCommands.interfere);
    def3d('FILLETEDGE FE', (c) => Solid3dCommands.edgeOp(c, 'fillet'));
    def3d('CHAMFEREDGE CE', (c) => Solid3dCommands.edgeOp(c, 'chamfer'));
    def3d('SLICE SL', Solid3dCommands.slice);
    def3d('3DMOVE 3M', Solid3dCommands.move3d);
    def3d('ROTATE3D 3DROTATE 3R', Solid3dCommands.rotate3d);
    def3d('3DMIRROR 3DMI', Solid3dCommands.mirror3d);
    def3d('3DARRAY 3A', Solid3dCommands.array3d);
    def3d('TAPERFACES DRAFT TF', Solid3dCommands.taperFaces);
    def3d('DRAFTDEMO SAMPLE3D', Solid3dCommands.draftDemo);
    def3d('VIEW3D 3DVIEW', Solid3dCommands.view3d);
    def3d('GO3D 3D', Solid3dCommands.go3d);
    def3d('GO2D 2D', Solid3dCommands.go2d);
    def3d('VPOINT VP', Solid3dCommands.vpoint);
    def3d('3DORBIT ORBIT 3DO', Solid3dCommands.orbit3d);
    def3d('VSCURRENT SHADEMODE VS', Solid3dCommands.visualStyle);
    def3d('PERSPECTIVE', Solid3dCommands.perspective);
    def3d('PARALLEL', Solid3dCommands.parallel);
    def3d('PLAN', Solid3dCommands.plan);
    def3d('ELEV', Solid3dCommands.elev);
    def('MASSPROP', Solid3dCommands.massProp);
    def3d('FLATSHOT SOLVIEW SOLDRAW', Solid3dCommands.flatShot);
    void PRESET_LABELS;
    void alias;
  }
}

Solid3dCommands.register();
