// The landing / taxi light's pool on the ground. The terrain's shaders ignore three.js lights, so the
// pool is drawn on its own: a grid that follows the terrain (Terrain.heightAt) ahead of the lamp.
// Per fragment:
//     E_lamp = sum over the beams of I(theta) cos(incidence) / r^2          (lights.js beams)
//     E_amb  = the sky's and the sun's light on level ground                 (fxshared fxLight)
//     ground = albedo (E_amb + E_lamp) / pi
// By day and at sunset E_lamp / E_amb is all there is (a 250,000 cd taxi beam gives ~350 lx 10 m
// ahead of the nose, a sunset sky ~400 lx: a faint brightening near the nose wheel). At night the
// lamp's light is seen as every artificial light is (js/env/README.md "Lights at night"): times
// fxEnv.lightGain, the eye's adaptation to the lights (1 by day and in the dusk, 1400 / exposure
// once the sky is dark), so the pool is as bright next to the lit aprons and streets as it is in
// lux: bright under the nose, falling off along the beam as the light grazes the ground (E ~ h /
// r^3 at the taxi light's 1.5 m). A soft roll-off far above the night's light (POOL_KNEE) only
// keeps the asphalt right under the lamp from turning to a white sheet.
// On dark land the pool keeps a floor, as a point light keeps its visibility floor: the eye adapted
// to the land weighs the lamp against the land's real light (the night's glow and the moon without
// their boosts, fxEnv.groundLightPhysical), and brightness goes with the log of the light (Fechner):
//     F >= 1 + ln(1 + E_lamp / E_real)
// The land the meter shows at night is lit as at the end of civil twilight (~20 lux with the moon's
// boost), so by the rule alone the landing beam's ~0.5 lux on the runway 370 m ahead on short final
// was x1.2, nothing, where the real runway there is tens of times brighter than by the moon: the
// floor draws it ~x5, the touchdown zone in the flare ~x8; near the nose (tens of lux and more) the
// rule is the higher and wins. By day and at dusk nothing is boosted and the floor stays under the
// rule (ln(1 + r) < r).
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
// curve follows) the draws multiply by F itself, which is right for any albedo. Fog fades the lamp's
// light out. The draws multiply whatever is under them: a street already lit by its own lamps comes
// out brighter than the landing light's share of its light would make it.
//
// The pool's own light draws its edges, not the grid: each beam fades out from 2.6 to 3.4 of its 1/e
// widths (a lamp's reflector has a rim; e^-9 of the peak is nothing next to the night's light, but the
// floor's log of a bright beam's tail would otherwise reach any edge), and the grid reaches past that: 45 deg
// either side for the wide taxi beam, ~27 deg for the landing beam alone, 1.2-3 km ahead (further
// the higher the lamp). On short final from 65 m the landing beam's centre meets the ground ~370 m
// ahead and its light is still x1.3 at 1.1 km; on the ground roll the taxi beam skims the runway to
// ~600 m. From 250 m up the pool fades out (gone at 400 m: from there its centre is 2 km ahead).
//
// The lamp lights more than the ground: the same light under the same rule is shared with any shader
// that lights itself (LAMP_GLSL, LAMP_UNIFORMS by reference, written here every frame: the
// buildings' walls and roofs, js/world/buildingShaders.js; a grid on the ground cannot light a wall,
// and the pool on short final over a town was lit ground between dark blocks). The beams (world
// position, directions, intensities, spreads) are also published on visual.lights.landing.

import * as THREE from 'three';
import { fxEnv, fxLight, fogUniforms, LUX_PER_UNIT } from './fxshared.js';

/**
 * Brightening of the ground on the luminance (the shader scales the colour channels' brightening in
 * proportion): the rule, F = 1 + K ln(1 + gain * E_lamp / E_amb / K), nearly the physical 1 + ratio
 * up to ~K and logarithmic beyond, and at least the floor on dark land, 1 + ln(1 + E_lamp / E_real)
 * (the header). ratio: E_lamp / E_amb, the light on the ground as drawn (boosted at night); gain:
 * the rule for lights at night (fxEnv.lightGain); ratioPhys: E_lamp / E_real, the ground's light
 * without the night's boosts (fxEnv.groundLightPhysical).
 */
export const POOL_KNEE = 64;
export function poolFactor(ratio, gain = 1, ratioPhys = 0) {
  const rule = 1 + POOL_KNEE * Math.log(1 + Math.max(0, gain) * Math.max(0, ratio) / POOL_KNEE);
  return Math.max(rule, 1 + Math.log(1 + Math.max(0, ratioPhys)));
}
/** Multiplying draws of the grid (each by M's N-th root, see the header), then one additive draw. */
export const POOL_PASSES = 3;
/** Albedos of the reference grounds the pool is worked out for: the runway's asphalt and its paint
 *  (terrainShaders.js runwayPaint). */
export const POOL_ALBEDO = [0.115, 0.62];

const CD = 1 / LUX_PER_UNIT;
// a beam ends at BEAM_END of its 1/e half widths (the header); the grid's half width covers the
// widest lit beam's end (x 1.15: a beam aimed down meets the ground wider than its angle)
const BEAM_END = 3.4;

