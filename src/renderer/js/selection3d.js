/** Pure geometry used by 3D picking, object snaps and the Face UCS overlay. */

const xyz = (p) => Array.isArray(p) ? p : [p.x, p.y, p.z || 0];
const unit = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-15 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Point at half the accumulated 3D length of a polyline, including tessellated curved edges. */
export function polylineMidpoint(points) {
  if (!points || points.length < 2) return null;
  const lens = [];
  let total = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = xyz(points[i]), b = xyz(points[i + 1]);
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    lens.push(l); total += l;
  }
  if (total <= 1e-15) return xyz(points[0]);
  let left = total / 2;
  for (let i = 0; i < lens.length; i += 1) {
    if (left > lens[i] && i + 1 < lens.length) { left -= lens[i]; continue; }
    const a = xyz(points[i]), b = xyz(points[i + 1]), t = lens[i] > 1e-15 ? left / lens[i] : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  return xyz(points.at(-1));
}

/** Area-weighted centre and outward normal of one triangle group in a solid display mesh. */
export function faceFrame(mesh, face) {
  if (!mesh || !face || face.count < 3) return null;
  let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0, weight = 0;
  for (let i = face.start; i + 2 < face.start + face.count; i += 3) {
    const a = mesh.idx[i] * 3, b = mesh.idx[i + 1] * 3, c = mesh.idx[i + 2] * 3;
    const ab = [mesh.pos[b] - mesh.pos[a], mesh.pos[b + 1] - mesh.pos[a + 1], mesh.pos[b + 2] - mesh.pos[a + 2]];
    const ac = [mesh.pos[c] - mesh.pos[a], mesh.pos[c + 1] - mesh.pos[a + 1], mesh.pos[c + 2] - mesh.pos[a + 2]];
    let cr = cross(ab, ac);
    const w = Math.hypot(...cr);
    if (w <= 1e-15) continue;
    if (mesh.nrm) {
      const vn = [mesh.nrm[a], mesh.nrm[a + 1], mesh.nrm[a + 2]];
      if (cr[0] * vn[0] + cr[1] * vn[1] + cr[2] * vn[2] < 0) cr = cr.map((q) => -q);
    }
    px += (mesh.pos[a] + mesh.pos[b] + mesh.pos[c]) / 3 * w;
    py += (mesh.pos[a + 1] + mesh.pos[b + 1] + mesh.pos[c + 1]) / 3 * w;
    pz += (mesh.pos[a + 2] + mesh.pos[b + 2] + mesh.pos[c + 2]) / 3 * w;
    nx += cr[0]; ny += cr[1]; nz += cr[2]; weight += w;
  }
  const n = unit([nx, ny, nz]);
  return weight > 1e-15 && n ? { p: [px / weight, py / weight, pz / weight], n } : null;
}

/** Stable right-handed axes for a plane whose Z direction is `normal`. */
export function faceAxes(normal) {
  const z = unit(xyz(normal));
  if (!z) return null;
  const seed = Math.abs(z[2]) < 0.88 ? [0, 0, 1] : [0, 1, 0];
  const x = unit(cross(seed, z));
  const y = x && unit(cross(z, x));
  return x && y ? { x, y, z } : null;
}

/** Closest point on a 3D polyline after it is projected to screen pixels. */
export function nearestProjectedPoint(points, project, sx, sy) {
  if (!points || points.length < 2) return null;
  let best = null;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = xyz(points[i]), b = xyz(points[i + 1]);
    const as = project(a), bs = project(b);
    const dx = bs.x - as.x, dy = bs.y - as.y, l2 = dx * dx + dy * dy;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((sx - as.x) * dx + (sy - as.y) * dy) / l2)) : 0;
    const qx = as.x + dx * t, qy = as.y + dy * t, d = Math.hypot(qx - sx, qy - sy);
    if (!best || d < best.d) best = {
      p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
      d, segment: i, t,
    };
  }
  return best;
}

/** Closest point on one triangle to an arbitrary model-space point. */
export function closestPointOnTriangle(point, av, bv, cv) {
  const p=xyz(point),a=xyz(av),b=xyz(bv),c=xyz(cv);
  const ab=b.map((v,i)=>v-a[i]),ac=c.map((v,i)=>v-a[i]),ap=p.map((v,i)=>v-a[i]);
  const d1=ab[0]*ap[0]+ab[1]*ap[1]+ab[2]*ap[2],d2=ac[0]*ap[0]+ac[1]*ap[1]+ac[2]*ap[2];
  if(d1<=0&&d2<=0)return a;
  const bp=p.map((v,i)=>v-b[i]),d3=ab[0]*bp[0]+ab[1]*bp[1]+ab[2]*bp[2],d4=ac[0]*bp[0]+ac[1]*bp[1]+ac[2]*bp[2];
  if(d3>=0&&d4<=d3)return b;
  const vc=d1*d4-d3*d2;if(vc<=0&&d1>=0&&d3<=0){const v=d1/(d1-d3);return a.map((q,i)=>q+v*ab[i]);}
  const cp=p.map((v,i)=>v-c[i]),d5=ab[0]*cp[0]+ab[1]*cp[1]+ab[2]*cp[2],d6=ac[0]*cp[0]+ac[1]*cp[1]+ac[2]*cp[2];
  if(d6>=0&&d5<=d6)return c;
  const vb=d5*d2-d1*d6;if(vb<=0&&d2>=0&&d6<=0){const w=d2/(d2-d6);return a.map((q,i)=>q+w*ac[i]);}
  const va=d3*d6-d5*d4;if(va<=0&&(d4-d3)>=0&&(d5-d6)>=0){const bc=c.map((q,i)=>q-b[i]),w=(d4-d3)/((d4-d3)+(d5-d6));return b.map((q,i)=>q+w*bc[i]);}
  const den=1/(va+vb+vc),v=vb*den,w=vc*den;return a.map((q,i)=>q+ab[i]*v+ac[i]*w);
}

