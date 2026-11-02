// The live panoramic cockpit display: a 2D canvas redrawn a few times a second from the sim state
// and used as the emissive map of the glb's PCD glass (Cockpit.js does that).
//
//   const pcd = new PCD({ maxAnisotropy });
//   await pcd.setMaps(terrain);                   // the TSD's moving map from the terrain imagery
//   pcd.setQuality('high');                       // resolution and redraw rate
//   pcd.update(dt, data, visible);                 // every frame; redraws when its timer runs out
//   pcd.texture                                    // THREE.CanvasTexture (glTF uv: v = 0 at the top)
//   pcd.glow                                       // THREE.Color: mean linear colour of the glass
//
// data = { st (FlightModel.state), levers (Input.levers), hours (solar time),
//          dayOfYear, spawn, airports, wingmen }. pages.js draws it; systems.js derives fuel tanks,
// engine temperatures and the caution list. The canvas is drawn in a 1600 x 640 reference frame
// scaled to the quality's size, so every size shows the same layout.

import * as THREE from 'three';
import { Systems } from './systems.js';
import { drawAll, LAYOUT, REF_W, REF_H } from './pages.js';

const NM = 1852;
const KT = 0.514444;
const FT = 0.3048;
const DEG = Math.PI / 180;

/** Canvas width (px) and redraw rate (Hz) per graphics quality. */
export const PCD_QUALITY = {
  low: { width: 1024, hz: 4 },
  medium: { width: 1600, hz: 6 },
  high: { width: 2048, hz: 10 },
};

const _f = new THREE.Vector3();
const NO_WINGMEN = [];

function hhmm(h) {
  h = ((h % 24) + 24) % 24;
  let H = Math.floor(h), M = Math.round((h - H) * 60);
  if (M === 60) { H = (H + 1) % 24; M = 0; }
  return `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`;
}

/**
 * Clock time from local apparent solar time at the sim's centre (35.025 E): UTC = solar - 35.025/15 h
 * - the equation of time; Israel keeps UTC+3 in summer (late March to late October), UTC+2 otherwise.
 */
export function clockFromSolar(solarH, doy = 172) {
  const B = (360 / 365) * (doy - 81) * DEG;
  const eotMin = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  const utc = solarH - eotMin / 60 - 35.025 / 15;
  const summer = doy >= 85 && doy <= 300;
  return { local: hhmm(utc + (summer ? 3 : 2)), zulu: hhmm(utc).replace(':', '') };
}

export class PCD {
  constructor({ maxAnisotropy = 8 } = {}) {
    this.maxAnisotropy = maxAnisotropy;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.sys = new Systems();
    this.texture = null;
    this.maps = null;
    this.quality = null;
    this.hz = 6;
    this.rangeNm = 20;
    /** Displayed heading minus the flight model's (map grid) heading, deg: 0 shows the grid
     *  headings; Cockpit.js sets it to the helmet's when the helmet shows magnetic ones. */
    this.variation = 0;
    this.timer = 0;
    this.time = 0;
    this.drawMs = 0;          // last redraw (ms, CPU side)
    this.redraws = 0;
    this.glow = new THREE.Color(0.05, 0.05, 0.05);
    this._mapGlow = new THREE.Color(0.18, 0.16, 0.13);
    this._data = { st: null, sys: this.sys, rangeNm: 20, steer: null, clock: { local: '', zulu: '' }, flash: false, variation: 0, airports: [], wingmen: [], thrustKn: 0 };
    this.onTextureChange = null;   // (texture) => void, when a quality change makes a new texture
    this.setQuality('medium');
  }

  setQuality(q) {
    const Q = PCD_QUALITY[q] || PCD_QUALITY.medium;
    this.hz = Q.hz;
    if (this.quality === q && this.texture) return;
    this.quality = q;
    const w = Q.width, h = Math.round(w * REF_H / REF_W);
    if (this.canvas.width !== w || !this.texture) {
      this.canvas.width = w;
      this.canvas.height = h;
      const old = this.texture;
      const t = new THREE.CanvasTexture(this.canvas);
      t.name = 'PCD_live';
      t.flipY = false;                        // glTF uv: v = 0 is the top of the glass
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = this.maxAnisotropy;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      this.texture = t;
      this.timer = 0;                          // redraw at once
      if (old) old.dispose();
      if (this.onTextureChange) this.onTextureChange(t);
    }
  }

  /**
   * The TSD's map: the terrain's overview (25 m/px over the 102 km core) and far (200 m/px over
   * 410 km) colour, reduced to 2048 / 1024 px copies (the canvas keeps its own GPU copy of what it
   * draws). From the terrain's loaded bitmaps when it has them, else fetched.
   */
  async setMaps(terrain, baseUrl = 'data/terrain/') {
    const get = async (tex, file) => {
      const img = tex && tex.image;
      if (img && img.width > 0 && (typeof ImageBitmap === 'undefined' || img instanceof ImageBitmap || img instanceof HTMLImageElement || img instanceof HTMLCanvasElement)) return img;
      const r = await fetch(baseUrl + file);
      if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
      return createImageBitmap(await r.blob());
    };
    try {
      const T = terrain && terrain.textures;
      const [ov, far] = await Promise.all([get(T && T.overview, 'color/overview.jpg'), get(T && T.far, 'color/far.jpg')]);
      const [core, farS] = await Promise.all([
        createImageBitmap(ov, { resizeWidth: 2048, resizeHeight: 2048, resizeQuality: 'medium' }),
        createImageBitmap(far, { resizeWidth: 1024, resizeHeight: 1024, resizeQuality: 'medium' }),
      ]);
      this.maps = {
        core: { img: core, metres: 102400, x0: -51200, z0: -51200 },
        far: { img: farS, metres: 409600, x0: -204800, z0: -204800 },
      };
      // mean colour of the imagery (for the display's glow on the cockpit)
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(core, 0, 0, 8, 8);
      const px = g.getImageData(0, 0, 8, 8).data;
      const m = [0, 0, 0];
      for (let i = 0; i < px.length; i += 4) for (let k = 0; k < 3; k++) m[k] += px[i + k];
      this._mapGlow.setRGB(m[0] / 64 / 255, m[1] / 64 / 255, m[2] / 64 / 255, THREE.SRGBColorSpace);
      this.timer = 0;
    } catch (e) {
      console.warn('PCD: no map imagery for the TSD:', e.message);
      this.maps = null;
    }
    return this.maps;
  }

