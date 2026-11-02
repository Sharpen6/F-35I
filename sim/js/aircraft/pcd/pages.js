// The pages of the panoramic cockpit display (PCD), drawn with the 2D canvas API in a fixed
// reference frame of 1600 x 640 px (80 px per inch of the 20 x 8 inch glass; PCD.js scales it).
//
// Layout (public F-35 descriptions: a status bar of format access buttons across the top, four
// 5-inch portals below it, each a main window with sub-portals underneath; black backgrounds;
// white = selected / on, red = warning or threat, yellow = caution or unknown, green = advisory or
// friendly, magenta = off-board navigation, grey = info boxes, light purple = fuel):
//
//   +--------------------------------------------------------------------------------------+
//   | ENG | FUEL | FCS | ICAWS |  CAS   ALT   MACH   HDG  |  STPT  |  TIME               |  status bar
//   +-------------------------------------------+------------------+-----------------------+
//   | TSD-1  (portals 1 and 2: the moving map)  | FUEL             | ENG                   |
//   |                                           |                  |                       |
//   |                                           +------------------+-----------------------+
//   |                                           | ICAWS            | EFI                   |
//   +-------------------------------------------+------------------+-----------------------+
//
// Text is larger than on the real glass so that the numbers read from the eye point at 1080p
// (the 50 cm display spans about 650 px there).

import { TANKS, FUEL_MAX_LB } from './systems.js';

export const REF_W = 1600;
export const REF_H = 640;
const PX_IN = 80;                     // reference px per inch

export const C = {
  bg: '#000000',
  frame: '#46505a',
  tab: '#20272e',
  tabText: '#e9eef2',
  white: '#f1f4f6',
  dim: '#8d98a3',
  grey: '#5c6670',
  green: '#4cf06e',
  cyan: '#3fd6ff',
  yellow: '#ffd43a',
  red: '#ff4436',
  magenta: '#ff5ad9',
  purple: '#b58cff',
  purpleDark: '#4b3274',
  sky: '#1f5fb8',
  ground: '#7a4f25',
};
const SANS = '"Segoe UI", "DejaVu Sans", "Liberation Sans", Arial, sans-serif';
export const font = (px, weight = 600) => `${weight} ${px}px ${SANS}`;

const DEG = Math.PI / 180;
const NM = 1852;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const fmt = (x) => Math.round(x).toLocaleString('en-US');
const pad3 = (x) => String(((Math.round(x) % 360) + 360) % 360 || 360).padStart(3, '0');

// ------------------------------------------------------------------------------ helpers
export function rect(r, x, y, w, h) { r.x = x; r.y = y; r.w = w; r.h = h; return r; }

