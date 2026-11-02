// The rift strip in the fragment shaders (terrainShaders.js base program, the Dead Sea's mirror
// in lakeShaders.js): its normals sit in the far normal map below the far grid's own (textures.js
// renderFarNormalMap), so its relief costs no sampler; its 50 m colour (rift_color.jpg, one
// pixel per height sample) is one more texture, read with far.jpg's.
//
// RIFT_NORMAL_GLSL needs uNormalFar, uRiftBox (strip x0, z0, x1, z1 in m; x1 < x0 when there is
// none), uNormalFarRows (2049 without the strip) and DECODE_N declared before it.
// RIFT_COLOR_GLSL (after RIFT_NORMAL_GLSL) needs uFarColor, uRiftColor and uRiftColorBox (the
// strip's box when its colour is loaded, else empty).
//
// Both read only where their result shows: outside the core (coreW < 1; inside it the caller
// replaces them with the core's own colour and normals) and, for the strip, inside its box. The
// lookups sit in branches, so they take their derivatives from the position, outside the branch
// (textureGrad: the same filtering as texture()). Most of the base program's pixels lie in the
// core, where the far grid's two lookups were spent for nothing before the strip and the strip's
// two more after it.

export const RIFT_NORMAL_GLSL = /* glsl */ `
// 1 inside the strip, fading out over its outer 400 m (where its heights have already joined
// the far grid's); 0 outside it or with an empty box.
float riftWeight(vec2 xz, vec4 box) {
  vec2 d = min(xz - box.xy, box.zw - xz);
  return smoothstep(0.0, 400.0, min(d.x, d.y));
}

// Normal x, z of the terrain outside the core: the rift strip's 50 m normals where it is, else
// the far grid's 200 m ones; (0, 0) where coreW is 1 (the caller's core normals replace it).
vec2 farNormalXZ(vec2 xz, float coreW) {
  vec2 dX = dFdx(xz), dY = dFdy(xz);
  vec2 sF = vec2(1.0 / (200.0 * 2049.0), 1.0 / (200.0 * uNormalFarRows));
  vec2 sR = vec2(1.0 / (50.0 * 2049.0), 1.0 / (50.0 * uNormalFarRows));
  float w = riftWeight(xz, uRiftBox);
  vec2 n = vec2(0.0);
  if (coreW < 1.0) {
    vec2 gF = (xz + 204800.0) / 200.0 + 0.5;
    n = DECODE_N(textureGrad(uNormalFar, vec2(gF.x / 2049.0, gF.y / uNormalFarRows), dX * sF, dY * sF).rg);
    if (w > 0.0) {
      vec2 gR = (xz - uRiftBox.xy) / 50.0 + 0.5;
      vec2 nR = DECODE_N(textureGrad(uNormalFar, vec2(gR.x / 2049.0, (2049.0 + gR.y) / uNormalFarRows), dX * sR, dY * sR).rg);
      n = mix(n, nR, w);
    }
  }
  return n;
}
`;

export const RIFT_COLOR_GLSL = /* glsl */ `
// Colour outside the core: the strip's 50 m imagery where it is, else far.jpg's 200 m (the strip's
// large-scale colour equals far.jpg's, rift.py, so the fade shows no edge); black where coreW is 1.
vec3 farColor(vec2 xz, float coreW) {
  vec2 dX = dFdx(xz), dY = dFdy(xz);
  const vec2 sF = vec2(1.0 / 409600.0);
  const vec2 sR = vec2(1.0 / (50.0 * 2049.0), 1.0 / (50.0 * 2048.0));
  float w = riftWeight(xz, uRiftColorBox);
  vec3 c = vec3(0.0);
  if (coreW < 1.0) {
    c = textureGrad(uFarColor, (xz + 204800.0) / 409600.0, dX * sF, dY * sF).rgb;
    if (w > 0.0) {
      vec3 r = textureGrad(uRiftColor, ((xz - uRiftColorBox.xy) / 50.0 + 0.5) / vec2(2049.0, 2048.0), dX * sR, dY * sR).rgb;
      c = mix(c, r, w);
    }
  }
  return c;
}
`;
