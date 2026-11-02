// The cockpit's sills and the canopy frame's inner face, built at load time (pcd/parts.js).
//
// In the glb the canopy's side frame is a bare strip under the glass and the sill a sloping plate
// meeting the tub's wall in a sharp crest: looking left or right, "a flat grey band" under the
// glass. Built here along both, from the glb's own sections (sliced every 2.5 cm fore and aft):
//
//   * the frame's inner face: a liner panel, the transparency's retaining strip along its top with
//     its bolts (every 9 cm), a rubber seal along its foot where the canopy closes on the sill
//     (the canopy's: they move with it);
//   * the sill's crest: a rounded cap over the tub wall's top edge (it catches the sky as a soft
//     highlight instead of a hard line), its screws along the sill.
// The bolt and screw heads are painted with the part they hold (one mesh with it).

import * as THREE from 'three';
import { MeshBuilder, sweepProfiles, roundedPolygon, stud, alongPolyline, ccw } from './shapes.js';

export const SILL = {
  step: 0.025,                      // the sections' spacing along z
  liner: { stand: 0.001, thick: 0.0028, r: 0.0012, foot: 0.013, head: 0.011 },
  retainer: { width: 0.02, proud: 0.0042, r: 0.0016, top: 0.0025 },
  seal: { width: 0.012, height: 0.0065, r: 0.004 },
  bolt: { pitch: 0.09, r: 0.0026, h: 0.0011 },
  cap: { r: 0.007, proud: 0.0008, wall: 0.03, sill: 0.034, screw: 0.07 },
};

/**
 * Sections of a mesh by planes z = zs[k] (root frame, ascending, evenly spaced): per plane, the
 * points where its triangles cross it, [[x, y], ...], of the triangles reaching x >= xMin. M: the
 * mesh's matrix to the root frame.
 */
export function sliceZ(geometry, M, zs, xMin = -Infinity) {
  const P = geometry.attributes.position;
  const idx = geometry.index ? geometry.index.array : null;
  const nT = (idx ? idx.length : P.count) / 3;
  const W = new Float32Array(P.count * 3), v = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i).applyMatrix4(M); W[i * 3] = v.x; W[i * 3 + 1] = v.y; W[i * 3 + 2] = v.z; }
  const out = zs.map(() => []);
  const z0 = zs[0], dz = zs.length > 1 ? zs[1] - zs[0] : 1;
  const edge = (list, p, q, z) => {
    const dp = W[p * 3 + 2] - z, dq = W[q * 3 + 2] - z;
    if ((dp < 0) === (dq < 0) || dp === dq) return;
    const s = dp / (dp - dq);
    list.push([W[p * 3] + (W[q * 3] - W[p * 3]) * s, W[p * 3 + 1] + (W[q * 3 + 1] - W[p * 3 + 1]) * s]);
  };
  for (let t = 0; t < nT; t++) {
    const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
    if (W[a * 3] < xMin && W[b * 3] < xMin && W[c * 3] < xMin) continue;
    const za = W[a * 3 + 2], zb = W[b * 3 + 2], zc = W[c * 3 + 2];
    const lo = Math.min(za, zb, zc), hi = Math.max(za, zb, zc);
    const k0 = Math.max(0, Math.ceil((lo - z0) / dz)), k1 = Math.min(zs.length - 1, Math.floor((hi - z0) / dz));
    for (let k = k0; k <= k1; k++) {
      const z = zs[k], list = out[k];
      edge(list, a, b, z);
      edge(list, b, c, z);
      edge(list, c, a, z);
    }
  }
  return out;
}

/**
 * The sections the sills need, left side (+x; the right is its mirror image), per station z:
 * {z, wall: [x, y] (the tub wall's top), foot: [x, y] (the frame's inner face at its foot), top:
 * [x, y] (the glass's lowest inner point: the face's top)}. Stations without all three, or where
 * the wall's top jumps (the instrument panel), are left out; the result is split into runs.
 */
