// Physically based clear-sky atmosphere (Rayleigh + Mie + ozone, single scattering plus
// Hillaire's multiple-scattering approximation, "A Scalable and Production Ready Sky and
// Atmosphere Rendering Technique", EGSR 2020).
//
// This file is pure JS (no three.js) so it runs in node tests. It builds the two small
// look-up tables the GPU needs (transmittance 256 x 64, multiple scattering 32 x 32) and
// evaluates sun colour, sky irradiance and horizon colour on the CPU for the lights and
// the shared fog uniforms. js/env/atmosphereGLSL.js mirrors the same formulas on the GPU.
//
// Units: metres. Radiance is relative to a sun illuminance of 1 at the top of the
// atmosphere; Environment scales it by its sun illuminance (scene units).

export const EARTH_RADIUS = 6371000;

/** Default parameters. `visibilityKm` sets the boundary-layer haze (Mie) density. */
export function makeAtmosphereParams(visibilityKm = 60) {
  const rayleigh = [5.802e-6, 13.558e-6, 33.1e-6];
  // meteorological range V: extinction at 550 nm = 3.912 / V; Rayleigh (green) takes its share
  const mieExt = Math.max(2e-6, 3.912 / (visibilityKm * 1000) - rayleigh[1]);
  return {
    Rg: EARTH_RADIUS,
    Rt: EARTH_RADIUS + 100000,
    rayleighScattering: rayleigh,
    rayleighH: 8000,
    mieExtinction: mieExt,
    mieScattering: mieExt * 0.9, // single scattering albedo of haze ~0.9
    mieH: 1200,
    mieG: 0.8,
    ozoneAbsorption: [0.650e-6, 1.881e-6, 0.085e-6],
    ozoneCenter: 25000,
    ozoneWidth: 15000,
    groundAlbedo: 0.13,
    visibilityKm,
  };
}

export const TRANSMITTANCE_W = 256, TRANSMITTANCE_H = 64;
export const MS_SIZE = 32;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------------------
// geometry helpers (ray from radius r with cos-zenith mu)

export function distanceToTop(p, r, mu) {
  const disc = r * r * (mu * mu - 1) + p.Rt * p.Rt;
  return Math.max(0, -r * mu + Math.sqrt(Math.max(disc, 0)));
}

export function distanceToGround(p, r, mu) {
  const disc = r * r * (mu * mu - 1) + p.Rg * p.Rg;
  return Math.max(0, -r * mu - Math.sqrt(Math.max(disc, 0)));
}

export function hitsGround(p, r, mu) {
  return mu < 0 && r * r * (mu * mu - 1) + p.Rg * p.Rg >= 0;
}

/** Densities [rayleigh, mie, ozone] at altitude h (m). */
function densities(p, h) {
  return [
    Math.exp(-h / p.rayleighH),
    Math.exp(-h / p.mieH),
    Math.max(0, 1 - Math.abs(h - p.ozoneCenter) / p.ozoneWidth),
  ];
}

