// Night traffic: the head and tail lights of cars on the motorways, trunk, primary, secondary and
// tertiary roads (and their ramps) near the camera, driving along their lanes from one road
// polyline to the next (owned by js/world/Roads.js, which calls update()).
//
// Drawn with the airfield lights' sprite shader (js/world/AirportLights.js, kind 5: an intensity
// per side of the travel axis, a beam, size and brightness from the illuminance at the eye over
// the threshold), so a car is a warm white point coming towards you and a red one going away, and
// the far ones fade out as their light drops under the threshold. On from sunset (the
// floodlights' switch); nothing by day: there are no car models.
//
// Lanes: the roads worker (js/world/roadsWorker.js, roadMesh.js trafficLanes) sends, for every
// road tile it loads, those roads' centre lines with the height of the surface the ribbons are
// draped on (bridge decks included) every <= 20 m, the cross slope, and each polyline's end points
// as keys; nothing is parsed here. The ends are joined: at the end of its polyline a car carries
// on along one that starts there (mostly the straightest, a ramp now and then; never against a
// one-way road, never back), its lateral offset taken on the mitre of the two polylines (no jump
// at the joint) and easing into its lane on the new road. Where no road carries on (a tunnel, a
// smaller street, the edge of the loaded tiles) the car fades out over its last 40 m; such a car,
// one that falls behind the radius and the surplus after a quality change come back elsewhere on
// the lanes in reach, fading in. Right-hand traffic.
//
// Per frame: the cars' positions and fades on the CPU (no allocation), uploaded for the slots in
// use only. A car keeps its slot (and so its lamps' colour and intensity) for its whole drive.

import * as THREE from 'three';
import { TILE_M, CORE_HALF } from './roadMesh.js';

/** Per quality: radius around the camera (m) and the most cars. */
const QUALITY = {
  low: { radius: 1800, cars: 1200 },
  medium: { radius: 2800, cars: 3500 },
  high: { radius: 3800, cars: 7000 },
};
// per class (motorway, its ramps, trunk, its ramps, primary, secondary, tertiary): spacing per
// lane (m) and speed (m/s) of the evening traffic
const FLOW = [[70, 29], [150, 19], [95, 25], [170, 16], [120, 15], [240, 14], [380, 12]];
const isRamp = (cls) => cls === 1 || cls === 3;
const HEAD = [1.0, 0.88, 0.7];          // halogen / LED low beams, seen from ahead
const TAIL = [1.0, 0.04, 0.02];         // tail lights, seen from behind
const HEAD_CD = 500, TAIL_CD = 18;      // towards a viewer above the road (low beams aim down)
const LIFT = 0.75;                      // lamp height over the road (m)
const REFRESH = 300;                    // lanes in reach found again after the camera moved this far (m)
const FADE_IN = 2.0;                    // s
const FADE_END = 40;                    // m before a dead end
const RETIRE = 1.0;                     // s (surplus cars)
const LANE_RATE = 1.0;                  // m/s sideways when changing lanes
const KIND_VEHICLE = 5;                 // AirportLights.js shader kind

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();

function hash(a) {
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  return ((a ^ (a >>> 16)) >>> 0) / 4294967296;
}

