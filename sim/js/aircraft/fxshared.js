// Shared pieces of the aircraft effects (Vapor.js, TyreSmoke.js, LandingPool.js, and the lights and
// the burner on the jet itself): the scene's light level (fxEnv: day / night from the sun, the
// exposure), the air the jet flies in (temperature, humidity, dew point), a tileable noise texture,
// the lighting of white vapour and smoke, three's fog for effects drawn premultiplied or additive,
// and a camera-facing ribbon for trails.
//
// Air: a warm Levant day near the ground (ISA + 8 K, decaying with height) and ISA aloft; relative
// humidity ~65 % at sea level falling to ~10 % at altitude (coastal plain in summer). Condensation
// needs the local cooling of the air (expansion over the wing, in a vortex core, ahead of a shock)
// to exceed the dew-point depression; contrails need the ambient air colder than about -38 C
// (Schmidt-Appleman, for a high-bypass-ish exhaust; ~8-9 km here).
//
// Nothing here allocates per frame: air() and condensation() fill an `out` object when given one,
// the ribbon keeps its points in a preallocated ring and writes the vertex arrays in place.

import * as THREE from 'three';

const CP = 1005;                       // J/(kg K)
const smooth = THREE.MathUtils.smoothstep;

// ------------------------------------------------------------------------- light level, exposure
/**
 * Where the lights, the burner and the effects read the scene's exposure when they are drawn
 * (three.js's toneMappingExposure; the HDR chain of the lighting track sets it too). An exposure
 * kept elsewhere replaces get. Used for brightness only, never for day / night decisions (fxEnv).
 */
export const fxExposure = { get: (renderer) => (renderer && renderer.toneMappingExposure) || 1 };

/**
 * log10 of the illuminance (lux) on level ground under a clear, moonless sky by the sun's elevation
 * (deg), after the standard twilight tables (e.g. the Explanatory Supplement to the Astronomical
 * Almanac): ~120 klx with the sun high, ~400 lx at sunset, ~3 lx at the end of civil twilight
 * (-6 deg), ~0.01 lx at the end of nautical twilight (-12 deg), ~0.001 lx (starlight and airglow)
 * below -18 deg.
 */
const SKY_LUX = [[-18, -3.0], [-15, -2.6], [-12, -2.0], [-10, -1.4], [-8, -0.6], [-6, 0.5], [-4, 1.3],
  [-2, 2.0], [-1, 2.3], [0, 2.6], [1, 2.95], [2, 3.25], [5, 3.75], [10, 4.15], [20, 4.55], [30, 4.8],
  [60, 5.03], [90, 5.1]];

/** log10(lux) of a clear, moonless sky's light on the ground for the sun's elevation (deg). */
export function skyLogLux(elevationDeg) {
  const e = Number.isFinite(elevationDeg) ? elevationDeg : 45;
  if (e <= SKY_LUX[0][0]) return SKY_LUX[0][1];
  for (let i = 1; i < SKY_LUX.length; i++) {
    const [e1, l1] = SKY_LUX[i];
    if (e <= e1) {
      const [e0, l0] = SKY_LUX[i - 1];
      return l0 + (l1 - l0) * (e - e0) / (e1 - e0);
    }
  }
  return SKY_LUX[SKY_LUX.length - 1][1];
}

/** Darkness 0..1 for a light level: 0 above ~1000 lx (sun above ~+1 deg), 1 below ~3 lx (~-6 deg). */
export function darknessOf(logLux) {
  return 1 - smooth(logLux, 0.5, 3.0);
}

/**
 * The scene's light level, for every day / night decision of the effects (the burner's day look,
 * the glare round the lights, the landing light pool's visibility): from the sun's elevation, not
 * from the exposure, so the switches happen at the same sun elevation whatever exposure meter the
 * Environment uses (main's reads 12.7 with the sun 1.6 deg up, the HDR chain's about 4).
 *   update(env)      every frame (AircraftFX does it; env.sunElevationDeg or env.sunDirection)
 *   darkness         0 by day .. 1 from the end of civil twilight (darknessOf)
 *   logLux           log10 of the sky's light on the ground (skyLogLux)
 *   noonExposure     the exposure meter's value at noon: the burner's and the lights' display
 *                    brightness is normalised to it (main's meter and the HDR chain's: 0.93)
 *   bloom            null: an HDR target (float) is taken to mean the HDR chain with its bloom; true /
 *                    false force it. With bloom the lights draw a fainter glare halo of their own.
 */
