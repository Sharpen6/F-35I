// The jet's self-luminous displays at a fixed picture level, as an automatic brightness control
// sets them: the glb's panoramic cockpit display glass (F35_PCD_Screen), the kneeboard tablet and
// the switch LEDs.
//
//   app.addModule(new DisplayLevels(ctx));     // main.js _addGraphicsModules (lighting fix)
//
// Their emission in the glb is a fixed radiance, right for the day. The picture is exposed for
// the scene: ~0.9 at noon, up to 285 at night (js/env/Environment.js METER), so at night the PCD
// came out as a white slab blooming over the cockpit (it already did at the old ceiling of 40).
// Here their emission is set every frame to level / exposure: the same picture level whatever the
// exposure, dimmer at night as a pilot sets it. The levels are the cockpit track's
// (js/aircraft/Cockpit.js and pcd/interior.js), so the look does not jump when that module comes
// in; when it is there (app.cockpit) it drives these materials itself and this module steps aside.
// The wingmen's copies are included once they have loaded.

/** Picture level of full emission: [day, night] (sun 0.08 rad up .. 0.1 rad down). */
const LEVELS = { F35_PCD_Screen: [1.05, 0.5], P2_TabletScreen: [0.9, 0.22], F35_SwitchLED: [0.55, 0.22] };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class DisplayLevels {
  constructor({ visual, env, app }) {
    this.visual = visual;
    this.env = env;
    this.app = app;
    this.enabled = true;
    this._mats = [];
    this._roots = 0;
  }

  /** The materials to drive, from the player's jet and the wingmen's (collected when they appear). */
  _collect() {
    const roots = [this.visual?.object3d, ...(this.app?.wingmen?.items || []).map((w) => w.visual?.object3d)].filter(Boolean);
    if (roots.length === this._roots) return;
    this._roots = roots.length;
    const seen = new Set();
    this._mats = [];
    for (const r of roots) {
      r.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (m && LEVELS[m.name] && !seen.has(m) && 'emissiveIntensity' in m) {
            seen.add(m);
            this._mats.push({ m, lv: LEVELS[m.name] });
          }
        }
      });
    }
  }

  update(f) {
    if (!this.enabled || f.draw === false || this.app?.cockpit) return;
    this._collect();
    if (!this._mats.length) return;
    const env = this.env;
    const e = Math.max(1e-3, (env.exposure ?? 1) * (env.exposureBias ?? 1));
    const day = smooth(-0.1, 0.08, f.sunDirection ? f.sunDirection.y : 1);
    for (const d of this._mats) d.m.emissiveIntensity = (d.lv[1] + (d.lv[0] - d.lv[1]) * day) / e;
  }
}
