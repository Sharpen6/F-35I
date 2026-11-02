// Lights in the HDR frame: the mark a self-lit thing leaves in the scene target's alpha, so the
// output transform (js/env/Post.js) can show it as the eye sees a light (README "Lights at night").
//
// The scene target is half float RGBA. Its alpha says what a pixel holds:
//   >= 0.5      a surface (opaque surfaces write 1; the additive glass passes add to it)
//   about 0     a cockpit display (js/aircraft/pcd/interior.js DISPLAY_ALPHA): night vision leaves
//               its colours alone
//   <= -64      a light: the airfield's lights, street lamps, cars, obstruction lights, lit windows,
//               the jet's lights and its burner at night. It writes
//                   alpha = -EMITTER_BIAS - EMITTER_SCALE * w
//               w (0..1) being its share of the pixel (emitterShare: from its own display
//               brightness, against a night's dark background), through a MIN blend on alpha
//               (emitterBlending): whatever the drawing order, the strongest mark stays, and the
//               colour blends as before.
// Post.js reads w back (EMITTER_DECODE_GLSL). A light keeps its colour under night vision (a point
// light is seen by the cones), and it goes through a hue-preserving tone curve - AgX's own curve on
// its brightest channel, the others in proportion - instead of AgX itself, which turns any bright
// saturated colour white: a PAPI's red at 64 on the display comes out (255, 252, 246) through AgX,
// (255, 75, 48) this way. Only from sunset (env.lightsOn): by day the frame is AgX's throughout.
// The offset keeps the mark apart from the displays' 0 whatever the glass passes in front add (+1
// to +3), and through the MSAA resolve: one light sample of four still averages under -15. The
// clouds' composite (js/env/Clouds.js) carries the mark through, faded by a cloud in front.

import * as THREE from 'three';

export const EMITTER_BIAS = 64;
export const EMITTER_SCALE = 1024;

/** For the lights' fragment shaders: emitterAlpha(w), emitterShare(display brightness). */
export const EMITTER_GLSL = /* glsl */ `
// js/env/emitters.js: the alpha a light writes for its share w (0..1) of the pixel
float emitterAlpha(float w) { return -${EMITTER_BIAS.toFixed(1)} - ${EMITTER_SCALE.toFixed(1)} * clamp(w, 0.0, 1.0); }
// a light's share of its pixel from what it adds to the display (radiance x exposure, its
// brightest channel): against a night's background (~0.01 on the display) it is the pixel from ~0.06
float emitterShare(float d) { return smoothstep(0.004, 0.06, d); }
`;

/** For the output transform: the light's share w (0..1) a pixel's alpha holds. */
export const EMITTER_DECODE_GLSL = /* glsl */ `
float emitterWeight(float a) { return clamp((-a - ${EMITTER_BIAS.toFixed(1)}) / ${EMITTER_SCALE.toFixed(1)}, 0.0, 1.0); }
`;

/**
 * A light's blend state: its colour added (equation: AddEquation, or MaxEquation on an 8-bit
 * canvas), its mark MIN-blended into the alpha. The source alpha is the mark, so a light cannot
 * also hide what is behind it by its alpha: it adds. A blend state, not a program: switching it
 * rebuilds nothing.
 */
export function emitterBlending(material, equation = THREE.AddEquation) {
  material.blending = THREE.CustomBlending;
  material.blendEquation = equation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.MinEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  return material;
}