/** One polyline of a road tile as a lane source (the worker's trafficLanes record). */
function makeLane(data, i, x0, z0, tile) {
  const f = data.first[i], n = data.count[i];
  const P = data.pts.subarray(f * 4, (f + n) * 4);
  const cls = data.info[i * 4], flags = data.info[i * 4 + 1], total = Math.max(1, data.info[i * 4 + 2]);
  const oneway = (flags & 1) !== 0;
  const cw = data.cw[i];
  const cum = new Float64Array(n);
  // unit direction of each segment (the last one repeated), then the mitre at each vertex: the
  // offset direction whose projection on both neighbouring segments' normals is 1 (polyline frame:
  // normal = right of the polyline's direction, x east, z south)
  const dx = new Float32Array(n), dz = new Float32Array(n);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let k = 0; k < n; k++) {
    const x = P[k * 4], z = P[k * 4 + 1];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    if (k === n - 1) break;
    const ex = P[k * 4 + 4] - x, ez = P[k * 4 + 5] - z, l = Math.hypot(ex, ez);
    cum[k + 1] = cum[k] + l;
    if (l > 1e-4) { dx[k] = ex / l; dz[k] = ez / l; } else if (k > 0) { dx[k] = dx[k - 1]; dz[k] = dz[k - 1]; } else { dx[k] = 1; }
  }
  dx[n - 1] = dx[n - 2]; dz[n - 1] = dz[n - 2];
  const mit = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) {
    const a = Math.max(k - 1, 0), b = Math.min(k, n - 2);
    const r1x = -dz[a], r1z = dx[a], r2x = -dz[b], r2z = dx[b];
    const den = Math.max(1 + r1x * r2x + r1z * r2z, 0.5);
    mit[k * 2] = (r1x + r2x) / den;
    mit[k * 2 + 1] = (r1z + r2z) / den;
  }
  const nDir = oneway ? total : Math.max(1, total >> 1);
  const len = cum[n - 1];
  return {
    tile, P, n, cum, mit, len, cls, oneway, nDir, lw: cw / total, hc: cw / 2,
    x0, z0, k0: data.keys[i * 2], k1: data.keys[i * 2 + 1],
    // first and last segment's direction (polyline frame)
    s0x: dx[0], s0z: dz[0], s1x: dx[n - 2], s1z: dz[n - 2],
    box: [x0 + minX, x0 + maxX, z0 + minZ, z0 + maxZ],
    weight: (len * (oneway ? nDir : 2 * nDir)) / FLOW[cls][0],
    dead: false,
  };
}

export class Traffic {
  /** roads: the Roads module (feeds addTile / dropTile); lights: the AirportLights (its material). */
  constructor({ roads, lights, env }) {
    this.roads = roads;
    this.env = env;
    this.enabled = params.get('traffic') !== '0' && !!lights;
    this.Q = QUALITY.high;
    this.stats = { cars: 0, lanes: 0, tiles: 0 };
    this._tiles = new Map();            // tile key -> its lanes
    this._ends = new Map();             // end point key -> [[lane, 0 (start) | 1 (end)], ...]
    this._active = [];                  // lanes in reach, and their cumulative spawn weights
    this._cumW = new Float64Array(0);
    this._want = 0;
    this._origin = new THREE.Vector3();
    this._refreshedAt = new THREE.Vector3(1e9, 0, 0);
    this._dirty = true;
    this._shown = false;
    this._cam = new THREE.Vector3();
    this.cars = [];
    this._free = [];                    // free slots below this._top
    this._top = 0;                      // slots in use are below this (the draw range)
    if (!this.enabled) return;

    const cap = QUALITY.high.cars;
    for (let i = 0; i < cap; i++) {
      this.cars.push({
        slot: i, live: false, lane: null, dir: 1, s: 0, seg: 0, k: 0, v: 0, vT: 0, sf: 1, speed: 0, speedT: 0,
        age: 0, retire: 0, next: null, nextDir: 1, mbx: 0, mbz: 0, mex: 0, mez: 0,
      });
    }
    const g = new THREE.BufferGeometry();
    this._pos = new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this._dir = new THREE.BufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const colA = new Float32Array(cap * 4), colB = new Float32Array(cap * 4), ext = new Float32Array(cap * 3);
    for (let i = 0; i < cap; i++) {
      // A: seen from behind (the -axis side, axis = travel): tail lights; B: from ahead: head lights
      colA.set([TAIL[0], TAIL[1], TAIL[2], TAIL_CD * (0.8 + 0.5 * hash(i * 7 + 1))], i * 4);
      colB.set([HEAD[0], HEAD[1] - 0.06 * hash(i * 3 + 2), HEAD[2] + 0.2 * hash(i * 5 + 3), HEAD_CD * (0.7 + 0.6 * hash(i * 11 + 4))], i * 4);
      ext.set([0, 0.06, 3], i * 3);      // omnidirectional share, switch group 3 (on from sunset)
    }
    g.setAttribute('position', this._pos);
    g.setAttribute('aColA', new THREE.BufferAttribute(colA, 4));
    g.setAttribute('aColB', new THREE.BufferAttribute(colB, 4));
    g.setAttribute('aDir', this._dir);
    g.setAttribute('aExt', new THREE.BufferAttribute(ext, 3));
    g.setDrawRange(0, 0);
    this.points = new THREE.Points(g, lights.material);
    this.points.name = 'Traffic';
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;
    this.points.visible = false;
    lights.group.add(this.points);
  }