function text(ctx, s, x, y, px, colour, align = 'left', weight = 600, base = 'alphabetic') {
  ctx.font = font(px, weight);
  ctx.fillStyle = colour;
  ctx.textAlign = align;
  ctx.textBaseline = base;
  ctx.fillText(s, x, y);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Text with a dark outline (labels over the map imagery). */
function textOutlined(ctx, s, x, y, px, colour, align = 'left', weight = 700, base = 'alphabetic') {
  ctx.font = font(px, weight);
  ctx.textAlign = align;
  ctx.textBaseline = base;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.strokeText(s, x, y);
  ctx.fillStyle = colour;
  ctx.fillText(s, x, y);
}

/** A portal: grey frame and the title tab in its upper-left corner (page name, master mode). */
function portal(ctx, r, title, mode = null) {
  ctx.strokeStyle = C.frame;
  ctx.lineWidth = 2;
  ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
  ctx.font = font(21, 700);
  const tw = ctx.measureText(title).width + 20;
  ctx.fillStyle = C.tab;
  ctx.fillRect(r.x + 2, r.y + 2, tw, 30);
  ctx.strokeStyle = C.frame;
  ctx.strokeRect(r.x + 2, r.y + 2, tw, 30);
  text(ctx, title, r.x + 12, r.y + 25, 21, C.tabText, 'left', 700);
  if (mode) {
    ctx.font = font(19, 600);
    const mw = ctx.measureText(mode).width + 16;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(r.x + tw + 4, r.y + 4, mw, 26);
    text(ctx, mode, r.x + tw + 12, r.y + 25, 19, C.dim, 'left', 600);
  }
}

/** A status-bar button (FAB): grey rounded frame and a small label. */
function fab(ctx, x, w, label) {
  ctx.strokeStyle = C.frame;
  ctx.lineWidth = 2;
  roundRect(ctx, x + 2, 4, w - 4, 68, 6);
  ctx.stroke();
  text(ctx, label, x + 12, 25, 16, C.dim, 'left', 700);
}

// ------------------------------------------------------------------------------ status bar
export function drawStatusBar(ctx, d) {
  const { sys, flash } = d;
  const F = sys.flight, en = sys.eng, fu = sys.fuel;
  ctx.fillStyle = '#05080b';
  ctx.fillRect(0, 0, REF_W, 76);
  // ENG: N2 and the throttle stage; the button framed in yellow with the afterburner lit
  let x = 0;
  fab(ctx, x, 196, 'ENG');
  if (en.stage === 'AB') {
    ctx.strokeStyle = C.yellow;
    ctx.lineWidth = 4;
    roundRect(ctx, x + 5, 7, 186, 62, 6);
    ctx.stroke();
  }
  text(ctx, `${Math.round(en.n2)}`, x + 104, 62, 34, en.running ? C.white : C.red, 'right', 700);
  text(ctx, '%', x + 106, 62, 18, C.dim, 'left');
  text(ctx, en.stage === 'AB' ? `AB${Math.max(1, Math.ceil(en.ab * 5))}` : en.stage, x + 184, 62, 22,
    en.stage === 'AB' ? C.yellow : C.green, 'right', 700);
  // FUEL: total, a light purple gauge with joker and bingo marks
  x = 196;
  fab(ctx, x, 220, 'FUEL');
  const low = fu.totalLb < fu.bingo;
  text(ctx, fmt(fu.totalLb), x + 210, 34, 30, low ? C.yellow : C.white, 'right', 700);
  const gx = x + 14, gy = 46, gw = 192, gh = 16;
  ctx.fillStyle = C.purpleDark;
  ctx.fillRect(gx, gy, gw, gh);
  ctx.fillStyle = C.purple;
  ctx.fillRect(gx, gy, gw * clamp(fu.totalLb / FUEL_MAX_LB, 0, 1), gh);
  ctx.fillStyle = C.white;
  for (const v of [fu.bingo, fu.joker]) ctx.fillRect(gx + gw * v / FUEL_MAX_LB - 1, gy - 4, 3, gh + 8);
  // FCS: gear lights (nose above, mains below), flaps
  x = 416;
  fab(ctx, x, 150, 'GEAR');
  const g = sys.gearPos;
  const gearCol = g >= 0.99 ? C.green : g <= 0.01 ? null : (flash ? C.red : '#5a1610');
  const sq = (cx, cy) => {
    ctx.lineWidth = 2;
    ctx.strokeStyle = gearCol || C.grey;
    ctx.strokeRect(cx - 8, cy - 8, 16, 16);
    if (gearCol) { ctx.fillStyle = gearCol; ctx.fillRect(cx - 5.5, cy - 5.5, 11, 11); }
  };
  sq(x + 44, 40); sq(x + 25, 60); sq(x + 63, 60);
  text(ctx, g <= 0.01 ? 'UP' : g >= 0.99 ? 'DN' : 'TRN', x + 140, 46, 20, g <= 0.01 ? C.white : g >= 0.99 ? C.green : C.red, 'right', 700);
  text(ctx, `FLP ${Math.round(sys.flaps * 100)}`, x + 140, 66, 15, C.dim, 'right');
  // ICAWS: master warning / caution, counts
  x = 566;
  fab(ctx, x, 196, 'ICAWS');
  const n = sys.icaws.length;
  if (sys.master) {
    const col = sys.master === 'W' ? C.red : C.yellow;
    const on = sys.master === 'C' || flash;
    ctx.fillStyle = on ? col : '#1a1a1a';
    roundRect(ctx, x + 12, 30, 120, 36, 4);
    ctx.fill();
    text(ctx, sys.master === 'W' ? 'WARNING' : 'CAUTION', x + 72, 56, 19, on ? '#000' : col, 'center', 800);
  } else {
    text(ctx, n ? 'ADVISORY' : 'NO ALERT', x + 14, 58, 19, n ? C.green : C.grey, 'left', 700);
  }
  if (n) {
    text(ctx, String(n), x + 168, 58, 22, sys.master === 'W' ? C.red : sys.master === 'C' ? C.yellow : C.green, 'right', 700);
    text(ctx, 'MSG', x + 186, 30, 12, C.dim, 'right', 700);
  }
  // flight data: CAS, ALT, MACH, HDG
  x = 762;
  ctx.strokeStyle = C.frame;
  roundRect(ctx, x + 2, 4, 472, 68, 6);
  ctx.stroke();
  const cell = (cx, label, value, w) => {
    text(ctx, label, cx + 10, 25, 16, C.dim, 'left', 700);
    text(ctx, value, cx + w - 8, 64, 34, C.white, 'right', 700);
  };
  cell(x + 2, 'CAS', fmt(F.cas), 112);
  cell(x + 112, 'ALT', fmt(F.alt), 150);
  cell(x + 262, 'MACH', F.mach.toFixed(2), 100);
  cell(x + 362, 'HDG', pad3(F.hdg + (d.variation || 0)), 110);
  // steerpoint
  x = 1236;
  fab(ctx, x, 204, 'STPT');
  const sp = d.steer;
  if (sp) {
    text(ctx, sp.icao, x + 70, 25, 17, C.magenta, 'left', 700);
    text(ctx, `${pad3(sp.brg)}°`, x + 14, 62, 26, C.white, 'left', 700);
    text(ctx, `${sp.rngNm < 10 ? sp.rngNm.toFixed(1) : Math.round(sp.rngNm)}`, x + 180, 62, 26, C.white, 'right', 700);
    text(ctx, 'NM', x + 182, 62, 14, C.dim, 'left');
  }
  // local time (Israel summer time) and zulu
  x = 1440;
  fab(ctx, x, 160, 'TIME');
  text(ctx, d.clock.local, x + 148, 46, 28, C.white, 'right', 700);
  text(ctx, `${d.clock.zulu}Z`, x + 148, 66, 15, C.dim, 'right');
}

// ------------------------------------------------------------------------------ TSD
const _p = { x: 0, y: 0 };

/** World (x, z) -> TSD screen, heading up around the own-ship. */
function toScreen(m, x, z, out = _p) {
  const dx = x - m.ox, dz = z - m.oz;
  const f = dx * m.sh - dz * m.ch;          // ahead
  const r = dx * m.ch + dz * m.sh;          // right
  out.x = m.sx + r * m.ppm;
  out.y = m.sy - f * m.ppm;
  return out;
}

export function drawTSD(ctx, r, d, maps) {
  const { st, sys, rangeNm } = d;
  const hdg = (st.heading || 0);
  const ox = st.position ? st.position.x : 0, oz = st.position ? st.position.z : 0;
  const sx = r.x + r.w / 2, sy = r.y + r.h * 0.68;
  const R = rangeNm * NM;
  const ppm = (sy - r.y - 6) / R;            // the range is the distance to the top edge
  const m = { ox, oz, sh: Math.sin(hdg), ch: Math.cos(hdg), sx, sy, ppm };
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.fillStyle = '#020507';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  // ---- map imagery (dimmed satellite colour; the far image beyond the 102 km core)
  if (maps) {
    // dimmed to about half, so the white and coloured symbols stand out (an F-35 TSD's imagery
    // underlay is a background, not a picture)
    ctx.globalAlpha = 0.56;
    const S = ctx.canvas.width / REF_W;      // canvas pixels per reference pixel
    for (const mp of [maps.far, maps.core]) {
      if (!mp) continue;
      // the finest mip level minified at most ~1.4:1 on the canvas (PCD.setMaps): smoothing then
      // filters every texel, and the map does not sparkle as it turns and moves
      const L = mp.levels;
      let img = mp.img;
      if (L) {
        let i = 0;
        while (i + 1 < L.length && (mp.metres / L[i].width) * ppm * S < 1 / 1.4) i++;
        img = L[i];
      }
      const k = mp.metres / img.width;       // m per pixel of the source
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(-hdg);
      ctx.scale(ppm * k, ppm * k);
      ctx.translate(-(ox - mp.x0) / k, -(oz - mp.z0) / k);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(0, 10, 26, 0.16)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  // ---- range rings (half and full range) and the compass rose on the outer ring
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(190, 200, 210, 0.55)';
  ctx.setLineDash([10, 9]);
  for (const k of [0.5, 1]) {
    ctx.beginPath();
    ctx.arc(sx, sy, R * k * ppm, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  const rr = R * ppm;
  const vari = d.variation || 0;               // displayed heading - the grid heading (deg)
  ctx.strokeStyle = C.white;
  for (let a = 0; a < 360; a += 10) {
    const ang = (a - vari) * DEG - hdg;        // screen angle from up
    const s = Math.sin(ang), c = -Math.cos(ang);
    const len = a % 30 === 0 ? 16 : 9;
    ctx.lineWidth = a % 30 === 0 ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(sx + s * rr, sy + c * rr);
    ctx.lineTo(sx + s * (rr - len), sy + c * (rr - len));
    ctx.stroke();
    // labels every 30 deg, none under the heading box at the top
    const up = Math.abs(Math.atan2(s, -c)) < 15 * DEG;
    if (a % 30 === 0 && !up) {
      const lab = a === 0 ? 'N' : a === 90 ? 'E' : a === 180 ? 'S' : a === 270 ? 'W' : String(a / 10);
      textOutlined(ctx, lab, sx + s * (rr - 34), sy + c * (rr - 34), 22, a % 90 === 0 ? C.white : '#b9c3cc', 'center', 700, 'middle');
    }
  }
  // ---- airfields: runways to scale, the ICAO code
  for (const ap of d.airports || []) {
    ctx.strokeStyle = ap.closed ? C.grey : '#9fe8ff';
    ctx.lineWidth = 4;
    ctx.lineCap = 'butt';
    let cxs = 0, cys = 0, n = 0;
    for (const rw of ap.runways || []) {
      if (!rw.ends || rw.ends.length < 2) continue;
      const a = toScreen(m, rw.ends[0].x, rw.ends[0].z, { x: 0, y: 0 });
      const b = toScreen(m, rw.ends[1].x, rw.ends[1].z, { x: 0, y: 0 });
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      cxs += a.x + b.x; cys += a.y + b.y; n += 2;
    }
    if (n) {
      const lx = cxs / n, ly = cys / n;
      if (lx > r.x - 40 && lx < r.x + r.w + 40 && ly > r.y - 40 && ly < r.y + r.h + 40) {
        textOutlined(ctx, ap.icao.startsWith('LL') ? ap.icao : ap.name.split(' ')[0].toUpperCase(), lx + 14, ly - 12, 18, ap.closed ? '#9aa4ad' : '#9fe8ff', 'left', 700);
      }
    }
  }
  // ---- route to the steerpoint (magenta), steerpoint symbol
  const sp = d.steer;
  if (sp) {
    const p = toScreen(m, sp.x, sp.z, { x: 0, y: 0 });
    ctx.strokeStyle = C.magenta;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = C.magenta;
    ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2); ctx.fill();
  }
  // ---- wingmen (MADL friendlies): green circles with a heading stick, altitude in hundreds of feet
  for (const w of d.wingmen || []) {
    const p = toScreen(m, w.x, w.z, { x: 0, y: 0 });
    const a = w.hdg - hdg;
    ctx.strokeStyle = C.green;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(p.x, p.y, 10, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p.x + Math.sin(a) * 10, p.y - Math.cos(a) * 10); ctx.lineTo(p.x + Math.sin(a) * 26, p.y - Math.cos(a) * 26); ctx.stroke();
    textOutlined(ctx, String(Math.round(w.altFt / 100)), p.x + 14, p.y + 22, 16, C.green, 'left', 700);
  }
  // ---- own-ship: the ground track line (one minute ahead) and the aircraft symbol
  const v = st.velocity;
  if (v && Math.hypot(v.x, v.z) > 3) {
    const t = toScreen(m, ox + v.x * 60, oz + v.z * 60, { x: 0, y: 0 });
    ctx.strokeStyle = C.white;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(t.x, t.y); ctx.stroke();
  }
  ctx.save();
  ctx.translate(sx, sy);
  ctx.fillStyle = C.cyan;
  ctx.strokeStyle = '#001018';
  ctx.lineWidth = 2;
  ctx.beginPath();
  // F-35 planform, 34 px long
  const S = 1.0;
  const pts = [[0, -18], [3, -10], [4, -4], [15, 5], [15, 8], [4, 7], [4, 11], [9, 15], [9, 17], [2, 16], [0, 17]];
  ctx.moveTo(pts[0][0] * S, pts[0][1] * S);
  for (const q of pts.slice(1)) ctx.lineTo(q[0] * S, q[1] * S);
  for (const q of pts.slice(0, -1).reverse()) ctx.lineTo(-q[0] * S, q[1] * S);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  ctx.restore();
  // ---- heading box (top centre), range, mode, steerpoint data block
  ctx.fillStyle = '#000';
  ctx.fillRect(sx - 40, r.y + 4, 80, 34);
  ctx.strokeStyle = C.white;
  ctx.lineWidth = 2;
  ctx.strokeRect(sx - 40, r.y + 4, 80, 34);
  text(ctx, pad3(sys.flight.hdg + vari), sx, r.y + 31, 26, C.white, 'center', 700);
  portal(ctx, r, 'TSD-1', 'NAV');
  // range: half ring value, the range box with the orientation under it
  textOutlined(ctx, `${rangeNm / 2}`, sx + R * 0.5 * ppm * 0.71 + 6, sy - R * 0.5 * ppm * 0.71 - 4, 17, '#b9c3cc', 'left', 700);
  ctx.fillStyle = '#000';
  ctx.fillRect(r.x + 10, r.y + 44, 70, 34);
  ctx.strokeStyle = C.frame;
  ctx.strokeRect(r.x + 10, r.y + 44, 70, 34);
  text(ctx, String(rangeNm), r.x + 45, r.y + 70, 24, C.white, 'center', 700);
  textOutlined(ctx, 'NM', r.x + 86, r.y + 70, 15, C.dim, 'left', 700);
  textOutlined(ctx, 'HDG UP', r.x + 12, r.y + 100, 15, C.dim, 'left', 700);
  if (sp) {
    const bx = r.x + 10, by = r.y + r.h - 96;
    ctx.fillStyle = 'rgba(0,0,0,0.86)';
    ctx.fillRect(bx, by, 236, 86);
    text(ctx, `STPT  ${sp.icao}`, bx + 8, by + 24, 19, C.magenta, 'left', 700);
    text(ctx, `${pad3(sp.brg)}° / ${sp.rngNm.toFixed(1)} NM`, bx + 8, by + 51, 21, C.white, 'left', 700);
    text(ctx, sp.ttg, bx + 8, by + 77, 19, C.dim, 'left', 700);
  }
  // ground speed and altitude block (lower right)
  const bx = r.x + r.w - 168, by = r.y + r.h - 70;
  ctx.fillStyle = 'rgba(0,0,0,0.86)';
  ctx.fillRect(bx, by, 158, 60);
  text(ctx, `GS ${Math.round(sys.flight.gs)}`, bx + 150, by + 25, 20, C.white, 'right', 700);
  text(ctx, `${sys.flight.vs >= 0 ? '+' : ''}${fmt(sys.flight.vs)} FPM`, bx + 150, by + 51, 17, C.dim, 'right', 700);
}

// ------------------------------------------------------------------------------ FUEL
const PLAN = [[0.5, 0.0], [0.53, 0.06], [0.555, 0.14], [0.565, 0.22], [0.62, 0.27], [0.64, 0.38], [0.66, 0.42],
  [1.0, 0.66], [1.0, 0.72], [0.70, 0.76], [0.68, 0.80], [0.87, 0.9], [0.87, 0.96], [0.62, 0.975], [0.57, 1.0], [0.5, 1.0]];

export function drawFuel(ctx, r, d) {
  const fu = d.sys.fuel;
  portal(ctx, r, 'FUEL');
  // planform with the tanks filling from the bottom
  const ph = r.h - 64, pw = ph * 0.70;
  const px = r.x + 18, py = r.y + 44;
  ctx.save();
  ctx.translate(px, py);
  ctx.strokeStyle = C.dim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  PLAN.forEach(([x, y], i) => (i ? ctx.lineTo(x * pw, y * ph) : ctx.moveTo(x * pw, y * ph)));
  for (let i = PLAN.length - 1; i >= 0; i--) ctx.lineTo((1 - PLAN[i][0]) * pw, PLAN[i][1] * ph);
  ctx.closePath();
  ctx.stroke();
  for (const t of TANKS) {
    const q = fu.tanks[t.id] || 0;
    const f = clamp(q / t.max, 0, 1);
    const x = t.x * pw, y = t.y * ph, w = t.w * pw, h = t.h * ph;
    ctx.fillStyle = C.purpleDark;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = C.purple;
    ctx.fillRect(x, y + h * (1 - f), w, h * f);
    ctx.strokeStyle = '#d9c8ff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);
  }
  ctx.restore();
  // numbers
  const cx = px + pw + 26, w = r.x + r.w - cx - 14;
  const row = (y, label, value, col = C.white, big = 28) => {
    text(ctx, label, cx, y, 17, C.dim, 'left', 700);
    text(ctx, value, cx + w, y + (big > 24 ? 2 : 0), big, col, 'right', 700);
  };
  text(ctx, 'TOTAL', cx, r.y + 56, 16, C.dim, 'left', 700);
  text(ctx, fmt(Math.round(fu.totalLb / 10) * 10), cx + w, r.y + 92, 36, fu.totalLb < fu.bingo ? C.yellow : C.white, 'right', 700);
  row(r.y + 126, 'INT', fmt(Math.round(fu.totalLb / 50) * 50), C.purple, 24);
  row(r.y + 156, 'EXT', '0', C.dim, 24);
  row(r.y + 194, 'FLOW', `${fmt(Math.round(fu.flowPph / 10) * 10)}`, C.white, 24);
  const em = Math.max(0, Math.round(fu.endurance));
  row(r.y + 224, 'ENDUR', fu.flowPph > 1 ? `${Math.floor(em / 60)}:${String(em % 60).padStart(2, '0')}` : '--:--', C.white, 24);
  row(r.y + 262, 'BINGO', fmt(fu.bingo), C.white, 24);
  row(r.y + 292, 'JOKER', fmt(fu.joker), C.white, 24);
  row(r.y + 324, 'GW', fmt(Math.round(fu.grossLb / 100) * 100), C.dim, 22);
}

// ------------------------------------------------------------------------------ ENG
function dial(ctx, cx, cy, rad, value, vmin, vmax, label, unit, digits, marks) {
  const a0 = 135 * DEG, a1 = 405 * DEG;         // 270 deg sweep, from lower left clockwise
  const ang = (v) => a0 + (a1 - a0) * clamp((v - vmin) / (vmax - vmin), 0, 1);
  ctx.lineWidth = 9;
  ctx.strokeStyle = '#1c2a22';
  ctx.beginPath(); ctx.arc(cx, cy, rad, a0, a1); ctx.stroke();
  // coloured bands: [from, to, colour]
  for (const [f, t, col] of marks) {
    ctx.strokeStyle = col;
    ctx.beginPath(); ctx.arc(cx, cy, rad, ang(f), ang(t)); ctx.stroke();
  }
  // pointer
  const a = ang(value);
  ctx.strokeStyle = C.white;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(a) * rad * 0.18, cy + Math.sin(a) * rad * 0.18);
  ctx.lineTo(cx + Math.cos(a) * (rad + 6), cy + Math.sin(a) * (rad + 6));
  ctx.stroke();
  ctx.lineCap = 'butt';
  text(ctx, label, cx, cy + rad * 0.62, 17, C.dim, 'center', 700);
  text(ctx, digits, cx, cy + rad + 12, 30, C.white, 'center', 700, 'middle');
  if (unit) text(ctx, unit, cx + rad * 0.95, cy + rad + 13, 14, C.dim, 'left', 700, 'middle');
}

function bar(ctx, x, y, w, h, f, col, label, digits) {
  ctx.fillStyle = '#121a16';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = col;
  ctx.fillRect(x, y + h * (1 - clamp(f, 0, 1)), w, h * clamp(f, 0, 1));
  ctx.strokeStyle = C.frame;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  text(ctx, label, x + w / 2, y + h + 22, 16, C.dim, 'center', 700);
  text(ctx, digits, x + w / 2, y - 10, 22, C.white, 'center', 700);
}

export function drawEng(ctx, r, d) {
  const en = d.sys.eng;
  portal(ctx, r, 'ENG', 'F135');
  const cy = r.y + 118;
  dial(ctx, r.x + 82, cy, 56, en.n2, 0, 110, 'N2', '%', `${Math.round(en.n2)}`,
    [[0, 100, '#2e8a46'], [100, 104, C.yellow], [104, 110, C.red]]);
  dial(ctx, r.x + 226, cy, 56, en.tet, 0, 1100, 'TET', '\u00b0C', `${Math.round(en.tet)}`,
    [[0, 900, '#2e8a46'], [900, 960, C.yellow], [960, 1100, C.red]]);
  bar(ctx, r.x + 330, r.y + 66, 40, 124, en.noz / 100, C.cyan, 'NOZ', `${Math.round(en.noz)}`);
  // oil, throttle (MIL detent, afterburner range), fuel flow and thrust
  const by = r.y + 232, bh = 72;
  bar(ctx, r.x + 22, by, 34, bh, en.oil / 100, '#2fbf5a', 'OIL', `${Math.round(en.oil)}`);
  const tx = r.x + 88, tw = 34;
  ctx.fillStyle = '#121a16';
  ctx.fillRect(tx, by, tw, bh);
  const th = clamp(en.thr, 0, 1);
  ctx.fillStyle = en.ab > 0.005 ? C.yellow : C.white;
  ctx.fillRect(tx, by + bh * (1 - th), tw, bh * th);
  ctx.strokeStyle = C.frame;
  ctx.lineWidth = 2;
  ctx.strokeRect(tx, by, tw, bh);
  ctx.strokeStyle = C.yellow;
  ctx.beginPath(); ctx.moveTo(tx - 6, by + bh * 0.25); ctx.lineTo(tx + tw + 6, by + bh * 0.25); ctx.stroke();
  text(ctx, 'THR', tx + tw / 2, by + bh + 22, 16, C.dim, 'center', 700);
  text(ctx, en.stage || `${Math.round(th / 0.75 * 100)}%`, tx + tw / 2, by - 10, 20, en.stage === 'AB' ? C.yellow : C.white, 'center', 700);
  const fx = r.x + 150;
  text(ctx, 'FF', fx, by + 14, 17, C.dim, 'left', 700);
  text(ctx, fmt(Math.round(en.ffPph / 10) * 10), fx + 196, by + 20, 30, C.white, 'right', 700);
  text(ctx, 'PPH', fx + 200, by + 20, 14, C.dim, 'left', 700);
  text(ctx, 'THRUST', fx, by + 60, 17, C.dim, 'left', 700);
  text(ctx, `${Math.round(d.thrustKn)}`, fx + 196, by + 66, 30, C.white, 'right', 700);
  text(ctx, 'kN', fx + 200, by + 66, 14, C.dim, 'left', 700);
  if (!en.running) text(ctx, 'ENGINE OFF', fx + 100, by + bh + 22, 22, C.red, 'center', 800);
}

// ------------------------------------------------------------------------------ ICAWS
export function drawIcaws(ctx, r, d) {
  portal(ctx, r, 'ICAWS');
  const list = d.sys.icaws;
  if (!list.length) {
    text(ctx, 'NO ALERTS', r.x + r.w / 2, r.y + r.h / 2 + 18, 22, C.grey, 'center', 700);
    return;
  }
  const col = { W: C.red, C: C.yellow, A: C.green };
  const n = Math.min(list.length, 5);
  for (let i = 0; i < n; i++) {
    const m = list[i];
    const y = r.y + 64 + i * 30;
    const c = col[m.level];
    if (m.level === 'W' && d.flash) {
      ctx.fillStyle = c;
      ctx.fillRect(r.x + 14, y - 22, r.w - 28, 28);
      text(ctx, m.text, r.x + 24, y, 22, '#000', 'left', 800);
    } else {
      ctx.fillStyle = c;
      ctx.fillRect(r.x + 14, y - 18, 8, 20);
      text(ctx, m.text, r.x + 32, y, 22, c, 'left', 700);
    }
  }
  if (list.length > n) text(ctx, `+${list.length - n}`, r.x + r.w - 14, r.y + r.h - 10, 18, C.dim, 'right', 700);
}

// ------------------------------------------------------------------------------ EFI
export function drawEfi(ctx, r, d) {
  const F = d.sys.flight;
  portal(ctx, r, 'EFI');
  // attitude indicator: sky over ground, pitch lines every 5 deg, bank pointer
  const s = r.h - 52, ax = r.x + 14, ay = r.y + 40, cx = ax + s / 2, cy = ay + s / 2;
  const pxDeg = s / 50;                       // 50 deg of pitch over the window
  ctx.save();
  ctx.beginPath();
  roundRect(ctx, ax, ay, s, s, 10);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(-F.roll * DEG);
  const off = F.pitch * pxDeg;
  ctx.fillStyle = C.sky;
  ctx.fillRect(-s, -2 * s + off, 2 * s, 2 * s);
  ctx.fillStyle = C.ground;
  ctx.fillRect(-s, off, 2 * s, 2 * s);
  ctx.strokeStyle = C.white;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-s, off); ctx.lineTo(s, off); ctx.stroke();
  for (let p = -40; p <= 40; p += 5) {
    if (!p) continue;
    const y = off - p * pxDeg;
    if (Math.abs(y) > s * 0.6) continue;
    const w = p % 10 === 0 ? s * 0.22 : s * 0.11;
    ctx.beginPath(); ctx.moveTo(-w, y); ctx.lineTo(w, y); ctx.stroke();
    if (p % 10 === 0) {
      text(ctx, String(Math.abs(p)), -w - 6, y, 14, C.white, 'right', 700, 'middle');
      text(ctx, String(Math.abs(p)), w + 6, y, 14, C.white, 'left', 700, 'middle');
    }
  }
  ctx.restore();
  // bank scale and pointer, the fixed aircraft symbol
  ctx.strokeStyle = C.white;
  ctx.lineWidth = 2;
  for (const b of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const a = (b - 90) * DEG, r0 = s * 0.44, r1 = r0 - (b % 30 === 0 ? 12 : 7);
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); ctx.stroke();
  }
  const ba = (-F.roll - 90) * DEG, br = s * 0.44 - 14;
  ctx.fillStyle = C.yellow;
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(ba) * br, cy + Math.sin(ba) * br);
  ctx.lineTo(cx + Math.cos(ba + 0.07) * (br - 14), cy + Math.sin(ba + 0.07) * (br - 14));
  ctx.lineTo(cx + Math.cos(ba - 0.07) * (br - 14), cy + Math.sin(ba - 0.07) * (br - 14));
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = C.yellow;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.3, cy); ctx.lineTo(cx - s * 0.1, cy); ctx.lineTo(cx - s * 0.06, cy + 8);
  ctx.moveTo(cx + s * 0.3, cy); ctx.lineTo(cx + s * 0.1, cy); ctx.lineTo(cx + s * 0.06, cy + 8);
  ctx.stroke();
  ctx.fillStyle = C.yellow;
  ctx.fillRect(cx - 3, cy - 3, 6, 6);
  ctx.strokeStyle = C.frame;
  ctx.lineWidth = 2;
  roundRect(ctx, ax, ay, s, s, 10);
  ctx.stroke();
  // readouts
  const x0 = ax + s + 18, x1 = r.x + r.w - 14;
  const row = (y, label, value, col = C.white) => {
    text(ctx, label, x0, y, 16, C.dim, 'left', 700);
    text(ctx, value, x1, y, 24, col, 'right', 700);
  };
  row(r.y + 62, 'CAS', fmt(F.cas));
  row(r.y + 90, 'ALT', fmt(F.alt));
  row(r.y + 118, 'VS', `${F.vs >= 0 ? '+' : ''}${fmt(F.vs)}`);
  row(r.y + 146, 'AOA', F.aoa.toFixed(1), F.aoa > 20 ? C.yellow : C.white);
  row(r.y + 174, 'G', F.g.toFixed(1), F.g > 8 || F.g < -2.5 ? C.yellow : C.white);
  row(r.y + 200, 'M', F.mach.toFixed(2));
}

/** Everything, into a 2D context already scaled to the reference frame. */
export function drawAll(ctx, d, maps, layout) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, REF_W, REF_H);
  drawStatusBar(ctx, d);
  drawTSD(ctx, layout.tsd, d, maps);
  drawFuel(ctx, layout.fuel, d);
  drawEng(ctx, layout.eng, d);
  drawIcaws(ctx, layout.icaws, d);
  drawEfi(ctx, layout.efi, d);
}

export const LAYOUT = {
  tsd: { x: 4, y: 80, w: 792, h: 556 },
  fuel: { x: 800, y: 80, w: 396, h: 344 },
  eng: { x: 1200, y: 80, w: 396, h: 344 },
  icaws: { x: 800, y: 428, w: 396, h: 208 },
  efi: { x: 1200, y: 428, w: 396, h: 208 },
};
export { PX_IN };
