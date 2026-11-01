// Exterior lights of the F-35I: lens emission, glow sprites and the landing light.
//
//   nav        red (left) / green (right) position lights on the aft fuselage sides and wing tips;
//              steady, a glow sprite each, seen only from their side (the lens faces outwards)
//   anticoll   red beacons on the spine and the belly: 1 Hz, 80 ms flashes (both together:
//              they share one lens material)
//   formation  green electroluminescent strips (inlets, aft fuselage, fins): emission only,
//              lights.formation 0..1 dims them
//   landing    the lamp on the nose-gear leg: lens emission, a glow sprite and a THREE.SpotLight,
//              on while lights.landing and the gear is down and locked (gear > 0.9)
//
// Light positions and directions come from rig.info.lights (node-relative, model frame), so the
// sprites ride on the node that carries the lens (the landing lamp swings up with the nose leg).

import * as THREE from 'three';

const ROLE = { nav: 'nav', beacon: 'anticoll', anticoll: 'anticoll', formation: 'formation', landing: 'landing' };

// lens material -> emission brightness when on (multiplies the glTF emissive colour)
const LENS = {
  F35_nav_red: { role: 'nav', on: 5 },
  F35_nav_green: { role: 'nav', on: 5 },
  F35_nav_white: { role: 'nav', on: 4 },
  F35_beacon: { role: 'anticoll', on: 12 },
  F35_formation: { role: 'formation', on: 0.35 },
  F35_landing_light: { role: 'landing', on: 30 },
};

const SPRITE = {
  // glow size (m, up close), minimum on-screen size (px), brightness; colour from rig info
  nav: { size: 0.5, px: 4.0, gain: 1.5 },
  anticoll: { size: 0.85, px: 6.0, gain: 2.4 },
  landing: { size: 0.7, px: 7.0, gain: 3.0 },
};

let glowTexture = null;
function glow() {
  if (glowTexture) return glowTexture;
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n * 2 - 1, dy = (y + 0.5) / n * 2 - 1;
      const r = Math.sqrt(dx * dx + dy * dy);
      // bright core with a soft halo
      const v = Math.max(0, Math.exp(-r * r * 28) * 0.85 + Math.exp(-r * r * 5) * 0.25 - 0.012) * (r < 1 ? 1 : 0);
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.min(255, Math.round(v * 255));
      data[i + 3] = 255;
    }
  }
  glowTexture = new THREE.DataTexture(data, n, n);
  glowTexture.magFilter = THREE.LinearFilter;
  glowTexture.minFilter = THREE.LinearMipmapLinearFilter;
  glowTexture.generateMipmaps = true;
  glowTexture.needsUpdate = true;
  return glowTexture;
}

// The lamp sits square to the raked nose leg, so its lens axis points ~12 deg above the body's
// horizon; the beam is aimed ahead and 3 deg below the body axis instead (on the ground it lights
// the runway from ~10 m out). Node frame with the gear down = model frame (+Z forward).
const LANDING_BEAM = new THREE.Vector3(0, Math.sin(THREE.MathUtils.degToRad(-3)), Math.cos(THREE.MathUtils.degToRad(-3)));

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Matrix3();

