// HMD: F-35 helmet-mounted display style symbology on a 2D canvas over the 3D view.
//
//   const hmd = new HMD(document.getElementById('hmd'));   // a <canvas>, or an element to put one in
//   hmd.draw(state, camera, viewMode, extra);              // every frame
//   hmd.visible = false;                                   // H key
//
// state is FlightModel.state (sim/DESIGN.md). extra (all optional): {quaternion, position} the pose
// drawn this frame (so the conformal symbols do not jitter against the scene), throttleLever,
// parkingBrake, speedbrake, maxG, mouseStick {x, y} (shown when given), paused, fps.
//
// Cockpit view: green, helmet-fixed boxes (KIAS left, altitude right, heading tape on top) and
// conformal symbols drawn where they are in the world: flight path marker, 5-degree pitch ladder
// (dashed and with negative numbers below the horizon), waterline (the jet's nose). Below the boxes
// Mach, g, max g, AoA (HI AOA in the 50 deg mode), radar altitude below 5,000 ft AGL, vertical
// speed, throttle / afterburner (APC: the auto-throttle flies it), fuel, gear, brakes; warnings (PULL UP with the break-X, AOA LIMIT,
// OVER G, GEAR, HARD LANDING, ...) flash under the heading tape. Other views get a compact info
// strip along the bottom instead. The canvas is sized in device pixels, so the lines stay crisp at
// any resolution and zoom.
//
// Gear down in the air (approach): an AoA bracket beside the flight path marker (marker centred =
// on-speed, 13 deg AoA, about 140 KIAS; marker high in the bracket = fast, low = slow), a dashed
// -3 deg glide-path line on the ladder, and below 100 ft the radar altitude next to the marker for
// the flare.
//
// Heading is magnetic, as on the real display and the runway numbers: the flight model's heading
// is relative to the map grid (north = -Z), so the grid convergence of the transverse Mercator
// projection (js/world/coords.js) and the magnetic variation (WMM2025, about 5 deg E) are applied.
// hmd.last holds the numbers on display, with hdgGrid, hdgTrue, conv and magVar for the tests.
//
// The pitch ladder stops at the glare shield (a body-fixed line), so it does not run over the
// cockpit displays below it; the flight path marker is never hidden.

import * as THREE from 'three';
import { xzToLonLat, ORIGIN } from '../world/coords.js';
import { MOUSE_DEADZONE } from '../input/Input.js';

const KT = 0.514444;
const FT = 0.3048;
const LB = 0.453592;
const DEG = Math.PI / 180;
const GREEN = 'rgba(96, 255, 128, 0.96)';
const GREEN_GLOW = 'rgba(70, 255, 110, 0.22)';
const WARN_NAMES = {
  'PULL UP': 'PULL UP', AOA: 'AOA LIMIT', 'OVER-G': 'OVER G', GEAR: 'GEAR', OVERSPEED: 'OVERSPEED',
  ENGINE: 'ENGINE', 'HARD LANDING': 'HARD LANDING', 'BINGO FUEL': 'BINGO FUEL', 'PARKING BRAKE': 'PARKING BRAKE',
};
const WARN_ORDER = ['PULL UP', 'OVER-G', 'AOA', 'GEAR', 'OVERSPEED', 'ENGINE', 'HARD LANDING', 'BINGO FUEL', 'PARKING BRAKE'];

// Approach symbols (gear down, in the air)
const ON_SPEED_AOA = 13;             // deg: the approach AoA the flight model is tuned for (f35i_config)
const BRACKET_AOA = 1;               // deg each side of on-speed: the ends of the AoA bracket
const GLIDE_REF = -3;                // deg: the dashed glide-path reference line
const FLARE_FT = 100;                // radar altitude next to the flight path marker below this
// The glare shield's top edge, in body angles from the pilot's eye (the cockpit model: ~16 deg
// below the nose line ahead, the PCD under it). The ladder is clipped below this line.
const GLARE_EL = -15.5 * DEG;
const GLARE_AZ = 30 * DEG;

