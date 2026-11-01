// Exterior lights of the F-35I: lens emission, glows, the anti-collision flash pattern and the
// landing light's beam (for the ground pool that AircraftFX draws).
//
//   nav        position lights: red (left) / green (right) on the wing tips and the aft fuselage
//              sides, steady, seen from ahead to 110 deg aft on their side; a white tail light
//              (no lens in the model: glow only, TAIL below) seen from behind (+-70 deg)
//   anticoll   red LED beacons on the spine and the belly: a 90 ms flash a second each, the two
//              alternating (they share one lens material: a shader patch splits them by height)
//   formation  green electroluminescent strips (inlets, aft fuselage, fins), dimmable; a few hundred
//              cd/m^2 at most: invisible by day, a soft green at night. Emission only.
//   landing    the lamp on the nose-gear leg, on while lights.landing and the gear is down and
//              locked (gear > 0.9): lens, glare, and `landing` (world position, beam, intensity) for
//              the pool of light on the runway (AircraftFX.js; terrain shaders ignore three.js lights)
//
// Photometry. Scene radiance units: the sun's 4.0 is ~120 klx (sim/js/env), so 1 unit of radiance
// is ~30,000 cd/m^2 and 1 unit of illuminance ~30,000 lux. Lens emission (LENS) is in those units.
// The glows are ONE THREE.Points draw for all the lights of an aircraft; per light:
//   core   the lens while it is smaller than a few pixels: the light reaching the camera, I / d^2,
//          spread over a ~2.5 px dot (energy-conserving), so a distant light stays a point of the
//          right brightness; it fades out as the lens itself (emissive material) becomes visible
//   halo   eye / lens glare, in proportion to the light reaching the camera, only once it is dark
//          (exposure > ~3): by day a lit lens is a small bright dot, never an LED glow. With an HDR
//          bloom pass, set AircraftLights.haloGain lower (the bloom then makes the halo).
// At night the sim's exposure stops at 40, far below a dark-adapted eye, so cores and halos get a
// visibility gain that grows with the exposure (nightGain): distant lights stay visible for miles.
// The exposure is read from the renderer (toneMappingExposure) when the glows are drawn.
//
// Light positions and directions come from rig.info.lights (node-relative, model frame), so the
// glows ride on the node that carries the lens (the landing lamp swings up with the nose leg).

import * as THREE from 'three';
import { fxExposure } from './fxshared.js';

const ROLE = { nav: 'nav', beacon: 'anticoll', anticoll: 'anticoll', formation: 'formation', landing: 'landing' };
const CD = 1 / 30000;                  // cd/m^2 -> scene radiance units; lux -> illuminance units

// lens material -> emission (scene radiance units) when on, multiplies the glTF emissive colour.
// LED lenses look much brighter than their average (the dies are small): ~100k cd/m^2 for nav.
const LENS = {
  F35_nav_red: { role: 'nav', on: 4 },
  F35_nav_green: { role: 'nav', on: 4 },
  F35_nav_white: { role: 'nav', on: 3 },
  F35_beacon: { role: 'anticoll', on: 14 },
  F35_formation: { role: 'formation', on: 250 * CD },      // EL strips: ~250 cd/m^2 at full bright
  F35_landing_light: { role: 'landing', on: 3 },           // + the beam towards the camera (update)
};

// glows: luminous intensity (cd) in the main direction; colour from rig info
const GLOW = {
  nav: { cd: 150 },                    // LED position lights (FAR 25.1391: >= 40 cd ahead)
  tail: { cd: 40 },                    // white aft position light (>= 20 cd)
  anticoll: { cd: 600 },               // red LED beacons, peak (>= 400 cd effective)
  landing: { cd: 400000 },             // landing / taxi lamp, peak of the beam
};

// the white tail light: not modelled; on the aft deck above the nozzle, facing aft (body frame)
const TAIL = { name: 'TailLight', role: 'tail', pos: [0, 0.80, 5.50], dir: [0, 0.25, 1], colour: [1.0, 0.95, 0.88] };

// The lamp sits square to the raked nose leg, so its lens axis points ~12 deg above the body's
// horizon; the beam is aimed ahead and 5 deg below the body axis instead (on the ground it lights
// the runway from ~5 m out). Node frame with the gear down = model frame (+Z forward).
const LANDING_BEAM = new THREE.Vector3(0, Math.sin(THREE.MathUtils.degToRad(-5)), Math.cos(THREE.MathUtils.degToRad(-5)));
const LANDING_SPREAD = THREE.MathUtils.degToRad(9);       // 1/e half width of the beam (landing + taxi)
const LANDING_SPILL = 0.002;                               // fraction seen from outside the beam