  setQuality(q) {
    this.Q = QUALITY[q] || QUALITY.high;
    this._dirty = true;
  }

  /** A new start point: the cars are placed again (at once, no fade). */
  reset() {
    if (!this.enabled) return;
    for (const c of this.cars) if (c.live) this._free_(c);
    this._shown = false;
    this._dirty = true;
  }

  // ------------------------------------------------------------------------------- lanes

  /** The lanes of a road tile (roadsWorker 'lanes' message: roadMesh.js trafficLanes). */
  addTile(key, ix, iz, data) {
    if (!this.enabled) return;
    if (this._tiles.has(key)) this.dropTile(key);
    const x0 = -CORE_HALF + ix * TILE_M, z0 = -CORE_HALF + iz * TILE_M;
    const lanes = [];
    for (let i = 0; i < data.first.length; i++) {
      if (data.count[i] < 2) continue;
      const L = makeLane(data, i, x0, z0, key);
      if (!(L.len > 0.05)) continue;
      lanes.push(L);
      for (const [end, k] of [[0, L.k0], [1, L.k1]]) {
        let list = this._ends.get(k);
        if (!list) { list = []; this._ends.set(k, list); }
        list.push([L, end]);
      }
    }
    this._tiles.set(key, lanes);
    // cars heading for a dead end may have a road to carry on along now
    for (const c of this.cars) if (c.live && !c.next) this._choose(c);
    this._dirty = true;
  }

  /** A road tile the roads module dropped: its lanes go, and the cars on them. */
  dropTile(key) {
    const lanes = this._tiles.get(key);
    if (!lanes) return;
    this._tiles.delete(key);
    for (const L of lanes) {
      L.dead = true;
      for (const k of [L.k0, L.k1]) {
        const list = this._ends.get(k);
        if (!list) continue;
        const rest = list.filter(([M]) => M !== L);
        if (rest.length) this._ends.set(k, rest); else this._ends.delete(k);
      }
    }
    for (const c of this.cars) {
      if (!c.live) continue;
      if (c.lane.dead) this._free_(c);
      else if (c.next && c.next.dead) this._choose(c);
    }
    this._dirty = true;
  }

  // ------------------------------------------------------------------------------- frame

  update(cam, dt = 1 / 60) {
    if (!this.enabled || !this.roads.index) return;
    const el = this.env.sunElevationDeg ?? 30;
    if (el > 2) { this.points.visible = false; this._shown = false; return; }
    this._cam.copy(cam);
    if (this._dirty || cam.distanceToSquared(this._refreshedAt) > REFRESH * REFRESH) this._refresh(cam);
    this._move(Math.min(Math.max(dt, 0), 0.1));
    this._shown = true;
    this.points.visible = this.stats.cars > 0;
  }