export function sillSections({ tub, frame, glass }, zFrom, zTo) {
  const zs = [];
  for (let z = zFrom; z <= zTo + 1e-6; z += SILL.step) zs.push(+z.toFixed(4));
  const T = sliceZ(tub.geometry, tub.matrix, zs, 0.3), F = sliceZ(frame.geometry, frame.matrix, zs, 0.3), G = sliceZ(glass.geometry, glass.matrix, zs, 0.3);
  const st = [];
  zs.forEach((z, k) => {
    const wall = T[k].filter((p) => p[0] > 0.3 && p[1] > 0.5).reduce((b, p) => (!b || p[1] > b[1] ? p : b), null);
    const fr = F[k].filter((p) => p[0] > 0.3 && p[1] < 1.0);
    const yMin = fr.reduce((m, p) => Math.min(m, p[1]), Infinity);
    const foot = fr.filter((p) => p[1] < yMin + 0.006).reduce((b, p) => (!b || p[0] < b[0] ? p : b), null);
    const top = G[k].filter((p) => p[0] > 0.3).reduce((b, p) => (!b || p[1] < b[1] ? p : b), null);
    st.push({ z, wall, foot, top });
  });
  return st;
}

/** Runs of consecutive stations with `ok` true. */
function runs(st, ok) {
  const out = [];
  let cur = [];
  for (const s of st) {
    if (ok(s, cur[cur.length - 1])) cur.push(s);
    else { if (cur.length > 2) out.push(cur); cur = ok(s, null) ? [s] : []; }
  }
  if (cur.length > 2) out.push(cur);
  return out;
}

/**
 * The canopy frame's inner face (both sides) into B (liner, retainer, seal: the bow's paint) and
 * M (the bolt heads: B too, painted with it), root frame. Returns the length lined (one side).
 */
export function buildLiner(st, B, M) {
  const S = SILL;
  const good = runs(st, (s, prev) => !!(s.foot && s.top) && s.top[1] - s.foot[1] > 0.06 && s.top[1] - s.foot[1] < 0.16 && (!prev || Math.hypot(s.foot[0] - prev.foot[0], s.foot[1] - prev.foot[1]) < 0.03));
  let length = 0;
  for (const run of good) {
    for (const side of [1, -1]) {
      const frames = [], liner = [], ret = [], seal = [], line = [];
      for (const s of run) {
        const fx = s.foot[0], fy = s.foot[1], tx = s.top[0], ty = s.top[1];
        const L = Math.hypot(tx - fx, ty - fy);
        const ux = (tx - fx) / L, uy = (ty - fy) / L;                // up the face
        // inwards: the face's normal towards the cockpit's middle
        let nx = -uy, ny = ux;
        if (nx > 0) { nx = -nx; ny = -ny; }
        frames.push({
          o: new THREE.Vector3(side * fx, fy, s.z),
          t: new THREE.Vector3(side * ux, uy, 0),
          n: new THREE.Vector3(side * nx, ny, 0),
        });
        const a = S.liner.foot, b = L - S.liner.head, n0 = S.liner.stand, n1 = n0 + S.liner.thick;
        liner.push(roundedPolygon(ccw([[a, n0, 0], [b, n0, 0], [b, n1, S.liner.r], [a, n1, S.liner.r]]), 2));
        const r0 = L - S.retainer.top - S.retainer.width, r1 = L - S.retainer.top;
        ret.push(roundedPolygon(ccw([[r0, n0, 0], [r1, n0, 0], [r1, S.retainer.proud, S.retainer.r], [r0, S.retainer.proud, S.retainer.r]]), 2));
        seal.push(roundedPolygon(ccw([[0.0005, 0.0004, 0, 0.45], [S.seal.width, 0.0004, 0, 0.45], [S.seal.width, S.seal.height * 0.8, S.seal.r, 0.45], [0.0005, S.seal.height, S.seal.r, 0.45]]), 3));
        line.push({ f: frames[frames.length - 1], t: (r0 + r1) / 2 });
      }
      for (const prof of [liner, ret, seal]) {
        // (the profiles are counterclockwise in (t, n); on the mirrored side t runs the other way)
        sweepProfiles(B, frames, prof, true);
      }
      // the retaining strip's bolts
      const pts = line.map(({ f, t }) => f.o.clone().addScaledVector(f.t, t));
      const p = new THREE.Vector3(), nrm = new THREE.Vector3();
      for (const { k, f } of alongPolyline(pts, S.bolt.pitch, 0.02)) {
        const A = line[k], C = line[Math.min(line.length - 1, k + 1)];
        p.lerpVectors(pts[k], pts[Math.min(pts.length - 1, k + 1)], f);
        nrm.lerpVectors(A.f.n, C.f.n, f).normalize();
        p.addScaledVector(nrm, S.retainer.proud);
        stud(M, p, nrm, S.bolt.r, S.bolt.h, 6, 0.5);
      }
      if (side === 1) for (let k = 1; k < pts.length; k++) length += pts[k].distanceTo(pts[k - 1]);
    }
  }
  return length;
}