export const fxEnv = {
  sunElevationDeg: 45,
  logLux: skyLogLux(45),
  darkness: 0,
  noonExposure: 0.93,
  bloom: null,
  update(env) {
    let el = env && Number.isFinite(env.sunElevationDeg) ? env.sunElevationDeg : null;
    if (el === null && env && env.sunDirection) el = THREE.MathUtils.radToDeg(Math.asin(Math.max(-1, Math.min(1, env.sunDirection.y))));
    if (el === null) return;
    this.sunElevationDeg = el;
    this.logLux = skyLogLux(el);
    this.darkness = darknessOf(this.logLux);
  },
  /** Whether the frame being drawn goes through the HDR chain's bloom (see bloom above). */
  bloomOn(renderer) {
    if (this.bloom !== null) return !!this.bloom;
    const rt = renderer && renderer.getRenderTarget ? renderer.getRenderTarget() : null;
    return !!(rt && rt.texture && rt.texture.type !== THREE.UnsignedByteType);
  },
  /** Whether the frame is drawn into a linear float target (the HDR chain) rather than the 8-bit canvas. */
  linearTarget(renderer) {
    const rt = renderer && renderer.getRenderTarget ? renderer.getRenderTarget() : null;
    return !!(rt && rt.texture && rt.texture.type !== THREE.UnsignedByteType);
  },
};

// ------------------------------------------------------------------------------------------ air
/** Ambient air at altitude h (m MSL): {T (K), Tc (C), rh (0..1), dewDep (K)} (into out if given). */
export function air(h, out = {}) {
  const hh = Math.max(-500, h);
  const T = Math.max(216.65, 288.15 - 0.0065 * Math.min(hh, 11000)) + 8 * Math.exp(-Math.max(0, hh) / 2000);
  const rh = Math.min(0.98, 0.10 + 0.55 * Math.exp(-Math.max(0, hh) / 2200));
  const Tc = T - 273.15;
  // Magnus formula for the dew point
  const a = 17.62, b = 243.12;
  const g = Math.log(rh) + a * Tc / (b + Tc);
  const Td = b * g / (a - g);
  out.T = T; out.Tc = Tc; out.rh = rh; out.dewDep = Math.max(0, Tc - Td);
  return out;
}

/** Dynamic temperature V^2 / (2 cp) (K): the most the air can cool by speeding up to 2x... scale. */
export function dynTemp(V) { return V * V / (2 * CP); }

/**
 * Condensation amounts 0..1 for the jet's state (FlightModel state): wing upper-surface sheets,
 * vortex cores (wing tips and chines), the transonic cone, the engine contrail.
 *   CL from the load factor (n W / q S), the local cooling ~ dynTemp * k * CL.
 * out (optional, reused every frame): {wing, vortex, cone, contrail, air, CL}.
 */
export function condensation(st, massKg = 22000, out = null) {
  const o = out || { air: {} };
  const V = st.tas || 0, q = st.qbar || 0, M = st.mach || 0;
  const h = st.altitude || 0;
  const A = air(h, o.air || (o.air = {}));
  const n = Math.abs(st.gLoad || 1);
  const CL = q > 50 ? n * massKg * 9.81 / (q * 42.7) : 0;
  const Td = dynTemp(V);
  const dd = A.dewDep;
  o.wing = smooth(Td * 0.55 * CL, dd + 0.5, dd + 6);
  o.vortex = smooth(Td * 0.95 * CL, dd + 1, dd + 5);
  // vapour cone: expansion ahead of the shocks near Mach 1, in humid air
  const humid = 1 - smooth(dd, 4, 14);                 // dew-point depression 4 K: humid, 14 K: dry
  o.cone = humid * smooth(M, 0.90, 0.955) * (1 - smooth(M, 1.01, 1.06)) * smooth(V, 250, 300);
  o.contrail = (1 - smooth(A.Tc, -42, -34)) * (st.onGround ? 0 : 1);   // none above -34 C, full below -42 C
  o.CL = CL;
  return o;
}

