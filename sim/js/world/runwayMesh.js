// Runway surface meshes draped exactly on the terrain, pure JS (node tests: sim/tests/airfield_mesh.mjs).
//
// The terrain's full-resolution mesh is the 25 m height grid with every cell split along its
// NW-SE diagonal (js/terrain/HeightField.js). A runway's pavement rectangle (overruns and
// shoulders included) is cut out of those triangles: each triangle is clipped by the rectangle's
// four sides and the piece left is a convex polygon in the triangle's own plane, fanned into
// triangles. The overlay then lies in the terrain's surface (up to float rounding) wherever the
// terrain draws its exact mesh (3.84 km around the camera), so it needs only a few steps of depth
// bias there; farther out the coarser terrain levels are covered by a bias growing with distance
// (js/world/runwayShaders.js).
//
// Per vertex: position (relative to the mesh origin), the runway frame (s along from end 0, t to
// the right of end 0 -> end 1, metres), the terrain normal's x, z, and the runway's row in the
// data texture.

const CORE_HALF = 51200, SPACING = 25, CORE_N = 4097;

/**
 * Clips the convex polygon poly (flat array of [x, z, h] triples) by the half-plane
 * a * x + b * z + c >= 0; heights are interpolated along the cut edges.
 */
function clipHalf(poly, a, b, c) {
  const n = poly.length / 3;
  if (!n) return poly;
  const out = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = poly[i * 3], z0 = poly[i * 3 + 1], h0 = poly[i * 3 + 2];
    const x1 = poly[j * 3], z1 = poly[j * 3 + 1], h1 = poly[j * 3 + 2];
    const d0 = a * x0 + b * z0 + c, d1 = a * x1 + b * z1 + c;
    if (d0 >= 0) out.push(x0, z0, h0);
    if ((d0 >= 0) !== (d1 >= 0)) {
      const f = d0 / (d0 - d1);
      out.push(x0 + (x1 - x0) * f, z0 + (z1 - z0) * f, h0 + (h1 - h0) * f);
    }
  }
  return out;
}

/**
 * The draped mesh of one runway rectangle.
 *   rw: {x0, z0 (end 0), ux, uz (unit, end 0 -> end 1), sMin, sMax, tMax}: s in [sMin, sMax], |t| <= tMax
 *   sample(i, j): core height sample (column i east, row j south), metres
 *   origin: [ox, oz] subtracted from the positions; index: the runway's data row
 * Appends to out = {pos: [], st: [], nrm: [], rw: [], idx: []} and returns the triangle count.
 */
export function drapeRunway(rw, sample, origin, index, out) {
  const { x0, z0, ux, uz, sMin, sMax, tMax } = rw;
  const rx = -uz, rz = ux;                       // right of end 0 -> end 1
  // half-planes (inside >= 0) in world x, z: s - sMin, sMax - s, t + tMax, tMax - t
  const s0 = ux * x0 + uz * z0, t0 = rx * x0 + rz * z0;
  const planes = [
    [ux, uz, -s0 - sMin], [-ux, -uz, s0 + sMax],
    [rx, rz, -t0 + tMax], [-rx, -rz, t0 + tMax],
  ];
  // the rectangle's corners: the grid cells to visit
  let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const s of [sMin, sMax]) {
    for (const t of [-tMax, tMax]) {
      const x = x0 + ux * s + rx * t, z = z0 + uz * s + rz * t;
      mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mnz = Math.min(mnz, z); mxz = Math.max(mxz, z);
    }
  }
  const i0 = Math.max(0, Math.floor((mnx + CORE_HALF) / SPACING)), i1 = Math.min(CORE_N - 2, Math.floor((mxx + CORE_HALF) / SPACING));
  const j0 = Math.max(0, Math.floor((mnz + CORE_HALF) / SPACING)), j1 = Math.min(CORE_N - 2, Math.floor((mxz + CORE_HALF) / SPACING));
  const [ox, oz] = origin;
  // the terrain normal at a point (central differences over one cell, like the 25 m normal map)
  const hAt = (x, z) => {
    const gx = (x + CORE_HALF) / SPACING, gz = (z + CORE_HALF) / SPACING;
    let i = Math.floor(gx), j = Math.floor(gz);
    i = Math.min(Math.max(i, 0), CORE_N - 2); j = Math.min(Math.max(j, 0), CORE_N - 2);
    const fx = gx - i, fz = gz - j, ha = sample(i, j), hd = sample(i + 1, j + 1);
    if (fx >= fz) { const hb = sample(i + 1, j); return ha + fx * (hb - ha) + fz * (hd - hb); }
    const hc = sample(i, j + 1);
    return ha + fz * (hc - ha) + fx * (hd - hc);
  };
  const nrm = (x, z) => {
    const e = SPACING / 2;
    const gx = (hAt(x + e, z) - hAt(x - e, z)) / (2 * e), gz = (hAt(x, z + e) - hAt(x, z - e)) / (2 * e);
    const l = Math.hypot(gx, 1, gz);
    return [-gx / l, -gz / l];
  };
  let tris = 0;
  const emit = (poly) => {
    const n = poly.length / 3;
    if (n < 3) return;
    const base = out.pos.length / 3;
    for (let k = 0; k < n; k++) {
      const x = poly[k * 3], z = poly[k * 3 + 1], h = poly[k * 3 + 2];
      out.pos.push(x - ox, h, z - oz);
      const dx = x - x0, dz = z - z0;
      out.st.push(dx * ux + dz * uz, dx * rx + dz * rz);
      const nn = nrm(x, z);
      out.nrm.push(nn[0], nn[1]);
      out.rw.push(index);
    }
    // fan, reversed: the cell corners a, b, d (and a, d, c) run clockwise seen from above
    // (cross(b - a, d - a) points down), and three.js front faces are counter-clockwise
    for (let k = 1; k < n - 1; k++) { out.idx.push(base, base + k + 1, base + k); tris++; }
  };
  for (let j = j0; j <= j1; j++) {
    const za = -CORE_HALF + j * SPACING, zb = za + SPACING;
    for (let i = i0; i <= i1; i++) {
      const xa = -CORE_HALF + i * SPACING, xb = xa + SPACING;
      // cell centre against the rectangle grown by a cell's half diagonal: skip far cells early
      const cx = xa + SPACING / 2 - x0, cz = za + SPACING / 2 - z0;
      const cs = cx * ux + cz * uz, ct = cx * rx + cz * rz;
      if (cs < sMin - 18 || cs > sMax + 18 || Math.abs(ct) > tMax + 18) continue;
      const ha = sample(i, j), hb = sample(i + 1, j), hc = sample(i, j + 1), hd = sample(i + 1, j + 1);
      // the two triangles: (a, b, d) where fx >= fz and (a, d, c) where fx < fz (HeightField.heightAt)
      for (const tri of [[xa, za, ha, xb, za, hb, xb, zb, hd], [xa, za, ha, xb, zb, hd, xa, zb, hc]]) {
        let p = tri;
        for (const [a, b, c] of planes) {
          p = clipHalf(p, a, b, c);
          if (p.length < 9) break;
        }
        if (p.length >= 9) emit(p);
      }
    }
  }
  return tris;
}
