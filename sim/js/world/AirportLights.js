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
// 1 and bloom where a post chain does that), with its mark as a light in the alpha
// (js/env/emitters.js: Post.js keeps its hue and night vision leaves it alone). Depth tested
// against the terrain with the sprite pulled towards the camera (coarse distant terrain does not
// swallow lights on the ground). Switched on by the one schedule of js/env (env.lightsOn, from
// just before sunset), the PAPI always on; at night the runway, approach and PAPI lights are on
// a lower intensity step (as ATC sets them), by the eye's adaptation (env.lightNight).
//
// Also drawn here: the street lamps (roads/lamps_ix_iz.bin, one THREE.Points per road tile out to
// LAMP_RANGE, their own program: 16 bytes a lamp), thinned with distance with the light of the
// lamps left out carried by the ones kept, and the cars' lights (js/world/Traffic.js).

import * as THREE from 'three';
import { ATMOSPHERE_CORE } from '../env/atmosphereGLSL.js';
import { skyIlluminance, pointLightThreshold, lightNight, lightsOn } from '../env/Environment.js';
import { EMITTER_GLSL, emitterBlending } from '../env/emitters.js';

// (the sky's light by the sun's elevation lives with the rule for lights at night in js/env)
export { skyIlluminance };

const DEG = Math.PI / 180;
// aviation colours (linear RGB): halogen white, yellow, green, red, blue, floodlight (4000 K), xenon strobe
const C = {
  white: [1.0, 0.86, 0.66], yellow: [1.0, 0.62, 0.1], green: [0.1, 1.0, 0.42], red: [1.0, 0.07, 0.03],
  blue: [0.12, 0.28, 1.0], flood: [1.0, 0.93, 0.82], strobe: [0.9, 0.94, 1.0], off: [0, 0, 0],
};
// shader kinds (5: the cars of js/world/Traffic.js; the street lamps have a program of their own)
const KIND = { normal: 0, papi: 1, flash: 2, omni: 3, vehicle: 5 };
const GROUP = { runway: 0, approach: 1, taxi: 2, flood: 3, papi: 4 };

// Street lamps (sim/tools/world/roads.py street_lamps: the lamps of the road shader's pools of
// light): high-pressure sodium on main roads, warm LED in towns, as in js/world/roadShaders.js.
// Colour: linear RGB, the chromaticity of the lamp a little short of its full saturation
// (high-pressure sodium, x 0.52 y 0.41, is (1, 0.26, 0.02); LED 3500-4000 K). cd of the luminaire
// seen from the side (below its horizontal plane), cd of its lit pool seen from above.
const LAMP = [
  { rgb: [1.0, 0.36, 0.06], side: 3000, pool: 600 },       // sodium, 12 m poles, 42 m apart
  { rgb: [1.0, 0.62, 0.32], side: 1200, pool: 250 },       // LED, 9 m, 33 m
];
const glslVec3 = (v) => `vec3(${v.map((x) => x.toFixed(4)).join(', ')})`;
const LAMP_DEFINES = {
  STREET_LAMPS: 1,
  LAMP_SODIUM_RGB: glslVec3(LAMP[0].rgb), LAMP_SODIUM_SIDE: LAMP[0].side.toFixed(1), LAMP_SODIUM_POOL: LAMP[0].pool.toFixed(1),
  LAMP_LED_RGB: glslVec3(LAMP[1].rgb), LAMP_LED_SIDE: LAMP[1].side.toFixed(1), LAMP_LED_POOL: LAMP[1].pool.toFixed(1),
};
/** Street lamps are drawn this far (m); the terrain's city lights, where it has them, beyond. */
export const LAMP_RANGE = { low: 8000, medium: 14000, high: 20000 };

const ERF_GLSL = /* glsl */ `
// erf to ~1e-4 (Winitzki)
float erfA(float x) {
  float t = x * x;
  return sign(x) * sqrt(1.0 - exp(-t * (1.2732395 + 0.147 * t) / (1.0 + 0.147 * t)));
}
`;

