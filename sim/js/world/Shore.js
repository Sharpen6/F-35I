// Shore structures of the Mediterranean coast between Ashkelon and Herzliya: the rubble-mound
// breakwaters (the ports of Ashdod and Jaffa, the Tel Aviv, Herzliya and Ashkelon marinas, the
// detached breakwaters off the Tel Aviv and Bat Yam beaches with the sand tombolos behind them,
// which the imagery has), quays, piers and marina pontoons, and the container cranes of Ashdod
// port. The terrain draws the coast from imagery on a 25 m grid: without this a breakwater was a
// smudge of sea colour and the port had nothing standing in it.
//
// Data: <data>/landscape/shore.json (sim/tools/world/shore.py, from Overture Maps /
// OpenStreetMap; format f35i-shore v1). Without it nothing is drawn (a note in the console).
//
// Everything is static and small (some 60 breakwaters, 120 decks and 25 cranes): built once at
// load into one mesh per 8 km area, positions relative to the area's middle (float32 stays exact),
// two draws each: the structures (opaque) and the white water on the sea along the breakwaters'
// sides that face the swell (blended over the terrain's water; shore.py works out which sides).
// The cranes carry steady red obstruction lights at night (the buildings' light program, on the
// rule every point light follows: its uniforms and the lights' blend, as Buildings.js has them).
// The Dead Sea's south basin lies outside the core whose buildings Buildings.js draws: its
// hotels (Ein Bokek, Hamei Zohar), Neve Zohar and the Dead Sea Works at Sdom come as plain
// blocks (shore.json "blocks") with balcony rows and windows in the shader, lit at night as the
// city's windows are (js/env/README.md "Lights at night": one schedule, one window luminance).
// Shaders: shoreShaders.js. Every program is compiled at load (_precompile), before it shows.
//
// Module API (main.js addModule): update(f), setTime(h), setQuality(q), reset(), dispose().
// URL: ?shore=0 leaves it out.

import * as THREE from 'three';
import { SHORE_VERT, SHORE_FRAG, KIND } from './shoreShaders.js';
import { LIGHT_VERT, LIGHT_FRAG } from './buildingShaders.js';
import { LUX_PER_UNIT, artificialLightGain, pointLightThreshold, lightsOn as lightsOnAt } from '../env/Environment.js';
import { emitterBlending } from '../env/emitters.js';

// far: areas whose nearest point is further away are hidden; foam: the white water band;
// detail: the stones' cells and stains up close
const QUALITY = {
  low: { far: 20000, foam: false, detail: 0 },
  medium: { far: 32000, foam: true, detail: 1 },
  high: { far: 45000, foam: true, detail: 1 },
};
// the south basin's blocks on every tier as far as on high: a 30-60 m hotel is 5-7 px at low's
// 20 km (and lit at night), and areas show without a fade; at 45 km it is about a pixel in the haze
const BLOCKS_FAR = QUALITY.high.far;
const AREA = 8000;              // m: structures are grouped into one mesh per area of this size
const BELOW = 3.0;              // m below the sea the mounds and walls reach (the water hides it)
const FOAM_Y = 0.12;            // m: the white water band floats this much over the sea
const FOAM_W = 9.0;             // m: its width from the foot of the mound
const QUAY_Y = 2.5;             // m: the quay level the cranes stand on (their legs reach below)
const SMOOTH_COS = Math.cos(35 * Math.PI / 180);   // mound sides meeting flatter than this are shaded smooth

// colours (sRGB 0-255). The stone of the small detached breakwaters is quarried limestone, the
// ports' armour concrete blocks; crane colours are made up (blue and white, common on STS cranes)
const C = {
  rock: [170, 162, 147],
  armour: [176, 175, 170],
  crest: [152, 151, 146],
  deck: [160, 158, 152],
  pontoon: [134, 128, 118],
  wall: [150, 148, 142],
  blue: [38, 84, 148],
  white: [222, 225, 228],
  grey: [196, 199, 202],
  dark: [58, 60, 64],
  glass: [30, 36, 42],
};
// the south basin's blocks by kind (shore.py): wall, roof, facade style (aNrm.w: 1 hotel, 0.5
// house, 0 shed). Hotels white and cream render, sheds pale grey cladding, houses beige.
const BLOCK = [
  { walls: [[236, 232, 220], [226, 214, 190], [240, 238, 232]], roof: [196, 192, 182], style: 1.0 },
  { walls: [[198, 196, 188], [182, 180, 172], [206, 200, 186]], roof: [170, 170, 166], style: 0.0 },
  { walls: [[222, 210, 186], [214, 204, 184], [230, 222, 204]], roof: [188, 180, 166], style: 0.5 },
];