function extinctionAt(p, h, out) {
  const d = densities(p, h);
  for (let c = 0; c < 3; c++) {
    out[c] = p.rayleighScattering[c] * d[0] + p.mieExtinction * d[1] + p.ozoneAbsorption[c] * d[2];
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// transmittance LUT (Bruneton 2017 parameterisation, only rays that do not hit the ground)

function uvFromUnit(u, size) { return 0.5 / size + u * (1 - 1 / size); }
function unitFromUv(uv, size) { return (uv - 0.5 / size) / (1 - 1 / size); }

export function transmittanceUv(p, r, mu) {
  const H = Math.sqrt(p.Rt * p.Rt - p.Rg * p.Rg);
  const rho = Math.sqrt(Math.max(0, r * r - p.Rg * p.Rg));
  const d = distanceToTop(p, r, mu);
  const dMin = p.Rt - r, dMax = rho + H;
  const xMu = (d - dMin) / (dMax - dMin);
  const xR = rho / H;
  return [uvFromUnit(clamp01(xMu), TRANSMITTANCE_W), uvFromUnit(clamp01(xR), TRANSMITTANCE_H)];
}

function rMuFromTransmittanceUv(p, u, v) {
  const xMu = unitFromUv(u, TRANSMITTANCE_W), xR = unitFromUv(v, TRANSMITTANCE_H);
  const H = Math.sqrt(p.Rt * p.Rt - p.Rg * p.Rg);
  const rho = H * xR;
  const r = Math.sqrt(rho * rho + p.Rg * p.Rg);
  const dMin = p.Rt - r, dMax = rho + H;
  const d = dMin + xMu * (dMax - dMin);
  let mu = d === 0 ? 1 : (H * H - rho * rho - d * d) / (2 * r * d);
  mu = Math.max(-1, Math.min(1, mu));
  return [r, mu];
}

/** Transmittance from radius r along mu to the top of the atmosphere (numerical, 64 steps). */
export function transmittanceToTop(p, r, mu, out = [0, 0, 0]) {
  const d = distanceToTop(p, r, mu);
  const n = 64, dt = d / n;
  let o0 = 0, o1 = 0, o2 = 0;
  const e = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) * dt;
    const h = Math.sqrt(t * t + 2 * r * mu * t + r * r) - p.Rg;
    extinctionAt(p, h, e);
    o0 += e[0] * dt; o1 += e[1] * dt; o2 += e[2] * dt;
  }
  out[0] = Math.exp(-o0); out[1] = Math.exp(-o1); out[2] = Math.exp(-o2);
  return out;
}

/** Float32Array RGBA (W x H) of the transmittance LUT. */
export function buildTransmittanceLUT(p) {
  const data = new Float32Array(TRANSMITTANCE_W * TRANSMITTANCE_H * 4);
  const t = [0, 0, 0];
  for (let j = 0; j < TRANSMITTANCE_H; j++) {
    for (let i = 0; i < TRANSMITTANCE_W; i++) {
      const [r, mu] = rMuFromTransmittanceUv(p, (i + 0.5) / TRANSMITTANCE_W, (j + 0.5) / TRANSMITTANCE_H);
      transmittanceToTop(p, r, mu, t);
      const k = (j * TRANSMITTANCE_W + i) * 4;
      data[k] = t[0]; data[k + 1] = t[1]; data[k + 2] = t[2]; data[k + 3] = 1;
    }
  }
  return data;
}

/** Bilinear lookup in a built transmittance LUT; 0 when the sun is below the horizon at r. */
export function sampleTransmittance(p, lut, r, mu, out = [0, 0, 0]) {
  r = Math.max(p.Rg, Math.min(p.Rt, r));
  if (hitsGround(p, r, mu)) { out[0] = out[1] = out[2] = 0; return out; }
  const [u, v] = transmittanceUv(p, r, mu);
  return bilinear(lut, TRANSMITTANCE_W, TRANSMITTANCE_H, u, v, out);
}

