// Tyre smoke: puffs of burnt rubber when a wheel touches down at speed (the tyre spins up from rest
// within a few metres and scrubs). Each touchdown of a wheel (FlightModel state.wheels[].wow going
// true above ~25 m/s ground speed) emits a burst of particles along the wheel's path; they stay in
// the air where they were made (world frame), drift a little with the jet's wake, rise, grow from
// ~0.6 m to ~4 m and fade over ~3 s. One THREE.Points draw, animated on the GPU from the birth time
// (sim clock, so paused or settled frames keep their smoke), lit like the vapour (fxshared) and
// faded by the scene's fog like everything else. Emitting allocates nothing.

import * as THREE from 'three';
import { noiseTexture, fxLight, fogUniforms, VAPOUR_LIGHT_GLSL, FOG_PARS_GLSL, PREMULT_OUT_GLSL } from './fxshared.js';

const SMOKE_VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 aVel;         // initial velocity (m/s, world)
  attribute vec4 aInfo;        // birth time (s), density 0..1, seed, start size (m)
  uniform float uTime;
  uniform float uProj;         // px per (m / m): drawing-buffer height / (2 tan(fov / 2))
  varying float vAlpha;
  varying float vSeed;
  varying vec3 vWorld;
  void main() {
    float age = uTime - aInfo.x;
    vSeed = aInfo.z;
    if (age < 0.0 || age > 4.5 || aInfo.y <= 0.0) {
      vAlpha = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 1.0;
      return;
    }
    float tau = 0.6;
    vec3 p = position + aVel * tau * (1.0 - exp(-age / tau)) + vec3(0.0, 0.35 * age, 0.0);
    float size = aInfo.w + 2.4 * (1.0 - exp(-age / 0.8)) + 0.35 * age;
    vWorld = p;
    vec4 mvPosition = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    float dist = max(-mvPosition.z, 0.1);
    gl_PointSize = min(size * uProj / dist, 1000.0);
    vAlpha = aInfo.y * 0.6 * exp(-age / 1.1) * smoothstep(0.0, 0.05, age) * smoothstep(0.5 * size, 1.5 * size, dist);
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }`;

const SMOKE_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uNoise;
  ${VAPOUR_LIGHT_GLSL}
  ${FOG_PARS_GLSL}
  varying float vAlpha;
  varying float vSeed;
  varying vec3 vWorld;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c) * 2.0;
    if (r > 1.0 || vAlpha <= 0.0) discard;
    float n = texture2D(uNoise, c * 0.9 + vec2(vSeed, vSeed * 1.7)).r;
    float d = pow(1.0 - r * r, 1.5) * smoothstep(0.2, 0.7, n + 0.35 * (1.0 - r));
    float alpha = clamp(vAlpha * d, 0.0, 0.9);
    if (alpha < 0.003) discard;
    vec3 col = vapourLight(normalize(cameraPosition - vWorld), 0.55);
    ${PREMULT_OUT_GLSL}
  }`;

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();

/** Pseudo-random -1..1 for particle k and channel x (a hash: no state, no allocation). */
function hash(k, x) { return (Math.sin(k * 12.9898 + x * 78.233) * 43758.5453) % 1; }

