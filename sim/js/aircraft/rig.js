// RigPlayer: moves the F-35I's glTF nodes the way the Blender rig (F35I_Rig) moves them.
//
// f35i_rig.json (written by sim/tools/aircraft/export_glb.py, format in sim/tools/aircraft/README.md)
// holds, for every moving node, how it moves with each control, sampled from the Blender drivers with
// all other controls at their defaults. Everything is in the glTF model frame and relative to the
// node's rest position (rest = all controls at default: gear down, surfaces neutral, canopy shut):
//
//   node.hinge = {pivot, axis, min, max} and node.controls[c] = {a: [angle per sample]}
//       one hinge line for all of the node's controls: angles add, then clamp to [min, max]
//       (control surfaces: the Blender drivers clamp the mixed stick / pedal / flap command)
//   node.controls[c] = {pivot, axis, a: [...]}          a hinge of its own for this control
//   node.controls[c] = {q: [[x,y,z,w], ...], t: [[x,y,z], ...]}   a general rigid motion (gear legs)
//   node.controls[c] = {spin: {pivot, axis, rate}}      angle = rate * value (wheels and roll_distance)
//   controls[c].x = sample positions (ascending, shared by every node the control moves)
//
// A node's transform is  T(rest) * L(outermost control) * ... * L(innermost control), the order of
// rig.compose listing the innermost first (a wheel spins inside its strut, the strut inside the
// retracting leg). That is how the Blender bone chain combines them, so combined controls compose.
// Morph targets (the nozzle's AB_Open) are sampled the same way: rig.morphs[node][target][control].

import * as THREE from 'three';

/** Segment index i and fraction f of value v among ascending sample positions xs (clamped). */
export function locate(xs, v) {
  const n = xs.length;
  if (n < 2 || !(v > xs[0])) return [0, 0];          // also catches NaN
  if (v >= xs[n - 1]) return [n - 2, 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= v) lo = mid; else hi = mid;
  }
  return [lo, (v - xs[lo]) / (xs[hi] - xs[lo])];
}

/** Linear interpolation of a sampled scalar. */
export function interp(xs, ys, v) {
  if (ys.length === 1) return ys[0];
  const [i, f] = locate(xs, v);
  return ys[i] + (ys[i + 1] - ys[i]) * f;
}

const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _t = new THREE.Vector3();
const _ta = new THREE.Vector3();
const _tb = new THREE.Vector3();

/** Rigid transform (rotation q, then translation t). */
class Rigid {
  constructor() { this.q = new THREE.Quaternion(); this.t = new THREE.Vector3(); }
  /** this = this * (q, t) */
  mul(q, t) {
    _t.copy(t).applyQuaternion(this.q);
    this.t.add(_t);
    this.q.multiply(q);
    return this;
  }
}

/** Rotation by angle a about the line through pivot p along unit axis u, as (q, t) in _q/_t. */
function aboutLine(p, u, a) {
  _q.setFromAxisAngle(u, a);
  _t.copy(p).applyQuaternion(_q).negate().add(p);      // t = p - R p
}

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

