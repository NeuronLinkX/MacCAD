/**
 * @file kernel3d.js
 * @brief The 3D solid kernel: OpenCascade (through replicad, loaded on first use) wrapped for the
 *        MacCAD entity model.
 *
 * A solid entity is `{type: 'solid3d', brep: <serialised B-rep>, ops: [pending operations]}`.
 * Moving / rotating only appends to `ops` (cheap, so previews stay interactive); booleans,
 * fillets and exports "bake" them into the B-rep.
 *
 * The functions are grouped in classes (Kernel, ShapeCache, Matrix4, Solids, SolidMesh,
 * Primitives, Profiles, EdgeTools, Boolean3d, SolidFiles); every function is also exported by its
 * short name (`makeBox`, `solidMesh`, ...) because the other files call them as `K.makeBox(...)`.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import * as G from './geom.js';

/* ============================================================================================
 * 2. MODULE STATE AND CONSTANTS
 * ========================================================================================== */

/** The replicad module once the kernel is loaded, else null. */
let R = null;
/** The pending load (so that parallel callers share one load). */
let initPromise = null;

/** Cache of shapes and meshes by B-rep text: brep string -> {shape, mesh}. */
const CACHE = new Map();
/** Shapes and meshes kept; an imported assembly raises it so that nothing is meshed twice. */
export let CACHE_MAX = 200;

/** Radians per mesh segment of a big imported model (the normal mesh uses 0.1). */
export const LOD_ANGLE = 0.25;
/** Mesh tolerance divisor: a normal solid / a big imported model (size / divisor). */
const MESH_DIVISOR = 2000;
const MESH_DIVISOR_LOD = 500;
/** Smallest mesh tolerance. */
const MIN_MESH_TOLERANCE = 0.005;
/** Half-size of the cutting block used by SLICE. */
const SLICE_BLOCK = 1e5;

/** Throws when the kernel is not loaded yet. @returns {object} the replicad module */
const need = () => {
  if (!R) throw new Error('The 3D kernel is not loaded yet.');
  return R;
};

/* ============================================================================================
 * 3. KERNEL LOADING
 * ========================================================================================== */

/** Loads the OpenCascade WebAssembly kernel. */
export class Kernel {
  /** @returns {boolean} true once the kernel is loaded. */
  static ready() {
    return !!R;
  }

  /** @returns {object|null} the replicad module (null before the kernel is loaded). */
  static lib() {
    return R;
  }

  /**
   * Loads the kernel (once; later calls get the same module).
   * @returns {Promise<object>} the replicad module
   */
  static async init() {
    if (R) return R;
    if (!initPromise) {
      initPromise = (async () => {
        const base = new URL('../vendor/occt/', import.meta.url);
        const [rep, ocMod] = await Promise.all([
          import('../vendor/occt/replicad.js'),
          import('../vendor/occt/replicad_single.js'),
        ]);
        const opts = { locateFile: (f) => new URL(f, base).href };
        const api = typeof window !== 'undefined' ? window.api : null;
        if (
          typeof location !== 'undefined' &&
          location.protocol === 'file:' &&
          api &&
          api.readBinary
        ) {
          opts.wasmBinary = await api.readBinary(
            decodeURIComponent(new URL('replicad_single.wasm', base).pathname),
          );
        }
        const oc = await ocMod.default(opts);
        rep.setOC(oc);
        R = rep;
        return R;
      })().catch((e) => {
        initPromise = null;
        throw e;
      });
    }
    return initPromise;
  }

  /** For Node tests: uses an already initialised replicad module. */
  static use(rep) {
    R = rep;
  }
}

/* ============================================================================================
 * 4. SHAPE CACHE
 * ========================================================================================== */

/** Least-recently-used cache of shapes and meshes, keyed by B-rep text. */
export class ShapeCache {
  /** Raises the cache size (never lowers it). */
  static setMax(n) {
    CACHE_MAX = Math.max(CACHE_MAX, n);
  }

  /** @returns {{shape: object, mesh: object|null}|undefined} the entry, marked as most recently used */
  static get(brep) {
    const v = CACHE.get(brep);
    if (v) {
      CACHE.delete(brep);
      CACHE.set(brep, v);
    }
    return v;
  }

  /** Stores an entry; the least recently used one is dropped beyond CACHE_MAX. */
  static set(brep, v) {
    CACHE.set(brep, v);
    if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  }

  /**
   * Remembers a ready-made shape (just imported), so the first mesh does not have to deserialise
   * the B-rep text again.
   */
  static seed(brep, shape) {
    ShapeCache.set(brep, { shape, mesh: null });
  }
}

/* ============================================================================================
 * 5. 4x4 MATRICES AND THE OPERATION LIST
 * ========================================================================================== */

/** 4x4 matrices (row-major, applied to column vectors) and the operation list of a solid. */
export class Matrix4 {
  /** @returns {number[]} the identity matrix. */
  static identity() {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }

