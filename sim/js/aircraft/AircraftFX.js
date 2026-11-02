// The aircraft's effects module, registered in main.js (_addGraphicsModules) with one line. It draws
// what the jet does to the air and the ground around it:
//   Vapor.js        wing-tip and chine vortices, vapour sheets over the wings, the transonic vapour
//                   cone, the contrail above ~8 km
//   TyreSmoke.js    puffs of rubber smoke when the wheels touch down
//   LandingPool.js  the landing light's pool on the ground at night (the terrain ignores lights)
// and keeps what all the aircraft effects share (the player's jet and the wingmen's; the effects
// above are drawn for the player's jet only):
//   fxEnv           the scene's light level from the sun's elevation (fxshared.js), updated every
//                   frame and on setTime: the burner's day look, the glare round the lights and the
//                   pool switch by the sun, never by the exposure meter
//   quality         the vapour's sheet layers and cone shells, the burner's ray-march steps
//   warm-up         every effect's shader program is built in the first frame drawn, long before
//                   the effect first shows (Warmup below)
// It reads the player's FlightModel state (app.fdm.state) and AircraftVisual (ctx.visual) and never
// changes them.
//
// Switches (URL): ?acfx=0 turns all of it off; ?vapour=0, ?tyresmoke=0, ?landingpool=0 one each.
// Quality: FX_QUALITY (main.js calls setQuality with 'low' | 'medium' | 'high').

import * as THREE from 'three';
import { Vapor } from './Vapor.js';
import { TyreSmoke } from './TyreSmoke.js';
import { LandingPool } from './LandingPool.js';
import { condensation, fxLight, fxEnv } from './fxshared.js';

/**
 * Per quality: vapour sheets / chine vortices / cone, sheet layers, cone shells (the outer ones
 * first; fewer shells are each denser), afterburner ray-march steps.
 */
export const FX_QUALITY = {
  low:    { sheets: false, chines: false, cone: true, layers: 1, shells: 1, abSteps: 16 },
  medium: { sheets: true,  chines: true,  cone: true, layers: 1, shells: 2, abSteps: 24 },
  high:   { sheets: true,  chines: true,  cone: true, layers: 2, shells: 3, abSteps: 32 },
};

function urlFlag(name) {
  try {
    const v = new URLSearchParams(window.location.search).get(name);
    return v === null || !/^(0|false|off|no)$/i.test(v);
  } catch (e) {
    return true;
  }
}

/**
 * Shader warm-up. three.js builds a material's program the first time the material is drawn: for
 * these shaders (the plume's ray march above all) tens of milliseconds on ANGLE / D3D11, a hitch just
 * as the burner lights, the vapour cone forms or a wheel first smokes. So each effect mesh's material
 * is drawn once as soon as it exists, in a frame the app draws anyway, by a stand-in: an object of
 * the same kind with the mesh's material and an empty geometry (the mesh's attribute names and sizes,
 * no vertices). three builds the very program variant the real draw will use (the scene's fog, the
 * tone mapping and colour space of the target the frame goes to: the canvas, or the HDR chain's
 * float target) and uploads the material's textures, and nothing is drawn. renderer.compile() would
 * only build the canvas variant. A stand-in leaves once its material has been drawn (onAfterRender:
 * not by a pass with an override material); add() again after a material changed (needsUpdate)
 * warms it again.
 */
class Warmup {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'AircraftFX_warmup';
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);
    this.done = new WeakMap();          // material -> material.version warmed
    this.pending = [];
  }

  /** Stand-ins for the meshes' materials not warmed yet (at their current version). */
  add(meshes) {
    for (const m of meshes) {
      const mat = m && m.material;
      if (!mat || Array.isArray(mat) || !m.geometry || this.done.get(mat) === mat.version) continue;
      this.done.set(mat, mat.version);
      const geo = new THREE.BufferGeometry();
      for (const k in m.geometry.attributes) {
        const a = m.geometry.attributes[k];
        const Arr = a.array ? a.array.constructor : Float32Array;
        geo.setAttribute(k, new THREE.BufferAttribute(new Arr(0), a.itemSize, a.normalized));
      }
      const proxy = m.isPoints ? new THREE.Points(geo, mat) : new THREE.Mesh(geo, mat);
      proxy.name = `warmup:${mat.name}`;
      proxy.frustumCulled = false;
      proxy.matrixAutoUpdate = false;
      proxy.renderOrder = m.renderOrder;
      proxy.userData.drawn = false;
      proxy.onAfterRender = (renderer, scene, camera, geometry, material) => {
        if (material === mat) proxy.userData.drawn = true;
      };
      this.group.add(proxy);
      this.pending.push(proxy);
    }
  }

  /** Before a frame: the stand-ins drawn in the last one leave (their empty buffers freed). */
  sweep() {
    if (!this.pending.length) return;
    let n = 0;
    for (const p of this.pending) {
      if (p.userData.drawn) { this.group.remove(p); p.geometry.dispose(); } else this.pending[n++] = p;
    }
    this.pending.length = n;
  }

  dispose() {
    for (const p of this.pending) p.geometry.dispose();
    this.pending.length = 0;
    this.scene.remove(this.group);
  }
}

