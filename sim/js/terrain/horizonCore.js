// Horizon angles toward the sun over a square grid aligned with the sun's azimuth (pure JS;
// runs in horizonWorker.js and in node tests).
//
// For every grid point the elevation angle of the terrain's horizon in the sun's direction
// is found with the convex hull sweep of Timonen & Westerholm ("Scalable Height Field
// Self-Shadowing", 2010): each grid row runs toward the sun, so one pass from the sunward
// end down the row, keeping the upper convex hull of the profile already seen, gives every
// point's horizon in O(n). The earth's curvature is exact for the parabolic drop t^2 / 2R:
// with H(u) = h(u) - u^2 / 2R, the slope from point i to a point j toward the sun is
// (H_j - H_i) / (u_j - u_i) + u_i / R, so the hull runs on H and u_i / R is added after.
//
// Output: Uint8Array n x n, v = round(255 * sqrt(angle / 90 deg)) (0 = flat horizon or
// below); row j, column i is the point C + ((i + 0.5) / n - 0.5) E a + ((j + 0.5) / n - 0.5) E b,
// a = unit vector toward the sun (horizontal), b = (-a.z, a.x), E = n * spacing.

export const EARTH_R = 6371000;

/**
 * heightAt(x, z) -> m; job = {cx, cz, ax, az, n, spacing, preroll}. Returns Uint8Array(n * n).
 */
export function computeHorizon(heightAt, job) {
  const { cx, cz, ax, az, n, spacing } = job;
  const preroll = Math.max(0, Math.ceil((job.preroll || 0) / spacing));
  const bx = -az, bz = ax;
  const E = n * spacing;
  const m = n + preroll;                      // samples per row (preroll beyond the sunward edge)
  const H = new Float64Array(m);
  const U = new Float64Array(m);
  const stack = new Int32Array(m);
  const out = new Uint8Array(n * n);
  const inv2R = 1 / (2 * EARTH_R);
  const k255 = 255 / Math.sqrt(Math.PI / 2);
  for (let j = 0; j < n; j++) {
    const v = ((j + 0.5) / n - 0.5) * E;
    const ox = cx + bx * v, oz = cz + bz * v;
    for (let i = 0; i < m; i++) {
      const u = ((i + 0.5) / n - 0.5) * E;
      const x = ox + ax * u, z = oz + az * u;
      const d = (i + 0.5) * spacing;            // distance from the row start (keeps u^2 small)
      U[i] = d;
      H[i] = heightAt(x, z) - d * d * inv2R;
    }
    // sweep from the sunward end
    let top = -1;
    for (let i = m - 1; i >= 0; i--) {
      const ui = U[i], hi = H[i];
      while (top >= 1) {
        const a = stack[top], b = stack[top - 1];
        const sa = (H[a] - hi) / (U[a] - ui), sb = (H[b] - hi) / (U[b] - ui);
        if (sa <= sb) top--; else break;
      }
      if (i < n) {
        let ang = 0;
        if (top >= 0) {
          const a = stack[top];
          const s = (H[a] - hi) / (U[a] - ui) + ui / EARTH_R;
          if (s > 0) ang = Math.atan(s);
        }
        out[j * n + i] = Math.min(255, Math.round(Math.sqrt(ang) * k255));
      }
      stack[++top] = i;
    }
  }
  return out;
}

/** Decodes a stored value to radians. */
export function decodeHorizon(v) {
  const s = v / 255;
  return s * s * Math.PI / 2;
}
