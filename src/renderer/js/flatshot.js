/**
 * @file flatshot.js
 * @brief FLATSHOT: the solids as they look in a 3D view, as 2D lines.
 *
 * The solids are projected in parallel along the view direction. The result is the visible edges
 * and the hidden edges as polylines. The edges are the B-rep edges of the solids plus the
 * SILHOUETTE edges of curved surfaces (where the surface turns away from the viewer). Hidden-line
 * removal is done on the triangle meshes: a point is hidden when a triangle in front of it covers
 * it in the view.
 *
 * Steps of `FlatShot.flatten`:
 *   1. mesh every solid and project its triangles into the view
 *   2. build a uniform grid over the triangles for fast "is this point covered?" tests
 *   3. cut every edge into small pieces and mark each piece visible or hidden
 *   4. add the silhouette edges, remove duplicates, simplify
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import * as K from './kernel3d.js';
import * as E from './entities.js';

/* ============================================================================================
 * 2. CLASS
 * ========================================================================================== */

/** @returns {number} dot product of two 3-vectors. */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Static functions that turn solids into flat line work. */
export class FlatShot {
  /**
   * Flattens solids into line work as seen along a view direction.
   * @param {object[]} solids MacCAD `solid3d` entities
   * @param {{r: number[], u: number[], f: number[]}} basis view basis: right, up, forward (the
   *        direction the viewer looks)
   * @param {{detail?: number}} [opt] `detail` = how many pieces the longest model dimension is
   *        cut into when testing visibility (default 250)
   * @returns {{visible: number[][][], hidden: number[][][], bbox: object|null}} polylines
   *          `[[x, y], ...]` in the plane of the view (x to the right, y up), same units as the model
   */
  static flatten(solids, basis, { detail = 250 } = {}) {
    const { r, u, f } = basis;
    const tris = [];
    const lo = [1e18, 1e18, 1e18];
    const hi = [-1e18, -1e18, -1e18];
    const meshes = solids.map((e) => ({ e, m: K.solidMesh(e) }));
    for (const { m } of meshes)
      for (let i = 0; i < m.pos.length; i += 3)
        for (let k = 0; k < 3; k += 1) {
          lo[k] = Math.min(lo[k], m.pos[i + k]);
          hi[k] = Math.max(hi[k], m.pos[i + k]);
        }
    const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6);
    const step = size / detail;
    const eps = size * 2e-5;
    const proj = (x, y, z) => [
      x * r[0] + y * r[1] + z * r[2],
      x * u[0] + y * u[1] + z * u[2],
      x * f[0] + y * f[1] + z * f[2],
    ];