/**
 * A lit window's luminance (cd/m^2): the city's (Buildings.js WINDOW_CD), drawn by the night rule
 * (x env.lightGain / LUX_PER_UNIT, on by env.lightsOn), so a hotel's windows are as bright as a
 * Tel Aviv flat's. (A fixed radiance of 0.014 was 4.6 times that at night: flat, blown-out slabs.)
 */
const WINDOW_CD = 20;

/**
 * Share of the blocks' windows lit at local solar time h: the buildings' curve (Buildings.js
 * litFraction: an evening peak, quiet small hours), so the hotels go dark with the cities.
 */
const LIT = [[0, 0.30], [2, 0.17], [5, 0.12], [6.5, 0.2], [8, 0.08], [17, 0.08], [19, 0.42], [21, 0.52], [23, 0.40], [24, 0.30]];
function litShare(h) {
  h = ((h % 24) + 24) % 24;
  let v = LIT[0][1];
  for (let i = 1; i < LIT.length; i++) {
    if (h <= LIT[i][0]) {
      const [h0, v0] = LIT[i - 1], [h1, v1] = LIT[i];
      v = v0 + (v1 - v0) * (h - h0) / (h1 - h0);
      break;
    }
  }
  return v;
}

const params = new URLSearchParams(globalThis.location?.search ?? '');

