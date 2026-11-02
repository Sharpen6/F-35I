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
//   faces repainted (a smooth edge along the sills), a floor plate between the pedals, ambient
//   occlusion of the tub with the light it passes round, the cockpit's own sun shadow
//   (pcd/shadow.js), the display's glow on the cockpit at night, LEDs and the kneeboard tablet at a
//   fixed picture level.
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
import { makeDetailTexture, makeGlassTexture } from './pcd/detail.js';
import { Interior, DISPLAY_ALPHA } from './pcd/interior.js';
import { CanopyGlass } from './pcd/canopy.js';
import { CockpitShadow } from './pcd/shadow.js';

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp1 = (x) => (x > 1 ? 1 : x < -1 ? -1 : x || 0);

/**
 * Rig nodes that show the pilot's inputs, re-posed here after the rig: the side-stick and the
 * hand on it, the throttle and the hand on it, the rudder pedals. The rig moves the stick and the
 * pedals with the flight controls' surface commands, which in a fly-by-wire jet are not where the
 * pilot holds them (trim, the control laws); here they follow the inputs. `base`: the lever a hand
 * holds (the hand turns with it about the lever's pivot).
 */
const INCEPTORS = {
  Stick: { controls: ['stick_pitch', 'stick_roll'] },
  Pilot_Hand_R: { base: 'Stick', controls: ['stick_pitch', 'stick_roll'] },
  Throttle: { controls: ['throttle'] },
  Pilot_Hand_L: { base: 'Throttle', controls: ['throttle'] },
  Pedal_L: { controls: ['pedals'] },
  Pedal_R: { controls: ['pedals'] },
};

/**
 * Which way the top of a lever moves for a positive input, in the glTF model frame (+X left, +Y
 * up, +Z forward): pull aft, roll right to the right, more throttle forward. The exported rig
 * (f35i_rig.json from the Blender rig, scripts/f35/rig.py, where the Stick and Throttle bones'
 * roll points their X axis fore and aft) turns the stick about swapped axes (a pull slides it to
 * the right) and swings the throttle sideways into the left wall. Where the rig's own motion
 * disagrees with this table, the hinge is rebuilt from it: the same angles about the axis that
 * moves the top the right way, through the lever's pivot. A corrected export is used as it is.
 */
const LEVER_MOTION = { stick_pitch: [0, 0, -1], stick_roll: [-1, 0, 0], throttle: [0, 0, 1] };

/** Materials of the glb this module takes over, by name (interior.js lists the repainted ones). */
export const COCKPIT_MATERIALS = {
  pcd: ['F35_PCD_Screen'],
  // the pilot's face and neck: hidden when the camera is at the eye (the head node is the visual's)
  face: ['P2_Skin', 'P2_TShirt'],
};

/**
 * The display's full brightness in scene units. A scene unit is ~25,000 cd/m2 (the sun's 4 units
 * of irradiance ~100,000 lx: grey card 0.23 units ~ 5,700 cd/m2), a sunlit-readable AMLCD gives
 * ~1,000 cd/m2. By day the glass itself is drawn far brighter (a picture level, legible through
 * the tone mapping); the light it throws on the canopy and the tub is the physical one, which by
 * day is lost in the daylight and at night is what the pilot sees.
 */
