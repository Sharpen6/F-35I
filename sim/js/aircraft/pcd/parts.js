// Cockpit parts rebuilt at load time from the glb's own geometry (Cockpit.js makes them before the
// interior analysis, so the worker's occlusion, the cockpit shadow and the paint patch take them
// like the glb's parts):
//
// * the canopy bow (frame.js): the glb's slab swept with a real section, fasteners and seals;
// * the coaming (coaming.js): a hood with a bull-nosed lip and an anti-glare top in place of the
//   glb's slab (dropped from the merged cockpit mesh), its two pads as low housings;
//
// Each new mesh takes the material of the part it replaces (no new material, no new shader
// program: nothing to compile at first sight); the replaced glb mesh is hidden (and skipped by the
// analysis, userData.ckSkip), or, inside a merged mesh, its triangles are dropped from the index.
// setEnabled(false) / dispose() put the glb's parts back. A part whose glb source is not as
// expected is left as the glb has it (a warning, `stats` says which).

import * as THREE from 'three';
import { bowRings, buildBow } from './frame.js';
import { buildCoaming } from './coaming.js';

/** Where the glb's glare shield is (glTF root frame: +X left, +Y up, +Z forward): its island of the cockpit mesh lies inside. */
const SHIELD_BOX = new THREE.Box3(new THREE.Vector3(-0.32, 0.80, 5.03), new THREE.Vector3(0.32, 0.90, 5.30));

/** New materials (interior.js INTERIOR_PAINT gives their paint; the same shader program as the cockpit's). */
const NEW_MATERIALS = ['F35_glare_shield', 'F35_canopy_fastener'];

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
    this.root.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
      const n = o.material.name || '';
      if (!this.byMat.has(n)) this.byMat.set(n, []);
      this.byMat.get(n).push(o);
    });
    const t0 = performance.now();
    this.root.updateMatrixWorld(true);
    this._rootInv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    for (const n of NEW_MATERIALS) {
      const m = new THREE.MeshStandardMaterial({ name: n, color: 0x202124, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
      this.materials.set(n, m);
    }
    this._try('bow', () => this._bow());
    this._try('coaming', () => this._coaming());
    this.stats.ms = +(performance.now() - t0).toFixed(1);
  }

  _try(name, fn) {
    try {
      this.stats[name] = fn();
    } catch (e) {
      console.warn(`Cockpit: ${name} not rebuilt:`, e.message);
      this.stats[name] = { err: e.message };
    }
  }

  /** A new mesh next to `like` (same parent, transform, material unless given, shadow flags). */
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
   * Drop the islands (welded connected parts) of `mesh` that lie inside `box` (root frame) from its
   * index. Returns their box (root frame) and triangle count, or null when none.
   */
  _trimIslands(mesh, box) {
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
    const boxes = new Map();
    for (let i = 0; i < P.count; i++) {
      const r = find(rep[i]);
      let b = boxes.get(r);
      if (!b) boxes.set(r, b = new THREE.Box3());
      b.expandByPoint(v.fromBufferAttribute(P, i).applyMatrix4(M));
    }
    const drop = new Set([...boxes].filter(([, b]) => box.containsBox(b)).map(([r]) => r));
    if (!drop.size) return null;
    const keep = [], out = new THREE.Box3();
    let n = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const r = find(rep[idx[t]]);
      if (drop.has(r)) { n++; continue; }
      keep.push(idx[t], idx[t + 1], idx[t + 2]);
    }
    for (const r of drop) out.union(boxes.get(r));
    this.trimmed.push({ geometry: g, index: g.index });
    g.setIndex(new THREE.BufferAttribute(P.count > 65535 ? Uint32Array.from(keep) : Uint16Array.from(keep), 1));
    return { box: out, tris: n };
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

  /** The glb's parts back (false) or the rebuilt ones (true). */
  setEnabled(on) {
    if (on === this.enabled) return;
    this.enabled = on;
    for (const m of this.added) m.visible = on;
    for (const m of this.hidden) m.visible = !on;
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
