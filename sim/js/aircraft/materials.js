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
// * Calibration (TUNE below): the exported values are Blender's, made for Cycles; here they are
//   matched to photos of IAF F-35Is (noon on the ramp, 07:00, dusk) in three.js's BRDF.
// * The nozzle gets its own copy of F35_Misc_B with heat staining (NOZZLE below).
// * Ambient occlusion (exports from sim/tools/aircraft with rig.ao): the skin atlases carry it in the
//   ORM texture's R channel (glTF occlusionTexture, three.js aoMap), every other part per vertex in
//   COLOR_0. three.js would tint the diffuse colour by COLOR_0; here it darkens the ambient light
//   only, like aoMap (sky and environment, not the sun: shadow maps do that). Older exports have
//   neither and render as before.

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

// ------------------------------------------------------------------------------- calibration
// three.js has no Blender-style coat-over-sheen layering: the exported clear coat (0.5, roughness 0.3)
// and sheen (tint 0.15) mirrored the bright horizon sharply and read as polished aluminium or grey
// plastic (the review's "light-grey chrome" at noon). The Have Glass coating is a satin, faintly
// metallic dark grey: one broad specular lobe, a little rougher than the baked map, no coat, no sheen
// (which also saves the coat's second environment lookup on 130k triangles).
// On materials with baked maps, roughness and metalness are factors on the map (ORM G and B).
// Colours are linear. Wells, bays and door interiors are white / light grey on the real jet, the
// gear legs gloss white paint, tyres black rubber (albedo ~0.035, not 0.02).
export const TUNE = {
  F35_Skin_A: { clearcoat: 0, sheen: 0, roughness: 1.18 },
  F35_Skin_B: { clearcoat: 0, sheen: 0, roughness: 1.18 },
  F35_Misc_B: { roughness: 1.12 },                                  // inlet duct lining (nozzle: NOZZLE)
  F35_gear: { metalness: 0, roughness: 0.36 },
  F35_hub: { color: [0.58, 0.59, 0.60], roughness: 0.45, metalness: 0 },
  F35_tyre: { color: [0.035, 0.035, 0.036], roughness: 0.92 },
  F35_bay: { color: [0.70, 0.71, 0.70], roughness: 0.62 },
  F35_nose_well: { color: [0.62, 0.63, 0.62], roughness: 0.62 },
  F35_marking_white: { roughness: 0.6 },
};

// F135 nozzle (the Nozzle node: outer flaps, seals and the ceramic-lined divergent petals share a
// copy of F35_Misc_B): photos show the outer flaps taupe-grey with bronze heat staining growing
// towards the serrated trailing edge, the petals' inner faces sooty, darker deeper in.
export const NOZZLE = {
  roughness: 1.3,                  // factor on the baked map (the metallic flaps looked polished)
  metalness: 0.7,                  // factor on the baked map
  heat: [1.0, 0.85, 0.68],         // multiplies the base colour at the trailing edge, outside
  soot: 0.55,                      // inner faces: base colour * (1 - soot) deep inside
};

/** Chain an onBeforeCompile patch on a material (with a program cache key per patch set). */
function addPatch(mat, key, patch) {
  const prev = mat.onBeforeCompile;
  const keys = mat.userData.f35Patches || (mat.userData.f35Patches = []);
  keys.push(key);
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    patch(shader, renderer);
  };
  mat.customProgramCacheKey = () => keys.join('+');
}

function applyTune(mat, t) {
  for (const [k, v] of Object.entries(t)) {
    if (k === 'color') mat.color.setRGB(v[0], v[1], v[2]);
    else if (k in mat) mat[k] = v;
  }
  mat.needsUpdate = true;
}

/** Vertex ambient occlusion: COLOR_0.r scales the ambient light (not the albedo). */
function patchVertexAO(mat, shared) {
  addPatch(mat, 'f35vao', (sh) => {
    sh.uniforms.uVertexAO = shared.uVertexAO;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uVertexAO;')
      .replace('#include <color_fragment>', '')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        #if defined( USE_COLOR ) && !defined( USE_AOMAP )
        {
          float vertexAO = mix(1.0, vColor.r, uVertexAO);
          reflectedLight.indirectDiffuse *= vertexAO;
          #if defined( USE_ENVMAP ) && defined( STANDARD )
            float dotNVao = saturate(dot(geometryNormal, geometryViewDir));
            reflectedLight.indirectSpecular *= computeSpecularOcclusion(dotNVao, vertexAO, material.roughness);
          #endif
        }
        #endif`);
  });
}

