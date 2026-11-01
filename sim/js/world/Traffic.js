// Night traffic: the head and tail lights of cars on the motorways, trunk and primary roads near
// the camera, moving along their lanes (owned by js/world/Roads.js, which calls update()).
//
// Drawn with the airfield lights' sprite shader (js/world/AirportLights.js: an intensity per side
// of the travel axis, size and brightness from the illuminance at the eye over the threshold), so
// a car is a warm white point coming towards you and a red one going away, and the far ones fade
// out as their light drops under the threshold. On from sunset (the floodlights' switch); nothing
// by day: there are no car models.
//
// Lanes come from the same road tiles (fetched again, from the browser's cache), right-hand
// traffic, heights from the terrain at least every 20 m. A car's position is a function of the
// clock (phase + speed * t along its lane), so rebuilding the set as the camera moves keeps the
// cars that stay where they were.

import * as THREE from 'three';
import { parseRoadTile, TILE_M, CORE_HALF } from './roadMesh.js';

/** Per quality: radius around the camera (m) and the most cars drawn. */
const QUALITY = {
  low: { radius: 1800, cars: 1200 },
  medium: { radius: 2800, cars: 3500 },
  high: { radius: 3800, cars: 7000 },
};
// per class (motorway, its links, trunk, its links, primary): spacing per lane (m), speed (m/s)
const FLOW = [[70, 29], [150, 19], [95, 25], [170, 16], [120, 15]];
const HEAD = [1.0, 0.88, 0.7];          // halogen / LED low beams, seen from ahead
const TAIL = [1.0, 0.04, 0.02];         // tail lights, seen from behind
const HEAD_CD = 500, TAIL_CD = 18;      // towards a viewer above the road (low beams aim down)
const LIFT = 0.75;                      // lamp height (m)
const STEP = 20;                        // lane height samples (m)
const REBUILD = 450;                    // rebuild the car set after the camera moved this far (m)

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();

function hash(a) {
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  return ((a ^ (a >>> 16)) >>> 0) / 4294967296;
}

