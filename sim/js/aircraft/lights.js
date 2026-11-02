// Exterior lights of the F-35I: lens emission, glows, the anti-collision flash pattern and the
// landing / taxi light's beams (for the ground pool that AircraftFX draws).
//
//   nav        position lights: red (left) / green (right) on the wing tips and the aft fuselage
//              sides, steady, seen from ahead to 110 deg aft on their side; a white tail light
//              (no lens in the model: glow only, TAIL below) seen from behind (+-70 deg)
//   anticoll   red LED beacons on the spine and the belly: a 90 ms flash a second each, the two
//              alternating (they share one lens material: a shader patch splits them by height)
//   formation  green electroluminescent strips (inlets, aft fuselage, fins), dimmable; a few hundred
//              cd/m^2 at most: invisible by day, a soft green at night. Emission only.
//   landing    the lamp on the nose-gear leg, on while lights.landing and the gear is down and
//              locked (gear > 0.9): lens, glare, and `landing` (world position, beams, intensities)
//              for the pool of light on the runway (AircraftFX.js; terrain shaders ignore three.js
//              lights). Two beams: the landing beam, aimed 12 deg below the body axis (on a 3 deg
//              approach at ~12 deg alpha it points along the glide path, so at the flare it lights
//              the touchdown zone 100-300 m ahead), and the wider taxi beam, 5 deg below the axis
//              (with the jet on its wheels it lights the runway from ~5 m out). The taxi beam takes
//              over with weight on wheels, the landing beam once airborne (blended over ~0.8 s).
//
// Photometry. Scene radiance units: the sun's 4.0 is ~120 klx (sim/js/env), so 1 unit of radiance
// is ~30,000 cd/m^2 and 1 unit of illuminance ~30,000 lux. Lens emission (LENS) is in those units.
// The glows are ONE THREE.Points draw for all the lights of an aircraft; per light:
//   core   the lens while it is smaller than a few pixels: the light reaching the camera, I / d^2,
//          spread over a ~2.5 px dot (energy-conserving), so a distant light stays a point of the
//          right brightness; it fades out as the lens itself (emissive material) becomes visible.
//          The dot's profile has a soft skirt, (1 + 2 r^2 / a^2)^-2 (a lens's spread, not a
//          Gaussian): a core brighter than the display can show looks bigger, as glare does, and
//          fades out at its edge instead of ending as a flat disc. The shader's hue-preserving
//          shoulder keeps a red or green light red or green at any distance (no white core with a
//          coloured rim); on the canvas it is the glow's whole tone curve (three's ACES on top bleached
//          a bright green towards white). The sprite sits a little nearer the camera than the lamp
//          (uDepthBias), so the lamp's own housing and the wing's edge beside it do not bite into it.
//   halo   eye / lens glare, in proportion to the light reaching the camera, only once it is dark
//          (fxEnv.darkness: from the sun's elevation, the same whatever the exposure meter): by day
//          a lit lens is a small bright dot, never an LED glow. When the frame goes through the HDR
//          chain's bloom (fxEnv.bloomOn) the halo is fainter and the shoulder higher: the bloom then
//          makes most of the glare.
// In the dark the sim's exposure stops at 40, far below a dark-adapted eye, so cores and halos get a
// visibility gain that grows with the darkness (nightGain): distant lights stay visible for miles.
// The exposure is read from the renderer (toneMappingExposure) when the glows are drawn.
//
// Light positions and directions come from rig.info.lights (node-relative, model frame), so the
// glows ride on the node that carries the lens (the landing lamp swings up with the nose leg).

import * as THREE from 'three';
import { fxExposure, fxEnv, fogUniforms, FOG_PARS_GLSL } from './fxshared.js';

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
  landing: { cd: 400000 },             // landing lamp, peak of the beam (the taxi beam: TAXI)
};

// the white tail light: not modelled; on the aft deck above the nozzle, facing aft (body frame)
const TAIL = { name: 'TailLight', role: 'tail', pos: [0, 0.80, 5.50], dir: [0, 0.25, 1], colour: [1.0, 0.95, 0.88] };

// The lamp sits square to the raked nose leg, so its lens axis points ~12 deg above the body's
// horizon; the beams are aimed below the body axis instead (see the header). Node frame with the gear
// down = model frame (+Z forward).
const DEG = THREE.MathUtils.degToRad;
const beamAxis = (deg) => new THREE.Vector3(0, Math.sin(DEG(deg)), Math.cos(DEG(deg)));
const LANDING = { axis: beamAxis(-12), cd: GLOW.landing.cd, spread: DEG(7) };   // 1/e half widths
const TAXI = { axis: beamAxis(-5), cd: 250000, spread: DEG(13) };
const LANDING_SPILL = 0.002;                               // fraction seen from outside the beam
const BEAM_TAU = 0.8;                                      // s, landing <-> taxi beam blend

