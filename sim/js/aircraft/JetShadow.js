// The player's jet's own sun shadow (exterior track; js/aircraft/README.md, "Exterior").
//
// Why: the scene has one shadow map (Environment.js), fitted near the ground to ~200 m around the
// camera (10 cm texels) and in the air to the jet (5 mm), with a depth bias of 0.8 m either way.
// On the jet that bias erased every shadow shorter than 0.8 m along the light (the canopy's on the
// spine, the doors', the gear's, every junction); on the runway the jet's shadow was a 25 cm blur
// that started 0.8 m behind the tyres, so the jet floated.
//
// Here:
//   * a depth map of the jet alone, in its own body frame (an ortho camera on the sun's side of the
//     jet's box: 2048 texels over ~17 m, 8 mm), redrawn when the light turns in that frame or a part
//     moves (rig signature), else kept; sampled by every exterior material (skin.js) with a bias of a
//     texel and a normal offset, and by the ground pass;
//   * a top-down map of the jet's underside (also body frame, from below: coverage and height above
//     the ground, mipmapped) for the occlusion of the sky under the jet and at the tyres;
//   * the ground pass: a grid on the terrain under the jet and along its shadow (heights from the
//     terrain), drawn after the opaque scene, multiplying what is there by
//         (1 - f) * (1 - ao) + f * sunVisibility,      f = the sun's share of the light on the ground,
//     (the occluded sky's share turned a little towards neutral: the horizon band and the light
//     off the jet's underside), the jet's shadow sharp at the tyres and widening with the distance
//     along the ray (the sun's disc, 0.53 deg). The jet then casts nothing into the scene's map (Exterior.js), so there is one
//     shadow, not two.
// All lookups go through matrices made per camera in doubles (skin.js viewHook): no world
// coordinates on the GPU.

import * as THREE from 'three';

/**
 * Per quality: map size (0: off, the scene's shadow as before), the light's turn that redraws it
 * (rad, ~1 texel at 8 m), the shortest time between redraws (s), the filter radius (texels),
 * the occlusion map's size, ground grid cells per side.
 */
export const JET_SHADOW_QUALITY = {
  low: { size: 0 },
  medium: { size: 1024, turn: 0.0018, minAge: 0.05, kernel: 1.4, ao: 128, grid: 16, taps: 4 },
  high: { size: 2048, turn: 0.0009, minAge: 0, kernel: 1.6, ao: 256, grid: 24, taps: 8 },
};

/** Ground pass: lift over the terrain (m), and the relative depth pull towards the camera. */
export const GROUND = { lift: 0.03, pull: 3e-4, maxAgl: 60, maxLength: 250, aoHeight: 4 };

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _q = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _c = Array.from({ length: 8 }, () => new THREE.Vector3());

