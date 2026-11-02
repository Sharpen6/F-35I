// Cockpit parts rebuilt at load time from the glb's own geometry (Cockpit.js builds them before
// the interior analysis, so the worker's occlusion, the cockpit shadow and the paint patch take
// them like the glb's parts):
//
// * the canopy bow (frame.js): the glb's arch swept with a slim section, sealant beads and two
//   handholds;
// * the coaming (coaming.js): a hood with a bull-nosed lip and an anti-glare top in place of the
//   glb's slab (dropped from the merged cockpit mesh), its two pads as low housings, fitted to
//   the glb's outline from the eye (the helmet's coaming line);
// * the seat's headbox and main beams (seat.js): rounded, with a lid, guide strips and bolts;
// * the side consoles (consoles.js): Dzus-fastened panels, one per switch row, round the glb's
//   switches, throttle and stick;
// * the canopy frame's inner face (sills.js: a liner with a retainer, a seal and a bolt row) and
//   the sills' crest (a rounded cap over the tub wall's top edge);
// * the PCD's bezel (bezel.js): a moulded frame with a chamfered lip and a mullion round the glass.
//
// Fastener heads are part of the surface they hold (its paint: a dome that catches the light, not
// a bright dot). Each new mesh takes the material of the part it replaces, or one of
// NEW_MATERIALS (clones of the cockpit's: the same shader program, nothing to compile at first
// sight); the replaced glb mesh is hidden (and skipped by the analysis, userData.ckSkip), or,
// inside a merged mesh, its triangles are dropped from the index. setEnabled(false) / dispose()
// put the glb's parts back; ?ckparts=0 leaves them all as the glb has them.
//
// build() makes them one part per task (each well under the 50 ms of a long task on the PC; the
// welds of the glb meshes are made once and kept), and each part is a transaction: everything is
// made first, then put in place at once, so a part whose glb source is not as expected (a
// warning, `stats` says which) leaves the glb's part exactly as it was.

import * as THREE from 'three';
import { bowRings, buildBow } from './frame.js';
import { coamingSpec, buildCoaming } from './coaming.js';
import { partBox, buildHeadbox, buildBeam } from './seat.js';
import { MeshBuilder, mergeBuilt, weld } from './shapes.js';
import { buildConsole, consoleBuilders } from './consoles.js';
import { sillSections, buildLiner, buildSillCap } from './sills.js';
import { buildBezel } from './bezel.js';

/** Where the glb's glare shield is (glTF root frame: +X left, +Y up, +Z forward): its island of the cockpit mesh lies inside. */
const SHIELD_BOX = new THREE.Box3(new THREE.Vector3(-0.32, 0.80, 5.03), new THREE.Vector3(0.32, 0.90, 5.30));

/** The seat's headbox and main beams (glTF root frame): each glb part lies inside its box. */
const SEAT_BOXES = {
  headbox: new THREE.Box3(new THREE.Vector3(-0.16, 0.97, 3.93), new THREE.Vector3(0.16, 1.26, 4.18)),
  beamL: new THREE.Box3(new THREE.Vector3(0.21, 0.26, 4.07), new THREE.Vector3(0.26, 1.17, 4.44)),
  beamR: new THREE.Box3(new THREE.Vector3(-0.26, 0.26, 4.07), new THREE.Vector3(-0.21, 1.17, 4.44)),
};

/** The design eye in the glTF root frame when the visual cannot say (rig.info.eye of f35i_rig.json). */
const DEFAULT_EYE = new THREE.Vector3(0, 1.0803, 4.4714);

/**
 * New materials (interior.js INTERIOR_PAINT gives their paint): clones of a glb cockpit material,
 * so that they take the same shader program as the cockpit's, before and after the interior's patch.
 */
export const NEW_MATERIALS = ['F35_glare_shield', 'F35_canopy_fitting', 'F35_console_panel'];

