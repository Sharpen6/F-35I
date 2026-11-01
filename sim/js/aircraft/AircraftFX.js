// The aircraft's effects module, registered in main.js (_addGraphicsModules) with one line. It draws
// what the jet does to the air and the ground around it:
//   Vapor.js        wing-tip and chine vortices, vapour sheets over the wings, the transonic vapour
//                   cone, the contrail above ~8 km
//   TyreSmoke.js    puffs of rubber smoke when the wheels touch down
//   LandingPool.js  the landing light's pool on the ground at night (the terrain ignores lights)
// and sets the afterburner's ray-march steps for the quality setting. It reads the player's
// FlightModel state (app.fdm.state) and AircraftVisual (ctx.visual) and never changes them.
//
// Switches (URL): ?acfx=0 turns all of it off; ?vapour=0, ?tyresmoke=0, ?landingpool=0 one each.
// Quality: FX_QUALITY (main.js calls setQuality with 'low' | 'medium' | 'high').

import * as THREE from 'three';
import { Vapor } from './Vapor.js';
import { TyreSmoke } from './TyreSmoke.js';
import { LandingPool } from './LandingPool.js';
import { condensation, fxLight } from './fxshared.js';

/** Per quality: vapour sheets / chine vortices / cone, sheet layers, afterburner ray-march steps. */
export const FX_QUALITY = {
  low:    { sheets: false, chines: false, cone: true, layers: 1, abSteps: 16 },
  medium: { sheets: true,  chines: true,  cone: true, layers: 1, abSteps: 24 },
  high:   { sheets: true,  chines: true,  cone: true, layers: 2, abSteps: 32 },
};

function urlFlag(name) {
  try {
    const v = new URLSearchParams(window.location.search).get(name);
    return v === null || !/^(0|false|off|no)$/i.test(v);
  } catch (e) {
    return true;
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
  }

  /** All the effects on or off at run time (off: nothing drawn or updated). */
  setEnabled(on) {
    this.on = !!on;
    this.group.visible = this.on;
    if (!this.on && this.vapor) this.vapor.reset();
    this._fresh = true;
  }

  setQuality(q) {
    const Q = FX_QUALITY[q] || FX_QUALITY.high;
    this.quality = FX_QUALITY[q] ? q : 'high';
    if (this.vapor) this.vapor.setQuality({ sheets: Q.sheets, chines: Q.chines, cone: Q.cone, layers: Q.layers });
    const ab = this.ctx.visual && this.ctx.visual.afterburner;
    if (ab && ab.setSteps) ab.setSteps(Q.abSteps);
  }

  reset() {
    if (this.vapor) this.vapor.reset();
    this._fresh = true;
  }

  update(f) {
    const app = this.ctx.app, v = this.ctx.visual;
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
    if (this.vapor && shown) this.vapor.update(st, condensation(st), f.camera, f.draw);
    if (this.smoke) this.smoke.update(st, v);
    if (this.pool) this.pool.update(shown ? v.lights && v.lights.landing : null, f.draw);
  }

  dispose() {
    if (this.vapor) this.vapor.dispose();
    if (this.smoke) this.smoke.dispose();
    if (this.pool) this.pool.dispose();
    this.ctx.scene.remove(this.group);
  }
}