/** Magnetic variation (declination, deg, + = east) at lat / lon (deg): WMM2025 at 2026.8, fitted
 *  over the sim's far area (within 0.04 deg; 4.7 deg E in the south to 5.2 deg E in the north,
 *  changing by about 0.02 deg a year). */
export function magneticVariation(lat, lon) {
  return 4.956 + 0.126 * (lat - ORIGIN.lat) - 0.0126 * (lon - ORIGIN.lon);
}

/** Grid convergence (deg) of the sim's transverse Mercator at lat / lon: true = grid + this. */
export function gridConvergence(lat, lon) {
  return Math.atan(Math.tan((lon - ORIGIN.lon) * DEG) * Math.sin(lat * DEG)) / DEG;
}

const wrap360 = (x) => ((x % 360) + 360) % 360;

const _q = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _p1 = {}, _p2 = {};

const fmtInt = (x) => Math.round(x).toLocaleString('en-US');
/** Heading as three digits; north is 360, as in aviation (never 000). */
const pad3 = (x) => { const v = Math.round(wrap360(x)) % 360; return String(v === 0 ? 360 : v).padStart(3, '0'); };

export class HMD {
  constructor(container) {
    if (container && container.tagName === 'CANVAS') {
      this.canvas = container;
    } else {
      this.canvas = document.createElement('canvas');
      Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
      (container || document.body).appendChild(this.canvas);
    }
    this.ctx = this.canvas.getContext('2d');
    this.visible = true;
    this.time = 0;
    this._last = performance.now();
    this._w = 0; this._h = 0; this._dpr = 1;
    this._clear = false;
    this._geo = { x: NaN, z: NaN, lat: ORIGIN.lat, lon: ORIGIN.lon, conv: 0, magVar: magneticVariation(ORIGIN.lat, ORIGIN.lon) };
  }

