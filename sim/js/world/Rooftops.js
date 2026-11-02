// Roof items of js/world/Buildings.js: solar water heaters, water tanks, air conditioners and
// chillers on the flat roofs near the camera.
//
// Built per 800 m chunk by BuildingsWorker.js (buildRoofItems: deterministic per building, so a
// roof always looks the same; none on pitched, tiled, metal or greenhouse roofs, hangars or
// sheds) and drawn as instances of a unit box that buildingShaders.js ROOF_ITEM_VERT scales,
// turns and shapes (a collector is a wedge: the panel's slope): one draw call per chunk in view,
// and one more in the sun's shadow map while it holds the buildings (near the ground).
// Chunks within Q.range of the camera get their items; each item shrinks into its roof between
// Q.fade[0] and Q.fade[1] from the camera, where the roof's own shader blends in the items' mean
// (BUILDING_FRAG: the same share of the roof by floors), so nothing pops.
//
// Owned by Buildings (its worker, tiles, shared uniforms); off with ?roofitems=0.

import * as THREE from 'three';
import { ROOF_ITEM_VERT, ROOF_ITEM_FRAG, DEPTH_FRAG } from './buildingShaders.js';

const TILE = 6400;
const NCH = 8;
const CHUNK = TILE / NCH;
const MAX_LOADS = 2;
// range: chunks with items within it (m); fade: items full size .. gone (m from the camera)
export const ROOF_QUALITY = {
  low: { range: 1100, fade: [600, 900] },
  medium: { range: 1700, fade: [1000, 1450] },
  high: { range: 2500, fade: [1500, 2200] },
};

/** The unit box: x, z in -1..1, y 0..1, a normal per face (24 vertices). */
function unitBox() {
  const P = [], N = [], I = [];
  const faces = [
    [[1, 0, 0], [[1, 0, -1], [1, 0, 1], [1, 1, 1], [1, 1, -1]]],
    [[-1, 0, 0], [[-1, 0, 1], [-1, 0, -1], [-1, 1, -1], [-1, 1, 1]]],
    [[0, 0, 1], [[1, 0, 1], [-1, 0, 1], [-1, 1, 1], [1, 1, 1]]],
    [[0, 0, -1], [[-1, 0, -1], [1, 0, -1], [1, 1, -1], [-1, 1, -1]]],
    [[0, 1, 0], [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]]],
  ];
  for (const [n, q] of faces) {
    const b = P.length / 3;
    for (const p of q) { P.push(...p); N.push(...n); }
    // wound counter-clockwise seen from outside
    I.push(b, b + 2, b + 1, b, b + 3, b + 2);
  }
  // the winding of each face, checked against its normal (outward)
  for (let k = 0; k < I.length; k += 3) {
    const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (cr[0] * N[a] + cr[1] * N[a + 1] + cr[2] * N[a + 2] < 0) { const t = I[k + 1]; I[k + 1] = I[k + 2]; I[k + 2] = t; }
  }
  return {
    position: new THREE.BufferAttribute(new Float32Array(P), 3),
    normal: new THREE.BufferAttribute(new Float32Array(N), 3),
    index: new THREE.BufferAttribute(new Uint16Array(I), 1),
  };
}

export class Rooftops {
  /** b: the Buildings module (its worker requests, shared uniforms, env, group). */
  constructor(b) {
    this.b = b;
    const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    this.on = params.get('roofitems') !== '0';
    this.Q = ROOF_QUALITY.high;
    this.uItemFade = { value: new THREE.Vector4(this.Q.fade[0], this.Q.fade[1], 0, 0) };
    this._box = unitBox();
    this._list = [];                       // chunks with items (or loading)
    this._loads = 0;
    this._cast = false;
    this.stats = { chunks: 0, items: 0, drawn: 0, MB: 0 };
    this.material = this._material();
    this.depthMaterial = this._depthMaterial();
  }

  _material() {
    const lights = THREE.UniformsUtils.clone(THREE.UniformsLib.lights);
    return new THREE.ShaderMaterial({
      name: 'RoofItems',
      uniforms: { ...lights, ...this.b.env.uniforms, ...this.b._shared, uItemFade: this.uItemFade },
      vertexShader: ROOF_ITEM_VERT,
      fragmentShader: ROOF_ITEM_FRAG,
      lights: true,
      fog: false,
    });
  }

  _depthMaterial() {
    return new THREE.ShaderMaterial({
      name: 'RoofItemsDepth',
      uniforms: { ...this.b.env.uniforms, uItemFade: this.uItemFade },
      vertexShader: ROOF_ITEM_VERT,
      fragmentShader: DEPTH_FRAG,
      defines: { DEPTH_PASS: 1 },
    });
  }

  /** A geometry of n instances (the unit box's own copies: disposing frees them). */
  geometry(a, b, c, n) {
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex(this._box.index.clone());
    g.setAttribute('position', this._box.position.clone());
    g.setAttribute('normal', this._box.normal.clone());
    g.setAttribute('iA', new THREE.InstancedBufferAttribute(a, 4));
    g.setAttribute('iB', new THREE.InstancedBufferAttribute(b, 4));
    g.setAttribute('iC', new THREE.InstancedBufferAttribute(c, 4, true));
    g.instanceCount = n;
    return g;
  }

  setQuality(q) {
    this.Q = ROOF_QUALITY[q] || this.Q;
    this.uItemFade.value.x = this.Q.fade[0];
    this.uItemFade.value.y = this.Q.fade[1];
  }

