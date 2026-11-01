// Vapour: what humid air does around a fighter in hard manoeuvres and near Mach 1, and contrails.
//
//   wing-tip vortices   thin white lines trailing from the wing tips (high lift, humid air)
//   chine vortices      thicker tubes from the forebody chines over the wing roots (high alpha)
//   wing sheets         a mist over the upper wing, densest behind the leading edge and at the root
//                       (high g at low level: the expansion over the wing cools the air below its dew
//                       point); two layers, noise drifting aft
//   vapour cone         the shock collar at Mach ~0.93-1.01 in humid air: a bell around the aft
//                       fuselage, densest at its sharp aft edge (the normal shock evaporates it),
//                       streaks over a misty base, its outline soft (the mist thins away from the body)
//   contrail            the engine's ice trail above ~8 km (ambient below about -38 C), starting a
//                       few dozen metres behind the nozzle, spreading and fading over ~25 s
// The amounts come from fxshared.condensation() (FlightModel state: load factor, dynamic pressure,
// speed, Mach, altitude -> CL, the local cooling and the assumed humidity). Trails are left in the
// air (world frame); sheets and the cone ride on the jet (body frame). Everything is premultiplied
// alpha, lit by the sun and the sky (fxshared.fxLight), hidden when not needed (no draw calls).
//
// Body-frame anchors (+X right, +Y up, -Z forward) were measured on the exported model.

import * as THREE from 'three';
import { Ribbon, noiseTexture, fxLight, VAPOUR_LIGHT_GLSL, PREMULT_OUT_GLSL } from './fxshared.js';

const WINGTIP = [5.30, 0.28, 3.75];        // trailing tip corner (right; the left is mirrored)
const CHINE = [1.75, 0.62, -1.8];          // chine / wing-root vortex origin
const WING = { rootLE: [1.9, 0.43, -1.2], tipLE: [5.2, 0.32, 2.0], tipTE: [5.25, 0.30, 3.9], rootTE: [2.0, 0.43, 4.1] };
const CONE = [[0.9, -3.2], [1.6, -2.0], [2.4, -0.5], [3.2, 1.0], [3.8, 2.4], [4.0, 3.0]];   // (radius, z)

const SHEET_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec4 aPlan;       // span 0..1, chord 0..1, layer, side
  varying vec4 vPlan;
  varying vec3 vWorld;
  void main() {
    vPlan = aPlan;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }`;

const SHEET_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uNoise;
  uniform float uAmount;
  uniform float uTime;
  ${VAPOUR_LIGHT_GLSL}
  varying vec4 vPlan;
  varying vec3 vWorld;
  void main() {
    #include <logdepthbuf_fragment>
    float eta = vPlan.x, xi = vPlan.y, layer = vPlan.z;
    // densest just behind the leading edge and at the root, gone by ~75 % chord and towards the tip
    float chord = smoothstep(0.0, 0.07, xi) * (1.0 - smoothstep(0.3, 0.78, xi));
    float span = 1.0 - smoothstep(0.5, 0.95, eta);
    // streaks along the flow (fine across the span, long along the chord), drifting aft
    vec2 nuv = vec2(eta * 6.5 + layer * 0.37 + vPlan.w * 0.21, xi * 0.8 - uTime * 2.4);
    float n = texture2D(uNoise, nuv).r * 0.6 + texture2D(uNoise, nuv * vec2(2.7, 1.3) + 0.5).g * 0.4;
    float d = uAmount * chord * span * smoothstep(0.35, 0.75, n + 0.3 * uAmount - 0.15 * layer);
    float alpha = clamp(d * (layer < 0.5 ? 0.85 : 0.5), 0.0, 0.92);
    if (alpha < 0.003) discard;
    vec3 col = vapourLight(normalize(cameraPosition - vWorld), 0.9);
    ${PREMULT_OUT_GLSL}
  }`;

