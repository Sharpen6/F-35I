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
//              lights). Two beams: the landing beam, aimed 20 deg below the body axis (on a 3 deg
//              approach at ~13 deg alpha the nose is ~10 deg up, so the beam meets the runway 10 deg
//              below the horizon: 170 m ahead from 30 m up, 370 m from 65 m, and still ~6 deg down at
//              the 14 deg pitch of the touchdown: aimed along the glide path it lit the ground only
//              a kilometre ahead, under the night's light, and above the horizon in the flare), and
//              the wider taxi beam, 5 deg below the axis (with the jet on its wheels it lights the
//              runway from ~5 m out). The taxi beam takes over with weight on wheels, the landing
//              beam once airborne (blended over ~0.8 s).
//
// Photometry. Scene radiance units: the sun's 4.0 is ~128 klx (sim/js/env), so 1 unit of radiance
// is LUX_PER_UNIT = 32,000 cd/m^2 and 1 unit of illuminance 32,000 lux. Lens emission (LENS) is in
// those units.
// The glows are ONE THREE.Points draw for all the lights of an aircraft; per light:
//   core   the lens while it is smaller than a few pixels: the light reaching the camera, I / d^2,
//          spread over a ~2.5 px dot (energy-conserving), so a distant light stays a point of the
//          right brightness; it fades out as the lens itself (emissive material) becomes visible.
//          The dot's profile has a soft skirt, (1 + 2 r^2 / a^2)^-2 (a lens's spread, not a
//          Gaussian): a core brighter than the display can show looks bigger, as glare does, and
//          fades out at its edge instead of ending as a flat disc. The shader's hue-preserving
//          shoulder keeps a red or green light red or green at any distance (no white core with a
//          coloured rim); on the canvas it is the glow's whole tone curve (a tone mapper on top
//          bleaches a bright green towards white). On the HDR chain's float target the glows (and
//          the lenses) write their mark as lights (js/env/emitters.js): from sunset Post.js tone-maps
//          them by their hue and night vision leaves them alone. The sprite sits a little nearer
//          the camera than the lamp (uDepthBias), so the lamp's own housing and the wing's edge
//          beside it do not bite into it.
//   halo   eye / lens glare, in proportion to the light reaching the camera, only once it is dark
//          (fxEnv.darkness: from the sun's elevation, the same whatever the exposure meter): by day
//          a lit lens is a small bright dot, never an LED glow. When the frame goes through the HDR
//          chain's bloom (fxEnv.bloomOn) the halo is fainter and the shoulder higher: the bloom then
//          makes most of the glare.
// Lights at night (js/env/README.md): the light reaching the camera is seen by the eye's adaptation
// to the lights, not by the meter's exposure: E x fxEnv.lightGain (1 by day and in the dusk,
// 1400 / exposure once the sky is dark), the same rule as the airfield lights and street lamps,
// so a position light looks the same at exposure 40 and at 285. And as for those (the rule for
// point lights, js/world/AirportLights.js), a light many times over the threshold of a point source
// on the night's ground is at least as bright on the display as that excess says (visibleFloor;
// at night only: by day the jet's lights keep their look), so it stays a dot for miles; and its
// centre is no brighter on the display than any point light's (NIGHT_PEAK 64, where the bloom
// clamps), so a light a few metres from the camera is a small hard point, not a ball. At night a
// lens is a coloured surface at LENS_NIGHT on the display (an LED lens is ~100,000 cd/m^2: thousands
// there, white whatever its colour) and its glow carries the brightness.
// The exposure is read from the renderer (toneMappingExposure) when the glows are drawn.
//
// Light positions and directions come from rig.info.lights (node-relative, model frame), so the
// glows ride on the node that carries the lens (the landing lamp swings up with the nose leg).

import * as THREE from 'three';
import { fxExposure, fxEnv, fogUniforms, FOG_PARS_GLSL, LUX_PER_UNIT } from './fxshared.js';
import { EMITTER_GLSL, emitterBlending } from '../env/emitters.js';

