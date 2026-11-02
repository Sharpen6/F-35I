// Vapour: what humid air does around a fighter in hard manoeuvres and near Mach 1, and contrails.
//
//   wing-tip vortices   thin white lines trailing from the wing tips (high lift, humid air)
//   chine vortices      thicker tubes from the forebody chines over the wing roots (high alpha)
//   wing sheets         a mist over the upper wing, densest a little behind the leading-edge flap's
//                       hinge and at the root (high g at low level: the expansion over the wing cools
//                       the air below its dew point); thin layers hugging the skin, noise drifting aft
//   vapour cone         the shock collar at Mach ~0.93-1.01 in humid air: a cloud round the aft
//                       fuselage and the wings, densest next to the skin and at its sharp aft edge (the
//                       normal shock evaporates it), thinning outwards to a ragged edge
//   contrail            the engine's ice trail above ~8 km (ambient below about -38 C), starting a
//                       few dozen metres behind the nozzle, spreading and fading over ~25 s
// The amounts come from fxshared.condensation() (FlightModel state: load factor, dynamic pressure,
// speed, Mach, altitude -> CL, the local cooling and the assumed humidity). Trails are left in the
// air (world frame); sheets and the cone ride on the jet (body frame). Everything is premultiplied
// alpha, lit by the sun and the sky (fxshared.fxLight), fogged like the jet, hidden when not needed
// (no draw calls).
//
// Sheets and cone are surfaces standing in for thin volumes of mist, so they fade where they are
// seen edge-on (|N.V| small): no bright hairlines along the wing seen from ahead, no crisp glassy
// outline round the cone. The cone is several nested shells (by quality), each with a slightly
// irregular outline, the inner ones denser, so that from behind or ahead it reads as mist densest
// round the jet and thinning outwards; its noise runs along the flow seen from the side and is
// mottled seen along the axis (no radial 'iris' streaks).
//
// Body-frame anchors (+X right, +Y up, -Z forward) were measured on the exported model.

import * as THREE from 'three';
import { Ribbon, noiseTexture, fxLight, fogUniforms, VAPOUR_LIGHT_GLSL, FOG_PARS_GLSL, PREMULT_OUT_GLSL } from './fxshared.js';

const WINGTIP = [5.30, 0.28, 3.75];        // trailing tip corner (right; the left is mirrored)
const CHINE = [1.75, 0.62, -1.8];          // chine / wing-root vortex origin
const WING = { rootLE: [1.9, 0.43, -1.2], tipLE: [5.2, 0.32, 2.0], tipTE: [5.25, 0.30, 3.9], rootTE: [2.0, 0.43, 4.1] };
const CONE = [[0.9, -3.2], [1.6, -2.0], [2.4, -0.5], [3.2, 1.0], [3.8, 2.4], [4.0, 3.0]];   // (radius, z)
const SHEET_START = 0.1;                   // chord fraction of the sheets' front: the LE flap hinge
const SHEET_HEIGHT = [0.05, 0.13];         // m above the planform, per layer
const CONE_SHELLS = [1.0, 0.8, 0.62];      // radius of each nested cone shell (outer first)
const CONE_WEIGHT = [0.55, 0.8, 1.0];      // and its density (the mist is densest near the skin)

const SHEET_VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  attribute vec4 aPlan;       // span 0..1, chord 0..1, layer, side
  varying vec4 vPlan;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  void main() {
    vPlan = aPlan;
    vNormalW = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }`;

const SHEET_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uNoise;
  uniform float uAmount;
  uniform float uTime;
  ${VAPOUR_LIGHT_GLSL}
  ${FOG_PARS_GLSL}
  varying vec4 vPlan;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  void main() {
    #include <logdepthbuf_fragment>
    float eta = vPlan.x, xi = vPlan.y, layer = vPlan.z;
    // densest just behind the leading-edge flap's hinge and at the root, gone by ~75 % chord and
    // towards the tip
    float chord = smoothstep(${SHEET_START.toFixed(2)}, ${(SHEET_START + 0.1).toFixed(2)} + 0.04 * layer, xi) * (1.0 - smoothstep(0.3, 0.78, xi));
    float span = 1.0 - smoothstep(0.5, 0.95, eta);
    // streaks along the flow (fine across the span, long along the chord), drifting aft
    vec2 nuv = vec2(eta * 6.5 + layer * 0.37 + vPlan.w * 0.21, xi * 0.8 - uTime * 2.4);
    float n = texture2D(uNoise, nuv).r * 0.6 + texture2D(uNoise, nuv * vec2(2.7, 1.3) + 0.5).g * 0.4;
    float d = uAmount * chord * span * smoothstep(0.35, 0.75, n + 0.3 * uAmount - 0.15 * layer);
    // a thin sheet of mist: nothing seen edge-on
    vec3 V = normalize(cameraPosition - vWorld);
    float view = smoothstep(0.15, 0.6, abs(dot(vNormalW, V)));
    float alpha = clamp(d * view * (layer < 0.5 ? 0.85 : 0.5), 0.0, 0.92);
    if (alpha < 0.003) discard;
    vec3 col = vapourLight(V, 0.9);
    ${PREMULT_OUT_GLSL}
  }`;