const AO_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying float vDist;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const AO_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec2 uAOCam;     // camera distance below the reference plane (m), height scale (m)
varying float vDist;
void main() {
  #include <logdepthbuf_fragment>
  // coverage, and the height above the reference plane (premultiplied by the coverage, for the mips)
  gl_FragColor = vec4(1.0, clamp((vDist - uAOCam.x) / uAOCam.y, 0.0, 1.0), 0.0, 1.0);
}`;

const GROUND_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vView;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const GROUND_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2DShadow uF35Shadow;
uniform mat4 uF35ShadowMat;      // view -> shadow map clip
uniform mat4 uF35ViewToBody;     // view -> body
uniform mat4 uAOMat;             // body -> occlusion map clip
uniform sampler2D uAO;
uniform vec4 uShadowG;           // depth range (m), body origin's map depth, map half size (m), texel (m)
uniform vec4 uGround;            // shadow on, occlusion amount, -, reference plane (body y)
uniform vec3 uSunShare;          // the light's share of the light on the open ground, per channel
uniform vec2 uAOScale;           // height scale (m), log2(map size / 256): the blur in metres
uniform float uPull;             // log-depth pull (relative distance)
varying vec3 vView;

float sunVis(vec3 vp) {
  float vis = 1.0;
  vec4 c = uF35ShadowMat * vec4(vp, 1.0);
  vec3 s = c.xyz * 0.5 + 0.5;
  if (uGround.x > 0.5 && all(greaterThan(s.xy, vec2(0.0))) && all(lessThan(s.xy, vec2(1.0)))) {
    // the penumbra grows with the distance along the ray behind the jet's middle (sun's disc
    // 0.53 deg), from the filter's own width at the tyres
    float behind = max(s.z - uShadowG.y, 0.0) * uShadowG.x;
    float rm = max(1.4 * uShadowG.w, 0.0047 * behind);
    float r = min(rm, 0.6) / (2.0 * uShadowG.z);
    float ref = min(s.z, 1.0) - 1.5 * uShadowG.w / uShadowG.x;
    float a = 0.0;
    #if TAPS == 8
    const float GA = 2.39996323;
    for (int i = 0; i < 8; i++) {
      float rr = sqrt((float(i) + 0.5) / 8.0);
      float t = float(i) * GA;
      a += texture(uF35Shadow, vec3(s.xy + r * rr * vec2(cos(t), sin(t)), ref));
    }
    vis = a / 8.0;
    #else
    a += texture(uF35Shadow, vec3(s.xy + r * vec2( 0.6,  0.8), ref));
    a += texture(uF35Shadow, vec3(s.xy + r * vec2(-0.8,  0.6), ref));
    a += texture(uF35Shadow, vec3(s.xy + r * vec2(-0.6, -0.8), ref));
    a += texture(uF35Shadow, vec3(s.xy + r * vec2( 0.8, -0.6), ref));
    vis = a / 4.0;
    #endif
    // long shadows fade as the penumbra eats them (sunset)
    vis = mix(vis, 1.0, smoothstep(0.3, 0.6, rm));
  }
  return vis;
}

float skyOcclusion(vec3 vp) {
  float ao = 0.0;
  if (uGround.y > 0.0) {
    vec3 pb = (uF35ViewToBody * vec4(vp, 1.0)).xyz;
    vec4 c = uAOMat * vec4(pb, 1.0);
    vec2 uv = c.xy * 0.5 + 0.5;
    if (all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) {
      vec2 a0 = textureLod(uAO, uv, 0.0).rg;
      vec2 a2 = textureLod(uAO, uv, max(2.5 + uAOScale.y, 0.0)).rg;
      vec2 a4 = textureLod(uAO, uv, max(4.3 + uAOScale.y, 0.0)).rg;
      // height of the underside above this ground point
      float h0 = uGround.w + uAOScale.x * a0.g / max(a0.r, 1e-3) - pb.y;
      float h2 = uGround.w + uAOScale.x * a2.g / max(a2.r, 1e-3) - pb.y;
      float h4 = uGround.w + uAOScale.x * a4.g / max(a4.r, 1e-3) - pb.y;
      float contact = a0.r * (1.0 - smoothstep(0.02, 0.35, h0));
      float mid = a2.r * (1.0 - smoothstep(0.3, 3.0, h2));
      float wide = a4.r * (1.0 - smoothstep(0.6, 6.0, h4));
      // (the sky seen under the fuselage's middle is ~10 % of the open sky's; kept lighter, as
      // the bright ground around lights the shade too)
      ao = 1.0 - (1.0 - 0.75 * contact) * (1.0 - 0.35 * mid) * (1.0 - 0.35 * wide);
      ao = min(ao, 0.62) * uGround.y;
    }
  }
  return ao;
}

void main() {
  #include <logdepthbuf_fragment>
  #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
    // over the runway's own depth pull (roadShaders.js): a fixed share of the distance
    gl_FragDepth = max(gl_FragDepth - uPull * logDepthBufFC * 0.5, 0.0);
  #endif
  float vis = sunVis(vView);
  float ao = skyOcclusion(vView);
  // the open ground's light: sky (1 - f) and sun (f); here the sky by the occlusion, the sun by the
  // jet's shadow
  vec3 f = uSunShare;
  vec3 sky = 1.0 - f;
  // under the jet what is left of the sky is the band near the horizon (paler than the whole
  // sky's blue) plus the light off the jet's underside (from the sunlit ground: neutral)
  vec3 shade = mix(sky, vec3(dot(sky, vec3(0.2126, 0.7152, 0.0722))), 0.5 * ao) * (1.0 - ao);
  vec3 k = shade + f * vis;
  gl_FragColor = vec4(k, 1.0);
  // a factor on what is in the target: encoded like the target (linear HDR buffer or sRGB canvas)
  #include <colorspace_fragment>
}`;

