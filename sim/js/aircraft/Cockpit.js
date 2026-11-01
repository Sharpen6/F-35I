// Cockpit: the pilot's side of the F-35I, a graphics module (main.js addModule):
//
//   const cockpit = new Cockpit({ renderer, scene, camera, env, terrain, visual, app });
//   cockpit.update(f);            // every frame (main.js _updateModules), after the visual and env
//   cockpit.setQuality(q);        // 'low' | 'medium' | 'high' (COCKPIT_QUALITY)
//
// * The panoramic cockpit display (pcd/PCD.js): a live canvas on the glb's PCD glass (material
//   F35_PCD_Screen) instead of the baked picture: status bar, moving-map TSD, FUEL, ENG, ICAWS and
//   EFI portals, redrawn 4-10 times a second from the flight model. Its emission is set against the
//   exposure every frame (an automatic brightness control), so the glass reads the same by day
//   and at night, a little dimmer at night as a pilot sets it.
// * The interior (pcd/interior.js): dark grey satin paint with grain and smudges, the skin's inner
//   faces repainted, a floor plate between the pedals, ambient occlusion of the tub, the display's
//   glow on the cockpit at night, LEDs and the kneeboard tablet at a fixed picture level.
// * The canopy (pcd/canopy.js): dust, smudges and scratches catching the sun, the PCD and the
//   interior reflected in the inner surface.
// * The pilot's own face (P2_Skin, part of the merged airframe mesh, not of the head node the
//   visual hides) is hidden with the camera at the eye; it showed when looking to the side.
//
// ?cockpit=0 turns the module off (the glb's cockpit as exported). Everything works on the
// player's AircraftVisual only (the wingmen keep the glb as it is).

import * as THREE from 'three';
import { interp, locate } from './rig.js';
import { PCD } from './pcd/PCD.js';
import { makeDetailTexture } from './pcd/detail.js';
import { Interior } from './pcd/interior.js';
import { CanopyGlass } from './pcd/canopy.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp1 = (x) => (x > 1 ? 1 : x < -1 ? -1 : x || 0);

/**
 * Rig nodes that show the pilot's inputs: the rig moves the side-stick (and the hand on it) and
 * the pedals with the flight controls' surface commands, which in a fly-by-wire jet are not where
 * the pilot holds them (trim, the control laws). The throttle already follows the lever.
 */
const INCEPTORS = { Stick: 1, Pilot_Hand_R: 1, Pedal_L: 1, Pedal_R: 1 };

/** Materials of the glb this module takes over, by name (interior.js lists the repainted ones). */
export const COCKPIT_MATERIALS = {
  pcd: ['F35_PCD_Screen'],
  // the pilot's face and neck: hidden when the camera is at the eye (the head node is the visual's)
  face: ['P2_Skin', 'P2_TShirt'],
};

/** Per graphics quality (the PCD's own table is in PCD.js). */
export const COCKPIT_QUALITY = {
  low: { canopy: false, detail: 0 },
  medium: { canopy: true, detail: 1 },
  high: { canopy: true, detail: 1 },
};

export class Cockpit {
  constructor({ renderer, scene, camera, env, terrain, visual, app } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.env = env;
    this.terrain = terrain;
    this.visual = visual;
    this.app = app;
    const off = typeof location !== 'undefined' && new URLSearchParams(location.search).get('cockpit') === '0';
    this.enabled = !!(visual && visual.root) && !off;
    /** Display brightness in the picture: white glass ~ this / exposure (day) ... (night). */
    this.displayDay = 1.05;
    this.displayNight = 0.5;
    this.inside = 0;                         // 0 camera outside .. 1 at the pilot's eye
    this._eye = new THREE.Vector3();
    this._cam = new THREE.Vector3();
    this._pcdW = { o: new THREE.Vector3(), u: new THREE.Vector3(), v: new THREE.Vector3(), n: new THREE.Vector3(), c: new THREE.Vector3(), texture: null, gain: 0 };
    if (!this.enabled) return;
    this._findMeshes();
    this.pcd = new PCD({ maxAnisotropy: renderer ? renderer.capabilities.getMaxAnisotropy() : 8 });
    this.pcd.onTextureChange = (t) => { if (this.pcdMaterial) { this.pcdMaterial.emissiveMap = t; this.pcdMaterial.needsUpdate = true; } };
    this._setupPcdMaterial();
    this.pcd.setMaps(terrain).catch(() => {});
    this.detail = makeDetailTexture(512);
    this.interior = new Interior({ visual, detail: this.detail });
    this.interior.start().then((s) => { this.interiorStats = s; }).catch((e) => console.warn('Cockpit: interior:', e.message));
    this.canopy = new CanopyGlass({ root: visual.root, detail: this.detail });
    // the side-stick and the pedals from the pilot's inputs (rig nodes, re-posed after the rig)
    this._inceptors = visual.player ? visual.player.nodes.filter((n) => n.name in INCEPTORS && !n.hinge) : [];
    this._inp = { stick_pitch: 0, stick_roll: 0, pedals: 0 };
  }

