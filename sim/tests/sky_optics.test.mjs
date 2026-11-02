// node --import ./sim/tests/node-three.mjs sim/tests/sky_optics.test.mjs
// Checks the sun's glare and lens ghosts of js/env/Post.js (VIEW_OPTICS, GHOSTS) against the
// physics they were set from: the eye's (cockpit view) glare against the CIE 135 disability glare
// spread function, the camera's (outside views) faint ghosts against what two reflections off
// multicoated glass can carry.
import { VIEW_OPTICS, GHOSTS } from '../js/env/Post.js';

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
// the output pass' glare lobe (Post.js lobe()): radiance per unit of the sun's irradiance (1 / sr)
const lobe = (th, w) => { const q = th * th + w * w; return w / (2 * Math.PI * q * Math.sqrt(q)); };
const glare = (o, th) => o.core[0] * lobe(th, o.core[1]) + o.veil[0] * lobe(th, o.veil[1]);
// CIE 135 (1999) disability glare, a young eye (age 25, a dark iris: p = 0.5): L / E (1 / sr), th in degrees
const cie = (deg) => 10 / deg ** 3 + (5 / deg ** 2 + 0.05 / deg) * (1 + (25 / 62.5) ** 4) + 0.0025 * 0.5;

check('the cockpit view (an eye) has no lens ghosts', VIEW_OPTICS.eye.ghosts === false);
check('the outside views (a camera) have them', VIEW_OPTICS.camera.ghosts === true);
for (const deg of [1, 2, 5, 10]) {
  const th = deg * Math.PI / 180;
  const r = glare(VIEW_OPTICS.eye, th) / cie(deg);
  check(`eye glare at ${deg} deg: 0.2-0.6 of CIE 135`, r > 0.2 && r < 0.6, r.toFixed(2));
}
for (const deg of [1, 5]) {
  const th = deg * Math.PI / 180;
  const r = glare(VIEW_OPTICS.camera, th) / glare(VIEW_OPTICS.eye, th);
  check(`camera glare at ${deg} deg below the eye's`, r < 1, r.toFixed(2));
}
// the share of the sun's light in all the glare stays small (energy: lobes integrate to their fraction)
const total = (o) => o.core[0] + o.veil[0];
check('the glare scatters < 5 % of the sun\'s light', total(VIEW_OPTICS.eye) < 0.05 && total(VIEW_OPTICS.camera) < 0.05);

// ghosts: each carries at most ~R^2 (R ~ 0.3 % per multicoated surface: 9e-6) of the sun's light,
// and over its disc at a 60 deg field of view adds at most ~0.01 E / sr (the old ones: 0.012 E / sr
// whatever their size, up to a tenth of the frame wide)
const radY = 2 * Math.tan(30 * Math.PI / 180);
for (const g of GHOSTS) {
  const a = g.r * radY, L = g.f / (0.8 * Math.PI * a * a);
  check(`ghost at t ${g.t}: <= R^2 of the light, <= 0.01 E/sr, small (< 3 % of the frame)`,
    g.f <= 9e-6 && L <= 0.01 && g.r < 0.03, `f ${g.f}, ${L.toFixed(4)} E/sr, r ${g.r}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