/** Renders the jet's opaque meshes with one material into a target (CockpitShadow's swap). */
function drawJet(renderer, root, target, camera, material, swap, clearAlpha) {
  root.traverseVisible((o) => {
    if (!o.isMesh && !o.isSprite && !o.isPoints && !o.isLine) return;
    const m = o.material;
    const cast = o.isMesh && m && !Array.isArray(m) && !m.transparent && m.depthWrite !== false && m.colorWrite !== false && !m.isShaderMaterial;
    if (cast) { swap.push(o, m); o.material = material; } else { swap.push(o, null); o.visible = false; }
  });
  const prevTarget = renderer.getRenderTarget(), prevAuto = renderer.autoClear, prevShadow = renderer.shadowMap.enabled;
  const prevColor = renderer.getClearColor(_clear), prevAlpha = renderer.getClearAlpha();
  renderer.shadowMap.enabled = false;
  renderer.autoClear = false;
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, clearAlpha);
  renderer.clear(true, true, false);
  // count this pass's draws without resetting the frame's counters (the frame's own render does)
  const info = renderer.info, prevReset = info.autoReset, calls0 = info.render.calls;
  info.autoReset = false;
  renderer.render(root, camera);
  const calls = info.render.calls - calls0;
  info.autoReset = prevReset;
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevColor, prevAlpha);
  renderer.autoClear = prevAuto;
  renderer.shadowMap.enabled = prevShadow;
  for (let k = 0; k < swap.length; k += 2) {
    const o = swap[k];
    if (swap[k + 1]) o.material = swap[k + 1]; else o.visible = true;
  }
  swap.length = 0;
  return calls;
}
const _clear = new THREE.Color();

