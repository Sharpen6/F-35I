// The cockpit's own sun shadow: a small depth map of the player's aircraft seen from the sun,
// framed on the cockpit, sampled by the interior materials (interior.js) on top of the scene's
// shadow map.
//
// Why: the scene's sun shadow covers hundreds of metres with a bias of ~0.8 m, so inside the tub
// it shadows nothing: at sunset the low sun lit the pilot's knees and the floor straight through
// the sills. This map covers the cockpit box only (texels of 2-4 mm), with a normal offset of a
// few millimetres: the sills, the canopy frame, the seat and the pilot cast their shadows inside.
//
// The map lives in the aircraft's frame: it is redrawn when the light turns in that frame (a
// fraction of a degree), the canopy moves, or the stick and the throttle (and the hands on them)
// move, 10-20 times a second at most; parked, it stays as it is. The lookup matrix (view space ->
// the map) is made every frame from the current camera and aircraft, in doubles (no large world
// coordinates on the GPU). One depth pass of the aircraft's opaque
// meshes when redrawn (~100 draws; the pixels clipped to the box, not the vertices).
//
//   const s = new CockpitShadow({ root, box, alsoCast });   // box: {min, max} in the root frame
//   s.setQuality('medium');                                 // SHADOW_QUALITY: low has none
//   s.update(renderer, camera, lightDirWorld, dt, force);   // before the frame is drawn
//   s.precompile(warmup);                                   // the depth program ahead (js/env/warmup.js)
//   s.uniforms -> uCkShadow (sampler2DShadow), uCkShadowMat, uCkShadowOn, uCkSunView, uCkShadowTexel

import * as THREE from 'three';

/**
 * Per graphics quality: map size (0 off); redrawn on a turn of the light (rad: ~1 texel at a metre),
 * with the stick or the throttle moving at most every `moving` s, and at least every `age` s.
 */
export const SHADOW_QUALITY = {
  low: { size: 0 },
  medium: { size: 1024, turn: 0.0026, moving: 0.1, age: 2 },
  high: { size: 2048, turn: 0.0017, moving: 0.05, age: 2 },
};

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _v = new THREE.Vector3(), _q = new THREE.Quaternion();
const _corners = Array.from({ length: 8 }, () => new THREE.Vector3());

