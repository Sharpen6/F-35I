// Afterburner plume and nozzle glow of the F135.
//
// The plume is a ray-marched emitting volume inside a cylinder behind the nozzle exit (no depth
// write): what photos of F-35s in burner show.
//   * by day: short and mostly transparent, an orange-yellow core that fills the exit and tapers
//     away within ~1.5-2 m, a faint blue at the nozzle lip, the shock diamonds pale and close in;
//   * at night: a long flame (~5 m in full burner): a yellow-white throat inside the nozzle, an
//     orange core that fades to red-orange, a blue-violet sheath along its edge for the first
//     metre or so, and a train of five or six yellow-white shock diamonds (Mach disks) inside the
//     core, attached to it (each weighted by the core where it sits, so none floats past the
//     visible flame).
// No white ball, no pink or lavender tail: each channel saturates at uSat and the flame hides what
// is behind it by its opacity (1 - exp(-kappa * luminance)), blended as premultiplied colour +
// background * (1 - alpha). By day kappa is 2: the flame's display brightness is compressed far
// below its real ratio to the sky (a core several times brighter than the sky), so a transparent
// flame would come out as orange + blue sky = a pale, whitish puff, worst when seen along its
// length. Hiding the sky in proportion keeps the core a saturated orange-yellow, and the faint
// edges stay nearly transparent. At night (FLAME_NIGHT.kappa 0) the flame is what it physically is,
// a soot-light gas that adds its light to the dark: once the night look is complete the plume adds
// and writes its mark as a light (js/env/emitters.js), so Post.js shows it by its hue and night
// vision leaves it alone (greyed by the rods, the orange read pink).
// Day and night (uDay) come from the sky's light level (fxshared fxEnv: the sun's elevation), not
// from the exposure, so the look changes at the same sun elevation whatever exposure meter the
// Environment uses: the day look down to the sun ~1.5 deg up, the night look from ~3 deg below the
// horizon. The two looks are tables (FLAME_DAY, FLAME_NIGHT) blended by uDay; noon is FLAME_DAY.
//
// Brightness: a burner's core (~10^4-10^5 cd/m^2) is far brighter than anything the exposure can
// hold, so the flame is drawn at a picture level, as the cockpit's displays are (js/env/README.md
// "Lights at night"), never at its physical radiance x exposure, which would be a white blob at
// dusk and night:
//   * by day its display brightness (radiance x exposure) grows with the 4th root of the exposure
//     (uDisp = (exposure / noon exposure)^0.25), as a camera exposing for the scene but not blind
//     to a bright flame would, then goes through a hue-preserving shoulder (uKnee, uCap): the
//     brightest channel rolls off towards uCap and the others keep their ratio to it;
//   * at night it is fixed (uDisp 1 with FLAME_NIGHT's own colours and shoulder): the same flame at
//     exposure 40 and 285. Post.js shows it by its hue (AgX's curve on its brightest channel), so
//     its colours are its colours on the screen: the body orange at display ~1-2, the tail a deeper
//     red-orange that holds its brightness to the last diamonds, the diamonds small, crisp and
//     yellow-white at ~3-5, the sheath a faint blue-violet.
//
// The glow inside the nozzle, seen from behind: rays that pass the exit and the throat reach the
// turbine's exit deep inside (NOZZLE_GLSL): a hot annulus round the tail cone with the flame
// holder's struts across it, the nozzle's wall between the throat and the exit dimly lit by it
// (parallax, a cavity: never a disc at the exit). Its light is the engine's heat plus the burner.
// The heat follows the rule for lights at night (js/env/README.md): the luminance of a body at
// ~930 K at idle (a dim dark red, ~0.06 on the display at night) to ~1030 K at MIL (orange-red,
// ~0.7) x lightGain / LUX_PER_UNIT, so the dusk shows next to nothing of it; by day the day
// table's faint heat. The burner (a hot yellow-orange by day, yellow-white at night) is a picture
// level as the flame. With the burner lit the plume shader draws it (seen through the flame, before
// the shoulder); without it, a disc on the exit plane that looks into the nozzle.
// The nozzle petals are a morph target driven by AircraftVisual (open at idle and in burner).
//
// Fog: three's scene fog (fxshared FOG_PARS_GLSL), as the jet's own materials get it.
//
// Frame: everything is built in the BODY frame (+Z aft); `exit` is the nozzle exit centre.