const CONE_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec2 aCone;       // s: 0 front .. 1 aft edge, phi 0..1 round
  varying vec2 vCone;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  void main() {
    vCone = aCone;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }`;

const CONE_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uNoise;
  uniform float uAmount;
  uniform float uTime;
  ${VAPOUR_LIGHT_GLSL}
  varying vec2 vCone;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  void main() {
    #include <logdepthbuf_fragment>
    float s = vCone.x, phi = vCone.y;
    vec3 V = normalize(cameraPosition - vWorld);
    // the shell is the outer bound of a region of mist that is densest near the body: it fades
    // out towards its silhouette (a soft, cloud-like outline, not a glassy rim)
    float edge = smoothstep(0.04, 0.5, abs(dot(normalize(vNormalW), V)));
    float axial = smoothstep(0.05, 0.92, s) * (1.0 - smoothstep(0.965, 1.0, s));
    // a misty base with streaks along the flow, ragged towards the front, a dense collar at the
    // shock (aft edge)
    vec2 nuv = vec2(phi * 11.0, s * 0.7 - uTime * 1.5);
    float n = texture2D(uNoise, nuv).r * 0.55 + texture2D(uNoise, nuv * vec2(2.3, 3.1) + 0.3).g * 0.45;
    float d = uAmount * axial * (0.4 + 0.6 * smoothstep(0.42, 0.78, n + 0.32 * s * s));
    float alpha = clamp(d * 0.62 * edge, 0.0, 0.85);
    if (alpha < 0.003) discard;
    vec3 col = vapourLight(V, 0.9);
    ${PREMULT_OUT_GLSL}
  }`;

function vapourMaterial(name, vert, frag, side = THREE.DoubleSide) {
  return new THREE.ShaderMaterial({
    name,
    uniforms: { ...fxLight.uniforms, uNoise: { value: noiseTexture() }, uAmount: { value: 0 }, uTime: { value: 0 } },
    vertexShader: vert, fragmentShader: frag, side,
    transparent: true, depthWrite: false, blending: THREE.NormalBlending, premultipliedAlpha: true, toneMapped: true,
  });
}

