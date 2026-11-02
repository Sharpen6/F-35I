// The landing / taxi light's pool on the ground. The terrain's shaders ignore three.js lights, so the
// pool is drawn on its own: a grid that follows the terrain (Terrain.heightAt) ahead of the lamp.
// Per fragment:
//     E_lamp = sum over the beams of I(theta) cos(incidence) / r^2          (lights.js beams)
//     E_amb  = the sky's and the sun's light on level ground                 (fxshared fxLight)
//     ground = albedo (E_amb + E_lamp) / pi
// By day and at sunset E_lamp / E_amb is all there is (a 250,000 cd taxi beam gives ~130 lx 10 m
// ahead of the nose, a sunset sky ~400 lx: a faint brightening near the nose wheel). In the dark the
// sim's exposure stops far short of a dark-adapted eye, so the lamp gets a visibility gain (poolGain,
// from the light level fxEnv, not the exposure: it rises from ~3 deg below the horizon) under a
// logarithmic roll-off (POOL_KNEE), so the pool reads as a lit runway that fades out along the beam.
//
// On the 8-bit canvas the frame is already tone-mapped, and the tone curve is not a multiplication:
// its toe crushes the red of the dark bluish night ground, its shoulder squeezes white paint. So what
// the pool draws is worked out on two reference grounds (POOL_ALBEDO: the runway's asphalt and its
// white paint), each without and with the lamp through the renderer's own tone curve and encoding
// (D_off, D_on), and the canvas gets the one map per channel that is exact on both:
//     drawn = what is there x M + A,   M = (D_on,paint - D_on,asphalt) / (D_off,paint - D_off,asphalt),
//                                      A = D_on,asphalt - M D_off,asphalt
// The asphalt comes out the lamp's warm grey (not the night's blue made brighter), the paint stays
// brighter than the asphalt and turns white rather than bluish, ground in between falls in between.
// M goes to the canvas in POOL_PASSES draws of the grid (an 8-bit canvas clamps a blend source at
// 1: at most x2 per draw), A in one more additive draw. On the HDR chain's float target (its tone
// curve follows) the draws multiply by F itself, which is right for any albedo. Fog and the grid's
// edges fade the lamp's light out.
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
 * the ratio (the shader scales the colour channels' brightening in proportion). At night, through
 * ACES at the exposure's ceiling, asphalt (4, 5, 11) without the lamp comes out ~(108, 104, 98) 10 m
 * ahead of the nose, ~(65, 62, 59) at 25 m, and the landing beam's 1-4 lx on the touchdown zone on
 * the approach ~(20-40) grey.
 */
export const POOL_KNEE = 4;
export function poolFactor(ratio, logLux) {
  return 1 + POOL_KNEE * Math.log(1 + poolGain(logLux) * Math.max(0, ratio) / POOL_KNEE);
}
/** Multiplying draws of the grid (each by M's N-th root, see the header), then one additive draw. */
export const POOL_PASSES = 3;
/** Albedos of the reference grounds the pool is worked out for: the runway's asphalt and its paint
 *  (terrainShaders.js runwayPaint). */
export const POOL_ALBEDO = [0.115, 0.62];

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
  uniform vec2 uAlbedo;        // POOL_ALBEDO (asphalt, paint)
  uniform float uMaxMul;       // the most the multiplying draws can do together on the canvas (2^passes)
  uniform float uPasses;       // POOL_PASSES
  uniform float uLinear;       // 1 on a linear float target (the HDR chain), 0 on the 8-bit canvas
  varying vec3 vWorld;
  varying vec2 vGrid;
  float beam(vec3 L, float r, vec3 axis, float I0, float spread) {
    float th = acos(clamp(dot(L / r, axis), -1.0, 1.0)) / spread;
    return I0 * exp(-th * th);
  }
  // radiance as the canvas holds it: through the renderer's tone curve (its exposure included) and
  // the output encoding, as the terrain under the pool was drawn
  vec3 poolDisplay(vec3 rad) {
    #ifdef TONE_MAPPING
      rad = toneMapping(rad);
    #endif
    return linearToOutputTexel(vec4(rad, 1.0)).rgb;
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
    F = 1.0 + (F - 1.0) * edge;
    if (uLinear > 0.5) {
      // a linear float target (the HDR chain; its tone curve follows): the ground's radiance times F
      // per channel is right for any albedo, and nothing clamps the blend
      #ifdef POOL_ADD
        discard;
      #else
        vec3 fl = pow(F, vec3(1.0 / uPasses)) - 1.0;
        if (max(fl.r, max(fl.g, fl.b)) < 1e-3) discard;
        gl_FragColor = vec4(fl, 0.0);
      #endif
    } else {
      // the canvas: the two reference grounds without and with the lamp, as the canvas holds them
      vec3 ra = uAlbedo.x / PI * Eamb, rp = uAlbedo.y / PI * Eamb;
      vec3 aOff = poolDisplay(ra), aOn = poolDisplay(ra * F);
      vec3 pOff = poolDisplay(rp), pOn = poolDisplay(rp * F);
      // the map through both, its multiplying part as far as the draws can go...
      vec3 M = clamp((pOn - aOn) / max(pOff - aOff, vec3(1e-4)), 1.0, uMaxMul);
      #ifdef POOL_ADD
        // ... and its adding part (the asphalt exact): the lamp's warm white where the toe had
        // crushed the red of the night's bluish ground
        vec3 A = max(aOn - M * aOff, 0.0);
        if (max(A.r, max(A.g, A.b)) < 0.002) discard;
        gl_FragColor = vec4(A, 0.0);
      #else
        vec3 f = pow(M, vec3(1.0 / uPasses)) - 1.0;
        if (max(f.r, max(f.g, f.b)) < 1e-3) discard;
        gl_FragColor = vec4(f, 0.0);
      #endif
    }
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
      uGain: { value: 1 }, uKnee: { value: POOL_KNEE }, uAlbedo: { value: new THREE.Vector2(...POOL_ALBEDO) },
      uMaxMul: { value: 2 ** POOL_PASSES }, uPasses: { value: POOL_PASSES }, uLinear: { value: 0 },
    };
    // toneMapped: three then gives the shader the renderer's tone curve (toneMapping()) on the canvas;
    // the pool's own output is never tone-mapped (no tonemapping_fragment)
    const common = {
      uniforms: this.uniforms, vertexShader: POOL_VERT, fragmentShader: POOL_FRAG,
      transparent: true, depthWrite: false, toneMapped: true, fog: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    };
    // dst * (1 + src): the ground already drawn, brightened (alpha untouched)
    this.material = new THREE.ShaderMaterial({
      ...common, name: 'F35_LandingPool', blendSrc: THREE.DstColorFactor, blendDst: THREE.OneFactor,
    });
    // dst + src: the lamp's light the multiplication cannot bring (drawn after it)
    this.addMaterial = new THREE.ShaderMaterial({
      ...common, name: 'F35_LandingPoolAdd', defines: { POOL_ADD: '' },
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    this.passes = [];
    for (let i = 0; i <= POOL_PASSES; i++) {
      const add = i === POOL_PASSES;
      const m = new THREE.Mesh(geo, add ? this.addMaterial : this.material);
      m.name = add ? 'LandingLightPoolAdd' : `LandingLightPool${i}`;
      m.frustumCulled = false;
      m.renderOrder = add ? 1.5 : 1;                  // the addition after the multiplications
      m.visible = false;
      m.matrixAutoUpdate = false;
      world.add(m);
      this.passes.push(m);
    }
    this.mesh = this.passes[0];
    this.addMesh = this.passes[POOL_PASSES];
    // the target decides the scheme: the canvas clamps a blend source at 1 (x2 a draw at most), a float
    // target does not (the first draw sets the shared uniforms for all of them)
    this.mesh.onBeforeRender = (renderer) => {
      this.uniforms.uLinear.value = fxEnv.linearTarget(renderer) ? 1 : 0;
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
  effectMeshes() { return [this.mesh, this.addMesh]; }

  dispose() {
    for (const m of this.passes) this.world.remove(m);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.addMaterial.dispose();
  }
}