const ROLE = { nav: 'nav', beacon: 'anticoll', anticoll: 'anticoll', formation: 'formation', landing: 'landing' };
const CD = 1 / LUX_PER_UNIT;            // cd/m^2 -> scene radiance units; lux -> illuminance units

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
const LANDING = { axis: beamAxis(-20), cd: GLOW.landing.cd, spread: DEG(7) };   // 1/e half widths
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
  uniform float uNightSize;  // 0 by day .. 1 at night: the sprite reaches where the skirt is invisible
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
    // at night against a black sky: out to where the skirt is under 0.002 on the display, past
    // the fade at the sprite's edge (a skirt cut off there showed as the edge of a disc)
    float dc = max(aCore.r, max(aCore.g, aCore.b)) * uExposure;
    rc = max(rc, uNightSize * aCore.a * sqrt(max(0.0, sqrt(dc / 0.002) - 1.0) * 0.5) / 0.8);
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
  ${EMITTER_GLSL}
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
      // cap); three's AgX on top of it would bleach a saturated green or red towards white
      gl_FragColor = vec4(col * uExposure, 1.0);
    #else
      // a float target: the HDR chain's tone curve and bloom follow, the light's mark in the alpha
      // (js/env/emitters.js: from sunset Post.js keeps its hue, night vision leaves it alone)
      gl_FragColor = vec4(col, emitterAlpha(emitterShare(max(col.r, max(col.g, col.b)) * uExposure)));
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
// light, then for a white one. On the canvas the shoulder is the whole tone curve (display 0..1): a
// saturated green tops out at ~(85, 243, 152), a red at ~(243, 66, 46). On a float target the HDR
// chain's tone curve follows and with its bloom both scale up (the bloom takes the excess): by day
// that is AgX, which keeps a saturated colour up to ~2 on the display (a red at 2.25 shows as
// (249, 157, 132)); from sunset the glows go through Post.js's hue-preserving curve for lights.
const SHOULDER = [0.6, 0.9, 0.75, 1.0];
const SHOULDER_HDR = [0.6, 0.9, 2.0, 4.0];
const SHOULDER_BLOOM = 2.5;
const DEPTH_BIAS = 0.6;                // m: the glow sprite drawn this much nearer than the lamp
const HALO_BLOOM = 0.35;
// The most a light's centre shows on the display at night (radiance x exposure): where the HDR
// chain's bloom clamps, the cap every point light has (js/world/AirportLights.js
// POINT_LIGHT_FRAG_GLSL). At night the lights near the jet hold far more than that (a 40 cd tail
// light 18 m away ~1,000): uncapped, the core's skirt stays over white for ~6 px around it and the
// bloom makes a ball of it; capped, it is a small hard point with a modest bloom, as the airfield's.
const NIGHT_PEAK = 64;
// A lens at night on the display (radiance x exposure, its brightest channel): a saturated colour
// that every tone curve keeps (the glow on top of it is the light's brightness).
const LENS_NIGHT = 0.8;

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
        const ec = m.emissive || { r: 1, g: 1, b: 1 };
        this.lenses.push({ mat: m, role: spec.role, on: spec.on, peak: Math.max(ec.r, ec.g, ec.b, 1e-3) });
        m.emissiveIntensity = 0;
        if (spec.role === 'anticoll') this._splitBeacons(m);
        this._markLens(m);
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
      uShoulder: { value: new THREE.Vector4().fromArray(SHOULDER) }, uDepthBias: { value: DEPTH_BIAS },
      uNightSize: { value: 0 } };
    // On the canvas the glows are display values already under their shoulder: two of them added up
    // (the wing-tip and the fuselage light of one side, seen from abeam) or one added to the lit skin
    // by day would clip towards white, so there the brighter of glow and frame wins, channel by
    // channel (MaxEquation: the hue survives, over a dark sky it is the same as adding). On the HDR
    // chain's float target the glows are radiance and add up (its tone curve follows), their mark
    // as lights MIN-blended into the alpha (js/env/emitters.js).
    this.glowMaterial = emitterBlending(new THREE.ShaderMaterial({
      name: 'F35_LightGlow', uniforms: this.glowUniforms, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
      transparent: true, depthWrite: false, depthTest: true, toneMapped: true, fog: true,
    }), THREE.MaxEquation);
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
      u.uNightSize.value = smooth(fxEnv.lightNight, 0, 0.1);
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

  /**
   * A lens writes its mark as a light (js/env/emitters.js) where its own light makes most of what
   * the pixel shows: from sunset Post.js shows it by its hue and night vision leaves it alone. By
   * day (the HDR chain's lights' path off) nothing changes.
   */
  _markLens(mat) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      if (prev) prev.call(mat, sh, r);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${EMITTER_GLSL}`)
        .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        {
          float lensE = max(totalEmissiveRadiance.r, max(totalEmissiveRadiance.g, totalEmissiveRadiance.b));
          float lensT = max(outgoingLight.r, max(outgoingLight.g, outgoingLight.b));
          float lensW = smoothstep(0.35, 0.8, lensE / max(lensT, 1e-12));
          if (lensW > 0.0) gl_FragColor.a = emitterAlpha(lensW);
        }`);
    };
    const key = mat.customProgramCacheKey.bind(mat);
    mat.customProgramCacheKey = () => key() + '+f35lens';
    mat.needsUpdate = true;
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
   * The rule for point lights (js/world/AirportLights.js POINT_LIGHT_VERT_GLSL): the least display
   * brightness of the centre of a light V times over the threshold of a point source (as star
   * magnitudes: 0 at V 1, 0.35 at V 8, up to 0.8: a saturated colour every tone curve keeps).
   */
  static visibleFloor(V) {
    const lv = Math.log2(Math.max(V, 1e-6));
    return Math.min(1, Math.max(0, lv / 3)) * Math.min(0.35 + 0.06 * Math.max(lv - 3, 0), 0.8);
  }

  /**
   * The most a light's core may hold (scene radiance) for the exposure, the brightest channel of its
   * colour and fxEnv.lightNight: NIGHT_PEAK on the display at night, eased in through the blue hour
   * (NIGHT_PEAK / lightNight), no cap by day (the jet's lights keep their day look).
   */
  static coreCap(exposure, peak, night) {
    // eased in over the first tenth of lightNight (the sun from ~-4.5 to ~-5 deg) so it does not
    // pop; then the cap itself, whatever the exposure (dividing by lightNight let a blue-hour tail
    // light hold 5 times the cap and grow into a ball)
    const k = smooth(night, 0, 0.1);
    return k > 0 ? NIGHT_PEAK / (Math.max(exposure, 1e-4) * Math.max(peak, 1e-4) * k) : Infinity;
  }

  /**
   * A lens's emissive intensity e at night (peak: its emissive colour's brightest channel): at most
   * LENS_NIGHT on the display, eased in as coreCap is; by day the lens keeps its own value.
   */
  static lensCap(e, exposure, peak, night) {
    const k = smooth(night, 0, 0.1);
    return k > 0 ? Math.min(e, LENS_NIGHT / (Math.max(exposure, 1e-4) * Math.max(peak, 1e-4) * k)) : e;
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
    // at night a lens shows its colour (LENS_NIGHT) and its glow the brightness: an LED lens at its
    // ~100,000 cd/m^2 was thousands on the display, a white dot whatever its colour
    const lensExposure = Math.max(0.05, this.exposure);
    for (const l of this.lenses) {
      let e = l.on * level[l.role];
      if (l.role === 'landing') e *= 1 + 120 * landingLens;
      l.mat.emissiveIntensity = AircraftLights.lensCap(e, lensExposure, l.peak, fxEnv.lightNight);
    }
    const any = level.nav || level.anticoll || level.landing;
    this.points.visible = !!(any && camera);
    if (!this.points.visible) return;
    // ---------------------------------------------------------------- glows
    const exposure = Math.max(0.05, this.exposure);
    const dark = fxEnv.darkness;
    // lights at night: the eye's adaptation to the lights (js/env); the threshold of a point light
    const G = fxEnv.lightGain;
    const threshold = fxEnv.pointThreshold;
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
          const Elux = cd / (d * d);                           // illuminance at the camera (lux)
          const E = Elux * CD;                                 // (scene units)
          const lensPx = s.lensSize / (d * pxAngle);
          const coreFade = s.lensSize > 0 ? 1 - smooth(lensPx, 1.5, 4.0) : 1;
          // energy-conserving: the profile (1 + 2 r^2 / a^2)^-2 holds pi a^2 / 2 px (GLOW_FRAG); one
          // brighter than the shoulder lets it show looks bigger through its skirt, never a flat disc
          core = E * G / (omegaPx * Math.PI * coreR * coreR / 2);
          // at night never fainter than the light's excess over the threshold says (a far light)
          core = Math.max(core, AircraftLights.visibleFloor(Elux / threshold) * dark / (exposure * s.peak)) * coreFade;
          // a little wider once it is far over the cap (the skirt alone would leave a 1 px pin)
          const over = core * exposure * s.peak / (capWhite + (capSat - capWhite) * s.sat);
          if (over > 4) {
            const grow = Math.min(1.6, Math.sqrt(over / 4));
            coreR *= grow;
            core /= grow * grow;
          }
          // at night no brighter on the display than any point light (NIGHT_PEAK): a hard point
          core = Math.min(core, 2000, AircraftLights.coreCap(exposure, s.peak, fxEnv.lightNight));
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
