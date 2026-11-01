// Afterburner plume and nozzle glow of the F135.
//
// The plume is a ray-marched emitting volume inside a cylinder behind the nozzle exit (no depth
// write): what photos of F-35s in burner show.
//   * by day: short and mostly transparent, an orange-yellow core that fills the exit and tapers
//     away within ~1.5-2 m, a faint blue at the nozzle lip, the shock diamonds pale and close in;
//   * at night: the same flame, much brighter against the dark, the diamonds (Mach disks) a bright
//     yellow-white train inside the core, attached to it (each weighted by the core where it sits,
//     so none floats past the visible flame).
// No white ball, no pink or lavender tail: each channel saturates at uSat (a hot orange-yellow) and
// the flame hides what is behind it by its opacity (1 - exp(-uKappa * luminance)), blended as
// premultiplied colour + background * (1 - alpha) (a soot-light flame: mostly transparent).
//
// Brightness and the camera's exposure: the flame is a light source of fixed radiance, but the sim's
// auto exposure (0.9 at noon, up to 40 at night) would turn it into a blown-out white blob at dusk
// and night. As a camera exposing for the scene but not blind to a bright flame would, the plume and
// the throat glow are written as display brightness that grows only with the 4th root of the
// exposure (uExpComp = (exposure / 0.93)^0.25 / exposure), read from the renderer when drawn.
//
// The throat glow (a disc inside the nozzle, seen from behind through the petals): engine heat
// (a dull red at idle and an orange at MIL that only the dark shows) plus the burner (white-hot).
// The nozzle petals are a morph target driven by AircraftVisual (open at idle and in burner).
//
// Frame: everything is built in the BODY frame (+Z aft); `exit` is the nozzle exit centre.

import * as THREE from 'three';
import { fxExposure } from './fxshared.js';

const PLUME_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform vec3 uScale;         // the mesh's scale: unit cylinder -> metres
  varying vec3 vLocal;
  void main() {
    vLocal = position * uScale;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }`;

const PLUME_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uCamLocal;     // camera position in the plume frame
  uniform float uLen;         // bounding length (m)
  uniform float uCore;        // visible core length (m)
  uniform float uR0;          // radius at the exit (m)
  uniform float uRmax;        // bounding cylinder radius (m)
  uniform float uAb;          // 0..1
  uniform float uTime;
  uniform float uGain;        // brightness (burner fill)
  uniform float uExpComp;     // exposure compensation (see the header)
  uniform float uDay;         // 1 against a daylight sky, 0 at night (from the exposure)
  uniform vec3 uSat;          // radiance each channel saturates at (display, linear)
  uniform float uKappa;       // opacity per unit of integrated luminance
  uniform float uSpacing;     // shock-cell spacing (m)
  uniform int uSteps;
  varying vec3 vLocal;

  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float vnoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }

  // core radius and axial weight of the flame at z (m downstream of the exit)
  float coreRadius(float z) { float s = clamp(z / uCore, 0.0, 1.0); return uR0 * (0.93 - 0.62 * pow(s, 1.3)) + 0.02; }
  float coreFall(float z) { float s = clamp(z / uCore, 0.0, 1.0); return pow(1.0 - s, 1.7); }
  // by day the faint back half of the flame is lost against the sky (drawn, it would only tint the
  // sky pink): it fades out over the core's back half; at night all of it shows
  float dayTail(float s) { return mix(1.0, 1.0 - smoothstep(0.3, 0.75, s), uDay); }

  // emission (display-referred linear RGB per metre) at a point of the plume frame
  vec3 emission(vec3 p) {
    float z = p.z;
    if (z < 0.0 || z > uLen) return vec3(0.0);
    float rho = length(p.xy);
    float s = z / uCore;
    float r = coreRadius(z);
    float fall = coreFall(z);
    float turb = 0.75 + 0.5 * vnoise(vec3(p.xy * 5.0, z * 3.0 - uTime * 26.0));
    // core: yellow-orange at the exit -> orange -> a deep orange tail (never pink)
    float env = exp(-pow(rho / r, 2.0) * 2.6) * fall * turb * dayTail(s);
    vec3 c1 = vec3(1.0, 0.62, 0.24), c2 = vec3(1.0, 0.44, 0.13);
    vec3 c3 = mix(vec3(0.92, 0.30, 0.08), vec3(1.0, 0.46, 0.12), uDay);
    vec3 col = (s < 0.4 ? mix(c1, c2, s / 0.4) : mix(c2, c3, clamp((s - 0.4) / 0.6, 0.0, 1.0))) * env * 1.8;
    // faint blue at the nozzle lip (the outer mixing layer right behind the exit)
    float lip = exp(-pow((rho - 0.85 * uR0) / (0.16 * uR0), 2.0)) * exp(-z / 0.30);
    col += vec3(0.30, 0.42, 1.0) * lip * 0.55;
    // shock diamonds: a train of Mach disks inside the core, spacing fixed by the nozzle pressure
    // ratio, each one as bright as the core around it (attached: none beyond the visible flame)
    float z0 = 0.62 * uSpacing;
    float k = floor((z - z0) / uSpacing + 0.5);
    if (k >= 0.0 && k < 5.0) {
      float zk = z0 + k * uSpacing;
      float rk = 0.52 * coreRadius(zk);
      float hk = 0.30 * uSpacing;
      float d = rho / rk + abs(z - zk) / hk;
      float ik = coreFall(zk) * dayTail(zk / uCore) * pow(1.0 - k / 5.0, 1.2)
        * (0.85 + 0.3 * vnoise(vec3(k * 3.1, uTime * 9.0, 0.0)));
      col += vec3(1.0, 0.82, 0.55) * pow(max(1.0 - d, 0.0), 1.2) * ik * 2.4;
    }
    return col;
  }

  void main() {
    #include <logdepthbuf_fragment>
    // ray from the camera through this fragment, clipped to the bounding cylinder
    vec3 ro = uCamLocal;
    vec3 rd = normalize(vLocal - ro);
    float a = dot(rd.xy, rd.xy);
    float b = dot(ro.xy, rd.xy);
    float c = dot(ro.xy, ro.xy) - uRmax * uRmax;
    float t0 = 0.0, t1 = 1e6;
    if (a > 1e-8) {
      float disc = b * b - a * c;
      if (disc <= 0.0) discard;
      float sq = sqrt(disc);
      t0 = (-b - sq) / a; t1 = (-b + sq) / a;
    } else if (c > 0.0) discard;
    if (abs(rd.z) > 1e-6) {
      float za = (0.0 - ro.z) / rd.z, zb = (uLen - ro.z) / rd.z;
      t0 = max(t0, min(za, zb)); t1 = min(t1, max(za, zb));
    } else if (ro.z < 0.0 || ro.z > uLen) discard;
    t0 = max(t0, 0.0);
    if (t1 <= t0) discard;
    float dt = (t1 - t0) / float(uSteps);
    float jitter = hash(vec3(gl_FragCoord.xy, uTime));
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 48; i++) {
      if (i >= uSteps) break;
      vec3 p = ro + rd * (t0 + (float(i) + jitter) * dt);
      acc += emission(p);
    }
    acc *= dt * uGain;
    float alpha = 1.0 - exp(-uKappa * dot(acc, vec3(0.2126, 0.7152, 0.0722)));
    vec3 col = uSat * (vec3(1.0) - exp(-acc / uSat)) * uExpComp;
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const GLOW_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }`;