/** One mesh's arrays: position (m, area-relative), aNrm (normal, exposure), aCol (sRGB, kind). */
class Geo {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.idx = [];
    this.n = 0;
  }

  v(x, y, z, n, exp, c, kind) {
    this.pos.push(x, y, z);
    this.nrm.push(Math.round(n[0] * 127), Math.round(n[1] * 127), Math.round(n[2] * 127), Math.round(Math.min(Math.max(exp, 0), 1) * 127));
    this.col.push(c[0], c[1], c[2], kind);
    return this.n++;
  }

  /** Triangle a b c wound counter-clockwise seen from the side its normal n points to. */
  tri(a, b, c, n) {
    const P = this.pos;
    const ax = P[3 * a], ay = P[3 * a + 1], az = P[3 * a + 2];
    const ux = P[3 * b] - ax, uy = P[3 * b + 1] - ay, uz = P[3 * b + 2] - az;
    const vx = P[3 * c] - ax, vy = P[3 * c + 1] - ay, vz = P[3 * c + 2] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  quad(a, b, c, d, n) {
    this.tri(a, b, c, n);
    this.tri(a, c, d, n);
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('aNrm', new THREE.BufferAttribute(new Int8Array(this.nrm), 4, true));
    g.setAttribute('aCol', new THREE.BufferAttribute(new Uint8Array(this.col), 4, true));
    g.setIndex(this.n > 65535 ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1) : new THREE.BufferAttribute(new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    // the vertex shader lowers far vertices with the earth's curvature: keep them inside
    g.boundingSphere.radius += 150;
    return g;
  }
}

function signedArea(r) {
  let s = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const a = r[i], b = r[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** Unit outward normal (x, z) of edge i of ring r (either orientation). */
function outward(r, i, sa) {
  const a = r[i], b = r[(i + 1) % r.length];
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const L = Math.hypot(dx, dz) || 1;
  return sa < 0 ? [-dz / L, dx / L] : [dz / L, -dx / L];
}

function norm3(v) {
  const L = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}

/** Flat polygon (ring of [x, z], area-relative) at height y, facing up or down. */
function cap(g, ring, y, up, col, kind, exp = 0) {
  const pts = ring.map((p) => new THREE.Vector2(p[0], p[1]));
  let faces;
  try {
    faces = THREE.ShapeUtils.triangulateShape(pts, []);
  } catch (e) {
    return;
  }
  const n = up ? [0, 1, 0] : [0, -1, 0];
  const base = g.n;
  for (const p of ring) g.v(p[0], y, p[1], n, exp, col, kind);
  for (const f of faces) g.tri(base + f[0], base + f[1], base + f[2], n);
}

export class Shore {
  constructor({ renderer, scene, env, terrain, app }, { baseUrl = 'data/landscape/' } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.env = env;
    this.terrain = terrain;
    this.app = app;
    this.baseUrl = baseUrl;
    this.name = 'shore';
    this.forcedOff = params.get('shore') === '0';
    this.quality = 'high';
    this.Q = QUALITY.high;
    this.hours = 12;
    this.areas = [];
    this.loaded = false;
    this.stats = { areas: 0, breakwaters: 0, decks: 0, cranes: 0, blocks: 0, triangles: 0, foamTriangles: 0, visible: 0 };
    this.group = new THREE.Group();
    this.group.name = 'Shore';
    this._cam = new THREE.Vector3();
    this._dbSize = new THREE.Vector2();
    this._disposed = false;
    // uWindowL: a lit window's radiance (WINDOW_CD by the night rule; 0 by day)
    this._shore = { uShore: { value: new THREE.Vector4(0.7, 1, 0.5, 0) }, uWindowL: { value: 0 } };
    // the cranes' lights: on, time; and the point-light rule's uniforms (AirportLights.js
    // POINT_LIGHT_VERT_GLSL), all of them: the program is the buildings' (the same source), and
    // one this material lacked was read as another material had left it there
    this._lightU = {
      uLightOn: { value: new THREE.Vector3(0, 0, 0) },
      uThreshold: { value: 1e-7 }, uExposure: { value: 1 }, uPxAngle: { value: 1e-3 }, uGain: { value: 1 / LUX_PER_UNIT },
      uLightsOn: { value: 0 },
    };
    // the stand-in environment of ?stubs=1 has no atmosphere: stay off
    if (!env?.uniforms?.uSkyViewLUT || this.forcedOff) {
      this.ready = Promise.resolve();
      return;
    }
    this.attribution = 'Shore structures: Overture Maps Foundation (ODbL), (c) OpenStreetMap contributors';
    this.material = this._material(false);
    this.foamMaterial = this._material(true);
    // added light with its mark as a light in the alpha (js/env/emitters.js), as the buildings'
    // obstruction lights: LIGHT_FRAG writes a negative alpha, which additive blending (SRC_ALPHA,
    // ONE) turned into black holes with cyan rims at night
    this.lightMaterial = emitterBlending(new THREE.ShaderMaterial({
      name: 'ShoreLights',
      uniforms: { ...env.uniforms, ...this._lightU },
      vertexShader: LIGHT_VERT,
      fragmentShader: LIGHT_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      fog: false,
    }));
    scene.add(this.group);
    this.ready = this._load();
  }

  _material(foam) {
    if (foam) {
      return new THREE.ShaderMaterial({
        name: 'ShoreFoam',
        uniforms: { ...this.env.uniforms, ...this._shore },
        vertexShader: SHORE_VERT,
        fragmentShader: SHORE_FRAG,
        defines: { FOAM: 1 },
        transparent: true,
        depthTest: true,
        depthWrite: false,
        fog: false,
      });
    }
    const lights = THREE.UniformsUtils.clone(THREE.UniformsLib.lights);
    return new THREE.ShaderMaterial({
      name: 'Shore',
      uniforms: { ...lights, ...this.env.uniforms, ...this._shore },
      vertexShader: SHORE_VERT,
      fragmentShader: SHORE_FRAG,
      lights: true,
      fog: false,
    });
  }

  // ------------------------------------------------------------------------------ data
  async _load() {
    let doc;
    try {
      const r = await fetch(this.baseUrl + 'shore.json');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      doc = await r.json();
      if (doc.format !== 'f35i-shore' || doc.version !== 1) throw new Error('unknown format');
    } catch (e) {
      console.warn(`Shore: no shore data (${e.message}); build it with sim/tools/world/shore.py`);
      return;
    }
    if (this._disposed) return;
    if (doc.attribution) this.attribution = doc.attribution;
    const t0 = performance.now();
    this._build(doc);
    this.loaded = true;
    this.stats.buildMs = Math.round(performance.now() - t0);
    this._precompile();
  }

  _area(map, x, z) {
    const key = `${Math.floor(x / AREA)}_${Math.floor(z / AREA)}`;
    let a = map.get(key);
    if (!a) {
      const ox = (Math.floor(x / AREA) + 0.5) * AREA, oz = (Math.floor(z / AREA) + 0.5) * AREA;
      a = { key, ox, oz, geo: new Geo(), foam: new Geo(), lights: [] };
      map.set(key, a);
    }
    return a;
  }

  _build(doc) {
    const map = new Map();
    for (const b of doc.breakwaters || []) {
      if (!b.foot || b.foot.length < 3 || b.foot.length !== b.crest?.length) continue;
      const a = this._area(map, b.foot[0][0], b.foot[0][1]);
      this._mound(a, b);
      this.stats.breakwaters++;
    }
    for (const d of doc.decks || []) {
      if (!d.ring || d.ring.length < 3) continue;
      const a = this._area(map, d.ring[0][0], d.ring[0][1]);
      this._deck(a, d);
      this.stats.decks++;
    }
    for (const c of doc.cranes || []) {
      const a = this._area(map, c.x, c.z);
      this._crane(a, c);
      this.stats.cranes++;
    }
    for (const b of doc.blocks || []) {
      if (!b.ring || b.ring.length < 3) continue;
      const a = this._area(map, b.ring[0][0], b.ring[0][1]);
      this._block(a, b);
      a.blocks = true;
      this.stats.blocks++;
    }
    for (const a of map.values()) {
      if (!a.geo.n) continue;
      const mesh = new THREE.Mesh(a.geo.geometry(), this.material);
      mesh.name = `shore_${a.key}`;
      mesh.position.set(a.ox, 0, a.oz);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.stats.triangles += a.geo.idx.length / 3;
      let foam = null;
      if (a.foam.n) {
        foam = new THREE.Mesh(a.foam.geometry(), this.foamMaterial);
        foam.name = `shore_foam_${a.key}`;
        foam.position.copy(mesh.position);
        foam.renderOrder = 2;
        this.group.add(foam);
        this.stats.foamTriangles += a.foam.idx.length / 3;
      }
      let lights = null;
      if (a.lights.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(a.lights.flatMap((l) => [l[0], l[1], l[2]])), 3));
        g.setAttribute('aLight', new THREE.BufferAttribute(new Float32Array(a.lights.flatMap((l) => [0, l[3]])), 2));
        g.computeBoundingSphere();
        lights = new THREE.Points(g, this.lightMaterial);
        lights.position.copy(mesh.position);
        lights.renderOrder = 20;
        lights.visible = false;
        this.group.add(lights);
      }
      const bs = mesh.geometry.boundingSphere;
      this.areas.push({ key: a.key, mesh, foam, lights, center: bs.center.clone().add(mesh.position), radius: bs.radius, blocks: !!a.blocks });
    }
    this.stats.areas = this.areas.length;
  }

  /** A rubble mound: footprint ring at sea level, crest ring at b.h (shore.py), the slope carried BELOW m under the sea. */
  _mound(a, b) {
    const g = a.geo, ox = a.ox, oz = a.oz;
    const F = b.foot.map((p) => [p[0] - ox, p[1] - oz]);
    const Cr = b.crest.map((p) => [p[0] - ox, p[1] - oz]);
    const n = F.length, h = Math.max(b.h, 0.5);
    const exp = b.exp || [];
    const col = h >= 5 ? C.armour : C.rock;
    // the bottom ring: the slope continued under the sea
    const B = F.map((f, i) => [f[0] + (f[0] - Cr[i][0]) * BELOW / h, f[1] + (f[1] - Cr[i][1]) * BELOW / h]);
    const sa = signedArea(F);
    // face normals per edge, oriented outward
    const fn = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const p0 = [B[i][0], -BELOW, B[i][1]], p1 = [B[j][0], -BELOW, B[j][1]], p3 = [Cr[i][0], h, Cr[i][1]];
      const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], v = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
      let c = norm3([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
      const o = outward(F, i, sa);
      if (c[0] * o[0] + c[2] * o[1] < 0 || (Math.abs(c[0]) + Math.abs(c[2]) < 1e-3 && c[1] < 0)) c = [-c[0], -c[1], -c[2]];
      // a crest inset to nothing leaves a vertical side: it still faces out
      if (c[1] < -0.05) c = norm3([o[0], 0.2, o[1]]);
      fn.push(c);
    }
    // smooth where neighbouring sides meet at a shallow angle
    const vn = [], ve = [], sharp = [];
    for (let i = 0; i < n; i++) {
      const p = (i - 1 + n) % n;
      const d = fn[p][0] * fn[i][0] + fn[p][1] * fn[i][1] + fn[p][2] * fn[i][2];
      sharp.push(d < SMOOTH_COS);
      vn.push(norm3([fn[p][0] + fn[i][0], fn[p][1] + fn[i][1], fn[p][2] + fn[i][2]]));
      ve.push(0.5 * ((exp[p] ?? 0) + (exp[i] ?? 0)) / 100);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ei = (exp[i] ?? 0) / 100;
      const ni = sharp[i] ? fn[i] : vn[i], nj = sharp[j] ? fn[i] : vn[j];
      const xi = sharp[i] ? ei : ve[i], xj = sharp[j] ? ei : ve[j];
      const v0 = g.v(B[i][0], -BELOW, B[i][1], ni, xi, col, KIND.rubble);
      const v1 = g.v(B[j][0], -BELOW, B[j][1], nj, xj, col, KIND.rubble);
      const v2 = g.v(Cr[j][0], h, Cr[j][1], nj, xj, col, KIND.rubble);
      const v3 = g.v(Cr[i][0], h, Cr[i][1], ni, xi, col, KIND.rubble);
      g.quad(v0, v1, v2, v3, fn[i]);
    }
    // the crest: a concrete cap (a road on the ports' main breakwaters), stones on the small ones
    cap(g, Cr, h, true, h >= 4 ? C.crest : col, h >= 4 ? KIND.crest : KIND.rubble);

    // white water on the sea along the exposed sides: a band from under the mound's foot outward
    if (!exp.some((e) => e > 0)) return;
    const fg = a.foam;
    const vo = [];
    for (let i = 0; i < n; i++) {
      const p = (i - 1 + n) % n;
      const o0 = outward(F, p, sa), o1 = outward(F, i, sa);
      let ox2 = o0[0] + o1[0], oz2 = o0[1] + o1[1];
      const L = Math.hypot(ox2, oz2);
      if (L < 0.3) { ox2 = o1[0]; oz2 = o1[1]; } else { ox2 /= L; oz2 /= L; }
      // mitre, capped: the band keeps its width round corners
      const c = Math.max(ox2 * o1[0] + oz2 * o1[1], 0.5);
      vo.push([ox2 / c, oz2 / c]);
    }
    const up = [0, 1, 0];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ei = (exp[i] ?? 0) / 100;
      if (ei <= 0) continue;
      const xi = sharp[i] ? ei : Math.max(ve[i], ei * 0.5), xj = sharp[j] ? ei : Math.max(ve[j], ei * 0.5);
      const q0 = fg.v(F[i][0] - vo[i][0] * 0.6, FOAM_Y, F[i][1] - vo[i][1] * 0.6, up, xi, [0, 0, 0], 0);
      const q1 = fg.v(F[j][0] - vo[j][0] * 0.6, FOAM_Y, F[j][1] - vo[j][1] * 0.6, up, xj, [0, 0, 0], 0);
      const q2 = fg.v(F[j][0] + vo[j][0] * FOAM_W, FOAM_Y, F[j][1] + vo[j][1] * FOAM_W, up, xj, [255, 0, 0], 0);
      const q3 = fg.v(F[i][0] + vo[i][0] * FOAM_W, FOAM_Y, F[i][1] + vo[i][1] * FOAM_W, up, xi, [255, 0, 0], 0);
      fg.quad(q0, q1, q2, q3, up);
    }
  }

  /** A quay, pier or pontoon: a flat top at d.h with walls down under the sea. */
  _deck(a, d) {
    const g = a.geo;
    const R = d.ring.map((p) => [p[0] - a.ox, p[1] - a.oz]);
    const n = R.length, h = d.h;
    const pontoon = h < 1.0;
    const sa = signedArea(R);
    cap(g, R, h, true, pontoon ? C.pontoon : C.deck, KIND.deck);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const o = outward(R, i, sa);
      const nn = [o[0], 0, o[1]];
      const v0 = g.v(R[i][0], -BELOW, R[i][1], nn, 0, C.wall, KIND.wall);
      const v1 = g.v(R[j][0], -BELOW, R[j][1], nn, 0, C.wall, KIND.wall);
      const v2 = g.v(R[j][0], h, R[j][1], nn, 0, C.wall, KIND.wall);
      const v3 = g.v(R[i][0], h, R[i][1], nn, 0, C.wall, KIND.wall);
      g.quad(v0, v1, v2, v3, nn);
    }
  }

  /**
   * A building of the Dead Sea's south basin (shore.py blocks): walls from under the lowest ground
   * of its footprint (the terrain's own heights, the rift strip's there) to b.h above the ground at
   * its middle, and a flat roof. The facade's floors, windows and balconies are the shader's.
   */
  _block(a, b) {
    const g = a.geo, T = this.terrain;
    const R = b.ring.map((p) => [p[0] - a.ox, p[1] - a.oz]);
    const n = R.length;
    let lo = Infinity, sum = 0;
    for (const p of b.ring) {
      const y = T?.heightAt ? T.heightAt(p[0], p[1]) : 0;
      lo = Math.min(lo, y);
      sum += y;
    }
    const base = lo - 1.5, top = sum / n + b.h;
    const st = BLOCK[b.kind] || BLOCK[2];
    const pick = Math.abs(Math.round(b.ring[0][0] * 0.37 + b.ring[0][1] * 0.11)) % st.walls.length;
    const wall = st.walls[pick];
    const sa = signedArea(R);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const o = outward(R, i, sa);
      const nn = [o[0], 0, o[1]];
      const v0 = g.v(R[i][0], base, R[i][1], nn, st.style, wall, KIND.facade);
      const v1 = g.v(R[j][0], base, R[j][1], nn, st.style, wall, KIND.facade);
      const v2 = g.v(R[j][0], top, R[j][1], nn, st.style, wall, KIND.facade);
      const v3 = g.v(R[i][0], top, R[i][1], nn, st.style, wall, KIND.facade);
      g.quad(v0, v1, v2, v3, nn);
    }
    cap(g, R, top, true, st.roof, KIND.roof);
  }

  /**
   * A ship-to-shore container crane (super post-Panamax, after Ashdod's published figures: 44 m
   * lift height, 60 m outreach): four legs on a 30.5 m rail gauge, sill and portal beams, twin
   * girders with the boom over the water (or raised, out of service), the A-frame with its fore-
   * and backstays, the machinery house over the backreach, the trolley and the driver's cab.
   * Crane frame: u along the boom (toward the water), v along the quay, y up; u = 0 the seaside rail.
   */
  _crane(a, c) {
    const g = a.geo;
    const hs = Math.sin(c.heading), hc = Math.cos(c.heading);
    const U = [hs, 0, -hc], Vq = [hc, 0, hs];
    const bx = c.x - a.ox, bz = c.z - a.oz, by = QUAY_Y;
    const P = (u, v, y) => [bx + U[0] * u + Vq[0] * v, by + y, bz + U[2] * u + Vq[2] * v];
    const D = (u, v, y) => [U[0] * u + Vq[0] * v, y, U[2] * u + Vq[2] * v];
    const steel = c.variant ? C.grey : C.blue, house = c.variant ? C.blue : C.white;
    // a beam from (u0, v0, y0) to (u1, v1, y1) in the crane frame, w wide, d deep
    const beam = (p0, p1, w, d, col, kind = KIND.steel) => {
      const A = P(...p0), Bp = P(...p1);
      const ax = norm3([Bp[0] - A[0], Bp[1] - A[1], Bp[2] - A[2]]);
      // side: horizontal, across the beam (along v for a vertical member)
      let s = [ax[2], 0, -ax[0]];
      if (Math.hypot(s[0], s[2]) < 1e-3) s = D(0, 1, 0);
      s = norm3(s);
      const t = norm3([s[1] * ax[2] - s[2] * ax[1], s[2] * ax[0] - s[0] * ax[2], s[0] * ax[1] - s[1] * ax[0]]);
      const corner = (q, i, j) => [q[0] + s[0] * i * w / 2 + t[0] * j * d / 2, q[1] + s[1] * i * w / 2 + t[1] * j * d / 2, q[2] + s[2] * i * w / 2 + t[2] * j * d / 2];
      const faces = [
        [s, [[1, -1], [1, 1]]], [[-s[0], -s[1], -s[2]], [[-1, -1], [-1, 1]]],
        [t, [[-1, 1], [1, 1]]], [[-t[0], -t[1], -t[2]], [[-1, -1], [1, -1]]],
      ];
      for (const [nn, [[i0, j0], [i1, j1]]] of faces) {
        const q0 = corner(A, i0, j0), q1 = corner(A, i1, j1), q2 = corner(Bp, i1, j1), q3 = corner(Bp, i0, j0);
        const k = [q0, q1, q2, q3].map((q) => g.v(q[0], q[1], q[2], nn, 0, col, kind));
        g.quad(k[0], k[1], k[2], k[3], nn);
      }
      for (const [q, nn] of [[A, [-ax[0], -ax[1], -ax[2]]], [Bp, ax]]) {
        const k = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => { const r = corner(q, i, j); return g.v(r[0], r[1], r[2], nn, 0, col, kind); });
        g.quad(k[0], k[1], k[2], k[3], nn);
      }
    };
    // an axis-aligned block in the crane frame
    const block = (u0, u1, v0, v1, y0, y1, col, kind) => beam([u0, (v0 + v1) / 2, (y0 + y1) / 2], [u1, (v0 + v1) / 2, (y0 + y1) / 2], v1 - v0, y1 - y0, col, kind);

    const G = 30.5, LV = 9.0;                       // rail gauge, legs at v = +-LV
    const yP = 46.0, yG = 51.5;                     // portal top, girder top
    for (const u of [0, -G]) {
      for (const v of [-LV, LV]) {
        beam([u, v, -1.5], [u, v, yP], 1.7, 1.7, steel);                   // leg
        block(u - 0.7, u + 0.7, v - 3.6, v + 3.6, -0.5, 1.8, C.dark, KIND.steel);   // gantry bogie
      }
      block(u - 0.9, u + 0.9, -LV - 0.9, LV + 0.9, yP - 3.0, yP, steel, KIND.steel);   // portal beam
    }
    for (const v of [-LV, LV]) beam([-G, v, 13.5], [0, v, 13.5], 1.2, 2.0, steel);     // sill beam
    // twin girders: backreach end to the boom hinge, then the boom
    const hingeU = 6.0, boomL = 54.0;
    const ang = c.boom_up ? 80 * Math.PI / 180 : 0;
    const tip = [hingeU + boomL * Math.cos(ang), yG - 2.0 + boomL * Math.sin(ang)];
    const mid = [hingeU + 0.5 * boomL * Math.cos(ang), yG - 2.0 + 0.5 * boomL * Math.sin(ang)];
    for (const v of [-4.0, 4.0]) {
      beam([-50.0, v, yG - 2.0], [hingeU, v, yG - 2.0], 1.8, 4.0, steel);
      beam([hingeU, v, yG - 2.0], [tip[0], v, tip[1]], 1.6, 3.2, steel);
    }
    for (const u of [-50.0, -G, 0.0]) beam([u, -4.0, yG - 0.6], [u, 4.0, yG - 0.6], 1.0, 1.0, steel);
    beam([tip[0], -4.0, tip[1]], [tip[0], 4.0, tip[1]], 1.0, 1.0, steel);
    beam([mid[0], -4.0, mid[1]], [mid[0], 4.0, mid[1]], 0.8, 0.8, steel);
    // A-frame over the seaside legs, and its stays
    const apex = [-9.0, 76.0];
    for (const v of [-3.0, 3.0]) {
      const vb = v * 1.6;
      beam([0.0, vb, yP], [apex[0], v, apex[1]], 1.3, 1.3, steel);
      beam([-24.0, vb, yP], [apex[0], v, apex[1]], 1.3, 1.3, steel);
      beam([apex[0], v, apex[1]], [tip[0], v * 1.3, tip[1] + 0.5], 0.5, 0.5, steel);     // forestays
      beam([apex[0], v, apex[1]], [mid[0], v * 1.3, mid[1] + 0.5], 0.5, 0.5, steel);
      beam([apex[0], v, apex[1]], [-50.0, v * 1.3, yG], 0.6, 0.6, steel);               // backstay
    }
    beam([apex[0], -3.6, apex[1] + 0.5], [apex[0], 3.6, apex[1] + 0.5], 1.6, 1.6, steel);
    // machinery house over the backreach, trolley (parked inboard with the boom up), cab
    block(-50.5, -35.0, -5.6, 5.6, yG, yG + 7.0, house, KIND.panel);
    const tu = c.boom_up ? -22.0 : 16.0;
    block(tu - 3.0, tu + 3.0, -4.6, 4.6, yG, yG + 2.2, C.grey, KIND.panel);
    block(tu - 1.6, tu + 1.6, 4.8, 7.4, yG - 7.6, yG - 4.2, C.white, KIND.panel);
    block(tu + 1.6, tu + 1.75, 5.0, 7.2, yG - 7.0, yG - 4.8, C.glass, KIND.dark);        // its window, to the water
    // obstruction lights: the apex and the boom tip (steady red)
    const l1 = P(apex[0], 0, apex[1] + 1.6), l2 = P(tip[0], 0, tip[1] + 1.8);
    a.lights.push([l1[0], l1[1], l1[2], Math.random()], [l2[0], l2[1], l2[2], Math.random()]);
  }

  /**
   * Compiles the programs before they show (a first use costs 0.4-0.9 s on the PC): the
   * structures with and without the sun's shadow map, the white water and the lights, each for
   * the canvas and for a render target (Post's HDR chain), as Buildings.js does.
   */
  _precompile() {
    const r = this.renderer;
    if (!r?.compile) return;
    const tmp = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(60, 1, 1, 1000);
    const g = new Geo();
    const v0 = g.v(0, 0, 0, [0, 1, 0], 0, C.rock, 0), v1 = g.v(1, 0, 0, [0, 1, 0], 0, C.rock, 0), v2 = g.v(0, 0, 1, [0, 1, 0], 0, C.rock, 0);
    g.tri(v0, v1, v2, [0, 1, 0]);
    const geo = g.geometry();
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    pg.setAttribute('aLight', new THREE.BufferAttribute(new Float32Array(2), 2));
    const objs = [new THREE.Mesh(geo, this.material), new THREE.Mesh(geo, this.foamMaterial), new THREE.Points(pg, this.lightMaterial)];
    for (const m of objs) { m.frustumCulled = false; m.receiveShadow = true; tmp.add(m); }
    const rt = new THREE.WebGLRenderTarget(1, 1);
    const done = () => { geo.dispose(); pg.dispose(); rt.dispose(); };
    const prev = r.getRenderTarget();
    const sun = this.env?.sunLight, cast = sun ? sun.castShadow : false;
    const states = sun && r.shadowMap.enabled ? [false, true] : [cast];
    const parallel = r.extensions.has('KHR_parallel_shader_compile');
    const p = [];
    try {
      for (const s of states) {
        if (sun) sun.castShadow = s;     // only for these calls: put back below, before any frame
        if (parallel) {
          p.push(r.compileAsync(tmp, cam, this.scene));
          r.setRenderTarget(rt);
          p.push(r.compileAsync(tmp, cam, this.scene));
        } else {
          r.compile(tmp, cam, this.scene);
          r.setRenderTarget(rt);
          r.compile(tmp, cam, this.scene);
        }
        r.setRenderTarget(prev);
      }
    } catch (e) {
      r.setRenderTarget(prev);
      console.warn('Shore: precompile', e);
    } finally {
      if (sun) sun.castShadow = cast;
    }
    Promise.all(p).then(done, (e) => { console.warn('Shore: precompile', e); done(); });
  }

  // ------------------------------------------------------------------------------ module API
  update(f) {
    const on = this.loaded && !this.forcedOff && this.app?.settings?.shore !== false;
    if (this.group.visible !== on) this.group.visible = on;
    if (!on) return;
    f.camera.getWorldPosition(this._cam);
    const sunY = this.env.sunDirection ? this.env.sunDirection.y : 1;
    // the cranes' lights and the lit windows by the one schedule of every light (js/env "Lights at
    // night": env.lightsOn, from just before sunset), as bright as its rule makes them (lightGain)
    const env = this.env, el = env.sunElevationDeg ?? 90;
    const kOn = env.lightsOn ?? lightsOnAt(el);
    const lightGain = env.lightGain ?? artificialLightGain(env.exposure, el);
    let vis = 0;
    for (let i = 0; i < this.areas.length; i++) {
      const A = this.areas[i];
      const near = this._cam.distanceTo(A.center) - A.radius < (A.blocks ? BLOCKS_FAR : this.Q.far);
      A.mesh.visible = near;
      if (A.foam) A.foam.visible = near && this.Q.foam && sunY > -0.2;
      if (A.lights) A.lights.visible = near && kOn > 0.01;
      if (near) vis++;
    }
    this.stats.visible = vis;
    const S = this._shore.uShore.value;
    S.x = this.terrain?.albedoGain ?? 0.7;
    S.y = this.Q.detail;
    // the sea: calmer in the morning, the sea breeze raises it in the afternoon
    const h = this.hours;
    const breeze = Math.min(1, Math.max(0, (h - 9) / 5)) * (1 - Math.min(1, Math.max(0, (h - 18) / 4)));
    S.z = 0.35 + 0.4 * breeze;
    // the blocks' lit windows: the city's share lit for the hour, each as bright as a city window
    // (Buildings.js: WINDOW_CD x kOn x lightGain / LUX_PER_UNIT; 0 by day, when none is drawn)
    S.w = litShare(h);
    this._shore.uWindowL.value = WINDOW_CD * kOn * lightGain / LUX_PER_UNIT;
    // the cranes' lights: on, time; the point-light rule (the eye's adaptation and the threshold of a
    // point light; the renderer's exposure and pixel size), as Buildings.js sets its own
    const LU = this._lightU;
    LU.uLightOn.value.set(kOn, performance.now() / 1000, 0);
    LU.uThreshold.value = env.pointThreshold ?? pointLightThreshold(el);
    LU.uExposure.value = this.renderer.toneMappingExposure || 1;
    LU.uGain.value = lightGain / LUX_PER_UNIT;
    LU.uLightsOn.value = kOn;
    const cam = f.camera;
    if (cam && cam.isPerspectiveCamera) {
      const hPx = this.renderer.getDrawingBufferSize(this._dbSize).y || 1;
      LU.uPxAngle.value = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / (cam.zoom || 1) / hPx;
    }
  }

  setTime(hours) {
    this.hours = hours;
  }

  setQuality(q) {
    if (!QUALITY[q]) return;
    this.quality = q;
    this.Q = QUALITY[q];
  }

  reset() {}

  dispose() {
    this._disposed = true;
    this.scene.remove(this.group);
    for (const A of this.areas) {
      A.mesh.geometry.dispose();
      A.foam?.geometry.dispose();
      A.lights?.geometry.dispose();
    }
    this.areas = [];
    this.material?.dispose();
    this.foamMaterial?.dispose();
    this.lightMaterial?.dispose();
  }
}