  /** @returns {number[]} A x B. */
  static mul(A, B) {
    const C = new Array(16).fill(0);
    for (let r = 0; r < 4; r += 1)
      for (let c = 0; c < 4; c += 1)
        for (let k = 0; k < 4; k += 1) C[r * 4 + c] += A[r * 4 + k] * B[k * 4 + c];
    return C;
  }

  /** @returns {number[]} a translation. */
  static translation(x, y, z) {
    return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
  }

  /** @returns {number[]} a uniform scale by s about the point o. */
  static scaling(s, o) {
    return Matrix4.mul(
      Matrix4.translation(o[0], o[1], o[2]),
      Matrix4.mul(
        [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1],
        Matrix4.translation(-o[0], -o[1], -o[2]),
      ),
    );
  }

  /** @returns {number[]} a rotation by `ang` radians about the axis through o (Rodrigues). */
  static rotation(axis, ang, o) {
    const l = Math.hypot(...axis) || 1;
    const [x, y, z] = axis.map((v) => v / l);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const t = 1 - c;
    const Rm = [
      t * x * x + c,
      t * x * y - s * z,
      t * x * z + s * y,
      0,
      t * x * y + s * z,
      t * y * y + c,
      t * y * z - s * x,
      0,
      t * x * z - s * y,
      t * y * z + s * x,
      t * z * z + c,
      0,
      0,
      0,
      0,
      1,
    ];
    return Matrix4.mul(
      Matrix4.translation(o[0], o[1], o[2]),
      Matrix4.mul(Rm, Matrix4.translation(-o[0], -o[1], -o[2])),
    );
  }

  /** @returns {number[]} a mirror across the plane through point o with normal n. */
  static mirror(o, n) {
    const l = Math.hypot(...n) || 1;
    const [x, y, z] = n.map((v) => v / l);
    const Rm = [
      1 - 2 * x * x,
      -2 * x * y,
      -2 * x * z,
      0,
      -2 * x * y,
      1 - 2 * y * y,
      -2 * y * z,
      0,
      -2 * x * z,
      -2 * y * z,
      1 - 2 * z * z,
      0,
      0,
      0,
      0,
      1,
    ];
    return Matrix4.mul(
      Matrix4.translation(o[0], o[1], o[2]),
      Matrix4.mul(Rm, Matrix4.translation(-o[0], -o[1], -o[2])),
    );
  }

  /**
   * The matrix of a solid's pending operations: T translate, R rotate, S scale, M mirror.
   * @param {object[]} ops
   * @returns {number[]}
   */
  static fromOps(ops) {
    let M = Matrix4.identity();
    for (const op of ops || []) {
      const m =
        op.t === 'T'
          ? Matrix4.translation(...op.v)
          : op.t === 'R'
            ? Matrix4.rotation(op.a, op.ang, op.o)
            : op.t === 'S'
              ? Matrix4.scaling(op.s, op.o)
              : op.t === 'M'
                ? Matrix4.mirror(op.o, op.n)
                : Matrix4.identity();
      M = Matrix4.mul(m, M);
    }
    return M;
  }

  /** @returns {number[]} the point p [x, y, z] transformed by M. */
  static apply(M, p) {
    return [
      M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3],
      M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7],
      M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11],
    ];
  }
}

/* ============================================================================================
 * 6. SOLID SHAPES
 * ========================================================================================== */

/** Shapes of solid entities: access, pending operations, baking, edge dressing. */
export class Solids {
  /** @returns {{shape: object, mesh: object|null}} the cache entry of a solid's base shape (without pending ops). */
  static baseShape(e) {
    need();
    let c = ShapeCache.get(e.brep);
    if (!c) {
      c = { shape: R.deserializeShape(e.brep), mesh: null };
      ShapeCache.set(e.brep, c);
    }
    return c;
  }

  /**
   * Applies pending operations to a shape. The shape is consumed when there are any (replicad
   * transforms dispose their input).
   */
  static applyOps(shape, ops) {
    let s = shape;
    for (const op of ops || []) {
      if (op.t === 'T') s = s.translate(op.v[0], op.v[1], op.v[2]);
      else if (op.t === 'R') s = s.rotate((op.ang * 180) / Math.PI, op.o, op.a);
      else if (op.t === 'S') s = s.scale(op.s, op.o);
      else if (op.t === 'M') s = s.mirror(op.n, op.o);
    }
    return s;
  }

  /** @returns {object} the entity's real shape with all pending operations applied. */
  static bakedShape(e) {
    let s = Solids.baseShape(e).shape;
    // replicad transforms dispose the shape they are applied to, so never touch the cached base shape directly
    if (e.ops && e.ops.length) s = s.clone();
    return Solids.applyOps(s, e.ops);
  }

