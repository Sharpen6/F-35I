// The canopy glass as the pilot sees it, a third pass over the glb's canopy (materials.js draws
// the amber tint and the outer reflections; this pass adds what they leave out):
//
// * haze: dust, smudges and wipe marks on the acrylic scatter the sunlight forward (a
//   Henyey-Greenstein lobe): a veil round the sun when looking towards it, nothing away from it;
// * scratches: the fine cleaning swirls and a few straight ones. A scratch scatters the light into
//   a cone about its own line, so only the scratches lying across the line to the sun light up:
//   thin bright arcs round the sun, as through every cleaned canopy (the texture carries each
//   scratch's direction, detail.js makeGlassTexture), fading with the angle from the sun;
// * from inside, the inner surface reflects the cockpit (Fresnel): the lit PCD, ray-traced off the
//   glass onto the display's rectangle and its live canvas at the display's luminance (lost in
//   the daylight; at night the reflections pilots know: faint, as the LCD sends little light that
//   steeply, and soft, out of focus for an eye on the world outside), and a faint veil from the
//   sunlit interior.
//
// Radiometry: the pass computes the radiance it adds, in scene units (linear; the sun's irradiance
// is ~4). Into the HDR frame (js/env/Post.js) it is added as it is, before the exposure and the
// tone curve. Drawn straight to the canvas (no post chain: each material tone maps itself), light
// cannot be added after the tone curve exactly; the pass then adds the increment the tone curve
// gives over a typical background (the ground in this light) with a screen blend (dst + src (1 -
// dst)), which gives more over darker pixels and nothing over white, close to the curve's shape.
// (Adding a tone-mapped, sRGB-encoded glare as it was over-brightened every mid-tone behind it.)
//
// Precision: everything in the glass mesh's own frame (metres round the cockpit), the camera and
// the sun brought into it on the CPU just before the draw. World positions ~30 km from the origin
// sit on a 2 mm float32 grid, which showed as a grid of blocks in the glare.
//
// Additive, no depth write, front faces only: from inside the inner surface of the shell, from
// outside the outer one. One draw of the canopy mesh, four texture reads per pixel.

import * as THREE from 'three';

/** Scratch light: the cone's angular half-width (in cos units) and the strength (see below). */
const SCRATCH = { width: 0.02, k: 5 };

const VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec3 uCentre;
varying vec3 vP;
varying vec3 vN;
varying float vOut;
void main() {
  vP = position;
  vN = normal;
  vOut = dot( normal, position - uCentre );
  // modelViewMatrix is made on the CPU in doubles: no large world coordinates here
  gl_Position = projectionMatrix * ( modelViewMatrix * vec4( position, 1.0 ) );
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
#define SCRATCH_W ${SCRATCH.width.toFixed(4)}
#define SCRATCH_K ${SCRATCH.k.toFixed(3)}
uniform sampler2D uGlass;
uniform float uTile;        // metres per texture tile
uniform float uDirt;        // 1: a canopy in service (haze ~1-3 %, cleaning swirls)
uniform vec3 uCam;          // the camera, glass frame
uniform vec3 uSun;          // towards the light (the sun, or the moon at night), glass frame
uniform vec3 uSunE;         // its irradiance, scene units
uniform float uInside;
uniform vec3 uVeil;         // radiance of the sunlit interior the inner surface reflects
uniform float uKey;         // a typical background radiance (canvas only, see the top)
uniform sampler2D uPcd;
uniform float uPcdGain;     // the display's physical luminance at white, scene units
uniform vec2 uPcdSize;      // texels
uniform vec3 uPcdO;         // its canvas: origin, u and v edges over their squared lengths, normal
uniform vec3 uPcdU;
uniform vec3 uPcdV;
uniform vec3 uPcdN;
varying vec3 vP;
varying vec3 vN;
varying float vOut;

float ckHG( float c, float g ) {
  float g2 = g * g;
  return ( 1.0 - g2 ) / ( 4.0 * PI * pow( max( 1.0 + g2 - 2.0 * g * c, 1e-4 ), 1.5 ) );
}

// The scratches of one triplanar projection lit by the sun: texel g of the plane with axes a (u)
// and b (v), n the surface normal, q = V - S (a scratch along t lights up where q.t = 0: its
// cone through the sun reaches the eye), wide: the share lit where the directions are crossed.
float ckScratch( vec4 g, vec3 a, vec3 b, vec3 n, vec3 q, float wide ) {
  vec2 cs = g.ba * 2.0 - 1.0;                       // coverage x (cos 2a, sin 2a)
  float m = length( cs );
  vec2 u = cs / max( m, 1e-4 );
  // half the doubled angle: a line, not an arrow
  vec2 d = vec2( sqrt( max( 0.5 + 0.5 * u.x, 0.0 ) ), ( u.y >= 0.0 ? 1.0 : -1.0 ) * sqrt( max( 0.5 - 0.5 * u.x, 0.0 ) ) );
  vec3 t = a * d.x + b * d.y;
  t -= n * dot( n, t );                              // into the surface (the projection is along an axis)
  t *= inversesqrt( max( dot( t, t ), 1e-8 ) );
  float e = dot( q, t ) / SCRATCH_W;
  float coh = clamp( m / max( g.r, 1e-3 ), 0.0, 1.0 );   // 1: one direction in the texel, 0: crossed
  return g.r * ( coh * exp( - e * e ) + ( 1.0 - coh ) * wide );
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 V = normalize( vP - uCam );                   // eye -> glass
  vec3 N = normalize( vN );
  vec3 Nf = faceforward( N, V, N );                  // towards the eye
  float cv = max( - dot( Nf, V ), 0.0 );
  float F = 0.04 + 0.96 * pow( 1.0 - cv, 5.0 );
  vec3 col = vec3( 0.0 );

  // ---- sunlight scattered forward by the haze and the scratches (the sun beyond the glass; the
  // texture reads outside any branch: their mip levels need the neighbours' derivatives)
  float ci = max( - dot( Nf, uSun ), 0.0 );         // the light's incidence; 0 with it on the eye's side
  vec3 w = pow( abs( N ), vec3( 4.0 ) );
  w /= w.x + w.y + w.z;
  vec3 p = vP / uTile;
  vec4 gx = texture2D( uGlass, p.zy );
  vec4 gy = texture2D( uGlass, p.xz + 0.37 );
  vec4 gz = texture2D( uGlass, p.xy + 0.71 );
  float cosT = dot( V, uSun );
  vec3 q = V - uSun;
  float th = length( q );                            // ~ the angle from the sun
  // haze: 0.8-3.4 % of the light through the film, mostly in a narrow forward lobe
  float haze = w.x * gx.g + w.y * gy.g + w.z * gz.g;
  float phase = 0.8 * ckHG( cosT, 0.8 ) + 0.2 * ckHG( cosT, 0.3 );
  float sigma = ( 0.004 + 0.03 * haze ) * phase;
  // scratches: the coverage (wider than real ones: SCRATCH_K includes their real width), the cone,
  // a diffraction-like fall-off with the angle from the sun
  float wide = min( 1.0, 2.0 * SCRATCH_W / ( PI * th + 1e-3 ) );
  float sc = w.x * ckScratch( gx, vec3( 0.0, 0.0, 1.0 ), vec3( 0.0, 1.0, 0.0 ), N, q, wide )
           + w.y * ckScratch( gy, vec3( 1.0, 0.0, 0.0 ), vec3( 0.0, 0.0, 1.0 ), N, q, wide )
           + w.z * ckScratch( gz, vec3( 1.0, 0.0, 0.0 ), vec3( 0.0, 1.0, 0.0 ), N, q, wide );
  float D = 1.0 / ( 1.0 + th * th * 400.0 );         // (th / 0.05)^2
  // radiance: the irradiance through the film, longer paths at grazing views
  col += uSunE * ( uDirt * ci / max( cv, 0.2 ) * ( sigma + SCRATCH_K * sc * D ) );

  // ---- the cockpit reflected in the inner surface (from inside only)
  float inner = uInside * step( vOut, 0.0 );
  col += uVeil * ( F * inner );
  vec3 R = reflect( V, Nf );
  float den = dot( R, uPcdN );
  float t = dot( uPcdO - vP, uPcdN ) / min( den, -1e-3 );
  vec3 H = vP + R * t - uPcdO;
  vec2 uv = vec2( dot( H, uPcdU ), dot( H, uPcdV ) );
  float hit = step( den, -1e-3 ) * step( 0.0, t ) * step( 0.0, uv.x ) * step( uv.x, 1.0 ) * step( 0.0, uv.y ) * step( uv.y, 1.0 );
  // the mip level from the reflected footprint (the curved glass squeezes the picture: aliasing
  // otherwise), and never sharp: the acrylic is not optically flat, and with the eye focused on
  // the world outside, the display's mirror image (~1.2 m away) is ~0.8 dioptre out of focus, a
  // blur about as wide as its lettering (~0.2 deg with a night pupil, ~1/200 of its width): a
  // soft glow in the pages' colours, no readable figures
  vec2 dx = dFdx( uv ) * uPcdSize, dy = dFdy( uv ) * uPcdSize;
  float lod = clamp( 0.5 * log2( max( dot( dx, dx ), dot( dy, dy ) ) ) + 1.0, log2( uPcdSize.x / 200.0 ), 8.0 );
  // (the canvas is stored as plain RGBA8, PCD.js: decoded from sRGB here)
  vec3 pcd = sRGBTransferEOTF( textureLod( uPcd, clamp( uv, 0.0, 1.0 ), lod ) ).rgb;
  // both surfaces of the acrylic reflect (x2); an LCD is much dimmer off its axis (~10 % of its
  // brightness at 70 deg), and the light that reaches the canopy leaves it steeply
  float offAxis = clamp( - den, 0.0, 1.0 );
  col += pcd * ( 2.0 * uPcdGain * F * inner * hit * offAxis * offAxis );

  #ifdef TONE_MAPPING
    // drawn on the canvas over tone-mapped pixels: the tone curve's increment over a typical
    // background, for the screen blend
    vec3 k0 = linearToOutputTexel( vec4( toneMapping( vec3( uKey ) ), 1.0 ) ).rgb;
    vec3 k1 = linearToOutputTexel( vec4( toneMapping( vec3( uKey ) + col ), 1.0 ) ).rgb;
    gl_FragColor = vec4( max( k1 - k0, 0.0 ) / max( 1.0 - k0, vec3( 0.05 ) ), 1.0 );
  #else
    // the HDR frame: linear radiance, added
    gl_FragColor = vec4( col, 1.0 );
    #include <colorspace_fragment>
  #endif
}`;

const _inv = new THREE.Matrix4(), _n3 = new THREE.Matrix3(), _v = new THREE.Vector3();
const luma = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

export class CanopyGlass {
  /**
   * @param {object} o
   * @param {THREE.Object3D} o.root the player's glTF root
   * @param {THREE.Texture} [o.detail] the glass texture (detail.js makeGlassTexture; or setDetail)
   */
  constructor({ root, detail = null }) {
    this.mesh = null;
    this.dirt = 1;
    root.traverse((o) => { if (!this.glass && o.isMesh && o.material && o.material.name === 'F35_canopy_tint') this.glass = o; });
    if (!this.glass) { console.warn('Cockpit: no canopy glass (F35_canopy_tint)'); return; }
    const g = this.glass.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const centre = g.boundingBox.getCenter(new THREE.Vector3());
    centre.y = g.boundingBox.min.y;                     // as materials.js: the bubble from the sill line
    // the light and the display in world space (update), brought into the glass frame per draw
    this._sunW = new THREE.Vector3(0, 1, 0);
    this._pcdW = null;
    this.uniforms = {
      uCentre: { value: centre },
      uGlass: { value: detail },
      uTile: { value: 0.42 },
      uDirt: { value: 1 },
      uCam: { value: new THREE.Vector3() },
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uSunE: { value: new THREE.Color(0, 0, 0) },
      uInside: { value: 0 },
      uVeil: { value: new THREE.Color(0, 0, 0) },
      uKey: { value: 0.2 },
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
    // the screen blend for the canvas (see the top): dst + src (1 - dst)
    this.material.blendSrc = THREE.OneMinusDstColorFactor;
    this.material.blendDst = THREE.OneFactor;
    this.material.blendEquation = THREE.AddEquation;
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = this.glass.name + '_cockpit';
    this.mesh.renderOrder = 4;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = this.glass.frustumCulled;
    this.mesh.onBeforeRender = (renderer, scene, camera) => this._beforeDraw(renderer, camera);
    this.glass.add(this.mesh);
  }

  set visible(v) { if (this.mesh) this.mesh.visible = v; }
  get visible() { return !!(this.mesh && this.mesh.visible); }

  /** The glass texture (detail.js makeGlassTexture; until it is set, no haze and no scratches). */
  setDetail(t) { this.uniforms && (this.uniforms.uGlass.value = t); }

  /**
   * @param {object} s {lightDir (world, towards the sun or the moon), lightColor (its irradiance),
   *   ambient (sky irradiance), inside 0..1, albedo (the interior paint's, linear), pcd: {texture,
   *   light (its physical luminance, scene units), o, u, v, n} in world space}
   */
  update(s) {
    if (!this.mesh) return;
    const U = this.uniforms;
    this._sunW.copy(s.lightDir);
    U.uSunE.value.copy(s.lightColor);
    U.uInside.value = s.inside;
    U.uDirt.value = this.dirt;
    // the veil: the interior (albedo ~6-8 %) lit by the sun through the canopy and by the sky
    const sunUp = Math.max(0, s.lightDir.y);
    const a = (s.albedo ?? 0.06) / Math.PI;
    const E = s.lightColor, A = s.ambient;
    U.uVeil.value.setRGB(a * (E.r * sunUp * 0.5 + A.r * 0.35), a * (E.g * sunUp * 0.5 + A.g * 0.35), a * (E.b * sunUp * 0.5 + A.b * 0.35));
    // a typical background for the canvas blend: the ground (albedo ~15 %) in this light
    U.uKey.value = Math.max(1e-6, 0.15 / Math.PI * (luma(E) * sunUp + luma(A)));
    const p = s.pcd;
    this._pcdW = p && p.texture ? p : null;
    if (this._pcdW) {
      U.uPcd.value = p.texture;
      U.uPcdGain.value = p.light;
      const img = p.texture.image;
      if (img && img.width) U.uPcdSize.value.set(img.width, img.height);
    } else {
      U.uPcdGain.value = 0;
    }
  }

  /** Just before the draw: the camera, the light and the display in the glass frame; the blend. */
  _beforeDraw(renderer, camera) {
    const U = this.uniforms;
    _inv.copy(this.mesh.matrixWorld).invert();
    U.uCam.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_inv);
    U.uSun.value.copy(this._sunW).transformDirection(_inv);
    const p = this._pcdW;
    if (p) {
      _n3.setFromMatrix4(_inv);
      U.uPcdO.value.copy(p.o).applyMatrix4(_inv);
      _v.copy(p.u).applyMatrix3(_n3);
      U.uPcdU.value.copy(_v).divideScalar(Math.max(1e-9, _v.lengthSq()));
      _v.copy(p.v).applyMatrix3(_n3);
      U.uPcdV.value.copy(_v).divideScalar(Math.max(1e-9, _v.lengthSq()));
      U.uPcdN.value.copy(p.n).transformDirection(_inv);
    }
    // linear radiance into an HDR target; on the canvas the screen blend (TONE_MAPPING in the shader)
    this.material.blending = renderer.getRenderTarget() ? THREE.AdditiveBlending : THREE.CustomBlending;
  }

  dispose() {
    if (!this.mesh) return;
    this.glass.remove(this.mesh);
    this.material.dispose();
  }
}