export class CockpitShadow {
  /**
   * @param {object} o
   * @param {THREE.Object3D} o.root the aircraft's glTF root (what casts, and the frame of the map)
   * @param {{min: number[], max: number[]}} o.box the cockpit in the root frame (the receivers)
   * @param {THREE.Object3D[]} [o.alsoCast] hidden objects that still cast (the pilot's head)
   */
  constructor({ root, box, alsoCast = [] }) {
    this.root = root;
    this.box = new THREE.Box3(new THREE.Vector3(...box.min), new THREE.Vector3(...box.max));
    this.alsoCast = alsoCast;
    this.size = 0;
    this.redraws = 0;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60);
    this.camera.name = 'CockpitShadowCamera';
    this.depthMaterial = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
    this.depthMaterial.name = 'CockpitShadowDepth';
    this.uniforms = {
      uCkShadow: { value: null },
      uCkShadowMat: { value: new THREE.Matrix4() },
      uCkShadowOn: { value: 0 },
      uCkSunView: { value: new THREE.Vector3(0, 0, 1) },
      uCkShadowTexel: { value: 0.004 },
    };
    this._sunLocal = new THREE.Vector3(0, 0, 0);   // the light in the root frame at the last redraw
    this._mapFromRoot = new THREE.Matrix4();        // root frame -> the map's clip space (at the last redraw)
    this._age = Infinity;
    this._swap = [];
    this.setQuality('medium');
  }

  setQuality(q) {
    this.q = SHADOW_QUALITY[q] || SHADOW_QUALITY.medium;
    if (this.q.size === this.size) return;
    this._disposeTarget();
    this.size = this.q.size;
    if (!this.size) { this.uniforms.uCkShadowOn.value = 0; return; }
    const depth = new THREE.DepthTexture(this.size, this.size, THREE.UnsignedIntType);
    depth.compareFunction = THREE.LessEqualCompare;   // hardware 2x2 comparisons (sampler2DShadow)
    depth.minFilter = depth.magFilter = THREE.LinearFilter;
    // (the colour attachment is not used: one byte a texel)
    this.target = new THREE.WebGLRenderTarget(this.size, this.size, {
      format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: true, depthTexture: depth,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    this.target.texture.name = 'CockpitShadow';
    this.uniforms.uCkShadow.value = depth;
    this._age = Infinity;
  }

  /** GPU memory of the map (bytes): 4 a texel of depth, 1 of colour. */
  bytes() { return this.size ? this.size * this.size * 5 : 0; }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera the camera the frame is drawn with
   * @param {THREE.Vector3} light towards the sun (or the moon), world
   * @param {number} dt
   * @param {boolean} [force] redraw now (the canopy moved)
   * @param {boolean} [moving] casters moved since the last redraw (the stick, the throttle, the hands)
   * @returns {boolean} whether the map was redrawn
   */
  update(renderer, camera, light, dt, force = false, moving = false) {
    const U = this.uniforms;
    if (!this.size || !renderer || light.lengthSq() < 0.5 || this._reversed(renderer)) { U.uCkShadowOn.value = 0; return false; }
    this.root.updateWorldMatrix(true, false);
    // the light in the root frame (rotation only)
    _q.setFromRotationMatrix(this.root.matrixWorld).invert();
    _v.copy(light).applyQuaternion(_q).normalize();
    this._age += dt || 0;
    const Q = this.q;
    const redraw = force || !this._sunLocal.lengthSq() || _v.angleTo(this._sunLocal) > Q.turn ||
      (moving && this._age >= Q.moving) || this._age >= Q.age;
    if (redraw) {
      this._render(renderer, _v);
      this._sunLocal.copy(_v);
      this._age = 0;
    }
    // view space -> world -> root -> the map (from its last redraw), in doubles
    _m.copy(this.root.matrixWorld).invert().multiply(camera.matrixWorld);
    U.uCkShadowMat.value.multiplyMatrices(this._mapFromRoot, _m);
    // the light in view space (to pick the sun among the directional lights)
    _m2.copy(camera.matrixWorld).invert();
    U.uCkSunView.value.copy(light).transformDirection(_m2);
    U.uCkShadowOn.value = 1;
    return redraw;
  }

  _reversed(renderer) {
    const r = renderer.state && renderer.state.buffers && renderer.state.buffers.depth.getReversed ? renderer.state.buffers.depth.getReversed() : false;
    if (r && !this._warned) { this._warned = true; console.warn('Cockpit: no cockpit shadow map with a reversed depth buffer'); }
    return r;
  }

  /** The depth pass: the camera on the light's side of the box (root frame), framed on it. */
  _render(renderer, sunLocal) {
    const cam = this.camera, box = this.box;
    // axes in the root frame: z towards the light, y the fuselage's axis across it (a tight frame)
    const z = sunLocal;
    const y = _v2.set(0, 0, 1).addScaledVector(z, -z.z);
    if (y.lengthSq() < 1e-4) y.set(0, 1, 0).addScaledVector(z, -z.y);
    y.normalize();
    const x = _v3.crossVectors(y, z);
    const c = box.getCenter(_v4);
    // the box's extent on those axes
    let i = 0;
    for (const px of [box.min.x, box.max.x]) for (const py of [box.min.y, box.max.y]) for (const pz of [box.min.z, box.max.z]) _corners[i++].set(px, py, pz).sub(c);
    let ex = 0, ey = 0, ez = 0;
    for (const p of _corners) { ex = Math.max(ex, Math.abs(p.dot(x))); ey = Math.max(ey, Math.abs(p.dot(y))); ez = Math.max(ez, Math.abs(p.dot(z))); }
    const D = 30;                                    // the camera 30 m towards the light: all of the airframe in front
    cam.left = -ex; cam.right = ex; cam.bottom = -ey; cam.top = ey;
    cam.near = 0.05; cam.far = D + ez + 0.1;
    cam.updateProjectionMatrix();
    // the camera's pose in the root frame, then in the world
    _m2.makeBasis(x, y, z).setPosition(_v5.copy(c).addScaledVector(z, D));
    this._mapFromRoot.multiplyMatrices(cam.projectionMatrix, _m.copy(_m2).invert());
    this.uniforms.uCkShadowTexel.value = 2 * Math.max(ex, ey) / this.size;
    cam.matrixWorld.multiplyMatrices(this.root.matrixWorld, _m2);
    cam.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale);
    cam.matrixAutoUpdate = false;
    cam.matrix.copy(cam.matrixWorld);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    cam.matrixWorldAutoUpdate = false;
    // the casters: the opaque meshes drawn with the depth material, everything else hidden
    const swap = this._swap;
    swap.length = 0;
    for (const o of this.alsoCast) if (o && !o.visible) { o.visible = true; swap.push(o, null, false); }
    this.root.traverseVisible((o) => {
      if (!o.isMesh && !o.isSprite && !o.isPoints && !o.isLine) return;
      const m = o.material;
      const cast = o.isMesh && m && !Array.isArray(m) && !m.transparent && m.depthWrite !== false && m.colorWrite !== false && !m.isShaderMaterial;
      if (cast) { swap.push(o, m, true); o.material = this.depthMaterial; } else { swap.push(o, null, true); o.visible = false; }
    });
    const prevTarget = renderer.getRenderTarget(), prevAuto = renderer.autoClear, prevShadow = renderer.shadowMap.enabled;
    renderer.shadowMap.enabled = false;               // the root's own lights must not redraw their maps here
    renderer.autoClear = false;
    renderer.setRenderTarget(this.target);
    renderer.clear(false, true, false);               // depth only (the colour is not read)
    renderer.render(this.root, cam);
    this.lastCalls = renderer.info.render.calls;
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAuto;
    renderer.shadowMap.enabled = prevShadow;
    for (let k = 0; k < swap.length; k += 3) {
      const o = swap[k];
      if (swap[k + 1]) o.material = swap[k + 1];
      else if (swap[k + 2]) o.visible = true;
      else o.visible = false;                          // alsoCast: hidden again
    }
    swap.length = 0;
    this.redraws++;
  }

  /**
   * Builds the depth pass's program ahead (js/env/warmup.js; before, it was built in the first
   * cockpit frame of a flight: ~0.5 s on ANGLE), as _render draws it: the casters with the depth
   * material and nothing else, no scene (no fog, none of the scene's lights), shadow maps off,
   * into a target (any: also when the quality has no map yet, so a later switch finds it built).
   */
  precompile(w) {
    const r = w.renderer, swap = this._swap;
    swap.length = 0;
    this.root.traverse((o) => {
      if (!o.isMesh && !o.isSprite && !o.isPoints && !o.isLine) return;
      const m = o.material;
      const cast = o.isMesh && m && !Array.isArray(m) && !m.transparent && m.depthWrite !== false && m.colorWrite !== false && !m.isShaderMaterial;
      swap.push(o, m);
      o.material = cast ? this.depthMaterial : null;      // (renderer.compile skips an object without a material)
    });
    const prevShadow = r.shadowMap.enabled;
    r.shadowMap.enabled = false;
    try {
      w.compile(this.root, this.camera, { target: this.target || w.floatTarget() });
    } finally {
      r.shadowMap.enabled = prevShadow;
      for (let k = 0; k < swap.length; k += 2) swap[k].material = swap[k + 1];
      swap.length = 0;
    }
  }

  _disposeTarget() {
    if (!this.target) return;
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.target = null;
    this.uniforms.uCkShadow.value = null;
  }

  dispose() {
    this._disposeTarget();
    this.depthMaterial.dispose();
  }
}