  /** Lanes in reach, the number of cars they carry, cars added or retired to match. */
  _refresh(cam) {
    this._dirty = false;
    this._refreshedAt.copy(cam);
    this._origin.set(Math.round(cam.x / 100) * 100, Math.round(cam.y / 100) * 100, Math.round(cam.z / 100) * 100);
    this.points.position.copy(this._origin);
    this.points.updateMatrix();
    this.points.updateMatrixWorld(true);
    const R = this.Q.radius;
    const act = this._active;
    act.length = 0;
    let want = 0;
    for (const lanes of this._tiles.values()) {
      for (const L of lanes) {
        const [a, b, c, d] = L.box;
        const dx = Math.max(a - cam.x, 0, cam.x - b), dz = Math.max(c - cam.z, 0, cam.z - d);
        if (dx * dx + dz * dz > R * R) continue;
        act.push(L);
        want += L.weight;
      }
    }
    if (this._cumW.length < act.length) this._cumW = new Float64Array(Math.max(act.length, 2 * this._cumW.length));
    let acc = 0;
    for (let i = 0; i < act.length; i++) { acc += act[i].weight; this._cumW[i] = acc; }
    this._want = acc;
    this.stats.lanes = act.length;
    this.stats.tiles = this._tiles.size;
    // as many cars as the lanes in reach carry, within the quality's budget
    const target = act.length ? Math.min(this.Q.cars, Math.round(want)) : 0;
    let live = 0;
    for (let i = 0; i < this._top; i++) { const c = this.cars[i]; if (c.live && c.retire === 0) live++; }
    for (let i = this._top - 1; i >= 0 && live > target; i--) {
      const c = this.cars[i];
      if (c.live && c.retire === 0) { c.retire = this._shown ? RETIRE : 1e-6; live--; }
    }
    while (live < target) {
      const c = this._alloc();
      if (!c) break;
      this._spawn(c, cam, !this._shown);
      live++;
    }
  }

  _alloc() {
    let i;
    if (this._free.length) i = this._free.pop();
    else if (this._top < this.cars.length) i = this._top++;
    else return null;
    const c = this.cars[i];
    c.live = true;
    return c;
  }

  _free_(c) {
    c.live = false;
    c.lane = null;
    c.next = null;
    this._dir.array[c.slot * 4 + 2] = 0;          // drawn as nothing until used again
    if (c.slot === this._top - 1) {
      // shrink the draw range over the free slots at its end
      this._top--;
      while (this._top > 0 && !this.cars[this._top - 1].live) this._top--;
      this._free = this._free.filter((s) => s < this._top);
    } else {
      this._free.push(c.slot);
    }
  }