/** Anti-collision pattern: [top, bottom] 0..1 at time t (s). LED: square 90 ms flashes, 1 Hz each. */
export function anticollPattern(t, out = [0, 0]) {
  const p = ((t % 1) + 1) % 1;
  out[0] = p < 0.09 ? 1 : 0;
  out[1] = p >= 0.5 && p < 0.59 ? 1 : 0;
  return out;
}

const GLOW_VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  attribute vec4 aCore;      // rgb: radiance at the centre (scene units), a: radius a of the profile (px)
  attribute vec4 aHalo;      // rgb: radiance at the centre, a: radius (px)
  uniform float uPixelRatio;
  uniform float uExposure;
  uniform vec4 uShoulder;
  uniform float uDepthBias;  // m nearer the camera than the lamp
  varying vec4 vCore;
  varying vec4 vHalo;
  varying float vRadius;
  void main() {
    vCore = aCore;
    vHalo = aHalo;
    // the sprite reaches as far as the core's skirt shows: (1 + 2 r^2 / a^2)^-2 of the centre's
    // brightness (over the shoulder's knee) is down to 1/50 of the knee there
    float over = max(aCore.r, max(aCore.g, aCore.b)) * uExposure / uShoulder.x;
    float rc = aCore.a * sqrt(max(0.0, sqrt(50.0 * over) - 1.0) * 0.5);
    float r = min(max(max(aCore.a * 2.0, rc), aHalo.a), 96.0);
    vRadius = r;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    // nearer the camera along the line of sight (same place on screen): the airframe right beside
    // the lamp does not cut the glow, while a lamp behind the fuselage stays hidden
    float dist = length(mvPosition.xyz);
    mvPosition.xyz *= max(0.5, 1.0 - (uDepthBias + 0.002 * dist) / max(dist, 1e-3));
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = 2.0 * r * uPixelRatio;
    if (dot(aCore.rgb, vec3(1.0)) + dot(aHalo.rgb, vec3(1.0)) <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }`;

const GLOW_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uExposure;   // the exposure the frame is drawn with
  uniform vec4 uShoulder;    // display brightness: knee and cap for a saturated light (x, y), a white one (z, w)
  varying vec4 vCore;
  varying vec4 vHalo;
  varying float vRadius;
  ${FOG_PARS_GLSL}
  void main() {
    #include <logdepthbuf_fragment>
    float r = length(gl_PointCoord - 0.5) * 2.0 * vRadius;          // px from the centre
    // the core: energy pi a^2 / 2 (as a Gaussian of 1/e^2 radius a), a skirt falling as r^-4
    float q = 1.0 + 2.0 * r * r / max(vCore.a * vCore.a, 1e-4);
    vec3 col = vCore.rgb / (q * q);
    float x = r / max(vHalo.a, 1e-4);
    col += vHalo.rgb * pow(max(1.0 - x, 0.0), 2.0) / (1.0 + 10.0 * x);
    col *= 1.0 - smoothstep(0.8, 1.0, r / vRadius);                  // nothing at the sprite's edge
    float m = max(col.r, max(col.g, col.b));
    if (m <= 0.0) discard;
    // hue-preserving shoulder on the display brightness: the brightest channel rolls off from the
    // knee towards the cap and the others keep their ratio to it, so the light keeps its colour
    // (a coloured light rolls off lower than a white one: a tone mapper bleaches it sooner)
    float sat = 1.0 - min(col.r, min(col.g, col.b)) / m;
    float knee = mix(uShoulder.z, uShoulder.x, sat), cap = mix(uShoulder.w, uShoulder.y, sat);
    float d = m * uExposure;
    if (d > knee) col *= (knee + (cap - knee) * (1.0 - exp(-(d - knee) / (cap - knee)))) / d;
    #ifdef TONE_MAPPING
      // the canvas: the shoulder is the glow's tone curve (display = radiance x exposure, at most the
      // cap); three's ACES on top of it would bleach a saturated green or red towards white
      gl_FragColor = vec4(col * uExposure, 1.0);
    #else
      // a float target: the HDR chain's tone curve and bloom follow
      gl_FragColor = vec4(col, 1.0);
    #endif
    #include <colorspace_fragment>
    gl_FragColor.rgb = fxFog(gl_FragColor.rgb, 0.0);
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

// display brightness (x exposure) of the glows' hue-preserving shoulder: knee and cap for a saturated
// light, then for a white one; with the HDR chain's bloom both scale up (the bloom takes the excess)
// On the canvas the shoulder is the whole tone curve (display 0..1): a saturated green tops out at
// ~(85, 243, 152), a red at ~(243, 66, 46). On a float target the HDR chain's tone curve follows
// (scene-linear values, the old ACES-matched shoulder), and with its bloom both scale up.
const SHOULDER = [0.6, 0.9, 0.75, 1.0];
const SHOULDER_HDR = [0.6, 0.9, 2.0, 4.0];
const SHOULDER_BLOOM = 2.5;
const DEPTH_BIAS = 0.6;                // m: the glow sprite drawn this much nearer than the lamp
const HALO_BLOOM = 0.35;

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
    this.onGround = false;
    this.time = 0;
    this.exposure = 1;                       // the renderer's, read when the glows are drawn
    this.haloGain = 1;
    this.taxi = 0;                           // 0 landing beam .. 1 taxi beam (weight on wheels)
    this._bloom = false;
    this._linear = false;                    // drawn into a float target (the HDR chain)
    this._sh = [0, 0, 0, 0];
    this._ac = [0, 0];
    this._level = { nav: 0, tail: 0, anticoll: 0, formation: 0, landing: 0 };
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
      const peak = Math.max(colour.r, colour.g, colour.b);
      const sat = 1 - Math.min(colour.r, colour.g, colour.b) / Math.max(peak, 1e-6);
      this.sources.push({
        name: l.name, role, node, pos, lensDir, outboard, colour, peak,
        // how saturated the light is: the shader's shoulder caps it lower the more it is (SHOULDER)
        sat,
        lensSize: role === 'tail' ? 0 : (l.size || 0.05),
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
    this.glowUniforms = { ...fogUniforms(), uPixelRatio: { value: 1 }, uExposure: { value: 1 },
      uShoulder: { value: new THREE.Vector4().fromArray(SHOULDER) }, uDepthBias: { value: DEPTH_BIAS } };
    // On the canvas the glows are display values already under their shoulder: two of them added up
    // (the wing-tip and the fuselage light of one side, seen from abeam) or one added to the lit skin
    // by day would clip towards white, so there the brighter of glow and frame wins, channel by
    // channel (MaxEquation: the hue survives, over a dark sky it is the same as adding). On the HDR
    // chain's float target the glows are radiance and add up (its tone curve follows).
    this.glowMaterial = new THREE.ShaderMaterial({
      name: 'F35_LightGlow', uniforms: this.glowUniforms, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
      transparent: true, depthWrite: false, depthTest: true, toneMapped: true, fog: true,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    this.points = new THREE.Points(geo, this.glowMaterial);
    this.points.name = 'F35_LightGlows';
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.visible = false;
    this.points.onBeforeRender = (renderer) => {
      this.exposure = fxExposure.get(renderer);
      this._bloom = fxEnv.bloomOn(renderer);
      this._linear = fxEnv.linearTarget(renderer);
      // a blend state, not a program: switching it rebuilds nothing
      this.glowMaterial.blendEquation = this._linear ? THREE.AddEquation : THREE.MaxEquation;
      const u = this.glowUniforms;
      u.uPixelRatio.value = renderer.getPixelRatio();
      u.uExposure.value = Math.max(0.05, this.exposure);
      const sh = this._shoulder();
      u.uShoulder.value.set(sh[0], sh[1], sh[2], sh[3]);
    };
    root.add(this.points);
    // the lamp's beams for the ground pool (world frame; AircraftFX reads them): `direction`,
    // `intensity` and `spread` are those of the beam that dominates (older readers), `beams` both
    this.landing = {
      on: false, position: new THREE.Vector3(), direction: new THREE.Vector3(0, 0, -1),
      intensity: LANDING.cd, spread: LANDING.spread, spill: LANDING_SPILL,
      beams: [
        { name: 'landing', direction: new THREE.Vector3(0, 0, -1), intensity: LANDING.cd, spread: LANDING.spread, weight: 1 },
        { name: 'taxi', direction: new THREE.Vector3(0, 0, -1), intensity: TAXI.cd, spread: TAXI.spread, weight: 0 },
      ],
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

  /**
   * lights: {nav, landing, formation, anticoll} (booleans or 0..1); gear 0..1; onGround: weight on
   * wheels (the taxi beam).
   */
  set(lights, gear, onGround) {
    if (lights) {
      for (const k of ['nav', 'anticoll', 'landing']) if (k in lights) this.state[k] = !!lights[k];
      if ('formation' in lights) this.state.formation = typeof lights.formation === 'number'
        ? Math.min(1, Math.max(0, lights.formation)) : (lights.formation ? 1 : 0);
    }
    if (Number.isFinite(gear)) this.gear = gear;
    if (onGround !== undefined) this.onGround = !!onGround;
  }

  /**
   * Visibility gain of the glows in the dark (darkness 0..1, fxEnv): 1 by day, ~200 at night, where
   * the exposure stops at 40 and a dark-adapted eye would go on far beyond it.
   */
  static nightGain(darkness) {
    const d = Math.min(1, Math.max(0, darkness || 0));
    return 1 + 203 * d * d;
  }

  /** The glows' shoulder for the target last drawn into: [knee, cap] saturated, [knee, cap] white. */
  _shoulder() {
    const src = this._linear ? SHOULDER_HDR : SHOULDER;
    const k = this._linear && this._bloom ? SHOULDER_BLOOM : 1;
    for (let i = 0; i < 4; i++) this._sh[i] = src[i] * k;
    return this._sh;
  }

  /** viewportHeight: canvas height in CSS px (pixel sizes of the glows). */
  update(dt, camera, viewportHeight = 1080) {
    dt = Math.max(0, dt || 0);
    this.time += dt;
    const st = this.state;
    const landingOn = st.landing && this.gear > 0.9;
    if (st.anticoll) anticollPattern(this.time, this._ac);
    else this._ac[0] = this._ac[1] = 0;
    const top = this._ac[0], bottom = this._ac[1];
    this.beaconUniforms.uBeacon.value.set(top, bottom);
    const level = this._level;
    level.nav = st.nav ? 1 : 0; level.tail = level.nav; level.anticoll = st.anticoll ? 1 : 0;
    level.formation = st.formation; level.landing = landingOn ? 1 : 0;
    // the beams in the world (for the ground pool): taxi with weight on wheels, landing airborne
    this.taxi += ((this.onGround ? 1 : 0) - this.taxi) * (1 - Math.exp(-dt / BEAM_TAU));
    const ls = this._landingSource;
    const L = this.landing;
    L.on = landingOn && !!ls;
    if (ls) {
      ls.node.updateWorldMatrix(true, false);
      L.position.copy(ls.pos).applyMatrix4(ls.node.matrixWorld);
      _m.setFromMatrix4(ls.node.matrixWorld);
      const bl = L.beams[0], bt = L.beams[1];
      bl.direction.copy(LANDING.axis).applyMatrix3(_m).normalize();
      bt.direction.copy(TAXI.axis).applyMatrix3(_m).normalize();
      bl.weight = 1 - this.taxi;
      bt.weight = this.taxi;
      const main = this.taxi > 0.5 ? bt : bl;
      L.direction.copy(main.direction);
      L.intensity = main.intensity * main.weight;
      L.spread = main.spread;
    }
    let landingLens = 0;
    if (camera && ls && landingOn) {
      camera.getWorldPosition(_c).sub(L.position).normalize();
      landingLens = this._beams(_c);
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
    const dark = fxEnv.darkness;
    const G = AircraftLights.nightGain(dark);
    const haloGain = this.haloGain * (this._bloom ? HALO_BLOOM : 1);
    // the display brightness the shader's shoulder caps a saturated / a white light at
    const sh = this._shoulder();
    const capSat = sh[1], capWhite = sh[3];
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
          // energy-conserving: the profile (1 + 2 r^2 / a^2)^-2 holds pi a^2 / 2 px (GLOW_FRAG); one
          // brighter than the shoulder lets it show looks bigger through its skirt, never a flat disc
          core = E * G / (omegaPx * Math.PI * coreR * coreR / 2) * coreFade;
          // a little wider once it is far over the cap (the skirt alone would leave a 1 px pin)
          const over = core * exposure * s.peak / (capWhite + (capSat - capWhite) * s.sat);
          if (over > 4) {
            const grow = Math.min(1.6, Math.sqrt(over / 4));
            coreR *= grow;
            core /= grow * grow;
          }
          core = Math.min(core, 2000);
          // halo: display brightness and size grow with the light at the camera; dark only, except
          // a light shining straight into the camera (a landing lamp head-on dazzles by day too)
          const seen = E * G * exposure;
          const glare = Math.max(dark, smooth(E * exposure, 3e-4, 6e-3));
          const peak = Math.min(1.0, 18 * seen) * glare * haloGain;
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

  /** Relative intensity of the lamp towards unit vector v (world, lamp -> viewer): both beams. */
  _beams(v) {
    const L = this.landing;
    let I = 0;
    for (const b of L.beams) {
      if (b.weight <= 0) continue;
      const x = Math.acos(Math.min(1, Math.max(-1, b.direction.dot(v)))) / b.spread;
      I += b.weight * (b.intensity / LANDING.cd) * Math.exp(-x * x);
    }
    // the spill is the lens and the reflector's rim lit from inside: it reaches the side, never
    // behind the lamp (the housing and the gear leg hide it), so no glare from a chase seat
    return I + LANDING_SPILL * smooth(L.direction.dot(v), -0.25, 0.15);
  }

  /** Relative intensity of a light towards unit vector v (world, light -> camera); m: node normal matrix. */
  _pattern(s, v, m) {
    if (s.role === 'landing') return this._beams(v);
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

  /** The meshes with shader programs of their own (AircraftFX compiles them before first use). */
  effectMeshes() { return [this.points]; }
}