  /** Streams the chunks' items around the camera c (world position); per frame. */
  update(c, enabled) {
    const on = this.on && enabled;
    this.b._shared.uRoofItems.value.set(this.Q.fade[0], this.Q.fade[1], on ? 1 : 0, 0);
    if (!on) { if (this._list.length) this.dropAll(); return; }
    const range = this.Q.range;
    // drop the far ones
    for (let i = this._list.length - 1; i >= 0; i--) {
      const e = this._list[i];
      const d = this._dist(e.t, e.k, c);
      e.dist = d;
      if (d > range * 1.2 || e.t.state !== 'ready') this._drop(i);
    }
    if (this._loads >= MAX_LOADS) return;
    // the nearest chunk without its items
    let want = null, wantK = 0, wantD = range;
    const tiles = this.b._tileList;
    for (let ti = 0; ti < tiles.length; ti++) {
      const t = tiles[ti];
      if (t.state !== 'ready' || !t.chunks || t.dist > range) continue;
      if (!t.roofs) t.roofs = new Map();
      for (let k = 0; k < NCH * NCH; k++) {
        if (!t.chunks[k].n || t.roofs.has(k)) continue;
        const d = this._dist(t, k, c);
        if (d < wantD) { want = t; wantK = k; wantD = d; }
      }
    }
    if (want) this._load(want, wantK);
  }

  _dist(t, k, c) {
    const info = t.chunks[k];
    const x0 = t.x0 + (k % NCH) * CHUNK, z0 = t.z0 + Math.floor(k / NCH) * CHUNK;
    const dx = c.x < x0 ? x0 - c.x : c.x > x0 + CHUNK ? c.x - x0 - CHUNK : 0;
    const dz = c.z < z0 ? z0 - c.z : c.z > z0 + CHUNK ? c.z - z0 - CHUNK : 0;
    const dy = c.y < info.lo ? info.lo - c.y : c.y > info.hi ? c.y - info.hi : 0;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  async _load(t, k) {
    const e = { t, k, state: 'loading', mesh: null, dist: 0, count: 0, bytes: 0 };
    t.roofs.set(k, e);
    this._list.push(e);
    this._loads++;
    try {
      const Q = this.b.Q;
      const m = await this.b._request({ type: 'roofs', key: t.key, chunk: k, opts: { parapets: Q.parapets, roofBoxes: Q.roofBoxes } });
      if (this.b._disposed || t.roofs?.get(k) !== e || e.state !== 'loading') return;
      const it = m.items;
      e.state = 'ready';
      if (!it.count) return;
      const g = this.geometry(it.a, it.b, it.c, it.count);
      const s = it.sphere;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(s[0], s[1], s[2]), s[3]);
      const mesh = new THREE.Mesh(g, this.material);
      mesh.name = `roofItems_${t.key}_${k}`;
      mesh.customDepthMaterial = this.depthMaterial;
      mesh.position.set(t.x0 + it.center[0], 0, t.z0 + it.center[1]);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.receiveShadow = true;
      mesh.castShadow = this._cast;
      mesh.renderOrder = 1;
      this.b.group.add(mesh);
      mesh.updateMatrixWorld(true);
      e.mesh = mesh;
      e.count = it.count;
      e.bytes = it.a.byteLength + it.b.byteLength + it.c.byteLength;
    } catch (err) {
      console.warn(`Buildings: roof items ${t.key}/${k}: ${err.message}`);
      e.state = 'failed';
    } finally {
      this._loads--;
    }
  }

  _drop(i) {
    const e = this._list[i];
    this._list.splice(i, 1);
    e.state = 'gone';
    e.t.roofs?.delete(e.k);
    if (e.mesh) {
      this.b.group.remove(e.mesh);
      e.mesh.geometry.dispose();
      e.mesh = null;
    }
  }

  /** A tile unloaded: its chunks' items go too. */
  dropTile(t) {
    for (let i = this._list.length - 1; i >= 0; i--) if (this._list[i].t === t) this._drop(i);
    t.roofs = null;
  }

  dropAll() {
    for (let i = this._list.length - 1; i >= 0; i--) this._drop(i);
  }

  /** Per drawn frame: visibility (within the fade), shadow casting as the chunks; stats. */
  prepare(cast) {
    let chunks = 0, items = 0, drawn = 0, bytes = 0;
    const far = this.Q.fade[1];
    for (let i = 0; i < this._list.length; i++) {
      const e = this._list[i];
      if (!e.mesh) continue;
      const vis = e.dist < far;
      e.mesh.visible = vis;
      if (e.mesh.castShadow !== cast) e.mesh.castShadow = cast;
      chunks++;
      items += e.count;
      bytes += e.bytes;
      if (vis) drawn += e.count;
    }
    this._cast = cast;
    const S = this.stats;
    S.chunks = chunks; S.items = items; S.drawn = drawn; S.MB = +(bytes / 1048576).toFixed(1);
  }

  /** Stand-ins for the precompile (Buildings._precompile): a mesh (colour) and a caster (depth). */
  precompileObjects() {
    const a = new Float32Array(4), b = new Uint8Array(4), c = new Uint8Array(4);
    const g = this.geometry(a, b, c, 1);
    const m = new THREE.Mesh(g, this.material);
    const d = new THREE.Mesh(g, this.material);
    d.castShadow = true;
    d.customDepthMaterial = this.depthMaterial;
    for (const o of [m, d]) { o.frustumCulled = false; o.receiveShadow = true; }
    return { mesh: m, caster: d, dispose: () => g.dispose() };
  }

  dispose() {
    this.dropAll();
    this.material.dispose();
    this.depthMaterial.dispose();
  }
}