/**
 * The rule for point lights seen from afar (js/env/README.md "Lights at night"), shared by the
 * airfield lights, the street lamps and the cars (here) and the buildings' obstruction lights
 * (js/world/buildingShaders.js). Uniforms: uThreshold (lux at the eye at which a point light is
 * just seen: env.pointThreshold), uExposure (the renderer's), uPxAngle (radians per pixel of the
 * drawing buffer), uGain (scene irradiance per lux: env.lightGain / LUX_PER_UNIT).
 *   vertex:   pointLightSprite(I, c, d): intensity I (cd), colour c (through the atmosphere), d (m);
 *             sets vColor, vSigma, vSize and gl_PointSize
 *   fragment: pointLightRadiance(): this pixel's radiance (discards the empty corners);
 *             pointLightAlpha(L): the alpha to write with it, the light's mark (js/env/emitters.js;
 *             the material blends with emitterBlending)
 * Colour is carried by its brightest channel: the visibility floor and the cap on the display are
 * on that channel, so a red or blue light is as bright on the screen as a white one at the floor
 * (normalised by its luminance a red light's red channel stood at 3.8 times it, and AgX bleached
 * it pink), and Post.js tone-maps it by its hue.
 */
export const POINT_LIGHT_VERT_GLSL = /* glsl */ `
${ERF_GLSL}
uniform float uThreshold;  // lux: threshold of a point source on the background
uniform float uExposure;
uniform float uPxAngle;    // radians per pixel of the drawing buffer
uniform float uGain;       // scene irradiance per lux, times the night eye's adaptation (env.lightGain)
varying vec3 vColor;       // irradiance at the eye (scene units), per channel
varying float vSigma;      // Gaussian radius (px)
varying float vSize;       // point size (px)
void pointLightSprite(float I, vec3 c, float d) {
  float cl = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-6);
  float cm = max(max(c.r, max(c.g, c.b)), 1e-6);
  float E = I * cl / (d * d);                                  // lux (luminance-weighted)
  // Seen against its background (Allard / Blondel-Rey threshold E_t = 10^(0.64 log B - 5.7)):
  float V = E / uThreshold;
  float lv = log2(max(V, 1e-6));
  // Physical: the light's irradiance spread over a Gaussian of sigma px. A display cannot show
  // a point as bright as the eye sees it, so a light the eye sees well (by day: PAPI against a
  // sunlit field; at night: a lamp many km away) is at least as bright as its excess over the
  // threshold says (as star magnitudes), up to 0.8 on the display: only a light that is
  // physically brighter than that saturates the display (near ones: depth, not a flat carpet).
  // In its brightest channel (e): a saturated colour keeps its hue at the floor.
  float Om = uPxAngle * uPxAngle;
  float ePhys = E * uGain * smoothstep(0.5, 2.0, V) * cm / cl;
  float fc0 = erfA(0.5439) * erfA(0.5439);                     // centre pixel's share at sigma 0.65
  float peakP = clamp(lv / 3.0, 0.0, 1.0) * min(0.35 + 0.06 * max(lv - 3.0, 0.0), 0.8);
  float e = max(ePhys, peakP / max(uExposure, 1e-4) * Om / fc0);
  // never under 0.65 px (a sub-pixel Gaussian twinkles as it crosses pixel centres); wider when
  // bright, as glare
  float peak = e * fc0 / Om * uExposure;                        // display value of the centre pixel
  vSigma = clamp(0.65 * (1.0 + 0.12 * max(log2(max(peak, 1e-6)) - 2.0, 0.0)), 0.65, 1.6);
  vColor = c / cm * e;
  vSize = e > 0.0 && I > 0.0 ? 2.0 * ceil(3.5 * vSigma) + 1.0 : 0.0;
  gl_PointSize = vSize;
}
`;