import * as THREE from 'three';
import { fxExposure, fxEnv, fogUniforms, FOG_PARS_GLSL, LUX_PER_UNIT } from './fxshared.js';
import { EMITTER_GLSL, emitterBlending } from '../env/emitters.js';

// What a ray from behind sees inside the nozzle (plume frame: z 0 at the exit, < 0 upstream).
// uNoz: exit radius, throat z, throat radius, z of the turbine's exit (deep inside, upstream of
// the throat). Rays through the exit and the throat end on the turbine's exit: the hot annulus of
// the gas path round the tail cone (centre body), brightest mid-span, the 12 struts of the flame
// holder darker across it (faded out where they get smaller than a pixel), the tail cone dimmer;
// rays through the exit that miss the throat end on the nozzle's wall, lit by the glow, dimmer
// towards the lip. Returns the share of the glow's light seen (0..1).
const NOZZLE_GLSL = /* glsl */`
  uniform vec4 uNoz;
  float nozzleView(vec3 ro, vec3 rd) {
    if (rd.z > -1e-4) return 0.0;
    float te = -ro.z / rd.z;
    if (te < 0.0) return 0.0;
    float re = length(ro.xy + rd.xy * te) / uNoz.x;
    if (re > 1.0) return 0.0;
    float rt = length(ro.xy + rd.xy * ((uNoz.y - ro.z) / rd.z)) / uNoz.z;
    // the wall between the throat and the exit
    float wall = 0.1 * (1.0 - smoothstep(0.55, 1.0, re));
    if (rt > 1.0) return wall;
    vec2 pd = ro.xy + rd.xy * ((uNoz.w - ro.z) / rd.z);
    float r = length(pd) / uNoz.z;
    float ann = smoothstep(0.32, 0.42, r) * (1.0 - smoothstep(0.95, 1.2, r))
      * (0.7 + 0.3 * sin(3.14159 * clamp((r - 0.37) / 0.7, 0.0, 1.0)));
    float a = atan(pd.y, pd.x) * 1.9098593;                     // 12 struts
    float sw = fwidth(a);
    float strut = mix(1.0 - 0.6 * smoothstep(0.1 + sw, 0.0, abs(fract(a) - 0.5)), 0.93, smoothstep(0.08, 0.3, sw));
    float cone = (1.0 - smoothstep(0.32, 0.42, r)) * (0.22 + 0.18 * (1.0 - r / 0.42));
    // the throat's edge, a little soft
    return mix(wall, ann * strut + cone, 1.0 - smoothstep(0.9, 1.0, rt));
  }
`;

