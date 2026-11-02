// The rift strip in the fragment shaders (terrainShaders.js base program, the Dead Sea's mirror
// in lakeShaders.js): its normals sit in the far normal map below the far grid's own (textures.js
// renderFarNormalMap), so the strip costs no sampler.
//
// Needs uNormalFar, uRiftBox (strip x0, z0, x1, z1 in m; x1 < x0 when there is none),
// uNormalFarRows (2049 without the strip) and DECODE_N declared before it.

export const RIFT_NORMAL_GLSL = /* glsl */ `
// Normal x, z of the terrain outside the core: the rift strip's 50 m normals where it is (they
// fade in over its outer 400 m, where its heights have already joined the far grid's), else the
// far grid's 200 m ones. Both lookups always run: a texture() inside a branch has no derivatives.
vec2 farNormalXZ(vec2 xz) {
  vec2 gF = (xz + 204800.0) / 200.0 + 0.5;
  vec2 nF = DECODE_N(texture(uNormalFar, vec2(gF.x / 2049.0, gF.y / uNormalFarRows)).rg);
  vec2 gR = (xz - uRiftBox.xy) / 50.0 + 0.5;
  vec2 nR = DECODE_N(texture(uNormalFar, vec2(gR.x / 2049.0, (2049.0 + gR.y) / uNormalFarRows)).rg);
  vec2 d = min(xz - uRiftBox.xy, uRiftBox.zw - xz);
  float w = smoothstep(0.0, 400.0, min(d.x, d.y));
  return mix(nF, nR, w);
}
`;
