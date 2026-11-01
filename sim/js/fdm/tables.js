// Small numeric helpers shared by the flight-model modules: clamped table lookup and smooth steps.

/** Linear interpolation in a table (xs ascending), clamped at both ends. */
export function lerpTable(xs, ys, x) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] > x) hi = mid; else lo = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/** A 1-D table {x: [...], y: [...]} evaluated at x. */
export function table(t, x) {
  return lerpTable(t.x, t.y, x);
}

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Hermite smoothstep: 0 below e0, 1 above e1. */
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Smooth maximum of a and b (rounded corner of width ~eps). */
export function smoothMax(a, b, eps) {
  const d = a - b;
  return 0.5 * (a + b + Math.sqrt(d * d + eps * eps));
}

/** Wrap an angle to (-pi, pi]. */
export function wrapPi(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

/** Move x toward target by at most maxStep. */
export function approach(x, target, maxStep) {
  const d = target - x;
  return Math.abs(d) <= maxStep ? target : x + Math.sign(d) * maxStep;
}

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
