// Geometry for the cockpit parts made at load time (frame.js, coaming.js): a small mesh builder,
// profile sweeps along a list of frames, studs (fastener heads) and the per-vertex cavity term.
//
// * Normals are given, not computed: a profile says which of its corners are sharp (the normal is
//   split there) and which are rounded (one averaged normal), so a 4 mm bevel reads as a rounded
//   edge catching the light.
// * Every triangle is wound to face along its vertices' normals: the cockpit materials are
//   double-sided and three.js flips a back face's normal, so a triangle wound the wrong way would
//   be lit from the wrong side.
// * The cavity term (ckCavity, 0-255 per vertex, 255 open) is a fixed occlusion for the creases
//   that the interior analysis's 1.5 cm voxels cannot see (a fastener's foot, the root of a flange):
//   interior.js multiplies it into the per-vertex occlusion it computes.

import * as THREE from 'three';

export class MeshBuilder {
  constructor() {
    this.p = [];
    this.n = [];
    this.c = [];
    this.i = [];
  }

  get count() { return this.p.length / 3; }

  /** A vertex: position, unit normal, cavity (0 closed .. 1 open). Returns its index. */
  v(px, py, pz, nx, ny, nz, cav = 1) {
    this.p.push(px, py, pz);
    this.n.push(nx, ny, nz);
    this.c.push(cav);
    return this.count - 1;
  }

  vv(p, n, cav = 1) { return this.v(p.x, p.y, p.z, n.x, n.y, n.z, cav); }

  /** A triangle, wound to face along its vertices' normals (degenerate ones are left out). */
  tri(a, b, c) {
    const P = this.p, N = this.n;
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const wx = P[c * 3] - P[a * 3], wy = P[c * 3 + 1] - P[a * 3 + 1], wz = P[c * 3 + 2] - P[a * 3 + 2];
    const gx = uy * wz - uz * wy, gy = uz * wx - ux * wz, gz = ux * wy - uy * wx;
    if (gx * gx + gy * gy + gz * gz < 1e-16) return;
    const s = gx * (N[a * 3] + N[b * 3] + N[c * 3]) + gy * (N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1]) + gz * (N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2]);
    if (s >= 0) this.i.push(a, b, c); else this.i.push(a, c, b);
  }

  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }

  /** The geometry: position, normal, the index; the cavity in userData.ckCavity (Uint8Array). */
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.userData.ckCavity = Uint8Array.from(this.c, (x) => Math.round(255 * Math.min(1, Math.max(0, x))));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * A 2D profile (points {t, n, hard, cav}, in order round the solid: counterclockwise in the (t, n)
 * plane, so that its outside is on the right of the way round) expanded into vertices with
 * normals: a sharp corner (hard) gets two, one for each side. Returns {verts: [{t, n, nt, nn,
 * cav}], segs: [[a, b]]} (segments between vertex numbers).
 */
