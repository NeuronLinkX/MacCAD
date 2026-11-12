/**
 * @file view3d.js
 * @brief 3D camera.
 *
 * Implements the same small interface as the 2D View (`w2s`, `s2w`, `zoom`, `cx`, `cy`) so that the
 * existing 2D drawing code can project flat entities into a 3D view unchanged.
 *
 * Contents: Vec3 (array-vector helpers), PRESETS / PRESET_LABELS (named views), View3D (the camera),
 * RayMath (picking helpers).
 *
 * Angles are in degrees (az = around the vertical axis, el = above the horizon); vectors are
 * `[x, y, z]` arrays; screen coordinates are pixels with y down.
 */

/* ============================================================================================
 * 1. CONSTANTS AND VECTOR HELPERS
 * ========================================================================================== */
const D2R = Math.PI / 180;

/** Small vector helpers for `[x, y, z]` arrays. */
class Vec3 {
  /** @returns {number[]} a - b. */
  static sub(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  }

  /** @returns {number} dot product. */
  static dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  /** @returns {number[]} cross product a x b. */
  static cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }

  /** @returns {number[]} unit vector (the input itself scaled by 1 when it has no length). */
  static norm(a) {
    const l = Math.hypot(...a) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  }
}

const sub = Vec3.sub;
const dot = Vec3.dot;
const cross = Vec3.cross;
const norm = Vec3.norm;

/** Named views: camera azimuth and elevation in degrees. */
export const PRESETS = {
  top: { az: -90, el: 90 },
  bottom: { az: -90, el: -90 },
  front: { az: -90, el: 0 },
  back: { az: 90, el: 0 },
  left: { az: 180, el: 0 },
  right: { az: 0, el: 0 },
  swiso: { az: -135, el: 35.264 },
  seiso: { az: -45, el: 35.264 },
  neiso: { az: 45, el: 35.264 },
  nwiso: { az: 135, el: 35.264 },
};
/** Names shown for the named views. */
export const PRESET_LABELS = {
  top: 'Top',
  bottom: 'Bottom',
  front: 'Front',
  back: 'Back',
  left: 'Left',
  right: 'Right',
  swiso: 'SW Isometric',
  seiso: 'SE Isometric',
  neiso: 'NE Isometric',
  nwiso: 'NW Isometric',
};

/* ============================================================================================
 * 2. CAMERA
 * ========================================================================================== */