export const POINT_LIGHT_FRAG_GLSL = /* glsl */ `
${ERF_GLSL}
${EMITTER_GLSL}
uniform float uPxAngle;
uniform float uExposure;
varying vec3 vColor;
varying float vSigma;
varying float vSize;
vec3 pointLightRadiance() {
  // this pixel's share of the light: the Gaussian integrated over the pixel's square, so the sum
  // over the pixels stays the light's whole energy wherever its centre falls (no twinkling)
  vec2 p = (gl_PointCoord - 0.5) * vSize;                    // pixel centre - light centre (px)
  float k = 0.70710678 / vSigma;
  float f = 0.25 * (erfA((p.x + 0.5) * k) - erfA((p.x - 0.5) * k)) * (erfA((p.y + 0.5) * k) - erfA((p.y - 0.5) * k));
  if (f < 2e-5) discard;
  // radiance: the share of the irradiance over the pixel's solid angle, at most 64 on the display
  // (where a bloom chain clamps)
  vec3 L = vColor * f / (uPxAngle * uPxAngle);
  float m = max(L.r, max(L.g, L.b)) * uExposure;
  return L * min(1.0, 64.0 / max(m, 1e-6));
}
// the light's mark in the alpha (js/env/emitters.js), from what this pixel adds to the display
float pointLightAlpha(vec3 L) {
  return emitterAlpha(emitterShare(max(L.r, max(L.g, L.b)) * uExposure));
}
`;

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${ATMOSPHERE_CORE}
${POINT_LIGHT_VERT_GLSL}
#ifdef STREET_LAMPS
// street lamps (their own material, 16 bytes a lamp): position and rank, flags
attribute vec4 aLamp;      // rank 0..255 (thinning with distance); flags: 1 LED, 2 a minor road; -; -
uniform float uStreetOn;
#else
attribute vec4 aColA;      // rgb, cd: seen from the -axis side (e.g. landing on the runway's first end)
attribute vec4 aColB;      // rgb, cd: seen from the +axis side
attribute vec4 aDir;       // axis x, z; horizontal beam half width (rad, 0: omnidirectional; cars: fade); kind
attribute vec3 aExt;       // PAPI angle (rad) / flash phase; omni share; switch group
uniform vec4 uOn;          // runway, approach, taxiway, floodlights: intensity factor (0: off)
uniform float uPapiOn;
uniform float uClock;      // seconds
#endif
uniform vec3 uRange;       // road ribbons' range, group 0 and 1; street lamps' range (m)

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 rel = mv.xyz * mat3(viewMatrix);         // light - camera, world axes
  float hLight = uCamAltitude + rel.y;            // MSL height of the light (before the curvature drop)
  rel.y -= atmoCurvatureDrop(rel.xz);
  float d = max(length(rel), 0.5);
  vec3 toCam = -rel / d;
  float I;
  vec3 rgb;
#ifdef STREET_LAMPS
  // The luminaire (cut-off optics: its full intensity from below its horizontal plane, from above
  // only the glow of its glass, ~8 %) and, beyond the range where the road surface shows its
  // pool of light, the pool as a point (Lambertian, seen from above).
  bool led = mod(aLamp.y, 2.0) > 0.5;
  rgb = led ? LAMP_LED_RGB : LAMP_SODIUM_RGB;
  float se = toCam.y;                                          // sine of the eye's elevation from the lamp
  float poolFrom = aLamp.y > 1.5 ? uRange.y : uRange.x;
  I = (led ? LAMP_LED_SIDE : LAMP_SODIUM_SIDE) * (0.08 + 0.92 * (1.0 - smoothstep(-0.1, 0.1, se)))
    + (led ? LAMP_LED_POOL : LAMP_SODIUM_POOL) * max(se, 0.0) * smoothstep(0.75 * poolFrom, poolFrom, d);
  // thinned with distance: (4 km / d)^2 of the lamps, at least 1 in 16, each carrying the light
  // of those left out; faded out at the end of the range
  float keep = clamp(16.0e6 / (d * d), 1.0 / 16.0, 1.0);
  I *= ((aLamp.x + 0.5) / 256.0 < keep ? 1.0 / keep : 0.0) * (1.0 - smoothstep(0.8 * uRange.z, uRange.z, d)) * uStreetOn;
