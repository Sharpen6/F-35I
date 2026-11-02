// Cockpit parts rebuilt at load time from the glb's own geometry (Cockpit.js makes them before the
// interior analysis, so the worker's occlusion, the cockpit shadow and the paint patch take them
// like the glb's parts):
//
// * the canopy bow (frame.js): the glb's slab swept with a real section, fasteners and seals;
// * the coaming (coaming.js): a hood with a bull-nosed lip and an anti-glare top in place of the
//   glb's slab (dropped from the merged cockpit mesh), its two pads as low housings;
// * the seat's headbox and main beams (seat.js): rounded, with a lid, guide strips and bolts;
// * the side consoles (consoles.js): Dzus-fastened panels, one per switch row, round the glb's
//   switches, throttle and stick;
// * the canopy frame's inner face and the sills (sills.js): a liner with a retainer, a seal and a
//   bolt row along the canopy's sides, a rounded cap over the tub wall's crest;
// * the PCD's bezel (bezel.js): a moulded frame with a chamfered lip and a mullion round the glass.
//
// Each new mesh takes the material of the part it replaces, or one of NEW_MATERIALS (clones of the
// cockpit's: the same shader program, nothing to compile at first sight); the replaced glb mesh is
// hidden (and skipped by the analysis, userData.ckSkip), or, inside a merged mesh, its triangles
// are dropped from the index. setEnabled(false) / dispose() put the glb's parts back; ?ckparts=0
// leaves them all as the glb has them. A part whose glb source is not as expected is left as the
// glb has it (a warning, `stats` says which).

import * as THREE from 'three';
import { bowRings, buildBow } from './frame.js';
import { buildCoaming } from './coaming.js';
import { partBox, buildHeadbox, buildBeam } from './seat.js';
import { MeshBuilder, mergeBuilt } from './shapes.js';
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

/**
 * New materials (interior.js INTERIOR_PAINT gives their paint): clones of a glb cockpit material,
 * so that they take the same shader program as the cockpit's, before and after the interior's patch.
 */
const NEW_MATERIALS = ['F35_glare_shield', 'F35_canopy_fastener', 'F35_console_panel'];

