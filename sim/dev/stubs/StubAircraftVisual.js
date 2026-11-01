// Stand-in for js/aircraft/AircraftVisual.js (sim/DESIGN.md interface), used with
// index.html?stubs=1: an F-35-sized box-and-wings jet in the body frame (+X right, +Y up,
// -Z forward, origin at the reference point) with moving stabilators, gear that folds away,
// a canopy that opens, an afterburner cone and nav lights. info has the same fields as the
// real rig (eye, gearContacts, nozzle, length, span).

import * as THREE from 'three';

export class AircraftVisual {
  constructor({ scene = null, baseUrl = 'data/aircraft/' } = {}) {
    this.scene = scene;
    this.baseUrl = baseUrl;
    this.object3d = new THREE.Group();
    this.object3d.name = 'StubF35';
    this.info = null;
    this.loaded = false;
    this._c = { gear: 1, ab: 0, throttle: 0, stick_pitch: 0, stick_roll: 0, canopy: 0, pedals: 0 };
    if (scene) scene.add(this.object3d);
  }

  async load(onProgress = () => {}) {
    onProgress(0, 'aircraft: stand-in');
    await new Promise((r) => setTimeout(r, 30));
    const g = this.object3d;
    const skin = new THREE.MeshStandardMaterial({ color: 0x7b8289, roughness: 0.55, metalness: 0.3 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3a3e42, roughness: 0.6, metalness: 0.4 });
    const add = (mesh, parent = g) => { mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh; };
    // fuselage (nose at -Z), nose cone, intakes
    add(new THREE.Mesh(new THREE.BoxGeometry(2.3, 1.5, 11.5), skin)).position.set(0, 0.1, 0.6);
    const nose = add(new THREE.Mesh(new THREE.ConeGeometry(0.85, 3.4, 16), skin));
    nose.rotation.x = -Math.PI / 2;
    nose.position.set(0, 0.15, -6.85);
    for (const s of [-1, 1]) add(new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.1, 3.2), dark)).position.set(s * 1.45, 0.05, -2.4);
    // wings (a trapezoid), stabilators, canted fins
    const wingShape = new THREE.Shape([new THREE.Vector2(0, -2.6), new THREE.Vector2(4.2, 0.9), new THREE.Vector2(4.2, 2.2), new THREE.Vector2(0, 2.6)]);
    const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.18, bevelEnabled: false }).rotateX(Math.PI / 2);
    const wr = add(new THREE.Mesh(wingGeo, skin)); wr.position.set(1.1, 0.15, 1.5);
    const wl = add(new THREE.Mesh(wingGeo, skin)); wl.scale.x = -1; wl.position.set(-1.1, 0.15, 1.5);
    this.stabs = [];
    for (const s of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(s * 1.4, 0.2, 5.9);
      g.add(pivot);
      add(new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.1, 1.9), skin), pivot).position.set(s * 1.2, 0, 0.2);
      this.stabs.push({ pivot, side: s });
      const fin = add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.3, 2.2), skin));
      fin.position.set(s * 1.25, 1.55, 4.7);
      fin.rotation.z = -s * 0.42;
    }
    // canopy on a hinge at its front
    this.canopyHinge = new THREE.Group();
    this.canopyHinge.position.set(0, 0.95, -5.4);
    g.add(this.canopyHinge);
    const glass = new THREE.Mesh(new THREE.SphereGeometry(0.62, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x9a7a3a, roughness: 0.08, metalness: 0.85, transparent: true, opacity: 0.55 }));
    glass.scale.set(1, 0.85, 2.6);
    glass.position.set(0, 0, 1.4);
    this.canopyHinge.add(glass);
    // a simple cockpit: panel and a seat, so the cockpit view has a frame of reference
    add(new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.35, 0.5), dark)).position.set(0, 0.62, -5.35);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 1.6), dark)).position.set(-0.52, 1.25, -4.9);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 1.6), dark)).position.set(0.52, 1.25, -4.9);
    // nozzle and afterburner cone
    const nz = add(new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.62, 1.2, 16, 1, true), dark));
    nz.rotation.x = Math.PI / 2;
    nz.position.set(0, 0.12, 6.6);
    this.flame = new THREE.Mesh(new THREE.ConeGeometry(0.45, 4, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xff9a40, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.flame.rotation.x = -Math.PI / 2;
    this.flame.position.set(0, 0.12, 9.2);
    this.flame.visible = false;
    g.add(this.flame);
    // gear: legs + wheels hanging from pivots, folding forward / inward
    this.gearParts = [];
    const tyre = new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.9 });
    const leg = new THREE.MeshStandardMaterial({ color: 0xd8d8d0, roughness: 0.5, metalness: 0.4 });
    const mk = (x, y, z, len, r) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, z);
      g.add(pivot);
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, len, 8), leg), pivot).position.y = -len / 2;
      const wheel = add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.25, 16).rotateZ(Math.PI / 2), tyre), pivot);
      wheel.position.y = -len;
      this.gearParts.push({ pivot, x });
    };
    mk(0, -0.65, -3.585, 1.42 - 0.3, 0.3);
    mk(-2.17, -0.6, 2.435, 1.33 - 0.43, 0.43);
    mk(2.17, -0.6, 2.435, 1.33 - 0.43, 0.43);
    // nav lights
    const navGeo = new THREE.SphereGeometry(0.08, 8, 6);
    const red = new THREE.Mesh(navGeo, new THREE.MeshBasicMaterial({ color: 0xff2020 }));
    red.position.set(-5.3, 0.15, 3.0);
    const grn = new THREE.Mesh(navGeo, new THREE.MeshBasicMaterial({ color: 0x20ff40 }));
    grn.position.set(5.3, 0.15, 3.0);
    this.navLights = [red, grn];
    g.add(red, grn);

    this.info = {
      eye: new THREE.Vector3(0, 1.0803, -4.4714),
      eyeForward: new THREE.Vector3(0, -0.1045, -0.9945),
      gearContacts: [
        { name: 'nose', pos: new THREE.Vector3(0, -2.0724, -3.585), radius: 0.2985, travel: 0.21, staticCompression: 0.05 },
        { name: 'left', pos: new THREE.Vector3(-2.17, -1.935, 2.435), radius: 0.432, travel: 0.225, staticCompression: 0.05 },
        { name: 'right', pos: new THREE.Vector3(2.17, -1.935, 2.435), radius: 0.432, travel: 0.225, staticCompression: 0.05 },
      ],
      nozzle: { exit: new THREE.Vector3(0, 0.12, 6.205), radius: 0.47 },
      length: 15.69,
      span: 10.78,
    };
    this.loaded = true;
    onProgress(1, 'aircraft: ready');
    return this;
  }

  setPose(position, quaternion) {
    if (position) this.object3d.position.copy(position);
    if (quaternion) this.object3d.quaternion.copy(quaternion);
  }

  setControls(c) {
    if (!c) return;
    for (const k of Object.keys(this._c)) if (Number.isFinite(c[k])) this._c[k] = c[k];
    if (c.lights) this._lights = c.lights;
  }

  update(dt, camera) {
    if (!this.loaded) return;
    const c = this._c;
    for (const s of this.stabs) s.pivot.rotation.x = -(c.stick_pitch * 0.35) + s.side * c.stick_roll * 0.14;
    this.canopyHinge.rotation.x = c.canopy * 0.7;
    const down = c.gear;
    for (const p of this.gearParts) {
      p.pivot.visible = down > 0.02;
      p.pivot.rotation.x = p.x === 0 ? -(1 - down) * 1.5 : 0;
      p.pivot.rotation.z = p.x === 0 ? 0 : Math.sign(p.x) * (1 - down) * 1.5;
    }
    const ab = Number.isFinite(c.ab) ? c.ab : Math.max(0, (c.throttle - 0.75) / 0.25);
    this.flame.visible = ab > 0.02;
    this.flame.scale.set(0.8 + 0.4 * ab, 0.5 + 0.7 * ab, 0.8 + 0.4 * ab);
    this.flame.material.opacity = 0.35 + 0.45 * ab * (0.85 + 0.15 * Math.random());
    const navOn = !this._lights || this._lights.nav !== false;
    for (const l of this.navLights) l.visible = navOn;
    this.object3d.updateMatrixWorld();
  }

  eyeWorld(out = new THREE.Vector3()) {
    return this.object3d.localToWorld(out.copy(this.info.eye));
  }
}
