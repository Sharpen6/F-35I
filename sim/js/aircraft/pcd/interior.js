// The cockpit interior of the player's F-35I (Cockpit.js drives it):
//
// * Paint: the glb's cockpit greys (F35_cockpit #45484b and friends) and the light exterior skin on
//   the inner sills and canopy frame become a dark grey satin (FS 36231-like), the canopy bow a
//   matte dark frame, the two light pads on the glare shield dark. Original values are kept
//   (setEnabled(false)).
// * The skin's inner faces: found by interiorWorker.js (flood fill of the cockpit air from the
//   eye) and drawn by a second mesh with the interior paint (same vertex buffers, the index
//   reordered so that the skin mesh and the interior mesh each draw one range of it). Where the
//   paint meets the skin (the sills) the edge follows the 0.5 line of a per-vertex interior share,
//   a smooth line through the triangles: the faces along the edge are drawn by both meshes and the
//   interior one is cut along that line (alpha to coverage: smooth under MSAA).
// * A floor plate over the opening between the rudder pedals (the white nose gear showed through).
// * Lighting, as a shader patch on the cockpit materials (and the pilot's):
//   - ambient occlusion per vertex (the worker): the tub is lit by the sky through the canopy only,
//     with a floor (AO_FLOOR) for the light its own surfaces pass round, which the occlusion
//     counts as black;
//   - bounce and adaptation (fill): a share of the light coming in through the canopy (sun and
//     sky on the opening), spread over the tub. It stands for the interreflections and for the
//     eye's adaptation to the shade, which a single exposure for the bright outside leaves out:
//     the walls read dark grey, not black, at noon;
//   - the cockpit's own sun shadow (shadow.js): the scene's sun shadow is far too coarse in here;
//   - the display's glow: a small area light at the PCD (its physical light by day, lost in the
//     daylight, and glowGain x that at night, as a dark-adapted eye sees it);
//   - a triplanar detail (paint grain, smudges) on the painted parts.
//   Everything in view space (uniforms from the CPU in doubles: no large world coordinates).
// * The switch LEDs and the kneeboard tablet are emissive: they follow the exposure like the PCD
//   (white dots at night before), and mark their pixels as a display (alpha 0) in an HDR frame:
//   see DISPLAY_ALPHA.
//
// Everything works on the player's model only; the analysis runs once, in a worker, a fraction of
// a second after start-up, and the cockpit keeps the glb's look until it is done.

import * as THREE from 'three';
import { TRIPLANAR_GLSL } from './detail.js';
import { SHADOW_GLSL } from './shadow.js';

/** Repainted materials (sRGB colour, roughness, metalness, detail strength). */
export const INTERIOR_PAINT = {
  F35_cockpit: { color: 0x45484b, roughness: 0.6, metalness: 0, detail: 1 },
  F35_cockpit_panel: { color: 0x3a3c40, roughness: 0.52, metalness: 0, detail: 0.8 },
  // the bow and the canopy frame's liner (pcd/frame.js, sills.js): a dark satin frame whose rounded
  // edges catch the sky; the bow's sealant beads and handholds a light grey
  F35_canopy_bow: { color: 0x323437, roughness: 0.5, metalness: 0, detail: 0.4 },
  F35_canopy_fitting: { color: 0x8b8e90, roughness: 0.62, metalness: 0, detail: 0.3 },
  F35_glare_pad: { color: 0x57534b, roughness: 0.85, metalness: 0, detail: 0.6 },
  // the coaming's hood (pcd/parts.js): a flat black anti-glare finish
  F35_glare_shield: { color: 0x1e1f21, roughness: 0.93, metalness: 0, detail: 0.8 },
  // the consoles' panels (pcd/consoles.js), a shade darker than the console under them
  F35_console_panel: { color: 0x2b2d30, roughness: 0.5, metalness: 0, detail: 0.6 },
  F35_seat: { color: 0x3a3c3f, roughness: 0.62, metalness: 0, detail: 0.7 },
  F35_seat_cushion: { color: 0x575b4e, roughness: 0.92, metalness: 0, detail: 0.5 },
};
/** The interior paint on the skin's inner faces and the floor plate. */
export const INTERIOR_SKIN = { name: 'F35_cockpit_interior', color: 0x45484c, roughness: 0.62, detail: 1 };
/** Further cockpit materials that get the occlusion and the glow only (the pilot's P2_* too). */
const AO_ONLY = ['F35_yellow_black', 'F35_switch_guard', 'F35_switch', 'F35_gear_handle', 'F35_hose', 'F35_SwitchLED'];
/** Emissive materials that follow the exposure: [day, night] picture level of full emission. */
const EMISSIVE_LEVEL = { F35_SwitchLED: [0.55, 0.22], P2_TabletScreen: [0.9, 0.22] };
/**
 * Self-lit displays write alpha 0 into the frame (opaque materials write 1): a post chain can tell
 * their pixels from the scene's, e.g. to keep them in colour when its night vision (the rods)
 * greys the dark scene: the displays are photopic (hundreds of cd/m2 at the picture level they are
 * drawn at). Harmless where nothing reads it (the canvas has no alpha).
 */