export class TyreSmoke {
  /** @param {THREE.Object3D} world  a group in the scene at the world origin */
  constructor(world, { max = 160 } = {}) {
    this.world = world;
    this.max = max;
    this.next = 0;
    this.perWheel = 20;
    const geo = new THREE.BufferGeometry();
    this._pos = new Float32Array(max * 3);
    this._vel = new Float32Array(max * 3);
    this._info = new Float32Array(max * 4);
    geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
    geo.setAttribute('aVel', new THREE.BufferAttribute(this._vel, 3));
    geo.setAttribute('aInfo', new THREE.BufferAttribute(this._info, 4));
    this.uniforms = { ...fxLight.uniforms, ...fogUniforms(), uNoise: { value: noiseTexture() }, uTime: { value: 0 }, uProj: { value: 500 } };
    this.material = new THREE.ShaderMaterial({
      name: 'F35_TyreSmoke', uniforms: this.uniforms, vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending, premultipliedAlpha: true, toneMapped: true,
      fog: true,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'TyreSmoke';
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.points.visible = false;
    this.points.onBeforeRender = (renderer, scene, camera) => {
      const h = renderer.getDrawingBufferSize(_v).y;
      const fov = camera.isPerspectiveCamera ? THREE.MathUtils.degToRad(camera.fov) : 1;
      this.uniforms.uProj.value = h / (2 * Math.tan(fov / 2));
    };
    world.add(this.points);
    this._wow = {};
    this._last = -1e9;                 // sim time of the last emission
  }

  reset(st) {
    this._info.fill(0);
    this.points.geometry.attributes.aInfo.needsUpdate = true;
    this.points.visible = false;
    this._wow = {};
    this._last = -1e9;
    if (st && st.wheels) for (const w of st.wheels) this._wow[w.name] = !!w.wow;
  }

  /** A burst along the wheel's path: n puffs 12.5 ms apart from contact point p (world), velocity vel. */
  emit(p, vel, t, density, n) {
    for (let i = 0; i < n; i++) {
      const k = this.next;
      this.next = (this.next + 1) % this.max;
      const dt = i * 0.0125;
      this._pos[k * 3] = p.x + vel.x * dt + hash(k, 1) * 0.3;
      this._pos[k * 3 + 1] = p.y + 0.25;
      this._pos[k * 3 + 2] = p.z + vel.z * dt + hash(k, 2) * 0.3;
      // smoke left on the runway, dragged a little by the wake, spread sideways and up
      this._vel[k * 3] = vel.x * 0.12 + hash(k, 3) * 2.0;
      this._vel[k * 3 + 1] = 0.6 + Math.abs(hash(k, 4)) * 1.0;
      this._vel[k * 3 + 2] = vel.z * 0.12 + hash(k, 5) * 2.0;
      const q = k * 4;
      this._info[q] = t + dt;
      this._info[q + 1] = density * (1 - 0.6 * i / n);
      this._info[q + 2] = Math.abs(hash(k, 6)) * 10;
      this._info[q + 3] = 0.9 + Math.abs(hash(k, 7)) * 0.5;
    }
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = true;
    a.aVel.needsUpdate = true;
    a.aInfo.needsUpdate = true;
    this._last = t;
  }

  /**
   * @param {object} st   FlightModel state
   * @param {import('./AircraftVisual.js').AircraftVisual} visual   (gear contact points)
   */
  update(st, visual) {
    const t = st.time || 0;
    const wheels = st.wheels || [];
    const gs = st.groundSpeed || 0;
    const contacts = (visual.info && visual.info.gearContacts) || [];
    for (const w of wheels) {
      const was = this._wow[w.name];
      this._wow[w.name] = !!w.wow;
      if (was !== false || !w.wow || gs < 25) continue;
      let g = null;
      for (const x of contacts) if (x.name === w.name) g = x;
      if (!g) continue;
      _p.set(g.pos[0], g.pos[1], g.pos[2]);
      visual.object3d.localToWorld(_p);
      const vel = st.velocity ? _v.set(st.velocity.x ?? st.velocity[0], 0, st.velocity.z ?? st.velocity[2]) : _v.set(0, 0, 0);
      // more rubber the faster the wheel has to spin up and the harder it lands
      const sink = st.lastTouchdown && Number.isFinite(st.lastTouchdown.sink) ? Math.abs(st.lastTouchdown.sink) : 1;
      const density = Math.min(1, (gs / 70) ** 2 * (0.7 + 0.3 * Math.min(1, sink / 2))) * (w.name === 'nose' ? 0.45 : 1);
      this.emit(_p, vel, t, density, w.name === 'nose' ? Math.ceil(this.perWheel / 2) : this.perWheel);
    }
    this.uniforms.uTime.value = t;
    this.points.visible = t - this._last < 5;
  }

  /** The meshes with shader programs of their own (AircraftFX compiles them before first use). */
  effectMeshes() { return [this.points]; }

  dispose() {
    this.world.remove(this.points);
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