  /**
   * Rounds / chamfers the edges with the given mesh edge ids. Done on the BASE shape (the ids are
   * its hash codes); then the pending operations are re-applied.
   * @param {object} e the solid entity
   * @param {'fillet'|'chamfer'} kind
   * @param {number} value radius or distance
   * @param {number[]} edgeIds
   * @param {boolean} [all] true when every edge is dressed (the limit is then half the thinnest side)
   * @throws {Error} when the value is too large for the solid
   */
  static dressEdges(e, kind, value, edgeIds, all = false) {
    // OpenCascade can spin forever on a value that is far too large: refuse early (smaller than the thinnest side; rounding EVERY edge needs half of it)
    const bb = Solids.baseShape(e).shape.boundingBox.bounds;
    const thin = Math.min(bb[1][0] - bb[0][0], bb[1][1] - bb[0][1], bb[1][2] - bb[0][2]);
    if (value >= (all ? thin / 2 : thin) - 1e-9)
      throw new Error(
        `the value ${value} is too large for this solid: it must be smaller than ${+(all ? thin / 2 : thin).toPrecision(4)}`,
      );
    const ids = new Set(edgeIds);
    const base = Solids.baseShape(e).shape;
    const pick = (f) => f.when(({ element }) => ids.has(element.hashCode));
    const res = kind === 'fillet' ? base.fillet(value, pick) : base.chamfer(value, pick);
    return Solids.applyOps(res, e.ops);
  }

  /** @returns {object} the entity properties for a new solid made from a shape. */
  static props(shape, extra = {}) {
    return { type: 'solid3d', brep: shape.serialize(), ops: [], ...extra };
  }

  /** Bakes the pending operations of an entity into its B-rep. @returns {object} the entity */
  static bake(e) {
    if (e.ops && e.ops.length) {
      const s = Solids.bakedShape(e);
      e.brep = s.serialize();
      e.ops = [];
    }
    return e;
  }

  /** @returns {boolean} true when the mesh of this solid is already built (nothing is meshed to answer). */
  static meshReady(e) {
    const c = e.brep && ShapeCache.get(e.brep);
    return !!(c && c.mesh);
  }
}

/* ============================================================================================
 * 7. SOLID MESH
 * ========================================================================================== */

/** Display meshes of solids (in world coordinates, pending operations applied). */
export class SolidMesh {
  /** @private @returns {number[][]} [min, max] of a flat vertex array. */
  static vertexBounds(v) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < v.length; i += 3)
      for (let k = 0; k < 3; k += 1) {
        const x = v[i + k];
        if (x < lo[k]) lo[k] = x;
        if (x > hi[k]) hi[k] = x;
      }
    return [lo, hi];
  }

  /** @private Meshes a shape: triangles, normals, edge lines, face / edge groups and bounds. */
  static build(shape, tol = 0.05, ang = 0.1, quick = false) {
    const m = shape.mesh({ tolerance: tol, angularTolerance: ang });
    const ed = shape.meshEdges({ tolerance: tol, angularTolerance: ang });
    const bb = quick ? SolidMesh.vertexBounds(m.vertices) : shape.boundingBox.bounds;
    return {
      pos: Float32Array.from(m.vertices),
      nrm: Float32Array.from(m.normals),
      idx: Uint32Array.from(m.triangles),
      faceGroups: m.faceGroups || [],
      lines: Float32Array.from(ed.lines),
      edgeGroups: ed.edgeGroups || [],
      bounds: bb,
    };
  }

  /**
   * The display mesh of a solid entity (cached; the plain mesh is a stable object because the GL
   * buffer cache keys on identity).
   * @param {object} e the solid entity
   * @returns {{pos: Float32Array, nrm: Float32Array, idx: Uint32Array, lines: Float32Array,
   *   edgeGroups: object[], faceGroups: object[], bounds: number[][], M?: number[]}}
   */
  static of(e) {
    need();
    const c = Solids.baseShape(e);
    if (!c.mesh) {
      // e.lod: a big imported model (STEP): coarser curves and a looser tolerance, many times faster. Its size comes from e.bb (one bounding box per part, not four)
      let size;
      if (e.lod && e.bb)
        size = Math.max(e.bb.x1 - e.bb.x0, e.bb.y1 - e.bb.y0, e.bb.z1 - e.bb.z0, 1e-6);
      else {
        const bb = c.shape.boundingBox.bounds;
        size = Math.max(...bb[1].map((v, i) => v - bb[0][i]), 1e-6);
      }
      c.mesh = SolidMesh.build(
        c.shape,
        Math.max(size / (e.lod ? MESH_DIVISOR_LOD : MESH_DIVISOR), MIN_MESH_TOLERANCE),
        e.lod ? LOD_ANGLE : 0.1,
        !!e.lod,
      );
    }
    if (!e.ops || !e.ops.length) return c.plain || (c.plain = { ...c.mesh, M: null }); // stable object: the GL buffer cache keys on identity
    const key = JSON.stringify(e.ops);
    if (e._mk === key && e._mm) return e._mm;
    const M = Matrix4.fromOps(e.ops);
    const b = c.mesh;
    const tf = (arr, normal) => {
      const out = new Float32Array(arr.length);
      for (let i = 0; i < arr.length; i += 3) {
        const p = normal
          ? [
              M[0] * arr[i] + M[1] * arr[i + 1] + M[2] * arr[i + 2],
              M[4] * arr[i] + M[5] * arr[i + 1] + M[6] * arr[i + 2],
              M[8] * arr[i] + M[9] * arr[i + 1] + M[10] * arr[i + 2],
            ]
          : Matrix4.apply(M, [arr[i], arr[i + 1], arr[i + 2]]);
        out[i] = p[0];
        out[i + 1] = p[1];
        out[i + 2] = p[2];
      }
      return out;
    };
    const det =
      M[0] * (M[5] * M[10] - M[6] * M[9]) -
      M[1] * (M[4] * M[10] - M[6] * M[8]) +
      M[2] * (M[4] * M[9] - M[5] * M[8]);
    let idx = b.idx;
    if (det < 0) {
      // a mirror turns the triangles inside out: swap two corners of each
      idx = new Uint32Array(b.idx.length);
      for (let i = 0; i < idx.length; i += 3) {
        idx[i] = b.idx[i];
        idx[i + 1] = b.idx[i + 2];
        idx[i + 2] = b.idx[i + 1];
      }
    }
    const pos = tf(b.pos, false);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3)
      for (let k = 0; k < 3; k += 1) {
        lo[k] = Math.min(lo[k], pos[i + k]);
        hi[k] = Math.max(hi[k], pos[i + k]);
      }
    const out = {
      pos,
      nrm: tf(b.nrm, true),
      idx,
      lines: tf(b.lines, false),
      edgeGroups: b.edgeGroups,
      faceGroups: b.faceGroups,
      bounds: [lo, hi],
      M,
    };
    e._mk = key;
    e._mm = out;
    return out;
  }
}