export function expandProfile(profile, closed) {
  const m = profile.length;
  const segN = [];
  for (let k = 0; k < (closed ? m : m - 1); k++) {
    const a = profile[k], b = profile[(k + 1) % m];
    const dt = b.t - a.t, dn = b.n - a.n, l = Math.hypot(dt, dn) || 1;
    segN.push([dn / l, -dt / l]);                  // right of the way round: outwards
  }
  const verts = [], first = [], last = [];
  for (let k = 0; k < m; k++) {
    const p = profile[k];
    const inN = k > 0 ? segN[k - 1] : closed ? segN[m - 1] : null;
    const outN = k < segN.length ? segN[k] : closed ? segN[0] : null;
    const cav = p.cav ?? 1;
    if (p.hard && inN && outN) {
      first[k] = verts.push({ t: p.t, n: p.n, nt: inN[0], nn: inN[1], cav, k, side: -1 }) - 1;
      last[k] = verts.push({ t: p.t, n: p.n, nt: outN[0], nn: outN[1], cav, k, side: 1 }) - 1;
    } else {
      let nt = (inN ? inN[0] : 0) + (outN ? outN[0] : 0), nn = (inN ? inN[1] : 0) + (outN ? outN[1] : 0);
      const l = Math.hypot(nt, nn) || 1;
      nt /= l; nn /= l;
      first[k] = last[k] = verts.push({ t: p.t, n: p.n, nt, nn, cav, k, side: 0 }) - 1;
    }
  }
  const segs = [];
  for (let k = 0; k < segN.length; k++) segs.push([last[k], first[(k + 1) % m]]);
  return { verts, segs };
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3();

/**
 * Sweep a profile along frames ({o, t, n}: the origin and the profile's two axes, Vector3s, in the
 * mesh's frame). Returns the vertex numbers per frame (rows), for caps.
 */
export function sweep(B, frames, profile, closed, cavAlong = null) {
  const { verts, segs } = expandProfile(profile, closed);
  const rows = [];
  frames.forEach((f, j) => {
    const row = [];
    const ca = cavAlong ? cavAlong(j) : 1;
    for (const q of verts) {
      _a.copy(f.o).addScaledVector(f.t, q.t).addScaledVector(f.n, q.n);
      _b.copy(f.t).multiplyScalar(q.nt).addScaledVector(f.n, q.nn).normalize();
      row.push(B.vv(_a, _b, q.cav * ca));
    }
    rows.push(row);
  });
  for (let j = 0; j + 1 < rows.length; j++) {
    const r0 = rows[j], r1 = rows[j + 1];
    for (const [a, b] of segs) B.quad(r0[a], r0[b], r1[b], r1[a]);
  }
  return { rows, verts };
}

/**
 * Sweep a profile that changes along the way: profiles[j] for frame j (the same number of points
 * and the same sharp corners in each; their normals are each profile's own).
 */
export function sweepProfiles(B, frames, profiles, closed) {
  const m = profiles[0].length, J = frames.length;
  // positions of the profile's points in every frame
  const P = frames.map((f, j) => profiles[j].map((q) => f.o.clone().addScaledVector(f.t, q.t).addScaledVector(f.n, q.n)));
  // normals: across the profile (both neighbours; one side of a sharp corner) x along the sweep,
  // on the side of the profile's own outward normal
  const tp = new THREE.Vector3(), ts = new THREE.Vector3(), nn = new THREE.Vector3(), ref = new THREE.Vector3();
  const rows = [];
  let segs = null;
  for (let j = 0; j < J; j++) {
    const e = expandProfile(profiles[j], closed);
    segs = segs || e.segs;
    const f = frames[j];
    const row = [];
    for (const q of e.verts) {
      const k = q.k;
      const prev = k > 0 ? k - 1 : closed ? m - 1 : k, next = k < m - 1 ? k + 1 : closed ? 0 : k;
      const a = q.side > 0 ? k : prev, b = q.side < 0 ? k : next;
      ref.copy(f.t).multiplyScalar(q.nt).addScaledVector(f.n, q.nn);
      tp.subVectors(P[j][b], P[j][a]);
      ts.subVectors(P[Math.min(J - 1, j + 1)][k], P[Math.max(0, j - 1)][k]);
      nn.crossVectors(ts, tp);
      if (nn.lengthSq() < 1e-16) nn.copy(ref);
      nn.normalize();
      if (nn.dot(ref) < 0) nn.negate();
      row.push(B.vv(P[j][k], nn, q.cav));
    }
    rows.push(row);
  }
  for (let j = 0; j + 1 < rows.length; j++) {
    const r0 = rows[j], r1 = rows[j + 1];
    for (const [a, b] of segs) B.quad(r0[a], r0[b], r1[b], r1[a]);
  }
  return rows;
}

/** Close the end of a sweep (frame f, the profile's points, facing along `dir`): a flat cap. */
export function cap(B, f, profile, dir) {
  const pts = profile.map((p) => new THREE.Vector2(p.t, p.n));
  const tris = THREE.ShapeUtils.triangulateShape(pts, []);
  const ids = profile.map((p) => {
    _a.copy(f.o).addScaledVector(f.t, p.t).addScaledVector(f.n, p.n);
    return B.vv(_a, dir, 0.8);
  });
  for (const [a, b, c] of tris) B.tri(ids[a], ids[b], ids[c]);
}

/**
 * A fastener head: a low dome of radius r and height h on a surface at `o` with normal `n`
 * (seg sides; its foot in the crease: cavity `foot`).
 */
export function stud(B, o, n, r, h, seg = 8, foot = 0.55) {
  const u = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0).cross(n).normalize() : new THREE.Vector3(1, 0, 0).cross(n).normalize();
  const w = new THREE.Vector3().crossVectors(n, u);
  const ring = (rr, hh, slope, cav) => {
    const ids = [];
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      _a.copy(o).addScaledVector(u, rr * ca).addScaledVector(w, rr * sa).addScaledVector(n, hh);
      _b.copy(u).multiplyScalar(ca * slope).addScaledVector(w, sa * slope).addScaledVector(n, 1).normalize();
      ids.push(B.vv(_a, _b, cav));
    }
    return ids;
  };
  const r0 = ring(r, -0.0004, 1.6, foot);           // (a little into the surface: no gap at its foot)
  const r1 = ring(r * 0.72, h * 0.8, 0.9, 1);
  _a.copy(o).addScaledVector(n, h);
  const top = B.vv(_a, n, 1);
  for (let k = 0; k < seg; k++) {
    const k1 = (k + 1) % seg;
    B.quad(r0[k], r0[k1], r1[k1], r1[k]);
    B.tri(r1[k], r1[k1], top);
  }
}

/** Unit vectors and points along a polyline by arc length: positions every `step` metres. */
export function alongPolyline(pts, step, margin = 0) {
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + pts[k].distanceTo(pts[k - 1]));
  const L = cum[cum.length - 1], out = [];
  const n = Math.max(1, Math.floor((L - 2 * margin) / step));
  const s0 = (L - n * step) / 2;
  for (let q = 0; q <= n; q++) {
    const s = s0 + q * step;
    let k = 1;
    while (k < cum.length - 1 && cum[k] < s) k++;
    const f = (s - cum[k - 1]) / Math.max(1e-9, cum[k] - cum[k - 1]);
    out.push({ k: k - 1, f });
  }
  return out;
}

