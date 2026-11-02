// Runway surfaces: the paved runways, their shoulders and blast pads drawn over the terrain's
// procedural runway paint (js/terrain/terrainShaders.js runwayShade, a uniform asphalt grey),
// as real ones look from the cockpit, on the approach and from the tower.
//
//   const rw = new Runways({renderer, scene, camera, env, terrain, app});   // main.js: one line
//   rw.update(f); rw.setQuality('high'); rw.dispose();
//
// Data: data/world/airfields/runways.json and runways.bin (sim/tools/world/airfields.py stage
// "runways", format in sim/tools/world/ROADS.md): per runway the shoulders, overruns, concrete
// ends, arresting gear cables, distance-remaining signs, crossings, taxiway turn-offs, the
// inset lights, and a strip of the terrain's imagery along it with the paint taken out (the
// pavement's own tone, light and dark sections, the rubber the satellite sees). Without the data
// the module draws nothing and the terrain's paint shows as before.
//
// Rendering: one mesh per airfield, its runway rectangles cut out of the terrain's 25 m
// triangles (js/world/runwayMesh.js), built one runway per frame after load; shaded in the
// runway frame (js/world/runwayShaders.js) and faded into the imagery at 9-11 km (high). By day
// the things standing on the airfield (edge and threshold light fixtures, distance-remaining
// and arresting gear signs) are small instanced meshes (js/world/runwayFixtures.js).
//
// URL parameter: runways=0 turns it off (the terrain's own runway paint shows).

import * as THREE from 'three';
import { drapeRunway } from './runwayMesh.js';
import { RUNWAY_VERT, runwayFrag, STRIP_PAD, DATA_W, MAX_TURNS, MAX_CROSS } from './runwayShaders.js';
import { makeNoiseData, NOISE_SIZE } from './roadMesh.js';
import { RunwayFixtures } from './runwayFixtures.js';
import { HORIZON_GLSL } from '../terrain/horizonMap.js';

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();

/**
 * Per quality: the 3D distance (m) the surfaces are drawn to, the share of it used for the
 * fade-out, shading detail (0..1: patches, turn-off marks, grain), fixtures' range (m).
 * The terrain's own paint fades out at 5-9 km: on high the overlay covers it until it is gone.
 */
const QUALITY = {
  low: { range: 7000, fade: 0.25, detail: 0.5, fixtures: 900 },
  medium: { range: 9500, fade: 0.22, detail: 0.8, fixtures: 1500 },
  high: { range: 11000, fade: 0.2, detail: 1.0, fixtures: 2200 },
};
/**
 * The pavement's albedo, from how light the imagery shows it (runways.json "tone": the clean
 * pavement's linear luminance in the satellite mosaic). The mosaic's 10 m pixels over a runway mix
 * in its paint and the soil beside it, and the terrain's albedo gain is tuned for soil and plants:
 * taken as it is, a runway comes out as light as the sand around it (0.3-0.45). Aged asphalt is
 * 0.10-0.18 (sun-bleached with a light limestone aggregate up to ~0.2), concrete 0.2-0.3, so the
 * imagery's tone only places a runway in that range (its darkest runways ~0.10, its lightest ~0.2)
 * and its light and dark sections are kept relative to it (runwayShaders.js).
 */
const PAVE = { lo: 0.10, hi: 0.20, toneLo: 0.4, toneHi: 0.9 };
const paveAlbedo = (tone) => PAVE.lo + (PAVE.hi - PAVE.lo) * Math.min(1, Math.max(0, (tone - PAVE.toneLo) / (PAVE.toneHi - PAVE.toneLo)));
const GLYPHS = '0123456789LRC';

/** Designator code of the terrain's shader: number + 100 x (1 L, 2 R, 3 C). */
function designator(id) {
  const m = /^(\d{1,2})([LRC]?)$/.exec(String(id || '').trim());
  if (!m) return 0;
  return Number(m[1]) + 100 * (m[2] ? 'LRC'.indexOf(m[2]) + 1 : 0);
}

