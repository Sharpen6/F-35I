// The landing / taxi light's pool on the ground. The terrain's shaders ignore three.js lights, so the
// pool is drawn on its own: a grid that follows the terrain (Terrain.heightAt) ahead of the lamp,
// which MULTIPLIES the ground already drawn (blend dst * (1 + src)), so the runway's paint stays
// brighter than its asphalt inside the pool, as under a real lamp. Per fragment:
//     E_lamp = sum over the beams of I(theta) cos(incidence) / r^2          (lights.js beams)
//     E_amb  = the sky's and the sun's light on level ground                 (fxshared fxLight)
//     ground = albedo (E_amb + E_lamp) / pi = what is drawn there x (1 + E_lamp / E_amb)
// per colour channel, so the lamp's warm white replaces the bluish twilight in the pool. By day and
// at sunset that ratio is all there is (a 400,000 cd lamp is ~430 lx 10 m ahead, a sunset sky ~400 lx:
// a faint brightening near the nose wheel). In the dark the sim's exposure stops far short of a
// dark-adapted eye, so the ratio gets a visibility gain (poolGain, from the light level fxEnv, not the
// exposure: it rises from ~3 deg below the horizon) and a logarithmic roll-off (POOL_KNEE), so the
// pool reads as a lit runway that fades out along the beam instead of a flat white wedge.
//
// The factor goes to the target in POOL_PASSES draws of the same grid, each multiplying by the
// factor's N-th root: an 8-bit canvas clamps a blend source at 1 (at most x2 per draw); a float
// target (the HDR chain) takes it whole. On the canvas the factor applies to sRGB-encoded values
// (x F^(1/2.2)), on a linear target to linear ones. Fog dims the factor with distance.
//
// The beams (world position, directions, intensities, spreads) are also published on
// visual.lights.landing for a terrain or roads shader that wants to light itself.

import * as THREE from 'three';
import { fxEnv, fxLight, fogUniforms } from './fxshared.js';

/**
 * Visibility gain of the pool for the sky's light level (log10 lux, fxEnv.logLux): 1 down to ~30 lx
 * (the sun ~3 deg below the horizon: physics only), up to POOL_GAIN once the sky is dark (~0.1 lx).
 */
export const POOL_GAIN = 300;
export function poolGain(logLux) {
  return 1 + (POOL_GAIN - 1) * (1 - THREE.MathUtils.smoothstep(logLux, -1.0, 1.5));
}
/**
 * Log roll-off of the brightening: F = 1 + K ln(1 + gain * E_lamp / E_amb / K), on the luminance of
 * the ratio (the shader scales the colour channels' brightening in proportion).
 */
export const POOL_KNEE = 40;
export function poolFactor(ratio, logLux) {
  return 1 + POOL_KNEE * Math.log(1 + poolGain(logLux) * Math.max(0, ratio) / POOL_KNEE);
}
/** Draws of the grid (each multiplies by the factor's N-th root, see the header). */
export const POOL_PASSES = 3;

const CD = 1 / 30000;
const NX = 17, NZ = 33;
const NEAR = 2.5, FAR = 320;           // m along the ground ahead of the lamp

