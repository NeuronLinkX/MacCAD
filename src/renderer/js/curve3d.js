/**
 * @file curve3d.js
 * @brief Turns drawn 2D objects (LINE, ARC, CIRCLE, POLYLINE, ELLIPSE, SPLINE, with or without the
 * drawing plane they were drawn on) into exact kernel edges and wires in model space, and builds
 * surfaces from them (extrude, cutting sheets that run through a body).
 */
import * as K from './kernel3d.js';
import * as E from './entities.js';
import * as H from './hybrid3d.js';

const R = () => K.lib();
const OC = () => R().getOC();
const TAU = Math.PI * 2;
const CURVES = new Set(['line', 'arc', 'circle', 'pline', 'ellipse', 'spline']);

/** @returns {boolean} true for a drawn object that has a path (it can be extruded or revolved into a sheet). */
export const isCurve = (e) => !!e && CURVES.has(e.type);

/** A local drawing point of an object -> model-space XYZ (the saved drawing plane is applied). */
export function worldPoint(e, p) {
  if (!e?.plane) return [p.x, p.y, p.z || 0];
  const { o, x, y, n } = e.plane;
  const z = p.z || 0;
  return [
    o[0] + x[0] * p.x + y[0] * p.y + n[0] * z,
    o[1] + x[1] * p.x + y[1] * p.y + n[1] * z,
    o[2] + x[2] * p.x + y[2] * p.y + n[2] * z,
  ];
}

/** The normal of the plane an object lies in (Z for an object without a saved plane). */
export const planeNormal = (e) => (e?.plane ? [...e.plane.n] : [0, 0, 1]);

/** Is the path of this object closed (a circle, a closed polyline, a full ellipse)? */
export function isClosedCurve(e) {
  if (e.type === 'circle') return true;
  if (e.type === 'pline') return !!e.closed;
  if (e.type === 'ellipse' || e.type === 'spline') {
    const prims = E.prims(e, null);
    if (!prims.length) return false;
    const a = prims[0].a, b = prims[prims.length - 1].b;
    return Math.hypot(a.x - b.x, a.y - b.y) < 1e-7;
  }
  return false;
}

const arcMid = (p) => {
  let span = (p.a1 - p.a0) % TAU;
  if (span <= 0) span += TAU;
  const am = p.a0 + span / 2;
  return { x: p.c.x + Math.cos(am) * p.r, y: p.c.y + Math.sin(am) * p.r };
};

/** The kernel edges (in model space, in drawing order) of a drawn object. */
export function curveEdges(e, doc) {
  const lib = R();
  const W = (p) => worldPoint(e, p);
  const out = [];
  for (const p of E.prims(e, doc)) {
    if (p.k === 's') {
      const a = W(p.a), b = W(p.b);
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9) continue;
      out.push(lib.makeLine(a, b));
    } else if (Math.abs(((p.a1 - p.a0) % TAU)) < 1e-9 || Math.abs(p.a1 - p.a0 - TAU) < 1e-9) {
      const n = e.plane ? e.plane.n : [0, 0, 1];
      out.push(lib.makeCircle(p.r, W(p.c), n));
    } else {
      const s = p.rev ? { x: p.c.x + Math.cos(p.a1) * p.r, y: p.c.y + Math.sin(p.a1) * p.r } : { x: p.c.x + Math.cos(p.a0) * p.r, y: p.c.y + Math.sin(p.a0) * p.r };
      const t = p.rev ? { x: p.c.x + Math.cos(p.a0) * p.r, y: p.c.y + Math.sin(p.a0) * p.r } : { x: p.c.x + Math.cos(p.a1) * p.r, y: p.c.y + Math.sin(p.a1) * p.r };
      out.push(lib.makeThreePointArc(W(s), W(arcMid(p)), W(t)));
    }
  }
  if (!out.length) throw new Error('This object has no usable path.');
  return out;
}

/** A kernel wire through the path of a drawn object. */
export function curveWire(e, doc) {
  return R().assembleWire(curveEdges(e, doc));
}

/** A flat face from a closed drawn object (null when the object is open). */
export function curveFace(e, doc) {
  if (!isClosedCurve(e)) return null;
  return R().makeFace(curveWire(e, doc));
}

/** Sweeps any wire, edge or face along a vector (open wire = sheet, face = solid). */
export const extrudeShape = (shape, v) => prism(shape, v);
function prism(shape, v) {
  const vec = new (R().Vector)(v);
  const maker = new (OC().BRepPrimAPI_MakePrism)(shape.wrapped, vec.wrapped, false, true);
  try { return R().cast(maker.Shape()); } finally { maker.delete(); vec.delete(); }
}