/* ============================================================================================
 * 8. PRIMITIVES
 * ========================================================================================== */

/** Constructors of the basic solids (they return replicad shapes). */
export class Primitives {
  static box(w, d, h, x = 0, y = 0, z = 0) {
    return need()
      .makeBaseBox(w, d, h)
      .translate(x + w / 2, y + d / 2, z);
  }

  static cylinder(r, h, x = 0, y = 0, z = 0) {
    return need().makeCylinder(r, h, [x, y, z], [0, 0, 1]);
  }

  static sphere(r, x = 0, y = 0, z = 0) {
    return need().makeSphere(r).translate(x, y, z);
  }

  static cone(r1, r2, h, x = 0, y = 0, z = 0) {
    const lib_ = need();
    // profile in XZ; a pointed cone (r2 = 0) must not get a zero-length edge on the axis (the revolve of that profile fails: "This object has been deleted")
    let d = lib_
      .draw([0, 0])
      .hLine(r1)
      .lineTo([Math.max(r2, 0), h]);
    if (r2 > 1e-9) d = d.lineTo([0, h]);
    const sk = d.close();
    return sk.sketchOnPlane('XZ').revolve([0, 0, 1]).translate(x, y, z);
  }

  static torus(R1, r, x = 0, y = 0, z = 0) {
    const lib_ = need();
    return lib_
      .drawCircle(r)
      .translate(R1, 0)
      .sketchOnPlane('XZ')
      .revolve([0, 0, 1])
      .translate(x, y, z);
  }

  static wedge(w, d, h, x = 0, y = 0, z = 0) {
    const lib_ = need();
    return lib_
      .draw([0, 0])
      .hLine(w)
      .lineTo([0, h])
      .close()
      .sketchOnPlane('XZ')
      .extrude(-d)
      .translate(x, y, z);
  }

  static pyramid(r, sides, h, x = 0, y = 0, z = 0) {
    const lib_ = need();
    const pts = [];
    for (let i = 0; i < sides; i += 1) {
      const a = (Math.PI * 2 * i) / sides;
      pts.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    // a true apex: the base and one triangle per side are sewn into a closed solid
    const apex = [0, 0, h];
    const faces = [lib_.makePolygon(pts.map((q) => [q[0], q[1], 0]).reverse())];
    for (let i = 0; i < sides; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % sides];
      faces.push(lib_.makePolygon([[a[0], a[1], 0], [b[0], b[1], 0], apex]));
    }
    return lib_
      .makeSolid(faces)
      .translate(x, y, z);
  }
}

/* ============================================================================================
 * 9. PROFILES, EXTRUSION AND DRAFT
 * ========================================================================================== */