  _resize() {
    const c = this.canvas;
    const w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (w !== this._w || h !== this._h || dpr !== this._dpr) {
      this._w = w; this._h = h; this._dpr = dpr;
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  clear() {
    this._resize();
    this.ctx.clearRect(0, 0, this._w, this._h);
  }

  draw(state, camera, viewMode = 'cockpit', extra = {}) {
    const now = performance.now();
    this.time += Math.min(0.25, (now - this._last) / 1000);
    this._last = now;
    this._resize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this._w, this._h);
    if (!state || !camera) return;
    const d = this._data(state, extra);
    this.last = d;                         // the numbers on display (read by the test API)
    if (this.visible) {
      if (viewMode === 'cockpit') this._drawCockpit(d, state, camera, extra);
      else this._drawStrip(d);
    }
    if (extra.mouseStick) this._drawMouseStick(extra.mouseStick);
  }

  // ------------------------------------------------------------------------------ data
  /** Latitude / longitude, grid convergence and magnetic variation at the jet (recomputed every 200 m). */
  _geoAt(pos) {
    const g = this._geo;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.z) && !(Math.abs(pos.x - g.x) < 200 && Math.abs(pos.z - g.z) < 200)) {
      const ll = xzToLonLat(pos.x, pos.z);
      g.x = pos.x; g.z = pos.z; g.lat = ll.lat; g.lon = ll.lon;
      g.conv = gridConvergence(ll.lat, ll.lon);
      g.magVar = magneticVariation(ll.lat, ll.lon);
    }
    return g;
  }

  _data(s, extra) {
    const eng = s.engine || {};
    const V = s.velocity ? s.velocity.length() : (s.tas || 0);
    const iasKt = s.ias_kt != null ? s.ias_kt : (s.ias || 0) / KT;
    const altFt = s.alt_ft != null ? s.alt_ft : (s.altitude || 0) / FT;
    const aglFt = (s.agl || 0) / FT;
    const vsFpm = s.vs_fpm != null ? s.vs_fpm : (s.vs || 0) / FT * 60;
    const thr = extra.throttleLever != null ? extra.throttleLever : (eng.throttle != null ? eng.throttle : (s.controls && s.controls.throttle) || 0);
    let warnings = Array.isArray(s.warnings) ? s.warnings.slice() : null;
    if (!warnings) {
      // flight model without warnings (dev stubs): derive the basic ones
      warnings = [];
      const gearDown = (s.gear || 0) > 0.99;
      if (!s.onGround) {
        if (!gearDown && aglFt < 800 && iasKt < 190 && (s.vs || 0) < -1.5) warnings.push('GEAR');
        if ((s.vs || 0) < -5 && (s.agl || 0) / Math.max(1, -(s.vs || 0)) < 6) warnings.push('PULL UP');
        if ((s.alpha || 0) > 27 * DEG) warnings.push('AOA');
      }
      if ((s.gLoad || 1) > 9.3 || (s.gLoad || 1) < -3.3) warnings.push('OVER-G');
    }
    warnings.sort((a, b) => WARN_ORDER.indexOf(a) - WARN_ORDER.indexOf(b));
    // heading: grid (flight model) -> true -> magnetic
    const geo = this._geoAt(extra.position || s.position);
    const hdgGrid = wrap360((s.heading || 0) / DEG);
    const hdgTrue = wrap360(hdgGrid + geo.conv);
    return {
      V, iasKt, altFt, aglFt, vsFpm,
      mach: s.mach || 0,
      g: s.gLoad != null ? s.gLoad : 1,
      maxG: extra.maxG != null ? extra.maxG : null,
      alphaDeg: (s.alpha || 0) / DEG,
      hdg: wrap360(hdgTrue - geo.magVar),  // magnetic: what the display shows
      hdgTrue, hdgGrid, conv: geo.conv, magVar: geo.magVar,
      thr,
      ab: eng.ab || 0,
      rpm: eng.rpm != null ? eng.rpm : null,
      fuelLb: eng.fuelKg != null ? eng.fuelKg / LB : null,
      gear: s.gear != null ? s.gear : 1,
      onGround: !!s.onGround,
      highAoA: !!s.highAoA,
      apc: !!s.apc,                        // the auto-throttle is flying the throttle
      warnings,
      parkingBrake: !!extra.parkingBrake,
      brakes: !!extra.brakes,
      speedbrake: (s.controls && s.controls.speedbrake > 0.05) || !!extra.speedbrake,
      crashed: !!s.crashed,
      gs: s.groundSpeed != null ? s.groundSpeed : V,
      approach: false,                     // set when the approach symbols are drawn
    };
  }

  // ------------------------------------------------------------------------------ drawing helpers
  _stroke(path, width) {
    const c = this.ctx;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = GREEN_GLOW;
    c.lineWidth = width * 3.2;
    path();
    c.stroke();
    c.strokeStyle = GREEN;
    c.lineWidth = width;
    path();
    c.stroke();
  }

  _text(str, x, y, size, align = 'left', weight = 600) {
    const c = this.ctx;
    c.font = `${weight} ${size}px "Segoe UI", "DejaVu Sans", Arial, sans-serif`;
    c.textAlign = align;
    c.textBaseline = 'middle';
    c.lineWidth = Math.max(2, size * 0.22);
    c.strokeStyle = 'rgba(0, 30, 10, 0.45)';
    c.strokeText(str, x, y);
    c.fillStyle = GREEN;
    c.fillText(str, x, y);
  }

  /** World direction -> screen px (null if behind the camera). */
  _project(dir, camera, out) {
    _q.copy(camera.quaternion).invert();
    _v.copy(dir).applyQuaternion(_q);
    if (_v.z > -1e-4) return null;
    const f = (this._h / 2) / Math.tan((camera.fov * DEG) / 2) * (camera.zoom || 1);
    out.x = this._w / 2 + (_v.x / -_v.z) * f;
    out.y = this._h / 2 - (_v.y / -_v.z) * f;
    out.z = -_v.z;
    return out;
  }

  /** Body direction (three.js body axes: x right, y up, -z forward) -> screen px, or null. */
  _projectBody(x, y, z, quat, camera, out) {
    _dir.set(x, y, z).applyQuaternion(quat);
    return this._project(_dir, camera, out);
  }

  // ------------------------------------------------------------------------------ cockpit HMD
  _drawCockpit(d, s, camera, extra) {
    const c = this.ctx;
    const W = this._w, H = this._h;
    const u = H / 1000;                    // symbol unit: 1/1000 of the screen height
    const cx = W / 2, cy = H / 2;
    const lw = Math.max(1.2, 1.7 * u);
    const fs = Math.round(Math.max(12, 21 * u));
    const fsS = Math.round(Math.max(11, 17 * u));
    const quat = extra.quaternion || s.quaternion;
    const flash = (this.time * 2.5) % 1 < 0.6;

    // ---- conformal: waterline, flight path marker, pitch ladder, approach symbols
    if (quat) {
      _fwd.set(0, 0, -1).applyQuaternion(quat);
      const wl = this._project(_fwd, camera, {});
      if (wl) this._drawWaterline(wl.x, wl.y, u, lw);
      // flight path: the velocity direction (nose direction when slow)
      const hasFpm = d.V > 20 && s.velocity;
      _dir.copy(hasFpm ? s.velocity : _fwd).normalize();
      const fpm = this._project(_dir, camera, {});
      const trackAz = Math.atan2(_dir.x, -_dir.z);
      const fpaDeg = Math.asin(Math.max(-1, Math.min(1, _dir.y))) / DEG;
      const approach = d.gear > 0.99 && !d.onGround && hasFpm;
      this._drawLadder(camera, trackAz, fpaDeg, u, lw, fs * 0.8, quat, approach);
      if (fpm && hasFpm) {
        this._drawFpm(fpm.x, fpm.y, u, lw);
        if (approach) {
          d.approach = true;
          this._drawAoaBracket(quat, s.velocity, camera, u, lw);
          if (d.aglFt < FLARE_FT) this._text(String(Math.max(0, Math.round(d.aglFt))), fpm.x + 44 * u, fpm.y, fsS, 'left', 600);
        }
      }
    }

    // ---- heading tape (helmet fixed, top)
    this._drawHeadingTape(cx, cy - 395 * u, d.hdg, u, lw, fsS);

    // ---- airspeed box (left) and altitude box (right)
    const bx = cx - 420 * u, ax = cx + 420 * u, by = cy - 40 * u;
    this._box(bx, by, 118 * u, 46 * u, lw);
    this._text(fmtInt(d.iasKt), bx + 50 * u, by, fs + 3, 'right');
    this._box(ax, by, 150 * u, 46 * u, lw);
    this._text(fmtInt(d.altFt), ax + 66 * u, by, fs + 3, 'right');

    // left column: Mach, g (max g), AoA (HI AOA mode), throttle, fuel
    const lx = bx - 56 * u;
    let ly = by + 52 * u;
    const step = 31 * u;
    this._text(`M ${d.mach.toFixed(2)}`, lx, ly, fsS); ly += step;
    this._text(`G ${d.g.toFixed(1)}`, lx, ly, fsS);
    if (d.maxG != null) this._text(d.maxG.toFixed(1), lx + 96 * u, ly, fsS * 0.9, 'left', 500);
    ly += step;
    this._text(`α ${d.alphaDeg.toFixed(1)}`, lx, ly, fsS);
    if (d.highAoA) this._text('HI AOA', lx + 96 * u, ly, fsS * 0.9, 'left', 700);
    ly += step * 1.5;
    const thrPct = Math.round(Math.min(d.thr, 0.75) / 0.75 * 100);
    const abTxt = d.thr > 0.751 ? ` AB ${Math.round((d.thr - 0.75) / 0.25 * 100)}%` : (Math.abs(d.thr - 0.75) < 0.002 ? ' MIL' : '');
    this._text(`THR ${thrPct}%${abTxt}${d.apc ? '  APC' : ''}`, lx, ly, fsS);
    ly += step;
    if (d.fuelLb != null) { this._text(`FUEL ${fmtInt(Math.round(d.fuelLb / 10) * 10)}`, lx, ly, fsS); ly += step; }

    // right column: radar altitude, vertical speed, gear, brakes
    const rx = ax - 72 * u;
    let ry = by + 52 * u;
    if (d.aglFt < 5000) {
      const ra = Math.max(0, d.aglFt);
      this._text(`R ${fmtInt(ra > 1000 ? Math.round(ra / 10) * 10 : ra)}`, rx, ry, fsS);
    }
    ry += step;
    const vs = Math.round(d.vsFpm / 10) * 10;
    this._text(`VS ${vs > 0 ? '+' : ''}${fmtInt(vs)}`, rx, ry, fsS); ry += step * 1.5;
    if (d.gear > 0.99) this._text('GEAR DN', rx, ry, fsS);
    else if (d.gear > 0.01) this._text(flash ? 'GEAR ↕' : 'GEAR', rx, ry, fsS);
    ry += step;
    if (d.parkingBrake) { this._text('PARK BRK', rx, ry, fsS); ry += step; }
    else if (d.brakes && d.onGround) { this._text('BRAKES', rx, ry, fsS); ry += step; }
    if (d.speedbrake) { this._text('SPD BRK', rx, ry, fsS); ry += step; }

    // ---- warnings: under the heading tape, clear of the flight path marker on the approach and
    // of the cockpit displays below the glare shield (they used to flash over the PCD)
    this._drawWarnings(d, cx, cy - 290 * u, u, lw, fs, flash);
  }

  _box(x, y, w, h, lw) {
    const c = this.ctx;
    this._stroke(() => { c.beginPath(); c.rect(x - w / 2, y - h / 2, w, h); }, lw);
  }

  _drawWaterline(x, y, u, lw) {
    const c = this.ctx;
    const s = 14 * u;
    this._stroke(() => {
      c.beginPath();
      c.moveTo(x - 3.2 * s, y); c.lineTo(x - 1.6 * s, y);
      c.lineTo(x - 0.8 * s, y + 1.1 * s); c.lineTo(x, y); c.lineTo(x + 0.8 * s, y + 1.1 * s);
      c.lineTo(x + 1.6 * s, y); c.lineTo(x + 3.2 * s, y);
    }, lw);
  }

  _drawFpm(x, y, u, lw) {
    const c = this.ctx;
    const r = 11 * u;
    this._stroke(() => {
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.moveTo(x - r, y); c.lineTo(x - r * 2.6, y);
      c.moveTo(x + r, y); c.lineTo(x + r * 2.6, y);
      c.moveTo(x, y - r); c.lineTo(x, y - r * 2.0);
    }, lw);
  }

  /**
   * Gear down: the AoA bracket left of the flight path marker. It stands at the marker's sideslip,
   * from 12 deg AoA (top end: fast) through 13 (the middle tick: on-speed) to 14 (bottom: slow), in
   * body axes, so the marker sits in its middle when the AoA is on-speed, whatever the bank.
   */
  _drawAoaBracket(quat, vel, camera, u, lw) {
    _qb.copy(quat).invert();
    _v.copy(vel).normalize().applyQuaternion(_qb);          // body: x right, y up, -z forward
    const sb = Math.max(-1, Math.min(1, _v.x)), cb = Math.sqrt(1 - sb * sb);
    const pts = [];
    for (const a of [ON_SPEED_AOA - BRACKET_AOA, ON_SPEED_AOA, ON_SPEED_AOA + BRACKET_AOA]) {
      const p = this._projectBody(sb, -Math.sin(a * DEG) * cb, -Math.cos(a * DEG) * cb, quat, camera, {});
      if (!p) return;
      pts.push(p);
    }
    let ex = pts[2].x - pts[0].x, ey = pts[2].y - pts[0].y;   // down the bracket (fast -> slow)
    const L = Math.hypot(ex, ey);
    if (L < 1e-3) return;
    ex /= L; ey /= L;
    const lx = -ey, ly = ex;               // the jet's left on the screen
    const off = 42 * u, tick = 9 * u;
    const c = this.ctx;
    const at = (p, k) => [p.x + lx * off - lx * k, p.y + ly * off - ly * k];
    this._stroke(() => {
      c.beginPath();
      const [x0, y0] = at(pts[0], 0), [x2, y2] = at(pts[2], 0), [x1, y1] = at(pts[1], 0);
      const [t0x, t0y] = at(pts[0], tick), [t2x, t2y] = at(pts[2], tick), [t1x, t1y] = at(pts[1], tick * 1.5);
      c.moveTo(t0x, t0y); c.lineTo(x0, y0); c.lineTo(x2, y2); c.lineTo(t2x, t2y);
      c.moveTo(x1, y1); c.lineTo(t1x, t1y);
    }, lw);
  }

  /** Screen centre a and unit direction {dx, dy} of a pitch-ladder rung at p deg on azimuth az. */
  _rung(camera, az, p, a) {
    const el = p * DEG;
    const ce = Math.cos(el);
    // rung centre on the flight path azimuth, and a point 1 deg to the right for the rung direction
    _dir.set(Math.sin(az) * ce, Math.sin(el), -Math.cos(az) * ce);
    if (!this._project(_dir, camera, a)) return null;
    const az2 = az + 1 * DEG;
    _dir.set(Math.sin(az2) * ce, Math.sin(el), -Math.cos(az2) * ce);
    const ok = this._project(_dir, camera, _p2);
    let dx = 1, dy = 0;
    if (ok && Math.abs(p) < 89) { dx = _p2.x - a.x; dy = _p2.y - a.y; }
    const L = Math.hypot(dx, dy) || 1;
    return { dx: dx / L, dy: dy / L };
  }

  /** Clip to the part of the view above the glare shield (a body-fixed line); false if it is not in view. */
  _clipGlareShield(quat, camera) {
    // two points of the (straight, level) edge, GLARE_EL below the nose line straight ahead
    const ty0 = Math.tan(GLARE_EL), tx0 = Math.tan(GLARE_AZ);
    const a = this._projectBody(-tx0, ty0, -1, quat, camera, _p1);
    if (!a) return false;
    const ax = a.x, ay = a.y;
    const b = this._projectBody(tx0, ty0, -1, quat, camera, _p1);
    if (!b) return false;
    let tx = b.x - ax, ty = b.y - ay;
    const L = Math.hypot(tx, ty);
    if (L < 1) return false;
    tx /= L; ty /= L;
    // the kept side holds the nose (the waterline)
    const nose = this._projectBody(0, 0, -1, quat, camera, _p1);
    let nx = -ty, ny = tx;
    if (nose && (nose.x - ax) * nx + (nose.y - ay) * ny < 0) { nx = -nx; ny = -ny; }
    const B = 4 * (this._w + this._h);
    const c = this.ctx;
    c.beginPath();
    c.moveTo(ax - tx * B, ay - ty * B);
    c.lineTo(ax + tx * B, ay + ty * B);
    c.lineTo(ax + tx * B + nx * B, ay + ty * B + ny * B);
    c.lineTo(ax - tx * B + nx * B, ay - ty * B + ny * B);
    c.closePath();
    c.clip();
    return true;
  }

  _drawLadder(camera, az, fpaDeg, u, lw, fs, quat, approach) {
    const c = this.ctx;
    const W = this._w, H = this._h;
    const cx = W / 2, cy = H / 2;
    const clipR = 330 * u;
    c.save();
    // keep the ladder in the middle (clear of the boxes and the heading tape) and above the
    // glare shield (the rungs used to run over the cockpit displays)
    c.beginPath();
    c.rect(cx - 330 * u, cy - 330 * u, 660 * u, 600 * u);
    c.clip();
    if (quat) this._clipGlareShield(quat, camera);
    const a = {};
    const lo = Math.ceil((fpaDeg - 40) / 5) * 5, hi = Math.floor((fpaDeg + 40) / 5) * 5;
    for (let p = Math.max(-90, lo); p <= Math.min(90, hi); p += 5) {
      const r = this._rung(camera, az, p, a);
      if (!r) continue;
      if (Math.hypot(a.x - cx, a.y - cy) > clipR * 1.6) continue;
      const { dx, dy } = r;
      // tick direction: towards the horizon (down the screen for rungs above it when level)
      let nx = -dy, ny = dx;
      if (p < 0) { nx = -nx; ny = -ny; }
      const half = p === 0 ? 300 * u : 95 * u, gap = p === 0 ? 34 * u : 30 * u;
      const tick = 12 * u;
      const dashed = p < 0;
      this._stroke(() => {
        c.beginPath();
        for (const sgn of [-1, 1]) {
          const x0 = a.x + dx * gap * sgn, y0 = a.y + dy * gap * sgn;
          const x1 = a.x + dx * half * sgn, y1 = a.y + dy * half * sgn;
          if (dashed) {
            const n = 4;
            for (let i = 0; i < n; i++) {
              const t0 = i / n, t1 = (i + 0.55) / n;
              c.moveTo(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0);
              c.lineTo(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1);
            }
          } else {
            c.moveTo(x0, y0); c.lineTo(x1, y1);
          }
          if (p !== 0) { c.moveTo(x1, y1); c.lineTo(x1 + nx * tick, y1 + ny * tick); }
        }
      }, lw * 0.9);
      if (p !== 0) {
        // dive rungs carry a minus sign (they used to read like the climb rungs)
        const label = String(p);
        for (const sgn of [-1, 1]) {
          const tx = a.x + dx * (half + 22 * u) * sgn, ty = a.y + dy * (half + 22 * u) * sgn;
          this._text(label, tx, ty, fs, 'center', 500);
        }
      }
    }
    // approach: the -3 deg glide-path reference, short dashes without numbers
    if (approach) {
      const r = this._rung(camera, az, GLIDE_REF, a);
      if (r) {
        const { dx, dy } = r;
        this._stroke(() => {
          c.beginPath();
          for (const sgn of [-1, 1]) {
            for (let i = 0; i < 6; i++) {
              const t0 = 36 + i * 20, t1 = t0 + 9;
              c.moveTo(a.x + dx * t0 * u * sgn, a.y + dy * t0 * u * sgn);
              c.lineTo(a.x + dx * t1 * u * sgn, a.y + dy * t1 * u * sgn);
            }
          }
        }, lw * 0.9);
      }
    }
    c.restore();
  }

  _drawHeadingTape(cx, y, hdg, u, lw, fs) {
    const c = this.ctx;
    const span = 30;                    // degrees shown each side
    const pxPerDeg = 9 * u;
    this._stroke(() => {
      c.beginPath();
      const start = Math.ceil((hdg - span) / 5) * 5;
      for (let h = start; h <= hdg + span; h += 5) {
        const x = cx + (h - hdg) * pxPerDeg;
        const major = ((h % 10) + 10) % 10 === 0;
        c.moveTo(x, y); c.lineTo(x, y - (major ? 14 : 8) * u);
      }
      // caret under the current heading
      c.moveTo(cx - 8 * u, y + 13 * u); c.lineTo(cx, y + 4 * u); c.lineTo(cx + 8 * u, y + 13 * u);
    }, lw);
    const start = Math.ceil((hdg - span) / 10) * 10;
    for (let h = start; h <= hdg + span; h += 10) {
      const x = cx + (h - hdg) * pxPerDeg;
      if (Math.abs(x - cx) < 34 * u) continue;     // the box shows it
      const v = wrap360(h);
      this._text(v === 0 ? '36' : String(v / 10).padStart(2, '0'), x, y - 30 * u, fs * 0.85, 'center', 500);
    }
    this._box(cx, y - 32 * u, 64 * u, 30 * u, lw);
    this._text(pad3(hdg), cx, y - 32 * u, fs, 'center');
  }

  _drawWarnings(d, cx, y, u, lw, fs, flash) {
    if (!d.warnings.length || d.crashed) return;
    const c = this.ctx;
    const main = d.warnings[0];
    if (main === 'PULL UP' && flash) {
      // break-X across the middle
      const s = 120 * u;
      const ycx = this._h / 2;
      this._stroke(() => {
        c.beginPath();
        c.moveTo(cx - s, ycx - s); c.lineTo(cx + s, ycx + s);
        c.moveTo(cx + s, ycx - s); c.lineTo(cx - s, ycx + s);
      }, lw * 2);
    }
    let yy = y;
    for (const w of d.warnings.slice(0, 3)) {
      const txt = WARN_NAMES[w] || w;
      const big = w === main;
      if (big && !flash) { yy += 52 * u; continue; }
      const size = big ? fs * 1.6 : fs;
      this._text(txt, cx, yy, size, 'center', 700);
      if (big) {
        const tw = this.ctx.measureText(txt).width;
        this._box(cx, yy, tw + 36 * u, size * 1.45, lw);
      }
      yy += (big ? 52 : 34) * u;
    }
  }

  // ------------------------------------------------------------------------------ external views
  _drawStrip(d) {
    const c = this.ctx;
    const W = this._w, H = this._h;
    const u = Math.max(0.8, Math.min(1.4, H / 900));
    const fs = Math.round(15 * u);
    const thrPct = Math.round(Math.min(d.thr, 0.75) / 0.75 * 100);
    const ab = d.thr > 0.751 ? ' AB' : (Math.abs(d.thr - 0.75) < 0.002 ? ' MIL' : '');
    const items = [
      `${fmtInt(d.iasKt)} KIAS`,
      `M ${d.mach.toFixed(2)}`,
      `${fmtInt(d.altFt)} FT`,
      d.aglFt < 5000 ? `R ${fmtInt(Math.max(0, d.aglFt))}` : null,
      `HDG ${pad3(d.hdg)}`,
      `VS ${d.vsFpm > 0 ? '+' : ''}${fmtInt(Math.round(d.vsFpm / 10) * 10)}`,
      `G ${d.g.toFixed(1)}`,
      `α ${d.alphaDeg.toFixed(1)}${d.highAoA ? ' HI' : ''}`,
      `THR ${thrPct}%${ab}${d.apc ? ' APC' : ''}`,
      d.gear > 0.99 ? 'GEAR DN' : d.gear > 0.01 ? 'GEAR ↕' : 'GEAR UP',
      d.parkingBrake ? 'PARK BRK' : null,
      d.speedbrake ? 'SPD BRK' : null,
      d.fuelLb != null ? `FUEL ${fmtInt(Math.round(d.fuelLb / 10) * 10)} LB` : null,
    ].filter(Boolean);
    c.font = `600 ${fs}px "Segoe UI", "DejaVu Sans", Arial, sans-serif`;
    const gap = 20 * u;
    const widths = items.map((t) => c.measureText(t).width);
    const total = widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1);
    const h = fs * 2;
    const y = H - h / 2 - 16 * u;
    const x0 = W / 2 - total / 2;
    c.fillStyle = 'rgba(6, 12, 9, 0.55)';
    const r = 6 * u;
    const bx = x0 - 16 * u, bw = total + 32 * u, byy = y - h / 2;
    c.beginPath();
    if (c.roundRect) c.roundRect(bx, byy, bw, h, r); else c.rect(bx, byy, bw, h);
    c.fill();
    let x = x0;
    for (let i = 0; i < items.length; i++) {
      this._text(items[i], x, y, fs, 'left', 600);
      x += widths[i] + gap;
    }
    // warnings above the strip
    if (d.warnings.length && !d.crashed) {
      const flash = (this.time * 2.5) % 1 < 0.6;
      if (flash) this._text(d.warnings.slice(0, 2).map((w) => WARN_NAMES[w] || w).join('   '), W / 2, y - h * 1.3, fs * 1.5, 'center', 700);
    }
  }

  /** Mouse stick position, bottom left (it used to sit on the cockpit displays): the ring is a full
   *  throw, the inner ring the deadzone where the stick reads centred. */
  _drawMouseStick(p) {
    const c = this.ctx;
    const H = this._h;
    const u = H / 1000;
    const R = 48 * u;
    const x = 60 * u + R, y = H - 90 * u - R;
    c.save();
    c.globalAlpha = 0.75;
    this._stroke(() => {
      c.beginPath();
      c.arc(x, y, R, 0, Math.PI * 2);
      c.moveTo(x + R * MOUSE_DEADZONE, y);
      c.arc(x, y, R * MOUSE_DEADZONE, 0, Math.PI * 2);
      c.moveTo(x - R, y); c.lineTo(x - R * 0.8, y); c.moveTo(x + R * 0.8, y); c.lineTo(x + R, y);
      c.moveTo(x, y - R); c.lineTo(x, y - R * 0.8); c.moveTo(x, y + R * 0.8); c.lineTo(x, y + R);
    }, 1.2);
    c.fillStyle = GREEN;
    c.beginPath();
    c.arc(x + p.x * R, y + p.y * R, 5 * u, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }
}