export class Traffic {
  /** roads: the Roads module (baseUrl, index); lights: the AirportLights (its material). */
  constructor({ roads, lights, terrain, env }) {
    this.roads = roads;
    this.terrain = terrain;
    this.env = env;
    this.enabled = params.get('traffic') !== '0' && !!lights;
    this.Q = QUALITY.high;
    this.stats = { cars: 0, lanes: 0, tiles: 0 };
    this._tiles = new Map();            // 'ix,iz' -> {state, lanes}
    this._cars = null;                  // {lane: Int32Array, phase, speed: Float32Array, seg: Int32Array}
    this._lanes = [];
    this._origin = new THREE.Vector3();
    this._built = new THREE.Vector3(1e9, 0, 0);
    this._dirty = true;
    this._t0 = performance.now();
    if (!this.enabled) return;

    const cap = QUALITY.high.cars;
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

  update(cam) {
    if (!this.enabled || !this.roads.index) return;
    const el = this.env.sunElevationDeg ?? 30;
    if (el > 2) { this.points.visible = false; return; }
    const R = this.Q.radius;
    // tiles near the camera: load (once) and drop far ones
    const i0 = Math.max(0, Math.floor((cam.x - R + CORE_HALF) / TILE_M)), i1 = Math.min(15, Math.floor((cam.x + R + CORE_HALF) / TILE_M));
    const j0 = Math.max(0, Math.floor((cam.z - R + CORE_HALF) / TILE_M)), j1 = Math.min(15, Math.floor((cam.z + R + CORE_HALF) / TILE_M));
    for (let iz = j0; iz <= j1; iz++) for (let ix = i0; ix <= i1; ix++) this._tile(ix, iz);
    for (const [k, t] of this._tiles) {
      const [ix, iz] = k.split(',').map(Number);
      if (ix < i0 - 1 || ix > i1 + 1 || iz < j0 - 1 || iz > j1 + 1) this._tiles.delete(k);
    }
    if (this._dirty || cam.distanceTo(this._built) > REBUILD) this._rebuild(cam);
    this._move();
    this.points.visible = this.stats.cars > 0;
  }

  _tile(ix, iz) {
    const key = `${ix},${iz}`;
    if (this._tiles.has(key)) return;
    const t = { state: 'loading', lanes: [] };
    this._tiles.set(key, t);
    if (!(this.roads.index.files && this.roads.index.files[key])) { t.state = 'ready'; return; }
    fetch(`${this.roads.baseUrl}roads/tile_${ix}_${iz}.bin`)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((buf) => {
        if (this._tiles.get(key) !== t) return;
        if (buf) t.lanes = this._lanesOf(parseRoadTile(buf), ix, iz);
        t.state = 'ready';
        this._dirty = true;
      })
      .catch(() => { t.state = 'ready'; });
  }

  /** The lanes of a tile's main roads: world points every <= STEP m, lengths, offset, direction. */
  _lanesOf(tile, ix, iz) {
    const x0 = -CORE_HALF + ix * TILE_M, z0 = -CORE_HALF + iz * TILE_M;
    const out = [];
    for (const pl of tile.polylines) {
      if (pl.cls > 4 || pl.n < 2) continue;
      // centre line, resampled for heights
      const xs = [], zs = [];
      for (let k = 0; k < pl.n; k++) {
        const x = x0 + tile.points[(pl.first + k) * 2] * 0.1, z = z0 + tile.points[(pl.first + k) * 2 + 1] * 0.1;
        if (k > 0) {
          const px = xs[xs.length - 1], pz = zs[zs.length - 1];
          const m = Math.ceil(Math.hypot(x - px, z - pz) / STEP);
          for (let s = 1; s < m; s++) { xs.push(px + (x - px) * s / m); zs.push(pz + (z - pz) * s / m); }
        }
        xs.push(x); zs.push(z);
      }
      const n = xs.length;
      const P = new Float64Array(n * 3), cum = new Float64Array(n);
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let k = 0; k < n; k++) {
        P[k * 3] = xs[k]; P[k * 3 + 1] = this.terrain.heightAt(xs[k], zs[k]) + LIFT; P[k * 3 + 2] = zs[k];
        if (k) cum[k] = cum[k - 1] + Math.hypot(xs[k] - xs[k - 1], zs[k] - zs[k - 1]);
        minX = Math.min(minX, xs[k]); maxX = Math.max(maxX, xs[k]); minZ = Math.min(minZ, zs[k]); maxZ = Math.max(maxZ, zs[k]);
      }
      const len = cum[n - 1];
      if (len < 30) continue;
      const lanes = Math.max(1, pl.lanes), lw = pl.cw / lanes, hc = pl.cw / 2;
      const base = { P, cum, len, cls: pl.cls, box: [minX, maxX, minZ, maxZ] };
      if (pl.flags & 1) {
        for (let k = 0; k < lanes; k++) out.push({ ...base, v: -hc + (k + 0.5) * lw, dir: 1 });
      } else {
        const half = Math.max(1, Math.floor(lanes / 2));
        for (let k = 0; k < half; k++) {
          out.push({ ...base, v: (k + 0.5) * lw, dir: 1 });      // right-hand traffic
          out.push({ ...base, v: -(k + 0.5) * lw, dir: -1 });
        }
      }
    }
    return out;
  }

