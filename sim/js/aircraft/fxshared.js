// Shared pieces of the aircraft effects (Vapor.js, TyreSmoke.js, LandingPool.js): the air the jet
// flies in (temperature, humidity, dew point), a tileable noise texture, the lighting of white
// vapour and smoke, and a camera-facing ribbon for trails.
//
// Air: a warm Levant day near the ground (ISA + 8 K, decaying with height) and ISA aloft; relative
// humidity ~65 % at sea level falling to ~10 % at altitude (coastal plain in summer). Condensation
// needs the local cooling of the air (expansion over the wing, in a vortex core, ahead of a shock)
// to exceed the dew-point depression; contrails need the ambient air colder than about -38 C
// (Schmidt-Appleman, for a high-bypass-ish exhaust; ~8-9 km here).

import * as THREE from 'three';

const CP = 1005;                       // J/(kg K)

/**
 * Where the lights, the burner and the effects read the scene's exposure when they are drawn
 * (three.js's toneMappingExposure). An HDR post chain that keeps its exposure elsewhere replaces get.
 */
export const fxExposure = { get: (renderer) => (renderer && renderer.toneMappingExposure) || 1 };

/** Ambient air at altitude h (m MSL): {T (K), Tc (C), rh (0..1), dewDep (K)}. */
export function air(h) {
  const hh = Math.max(-500, h);
  const T = Math.max(216.65, 288.15 - 0.0065 * Math.min(hh, 11000)) + 8 * Math.exp(-Math.max(0, hh) / 2000);
  const rh = Math.min(0.98, 0.10 + 0.55 * Math.exp(-Math.max(0, hh) / 2200));
  const Tc = T - 273.15;
  // Magnus formula for the dew point
  const a = 17.62, b = 243.12;
  const g = Math.log(rh) + a * Tc / (b + Tc);
  const Td = b * g / (a - g);
  return { T, Tc, rh, dewDep: Math.max(0, Tc - Td) };
}

/** Dynamic temperature V^2 / (2 cp) (K): the most the air can cool by speeding up to 2x... scale. */
export function dynTemp(V) { return V * V / (2 * CP); }

const smooth = THREE.MathUtils.smoothstep;

/**
 * Condensation amounts 0..1 for the jet's state (FlightModel state): wing upper-surface sheets,
 * vortex cores (wing tips and chines), the transonic cone, the engine contrail.
 *   CL from the load factor (n W / q S), the local cooling ~ dynTemp * k * CL.
 */
export function condensation(st, massKg = 22000) {
  const V = st.tas || 0, q = st.qbar || 0, M = st.mach || 0;
  const h = st.altitude || 0;
  const A = air(h);
  const n = Math.abs(st.gLoad || 1);
  const CL = q > 50 ? n * massKg * 9.81 / (q * 42.7) : 0;
  const Td = dynTemp(V);
  const dd = A.dewDep;
  const wing = smooth(Td * 0.55 * CL, dd + 0.5, dd + 6);
  const vortex = smooth(Td * 0.95 * CL, dd + 1, dd + 5);
  // vapour cone: expansion ahead of the shocks near Mach 1, in humid air
  const humid = 1 - smooth(dd, 4, 14);                 // dew-point depression 4 K: humid, 14 K: dry
  const cone = humid * smooth(M, 0.90, 0.955) * (1 - smooth(M, 1.01, 1.06)) * smooth(V, 250, 300);
  const contrail = (1 - smooth(A.Tc, -42, -34)) * (st.onGround ? 0 : 1);   // none above -34 C, full below -42 C
  return { wing, vortex, cone, contrail, air: A, CL };
}

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

/** Common output of the premultiplied-alpha effects: tone-map the colour, then weight by alpha. */
export const PREMULT_OUT_GLSL = /* glsl */`
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor = vec4(gl_FragColor.rgb * alpha, alpha);`;