const PLUME_VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  uniform vec3 uScale;         // the mesh's scale: unit cylinder -> metres
  varying vec3 vLocal;
  void main() {
    vLocal = position * uScale;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }`;

const PLUME_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uCamLocal;     // camera position in the plume frame
  uniform float uLen;         // bounding length (m)
  uniform float uCore;        // visible core length (m)
  uniform float uR0;          // radius at the exit (m)
  uniform float uRmax;        // bounding cylinder radius (m)
  uniform float uAb;          // 0..1
  uniform float uTime;
  uniform float uGain;        // brightness (burner fill)
  uniform float uDisp;        // display gain: (exposure / noon exposure)^0.25 (see the header)
  uniform float uInvExp;      // 1 / exposure: display brightness -> scene radiance
  uniform float uKnee;        // display brightness where the hue-preserving shoulder starts
  uniform float uCap;         // ... and the brightness it rolls off towards
  uniform float uDay;         // 1 against a daylight sky, 0 at night (fxEnv light level)
  uniform vec3 uSat;          // brightness each channel saturates at (display, linear, x uDisp)
  uniform vec3 uGlow;         // the glow inside the nozzle (display, linear, x uDisp): engine heat + burner
  uniform float uMark;        // 1: the night plume, added light with its mark as a light (js/env/emitters.js)
  uniform float uKappa;       // opacity per unit of integrated luminance (see the header)
  uniform float uSpacing;     // shock-cell spacing (m)
  // the look (FLAME_DAY / FLAME_NIGHT blended by uDay): colours x brightness per metre
  uniform vec3 uC1;           // core at the exit
  uniform vec3 uC2;           // ... at 40 % of its length
  uniform vec3 uC3;           // ... at its tail
  uniform float uFall;        // exponent of the core's fall-off along its length
  uniform vec3 uLipCol;       // the blue lip (by day) / sheath (at night)
  uniform vec4 uLip;          // its radius (x exit radius, or x core radius by w), width (x exit radius), decay (m), w
  uniform vec3 uDiaCol;       // the shock diamonds
  uniform vec4 uDia;          // their count, radius (x core radius), half length (x spacing), sharpness
  uniform vec2 uDiaFall;      // exponents of the core's fall-off where one sits and of its rank
  uniform int uSteps;
  varying vec3 vLocal;
  ${FOG_PARS_GLSL}
  ${NOZZLE_GLSL}
  ${EMITTER_GLSL}

  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float vnoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }

  // core radius and axial weight of the flame at z (m downstream of the exit)
  float coreRadius(float z) { float s = clamp(z / uCore, 0.0, 1.0); return uR0 * (0.93 - 0.62 * pow(s, 1.3)) + 0.02; }
  float coreFall(float z) { float s = clamp(z / uCore, 0.0, 1.0); return pow(1.0 - s, uFall); }
  // by day the faint back half of the flame is lost against the sky (drawn, it would only tint the
  // sky pink): it fades out over the core's back half; at night all of it shows
  float dayTail(float s) { return mix(1.0, 1.0 - smoothstep(0.3, 0.75, s), uDay); }

  // emission (display-referred linear RGB per metre) at a point of the plume frame
  vec3 emission(vec3 p) {
    float z = p.z;
    if (z < 0.0 || z > uLen) return vec3(0.0);
    float rho = length(p.xy);
    float s = z / uCore;
    float r = coreRadius(z);
    float fall = coreFall(z);
    float turb = 0.75 + 0.5 * vnoise(vec3(p.xy * 5.0, z * 3.0 - uTime * 26.0));
    // core: yellow-orange (by day) / orange (at night) at the exit -> a deeper orange tail (never pink)
    float env = exp(-pow(rho / r, 2.0) * 2.6) * fall * turb * dayTail(s);
    vec3 col = (s < 0.4 ? mix(uC1, uC2, s / 0.4) : mix(uC2, uC3, clamp((s - 0.4) / 0.6, 0.0, 1.0))) * env;
    // blue at the nozzle lip (the outer mixing layer right behind the exit); at night a blue-violet
    // sheath that follows the core's edge downstream
    float lr = uLip.x * mix(uR0, r, uLip.w);
    float lip = exp(-pow((rho - lr) / (uLip.y * uR0), 2.0)) * exp(-z / uLip.z);
    col += uLipCol * lip;
    // shock diamonds: a train of Mach disks inside the core, spacing fixed by the nozzle pressure
    // ratio, each one as bright as the core around it (attached: none beyond the visible flame)
    float z0 = 0.62 * uSpacing;
    float k = floor((z - z0) / uSpacing + 0.5);
    if (k >= 0.0 && k < uDia.x) {
      float zk = z0 + k * uSpacing;
      float rk = uDia.y * coreRadius(zk);
      float hk = uDia.z * uSpacing;
      float d = rho / rk + abs(z - zk) / hk;
      float ik = pow(coreFall(zk), uDiaFall.x) * dayTail(zk / uCore) * pow(max(1.0 - k / uDia.x, 0.0), uDiaFall.y)
        * (0.85 + 0.3 * vnoise(vec3(k * 3.1, uTime * 9.0, 0.0)));
      col += uDiaCol * pow(max(1.0 - d, 0.0), uDia.w) * ik;
    }
    return col;
  }


  // hue-preserving shoulder on the display brightness: the brightest channel rolls off from uKnee
  // towards uCap, the others keep their ratio to it (no clipping of all three to white)
  vec3 shoulder(vec3 d) {
    float m = max(d.r, max(d.g, d.b));
    if (m <= uKnee) return d;
    float w = max(uCap - uKnee, 1e-3);
    return d * (uKnee + w * (1.0 - exp(-(m - uKnee) / w))) / m;
  }

  void main() {
    #include <logdepthbuf_fragment>
    // ray from the camera through this fragment, clipped to the bounding cylinder
    vec3 ro = uCamLocal;
    vec3 rd = normalize(vLocal - ro);
    float a = dot(rd.xy, rd.xy);
    float b = dot(ro.xy, rd.xy);
    float c = dot(ro.xy, ro.xy) - uRmax * uRmax;
    float t0 = 0.0, t1 = 1e6;
    if (a > 1e-8) {
      float disc = b * b - a * c;
      if (disc <= 0.0) discard;
      float sq = sqrt(disc);
      t0 = (-b - sq) / a; t1 = (-b + sq) / a;
    } else if (c > 0.0) discard;
    if (abs(rd.z) > 1e-6) {
      float za = (0.0 - ro.z) / rd.z, zb = (uLen - ro.z) / rd.z;
      t0 = max(t0, min(za, zb)); t1 = min(t1, max(za, zb));
    } else if (ro.z < 0.0 || ro.z > uLen) discard;
    t0 = max(t0, 0.0);
    if (t1 <= t0) discard;
    float dt = (t1 - t0) / float(uSteps);
    float jitter = hash(vec3(gl_FragCoord.xy, uTime));
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 48; i++) {
      if (i >= uSteps) break;
      vec3 p = ro + rd * (t0 + (float(i) + jitter) * dt);
      acc += emission(p);
    }
    acc *= dt * uGain;
    float alpha = 1.0 - exp(-uKappa * dot(acc, vec3(0.2126, 0.7152, 0.0722)));
    vec3 flame = uSat * (vec3(1.0) - exp(-acc / uSat));
    // the glow inside the nozzle seen through the flame: summed before the shoulder, so the two
    // never add up to white
    flame += uGlow * nozzleView(ro, rd) * (1.0 - alpha);
    vec3 disp = shoulder(flame * uDisp);
    vec3 col = disp * uInvExp;
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor.rgb = fxFog(gl_FragColor.rgb, alpha);
    if (uMark > 0.5) gl_FragColor.a = emitterAlpha(emitterShare(max(disp.r, max(disp.g, disp.b))));
  }`;