  /** Meshes of the player's model by material name. */
  _findMeshes() {
    const byMat = new Map();
    this.visual.root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const n = o.material.name || '';
      if (!byMat.has(n)) byMat.set(n, []);
      byMat.get(n).push(o);
    });
    this.meshesByMaterial = byMat;
    const pick = (names) => names.flatMap((n) => byMat.get(n) || []);
    this.pcdMeshes = pick(COCKPIT_MATERIALS.pcd);
    this.faceMeshes = pick(COCKPIT_MATERIALS.face);
  }

  _setupPcdMaterial() {
    if (!this.pcdMeshes.length) { console.warn('Cockpit: no PCD glass (material F35_PCD_Screen) in the model'); return; }
    // black glass with an anti-reflection coating: a faint, slightly blurred sky reflection over the
    // emitted picture
    this.pcdMaterial = new THREE.MeshStandardMaterial({
      name: 'F35_PCD_Screen_live',
      color: 0x030405,
      roughness: 0.24,
      metalness: 0,
      envMapIntensity: 0.45,
      emissive: 0xffffff,
      emissiveMap: this.pcd.texture,
      emissiveIntensity: 1,
      side: THREE.DoubleSide,
    });
    for (const m of this.pcdMeshes) m.material = this.pcdMaterial;
    this._pcdRect = pcdRectangle(this.pcdMeshes[0]);
  }

  // ------------------------------------------------------------------------------ module API
  setQuality(q) {
    if (!this.enabled) return;
    this.quality = q;
    const Q = COCKPIT_QUALITY[q] || COCKPIT_QUALITY.medium;
    this.pcd.setQuality(q);
    if (this.canopy) this.canopy.enabled = Q.canopy;
    if (this.interior) this.interior.detailAmount = Q.detail;
  }

  setTime(h, doy) {
    this.dayOfYear = doy;
  }

  reset() {
    if (!this.enabled) return;
    this.pcd.reset();
  }

  /** The exposure the picture is drawn with (the Environment's auto exposure and bias). */
  exposure() {
    const r = this.renderer;
    const e = this.env && Number.isFinite(this.env.displayExposure) ? this.env.displayExposure
      : r && Number.isFinite(r.toneMappingExposure) ? r.toneMappingExposure : 1;
    return Math.max(1e-3, e);
  }

  update(f) {
    if (!this.enabled) return;
    const app = this.app;
    const cam = f.camera || this.camera;
    const st = app && app.fdm ? app.fdm.state : null;
    // where the camera is: at the eye (cockpit view) or outside
    this.visual.eyeWorld(this._eye);
    cam.getWorldPosition(this._cam);
    const d = this._cam.distanceTo(this._eye);
    this.inside = smooth(1.2, 0.4, d);
    const atEye = d < (this.visual.headHideDistance || 0.3);
    for (const m of this.faceMeshes) m.visible = !atEye;
    this._poseInceptors(f.dt || 0);
    // the display: redraw only while it can be seen (a drawn frame, the camera within ~40 m)
    if (st && this.pcd) {
      const visible = f.draw !== false && d < 40 && this.visual.object3d.visible;
      this.pcd.update(f.dt || 0, {
        st, levers: app.input ? app.input.levers : {},
        hours: f.time, dayOfYear: this.dayOfYear || (app.spawn && app.spawn.day_of_year) || 172,
        spawn: app.spawn, airports: this.terrain ? this.terrain.airports : [],
        wingmen: app.wingmen && app.wingmen.count ? app.wingmen.items.map((w) => ({ position: w.drawPos, quaternion: w.drawQuat })) : [],
      }, visible);
    }
    if (f.draw === false) return;
    const sunY = f.sunDirection ? f.sunDirection.y : 1;
    const exposure = this.exposure();
    const power = st && st.crashed ? 0 : 1;
    if (this.pcdMaterial) {
      // automatic brightness: the same picture level by day and at night (dimmer at night),
      // whatever the exposure; off with the engine and the battery off after a crash
      const level = this.displayNight + (this.displayDay - this.displayNight) * smooth(-0.1, 0.08, sunY);
      this.pcdMaterial.emissiveIntensity = power * level / exposure;
      this._updatePcdRect();
    }
    const P = this._pcdW;
    if (this.interior) {
      this.interior.update({ exposure, sunY, power, pcdGlow: this.pcd.glow, pcdIntensity: P.gain, pcdCentre: P.c, pcdNormal: P.n });
    }
    if (this.canopy) {
      const show = this.canopy.enabled !== false && d < 80 && this.visual.object3d.visible;
      this.canopy.visible = show;
      if (show && this.env) {
        this.canopy.update({
          sunDir: f.sunDirection || this.env.sunDirection,
          sunColor: this.env.sunLight ? this.env.sunLight.color : new THREE.Color(1, 1, 1),
          ambient: this.env.uniforms && this.env.uniforms.uAmbient ? this.env.uniforms.uAmbient.value : new THREE.Color(0.5, 0.5, 0.5),
          inside: this.inside,
          pcd: P.texture ? P : null,
        });
      }
    }
  }

  /**
   * The side-stick, the hand on it and the pedals where the pilot holds them (input frame of this
   * tick, test inputs included; a stick has some mass: 50 ms), posed as RigPlayer.apply does.
   */
  _poseInceptors(dt) {
    const f = this.app && this.app.input ? this.app.input.frame : null;
    if (!f || !this._inceptors.length) return;
    // (the test API's inputs override the frame's, as main.js applies them)
    const t = this.app.testInput || {};
    const pick = (k) => clamp1(t[k] != null ? t[k] : f[k]);
    const I = this._inp, k = 1 - Math.exp(-Math.max(0, dt) / 0.05);
    I.stick_pitch += (pick('pitch') - I.stick_pitch) * k;
    I.stick_roll += (pick('roll') - I.stick_roll) * k;
    I.pedals += (pick('yaw') - I.pedals) * k;
    for (const n of this._inceptors) {
      _rq.identity();
      _rt.copy(n.rest);
      for (const p of n.parts) {
        const v = I[p.control];
        if (v === undefined) continue;
        if (p.kind === 'hinge') {
          const a = interp(p.xs, p.a, v);
          if (a === 0) continue;
          _hq.setFromAxisAngle(p.axis, a);
          _ht.copy(p.pivot).applyQuaternion(_hq).negate().add(p.pivot);   // about the line: t = p - R p
        } else if (p.kind === 'trs') {
          if (p.q.length === 1) { _hq.copy(p.q[0]); _ht.copy(p.t[0]); } else {
            const [i, w] = locate(p.xs, v);
            _hq.slerpQuaternions(p.q[i], p.q[i + 1], w);
            _ht.lerpVectors(p.t[i], p.t[i + 1], w);
          }
        } else continue;
        _rt.add(_ht.applyQuaternion(_rq));
        _rq.multiply(_hq);
      }
      n.object.position.copy(_rt);
      n.object.quaternion.copy(_rq);
    }
  }

  /** The display's canvas rectangle in world space (origin, u and v edges, normal to the pilot). */
  _updatePcdRect() {
    const R = this._pcdRect, P = this._pcdW;
    if (!R) return;
    const M = R.mesh.matrixWorld;
    P.o.copy(R.o).applyMatrix4(M);
    P.u.copy(R.o).add(R.u).applyMatrix4(M).sub(P.o);
    P.v.copy(R.o).add(R.v).applyMatrix4(M).sub(P.o);
    P.c.copy(P.o).addScaledVector(P.u, 0.5).addScaledVector(P.v, 0.5);
    P.n.crossVectors(P.u, P.v).normalize();
    if (P.n.dot(_t.copy(this._eye).sub(P.c)) < 0) P.n.negate();
    P.texture = this.pcd.texture;
    P.gain = this.pcdMaterial.emissiveIntensity;
  }

  dispose() {
    if (!this.enabled) return;
    this.pcd.dispose();
    this.pcdMaterial?.dispose();
    this.interior?.dispose();
    this.canopy?.dispose();
    this.detail?.dispose();
  }
}