  /** A car somewhere on the lanes in reach: by their weights, within the radius if it can be. */
  _spawn(c, cam, instant) {
    const act = this._active, n = act.length, R = this.Q.radius;
    if (!n) { this._free_(c); return false; }              // no road in reach (over the sea)
    let L = null, s = 0, seg = 0;
    for (let tries = 0; tries < 4; tries++) {
      const r = Math.random() * this._want;
      let lo = 0, hi = n - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (this._cumW[m] < r) lo = m + 1; else hi = m; }
      L = act[lo];
      s = Math.random() * L.len;
      seg = this._segAt(L, s);
      const f = (s - L.cum[seg]) / Math.max(L.cum[seg + 1] - L.cum[seg], 1e-6);
      const x = L.x0 + L.P[seg * 4] + (L.P[seg * 4 + 4] - L.P[seg * 4]) * f - cam.x;
      const z = L.z0 + L.P[seg * 4 + 1] + (L.P[seg * 4 + 5] - L.P[seg * 4 + 1]) * f - cam.z;
      if (x * x + z * z < R * R) break;
    }
    c.lane = L;
    c.dir = L.oneway || Math.random() < 0.5 ? 1 : -1;
    c.s = s;
    c.seg = seg;
    c.k = Math.floor(Math.random() * L.nDir);
    c.vT = c.v = L.hc - (c.k + 0.5) * L.lw;
    c.sf = 0.85 + 0.3 * Math.random();
    c.speedT = c.speed = FLOW[L.cls][1] * c.sf;
    c.age = instant ? FADE_IN : 0;
    c.retire = 0;
    // offset direction at the vertex behind: the polyline's own there
    const tb = c.dir > 0 ? 0 : L.n - 1;
    c.mbx = c.dir * L.mit[tb * 2];
    c.mbz = c.dir * L.mit[tb * 2 + 1];
    this._choose(c);
    return true;
  }

  _segAt(L, s) {
    let lo = 0, hi = L.n - 2;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (L.cum[m] <= s) lo = m; else hi = m - 1; }
    return lo;
  }

  /** The road the car takes at the end of its polyline (c.next, or null), and the mitre there. */
  _choose(c) {
    const L = c.lane, end = c.dir > 0 ? 1 : 0;
    // travel direction arriving at the end
    const ix = c.dir > 0 ? L.s1x : -L.s0x, iz = c.dir > 0 ? L.s1z : -L.s0z;
    const list = this._ends.get(end ? L.k1 : L.k0);
    let total = 0, pick = null, pickDir = 1, ox = 0, oz = 0;
    if (list) {
      for (let pass = 0; pass < 2; pass++) {
        // pass 0 sums the weights, pass 1 picks one by them
        let r = Math.random() * total, acc = 0;
        for (const [M, e] of list) {
          if ((M === L && e === end) || M.dead || (e === 1 && M.oneway)) continue;
          const nd = e === 0 ? 1 : -1;
          const mx = nd > 0 ? M.s0x : -M.s1x, mz = nd > 0 ? M.s0z : -M.s1z;
          const cos = ix * mx + iz * mz;
          if (cos < -0.5) continue;                          // no U-turns or hairpins
          let w = ((1 + cos) / 2) ** 4;
          if (isRamp(M.cls) && !isRamp(L.cls)) w *= 0.2;      // off the main road: now and then
          else if (M.cls >= 5 && L.cls <= 4) w *= 0.3;
          else if (M.cls !== L.cls) w *= 0.7;
          if (pass === 0) { total += w; continue; }
          acc += w;
          if (acc >= r) { pick = M; pickDir = nd; ox = mx; oz = mz; break; }
        }
        if (total <= 0) break;
      }
    }
    c.next = pick;
    c.nextDir = pickDir;
    // offset direction at the joint: the mitre of the two travel directions (own normal at a dead end)
    const r1x = -iz, r1z = ix;
    if (pick) {
      const r2x = -oz, r2z = ox, den = Math.max(1 + r1x * r2x + r1z * r2z, 0.5);
      c.mex = (r1x + r2x) / den;
      c.mez = (r1z + r2z) / den;
    } else {
      c.mex = r1x;
      c.mez = r1z;
    }
  }

  /** Moves the car into its next polyline; false at a dead end. */
  _enter(c, over) {
    for (let guard = 0; guard < 8; guard++) {
      const M = c.next;
      if (!M || M.dead) return false;
      c.mbx = c.mex; c.mbz = c.mez;
      c.lane = M;
      c.dir = c.nextDir;
      c.k = Math.min(c.k, M.nDir - 1);
      c.vT = M.hc - (c.k + 0.5) * M.lw;
      c.speedT = FLOW[M.cls][1] * c.sf;
      this._choose(c);
      if (over <= M.len) {
        c.s = c.dir > 0 ? over : M.len - over;
        c.seg = c.dir > 0 ? 0 : M.n - 2;
        return true;
      }
      over -= M.len;                                       // a polyline shorter than this frame's travel
    }
    return false;
  }

  _move(dt = 1 / 60) {
    const pos = this._pos.array, dirA = this._dir.array;
    const ox = this._origin.x, oy = this._origin.y, oz = this._origin.z;
    const cam = this._cam, R = this.Q.radius, R0 = 0.85 * R;
    let cars = 0;
    for (let i = 0; i < this._top; i++) {
      const c = this.cars[i];
      if (!c.live) continue;
      if (c.retire > 0) {
        c.retire -= dt;
        if (c.retire <= 0) { this._free_(c); continue; }
      }
      // speed and lane changes ease in
      c.speed += Math.min(Math.max(c.speedT - c.speed, -3 * dt), 2 * dt);
      c.v += Math.min(Math.max(c.vT - c.v, -LANE_RATE * dt), LANE_RATE * dt);
      c.age += dt;
      let L = c.lane;
      const ds = c.speed * dt;
      c.s += c.dir * ds;
      if (c.s > L.len || c.s < 0) {
        const over = c.dir > 0 ? c.s - L.len : -c.s;
        if (!this._enter(c, over) && !this._spawn(c, cam, false)) continue;
        L = c.lane;
      }
      // segment (from the last one: cars move steadily)
      const n = L.n, cum = L.cum, P = L.P;
      let k = c.seg;
      while (k < n - 2 && cum[k + 1] < c.s) k++;
      while (k > 0 && cum[k] > c.s) k--;
      c.seg = k;
      const sl = cum[k + 1] - cum[k];
      const f = sl > 1e-6 ? (c.s - cum[k]) / sl : 0;
      // the offset directions at both vertices (travel frame): the joints' mitres at the ends
      const tb = c.dir > 0 ? 0 : n - 1, te = c.dir > 0 ? n - 1 : 0;
      let ax, az, bx, bz;
      if (k === tb) { ax = c.mbx; az = c.mbz; } else if (k === te) { ax = c.mex; az = c.mez; } else { ax = c.dir * L.mit[k * 2]; az = c.dir * L.mit[k * 2 + 1]; }
      const k1 = k + 1;
      if (k1 === tb) { bx = c.mbx; bz = c.mbz; } else if (k1 === te) { bx = c.mex; bz = c.mez; } else { bx = c.dir * L.mit[k1 * 2]; bz = c.dir * L.mit[k1 * 2 + 1]; }
      const v = c.v, w = c.dir * v;
      const pax = P[k * 4] + v * ax, paz = P[k * 4 + 1] + v * az, pbx = P[k1 * 4] + v * bx, pbz = P[k1 * 4 + 1] + v * bz;
      const ha = P[k * 4 + 2] + w * P[k * 4 + 3], hb = P[k1 * 4 + 2] + w * P[k1 * 4 + 3];
      const x = L.x0 + pax + (pbx - pax) * f, z = L.z0 + paz + (pbz - paz) * f, y = ha + (hb - ha) * f + LIFT;
      const dxc = x - cam.x, dzc = z - cam.z, d = Math.sqrt(dxc * dxc + dzc * dzc);
      const o3 = c.slot * 3, o4 = c.slot * 4;
      if (d > 1.08 * R && c.retire === 0) {
        // fallen behind: again elsewhere, placed from the next frame on
        dirA[o4 + 2] = 0;
        if (this._spawn(c, cam, false)) cars++;
        continue;
      }
      // fades: spawned, approaching a dead end, the radius, retiring
      let a = Math.min(1, c.age / FADE_IN);
      if (!c.next) a *= Math.min(1, (c.dir > 0 ? L.len - c.s : c.s) / FADE_END);
      if (d > R0) a *= Math.max(0, 1 - (d - R0) / (R - R0));
      if (c.retire > 0) a *= c.retire / RETIRE;
      pos[o3] = x - ox; pos[o3 + 1] = y - oy; pos[o3 + 2] = z - oz;
      // travel axis, fade, kind
      const ux = sl > 1e-6 ? (P[k1 * 4] - P[k * 4]) / sl : 1, uz = sl > 1e-6 ? (P[k1 * 4 + 1] - P[k * 4 + 1]) / sl : 0;
      dirA[o4] = ux * c.dir; dirA[o4 + 1] = uz * c.dir; dirA[o4 + 2] = a; dirA[o4 + 3] = KIND_VEHICLE;
      cars++;
    }
    this.stats.cars = cars;
    // upload the slots in use only
    const top = this._top;
    this.points.geometry.setDrawRange(0, top);
    if (top > 0) {
      this._pos.clearUpdateRanges(); this._pos.addUpdateRange(0, top * 3); this._pos.needsUpdate = true;
      this._dir.clearUpdateRanges(); this._dir.addUpdateRange(0, top * 4); this._dir.needsUpdate = true;
    }
  }

  dispose() {
    if (!this.points) return;
    this.points.parent?.remove(this.points);
    this.points.geometry.dispose();
    this._tiles.clear();
    this._ends.clear();
  }
}
