// Terrain / environment test page: free-fly camera over the terrain.
//
// URL parameters (all optional):
//   data=<url>         terrain data folder (default ../data/terrain/)
//   spawn=<name>       start at a spawn from spawns.json
//   x, y, z            camera position (m); agl=<m> puts y that far above the ground
//   hdg, pitch         view direction in degrees (heading 0 = north, pitch + = up)
//   t, day             local solar time (h) and day of year
//   fov                vertical field of view (deg, default 60)
//   vis                haze visibility (km)
//   lod=1, wire=1      LOD colours / wireframe
//   jet=1              stand-in aircraft (data/aircraft/f35i.glb if present) for shadows
//   jx, jz, jhdg       where to put the jet (default: 60 m ahead of the camera, on the ground)
//   hud=0              hide the panel (screenshots)
//   depth=log          logarithmic depth buffer even where reversed depth is available
// window.__dev exposes the objects for scripted tests (see sim/tests/terrain_screens.mjs).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Environment } from '../js/env/Environment.js';
import { Terrain } from '../js/terrain/Terrain.js';
import { xzToLonLat } from '../js/world/coords.js';

const P = new URLSearchParams(location.search);
const num = (k, d) => (P.has(k) && P.get(k) !== '' && Number.isFinite(Number(P.get(k))) ? Number(P.get(k)) : d);
const DEG = Math.PI / 180;