const POOL_VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  attribute vec2 aGrid;        // across -1..1, along 0..1 (the grid's own coordinates)
  varying vec3 vWorld;
  varying vec2 vGrid;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vGrid = aGrid;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }`;

const POOL_FRAG = /* glsl */`
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uLamp;          // lamp position (world)
  uniform vec3 uBeamA;         // landing beam axis (world, unit)
  uniform vec3 uBeamB;         // taxi beam axis
  uniform vec4 uBeams;         // peak intensities (scene units, x weight), 1/e half widths (rad)
  uniform vec3 uLampColour;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform float uGain;         // visibility gain (poolGain)
  uniform float uKnee;         // POOL_KNEE
  uniform float uPow;          // exponent of the factor per draw: (1 / 2.2 on the canvas) / passes
  varying vec3 vWorld;
  varying vec2 vGrid;
  float beam(vec3 L, float r, vec3 axis, float I0, float spread) {
    float th = acos(clamp(dot(L / r, axis), -1.0, 1.0)) / spread;
    return I0 * exp(-th * th);
  }
  void main() {
    #include <logdepthbuf_fragment>
    vec3 L = vWorld - uLamp;
    float r2 = max(dot(L, L), 0.25);
    float r = sqrt(r2);
    float cosInc = max(0.0, -L.y / r);
    float E = (beam(L, r, uBeamA, uBeams.x, uBeams.z) + beam(L, r, uBeamB, uBeams.y, uBeams.w)) * cosInc / r2;
    // the lamp against the light already on the ground (per channel), rolled off logarithmically on
    // its brightness with the channels kept in proportion: the lamp's warm white wins over the bluish
    // night ground as it would (a roll-off per channel would squash the channels together, blue pool)
    vec3 Eamb = max(uAmbient + uSunColor * max(uSunDir.y, 0.0), vec3(1e-7));
    vec3 ratio = uGain * E * uLampColour / Eamb;
    float ry = max(dot(ratio, vec3(0.2126, 0.7152, 0.0722)), 1e-6);
    vec3 F = 1.0 + ratio * (uKnee * log(1.0 + ry / uKnee) / ry);
    // nothing reaches the grid's edges (no visible border whatever the beam does)
    float edge = (1.0 - smoothstep(0.7, 1.0, abs(vGrid.x))) * smoothstep(0.0, 0.08, vGrid.y)
      * (1.0 - smoothstep(0.8, 1.0, vGrid.y));
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        edge *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        edge *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
      #endif
    #endif
    vec3 f = pow(1.0 + (F - 1.0) * edge, vec3(uPow)) - 1.0;
    if (max(f.r, max(f.g, f.b)) < 1e-3) discard;
    gl_FragColor = vec4(f, 0.0);
  }`;

const _d = new THREE.Vector3();
const _s = new THREE.Vector3();

export class LandingPool {
  /**
   * @param {THREE.Object3D} world  a group in the scene at the world origin
   * @param {object} terrain        heightAt(x, z)
   */
  constructor(world, terrain) {
    this.world = world;
    this.terrain = terrain;
    this.enabled = true;
    const geo = new THREE.BufferGeometry();
    this._pos = new Float32Array(NX * NZ * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3).setUsage(THREE.DynamicDrawUsage));
    const grid = new Float32Array(NX * NZ * 2);
    for (let j = 0, k = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) { grid[k++] = (i / (NX - 1)) * 2 - 1; grid[k++] = j / (NZ - 1); }
    }
    geo.setAttribute('aGrid', new THREE.BufferAttribute(grid, 2));
    const idx = [];
    for (let j = 0; j < NZ - 1; j++) {
      for (let i = 0; i < NX - 1; i++) {
        const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1;
        idx.push(a, b, c, b, d, c);                   // facing up (+Y)
      }
    }
    geo.setIndex(idx);
    this.uniforms = {
      ...fogUniforms(),
      uSunDir: fxLight.uniforms.uSunDir, uSunColor: fxLight.uniforms.uSunColor, uAmbient: fxLight.uniforms.uAmbient,
      uLamp: { value: new THREE.Vector3() }, uBeamA: { value: new THREE.Vector3(0, 0, -1) },
      uBeamB: { value: new THREE.Vector3(0, 0, -1) }, uBeams: { value: new THREE.Vector4(400000 * CD, 0, 0.15, 0.2) },
      uLampColour: { value: new THREE.Color(1.0, 0.95, 0.86) },
      uGain: { value: 1 }, uKnee: { value: POOL_KNEE }, uPow: { value: 1 / 2.2 / POOL_PASSES },
    };
    // dst * (1 + src): the ground already drawn, brightened (alpha untouched)
    this.material = new THREE.ShaderMaterial({
      name: 'F35_LandingPool', uniforms: this.uniforms, vertexShader: POOL_VERT, fragmentShader: POOL_FRAG,
      transparent: true, depthWrite: false, toneMapped: false, fog: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.passes = [];
    for (let i = 0; i < POOL_PASSES; i++) {
      const m = new THREE.Mesh(geo, this.material);
      m.name = `LandingLightPool${i}`;
      m.frustumCulled = false;
      m.renderOrder = 1;
      m.visible = false;
      m.matrixAutoUpdate = false;
      world.add(m);
      this.passes.push(m);
    }
    this.mesh = this.passes[0];
    // the target decides the encoding of the factor: sRGB on the 8-bit canvas, linear on a float target
    this.mesh.onBeforeRender = (renderer) => {
      this.uniforms.uPow.value = (fxEnv.linearTarget(renderer) ? 1 : 1 / 2.2) / POOL_PASSES;
      this.uniforms.uGain.value = poolGain(fxEnv.logLux);
    };
    this._lastLamp = new THREE.Vector3(1e9, 0, 0);
    this._lastDir = new THREE.Vector3();
  }

  _show(on) { for (const m of this.passes) m.visible = on; }

  /**
   * landing: visual.lights.landing {on, position, direction, beams: [{direction, intensity, spread,
   * weight}]} (world); draw: the frame is drawn (rebuild the grid).
   */
  update(landing, draw) {
    const on = this.enabled && landing && landing.on;
    // a lamp is nothing against daylight (the sun more than ~4 deg up): no draws at all
    if (!on || !this.terrain || !this.terrain.heightAt || fxEnv.logLux > 3.8) { this._show(false); return; }
    const P = landing.position, D = landing.direction;
    const g0 = this.terrain.heightAt(P.x, P.z);
    const hLamp = P.y - g0;
    // the beam lights the ground only from a few hundred metres up and when it points down-ish
    if (!Number.isFinite(hLamp) || hLamp > 400 || hLamp < -1 || D.y > 0.2) { this._show(false); return; }
    const u = this.uniforms;
    u.uLamp.value.copy(P);
    const B = landing.beams;
    if (B && B.length >= 2) {
      u.uBeamA.value.copy(B[0].direction);
      u.uBeamB.value.copy(B[1].direction);
      u.uBeams.value.set(B[0].intensity * B[0].weight * CD, B[1].intensity * B[1].weight * CD, B[0].spread, B[1].spread);
    } else {
      u.uBeamA.value.copy(D);
      u.uBeams.value.set((landing.intensity || 400000) * CD, 0, landing.spread || 0.15, 0.2);
    }
    if (draw) this._show(true);
    if (!draw) return;
    // rebuild the grid only when the lamp has moved or turned
    if (P.distanceToSquared(this._lastLamp) < 0.04 && D.angleTo(this._lastDir) < 0.003) return;
    this._lastLamp.copy(P);
    this._lastDir.copy(D);
    _d.set(D.x, 0, D.z);
    if (_d.lengthSq() < 1e-6) _d.set(0, 0, -1);
    _d.normalize();
    _s.set(-_d.z, 0, _d.x);
    // where the flattest lit beam axis meets the ground sets how far the pool reaches (more points near)
    let dy = D.y;
    if (B) for (const b of B) if (b.weight > 0.05) dy = Math.max(dy, b.direction.y);
    const far = dy < -1e-3 ? Math.min(FAR, Math.max(60, 4 * Math.max(hLamp, 0.5) / -dy)) : FAR;
    let k = 0;
    for (let j = 0; j < NZ; j++) {
      const f = j / (NZ - 1);
      const along = NEAR + (far - NEAR) * Math.pow(f, 1.8);
      const half = 3 + 0.4 * along;                        // ~22 deg either side
      for (let i = 0; i < NX; i++) {
        const uu = (i / (NX - 1)) * 2 - 1;
        const x = P.x + _d.x * along + _s.x * half * uu;
        const z = P.z + _d.z * along + _s.z * half * uu;
        const y = this.terrain.heightAt(x, z);
        this._pos[k++] = x;
        this._pos[k++] = (Number.isFinite(y) ? y : g0) + 0.12 + 0.0004 * along;
        this._pos[k++] = z;
      }
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
  }

  /** The meshes with shader programs of their own (AircraftFX compiles them before first use). */
  effectMeshes() { return [this.mesh]; }

  dispose() {
    for (const m of this.passes) this.world.remove(m);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