export class RigPlayer {
  /**
   * @param {object} rig     parsed f35i_rig.json
   * @param {THREE.Object3D} root   the glTF scene; nodes are found by name
   */
  constructor(rig, root) {
    this.rig = rig;
    this.values = {};                 // current control values, rig units (m, rad, 0..1)
    this.defaults = {};
    for (const [name, c] of Object.entries(rig.controls)) {
      this.values[name] = c.default;
      this.defaults[name] = c.default;
    }
    const order = new Map((rig.compose || []).map((c, i) => [c, i]));
    this.nodes = [];
    this.missing = [];
    for (const [name, nd] of Object.entries(rig.nodes)) {
      const object = root.getObjectByName(name);
      if (!object) { this.missing.push(name); continue; }
      const rest = v3(nd.rest || [object.position.x, object.position.y, object.position.z]);
      const entry = { name, object, rest, hinge: null, parts: [] };
      if (nd.hinge) {
        const parts = Object.entries(nd.controls).map(([c, d]) => ({ control: c, xs: rig.controls[c].x, a: d.a }));
        // The clamp is the Blender drivers' limit on a MIXED command (stick + pedals + flaps). A node
        // moved by one control needs none, and its limits can be in another sense than its samples:
        // the main and nose gear doors rest open (gear down) and their angles run negative to shut,
        // so clamping to [0, max] held them open with the gear up.
        const mixed = parts.length > 1;
        entry.hinge = {
          pivot: v3(nd.hinge.pivot), axis: v3(nd.hinge.axis).normalize(),
          min: mixed ? nd.hinge.min ?? -Infinity : -Infinity, max: mixed ? nd.hinge.max ?? Infinity : Infinity,
          parts,
        };
      } else {
        for (const [c, d] of Object.entries(nd.controls)) {
          const part = { control: c, xs: rig.controls[c].x, order: order.has(c) ? order.get(c) : 999 };
          if (d.spin) {
            part.kind = 'spin';
            part.pivot = v3(d.spin.pivot); part.axis = v3(d.spin.axis).normalize(); part.rate = d.spin.rate;
          } else if (d.a) {
            part.kind = 'hinge';
            part.pivot = v3(d.pivot); part.axis = v3(d.axis).normalize(); part.a = d.a;
          } else {
            part.kind = 'trs';
            part.q = d.q.map((q) => new THREE.Quaternion(q[0], q[1], q[2], q[3]));
            part.t = d.t.map(v3);
          }
          entry.parts.push(part);
        }
        entry.parts.sort((a, b) => b.order - a.order);           // outermost first
      }
      object.matrixAutoUpdate = true;
      this.nodes.push(entry);
    }
    // morph targets: [{meshes, index per mesh, parts: [{control, xs, w}], rest}]
    this.morphs = [];
    for (const [nodeName, targets] of Object.entries(rig.morphs || {})) {
      const object = root.getObjectByName(nodeName);
      if (!object) { this.missing.push(nodeName); continue; }
      for (const [target, perControl] of Object.entries(targets)) {
        const slots = [];
        object.traverse((m) => {
          if (m.isMesh && m.morphTargetDictionary && target in m.morphTargetDictionary) {
            slots.push({ mesh: m, index: m.morphTargetDictionary[target] });
          }
        });
        const parts = Object.entries(perControl).map(([c, w]) => ({ control: c, xs: rig.controls[c].x, w }));
        const rest = parts.length ? interp(parts[0].xs, parts[0].w, rig.controls[parts[0].control].default) : 0;
        this.morphs.push({ node: nodeName, target, slots, parts, rest, override: null });
      }
    }
    this._acc = new Rigid();
    this.apply();
  }

  /** Set control values (rig names and units); unknown names are ignored. */
  set(values) {
    for (const k in values) {
      if (k in this.values && Number.isFinite(values[k])) this.values[k] = values[k];
    }
  }

  /** Force a morph target's weight (null = follow the rig), e.g. the nozzle from the afterburner. */
  overrideMorph(target, weight) {
    for (const m of this.morphs) if (m.target === target) m.override = weight;
  }

  /** Weight of a morph target from the controls (ignores overrides). */
  morphWeight(m) {
    let w = m.rest;
    for (const p of m.parts) w += interp(p.xs, p.w, this.values[p.control]) - m.rest;
    return w;
  }

  /** Pose every node for the current values. */
  apply() {
    const acc = this._acc;
    const vals = this.values;
    for (const n of this.nodes) {
      acc.q.identity();
      acc.t.copy(n.rest);
      if (n.hinge) {
        const h = n.hinge;
        let a = 0;
        for (const p of h.parts) a += interp(p.xs, p.a, vals[p.control]);
        a = Math.min(h.max, Math.max(h.min, a));
        if (a !== 0) { aboutLine(h.pivot, h.axis, a); acc.mul(_q, _t); }
      } else {
        for (const p of n.parts) {
          const v = vals[p.control];
          if (p.kind === 'spin') {
            const a = (p.rate * v) % (2 * Math.PI);
            if (a !== 0) { aboutLine(p.pivot, p.axis, a); acc.mul(_q, _t); }
          } else if (p.kind === 'hinge') {
            const a = interp(p.xs, p.a, v);
            if (a !== 0) { aboutLine(p.pivot, p.axis, a); acc.mul(_q, _t); }
          } else {
            if (p.q.length === 1) { acc.mul(p.q[0], p.t[0]); continue; }
            const [i, f] = locate(p.xs, v);
            _qa.slerpQuaternions(p.q[i], p.q[i + 1], f);
            _ta.lerpVectors(p.t[i], p.t[i + 1], f);
            _qb.copy(_qa); _tb.copy(_ta);
            acc.mul(_qb, _tb);
          }
        }
      }
      n.object.position.copy(acc.t);
      n.object.quaternion.copy(acc.q);
    }
    for (const m of this.morphs) {
      const w = Math.min(1, Math.max(0, m.override ?? this.morphWeight(m)));
      for (const s of m.slots) s.mesh.morphTargetInfluences[s.index] = w;
    }
  }
}