const GLOW_VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  #include <logdepthbuf_pars_vertex>
  uniform float uZ;           // the disc's z in the plume frame
  varying vec3 vLocal;
  void main() {
    vLocal = vec3(position.xy, uZ);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }`;

// the glow inside the nozzle without the burner: a disc on the exit plane, each fragment looking
// into the nozzle along its ray (NOZZLE_GLSL); added light, its mark as a light in the alpha
const GLOW_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColour;       // display-referred (x uDisp by day)
  uniform float uDisp;
  uniform float uInvExp;
  uniform vec3 uCamLocal;     // camera position in the plume frame
  varying vec3 vLocal;
  ${FOG_PARS_GLSL}
  ${NOZZLE_GLSL}
  ${EMITTER_GLSL}
  void main() {
    #include <logdepthbuf_fragment>
    vec3 ro = uCamLocal;
    float g = nozzleView(ro, normalize(vLocal - ro));
    if (g <= 0.0) discard;
    vec3 disp = uColour * g * uDisp;
    gl_FragColor = vec4(disp * uInvExp, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor.rgb = fxFog(gl_FragColor.rgb, 0.0);
    gl_FragColor.a = emitterAlpha(emitterShare(max(disp.r, max(disp.g, disp.b))));
  }`;

/**
 * Display gain of the flame for the exposure: its display brightness grows with the exposure's 4th
 * root, 1 at the exposure meter's noon value (fxEnv.noonExposure).
 */
export function flameDisplayGain(exposure, noon = fxEnv.noonExposure) {
  const e = Math.max(0.05, exposure || 1);
  return Math.pow(e / Math.max(0.05, noon || 0.93), 0.25);
}

/** Exposure compensation (scene radiance per display brightness): flameDisplayGain / exposure. */
export function flameExposureComp(exposure, noon = fxEnv.noonExposure) {
  return flameDisplayGain(exposure, noon) / Math.max(0.05, exposure || 1);
}

/** The flame's day look (1) against its night look (0) for the sky's light level (log10 lux). */
export function flameDayLook(logLux) {
  return THREE.MathUtils.smoothstep(logLux, 1.5, 3.3);
}

