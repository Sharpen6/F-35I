// Crash effects: a fireball, then a column of smoke drifting with the wind, from camera-facing
// sprites (no textures to load: the puff is drawn on a canvas once).
//
//   const fx = new Effects(scene);
//   fx.explode(position, scale);   // when the jet crashes
//   fx.update(dt);                 // every frame
//   fx.clear();                    // on restart

import * as THREE from 'three';

function puffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  // a little lumpiness
  for (let i = 0; i < 40; i++) {
    const x = 30 + Math.random() * 68, y = 30 + Math.random() * 68, r = 6 + Math.random() * 16;
    const gg = g.createRadialGradient(x, y, 0, x, y, r);
    gg.addColorStop(0, 'rgba(255,255,255,0.25)');
    gg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gg;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const FIRE_N = 40, SMOKE_N = 90;

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'CrashEffects';
    scene.add(this.group);
    const tex = puffTexture();
    this.fire = [];
    this.smoke = [];
    for (let i = 0; i < FIRE_N; i++) {
      // self-luminous: not tone mapped, so the fire keeps its colour at any exposure (dusk, night)
      const m = new THREE.SpriteMaterial({ map: tex, color: 0xffa040, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, toneMapped: false });
      const s = new THREE.Sprite(m);
      s.visible = false;
      s.renderOrder = 6;
      this.group.add(s);
      this.fire.push({ s, v: new THREE.Vector3(), age: 0, life: 1 });
    }
    for (let i = 0; i < SMOKE_N; i++) {
      const m = new THREE.SpriteMaterial({ map: tex, color: 0x2a2826, depthWrite: false, transparent: true, opacity: 0 });
      const s = new THREE.Sprite(m);
      s.visible = false;
      s.renderOrder = 5;
      this.group.add(s);
      this.smoke.push({ s, v: new THREE.Vector3(), age: 0, life: 1, size: 1 });
    }
    this.origin = new THREE.Vector3();
    this.active = false;
    this.t = 0;
    this._emit = 0;
    this._next = 0;
    this.wind = new THREE.Vector3(3, 0, -1.5);
    // physical units: the Environment's sun gives about 4 at the ground, so a few thousand cd
    // light the wreck and the jets near it without washing out everything around
    this.light = new THREE.PointLight(0xff8a30, 0, 300, 2);
    this.group.add(this.light);
  }

  explode(pos, scale = 1) {
    this.clear();
    this.origin.copy(pos);
    this.active = true;
    this.t = 0;
    this.scale = scale;
    for (const p of this.fire) {
      p.s.position.copy(pos);
      p.v.set(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).normalize().multiplyScalar((8 + Math.random() * 22) * scale);
      p.age = 0;
      p.life = 0.8 + Math.random() * 1.6;
      p.s.visible = true;
    }
    this.light.position.copy(pos).y += 4;
  }

  clear() {
    this.active = false;
    for (const p of this.fire) p.s.visible = false;
    for (const p of this.smoke) p.s.visible = false;
    this.light.intensity = 0;
  }

  update(dt) {
    if (!this.active) return;
    dt = Math.min(dt, 0.1);
    this.t += dt;
    const sc = this.scale || 1;
    for (const p of this.fire) {
      if (!p.s.visible) continue;
      p.age += dt;
      if (p.age > p.life) {
        // the fire keeps burning near the ground for a while
        if (this.t < 12) {
          p.age = 0;
          p.life = 0.6 + Math.random() * 0.9;
          p.s.position.copy(this.origin).add(new THREE.Vector3((Math.random() - 0.5) * 8 * sc, 0, (Math.random() - 0.5) * 8 * sc));
          p.v.set((Math.random() - 0.5) * 3, 4 + Math.random() * 6, (Math.random() - 0.5) * 3).multiplyScalar(sc);
        } else { p.s.visible = false; continue; }
      }
      const k = p.age / p.life;
      p.v.multiplyScalar(Math.exp(-2.2 * dt));
      p.v.y += 6 * dt;
      p.s.position.addScaledVector(p.v, dt);
      const size = (4 + 18 * Math.sqrt(k)) * sc * (this.t < 1.5 ? 1.6 : 0.8);
      p.s.scale.setScalar(size);
      // additive: a white-hot core where many overlap, orange at the edges
      p.s.material.opacity = 0.35 * Math.max(0, 1 - k) * (this.t < 12 ? 1 : 0);
      p.s.material.color.setRGB(1, 0.3 + 0.3 * (1 - k), 0.06 * (1 - k));
    }
    this.light.intensity = this.t < 12 ? (this.t < 1 ? 2500 : 600 * (0.7 + 0.3 * Math.random())) * sc : 0;
    // smoke: a steady stream rising and drifting
    if (this.t < 40) {
      this._emit += dt * (this.t < 15 ? 6 : 2.5);
      while (this._emit >= 1) {
        this._emit -= 1;
        const p = this.smoke[this._next];
        this._next = (this._next + 1) % SMOKE_N;
        p.s.position.copy(this.origin).add(new THREE.Vector3((Math.random() - 0.5) * 6 * sc, 2, (Math.random() - 0.5) * 6 * sc));
        p.v.set((Math.random() - 0.5) * 2, 7 + Math.random() * 5, (Math.random() - 0.5) * 2);
        p.age = 0;
        p.life = 9 + Math.random() * 6;
        p.size = (6 + Math.random() * 6) * sc;
        p.s.visible = true;
      }
    }
    for (const p of this.smoke) {
      if (!p.s.visible) continue;
      p.age += dt;
      if (p.age > p.life) { p.s.visible = false; continue; }
      const k = p.age / p.life;
      p.s.position.addScaledVector(p.v, dt).addScaledVector(this.wind, dt * k);
      p.v.y *= Math.exp(-0.15 * dt);
      p.s.scale.setScalar(p.size * (1 + 5 * k));
      p.s.material.opacity = 0.55 * Math.min(1, p.age * 2) * (1 - k);
    }
  }
}
