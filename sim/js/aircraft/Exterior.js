// Exterior (graphics module of main.js; exterior track, js/aircraft/README.md "Exterior"): drives
// the player's jet's own shadow (JetShadow.js) and the coating's uniforms (skin.js).
//
//   app.addModule(new Exterior(ctx));      // ctx: renderer, scene, env, terrain, visual
//
// Each drawn frame, after the environment (the light, and whether it casts) and before the scene:
// the jet's shadow map is redrawn if the light turned in the jet's frame or a part moved, the
// ground pass follows the jet, and the jet's meshes are kept out of the scene's shadow map while
// its own shadow is on (one shadow, not a blurred second one 0.8 m behind). Off (?exterior=0 or
// ?jetshadow=0, low quality, a reversed depth buffer): the jet casts into the scene's map as before.

import { JetShadow, JET_SHADOW_QUALITY } from './JetShadow.js';
import { SKIN, toneStatus } from './skin.js';

function urlFlag(name) {
  try {
    const v = new URLSearchParams(window.location.search).get(name);
    return v === null || !/^(0|false|off|no)$/i.test(v);
  } catch (e) {
    return true;
  }
}

export class Exterior {
  constructor(ctx) {
    this.ctx = ctx;
    this.name = 'Exterior';
    this.enabled = urlFlag('exterior');
    this.shadowEnabled = this.enabled && urlFlag('jetshadow');
    this.quality = 'high';
    this.jet = null;
    this.on = false;
    this._noCast = new Set();                // meshes we took out of the scene's shadow map
    this._noCastVisit = (o) => {             // (made once: the traversal runs every frame)
      if (o.isMesh && o.castShadow) { o.castShadow = false; this._noCast.add(o); }
    };
  }

  setQuality(q) {
    this.quality = JET_SHADOW_QUALITY[q] ? q : 'high';
    if (this.jet) this.jet.setQuality(this.quality);
  }

  update(f) {
    if (!f.draw) return;
    const v = this.ctx.visual;
    if (!this.shadowEnabled || !v || !v.loaded || !v.exterior) return;
    if (!this.jet) {
      this.jet = new JetShadow({ visual: v, terrain: this.ctx.terrain });
      this.jet.setQuality(this.quality);
      if (this.jet.ground) this.ctx.scene.add(this.jet.ground);
    }
    if (this.jet.ground && !this.jet.ground.parent) this.ctx.scene.add(this.jet.ground);
    this.on = this.jet.update(this.ctx.renderer, this.ctx.env, f.dt);
    this._casting(v, !this.on);
  }

  /** The jet's meshes out of (or back into) the scene's shadow map. */
  _casting(v, cast) {
    if (cast) {
      if (this._noCast.size) {
        for (const o of this._noCast) o.castShadow = true;
        this._noCast.clear();
      }
      return;
    }
    // every frame: the environment sets castShadow again when the jet's mesh count changes
    v.root.traverse(this._noCastVisit);
  }

  /** For tests and the bench. */
  stats() {
    const j = this.jet;
    return {
      enabled: this.enabled, shadow: this.shadowEnabled, on: this.on, quality: this.quality,
      size: j ? j.size : 0, redraws: j ? j.redraws : 0, aoRedraws: j ? j.aoRedraws : 0,
      calls: j ? j.lastCalls : 0, texel: j ? j.texel || 0 : 0, bytes: j ? j.bytes() : 0,
      ground: !!(j && j.ground && j.ground.visible), noCast: this._noCast.size,
      sunShare: j ? +(j.sunShare || 0).toFixed(3) : 0, agl: j ? +(j.agl || 0).toFixed(2) : 0,
      tones: toneStatus(), skin: { ...SKIN },
    };
  }

  /** GPU memory of the module's targets (bytes). */
  gpuBytes() { return this.jet ? this.jet.bytes() : 0; }

  /**
   * The render targets the scene does not reach (the GPU memory estimate, test/stats.js): the
   * underside map. (The jet map's depth texture is reached through the ground pass's uniforms and
   * counted there, at the estimate's generic 16 B a texel: 64 MB on high for a real 16 + 4 MB.)
   */
  targets() {
    const j = this.jet;
    return j && j.aoTarget ? [j.aoTarget] : [];
  }

  dispose() {
    const v = this.ctx.visual;
    if (v && v.root) this._casting(v, true);
    if (this.jet) this.jet.dispose();
    this.jet = null;
  }
}