/** The sheets over both wings: a grid on the planform, two layers above it. */
function sheetGeometry(layers) {
  const NX = 10, NY = 8;
  const pos = [], plan = [], idx = [];
  const P = (k, s) => new THREE.Vector3(s * WING[k][0], WING[k][1], WING[k][2]);
  for (let L = 0; L < layers; L++) {           // layer by layer (setQuality draws the first n)
    for (const side of [1, -1]) {
      const base = pos.length / 3;
      const h = [0.07, 0.26][L];
      for (let j = 0; j <= NY; j++) {
        const xi = j / NY;
        for (let i = 0; i <= NX; i++) {
          const eta = i / NX;
          const le = P('rootLE', side).lerp(P('tipLE', side), eta);
          const te = P('rootTE', side).lerp(P('tipTE', side), eta);
          const p = le.lerp(te, xi);
          p.y += h * (1 - 0.5 * eta);
          pos.push(p.x, p.y, p.z);
          plan.push(eta, xi, L, side);
        }
      }
      for (let j = 0; j < NY; j++) {
        for (let i = 0; i < NX; i++) {
          const a = base + j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aPlan', new THREE.Float32BufferAttribute(plan, 4));
  g.setIndex(idx);
  return g;
}

/** The vapour cone: a lathe of CONE around the body axis (+Z aft). */
function coneGeometry() {
  const NS = 24, NR = 40;
  const pos = [], uv = [], idx = [];
  const z0 = CONE[0][1], z1 = CONE[CONE.length - 1][1];
  const prof = (s) => {             // radius at axial fraction s (piecewise linear)
    const z = z0 + s * (z1 - z0);
    for (let k = 1; k < CONE.length; k++) {
      if (z <= CONE[k][1]) {
        const f = (z - CONE[k - 1][1]) / (CONE[k][1] - CONE[k - 1][1]);
        return [CONE[k - 1][0] + f * (CONE[k][0] - CONE[k - 1][0]), z];
      }
    }
    return [CONE[CONE.length - 1][0], z1];
  };
  for (let j = 0; j <= NS; j++) {
    const s = j / NS;
    const [r, z] = prof(s);
    for (let i = 0; i <= NR; i++) {
      const phi = i / NR;
      const a = phi * Math.PI * 2;
      pos.push(Math.cos(a) * r, 0.25 + Math.sin(a) * r * 0.82, z);       // a little flattened
      uv.push(s, phi);
    }
  }
  for (let j = 0; j < NS; j++) {
    for (let i = 0; i < NR; i++) {
      const a = j * (NR + 1) + i, b = a + 1, c = a + NR + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aCone', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const _p = new THREE.Vector3();
const _cam = new THREE.Vector3();

export class Vapor {
  /**
   * @param {THREE.Object3D} world   a group in the scene at the world origin (trails)
   * @param {import('./AircraftVisual.js').AircraftVisual} visual
   */
  constructor(world, visual) {
    this.world = world;
    this.visual = visual;
    this.amount = { wing: 0, vortex: 0, cone: 0, contrail: 0 };
    this.enabled = { sheets: true, chines: true, cone: true, layers: 2 };
    const tip = { max: 48, spacing: 3, life: 0.3, width0: 0.14, growth: 1.2, soft: 2.2, noiseScale: 0.06, maxAlpha: 0.75 };
    const chine = { max: 16, spacing: 1.2, life: 0.04, width0: 0.5, growth: 9, soft: 1.3, noiseScale: 0.22, maxAlpha: 0.55 };
    this.trails = [
      { r: new Ribbon(tip), at: [WINGTIP[0], WINGTIP[1], WINGTIP[2]], kind: 'tip', dist: 70 },
      { r: new Ribbon(tip), at: [-WINGTIP[0], WINGTIP[1], WINGTIP[2]], kind: 'tip', dist: 70 },
      { r: new Ribbon(chine), at: [CHINE[0], CHINE[1], CHINE[2]], kind: 'chine', dist: 7 },
      { r: new Ribbon(chine), at: [-CHINE[0], CHINE[1], CHINE[2]], kind: 'chine', dist: 7 },
    ];
    const nz = visual.info && visual.info.nozzle ? visual.info.nozzle.exit : [0, 0.12, 6.2];
    this.contrail = { r: new Ribbon({ max: 160, spacing: 20, life: 25, width0: 1.2, growth: 0.9, fadeIn: 0.15,
      fadeOut: 0.6, soft: 1.0, noiseScale: 0.015, maxAlpha: 0.8, albedo: 0.95, renderOrder: 6 }), at: [nz[0], nz[1], nz[2]] };
    for (const t of [...this.trails, this.contrail]) world.add(t.r.mesh);
    // body-frame sheets and cone
    this.sheetMat = vapourMaterial('F35_VapourSheet', SHEET_VERT, SHEET_FRAG);
    this.sheets = new THREE.Mesh(sheetGeometry(2), this.sheetMat);
    this.sheets.name = 'VapourSheets';
    this.sheets.renderOrder = 7;
    this.sheets.visible = false;
    this.sheets.frustumCulled = false;
    this.coneMat = [vapourMaterial('F35_VapourConeBack', CONE_VERT, CONE_FRAG, THREE.BackSide),
      vapourMaterial('F35_VapourConeFront', CONE_VERT, CONE_FRAG, THREE.FrontSide)];
    const cg = coneGeometry();
    this.cone = this.coneMat.map((m, i) => {
      const mesh = new THREE.Mesh(cg, m);
      mesh.name = i ? 'VapourConeFront' : 'VapourConeBack';
      mesh.renderOrder = i ? 8 : 6;
      mesh.visible = false;
      mesh.frustumCulled = false;
      return mesh;
    });
    visual.object3d.add(this.sheets, ...this.cone);
    this._t = null;
  }

  /** quality: {sheets, chines, cone, layers} */
  setQuality(q) {
    Object.assign(this.enabled, q);
    const perLayer = 2 * 10 * 8 * 6;              // indices: both wings, NX x NY quads
    this.sheets.geometry.setDrawRange(0, Math.max(1, Math.min(2, this.enabled.layers)) * perLayer);
  }

  reset() {
    for (const t of [...this.trails, this.contrail]) t.r.clear();
    for (const k in this.amount) this.amount[k] = 0;
    this.sheets.visible = false;
    for (const m of this.cone) m.visible = false;
    this._t = null;
  }

  /**
   * @param {object} st     FlightModel state
   * @param {object} c      fxshared.condensation(st)
   * @param {THREE.Camera} camera
   * @param {boolean} draw  rebuild the geometry (false: the frame is not drawn)
   */
  update(st, c, camera, draw) {
    const t = st.time || 0;
    const dt = this._t === null ? 0 : Math.max(0, Math.min(0.5, t - this._t));
    this._t = t;
    // smooth the amounts (~0.15 s) so vapour builds and fades instead of popping
    const k = dt > 0 ? 1 - Math.exp(-dt / 0.15) : (this._init ? 0 : 1);
    this._init = true;
    const A = this.amount;
    A.wing += ((this.enabled.sheets ? c.wing : 0) - A.wing) * k;
    A.vortex += (c.vortex - A.vortex) * k;
    A.cone += ((this.enabled.cone ? c.cone : 0) - A.cone) * k;
    A.contrail += (c.contrail - A.contrail) * (dt > 0 ? 1 - Math.exp(-dt / 1.0) : 1);
    const V = Math.max(30, st.tas || 0);
    const o3 = this.visual.object3d;
    for (const tr of this.trails) {
      if (tr.kind === 'chine' && !this.enabled.chines) { tr.r.clear(); continue; }
      tr.r.o.life = Math.min(tr.kind === 'tip' ? 0.6 : 0.12, Math.max(0.02, tr.dist / V));
      _p.fromArray(tr.at);
      o3.localToWorld(_p);
      const amt = tr.kind === 'tip' ? A.vortex : A.vortex * smoothAlpha(st.alpha);
      tr.r.push(_p, t, amt > 0.01 ? amt : 0);
    }
    _p.fromArray(this.contrail.at);
    o3.localToWorld(_p);
    this.contrail.r.o.fadeIn = 40 / V;                     // ~40 m of clear exhaust first
    this.contrail.r.push(_p, t, A.contrail > 0.01 ? A.contrail : 0);
    if (!draw || !camera) return;
    const cam = camera.getWorldPosition(_cam);
    for (const tr of this.trails) tr.r.build(t, cam);
    this.contrail.r.build(t, cam);
    for (const m of [this.sheetMat, ...this.coneMat]) m.uniforms.uTime.value = t % 1000;
    this.sheetMat.uniforms.uAmount.value = A.wing;
    this.sheets.visible = A.wing > 0.01;
    for (const m of this.coneMat) m.uniforms.uAmount.value = A.cone;
    for (const m of this.cone) m.visible = A.cone > 0.01;
  }

  dispose() {
    for (const t of [...this.trails, this.contrail]) { this.world.remove(t.r.mesh); t.r.dispose(); }
    this.visual.object3d.remove(this.sheets, ...this.cone);
    this.sheets.geometry.dispose();
    this.cone[0].geometry.dispose();
    this.sheetMat.dispose();
    for (const m of this.coneMat) m.dispose();
  }
}

/** Chine vortices need angle of attack: none below ~8 deg, full by ~16 deg. */
function smoothAlpha(alpha) {
  return THREE.MathUtils.smoothstep((alpha || 0) * 180 / Math.PI, 8, 16);
}