// ---------------------------------------------------------------------------------------- noise
let noiseTex = null;
/** A 128^2 tileable fbm value-noise texture (R: fbm, G: a second octave set), repeat wrap. */
export function noiseTexture() {
  if (noiseTex) return noiseTex;
  const N = 128;
  const rnd = (i, j, s) => {
    let x = Math.sin((i % 64) * 127.1 + (j % 64) * 311.7 + s * 74.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const vnoise = (x, y, period, s) => {
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const p = (a) => ((a % period) + period) % period;
    const a = rnd(p(i), p(j), s), b = rnd(p(i + 1), p(j), s), c = rnd(p(i), p(j + 1), s), d = rnd(p(i + 1), p(j + 1), s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let f1 = 0, f2 = 0, amp = 0.5, tot = 0;
      for (let o = 0; o < 5; o++) {
        const per = 4 << o;
        const sc = per / N;
        f1 += amp * vnoise(x * sc, y * sc, per, 1);
        f2 += amp * vnoise(x * sc, y * sc, per, 7);
        tot += amp;
        amp *= 0.5;
      }
      const i = (y * N + x) * 4;
      data[i] = Math.round(255 * f1 / tot);
      data[i + 1] = Math.round(255 * f2 / tot);
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  noiseTex = new THREE.DataTexture(data, N, N);
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.magFilter = THREE.LinearFilter;
  noiseTex.minFilter = THREE.LinearMipmapLinearFilter;
  noiseTex.generateMipmaps = true;
  noiseTex.needsUpdate = true;
  return noiseTex;
}

// ------------------------------------------------------------------------------------- lighting
/** Lighting uniforms shared by the vapour / smoke materials (update with fxLight.update(env)). */
export const fxLight = {
  uniforms: {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(3, 3, 3) },      // irradiance (scene units)
    uAmbient: { value: new THREE.Color(0.6, 0.7, 0.9) }, // sky irradiance (scene units)
  },
  /** Copy the sun and sky from the Environment (sim/js/env/Environment.js; fallbacks if renamed). */
  update(env, sunDirection) {
    const u = this.uniforms;
    if (sunDirection) u.uSunDir.value.copy(sunDirection).normalize();
    if (env && env.sunLight) u.uSunColor.value.copy(env.sunLight.color).multiplyScalar(env.sunLight.intensity ?? 1);
    if (env && env.uniforms && env.uniforms.uAmbient) u.uAmbient.value.copy(env.uniforms.uAmbient.value);
    else if (env && env.hemiLight) u.uAmbient.value.copy(env.hemiLight.color).multiplyScalar(1 / (env.hemiFraction || 0.15));
  },
};

/** GLSL: radiance of white droplets (albedo a) lit by the sun and the sky, view vector V (to the eye). */
export const VAPOUR_LIGHT_GLSL = /* glsl */`
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  vec3 vapourLight(vec3 V, float albedo) {
    // strongly forward-scattering droplets: brighter looking towards the sun
    float c = max(0.0, dot(-V, uSunDir));
    float phase = 0.7 + 2.2 * pow(c, 6.0) + 0.6 * pow(c, 40.0);
    return albedo / PI * (uSunColor * phase + uAmbient);
  }`;

// ------------------------------------------------------------------------------------------ fog
/**
 * three's fog for the effects (fog: true on the material, fogUniforms() in its uniforms, the
 * fog_pars_vertex / fog_vertex chunks in its vertex shader and FOG_PARS_GLSL in its fragment
 * shader), so the plume, the vapour, the light glows and the pool fade with distance exactly as
 * the jet's own materials do: an effect's light dims with the fog's transmittance, and what it
 * hides (its alpha) takes the fog colour. Applied after the colour-space chunk, as three does.
 */
export function fogUniforms() { return THREE.UniformsUtils.clone(THREE.UniformsLib.fog); }

export const FOG_PARS_GLSL = /* glsl */`
  #include <fog_pars_fragment>
  // premultiplied colour (cover = its alpha) or additive light (cover = 0) seen through the fog
  vec3 fxFog(vec3 rgb, float cover) {
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float f = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        float f = smoothstep(fogNear, fogFar, vFogDepth);
      #endif
      return mix(rgb, fogColor * cover, f);
    #else
      return rgb;
    #endif
  }`;

/** Common output of the premultiplied-alpha effects: tone-map the colour, weight by alpha, fog. */
export const PREMULT_OUT_GLSL = /* glsl */`
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor = vec4(fxFog(gl_FragColor.rgb * alpha, alpha), alpha);`;

// --------------------------------------------------------------------------------------- ribbon
const RIBBON_VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  attribute vec4 aData;        // x: across (-1..1), y: distance along (m), z: alpha, w: age (s)
  varying vec4 vData;
  varying vec3 vWorld;
  void main() {
    vData = aData;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }`;

const RIBBON_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uNoise;
  uniform float uNoiseScale;   // noise cycles per metre along the trail
  uniform float uSoft;         // edge softness exponent
  uniform float uAlbedo;
  ${VAPOUR_LIGHT_GLSL}
  ${FOG_PARS_GLSL}
  varying vec4 vData;
  varying vec3 vWorld;
  void main() {
    #include <logdepthbuf_fragment>
    float u = vData.x;
    float edge = pow(max(0.0, 1.0 - u * u), uSoft);
    vec2 nuv = vec2(vData.y * uNoiseScale, u * 0.25 + vData.w * 0.15);
    float n = texture2D(uNoise, nuv).r * 0.7 + texture2D(uNoise, nuv * 2.7 + 0.31).g * 0.3;
    float alpha = clamp(vData.z * edge * smoothstep(0.25, 0.75, n) * 1.6, 0.0, 1.0);
    if (alpha < 0.003) discard;
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 col = vapourLight(V, uAlbedo);
    ${PREMULT_OUT_GLSL}
  }`;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _t = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Vector3();

/**
 * A trail of points left in the air (world frame), drawn as a camera-facing ribbon.
 *   push(p, time, amount, speed)  every update: the head follows the source; a point is left behind
 *                                 every `spacing` metres. amount 0..1 is the density there. With the
 *                                 source's speed (m/s) the spacing grows so that `max` points always
 *                                 cover the whole `life` (a contrail must not run out of points and
 *                                 end bluntly half way through its fade).
 *   build(time, camPos)           rebuilds the ribbon; returns whether anything is visible.
 * opts: {max points, spacing (m, the least), life (s), width0 (m), growth (m/s), fadeIn (s),
 *        fadeOut (fraction of the life), soft, noiseScale, albedo, maxAlpha}
 * The points live in a preallocated ring (oldest at _start); the vertex arrays are written in place.
 */
export class Ribbon {
  constructor(opts) {
    this.o = Object.assign({ max: 64, spacing: 2, life: 0.5, width0: 0.2, growth: 0.5, fadeIn: 0, fadeOut: 0.4,
      soft: 1.5, noiseScale: 0.15, albedo: 0.9, renderOrder: 6, maxAlpha: 0.85 }, opts);
    const n = this.o.max;
    this._p = Array.from({ length: n }, () => new THREE.Vector3());
    this._time = new Float64Array(n);
    this._amt = new Float32Array(n);
    this._odo = new Float32Array(n);
    this._start = 0;
    this.count = 0;
    this._head = false;                 // the newest point still follows the source
    this.odo = 0;                       // odometer of the source (m): the noise stays put in the air
    this.spacing = this.o.spacing;
    this.pos = new Float32Array(n * 2 * 3);
    this.data = new Float32Array(n * 2 * 4);
    const idx = new Uint16Array(Math.max(0, n - 1) * 6);
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aData', new THREE.BufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      name: 'F35_VapourTrail',
      uniforms: { ...fxLight.uniforms, ...fogUniforms(), uNoise: { value: noiseTexture() },
        uNoiseScale: { value: this.o.noiseScale }, uSoft: { value: this.o.soft }, uAlbedo: { value: this.o.albedo } },
      vertexShader: RIBBON_VERT, fragmentShader: RIBBON_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
      blending: THREE.NormalBlending, premultipliedAlpha: true, toneMapped: true,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = this.o.name || 'VapourTrail';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = this.o.renderOrder;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;
  }

  /** Ring slot of point k (0 = the oldest). */
  _slot(k) { return (this._start + k) % this.o.max; }

  clear() { this._start = 0; this.count = 0; this._head = false; this.mesh.visible = false; }

  push(p, time, amount, speed = 0) {
    const o = this.o, n = this.count;
    this.spacing = Math.max(o.spacing, speed * o.life / Math.max(1, o.max - 2));
    if (n) {
      const hi = this._slot(n - 1);
      const head = this._p[hi];
      this.odo = (this.odo + p.distanceTo(head)) % (1000 / o.noiseScale);
      if (this._head) {
        // the head follows the source; it is left behind once `spacing` from the last fixed point
        head.copy(p); this._time[hi] = time; this._amt[hi] = amount; this._odo[hi] = this.odo;
        if (n > 1 && this._p[this._slot(n - 2)].distanceTo(p) < this.spacing) return;
        this._head = false;
      }
      if (amount <= 0 && this._amt[hi] <= 0) return;
    } else if (amount <= 0) return;
    if (this.count === o.max) { this._start = (this._start + 1) % o.max; this.count--; }
    const k = this._slot(this.count);
    this._p[k].copy(p); this._time[k] = time; this._amt[k] = amount; this._odo[k] = this.odo;
    this.count++;
    this._head = true;
  }

  /**
   * Alpha of point k (0 = the oldest) at `time`, before the near-camera fade: density x fade in
   * (the contrail's gap) x fade out over the end of the life x a fade over the oldest few points
   * while the ring is full (should the spacing still be too short, they are gone before they drop).
   */
  alphaAt(k, time) {
    const o = this.o, s = this._slot(k);
    const age = Math.max(0, time - this._time[s]);
    let al = this._amt[s] * o.maxAlpha;
    if (o.fadeIn > 0) al *= smooth(age, o.fadeIn * 0.6, o.fadeIn * 1.4);
    al *= 1 - smooth(age, o.life * (1 - o.fadeOut), o.life);
    const full = smooth(this.count, o.max - 10, o.max - 1);
    if (full > 0) al *= 1 - full * (1 - smooth(k, 0, 8));
    return al;
  }

  /** The points, oldest first ({p, t}; allocates: for tests and tools). */
  points() {
    const out = [];
    for (let k = 0; k < this.count; k++) out.push({ p: this._p[this._slot(k)], t: this._time[this._slot(k)] });
    return out;
  }

  build(time, camPos) {
    const o = this.o;
    while (this.count && time - this._time[this._start] > o.life) { this._start = (this._start + 1) % o.max; this.count--; }
    const n = this.count;
    let any = false;
    for (let k = 0; k < n && !any; k++) any = this._amt[this._slot(k)] > 0;
    if (n < 2 || !any) { this.mesh.visible = false; this.mesh.geometry.setDrawRange(0, 0); return false; }
    const pos = this.pos, data = this.data;
    for (let i = 0; i < n; i++) {
      // newest first in the buffer; noise along the trail from each point's odometer
      const k = n - 1 - i;
      const s = this._slot(k);
      const P = this._p[s];
      const prev = this._p[this._slot(k > 0 ? k - 1 : 0)], next = this._p[this._slot(k < n - 1 ? k + 1 : n - 1)];
      _t.subVectors(next, prev);
      if (_t.lengthSq() < 1e-8) _t.set(0, 0, 1);
      _e.subVectors(camPos, P);
      const dist = _e.length();
      _s.crossVectors(_t, _e);
      if (_s.lengthSq() < 1e-10) _s.set(0, 1, 0);
      _s.normalize();
      const age = Math.max(0, time - this._time[s]);
      const w = o.width0 + o.growth * age;
      _s.multiplyScalar(w / 2);
      _a.copy(P).add(_s);
      _b.copy(P).sub(_s);
      const j = i * 6;
      pos[j] = _a.x; pos[j + 1] = _a.y; pos[j + 2] = _a.z;
      pos[j + 3] = _b.x; pos[j + 4] = _b.y; pos[j + 5] = _b.z;
      // alpha (see alphaAt) x a fade close to the camera
      const al = this.alphaAt(k, time) * smooth(dist, 1.5 * w, 4 * w + 2);
      const along = this._odo[s];
      const d = i * 8;
      data[d] = -1; data[d + 1] = along; data[d + 2] = al; data[d + 3] = age;
      data[d + 4] = 1; data[d + 5] = along; data[d + 6] = al; data[d + 7] = age;
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aData.needsUpdate = true;
    g.setDrawRange(0, (n - 1) * 6);
    this.mesh.visible = true;
    return true;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}