export class AircraftFX {
  /** @param {object} ctx  main.js module context {renderer, scene, camera, env, terrain, visual, app} */
  constructor(ctx) {
    this.ctx = ctx;
    this.name = 'AircraftFX';
    const all = urlFlag('acfx');
    this.enabled = { vapour: all && urlFlag('vapour'), smoke: all && urlFlag('tyresmoke'), pool: all && urlFlag('landingpool') };
    // trails, smoke and the pool live in world coordinates: a group at the origin
    this.group = new THREE.Group();
    this.group.name = 'AircraftFX';
    this.group.matrixAutoUpdate = false;
    ctx.scene.add(this.group);
    const v = ctx.visual;
    const ok = !!(v && v.object3d);
    this.vapor = this.enabled.vapour && ok ? new Vapor(this.group, v) : null;
    this.smoke = this.enabled.smoke && ok ? new TyreSmoke(this.group) : null;
    this.pool = this.enabled.pool && ok && ctx.terrain ? new LandingPool(this.group, ctx.terrain) : null;
    this.quality = 'high';
    this.on = true;
    this._fresh = true;                 // reset the touchdown detector on the next update
    this._shown = true;
    this._cond = { air: {} };           // condensation() output, reused
    this.warmup = new Warmup(ctx.scene);
    this._warmed = new WeakSet();       // visuals whose effect meshes were handed to the warm-up
    this._warmFx = false;
    fxEnv.update(ctx.env);
  }

  /** All the effects on or off at run time (off: nothing drawn or updated). */
  setEnabled(on) {
    this.on = !!on;
    this.group.visible = this.on;
    if (!this.on && this.vapor) this.vapor.reset();
    // the pool's lamp off for the other shaders too (LandingPool.js LAMP_UNIFORMS)
    if (!this.on && this.pool) this.pool.update(null, false);
    this._fresh = true;
  }

  setQuality(q) {
    const Q = FX_QUALITY[q] || FX_QUALITY.high;
    this.quality = FX_QUALITY[q] ? q : 'high';
    if (this.vapor) this.vapor.setQuality({ sheets: Q.sheets, chines: Q.chines, cone: Q.cone, layers: Q.layers, shells: Q.shells });
    const ab = this.ctx.visual && this.ctx.visual.afterburner;
    if (ab && ab.setSteps) ab.setSteps(Q.abSteps);
  }

  /** The time of day changed: the light level at once (the jet's lights are updated before us). */
  setTime() { fxEnv.update(this.ctx.env); }

  /** The visual's and the effects' meshes to the warm-up (once each; again if a material changed). */
  _warmAll() {
    const v = this.ctx.visual;
    if (v && v.loaded && v.effectMeshes) this.warmup.add(v.effectMeshes());
    for (const fx of [this.vapor, this.smoke, this.pool]) if (fx && fx.effectMeshes) this.warmup.add(fx.effectMeshes());
    this._warmFx = true;
  }

  /**
   * The wingmen's jets (their visuals load later, on demand): the same ray-march steps, and their
   * effect materials warmed as soon as they exist.
   */
  _syncWingmen() {
    const w = this.ctx.app && this.ctx.app.wingmen;
    if (!w || !w.items) return;
    const n = (FX_QUALITY[this.quality] || FX_QUALITY.high).abSteps;
    for (const it of w.items) {
      const vis = it.visual;
      const ab = vis && vis.afterburner;
      if (ab && ab.setSteps && ab.steps !== n) ab.setSteps(n);
      if (vis && vis.loaded && vis.effectMeshes && !this._warmed.has(vis)) {
        this._warmed.add(vis);
        this.warmup.add(vis.effectMeshes());
      }
    }
  }

  reset() {
    if (this.vapor) this.vapor.reset();
    this._fresh = true;
  }

  update(f) {
    const app = this.ctx.app, v = this.ctx.visual;
    // the light level every frame, whatever else is off (the lights and burners of all the jets read it)
    fxEnv.update(this.ctx.env);
    if (f.draw) {
      this.warmup.sweep();
      if (!this._warmFx) this._warmAll();
      this._syncWingmen();
    }
    const st = app && app.fdm && app.fdm.state;
    if (!this.on || !st || !v || !v.object3d) return;
    if (this._fresh) {
      if (this.smoke) this.smoke.reset(st);
      this._fresh = false;
    }
    // the jet hidden (crash): no vapour; the smoke stays where it was left
    const shown = v.object3d.visible !== false;
    if (!shown && this._shown && this.vapor) this.vapor.reset();
    this._shown = shown;
    if (f.draw) fxLight.update(this.ctx.env, f.sunDirection);
    if (this.vapor && shown) this.vapor.update(st, condensation(st, undefined, this._cond), f.camera, f.draw);
    if (this.smoke) this.smoke.update(st, v);
    if (this.pool) this.pool.update(shown ? v.lights && v.lights.landing : null, f.draw);
  }

  dispose() {
    if (this.vapor) this.vapor.dispose();
    if (this.smoke) this.smoke.dispose();
    if (this.pool) this.pool.dispose();
    this.warmup.dispose();
    this.ctx.scene.remove(this.group);
  }
}