/**
 * The flame's two looks (the header), display-referred linear RGB: FLAME_DAY against a daylit sky
 * (x uDisp, the exposure's 4th root), FLAME_NIGHT against the dark (x 1: a fixed picture level).
 *   c1, c2, c3     the core's colour x brightness per metre at the exit, at 40 % and at the tail
 *   fall           exponent of its fall-off along its length; length: x the day's core length
 *   lip, lipShape  the blue lip / sheath (colour x brightness; radius, width, decay m, follows the core)
 *   dia, diaShape  the shock diamonds (colour x brightness; count, radius, half length, sharpness)
 *   diaFall        exponents of the core's fall-off where a diamond sits and of its rank
 *   sat            brightness each channel saturates at; knee, cap: the hue-preserving shoulder
 *   kappa          opacity per unit of luminance (see the header)
 *   burner         the glow inside the nozzle of the burner at full burner (x ab^0.7)
 *   heat           the glow of the engine's heat: [colour at idle, colour at MIL], then by day its
 *                  brightness [idle, MIL] (display), at night the temperature [idle, MIL] (K) of the
 *                  body whose luminance it has (the rule for lights at night, throatGlow)
 * FLAME_DAY is the look the aircraft track tuned (the shoulder: Afterburner.shoulder); its engine
 * heat also grows with fxEnv.darkness (only the dark shows it). FLAME_NIGHT is set through the
 * output's hue-preserving curve (the night plume is a light: what it puts on the display is its
 * colour) against night photos of F-35s in burner: seen 28 deg off the tail the body between the
 * diamonds ~(206,108,65), the tail at 70 % of the core ~(193,63,46), the diamonds ~(248,219,167);
 * the channels saturate (sat) and the shoulder starts (knee) above the diamonds' ~5, so they keep
 * their colour, and their profile is peaked (sharpness 1.6) and small (0.4 of the core's radius,
 * a quarter of a cell long): crisp Mach disks, not soft blobs.
 */
export const FLAME_DAY = {
  c1: [1.8, 1.116, 0.432], c2: [1.8, 0.792, 0.234], c3: [1.8, 0.828, 0.216], fall: 1.7, length: 1,
  lip: [0.105, 0.147, 0.35], lipShape: [0.85, 0.16, 0.30, 0],
  dia: [2.4, 1.968, 1.32], diaShape: [5, 0.52, 0.30, 1.2], diaFall: [1, 1.2],
  sat: [1.0, 0.44, 0.11], kappa: 2.0,
  burner: [0.55, 0.231, 0.055],
  heat: [[1.0, 0.28, 0.06], [1.0, 0.28, 0.06], [0.012, 0.112]],
};
export const FLAME_NIGHT = {
  c1: [2.6, 1.0, 0.25], c2: [2.4, 0.5, 0.17], c3: [3.6, 0.14, 0.07], fall: 0.6, length: 1.5,
  lip: [0.05, 0.03, 0.34], lipShape: [1.0, 0.16, 0.8, 1],
  dia: [44, 33, 18], diaShape: [6, 0.4, 0.26, 1.6], diaFall: [0.6, 0.8],
  sat: [12, 9, 5], knee: 4, cap: 10, kappa: 0,
  burner: [1.6, 0.99, 0.45],
  heat: [[1.0, 0.16, 0.03], [1.0, 0.22, 0.04], [930, 1030]],
};

// luminance (cd/m^2) of a black body by its temperature (K): Planck's law through the CIE 1931
// observer (x 683 lm/W), log-interpolated
const BLACKBODY = [[850, 0.0448], [900, 0.204], [950, 0.795], [1000, 2.73], [1050, 8.36], [1100, 23.3], [1200, 141]];
export function blackbodyLuminance(T) {
  const B = BLACKBODY;
  if (T <= B[0][0]) return B[0][1] * Math.pow(T / B[0][0], 30);
  for (let i = 1; i < B.length; i++) {
    if (T <= B[i][0]) {
      const t = (T - B[i - 1][0]) / (B[i][0] - B[i - 1][0]);
      return Math.exp(Math.log(B[i - 1][1]) + t * (Math.log(B[i][1]) - Math.log(B[i - 1][1])));
    }
  }
  return B[B.length - 1][1];
}

/** Display brightness per cd/m^2 of a light at full night (the rule: x 1400 / LUX_PER_UNIT). */
export const NIGHT_DISPLAY_PER_NIT = 1400 / LUX_PER_UNIT;

// a * (1 - t) + b * t: exactly b at t = 1 (noon draws FLAME_DAY bit for bit)
const blend = (a, b, t) => a * (1 - t) + b * t;
const blend3 = (v, a, b, t) => v.set(blend(a[0], b[0], t), blend(a[1], b[1], t), blend(a[2], b[2], t));
const blend4 = (v, a, b, t) => v.set(blend(a[0], b[0], t), blend(a[1], b[1], t), blend(a[2], b[2], t), blend(a[3], b[3], t));

/**
 * The glow inside the nozzle (display, linear, x uDisp) for a look: engine heat at the lagged lever
 * thr (0.75 MIL) plus the burner at ab; `darkness` (fxEnv) only for the day look. At night the heat
 * is a body at FLAME_NIGHT's temperature seen by the rule for lights (js/env/README.md): its
 * luminance x display (display brightness per cd/m^2: fxEnv.lightGain x exposure / LUX_PER_UNIT,
 * NIGHT_DISPLAY_PER_NIT at full night), so the dusk shows next to nothing of it. Writes into out.
 */