/**
 * Runway digits and letters in a 4 x 4 grid of square cells, white on black, in a heavy condensed
 * sans like the painted ones (each glyph fills the middle 60 % of its cell's width: the same
 * layout as the terrain's GLYPHS layer, js/terrain/detailTextures.js).
 */
function glyphTexture(renderer) {
  const size = 512, G = 4;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const cell = size / G;
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i < GLYPHS.length; i++) {
    g.save();
    g.translate((i % G + 0.5) * cell, (Math.floor(i / G) + 0.5) * cell);
    g.scale(0.62, 1.0);
    g.font = `bold ${Math.round(cell * 1.12)}px "Arial Black", "Helvetica Neue", Arial, "DejaVu Sans", sans-serif`;
    g.fillText(GLYPHS[i], 0, cell * 0.04);
    g.restore();
  }
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  t.name = 'RunwayGlyphs';
  return t;
}

export class Runways {
  constructor({ renderer, scene, camera, env, terrain, app, baseUrl = 'data/world/' }) {
    this.name = 'runways';
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.env = env;
    this.terrain = terrain;
    this.app = app;
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    // off with ?runways=0, and on the stand-in terrain of ?stubs=1 (no height field to drape on)
    this.enabled = params.get('runways') !== '0' && !!terrain.hf;
    this.credits = '';
    this.quality = 'high';
    this.Q = QUALITY.high;
    this.ready = false;
    this.data = null;
    this.stats = { runways: 0, airfields: 0, triangles: 0, building: 0, fixtures: 0, bytes: 0, buildMs: 0, buildMaxMs: 0 };
    this.group = new THREE.Group();
    this.group.name = 'Runways';
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);
    this._queue = [];
    this._acc = null;          // the airfield being built: its runways draped so far
    this._meshes = [];
    this._layers = 1;
    this._disposed = false;

