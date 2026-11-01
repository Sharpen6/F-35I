// Airfield lights: runway edge, threshold / end, centreline and touchdown zone lights, approach
// lights with sequenced flashers, PAPI, blue taxiway edge lights and apron floodlight masts.
// Owned by js/world/Roads.js (setAirfields once its data is in, update every frame).
//
// Layout: ICAO Annex 14 on the runways of data/terrain/airports.json (the ones the terrain
// paints), configured per runway end by data/world/airfields/airfields.json (runwayLights, from
// sim/tools/world/airfields.py): edge lights every <= 60 m, 1 m outside the edge, white, yellow in
// the last 600 m of an instrument runway, red before a displaced threshold; green threshold bar,
// red end bar (3 m spacing); centreline every 30 m (white, red / white from 900 m before the end,
// red the last 300 m); touchdown zone barrettes every 60 m to 900 m; approach lights (900 m
// Calvert-style CAT I or a 420 m simple layout); PAPI on the left abeam the aiming point (2.5,
// 2.83, 3.17, 3.5 deg). Taxiway edge lights and floodlight masts come from airfields.json.
//
// Drawing: one THREE.Points per airfield, camera-facing sprites. Every light has a colour and
// intensity (cd) seen from either side of its axis and a beam; the vertex shader takes the
// illuminance at the eye (I * T / d^2, T the atmosphere's transmittance) against the threshold of
// a point source on the background luminance (Allard / Blondel-Rey: E_t = 10^(0.64 log10 B - 5.7)
// lux), so a light is invisible at noon and bright at night by the same rule, then sizes the
// sprite (clamped in pixels) and writes HDR colour divided by the exposure (bright lights exceed
// 1 and bloom where a post chain does that). Depth tested against the terrain with the sprite
// pulled towards the camera (coarse distant terrain does not swallow lights on the ground).
// Switched by sun elevation: runway, approach and taxiway lights from sun 8 deg, floodlights
// from sunset; PAPI always on.

import * as THREE from 'three';
import { ATMOSPHERE_CORE } from '../env/atmosphereGLSL.js';

const DEG = Math.PI / 180;
// aviation colours (linear RGB): halogen white, yellow, green, red, blue, floodlight (4000 K), xenon strobe
const C = {
  white: [1.0, 0.86, 0.66], yellow: [1.0, 0.62, 0.1], green: [0.1, 1.0, 0.42], red: [1.0, 0.07, 0.03],
  blue: [0.12, 0.28, 1.0], flood: [1.0, 0.93, 0.82], strobe: [0.9, 0.94, 1.0], off: [0, 0, 0],
};
const KIND = { normal: 0, papi: 1, flash: 2, omni: 3 };
const GROUP = { runway: 0, approach: 1, taxi: 2, flood: 3, papi: 4 };

