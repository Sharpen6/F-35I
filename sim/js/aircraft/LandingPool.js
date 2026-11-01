// The landing light's pool on the ground. The terrain's shaders ignore three.js lights, so the pool
// is drawn on its own: a grid that follows the terrain (Terrain.heightAt) ahead of the lamp, added
// on top of the ground (additive), lit per fragment from the lamp's beam:
//     E = I(theta) cos(incidence) / r^2,   L = albedo E / pi
// with I(theta) the beam pattern of lights.js (400,000 cd peak, 9 deg 1/e half width), the ground's
// albedo assumed (runway asphalt with its paint ~0.12), and the same night visibility gain as the light
// glows (AircraftLights.nightGain: the sim's night exposure stops far short of a dark-adapted eye).
// By day it is invisible, as it should be. The beam (world position, direction, intensity, spread)
// is also published on visual.lights.landing for a terrain shader that wants to light itself.

import * as THREE from 'three';
import { AircraftLights } from './lights.js';
import { fxExposure } from './fxshared.js';

const CD = 1 / 30000;
const NX = 17, NZ = 33;
const NEAR = 2.5, FAR = 320;           // m along the ground ahead of the lamp

const POOL_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }`;

const POOL_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uLamp;          // lamp position (world)
  uniform vec3 uBeam;          // beam axis (world, unit)
  uniform float uI0;           // peak intensity (scene units: cd / 30000)
  uniform float uSpread;       // 1/e half width (rad)
  uniform float uGain;         // albedo / pi x night gain
  varying vec3 vWorld;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 L = vWorld - uLamp;
    float r2 = max(dot(L, L), 0.25);
    float r = sqrt(r2);
    float c = clamp(dot(L / r, uBeam), -1.0, 1.0);
    float th = acos(c) / uSpread;
    float I = uI0 * exp(-th * th);
    float cosInc = max(0.0, -L.y / r);
    vec3 col = vec3(1.0, 0.93, 0.80) * (I * cosInc / r2) * uGain;
    if (max(col.r, col.g) < 1e-7) discard;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
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
    this.albedo = 0.12;                  // runway asphalt with its paint, on average
    this.enabled = true;
    const geo = new THREE.BufferGeometry();
    this._pos = new Float32Array(NX * NZ * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let j = 0; j < NZ - 1; j++) {
      for (let i = 0; i < NX - 1; i++) {
        const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1;
        idx.push(a, b, c, b, d, c);                   // facing up (+Y)
      }
    }
    geo.setIndex(idx);
    this.uniforms = {
      uLamp: { value: new THREE.Vector3() }, uBeam: { value: new THREE.Vector3(0, 0, -1) },
      uI0: { value: 400000 * CD }, uSpread: { value: THREE.MathUtils.degToRad(9) }, uGain: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'F35_LandingPool', uniforms: this.uniforms, vertexShader: POOL_VERT, fragmentShader: POOL_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: true,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'LandingLightPool';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.onBeforeRender = (renderer) => {
      const e = fxExposure.get(renderer);
      this.uniforms.uGain.value = this.albedo / Math.PI * AircraftLights.nightGain(e);
    };
    world.add(this.mesh);
    this._lastLamp = new THREE.Vector3(1e9, 0, 0);
    this._lastDir = new THREE.Vector3();
  }

  /** landing: visual.lights.landing {on, position, direction, intensity, spread} (world). */
  update(landing, draw) {
    const on = this.enabled && landing && landing.on;
    if (!on || !this.terrain || !this.terrain.heightAt) { this.mesh.visible = false; return; }
    const P = landing.position, D = landing.direction;
    const g0 = this.terrain.heightAt(P.x, P.z);
    const hLamp = P.y - g0;
    // the beam lights the ground only from a few hundred metres up and when it points down-ish
    if (!Number.isFinite(hLamp) || hLamp > 400 || hLamp < -1 || D.y > 0.2) { this.mesh.visible = false; return; }
    this.uniforms.uLamp.value.copy(P);
    this.uniforms.uBeam.value.copy(D);
    this.uniforms.uI0.value = (landing.intensity || 400000) * CD;
    this.uniforms.uSpread.value = landing.spread || THREE.MathUtils.degToRad(9);
    this.mesh.visible = !!draw || this.mesh.visible;
    if (!draw) return;
    // rebuild the grid only when the lamp has moved or turned
    if (P.distanceToSquared(this._lastLamp) < 0.04 && D.angleTo(this._lastDir) < 0.003) return;
    this._lastLamp.copy(P);
    this._lastDir.copy(D);
    _d.set(D.x, 0, D.z);
    if (_d.lengthSq() < 1e-6) _d.set(0, 0, -1);
    _d.normalize();
    _s.set(-_d.z, 0, _d.x);
    // where the beam axis meets the ground sets how far the pool reaches (more points near)
    const far = D.y < -1e-3 ? Math.min(FAR, Math.max(60, 4 * Math.max(hLamp, 0.5) / -D.y)) : FAR;
    let k = 0;
    for (let j = 0; j < NZ; j++) {
      const f = j / (NZ - 1);
      const along = NEAR + (far - NEAR) * Math.pow(f, 1.8);
      const half = 3 + 0.36 * along;                       // ~20 deg either side (2.2 x the spread)
      for (let i = 0; i < NX; i++) {
        const u = (i / (NX - 1)) * 2 - 1;
        const x = P.x + _d.x * along + _s.x * half * u;
        const z = P.z + _d.z * along + _s.z * half * u;
        const y = this.terrain.heightAt(x, z);
        this._pos[k++] = x;
        this._pos[k++] = (Number.isFinite(y) ? y : g0) + 0.12 + 0.0004 * along;
        this._pos[k++] = z;
      }
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
  }

  dispose() {
    this.world.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
