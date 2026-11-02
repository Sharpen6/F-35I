// node sim/tests/light_pollution.test.mjs
// Checks the night sky's light pollution model (js/env/lightPollution.js, the JS twin of the
// shaders' LP_GLSL) against the light pollution atlas it was calibrated to (Falchi et al. 2016:
// the artificial zenith brightness in natural units, n.u.; 1 n.u. = 22.0 mag / arcsec^2), the
// overcast-sky ratio of Kyba et al. (2015), and its own invariants (uniform packing, symmetry).
import { SkyGlow, LP_N, LP_MODEL, LP_RGB, NATURAL_SKY, lpLuma } from '../js/env/lightPollution.js';
import { lonLatToXZ } from '../js/world/coords.js';

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const at = (lon, lat, y = 30) => { const p = lonLatToXZ(lon, lat); return [p.x, y, p.z]; };
// compass azimuth (deg) of the brightest sky 1 deg above the horizon, and that brightness
function brightest(g) {
  let best = 0, az = 0;
  for (let a = 0; a < 360; a += 2) {
    const r = a * Math.PI / 180;
    const s = g.sky(Math.sin(r) * 0.99985, 0.0175, -Math.cos(r) * 0.99985);
    if (s.B > best) { best = s.B; az = a; }
  }
  return { az, B: best };
}
const g = new SkyGlow();

// zenith brightness (natural + artificial, n.u.) where the atlas has it
const PLACES = [
  // name, lon, lat, height (m), [min, max] n.u. at the zenith
  ['central Tel Aviv', 34.78, 32.08, 30, [25, 90]],          // atlas: > 17x natural (red-white)
  ['Ben Gurion airport', 34.886, 32.005, 40, [6, 20]],       // red: 5.7-17x
  ['Tel Nof', 34.82, 31.84, 60, [3, 10]],
  ['north of the Dead Sea', 35.5, 31.72, -400, [1.3, 3.5]], // near natural, Jerusalem / Amman domes
  ['the Negev south of Beer Sheva', 35.0, 31.0, 500, [1.0, 1.8]],
  ['30 km out at sea off Tel Aviv', 34.45, 32.08, 300, [1.3, 3.5]],
];
const zen = {};
for (const [name, lon, lat, y, [lo, hi]] of PLACES) {
  g.update(...at(lon, lat, y));
  const z = g.sky(0, 1, 0).B;
  zen[name] = z;
  check(`zenith over ${name} ${lo}-${hi} n.u.`, z >= lo && z <= hi, `${z.toFixed(1)} n.u. (${(22 - 2.5 * Math.log10(z)).toFixed(2)} mag/arcsec^2)`);
}
check('darker from the city outwards', zen['central Tel Aviv'] > zen['Ben Gurion airport'] && zen['Ben Gurion airport'] > zen['Tel Nof'] && zen['Tel Nof'] > zen['north of the Dead Sea']);

// the domes: from Ben Gurion the brightest horizon is towards Tel Aviv (NW), from the Dead Sea
// towards Jerusalem (W) or Amman (E), never towards the empty south
g.update(...at(34.886, 32.005, 40));
let b = brightest(g);
check('Ben Gurion: the brightest dome towards Tel Aviv (az 290-335)', b.az >= 290 && b.az <= 335, `az ${b.az}, ${b.B.toFixed(1)} n.u.`);
check('Ben Gurion: the horizon 2-5x the zenith', b.B / g.sky(0, 1, 0).B > 2 && b.B / g.sky(0, 1, 0).B < 5, `${(b.B / g.sky(0, 1, 0).B).toFixed(2)}`);
g.update(...at(35.5, 31.72, -400));
b = brightest(g);
check('Dead Sea: the brightest dome towards Jerusalem or Amman', (b.az >= 260 && b.az <= 310) || (b.az >= 55 && b.az <= 100), `az ${b.az}`);
const south = g.sky(0, 0.0175, 0.99985).B;
check('Dead Sea: the southern horizon near natural (< 4 n.u.)', south < 4, `${south.toFixed(2)} n.u.`);

// the dome narrows and fades with elevation; the glow above the camera fades with height
g.update(...at(34.886, 32.005, 40));
const toTlv = (e) => { const r = 313 * Math.PI / 180, c = Math.cos(e * Math.PI / 180); return g.sky(Math.sin(r) * c, Math.sin(e * Math.PI / 180), -Math.cos(r) * c).B; };
check('the dome fades with elevation (1 > 10 > 30 > 90 deg)', toTlv(1) > toTlv(10) && toTlv(10) > toTlv(30) && toTlv(30) > g.sky(0, 1, 0).B);
const zLow = g.sky(0, 1, 0).B;
g.update(...at(34.886, 32.005, 6000));
check('the glow above fades with height (6 km < half of the ground)', g.sky(0, 1, 0).B - 1 < 0.5 * (zLow - 1), `${g.sky(0, 1, 0).B.toFixed(2)} vs ${zLow.toFixed(2)} n.u.`);