/** 2D profiles turned into sketches, extrusion and draft (taper) of prisms. */
export class Profiles {
  /**
   * A 2D profile (array of loops, each `[{x, y, b}]` with bulge) as sketch face(s) in the XY
   * plane at height z. The first loop is the outline, the others are holes.
   */
  static toSketch(loops, z = 0) {
    const lib_ = need();
    const drawLoop = (pts) => {
      const n = pts.length;
      let pen = lib_.draw([pts[0].x, pts[0].y]);
      for (let i = 0; i < n; i += 1) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        if (i === n - 1 && Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) break;
        if (i === n - 1) {
          if (a.b) {
            const ch = Math.hypot(b.x - a.x, b.y - a.y);
            pen = pen.sagittaArcTo([b.x, b.y], -(a.b * ch) / 2);
          }
          break;
        }
        if (a.b) {
          const ch = Math.hypot(b.x - a.x, b.y - a.y);
          pen = pen.sagittaArcTo([b.x, b.y], -(a.b * ch) / 2);
        } else pen = pen.lineTo([b.x, b.y]);
      }
      return pen.close();
    };
    let d = drawLoop(loops[0]);
    for (let i = 1; i < loops.length; i += 1) d = d.cut(drawLoop(loops[i]));
    return d.sketchOnPlane('XY', z);
  }

  /** A circle as a sketch in the XY plane at height z. */
  static circleSketch(cx, cy, r, z = 0) {
    return need().drawCircle(r).translate(cx, cy).sketchOnPlane('XY', z);
  }

  /** Extrudes a sketch by h, optionally tapering the sides by taperDeg degrees. */
  static extrude(sk, h, taperDeg = 0) {
    if (!taperDeg) return sk.extrude(h);
    // every side leans by the angle: the profile shrinks by h * tan(angle) on each side, so the factor depends on the size of the profile
    let half = 1;
    try {
      const [lo, hi] = sk.face().boundingBox.bounds;
      half = Math.max(1e-6, Math.min(hi[0] - lo[0], hi[1] - lo[1]) / 2);
    } catch { /* keeps the unit size */ }
    const f = Math.max(0.001, 1 - (Math.tan((taperDeg * Math.PI) / 180) * Math.abs(h)) / half);
    return sk.extrude(h, { extrusionProfile: { profile: 'linear', endFactor: f } });
  }

  /** @private Signed area of a polygon. */
  static polyArea2(p) {
    let a = 0;
    for (let i = 0; i < p.length; i += 1) {
      const q = p[(i + 1) % p.length];
      a += p[i].x * q.y - q.x * p[i].y;
    }
    return a / 2;
  }

  /**
   * Moves every edge of a polygon toward its interior: the top profile of a drafted prism is the
   * bottom profile moved inward by h * tan(angle) on every edge.
   * @param {{x: number, y: number}[]} pts straight edges only
   * @param {number|number[]} dists distance per edge (> 0 inward, < 0 outward), or one number for every edge
   * @returns {{x: number, y: number, b: number}[]}
   * @throws {Error} when the profile collapses (draft angle too large for the height)
   */
  static insetPoly(pts, dists) {
    const polyArea2 = Profiles.polyArea2;
    const n = pts.length;
    const sg = polyArea2(pts) >= 0 ? 1 : -1;
    const lines = [];
    const dd = (i) => (Array.isArray(dists) ? dists[i] || 0 : dists);
    for (let i = 0; i < n; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      const nx = (-dy / l) * sg;
      const ny = (dx / l) * sg;
      lines.push({ p: { x: a.x + nx * dd(i), y: a.y + ny * dd(i) }, v: { x: dx / l, y: dy / l } });
    }
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const L0 = lines[(i + n - 1) % n];
      const L1 = lines[i];
      const den = L0.v.x * L1.v.y - L0.v.y * L1.v.x;
      if (Math.abs(den) < 1e-9) {
        out.push({ x: L1.p.x, y: L1.p.y, b: 0 });
        continue;
      }
      const t = ((L1.p.x - L0.p.x) * L1.v.y - (L1.p.y - L0.p.y) * L1.v.x) / den;
      out.push({ x: L0.p.x + L0.v.x * t, y: L0.p.y + L0.v.y * t, b: 0 });
    }
    // an edge that reversed direction means the profile collapsed (draft angle too large for the height)
    for (let i = 0; i < n; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const c = out[i];
      const e = out[(i + 1) % n];
      if ((b.x - a.x) * (e.x - c.x) + (b.y - a.y) * (e.y - c.y) <= 0)
        throw new Error('The draft angle is too large for this height.');
    }
    if (polyArea2(out) * sg <= 1e-9)
      throw new Error('The draft angle is too large for this height.');
    return out;
  }

  /**
   * A prism whose side faces lean. Positive angles lean the material inward toward the top; hole
   * walls follow the same rule (they widen toward the top).
   * @param {object[][]} loops outline first, then holes (straight edges only)
   * @param {number} z0 bottom height
   * @param {number} h height
   * @param {number|number[][]} angles one angle (degrees) for every side face, or `[[angle per edge] per loop]`
   */
  static draftPrism(loops, z0, h, angles) {
    if (loops.some((l) => l.some((p) => p.b)))
      throw new Error('Draft needs straight edges (no arcs) in the profile.');
    const ang = (li, i) => (Array.isArray(angles) ? (angles[li] && angles[li][i]) || 0 : angles);
    const one = (li) => {
      const loop = loops[li];
      const hole = li > 0;
      const d = loop.map((_, i) => Math.tan((ang(li, i) * Math.PI) / 180) * h * (hole ? -1 : 1));
      return Profiles.toSketch([loop], z0).loftWith(
        Profiles.toSketch([Profiles.insetPoly(loop, d)], z0 + h),
        { ruled: true },
      );
    };
    let shape = one(0);
    for (let li = 1; li < loops.length; li += 1) shape = shape.cut(one(li));
    return shape;
  }

  /**
   * Which edge of a prism's profile does a picked side face belong to?
   * @param {object} e the solid entity (with `src.kind === 'prism'`)
   * @param {number[]} p a point on the face (world coordinates)
   * @param {number[]} n the face's outward normal (world coordinates)
   * @returns {{loop: number, idx: number}|null}
   */
  static prismEdgeOfFace(e, p, n) {
    const polyArea2 = Profiles.polyArea2;
    const s = e.src;
    if (!s || s.kind !== 'prism') return null;
    const M = Matrix4.fromOps(e.ops || []);
    const Rot = [
      [M[0], M[1], M[2]],
      [M[4], M[5], M[6]],
      [M[8], M[9], M[10]],
    ];
    const det =
      Rot[0][0] * (Rot[1][1] * Rot[2][2] - Rot[1][2] * Rot[2][1]) -
      Rot[0][1] * (Rot[1][0] * Rot[2][2] - Rot[1][2] * Rot[2][0]) +
      Rot[0][2] * (Rot[1][0] * Rot[2][1] - Rot[1][1] * Rot[2][0]);
    if (Math.abs(det) < 1e-12) return null;
    const inv = [
      [
        (Rot[1][1] * Rot[2][2] - Rot[1][2] * Rot[2][1]) / det,
        (Rot[0][2] * Rot[2][1] - Rot[0][1] * Rot[2][2]) / det,
        (Rot[0][1] * Rot[1][2] - Rot[0][2] * Rot[1][1]) / det,
      ],
      [
        (Rot[1][2] * Rot[2][0] - Rot[1][0] * Rot[2][2]) / det,
        (Rot[0][0] * Rot[2][2] - Rot[0][2] * Rot[2][0]) / det,
        (Rot[0][2] * Rot[1][0] - Rot[0][0] * Rot[1][2]) / det,
      ],
      [
        (Rot[1][0] * Rot[2][1] - Rot[1][1] * Rot[2][0]) / det,
        (Rot[0][1] * Rot[2][0] - Rot[0][0] * Rot[2][1]) / det,
        (Rot[0][0] * Rot[1][1] - Rot[0][1] * Rot[1][0]) / det,
      ],
    ];
    const mv = (A, v) => [
      A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2],
      A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2],
      A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2],
    ];
    const q = mv(inv, [p[0] - M[3], p[1] - M[7], p[2] - M[11]]);
    const nb = mv(
      [
        [Rot[0][0], Rot[1][0], Rot[2][0]],
        [Rot[0][1], Rot[1][1], Rot[2][1]],
        [Rot[0][2], Rot[1][2], Rot[2][2]],
      ],
      n,
    );
    const nl = Math.hypot(nb[0], nb[1]);
    if (nl < 0.3 || Math.abs(nb[2]) > 0.5) return null; // top / bottom faces cannot be drafted
    const nx = nb[0] / nl;
    const ny = nb[1] / nl;
    let best = null;
    s.loops.forEach((loop, li) => {
      const sg = polyArea2(loop) >= 0 ? 1 : -1;
      for (let i = 0; i < loop.length; i += 1) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const l = Math.hypot(dx, dy) || 1;
        let ox = (dy / l) * sg;
        let oy = (-dx / l) * sg;
        if (li > 0) {
          ox = -ox;
          oy = -oy;
        } // outward from the material
        if (ox * nx + oy * ny < 0.6) continue;
        const t = Math.max(0, Math.min(1, ((q[0] - a.x) * dx + (q[1] - a.y) * dy) / (l * l)));
        const d = Math.hypot(q[0] - (a.x + dx * t), q[1] - (a.y + dy * t));
        if (!best || d < best.d) best = { loop: li, idx: i, d };
      }
    });
    return best && { loop: best.loop, idx: best.idx };
  }
}