function bilinear(data, w, h, u, v, out) {
  const x = Math.max(0, Math.min(w - 1, u * w - 0.5));
  const y = Math.max(0, Math.min(h - 1, v * h - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  for (let c = 0; c < 3; c++) {
    const a = data[(y0 * w + x0) * 4 + c], b = data[(y0 * w + x1) * 4 + c];
    const cc = data[(y1 * w + x0) * 4 + c], d = data[(y1 * w + x1) * 4 + c];
    out[c] = (a + (b - a) * fx) * (1 - fy) + (cc + (d - cc) * fx) * fy;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// multiple scattering LUT (Hillaire 2020, section 5.5): psi_ms(h, mu_sun)

export function buildMultipleScatteringLUT(p, tLut) {
  const N = MS_SIZE;
  const data = new Float32Array(N * N * 4);
  const SQRT_SAMPLES = 8;
  const STEPS = 20;
  const isoPhase = 1 / (4 * Math.PI);
  const ts = [0, 0, 0], e = [0, 0, 0];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const muS = -1 + 2 * (i + 0.5) / N;
      const h = Math.max(10, (j + 0.5) / N * (p.Rt - p.Rg));
      const r = p.Rg + h;
      const L2 = [0, 0, 0], fms = [0, 0, 0];
      for (let a = 0; a < SQRT_SAMPLES; a++) {
        for (let b = 0; b < SQRT_SAMPLES; b++) {
          // uniform sphere directions
          const cosT = 1 - 2 * (a + 0.5) / SQRT_SAMPLES;
          const sinT = Math.sqrt(1 - cosT * cosT);
          const phi = 2 * Math.PI * (b + 0.5) / SQRT_SAMPLES;
          const dir = [sinT * Math.cos(phi), sinT * Math.sin(phi), cosT]; // z = up
          const mu = dir[2];
          const ground = hitsGround(p, r, mu);
          const dist = ground ? distanceToGround(p, r, mu) : distanceToTop(p, r, mu);
          const dt = dist / STEPS;
          const thr = [1, 1, 1], L = [0, 0, 0], F = [0, 0, 0];
          const sun = [Math.sqrt(1 - muS * muS), 0, muS];
          for (let s = 0; s < STEPS; s++) {
            const t = (s + 0.5) * dt;
            // sample position relative to the planet centre (camera at (0, 0, r))
            const px = dir[0] * t, py = dir[1] * t, pz = r + dir[2] * t;
            const pr = Math.sqrt(px * px + py * py + pz * pz);
            const hs = pr - p.Rg;
            const d = densities(p, hs);
            extinctionAt(p, hs, e);
            const muSs = (px * sun[0] + py * sun[1] + pz * sun[2]) / pr;
            sampleTransmittance(p, tLut, pr, muSs, ts);
            for (let c = 0; c < 3; c++) {
              const scat = p.rayleighScattering[c] * d[0] + p.mieScattering * d[1];
              const stepT = Math.exp(-e[c] * dt);
              const integ = e[c] > 0 ? (1 - stepT) / e[c] : dt;
              L[c] += thr[c] * scat * ts[c] * isoPhase * integ;
              F[c] += thr[c] * scat * integ;
              thr[c] *= stepT;
            }
          }
          if (ground) {
            const gx = dir[0] * dist, gy = dir[1] * dist, gz = r + dir[2] * dist;
            const gr = Math.sqrt(gx * gx + gy * gy + gz * gz);
            const muG = (gx * sun[0] + gy * sun[1] + gz * sun[2]) / gr;
            sampleTransmittance(p, tLut, gr, muG, ts);
            for (let c = 0; c < 3; c++) L[c] += thr[c] * ts[c] * Math.max(0, muG) * p.groundAlbedo / Math.PI;
          }
          const w = 4 * Math.PI / (SQRT_SAMPLES * SQRT_SAMPLES);
          for (let c = 0; c < 3; c++) { L2[c] += L[c] * w; fms[c] += F[c] * w; }
        }
      }
      const k = (j * N + i) * 4;
      for (let c = 0; c < 3; c++) {
        const l2 = L2[c] * isoPhase, f = fms[c] * isoPhase;
        data[k + c] = l2 / (1 - Math.min(f, 0.99));
      }
      data[k + 3] = 1;
    }
  }
  return data;
}

export function sampleMultipleScattering(p, msLut, h, muS, out = [0, 0, 0]) {
  const u = clamp01(muS * 0.5 + 0.5);
  const v = clamp01(h / (p.Rt - p.Rg));
  return bilinear(msLut, MS_SIZE, MS_SIZE, u, v, out);
}

// ---------------------------------------------------------------------------------------
// sky radiance along one view ray (single scattering + multiple scattering), CPU version

function rayleighPhase(c) { return 3 / (16 * Math.PI) * (1 + c * c); }
function miePhase(c, g) {
  // Cornette-Shanks
  const g2 = g * g;
  const k = 3 / (8 * Math.PI) * (1 - g2) / (2 + g2);
  return k * (1 + c * c) / Math.pow(1 + g2 - 2 * g * c, 1.5);
}

/**
 * In-scattered radiance (sun illuminance 1) and transmittance for a ray from altitude h
 * with direction dir (x, y = up, z), sun direction sun. Returns {L: [r,g,b], T: [r,g,b]}.
 */
export function skyRadiance(p, luts, h, dir, sun, steps = 24) {
  const r = p.Rg + Math.max(h, 1);
  const mu = dir[1];
  const ground = hitsGround(p, r, mu);
  const dist = ground ? distanceToGround(p, r, mu) : distanceToTop(p, r, mu);
  const cosT = dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2];
  const pr = rayleighPhase(cosT), pm = miePhase(cosT, p.mieG);
  const thr = [1, 1, 1], L = [0, 0, 0];
  const e = [0, 0, 0], ts = [0, 0, 0], ms = [0, 0, 0];
  let tPrev = 0;
  for (let s = 0; s < steps; s++) {
    // quadratic distribution: dense samples near the camera
    const t1 = dist * Math.pow((s + 1) / steps, 2);
    const dt = t1 - tPrev;
    const t = tPrev + dt * 0.5;
    tPrev = t1;
    const px = dir[0] * t, py = r + dir[1] * t, pz = dir[2] * t;
    const prr = Math.sqrt(px * px + py * py + pz * pz);
    const hs = prr - p.Rg;
    const d = densities(p, hs);
    extinctionAt(p, hs, e);
    const muS = (px * sun[0] + py * sun[1] + pz * sun[2]) / prr;
    sampleTransmittance(p, luts.transmittance, prr, muS, ts);
    sampleMultipleScattering(p, luts.ms, hs, muS, ms);
    for (let c = 0; c < 3; c++) {
      const sr = p.rayleighScattering[c] * d[0], sm = p.mieScattering * d[1];
      const S = ts[c] * (sr * pr + sm * pm) + ms[c] * (sr + sm);
      const stepT = Math.exp(-e[c] * dt);
      L[c] += thr[c] * S * (e[c] > 0 ? (1 - stepT) / e[c] : dt);
      thr[c] *= stepT;
    }
  }
  return { L, T: thr, ground, dist };
}

/** Builds both LUTs. */
export function buildLUTs(p) {
  const transmittance = buildTransmittanceLUT(p);
  const ms = buildMultipleScatteringLUT(p, transmittance);
  return { transmittance, ms };
}

/**
 * Hemispherical sky irradiance on a horizontal surface at altitude h (sun illuminance 1),
 * and the mean horizon radiance (for simple fog colours).
 */
export function skyIrradiance(p, luts, h, sun) {
  const E = [0, 0, 0];
  const NT = 6, NP = 12;
  for (let a = 0; a < NT; a++) {
    // cosine-weighted: uniform in sin^2(theta)
    const s2 = (a + 0.5) / NT;
    const sinT = Math.sqrt(s2), cosT = Math.sqrt(1 - s2);
    for (let b = 0; b < NP; b++) {
      const phi = 2 * Math.PI * (b + 0.5) / NP;
      const dir = [sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)];
      const { L } = skyRadiance(p, luts, h, dir, sun, 16);
      for (let c = 0; c < 3; c++) E[c] += L[c];
    }
  }
  // integral of L cos over the hemisphere = pi * mean(L) under cosine-weighted sampling
  for (let c = 0; c < 3; c++) E[c] *= Math.PI / (NT * NP);
  const H = [0, 0, 0];
  const NH = 8;
  for (let b = 0; b < NH; b++) {
    const phi = 2 * Math.PI * (b + 0.5) / NH;
    const dir = [Math.cos(phi) * 0.9986, 0.0523, Math.sin(phi) * 0.9986]; // 3 deg up
    const { L } = skyRadiance(p, luts, h, dir, sun, 16);
    for (let c = 0; c < 3; c++) H[c] += L[c] / NH;
  }
  return { irradiance: E, horizon: H };
}

/** Sun transmittance at altitude h for a sun direction (y = up), using the LUT. */
export function sunTransmittance(p, luts, h, sun, out = [0, 0, 0]) {
  const r = p.Rg + Math.max(h, 0);
  // soften the terminator over the sun's disc (about +-0.27 deg)
  const mu = sun[1];
  sampleTransmittance(p, luts.transmittance, r, mu, out);
  const muH = -Math.sqrt(Math.max(0, 1 - (p.Rg / r) ** 2));
  const vis = clamp01((mu - muH) / 0.0093 + 0.5);
  if (vis < 1) {
    const t2 = sampleTransmittance(p, luts.transmittance, r, muH + 0.0047, [0, 0, 0]);
    for (let c = 0; c < 3; c++) out[c] = t2[c] * vis;
  }
  return out;
}

/** Total extinction (green) at altitude h, 1/m. */
export function extinctionGreen(p, h) {
  const e = extinctionAt(p, h, [0, 0, 0]);
  return e[1];
}
