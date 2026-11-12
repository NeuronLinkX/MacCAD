/**
 * @file xform3d.js
 * @brief Rotates and mirrors drawn curves (LINE, ARC, CIRCLE, POLYLINE, ...) in 3D. A curve keeps its
 * own drawing coordinates; what moves is the drawing plane (origin and axes) it lies on.
 */
import * as E from './entities.js';

const IDENT = () => ({ o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] });
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

/** @returns {boolean} true when a drawn object can be turned or mirrored out of the ground plane. */
export const canStand3d = (e) => E.PLANEABLE.has(e.type);

/** Rotates vector v about the unit axis a by `ang` radians (Rodrigues). */
export function rotateVector(v, a, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), k = cross(a, v), d = dot(a, v) * (1 - c);
  return [0, 1, 2].map((i) => v[i] * c + k[i] * s + a[i] * d);
}

/** Rotates a curve about an axis through `origin`. */
export function rotateCurve3d(e, origin, axis, ang) {
  const a = unit(axis), P = e.plane || IDENT();
  const o = rotateVector([0, 1, 2].map((i) => P.o[i] - origin[i]), a, ang).map((x, i) => x + origin[i]);
  e.plane = { o, x: rotateVector(P.x, a, ang), y: rotateVector(P.y, a, ang), n: rotateVector(P.n, a, ang) };
  return e;
}

/** Mirrors a curve about the plane through `origin` with normal `normal`. */
export function mirrorCurve3d(e, origin, normal) {
  const n = unit(normal), P = e.plane || IDENT();
  const v = (u) => u.map((x, i) => x - 2 * dot(u, n) * n[i]);
  const p = P.o.map((x, i) => x - origin[i]);
  const o = p.map((x, i) => x - 2 * dot(p, n) * n[i] + origin[i]);
  const mx = v(P.x), my = v(P.y);
  e.plane = { o, x: mx, y: my, n: cross(mx, my) };
  return e;
}
