// Cockpit: the pilot's side of the F-35I, a graphics module (main.js addModule):
//
//   const cockpit = new Cockpit({ renderer, scene, camera, env, terrain, visual, app });
//   cockpit.update(f);            // every frame (main.js _updateModules), after the visual and env
//   cockpit.setQuality(q);        // 'low' | 'medium' | 'high': PCD resolution and redraw rate
//
// * The panoramic cockpit display (pcd/): a live canvas on the glb's PCD glass (material
//   F35_PCD_Screen) instead of the baked picture: status bar, moving-map TSD, FUEL, ENG, ICAWS and
//   EFI portals, redrawn 4-10 times a second from the flight model. Its emission is set against the
//   exposure every frame (an automatic brightness control), so the glass reads the same by day
//   and at night, a little dimmer at night as a pilot sets it.
// * The pilot's own face (P2_Skin, part of the merged airframe mesh, not of the head node the
//   visual hides) is hidden with the camera at the eye; it showed when looking to the side.
//
// Everything works on the player's AircraftVisual only (the wingmen keep the glb as it is).

import * as THREE from 'three';
import { PCD } from './pcd/PCD.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Materials of the glb this module takes over, by name. */
export const COCKPIT_MATERIALS = {
  pcd: ['F35_PCD_Screen'],
  // the pilot's face and neck: hidden when the camera is at the eye (the head node is the visual's)
  face: ['P2_Skin', 'P2_TShirt'],
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
    this.enabled = !!(visual && visual.root);
    /** Display brightness in the picture: white glass ~ this / exposure (day) ... (night). */
    this.displayDay = 1.05;
    this.displayNight = 0.5;
    this.inside = 0;                         // 0 camera outside .. 1 at the pilot's eye
    this._eye = new THREE.Vector3();
    this._cam = new THREE.Vector3();
    if (!this.enabled) return;
    this._findMeshes();
    this.pcd = new PCD({ maxAnisotropy: renderer ? renderer.capabilities.getMaxAnisotropy() : 8 });
    this.pcd.onTextureChange = (t) => { if (this.pcdMaterial) { this.pcdMaterial.emissiveMap = t; this.pcdMaterial.needsUpdate = true; } };
    this._setupPcdMaterial();
    this.pcd.setMaps(terrain).catch(() => {});
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
  }

  // ------------------------------------------------------------------------------ module API
  setQuality(q) {
    if (!this.enabled) return;
    this.pcd.setQuality(q);
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
    if (this.pcdMaterial && f.draw !== false) {
      // automatic brightness: the same picture level by day and at night (dimmer at night),
      // whatever the exposure; off with the engine and the battery off after a crash
      const sunY = f.sunDirection ? f.sunDirection.y : 1;
      const level = this.displayNight + (this.displayDay - this.displayNight) * smooth(-0.1, 0.08, sunY);
      const power = st && st.crashed ? 0 : 1;
      this.pcdMaterial.emissiveIntensity = power * level / this.exposure();
    }
  }

  dispose() {
    if (!this.enabled) return;
    this.pcd.dispose();
    this.pcdMaterial?.dispose();
  }
}