/**
 * Sweeps a drawn object along a straight vector. An open path or a closed path with `solid: false`
 * becomes a sheet; a closed path with `solid: true` becomes a solid.
 */
export function extrudeCurve(e, doc, vector, { solid = false, both = false } = {}) {
  const len = Math.hypot(...vector);
  if (!(len > 1e-9)) throw new Error('The extrusion distance must not be zero.');
  const unit = vector.map((v) => v / len);
  const nrm = planeNormal(e);
  const wire = curveWire(e, doc);
  try {
    let base = wire;
    let v = [...vector];
    if (both) {
      base = wire.clone().translate(unit.map((x) => -x * len));
      v = vector.map((x) => x * 2);
    }
    if (solid) {
      const face = R().makeFace(base);
      try {
        // a face is swept to a solid; its normal does not matter to the kernel, only that it is not parallel to the vector
        if (Math.abs(unit[0] * nrm[0] + unit[1] * nrm[1] + unit[2] * nrm[2]) < 1e-9) throw new Error('The extrusion direction lies in the plane of the closed shape; use a direction that leaves the plane.');
        return H.check(prism(face, v));
      } finally { face.delete(); }
    }
    return H.check(prism(base, v));
  } finally { wire.delete(); }
}

/** Turns a drawn object about an axis: a closed shape makes a solid (or a sheet), an open path a sheet. */
export function revolveCurve(e, doc, origin, direction, angleDeg, { solid = false } = {}) {
  const oc = OC();
  const wire = curveWire(e, doc);
  let src = wire;
  let face = null;
  if (solid) { face = R().makeFace(wire); src = face; }
  const axis = R().makeAx1(origin, direction);
  const maker = new oc.BRepPrimAPI_MakeRevol(src.wrapped, axis, (Math.min(360, Math.abs(angleDeg)) * Math.PI / 180) * (angleDeg < 0 ? -1 : 1), false);
  try { return H.check(R().cast(maker.Shape())); } finally { maker.delete(); axis.delete(); wire.delete(); if (face) face.delete(); }
}

const bounds3 = (shape) => shape.boundingBox.bounds;
const boundsDiagonal = (list) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of list) for (let i = 0; i < 3; i += 1) { lo[i] = Math.min(lo[i], b[0][i]); hi[i] = Math.max(hi[i], b[1][i]); }
  return Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
};

/**
 * The cutting sheet for a pick: a face of a sheet or solid (a flat one is extended until it passes
 * completely through the targets), or a drawn line / curve swept through the targets along its
 * plane normal (or along `direction`).
 * @param {{e: object, face?: object, curve?: object, edge?: object}} hit what the user picked
 * @param {object} doc the drawing
 * @param {object[]} targets the bodies that will be cut (their size sets how far the sheet reaches)
 * @param {number[]} [direction] a sweep direction for drawn curves
 */
export function cutterFromPick(hit, doc, targets, direction = null) {
  const shapes = targets.map((t) => K.bakedShape(t));
  if (hit.curve) {
    const e = hit.curve;
    const reach = boundsDiagonal([...shapes.map(bounds3), ...(() => { const w = curveWire(e, doc); try { return [bounds3(w)]; } finally { w.delete(); } })()]) * 2;
    const dir = direction || planeNormal(e);
    const wire = curveWire(e, doc);
    try {
      const n = Math.hypot(...dir);
      const u = dir.map((x) => x / n);
      const w0 = wire.clone().translate(u.map((x) => -x * reach));
      try { return H.check(prism(w0, u.map((x) => x * reach * 2))); } finally { w0.delete(); }
    } finally { wire.delete(); }
  }
  if (hit.face) {
    let face = H.faceOf(hit.e, hit.face.faceId);
    if (face.geomType === 'PLANE') {
      const reach = boundsDiagonal([...shapes.map(bounds3), bounds3(face)]) * 1.5;
      face = H.extendPlanar(face, reach);
    }
    return face;
  }
  throw new Error('Pick a face of a sheet or solid, or a drawn line or curve, as the cutting surface.');
}

/** Keeps the parts of a split that are on the chosen side(s) of a pick. */
export function splitBodies(targets, cutter) {
  const parts = [];
  const untouched = [];
  for (const t of targets) {
    try { parts.push(...H.split(K.bakedShape(t), cutter).map((shape) => ({ shape, source: t }))); }
    catch (error) {
      if (/does not divide/i.test(error.message || '')) untouched.push(t);
      else throw error;
    }
  }
  return { parts, untouched };
}
