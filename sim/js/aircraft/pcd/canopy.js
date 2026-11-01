// The canopy glass as the pilot sees it, a third pass over the glb's canopy (materials.js draws
// the amber tint and the outer reflections; this pass adds what they leave out):
//
// * dust, smudges and fine scratches (cleaning swirls) on the acrylic scatter the sunlight: faint
//   on the clean glass, a glare that lights up the streaks when looking towards the sun (a
//   forward-peaked Henyey-Greenstein phase), on both sides of the glass;
// * from inside, the inner surface reflects the cockpit (Fresnel): the lit PCD, ray-traced off the
//   glass onto the display's rectangle and its live canvas (the night reflections pilots know), and
//   a faint veil from the sunlit interior.
//
// Additive, no depth write, front faces only: from inside the inner surface of the shell, from
// outside the outer one. One draw of the canopy mesh, four texture reads per pixel.

import * as THREE from 'three';
import { TRIPLANAR_GLSL } from './detail.js';

const VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec3 uCentre;
varying vec3 vW;
varying vec3 vNw;
varying vec3 vObj;
varying vec3 vObjN;
varying float vOut;
void main() {
  vec4 w = modelMatrix * vec4( position, 1.0 );
  vW = w.xyz;
  vNw = normalize( mat3( modelMatrix ) * normal );
  vObj = position;
  vObjN = normal;
  vOut = dot( normal, position - uCentre );
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uDetail;
uniform float uTile;
uniform float uDirt;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uInside;
uniform vec3 uVeil;
uniform sampler2D uPcd;
uniform float uPcdGain;
uniform vec2 uPcdSize;  // texels
uniform vec3 uPcdO;
uniform vec3 uPcdU;     // edge along u / its squared length
uniform vec3 uPcdV;
uniform vec3 uPcdN;     // the display's normal (towards the pilot)
varying vec3 vW;
varying vec3 vNw;
varying vec3 vObj;
varying vec3 vObjN;
varying float vOut;
${TRIPLANAR_GLSL}
float ckHG( float c, float g ) {
  float g2 = g * g;
  return ( 1.0 - g2 ) / ( 4.0 * PI * pow( max( 1.0 + g2 - 2.0 * g * c, 1e-4 ), 1.5 ) );
}
void main() {
  #include <logdepthbuf_fragment>
  vec3 V = normalize( vW - cameraPosition );          // eye -> glass
  vec3 N = normalize( vNw );
  N = faceforward( N, V, N );                          // towards the eye
  float c = abs( dot( N, V ) );
  float F = 0.04 + 0.96 * pow( 1.0 - c, 5.0 );
  vec3 Nout = normalize( vNw ) * ( vOut >= 0.0 ? 1.0 : -1.0 );
  vec4 d = ckTriplanar( uDetail, vObj, vObjN, uTile );
  // ---- sunlight scattered by dust, smudges and scratches
  float lit = smoothstep( -0.05, 0.2, dot( Nout, uSunDir ) );
  float cosT = dot( V, uSunDir );                      // 1: the sun right behind the glass
  float sigma = uDirt * ( 0.002 + 0.012 * d.g + 0.1 * d.r * d.r + 0.05 * d.a );
  float phase = 0.85 * ckHG( cosT, 0.9 ) + 0.15 * ckHG( cosT, 0.5 );
  vec3 col = uSunColor * ( lit * sigma * phase / max( c, 0.25 ) );
  // ---- the cockpit reflected in the inner surface (from inside only), without branches
  float inner = uInside * step( vOut, 0.0 );
  col += uVeil * ( F * inner );
  vec3 R = reflect( V, N );
  float den = dot( R, uPcdN );
  float t = dot( uPcdO - vW, uPcdN ) / min( den, -1e-3 );
  vec3 H = vW + R * t - uPcdO;
  vec2 uv = vec2( dot( H, uPcdU ), dot( H, uPcdV ) );
  float hit = step( den, -1e-3 ) * step( 0.0, t ) * step( 0.0, uv.x ) * step( uv.x, 1.0 ) * step( 0.0, uv.y ) * step( uv.y, 1.0 );
  // the mip level from the reflected footprint (the curved glass squeezes the picture: aliasing
  // otherwise), a little softer than sharp (the acrylic is not optically flat)
  vec2 gx = dFdx( uv ) * uPcdSize, gy = dFdy( uv ) * uPcdSize;
  float lod = clamp( 0.5 * log2( max( dot( gx, gx ), dot( gy, gy ) ) ) + 1.0, 1.5, 8.0 );
  vec3 pcd = textureLod( uPcd, clamp( uv, 0.0, 1.0 ), lod ).rgb;
  // both surfaces of the acrylic reflect (x2); an LCD is dimmer off its axis (the light that
  // reaches the canopy leaves it steeply)
  col += pcd * ( 2.0 * uPcdGain * F * inner * hit * sqrt( clamp( - den, 0.0, 1.0 ) ) );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class CanopyGlass {
  /**
   * @param {object} o
   * @param {THREE.Object3D} o.root the player's glTF root
   * @param {THREE.Texture} o.detail detail texture (detail.js)
   */
  constructor({ root, detail }) {
    this.mesh = null;
    root.traverse((o) => { if (!this.glass && o.isMesh && o.material && o.material.name === 'F35_canopy_tint') this.glass = o; });
    if (!this.glass) { console.warn('Cockpit: no canopy glass (F35_canopy_tint)'); return; }
    const g = this.glass.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const centre = g.boundingBox.getCenter(new THREE.Vector3());
    centre.y = g.boundingBox.min.y;                     // as materials.js: the bubble from the sill line
    this.uniforms = {
      uCentre: { value: centre },
      uDetail: { value: detail },
      uTile: { value: 0.42 },
      uDirt: { value: 1 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(0, 0, 0) },
      uInside: { value: 0 },
      uVeil: { value: new THREE.Color(0, 0, 0) },
      uPcd: { value: null },
      uPcdGain: { value: 0 },
      uPcdSize: { value: new THREE.Vector2(1024, 1024) },
      uPcdO: { value: new THREE.Vector3() },
      uPcdU: { value: new THREE.Vector3() },
      uPcdV: { value: new THREE.Vector3() },
      uPcdN: { value: new THREE.Vector3(0, 0, 1) },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'F35_canopy_cockpit',
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = this.glass.name + '_cockpit';
    this.mesh.renderOrder = 4;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = this.glass.frustumCulled;
    this.glass.add(this.mesh);
  }

  set visible(v) { if (this.mesh) this.mesh.visible = v; }
  get visible() { return !!(this.mesh && this.mesh.visible); }

  /**
   * @param {object} s {sunDir, sunColor (irradiance), ambient (sky irradiance), inside 0..1,
   *                    pcd: {texture, gain, o, u, v, n} in world space}
   */
  update(s) {
    if (!this.mesh) return;
    const U = this.uniforms;
    U.uSunDir.value.copy(s.sunDir);
    U.uSunColor.value.copy(s.sunColor);
    U.uInside.value = s.inside;
    // the veil: a dark interior (albedo ~6 %) lit by the sun through the canopy and the sky
    const sunIn = Math.max(0, s.sunDir.y) * 0.5;
    U.uVeil.value.setRGB(
      0.06 / Math.PI * (s.sunColor.r * sunIn + s.ambient.r * 0.35),
      0.06 / Math.PI * (s.sunColor.g * sunIn + s.ambient.g * 0.35),
      0.06 / Math.PI * (s.sunColor.b * sunIn + s.ambient.b * 0.35));
    const p = s.pcd;
    if (p && p.texture) {
      U.uPcd.value = p.texture;
      U.uPcdGain.value = p.gain;
      const img = p.texture.image;
      if (img && img.width) U.uPcdSize.value.set(img.width, img.height);
      U.uPcdO.value.copy(p.o);
      U.uPcdU.value.copy(p.u).divideScalar(Math.max(1e-9, p.u.lengthSq()));
      U.uPcdV.value.copy(p.v).divideScalar(Math.max(1e-9, p.v.lengthSq()));
      U.uPcdN.value.copy(p.n);
    } else {
      U.uPcdGain.value = 0;
    }
  }

  dispose() {
    if (!this.mesh) return;
    this.glass.remove(this.mesh);
    this.material.dispose();
  }
}
