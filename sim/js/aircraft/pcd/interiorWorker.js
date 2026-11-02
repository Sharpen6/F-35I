// Cockpit interior analysis, run once in a module worker for the player's model (interior.js).
//
// The glb's exterior skin material (F35_Skin_A) also covers the inside of the cockpit sills and
// of the canopy frame, and nothing in the model says which faces are inside. So:
//   1. the cockpit's surroundings are voxelised (walls, glass, the pilot) in the glTF root frame,
//      and the walls and the glass binned as triangles in a coarse grid (exact rays);
//   2. the cockpit air is flood-filled from the pilot's eye, bounded by the walls and the canopy
//      glass (thickened by one voxel to close small seams only if the air leaks out);
//   3. a side of a skin triangle looks into the cockpit when a short march along its normal
//      reaches that air, when the canopy glass lies right on it, or when one of the eye points
//      sees it (an exact ray); front side in: interior paint; back side only, the front in the
//      open: a single-sided panel, interior paint on its back (twoFaced);
//   4. every vertex of the cockpit parts gets an ambient occlusion value: the fraction of a
//      cosine-weighted set of rays that leave the cockpit (through the glass) instead of hitting
//      a wall or the pilot nearer than aoDist (a hit at distance s counts 1 - s / aoDist);
//   5. every vertex of a classified mesh gets the share (by area) of the faces round it that are
//      interior, over welded positions (seams split the vertices): the paint's edge is then drawn
//      along the 0.5 line of that share, a smooth line through the triangles instead of the
//      saw-tooth of their edges along the sills.
//
// in:  { eye: [x, y, z], eyes: [[x, y, z], ...], box: { min, max }, voxel, outside: [[x, y, z], ...],
//        aoRays, aoDist, meshes: [{ id, kind: 'wall' | 'glass' | 'pilot', pos, nrm, index, classify, ao }] }
// out: { ok, leak, interior: { id: Uint32Array of triangle numbers }, twoFaced: { id: ... },
//        ao: { id: Uint8Array }, inside: { id: Uint8Array per vertex, 255 all interior }, stats, ms }

const WALL = 1, GLASS = 2, PILOT = 4;

self.onmessage = (e) => {
  const t0 = performance.now();
  try {
    const out = analyse(e.data);
    out.ms = performance.now() - t0;
    const transfer = [...Object.values(out.interior), ...Object.values(out.twoFaced), ...Object.values(out.ao), ...Object.values(out.inside)].map((a) => a.buffer);
    self.postMessage(out, transfer);
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.stack) || err) });
  }
};