/** Closest point on all triangles belonging to one display-mesh face. */
export function closestPointOnFace(mesh, face, point) {
  if(!mesh||!face||face.count<3)return null;let best=null;const p=xyz(point);
  for(let i=face.start;i+2<face.start+face.count;i+=3){
    const at=mesh.idx[i]*3,bt=mesh.idx[i+1]*3,ct=mesh.idx[i+2]*3;
    const vertex=(j)=>[mesh.pos[j],mesh.pos[j+1],mesh.pos[j+2]];
    const q=closestPointOnTriangle(p,vertex(at),vertex(bt),vertex(ct)),d=Math.hypot(q[0]-p[0],q[1]-p[1],q[2]-p[2]);
    if(!best||d<best.d)best={p:q,d};
  }
  return best;
}

/** 3D snaps use pixels; midpoints and centres intentionally have a larger capture range. */
export function snapReach(aperture, kind) {
  if (kind === 'mid') return aperture * 1.6;
  if (kind === 'gcen' || kind === 'cen') return aperture * 1.35;
  return aperture * 1.15;
}

/** Large XY/YZ/ZX cutting-plane cards centred on a target bounding box. */
export function planePickerChoices(bounds, padding = 1.22) {
  if (!bounds || bounds.length !== 2) return [];
  const lo = xyz(bounds[0]), hi = xyz(bounds[1]);
  if ([...lo, ...hi].some((v) => !Number.isFinite(v))) return [];
  const c = lo.map((v, i) => (v + hi[i]) / 2);
  const span = lo.map((v, i) => Math.max(0, hi[i] - v));
  const floor = Math.max(1e-6, Math.hypot(...span) * 0.22);
  const h = span.map((v) => Math.max(floor, v * padding / 2));
  const corners = (a, b) => [
    c.map((v, i) => v - a[i] - b[i]), c.map((v, i) => v + a[i] - b[i]),
    c.map((v, i) => v + a[i] + b[i]), c.map((v, i) => v - a[i] + b[i]),
  ];
  return [
    { name: 'XY', center: [...c], normal: [0, 0, 1], corners: corners([h[0], 0, 0], [0, h[1], 0]) },
    { name: 'YZ', center: [...c], normal: [1, 0, 0], corners: corners([0, h[1], 0], [0, 0, h[2]]) },
    { name: 'ZX', center: [...c], normal: [0, 1, 0], corners: corners([0, 0, h[2]], [h[0], 0, 0]) },
  ];
}

const pointInConvex = (poly, x, y) => {
  let sign = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const z = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (Math.abs(z) < 1e-7) continue;
    if (sign && Math.sign(z) !== sign) return false;
    sign = Math.sign(z);
  }
  return true;
};

const segmentDistance = (a, b, x, y) => {
  const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
  const t = d2 > 1e-12 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / d2)) : 0;
  return Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
};

/** Chooses the projected cutting plane under the pointer, with an edge-friendly pixel margin. */
export function pickPlaneChoice(choices, project, sx, sy, margin = 10) {
  let best = null;
  for (const choice of choices || []) {
    const poly = choice.corners.map((p) => project(p));
    if (poly.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) continue;
    const inside = pointInConvex(poly, sx, sy);
    const edge = Math.min(...poly.map((p, i) => segmentDistance(p, poly[(i + 1) % poly.length], sx, sy)));
    if (!inside && edge > margin) continue;
    const area = Math.abs(poly.reduce((n, p, i) => n + p.x * poly[(i + 1) % poly.length].y - p.y * poly[(i + 1) % poly.length].x, 0)) / 2;
    const score = (inside ? 0 : 1e6) + edge - Math.min(area, 1e5) * 1e-6;
    if (!best || score < best.score) best = { ...choice, projected: poly, score };
  }
  return best;
}

/** Intersects a camera ray with an arbitrary work plane. */
export function rayPlanePoint(ray, plane) {
  if (!ray || !plane) return null;
  const o = xyz(ray.o), d = xyz(ray.d), p = xyz(plane.o), n = unit(xyz(plane.n));
  if (!n) return null;
  const den = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1] + (p[2] - o[2]) * n[2]) / den;
  return { x: o[0] + d[0] * t, y: o[1] + d[1] * t, z: o[2] + d[2] * t };
}