/**
 * A polygon with rounded corners as a profile: corners [t, n, r] in order (counterclockwise), each
 * rounded with radius r in `seg` steps (r 0: a sharp corner). cav: a cavity value per corner
 * (optional, the default 1).
 */
export function roundedPolygon(corners, seg = 4, closed = true) {
  const out = [];
  const m = corners.length;
  for (let k = 0; k < m; k++) {
    const [pt, pn, r, cav = 1] = corners[k];
    const A = corners[(k - 1 + m) % m], C = corners[(k + 1) % m];
    if (!r || (!closed && (k === 0 || k === m - 1))) { out.push({ t: pt, n: pn, hard: true, cav }); continue; }
    let d1t = A[0] - pt, d1n = A[1] - pn, d2t = C[0] - pt, d2n = C[1] - pn;
    const l1 = Math.hypot(d1t, d1n), l2 = Math.hypot(d2t, d2n);
    d1t /= l1; d1n /= l1; d2t /= l2; d2n /= l2;
    const half = Math.acos(Math.min(1, Math.max(-1, d1t * d2t + d1n * d2n))) / 2;
    if (half < 1e-3 || half > Math.PI / 2 - 1e-3) { out.push({ t: pt, n: pn, cav }); continue; }
    const tl = Math.min(r / Math.tan(half), 0.49 * l1, 0.49 * l2);
    const rr = tl * Math.tan(half);
    let bt = d1t + d2t, bn = d1n + d2n;
    const bl = Math.hypot(bt, bn);
    bt /= bl; bn /= bl;
    const ct = pt + bt * rr / Math.sin(half), cn = pn + bn * rr / Math.sin(half);
    const a0 = Math.atan2(pn + d1n * tl - cn, pt + d1t * tl - ct);
    let a1 = Math.atan2(pn + d2n * tl - cn, pt + d2t * tl - ct);
    // the short way round
    while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
    while (a0 - a1 > Math.PI) a1 += 2 * Math.PI;
    for (let s = 0; s <= seg; s++) {
      const a = a0 + (a1 - a0) * (s / seg);
      out.push({ t: ct + rr * Math.cos(a), n: cn + rr * Math.sin(a), cav });
    }
  }
  return out;
}

/**
 * A box with rounded edges and corners: centre c, axes u, v, w (unit Vector3s) with half sizes
 * hu, hv, hw, radius r. A cube's faces pushed out round an inner box: every face a grid with `e`
 * steps across each rounded band and `m` across the flat middle.
 */
export function roundedBox(B, c, u, v, w, hu, hv, hw, r, e = 3, m = 2, cav = 1) {
  const p = new THREE.Vector3(), q = new THREE.Vector3(), nrm = new THREE.Vector3();
  const H = [hu, hv, hw], I = H.map((h) => Math.max(0, h - r));
  // grid coordinates along an axis of half size h (inner half size i)
  const steps = (h, i) => {
    const out = [];
    for (let k = 0; k < e; k++) out.push(-h + (h - i) * (1 - Math.cos((k / e) * Math.PI / 2)));
    for (let k = 0; k <= m; k++) out.push(-i + 2 * i * (k / m));
    for (let k = e - 1; k >= 0; k--) out.push(h - (h - i) * (1 - Math.cos((k / e) * Math.PI / 2)));
    return out;
  };
  for (const [fa, sgn] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
    const a1 = (fa + 1) % 3, a2 = (fa + 2) % 3;
    const s1 = steps(H[a1], I[a1]), s2 = steps(H[a2], I[a2]);
    const ids = [];
    for (const x1 of s1) {
      for (const x2 of s2) {
        const L = [0, 0, 0];
        L[fa] = sgn * H[fa];
        L[a1] = x1;
        L[a2] = x2;
        const K = L.map((x, k) => Math.max(-I[k], Math.min(I[k], x)));
        nrm.set(L[0] - K[0], L[1] - K[1], L[2] - K[2]);
        if (nrm.lengthSq() < 1e-14) nrm.set(fa === 0 ? sgn : 0, fa === 1 ? sgn : 0, fa === 2 ? sgn : 0);
        nrm.normalize();
        p.copy(c).addScaledVector(u, K[0] + nrm.x * r).addScaledVector(v, K[1] + nrm.y * r).addScaledVector(w, K[2] + nrm.z * r);
        q.copy(u).multiplyScalar(nrm.x).addScaledVector(v, nrm.y).addScaledVector(w, nrm.z).normalize();
        ids.push(B.vv(p, q, cav));
      }
    }
    const n2 = s2.length;
    for (let i = 0; i + 1 < s1.length; i++) for (let j = 0; j + 1 < n2; j++) {
      B.quad(ids[i * n2 + j], ids[(i + 1) * n2 + j], ids[(i + 1) * n2 + j + 1], ids[i * n2 + j + 1]);
    }
  }
}