const PCD_LIGHT_MAX = 1000 / 25000;

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
    // the display in world space: its rectangle, picture level (gain) and physical light (light)
    this._pcdW = { o: new THREE.Vector3(), u: new THREE.Vector3(), v: new THREE.Vector3(), n: new THREE.Vector3(), c: new THREE.Vector3(), texture: null, gain: 0, light: 0 };
    this._light = { dir: new THREE.Vector3(0, 1, 0), color: new THREE.Color(0, 0, 0), ambient: new THREE.Color(0.3, 0.35, 0.45) };
    this._src = { st: null, levers: null, hours: 12, dayOfYear: 172, spawn: null, airports: null, wingmen: [] };
    if (!this.enabled) return;
    this._findMeshes();
    this.pcd = new PCD({ maxAnisotropy: renderer ? renderer.capabilities.getMaxAnisotropy() : 8 });
    this.pcd.onTextureChange = (t) => { if (this.pcdMaterial) { this.pcdMaterial.emissiveMap = t; this.pcdMaterial.needsUpdate = true; } };
    this._setupPcdMaterial();
    this.pcd.setMaps(terrain).catch(() => {});
    this.detail = makeDetailTexture(512);
    this.interior = new Interior({ visual, detail: this.detail });
    // the cockpit's own sun shadow, on the interior's analysis box (the pilot's head, hidden at the
    // eye, still casts)
    this.shadow = new CockpitShadow({ root: visual.root, box: this.interior.box, alsoCast: [visual.head, ...this.faceMeshes] });
    this.interior.shadowUniforms = this.shadow.uniforms;
    this._canopyNode = visual.root.getObjectByName('Canopy');
    this._canopyQ = new THREE.Quaternion();
    // (the patched materials need 5-9 new programs: the next render compiles them, once, normally
    // behind the menu. A compileAsync here would not help: the materials are already patched, and
    // behind a post chain the scene renders into a target with other program variants)
    this.interior.start().then((s) => { this.interiorStats = s; })
      .catch((e) => console.warn('Cockpit: interior:', e.message));
    // the canopy pass; its glass texture is made the first time the pass is on (_glass: 1024²,
    // 0.1-0.2 s of start-up that the low quality, without the pass, does not pay)
    this.glassDetail = null;
    this.canopy = new CanopyGlass({ root: visual.root });
    // the side-stick, the throttle, the hands on them and the pedals from the pilot's inputs (rig
    // nodes, re-posed after the rig); inceptorFix lists the controls whose hinge was rebuilt
    const inc = visual.player && visual.rig ? buildInceptors(visual.rig, visual.player) : { nodes: [], fixed: [] };
    this._inceptors = inc.nodes;
    this.inceptorFix = inc.fixed;
    this._inp = { stick_pitch: 0, stick_roll: 0, pedals: 0, throttle: 0 };
    this._inpShadow = { stick_pitch: 0, stick_roll: 0, pedals: 0, throttle: 0 };   // as at the last shadow redraw
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
    // a display: alpha 0 in the frame (interior.js DISPLAY_ALPHA: a post chain can keep it in colour
    // when its night vision greys the dark scene)
    this.pcdMaterial.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