/**
 * The lamp for any shader that lights itself (the header), by reference: LandingPool.update writes
 * them every frame. uLampRule.w is 0 while the pool is off (by day, from 400 m up, the light off),
 * so a shader skips the lamp with one uniform branch and draws as it did.
 */
export const LAMP_UNIFORMS = {
  uLampPos: { value: new THREE.Vector3() },                         // world
  uLampBeamA: { value: new THREE.Vector3(0, 0, -1) },               // landing beam axis (world, unit)
  uLampBeamB: { value: new THREE.Vector3(0, 0, -1) },               // taxi beam axis
  uLampBeams: { value: new THREE.Vector4(0, 0, 0.15, 0.2) },        // peak intensities (scene units, x weight), 1/e half widths (rad)
  uLampColour: { value: new THREE.Color(1.0, 0.95, 0.86) },
  uLampRule: { value: new THREE.Vector4(1, 1, POOL_KNEE, 0) },      // fxEnv.lightGain, fxEnv.groundLightPhysical, POOL_KNEE, on (0..1)
};
/**
 * lampLight(L, N): the lamp's illuminance (scene units) on a surface facing N at L (world, m) from
 * the lamp; lampFactor(E, Eamb, Ereal): the brightening per channel of a surface lit by Eamb as
 * drawn (per channel) and by Ereal without the night's boosts (luminance), as poolFactor: the rule
 * rolled off on the luminance with the channels kept in proportion (the lamp's warm white wins over
 * the bluish night as it would), at least the floor on dark land; times uLampRule.w.
 */
export const LAMP_GLSL = /* glsl */`
  uniform vec3 uLampPos;
  uniform vec3 uLampBeamA;
  uniform vec3 uLampBeamB;
  uniform vec4 uLampBeams;
  uniform vec3 uLampColour;
  uniform vec4 uLampRule;
  float lampBeam(vec3 Lr, vec3 axis, float I0, float spread) {
    float th = acos(clamp(dot(Lr, axis), -1.0, 1.0)) / spread;
    // the reflector's rim at ${BEAM_END.toFixed(1)} widths
    return I0 * exp(-th * th) * (1.0 - smoothstep(${(BEAM_END - 0.8).toFixed(1)}, ${BEAM_END.toFixed(1)}, th));
  }
  float lampLight(vec3 L, vec3 N) {
    float r2 = max(dot(L, L), 0.25);
    vec3 Lr = L * inversesqrt(r2);
    float cosInc = max(0.0, -dot(Lr, N));
    return (lampBeam(Lr, uLampBeamA, uLampBeams.x, uLampBeams.z) + lampBeam(Lr, uLampBeamB, uLampBeams.y, uLampBeams.w))
      * cosInc / r2;
  }
  vec3 lampFactor(float E, vec3 Eamb, float Ereal) {
    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
    vec3 ratio = uLampRule.x * E * uLampColour / max(Eamb, vec3(1e-7));
    float ry = max(dot(ratio, LUMA), 1e-6);
    float Fy = 1.0 + uLampRule.z * log(1.0 + ry / uLampRule.z);
    Fy = max(Fy, 1.0 + log(1.0 + E * dot(uLampColour, LUMA) / max(Ereal, 1e-9)));
    return 1.0 + ratio * ((Fy - 1.0) / ry) * uLampRule.w;
  }
`;

const NX = 25, NZ = 49;
// m along the ground ahead of the lamp (the header): the far end FAR_PER_M x the lamp's height,
// between FAR_MIN and FAR_MAX; the rows closer together near the lamp (along ~ f^1.8)
const NEAR = 2.5, FAR_MIN = 1200, FAR_MAX = 3000, FAR_PER_M = 30;
const ROW_F = Array.from({ length: NZ }, (_, j) => Math.pow(j / (NZ - 1), 1.8));
// m above the ground: the pool fades out between these heights
const FADE_H = [250, 400];