  /** Steerpoint: the start point's airfield, else the nearest open one with a long runway. */
  _steer(st, spawn, airports, variation) {
    if (!st || !st.position || !airports || !airports.length) return null;
    const p = st.position;
    let ap = spawn && spawn.airport ? airports.find((a) => a.icao === spawn.airport) : null;
    if (!ap) {
      let best = Infinity;
      for (const a of airports) {
        if (a.closed || !(a.runways || []).some((r) => (r.length_m || 0) > 1500)) continue;
        const d = Math.hypot(a.x - p.x, a.z - p.z);
        if (d < best) { best = d; ap = a; }
      }
    }
    if (!ap) return null;
    const dx = ap.x - p.x, dz = ap.z - p.z;
    const rng = Math.hypot(dx, dz);
    const brg = ((Math.atan2(dx, -dz) / DEG + variation) % 360 + 360) % 360;
    const v = st.velocity;
    const gs = v ? Math.hypot(v.x, v.z) : 0;
    let ttg = '--:--';
    if (gs > 20) {
      const s = Math.round(rng / gs);
      ttg = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }
    return { icao: ap.icao.startsWith('LL') ? ap.icao : ap.name.split(' ')[0].toUpperCase(), x: ap.x, z: ap.z, brg, rngNm: rng / NM, ttg: `TTG ${ttg}` };
  }

  /** TSD range (NM): 5 on the ground, 10 low and slow, 20 in general, 40 high and fast. */
  _autoRange(st) {
    const kt = (st.ias || 0) / KT, ft = (st.agl || 0) / FT;
    const want = st.onGround ? 5 : kt < 250 && ft < 3000 ? 10 : (st.altitude || 0) > 9000 || kt > 520 ? 40 : 20;
    // a new range once it has been wanted for 1.5 s (no flicker at the boundaries); at once after a reset
    if (!this._rangeSet || want === this.rangeNm) { this._rangeSet = true; this._rangeSince = this.time; return want; }
    return this.time - this._rangeSince > 1.5 ? want : this.rangeNm;
  }

  /** A new start point: redraw at once, the range and the engine lags start from the new state. */
  reset() {
    this.timer = 0;
    this._rangeSet = false;
    this.sys.reset();
  }

  /**
   * @param {number} dt s
   * @param {object} src {st, levers, hours, dayOfYear, spawn, airports, wingmen}
   * @param {boolean} visible redraw the canvas (false: only the systems model runs)
   */
  update(dt, src, visible = true) {
    const st = src.st;
    if (!st) return false;
    this.time += dt;
    this.sys.update(dt, st, src.levers || {}, 15 - 0.0065 * Math.max(0, st.altitude || 0));
    this.timer -= dt;
    if (!visible || this.timer > 0) return false;
    this.timer = 1 / this.hz;
    const d = this._data;
    d.st = st;
    d.hours = src.hours;
    d.variation = this.variation;
    this.rangeNm = this._autoRange(st);
    d.rangeNm = this.rangeNm;
    d.airports = src.airports || [];
    d.steer = this._steer(st, src.spawn, d.airports, d.variation);
    d.clock = clockFromSolar(src.hours ?? 12, src.dayOfYear ?? 172);
    d.flash = (this.time * 1.6) % 1 < 0.6;
    d.thrustKn = Math.max(0, (st.engine && st.engine.thrust) || 0) / 1000;
    // the wingmen's symbols (objects kept from redraw to redraw: no garbage)
    const ws = src.wingmen || NO_WINGMEN, out = d.wingmen;
    out.length = ws.length;
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      _f.set(0, 0, -1).applyQuaternion(w.quaternion);
      const o = out[i] || (out[i] = { x: 0, z: 0, hdg: 0, altFt: 0 });
      o.x = w.position.x; o.z = w.position.z; o.hdg = Math.atan2(_f.x, -_f.z); o.altFt = w.position.y / FT;
    }
    const t0 = performance.now();
    const ctx = this.ctx;
    ctx.setTransform(this.canvas.width / REF_W, 0, 0, this.canvas.height / REF_H, 0, 0);
    drawAll(ctx, d, this.maps, LAYOUT);
    this.drawMs = performance.now() - t0;
    this.redraws++;
    if (this.texture) this.texture.needsUpdate = true;
    // glow: the TSD's dimmed map over 43 % of the glass, the symbology over the rest
    const tsd = 0.43 * 0.55;
    this.glow.setRGB(this._mapGlow.r * tsd + 0.03, this._mapGlow.g * tsd + 0.035, this._mapGlow.b * tsd + 0.03);
    if (this.sys.master === 'W' && d.flash) this.glow.r += 0.02;
    return true;
  }

  dispose() {
    this.texture?.dispose();
    this.maps?.core?.img?.close?.();
    this.maps?.far?.img?.close?.();
    this.maps = null;
  }
}