const RIBBON_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec4 aData;        // x: across (-1..1), y: distance along (m), z: alpha, w: age (s)
  varying vec4 vData;
  varying vec3 vWorld;
  void main() {
    vData = aData;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }`;

const RIBBON_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uNoise;
  uniform float uNoiseScale;   // noise cycles per metre along the trail
  uniform float uSoft;         // edge softness exponent
  uniform float uAlbedo;
  ${VAPOUR_LIGHT_GLSL}
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
 *   push(p, time, amount)  every update: the head follows the source; a point is left behind every
 *                          `spacing` metres. amount 0..1 is the density there.
 *   build(time, camPos)    rebuilds the ribbon; returns whether anything is visible.
 * opts: {max points, spacing (m), life (s), width0 (m), growth (m/s), fadeIn (s), soft, noiseScale}
 */
export class Ribbon {
  constructor(opts) {
    this.o = Object.assign({ max: 64, spacing: 2, life: 0.5, width0: 0.2, growth: 0.5, fadeIn: 0, fadeOut: 0.4,
      soft: 1.5, noiseScale: 0.15, albedo: 0.9, renderOrder: 6, maxAlpha: 0.85 }, opts);
    const n = this.o.max;
    this.pts = [];                                     // {p, t, a}
    this.pos = new Float32Array(n * 2 * 3);
    this.data = new Float32Array(n * 2 * 4);
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aData', new THREE.BufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      name: 'F35_VapourTrail',
      uniforms: { ...fxLight.uniforms, uNoise: { value: noiseTexture() }, uNoiseScale: { value: this.o.noiseScale },
        uSoft: { value: this.o.soft }, uAlbedo: { value: this.o.albedo } },
      vertexShader: RIBBON_VERT, fragmentShader: RIBBON_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.NormalBlending, premultipliedAlpha: true, toneMapped: true,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = this.o.renderOrder;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;
  }

  clear() { this.pts.length = 0; this.mesh.visible = false; }

  push(p, time, amount) {
    const pts = this.pts;
    const head = pts[pts.length - 1];
    // odometer of the source: each point keeps its own (the noise stays put in the air)
    if (head) this.odo = ((this.odo || 0) + p.distanceTo(head.p)) % (1000 / this.o.noiseScale);
    if (head && head.head) {
      // the head follows the source; leave it behind once it is `spacing` from the last fixed point
      const prev = pts[pts.length - 2];
      head.p.copy(p); head.t = time; head.a = amount; head.s = this.odo || 0;
      if (!prev || prev.p.distanceTo(p) >= this.o.spacing) head.head = false;
      else return;
    }
    if (amount <= 0 && (!head || head.a <= 0)) return;
    pts.push({ p: p.clone(), t: time, a: amount, s: this.odo || 0, head: true });
    if (pts.length > this.o.max) pts.shift();
  }

  build(time, camPos) {
    const o = this.o, pts = this.pts;
    while (pts.length && time - pts[0].t > o.life) pts.shift();
    if (pts.length < 2 || !pts.some((x) => x.a > 0)) { this.mesh.visible = false; this.mesh.geometry.setDrawRange(0, 0); return false; }
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      // newest first in the buffer; noise along the trail from each point's odometer
      const k = n - 1 - i;
      const P = pts[k].p;
      const along = pts[k].s;
      const prev = pts[Math.max(0, k - 1)].p, next = pts[Math.min(n - 1, k + 1)].p;
      _t.subVectors(next, prev);
      if (_t.lengthSq() < 1e-8) _t.set(0, 0, 1);
      _e.subVectors(camPos, P);
      const dist = _e.length();
      _s.crossVectors(_t, _e);
      if (_s.lengthSq() < 1e-10) _s.set(0, 1, 0);
      _s.normalize();
      const age = Math.max(0, time - pts[k].t);
      const w = o.width0 + o.growth * age;
      _s.multiplyScalar(w / 2);
      _a.copy(P).add(_s);
      _b.copy(P).sub(_s);
      const j = i * 2;
      this.pos.set([_a.x, _a.y, _a.z, _b.x, _b.y, _b.z], j * 3);
      // alpha: density x fade in (contrail gap) x fade out x near-camera fade
      let al = pts[k].a * o.maxAlpha;
      if (o.fadeIn > 0) al *= smooth(age, o.fadeIn * 0.6, o.fadeIn * 1.4);
      al *= 1 - smooth(age, o.life * (1 - o.fadeOut), o.life);
      al *= smooth(dist, 1.5 * w, 4 * w + 2);
      this.data.set([-1, along, al, age, 1, along, al, age], j * 4);
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
