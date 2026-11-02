// Things standing on and beside the runways by day (js/world/Runways.js owns this): elevated
// edge light fixtures (the layout of js/world/AirportLights.js: every <= 60 m, 1 m outside the
// edge, 35 cm tall, yellow bodies with clear domes), distance-remaining signs (FAA AC
// 150/5340-18: every 1000 ft both sides, 18 m from the edge, a white digit on black: thousands
// of feet left, the other number on the back), arresting gear signs (a yellow disc on black) and
// the arresting engines' low housings beside each cable. At night the lights themselves are
// js/world/AirportLights.js's.
//
// One merged mesh per airfield (a few thousand vertices), positions relative to the airfield's
// centre; one program: albedo per vertex, sign faces drawn with the runway glyph texture, lit as
// the runway surfaces (sun through the atmosphere, sky, the shadow map, aerial perspective), and
// faded out with distance before they shrink below a pixel.

import * as THREE from 'three';
import { ATMOSPHERE_PARS, ATMOSPHERE_CORE } from '../env/atmosphereGLSL.js';

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <shadowmap_pars_vertex>
${ATMOSPHERE_CORE}
attribute vec3 aCol;          // albedo (linear)
attribute vec4 aFace;         // sign face u, v (0..1), number (-1 none), kind (1 digit, 2 yellow disc)
varying vec3 vRel;
varying float vH;
varying vec3 vN;
varying vec3 vCol;
varying vec4 vFace;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec3 rel = (modelViewMatrix * vec4(position, 1.0)).xyz * mat3(viewMatrix);
  rel.y -= atmoCurvatureDrop(rel.xz);
  vRel = rel;
  vH = world.y;
  vN = normalize(mat3(modelMatrix) * normal);
  vCol = aCol;
  vFace = aFace;
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * rel, 1.0);
  #include <logdepthbuf_vertex>
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    vDirectionalShadowCoord[ 0 ] = directionalShadowMatrix[ 0 ] * vec4(rel + cameraPosition + vN * 0.05, 1.0);
  #endif
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <packing>
#include <logdepthbuf_pars_fragment>
#include <shadowmap_pars_fragment>
uniform bool receiveShadow;
${ATMOSPHERE_PARS}
uniform sampler2D uGlyphs;
uniform vec2 uFade;           // fade-out start, end (m)
varying vec3 vRel;
varying float vH;
varying vec3 vN;
varying vec3 vCol;
varying vec4 vFace;
void main() {
  #include <logdepthbuf_fragment>
  float dist = max(length(vRel), 1e-3);
  vec3 V = vRel / dist;
  vec3 albedo = vCol;
  vec2 q = vFace.xy;
  vec2 dqx = dFdx(q), dqy = dFdy(q);
  if (vFace.z >= 0.0) {
    if (vFace.w < 1.5) {
      // a white digit on black (the glyph texture's 4 x 4 cells, the glyph in 60 % of the width)
      float g = vFace.z;
      vec2 b = vec2((q.x - 0.2) / 0.6, (q.y - 0.12) / 0.76);
      float G = 4.0, cx = mod(g, G), cy = floor(g / G);
      vec2 uv = vec2((cx + 0.2 + 0.6 * b.x) / G, 1.0 - (cy + 1.0 - b.y) / G);
      vec2 gs = vec2(1.0 / G, 1.0 / (0.76 * G));
      float on = (b.x >= 0.0 && b.x <= 1.0 && b.y >= 0.0 && b.y <= 1.0) ? textureGrad(uGlyphs, uv, dqx * gs, dqy * gs).r : 0.0;
      albedo = mix(vec3(0.03), vec3(0.75), on);
    } else {
      // a yellow disc on black
      float r = length(q - 0.5);
      float w = max(fwidth(r), 1e-3);
      albedo = mix(vec3(0.03), vec3(0.62, 0.45, 0.05), clamp((0.36 - r) / w + 0.5, 0.0, 1.0));
    }
  }
  vec3 upP = normalize(vec3(vRel.x / uEarthRadius, 1.0, vRel.z / uEarthRadius));
  vec3 N = normalize(vN);
  vec3 sunE = atmoSunIrradianceAt(vRel, vH);
  float shadow = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    if (receiveShadow) {
      DirectionalLightShadow shd = directionalLightShadows[ 0 ];
      shadow = getShadow( directionalShadowMap[ 0 ], shd.shadowMapSize, shd.shadowIntensity, shd.shadowBias, shd.shadowRadius, vDirectionalShadowCoord[ 0 ] );
    }
  #endif
  float NdL = max(dot(N, uSunDir), 0.0);
  // sky from above, the sunlit ground's bounce from below (vertical faces see half of each)
  float up = dot(N, upP);
  vec3 groundE = vec3(0.3) * (sunE * max(dot(upP, uSunDir), 0.0) + uAmbient);
  vec3 skyE = uAmbient * 0.5 * (1.0 + up) + groundE * 0.5 * (1.0 - up);
  vec3 radiance = albedo * (sunE * NdL * shadow + skyE) / PI;
  vec3 color = atmoAerial(radiance, V, dist, vH);
  float alpha = 1.0 - smoothstep(uFade.x, uFade.y, dist);
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// albedos (linear)
const YELLOW = [0.5, 0.36, 0.05], GLASS = [0.55, 0.58, 0.6], BLACK = [0.035, 0.035, 0.035], STEEL = [0.25, 0.25, 0.26];
const HOUSING = [0.16, 0.17, 0.14];

/** Geometry under construction: boxes and prisms with per-vertex albedo and sign faces. */
class Builder {
  constructor() { this.p = []; this.n = []; this.c = []; this.f = []; this.i = []; }
  /** a quad (4 corners, counter-clockwise seen from outside), normal, colour, face (u, v per corner) */
  quad(P, N, col, face = null) {
    const b = this.p.length / 3;
    const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let k = 0; k < 4; k++) {
      this.p.push(...P[k]); this.n.push(...N); this.c.push(...col);
      this.f.push(face ? uv[k][0] : 0, face ? uv[k][1] : 0, face ? face[0] : -1, face ? face[1] : 0);
    }
    this.i.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  /**
   * An oriented box: centre (x, y0 at its foot, z), half sizes along the runway (a), across (b),
   * height h, the runway direction (ux, uz); faces: {front, back} sign faces on the +-s sides.
   */
  box(x, y0, z, a, b, h, ux, uz, col, faces = {}) {
    const rx = -uz, rz = ux;
    const P = (s, t, y) => [x + ux * s + rx * t, y0 + y, z + uz * s + rz * t];
    const S = (s, t) => [ux * s + rx * t, 0, uz * s + rz * t];
    // +s face (seen by traffic going -s), -s face, +t, -t, top
    this.quad([P(a, b, 0), P(a, -b, 0), P(a, -b, h), P(a, b, h)], S(1, 0), col, faces.plus);
    this.quad([P(-a, -b, 0), P(-a, b, 0), P(-a, b, h), P(-a, -b, h)], S(-1, 0), col, faces.minus);
    this.quad([P(-a, b, 0), P(a, b, 0), P(a, b, h), P(-a, b, h)], S(0, 1), col);
    this.quad([P(a, -b, 0), P(-a, -b, 0), P(-a, -b, h), P(a, -b, h)], S(0, -1), col);
    this.quad([P(-a, -b, h), P(-a, b, h), P(a, b, h), P(a, -b, h)], [0, 1, 0], col);
  }
  /** a vertical hexagonal prism (radius r, from y0 to y0 + h) */
  prism(x, y0, z, r, h, col, top = true) {
    for (let k = 0; k < 6; k++) {
      const a0 = (k / 6) * Math.PI * 2, a1 = ((k + 1) / 6) * Math.PI * 2, am = (a0 + a1) / 2;
      const c0 = [Math.cos(a0) * r, Math.sin(a0) * r], c1 = [Math.cos(a1) * r, Math.sin(a1) * r];
      this.quad([[x + c0[0], y0, z + c0[1]], [x + c0[0], y0 + h, z + c0[1]], [x + c1[0], y0 + h, z + c1[1]], [x + c1[0], y0, z + c1[1]]],
        [Math.cos(am), 0, Math.sin(am)], col);
      if (top) {
        const b = this.p.length / 3;
        for (const c of [[0, 0], c1, c0]) { this.p.push(x + c[0], y0 + h, z + c[1]); this.n.push(0, 1, 0); this.c.push(...col); this.f.push(0, 0, -1, 0); }
        this.i.push(b, b + 1, b + 2);
      }
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aFace', new THREE.Float32BufferAttribute(this.f, 4));
    g.setIndex(this.p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere();
    return g;
  }
}

export class RunwayFixtures {
  constructor({ renderer, scene, env, terrain, glyphs }) {
    this.renderer = renderer;
    this.env = env;
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.group.name = 'RunwayFixtures';
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);
    this.range = 2200;
    this.stats = { instances: 0, vertices: 0 };
    this._cam = new THREE.Vector3();
    const lights = THREE.UniformsUtils.clone(THREE.UniformsLib.lights);
    this.material = new THREE.ShaderMaterial({
      name: 'RunwayFixtures',
      uniforms: { ...lights, ...env.uniforms, uGlyphs: { value: glyphs }, uFade: { value: new THREE.Vector2(1700, 2200) } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      lights: true,
      fog: false,
      transparent: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this._meshes = [];
  }

  /** A stand-in mesh for the owner's warm-up (its program and its shadow depth program); returns its geometry (to dispose). */
  addPrecompile(scene) {
    const b = new Builder();
    b.box(0, 0, 0, 0.1, 0.1, 0.1, 1, 0, BLACK, { plus: [1, 1] });
    const m = new THREE.Mesh(b.geometry(), this.material);
    m.frustumCulled = false;
    m.receiveShadow = true;
    m.castShadow = true;
    scene.add(m);
    return m.geometry;
  }

  setRange(r) {
    this.range = r;
    this.material.uniforms.uFade.value.set(r * 0.75, r);
  }

  /** recs: [{rec (runways.json), tr (terrain runway)}] */
  setRunways(recs) {
    const hAt = (x, z) => this.terrain.heightAt(x, z);
    const byIcao = new Map();
    for (const r of recs) { if (!byIcao.has(r.rec.icao)) byIcao.set(r.rec.icao, []); byIcao.get(r.rec.icao).push(r); }
    let count = 0;
    for (const [icao, rs] of byIcao) {
      let cx = 0, cz = 0;
      for (const { tr } of rs) { cx += tr.cx; cz += tr.cz; }
      cx /= rs.length; cz /= rs.length;
      const B = new Builder();
      for (const { rec, tr } of rs) {
        if (rec.closed) continue;
        const a = tr.ends[0], ux = tr.ux, uz = tr.uz, rx = -uz, rz = ux;
        const L = rec.len, hw = rec.hw;
        const at = (s, t) => { const x = a.x + ux * s + rx * t, z = a.z + uz * s + rz * t; return [x - cx, hAt(x, z), z - cz]; };
        if (rec.lit) {
          // elevated edge lights (AirportLights.js layout): yellow body on a frangible stem, clear dome
          const n = Math.max(2, Math.ceil(L / 60));
          for (let k = 0; k <= n; k++) {
            for (const t of [-hw - 1, hw + 1]) {
              const [x, y, z] = at(L * k / n, t);
              B.prism(x, y, z, 0.035, 0.2, STEEL, false);
              B.prism(x, y + 0.2, z, 0.07, 0.07, YELLOW);
              B.prism(x, y + 0.27, z, 0.055, 0.08, GLASS);
              count++;
            }
          }
        }
        // distance-remaining signs: [s, thousands of feet left towards end 1 (seen going +s), towards end 0]
        const off = hw + rec.sh + 12;
        for (const [s, front, back] of rec.dtg || []) {
          for (const t of [-off, off]) {
            const [x, y, z] = at(s, t);
            for (const lt of [-0.55, 0.55]) {
              const [lx, , lz] = [x + rx * lt, 0, z + rz * lt];
              B.box(lx, y, lz, 0.05, 0.05, 0.4, ux, uz, STEEL);
            }
            // the face read going +s looks towards -s: on the box's -s side
            B.box(x, y + 0.35, z, 0.15, 0.8, 1.05, ux, uz, BLACK, { minus: [front, 1], plus: [back, 1] });
            count++;
          }
        }
        // arresting gear: signs (yellow disc on black) and the engines' low housings beside each cable
        for (const s of rec.cables || []) {
          for (const sg of [-1, 1]) {
            const [x, y, z] = at(s - 3, sg * (hw + rec.sh + 9));
            B.box(x, y, z, 0.05, 0.05, 0.4, ux, uz, STEEL);
            B.box(x, y + 0.35, z, 0.12, 0.55, 1.1, ux, uz, BLACK, { minus: [0, 2], plus: [0, 2] });
            const [hx, hy, hz] = at(s, sg * (hw + rec.sh + 28));
            B.box(hx, hy - 0.1, hz, 1.6, 1.2, 1.2, ux, uz, HOUSING);
            count += 2;
          }
        }
      }
      if (!B.p.length) continue;
      const mesh = new THREE.Mesh(B.geometry(), this.material);
      mesh.name = `RunwayFixtures ${icao}`;
      mesh.position.set(cx, 0, cz);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.receiveShadow = true;
      // the signs' and fixtures' shadows (long at a low sun; the sun's map covers ~160 m around
      // the camera near the ground: one more draw in its pass at the airfield)
      mesh.castShadow = true;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this._meshes.push(mesh);
      this.stats.vertices += B.p.length / 3;
    }
    this.stats.instances = count;
  }

  update(f) {
    // whole airfields beyond the fixtures' range are skipped
    const cam = f.camera.getWorldPosition(this._cam);
    for (const m of this._meshes) {
      const bs = m.geometry.boundingSphere;
      const d = Math.hypot(cam.x - m.position.x - bs.center.x, cam.y - bs.center.y, cam.z - m.position.z - bs.center.z) - bs.radius;
      m.visible = d < this.range;
    }
  }

  dispose() {
    for (const m of this._meshes) m.geometry.dispose();
    this._meshes.length = 0;
    this.material.dispose();
    this.group.parent?.remove(this.group);
  }
}