export class AircraftLights {
  /**
   * @param {THREE.Object3D} root    the glTF scene (model frame)
   * @param {object} info            rig.info
   * @param {Map<string, THREE.Material[]>} materials  materials by name (materials.js)
   */
  constructor(root, info, materials) {
    this.state = { nav: false, anticoll: false, formation: 0, landing: false };
    this.gear = 1;
    this.time = 0;
    this.lenses = [];
    for (const [name, spec] of Object.entries(LENS)) {
      for (const m of materials.get(name) || []) {
        this.lenses.push({ mat: m, role: spec.role, on: spec.on });
        m.emissiveIntensity = 0;
      }
    }
    this.sprites = [];
    for (const l of info.lights || []) {
      const role = ROLE[l.role];
      const sp = SPRITE[role];
      if (!sp) continue;
      const node = root.getObjectByName(l.node);
      if (!node) continue;
      const colour = new THREE.Color().fromArray(l.colour || [1, 1, 1]);
      if (role === 'landing') colour.setRGB(1.0, 0.93, 0.8);
      const mat = new THREE.SpriteMaterial({
        map: glow(), color: colour, blending: THREE.AdditiveBlending, transparent: true,
        depthWrite: false, depthTest: true, sizeAttenuation: true,
      });
      const s = new THREE.Sprite(mat);
      s.name = 'Glow_' + l.name;
      const lens = new THREE.Vector3().fromArray(l.nodeDir).normalize();
      // just off the lens, so the airframe hides it from behind but the lens itself does not
      s.position.fromArray(l.nodePos).addScaledVector(lens, 0.04 + 0.25 * (l.size || 0.05));
      // the landing lamp's glare follows its beam (see below), the others their lens
      const dir = role === 'landing' ? LANDING_BEAM.clone() : lens;
      s.renderOrder = 5;
      s.visible = false;
      s.frustumCulled = false;            // tiny bounds: let the size logic decide
      node.add(s);
      this.sprites.push({ sprite: s, role, spec: sp, dir, colour });
    }
    // landing light: a real light source on the nose leg
    this.spot = null;
    const ll = info.landingLight;
    if (ll) {
      const node = root.getObjectByName(ll.node);
      if (node) {
        const spot = new THREE.SpotLight(0xfff0d8, 0, 900, THREE.MathUtils.degToRad(13), 0.5, 2);
        spot.name = 'LandingLight';
        spot.position.fromArray(ll.nodePos);
        spot.target.position.copy(spot.position).addScaledVector(LANDING_BEAM, 10);
        spot.castShadow = false;
        spot.visible = false;
        node.add(spot);
        node.add(spot.target);
        this.spot = spot;
        this.spotIntensity = 60000;          // cd: a ~450 W class lamp
      }
    }
  }

  /** lights: {nav, landing, formation, anticoll} (booleans or 0..1); gear 0..1. */
  set(lights, gear) {
    if (lights) {
      for (const k of ['nav', 'anticoll', 'landing']) if (k in lights) this.state[k] = !!lights[k];
      if ('formation' in lights) this.state.formation = typeof lights.formation === 'number'
        ? Math.min(1, Math.max(0, lights.formation)) : (lights.formation ? 1 : 0);
    }
    if (Number.isFinite(gear)) this.gear = gear;
  }

  /** Beacon flash: 80 ms every second. */
  beacon(t) {
    const p = t % 1.0;
    return p < 0.08 ? 1 : 0;
  }

  /** viewportHeight: canvas height in px (keeps distant lights a few pixels big). */
  update(dt, camera, viewportHeight = 1080) {
    this.time += dt;
    const st = this.state;
    const landingOn = st.landing && this.gear > 0.9;
    const flash = st.anticoll ? this.beacon(this.time) : 0;
    const level = { nav: st.nav ? 1 : 0, anticoll: flash, formation: st.formation, landing: landingOn ? 1 : 0 };
    for (const l of this.lenses) l.mat.emissiveIntensity = l.on * level[l.role];
    if (this.spot) {
      this.spot.visible = landingOn;
      this.spot.intensity = landingOn ? this.spotIntensity : 0;
    }
    if (!camera) return;
    const fov = camera.isPerspectiveCamera ? THREE.MathUtils.degToRad(camera.fov) : 1;
    const h = Math.max(1, viewportHeight);
    for (const s of this.sprites) {
      const on = level[s.role];
      const spr = s.sprite;
      if (!on) { spr.visible = false; continue; }
      spr.getWorldPosition(_w);
      camera.getWorldPosition(_v).sub(_w);
      const dist = Math.max(0.01, _v.length());
      _v.divideScalar(dist);
      // lens direction in world space
      _m.setFromMatrix4(spr.parent.matrixWorld);
      _d.copy(s.dir).applyMatrix3(_m).normalize();
      const facing = _d.dot(_v);
      // the beacons shine all round; position lights over a wide sector; the landing lamp is a
      // beam: dazzling inside it, a small lit lens from the side
      let dirGain = 1;
      if (s.role === 'nav') dirGain = THREE.MathUtils.smoothstep(facing, -0.25, 0.35);
      else if (s.role === 'landing') dirGain = 0.08 + 0.92 * Math.pow(THREE.MathUtils.smoothstep(facing, 0.6, 0.98), 2);
      if (dirGain <= 0.001 || dist < 0.6) { spr.visible = false; continue; }
      // world size: the physical glow up close, at least `px` pixels far away
      const pxSize = s.spec.px * 2 * dist * Math.tan(fov / 2) / h;
      const size = Math.max(s.spec.size, pxSize);
      spr.scale.setScalar(size);
      spr.material.color.copy(s.colour).multiplyScalar(s.spec.gain * dirGain * on);
      spr.visible = true;
    }
  }
}