// reversed depth (EXT_clip_control) where available, else three falls back to the
// logarithmic depth buffer: 0.5 m to 2000 km without z-fighting either way
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  reversedDepthBuffer: P.get('depth') !== 'log',
  logarithmicDepthBuffer: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(P.has('dpr') ? num('dpr', 1) : Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(num('fov', 60), window.innerWidth / window.innerHeight, 0.5, 2e6);
camera.rotation.order = 'YXZ';
const env = new Environment({ renderer, scene, visibilityKm: num('vis', 60) });
const terrain = new Terrain({ renderer, scene, env, baseUrl: P.get('data') || '../data/terrain/' });

const view = { yaw: 0, pitch: 0, speed: 150 };
function setView({ x, y, z, hdg = 0, pitch = 0, agl = null }) {
  const gy = terrain.heightAt(x, z);
  camera.position.set(x, agl != null ? gy + agl : y, z);
  view.yaw = -hdg * DEG;
  view.pitch = pitch * DEG;
  camera.rotation.set(view.pitch, view.yaw, 0);
  camera.updateMatrixWorld();
}

// --- UI ---------------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const timeEl = $('time'), dayEl = $('day'), visEl = $('vis');
timeEl.value = num('t', 10.5);
dayEl.value = num('day', 172);
visEl.value = num('vis', 60);
const applyTime = () => {
  env.setTime(Number(timeEl.value), Number(dayEl.value));
  const h = Math.floor(timeEl.value), m = Math.round((timeEl.value - h) * 60);
  $('timeVal').textContent = `${h}:${String(m).padStart(2, '0')}`;
  $('dayVal').textContent = dayEl.value;
};
timeEl.addEventListener('input', applyTime);
dayEl.addEventListener('input', applyTime);
visEl.addEventListener('change', () => { env.setVisibility(Number(visEl.value)); $('visVal').textContent = visEl.value; });
$('visVal').textContent = visEl.value;
applyTime();
$('lod').checked = P.get('lod') === '1';
$('wire').checked = P.get('wire') === '1';
if (P.get('hud') === '0') document.body.classList.add('hud-off');

// --- input --------------------------------------------------------------------------------
const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  keys.add(e.code);
  if (e.code === 'Equal' || e.code === 'NumpadAdd') view.speed = Math.min(5000, view.speed * 1.5);
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') view.speed = Math.max(2, view.speed / 1.5);
  if (e.code === 'KeyH') document.body.classList.toggle('hud-off');
  if (e.code === 'KeyL') $('lod').checked = !$('lod').checked;
  if (e.code === 'KeyG') $('wire').checked = !$('wire').checked;
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const canvas = renderer.domElement;
let dragging = false;
canvas.addEventListener('mousedown', () => { dragging = true; });
addEventListener('mouseup', () => { dragging = false; });
canvas.addEventListener('dblclick', () => canvas.requestPointerLock?.());
addEventListener('mousemove', (e) => {
  if (!dragging && document.pointerLockElement !== canvas) return;
  view.yaw -= e.movementX * 0.0025;
  view.pitch = Math.max(-1.55, Math.min(1.55, view.pitch - e.movementY * 0.0025));
});
canvas.addEventListener('wheel', (e) => {
  view.speed = Math.max(2, Math.min(5000, view.speed * (e.deltaY < 0 ? 1.25 : 0.8)));
  e.preventDefault();
}, { passive: false });
addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// --- stand-in aircraft (shadow and lighting test) -----------------------------------------
let jet = null;
async function makeJet() {
  const g = new THREE.Group();
  g.name = 'TestJet';
  try {
    const head = await fetch('../data/aircraft/f35i.glb', { method: 'HEAD' });
    if (!head.ok) throw new Error('no glb');
    const gltf = await new GLTFLoader().loadAsync('../data/aircraft/f35i.glb');
    gltf.scene.rotation.y = Math.PI; // glTF +Z forward -> body -Z forward
    g.add(gltf.scene);
    g.userData.gearHeight = 2.3;
  } catch (e) {
    // simple F-35 sized stand-in: fuselage, wings, tails
    const mat = new THREE.MeshStandardMaterial({ color: 0x6d747c, metalness: 0.35, roughness: 0.45 });
    const fus = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 15.6, 16), mat);
    fus.rotation.x = Math.PI / 2;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.9, 3, 16), mat);
    nose.rotation.x = -Math.PI / 2; nose.position.z = -9.3;
    const wingShape = new THREE.Shape([new THREE.Vector2(0, -3), new THREE.Vector2(5.3, 1.5), new THREE.Vector2(5.3, 3), new THREE.Vector2(0, 3)]);
    const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.25, bevelEnabled: false });
    const wl = new THREE.Mesh(wingGeo, mat); wl.rotation.x = Math.PI / 2; wl.position.set(0.8, 0, 1);
    const wr = wl.clone(); wr.scale.x = -1; wr.position.x = -0.8;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.15, 2.4, 2.4), mat); fin.position.set(1.2, 1.6, 6); fin.rotation.z = -0.4;
    const fin2 = fin.clone(); fin2.position.x = -1.2; fin2.rotation.z = 0.4;
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 8), new THREE.MeshStandardMaterial({ color: 0x8a6a30, metalness: 0.9, roughness: 0.1 }));
    canopy.scale.set(1, 0.8, 2.6); canopy.position.set(0, 0.85, -4.2);
    g.add(fus, nose, wl, wr, fin, fin2, canopy);
    g.userData.gearHeight = 2.0;
  }
  scene.add(g);
  return g;
}
/** Shows the stand-in jet on the ground (default: 60 m ahead of the camera) and casts its shadow. */
async function placeJet(on, at = {}) {
  if (!on) { if (jet) jet.visible = false; env.setShadowTarget(null); return; }
  if (!jet) jet = await makeJet();
  jet.visible = true;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).setY(0).normalize();
  const x = at.x ?? num('jx', camera.position.x + fwd.x * 60), z = at.z ?? num('jz', camera.position.z + fwd.z * 60);
  const hdg = at.hdg ?? num('jhdg', (Math.atan2(fwd.x, -fwd.z) / DEG + 360) % 360);
  jet.position.set(x, terrain.heightAt(x, z) + jet.userData.gearHeight, z);
  jet.rotation.set(0, -hdg * DEG, 0);
  jet.updateMatrixWorld(true);
  env.setShadowTarget(jet);
}
$('jet').addEventListener('change', (e) => placeJet(e.target.checked));

// --- start -----------------------------------------------------------------------------------
const loadingEl = $('loading');
const ready = terrain.load((f, label) => { loadingEl.textContent = `${label} (${Math.round(f * 100)} %)`; }).then(async () => {
  loadingEl.remove();
  $('attribution').textContent = terrain.attribution;
  const sp = $('spawns');
  for (const [name, s] of Object.entries(terrain.spawns)) {
    const b = document.createElement('button');
    b.textContent = s.label || name;
    b.title = name;
    b.onclick = () => gotoSpawn(name);
    sp.appendChild(b);
  }
  if (P.has('spawn')) gotoSpawn(P.get('spawn'), P.has('t'));
  else if (P.has('x') && P.has('z')) {
    setView({ x: num('x', 0), y: num('y', 1000), z: num('z', 0), hdg: num('hdg', 0), pitch: num('pitch', 0), agl: P.has('agl') ? num('agl', 100) : null });
  } else gotoSpawn(Object.keys(terrain.spawns)[0]);
  if (P.get('jet') === '1') { $('jet').checked = true; await placeJet(true); }
});
ready.catch((e) => { loadingEl.textContent = `terrain failed to load: ${e.message}`; console.error(e); });