/** Orbit / pan / zoom camera looking at `target`, orthographic or perspective. */
export class View3D {
  /**
   * @param {{az?: number, el?: number, target?: number[], dist?: number, persp?: boolean, w?: number, h?: number, elev?: number, preset?: string}} [o]
   */
  constructor(o = {}) {
    this.is3d = true;
    this.az = o.az ?? -135;
    this.el = o.el ?? 35.264; // degrees
    this.target = o.target ? [...o.target] : [0, 0, 0];
    this.dist = o.dist ?? 500; // camera distance (perspective) / half-height in world units = dist * tan(fov/2)
    this.persp = o.persp ?? false;
    this.fov = 40 * D2R;
    this.w = o.w ?? 800;
    this.h = o.h ?? 600;
    this.elev = o.elev ?? 0; // z of the working plane used for point input
    this.preset = o.preset || 'swiso';
  }
  /** @returns {object} the camera state (what is stored with the drawing). */
  save() {
    return {
      az: this.az,
      el: this.el,
      target: [...this.target],
      dist: this.dist,
      persp: this.persp,
      elev: this.elev,
      preset: this.preset,
    };
  }
  /**
   * Jumps to a named view (see PRESETS).
   * @param {string} name preset name
   * @returns {boolean} false when there is no such preset
   */
  setPreset(name) {
    const p = PRESETS[name];
    if (!p) return false;
    this.az = p.az;
    this.el = p.el;
    this.preset = name;
    return true;
  }
  /** @returns {{d: number[], f: number[], r: number[], u: number[]}} camera basis: d = target->camera, f = forward, r = right, u = up. */
  basis() {
    const az = this.az * D2R;
    const el = this.el * D2R;
    const d = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)]; // from target to camera
    const f = [-d[0], -d[1], -d[2]];
    const r = [-Math.sin(az), Math.cos(az), 0];
    const u = cross(r, f);
    return { d, f, r, u: norm(u) };
  }
  /** @returns {number[]} the camera position. */
  eye() {
    const { d } = this.basis();
    return [
      this.target[0] + d[0] * this.dist,
      this.target[1] + d[1] * this.dist,
      this.target[2] + d[2] * this.dist,
    ];
  }
  /** Pixels per world unit (the 2D View calls this `zoom`). */
  get zoom() {
    return this.persp
      ? this.h / (2 * this.dist * Math.tan(this.fov / 2))
      : this.h / (2 * this.dist * Math.tan(this.fov / 2));
  }
  set zoom(z) {
    this.dist = this.h / (2 * Math.tan(this.fov / 2) * z);
  }
  get cx() {
    return this.target[0];
  }
  set cx(v) {
    this.target[0] = v;
  }
  get cy() {
    return this.target[1];
  }
  set cy(v) {
    this.target[1] = v;
  }
  /**
   * Projects a world point to the screen.
   * @param {{x: number, y: number, z?: number}} p
   * @returns {{x: number, y: number, depth: number}} pixels (y down) and the distance along the view direction
   */
  w2s(p) {
    const { r, u, f } = this.basis();
    const eye = this.eye();
    const v = sub([p.x, p.y, p.z || 0], eye);
    const x = dot(v, r);
    const y = dot(v, u);
    const z = dot(v, f);
    if (this.persp) {
      const fp = this.h / 2 / Math.tan(this.fov / 2);
      const zz = Math.max(z, 1e-6);
      return { x: this.w / 2 + (x / zz) * fp, y: this.h / 2 - (y / zz) * fp, depth: z };
    }
    const s = this.zoom;
    return { x: this.w / 2 + x * s, y: this.h / 2 - y * s, depth: z };
  }
  /**
   * The picking ray through a pixel.
   * @returns {{o: number[], d: number[]}} origin and direction
   */
  ray(sx, sy) {
    const { r, u, f } = this.basis();
    const eye = this.eye();
    if (this.persp) {
      const fp = this.h / 2 / Math.tan(this.fov / 2);
      const dx = (sx - this.w / 2) / fp;
      const dy = -(sy - this.h / 2) / fp;
      return {
        o: eye,
        d: norm([
          f[0] + r[0] * dx + u[0] * dy,
          f[1] + r[1] * dx + u[1] * dy,
          f[2] + r[2] * dx + u[2] * dy,
        ]),
      };
    }
    const s = this.zoom;
    const dx = (sx - this.w / 2) / s;
    const dy = -(sy - this.h / 2) / s;
    return {
      o: [
        eye[0] + r[0] * dx + u[0] * dy,
        eye[1] + r[1] * dx + u[1] * dy,
        eye[2] + r[2] * dx + u[2] * dy,
      ],
      d: f,
    };
  }
  /**
   * Pixel -> point on the horizontal plane z (default: the working plane `elev`).
   * @returns {{x: number, y: number, z: number}}
   */
  s2w(sx, sy, z = this.elev) {
    const { o, d } = this.ray(sx, sy);
    if (Math.abs(d[2]) < 1e-6) {
      const q = this.w2s({ x: this.target[0], y: this.target[1], z });
      void q;
      return { x: this.target[0], y: this.target[1], z };
    }
    const t = (z - o[2]) / d[2];
    return { x: o[0] + d[0] * t, y: o[1] + d[1] * t, z };
  }
  /** Rotates the camera by a mouse movement of (dx, dy) pixels. */
  orbit(dx, dy) {
    this.az -= dx * 0.4;
    this.el = Math.max(-90, Math.min(90, this.el + dy * 0.4));
    this.preset = '';
  }
  /** Moves the target sideways by a mouse movement of (dx, dy) pixels. */
  pan(dx, dy) {
    const { r, u } = this.basis();
    const k = (2 * this.dist * Math.tan(this.fov / 2)) / this.h;
    for (let i = 0; i < 3; i += 1) this.target[i] += (-dx * r[i] + dy * u[i]) * k;
  }
  /** Moves the camera nearer (factor > 1) or farther (factor < 1). */
  dolly(factor) {
    this.dist = Math.max(1e-4, Math.min(1e9, this.dist / factor));
  }
  /** Zooms about a pixel so the point under it stays under it. */
  zoomAt(sx, sy, factor) {
    const before = this.s2w(sx, sy, this.target[2]);
    this.dolly(factor);
    const after = this.s2w(sx, sy, this.target[2]);
    this.target[0] += before.x - after.x;
    this.target[1] += before.y - after.y;
  }
  /**
   * Frames a world bounding box: the window is filled by what is really seen (the 8 corners of the
   * box projected on the screen), not by the sphere around the box.
   * @param {{x0: number, x1: number, y0: number, y1: number, z0?: number, z1?: number}} b
   */
  fit(b) {
    const c = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, ((b.z0 ?? 0) + (b.z1 ?? 0)) / 2];
    const rad = Math.max(1e-6, Math.hypot(b.x1 - b.x0, b.y1 - b.y0, (b.z1 ?? 0) - (b.z0 ?? 0)) / 2);
    this.target = c;
    if (this.persp) {
      this.dist =
        (rad / Math.sin(this.fov / 2)) * 0.95 * (this.h < this.w ? 1 : this.w / this.h + 0.2);
      return;
    }
    const { r, u } = this.basis();
    let hx = 1e-9;
    let hy = 1e-9;
    for (const x of [b.x0, b.x1])
      for (const y of [b.y0, b.y1])
        for (const z of [b.z0 ?? 0, b.z1 ?? 0]) {
          const p = [x - c[0], y - c[1], z - c[2]];
          hx = Math.max(hx, Math.abs(dot(p, r)));
          hy = Math.max(hy, Math.abs(dot(p, u)));
        }
    const need = Math.max(hy, hx / Math.max(1e-6, this.w / this.h)) * 1.04; // half of the height in world units that is needed, 4 % margin
    this.dist = need / Math.tan(this.fov / 2);
  }
  /**
   * 4x4 column-major matrices for WebGL.
   * @param {number} near near clip distance
   * @param {number} far far clip distance
   * @returns {{V: number[], P: number[], VP: number[]}} view, projection and their product
   */
  matrices(near, far) {
    const { r, u, f } = this.basis();
    const e = this.eye();
    const V = [
      r[0],
      u[0],
      -f[0],
      0,
      r[1],
      u[1],
      -f[1],
      0,
      r[2],
      u[2],
      -f[2],
      0,
      -dot(r, e),
      -dot(u, e),
      dot(f, e),
      1,
    ];
    const asp = this.w / this.h;
    let P;
    if (this.persp) {
      const t = 1 / Math.tan(this.fov / 2);
      P = [
        t / asp,
        0,
        0,
        0,
        0,
        t,
        0,
        0,
        0,
        0,
        (far + near) / (near - far),
        -1,
        0,
        0,
        (2 * far * near) / (near - far),
        0,
      ];
    } else {
      const hh = this.dist * Math.tan(this.fov / 2);
      const ww = hh * asp;
      P = [
        1 / ww,
        0,
        0,
        0,
        0,
        1 / hh,
        0,
        0,
        0,
        0,
        -2 / (far - near),
        0,
        0,
        0,
        -(far + near) / (far - near),
        1,
      ];
    }
    const VP = new Array(16).fill(0);
    for (let c = 0; c < 4; c += 1)
      for (let rr = 0; rr < 4; rr += 1)
        for (let k = 0; k < 4; k += 1) VP[c * 4 + rr] += P[k * 4 + rr] * V[c * 4 + k];
    return { V, P, VP };
  }
}

