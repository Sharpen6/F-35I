// Afterburner plume and nozzle glow of the F135.
//
// The plume is a ray-marched emissive volume inside a cylinder behind the nozzle exit (additive,
// no depth write): a tapering orange core that turns pink towards the tail, with a train of
// shock diamonds (Mach disks), bright yellow-white near the nozzle and fading downstream - the
// look of the Blender AB_Flame (4.6 m at full burner, first diamond 0.5 m behind the exit,
// 0.78 m apart). Length, brightness and diamond spacing follow `ab` (0..1); a little turbulent
// flicker keeps it alive. A disc of hot glow sits in the nozzle throat: dull red at idle, orange
// at MIL, white-hot in burner (seen from behind, through the petals).
//
// Frame: everything is built in the BODY frame (+Z aft); `exit` is the nozzle exit centre.

import * as THREE from 'three';

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
  uniform float uLen;         // plume length (m)
  uniform float uR0;          // radius at the exit (m)
  uniform float uRmax;        // bounding cylinder radius (m)
  uniform float uAb;          // 0..1
  uniform float uTime;
  uniform float uGain;
  varying vec3 vLocal;

  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float vnoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }

  // emission (linear RGB per metre) at a point of the plume frame (z downstream from the exit)
  vec3 emission(vec3 p) {
    float z = p.z;
    if (z < 0.0 || z > uLen) return vec3(0.0);
    float s = z / uLen;
    float rho = length(p.xy);
    float turb = 0.7 + 0.6 * vnoise(vec3(p.xy * 4.0, z * 2.5 - uTime * 23.0));
    // envelope: fills the exit, swells a little, then tapers away; orange -> red -> pink
    float r = max(uR0 * (0.90 + 0.10 * smoothstep(0.0, 0.2, s) - 0.62 * s * s), 0.05);
    float env = exp(-pow(rho / r, 2.0) * 3.0) * pow(1.0 - s, 2.0) * turb;
    vec3 c1 = vec3(1.0, 0.55, 0.16), c2 = vec3(1.0, 0.30, 0.16), c3 = vec3(0.78, 0.22, 0.45);
    vec3 envCol = s < 0.45 ? mix(c1, c2, s / 0.45) : mix(c2, c3, (s - 0.45) / 0.55);
    vec3 col = envCol * env * 1.5;
    // flame front at the exit: yellow-white across the nozzle
    float front = exp(-pow(rho / (0.82 * uR0), 4.0)) * (1.0 - smoothstep(0.0, 0.4, z));
    col += vec3(1.0, 0.70, 0.36) * front * 3.0;
    // shock diamonds (Mach disks): L1 'diamond' shapes on the axis, spacing scaled with the plume
    float stp = 0.78 * uLen / 4.6;
    float z0 = 0.5 * uLen / 4.6;
    float k = floor((z - z0) / stp + 0.5);
    if (k >= 0.0 && k < 6.0) {
      float zk = z0 + k * stp;
      float rk = 0.50 * uR0 * (1.0 - 0.1 * k);
      float hk = 0.32 * stp;
      float d = rho / rk + abs(z - zk) / hk;
      float ik = pow(1.0 - k / 6.0, 1.7) * (0.85 + 0.3 * vnoise(vec3(k * 3.1, uTime * 9.0, 0.0)));
      col += vec3(1.0, 0.76, 0.46) * pow(max(1.0 - d, 0.0), 1.3) * ik * 2.0;
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
    const int N = 32;
    float dt = (t1 - t0) / float(N);
    float jitter = hash(vec3(gl_FragCoord.xy, uTime));
    vec3 acc = vec3(0.0);
    for (int i = 0; i < N; i++) {
      vec3 p = ro + rd * (t0 + (float(i) + jitter) * dt);
      acc += emission(p);
    }
    acc *= dt * uGain;
    gl_FragColor = vec4(acc, 1.0);
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
  uniform vec3 uColour;
  varying vec2 vUv;
  void main() {
    #include <logdepthbuf_fragment>
    float r = length(vUv - 0.5) * 2.0;
    float g = exp(-r * r * 2.5) * (1.0 - smoothstep(0.85, 1.0, r));
    gl_FragColor = vec4(uColour * g, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

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
    this.maxLen = 5.4;
    this.r0 = nozzle.radiusAB || 0.56;
    this.rMax = this.r0 * 1.25;
    // bounding cylinder (z 0..1, scaled to the plume length), drawn from the inside so the
    // shader runs with the camera in the plume too
    const geo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, false);
    geo.rotateX(Math.PI / 2);          // axis along +Z
    geo.translate(0, 0, 0.5);
    // (the plume starts 2 cm behind the exit plane: no z-fight with the petal tips)
    this.uniforms = {
      uCamLocal: { value: new THREE.Vector3() },
      uLen: { value: 4.6 }, uR0: { value: this.r0 }, uRmax: { value: this.rMax },
      uAb: { value: 0 }, uTime: { value: 0 }, uGain: { value: 1.0 }, uScale: { value: new THREE.Vector3(1, 1, 1) },
    };
    this.plumeMat = new THREE.ShaderMaterial({
      name: 'F35_AB_Plume', uniforms: this.uniforms, vertexShader: PLUME_VERT, fragmentShader: PLUME_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
      toneMapped: true,
    });
    this.plume = new THREE.Mesh(geo, this.plumeMat);
    this.plume.name = 'AB_Plume';
    this.plume.renderOrder = 4;
    this.plume.castShadow = false;
    this.plume.receiveShadow = false;
    this.plume.visible = false;
    this.group.add(this.plume);
    // throat glow, a little inside the exit, facing aft
    const throatZ = nozzle.throat ? (nozzle.throat[2] - nozzle.exit[2]) : -0.4;
    this.glowUniforms = { uColour: { value: new THREE.Color(0, 0, 0) } };
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
    this.group.add(this.glow);
    this.ab = 0;
    this.throttle = 0;
    this.time = 0;
    this._inv = new THREE.Matrix4();
    this._cam = new THREE.Vector3();
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
    if (on) {
      const len = 2.0 + (this.maxLen - 2.0) * Math.pow(ab, 0.8);
      this.plume.scale.set(this.rMax, this.rMax, len);
      const u = this.uniforms;
      u.uScale.value.copy(this.plume.scale);
      u.uLen.value = len;
      u.uAb.value = ab;
      u.uTime.value = this.time % 1000;
      u.uGain.value = 0.3 + 0.7 * Math.pow(ab, 0.7);
      if (camera) {
        // camera in the plume frame (unscaled: the group's frame, metres)
        this.group.updateWorldMatrix(true, false);
        this._inv.copy(this.group.matrixWorld).invert();
        camera.getWorldPosition(this._cam);
        u.uCamLocal.value.copy(this._cam).applyMatrix4(this._inv);
      }
    }
    // throat glow: engine heat (dull red at idle, orange at MIL) plus the burner
    const thr = Math.min(1, Math.max(0, this.throttle));
    // (dim: a hot nozzle is a night-time sight; additive light would show in daylight too)
    const heat = 0.006 + 0.05 * Math.pow(Math.min(thr, 0.75) / 0.75, 2);
    const c = this.glowUniforms.uColour.value;
    c.setRGB(1.0, 0.30, 0.07).multiplyScalar(heat);
    if (on) {
      const k = 0.8 * Math.pow(ab, 0.7);
      c.r += 1.0 * k; c.g += 0.62 * k; c.b += 0.28 * k;
    }
  }
}