/**
 * The sill's crest (both sides): a rounded cap over the tub wall's top edge, into B (the tub's
 * paint) and its screw heads into M (B too), root frame, aft of zMax (the instrument panel).
 * Returns the length capped (one side).
 */
export function buildSillCap(st, B, M, zMax = Infinity) {
  const S = SILL.cap;
  const good = runs(st, (s, prev) => !!(s.wall && s.foot) && s.z <= zMax && s.foot[0] - s.wall[0] > 0.04 && (!prev || (Math.abs(s.wall[0] - prev.wall[0]) < 0.02 && Math.abs(s.wall[1] - prev.wall[1]) < 0.04)));
  let length = 0;
  for (const run of good) {
    for (const side of [1, -1]) {
      const frames = [], profs = [], line = [];
      for (const s of run) {
        // u outwards (x), v up; the sill from the crest down to the frame's foot
        const sx = s.foot[0] - s.wall[0], sy = s.foot[1] - s.wall[1];
        const sl = Math.hypot(sx, sy), su = sx / sl, sv = sy / sl;
        const nu = -sv, nv = su;                                    // the sill's normal (up and out)
        const D = S.sill, r = S.r;
        // the crest is a sharp wedge (the wall down, the sill out): the cap's faces stand off both
        // by `off`, so that its rounded crest (radius r) still passes S.proud outside the glb's edge
        const half = Math.acos(Math.min(1, Math.max(-1, -sv))) / 2;
        const off = r - r * Math.sin(half) + S.proud * Math.sin(half);
        const cu = -off, cv = (off - cu * nu) / nv;                 // (u, v) with u*nu + v*nv = off
        const corners = [
          [-off, -S.wall, 0, 0.7],
          [cu, cv, r, 1],
          [D * su + off * nu, D * sv + off * nv, 0, 0.8],
          [D * su - 0.004 * nu, D * sv - 0.004 * nv, 0, 0.6],
          [0.004, -S.wall, 0, 0.6],
        ];
        const P = off;
        frames.push({ o: new THREE.Vector3(side * s.wall[0], s.wall[1], s.z), t: new THREE.Vector3(side, 0, 0), n: new THREE.Vector3(0, 1, 0) });
        profs.push(roundedPolygon(ccw(corners), 6));
        line.push({ u: 0.6 * D * su + P * nu, v: 0.6 * D * sv + P * nv, nu, nv });
      }
      sweepProfiles(B, frames, profs, true);
      const pts = frames.map((f, k) => f.o.clone().add(new THREE.Vector3(side * line[k].u, line[k].v, 0)));
      const p = new THREE.Vector3(), nrm = new THREE.Vector3();
      for (const { k, f } of alongPolyline(pts, S.screw, 0.03)) {
        const k1 = Math.min(pts.length - 1, k + 1);
        p.lerpVectors(pts[k], pts[k1], f);
        nrm.set(side * (line[k].nu + (line[k1].nu - line[k].nu) * f), line[k].nv + (line[k1].nv - line[k].nv) * f, 0).normalize();
        stud(M, p, nrm, 0.0024, 0.0008, 6, 0.5);
      }
      if (side === 1) for (let k = 1; k < pts.length; k++) length += pts[k].distanceTo(pts[k - 1]);
    }
  }
  return length;
}
