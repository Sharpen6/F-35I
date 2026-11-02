// The landscape track's checks at night, read off the drawn frame (js/world/Shore.js, js/env/README.md
// "Lights at night"), for tests/e2e.mjs (section 7) and by hand:
//
//   contract  every material drawn by the rule for point lights (js/world/AirportLights.js
//             POINT_LIGHT_VERT_GLSL: the airfield's lights, street lamps, cars, the buildings' and the
//             cranes' obstruction lights) carries the rule's uniforms (uThreshold, uExposure, uPxAngle,
//             uGain, uLightsOn) and the lights' blend (js/env/emitters.js emitterBlending). A light left
//             on the old contract (additive blending, two of the uniforms) drew black holes with cyan
//             rims at night: its negative emitter alpha times its colour, with the uniforms another
//             material had left in the program they share.
//   cranes    Ashdod port at 21:30 from 3.3 km, 250 m up (a free camera, the jet hidden): the container
//             cranes' obstruction lights are red (the reddest pixel within 2 px of each: r >= 100,
//             r >= 2 g, r >= 2 b), not dark holes.
//   hotels    Ein Bokek at 21:30 from 2 km: the hotels' lit windows are as bright as the city's
//             (Buildings.js WINDOW_CD by the night rule): the blocks' pixels (those that change when the
//             shore is hidden) average well under a lit window (they were flat, daylight-bright slabs:
//             luma ~165 for a mean window radiance 4.6 times the city's) and are lit (warm, not black).
//
// Needs NIGHT_PROBE (tests/night_probe.mjs) evaluated in the page (window.__np) and the shore data
// (data/landscape/shore.json, optional: without it the checks are skipped with a note).

/** Free cameras (world metres, y above sea level) and where the jet waits, hidden, meanwhile. */
export const SHORE_NIGHT_VIEWS = {
  // Ashdod port from the north-west (the review's cockpit view at 250 m), the cranes' middle 3.3 km away
  cranes: { spawn: [-38200, -1500], pos: [-38200, 250, -1500], look: [-35998, 40, -3966], fov: 35, time: 21.5 },
  // Ein Bokek's hotels from over the evaporation pond, 320 m above it, 2 km out
  hotels: { spawn: [33500, 68500], pos: [33500, -80, 68500], look: [32300, -385, 66900], fov: 40, time: 21.5 },
};

/** In the page: a flight next to the view (the jet out of sight) and the free camera on it. */
function placeView(v) {
  const sim = window.__sim, app = sim.app;
  const g = app.terrain.heightAt(v.spawn[0], v.spawn[1]);
  app.terrain.spawns._e2eShore = {
    label: 'e2e shore', x: v.spawn[0], z: v.spawn[1], y: Math.max(g, 0) + 900, ground_y: g,
    heading_deg: 0, on_ground: false, speed_ms: 160, gear: 0,
  };
  sim.start('_e2eShore', { time: v.time, camera: 'chase' });
  sim.time(v.time);
  sim.step(60);
  window.__np.free(v.pos, v.look, v.fov);
  const sh = app.modules.find((m) => m && m.name === 'shore');
  return sh ? { loaded: !!sh.loaded, stats: { ...sh.stats } } : null;
}

/** In the page: the materials drawn by the point lights' rule, and what each lacks of its contract. */
async function pointLightContract() {
  const app = window.__sim.app;
  const { emitterBlending } = await import('/js/env/emitters.js');
  const ref = emitterBlending({});
  const want = ['uThreshold', 'uExposure', 'uPxAngle', 'uGain', 'uLightsOn'];
  const seen = new Map();
  app.scene.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) {
      if (!m || !m.isShaderMaterial || seen.has(m) || !/pointLightSprite\s*\(/.test(m.vertexShader || '')) continue;
      const miss = want.filter((k) => !m.uniforms || !m.uniforms[k]);
      const blend = ['blending', 'blendSrc', 'blendDst', 'blendEquationAlpha', 'blendSrcAlpha', 'blendDstAlpha'].filter((k) => m[k] !== ref[k]);
      seen.set(m, { name: m.name || m.type, miss, blend });
    }
  });
  return [...seen.values()];
}

/** In the page: the reddest pixel (r - max(g, b)) within 2 px of each crane light on the screen. */
function craneLights() {
  const app = window.__sim.app, np = window.__np;
  const sh = app.modules.find((m) => m && m.name === 'shore');
  if (!sh || !sh.loaded) return null;
  window.__sim.render();
  const f = np.frame();
  const V = app.camera.position.clone();
  const out = [];
  let shown = 0;
  for (const A of sh.areas) {
    const L = A.lights;
    if (!L) continue;
    if (L.visible) shown++;
    const P = L.geometry.attributes.position;
    for (let i = 0; i < P.count; i++) {
      V.set(P.getX(i), P.getY(i), P.getZ(i)).add(L.position);
      const s = np.project(V);
      if (!s || s[0] < 3 || s[1] < 3 || s[0] > f.w - 4 || s[1] > f.h - 4) continue;
      let best = null;
      for (let j = -2; j <= 2; j++) {
        for (let k = -2; k <= 2; k++) {
          const c = np.px(f, s[0] + k, s[1] + j), r = c[0] - Math.max(c[1], c[2]);
          if (!best || r > best.r) best = { r, rgb: c };
        }
      }
      out.push(best.rgb);
    }
  }
  return { shown, lights: out };
}