const CONE_VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 aCone;       // s: 0 front .. 1 aft edge, phi 0..1 round, shell (0 outer)
  varying vec3 vCone;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying vec3 vAxisW;
  varying vec2 vCross;
  void main() {
    vCone = aCone;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vAxisW = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
    vCross = position.xy;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }`;

const CONE_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uNoise;
  uniform float uAmount;
  uniform float uTime;
  uniform float uShellGain;   // density per shell (more when fewer shells are drawn)
  ${VAPOUR_LIGHT_GLSL}
  ${FOG_PARS_GLSL}
  varying vec3 vCone;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying vec3 vAxisW;
  varying vec2 vCross;
  void main() {
    #include <logdepthbuf_fragment>
    float s = vCone.x, phi = vCone.y, shell = vCone.z;
    vec3 V = normalize(cameraPosition - vWorld);
    // a shell of a volume of mist: it fades where it is seen edge-on (soft, cloud-like outlines)
    float view = smoothstep(0.15, 0.6, abs(dot(normalize(vNormalW), V)));
    // streaks along the flow seen from the side, a mottled cloud seen along the axis
    vec2 nuv = vec2(phi * 11.0 + shell * 0.31, s * 0.7 - uTime * 1.5);
    float nS = texture2D(uNoise, nuv).r * 0.55 + texture2D(uNoise, nuv * vec2(2.3, 3.1) + 0.3).g * 0.45;
    vec2 muv = vCross * 0.23 + vec2(shell * 0.43, uTime * 0.21);
    float nM = texture2D(uNoise, muv).r * 0.6 + texture2D(uNoise, muv * 2.6 + 0.17).g * 0.4;
    float n = mix(nS, nM, smoothstep(0.55, 0.9, abs(dot(vAxisW, V))));
    // ragged towards the front; the aft edge (the shock) sharp but not a perfect circle
    float sEnd = 0.975 - 0.05 * texture2D(uNoise, vec2(phi * 5.0 + shell * 0.5, 0.37)).g;
    float axial = smoothstep(0.05, 0.92, s) * (1.0 - smoothstep(sEnd - 0.035, sEnd, s));
    float d = uAmount * axial * (0.4 + 0.6 * smoothstep(0.42, 0.78, n + 0.32 * s * s));
    float alpha = clamp(d * 0.62 * view * uShellGain * (shell < 0.5 ? ${CONE_WEIGHT[0].toFixed(3)} : shell < 1.5 ? ${CONE_WEIGHT[1].toFixed(3)} : ${CONE_WEIGHT[2].toFixed(3)}), 0.0, 0.85);
    if (alpha < 0.003) discard;
    vec3 col = vapourLight(V, 0.9);
    ${PREMULT_OUT_GLSL}
  }`;

function vapourMaterial(name, vert, frag, side = THREE.DoubleSide, extra = {}) {
  return new THREE.ShaderMaterial({
    name,
    uniforms: { ...fxLight.uniforms, ...fogUniforms(), uNoise: { value: noiseTexture() }, uAmount: { value: 0 },
      uTime: { value: 0 }, ...extra },
    vertexShader: vert, fragmentShader: frag, side, fog: true,
    transparent: true, depthWrite: false, blending: THREE.NormalBlending, premultipliedAlpha: true, toneMapped: true,
  });
}

