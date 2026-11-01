// Stand-in for js/terrain/Terrain.js (sim/DESIGN.md interface), used with index.html?stubs=1:
// flat ground at 59 m MSL (Tel Nof's elevation) with a 2,400 m runway 36/18 at the origin, a
// taxiway, a few hangars and a tower, one airport and three spawns. The grass is a large
// textured plane that follows the camera so it never ends.

import * as THREE from 'three';

const ELEV = 59;
const RWY_LEN = 2400, RWY_W = 45;

function canvasTexture(w, h, draw, repeat = 1) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat !== 1) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); }
  return t;
}

export class Terrain {
  constructor({ renderer, scene, env, baseUrl = 'data/terrain/' } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.env = env;
    this.baseUrl = baseUrl;
    this.group = new THREE.Group();
    this.group.name = 'StubTerrain';
    scene.add(this.group);
    this.loaded = false;
    this.attribution = 'Stand-in terrain (dev/stubs): flat ground and one runway, no real data.';
    this.airports = [{
      icao: 'STUB', name: 'Stub field', elev_m: ELEV,
      runways: [{
        ids: ['36', '18'], width_m: RWY_W, length_m: RWY_LEN, surface: 'asphalt',
        ends: [
          { id: '36', x: 0, y: ELEV, z: RWY_LEN / 2, heading_deg: 0 },
          { id: '18', x: 0, y: ELEV, z: -RWY_LEN / 2, heading_deg: 180 },
        ],
      }],
    }];
    this.spawns = {
      stub_36: { label: 'Stub field, runway 36, ready for takeoff', x: 0, y: ELEV, z: RWY_LEN / 2 - 60, heading_deg: 0, on_ground: true, speed_ms: 0, gear: 1, throttle: 0 },
      stub_air: { label: 'Over the stub field, 1,500 m, heading east', x: -4000, y: 1500, z: -2000, heading_deg: 90, on_ground: false, speed_ms: 180, gear: 0, throttle: 0.62, ground_y: ELEV },
      stub_final: { label: 'Stub field, 8 km final runway 36, gear down', x: 0, y: ELEV + 420, z: RWY_LEN / 2 + 8000, heading_deg: 0, on_ground: false, speed_ms: 75, gear: 1, throttle: 0.5, flight_path_deg: -3, ground_y: ELEV },
    };
  }

  async load(onProgress = () => {}) {
    const steps = ['terrain: stand-in heights', 'terrain: stand-in imagery', 'terrain: runway'];
    for (let i = 0; i < steps.length; i++) {
      onProgress(i / steps.length, steps[i]);
      await new Promise((r) => setTimeout(r, 40));
    }
    this._build();
    this.loaded = true;
    onProgress(1, 'terrain: ready');
    return this;
  }