/** Anti-collision pattern: [top, bottom] 0..1 at time t (s). LED: square 90 ms flashes, 1 Hz each. */
export function anticollPattern(t) {
  const p = ((t % 1) + 1) % 1;
  const f = (x) => (x >= 0 && x < 0.09 ? 1 : 0);
  return [f(p), f(p - 0.5)];
}

const GLOW_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec4 aCore;      // rgb: radiance at the centre (scene units), a: 1/e^2 radius (px)
  attribute vec4 aHalo;      // rgb: radiance at the centre, a: radius (px)
  uniform float uPixelRatio;
  varying vec4 vCore;
  varying vec4 vHalo;
  varying float vRadius;
  void main() {
    vCore = aCore;
    vHalo = aHalo;
    float r = max(aCore.a * 2.0, aHalo.a);
    vRadius = r;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = 2.0 * r * uPixelRatio;
    if (dot(aCore.rgb, vec3(1.0)) + dot(aHalo.rgb, vec3(1.0)) <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    #include <logdepthbuf_vertex>
  }`;

const GLOW_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec4 vCore;
  varying vec4 vHalo;
  varying float vRadius;
  void main() {
    #include <logdepthbuf_fragment>
    float r = length(gl_PointCoord - 0.5) * 2.0 * vRadius;          // px from the centre
    vec3 col = vCore.rgb * exp(-2.0 * r * r / max(vCore.a * vCore.a, 1e-4));
    float x = r / max(vHalo.a, 1e-4);
    col += vHalo.rgb * pow(max(1.0 - x, 0.0), 2.0) / (1.0 + 10.0 * x);
    if (max(col.r, max(col.g, col.b)) <= 0.0) discard;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _d = new THREE.Vector3();
const _c = new THREE.Vector3();
const _f = new THREE.Vector3();
const _m = new THREE.Matrix3();
const _inv = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const smooth = THREE.MathUtils.smoothstep;

export class AircraftLights {
  /**
   * @param {THREE.Object3D} root    the glTF scene (model frame)
   * @param {object} info            rig.info
   * @param {Map<string, THREE.Material[]>} materials  materials by name (materials.js)
   */
  constructor(root, info, materials) {
    this.root = root;
    this.state = { nav: false, anticoll: false, formation: 0, landing: false };
    this.gear = 1;
    this.time = 0;
    this.exposure = 1;                       // the renderer's, read when the glows are drawn
    this.haloGain = 1;
    // lenses
    this.lenses = [];
    this.beaconUniforms = { uBeacon: { value: new THREE.Vector2(0, 0) } };
    for (const [name, spec] of Object.entries(LENS)) {
      for (const m of materials.get(name) || []) {
        this.lenses.push({ mat: m, role: spec.role, on: spec.on });
        m.emissiveIntensity = 0;
        if (spec.role === 'anticoll') this._splitBeacons(m);
      }
    }
    // glow sources: info.lights (minus the formation strips) + the tail light
    const fwdModel = new THREE.Vector3(0, 0, 1);              // model frame: +Z forward
    this.sources = [];
    const add = (l, role, node, nodePos, nodeDir) => {
      const lensDir = new THREE.Vector3().fromArray(nodeDir).normalize();
      const pos = new THREE.Vector3().fromArray(nodePos);
      // just off the lens, so the airframe hides it from behind but the lens itself does not
      if (role !== 'tail') pos.addScaledVector(lensDir, 0.04 + 0.25 * (l.size || 0.05));
      const colour = new THREE.Color().fromArray(l.colour || [1, 1, 1]);
      if (role === 'landing') colour.setRGB(1.0, 0.93, 0.80);
      // outboard axis of a position light: its lens direction without the up / down part
      const outboard = lensDir.clone().setY(0);
      if (outboard.lengthSq() < 1e-6) outboard.set(1, 0, 0);
      outboard.normalize();
      this.sources.push({
        name: l.name, role, node, pos, lensDir, outboard, colour,
        lensSize: role === 'tail' ? 0 : (l.size || 0.05),
        beam: role === 'landing' ? LANDING_BEAM.clone() : null,
        top: role === 'anticoll' ? nodePos[1] > 0.2 : false,
        fwd: fwdModel,
      });
    };
    for (const l of info.lights || []) {
      const role = ROLE[l.role];
      if (!role || role === 'formation') continue;
      const node = root.getObjectByName(l.node);
      if (node) add(l, role, node, l.nodePos, l.nodeDir);
    }
    const airframe = root.getObjectByName('Airframe') || root;
    // body (+X right, -Z forward) -> model (+X left, +Z forward): x -> -x, z -> -z; node-relative
    const ap = airframe === root ? new THREE.Vector3() : airframe.position;
    add(TAIL, 'tail', airframe, [-TAIL.pos[0] - ap.x, TAIL.pos[1] - ap.y, -TAIL.pos[2] - ap.z],
      [-TAIL.dir[0], TAIL.dir[1], -TAIL.dir[2]]);
    // one Points draw for every glow
    const n = this.sources.length;
    const geo = new THREE.BufferGeometry();
    this._pos = new Float32Array(n * 3);
    this._core = new Float32Array(n * 4);
    this._halo = new Float32Array(n * 4);
    geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aCore', new THREE.BufferAttribute(this._core, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aHalo', new THREE.BufferAttribute(this._halo, 4).setUsage(THREE.DynamicDrawUsage));
    this.glowUniforms = { uPixelRatio: { value: 1 } };
    this.glowMaterial = new THREE.ShaderMaterial({
      name: 'F35_LightGlow', uniforms: this.glowUniforms, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, toneMapped: true,
    });
    this.points = new THREE.Points(geo, this.glowMaterial);
    this.points.name = 'F35_LightGlows';
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.visible = false;
    this.points.onBeforeRender = (renderer) => {
      this.exposure = fxExposure.get(renderer);
      this.glowUniforms.uPixelRatio.value = renderer.getPixelRatio();
    };
    root.add(this.points);
    // landing light beam for the ground pool (world frame; AircraftFX reads it)
    this.landing = {
      on: false, position: new THREE.Vector3(), direction: new THREE.Vector3(0, 0, -1),
      intensity: GLOW.landing.cd, spread: LANDING_SPREAD, spill: LANDING_SPILL,
    };
    this._landingSource = this.sources.find((s) => s.role === 'landing') || null;
  }

  /** The beacon lens material lights the top or the bottom lens from uBeacon (x top, y bottom). */
  _splitBeacons(mat) {
    const u = this.beaconUniforms;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      if (prev) prev.call(mat, sh, r);
      sh.uniforms.uBeacon = u.uBeacon;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vBeaconTop;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBeaconTop = step(0.2, position.y);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec2 uBeacon;\nvarying float vBeaconTop;')
        .replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= mix(uBeacon.y, uBeacon.x, vBeaconTop);');
    };
    const key = mat.customProgramCacheKey.bind(mat);
    mat.customProgramCacheKey = () => key() + '+f35beacon';
    mat.needsUpdate = true;
  }

  /** lights: {nav, landing, formation, anticoll} (booleans or 0..1); gear 0..1. */
  set(lights, gear) {
    if (lights) {
      for (const k of ['nav', 'anticoll', 'landing']) if (k in lights) this.state[k] = !!lights[k];
      if ('formation' in lights) this.state.formation = typeof lights.formation === 'number'
        ? Math.min(1, Math.max(0, lights.formation)) : (lights.formation ? 1 : 0);
    }
    if (Number.isFinite(gear)) this.gear = gear;
  }

  /** Visibility gain of the glows at night (exposure ~1 by day, up to 40 at night). */
  static nightGain(exposure) {
    return Math.max(1, Math.pow(exposure / 2.8, 2));
  }

  /** viewportHeight: canvas height in CSS px (pixel sizes of the glows). */
  update(dt, camera, viewportHeight = 1080) {
    this.time += Math.max(0, dt || 0);
    const st = this.state;
    const landingOn = st.landing && this.gear > 0.9;
    const [top, bottom] = st.anticoll ? anticollPattern(this.time) : [0, 0];
    this.beaconUniforms.uBeacon.value.set(top, bottom);
    const level = { nav: st.nav ? 1 : 0, tail: st.nav ? 1 : 0, anticoll: st.anticoll ? 1 : 0,
      formation: st.formation, landing: landingOn ? 1 : 0 };
    // the landing beam in the world (for the ground pool) and its direction to the camera
    const ls = this._landingSource;
    this.landing.on = landingOn && !!ls;
    if (ls) {
      ls.node.updateWorldMatrix(true, false);
      this.landing.position.copy(ls.pos).applyMatrix4(ls.node.matrixWorld);
      _m.setFromMatrix4(ls.node.matrixWorld);
      this.landing.direction.copy(ls.beam).applyMatrix3(_m).normalize();
    }
    let landingLens = 0;
    if (camera && ls && landingOn) {
      camera.getWorldPosition(_c).sub(this.landing.position).normalize();
      landingLens = this._beam(Math.acos(Math.min(1, Math.max(-1, _c.dot(this.landing.direction)))));
    }
    for (const l of this.lenses) {
      let e = l.on * level[l.role];
      if (l.role === 'landing') e *= 1 + 120 * landingLens;
      l.mat.emissiveIntensity = e;
    }
    const any = level.nav || level.anticoll || level.landing;
    this.points.visible = !!(any && camera);
    if (!this.points.visible) return;
    // ---------------------------------------------------------------- glows
    const exposure = Math.max(0.05, this.exposure);
    const G = AircraftLights.nightGain(exposure);
    const night = smooth(exposure, 2.5, 8);
    const H = Math.max(1, viewportHeight);
    const pxAngle = camera.isPerspectiveCamera
      ? 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (camera.zoom || 1) / H : 1e-3;
    const omegaPx = pxAngle * pxAngle;
    const scale = H / 1080;
    camera.getWorldPosition(_c);
    this.root.updateWorldMatrix(true, false);
    _inv.copy(this.root.matrixWorld).invert();
    for (let i = 0; i < this.sources.length; i++) {
      const s = this.sources[i];
      const lv = level[s.role] * (s.role === 'anticoll' ? (s.top ? top : bottom) : 1);
      let core = 0, halo = 0, coreR = 1.25, haloR = 4;
      _w.copy(s.pos).applyMatrix4(s.node.matrixWorld);
      if (lv > 0) {
        _v.copy(_c).sub(_w);
        const d = Math.max(0.3, _v.length());
        _v.divideScalar(d);
        _m.setFromMatrix4(s.node.matrixWorld);
        const g = this._pattern(s, _v, _m);
        if (g > 1e-4) {
          const cd = GLOW[s.role].cd * lv * g;
          const E = cd * CD / (d * d);                        // illuminance at the camera (scene units)
          const lensPx = s.lensSize / (d * pxAngle);
          const coreFade = s.lensSize > 0 ? 1 - smooth(lensPx, 1.5, 4.0) : 1;
          core = Math.min(2000, E * G / (omegaPx * Math.PI * coreR * coreR / 2)) * coreFade;
          // halo: display brightness and size grow with the light at the camera; dark only, except
          // a light shining straight into the camera (a landing lamp head-on dazzles by day too)
          const seen = E * G * exposure;
          const dark = Math.max(night, smooth(E * exposure, 3e-4, 6e-3));
          const peak = Math.min(1.0, 18 * seen) * dark * this.haloGain;
          halo = peak / exposure;
          haloR = Math.min(64, Math.max(4, 380 * Math.sqrt(seen))) * scale;
        }
      }
      _w.applyMatrix4(_inv);
      this._pos[i * 3] = _w.x; this._pos[i * 3 + 1] = _w.y; this._pos[i * 3 + 2] = _w.z;
      const c = s.colour;
      this._core[i * 4] = c.r * core; this._core[i * 4 + 1] = c.g * core; this._core[i * 4 + 2] = c.b * core;
      this._core[i * 4 + 3] = coreR;
      this._halo[i * 4] = c.r * halo; this._halo[i * 4 + 1] = c.g * halo; this._halo[i * 4 + 2] = c.b * halo;
      this._halo[i * 4 + 3] = haloR;
    }
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = true;
    a.aCore.needsUpdate = true;
    a.aHalo.needsUpdate = true;
  }

  /** Relative intensity of the landing lamp at angle th (rad) off its beam axis. */
  _beam(th) {
    const x = th / LANDING_SPREAD;
    return Math.exp(-x * x) + LANDING_SPILL;
  }

  /** Relative intensity of a light towards unit vector v (world, light -> camera); m: node normal matrix. */
  _pattern(s, v, m) {
    if (s.role === 'landing') {
      _d.copy(s.beam).applyMatrix3(m).normalize();
      return this._beam(Math.acos(Math.min(1, Math.max(-1, _d.dot(v)))));
    }
    _d.copy(s.lensDir).applyMatrix3(m).normalize();
    if (s.role === 'anticoll') return smooth(_d.dot(v), -0.3, 0.1);
    // position lights: outboard and forward sectors (red / green from dead ahead to 110 deg aft),
    // the white tail light within 70 deg of dead astern
    _q.setFromRotationMatrix(s.node.matrixWorld);
    const fwd = _f.copy(s.fwd).applyQuaternion(_q);
    if (s.role === 'tail') return smooth(-fwd.dot(v), 0.25, 0.45);
    const out = _d.copy(s.outboard).applyMatrix3(m).normalize();
    return smooth(out.dot(v), -0.35, 0.05) * smooth(fwd.dot(v), -0.55, -0.25);
  }
}