/** The sheets over both wings: a grid on the planform aft of the LE flap hinge, layers above it. */
function sheetGeometry(layers) {
  const NX = 10, NY = 8;
  const pos = [], plan = [], idx = [];
  const P = (k, s) => new THREE.Vector3(s * WING[k][0], WING[k][1], WING[k][2]);
  for (let L = 0; L < layers; L++) {           // layer by layer (setQuality draws the first n)
    for (const side of [1, -1]) {
      const base = pos.length / 3;
      const h = SHEET_HEIGHT[L];
      for (let j = 0; j <= NY; j++) {
        const xi = SHEET_START + (1 - SHEET_START) * j / NY;
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

const CONE_NS = 24, CONE_NR = 40;
const CONE_PER_SHELL = CONE_NS * CONE_NR * 6;      // indices per shell

/**
 * The vapour cone: nested lathes of CONE round the body axis (+Z aft), each a little irregular
 * (a few low harmonics round it, fixed per shell). Two geometries share the vertices: shells outer
 * to inner (drawn from inside, back faces: far to near) and inner to outer (front faces).
 */
function coneGeometries() {
  const pos = [], attr = [];
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
  const NV = (CONE_NS + 1) * (CONE_NR + 1);
  CONE_SHELLS.forEach((scale, L) => {
    // fixed pseudo-random phases: a wobbly outline, different on each shell
    const ph = [1.7, 4.1, 2.9, 0.6].map((x) => x * (L + 1.3));
    for (let j = 0; j <= CONE_NS; j++) {
      const s = j / CONE_NS;
      const [r, z] = prof(s);
      for (let i = 0; i <= CONE_NR; i++) {
        const phi = i / CONE_NR;
        const a = phi * Math.PI * 2;
        const wob = 1 + (0.045 * Math.sin(3 * a + ph[0] + 2.0 * s) + 0.03 * Math.sin(5 * a + ph[1])
          + 0.02 * Math.sin(7 * a + ph[2] - 1.5 * s)) * (0.4 + 0.6 * s);
        const R = r * scale * wob;
        pos.push(Math.cos(a) * R, 0.25 + Math.sin(a) * R * 0.82, z);       // a little flattened
        attr.push(s, phi, L);
      }
    }
  });
  const shellIdx = (L) => {
    const out = [], base = L * NV;
    for (let j = 0; j < CONE_NS; j++) {
      for (let i = 0; i < CONE_NR; i++) {
        const a = base + j * (CONE_NR + 1) + i, b = a + 1, c = a + CONE_NR + 1, d = c + 1;
        out.push(a, b, c, b, d, c);
      }
    }
    return out;
  };
  const posAttr = new THREE.Float32BufferAttribute(pos, 3);
  const coneAttr = new THREE.Float32BufferAttribute(attr, 3);
  const make = (order) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', posAttr);
    g.setAttribute('aCone', coneAttr);
    g.setIndex(order.flatMap(shellIdx));
    return g;
  };
  const back = make(CONE_SHELLS.map((_, i) => i));                 // outer -> inner
  back.computeVertexNormals();
  const front = make(CONE_SHELLS.map((_, i) => CONE_SHELLS.length - 1 - i));   // inner -> outer
  front.setAttribute('normal', back.getAttribute('normal'));
  return { back, front };
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
    this.enabled = { sheets: true, chines: true, cone: true, layers: 2, shells: CONE_SHELLS.length };
    const tip = { name: 'VortexTip', max: 48, spacing: 3, life: 0.3, width0: 0.14, growth: 1.2, soft: 2.2, noiseScale: 0.06, maxAlpha: 0.75 };
    const chine = { name: 'VortexChine', max: 16, spacing: 1.2, life: 0.04, width0: 0.5, growth: 9, soft: 1.3, noiseScale: 0.22, maxAlpha: 0.55 };
    this.trails = [
      { r: new Ribbon(tip), at: [WINGTIP[0], WINGTIP[1], WINGTIP[2]], kind: 'tip', dist: 70 },
      { r: new Ribbon(tip), at: [-WINGTIP[0], WINGTIP[1], WINGTIP[2]], kind: 'tip', dist: 70 },
      { r: new Ribbon(chine), at: [CHINE[0], CHINE[1], CHINE[2]], kind: 'chine', dist: 7 },
      { r: new Ribbon(chine), at: [-CHINE[0], CHINE[1], CHINE[2]], kind: 'chine', dist: 7 },
    ];
    const nz = visual.info && visual.info.nozzle ? visual.info.nozzle.exit : [0, 0.12, 6.2];
    // the contrail's points are spaced by speed (Ribbon.push): 160 cover its 25 s at any speed
    this.contrail = { r: new Ribbon({ name: 'Contrail', max: 160, spacing: 20, life: 25, width0: 1.2, growth: 0.9, fadeIn: 0.15,
      fadeOut: 0.6, soft: 1.0, noiseScale: 0.015, maxAlpha: 0.8, albedo: 0.95, renderOrder: 6 }), at: [nz[0], nz[1], nz[2]] };
    this.ribbons = [...this.trails.map((t) => t.r), this.contrail.r];
    for (const r of this.ribbons) world.add(r.mesh);
    // body-frame sheets and cone
    this.sheetMat = vapourMaterial('F35_VapourSheet', SHEET_VERT, SHEET_FRAG);
    this.sheets = new THREE.Mesh(sheetGeometry(SHEET_HEIGHT.length), this.sheetMat);
    this.sheets.name = 'VapourSheets';
    this.sheets.renderOrder = 7;
    this.sheets.visible = false;
    this.sheets.frustumCulled = false;
    this.coneMat = [vapourMaterial('F35_VapourConeBack', CONE_VERT, CONE_FRAG, THREE.BackSide, { uShellGain: { value: 1 } }),
      vapourMaterial('F35_VapourConeFront', CONE_VERT, CONE_FRAG, THREE.FrontSide, { uShellGain: { value: 1 } })];
    const cg = coneGeometries();
    this.cone = this.coneMat.map((m, i) => {
      const mesh = new THREE.Mesh(i ? cg.front : cg.back, m);
      mesh.name = i ? 'VapourConeFront' : 'VapourConeBack';
      mesh.renderOrder = i ? 8 : 6;
      mesh.visible = false;
      mesh.frustumCulled = false;
      return mesh;
    });
    this.materials = [this.sheetMat, ...this.coneMat];
    visual.object3d.add(this.sheets, ...this.cone);
    this._c = null;
    this._t = null;
    this.setQuality({});
  }

  /** quality: {sheets, chines, cone, layers (sheet layers), shells (cone shells)} */
  setQuality(q) {
    Object.assign(this.enabled, q);
    const perLayer = 2 * 10 * 8 * 6;              // indices: both wings, NX x NY quads
    this.sheets.geometry.setDrawRange(0, Math.max(1, Math.min(SHEET_HEIGHT.length, this.enabled.layers)) * perLayer);
    // the outer n shells: first in the back faces' order, last in the front faces'
    const n = Math.max(1, Math.min(CONE_SHELLS.length, this.enabled.shells || CONE_SHELLS.length));
    this.cone[0].geometry.setDrawRange(0, n * CONE_PER_SHELL);
    this.cone[1].geometry.setDrawRange((CONE_SHELLS.length - n) * CONE_PER_SHELL, n * CONE_PER_SHELL);
    // fewer shells, each denser (about the same mist overall)
    let w = 0;
    for (let i = 0; i < n; i++) w += CONE_WEIGHT[i];
    const all = CONE_WEIGHT.reduce((a, b) => a + b, 0);
    for (const m of this.coneMat) m.uniforms.uShellGain.value = 0.5 * all / w;
  }

  reset() {
    for (const r of this.ribbons) r.clear();
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
      tr.r.push(_p, t, amt > 0.01 ? amt : 0, V);
    }
    _p.fromArray(this.contrail.at);
    o3.localToWorld(_p);
    this.contrail.r.o.fadeIn = 40 / V;                     // ~40 m of clear exhaust first
    this.contrail.r.push(_p, t, A.contrail > 0.01 ? A.contrail : 0, V);
    if (!draw || !camera) return;
    const cam = camera.getWorldPosition(_cam);
    for (const r of this.ribbons) r.build(t, cam);
    for (const m of this.materials) m.uniforms.uTime.value = t % 1000;
    this.sheetMat.uniforms.uAmount.value = A.wing;
    this.sheets.visible = A.wing > 0.01;
    for (const m of this.coneMat) m.uniforms.uAmount.value = A.cone;
    for (const m of this.cone) m.visible = A.cone > 0.01;
  }

  /** The meshes with shader programs of their own (AircraftFX compiles them before first use). */
  effectMeshes() { return [this.sheets, ...this.cone, this.contrail.r.mesh]; }

  dispose() {
    for (const r of this.ribbons) { this.world.remove(r.mesh); r.dispose(); }
    this.visual.object3d.remove(this.sheets, ...this.cone);
    this.sheets.geometry.dispose();
    this.cone[0].geometry.dispose();
    this.cone[1].geometry.dispose();
    for (const m of this.materials) m.dispose();
  }
}

/** Chine vortices need angle of attack: none below ~8 deg, full by ~16 deg. */
function smoothAlpha(alpha) {
  return THREE.MathUtils.smoothstep((alpha || 0) * 180 / Math.PI, 8, 16);
}