export const DISPLAY_ALPHA = 0;

/** The tub's occlusion never goes below this (the light the cockpit's own surfaces pass round). */
const AO_FLOOR = 0.33;
const PCD_AREA = 0.508 * 0.203;          // m2: 20 x 8 in
// glTF root frame (+X left, +Y up, +Z forward), checked against the model at start (_checkFrame)
const FLOOR = { x: 0.36, y: 0.062, z0: 5.06, z1: 5.60 };
const BOX = { min: [-0.82, -0.25, 2.85], max: [0.82, 1.62, 6.35] };
/** Where the pilot's eye goes (offsets from the design eye, glTF frame): what it sees is interior. */
const EYE_OFFSETS = [[0, 0, 0], [0.13, -0.03, 0.04], [-0.13, -0.03, 0.04], [0, -0.08, 0.12], [0, 0.05, -0.06]];
/** Points beside and above the canopy: the cockpit air must not reach them (a gap in the model). */
const OUTSIDE = [[0, 1.55, 4.4], [0.74, 1.35, 4.2], [-0.74, 1.35, 4.2], [0, 1.4, 6.2]];

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const _m = new THREE.Matrix4(), _v = new THREE.Vector3();

export class Interior {
  /**
   * @param {object} o
   * @param {object} o.visual AircraftVisual (loaded)
   * @param {THREE.Texture} o.detail detail texture (detail.js)
   * @param {object} [o.shadowUniforms] the cockpit shadow's uniforms (shadow.js)
   * @param {number} [o.voxel] analysis voxel (m)
   * @param {number} [o.aoRays] occlusion rays per vertex
   */
  constructor({ visual, detail, shadowUniforms = null, voxel = 0.015, aoRays = 16 }) {
    this.visual = visual;
    this.root = visual.root;
    this.detail = detail;
    this.voxel = voxel;
    this.aoRays = aoRays;
    this.enabled = true;
    this.ready = false;           // analysis applied
    this.stats = null;
    this.glowGain = 120;          // the display's glow on the cockpit at night: x physical (an eye adapted to the dark sees it)
    // bounce and adaptation: this share of the light on the canopy opening, spread over the tub
    // (calibrated in the HDR frame of js/env/Post.js: the walls below the sills at noon a dark grey,
    // an 8-bit ~25-30, not black)
    this.fill = 0.2;
    this.detailAmount = 1;
    this.uniforms = {
      uCkOn: { value: 1 },
      uCkGlow: { value: new THREE.Color(0, 0, 0) },
      uCkGlowPos: { value: new THREE.Vector3() },       // view space
      uCkGlowN: { value: new THREE.Vector3(0, 0, 1) },  // view space
      uCkFill: { value: new THREE.Color(0, 0, 0) },
      uCkAoFloor: { value: AO_FLOOR },
      uCkDetail: { value: detail },
      uCkDetailOn: { value: 1 },
    };
    this.shadowUniforms = shadowUniforms;
    this._saved = new Map();      // material -> original values
    this._splits = [];
    this._patched = new Set();
    this._emissive = [];
    this._index();
    this.box = this._checkFrame();
    // the paint's linear albedo (the canopy's reflection of the interior)
    this.albedo = luminance(new THREE.Color(INTERIOR_SKIN.color));
    this.skinMaterial = new THREE.MeshStandardMaterial({
      name: INTERIOR_SKIN.name, color: INTERIOR_SKIN.color, roughness: INTERIOR_SKIN.roughness, metalness: 0, side: THREE.DoubleSide,
    });
    this.skinMaterial.userData.ckDetail = INTERIOR_SKIN.detail;
    this.skinMaterial.userData.ckEdge = true;          // cut along the interior share (ckIn), pulled over the skin
    this.skinMaterial.alphaToCoverage = true;
    // the inner side of single-sided panels (canopy frame, the fairing behind the seat): back faces,
    // drawn 1.5 mm inside the skin so that they cover its back faces
    this.backMaterial = new THREE.MeshStandardMaterial({
      name: INTERIOR_SKIN.name + '_back', color: INTERIOR_SKIN.color, roughness: INTERIOR_SKIN.roughness, metalness: 0, side: THREE.BackSide,
    });
    this.backMaterial.userData.ckDetail = INTERIOR_SKIN.detail;
    this.backMaterial.userData.ckInset = 0.0015;
    if (this.floorOk) this._addFloor();
    this._repaint();
    for (const [name, lv] of Object.entries(EMISSIVE_LEVEL)) {
      const e = this.byName.get(name);
      if (!e || !e.material.emissive) continue;
      this._emissive.push({ m: e.material, base: e.material.emissiveIntensity, lv });
      e.material.userData.ckDisplay = true;
    }
  }