#else
  float kind = aDir.w;
  // which side of the axis the eye is on, and the beam (a car's is fixed: its aDir.z is its fade)
  float side = dot(toCam.xz, aDir.xy);
  vec4 col = side >= 0.0 ? aColB : aColA;
  I = col.a;
  float bw = kind == 5.0 ? 0.55 : aDir.z;
  if (bw > 0.0) {
    float h = length(toCam.xz);
    float c = h > 1e-4 ? abs(side) / h : 1.0;                 // cos of the horizontal angle off the axis
    float ang = acos(clamp(c, -1.0, 1.0));
    float el = atan(toCam.y, h);
    float beam = exp(-pow(ang / bw, 2.0)) * exp(-pow((el - 0.07) / 0.2, 2.0));
    I *= max(beam, aExt.y);
  }
  rgb = col.rgb;
  if (kind == 1.0) {
    // PAPI: white above the unit's angle, red below (3 arc minutes of transition)
    float el = atan(toCam.y, length(toCam.xz));
    float w = smoothstep(aExt.x - 0.0009, aExt.x + 0.0009, el);
    rgb = mix(vec3(1.0, 0.07, 0.03), vec3(1.0, 0.9, 0.75), w);
    I *= uPapiOn;
  } else if (kind == 2.0) {
    // sequenced flasher: one run towards the threshold twice a second; each flash held 40 ms
    // (two or three frames: a shorter one falls between frames)
    float t = fract(uClock * 2.0 - aExt.x);
    I *= step(t, 0.08) * 1.5;
  } else if (kind == 5.0) {
    // a car (js/world/Traffic.js): faded in when it appears, out at a dead end and the radius
    I *= aDir.z;
  }
  int grp = int(aExt.z + 0.5);
  float on = grp == 0 ? uOn.x : grp == 1 ? uOn.y : grp == 2 ? uOn.z : grp == 3 ? uOn.w : 1.0;
  I *= on;