export function throatGlow(look, thr, ab, darkness, out = [0, 0, 0], display = NIGHT_DISPLAY_PER_NIT) {
  const m = Math.pow(Math.min(Math.max(thr, 0), 0.75) / 0.75, 2);
  const [c0, c1, lv] = look.heat;
  let h = lv[0] + (lv[1] - lv[0]) * m;
  if (look === FLAME_DAY) h *= 0.15 + 0.85 * darkness;
  else {
    // a temperature: luminance by the rule, on the colour's brightest channel (1)
    const lum = 0.2126 * (c0[0] + (c1[0] - c0[0]) * m) + 0.7152 * (c0[1] + (c1[1] - c0[1]) * m)
      + 0.0722 * (c0[2] + (c1[2] - c0[2]) * m);
    h = blackbodyLuminance(h) * display / Math.max(lum, 1e-3);
  }
  const k = ab > 0.005 ? Math.pow(ab, 0.7) : 0;
  for (let i = 0; i < 3; i++) out[i] = (c0[i] + (c1[i] - c0[i]) * m) * h + look.burner[i] * k;
  return out;
}

export class Afterburner {
  /**
   * @param {object} nozzle  rig.info.nozzle (body frame): exit, radius, radiusAB, axis, throat, throatRadius
   */
  constructor(nozzle) {
    this.group = new THREE.Group();
    this.group.name = 'Afterburner';
    const exit = new THREE.Vector3().fromArray(nozzle.exit);
    const axis = new THREE.Vector3().fromArray(nozzle.axis || [0, 0, 1]).normalize();
    this.group.position.copy(exit).addScaledVector(axis, 0.02);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    this.maxLen = 7.0;                 // bounding length at full burner (the long night flame)
    this.r0 = nozzle.radiusAB || 0.56;
    this.rMil = nozzle.radius || 0.47;  // exit radius with the petals at the MIL position
    this.rMax = this.r0 * 1.15;
    this.steps = 32;
    // the hue-preserving shoulder (display brightness, see the header): a lighting setup that wants
    // more of the core in its bloom raises cap
    this.shoulder = { knee: 0.75, cap: 1.2 };
    // bounding cylinder (z 0..1, scaled to the plume length), drawn from the inside so the
    // shader runs with the camera in the plume too
    const geo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, false);
    geo.rotateX(Math.PI / 2);          // axis along +Z
    geo.translate(0, 0, 0.5);
    // (the plume starts 2 cm behind the exit plane: no z-fight with the petal tips; the throat glow
    // sits 2 cm downstream of the throat, in the plume's frame 0.02 m further)
    const throatZ = nozzle.throat ? (nozzle.throat[2] - nozzle.exit[2]) : -0.4;
    const throatR = nozzle.throatRadius || 0.4;
    // inside the nozzle (NOZZLE_GLSL): exit radius (the petals move it), throat, and the turbine's
    // exit a metre upstream of the throat (the augmentor duct between)
    this.noz = { value: new THREE.Vector4(this.r0, throatZ, throatR * 1.05, throatZ - 1.0) };
    this.uniforms = {
      ...fogUniforms(),
      uCamLocal: { value: new THREE.Vector3() },
      uLen: { value: 4.0 }, uCore: { value: 3.0 }, uR0: { value: this.r0 }, uRmax: { value: this.rMax },
      uAb: { value: 0 }, uTime: { value: 0 }, uGain: { value: 1.0 }, uScale: { value: new THREE.Vector3(1, 1, 1) },
      uSat: { value: new THREE.Vector3().fromArray(FLAME_DAY.sat) }, uKappa: { value: FLAME_DAY.kappa },
      uSpacing: { value: 0.8 }, uSteps: { value: this.steps }, uDay: { value: 1 },
      uDisp: { value: 1 }, uInvExp: { value: 1 }, uKnee: { value: this.shoulder.knee }, uCap: { value: this.shoulder.cap },
      uNoz: this.noz, uMark: { value: 0 },
      uGlow: { value: new THREE.Vector3() },
      uC1: { value: new THREE.Vector3() }, uC2: { value: new THREE.Vector3() }, uC3: { value: new THREE.Vector3() },
      uFall: { value: FLAME_DAY.fall }, uLipCol: { value: new THREE.Vector3() }, uLip: { value: new THREE.Vector4() },
      uDiaCol: { value: new THREE.Vector3() }, uDia: { value: new THREE.Vector4() }, uDiaFall: { value: new THREE.Vector2() },
    };
    this._setLook(1);
    // premultiplied "over": the tone-mapped flame colour + the background * (1 - opacity); once the
    // night look is complete (kappa 0: the same as adding) added light with its mark as a light
    this.plumeMat = new THREE.ShaderMaterial({
      name: 'F35_AB_Plume', uniforms: this.uniforms, vertexShader: PLUME_VERT, fragmentShader: PLUME_FRAG,
      transparent: true, depthWrite: false, side: THREE.BackSide, toneMapped: true, fog: true,
    });
    this._plumeBlend(false);
    this.plume = new THREE.Mesh(geo, this.plumeMat);
    this.plume.name = 'AB_Plume';
    this.plume.renderOrder = 4;
    this.plume.castShadow = false;
    this.plume.receiveShadow = false;
    this.plume.visible = false;
    // the look from the light level, the brightness from the exposure the frame is drawn with (by
    // day; at night a fixed picture level)
    this.plume.onBeforeRender = (renderer) => {
      const u = this.uniforms;
      const e = Math.max(0.05, fxExposure.get(renderer));
      this._exposure = e;
      const day = flameDayLook(fxEnv.logLux);
      this._setLook(day);
      // a blend state, not a program: switching it rebuilds nothing
      this._plumeBlend(day <= 1e-3 && fxEnv.linearTarget(renderer));
      u.uDisp.value = blend(1, flameDisplayGain(e), day);
      u.uInvExp.value = 1 / e;
    };
    this.group.add(this.plume);
    // the glow inside the nozzle without the burner (engine heat): a disc on the exit plane (1 cm
    // inside it) facing aft, that looks into the nozzle (GLOW_FRAG)
    const glowZ = -0.03;
    this.glowUniforms = { ...fogUniforms(), uColour: { value: new THREE.Color(0, 0, 0) }, uDisp: { value: 1 }, uInvExp: { value: 1 },
      uCamLocal: this.uniforms.uCamLocal, uNoz: this.noz, uZ: { value: glowZ } };
    this.glow = new THREE.Mesh(
      new THREE.CircleGeometry(this.r0 * 1.02, 48),
      emitterBlending(new THREE.ShaderMaterial({
        name: 'F35_Nozzle_Glow', uniforms: this.glowUniforms, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
        transparent: true, depthWrite: false, toneMapped: true, fog: true,
      })));
    this.glow.name = 'Nozzle_Glow';
    this.glow.position.set(0, 0, glowZ);
    this.glow.renderOrder = 4;
    this.glow.castShadow = false;
    this.glow.receiveShadow = false;
    this.glow.onBeforeRender = (renderer) => {
      const e = Math.max(0.05, fxExposure.get(renderer));
      this._exposure = e;
      this.glowUniforms.uDisp.value = blend(1, flameDisplayGain(e), flameDayLook(fxEnv.logLux));
      this.glowUniforms.uInvExp.value = 1 / e;
    };
    this.group.add(this.glow);
    this.ab = 0;
    this.throttle = 0;
    this.open = 0;
    this.time = 0;
    this._inv = new THREE.Matrix4();
    this._cam = new THREE.Vector3();
    this._gDay = [0, 0, 0];
    this._gNight = [0, 0, 0];
    this._exposure = 1;
  }

  /** The plume's blend state: premultiplied over (by day), or added light with its mark (night). */
  _plumeBlend(mark) {
    if (mark === this._mark) return;
    this._mark = mark;
    const m = this.plumeMat;
    if (mark) emitterBlending(m);
    else {
      m.blending = THREE.CustomBlending; m.blendEquation = THREE.AddEquation;
      m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
      m.blendEquationAlpha = THREE.AddEquation;
      m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor;
    }
    this.uniforms.uMark.value = mark ? 1 : 0;
  }

  /** The look's uniforms for day (1: FLAME_DAY, 0: FLAME_NIGHT, between: blended). */
  _setLook(day) {
    const u = this.uniforms, N = FLAME_NIGHT, D = FLAME_DAY;
    if (day === this._day && this.shoulder.knee === this._knee && this.shoulder.cap === this._cap) return;
    this._day = day; this._knee = this.shoulder.knee; this._cap = this.shoulder.cap;
    blend3(u.uC1.value, N.c1, D.c1, day);
    blend3(u.uC2.value, N.c2, D.c2, day);
    blend3(u.uC3.value, N.c3, D.c3, day);
    u.uFall.value = blend(N.fall, D.fall, day);
    blend3(u.uLipCol.value, N.lip, D.lip, day);
    blend4(u.uLip.value, N.lipShape, D.lipShape, day);
    blend3(u.uDiaCol.value, N.dia, D.dia, day);
    blend4(u.uDia.value, N.diaShape, D.diaShape, day);
    u.uDiaFall.value.set(blend(N.diaFall[0], D.diaFall[0], day), blend(N.diaFall[1], D.diaFall[1], day));
    blend3(u.uSat.value, N.sat, D.sat, day);
    u.uKappa.value = blend(N.kappa, D.kappa, day);
    const knee = blend(N.knee, this.shoulder.knee, day);
    u.uKnee.value = knee;
    u.uCap.value = Math.max(blend(N.cap, this.shoulder.cap, day), knee + 0.01);
    u.uDay.value = day;
  }

  /** Ray-march steps (quality): 16 low, 24 medium, 32 high. */
  setSteps(n) {
    this.steps = Math.max(8, Math.min(48, Math.round(n)));
    this.uniforms.uSteps.value = this.steps;
  }

  /**
   * ab 0..1 (afterburner); throttle 0..1 (0.75 MIL; AircraftVisual lags it like the engine's spool)
   * for the throat glow; open 0..1, the petals' AB_Open weight (the exit the glow is seen through).
   */
  set(ab, throttle, open) {
    this.ab = Math.min(1, Math.max(0, ab || 0));
    if (Number.isFinite(throttle)) this.throttle = throttle;
    if (Number.isFinite(open)) this.open = Math.min(1, Math.max(0, open));
  }

  update(dt, camera) {
    this.time += dt;
    const ab = this.ab;
    const on = ab > 0.005;
    this.plume.visible = on;
    const u = this.uniforms;
    // throat glow (display, x uDisp): engine heat that only the dark shows (faint by day), plus the
    // burner's hot yellow-orange (yellow-white at night); the two looks blended as the flame's
    const day = flameDayLook(fxEnv.logLux);
    const thr = Math.min(1, Math.max(0, this.throttle));
    const gD = throatGlow(FLAME_DAY, thr, ab, fxEnv.darkness, this._gDay);
    // the night's engine heat by the rule for lights (display per cd/m^2: lightGain x exposure)
    const gN = throatGlow(FLAME_NIGHT, thr, ab, fxEnv.darkness, this._gNight, fxEnv.lightGain * this._exposure / LUX_PER_UNIT);
    const gr = blend(gN[0], gD[0], day), gg = blend(gN[1], gD[1], day), gb = blend(gN[2], gD[2], day);
    // with the burner lit the plume shader draws the glow (behind the flame, under the shoulder)
    this.glow.visible = !on;
    // the exit's radius as the petals open and close
    this.noz.value.x = this.rMil + (this.r0 - this.rMil) * Math.max(this.open, ab);
    if (camera) {
      // camera in the plume frame (unscaled: the group's frame, metres)
      this.group.updateWorldMatrix(true, false);
      this._inv.copy(this.group.matrixWorld).invert();
      camera.getWorldPosition(this._cam);
      u.uCamLocal.value.copy(this._cam).applyMatrix4(this._inv);
    }
    if (!on) { this.glowUniforms.uColour.value.setRGB(gr, gg, gb); return; }
    u.uGlow.value.set(gr, gg, gb);
    // visible core 1.4 m at light-off to 3.2 m at full burner by day, half as long again at night
    // (the faint tail shows against the dark); the bounding volume a little longer
    const core = (1.4 + 1.8 * Math.pow(ab, 0.8)) * blend(FLAME_NIGHT.length, FLAME_DAY.length, day);
    const len = Math.min(this.maxLen, core * 1.3);
    this.plume.scale.set(this.rMax, this.rMax, len);
    u.uScale.value.copy(this.plume.scale);
    u.uLen.value = len;
    u.uCore.value = core;
    u.uAb.value = ab;
    u.uTime.value = this.time % 1000;
    u.uGain.value = 0.35 + 0.65 * Math.pow(ab, 0.7);
    u.uSpacing.value = 0.72 + 0.12 * ab;              // shock cells stretch a little with pressure ratio
  }

  /** The meshes with shader programs of their own (AircraftFX compiles them before first use). */
  effectMeshes() { return [this.plume, this.glow]; }
}