const _t = new THREE.Vector3();
const _rq = new THREE.Quaternion(), _hq = new THREE.Quaternion();
const _rt = new THREE.Vector3(), _ht = new THREE.Vector3();

/**
 * The display's canvas as an affine map of the glass mesh's uv (glTF: v = 0 at the top): the
 * origin (uv 0, 0) and the u and v edges in the mesh's frame, from its first triangle.
 */
function pcdRectangle(mesh) {
  const g = mesh.geometry, P = g.attributes.position, T = g.attributes.uv;
  if (!P || !T) return null;
  const i = g.index ? [g.index.getX(0), g.index.getX(1), g.index.getX(2)] : [0, 1, 2];
  const p = i.map((k) => new THREE.Vector3().fromBufferAttribute(P, k));
  const t = i.map((k) => new THREE.Vector2().fromBufferAttribute(T, k));
  const d1 = t[1].clone().sub(t[0]), d2 = t[2].clone().sub(t[0]);
  const det = d1.x * d2.y - d2.x * d1.y;
  if (Math.abs(det) < 1e-12) return null;
  const e1 = p[1].clone().sub(p[0]), e2 = p[2].clone().sub(p[0]);
  // [e1 e2] = [U V] [d1 d2]  ->  [U V] = [e1 e2] [d1 d2]^-1
  const U = e1.clone().multiplyScalar(d2.y / det).addScaledVector(e2, -d1.y / det);
  const V = e1.clone().multiplyScalar(-d2.x / det).addScaledVector(e2, d1.x / det);
  const o = p[0].clone().addScaledVector(U, -t[0].x).addScaledVector(V, -t[0].y);
  return { mesh, o, u: U, v: V };
}