/** Teleports to a spawn; spawns with time_h / day_of_year also set the time (unless keepTime). */
function gotoSpawn(name, keepTime = false) {
  const s = terrain.spawns[name];
  if (!s) return;
  if (s.time_h != null && !keepTime) {
    timeEl.value = s.time_h;
    if (s.day_of_year != null) dayEl.value = s.day_of_year;
    applyTime();
  }
  const onGround = s.on_ground;
  setView({
    x: s.x, z: s.z, y: onGround ? s.y + 3.2 : s.y, hdg: num('hdg', s.heading_deg || 0),
    pitch: num('pitch', onGround ? -1.5 : -12),
  });
}

// --- loop ------------------------------------------------------------------------------------
let last = performance.now(), frames = 0, fpsT0 = last, fps = 0;
const v3 = new THREE.Vector3();
const statsEl = $('stats');
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (window.__dev.paused) return;
  step(dt, now);
}

/** One simulation + render step (also used by scripted tests while paused). */
function step(dt, now = performance.now(), render = true) {
  // free fly
  camera.rotation.set(view.pitch, view.yaw, 0);
  const boost = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 5 : 1;
  const sp = view.speed * boost * dt;
  v3.set((keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0), 0, (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0));
  if (v3.lengthSq() > 0) camera.position.addScaledVector(v3.normalize().applyQuaternion(camera.quaternion), sp);
  const up = (keys.has('KeyR') || keys.has('Space') ? 1 : 0) - (keys.has('KeyF') || keys.has('KeyC') ? 1 : 0);
  camera.position.y += up * sp;
  if (terrain.loaded) camera.position.y = Math.max(camera.position.y, terrain.heightAt(camera.position.x, camera.position.z) + 1.5);
  camera.updateMatrixWorld();

  terrain.debug.lod = $('lod').checked;
  terrain.debug.wireframe = $('wire').checked;
  env.update(camera, dt);
  terrain.update(camera);
  // the terrain's module step, as the app runs it before drawing: the Dead Sea's mirror (or its
  // horizon profile) and the hills' shadow on the sun light
  terrain.module.update({ dt, draw: render });
  if (!render) return;
  renderer.render(scene, camera);
  window.__dev.frames++;

  frames++;
  if (now - fpsT0 > 500) {
    fps = frames * 1000 / (now - fpsT0);
    frames = 0; fpsT0 = now;
    const p = camera.position, ri = renderer.info.render, st = terrain.stats;
    const ll = xzToLonLat(p.x, p.z);
    const gh = terrain.heightAt(p.x, p.z), surf = terrain.surfaceAt(p.x, p.z);
    const hdg = ((-view.yaw / DEG) % 360 + 360) % 360;
    statsEl.textContent =
      `fps ${fps.toFixed(1)}   draw calls ${ri.calls}   tris ${(ri.triangles / 1e6).toFixed(2)} M\n` +
      `terrain: ${st.patches} patches, ${(st.triangles / 1e6).toFixed(2)} M tris, ${st.groups} groups\n` +
      `L0 tiles: ${st.tilesResident} resident, ${st.tilesLoading} loading, ${st.tilesWanted} wanted\n` +
      `x ${p.x.toFixed(0)}  z ${p.z.toFixed(0)}  y ${p.y.toFixed(1)} m  hdg ${hdg.toFixed(0)}\n` +
      `${ll.lat.toFixed(4)} N  ${ll.lon.toFixed(4)} E   ground ${gh.toFixed(1)} m  AGL ${(p.y - gh).toFixed(1)} m\n` +
      `surface ${surf.type} (${surf.friction})   speed ${view.speed.toFixed(0)} m/s\n` +
      `sun el ${env.sunElevationDeg.toFixed(1)} az ${env.sunAzimuthDeg.toFixed(0)}   exposure ${renderer.toneMappingExposure.toFixed(2)}`;
  }
}

window.__dev = {
  THREE, renderer, scene, camera, env, terrain, setView, gotoSpawn, placeJet, view, ready, frames: 0,
  /** true stops the render loop (tests render with step() and take screenshots) */
  paused: false,
  step,
  /** true once no L0 tile is loading or waiting for upload */
  settled: () => terrain.loaded && terrain.stats.tilesLoading === 0,
  /** Renders one frame and waits for the GPU; returns milliseconds. */
  timeFrame: (dt = 1 / 60) => {
    const gl = renderer.getContext(), px = new Uint8Array(4);
    const t0 = performance.now();
    step(dt);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return performance.now() - t0;
  },
};
requestAnimationFrame(frame);