export class CockpitParts {
  /** @param {object} o @param {object} o.visual AircraftVisual (loaded, the player's) */
  constructor({ visual }) {
    this.visual = visual;
    this.root = visual.root;
    this.enabled = true;
    this.added = [];          // new meshes
    this.hidden = [];         // glb meshes hidden
    this.trimmed = [];        // {geometry, index}: glb meshes with triangles dropped (the index before)
    this.materials = new Map();
    this.stats = {};
    this.byMat = new Map();
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('ckparts') === '0') {
      this.enabled = false;
      this.stats.off = true;
      return;
    }
    const t0 = performance.now();
    this.root.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
      const n = o.material.name || '';
      if (!this.byMat.has(n)) this.byMat.set(n, []);
      this.byMat.get(n).push(o);
    });
    this.root.updateMatrixWorld(true);
    this._rootInv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const proto = ((this.byMat.get('F35_cockpit_panel') || this.byMat.get('F35_cockpit') || [])[0] || {}).material;
    for (const n of NEW_MATERIALS) {
      const m = proto ? proto.clone() : new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
      m.name = n;
      this.materials.set(n, m);
    }
    this._try('bow', () => this._bow());
    this._try('coaming', () => this._coaming());
    this._try('seat', () => this._seat());
    this._try('consoles', () => this._consoles());
    this._try('sills', () => this._sills());
    this._try('bezel', () => this._bezel());
    this._try('merged', () => this._merge());
    this.stats.ms = +(performance.now() - t0).toFixed(1);
  }

  _try(name, fn) {
    const t0 = performance.now();
    try {
      this.stats[name] = fn();
      this.stats[name].ms = +(performance.now() - t0).toFixed(1);
    } catch (e) {
      console.warn(`Cockpit: ${name} not rebuilt:`, e.message);
      this.stats[name] = { err: e.message };
    }
  }

  /**
   * A new mesh next to `like` (same parent, transform, material unless given, shadow flags; the
   * environment makes every mesh of the jet a caster of the sun's shadow and a receiver anyway).
   */
  _add(geometry, like, name, material = like.material) {
    const m = new THREE.Mesh(geometry, material);
    m.name = name;
    m.position.copy(like.position);
    m.quaternion.copy(like.quaternion);
    m.scale.copy(like.scale);
    m.castShadow = like.castShadow;
    m.receiveShadow = like.receiveShadow;
    m.renderOrder = like.renderOrder;
    like.parent.add(m);
    this.added.push(m);
    return m;
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
      M.multiply(rest.has(o) ? new THREE.Matrix4().makeTranslation(rest.get(o)) : o.matrix);
    }
    return M;
  }

  /** mesh -> glTF root frame */
  _toRoot(mesh) { return new THREE.Matrix4().multiplyMatrices(this._rootInv, mesh.matrixWorld); }

  /** A geometry made in the root frame, moved into `mesh`'s frame. */
  _inFrameOf(geometry, mesh) {
    geometry.applyMatrix4(this._toRoot(mesh).invert());
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  /**
   * The islands (welded connected parts) of `mesh`: {idx (its index, or 0..n), tri (each triangle's
   * island), islands: [{box (root frame), tris, verts (vertex numbers)}]}.
   */
  _islands(mesh) {
    const g = mesh.geometry, P = g.attributes.position;
    const idx = g.index ? g.index.array : Uint32Array.from({ length: P.count }, (_, i) => i);
    const ids = new Map(), rep = new Int32Array(P.count);
    for (let i = 0; i < P.count; i++) {
      const k = `${Math.round(P.getX(i) * 1e4)},${Math.round(P.getY(i) * 1e4)},${Math.round(P.getZ(i) * 1e4)}`;
      let r = ids.get(k);
      if (r === undefined) { r = ids.size; ids.set(k, r); }
      rep[i] = r;
    }
    const par = Int32Array.from({ length: ids.size }, (_, i) => i);
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    for (let t = 0; t < idx.length; t += 3) {
      const a = find(rep[idx[t]]), b = find(rep[idx[t + 1]]), c = find(rep[idx[t + 2]]);
      par[b] = a; par[find(c)] = a;
    }
    const M = this._toRoot(mesh), v = new THREE.Vector3();
    const num = new Map(), islands = [];
    const of = (i) => {
      const r = find(rep[i]);
      let k = num.get(r);
      if (k === undefined) { k = islands.length; num.set(r, k); islands.push({ box: new THREE.Box3(), tris: 0, verts: [] }); }
      return k;
    };
    for (let i = 0; i < P.count; i++) {
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
   * index. Returns null when none, else {box (theirs, root frame), tris, islands: [{which (the
   * box's number), box, points ([x, y, z, ...] root frame)}]}.
   */
  _trimIslands(mesh, boxes) {
    const list = Array.isArray(boxes) ? boxes : [boxes];
    const g = mesh.geometry, P = g.attributes.position;
    const { idx, tri, islands } = this._islands(mesh);
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
    // (one record per geometry, its index as the glb had it: trimmed again, it stays the first)
    if (!this.trimmed.some((t) => t.geometry === g)) this.trimmed.push({ geometry: g, index: g.index });
    g.setIndex(new THREE.BufferAttribute(P.count > 65535 ? Uint32Array.from(keep) : Uint16Array.from(keep), 1));
    return { box: out, tris: n, islands: [...drop.values()] };
  }

  _hide(mesh) {
    mesh.visible = false;
    mesh.userData.ckSkip = true;
    this.hidden.push(mesh);
  }

  _bow() {
    const glb = (this.byMat.get('F35_canopy_bow') || [])[0];
    if (!glb) throw new Error('no canopy bow (F35_canopy_bow) in the model');
    const r = bowRings(glb.geometry);
    if (r.err) throw new Error(r.err);
    const b = buildBow(r.rings);
    this._add(b.geometry, glb, 'Canopy_Bow_Frame');
    this._add(b.fasteners, glb, 'Canopy_Bow_Fasteners', this.materials.get('F35_canopy_fastener'));
    this._hide(glb);
    return { rings: r.rings.length, tris: (b.geometry.index.count + b.fasteners.index.count) / 3, studs: b.studs, length: +b.length.toFixed(3) };
  }

  _coaming() {
    let cut = null, host = null;
    for (const m of this.byMat.get('F35_cockpit') || []) {
      cut = this._trimIslands(m, SHIELD_BOX);
      if (cut) { host = m; break; }
    }
    if (!cut) throw new Error('no glare shield in the cockpit mesh');
    const c = buildCoaming(cut.box);
    this._add(this._inFrameOf(c.hood, host), host, 'Coaming_Hood', this.materials.get('F35_glare_shield'));
    const pad = (this.byMat.get('F35_glare_pad') || [])[0];
    if (pad) {
      this._add(this._inFrameOf(c.pads, pad), pad, 'Coaming_Pads');
      this._hide(pad);
    }
    return { dropped: cut.tris, hood: c.hood.index.count / 3, pads: c.pads.index.count / 3 };
  }

  _seat() {
    const glb = (this.byMat.get('F35_seat') || [])[0];
    if (!glb) throw new Error('no seat (F35_seat) in the model');
    const names = Object.keys(SEAT_BOXES);
    const cut = this._trimIslands(glb, Object.values(SEAT_BOXES));
    if (!cut) throw new Error('no headbox or beams in the seat mesh');
    const B = new MeshBuilder(), M = new MeshBuilder(), parts = [];
    for (const isl of cut.islands) {
      const name = names[isl.which], b = partBox(isl.points);
      if (name === 'headbox') buildHeadbox(b, B);
      else buildBeam(b, name === 'beamL' ? 1 : -1, B, M);
      parts.push(name);
    }
    const body = B.geometry(), metal = M.geometry();
    this._add(this._inFrameOf(body, glb), glb, 'Seat_Rebuilt');
    if (metal.index.count) this._add(this._inFrameOf(metal, glb), glb, 'Seat_Rebuilt_Metal', this.materials.get('F35_canopy_fastener'));
    return { dropped: cut.tris, parts, tris: (body.index.count + metal.index.count) / 3 };
  }

  _consoles() {
    const host = (this.byMat.get('F35_cockpit_panel') || [])[0];
    if (!host) throw new Error('no consoles (F35_cockpit_panel) in the model');
    // the consoles: the panel mesh's tall, long boxes out at the sides
    const consoles = this._islands(host).islands.map((i) => i.box)
      .filter((b) => Math.abs(b.min.x + b.max.x) / 2 > 0.25 && b.max.y - b.min.y > 0.15 && b.max.z - b.min.z > 0.4);
    if (!consoles.length) throw new Error('no console boxes');
    // what stands on their tops: the switches (their rows), the throttle's track and the stick's base
    const boxesOf = (name) => (this.byMat.get(name) || []).flatMap((m) => this._islands(m).islands.map((i) => i.box));
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
    const base = out.base.geometry(), plates = out.plates.geometry(), fast = out.fasteners.geometry();
    this._add(this._inFrameOf(base, host), host, 'Console_Base', this.materials.get('F35_glare_shield'));
    this._add(this._inFrameOf(plates, host), host, 'Console_Panels', this.materials.get('F35_console_panel'));
    this._add(this._inFrameOf(fast, host), host, 'Console_Fasteners', this.materials.get('F35_canopy_fastener'));
    return { consoles: consoles.length, panels, tris: (base.index.count + plates.index.count + fast.index.count) / 3 };
  }

  _sills() {
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
    // the frame's inner face: the canopy's (made at rest, into the frame mesh's own frame)
    const L = new MeshBuilder(), LM = new MeshBuilder();
    const lined = buildLiner(st, L, LM);
    const inv = Mf.clone().invert();
    const bow = (this.byMat.get('F35_canopy_bow') || [])[0]?.material;
    let tris = 0;
    if (lined > 0 && bow) {
      for (const [g, mat, name] of [[L.geometry(), bow, 'Canopy_Frame_Liner'], [LM.geometry(), this.materials.get('F35_canopy_fastener'), 'Canopy_Frame_Bolts']]) {
        g.applyMatrix4(inv); g.computeBoundingBox(); g.computeBoundingSphere();
        this._add(g, frame, name, mat);
        tris += g.index.count / 3;
      }
    }
    // the sill's crest: the tub's
    const C = new MeshBuilder(), CM = new MeshBuilder();
    const capped = buildSillCap(st, C, CM, SHIELD_BOX.min.z);
    if (capped > 0) {
      const g = C.geometry(), gm = CM.geometry();
      this._add(this._inFrameOf(g, tub), tub, 'Cockpit_Sill_Cap');
      this._add(this._inFrameOf(gm, tub), tub, 'Cockpit_Sill_Screws', this.materials.get('F35_canopy_fastener'));
      tris += (g.index.count + gm.index.count) / 3;
    }
    return { stations: st.length, lined: +lined.toFixed(3), capped: +capped.toFixed(3), tris };
  }

  _bezel() {
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
    const cut = this._trimIslands(tub, box.clone().expandByScalar(0.03));
    const b = buildBezel({ c, u, v, n, hu: (box.max.x - box.min.x) / 2, hv: up.length() / 2 });
    this._add(this._inFrameOf(b.frame, tub), tub, 'PCD_Bezel', this.materials.get('F35_glare_shield'));
    this._add(this._inFrameOf(b.screws, tub), tub, 'PCD_Bezel_Screws', this.materials.get('F35_canopy_fastener'));
    return { dropped: cut ? cut.tris : 0, tris: (b.frame.index.count + b.screws.index.count) / 3 };
  }

  /**
   * The new meshes that share a parent, a transform, a material and the shadow flags merged into
   * one: the fasteners of the tub's parts are one draw, the hood, the consoles' base and the bezel
   * another, the bow and the frame's liner (both on the canopy) a third.
   */
  _merge() {
    const groups = new Map();
    for (const m of this.added) {
      m.updateMatrix();
      const key = [m.parent.uuid, m.material.uuid, m.castShadow, m.receiveShadow, m.renderOrder, ...m.matrix.elements.map((e) => e.toFixed(6))].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    const before = this.added.length, out = [];
    for (const list of groups.values()) {
      if (list.length === 1) { out.push(list[0]); continue; }
      const first = list[0];
      const m = new THREE.Mesh(mergeBuilt(list.map((x) => x.geometry)), first.material);
      m.name = list.map((x) => x.name).join('+');
      m.position.copy(first.position);
      m.quaternion.copy(first.quaternion);
      m.scale.copy(first.scale);
      m.castShadow = first.castShadow;
      m.receiveShadow = first.receiveShadow;
      m.renderOrder = first.renderOrder;
      first.parent.add(m);
      for (const x of list) { x.parent.remove(x); x.geometry.dispose(); }
      out.push(m);
    }
    this.added = out;
    return { meshes: before, draws: out.length };
  }

  /** The glb's parts back (false) or the rebuilt ones (true). */
  setEnabled(on) {
    if (on === this.enabled) return;
    this.enabled = on;
    for (const m of this.added) m.visible = on;
    for (const m of this.hidden) { m.visible = !on; m.userData.ckSkip = on; }
    for (const t of this.trimmed) {
      if (!t.cut) t.cut = t.geometry.index;
      t.geometry.setIndex(on ? t.cut : t.index);
    }
  }

  dispose() {
    this.setEnabled(false);
    for (const m of this.added) {
      m.parent?.remove(m);
      m.geometry.dispose();
    }
    this.added.length = 0;
    for (const m of this.materials.values()) m.dispose();
  }
}
