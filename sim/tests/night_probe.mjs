// Page-side measurements of the lights in the drawn frame, for the night checks of e2e.mjs and the
// probes of night_shots.mjs (js/env/README.md "Lights at night"). Evaluate NIGHT_PROBE in the page
// (index.html?test=1) after the app is ready; it defines window.__np:
//
//   free(pos, look, fov) / restore()   a free camera (world metres; the jet hidden) / the app's own
//   papiCam(near, heading, D, fov)      on the 3 deg path, D m before the PAPI next to `near` ([x, z]),
//                                       on the runway's centreline (heading deg of the landing direction)
//   papi(near)                          the four PAPI units next to `near` ([x, z]; by default the ones
//                                       papiCam aimed at, else those nearest the camera): their elevation
//                                       angle, the brightest pixel near each (rgb 0..255), r / g, CIE x y
//   reds()                              the red lights in the frame: local maxima (3x3) of redness (red
//                                       over the brightest other channel) whose red is >= 100 and that
//                                       are red (hue -20..18 deg, saturation >= 0.25; a pale salmon
//                                       counts, so a light washed out to white shows): their count, CIE x
//                                       as drawn (median, quartiles) and of what the light adds over its
//                                       background (lightX: over the per-channel median of the ring 3 px
//                                       out, in linear light; a far light is a pixel on the lit facade it
//                                       sits on, which pales the pixel whatever the light's colour)
//   tail()                              the jet's white tail light: its brightest pixel, the width (px) of
//                                       the row through it at half its height over the background, its
//                                       white core (the run at luma >= 200), the steepest step between
//                                       neighbours under luma 100 (step) and the skirt's kink: outside
//                                       the half height a soft skirt's steps between neighbours shrink
//                                       outwards, a skirt cut off at the sprite's edge drops by a step
//                                       larger than the one before it (the most any step outgrows the
//                                       one inside it, either side of the row: ~1-3 soft, ~15 the
//                                       blue-hour ball's cut skirt)
//   burner()                            the burner's flame along its axis: the body between the first three
//                                       shock diamonds (median colour: rgb, r / g, CIE x y), the diamonds
//                                       (dia: the median of their brightest pixels) and the tail (tail:
//                                       between the 4th and 5th diamond, at tailAt of the visible core)
//   pool()                              the landing light's pool: where its beam meets the ground on
//                                       screen, and the median display luminance (linear) round it with the
//                                       lamp on and off (two frames each, the jet hidden: from the chase
//                                       seat it stands in front of its pool); its distance from the lamp,
//                                       the ground's light as drawn and without the night's boosts (lux)
//
// Pixels are those of the 3D canvas as drawn (tone mapped, sRGB), read after window.__sim.render().