  // ------------------------------------------------------------------------------ set-up
  /** The model's meshes by material name (again at start(): pcd/parts.js adds meshes and materials). */
  _index() {
    this.byName = new Map();
    this.root.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
      const n = o.material.name || '';
      if (!this.byName.has(n)) this.byName.set(n, { material: o.material, meshes: [] });
      this.byName.get(n).meshes.push(o);
    });
  }

  /**
   * The analysis box, the floor plate and the outside points are in the glTF root frame, for this
   * model: checked here against the model (the eye, the canopy glass, the pedals), the box grown
   * to hold the glass, the plate left out where it would not sit between the pedals.
   */
  _checkFrame() {
    const box = { min: BOX.min.slice(), max: BOX.max.slice() };
    const warn = (m) => console.warn('Cockpit: interior frame: ' + m);
    this.root.updateMatrixWorld(true);
    const inv = _m.copy(this.root.matrixWorld).invert();
    const eye = this.visual.eyeWorld(new THREE.Vector3()).applyMatrix4(inv);
    const inBox = (p, margin = 0) => p.x > box.min[0] + margin && p.x < box.max[0] - margin &&
      p.y > box.min[1] + margin && p.y < box.max[1] - margin && p.z > box.min[2] + margin && p.z < box.max[2] - margin;
    const glass = this.byName.get('F35_canopy_tint');
    if (glass) {
      const b = new THREE.Box3();
      for (const o of glass.meshes) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        b.union(o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld)));
      }
      const g = [b.min.toArray(), b.max.toArray()];
      let grew = false;
      for (let k = 0; k < 3; k++) {
        if (g[0][k] - 0.1 < box.min[k]) { box.min[k] = g[0][k] - 0.1; grew = true; }
        if (g[1][k] + 0.1 > box.max[k]) { box.max[k] = g[1][k] + 0.1; grew = true; }
      }
      if (grew) warn('the canopy glass reaches outside the analysis box: box grown to ' + JSON.stringify(box));
      this.glassBox = b;
    } else warn('no canopy glass (F35_canopy_tint)');
    if (!inBox(eye, 0.25)) warn('the design eye is not well inside the analysis box');
    for (const p of OUTSIDE) if (!inBox(new THREE.Vector3(...p))) warn('outside point ' + p + ' is beyond the box (a gap would go unseen)');
    // the floor plate: below the eye, under the pedals, between them
    const peds = ['Pedal_L', 'Pedal_R'].map((n) => this.root.getObjectByName(n)).filter(Boolean)
      .map((o) => o.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv));
    const dy = eye.y - FLOOR.y;
    this.floorOk = peds.length === 2 && dy > 0.7 && dy < 1.4 && peds.every((p) =>
      Math.abs(p.x) < FLOOR.x && p.z > FLOOR.z0 - 0.15 && p.z < FLOOR.z1 + 0.15 && p.y - FLOOR.y > 0.03 && p.y - FLOOR.y < 0.45);
    if (!this.floorOk) warn('the floor plate would not sit under the pedals: left out');
    this.eyeLocal = eye;
    return box;
  }

  _addFloor() {
    const g = new THREE.PlaneGeometry(2 * FLOOR.x, FLOOR.z1 - FLOOR.z0);
    g.rotateX(-Math.PI / 2);                         // normal up (+Y), plane along X / Z
    g.translate(0, FLOOR.y, (FLOOR.z0 + FLOOR.z1) / 2);
    g.setAttribute('ckIn', new THREE.BufferAttribute(new Uint8Array(g.attributes.position.count).fill(255), 1, true));
    const m = new THREE.Mesh(g, this.skinMaterial);
    m.name = 'Cockpit_FloorPlate';
    m.castShadow = true;
    m.receiveShadow = true;
    this.root.add(m);
    this.floor = m;
  }

  _repaint() {
    for (const [name, p] of Object.entries(INTERIOR_PAINT)) {
      const e = this.byName.get(name);
      if (!e || this._saved.has(e.material)) continue;
      const m = e.material;
      this._saved.set(m, { color: m.color.clone(), roughness: m.roughness, metalness: m.metalness });
      m.color.set(p.color);
      m.roughness = p.roughness;
      m.metalness = p.metalness;
      m.userData.ckDetail = p.detail;
    }
  }

  /** The cockpit meshes for the worker, positions and normals in the glTF root frame. */
  _gather() {
    const root = this.root;
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const head = root.getObjectByName('Pilot_Head');
    const inHead = (o) => { for (let x = o; x; x = x.parent) if (x === head) return true; return false; };
    const list = [];
    const M = new THREE.Matrix4(), NM = new THREE.Matrix3(), v = new THREE.Vector3();
    const box = new THREE.Box3(new THREE.Vector3(...this.box.min), new THREE.Vector3(...this.box.max));
    const wb = new THREE.Box3();
    root.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material) || inHead(o) || o.userData.ckSkip) return;
      const mat = o.material, name = mat.name || '';
      if (name.endsWith('_reflect') || name.startsWith('F35_Decal_')) return;
      const g = o.geometry;
      if (!g || !g.attributes.position) return;
      M.multiplyMatrices(inv, o.matrixWorld);
      if (!g.boundingBox) g.computeBoundingBox();
      wb.copy(g.boundingBox).applyMatrix4(M);
      if (!wb.intersectsBox(box)) return;
      const glass = mat.isShaderMaterial && name.endsWith('_tint');
      if (mat.transparent && !glass) return;
      // ('frame': the canopy bow and the frame's liner, pcd/parts.js: walls that do not shade
      // themselves, their 1.5 cm voxels would)
      const kind = glass ? 'glass' : name.startsWith('P2_') ? 'pilot' : o.userData.ckFrame ? 'frame' : 'wall';
      const P = g.attributes.position, N = g.attributes.normal;
      const pos = new Float32Array(P.count * 3), nrm = N ? new Float32Array(P.count * 3) : null;
      NM.getNormalMatrix(M);
      for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(M);
        pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
        if (N) {
          v.fromBufferAttribute(N, i).applyMatrix3(NM).normalize();
          nrm[i * 3] = v.x; nrm[i * 3 + 1] = v.y; nrm[i * 3 + 2] = v.z;
        }
      }
      const index = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: P.count }, (_, i) => i);
      const morph = !!(g.morphAttributes && g.morphAttributes.position) || o.isSkinnedMesh;
      const classify = name === 'F35_Skin_A' && !morph;
      const ao = !glass && (classify || this._wantsAO(mat) || o === this.floor);
      list.push({ mesh: o, kind, classify, ao, pos, nrm, index });
    });
    return list;
  }

  _wantsAO(m) {
    const n = m.name || '';
    if (!(m.isMeshStandardMaterial) || m.transparent) return false;
    return n in INTERIOR_PAINT || AO_ONLY.includes(n) || n.startsWith('P2_') || m === this.skinMaterial;
  }

  /**
   * Run the analysis (worker) and apply it. Resolves to the stats, or null when it failed. The
   * rebuilt parts (pcd/parts.js) are in place by now: their materials are painted first.
   */
  async start() {
    this._index();
    if (this.enabled) this._repaint();
    const list = this._gather();
    const eye = this.eyeLocal;
    const msg = {
      eye: eye.toArray(), eyes: EYE_OFFSETS.map((o) => [eye.x + o[0], eye.y + o[1], eye.z + o[2]]),
      box: this.box, voxel: this.voxel, aoRays: this.aoRays, aoDist: 1.2, outside: OUTSIDE,
      meshes: list.map((m, id) => ({ id, kind: m.kind, classify: m.classify, ao: m.ao, pos: m.pos, nrm: m.nrm, index: m.index })),
    };
    const transfer = [];
    for (const m of msg.meshes) { transfer.push(m.pos.buffer, m.index.buffer); if (m.nrm) transfer.push(m.nrm.buffer); }
    let res;
    try {
      res = await new Promise((resolve, reject) => {
        const w = new Worker(new URL('./interiorWorker.js', import.meta.url), { type: 'module' });
        w.onmessage = (e) => { w.terminate(); resolve(e.data); };
        w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'worker error')); };
        w.postMessage(msg, transfer);
      });
    } catch (e) {
      console.warn('Cockpit: interior analysis failed:', e.message);
      res = { ok: false, error: e.message };
    }
    if (this.disposed) return null;
    if (!res.ok) console.warn('Cockpit: interior analysis:', res.error);
    else if (res.leak) console.warn('Cockpit: the cockpit air reaches the outside (a gap in the model): no inner skin faces repainted');
    this._apply(list, res.ok ? res : { interior: {}, ao: {}, inside: {} });
    this.stats = res.ok ? {
      ms: Math.round(res.ms), leak: res.leak, ...res.stats,
      interiorTris: Object.values(res.interior).reduce((a, l) => a + l.length, 0),
      edgeTris: this._splits.reduce((a, s) => a + s.edge, 0),
      floor: !!this.floor,
    } : null;
    return this.stats;
  }

  _apply(list, res) {
    // ambient occlusion and interior share attributes first (the interior meshes share the skin's)
    const done = new Set();
    // (parts.js's meshes carry a fixed occlusion for the creases the voxels miss: multiplied in)
    list.forEach((m, id) => {
      const a = res.ao[id];
      const g = m.mesh.geometry;
      if (!a || done.has(g)) return;
      const cav = g.userData.ckCavity;
      if (cav && cav.length === a.length) for (let i = 0; i < a.length; i++) a[i] = Math.round(a[i] * cav[i] / 255);
      g.setAttribute('ckAO', new THREE.BufferAttribute(a, 1, true));
      done.add(g);
    });
    // the skin's inner faces
    list.forEach((m, id) => {
      const a = res.interior[id], b = res.twoFaced && res.twoFaced[id];
      if (a || b) this._split(m.mesh, a || [], b || [], res.inside && res.inside[id]);
    });
    // the patch, on every mesh of a patched material (an occlusion of 1 where none was computed)
    const mats = new Set([this.skinMaterial, this.backMaterial]);
    this.root.traverse((o) => { if (o.isMesh && o.material && !Array.isArray(o.material) && this._wantsAO(o.material)) mats.add(o.material); });
    this.root.traverse((o) => {
      if (!o.isMesh || !mats.has(o.material)) return;
      const g = o.geometry;
      if (!g.attributes.ckAO) {
        const a = new Uint8Array(g.attributes.position.count).fill(255);
        if (g.userData.ckCavity && g.userData.ckCavity.length === a.length) a.set(g.userData.ckCavity);
        g.setAttribute('ckAO', new THREE.BufferAttribute(a, 1, true));
      }
      if (o.material === this.skinMaterial && !g.attributes.ckIn) g.setAttribute('ckIn', new THREE.BufferAttribute(new Uint8Array(g.attributes.position.count).fill(255), 1, true));
    });
    for (const m of mats) this._patch(m);
    this.ready = true;
  }

  /**
   * Repaint triangles of `mesh` (one draw range of the same buffers each, the index reordered):
   * `inner` faces with the interior paint, `twoFaced` ones on their back side only. With the
   * per-vertex interior share `w` (0-255), the faces round the paint's edge (shares on both sides of
   * one half) are drawn by both meshes, the interior one cut along the half line.
   * Index order after: [skin ..., twoFaced ..., edge ..., inner ...]; the skin mesh draws the first
   * three ranges, the back mesh the second, the interior mesh the last two.
   */
  _split(mesh, inner, twoFaced, w) {
    const g = mesh.geometry;
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
    const idx = g.index, a = idx.array, n = a.length / 3;
    const kind = new Uint8Array(n);                   // 0 skin, 1 twoFaced, 2 edge, 3 inner
    for (const t of inner) kind[t] = 3;
    if (w) {
      g.setAttribute('ckIn', new THREE.BufferAttribute(w, 1, true));
      for (let t = 0; t < n; t++) {
        const lo = Math.min(w[a[t * 3]], w[a[t * 3 + 1]], w[a[t * 3 + 2]]), hi = Math.max(w[a[t * 3]], w[a[t * 3 + 1]], w[a[t * 3 + 2]]);
        if (kind[t] === 3 ? lo < 128 : hi >= 128) kind[t] = 2;
      }
    }
    for (const t of twoFaced) kind[t] = 1;
    const out = new a.constructor(a.length);
    let o = 0;
    const counts = [0, 0, 0, 0];
    for (const k of [0, 1, 2, 3]) {
      for (let t = 0; t < n; t++) {
        if (kind[t] !== k) continue;
        out[o++] = a[t * 3]; out[o++] = a[t * 3 + 1]; out[o++] = a[t * 3 + 2];
        counts[k]++;
      }
    }
    a.set(out);
    idx.needsUpdate = true;
    if (!g.boundingSphere) g.computeBoundingSphere();
    if (!g.boundingBox) g.computeBoundingBox();
    const old = { start: g.drawRange.start, count: g.drawRange.count };
    const skinCount = (counts[0] + counts[1] + counts[2]) * 3;
    g.setDrawRange(0, skinCount);
    const part = (start, count, material, suffix) => {
      if (!count) return null;
      const gi = new THREE.BufferGeometry();
      for (const k of Object.keys(g.attributes)) gi.setAttribute(k, g.attributes[k]);
      gi.setIndex(idx);
      gi.setDrawRange(start, count);
      gi.boundingSphere = g.boundingSphere.clone();
      gi.boundingBox = g.boundingBox.clone();
      const mi = new THREE.Mesh(gi, material);
      mi.name = mesh.name + suffix;
      mi.castShadow = mesh.castShadow;
      mi.receiveShadow = mesh.receiveShadow;
      mi.renderOrder = mesh.renderOrder;
      mesh.add(mi);
      return mi;
    };
    // the interior mesh needs the share on every vertex it draws: 1 where the worker gave none
    if (!g.attributes.ckIn) g.setAttribute('ckIn', new THREE.BufferAttribute(new Uint8Array(g.attributes.position.count).fill(255), 1, true));
    const back = part(counts[0] * 3, counts[1] * 3, this.backMaterial, '_interior_back');
    const mi = part((counts[0] + counts[1]) * 3, (counts[2] + counts[3]) * 3, this.skinMaterial, '_interior');
    this._splits.push({ mesh, g, old, parts: [back, mi].filter(Boolean), skinCount, inner: counts[3], edge: counts[2], twoFaced: counts[1] });
  }

  /** The shader patch: occlusion, fill, the cockpit's sun shadow, the displays' glow, the paint detail. */
  _patch(m) {
    if (this._patched.has(m)) return;
    this._patched.add(m);
    const U = this.uniforms, S = this.shadowUniforms;
    const detail = (m.userData.ckDetail || 0) > 0;
    const inset = m.userData.ckInset || 0;
    const edge = !!m.userData.ckEdge;
    const display = !!m.userData.ckDisplay;
    const amount = { value: m.userData.ckDetail || 0 };
    const prev = m.onBeforeCompile;
    const prevKey = m.customProgramCacheKey;
    m.onBeforeCompile = function (sh, r) {
      if (prev) prev.call(this, sh, r);
      for (const k of ['uCkOn', 'uCkGlow', 'uCkGlowPos', 'uCkGlowN', 'uCkFill', 'uCkAoFloor']) sh.uniforms[k] = U[k];
      if (detail) {
        sh.uniforms.uCkDetail = U.uCkDetail;
        sh.uniforms.uCkDetailOn = U.uCkDetailOn;
        sh.uniforms.uCkDetailAmt = amount;
      }
      // the cockpit's sun shadow, on the directional (and sun) lights' loop (three's chunk, patched
      // where it takes each light's colour; left out if the chunk is not as expected)
      let lights = THREE.ShaderChunk.lights_fragment_begin;
      const shadowed = !!S && /getDirectionalLightInfo\( directionalLight, directLight \);/.test(lights);
      if (shadowed) {
        for (const k of Object.keys(S)) sh.uniforms[k] = S[k];
        lights = lights
          .replace('getDirectionalLightInfo( directionalLight, directLight );', 'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= ckSunShadow( directLight.direction, geometryPosition, geometryNormal );')
          .replace('getSunLightInfo( sunLight, directLight );', 'getSunLightInfo( sunLight, directLight );\n\t\tdirectLight.color *= ckSunShadow( directLight.direction, geometryPosition, geometryNormal );');
      }
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute float ckAO;
varying float vCkAO;
${edge ? 'attribute float ckIn;\nvarying float vCkIn;' : ''}
${detail ? 'varying vec3 vCkObj;\nvarying vec3 vCkObjN;' : ''}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vCkAO = ckAO;
${edge ? 'vCkIn = ckIn;' : ''}
${inset ? `transformed -= objectNormal * ${inset.toFixed(5)};` : ''}
${detail ? 'vCkObj = position;\nvCkObjN = normal;' : ''}`)
        .replace('#include <project_vertex>', `#include <project_vertex>
${edge ? `// drawn over the skin's own faces along the paint's edge: 0.03 % nearer the eye, the same pixels
mvPosition.xyz *= 0.9997;
gl_Position = projectionMatrix * mvPosition;` : ''}`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform float uCkOn;
uniform vec3 uCkGlow;
uniform vec3 uCkGlowPos;
uniform vec3 uCkGlowN;
uniform vec3 uCkFill;
uniform float uCkAoFloor;
varying float vCkAO;
${edge ? 'varying float vCkIn;' : ''}
${shadowed ? SHADOW_GLSL : ''}
${detail ? `uniform sampler2D uCkDetail;
uniform float uCkDetailOn;
uniform float uCkDetailAmt;
varying vec3 vCkObj;
varying vec3 vCkObjN;
${TRIPLANAR_GLSL}` : ''}`)
        .replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
${edge ? `{
  // the paint's edge: the half line of the interior share, a pixel or two of coverage across it
  float ckW = max( fwidth( vCkIn ), 1e-4 );
  float ckA = smoothstep( 0.5 - ckW, 0.5 + ckW, vCkIn );
  if ( ckA <= 0.0 ) discard;
  diffuseColor.a *= ckA;
}` : ''}`)
        .replace('#include <lights_fragment_begin>', lights)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
${detail ? `if ( uCkDetailOn * uCkOn > 0.5 ) {
  // satin paint: a fine grain, and smudges (handled, wiped) a little lighter and glossier
  vec4 ckD = ckTriplanar( uCkDetail, vCkObj, vCkObjN, 0.3 );
  float ckG = ckD.b - 0.5;
  float ckS = ckD.g;
  diffuseColor.rgb *= 1.0 + uCkDetailAmt * ( 0.08 * ckG + 0.06 * ckS );
  roughnessFactor = clamp( roughnessFactor * ( 1.0 + uCkDetailAmt * ( 0.1 * ckG - 0.15 * ckS ) ), 0.08, 1.0 );
}` : ''}`)
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>
{
  // the tub sees the sky through the canopy only (per-vertex occlusion from interiorWorker.js),
  // with a floor for the light its own surfaces pass round
  float ckAo = mix( 1.0, mix( uCkAoFloor, 1.0, vCkAO ), uCkOn );
  reflectedLight.indirectDiffuse *= ckAo;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( saturate( dot( geometryNormal, geometryViewDir ) ), ckAo, material.roughness );
  #endif
  // bounce and adaptation: the light through the canopy spread over the tub (less in its corners)
  reflectedLight.indirectDiffuse += uCkFill * ( uCkOn * ( 0.55 + 0.45 * vCkAO ) ) * BRDF_Lambert( material.diffuseColor );
  // the displays' glow: the PCD as a small area light (cosine at both ends, no shadow), view space
  vec3 ckL = uCkGlowPos - geometryPosition;
  float ckD2 = dot( ckL, ckL );
  ckL *= inversesqrt( ckD2 );
  float ckK = max( dot( geometryNormal, ckL ), 0.0 ) * max( - dot( uCkGlowN, ckL ), 0.0 ) / ( ckD2 + 0.03 );
  reflectedLight.indirectDiffuse += uCkGlow * ( uCkOn * ckK * ( 0.3 + 0.7 * vCkAO ) ) * BRDF_Lambert( material.diffuseColor );
}`)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
${display ? `gl_FragColor.a = mix( gl_FragColor.a, ${DISPLAY_ALPHA.toFixed(1)}, uCkOn );   // a display (see interior.js DISPLAY_ALPHA)` : ''}`);
    };
    const key = (detail ? '|ckd' : '|ck') + (inset ? 'i' : '') + (edge ? 'e' : '') + (display ? 'D' : '') + (S ? 's' : '');
    m.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + key; };
    m.needsUpdate = true;
  }

  // ------------------------------------------------------------------------------ per frame
  /**
   * @param {object} s {exposure, sunY, power, camera, pcdGlow (THREE.Color, mean linear colour of
   *   the screen), pcdIntensity (its physical luminance at white, scene units), pcdCentre,
   *   pcdNormal (world), light {dir, color, ambient} (world: towards the sun or the moon, its
   *   irradiance, the sky's), up (the aircraft's up, world)}
   */
  update(s) {
    const U = this.uniforms;
    const day = smooth(-0.1, 0.08, s.sunY ?? 1);
    // the glow's position and normal in view space (from the camera of this frame, in doubles)
    if (s.camera && s.pcdCentre) {
      _m.copy(s.camera.matrixWorld).invert();
      U.uCkGlowPos.value.copy(s.pcdCentre).applyMatrix4(_m);
      if (s.pcdNormal) U.uCkGlowN.value.copy(s.pcdNormal).transformDirection(_m);
    }
    // the glow is the physical light by day (lost in the daylight) and glowGain x that at night
    const gain = 1 + (this.glowGain - 1) * (1 - day);
    U.uCkGlow.value.copy(s.pcdGlow || U.uCkGlow.value).multiplyScalar((s.pcdIntensity || 0) * PCD_AREA * gain);
    // the fill: a share of the irradiance on the canopy's opening (the sun on it, the sky)
    const L = s.light;
    if (L) {
      const up = s.up || _v.set(0, 1, 0);
      const sun = Math.max(0, L.dir.dot(up)) * this.fill, sky = this.fill;
      U.uCkFill.value.setRGB(L.color.r * sun + L.ambient.r * sky, L.color.g * sun + L.ambient.g * sky, L.color.b * sun + L.ambient.b * sky);
    }
    U.uCkDetailOn.value = this.detailAmount > 0 ? 1 : 0;
    // emissive parts at a picture level, whatever the exposure
    for (const e of this._emissive) {
      const level = e.lv[1] + (e.lv[0] - e.lv[1]) * day;
      e.m.emissiveIntensity = (s.power ?? 1) * level / Math.max(1e-3, s.exposure || 1);
    }
  }

  /** Back to the glb's look (and on again): paint, inner faces, floor, and the patch's terms (uCkOn). */
  setEnabled(on) {
    if (on === this.enabled) return;
    this.enabled = on;
    this.uniforms.uCkOn.value = on ? 1 : 0;
    for (const [m, o] of this._saved) {
      if (on) {
        const p = INTERIOR_PAINT[m.name];
        m.color.set(p.color); m.roughness = p.roughness; m.metalness = p.metalness;
      } else {
        m.color.copy(o.color); m.roughness = o.roughness; m.metalness = o.metalness;
      }
    }
    for (const s of this._splits) {
      for (const p of s.parts) p.visible = on;
      if (on) s.g.setDrawRange(0, s.skinCount);
      else s.g.setDrawRange(s.old.start, s.old.count);     // (all of the reordered index: the same faces)
    }
    if (this.floor) this.floor.visible = on;
    for (const e of this._emissive) if (!on) e.m.emissiveIntensity = e.base;
  }

  dispose() {
    this.disposed = true;
    this.setEnabled(false);
    for (const s of this._splits) for (const p of s.parts) s.mesh.remove(p);
    if (this.floor) {
      this.root.remove(this.floor);
      this.floor.geometry.dispose();
    }
    this.skinMaterial.dispose();
    this.backMaterial.dispose();
  }
}

/** Linear luminance of a colour (three keeps colours linear). */
function luminance(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