gl_FragColor.a = ${DISPLAY_ALPHA.toFixed(1)};`);
    };
    this.pcdMaterial.customProgramCacheKey = () => 'ckDisplay';
    for (const m of this.pcdMeshes) m.material = this.pcdMaterial;
    this._pcdRect = pcdRectangle(this.pcdMeshes[0]);
  }

  // ------------------------------------------------------------------------------ module API
  setQuality(q) {
    if (!this.enabled) return;
    this.quality = q;
    const Q = COCKPIT_QUALITY[q] || COCKPIT_QUALITY.medium;
    this.pcd.setQuality(q);
    if (this.canopy) { this.canopy.enabled = Q.canopy; if (Q.canopy) this._glass(); }
    if (this.interior) this.interior.detailAmount = Q.detail;
    if (this.shadow) this.shadow.setQuality(q);
  }

  setTime(h, doy) {
    this.dayOfYear = doy;
  }

  reset() {
    if (!this.enabled) return;
    this.pcd.reset();
  }

  /**
   * The directional light as the scene has it: towards the sun, or the moon where the Environment
   * lights the night with it (its sunLight then; lightDirection), its irradiance (0 when switched
   * off) and the sky's (uAmbient).
   */
  light(f) {
    const L = this._light, env = this.env, S = env && env.sunLight;
    // as three lights the scene: from the light's and its target's world positions
    if (S) L.dir.subVectors(_t.setFromMatrixPosition(S.matrixWorld), _t2.setFromMatrixPosition(S.target.matrixWorld));
    if (!S || L.dir.lengthSq() < 1e-12) L.dir.copy((env && (env.lightDirection || env.sunDirection)) || (f && f.sunDirection) || _up);
    L.dir.normalize();
    if (S && S.visible) L.color.copy(S.color).multiplyScalar(S.intensity);
    else L.color.setRGB(0, 0, 0);
    if (env && env.uniforms && env.uniforms.uAmbient) L.ambient.copy(env.uniforms.uAmbient.value);
    return L;
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
    // the display: its systems model runs every frame, the canvas is redrawn only while it can be
    // seen: from the seat, or in view and over ~60 px wide (a drawn frame)
    if (st && this.pcd) {
      this._updatePcdRect();                  // (where it is now; its gain follows below)
      const visible = f.draw !== false && this.visual.object3d.visible && (this.inside > 0.5 || this._pcdOnScreen(cam) > 60);
      // headings as the helmet shows them: where it shows magnetic ones (hmd.last.magVar, the grid
      // convergence conv), the same reference; else the flight model's
      const H = app.hmd && app.hmd.last;
      this.pcd.variation = H && Number.isFinite(H.magVar) ? (H.conv || 0) - H.magVar : 0;
      const S = this._src;                    // (one object, filled every frame: no garbage)
      S.st = st;
      S.levers = app.input ? app.input.levers : _none;
      S.hours = f.time;
      S.dayOfYear = this.dayOfYear || (app.spawn && app.spawn.day_of_year) || 172;
      S.spawn = app.spawn;
      S.airports = this.terrain ? this.terrain.airports : NO_LIST;
      const W = app.wingmen && app.wingmen.count ? app.wingmen.items : NO_LIST;
      S.wingmen.length = W.length;
      for (let i = 0; i < W.length; i++) {
        const o = S.wingmen[i] || (S.wingmen[i] = { position: null, quaternion: null });
        o.position = W[i].drawPos; o.quaternion = W[i].drawQuat;
      }
      this.pcd.update(f.dt || 0, S, visible);
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
    const L = this.light(f);
    const lit = L.color.r + L.color.g + L.color.b > 1e-6;     // (no directional light on a dark night)
    if (this.shadow && this.interior && this.interior.ready && this.interior.enabled && lit && d < 30 && this.visual.object3d.visible) {
      // the cockpit's sun shadow (redrawn when the light turns in the aircraft's frame, the canopy
      // moves, or the stick and the throttle move: ~1 mm at their tops)
      let moved = false;
      if (this._canopyNode) { moved = this._canopyNode.quaternion.angleTo(this._canopyQ) > 1e-4; this._canopyQ.copy(this._canopyNode.quaternion); }
      const I = this._inp, J = this._inpShadow;
      const moving = Math.abs(I.stick_pitch - J.stick_pitch) > 0.01 || Math.abs(I.stick_roll - J.stick_roll) > 0.01 ||
        Math.abs(I.throttle - J.throttle) > 0.005 || Math.abs(I.pedals - J.pedals) > 0.02;
      if (this.shadow.update(this.renderer, cam, L.dir, f.dt || 0, moved, moving)) {
        J.stick_pitch = I.stick_pitch; J.stick_roll = I.stick_roll; J.throttle = I.throttle; J.pedals = I.pedals;
      }
    } else if (this.shadow) this.shadow.uniforms.uCkShadowOn.value = 0;
    if (this.interior) {
      _up2.set(0, 1, 0).transformDirection(this.visual.root.matrixWorld);
      this.interior.update({ exposure, sunY, power, camera: cam, light: L, up: _up2, pcdGlow: this.pcd.glow, pcdIntensity: P.light, pcdCentre: P.c, pcdNormal: P.n });
    }
    if (this.canopy) {
      const show = this.canopy.enabled !== false && d < 80 && this.visual.object3d.visible;
      this.canopy.visible = show;
      if (show && !this.glassDetail) this._glass();       // (on without a setQuality)
      if (show && this.env) {
        this.canopy.update({
          lightDir: L.dir, lightColor: L.color, ambient: L.ambient, inside: this.inside,
          albedo: this.interior ? this.interior.albedo : 0.06,
          pcd: P.texture ? P : null,
        });
      }
    }
  }

  /**
   * The side-stick, the throttle, the hands on them and the pedals where the pilot holds them
   * (input frame of this tick, test inputs included; a stick has some mass: 50 ms; the throttle is
   * the lever, Input.levers), posed as RigPlayer.apply does.
   */
  _poseInceptors(dt) {
    const input = this.app && this.app.input;
    const f = input ? input.frame : null;
    if (!f || !this._inceptors.length) return;
    // (the test API's inputs override the frame's, as main.js applies them)
    const t = this.app.testInput || _none;
    const pick = (k) => clamp1(t[k] != null ? t[k] : f[k]);
    const I = this._inp, k = 1 - Math.exp(-Math.max(0, dt) / 0.05);
    I.stick_pitch += (pick('pitch') - I.stick_pitch) * k;
    I.stick_roll += (pick('roll') - I.stick_roll) * k;
    I.pedals += (pick('yaw') - I.pedals) * k;
    const thr = input.levers ? input.levers.throttle : f.throttle;
    I.throttle = Number.isFinite(thr) ? Math.min(1, Math.max(0, thr)) : 0;
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

  /** The canopy's glass texture, made once, the first time the canopy pass is on. */
  _glass() {
    if (this.glassDetail || !this.canopy || !this.canopy.mesh) return;
    this.glassDetail = makeGlassTexture(1024);
    this.canopy.setDetail(this.glassDetail);
  }

  /** Tests: the tops of the side-stick and the throttle (17 cm up the lever) in the glTF root frame. */
  leverTips() {
    const root = this.visual.root, out = {};
    for (const [k, name] of [['stick', 'Stick'], ['throttle', 'Throttle']]) {
      const o = root.getObjectByName(name);
      if (!o) continue;
      o.updateWorldMatrix(true, false);
      out[k] = root.worldToLocal(o.localToWorld(new THREE.Vector3(0, 0.17, 0))).toArray();
    }
    return out;
  }

  /** The display's width on screen (px; 0 when out of view), from this frame's rectangle. */
  _pcdOnScreen(cam) {
    const P = this._pcdW;
    if (!this._pcdRect || !cam || !cam.isPerspectiveCamera) return 0;
    _t.copy(P.c).applyMatrix4(cam.matrixWorldInverse);
    const z = -_t.z;
    if (z < cam.near) return 0;
    _t.applyMatrix4(cam.projectionMatrix);
    if (Math.abs(_t.x) > 1.3 || Math.abs(_t.y) > 1.3) return 0;
    const h = this.renderer ? this.renderer.domElement.height : 1080;
    return P.u.length() / (2 * z * Math.tan(cam.fov * Math.PI / 360) / cam.zoom) * h;
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
    P.light = Math.min(P.gain, PCD_LIGHT_MAX);
  }

  dispose() {
    if (!this.enabled) return;
    this.pcd.dispose();
    this.pcdMaterial?.dispose();
    this.interior?.dispose();
    this.canopy?.dispose();
    this.shadow?.dispose();
    this.detail?.dispose();
    this.glassDetail?.dispose();
  }
}

const _t = new THREE.Vector3(), _t2 = new THREE.Vector3(), _up2 = new THREE.Vector3();
const _rq = new THREE.Quaternion(), _hq = new THREE.Quaternion();
const _rt = new THREE.Vector3(), _ht = new THREE.Vector3();
const _none = {};
const NO_LIST = [];
const _up = new THREE.Vector3(0, 1, 0);
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

/**
 * The inceptor nodes and how each moves with its controls (glTF model frame, relative to the
 * node's rest position, as RigPlayer keeps them): [{name, object, rest, parts}], parts outermost
 * first, a part {control, kind: 'hinge', pivot, axis, xs, a} or {control, kind: 'trs', xs, q, t}.
 * The levers' hinges are checked against LEVER_MOTION and rebuilt where the rig moves them the
 * wrong way (fixed: the controls rebuilt); a hand then turns about the corrected lever's pivot.
 */
export function buildInceptors(rig, player) {
  const entries = new Map(player.nodes.map((n) => [n.name, n]));
  const order = new Map((rig.compose || []).map((c, i) => [c, i]));
  /** The rig's hinge of node `name` for control `c` (a node-wide hinge or the control's own). */
  const rigHinge = (name, c) => {
    const nd = rig.nodes && rig.nodes[name];
    const d = nd && nd.controls && nd.controls[c];
    const ctl = rig.controls && rig.controls[c];
    if (!d || !d.a || !ctl) return null;
    const h = nd.hinge || (d.axis ? d : null);
    if (!h || !h.axis) return null;
    return { control: c, kind: 'hinge', pivot: v3(h.pivot || [0, 0, 0]), axis: v3(h.axis).normalize(), xs: ctl.x, a: d.a };
  };
  // the levers: does a full positive input move the top (15 cm above the pivot) the right way?
  const levers = new Map();
  const fixed = [];
  for (const [name, def] of Object.entries(INCEPTORS)) {
    if (def.base) continue;
    for (const c of def.controls) {
      const want = LEVER_MOTION[c];
      const h = rigHinge(name, c);
      if (!want || !h) continue;
      const a1 = interp(h.xs, h.a, h.xs[h.xs.length - 1]);
      const top = new THREE.Vector3(0, 0.15, 0).add(h.pivot);
      const moved = top.clone().sub(h.pivot).applyAxisAngle(h.axis, a1).add(h.pivot).sub(top);
      const w = v3(want);
      if (moved.lengthSq() > 1e-10 && moved.normalize().dot(w) > 0.9) { levers.set(`${name}/${c}`, { ...h, fixed: false }); continue; }
      // rebuilt: rotating by a about u moves the up vector along u x Y, so u = sign(a) (Y x w)
      const axis = new THREE.Vector3(0, 1, 0).cross(w).normalize().multiplyScalar(Math.sign(a1) || 1);
      levers.set(`${name}/${c}`, { ...h, axis, fixed: true });
      fixed.push(c);
    }
  }
  const nodes = [];
  for (const [name, def] of Object.entries(INCEPTORS)) {
    const e = entries.get(name);
    if (!e) continue;
    const parts = [];
    for (const c of def.controls) {
      const L = levers.get(`${def.base || name}/${c}`);
      if (L && !def.base) parts.push(L);
      else if (L && def.base) {
        // a hand: about the lever's pivot (the base's rest + its pivot, from the hand's rest)
        const own = rigHinge(name, c);
        const b = entries.get(def.base);
        if (!L.fixed && own) parts.push(own);
        else if (b && own) parts.push({ ...own, axis: L.axis, pivot: b.rest.clone().add(L.pivot).sub(e.rest) });
      } else {
        // no lever hinge (the pedals: a slide), the rig's own part
        const p = e.parts.find((q) => q.control === c);
        if (p) parts.push(p);
      }
    }
    if (!parts.length) continue;
    parts.sort((p, q) => (order.get(q.control) ?? 999) - (order.get(p.control) ?? 999));    // outermost first
    nodes.push({ name, object: e.object, rest: e.rest, parts });
  }
  return { nodes, fixed: [...new Set(fixed)] };
}

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