export const NIGHT_PROBE = `
window.__np = {
  frame() {
    const c = window.__sim.app.renderer.domElement;
    const cv = this._cv || (this._cv = document.createElement('canvas'));
    if (cv.width !== c.width || cv.height !== c.height) { cv.width = c.width; cv.height = c.height; }
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0);
    return { w: cv.width, h: cv.height, d: g.getImageData(0, 0, cv.width, cv.height).data };
  },
  px(f, x, y) {
    x = Math.max(0, Math.min(f.w - 1, Math.round(x))); y = Math.max(0, Math.min(f.h - 1, Math.round(y)));
    const i = 4 * (y * f.w + x);
    return [f.d[i], f.d[i + 1], f.d[i + 2]];
  },
  luma(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; },
  lin(v) { const x = v / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); },
  /** CIE xy of an 8-bit sRGB colour. */
  xy(c) { return this.xyLin([this.lin(c[0]), this.lin(c[1]), this.lin(c[2])]); },
  /** CIE xy of a linear sRGB colour. */
  xyLin([r, g, b]) {
    const X = 0.4124 * r + 0.3576 * g + 0.1805 * b, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
    const s = X + Y + Z || 1;
    return [+(X / s).toFixed(3), +(Y / s).toFixed(3)];
  },
  /** World point -> drawing-buffer pixel (null behind the camera). */
  project(p) {
    const app = window.__sim.app, cam = app.camera, el = app.renderer.domElement;
    const v = cam.position.clone().copy(p).project(cam);
    if (v.z > 1 || v.z < -1) return null;
    return [(v.x + 1) / 2 * el.width, (1 - v.y) / 2 * el.height];
  },
  /** The brightest pixel (luma) within r px of (x, y). */
  peak(f, x, y, r = 3) {
    let best = null;
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
      const c = this.px(f, x + i, y + j), l = this.luma(c);
      if (!best || l > best.luma) best = { x: Math.round(x + i), y: Math.round(y + j), rgb: c, luma: +l.toFixed(1) };
    }
    return best;
  },
  /** Width (px) of the run through (x, y) along the row over half the peak's height above the row's floor. */
  fwhm(f, x, y, span = 30) {
    const L = (i) => this.luma(this.px(f, x + i, y));
    let lo = Infinity;
    for (let i = -span; i <= span; i++) lo = Math.min(lo, L(i));
    const half = lo + 0.5 * (L(0) - lo);
    let a = 0, b = 0;
    while (a > -span && L(a - 1) >= half) a--;
    while (b < span && L(b + 1) >= half) b++;
    return b - a + 1;
  },
  free(pos, look, fov) {
    const app = window.__sim.app, c = app.camera;
    if (!app._npCam) app._npCam = app.cams.update.bind(app.cams);
    app.cams.update = () => {
      c.position.set(pos[0], pos[1], pos[2]);
      c.up.set(0, 1, 0);
      c.lookAt(look[0], look[1], look[2]);
      c.fov = fov;
      c.updateProjectionMatrix();
      c.updateMatrixWorld(true);
    };
    app.visual.object3d.visible = false;
    return true;
  },
  restore() {
    const app = window.__sim.app;
    this._papiNear = null;
    if (app._npCam) app.cams.update = app._npCam;
    app.visual.object3d.visible = true;
    return true;
  },
  /** Every PAPI unit of the airfield lights: world position, elevation angle (deg). */
  papiUnits() {
    const app = window.__sim.app, R = app.modules && app.modules.find((m) => m.name === 'roads'), L = R && R.lights;
    if (!L) return [];
    const out = [];
    for (const o of L.group.children) {
      const g = o.geometry, D = g && g.attributes.aDir, E = g && g.attributes.aExt, P = g && g.attributes.position;
      if (!D || !E || !P) continue;
      o.updateMatrixWorld(true);
      for (let i = 0; i < D.count; i++) {
        if (Math.abs(D.getW(i) - 1) > 0.01) continue;
        const v = app.camera.position.clone().set(P.getX(i), P.getY(i), P.getZ(i)).applyMatrix4(o.matrixWorld);
        out.push({ p: v, ang: E.getX(i) * 180 / Math.PI });
      }
    }
    return out;
  },
  papiCam(near, heading, D, fov) {
    const u = this.papiUnits().map((x) => ({ ...x, d: Math.hypot(x.p.x - near[0], x.p.z - near[1]) }))
      .sort((a, b) => a.d - b.d).slice(0, 4);
    if (u.length < 4) return null;
    const h = heading * Math.PI / 180, dx = Math.sin(h), dz = -Math.cos(h);
    const m = u.reduce((s, x) => [s[0] + x.p.x / 4, s[1] + x.p.y / 4, s[2] + x.p.z / 4], [0, 0, 0]);
    // the centreline: the units stand on the runway's left (or right) at 15 m + 9 m steps from its
    // edge, on a line square to it; the inner unit (the highest angle) is the nearest the runway
    const inner = u.reduce((a, b) => (b.ang > a.ang ? b : a));
    const outer = u.reduce((a, b) => (b.ang < a.ang ? b : a));
    const ox = inner.p.x - outer.p.x, oz = inner.p.z - outer.p.z, ol = Math.hypot(ox, oz) || 1;
    const off = 15 + 13.5 + 22.5;          // from the units' middle to the centreline (a 45 m runway)
    const cx = m[0] + ox / ol * off, cz = m[2] + oz / ol * off;
    const pos = [cx - dx * D, m[1] + D * Math.tan(3 * Math.PI / 180), cz - dz * D];
    this.free(pos, [m[0], m[1], m[2]], fov);
    this._papiNear = near;
    return { units: u.map((x) => ({ ang: +x.ang.toFixed(3), d: +x.d.toFixed(1) })), pos: pos.map((v) => +v.toFixed(1)) };
  },
  papi(near = this._papiNear) {
    const app = window.__sim.app, f = this.frame(), cp = app.camera.position;
    const u = this.papiUnits().map((x) => ({ ...x, d: x.p.distanceTo(cp), k: near ? Math.hypot(x.p.x - near[0], x.p.z - near[1]) : x.p.distanceTo(cp) }))
      .sort((a, b) => a.k - b.k).slice(0, 4);
    return u.sort((a, b) => b.ang - a.ang).map((x) => {
      const s = this.project(x.p);
      const pk = s ? this.peak(f, s[0], s[1], 2) : null;
      const el = Math.atan2(cp.y - x.p.y, Math.hypot(cp.x - x.p.x, cp.z - x.p.z)) * 180 / Math.PI;
      return { ang: +x.ang.toFixed(3), seen: +el.toFixed(3), d: Math.round(x.d), at: s && s.map(Math.round), rgb: pk && pk.rgb,
        rg: pk ? +(pk.rgb[0] / Math.max(pk.rgb[1], 1)).toFixed(2) : null, xy: pk && this.xy(pk.rgb) };
    });
  },
  /** Hue (deg, -180..180, 0 red) and saturation (max - min) / max of an 8-bit colour. */
  hue(c) {
    const M = Math.max(c[0], c[1], c[2]), m = Math.min(c[0], c[1], c[2]), d = M - m;
    if (d <= 0) return { h: 0, s: 0 };
    let h = M === c[0] ? (c[1] - c[2]) / d : M === c[1] ? 2 + (c[2] - c[0]) / d : 4 + (c[0] - c[1]) / d;
    h *= 60; if (h > 180) h -= 360;
    return { h, s: d / M };
  },
  reds() {
    const f = this.frame(), xs = [], ls = [];
    const red = (c) => c[0] - Math.max(c[1], c[2]);
    for (let y = 3; y < f.h - 3; y++) for (let x = 3; x < f.w - 3; x++) {
      const c = this.px(f, x, y);
      if (c[0] < 100 || c[0] < c[1] || c[0] < c[2]) continue;
      const hs = this.hue(c);
      if (hs.s < 0.25 || hs.h < -20 || hs.h > 18) continue;
      // the light's own pixel: a luma maximum next to a red light on a lit facade is often the facade
      const k = red(c);
      let max = true;
      for (let j = -1; j <= 1 && max; j++) for (let i = -1; i <= 1; i++) {
        if ((i || j) && red(this.px(f, x + i, y + j)) > k) { max = false; break; }
      }
      if (!max) continue;
      xs.push(this.xy(c)[0]);
      const ring = [[], [], []];
      for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== 3) continue;
        const p = this.px(f, x + i, y + j);
        for (let ch = 0; ch < 3; ch++) ring[ch].push(this.lin(p[ch]));
      }
      const add = [0, 1, 2].map((ch) => {
        const r = ring[ch].sort((a, b) => a - b);
        return Math.max(0, this.lin(c[ch]) - r[r.length >> 1]);
      });
      ls.push(this.xyLin(add)[0]);
    }
    const q = (v, p) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null);
    xs.sort((a, b) => a - b);
    ls.sort((a, b) => a - b);
    return { n: xs.length, medianX: q(xs, 0.5), p25: q(xs, 0.25), p75: q(xs, 0.75),
      lightX: q(ls, 0.5), lightP25: q(ls, 0.25), lightP75: q(ls, 0.75) };
  },
  tail() {
    const app = window.__sim.app, L = app.visual && app.visual.lights;
    const s = L && L.sources.find((x) => x.role === 'tail');
    if (!s) return null;
    s.node.updateWorldMatrix(true, false);
    const p = this.project(s.pos.clone().applyMatrix4(s.node.matrixWorld));
    if (!p) return null;
    const f = this.frame(), pk = this.peak(f, p[0], p[1], 4);
    const Y = (i) => this.luma(this.px(f, pk.x + i, pk.y));
    let a = 0, b = 0;
    while (a > -30 && Y(a - 1) >= 200) a--;
    while (b < 30 && Y(b + 1) >= 200) b++;
    let step = 0;
    for (let i = -30; i < 30; i++) if (Math.max(Y(i), Y(i + 1)) < 100) step = Math.max(step, Math.abs(Y(i + 1) - Y(i)));
    // the kink: from the half height outwards, each side, how much a step outgrows the one inside it
    let lo = Infinity;
    for (let i = -30; i <= 30; i++) lo = Math.min(lo, Y(i));
    const half = lo + 0.5 * (Y(0) - lo);
    let kink = 0;
    for (const dir of [-1, 1]) {
      let i = 0;
      while (Math.abs(i) < 29 && Y(i) >= half) i += dir;
      let prev = Infinity;
      for (; Math.abs(i) < 29; i += dir) {
        const d = Y(i) - Y(i + dir);
        if (prev < Infinity) kink = Math.max(kink, d - prev);
        prev = d;
      }
    }
    return { at: [pk.x, pk.y], rgb: pk.rgb, width: this.fwhm(f, pk.x, pk.y), height: this.fwhmV(f, pk.x, pk.y),
      core: Y(0) >= 200 ? b - a + 1 : 0, step: Math.round(step), kink: Math.round(kink) };
  },
  fwhmV(f, x, y, span = 30) {
    const L = (j) => this.luma(this.px(f, x, y + j));
    let lo = Infinity;
    for (let j = -span; j <= span; j++) lo = Math.min(lo, L(j));
    const half = lo + 0.5 * (L(0) - lo);
    let a = 0, b = 0;
    while (a > -span && L(a - 1) >= half) a--;
    while (b < span && L(b + 1) >= half) b++;
    return b - a + 1;
  },
  burner() {
    const app = window.__sim.app, ab = app.visual && app.visual.afterburner;
    if (!ab || !ab.plume.visible) return null;
    ab.group.updateWorldMatrix(true, false);
    const u = ab.uniforms, core = u.uCore.value, sp = u.uSpacing.value, z0 = 0.62 * sp, f = this.frame();
    // the plume's axis at z m behind the exit, on screen
    const at = (z) => {
      const p = this.project(app.camera.position.clone().set(0, 0, z).applyMatrix4(ab.group.matrixWorld));
      return p && p[0] >= 0 && p[1] >= 0 && p[0] < f.w && p[1] < f.h ? p : null;
    };
    const median = (cols) => {
      if (!cols.length) return null;
      const m = [0, 1, 2].map((k) => cols.map((c) => c[k]).sort((a, b) => a - b)[Math.floor(cols.length / 2)]);
      return { rgb: m, gr: +(m[1] / Math.max(m[0], 1)).toFixed(3), xy: this.xy(m), n: cols.length };
    };
    // the body between the first three shock diamonds (Afterburner.js: the k-th at z0 + k x spacing),
    // the brightest pixel at each of those three diamonds, and the body between the 4th and 5th
    const body = [], dia = [];
    for (let k = 0; k < 3; k++) {
      for (const d of [-0.1, 0, 0.1]) { const p = at(z0 + (k + 0.5 + d) * sp); if (p) body.push(this.px(f, p[0], p[1])); }
      const q = at(z0 + k * sp);
      if (q) dia.push(this.peak(f, q[0], q[1], 2).rgb);
    }
    const tail = [];
    for (const d of [-0.1, 0, 0.1]) { const p = at(z0 + (3.5 + d) * sp); if (p) tail.push(this.px(f, p[0], p[1])); }
    const b = median(body);
    return b && { ...b, dia: median(dia), tail: median(tail), tailAt: +((z0 + 3.5 * sp) / core).toFixed(2) };
  },
  /** Where the landing beam meets the ground (world), from the lamp along its axis. */
  poolPoint() {
    const app = window.__sim.app, L = app.visual && app.visual.lights && app.visual.lights.landing;
    if (!L) return null;
    const beam = L.beams ? (L.beams[0].weight >= L.beams[1].weight ? L.beams[0] : L.beams[1]) : L;
    const p = L.position.clone(), d = beam.direction;
    for (let t = 2; t < 3000; t *= 1.03) {
      const q = p.clone().addScaledVector(d, t);
      if (q.y <= app.terrain.heightAt(q.x, q.z) + 0.2) return q;
    }
    return null;
  },
  pool() {
    const app = window.__sim.app, sim = window.__sim, q = this.poolPoint();
    if (!q) return null;
    // the median over 13 x 13 px: the ground, not the runway's or the approach's lights in the box
    const lum = () => {
      const f = this.frame(), s = this.project(q);
      if (!s) return null;
      const v = [];
      for (let j = -6; j <= 6; j++) for (let i = -6; i <= 6; i++) {
        const c = this.px(f, s[0] + i, s[1] + j);
        v.push(0.2126 * this.lin(c[0]) + 0.7152 * this.lin(c[1]) + 0.0722 * this.lin(c[2]));
      }
      v.sort((a, b) => a - b);
      return { at: s.map(Math.round), lum: v[v.length >> 1] };
    };
    // the jet hidden while measuring (from the chase seat it stands in front of its own pool); the
    // pool is drawn by AircraftFX, which only asks whether the jet's group is shown
    const v = app.visual, hide = [v.model, v.afterburner && v.afterburner.group].filter(Boolean);
    const shown = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    const was = app.lights.landing;
    app.lights.landing = true; sim.render(); sim.render();
    const on = lum();
    app.lights.landing = false; sim.render(); sim.render();
    const off = lum();
    app.lights.landing = was;
    hide.forEach((o, i) => { o.visible = shown[i]; });
    sim.render();
    const cp = app.camera.position, env = app.env, A = env.uniforms.uAmbient.value;
    // the light on the ground as drawn (boosted at night) and without the boosts (lux)
    const lux = (x) => +(x * 32000).toPrecision(3);
    return on && off ? { at: on.at, dist: Math.round(q.distanceTo(cp)), on: +on.lum.toExponential(3), off: +off.lum.toExponential(3),
      ratio: +(on.lum / Math.max(off.lum, 1e-6)).toFixed(2), lamp: Math.round(q.distanceTo(app.visual.lights.landing.position)),
      ground: lux(0.2126 * A.r + 0.7152 * A.g + 0.0722 * A.b), real: lux(env.groundLightPhysical ?? 0) } : null;
  },
};
true;
`;