  /** The cars on the lanes within reach: deterministic per lane, thinned to the quality's budget. */
  _rebuild(cam) {
    this._dirty = false;
    this._built.copy(cam);
    this._origin.set(Math.round(cam.x / 100) * 100, Math.round(cam.y / 100) * 100, Math.round(cam.z / 100) * 100);
    this.points.position.copy(this._origin);
    this.points.updateMatrix();
    this.points.updateMatrixWorld(true);
    const R = this.Q.radius;
    const lanes = [];
    let want = 0;
    let tileCount = 0;
    for (const t of this._tiles.values()) {
      if (t.state === 'ready') tileCount++;
      for (const L of t.lanes) {
        const [a, b, c, d] = L.box;
        const dx = Math.max(a - cam.x, 0, cam.x - b), dz = Math.max(c - cam.z, 0, cam.z - d);
        if (dx * dx + dz * dz > R * R) continue;
        lanes.push(L);
        want += L.len / FLOW[L.cls][0];
      }
    }
    const thin = Math.max(1, want / this.Q.cars);
    const lane = [], phase = [], speed = [];
    for (let li = 0; li < lanes.length; li++) {
      const L = lanes[li];
      const [spacing, v] = FLOW[L.cls];
      // a stable seed per lane (its geometry), so the same cars come back after a rebuild
      const seed = Math.floor(L.P[0] * 7 + L.P[2] * 13 + L.v * 101 + L.dir * 17) | 0;
      const nCars = Math.floor(L.len / (spacing * thin) + hash(seed));
      for (let k = 0; k < nCars; k++) {
        if (lane.length >= this.Q.cars) break;
        lane.push(li);
        phase.push(L.len * (k + 0.8 * hash(seed + k * 31)) / Math.max(nCars, 1));
        speed.push(v * (0.85 + 0.3 * hash(seed + k * 57 + 3)));
      }
    }
    this._lanes = lanes;
    this._cars = { lane: Int32Array.from(lane), phase: Float64Array.from(phase), speed: Float32Array.from(speed), seg: new Int32Array(lane.length) };
    this.stats.cars = lane.length;
    this.stats.lanes = lanes.length;
    this.stats.tiles = tileCount;
    this.points.geometry.setDrawRange(0, lane.length);
  }

  _move() {
    const C = this._cars;
    if (!C || !C.lane.length) return;
    const t = (performance.now() - this._t0) / 1000;
    const pos = this._pos.array, dir = this._dir.array;
    const ox = this._origin.x, oy = this._origin.y, oz = this._origin.z;
    for (let i = 0; i < C.lane.length; i++) {
      const L = this._lanes[C.lane[i]];
      let s = (C.phase[i] + C.speed[i] * t) % L.len;
      if (L.dir < 0) s = L.len - s;
      // segment: from the last one, forwards or backwards (cars move steadily)
      const cum = L.cum, n = cum.length;
      let k = Math.min(C.seg[i], n - 2);
      while (k < n - 2 && cum[k + 1] < s) k++;
      while (k > 0 && cum[k] > s) k--;
      C.seg[i] = k;
      const P = L.P;
      const sl = cum[k + 1] - cum[k];
      const f = sl > 1e-6 ? (s - cum[k]) / sl : 0;
      const ax = P[k * 3], ay = P[k * 3 + 1], az = P[k * 3 + 2];
      const bx = P[k * 3 + 3], by = P[k * 3 + 4], bz = P[k * 3 + 5];
      const ux = sl > 1e-6 ? (bx - ax) / sl : 1, uz = sl > 1e-6 ? (bz - az) / sl : 0;
      // the lane: v to the right of the polyline (right = (-uz, ux) with x east, z south)
      pos[i * 3] = ax + (bx - ax) * f - uz * L.v - ox;
      pos[i * 3 + 1] = ay + (by - ay) * f - oy;
      pos[i * 3 + 2] = az + (bz - az) * f + ux * L.v - oz;
      // travel axis, beam half width (rad), kind 0
      dir[i * 4] = ux * L.dir;
      dir[i * 4 + 1] = uz * L.dir;
      dir[i * 4 + 2] = 0.55;
      dir[i * 4 + 3] = 0;
    }
    this._pos.needsUpdate = true;
    this._dir.needsUpdate = true;
  }

  dispose() {
    if (!this.points) return;
    this.points.parent?.remove(this.points);
    this.points.geometry.dispose();
  }
}