/** Outdoor illuminance (lux) for a sun elevation (deg): daylight, civil / nautical twilight, night. */
export function skyIlluminance(el) {
  const H = [-18, -12, -9, -6, -4, -2, 0, 2, 5, 10, 20, 40, 90];
  const L = [-3, -2.1, -1, 0.53, 1.48, 2.18, 2.85, 3.3, 3.78, 4.3, 4.7, 4.95, 5.08];
  if (el <= H[0]) return 10 ** L[0];
  for (let i = 1; i < H.length; i++) {
    if (el <= H[i]) return 10 ** (L[i - 1] + (L[i] - L[i - 1]) * (el - H[i - 1]) / (H[i] - H[i - 1]));
  }
  return 10 ** L[L.length - 1];
}

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${ATMOSPHERE_CORE}
attribute vec4 aColA;      // rgb, cd: seen from the -axis side (e.g. landing on the runway's first end)
attribute vec4 aColB;      // rgb, cd: seen from the +axis side
attribute vec4 aDir;       // axis x, z; horizontal beam half width (rad, 0: omnidirectional); kind
attribute vec3 aExt;       // PAPI angle (rad) / flash phase; omnidirectional share; switch group
uniform vec4 uOn;          // runway, approach, taxiway, floodlights: intensity factor (0: off)
uniform float uPapiOn;
uniform float uThreshold;  // lux: threshold of a point source on the background
uniform float uExposure;
uniform float uPx;         // pixel scale
uniform float uClock;      // seconds
varying vec3 vColor;
varying float vSize;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 rel = mv.xyz * mat3(viewMatrix);         // light - camera, world axes
  float hLight = uCamAltitude + rel.y;            // MSL height of the light (before the curvature drop)
  rel.y -= atmoCurvatureDrop(rel.xz);
  float d = max(length(rel), 0.5);
  vec3 toCam = -rel / d;
  float kind = aDir.w;
  // which side of the axis the eye is on, and the beam
  float side = dot(toCam.xz, aDir.xy);
  vec4 col = side >= 0.0 ? aColB : aColA;
  float I = col.a;
  if (aDir.z > 0.0) {
    float h = length(toCam.xz);
    float c = h > 1e-4 ? abs(side) / h : 1.0;                 // cos of the horizontal angle off the axis
    float ang = acos(clamp(c, -1.0, 1.0));
    float el = atan(toCam.y, h);
    float beam = exp(-pow(ang / aDir.z, 2.0)) * exp(-pow((el - 0.07) / 0.2, 2.0));
    I *= max(beam, aExt.y);
  }
  vec3 rgb = col.rgb;
  if (kind == 1.0) {
    // PAPI: white above the unit's angle, red below (3 arc minutes of transition)
    float el = atan(toCam.y, length(toCam.xz));
    float w = smoothstep(aExt.x - 0.0009, aExt.x + 0.0009, el);
    rgb = mix(vec3(1.0, 0.07, 0.03), vec3(1.0, 0.9, 0.75), w);
    I *= uPapiOn;
  } else if (kind == 2.0) {
    // sequenced flasher: one run towards the threshold twice a second
    float t = fract(uClock * 2.0 - aExt.x);
    I *= exp(-t * 60.0) * 3.0;
  }
  int grp = int(aExt.z + 0.5);
  float on = grp == 0 ? uOn.x : grp == 1 ? uOn.y : grp == 2 ? uOn.z : grp == 3 ? uOn.w : 1.0;
  I *= on;
  // illuminance at the eye through the atmosphere, against the detection threshold
  vec3 T = atmoPathTransmittance(uCamAltitude, hLight, d);
  float E = I * T.g / (d * d);
  float V = E / uThreshold;
  float lv = log2(max(V, 1e-6));
  // brightness and size grow with the log of the excess over threshold (as star magnitudes):
  // a light just above threshold is a faint pixel, a bright one a saturated disc a few px wide
  float a = clamp(lv / 3.0, 0.0, 1.0);
  float peak = min(a * (0.5 + 0.15 * max(lv - 3.0, 0.0)), 3.0);
  vColor = rgb * (T / max(T.g, 1e-4)) * peak / max(uExposure, 1e-4);
  vSize = clamp(0.9 + 0.12 * max(lv - 2.0, 0.0), 0.9, 3.2) * uPx;
  gl_PointSize = a > 0.0 ? vSize * 3.5 : 0.0;
  // towards the camera, so the coarse terrain far away does not hide lights on the ground
  float pull = min(0.012 * d, d * 0.5);
  vec3 relP = rel * (1.0 - pull / d);
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * relP, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vSize;
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = (gl_PointCoord - 0.5) * vSize * 3.5;      // pixels from the centre
  float r2 = dot(p, p) / (vSize * vSize);
  float f = exp(-2.5 * r2) + 0.03 * exp(-0.4 * r2);   // core and a faint halo (bloom adds glare)
  if (f < 0.004) discard;
  gl_FragColor = vec4(vColor * f, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

class LightList {
  constructor() { this.p = []; this.a = []; this.b = []; this.d = []; this.e = []; }
  /** world x, y, z; colours / cd from -axis (A) and +axis (B); axis (ux, uz); beam half width; kind; ext. */
  add(x, y, z, colA, cdA, colB, cdB, ux = 1, uz = 0, beam = 0, kind = KIND.normal, ext0 = 0, omni = 0, group = 0) {
    this.p.push(x, y, z);
    this.a.push(colA[0], colA[1], colA[2], cdA);
    this.b.push(colB[0], colB[1], colB[2], cdB);
    this.d.push(ux, uz, beam, kind);
    this.e.push(ext0, omni, group);
  }
  get length() { return this.p.length / 3; }
}

export class AirportLights {
  constructor({ renderer, scene, env, terrain }) {
    this.renderer = renderer;
    this.scene = scene;
    this.env = env;
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.group.name = 'AirportLights';
    scene.add(this.group);
    this.quality = 'high';
    this.stats = { lights: 0, airfields: 0 };
    this.uniforms = {
      ...env.uniforms,
      uOn: { value: new THREE.Vector4() },
      uPapiOn: { value: 1 },
      uThreshold: { value: 1e-7 },
      uExposure: { value: 1 },
      uPx: { value: 1 },
      uClock: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'AirportLights',
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this._t0 = performance.now();
    this._built = false;
  }

  setQuality(q) { this.quality = q; }
  setTime() {}
  reset() {}

  /** Builds every airfield's lights (once the terrain and airfields.json are there). */
  setAirfields(af) {
    if (this._built || !this.terrain.runways) return;
    this._built = true;
    const cfg = (af && af.runwayLights) || {};
    const byIcao = new Map();
    const list = (icao) => { if (!byIcao.has(icao)) byIcao.set(icao, new LightList()); return byIcao.get(icao); };
    const hAt = (x, z) => this.terrain.heightAt(x, z);

    for (const r of this.terrain.runways.list) {
      const ap = (this.terrain.airports || []).find((a) => a.icao === r.icao);
      const rw = ap && ap.runways.find((x) => x.ends && x.ends[0].id === r.ends[0].id && x.ends[1].id === r.ends[1].id);
      if (!rw || rw.lighted === false || (ap && ap.closed)) continue;
      const conf = cfg[r.icao] || {};
      if (!Object.keys(conf).length && !af) continue;
      this._runway(list(r.icao), r, conf[r.ends[0].id] || null, conf[r.ends[1].id] || null, hAt);
    }
    // taxiway edge lights and floodlight masts (by the nearest airfield)
    const near = (x, z) => {
      let best = null, bd = 1e18;
      for (const ap of this.terrain.airports || []) {
        const d = (ap.x - x) ** 2 + (ap.z - z) ** 2;
        if (d < bd) { bd = d; best = ap.icao; }
      }
      return best;
    };
    for (const [x, z] of (af && af.taxiLights) || []) {
      list(near(x, z)).add(x, hAt(x, z) + 0.35, z, C.blue, 4, C.blue, 4, 1, 0, 0, KIND.omni, 0, 1, GROUP.taxi);
    }
    for (const [x, z, h, lux] of (af && af.masts) || []) {
      // lamp heads: bright from below and the side (a few thousand cd), off by day
      list(near(x, z)).add(x, hAt(x, z) + h, z, C.flood, 40 * lux, C.flood, 40 * lux, 1, 0, 0, KIND.omni, 0, 1, GROUP.flood);
    }
    let total = 0;
    for (const [icao, L] of byIcao) {
      if (!L.length) continue;
      // positions relative to the airfield's centre (float32 precision near the camera)
      let cx = 0, cz = 0;
      for (let i = 0; i < L.p.length; i += 3) { cx += L.p[i]; cz += L.p[i + 2]; }
      cx /= L.length; cz /= L.length;
      const pos = new Float32Array(L.p.length);
      let r2 = 0, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < L.p.length; i += 3) {
        pos[i] = L.p[i] - cx; pos[i + 1] = L.p[i + 1]; pos[i + 2] = L.p[i + 2] - cz;
        r2 = Math.max(r2, pos[i] ** 2 + pos[i + 2] ** 2);
        y0 = Math.min(y0, pos[i + 1]); y1 = Math.max(y1, pos[i + 1]);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aColA', new THREE.Float32BufferAttribute(L.a, 4));
      g.setAttribute('aColB', new THREE.Float32BufferAttribute(L.b, 4));
      g.setAttribute('aDir', new THREE.Float32BufferAttribute(L.d, 4));
      g.setAttribute('aExt', new THREE.Float32BufferAttribute(L.e, 3));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, (y0 + y1) / 2, 0), Math.sqrt(r2) + (y1 - y0) + 50);
      const pts = new THREE.Points(g, this.material);
      pts.name = `AirportLights ${icao}`;
      pts.position.set(cx, 0, cz);
      pts.matrixAutoUpdate = false;
      pts.updateMatrix();
      pts.renderOrder = 1;          // before the canopy glass (2, 3), which tints them
      pts.frustumCulled = true;
      this.group.add(pts);
      total += L.length;
    }
    this.stats.lights = total;
    this.stats.airfields = byIcao.size;
  }

  /** The lights of one runway; ca / cb: configuration of landing on end 0 / end 1 (or null). */
  _runway(L, r, ca, cb, hAt) {
    const [a, b] = r.ends;
    const ux = r.ux, uz = r.uz, len = r.length, hw = r.halfWidth;
    const rx = -uz, rz = ux;                    // right of travel from end 0 to end 1
    const P = (s, t) => [a.x + ux * s + rx * t, a.z + uz * s + rz * t];
    const d0 = r.displaced[0], d1 = r.displaced[1];
    const instA = !!(ca && ca.inst), instB = !!(cb && cb.inst);
    const put = (s, t, lift, colA, cdA, colB, cdB, beam, kind = KIND.normal, ext0 = 0, omni = 0, group = GROUP.runway) => {
      const [x, z] = P(s, t);
      L.add(x, hAt(x, z) + lift, z, colA, cdA, colB, cdB, ux, uz, beam, kind, ext0, omni, group);
    };
    // edge lights (elevated, bidirectional, a little light all round for circling)
    const n = Math.max(2, Math.ceil(len / 60));
    for (let k = 0; k <= n; k++) {
      const s = len * k / n;
      const colA = s < d0 ? C.red : (instA && len - s < 600 ? C.yellow : C.white);
      const colB = s > len - d1 ? C.red : (instB && s < 600 ? C.yellow : C.white);
      for (const t of [-hw - 1, hw + 1]) put(s, t, 0.35, colA, 10000, colB, 10000, 10 * DEG, KIND.normal, 0, 0.012);
    }
    // threshold / end bars: at each end and at displaced thresholds (3 m spacing)
    const bar = (s, colA, cdA, colB, cdB) => {
      const m = Math.floor((2 * hw) / 3);
      for (let k = 0; k <= m; k++) put(s, -hw + (2 * hw) * k / m, 0.25, colA, cdA, colB, cdB, 12 * DEG, KIND.normal, 0, 0.004);
    };
    // end 0: green towards an approach to end 0 (-axis side), red towards the runway (+axis side)
    if (d0 > 0) { bar(0, C.off, 0, C.red, 2500); bar(d0, C.green, 10000, C.off, 0); } else bar(0, C.green, 10000, C.red, 2500);
    if (d1 > 0) { bar(len, C.red, 2500, C.off, 0); bar(len - d1, C.off, 0, C.green, 10000); } else bar(len, C.red, 2500, C.green, 10000);
    // centreline (inset, 30 m): white, red / white from 900 m before the end, red the last 300 m
    if ((ca && ca.cl) || (cb && cb.cl)) {
      const s0 = d0 + 30, s1 = len - d1 - 30;
      let k = 0;
      for (let s = s0; s <= s1 + 1e-6; s += 30, k++) {
        const endA = len - s, endB = s;
        const colA = endA < 300 ? C.red : endA < 900 ? (k % 2 ? C.red : C.white) : C.white;
        const colB = endB < 300 ? C.red : endB < 900 ? (k % 2 ? C.red : C.white) : C.white;
        put(s, 0, 0.05, colA, 5000, colB, 5000, 6 * DEG);
      }
    }
    const endLights = (conf, s0, dir) => {
      if (!conf) return;
      // dir = +1: landing on end 0 (travel +axis, seen from the -axis side = A)
      const A = dir > 0;
      const one = (s, t, lift, col, cd, beam, kind = KIND.normal, ext0 = 0, group = GROUP.runway) =>
        put(s, t * dir, lift, A ? col : C.off, A ? cd : 0, A ? C.off : col, A ? 0 : cd, beam, kind, ext0, 0, group);
      // touchdown zone: barrettes of 3 each side of the centreline every 60 m to 900 m
      if (conf.tdz) {
        for (let e = 60; e <= 900; e += 60) for (const t of [-12, -10.5, -9, 9, 10.5, 12]) one(s0 + dir * e, t, 0.05, C.white, 5000, 6 * DEG);
      }
      // PAPI: four units on the left, abeam the aiming point, inner unit 15 m from the edge
      if (conf.papi) {
        const sideSign = conf.papi === 'R' ? 1 : -1;
        const angles = [3.5, 3.1667, 2.8333, 2.5];
        angles.forEach((ang, i) => one(s0 + dir * 400, sideSign * (hw + 15 + 9 * i), 0.8, C.white, 30000, 10 * DEG, KIND.papi, ang * DEG, GROUP.papi));
      }
      // approach lights, outwards from the threshold
      if (conf.als) {
        const calvert = conf.als === 'calvert900';
        const lenA = calvert ? 900 : 420, step = calvert ? 30 : 60;
        for (let e = step; e <= lenA + 1e-6; e += step) {
          const sA = s0 - dir * e;
          // inset (flush) where they cross a displaced threshold's pavement, on short masts beyond
          const paved = sA > 0 && sA < len;
          const lift = paved ? 0.05 : 1.0;
          for (const t of calvert ? [-2, -1, 0, 1, 2] : [-1, 0, 1]) one(sA, t, lift, C.white, 20000, 10 * DEG, KIND.normal, 0, GROUP.approach);
          const crossbar = calvert ? (e % 150 === 0 ? { 150: 6, 300: 15, 450: 10, 600: 12, 750: 14, 900: 16 }[e] : 0) : (e === 300 ? 15 : 0);
          if (crossbar) for (let t = 4; t <= crossbar + 1e-6; t += 2.5) for (const sg of [-1, 1]) one(sA, sg * t, lift, C.white, 20000, 10 * DEG, KIND.normal, 0, GROUP.approach);
          // sequenced flashers from the outer end to 300 m
          if (conf.flash && e >= 300) one(sA, 0, paved ? 0.1 : 1.6, C.strobe, 12000, 12 * DEG, KIND.flash, (lenA - e) / (lenA - 300 + step) * 0.45, GROUP.approach);
        }
      }
    };
    endLights(ca, d0, +1);
    endLights(cb, len - d1, -1);
  }

  update(f) {
    if (!this._built) return;
    const env = this.env;
    const el = env.sunElevationDeg ?? 30;
    // runway / approach / taxiway lights from sun 8 deg (dusk, dawn, night), floods from sunset;
    // night intensity steps are lower than the day setting
    const dusk = Math.min(1, Math.max(0, (8 - el) / 4));
    const nightStep = el < -6 ? 0.35 : el < 0 ? 0.6 : 1.0;
    const flood = Math.min(1, Math.max(0, (1 - el) / 3));
    const U = this.uniforms;
    U.uOn.value.set(dusk * nightStep, dusk * nightStep, dusk, flood);
    U.uPapiOn.value = el > 8 ? 1 : nightStep;
    // background luminance of the ground (albedo 0.15, a little city glow at night) -> threshold
    const lux = skyIlluminance(el) + 0.05;
    const B = 0.15 * lux / Math.PI;
    U.uThreshold.value = Math.max(10 ** (0.64 * Math.log10(B) - 5.7), 1e-7);
    U.uExposure.value = this.renderer.toneMappingExposure || 1;
    U.uPx.value = Math.min(2, this.renderer.getPixelRatio()) * Math.max(0.6, Math.min(1.6, this.renderer.domElement.height / 1080));
    U.uClock.value = (performance.now() - this._t0) / 1000;
    this.group.visible = true;
  }

  dispose() {
    for (const o of [...this.group.children]) o.geometry.dispose();
    this.scene.remove(this.group);
    this.material.dispose();
  }
}