/* ============================================================================================
 * 10. EDGE SELECTION (FILLET / CHAMFER)
 * ========================================================================================== */

/** Helpers that choose edges for fillet and chamfer. */
export class EdgeTools {
  /** @returns {number[]} the mesh edge ids that bound a face (the edges of its outer and inner wires). */
  static faceEdgeIds(e, faceId) {
    const f = Solids.baseShape(e).shape.faces.find((x) => x.hashCode === faceId);
    return f ? f.edges.map((x) => x.hashCode) : [];
  }

  /**
   * The edges that continue the start edge with a smooth (tangent) transition, as a CAD "chain".
   * @param {{id: number, pts: number[][]}[]} edges all edges, in world coordinates
   * @param {number} startId the id of the picked edge
   * @param {number} [tolDeg] the largest bend that still counts as smooth
   * @returns {number[]} ids of the chain, including the start edge
   */
  static tangentChain(edges, startId, tolDeg = 8) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const ed of edges)
      for (const p of ed.pts)
        for (let k = 0; k < 3; k += 1) {
          lo[k] = Math.min(lo[k], p[k]);
          hi[k] = Math.max(hi[k], p[k]);
        }
    const eps = Math.max(1e-6, 1e-5 * Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1));
    const unit = (a, b) => {
      const v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const l = Math.hypot(...v) || 1;
      return [v[0] / l, v[1] / l, v[2] / l];
    };
    // the two ends of an edge with the direction that leads AWAY from the end into the edge
    const ends = (ed) => {
      const p = ed.pts;
      const n = p.length;
      return n < 2
        ? []
        : [
            { p: p[0], d: unit(p[0], p[1]) },
            { p: p[n - 1], d: unit(p[n - 1], p[n - 2]) },
          ];
    };
    const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= eps;
    const cosMin = Math.cos((tolDeg * Math.PI) / 180);
    const info = new Map(edges.map((ed) => [ed.id, ends(ed)]));
    const seen = new Set([startId]);
    const queue = [startId];
    while (queue.length) {
      const id = queue.pop();
      for (const a of info.get(id) || [])
        for (const ed of edges) {
          if (seen.has(ed.id)) continue;
          for (const b of info.get(ed.id) || []) {
            // tangent continuation: same point, and the directions leaving it point in opposite ways
            if (
              near(a.p, b.p) &&
              -(a.d[0] * b.d[0] + a.d[1] * b.d[1] + a.d[2] * b.d[2]) >= cosMin
            ) {
              seen.add(ed.id);
              queue.push(ed.id);
              break;
            }
          }
        }
    }
    return [...seen];
  }

  /** Rounds the edges with these hash codes (as reported in mesh.edgeGroups). */
  static fillet(shape, radius, edgeIds) {
    const set = new Set(edgeIds);
    return shape.fillet(radius, (f) => f.when(({ element }) => set.has(element.hashCode)));
  }

  /** Chamfers the edges with these hash codes. */
  static chamfer(shape, dist, edgeIds) {
    const set = new Set(edgeIds);
    return shape.chamfer(dist, (f) => f.when(({ element }) => set.has(element.hashCode)));
  }

  /** @returns {number[]} the hash codes of all edges of a shape. */
  static allEdgeIds(shape) {
    return shape.edges.map((e) => e.hashCode);
  }
}