/** In the page: the shore blocks' pixels (changed by hiding the shore): count, mean colour, luma quantiles. */
function shorePixels() {
  const app = window.__sim.app, np = window.__np, sim = window.__sim;
  sim.render();
  const on = np.frame();
  const had = Object.prototype.hasOwnProperty.call(app.settings, 'shore'), was = app.settings.shore;
  app.settings.shore = false;
  sim.render();
  const off = np.frame();
  if (had) app.settings.shore = was; else delete app.settings.shore;
  sim.render();
  const d1 = on.d, d0 = off.d, L = [];
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d1.length; i += 4) {
    if (Math.abs(d1[i] - d0[i]) + Math.abs(d1[i + 1] - d0[i + 1]) + Math.abs(d1[i + 2] - d0[i + 2]) < 12) continue;
    r += d1[i]; g += d1[i + 1]; b += d1[i + 2];
    L.push(0.2126 * d1[i] + 0.7152 * d1[i + 1] + 0.0722 * d1[i + 2]);
  }
  const n = L.length;
  L.sort((x, y) => x - y);
  const q = (p) => (n ? +L[Math.min(n - 1, Math.floor(p * n))].toFixed(1) : null);
  return { n, rgb: n ? [r / n, g / n, b / n].map((v) => Math.round(v)) : null, luma: n ? +(L.reduce((s, v) => s + v, 0) / n).toFixed(1) : null,
    p50: q(0.5), p90: q(0.9) };
}

async function settleView(S) {
  // the terrain's tiles and the buildings around the free camera stream in
  for (let i = 0; i < 3; i++) await S((ms) => window.__sim.settle(ms), 2000);
}

/**
 * Runs the checks: S(fn, arg) = page.evaluate; check(name, ok, detail); shot(name, settleMs) draws and
 * saves a screenshot; log(...). Returns the measurements.
 */
export async function landscapeNightChecks({ S, check, shot, log }) {
  const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : String(x));
  const res = {};
  // ---- Ashdod's cranes
  const vc = await S(placeView, SHORE_NIGHT_VIEWS.cranes);
  if (!vc || !vc.loaded) {
    log(`note: no shore structures (${vc ? 'no data/landscape/shore.json' : 'no shore module'}): the landscape's night checks skipped`);
    await S(() => window.__np.restore());
    return null;
  }
  await settleView(S);
  if (shot) await shot('17_ashdod_cranes_night', 600);
  const cl = await S(craneLights);
  const red = cl.lights.filter((c) => c[0] >= 100 && c[0] >= 2 * c[1] && c[0] >= 2 * c[2]);
  res.cranes = { shown: cl.shown, lights: cl.lights.length, red: red.length, sample: cl.lights.slice(0, 6) };
  check('Ashdod at night: the cranes\' obstruction lights are red (r >= 100, r >= 2 g), not dark holes',
    cl.lights.length >= 10 && red.length >= 0.75 * cl.lights.length,
    `${red.length} of ${cl.lights.length} lights on the screen red (${cl.shown} areas lit); e.g. ${cl.lights.slice(0, 4).map((c) => `(${c})`).join(' ')}`);
  // ---- every point light on the rule's contract (the buildings' tiles round Ashdod are in the scene by now)
  const pc = await S(pointLightContract);
  const badC = pc.filter((m) => m.miss.length || m.blend.length);
  res.contract = pc;
  check('point lights: every material on the rule\'s uniforms and the lights\' blend (emitters.js)',
    pc.length >= 2 && badC.length === 0,
    `${pc.map((m) => m.name).join(', ')}${badC.length ? `; wrong: ${badC.map((m) => `${m.name} lacks ${m.miss.join(' ')}${m.blend.length ? ` blend ${m.blend.join(' ')}` : ''}`).join('; ')}` : ''}`);

  // ---- Ein Bokek's hotels
  await S(placeView, SHORE_NIGHT_VIEWS.hotels);
  await settleView(S);
  if (shot) await shot('18_einbokek_hotels_night', 600);
  const hp = await S(shorePixels);
  res.hotels = hp;
  // a lit window is ~0.9 on the display by the night rule (sRGB luma ~230 through the lights' tone
  // curve): the facades' mean (some windows lit, walls, balconies) well under it (~100; the fixed
  // window radiance made it ~160), and lit, warm
  check('Ein Bokek at night: the hotels lit as the city\'s windows (mean luma < 130, lit, warm), not daylight-bright slabs',
    hp.n >= 300 && hp.luma < 130 && hp.p90 >= 40 && hp.rgb[0] >= hp.rgb[2],
    `${hp.n} pixels: mean rgb (${hp.rgb}) luma ${f1(hp.luma)}, median ${f1(hp.p50)}, 90th percentile ${f1(hp.p90)}`);
  await S(() => window.__np.restore());
  return res;
}