const POOL_VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  attribute float aAcross;     // -1..1 across the grid
  varying vec3 vWorld;
  varying float vAcross;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vAcross = aAcross;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }`;

const POOL_FRAG = /* glsl */`
  #include <common>
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  ${LAMP_GLSL}
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform vec2 uAlbedo;        // POOL_ALBEDO (asphalt, paint)
  uniform float uMaxMul;       // the most the multiplying draws can do together on the canvas (2^passes)
  uniform float uPasses;       // POOL_PASSES
  uniform float uLinear;       // 1 on a linear float target (the HDR chain), 0 on the 8-bit canvas
  uniform vec2 uAhead;         // the grid's heading (world xz, unit)
  uniform vec2 uReach;         // m along it: near, far
  varying vec3 vWorld;
  varying float vAcross;
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
    vec3 L = vWorld - uLampPos;
    float E = lampLight(L, vec3(0.0, 1.0, 0.0));
    // the lamp against the light already on the ground (per channel) and against the ground's real
    // light (the floor on dark land: the night's glow and the moon without their boosts, and the sun)
    vec3 Eamb = max(uAmbient + uSunColor * max(uSunDir.y, 0.0), vec3(1e-7));
    float Ereal = uLampRule.y + dot(uSunColor, vec3(0.2126, 0.7152, 0.0722)) * max(uSunDir.y, 0.0);
    vec3 F = lampFactor(E, Eamb, Ereal);
    // the grid's edges only as a safety net (the beams end inside it)
    float along = dot(L.xz, uAhead);
    float edge = (1.0 - smoothstep(0.85, 1.0, abs(vAcross))) * smoothstep(uReach.x, uReach.x + 4.0, along)
      * (1.0 - smoothstep(0.6 * uReach.y, uReach.y, along));
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
    const across = new Float32Array(NX * NZ);
    for (let j = 0, k = 0; j < NZ; j++) for (let i = 0; i < NX; i++) across[k++] = (i / (NX - 1)) * 2 - 1;
    geo.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
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
      ...LAMP_UNIFORMS,
      uAlbedo: { value: new THREE.Vector2(...POOL_ALBEDO) },
      uMaxMul: { value: 2 ** POOL_PASSES }, uPasses: { value: POOL_PASSES }, uLinear: { value: 0 },
      uAhead: { value: new THREE.Vector2(0, -1) }, uReach: { value: new THREE.Vector2(NEAR, FAR_MIN) },
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
      // in the transparent list after the terrain and the roads (opaque) and before every light's
      // sprite (1: the airfield's, the street lamps', the cars'; 5: the jet's): the lamp lights the
      // ground, it does not make the runway's lights brighter; the addition after the multiplications
      m.renderOrder = add ? 0.6 : 0.5;
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
    };
    this._lastLamp = new THREE.Vector3(1e9, 0, 0);
    this._lastDir = new THREE.Vector3();
  }

  _show(on) {
    for (const m of this.passes) m.visible = on;
    // the lamp for the other shaders (LAMP_UNIFORMS) goes with the pool
    if (!on) LAMP_UNIFORMS.uLampRule.value.w = 0;
  }

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
    if (!Number.isFinite(hLamp) || hLamp >= FADE_H[1] || hLamp < -1 || D.y > 0.2) { this._show(false); return; }
    const u = this.uniforms;
    // the lamp (LAMP_UNIFORMS: the pool's and every other shader's): the rule for lights at night,
    // the ground's real light, faded out with height
    const fade = 1 - (Math.min(Math.max(hLamp, FADE_H[0]), FADE_H[1]) - FADE_H[0]) / (FADE_H[1] - FADE_H[0]);
    LAMP_UNIFORMS.uLampRule.value.set(fxEnv.lightGain, fxEnv.groundLightPhysical, POOL_KNEE, fade * fade * (3 - 2 * fade));
    LAMP_UNIFORMS.uLampPos.value.copy(P);
    const B = landing.beams;
    if (B && B.length >= 2) {
      LAMP_UNIFORMS.uLampBeamA.value.copy(B[0].direction);
      LAMP_UNIFORMS.uLampBeamB.value.copy(B[1].direction);
      LAMP_UNIFORMS.uLampBeams.value.set(B[0].intensity * B[0].weight * CD, B[1].intensity * B[1].weight * CD, B[0].spread, B[1].spread);
    } else {
      LAMP_UNIFORMS.uLampBeamA.value.copy(D);
      LAMP_UNIFORMS.uLampBeams.value.set((landing.intensity || 400000) * CD, 0, landing.spread || 0.15, 0.2);
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
    u.uAhead.value.set(_d.x, _d.z);
    // how far (the header) and how wide: the widest lit beam's end, at most 45 deg either side
    const far = Math.min(FAR_MAX, Math.max(FAR_MIN, FAR_PER_M * hLamp));
    u.uReach.value.y = far;
    let spread = 0;
    if (B) { for (const b of B) if (b.weight > 0.05) spread = Math.max(spread, b.spread); } else spread = landing.spread || 0.15;
    const halfTan = Math.min(1, 1.15 * Math.tan(Math.min(1.2, BEAM_END * spread)));
    let k = 0;
    for (let j = 0; j < NZ; j++) {
      const along = NEAR + (far - NEAR) * ROW_F[j];
      const half = 3 + halfTan * along;
      for (let i = 0; i < NX; i++) {
        const uu = (i / (NX - 1)) * 2 - 1;
        const x = P.x + _d.x * along + _s.x * half * uu;
        const z = P.z + _d.z * along + _s.z * half * uu;
        const y = this.terrain.heightAt(x, z);
        this._pos[k++] = x;
        // lifted off the terrain's drawn mesh (its triangles are not heightAt's), more far away
        this._pos[k++] = (Number.isFinite(y) ? y : g0) + 0.12 + 0.001 * along;
        this._pos[k++] = z;
      }
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
  }

  /** The meshes with shader programs of their own (AircraftFX compiles them before first use). */
  effectMeshes() { return [this.mesh, this.addMesh]; }

  dispose() {
    this._show(false);
    for (const m of this.passes) this.world.remove(m);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.addMaterial.dispose();
  }
}