/** The nozzle's own material: heat staining along the axis, soot on the inner faces. */
function nozzleMaterial(src, meshes) {
  const mat = src.clone();
  mat.name = 'F35_Nozzle';
  mat.roughness = (src.roughness ?? 1) * NOZZLE.roughness;
  mat.metalness = (src.metalness ?? 1) * NOZZLE.metalness;
  // axis frame from the geometry: x, y centre; z from the forward end (0) to the exit (1)
  const box = new THREE.Box3();
  for (const m of meshes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox); }
  const fwdIsMax = Math.abs(box.max.z) < Math.abs(box.min.z);      // the exit is the end farther aft
  const z0 = fwdIsMax ? box.max.z : box.min.z;
  const z1 = fwdIsMax ? box.min.z : box.max.z;
  const axis = new THREE.Vector4((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, z0, 1 / (z1 - z0));
  const heat = new THREE.Vector3().fromArray(NOZZLE.heat);
  addPatch(mat, 'f35nozzle', (sh) => {
    sh.uniforms.uNozAxis = { value: axis };
    sh.uniforms.uNozHeat = { value: heat };
    sh.uniforms.uNozSoot = { value: NOZZLE.soot };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uNozAxis;\nvarying vec2 vNoz;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        {
          vec2 rad = transformed.xy - uNozAxis.xy;
          float inward = -dot(normalize(objectNormal.xy + 1e-5), normalize(rad + 1e-5));
          vNoz = vec2(clamp((transformed.z - uNozAxis.z) * uNozAxis.w, 0.0, 1.0), smoothstep(0.15, 0.6, inward));
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uNozHeat;\nuniform float uNozSoot;\nvarying vec2 vNoz;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float t = vNoz.x, inner = vNoz.y;
          diffuseColor.rgb *= mix(vec3(1.0), uNozHeat, smoothstep(0.3, 1.0, t) * (1.0 - inner));
          diffuseColor.rgb *= 1.0 - uNozSoot * inner * (1.0 - 0.55 * smoothstep(0.3, 1.0, t));
        }`);
  });
  return mat;
}

/**
 * Prepare every material of the loaded glTF scene.
 * @param {object} [opts]
 * @param {number} [opts.anisotropy=8]
 * @param {object} [opts.rig]   f35i_rig.json: rig.ao {orm, vertex} says what the export baked;
 *                              rig.info.nozzle.node names the nozzle node
 * @returns {{byName: Map<string, THREE.Material[]>, glass: THREE.Material[], uniforms: object}}
 */
export function setupMaterials(root, { anisotropy = 8, rig = null } = {}) {
  const shared = { uInside: { value: 0 }, uVertexAO: { value: 1 } };
  const byName = new Map();
  const glass = [];
  const seenTex = new Set();
  const seenMat = new Set();
  const ao = (rig && rig.ao) || {};
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  // the nozzle's copy of F35_Misc_B
  const nozzleNode = root.getObjectByName((rig && rig.info && rig.info.nozzle && rig.info.nozzle.node) || 'Nozzle');
  if (nozzleNode) {
    const parts = [];
    nozzleNode.traverse((o) => { if (o.isMesh && o.material && o.material.name === 'F35_Misc_B') parts.push(o); });
    if (parts.length) {
      const nm = nozzleMaterial(parts[0].material, parts);
      for (const o of parts) o.material = nm;
    }
  }
  for (const mesh of meshes) {
    const mat = mesh.material;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (!mat) continue;
    for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'clearcoatMap', 'aoMap']) {
      const t = mat[key];
      if (t && !seenTex.has(t)) { t.anisotropy = anisotropy; seenTex.add(t); }
    }
    if (mat.transmission > 0) {
      glass.push(...makeGlass(mesh, mat, shared));
      continue;
    }
    if (!seenMat.has(mat)) {
      seenMat.add(mat);
      if (TUNE[mat.name]) applyTune(mat, TUNE[mat.name]);
      // baked occlusion: the exporter's occlusionTexture, or the ORM's R channel when the rig says so
      if (ao.orm && !mat.aoMap && mat.roughnessMap && /^F35_(Skin|Misc|Nozzle)/.test(mat.name)) {
        mat.aoMap = mat.roughnessMap;
        mat.needsUpdate = true;
      }
      if (mat.aoMap) mat.aoMapIntensity = 1;
      if (mat.vertexColors && mesh.geometry.attributes.color && !mat.isShaderMaterial) patchVertexAO(mat, shared);
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
