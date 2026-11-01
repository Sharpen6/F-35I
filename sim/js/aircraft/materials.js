// Materials of the exported F-35I, adapted for real-time three.js after GLTFLoader.
//
// * Glass (any material with KHR_materials_transmission: canopy, EOTS window, helmet visor). three.js
//   transmission re-renders the opaque scene (terrain included) into a texture every frame, so the
//   glass is drawn in two cheap passes instead:
//     1. tint:     MultiplyBlending, every surface crossing multiplies what is behind by the glass
//                  colour less the Fresnel reflectance (Cycles does the same per surface: the 12 mm
//                  solidified canopy gives the amber view through both walls seen in photos);
//     2. reflect:  additive, a black MeshPhysicalMaterial (specular + environment only, thin-film
//                  iridescence for the canopy's gold ITO coating), outer surfaces only.
//   From the cockpit the tint is weakened (uInside) so the world does not turn amber.
// * Decals (F35_Decal_*): alpha-blended, no depth write, polygon offset against the skin.
// * Light lenses keep their materials; lights.js switches their emission.
// * Textures get anisotropic filtering; meshes cast and receive shadows (glass, decals do not cast).

import * as THREE from 'three';

// Blender's canopy coating (scripts/f35/materials.py): 131 nm film of n 1.62 on the glass
const THIN_FILM = { F35_canopy: { ior: 1.62, nm: 131 }, F35_eots_glass: { ior: 1.9, nm: 220 } };

const TINT_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vNormalV;
  varying vec3 vViewV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewV = -mv.xyz;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

const TINT_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uTint;        // per-surface transmittance (linear)
  uniform float uInside;     // 0 outside .. 1 camera in the cockpit
  uniform float uF0;
  varying vec3 vNormalV;
  varying vec3 vViewV;
  void main() {
    #include <logdepthbuf_fragment>
    float c = abs(dot(normalize(vNormalV), normalize(vViewV)));
    float F = uF0 + (1.0 - uF0) * pow(1.0 - c, 5.0);
    vec3 T = pow(uTint, vec3(mix(1.0, 0.22, uInside)));
    gl_FragColor = vec4(T * (1.0 - F * mix(1.0, 0.3, uInside)), 1.0);
    // a factor on what is already in the target: encode it like the target (sRGB canvas or linear
    // HDR buffer), so it multiplies the light rather than the display values
    #include <colorspace_fragment>
  }`;

/** Glass in two passes; returns the shared uniforms ({uInside}) to drive from the visual. */
function makeGlass(mesh, src, shared) {
  const tint = src.color.clone();
  const tintMat = new THREE.ShaderMaterial({
    name: src.name + '_tint',
    uniforms: { uTint: { value: tint }, uInside: shared.uInside, uF0: { value: 0.045 } },
    vertexShader: TINT_VERT,
    fragmentShader: TINT_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.MultiplyBlending,
    premultipliedAlpha: true,
  });
  const film = THIN_FILM[src.name];
  const refl = new THREE.MeshPhysicalMaterial({
    name: src.name + '_reflect',
    color: 0x000000,
    metalness: 0,
    roughness: Math.max(0.02, src.roughness ?? 0.02),
    ior: src.ior ?? 1.5,
    specularIntensity: 1,
    specularColor: src.specularColor ? src.specularColor.clone() : new THREE.Color(1, 1, 1),
    iridescence: film ? 1 : 0,
    iridescenceIOR: film ? film.ior : 1.3,
    iridescenceThicknessMinimum: film ? film.nm : 100,
    iridescenceThicknessMaximum: film ? film.nm : 400,
    clearcoat: src.clearcoat ?? 0,
    clearcoatRoughness: src.clearcoatRoughness ?? 0,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
  });
  // only surfaces facing away from the glass's own centre reflect (the outer skin of the shell):
  // the inner faces would mirror the sky into the cockpit and over the pilot
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox;
  const centre = bb.getCenter(new THREE.Vector3());
  if (src.name === 'F35_canopy') centre.y = bb.min.y;        // bubble: from the sill line
  refl.onBeforeCompile = (sh) => {
    sh.uniforms.uGlassCentre = { value: centre };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uGlassCentre;\nvarying float vOutward;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvOutward = dot(objectNormal, position - uGlassCentre);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vOutward;')
      .replace('#include <clipping_planes_fragment>', 'if (vOutward < 0.0) discard;\n#include <clipping_planes_fragment>');
  };
  refl.customProgramCacheKey = () => 'f35glass';
  mesh.material = tintMat;
  mesh.renderOrder = 2;
  mesh.castShadow = false;
  const r = new THREE.Mesh(mesh.geometry, refl);
  r.name = mesh.name + '_reflect';
  r.renderOrder = 3;
  r.castShadow = false;
  r.receiveShadow = false;
  mesh.add(r);
  return [tintMat, refl];
}

/**
 * Prepare every material of the loaded glTF scene.
 * @returns {{byName: Map<string, THREE.Material[]>, glass: THREE.Material[], uniforms: object}}
 */
export function setupMaterials(root, { anisotropy = 8 } = {}) {
  const shared = { uInside: { value: 0 } };
  const byName = new Map();
  const glass = [];
  const seenTex = new Set();
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const mesh of meshes) {
    const mat = mesh.material;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (!mat) continue;
    for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'clearcoatMap']) {
      const t = mat[key];
      if (t && !seenTex.has(t)) { t.anisotropy = anisotropy; seenTex.add(t); }
    }
    if (mat.transmission > 0) {
      glass.push(...makeGlass(mesh, mat, shared));
      continue;
    }
    if (mat.name.startsWith('F35_Decal_')) {
      mat.transparent = true;
      mat.depthWrite = false;
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -1;
      mat.polygonOffsetUnits = -4;
      mesh.castShadow = false;
      mesh.renderOrder = 1;
    }
    if (!byName.has(mat.name)) byName.set(mat.name, []);
    const list = byName.get(mat.name);
    if (!list.includes(mat)) list.push(mat);
  }
  return { byName, glass, uniforms: shared };
}
