// The rift strip in the fragment shaders (terrainShaders.js base program, the Dead Sea's mirror
// in lakeShaders.js): its normals sit in the far normal map below the far grid's own (textures.js
// renderFarNormalMap), so its relief costs no sampler; its 50 m colour (rift_color.jpg, one
// pixel per height sample) is one more texture, read with far.jpg's.
//
// RIFT_NORMAL_GLSL needs uNormalFar, uRiftBox (strip x0, z0, x1, z1 in m; x1 < x0 when there is
// none), uNormalFarRows (2049 without the strip) and DECODE_N declared before it.
// RIFT_COLOR_GLSL (after RIFT_NORMAL_GLSL) needs uFarColor, uRiftColor and uRiftColorBox (the
// strip's box when its colour is loaded, else empty).

export const RIFT_NORMAL_GLSL = /* glsl */ `
// 1 inside the strip, fading out over its outer 400 m (where its heights have already joined
// the far grid's); 0 outside it or with an empty box.
float riftWeight(vec2 xz, vec4 box) {
  vec2 d = min(xz - box.xy, box.zw - xz);
  return smoothstep(0.0, 400.0, min(d.x, d.y));
}

// Normal x, z of the terrain outside the core: the rift strip's 50 m normals where it is, else
// the far grid's 200 m ones. Both lookups always run: a texture() inside a branch has no derivatives.
vec2 farNormalXZ(vec2 xz) {
  vec2 gF = (xz + 204800.0) / 200.0 + 0.5;
  vec2 nF = DECODE_N(texture(uNormalFar, vec2(gF.x / 2049.0, gF.y / uNormalFarRows)).rg);
  vec2 gR = (xz - uRiftBox.xy) / 50.0 + 0.5;
  vec2 nR = DECODE_N(texture(uNormalFar, vec2(gR.x / 2049.0, (2049.0 + gR.y) / uNormalFarRows)).rg);
  return mix(nF, nR, riftWeight(xz, uRiftBox));
}
`;

export const RIFT_COLOR_GLSL = /* glsl */ `
// Colour outside the core: the strip's 50 m imagery where it is, else far.jpg's 200 m (the strip's
// large-scale colour equals far.jpg's, rift.py, so the fade shows no edge).
vec3 farColor(vec2 xz) {
  vec3 f = texture(uFarColor, (xz + 204800.0) / 409600.0).rgb;
  vec3 r = texture(uRiftColor, ((xz - uRiftColorBox.xy) / 50.0 + 0.5) / vec2(2049.0, 2048.0)).rgb;
  return mix(f, r, riftWeight(xz, uRiftColorBox));
}
`;