// under a cloud deck: a base over Tel Aviv 5-25x the clear sky there (Kyba 2015), over the Dead
// Sea and far out at sea next to nothing
g.update(...at(34.78, 32.08, 3000), 1800);
const tlv = lonLatToXZ(34.78, 32.08);
const baseTlv = g.cloudBase(tlv.x, tlv.z), skyTlv = g.sky(0, 1, 0).B;
g.update(...at(34.78, 32.08, 30), 1800);
const ratio = baseTlv / g.sky(0, 1, 0).B;
check('cloud base over Tel Aviv 5-25x its clear zenith', ratio >= 5 && ratio <= 25, `${baseTlv.toFixed(0)} n.u. = ${ratio.toFixed(1)}x (sky from 3 km ${skyTlv.toFixed(1)})`);
g.update(...at(35.5, 31.72, -400), 1800);
const ds = lonLatToXZ(35.5, 31.72);
check('cloud base over the Dead Sea < 2 n.u.', g.cloudBase(ds.x, ds.z) < 2, `${g.cloudBase(ds.x, ds.z).toFixed(2)} n.u.`);

// the drawn sky (one gain per place: the eye adapts further in the dark): Ben Gurion's about as
// the night glow was tuned (~4e-5 scene units), a dark place 1/2-2/3 of it (not 1/10), central Tel
// Aviv's 1.4-2.5x; the colour of a city's dome orange, of a dark sky blue
g.update(...at(34.886, 32.005, 40));
const m = g.means(g.gain());
const zb = lpLuma(...m.zenith);
check('Ben Gurion zenith drawn 3.5-5.5e-5', zb > 3.5e-5 && zb < 5.5e-5, zb.toExponential(2));
check('Ben Gurion horizon (mean) brighter and warmer than the zenith', lpLuma(...m.horizon) > zb && m.horizon[0] / m.horizon[2] > m.zenith[0] / m.zenith[2]);
g.update(...at(35.0, 31.0, 500));
const mn = g.means(g.gain());
const zn = lpLuma(...mn.zenith);
check('the Negev zenith drawn 1/2-2/3 of Ben Gurion', zn / zb > 0.5 && zn / zb < 0.67, (zn / zb).toFixed(2));
check('the Negev zenith blue (b > r)', mn.zenith[2] > mn.zenith[0]);
g.update(...at(34.78, 32.08, 30));
const zt = lpLuma(...g.means(g.gain()).zenith);
check('central Tel Aviv zenith drawn 1.4-2.5x Ben Gurion', zt / zb > 1.4 && zt / zb < 2.5, (zt / zb).toFixed(2));
check('the cities\' glow orange (r > g > b)', LP_RGB[0] > LP_RGB[1] && LP_RGB[1] > LP_RGB[2] && Math.abs(lpLuma(...LP_RGB) - 1) < 0.01);
check('dusk fade 0: nothing drawn', lpLuma(...g.means(0).zenith) === 0 && lpLuma(...g.means(0).horizon) === 0);
// the gain: the zenith as drawn over the zenith as it is (the moon's boost); a moonlit sky lowers
// it (a full moon 30 deg up adds ~40 n.u.); the display law grows with the sky, slower than it
const B0 = g.zenithArt + 1;
check('gain x zenith = the zenith drawn', Math.abs(g.gain() * B0 / g.drawn(B0) - 1) < 1e-9);
check('a moonlit sky lowers the gain (the moon\'s boost 150-600 under a full moon over Tel Aviv)', g.gain(40) < g.gain(0) && g.gain(40) / NATURAL_SKY > 150 && g.gain(40) / NATURAL_SKY < 600, (g.gain(40) / NATURAL_SKY).toFixed(0));
let lawOk = true;
for (let b = 0.5; b < 500; b *= 1.3) if (!(g.drawn(b * 1.3) > g.drawn(b) && g.drawn(b * 1.3) / g.drawn(b) < 1.3)) lawOk = false;
check('the display law: rising, compressive', lawOk);

// the uniforms: LP_N domes, strongest first, each a unit direction x kappa; empty slots harmless
g.update(...at(34.886, 32.005, 40));
let sorted = true, finite = true;
for (let i = 0; i < LP_N; i++) {
  if (i > 0 && g.src[i * 4 + 2] > g.src[(i - 1) * 4 + 2]) sorted = false;
  for (let k = 0; k < 4; k++) if (!Number.isFinite(g.src[i * 4 + k]) || !Number.isFinite(g.city[i * 4 + k])) finite = false;
}
check(`uniforms: ${LP_N} domes, strongest first, finite`, sorted && finite);
check('NATURAL_SKY: 174 ucd/m^2 in scene units', Math.abs(NATURAL_SKY * 32000 - 174e-6) < 1e-9);
check('model gamma in (0, 1], floor >= 0', LP_MODEL.gamma > 0 && LP_MODEL.gamma <= 1 && LP_MODEL.floor >= 0);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