/* ============================================================================================
 * 11. BOOLEANS, MEASURING, SLICING
 * ========================================================================================== */

/** Boolean operations, measurements and slicing of shapes. */
export class Boolean3d {
  static fuse(a, b) {
    return a.fuse(b);
  }

  static cut(a, b) {
    return a.cut(b);
  }

  static common(a, b) {
    return a.intersect(b);
  }

  /** @returns {number} the volume of a shape. */
  static volume(s) {
    return need().measureVolume(s);
  }

  /** @returns {number} the surface area of a shape. */
  static area(s) {
    return need().measureArea(s);
  }

  /** @returns {number[]|null} the centre of mass of a shape. */
  static centroid(s) {
    const p = need().measureShapeVolumeProperties(s);
    const c = p.centerOfMass || p.centre || p.center;
    return c ? [c.x ?? c[0], c.y ?? c[1], c.z ?? c[2]] : null;
  }

  /**
   * Slices a shape with a plane.
   * @param {object} shape
   * @param {number[]} origin a point on the plane
   * @param {number[]} normal the plane normal
   * @param {'positive'|'negative'|'both'} [keep] which side(s) to keep
   * @returns {object[]} the kept part(s)
   */
  static slice(shape, origin, normal, keep = 'positive') {
    const lib_ = need();
    const big = SLICE_BLOCK;
    const n = Array.isArray(normal) ? normal : [normal.x, normal.y, normal.z];
    const nl = Math.hypot(...n) || 1;
    const nn = n.map((v) => v / nl);
    const half = (side) => {
      const box = lib_.makeBaseBox(big * 2, big * 2, big).translate(0, 0, side > 0 ? 0 : -big); // block above (z>0) / below (z<0) the XY plane
      // rotate +Z to the normal
      const z = [0, 0, 1];
      const dot = z[0] * nn[0] + z[1] * nn[1] + z[2] * nn[2];
      let b = box;
      if (dot < 0.999999) {
        const axis = [
          z[1] * nn[2] - z[2] * nn[1],
          z[2] * nn[0] - z[0] * nn[2],
          z[0] * nn[1] - z[1] * nn[0],
        ];
        b = b.rotate((Math.acos(Math.max(-1, dot)) * 180) / Math.PI, [0, 0, 0], axis);
      }
      return b.translate(...origin);
    };
    if (keep === 'both') return [shape.intersect(half(1)), shape.intersect(half(-1))];
    return [shape.intersect(half(keep === 'negative' ? -1 : 1))];
  }
}