/** The parts, in build order (one task each). */
export const STEPS = ['bow', 'coaming', 'seat', 'consoles', 'stations', 'liner', 'sills', 'bezel', 'merged'];

/**
 * The draws when every part is built (after the merge: the bow and the canopy frame's liner; the
 * bow's beads and handholds; the hood, the consoles' base and the bezel; the console panels; the
 * pads; the seat; the sills' cap).
 */
export const EXPECTED_DRAWS = 7;

/** Let the browser draw and handle input between two parts (a task each). */
function nextTask() {
  const s = globalThis.scheduler;
  if (s && typeof s.yield === 'function') return s.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** What a part changes, made first and put in place at once (CockpitParts._commit). */
class Change {
  constructor() {
    this.adds = [];         // {geometry, like, parent, name, material, frame}
    this.hides = [];        // glb meshes
    this.trims = new Map(); // geometry -> its new index (BufferAttribute)
    this.removes = [];      // meshes of this.added replaced (the merge)
  }

  add(geometry, like, name, material = like.material, frame = false) {
    this.adds.push({ geometry, like, parent: like.parent, name, material, frame });
  }

  hide(mesh) { this.hides.push(mesh); }

  /** (made but not put in place: their buffers go) */
  discard() { for (const a of this.adds) a.geometry.dispose(); }
}

export class CockpitParts {
  /** @param {object} o @param {object} o.visual AircraftVisual (loaded, the player's) */
  constructor({ visual }) {
    this.visual = visual;
    this.root = visual.root;
    this.enabled = true;
    this.disposed = false;
    this.added = [];          // new meshes
    this.hidden = [];         // glb meshes hidden
    this.trimmed = [];        // {geometry, index (the glb's), cut (the index with the parts dropped)}
    this.materials = new Map();
    this.stats = {};
    this.byMat = new Map();
    this.ready = null;
    this._welds = new WeakMap();
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('ckparts') === '0') {
      this.enabled = false;
      this.stats.off = true;
      return;
    }
    this.root.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
      const n = o.material.name || '';
      if (!this.byMat.has(n)) this.byMat.set(n, []);
      this.byMat.get(n).push(o);
    });
    const proto = ((this.byMat.get('F35_cockpit_panel') || this.byMat.get('F35_cockpit') || [])[0] || {}).material;
    for (const n of NEW_MATERIALS) {
      const m = proto ? proto.clone() : new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
      m.name = n;
      this.materials.set(n, m);
    }
  }

  /**
   * Build every part, one per task. Resolves to the stats when done (or disposed on the way).
   * Called twice, the same promise.
   */
  build() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (this.stats.off) return this.stats;
      const t0 = performance.now();
      let sum = 0, max = 0;
      for (const name of STEPS) {
        // (a task of its own each, the first too: not appended to the task that called build(),
        // the model's load)
        await nextTask();
        if (this.disposed) break;
        const ms = this._step(name);
        sum += ms;
        max = Math.max(max, ms);
      }
      await nextTask();     // (and what follows, the interior's analysis, in a task of its own)
      this.stats.ms = +sum.toFixed(1);
      this.stats.maxTaskMs = +max.toFixed(1);
      this.stats.wallMs = +(performance.now() - t0).toFixed(1);
      return this.stats;
    })();
    return this.ready;
  }

  /** One part: made, then put in place (or nothing changes). Returns the time it took (ms). */
  _step(name) {
    const t0 = performance.now();
    const ch = new Change();
    try {
      const st = this['_' + name](ch);
      this._commit(ch);
      st.ms = +(performance.now() - t0).toFixed(1);
      this.stats[name] = st;
    } catch (e) {
      ch.discard();
      console.warn(`Cockpit: ${name} not rebuilt:`, e.message);
      this.stats[name] = { err: e.message };
    }
    return performance.now() - t0;
  }

  /** Put a part's change in place, all of it or (on an error half way) none of it. */
  _commit(ch) {
    const undo = [];
    try {
      for (const m of ch.removes) {
        const i = this.added.indexOf(m), parent = m.parent;
        if (i < 0) continue;
        this.added.splice(i, 1);
        parent?.remove(m);
        undo.push(() => { parent?.add(m); this.added.push(m); });
      }
      for (const a of ch.adds) {
        const m = new THREE.Mesh(a.geometry, a.material);
        m.name = a.name;
        m.position.copy(a.like.position);
        m.quaternion.copy(a.like.quaternion);
        m.scale.copy(a.like.scale);
        // (the environment makes every mesh of the jet a caster of the sun's shadow and a receiver)
        m.castShadow = a.like.castShadow;
        m.receiveShadow = a.like.receiveShadow;
        m.renderOrder = a.like.renderOrder;
        m.visible = this.enabled;
        // a 'frame' part (the bow, the canopy frame's liner) does not shade itself in the
        // interior's occlusion (its 1.5 cm voxels would)
        if (a.frame) m.userData.ckFrame = true;
        a.parent.add(m);
        this.added.push(m);
        undo.push(() => { m.parent?.remove(m); this.added.splice(this.added.indexOf(m), 1); });
      }
      for (const m of ch.hides) {
        const was = [m.visible, m.userData.ckSkip];
        if (this.enabled) { m.visible = false; m.userData.ckSkip = true; }
        this.hidden.push(m);
        undo.push(() => { [m.visible, m.userData.ckSkip] = was; this.hidden.splice(this.hidden.indexOf(m), 1); });
      }
      for (const [g, cut] of ch.trims) {
        let t = this.trimmed.find((x) => x.geometry === g);
        const before = t ? { cut: t.cut } : null;
        if (!t) { t = { geometry: g, index: g.index, cut }; this.trimmed.push(t); } else t.cut = cut;
        const idx = g.index;
        if (this.enabled) g.setIndex(cut);
        undo.push(() => {
          g.setIndex(idx);
          if (before) t.cut = before.cut; else this.trimmed.splice(this.trimmed.indexOf(t), 1);
        });
      }
    } catch (e) {
      for (let i = undo.length - 1; i >= 0; i--) { try { undo[i](); } catch { /* keep undoing */ } }
      throw e;
    }
    for (const m of ch.removes) m.geometry.dispose();
  }

  /** The design eye in the glTF root frame. */
  _eye() {
    const v = this.visual;
    if (v.object3d && typeof v.eyeWorld === 'function') {
      v.object3d.updateMatrixWorld(true);
      return v.eyeWorld(new THREE.Vector3()).applyMatrix4(new THREE.Matrix4().copy(this.root.matrixWorld).invert());
    }
    const e = v.info && (v.info.raw?.eye || v.info.eye);
    if (Array.isArray(e)) return new THREE.Vector3(-e[0], e[1], -e[2]);      // body frame -> glTF root frame
    return DEFAULT_EYE.clone();
  }

  /**
   * mesh -> glTF root frame with the rig's nodes at rest (rig.js: a node's rest is a translation,
   * every control at its default: the canopy shut), whatever the pose at load.
   */
  _restToRoot(mesh) {
    const rest = new Map((this.visual.player?.nodes || []).map((n) => [n.object, n.rest]));
    const chain = [];
    for (let o = mesh; o && o !== this.root; o = o.parent) chain.push(o);
    const M = new THREE.Matrix4();
    for (let i = chain.length - 1; i >= 0; i--) {
      const o = chain[i];
      if (!rest.has(o) && o.matrixAutoUpdate) o.updateMatrix();
      M.multiply(rest.has(o) ? new THREE.Matrix4().makeTranslation(rest.get(o)) : o.matrix);
    }
    return M;
  }

  /**
   * mesh -> glTF root frame, from the nodes' own matrices (not the world's: the jet may move
   * between two parts of the build).
   */
  _toRoot(mesh) {
    const chain = [];
    for (let o = mesh; o && o !== this.root; o = o.parent) chain.push(o);
    const M = new THREE.Matrix4();
    for (let i = chain.length - 1; i >= 0; i--) {
      const o = chain[i];
      if (o.matrixAutoUpdate) o.updateMatrix();
      M.multiply(o.matrix);
    }
    return M;
  }

  /** A geometry made in the root frame, moved into `mesh`'s frame. */
  _inFrameOf(geometry, mesh) {
    geometry.applyMatrix4(this._toRoot(mesh).invert());
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  /** The points of a mesh in the root frame: [x, y, z, ...]. */
  _points(mesh) {
    const P = mesh.geometry.attributes.position, M = this._toRoot(mesh), v = new THREE.Vector3(), out = new Float64Array(P.count * 3);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(M);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    return out;
  }

  /**
   * The islands (welded connected parts) of `mesh` under its current index (a change's pending
   * one first): {idx, tri (each triangle's island), islands: [{box (root frame), tris, verts
   * (vertex numbers)}]}.
   */
  _islands(mesh, ch = null) {
    const g = mesh.geometry, P = g.attributes.position;
    let w = this._welds.get(g);
    if (!w) { w = weld(P); this._welds.set(g, w); }
    const cur = (ch && ch.trims.get(g)) || g.index;
    const idx = cur ? cur.array : Uint32Array.from({ length: P.count }, (_, i) => i);
    const rep = w.rep;
    const par = new Int32Array(w.count);
    for (let i = 0; i < par.length; i++) par[i] = i;
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    for (let t = 0; t < idx.length; t += 3) {
      const a = find(rep[idx[t]]), b = find(rep[idx[t + 1]]), c = find(rep[idx[t + 2]]);
      par[b] = a; par[find(c)] = a;
    }
    // only the vertices the index uses (a trimmed index leaves the dropped ones unused)
    const used = new Uint8Array(P.count);
    for (let t = 0; t < idx.length; t++) used[idx[t]] = 1;
    const M = this._toRoot(mesh), v = new THREE.Vector3();
    const num = new Int32Array(w.count).fill(-1), islands = [];
    const of = (i) => {
      const r = find(rep[i]);
      if (num[r] < 0) { num[r] = islands.length; islands.push({ box: new THREE.Box3(), tris: 0, verts: [] }); }
      return num[r];
    };
    for (let i = 0; i < P.count; i++) {
      if (!used[i]) continue;
      const isl = islands[of(i)];
      isl.box.expandByPoint(v.fromBufferAttribute(P, i).applyMatrix4(M));
      isl.verts.push(i);
    }
    const tri = new Int32Array(idx.length / 3);
    for (let t = 0; t < tri.length; t++) { tri[t] = of(idx[t * 3]); islands[tri[t]].tris++; }
    return { idx, tri, islands };
  }

  /**
   * Drop the islands of `mesh` that lie inside `boxes` (a Box3 or a list, root frame) from its
   * index, in the change `ch` (put in place with it). Returns null when none, else {box (theirs,
   * root frame), tris, islands: [{which (the box's number), box, points ([x, y, z, ...] root frame)}]}.
   */
  _trimIslands(mesh, boxes, ch) {
    const list = Array.isArray(boxes) ? boxes : [boxes];
    const g = mesh.geometry, P = g.attributes.position;
    const { idx, tri, islands } = this._islands(mesh, ch);
    const M = this._toRoot(mesh), v = new THREE.Vector3();
    const drop = new Map();
    islands.forEach((isl, k) => {
      const which = list.findIndex((B) => B.containsBox(isl.box));
      if (which < 0) return;
      const points = [];
      for (const i of isl.verts) { v.fromBufferAttribute(P, i).applyMatrix4(M); points.push(v.x, v.y, v.z); }
      drop.set(k, { which, box: isl.box, points });
    });
    if (!drop.size) return null;
    const keep = [], out = new THREE.Box3();
    let n = 0;
    for (let t = 0; t < tri.length; t++) {
      if (drop.has(tri[t])) { n++; continue; }
      keep.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
    }
    for (const d of drop.values()) out.union(d.box);
    ch.trims.set(g, new THREE.BufferAttribute(P.count > 65535 ? Uint32Array.from(keep) : Uint16Array.from(keep), 1));
    return { box: out, tris: n, islands: [...drop.values()] };
  }

  // ------------------------------------------------------------------------------ the parts
  _bow(ch) {
    const glb = (this.byMat.get('F35_canopy_bow') || [])[0];
    if (!glb) throw new Error('no canopy bow (F35_canopy_bow) in the model');
    const r = bowRings(glb.geometry);
    if (r.err) throw new Error(r.err);
    const b = buildBow(r.rings);
    ch.add(b.geometry, glb, 'Canopy_Bow_Frame', glb.material, true);
    ch.add(b.fittings, glb, 'Canopy_Bow_Fittings', this.materials.get('F35_canopy_fitting'), true);
    ch.hide(glb);
    return { rings: r.rings.length, tris: (b.geometry.index.count + b.fittings.index.count) / 3, band: +(2 * b.half).toFixed(4), handholds: b.handholds, length: +b.length.toFixed(3) };
  }

  _coaming(ch) {
    let cut = null, host = null;
    for (const m of this.byMat.get('F35_cockpit') || []) {
      cut = this._trimIslands(m, SHIELD_BOX, ch);
      if (cut) { host = m; break; }
    }
    if (!cut) throw new Error('no glare shield in the cockpit mesh');
    const pad = (this.byMat.get('F35_glare_pad') || [])[0];
    const shield = Float64Array.from(cut.islands.flatMap((i) => i.points));
    const spec = coamingSpec(shield, pad ? this._points(pad) : null);
    const c = buildCoaming(spec, this._eye());
    ch.add(this._inFrameOf(c.hood, host), host, 'Coaming_Hood', this.materials.get('F35_glare_shield'));
    if (pad && c.pads) {
      ch.add(this._inFrameOf(c.pads, pad), pad, 'Coaming_Pads');
      ch.hide(pad);
    }
    return { dropped: cut.tris, hood: c.hood.index.count / 3, pads: c.pads ? c.pads.index.count / 3 : 0, fit: c.fit };
  }

  _seat(ch) {
    const glb = (this.byMat.get('F35_seat') || [])[0];
    if (!glb) throw new Error('no seat (F35_seat) in the model');
    const names = Object.keys(SEAT_BOXES);
    const cut = this._trimIslands(glb, Object.values(SEAT_BOXES), ch);
    if (!cut) throw new Error('no headbox or beams in the seat mesh');
    const B = new MeshBuilder(), parts = [];
    for (const isl of cut.islands) {
      const name = names[isl.which], b = partBox(isl.points);
      if (name === 'headbox') buildHeadbox(b, B);
      else buildBeam(b, name === 'beamL' ? 1 : -1, B, B);
      parts.push(name);
    }
    const body = B.geometry();
    ch.add(this._inFrameOf(body, glb), glb, 'Seat_Rebuilt');
    return { dropped: cut.tris, parts, tris: body.index.count / 3 };
  }

  _consoles(ch) {
    const host = (this.byMat.get('F35_cockpit_panel') || [])[0];
    if (!host) throw new Error('no consoles (F35_cockpit_panel) in the model');
    // the consoles: the panel mesh's tall, long boxes out at the sides
    const consoles = this._islands(host, ch).islands.map((i) => i.box)
      .filter((b) => Math.abs(b.min.x + b.max.x) / 2 > 0.25 && b.max.y - b.min.y > 0.15 && b.max.z - b.min.z > 0.4);
    if (!consoles.length) throw new Error('no console boxes');
    // what stands on their tops: the switches (their rows), the throttle's track and the stick's base
    const boxesOf = (name) => (this.byMat.get(name) || []).flatMap((m) => this._islands(m, ch).islands.map((i) => i.box));
    const switches = boxesOf('F35_switch'), features = boxesOf('F35_cockpit');
    const out = consoleBuilders();
    let panels = 0;
    const _c = new THREE.Vector3();
    for (const b of consoles) {
      const c = { x0: b.min.x, x1: b.max.x, z0: b.min.z, z1: b.max.z, y: b.max.y };
      const on = (f) => f.min.x >= c.x0 - 1e-3 && f.max.x <= c.x1 + 1e-3 && f.min.z >= c.z0 && f.max.z <= c.z1 && f.min.y > c.y - 0.01 && f.min.y < c.y + 0.03;
      const zs = switches.filter(on).map((f) => f.getCenter(_c).z).sort((a, b2) => a - b2);
      const rows = [];
      for (const z of zs) {
        const r = rows[rows.length - 1];
        if (r && z - r.z1 < 0.02) { r.z1 = z; r.sum += z; r.n++; } else rows.push({ z1: z, sum: z, n: 1 });
      }
      const holes = features.filter((f) => on(f) && (f.max.x - f.min.x) * (f.max.z - f.min.z) > 0.002)
        .map((f) => ({ x0: f.min.x, x1: f.max.x, z0: f.min.z, z1: f.max.z }));
      panels += buildConsole(c, rows.map((r) => r.sum / r.n), holes, out);
    }
    const base = out.base.geometry(), plates = out.plates.geometry();
    ch.add(this._inFrameOf(base, host), host, 'Console_Base', this.materials.get('F35_glare_shield'));
    ch.add(this._inFrameOf(plates, host), host, 'Console_Panels', this.materials.get('F35_console_panel'));
    return { consoles: consoles.length, panels, fasteners: out.heads, tris: (base.index.count + plates.index.count) / 3 };
  }

  /** The sections the liner and the sills' cap are made from (sills.js), once. */
  _sillStations() {
    if (this._st) return this._st;
    const under = (o, name) => { for (; o; o = o.parent) if (o.name === name) return true; return false; };
    const tub = (this.byMat.get('F35_cockpit') || [])[0];
    const frame = (this.byMat.get('F35_Skin_A') || []).find((m) => under(m, 'Canopy'));
    const glass = [...(this.byMat.get('F35_canopy_tint') || []), ...(this.byMat.get('F35_canopy') || [])][0];
    if (!tub || !frame || !glass) throw new Error('no tub, canopy frame or canopy glass in the model');
    const Mf = this._restToRoot(frame);
    const st = sillSections({
      tub: { geometry: tub.geometry, matrix: this._toRoot(tub) },
      frame: { geometry: frame.geometry, matrix: Mf },
      glass: { geometry: glass.geometry, matrix: this._restToRoot(glass) },
    }, 3.2, 5.5);
    this._st = { st, tub, frame, Mf };
    return this._st;
  }

  /** The sections first, in a task of their own (nothing to put in place). */
  _stations() {
    return { stations: this._sillStations().st.length };
  }

  /** The canopy frame's inner face: the canopy's (made at rest, into the frame mesh's own frame). */
  _liner(ch) {
    const { st, frame, Mf } = this._sillStations();
    const L = new MeshBuilder();
    const lined = buildLiner(st, L, L);
    const bow = (this.byMat.get('F35_canopy_bow') || [])[0]?.material;
    if (!(lined > 0) || !bow) throw new Error('no canopy frame to line');
    const g = L.geometry();
    g.applyMatrix4(Mf.clone().invert());
    g.computeBoundingBox();
    g.computeBoundingSphere();
    ch.add(g, frame, 'Canopy_Frame_Liner', bow, true);
    return { stations: st.length, lined: +lined.toFixed(3), tris: g.index.count / 3 };
  }

  /** The sills' crest: the tub's. */
  _sills(ch) {
    const { st, tub } = this._sillStations();
    const C = new MeshBuilder();
    const capped = buildSillCap(st, C, C, SHIELD_BOX.min.z);
    if (!(capped > 0)) throw new Error('no sill to cap');
    const g = C.geometry();
    ch.add(this._inFrameOf(g, tub), tub, 'Cockpit_Sill_Cap');
    return { stations: st.length, capped: +capped.toFixed(3), tris: g.index.count / 3 };
  }

  _bezel(ch) {
    const screen = [...(this.byMat.get('F35_PCD_Screen_live') || []), ...(this.byMat.get('F35_PCD_Screen') || [])][0];
    const tub = (this.byMat.get('F35_cockpit') || [])[0];
    if (!screen || !tub) throw new Error('no PCD glass or cockpit mesh in the model');
    // the glass's rectangle (root frame; it leans back about x only)
    const P = screen.geometry.attributes.position, M = this._toRoot(screen), pts = [];
    for (let i = 0; i < P.count; i++) pts.push(new THREE.Vector3().fromBufferAttribute(P, i).applyMatrix4(M));
    const box = new THREE.Box3().setFromPoints(pts);
    const lo = pts.reduce((a, p) => (p.y < a.y ? p : a)), hi = pts.reduce((a, p) => (p.y > a.y ? p : a));
    const up = new THREE.Vector3(0, hi.y - lo.y, hi.z - lo.z);
    const v = up.clone().normalize(), u = new THREE.Vector3(1, 0, 0);
    const n = new THREE.Vector3().crossVectors(u, v);
    if (n.z > 0) n.negate();
    const c = box.getCenter(new THREE.Vector3());
    // the glb's frame and divider round it: dropped from the cockpit mesh
    const cut = this._trimIslands(tub, box.clone().expandByScalar(0.03), ch);
    const b = buildBezel({ c, u, v, n, hu: (box.max.x - box.min.x) / 2, hv: up.length() / 2 });
    ch.add(this._inFrameOf(b.frame, tub), tub, 'PCD_Bezel', this.materials.get('F35_glare_shield'));
    return { dropped: cut ? cut.tris : 0, tris: b.frame.index.count / 3, screws: b.screws };
  }

  /**
   * The new meshes that share a parent, a transform, a material, the shadow flags and the
   * occlusion kind merged into one: the hood, the consoles' base and the bezel are one draw, the
   * bow and the frame's liner (both on the canopy) another.
   */
  _merged(ch) {
    const groups = new Map();
    for (const m of this.added) {
      m.updateMatrix();
      const key = [m.parent.uuid, m.material.uuid, m.castShadow, m.receiveShadow, m.renderOrder, !!m.userData.ckFrame, ...m.matrix.elements.map((e) => e.toFixed(6))].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    let draws = 0;
    for (const list of groups.values()) {
      draws++;
      if (list.length === 1) continue;
      const first = list[0];
      ch.add(mergeBuilt(list.map((x) => x.geometry)), first, list.map((x) => x.name).join('+'), first.material, !!first.userData.ckFrame);
      ch.removes.push(...list);
    }
    return { meshes: this.added.length, draws };
  }

  /** The glb's parts back (false) or the rebuilt ones (true). */
  setEnabled(on) {
    if (on === this.enabled) return;
    this.enabled = on;
    for (const m of this.added) m.visible = on;
    for (const m of this.hidden) { m.visible = !on; m.userData.ckSkip = on; }
    for (const t of this.trimmed) t.geometry.setIndex(on ? t.cut : t.index);
  }

  dispose() {
    this.disposed = true;
    this.setEnabled(false);
    for (const m of this.added) {
      m.parent?.remove(m);
      m.geometry.dispose();
    }
    this.added.length = 0;
    for (const m of this.materials.values()) m.dispose();
  }
}
