// AircraftVisual: the F-35I 'Adir' in the sim (sim/DESIGN.md, "Module interfaces").
//
//   const visual = new AircraftVisual({ scene, baseUrl: 'data/aircraft/' });
//   await visual.load((fraction, label) => ...);
//   visual.setPose(position, quaternion);          // world; body -> world
//   visual.setControls(fdm.state.controls);         // rig-named controls, + ab, lights, wheels
//   visual.update(dt, camera);                     // every frame
//   visual.info.eye, visual.info.gearContacts ...  // body frame (+X right, +Y up, -Z forward)
//
// object3d is the body-frame group; inside it the glTF model (Blender's +X left, +Z forward) is
// turned 180 deg about Y. Moving parts are separate glTF nodes driven by RigPlayer (rig.js) from
// f35i_rig.json; materials.js prepares the glass and decals, lights.js the exterior lights and
// Afterburner.js the burner plume.
//
// setControls(c) accepts (all optional, missing keys keep their value):
//   stick_pitch, stick_roll, pedals (-1..1), throttle (0..1, 0.75 MIL), flaps, speedbrake, gear,
//   weapon_bays, canopy, refuel_door, gun_door, tailhook (0..1), nws (-1..1), roll_distance (m),
//   ab (0..1: plume and nozzle petals; without it the petals follow the throttle as in Blender),
//   lights {nav, anticoll, landing (booleans), formation (0..1 or boolean)},
//   wheels [{name: 'nose'|'left'|'right', compression, steer}] (FlightModel state.wheels) or
//   strut {nose, left, right}: strut compression in m from fully extended (info.gearContacts);
//   the nose wheel's steer (rad, + right) stands in for nws when nws is not given,
//   head {yaw, pitch, tilt} (rad: + = look left / up / tilt): the pilot's helmet.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RigPlayer } from './rig.js';
import { setupMaterials } from './materials.js';
import { AircraftLights } from './lights.js';
import { Afterburner } from './Afterburner.js';

const RIG_CONTROLS = ['stick_pitch', 'stick_roll', 'pedals', 'throttle', 'flaps', 'speedbrake', 'gear', 'nws',
  'roll_distance', 'weapon_bays', 'canopy', 'refuel_door', 'gun_door', 'tailhook'];

/** A Vector3 that also reads as an array (p[0], p[1], p[2]) for code written against the json. */
export class InfoPoint extends THREE.Vector3 {}
for (const [i, k] of ['x', 'y', 'z'].entries()) {
  Object.defineProperty(InfoPoint.prototype, i, {
    get() { return this[k]; }, set(v) { this[k] = v; }, enumerable: false,
  });
}
const P = (a) => (Array.isArray(a) && a.length === 3 ? new InfoPoint(a[0], a[1], a[2]) : a);