/* ============================================================================================
 * 12. FILES
 * ========================================================================================== */

/** STEP / STL / OBJ data. */
export class SolidFiles {
  /** @returns {Blob} a STEP file of the shapes. */
  static stepBlob(shapes) {
    const lib_ = need();
    const s = shapes.length === 1 ? shapes[0] : lib_.makeCompound(shapes);
    return s.blobSTEP();
  }

  /** @returns {Blob} a binary STL file of the shapes. */
  static stlBlob(shapes) {
    const lib_ = need();
    const s = shapes.length === 1 ? shapes[0] : lib_.makeCompound(shapes);
    return s.blobSTL({ tolerance: 0.01, angularTolerance: 0.1, binary: true });
  }

  /** Reads a STEP file. @param {Blob} blob @returns {Promise<object>} the shape */
  static async importStep(blob) {
    return need().importSTEP(blob);
  }

  /** @returns {string} an OBJ file of display meshes (one object per mesh). */
  static objText(meshes) {
    let out = '# MacCAD 2027 OBJ export\n';
    let off = 1;
    meshes.forEach((m, k) => {
      out += `o solid${k + 1}\n`;
      for (let i = 0; i < m.pos.length; i += 3)
        out += `v ${m.pos[i]} ${m.pos[i + 1]} ${m.pos[i + 2]}\n`;
      for (let i = 0; i < m.idx.length; i += 3)
        out += `f ${m.idx[i] + off} ${m.idx[i + 1] + off} ${m.idx[i + 2] + off}\n`;
      off += m.pos.length / 3;
    });
    return out;
  }
}

/* ============================================================================================
 * 13. SHORT-NAME EXPORTS
 * ========================================================================================== */
export const kernelReady = Kernel.ready;
export const lib = Kernel.lib;
export const initKernel = Kernel.init;
export const useKernel = Kernel.use;

export const setCacheMax = ShapeCache.setMax;
export const seedShape = ShapeCache.seed;

export const opsMatrix = Matrix4.fromOps;
export const applyM = Matrix4.apply;

export const baseShape = Solids.baseShape;
export const applyOps = Solids.applyOps;
export const bakedShape = Solids.bakedShape;
export const dressEdges = Solids.dressEdges;
export const solidProps = Solids.props;
export const bake = Solids.bake;
export const meshReady = Solids.meshReady;

export const solidMesh = SolidMesh.of;
export const mesh = SolidMesh.of;

export const makeBox = Primitives.box;
export const makeCylinder = Primitives.cylinder;
export const makeSphere = Primitives.sphere;
export const makeCone = Primitives.cone;
export const makeTorus = Primitives.torus;
export const makeWedge = Primitives.wedge;
export const makePyramid = Primitives.pyramid;

export const profileToSketch = Profiles.toSketch;
export const circleSketch = Profiles.circleSketch;
export const extrudeSketch = Profiles.extrude;
export const insetPoly = Profiles.insetPoly;
export const draftPrism = Profiles.draftPrism;
export const prismEdgeOfFace = Profiles.prismEdgeOfFace;

export const faceEdgeIds = EdgeTools.faceEdgeIds;
export const tangentChain = EdgeTools.tangentChain;
export const filletEdges = EdgeTools.fillet;
export const chamferEdges = EdgeTools.chamfer;
export const allEdgeIds = EdgeTools.allEdgeIds;

export const fuse = Boolean3d.fuse;
export const cut = Boolean3d.cut;
export const common = Boolean3d.common;
export const volume = Boolean3d.volume;
export const area = Boolean3d.area;
export const centroid = Boolean3d.centroid;
export const sliceShape = Boolean3d.slice;

export const stepBlob = SolidFiles.stepBlob;
export const stlBlob = SolidFiles.stlBlob;
export const importStep = SolidFiles.importStep;
export const objText = SolidFiles.objText;