const _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();

/**
 * GLSL for the interior materials: the cockpit shadow of the sun's light (1 lit, 0 shadowed), for a
 * directional light towards L (view space), at view-space point p with normal n.
 */
export const SHADOW_GLSL = /* glsl */`
uniform sampler2DShadow uCkShadow;
uniform mat4 uCkShadowMat;
uniform float uCkShadowOn;
uniform vec3 uCkSunView;
uniform float uCkShadowTexel;
float ckSunShadow( vec3 L, vec3 p, vec3 n ) {
  if ( uCkShadowOn < 0.5 || dot( L, uCkSunView ) < 0.9999 ) return 1.0;
  // a normal offset of ~1.5 texels (no acne on the lit side, none of the thin walls' light leaks
  // through), more at grazing light
  float nl = dot( n, L );
  vec3 q = p + n * ( uCkShadowTexel * ( 1.5 + 2.0 * ( 1.0 - abs( nl ) ) ) );
  vec4 c = uCkShadowMat * vec4( q, 1.0 );
  vec3 s = c.xyz * 0.5 + 0.5;
  if ( any( lessThan( s, vec3( 0.0 ) ) ) || any( greaterThan( s, vec3( 1.0 ) ) ) ) return 1.0;
  s.z -= 0.0001;
  // five hardware-filtered taps (a 2-3 texel penumbra)
  vec2 d = vec2( 1.0 / float( textureSize( uCkShadow, 0 ).x ) );
  float v = texture( uCkShadow, s ) * 2.0
    + texture( uCkShadow, vec3( s.xy + vec2( d.x, d.y ) * 1.2, s.z ) )
    + texture( uCkShadow, vec3( s.xy + vec2( -d.x, d.y ) * 1.2, s.z ) )
    + texture( uCkShadow, vec3( s.xy + vec2( d.x, -d.y ) * 1.2, s.z ) )
    + texture( uCkShadow, vec3( s.xy + vec2( -d.x, -d.y ) * 1.2, s.z ) );
  // the side facing away from the light gets none anyway
  return v / 6.0;
}
`;