/** rig.info with every 3-vector as an InfoPoint (deep copy). */
function infoWithPoints(info) {
  const walk = (v) => {
    if (Array.isArray(v)) {
      if (v.length === 3 && v.every((x) => typeof x === 'number')) return P(v);
      return v.map(walk);
    }
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  return walk(info);
}

const _eye = new THREE.Vector3();
const _cam = new THREE.Vector3();

/** AB_Open weight of the nozzle from the throttle alone: open at idle, shut by ~60 % (MIL 0.75). */
export function nozzleIdleOpen(throttle) {
  const t = Number.isFinite(throttle) ? throttle : 0;
  return 0.75 * (1 - THREE.MathUtils.smoothstep(t, 0.08, 0.6));
}

export class AircraftVisual {
  constructor({ scene = null, baseUrl = 'data/aircraft/' } = {}) {
    this.scene = scene;
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    this.object3d = new THREE.Group();
    this.object3d.name = 'F35I';
    this.model = new THREE.Group();            // glTF frame -> body frame
    this.model.name = 'F35I_model';
    this.model.rotation.y = Math.PI;
    this.object3d.add(this.model);
    this.info = null;
    this.rig = null;
    this.loaded = false;
    this.headHideDistance = 0.3;               // m: hide the pilot's head with the camera at the eye
    this.viewportHeight = (typeof window !== 'undefined' && window.innerHeight) || 1080;   // px, for light glow sizes
    this._ab = null;
    this._throttle = 0;
    this._gear = 1;
    if (scene) scene.add(this.object3d);
  }

  /** Load f35i_rig.json and f35i.glb. onProgress(fraction 0..1, label). */
  async load(onProgress) {
    const report = (f, label) => { if (onProgress) onProgress(Math.min(1, Math.max(0, f)), label); };
    report(0, 'aircraft: rig');
    const res = await fetch(this.baseUrl + 'f35i_rig.json');
    if (!res.ok) throw new Error(`AircraftVisual: ${this.baseUrl}f35i_rig.json: HTTP ${res.status}`);
    const rig = await res.json();
    if (rig.format !== 'f35i-rig') throw new Error('AircraftVisual: not an f35i rig file');
    this.rig = rig;
    report(0.02, 'aircraft: model');
    const gltf = await new GLTFLoader().loadAsync(this.baseUrl + (rig.glb || 'f35i.glb'), (e) => {
      if (e.total) report(0.02 + 0.93 * e.loaded / e.total, 'aircraft: model');
    });
    const root = gltf.scene;
    root.name = 'F35I_gltf';
    this.root = root;
    this.model.add(root);
    // materials, rig, lights, burner
    const mats = setupMaterials(root, { rig });
    this.materials = mats;
    this.player = new RigPlayer(rig, root);
    if (this.player.missing.length) console.warn('AircraftVisual: rig nodes missing in the glb:', this.player.missing);
    this.lights = new AircraftLights(root, rig.info, mats.byName);
    this.afterburner = new Afterburner(rig.info.nozzle);
    this.object3d.add(this.afterburner.group);
    this.head = root.getObjectByName('Pilot_Head');
    // reference data in the body frame, vectors as InfoPoints (also readable as arrays)
    this.info = infoWithPoints(rig.info);
    this.info.raw = rig.info;
    this.info.controls = rig.controls;
    this._eyeLocal = new THREE.Vector3().fromArray(rig.info.eye);
    this.loaded = true;
    this.object3d.updateMatrixWorld(true);
    report(1, 'aircraft: ready');
    return this;
  }

  /** World position and attitude (body -> world). */
  setPose(position, quaternion) {
    if (position) this.object3d.position.copy(position);
    if (quaternion) this.object3d.quaternion.copy(quaternion);
  }

  setControls(c) {
    if (!c || !this.loaded) return;
    const v = {};
    for (const k of RIG_CONTROLS) if (Number.isFinite(c[k])) v[k] = c[k];
    // struts: compression from fully extended -> rig strut_<x> (from the modelled parked pose)
    const comp = {};
    if (Array.isArray(c.wheels)) {
      for (const w of c.wheels) {
        if (!w) continue;
        if (Number.isFinite(w.compression)) comp[w.name] = w.compression;
        // nose-wheel angle (rad) when no nws command is given
        if (w.name === 'nose' && Number.isFinite(w.steer) && !Number.isFinite(c.nws)) {
          v.nws = Math.max(-1, Math.min(1, w.steer / this.rig.info.noseSteer.max));
        }
      }
    }
    if (c.strut) for (const k of ['nose', 'left', 'right']) if (Number.isFinite(c.strut[k])) comp[k] = c.strut[k];
    for (const g of this.rig.info.gearContacts) {
      if (g.name in comp && g.control) {
        const x = Math.min(g.travel, Math.max(0, comp[g.name])) - g.staticCompression;
        v[g.control] = x;
      }
    }
    if (c.head) {
      if (Number.isFinite(c.head.yaw)) v.head_yaw = c.head.yaw;
      if (Number.isFinite(c.head.pitch)) v.head_pitch = c.head.pitch;
      if (Number.isFinite(c.head.tilt)) v.head_tilt = c.head.tilt;
    }
    this.player.set(v);
    if (Number.isFinite(c.throttle)) this._throttle = c.throttle;
    if (Number.isFinite(c.gear)) this._gear = c.gear;
    if ('ab' in c) this._ab = Number.isFinite(c.ab) ? c.ab : null;
    if (c.lights) this.lights.set(c.lights, this._gear);
  }

  update(dt, camera) {
    if (!this.loaded) return;
    dt = Math.min(Math.max(dt || 0, 0), 0.25);
    // burner from ab, or from the throttle above MIL
    const ab = this._ab !== null ? this._ab : Math.max(0, (this._throttle - 0.75) / 0.25);
    // nozzle petals (AB_Open: 0 = the MIL position, 1 = full burner): the F135's convergent-divergent
    // nozzle is wide open at idle, closes as the throttle comes up to MIL and opens again in burner
    this.player.overrideMorph('AB_Open', Math.max(ab, nozzleIdleOpen(this._throttle)));
    this.player.apply();
    this.afterburner.set(ab, this._throttle);
    this.lights.set(null, this._gear);
    this.object3d.updateMatrixWorld();
    this.afterburner.update(dt, camera);
    this.lights.update(dt, camera, this.viewportHeight);
    if (camera) {
      // camera at the pilot's eye: hide his head (helmet, visor, mask) and see out through the canopy
      _eye.copy(this._eyeLocal);
      this.object3d.localToWorld(_eye);
      camera.getWorldPosition(_cam);
      const d = _cam.distanceTo(_eye);
      if (this.head) this.head.visible = d > this.headHideDistance;
      this.materials.uniforms.uInside.value = THREE.MathUtils.smoothstep(1.2 - d, 0.0, 0.8);
    }
  }

  /**
   * Optional: an environment map for the aircraft's materials only (e.g. a PMREM of the sky when the
   * scene has no scene.environment). The coating's sky sheen and the canopy reflections need one.
   */
  setEnvironment(envMap, intensity = 1) {
    this.object3d.traverse((o) => {
      const m = o.material;
      if (!m) return;
      for (const mm of Array.isArray(m) ? m : [m]) {
        if ('envMap' in mm && !mm.isShaderMaterial) {
          mm.envMap = envMap;
          mm.envMapIntensity = intensity;
          mm.needsUpdate = true;
        }
      }
    });
  }

  /** Eye point in world coordinates (out). */
  eyeWorld(out = new THREE.Vector3()) {
    out.copy(this._eyeLocal || out.set(0, 0, 0));
    return this.object3d.localToWorld(out);
  }

  dispose() {
    if (this.object3d.parent) this.object3d.parent.remove(this.object3d);
    this.object3d.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const m = o.material;
      if (m) {
        for (const mm of Array.isArray(m) ? m : [m]) {
          for (const k of Object.keys(mm)) if (mm[k] && mm[k].isTexture) mm[k].dispose();
          mm.dispose();
        }
      }
    });
    this.loaded = false;
  }
}