export class JetShadow {
  /**
   * @param {object} o
   * @param {import('./AircraftVisual.js').AircraftVisual} o.visual  loaded, with visual.exterior
   * @param {object} [o.terrain] heightAt(x, z)
   */
  constructor({ visual, terrain = null }) {
    this.visual = visual;
    this.body = visual.object3d;
    this.root = visual.root;
    this.terrain = terrain;
    this.U = visual.exterior.uniforms;
    this.hook = visual.exterior.hookState;
    this.size = 0;
    this.redraws = 0;
    this.aoRedraws = 0;
    this.active = false;
    this.lastCalls = 0;
    this._swap = [];
    this._age = Infinity;
    this._aoAge = Infinity;
    this._sunBody = new THREE.Vector3();
    this._sunNow = new THREE.Vector3();
    this._sig = new Float64Array(64);
    this._sigN = 0;
    this._aoSig = new Float64Array(64);
    this._aoSigN = -1;
    this.fromBody = new THREE.Matrix4();          // body -> map clip (at the last redraw)
    // the jet's box in the body frame, from the meshes (gear down) with room for the moving parts
    this.box = new THREE.Box3();
    this.body.updateMatrixWorld(true);
    _m.copy(this.body.matrixWorld).invert();
    this.root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const b = _box.copy(o.geometry.boundingBox).applyMatrix4(_m2.multiplyMatrices(_m, o.matrixWorld));
      this.box.union(b);
    });
    this.box.expandByScalar(0.25);
    this.box.max.y += 0.5;                          // the canopy open
    // the ground plane in the body frame: the lowest tyre bottom (fully extended)
    const gc = (visual.info && visual.info.gearContacts) || [];
    this.groundY = gc.length ? Math.min(...gc.map((g) => g.pos.y)) - 0.02 : this.box.min.y;
    this.radius = Math.hypot(Math.max(-this.box.min.x, this.box.max.x), Math.max(-this.box.min.z, this.box.max.z));

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60);
    this.camera.name = 'JetShadowCamera';
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
    this.depthMaterial = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
    this.depthMaterial.name = 'JetShadowDepth';

    // the underside map (coverage, height), body frame, from below
    this.aoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 10);
    this.aoCamera.name = 'JetAOCamera';
    this.aoCamera.matrixAutoUpdate = false;
    this.aoCamera.matrixWorldAutoUpdate = false;
    this.aoMaterial = new THREE.ShaderMaterial({
      name: 'JetAO', vertexShader: AO_VERT, fragmentShader: AO_FRAG, side: THREE.DoubleSide,
      uniforms: { uAOCam: { value: new THREE.Vector2(1, GROUND.aoHeight) } },
    });
    this.aoFromBody = new THREE.Matrix4();
    this.aoTarget = null;

    // the ground pass
    this.groundU = {
      uF35Shadow: this.U.uF35Shadow,
      uF35ShadowMat: { value: new THREE.Matrix4() },
      uF35ViewToBody: { value: new THREE.Matrix4() },
      uAOMat: { value: this.aoFromBody },
      uAO: { value: null },
      uShadowG: { value: new THREE.Vector4(40, 0.5, 9, 0.01) },
      uGround: { value: new THREE.Vector4(0, 0, 0, this.groundY) },
      uSunShare: { value: new THREE.Vector3() },
      uAOScale: { value: new THREE.Vector2(GROUND.aoHeight, 0) },
      uPull: { value: Math.log2(1 + GROUND.pull) },
    };
    this.groundMaterial = new THREE.ShaderMaterial({
      name: 'JetGround', vertexShader: GROUND_VERT, fragmentShader: GROUND_FRAG,
      uniforms: this.groundU, defines: { TAPS: 8 },
      transparent: true, depthWrite: false, depthTest: true, toneMapped: false, fog: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
      // without a logarithmic depth buffer (gl_FragDepth not written) the offset does it
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
    });
    this._groundHook = { frame: -1, camera: null };
    this.groundMaterial.onBeforeRender = (renderer, scene, camera) => {
      const s = this._groundHook, f = renderer.info.render.frame;
      if (s.frame === f && s.camera === camera) return;
      s.frame = f; s.camera = camera;
      _m.copy(this.body.matrixWorld).invert().multiply(camera.matrixWorld);
      this.groundU.uF35ViewToBody.value.copy(_m);
      this.groundU.uF35ShadowMat.value.multiplyMatrices(this.fromBody, _m);
    };
    this.ground = null;
    this._gridN = 0;
    this._gridKey = new Float64Array(6).fill(NaN);
    this.setQuality('high');
  }

  setQuality(q) {
    this.q = JET_SHADOW_QUALITY[q] || JET_SHADOW_QUALITY.high;
    if (this.q.size !== this.size) {
      this._disposeTargets();
      this.size = this.q.size;
      if (this.size) {
        const depth = new THREE.DepthTexture(this.size, this.size, THREE.UnsignedIntType);
        depth.compareFunction = THREE.LessEqualCompare;
        depth.minFilter = depth.magFilter = THREE.LinearFilter;
        this.target = new THREE.WebGLRenderTarget(this.size, this.size, {
          format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: true, depthTexture: depth,
          minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
        });
        this.target.texture.name = 'JetShadow';
        this._pendingDepth = depth;
        const n = this.q.ao;
        this.aoTarget = new THREE.WebGLRenderTarget(n, n, {
          format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: true,
          minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
        });
        this.aoTarget.texture.name = 'JetAO';
        this.groundU.uAO.value = this.aoTarget.texture;
        this.groundU.uAOScale.value.set(GROUND.aoHeight, Math.log2(n / 256));
        this._aoSigN = -1;
      }
      this._age = Infinity;
    }
    if (this.groundMaterial.defines.TAPS !== (this.q.taps || 4)) {
      this.groundMaterial.defines.TAPS = this.q.taps || 4;
      this.groundMaterial.needsUpdate = true;
    }
    if (this.q.grid && this.q.grid !== this._gridN) this._buildGround(this.q.grid);
  }

  /** GPU memory (bytes): the depth map (4 B) and its colour (1 B); the occlusion map with mips. */
  bytes() {
    if (!this.size) return 0;
    const n = this.q.ao;
    return this.size * this.size * 5 + Math.round(n * n * 4 * 4 / 3) + n * n * 4;
  }

  _buildGround(n) {
    this._gridN = n;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array((n + 1) * (n + 1) * 3);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
        idx.push(a, b, c, b, d, c);                  // facing up (+y)
      }
    }
    g.setIndex(idx);
    if (this.ground) {
      this.ground.geometry.dispose();
      this.ground.geometry = g;
    } else {
      this.ground = new THREE.Mesh(g, this.groundMaterial);
      this.ground.name = 'JetGroundShadow';
      this.ground.frustumCulled = false;
      this.ground.castShadow = false;
      this.ground.receiveShadow = false;
      this.ground.renderOrder = 0.5;                 // before the landing light's pool (1, 1.5) and the smoke
      this.ground.matrixAutoUpdate = false;
    }
    this._gridKey.fill(NaN);
  }

  /** The rig's state as a vector: any change redraws the maps. */
  _signature(out) {
    const c = this.visual._ctl || {};
    let n = 0;
    for (const k of SIG_KEYS) out[n++] = Number.isFinite(c[k]) ? c[k] : 0;
    out[n++] = this.visual._nozzleOpen || 0;
    return n;
  }

  _changed(sig, n, last, lastN, eps) {
    if (n !== lastN) return true;
    for (let i = 0; i < n; i++) if (Math.abs(sig[i] - last[i]) > eps) return true;
    return false;
  }

  /**
   * Every drawn frame, after the environment (its light and shadow choice) and before the scene.
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} env Environment: lightDirection, sunLight.castShadow, uniforms uSunColor, uAmbient
   * @param {number} dt
   * @returns {boolean} whether the jet's shadow is on (the jet then casts nothing into the scene's map)
   */
  update(renderer, env, dt) {
    const U = this.U;
    if (!this.size || this._reversed(renderer) || !visibleChain(this.body)) {
      U.uF35ShadowP.value.x = 0;
      if (this.ground) this.ground.visible = false;
      this.active = false;
      return false;
    }
    if (this._pendingDepth) {
      // the first use: allocate the map (clear it) and bind it in place of the placeholder
      drawNothing(renderer, this.target);
      U.uF35Shadow.value = this._pendingDepth;
      this._pendingDepth = null;
    }
    this.active = true;
    const light = env.lightDirection;
    const casting = !!(env.sunLight && env.sunLight.castShadow && light && light.y > 0.0);
    this.body.updateWorldMatrix(true, true);
    _q.setFromRotationMatrix(this.body.matrixWorld).invert();
    const sunB = this._sunNow.copy(light).applyQuaternion(_q).normalize();     // the light in the body frame
    this._age += dt || 0;
    this._aoAge += dt || 0;
    const sig = _sigTmp, n = this._signature(sig);
    const moved = this._changed(sig, n, this._sig, this._sigN, 1e-3);
    if (casting) {
      const Q = this.q;
      const turned = !this._sunBody.lengthSq() || sunB.angleTo(this._sunBody) > Q.turn;
      if (this._age === Infinity || ((turned || moved) && this._age >= Q.minAge) || this._age > 2) {
        this._render(renderer, sunB);
        this._sunBody.copy(sunB);
        this._sig.set(sig.subarray(0, n));
        this._sigN = n;
        this._age = 0;
      }
    }
    U.uF35ShadowP.value.set(casting ? 1 : 0, this.texel || 0.01, this.depthRange || 40, this.q.kernel);
    this.hook.shadowFromBody = this.fromBody;
    this.hook.frame = -1;                                     // remake the view matrices this frame
    // the underside map: when a part moved (gear, doors, struts), at most twice a second
    const aoMoved = this._aoSigN < 0 || this._changed(sig, n, this._aoSig, this._aoSigN, 0.01);
    if (aoMoved && this._aoAge > 0.5) {
      this._renderAO(renderer);
      this._aoSig.set(sig.subarray(0, n));
      this._aoSigN = n;
      this._aoAge = 0;
    }
    this._updateGround(env, casting);
    return true;
  }

  _reversed(renderer) {
    const d = renderer.state && renderer.state.buffers && renderer.state.buffers.depth;
    return !!(d && d.getReversed && d.getReversed());
  }

  /** The depth pass: an ortho camera on the light's side of the jet's box (body frame). */
  _render(renderer, sunBody) {
    const cam = this.camera, box = this.box;
    // map axes in the body frame: z towards the light, y the fuselage's axis across it
    const z = _v2.copy(sunBody);
    const y = _v3.set(0, 0, -1).addScaledVector(z, z.z);
    if (y.lengthSq() < 1e-4) y.set(0, 1, 0).addScaledVector(z, -z.y);
    y.normalize();
    const x = _v4.crossVectors(y, z);
    const c = box.getCenter(_vc);
    let i = 0;
    for (const px of [box.min.x, box.max.x]) for (const py of [box.min.y, box.max.y]) for (const pz of [box.min.z, box.max.z]) _c[i++].set(px, py, pz).sub(c);
    let ex = 0, ey = 0, ez = 0;
    for (const p of _c) { ex = Math.max(ex, Math.abs(p.dot(x))); ey = Math.max(ey, Math.abs(p.dot(y))); ez = Math.max(ez, Math.abs(p.dot(z))); }
    const e = Math.max(ex, ey);                    // square texels
    const D = 30;
    cam.left = -e; cam.right = e; cam.bottom = -e; cam.top = e;
    cam.near = D - ez - 0.1; cam.far = D + ez + 0.1;
    cam.updateProjectionMatrix();
    _m2.makeBasis(x, y, z).setPosition(_v.copy(c).addScaledVector(z, D));
    this.fromBody.multiplyMatrices(cam.projectionMatrix, _m.copy(_m2).invert());
    this.texel = 2 * e / this.size;
    this.depthRange = cam.far - cam.near;
    this.halfSize = e;
    // the body origin's depth in the map (the ground pass's penumbra grows behind it)
    _v.set(0, 0, 0).applyMatrix4(this.fromBody);
    this.originDepth = _v.z * 0.5 + 0.5;
    cam.matrixWorld.multiplyMatrices(this.body.matrixWorld, _m2);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    this.lastCalls = drawJet(renderer, this.root, this.target, cam, this.depthMaterial, this._swap, 1);
    this.redraws++;
  }

  /** The underside map: from below the ground plane looking up the body's +y. */
  _renderAO(renderer) {
    const cam = this.aoCamera, box = this.box;
    const below = 1.0;
    const cx = 0.5 * (box.min.x + box.max.x), cz = 0.5 * (box.min.z + box.max.z);
    const e = 0.5 * Math.max(box.max.x - box.min.x, box.max.z - box.min.z) + 1.5;   // + the occlusion's reach
    cam.left = -e; cam.right = e; cam.bottom = -e; cam.top = e;
    cam.near = 0.05; cam.far = below + (box.max.y - this.groundY) + 0.5;
    cam.updateProjectionMatrix();
    // camera axes (body): looks along +y (its -z = +y): z = -y_body, y = -z_body (forward up the map)
    _m2.makeBasis(_v2.set(-1, 0, 0), _v3.set(0, 0, -1), _v4.set(0, -1, 0)).setPosition(cx, this.groundY - below, cz);
    this.aoFromBody.multiplyMatrices(cam.projectionMatrix, _m.copy(_m2).invert());
    this.aoMaterial.uniforms.uAOCam.value.set(below, GROUND.aoHeight);
    cam.matrixWorld.multiplyMatrices(this.body.matrixWorld, _m2);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    drawJet(renderer, this.root, this.aoTarget, cam, this.aoMaterial, this._swap, 0);
    this.aoRedraws++;
  }

  /** The ground grid under the jet and along its shadow, on the terrain; the ground pass's uniforms. */
  _updateGround(env, casting) {
    const g = this.ground;
    if (!g) return;
    const P = this.body.matrixWorld.elements;
    const px = P[12], py = P[13], pz = P[14];
    const h = this.terrain && typeof this.terrain.heightAt === 'function' ? this.terrain.heightAt(px, pz) : 0;
    const gh = Number.isFinite(h) ? h : 0;
    // the body's ground plane over the terrain: the jet's height above the ground
    const agl = py + this.groundY - gh;
    const L = env.lightDirection;
    // the light's share per channel on open flat ground (the terrain's own terms: the directional
    // light's colour, sun or moon, at its elevation; the sky's irradiance)
    const lc = env.sunLight ? env.sunLight.color : null, amb = env.uniforms && env.uniforms.uAmbient ? env.uniforms.uAmbient.value : null;
    const mu = Math.max(0, L.y), share = this.groundU.uSunShare.value;
    if (casting && lc && amb) {
      share.set(lc.r * mu / Math.max(1e-6, lc.r * mu + amb.r), lc.g * mu / Math.max(1e-6, lc.g * mu + amb.g), lc.b * mu / Math.max(1e-6, lc.b * mu + amb.b));
    } else share.set(0, 0, 0);
    this.sunShare = (share.x + share.y + share.z) / 3;
    const shadowOn = casting && L.y > 0.03 && agl < GROUND.maxAgl;
    const aoAmount = 1 - THREE.MathUtils.smoothstep(agl, 3, 14);
    if (!shadowOn && aoAmount <= 0) { g.visible = false; return; }
    g.visible = true;
    const Gu = this.groundU;
    Gu.uGround.value.set(shadowOn ? 1 : 0, aoAmount, 0, this.groundY);
    this.agl = agl;
    Gu.uShadowG.value.set(this.depthRange || 40, this.originDepth ?? 0.5, this.halfSize || 9, this.texel || 0.01);
    // the grid: along the light's azimuth (away from it) from the jet, as far as its shadow reaches
    const R = this.radius + 1.5;
    let ux = -L.x, uz = -L.z;
    const hl = Math.hypot(ux, uz);
    if (hl < 1e-4) { ux = 1; uz = 0; } else { ux /= hl; uz /= hl; }
    let len = 0;
    if (shadowOn) {
      const top = agl + (this.box.max.y - this.groundY);
      len = Math.min(GROUND.maxLength, top * hl / Math.max(L.y, 0.02));
    }
    const key = this._gridKey;
    const moved = !(Math.abs(key[0] - px) < 0.25 && Math.abs(key[1] - pz) < 0.25 && Math.abs(key[2] - ux) < 0.01 &&
      Math.abs(key[3] - uz) < 0.01 && Math.abs(key[4] - len) < 0.5 && Math.abs(key[5] - gh) < 0.05);
    if (moved) {
      key[0] = px; key[1] = pz; key[2] = ux; key[3] = uz; key[4] = len; key[5] = gh;
      const n = this._gridN, pos = g.geometry.attributes.position.array;
      const u0 = -R, u1 = len + R;
      let k = 0;
      for (let j = 0; j <= n; j++) {
        // more rows near the jet: u spaced quadratically
        const t = j / n, u = u0 + (u1 - u0) * t * (0.35 + 0.65 * t);
        for (let i = 0; i <= n; i++) {
          const v = -R + 2 * R * i / n;
          const x = ux * u - uz * v, z = uz * u + ux * v;
          const th = this.terrain && this.terrain.heightAt ? this.terrain.heightAt(px + x, pz + z) : gh;
          pos[k++] = x; pos[k++] = (Number.isFinite(th) ? th : gh) + GROUND.lift - gh; pos[k++] = z;
        }
      }
      g.geometry.attributes.position.needsUpdate = true;
      g.matrix.makeTranslation(px, gh, pz);
      g.matrixWorld.copy(g.matrix);
      g.matrixWorldNeedsUpdate = true;
    }
  }

  dispose() {
    this._disposeTargets();
    this.depthMaterial.dispose();
    this.aoMaterial.dispose();
    this.groundMaterial.dispose();
    if (this.ground) {
      if (this.ground.parent) this.ground.parent.remove(this.ground);
      this.ground.geometry.dispose();
    }
  }

  _disposeTargets() {
    if (this.target) {
      if (this.U.uF35Shadow.value === this.target.depthTexture) this.U.uF35Shadow.value = this._placeholder();
      this.target.depthTexture?.dispose();
      this.target.dispose();
      this.target = null;
    }
    if (this.aoTarget) { this.aoTarget.dispose(); this.aoTarget = null; this.groundU.uAO.value = null; }
    this._pendingDepth = null;
    this.U.uF35ShadowP.value.x = 0;
  }

  _placeholder() {
    const t = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    t.compareFunction = THREE.LessEqualCompare;
    t.needsUpdate = true;
    return t;
  }
}

/** The rig's controls that move what casts on the outside (not the stick, the throttle, the head). */
const SIG_KEYS = ['stick_pitch', 'stick_roll', 'pedals', 'flaps', 'speedbrake', 'gear', 'nws', 'weapon_bays', 'canopy',
  'refuel_door', 'gun_door', 'tailhook', 'strut_nose', 'strut_left', 'strut_right'];
const _box = new THREE.Box3();
const _vc = new THREE.Vector3();
const _sigTmp = new Float64Array(64);

/** The object and all its parents visible (the e2e and some views hide the jet). */
function visibleChain(o) {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/** Allocate a render target's attachments (and clear them) outside a frame. */
function drawNothing(renderer, target) {
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.clear(true, true, false);
  renderer.setRenderTarget(prev);
}