    // ---- triangles in view coordinates, with a facing flag, welded vertices for the silhouette search
    const weld = new Map();
    const wq = size * 1e-5;
    const wid = (x, y, z) => {
      const k = `${Math.round(x / wq)},${Math.round(y / wq)},${Math.round(z / wq)}`;
      let i = weld.get(k);
      if (i === undefined) {
        i = weld.size;
        weld.set(k, i);
      }
      return i;
    };
    const edgeFacing = new Map();
    const edgePts = new Map();
    let px0 = 1e18;
    let py0 = 1e18;
    let px1 = -1e18;
    let py1 = -1e18;
    for (const { m } of meshes) {
      for (let i = 0; i < m.idx.length; i += 3) {
        const ia = m.idx[i];
        const ib = m.idx[i + 1];
        const ic = m.idx[i + 2];
        const A = [m.pos[ia * 3], m.pos[ia * 3 + 1], m.pos[ia * 3 + 2]];
        const B = [m.pos[ib * 3], m.pos[ib * 3 + 1], m.pos[ib * 3 + 2]];
        const C = [m.pos[ic * 3], m.pos[ic * 3 + 1], m.pos[ic * 3 + 2]];
        const pa = proj(...A);
        const pb = proj(...B);
        const pc = proj(...C);
        const n = [
          (B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]),
          (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]),
          (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]),
        ];
        const nl = Math.hypot(...n);
        if (nl < 1e-18) continue;
        const nv = [
          m.nrm[ia * 3] + m.nrm[ib * 3] + m.nrm[ic * 3],
          m.nrm[ia * 3 + 1] + m.nrm[ib * 3 + 1] + m.nrm[ic * 3 + 1],
          m.nrm[ia * 3 + 2] + m.nrm[ib * 3 + 2] + m.nrm[ic * 3 + 2],
        ];
        const out = dot(n, nv) >= 0 ? 1 : -1; // the stored normals tell which way the triangle faces outwards
        const face = (dot(n, f) / nl) * out; // < 0: faces the viewer
        tris.push({ a: pa, b: pb, c: pc });
        for (const q of [pa, pb, pc]) {
          px0 = Math.min(px0, q[0]);
          px1 = Math.max(px1, q[0]);
          py0 = Math.min(py0, q[1]);
          py1 = Math.max(py1, q[1]);
        }
        const ids = [wid(...A), wid(...B), wid(...C)];
        const P3 = [A, B, C];
        for (let k = 0; k < 3; k += 1) {
          const j = (k + 1) % 3;
          const a = ids[k];
          const b = ids[j];
          if (a === b) continue;
          const key = a < b ? `${a}_${b}` : `${b}_${a}`;
          let rec = edgeFacing.get(key);
          if (!rec) {
            rec = [];
            edgeFacing.set(key, rec);
            edgePts.set(key, [P3[k], P3[j]]);
          }
          rec.push(face);
        }
      }
    }
    if (!tris.length) return { visible: [], hidden: [], bbox: null };

    // ---- uniform grid over the view for the occlusion test
    const N = Math.max(8, Math.min(160, Math.round(Math.sqrt(tris.length))));
    const gw = Math.max(1e-9, px1 - px0);
    const gh = Math.max(1e-9, py1 - py0);
    const cells = new Array(N * N);
    const cx = (x) => Math.min(N - 1, Math.max(0, Math.floor(((x - px0) / gw) * N)));
    const cy = (y) => Math.min(N - 1, Math.max(0, Math.floor(((y - py0) / gh) * N)));
    tris.forEach((t, ti) => {
      const x0 = Math.min(t.a[0], t.b[0], t.c[0]);
      const x1 = Math.max(t.a[0], t.b[0], t.c[0]);
      const y0 = Math.min(t.a[1], t.b[1], t.c[1]);
      const y1 = Math.max(t.a[1], t.b[1], t.c[1]);
      for (let gx = cx(x0); gx <= cx(x1); gx += 1)
        for (let gy = cy(y0); gy <= cy(y1); gy += 1) (cells[gy * N + gx] ||= []).push(ti);
    });
    // is the point (x, y) at depth d covered by a triangle that is nearer to the viewer?
    const hiddenAt = (x, y, d) => {
      const list = cells[cy(y) * N + cx(x)];
      if (!list) return false;
      for (const ti of list) {
        const t = tris[ti];
        const den = (t.b[1] - t.c[1]) * (t.a[0] - t.c[0]) + (t.c[0] - t.b[0]) * (t.a[1] - t.c[1]);
        if (Math.abs(den) < 1e-18) continue;
        const w1 = ((t.b[1] - t.c[1]) * (x - t.c[0]) + (t.c[0] - t.b[0]) * (y - t.c[1])) / den;
        const w2 = ((t.c[1] - t.a[1]) * (x - t.c[0]) + (t.a[0] - t.c[0]) * (y - t.c[1])) / den;
        const w3 = 1 - w1 - w2;
        const tol = -1e-7;
        if (w1 < tol || w2 < tol || w3 < tol) continue;
        if (w1 * t.a[2] + w2 * t.b[2] + w3 * t.c[2] < d - eps) return true; // smaller depth = nearer to the viewer
      }
      return false;
    };

    // ---- cut a 3D segment into small pieces, mark each as visible / hidden, and append to the two outputs as polylines
    const visible = [];
    const hidden = [];
    const runs = (p, q, st) => {
      // st = {poly, hid}: the polyline being extended; a change of visibility starts a new one
      const len = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 0; k < n; k += 1) {
        const t0 = k / n;
        const t1 = (k + 1) / n;
        const a = [p[0] + (q[0] - p[0]) * t0, p[1] + (q[1] - p[1]) * t0, p[2] + (q[2] - p[2]) * t0];
        const b = [p[0] + (q[0] - p[0]) * t1, p[1] + (q[1] - p[1]) * t1, p[2] + (q[2] - p[2]) * t1];
        const pm = proj((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
        const pa = proj(...a);
        const pb = proj(...b);
        const hid = hiddenAt(pm[0], pm[1], pm[2]);
        if (!st.poly || st.hid !== hid) {
          st.poly = [[pa[0], pa[1]]];
          st.hid = hid;
          (hid ? hidden : visible).push(st.poly);
        }
        st.poly.push([pb[0], pb[1]]);
      }
    };
    // B-rep edges (sharp edges, circles of holes, ...)
    for (const { e } of meshes)
      for (const ed of E.solidEdges(e)) {
        const st = { poly: null, hid: false };
        for (let i = 0; i + 1 < ed.pts.length; i += 1) runs(ed.pts[i], ed.pts[i + 1], st);
      }
    // silhouette edges: a mesh edge whose two triangles face different ways
    const sil = { visible: [], hidden: [] };
    for (const [key, facing] of edgeFacing) {
      if (facing.length !== 2) continue;
      const [s1, s2] = facing;
      if (!((s1 < -1e-6 && s2 > 1e-6) || (s1 > 1e-6 && s2 < -1e-6))) continue;
      const [p, q] = edgePts.get(key);
      const pa = proj(...p);
      const pb = proj(...q);
      const pm = proj((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2);
      (hiddenAt(pm[0], pm[1], pm[2]) ? sil.hidden : sil.visible).push([
        [pa[0], pa[1]],
        [pb[0], pb[1]],
      ]);
    }
    visible.push(...FlatShot.chain(sil.visible, size * 1e-5));
    hidden.push(...FlatShot.chain(sil.hidden, size * 1e-5));
    // bounding box of everything that is drawn (visible lines decide the size of the view; hidden lines are inside it)
    let bbox = null;
    for (const list of [visible, hidden])
      for (const pl of list)
        for (const q of pl)
          bbox = bbox
            ? {
                x0: Math.min(bbox.x0, q[0]),
                y0: Math.min(bbox.y0, q[1]),
                x1: Math.max(bbox.x1, q[0]),
                y1: Math.max(bbox.y1, q[1]),
              }
            : { x0: q[0], y0: q[1], x1: q[0], y1: q[1] };
    const tol = size * 2e-4;
    const visOnly = FlatShot.uncovered(visible, [], tol, step, true); // the same edge found twice (B-rep edge and silhouette) is drawn once
    const hiddenOnly = FlatShot.uncovered(
      FlatShot.uncovered(hidden, visOnly, tol, step),
      [],
      tol,
      step,
      true,
    ); // a hidden line exactly under a visible one is not drawn
    const st = size * 2e-4; // pieces of one straight edge become one line, curves keep as many points as the 0.02 % accuracy needs
    return {
      visible: FlatShot.dropTiny(
        visOnly.map((pl) => FlatShot.simplify(pl, st)),
        size * 1e-6,
      ),
      hidden: FlatShot.dropTiny(
        hiddenOnly.map((pl) => FlatShot.simplify(pl, st)),
        size * 1e-6,
      ),
      bbox,
    };
  }

  /**
   * The parts of the polylines `list` that are NOT within `tol` of any of the polylines `cover`.
   * With `self`, the pieces kept so far also cover later ones (drops duplicates inside `list`).
   * @private
   */
  static uncovered(list, cover, tol, step, self = false) {
    if (!list.length || (!cover.length && !self)) return list;
    const cell = Math.max(tol * 4, step * 2);
    const grid = new Map();
    const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    const addSeg = (a, b) => {
      for (
        let gx = Math.floor((Math.min(a[0], b[0]) - tol) / cell);
        gx <= Math.floor((Math.max(a[0], b[0]) + tol) / cell);
        gx += 1
      )
        for (
          let gy = Math.floor((Math.min(a[1], b[1]) - tol) / cell);
          gy <= Math.floor((Math.max(a[1], b[1]) + tol) / cell);
          gy += 1
        ) {
          const k = `${gx},${gy}`;
          (grid.get(k) || grid.set(k, []).get(k)).push([a, b]);
        }
    };
    for (const pl of cover) for (let i = 0; i + 1 < pl.length; i += 1) addSeg(pl[i], pl[i + 1]);
    const near = (x, y) => {
      for (const [a, b] of grid.get(key(x, y)) || []) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
        if (Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) <= tol) return true;
      }
      return false;
    };
    const out = [];
    for (const pl of list) {
      let cur = null;
      for (let i = 0; i + 1 < pl.length; i += 1) {
        const a = pl[i];
        const b = pl[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
        for (let k = 0; k < n; k += 1) {
          const p0 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
          const p1 = [a[0] + ((b[0] - a[0]) * (k + 1)) / n, a[1] + ((b[1] - a[1]) * (k + 1)) / n];
          if (near((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)) {
            cur = null;
            continue;
          }
          if (!cur) {
            cur = [p0];
            out.push(cur);
          }
          cur.push(p1);
          if (self) addSeg(p0, p1);
        }
      }
    }
    return out;
  }
  /**
   * Douglas-Peucker: drops the points that lie within `tol` of the line between their neighbours.
   * @private
   */
  static simplify(pl, tol) {
    if (pl.length <= 2) return pl;
    const keep = new Array(pl.length).fill(false);
    keep[0] = keep[pl.length - 1] = true;
    const stack = [[0, pl.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let far = -1;
      let fd = tol;
      const A = pl[a];
      const B = pl[b];
      const dx = B[0] - A[0];
      const dy = B[1] - A[1];
      const l2 = dx * dx + dy * dy;
      for (let i = a + 1; i < b; i += 1) {
        const t = l2
          ? Math.max(0, Math.min(1, ((pl[i][0] - A[0]) * dx + (pl[i][1] - A[1]) * dy) / l2))
          : 0;
        const d = Math.hypot(pl[i][0] - A[0] - t * dx, pl[i][1] - A[1] - t * dy);
        if (d > fd) {
          fd = d;
          far = i;
        }
      }
      if (far >= 0) {
        keep[far] = true;
        stack.push([a, far], [far, b]);
      }
    }
    return pl.filter((_, i) => keep[i]);
  }
  /** @private Removes polylines that are shorter than `tol` in total extent. */
  static dropTiny(list, tol) {
    return list.filter(
      (pl) =>
        pl.length >= 2 &&
        pl.some((q, i) => i && Math.hypot(q[0] - pl[0][0], q[1] - pl[0][1]) > tol),
    );
  }

  /** @private Joins 2-point segments that touch end to end into polylines (collinear pieces merge). */
  static chain(segs, tol) {
    const key = (p) => `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)}`;
    const byEnd = new Map();
    const used = new Array(segs.length).fill(false);
    segs.forEach((s, i) => {
      for (const p of [s[0], s[1]]) {
        const k = key(p);
        (byEnd.get(k) || byEnd.set(k, []).get(k)).push(i);
      }
    });
    const out = [];
    for (let i = 0; i < segs.length; i += 1) {
      if (used[i]) continue;
      used[i] = true;
      const pl = [segs[i][0], segs[i][1]];
      for (const end of [1, 0]) {
        for (;;) {
          const tip = end ? pl[pl.length - 1] : pl[0];
          const next = (byEnd.get(key(tip)) || []).find((j) => !used[j]);
          if (next === undefined) break;
          used[next] = true;
          const s = segs[next];
          const other = key(s[0]) === key(tip) ? s[1] : s[0];
          if (end) pl.push(other);
          else pl.unshift(other);
        }
      }
      // a straight chain of collinear pieces is one line
      const simp = [pl[0]];
      for (let k = 1; k < pl.length - 1; k += 1) {
        const a = simp[simp.length - 1];
        const b = pl[k];
        const c = pl[k + 1];
        const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if (Math.abs(cr) > tol * Math.hypot(c[0] - a[0], c[1] - a[1]) * 10) simp.push(b);
      }
      simp.push(pl[pl.length - 1]);
      out.push(simp);
    }
    return out;
  }

  /**
   * Places the flattened lines: scale `s`, the view's lower left corner goes to (ox, oy).
   * @returns {{visible: object[][], hidden: object[][]}} polylines of `{x, y}` points
   */
  static place(flat, s, ox, oy) {
    const { bbox } = flat;
    const map = (q) => ({ x: ox + (q[0] - bbox.x0) * s, y: oy + (q[1] - bbox.y0) * s });
    return {
      visible: flat.visible.map((pl) => pl.map(map)),
      hidden: flat.hidden.map((pl) => pl.map(map)),
    };
  }
  /**
   * Fits the view into the rectangle (x0,y0)-(x1,y1), centred.
   * @returns {{scale: number, visible: object[][], hidden: object[][]}} the scale and the placed lines
   */
  static fitInto(flat, x0, y0, x1, y1) {
    const { bbox } = flat;
    const bw = Math.max(1e-9, bbox.x1 - bbox.x0);
    const bh = Math.max(1e-9, bbox.y1 - bbox.y0);
    const rw = Math.abs(x1 - x0);
    const rh = Math.abs(y1 - y0);
    const s = Math.min(rw / bw, rh / bh);
    const ox = Math.min(x0, x1) + (rw - bw * s) / 2;
    const oy = Math.min(y0, y1) + (rh - bh * s) / 2;
    return { scale: s, ...FlatShot.place(flat, s, ox, oy) };
  }
}

/* ============================================================================================
 * 3. COMPATIBILITY EXPORTS
 * ========================================================================================== */
export const flatten = FlatShot.flatten;
export const place = FlatShot.place;
export const fitInto = FlatShot.fitInto;