  _build() {
    // grass: noise and field patches, repeating
    const grass = canvasTexture(512, 512, (g, w, h) => {
      g.fillStyle = '#6f7a48';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 70; i++) {
        g.fillStyle = `hsl(${60 + Math.random() * 40}, ${18 + Math.random() * 20}%, ${28 + Math.random() * 14}%)`;
        g.fillRect(Math.random() * w, Math.random() * h, 40 + Math.random() * 160, 30 + Math.random() * 120);
      }
      for (let i = 0; i < 9000; i++) {
        g.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,230' : '20,30,10'},0.06)`;
        g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
    }, 1);
    grass.wrapS = grass.wrapT = THREE.RepeatWrapping;
    this._grassTex = grass;
    const size = 120000;
    // subdivided: one 120 km quad has too little depth precision near the camera
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size, 160, 160).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: grass, roughness: 0.95, metalness: 0 }),
    );
    grass.repeat.set(size / 400, size / 400);
    ground.position.y = ELEV;
    ground.receiveShadow = true;
    this.ground = ground;
    this.group.add(ground);

    // runway with markings (canvas 64 px across, 2,400 m long -> drawn in 3 tiled pieces)
    const rwTex = canvasTexture(256, 4096, (g, w, h) => {
      g.fillStyle = '#3d3f42';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 20000; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 3); }
      const px = w / RWY_W, pz = h / RWY_LEN;
      g.fillStyle = '#e9e9e4';
      // edge lines, centreline dashes
      g.fillRect(1 * px, 0, 0.9 * px, h);
      g.fillRect(w - 1.9 * px, 0, 0.9 * px, h);
      for (let z = 120; z < RWY_LEN - 120; z += 50) g.fillRect(w / 2 - 0.45 * px, z * pz, 0.9 * px, 30 * pz);
      // threshold bars and numbers at both ends
      for (const [end, label] of [[0, '18'], [1, '36']]) {
        for (let i = 0; i < 8; i++) {
          const x = (3 + i * 2.2 + (i >= 4 ? 4 : 0)) * px;
          const z0 = end ? h - 36 * pz : 6 * pz;
          g.fillRect(x, z0, 1.6 * px, 30 * pz);
        }
        g.save();
        g.translate(w / 2, end ? h - 70 * pz : 70 * pz);
        if (!end) g.rotate(Math.PI);
        g.font = `bold ${Math.round(24 * pz * 1.0)}px Arial`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.scale(1, 1);
        g.fillText(label, 0, 0);
        g.restore();
      }
    });
    rwTex.anisotropy = 16;
    const runway = new THREE.Mesh(
      new THREE.PlaneGeometry(RWY_W, RWY_LEN).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: rwTex, roughness: 0.85, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    runway.position.set(0, ELEV + 0.06, 0);
    runway.receiveShadow = true;
    this.group.add(runway);
    // taxiway and apron
    const conc = new THREE.MeshStandardMaterial({ color: 0x8c8b86, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const twy = new THREE.Mesh(new THREE.PlaneGeometry(22, RWY_LEN * 0.8).rotateX(-Math.PI / 2), conc);
    twy.position.set(160, ELEV + 0.05, 0);
    twy.receiveShadow = true;
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(220, 420).rotateX(-Math.PI / 2), conc);
    apron.position.set(300, ELEV + 0.05, -200);
    apron.receiveShadow = true;
    this.group.add(twy, apron);
    // hangars and a tower for scale and motion cues
    const hangarMat = new THREE.MeshStandardMaterial({ color: 0xb8b2a2, roughness: 0.8 });
    for (let i = 0; i < 6; i++) {
      const hgr = new THREE.Mesh(new THREE.BoxGeometry(36, 12, 40), hangarMat);
      hgr.position.set(440, ELEV + 6, -380 + i * 70);
      hgr.castShadow = hgr.receiveShadow = true;
      this.group.add(hgr);
    }
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(3, 4, 26, 12), hangarMat);
    tower.position.set(330, ELEV + 13, 180);
    const cab = new THREE.Mesh(new THREE.CylinderGeometry(6, 5, 5, 12), new THREE.MeshStandardMaterial({ color: 0x334455, roughness: 0.2, metalness: 0.5 }));
    cab.position.set(330, ELEV + 28, 180);
    this.group.add(tower, cab);
    // scattered trees / buildings across the plain
    const rnd = (a, b) => a + Math.random() * (b - a);
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const blockMat = new THREE.MeshStandardMaterial({ color: 0xc9c2b0, roughness: 0.9 });
    const inst = new THREE.InstancedMesh(boxGeo, blockMat, 1500);
    const m = new THREE.Matrix4();
    for (let i = 0; i < inst.count; i++) {
      let x, z;
      do { x = rnd(-30000, 30000); z = rnd(-30000, 30000); } while (Math.abs(x) < 700 && Math.abs(z) < 2000);
      const s = rnd(8, 40), hh = rnd(6, 30);
      m.compose(new THREE.Vector3(x, ELEV + hh / 2, z), new THREE.Quaternion(), new THREE.Vector3(s, hh, s * rnd(0.6, 1.6)));
      inst.setMatrixAt(i, m);
    }
    inst.castShadow = false;
    inst.receiveShadow = true;
    this.group.add(inst);
  }

  update(camera) {
    if (!this.loaded) return;
    // keep the endless grass under the camera (snapped to the texture period: no swimming)
    const p = camera.getWorldPosition(new THREE.Vector3());
    this.ground.position.x = Math.round(p.x / 400) * 400;
    this.ground.position.z = Math.round(p.z / 400) * 400;
  }

  heightAt() { return ELEV; }

  normalAt(x, z, out = new THREE.Vector3()) { return out.set(0, 1, 0); }

  surfaceAt(x, z) {
    if (Math.abs(x) <= RWY_W / 2 && Math.abs(z) <= RWY_LEN / 2) return { type: 'runway', friction: 0.8 };
    return { type: 'ground', friction: 0.55 };
  }
}