#endif
  // illuminance at the eye through the atmosphere
  vec3 T = atmoPathTransmittance(uCamAltitude, hLight, d);
  pointLightSprite(I, rgb * T, d);
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
${POINT_LIGHT_FRAG_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  vec3 L = pointLightRadiance();
  gl_FragColor = vec4(L, pointLightAlpha(L));
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
  constructor({ renderer, scene, env, terrain, camera, roads = null }) {
    this.renderer = renderer;
    this.scene = scene;
    this.env = env;
    this.terrain = terrain;
    this.camera = camera;
    this.roads = roads;
    this.group = new THREE.Group();
    this.group.name = 'AirportLights';
    scene.add(this.group);
    this.quality = 'high';
    this.stats = { lights: 0, airfields: 0, lamps: 0, lampTiles: 0 };
    this.uniforms = {
      ...env.uniforms,
      uOn: { value: new THREE.Vector4() },
      uPapiOn: { value: 1 },
      uStreetOn: { value: 0 },
      uThreshold: { value: 1e-7 },
      uExposure: { value: 1 },
      uPxAngle: { value: 1e-3 },
      uGain: { value: 1 / 32000 },
      uRange: { value: new THREE.Vector3(3400, 1600, LAMP_RANGE.high) },
      uClock: { value: 0 },
    };
    // street lamp tiles: 'ix,iz' -> {state, points}
    this._lampSrc = null;
    this._lampTiles = new Map();
    this._lampAt = new THREE.Vector3(1e9, 0, 0);
    this._dbSize = new THREE.Vector2();
    this._camPos = new THREE.Vector3();
    this.material = new THREE.ShaderMaterial({
      name: 'AirportLights',
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    emitterBlending(this.material);
    // the street lamps' own program (same shader, STREET_LAMPS): 16 bytes a lamp instead of 72
    this.lampMaterial = new THREE.ShaderMaterial({
      name: 'StreetLamps',
      uniforms: this.uniforms,
      defines: LAMP_DEFINES,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    emitterBlending(this.lampMaterial);
    this._t0 = performance.now();
    this._built = false;
  }

  setQuality(q) {
    this.quality = LAMP_RANGE[q] ? q : 'high';
    this.uniforms.uRange.value.z = LAMP_RANGE[this.quality];
    this._lampAt.set(1e9, 0, 0);
  }
  setTime() {}
  reset() { this._lampAt.set(1e9, 0, 0); }

  /** Where the street lamp tiles are (Roads.js, from roads/index.json): {baseUrl, files: {'ix,iz': count}}. */
  setLampSource(src) {
    this._lampSrc = src && src.files && Object.keys(src.files).length ? src : null;
    this._lampAt.set(1e9, 0, 0);
  }

  /** The road ribbons' draw range (m) of group 0 and group 1: lamp pools become points beyond. */
  setRoadRange(r0, r1) { this.uniforms.uRange.value.x = r0; this.uniforms.uRange.value.y = r1; }

  // street lamp tiles within the lamp range: loaded (8 bytes a lamp) and dropped as the camera moves
  _updateLamps(cam) {
    if (!this._lampSrc) return;
    const dx = cam.x - this._lampAt.x, dz = cam.z - this._lampAt.z;
    if (dx * dx + dz * dz < 500 * 500) return;
    this._lampAt.copy(cam);
    const R = LAMP_RANGE[this.quality], T = 6400, H = 51200;
    const want = new Set();
    const i0 = Math.max(0, Math.floor((cam.x - R + H) / T)), i1 = Math.min(15, Math.floor((cam.x + R + H) / T));
    const j0 = Math.max(0, Math.floor((cam.z - R + H) / T)), j1 = Math.min(15, Math.floor((cam.z + R + H) / T));
    for (let iz = j0; iz <= j1; iz++) {
      for (let ix = i0; ix <= i1; ix++) {
        const key = `${ix},${iz}`;
        if (!this._lampSrc.files[key]) continue;
        const ex = Math.max(-H + ix * T - cam.x, 0, cam.x - (-H + (ix + 1) * T));
        const ez = Math.max(-H + iz * T - cam.z, 0, cam.z - (-H + (iz + 1) * T));
        if (Math.hypot(ex, ez) > R) continue;
        want.add(key);
        if (!this._lampTiles.has(key)) this._loadLamps(key, ix, iz);
      }
    }
    for (const [key, t] of this._lampTiles) {
      if (want.has(key)) continue;
      const cx = -H + (t.ix + 0.5) * T, cz = -H + (t.iz + 0.5) * T;
      if (Math.hypot(cx - cam.x, cz - cam.z) < R + 6000) continue;      // keep a margin (no reload churn)
      this._dropLamps(key, t);
    }
  }

  _loadLamps(key, ix, iz) {
    const t = { state: 'loading', ix, iz, points: null, n: 0 };
    this._lampTiles.set(key, t);
    fetch(`${this._lampSrc.baseUrl}lamps_${ix}_${iz}.bin`).then((r) => (r.ok ? r.arrayBuffer() : null)).then((buf) => {
      if (this._lampTiles.get(key) !== t || !buf) { if (this._lampTiles.get(key) === t) t.state = 'failed'; return; }
      const dv = new DataView(buf);
      const n = buf.byteLength >= 8 && dv.getUint32(4, true);
      if (!n || String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'LMP1') { t.state = 'failed'; return; }
      const pos = new Float32Array(3 * n), lamp = new Uint8Array(4 * n);
      let y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const o = 8 + 8 * i;
        // relative to the tile's centre (float32 precision near the camera)
        pos[3 * i] = dv.getUint16(o, true) * 0.1 - 3200;
        pos[3 * i + 1] = dv.getUint16(o + 4, true) * 0.05 - 500;
        pos[3 * i + 2] = dv.getUint16(o + 2, true) * 0.1 - 3200;
        y0 = Math.min(y0, pos[3 * i + 1]); y1 = Math.max(y1, pos[3 * i + 1]);
        lamp[4 * i] = dv.getUint8(o + 7);                   // rank
        lamp[4 * i + 1] = dv.getUint8(o + 6) & 3;           // LED, minor road
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aLamp', new THREE.BufferAttribute(lamp, 4));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, (y0 + y1) / 2, 0), 4526 + (y1 - y0) / 2 + 20);
      const pts = new THREE.Points(g, this.lampMaterial);
      pts.name = `StreetLamps ${key}`;
      pts.position.set(-51200 + (ix + 0.5) * 6400, 0, -51200 + (iz + 0.5) * 6400);
      pts.matrixAutoUpdate = false;
      pts.updateMatrix();
      pts.renderOrder = 1;
      pts.visible = this.uniforms.uStreetOn.value > 0;
      this.group.add(pts);
      t.points = pts; t.n = n; t.state = 'ready';
      this.stats.lamps += n;
      this.stats.lampTiles++;
    }).catch(() => { t.state = 'failed'; });
  }

  _dropLamps(key, t) {
    if (t.points) {
      this.group.remove(t.points);
      t.points.geometry.dispose();
      this.stats.lamps -= t.n;
      this.stats.lampTiles--;
    }
    this._lampTiles.delete(key);
  }

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
    const env = this.env;
    const el = env.sunElevationDeg ?? 30;
    // on by the one schedule (js/env "Lights at night": env.lightsOn, from just before sunset);
    // the runway, approach and PAPI lights on a lower intensity step at night (ATC sets ~30 % on a
    // clear night: full brightness would dazzle), stepping down as the eye adapts (env.lightNight)
    const on = env.lightsOn ?? lightsOn(el);
    const step = 1 - 0.65 * (env.lightNight ?? lightNight(el));
    const U = this.uniforms;
    U.uOn.value.set(on * step, on * step, on, on);
    U.uPapiOn.value = step;
    // the threshold of a point light on the ground's luminance (albedo 0.15, a little city glow
    // at night): js/env "Lights at night"
    U.uThreshold.value = env.pointThreshold ?? pointLightThreshold(el);
    U.uExposure.value = this.renderer.toneMappingExposure || 1;
    // radians per pixel of the drawing buffer (device pixels: the pixel ratio is in it once)
    const cam = (f && f.camera) || this.camera;
    if (cam && cam.isPerspectiveCamera) {
      const hPx = this.renderer.getDrawingBufferSize(this._dbSize).y || 1;
      U.uPxAngle.value = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / (cam.zoom || 1) / hPx;
    }
    // street lamps with the road surfaces' switch and night adaptation (Roads.js)
    U.uStreetOn.value = this.roads ? this.roads._lightsOn || 0 : 0;
    U.uGain.value = this.roads && this.roads.sceneGain ? this.roads.sceneGain : 1 / 32000;
    U.uClock.value = (performance.now() - this._t0) / 1000;
    // the lamps only while they are on (by day their 200 k points would be drawn for nothing);
    // their tiles load from dusk
    const lampsOn = U.uStreetOn.value > 0;
    for (const t of this._lampTiles.values()) if (t.points) t.points.visible = lampsOn;
    if (cam && lampsOn) this._updateLamps(cam.getWorldPosition(this._camPos));
    this.group.visible = true;
  }

  dispose() {
    for (const [key, t] of [...this._lampTiles]) this._dropLamps(key, t);
    for (const o of [...this.group.children]) o.geometry.dispose();
    this.scene.remove(this.group);
    this.material.dispose();
    this.lampMaterial.dispose();
  }
}