function analyse(msg) {
  const { eye, box, voxel: vs, meshes } = msg;
  const aoRays = msg.aoRays || 16, aoDist = msg.aoDist || 1.2;
  const [x0, y0, z0] = box.min;
  const nx = Math.ceil((box.max[0] - x0) / vs), ny = Math.ceil((box.max[1] - y0) / vs), nz = Math.ceil((box.max[2] - z0) / vs);
  const N = nx * ny * nz;
  const sxy = nx * ny;
  const grid = new Uint8Array(N);
  const vox = (x, y, z) => {
    const i = Math.floor((x - x0) / vs), j = Math.floor((y - y0) / vs), k = Math.floor((z - z0) / vs);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1;
    return i + j * nx + k * sxy;
  };
  const stats = { voxels: N, dims: [nx, ny, nz], samples: 0 };

  // ---- 1. voxelise every triangle that touches the box (points spaced at half a voxel); the walls
  //      and the glass also go, as triangles, into a coarse grid (cells of two voxels, each
  //      triangle in every cell it may touch) for the exact rays of the eye test
  const step = vs * 0.5;
  const C = 2 * vs, cnx = Math.ceil(nx / 2), cny = Math.ceil(ny / 2), cnz = Math.ceil(nz / 2), csxy = cnx * cny;
  const cells = new Array(cnx * cny * cnz);
  const lastTri = new Int32Array(cnx * cny * cnz).fill(-1);
  let triV = new Float32Array(9 * 65536), triK = new Uint8Array(65536), ntri = 0;
  const triOf = {};                          // mesh id -> its triangle -> occluder number (-1: none)
  const mg = step;                           // a sample covers the triangle within this distance
  for (const m of meshes) {
    const bit = m.kind === 'glass' ? GLASS : m.kind === 'pilot' ? PILOT : WALL;
    const occ = bit !== PILOT;
    const P = m.pos, I = m.index;
    const tmap = occ ? new Int32Array(I.length / 3).fill(-1) : null;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ax = P[a], ay = P[a + 1], az = P[a + 2];
      const bx = P[b], by = P[b + 1], bz = P[b + 2];
      const cx = P[c], cy = P[c + 1], cz = P[c + 2];
      if (Math.max(ax, bx, cx) < x0 || Math.min(ax, bx, cx) > box.max[0] ||
          Math.max(ay, by, cy) < y0 || Math.min(ay, by, cy) > box.max[1] ||
          Math.max(az, bz, cz) < z0 || Math.min(az, bz, cz) > box.max[2]) continue;
      let g = -1;
      if (occ) {
        g = ntri++;
        if (ntri > triK.length) {
          const nv = new Float32Array(triV.length * 2); nv.set(triV); triV = nv;
          const nk = new Uint8Array(triK.length * 2); nk.set(triK); triK = nk;
        }
        triK[g] = bit;
        const o = 9 * g;
        triV[o] = ax; triV[o + 1] = ay; triV[o + 2] = az; triV[o + 3] = bx; triV[o + 4] = by; triV[o + 5] = bz;
        triV[o + 6] = cx; triV[o + 7] = cy; triV[o + 8] = cz;
        tmap[t / 3] = g;
      }
      const e = Math.max(Math.hypot(bx - ax, by - ay, bz - az), Math.hypot(cx - bx, cy - by, cz - bz), Math.hypot(ax - cx, ay - cy, az - cz));
      const n = Math.max(1, Math.ceil(e / step));
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        for (let j = 0; j <= n - i; j++) {
          const v = j / n;
          const px = ax + (bx - ax) * u + (cx - ax) * v, py = ay + (by - ay) * u + (cy - ay) * v, pz = az + (bz - az) * u + (cz - az) * v;
          const q = vox(px, py, pz);
          if (q >= 0) grid[q] |= bit;
          if (!occ) continue;
          const i0 = Math.floor((px - mg - x0) / C), i1 = Math.floor((px + mg - x0) / C);
          const j0 = Math.floor((py - mg - y0) / C), j1 = Math.floor((py + mg - y0) / C);
          const k0 = Math.floor((pz - mg - z0) / C), k1 = Math.floor((pz + mg - z0) / C);
          if (i1 < 0 || j1 < 0 || k1 < 0 || i0 >= cnx || j0 >= cny || k0 >= cnz) continue;
          for (let kk = Math.max(0, k0); kk <= Math.min(cnz - 1, k1); kk++) {
            for (let jj = Math.max(0, j0); jj <= Math.min(cny - 1, j1); jj++) {
              for (let ii = Math.max(0, i0); ii <= Math.min(cnx - 1, i1); ii++) {
                const cc = ii + jj * cnx + kk * csxy;
                if (lastTri[cc] === g) continue;
                lastTri[cc] = g;
                (cells[cc] || (cells[cc] = [])).push(g);
              }
            }
          }
        }
      }
      stats.samples += (n + 1) * (n + 2) / 2;
    }
    if (occ) triOf[m.id] = tmap;
  }
  stats.occluders = ntri;

  // the walls and the glass along the segment o -> o + d (0 < t < 1, a triangle other than
  // `self`): the kind bit of the nearest one, 0 for none (any: of the first one found). A 3D DDA
  // over the coarse cells, Moller-Trumbore on their triangles, each triangle once per ray
  const stamp = new Int32Array(ntri);
  let rayId = 0;
  const cast = (ox, oy, oz, dx, dy, dz, self, any) => {
    rayId++;
    const tMin = 5e-4 / Math.hypot(dx, dy, dz);
    let best = 1, kind = 0;
    const cl = (x, n) => (x < 0 ? 0 : x >= n ? n - 1 : x);
    let i = cl(Math.floor((ox - x0) / C), cnx), j = cl(Math.floor((oy - y0) / C), cny), k = cl(Math.floor((oz - z0) / C), cnz);
    const si = dx > 0 ? 1 : -1, sj = dy > 0 ? 1 : -1, sk = dz > 0 ? 1 : -1;
    const ddx = dx !== 0 ? Math.abs(C / dx) : Infinity, ddy = dy !== 0 ? Math.abs(C / dy) : Infinity, ddz = dz !== 0 ? Math.abs(C / dz) : Infinity;
    let tx = dx !== 0 ? ((i + (dx > 0 ? 1 : 0)) * C + x0 - ox) / dx : Infinity;
    let ty = dy !== 0 ? ((j + (dy > 0 ? 1 : 0)) * C + y0 - oy) / dy : Infinity;
    let tz = dz !== 0 ? ((k + (dz > 0 ? 1 : 0)) * C + z0 - oz) / dz : Infinity;
    for (;;) {
      if (i < 0 || j < 0 || k < 0 || i >= cnx || j >= cny || k >= cnz) return kind;
      const l = cells[i + j * cnx + k * csxy];
      if (l) {
        for (let n = 0; n < l.length; n++) {
          const g = l[n];
          if (g === self || stamp[g] === rayId) continue;
          stamp[g] = rayId;
          const b = 9 * g;
          const ax = triV[b], ay = triV[b + 1], az = triV[b + 2];
          const e1x = triV[b + 3] - ax, e1y = triV[b + 4] - ay, e1z = triV[b + 5] - az;
          const e2x = triV[b + 6] - ax, e2y = triV[b + 7] - ay, e2z = triV[b + 8] - az;
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (det > -1e-14 && det < 1e-14) continue;
          const inv = 1 / det;
          const sx = ox - ax, sy = oy - ay, sz = oz - az;
          const u = (sx * px + sy * py + sz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (t > tMin && t < best) {
            if (any) return triK[g];
            best = t; kind = triK[g];
          }
        }
      }
      if (tx < ty && tx < tz) { if (tx > best) return kind; i += si; tx += ddx; }
      else if (ty < tz) { if (ty > best) return kind; j += sj; ty += ddy; }
      else { if (tz > best) return kind; k += sk; tz += ddz; }
    }
  };

  // ---- 2. cockpit air: flood fill from the eye; walls and glass thickened by one voxel
  const dilate = (mask) => {
    const out = new Uint8Array(N);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const q = i + j * nx + k * sxy;
      if (grid[q] & mask) {
        out[q] = 1;
        if (i > 0) out[q - 1] = 1; if (i < nx - 1) out[q + 1] = 1;
        if (j > 0) out[q - nx] = 1; if (j < ny - 1) out[q + nx] = 1;
        if (k > 0) out[q - sxy] = 1; if (k < nz - 1) out[q + sxy] = 1;
      }
    }
    return out;
  };
  // the walls as voxelised first (gaps of a voxel stay open: a leak shows up at the outside
  // points); thickened by one voxel when it leaks
  const flood = (barrier) => {
    const air = new Uint8Array(N);
    const queue = new Int32Array(N);
    let head = 0, tail = 0;
    let seed = vox(eye[0], eye[1], eye[2]);
    if (seed < 0) throw new Error('eye outside the analysed box');
    for (let d = 1; d < 6 && barrier[seed]; d++) seed = vox(eye[0], eye[1] + d * vs, eye[2]);
    air[seed] = 1;
    queue[tail++] = seed;
    while (head < tail) {
      const q = queue[head++];
      const i = q % nx, j = ((q - i) / nx) % ny, k = Math.floor(q / sxy);
      const visit = (r) => { if (!air[r] && !barrier[r]) { air[r] = 1; queue[tail++] = r; } };
      if (i > 0) visit(q - 1); if (i < nx - 1) visit(q + 1);
      if (j > 0) visit(q - nx); if (j < ny - 1) visit(q + nx);
      if (k > 0) visit(q - sxy); if (k < nz - 1) visit(q + sxy);
    }
    let leak = false;
    for (const p of msg.outside || []) { const q = vox(p[0], p[1], p[2]); if (q >= 0 && air[q]) leak = true; }
    return { air, count: tail, leak };
  };
  let barrier = new Uint8Array(N);
  for (let q = 0; q < N; q++) barrier[q] = grid[q] & (WALL | GLASS) ? 1 : 0;
  let fl = flood(barrier);
  stats.dilated = false;
  if (fl.leak) {
    barrier = dilate(WALL | GLASS);
    fl = flood(barrier);
    stats.dilated = true;
  }
  const air = fl.air, leak = fl.leak;
  stats.air = fl.count;

  // ---- 3. interior skin triangles. A side of a face looks into the cockpit when, from the centroid,
  //      (a) a march along that side's normal reaches the cockpit air before a wall, or
  //      (b) the glass lies right on it (the frame under the canopy's bonded edge), or
  //      (c) it faces the eye and the line to the eye crosses no wall and no glass.
  //      Front side inside: the whole face is interior (interior). Only the back side inside and
  //      the front side in the open: a single-sided panel (the canopy frame, the fairing behind
  //      the seat), skin outside and interior paint inside (twoFaced).
  const interior = {}, twoFaced = {};
  const own = vs * 1.8;                       // the triangle's own voxels along its normal
  const reachesAir = (px, py, pz, dx, dy, dz) => {
    for (let s = step; s <= vs * 7; s += step) {
      const q = vox(px + dx * s, py + dy * s, pz + dz * s);
      if (q < 0) return false;
      if (s <= own) continue;
      if (air[q]) return true;
      if (grid[q] & (WALL | GLASS)) return false;
    }
    return false;
  };
  // (b) exact: the first thing along the normal within 2.5 cm (from 2 mm behind the face: the glass
  //     may lie on it) is the canopy glass
  const underGlass = (px, py, pz, dx, dy, dz, self) =>
    cast(px - dx * 2e-3, py - dy * 2e-3, pz - dz * 2e-3, dx * 0.027, dy * 0.027, dz * 0.027, self, false) === GLASS;
  // (c) exact: a ray from the centroid to one of the eye points (the head moves about) crosses no
  //     wall and no glass (the voxels are too coarse for the groove of the canopy rail)
  const eyes = msg.eyes || [eye];
  const eyeSees = (px, py, pz, fx, fy, fz, self) => {
    for (const e of eyes) {
      const ox = px + fx * 1e-3, oy = py + fy * 1e-3, oz = pz + fz * 1e-3;
      const dx = e[0] - ox, dy = e[1] - oy, dz = e[2] - oz;
      if (fx * dx + fy * dy + fz * dz < 0.08 * Math.hypot(dx, dy, dz)) continue;
      if (!cast(ox, oy, oz, dx, dy, dz, self, true)) return true;
    }
    return false;
  };
  const reachesOutside = (px, py, pz, dx, dy, dz) => {
    for (let s = step; s <= vs * 7; s += step) {
      const q = vox(px + dx * s, py + dy * s, pz + dz * s);
      if (q < 0) return true;
      if (s <= own) continue;
      if (grid[q] & (WALL | GLASS)) return false;
      if (!air[q]) return true;
    }
    return false;
  };
  const looksIn = (cx, cy, cz, fx, fy, fz, self) => reachesAir(cx, cy, cz, fx, fy, fz) || underGlass(cx, cy, cz, fx, fy, fz, self) || eyeSees(cx, cy, cz, fx, fy, fz, self);
  stats.twoFaced = 0;
  if (!leak) {
    for (const m of meshes) {
      if (!m.classify) continue;
      const P = m.pos, I = m.index, tmap = triOf[m.id];
      const list = [], list2 = [];
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const cx = (P[a] + P[b] + P[c]) / 3, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
        if (vox(cx, cy, cz) < 0) continue;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
        let fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
        const l = Math.hypot(fx, fy, fz);
        if (l < 1e-12) continue;
        fx /= l; fy /= l; fz /= l;
        const self = tmap ? tmap[t / 3] : -1;
        if (looksIn(cx, cy, cz, fx, fy, fz, self)) list.push(t / 3);
        else if (looksIn(cx, cy, cz, -fx, -fy, -fz, self)) {
          if (reachesOutside(cx, cy, cz, fx, fy, fz)) { list2.push(t / 3); stats.twoFaced++; } else list.push(t / 3);
        }
      }
      if (list.length) interior[m.id] = Uint32Array.from(list);
      if (list2.length) twoFaced[m.id] = Uint32Array.from(list2);
    }
  }

  // (debugging: the marches of chosen triangles)
  if (msg.debug) {
    stats.debug = msg.debug.map(({ id, t }) => {
      const m = meshes.find((x) => x.id === id);
      const P = m.pos, I = m.index;
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const cx = (P[a] + P[b] + P[c]) / 3, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
      let fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
      const l = Math.hypot(fx, fy, fz); fx /= l; fy /= l; fz /= l;
      const trace = (sg) => {
        const out = [];
        for (let s = step; s <= vs * 7; s += step) {
          const q = vox(cx + sg * fx * s, cy + sg * fy * s, cz + sg * fz * s);
          if (q < 0) { out.push('out'); break; }
          out.push((s <= own ? 'o' : '') + (air[q] ? 'A' : '') + (barrier[q] ? 'b' : '') + (grid[q] & WALL ? 'W' : '') + (grid[q] & GLASS ? 'G' : '') + (grid[q] & PILOT ? 'P' : '') || '.');
        }
        return out.join(' ');
      };
      const self = triOf[id] ? triOf[id][t] : -1;
      const tests = [reachesAir(cx, cy, cz, fx, fy, fz), reachesAir(cx, cy, cz, -fx, -fy, -fz), underGlass(cx, cy, cz, fx, fy, fz, self), underGlass(cx, cy, cz, -fx, -fy, -fz, self), eyeSees(cx, cy, cz, fx, fy, fz, self), eyeSees(cx, cy, cz, -fx, -fy, -fz, self)].map((x) => (x ? 1 : 0)).join('');
      return { id, t, c: [cx, cy, cz].map((x) => +x.toFixed(3)), n: [fx, fy, fz].map((x) => +x.toFixed(2)), tests, plus: trace(1), minus: trace(-1) };
    });
  }

  // ---- 4. ambient occlusion per vertex (walls and the pilot occlude, the glass does not)
  const dirs = [];
  for (let k = 0; k < aoRays; k++) {
    // cosine-weighted hemisphere (z up), a Fibonacci spiral
    const u = (k + 0.5) / aoRays, phi = k * 2.399963229728653;
    const r = Math.sqrt(u);
    dirs.push([r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - u)]);
  }
  const ao = {};
  const march = 0.75 * vs;
  for (const m of meshes) {
    if (!m.ao) continue;
    const P = m.pos, Nn = m.nrm;
    const nv = P.length / 3;
    const res = new Uint8Array(nv).fill(255);
    for (let v = 0; v < nv; v++) {
      const px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2];
      if (vox(px, py, pz) < 0) continue;
      let nxv = Nn ? Nn[v * 3] : 0, nyv = Nn ? Nn[v * 3 + 1] : 1, nzv = Nn ? Nn[v * 3 + 2] : 0;
      const ln = Math.hypot(nxv, nyv, nzv) || 1;
      nxv /= ln; nyv /= ln; nzv /= ln;
      // the side of the surface that faces the cockpit air
      if (!reachesAir(px, py, pz, nxv, nyv, nzv) && reachesAir(px, py, pz, -nxv, -nyv, -nzv)) { nxv = -nxv; nyv = -nyv; nzv = -nzv; }
      // tangent frame, turned by a per-vertex angle (no banding between neighbours)
      let tx, ty, tz;
      if (Math.abs(nxv) < 0.9) { tx = 0; ty = nzv; tz = -nyv; } else { tx = -nzv; ty = 0; tz = nxv; }
      const lt = Math.hypot(tx, ty, tz); tx /= lt; ty /= lt; tz /= lt;
      const bx = nyv * tz - nzv * ty, by = nzv * tx - nxv * tz, bz = nxv * ty - nyv * tx;
      const rot = ((v * 2654435761) >>> 0) / 4294967296 * Math.PI * 2;
      const cr = Math.cos(rot), sr = Math.sin(rot);
      const ox = px + nxv * own, oy = py + nyv * own, oz = pz + nzv * own;     // clear of its own voxels
      let occl = 0;
      for (const d of dirs) {
        const lx = d[0] * cr - d[1] * sr, ly = d[0] * sr + d[1] * cr;
        const dx = tx * lx + bx * ly + nxv * d[2], dy = ty * lx + by * ly + nyv * d[2], dz = tz * lx + bz * ly + nzv * d[2];
        for (let s = 0; s < aoDist; s += march) {
          const q = vox(ox + dx * s, oy + dy * s, oz + dz * s);
          if (q < 0) break;
          if (grid[q] & (WALL | PILOT)) { occl += 1 - s / aoDist; break; }
        }
      }
      res[v] = Math.round(255 * (1 - occl / dirs.length));
    }
    ao[m.id] = res;
  }
  // ---- 5. the interior share per vertex (welded at 0.1 mm), for the paint's edge
  const inside = {};
  for (const m of meshes) {
    const list = interior[m.id];
    if (!m.classify || !list) continue;
    const P = m.pos, I = m.index, nv = P.length / 3;
    const isIn = new Uint8Array(I.length / 3);
    for (const t of list) isIn[t] = 1;
    const rep = new Int32Array(nv).fill(-1), keys = new Map();
    for (let v = 0; v < nv; v++) {
      if (vox(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]) < 0) continue;
      const k = `${Math.round(P[v * 3] * 1e4)},${Math.round(P[v * 3 + 1] * 1e4)},${Math.round(P[v * 3 + 2] * 1e4)}`;
      let r = keys.get(k);
      if (r === undefined) { r = v; keys.set(k, v); }
      rep[v] = r;
    }
    const num = new Float32Array(nv), den = new Float32Array(nv);
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      if (rep[a] < 0 && rep[b] < 0 && rep[c] < 0) continue;
      const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
      const wx = P[c * 3] - P[a * 3], wy = P[c * 3 + 1] - P[a * 3 + 1], wz = P[c * 3 + 2] - P[a * 3 + 2];
      const A = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) + 1e-12;
      const f = isIn[t / 3] ? A : 0;
      for (const v of [a, b, c]) { const r = rep[v]; if (r >= 0) { den[r] += A; num[r] += f; } }
    }
    const out = new Uint8Array(nv);
    for (let v = 0; v < nv; v++) { const r = rep[v]; if (r >= 0 && den[r] > 0) out[v] = Math.round(255 * num[r] / den[r]); }
    inside[m.id] = out;
  }
  return { ok: true, leak, interior, twoFaced, ao, inside, stats };
}