/**
 * Adapts an arbitrary planar drawing coordinate system to a 3D camera.
 *
 * Ordinary drawing entities keep their mature 2D geometry (x/y, bulges, radii), while `plane`
 * records where that local drawing lies in model space.  This lets LINE, PLINE, CIRCLE, MOVE,
 * ROTATE and the rest of the 2D toolchain work unchanged on a front/side face.
 */
export class PlaneView {
  constructor(camera, plane) {
    this.camera = camera;
    this.plane = plane;
    this.is3d = true;
  }
  get w() { return this.camera.w; }
  get h() { return this.camera.h; }
  get zoom() { return this.camera.zoom; }
  get elev() { return 0; }
  ray(sx, sy) { return this.camera.ray(sx, sy); }
  basis() { return this.camera.basis(); }
  /** Local drawing point -> model-space point. */
  toWorld(p) {
    const { o, x, y, n } = this.plane;
    const z = p.z || 0;
    return {
      x: o[0] + x[0] * p.x + y[0] * p.y + n[0] * z,
      y: o[1] + x[1] * p.x + y[1] * p.y + n[1] * z,
      z: o[2] + x[2] * p.x + y[2] * p.y + n[2] * z,
    };
  }
  /** Model-space point -> local drawing point. */
  fromWorld(p) {
    const { o, x, y, n } = this.plane;
    const d = [p.x - o[0], p.y - o[1], (p.z || 0) - o[2]];
    return {
      x: dot(d, x),
      y: dot(d, y),
      z: dot(d, n),
    };
  }
  w2s(p) { return this.camera.w2s(this.toWorld(p)); }
  /** Pixel -> local point on this plane (or a parallel plane at local z). */
  s2w(sx, sy, z = 0) {
    const ray = this.camera.ray(sx, sy);
    const origin = {
      x: this.plane.o[0] + this.plane.n[0] * z,
      y: this.plane.o[1] + this.plane.n[1] * z,
      z: this.plane.o[2] + this.plane.n[2] * z,
    };
    const den = dot(ray.d, this.plane.n);
    if (Math.abs(den) < 1e-10) return { x: 0, y: 0, z };
    const t = dot(
      [origin.x - ray.o[0], origin.y - ray.o[1], origin.z - ray.o[2]],
      this.plane.n,
    ) / den;
    const world = {
      x: ray.o[0] + ray.d[0] * t,
      y: ray.o[1] + ray.d[1] * t,
      z: ray.o[2] + ray.d[2] * t,
    };
    const local = this.fromWorld(world);
    return { x: local.x, y: local.y, ...(z ? { z } : {}) };
  }
}

/* ============================================================================================
 * 3. PICKING HELPERS
 * ========================================================================================== */

/** Ray intersection tests. */
export class RayMath {
  /**
   * Ray / triangle intersection (Moller-Trumbore).
   * @param {number[]} o ray origin
   * @param {number[]} d ray direction
   * @param {number[]} a first triangle corner
   * @param {number[]} b second triangle corner
   * @param {number[]} c third triangle corner
   * @returns {number|null} distance along the ray, or null when it misses
   */
  static triangle(o, d, a, b, c) {
    const e1 = sub(b, a);
    const e2 = sub(c, a);
    const p = cross(d, e2);
    const det = dot(e1, p);
    if (Math.abs(det) < 1e-12) return null;
    const inv = 1 / det;
    const tv = sub(o, a);
    const uu = dot(tv, p) * inv;
    if (uu < 0 || uu > 1) return null;
    const q = cross(tv, e1);
    const vv = dot(d, q) * inv;
    if (vv < 0 || uu + vv > 1) return null;
    const t = dot(e2, q) * inv;
    return t > 1e-9 ? t : null;
  }
}

/* ============================================================================================
 * 4. COMPATIBILITY EXPORTS
 * ========================================================================================== */
export const rayTri = RayMath.triangle;