const GLOW_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColour;       // display-referred
  uniform float uExpComp;
  varying vec2 vUv;
  void main() {
    #include <logdepthbuf_fragment>
    float r = length(vUv - 0.5) * 2.0;
    float g = exp(-r * r * 2.5) * (1.0 - smoothstep(0.85, 1.0, r));
    gl_FragColor = vec4(uColour * g * uExpComp, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

/** Exposure compensation: display brightness grows with exposure^0.25 (1 at the noon 0.93). */
export function flameExposureComp(exposure) {
  const e = Math.max(0.05, exposure || 1);
  return Math.pow(e / 0.93, 0.25) / e;
}

export class Afterburner {
  /**
   * @param {object} nozzle  rig.info.nozzle (body frame): exit, radius, radiusAB, axis, throat, throatRadius
   */
  constructor(nozzle) {
    this.group = new THREE.Group();
    this.group.name = 'Afterburner';
    const exit = new THREE.Vector3().fromArray(nozzle.exit);
    const axis = new THREE.Vector3().fromArray(nozzle.axis || [0, 0, 1]).normalize();
    this.group.position.copy(exit).addScaledVector(axis, 0.02);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    this.maxLen = 5.0;                 // bounding length at full burner (the faint tail at night)
    this.r0 = nozzle.radiusAB || 0.56;
    this.rMax = this.r0 * 1.15;
    this.steps = 32;
    // bounding cylinder (z 0..1, scaled to the plume length), drawn from the inside so the
    // shader runs with the camera in the plume too
    const geo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, false);
    geo.rotateX(Math.PI / 2);          // axis along +Z
    geo.translate(0, 0, 0.5);
    // (the plume starts 2 cm behind the exit plane: no z-fight with the petal tips)
    this.uniforms = {
      uCamLocal: { value: new THREE.Vector3() },
      uLen: { value: 4.0 }, uCore: { value: 3.0 }, uR0: { value: this.r0 }, uRmax: { value: this.rMax },
      uAb: { value: 0 }, uTime: { value: 0 }, uGain: { value: 1.0 }, uScale: { value: new THREE.Vector3(1, 1, 1) },
      uSat: { value: new THREE.Vector3(1.0, 0.56, 0.20) }, uKappa: { value: 0.35 },
      uSpacing: { value: 0.8 }, uSteps: { value: this.steps }, uExpComp: { value: 1 }, uDay: { value: 1 },
    };
    // premultiplied "over": the tone-mapped flame colour + the background * (1 - opacity)
    this.plumeMat = new THREE.ShaderMaterial({
      name: 'F35_AB_Plume', uniforms: this.uniforms, vertexShader: PLUME_VERT, fragmentShader: PLUME_FRAG,
      transparent: true, depthWrite: false, side: THREE.BackSide, toneMapped: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.plume = new THREE.Mesh(geo, this.plumeMat);
    this.plume.name = 'AB_Plume';
    this.plume.renderOrder = 4;
    this.plume.castShadow = false;
    this.plume.receiveShadow = false;
    this.plume.visible = false;
    this.plume.onBeforeRender = (renderer) => {
      const e = fxExposure.get(renderer);
      this.uniforms.uExpComp.value = flameExposureComp(e);
      this.uniforms.uDay.value = 1 - THREE.MathUtils.smoothstep(e, 2, 8);
    };
    this.group.add(this.plume);
    // throat glow, a little inside the exit, facing aft
    const throatZ = nozzle.throat ? (nozzle.throat[2] - nozzle.exit[2]) : -0.4;
    this.glowUniforms = { uColour: { value: new THREE.Color(0, 0, 0) }, uExpComp: { value: 1 } };
    this.glow = new THREE.Mesh(
      new THREE.CircleGeometry((nozzle.throatRadius || 0.4) * 1.05, 32),
      new THREE.ShaderMaterial({
        name: 'F35_Nozzle_Glow', uniforms: this.glowUniforms, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: true,
      }));
    this.glow.name = 'Nozzle_Glow';
    this.glow.position.set(0, 0, throatZ + 0.02);
    this.glow.renderOrder = 4;
    this.glow.castShadow = false;
    this.glow.receiveShadow = false;
    this.glow.onBeforeRender = (renderer) => {
      this.glowUniforms.uExpComp.value = flameExposureComp(fxExposure.get(renderer));
    };
    this.group.add(this.glow);
    this.ab = 0;
    this.throttle = 0;
    this.time = 0;
    this._inv = new THREE.Matrix4();
    this._cam = new THREE.Vector3();
  }

  /** Ray-march steps (quality): 16 low, 24 medium, 32 high. */
  setSteps(n) {
    this.steps = Math.max(8, Math.min(48, Math.round(n)));
    this.uniforms.uSteps.value = this.steps;
  }

  /** ab 0..1 (afterburner), throttle 0..1 (0.75 MIL), for the throat glow. */
  set(ab, throttle) {
    this.ab = Math.min(1, Math.max(0, ab || 0));
    if (Number.isFinite(throttle)) this.throttle = throttle;
  }

  update(dt, camera) {
    this.time += dt;
    const ab = this.ab;
    const on = ab > 0.005;
    this.plume.visible = on;
    const u = this.uniforms;
    if (on) {
      // visible core 1.4 m at light-off to 3.2 m at full burner; the bounding volume a little longer
      const core = 1.4 + 1.8 * Math.pow(ab, 0.8);
      const len = Math.min(this.maxLen, core * 1.3);
      this.plume.scale.set(this.rMax, this.rMax, len);
      u.uScale.value.copy(this.plume.scale);
      u.uLen.value = len;
      u.uCore.value = core;
      u.uAb.value = ab;
      u.uTime.value = this.time % 1000;
      u.uGain.value = 0.35 + 0.65 * Math.pow(ab, 0.7);
      u.uSpacing.value = 0.72 + 0.12 * ab;              // shock cells stretch a little with pressure ratio
      if (camera) {
        // camera in the plume frame (unscaled: the group's frame, metres)
        this.group.updateWorldMatrix(true, false);
        this._inv.copy(this.group.matrixWorld).invert();
        camera.getWorldPosition(this._cam);
        u.uCamLocal.value.copy(this._cam).applyMatrix4(this._inv);
      }
    }
    // throat glow (display-referred): engine heat that only the dark shows, plus the burner
    const thr = Math.min(1, Math.max(0, this.throttle));
    const heat = 0.012 + 0.10 * Math.pow(Math.min(thr, 0.75) / 0.75, 2);
    const c = this.glowUniforms.uColour.value;
    c.setRGB(1.0, 0.28, 0.06).multiplyScalar(heat);
    if (on) {
      const k = 0.55 * Math.pow(ab, 0.7);
      c.r += 1.0 * k; c.g += 0.55 * k; c.b += 0.20 * k;
    }
  }
}