    // placeholders until the data is in (the material compiles against them)
    const one = (arr, type = THREE.UnsignedByteType) => { const t = new THREE.DataTexture(arr, 1, 1, THREE.RGBAFormat, type); t.needsUpdate = true; return t; };
    this._stripTex = one(new Uint8Array([128, 128, 128, 0]));
    this._dataTex = one(new Float32Array(4), THREE.FloatType);
    this._noiseTex = null;
    this._glyphTex = this.enabled ? glyphTexture(renderer) : one(new Uint8Array(4));
    this.uniforms = {
      uStrip: { value: this._stripTex },
      uRwData: { value: this._dataTex },
      uNoise: { value: this._stripTex },
      uGlyphs: { value: this._glyphTex },
      uFade: { value: new THREE.Vector4(8800, 11000, 1, 1) },
    };
    // with the terrain's own shadows (hills at a low sun) when it has horizon maps. Made once and
    // kept: a first material swapped for this one when a dynamic import of horizonMap.js came in,
    // and disposed, deleted its programs while the driver was still linking them in parallel
    // (KHR_parallel_shader_compile on the PC: "glGetProgramiv: Program object expected" in the
    // console), and the warm-up's replay of its precompile scene built two more for it
    const hz = terrain.horizon && terrain.horizon.uniforms ? { uniforms: terrain.horizon.uniforms, glsl: HORIZON_GLSL } : null;
    this.material = this._makeMaterial(hz);
    this.fixtures = this.enabled ? new RunwayFixtures({ renderer, scene, env, terrain, glyphs: this._glyphTex }) : null;
    if (this.enabled) {
      // the programs are built by the warm-up's pass (warmup() below); made after it (the module's
      // import came late), now, and finished in the background
      const w = app && app.warmup;
      if (w && w.done) {
        const mark = w.nextId ? w.nextId() : -1;
        this.warmup(w, camera);
        if (mark >= 0) w.finish?.(mark).catch(() => {});
      }
      this._load();
    }
  }

  _makeMaterial(horizon = null) {
    const lights = THREE.UniformsUtils.clone(THREE.UniformsLib.lights);
    return new THREE.ShaderMaterial({
      name: 'Runways',
      uniforms: { ...lights, ...this.env.uniforms, ...this.uniforms, ...(horizon ? horizon.uniforms : {}) },
      vertexShader: RUNWAY_VERT,
      fragmentShader: runwayFrag(horizon ? horizon.glsl : ''),
      lights: true,
      fog: false,
      // opaque list after the terrain, before the roads (renderOrder), blended: the soft edges
      // and the distance fade mix into the terrain under them
      transparent: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      depthWrite: true,
    });
  }

  /**
   * The programs of the surfaces and the fixtures, built ahead (js/env/warmup.js calls this at
   * start-up behind the loading screen, as Roads.js warmup): stand-ins (to three only the
   * material, the kind of object and whether the geometry has normals select the program), lit
   * with the sun casting shadows (by day) and without (night), into the target the frame is drawn
   * into, and the depth program the fixtures cast the sun's shadow with. A Group, which the
   * warm-up compiles once (a Scene compiled before its pass is compiled again in it). A quality
   * change moves only ranges and uniforms.
   */
  warmup(w, camera) {
    if (!this.enabled) return;
    const tmp = new THREE.Group();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    const mesh = new THREE.Mesh(g, this.material);
    mesh.receiveShadow = true;
    tmp.add(mesh);
    const fg = this.fixtures?.addPrecompile(tmp);
    try {
      w.compile(tmp, camera, { scene: this.scene });
      w.compileDepth?.(tmp, camera);
    } finally {
      g.dispose();
      fg?.dispose();
    }
  }

  async _load() {
    const B = this.baseUrl + 'airfields/';
    let doc = null, bin = null;
    try {
      const r = await fetch(B + 'runways.json');
      if (r.ok) doc = await r.json();
      if (doc && doc.strip) {
        const rb = await fetch(B + (doc.strip.file || 'runways.bin'));
        if (rb.ok) bin = new Uint8Array(await rb.arrayBuffer());
      }
    } catch (e) { /* no data: off */ }
    if (this._disposed) return;
    if (!doc || !bin || !Array.isArray(doc.runways)) {
      console.warn('Runways: no data/world/airfields/runways.json (sim/tools/world/airfields.py --stages runways); the terrain paints the runways');
      return;
    }
    this.data = doc;
    this.stats.bytes = bin.length;
    const S = doc.strip.samples, R = doc.strip.rows, NL = doc.strip.layers;
    if (bin.length < S * R * NL * 4 || R !== 32) { console.warn('Runways: runways.bin does not match runways.json'); return; }
    // the strips in one atlas, STRIP_PAD rows repeated above and below each (mip levels 1, 2
    // stay inside a runway's own rows)
    const RH = R + 2 * STRIP_PAD;
    const atlas = new Uint8Array(S * RH * NL * 4);
    for (let l = 0; l < NL; l++) {
      for (let y = 0; y < RH; y++) {
        const src = Math.min(R - 1, Math.max(0, y - STRIP_PAD));
        atlas.set(bin.subarray(((l * R) + src) * S * 4, ((l * R) + src + 1) * S * 4), ((l * RH) + y) * S * 4);
      }
    }
    const strip = new THREE.DataTexture(atlas, S, RH * NL, THREE.RGBAFormat, THREE.UnsignedByteType);
    strip.colorSpace = THREE.NoColorSpace;            // sRGB values, decoded in the shader
    strip.magFilter = THREE.LinearFilter;
    strip.minFilter = THREE.LinearMipmapLinearFilter;
    strip.generateMipmaps = true;
    strip.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    strip.wrapS = strip.wrapT = THREE.ClampToEdgeWrapping;
    strip.name = 'RunwayStrips';
    strip.needsUpdate = true;
    this._layers = NL;
    // noise (the roads' generator: r grain, g blotches, b streaks, a large patches)
    const noise = new THREE.DataTexture(makeNoiseData(NOISE_SIZE), NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
    noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
    noise.magFilter = THREE.LinearFilter;
    noise.minFilter = THREE.LinearMipmapLinearFilter;
    noise.generateMipmaps = true;
    noise.anisotropy = Math.min(16, this.renderer.capabilities.getMaxAnisotropy());
    noise.colorSpace = THREE.NoColorSpace;
    noise.name = 'RunwayNoise';
    noise.needsUpdate = true;
    this._noiseTex = noise;

    // match the records with the terrain's runways (positions, overruns as the terrain has them)
    const list = (this.terrain.runways && this.terrain.runways.list) || [];
    const recs = [];
    for (const rec of doc.runways) {
      const tr = list.find((r) => r.icao === rec.icao && r.ends[0].id === rec.ids[0] && r.ends[1].id === rec.ids[1]);
      if (!tr) continue;
      recs.push({ rec, tr, row: recs.length });
    }
    // per runway: DATA_W texels of RGBA32F (runwayShaders.js reads them by column)
    const N = Math.max(1, recs.length);
    const D = new Float32Array(DATA_W * N * 4);
    const put = (row, col, a, b, c, d) => D.set([a, b, c, d], (row * DATA_W + col) * 4);
    const byIcao = new Map();
    for (const { rec, tr, row } of recs) {
      const flags = (rec.military ? 1 : 0) | (rec.closed ? 2 : 0) | (rec.lit ? 4 : 0) | (rec.cl?.[0] ? 8 : 0) | (rec.cl?.[1] ? 16 : 0)
        | (rec.tdzl?.[0] ? 32 : 0) | (rec.tdzl?.[1] ? 64 : 0);
      put(row, 0, rec.len, rec.hw, rec.sh, rec.layer);
      put(row, 1, rec.ov[0], rec.ov[1], rec.disp[0], rec.disp[1]);
      put(row, 2, rec.conc[0], rec.conc[1], rec.rubber[0], rec.rubber[1]);
      put(row, 3, rec.strip[0], rec.strip[1], rec.strip[2], rec.wear ?? 0.5);
      put(row, 4, flags, designator(rec.ids[0]), designator(rec.ids[1]), 0);
      const turns = (rec.turns || []).slice(0, MAX_TURNS), cross = (rec.cross || []).slice(0, MAX_CROSS);
      put(row, 5, rec.cables?.[0] ?? -1, rec.cables?.[1] ?? -1, turns.length, cross.length);
      put(row, 6, Math.max(rec.tone || 0.6, 0.05), paveAlbedo(rec.tone || 0.6), 0, 0);
      turns.forEach((v, k) => put(row, 8 + k, v[0], v[1], v[2], v[3]));
      cross.forEach((v, k) => { put(row, 24 + 2 * k, v[0], v[1], v[2], v[3]); put(row, 25 + 2 * k, v[4], v[5], v[6], 0); });
      if (!byIcao.has(rec.icao)) byIcao.set(rec.icao, []);
      byIcao.get(rec.icao).push({ rec, tr, row });
    }
    // depth priority inside an airfield: the longer runway over the shorter where they cross
    for (const rs of byIcao.values()) {
      rs.slice().sort((a, b) => a.rec.len - b.rec.len).forEach((x, k) => { D[(x.row * DATA_W + 4) * 4 + 3] = Math.min(k, 2); });
    }
    const data = new THREE.DataTexture(D, DATA_W, N, THREE.RGBAFormat, THREE.FloatType);
    data.magFilter = data.minFilter = THREE.NearestFilter;
    data.generateMipmaps = false;
    data.needsUpdate = true;
    this.uniforms.uStrip.value = strip;
    this.uniforms.uRwData.value = data;
    this.uniforms.uNoise.value = noise;
    this._stripTex.dispose();
    this._dataTex.dispose();
    this._stripTex = strip;
    this._dataTex = data;
    this._queue = [...byIcao.entries()];
    this._recs = recs;
    this.stats.runways = recs.length;
    this.stats.building = this._queue.length;
    this.fixtures?.setRunways(recs);
    this.ready = true;
  }

  /**
   * Drapes one runway of the airfield at the head of the queue (one per frame: ~5-75 ms each on
   * the loaded 4-core test VM); once all its runways are in, makes the airfield's mesh.
   */
  _buildNext() {
    const [icao, rs] = this._queue[0];
    const t0 = performance.now();
    if (!this._acc) {
      let cx = 0, cz = 0;
      for (const { tr } of rs) { cx += tr.cx; cz += tr.cz; }
      this._acc = { k: 0, cx: cx / rs.length, cz: cz / rs.length, tris: 0, out: { pos: [], st: [], nrm: [], rw: [], idx: [] } };
    }
    const A = this._acc;
    const { rec, tr, row } = rs[A.k++];
    const hf = this.terrain.hf;
    const a = tr.ends[0];
    A.tris += drapeRunway({
      x0: a.x, z0: a.z, ux: tr.ux, uz: tr.uz,
      sMin: -rec.ov[0] - 1.5, sMax: rec.len + rec.ov[1] + 1.5, tMax: rec.hw + rec.sh + 1.5,
    }, (i, j) => hf.coreSample(i, j), [A.cx, A.cz], row, A.out);
    if (A.k < rs.length) {
      this._noteBuild(t0);
      return;
    }
    this._queue.shift();
    this._acc = null;
    const { out, cx, cz, tris } = A;
    if (tris) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
      g.setAttribute('aST', new THREE.Float32BufferAttribute(out.st, 2));
      g.setAttribute('aNrm', new THREE.Float32BufferAttribute(out.nrm, 2));
      g.setAttribute('aRw', new THREE.Float32BufferAttribute(out.rw, 1));
      g.setIndex(out.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(out.idx, 1) : new THREE.Uint16BufferAttribute(out.idx, 1));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, this.material);
      mesh.name = `Runways ${icao}`;
      mesh.position.set(cx, 0, cz);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      // after the terrain (L0 tiles -10, base 0), before the roads' taxiways and aprons (1)
      mesh.renderOrder = 0.9;
      this.group.add(mesh);
      this._meshes.push(mesh);
      this.stats.triangles += tris;
      this.stats.airfields++;
    }
    this._noteBuild(t0);
  }

  _noteBuild(t0) {
    const ms = performance.now() - t0;
    this.stats.building = this._queue.length;
    this.stats.buildMs += ms;
    this.stats.buildMaxMs = Math.max(this.stats.buildMaxMs, ms);
  }

  // -------------------------------------------------------------------------------------- module API

  /** The runway whose surface (pavement, shoulders, overruns) is at world x, z: "LLEK 18/36", or null (tests). */
  covers(x, z) {
    for (const { rec, tr } of this._recs || []) {
      const a = tr.ends[0], dx = x - a.x, dz = z - a.z;
      const s = dx * tr.ux + dz * tr.uz, t = -dx * tr.uz + dz * tr.ux;
      if (s >= -rec.ov[0] && s <= rec.len + rec.ov[1] && Math.abs(t) <= rec.hw + rec.sh) return `${rec.icao} ${rec.ids[0]}/${rec.ids[1]}`;
    }
    return null;
  }

  setQuality(q) {
    this.quality = QUALITY[q] ? q : 'high';
    this.Q = QUALITY[this.quality];
    this.fixtures?.setRange(this.Q.fixtures);
  }

  update(f) {
    if (!this.enabled || !this.ready) return;
    if (this._queue.length) this._buildNext();
    const Q = this.Q;
    this.uniforms.uFade.value.set(Q.range * (1 - Q.fade), Q.range, Q.detail, this._layers);
    this.fixtures?.update(f);
    this.stats.fixtures = this.fixtures ? this.fixtures.stats.instances : 0;
  }

  dispose() {
    this._disposed = true;
    for (const m of this._meshes) m.geometry.dispose();
    this._meshes.length = 0;
    this.material.dispose();
    this._stripTex.dispose();
    this._dataTex.dispose();
    this._noiseTex?.dispose();
    this._glyphTex.dispose();
    this.fixtures?.dispose();
    this.scene.remove(this.group);
  }
}
