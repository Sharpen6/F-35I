// Test page for js/aircraft/AircraftVisual.js: the F-35I on an apron under a procedural sky,
// an orbit camera, a slider for every control, light switches, day / night and view presets.
//
// URL parameters (all optional), e.g. aircraft.html?view=rear34&ab=1&night=1&ui=0
//   view=front34|side|rear34|top|front|rear|cockpit|gear|nozzle|canopy|nose   camera preset
//   <control>=value     any rig control (gear, canopy, flaps, stick_pitch, ...), ab, head_yaw (deg) ...
//   lights=nav,anticoll,landing,formation     night=1   air=1 (jet in the air, gear free)
//   ui=0 (no panel)   logdepth=0 (plain depth buffer)   t=seconds (fixed clock: strobes, flicker)
//   data=../data/aircraft/   where f35i.glb and f35i_rig.json are
// window.dev (for Playwright): {ready, visual, set(c), view(name), night(b), air(b), frames(n)}.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AircraftVisual } from '../js/aircraft/AircraftVisual.js';

const params = new URLSearchParams(location.search);
const num = (k, d) => (params.has(k) && Number.isFinite(parseFloat(params.get(k))) ? parseFloat(params.get(k)) : d);

// ------------------------------------------------------------------------------------------ renderer
const container = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: params.get('logdepth') !== '0' });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.05, 30000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;

// ------------------------------------------------------------------------------------------ sky
const SKY = {
  // a bright, slightly hazy day over a concrete apron (close to the Blender scenes' HDRI)
  day: { zenith: [0.30, 0.42, 0.66], horizon: [0.80, 0.84, 0.90], ground: [0.40, 0.39, 0.37], sun: [1.0, 0.96, 0.90],
         sunI: 3.2, env: 1.0, exposure: 1.0, sunDir: [-0.45, 0.62, -0.35] },
  // moonless night with some sky glow
  night: { zenith: [0.003, 0.004, 0.009], horizon: [0.016, 0.019, 0.028], ground: [0.010, 0.010, 0.010],
           sun: [0.55, 0.65, 0.9], sunI: 0.05, env: 1.0, exposure: 1.8, sunDir: [0.3, 0.5, 0.6] },
};
const skyUniforms = {
  uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
  uSunDir: { value: new THREE.Vector3() }, uSun: { value: new THREE.Color() },
};
const skyMat = new THREE.ShaderMaterial({
  uniforms: skyUniforms, side: THREE.BackSide, depthWrite: false,
  vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
  fragmentShader: `uniform vec3 uZenith, uHorizon, uGround, uSunDir, uSun; varying vec3 vDir;
    void main() { vec3 d = normalize(vDir); float h = d.y;
      vec3 c = h > 0.0 ? mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(uHorizon, uGround, clamp(-h * 6.0, 0.0, 1.0));
      float s = max(dot(d, normalize(uSunDir)), 0.0);
      c += uSun * (pow(s, 900.0) * 40.0 + pow(s, 12.0) * 0.25);
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), skyMat);
sky.scale.setScalar(20000);
sky.frustumCulled = false;
sky.renderOrder = -10;
scene.add(sky);

const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.left = -13; sun.shadow.camera.right = 13;
sun.shadow.camera.top = 13; sun.shadow.camera.bottom = -13;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 80;
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.015;
scene.add(sun, sun.target);

const pmrem = new THREE.PMREMGenerator(renderer);
let envRT = null;
function buildEnvironment(mode) {
  const s = SKY[mode];
  skyUniforms.uZenith.value.setRGB(...s.zenith);
  skyUniforms.uHorizon.value.setRGB(...s.horizon);
  skyUniforms.uGround.value.setRGB(...s.ground);
  skyUniforms.uSun.value.setRGB(...s.sun);
  skyUniforms.uSunDir.value.set(...s.sunDir).normalize();
  // environment map: the same sky, without the sun disc (the directional light is the sun)
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), skyMat.clone());
  envSky.material.uniforms.uSun.value = new THREE.Color(0, 0, 0);
  envSky.scale.setScalar(100);
  envScene.add(envSky);
  if (envRT) envRT.dispose();
  envRT = pmrem.fromScene(envScene, 0.0, 0.1, 1000);
  scene.environment = envRT.texture;
  scene.environmentIntensity = s.env;
  sun.color.setRGB(...s.sun);
  sun.intensity = s.sunI;
  sun.position.set(...s.sunDir).normalize().multiplyScalar(40);
  renderer.toneMappingExposure = s.exposure;
}

// ------------------------------------------------------------------------------------------ apron
function concreteTexture() {
  const n = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const g = cv.getContext('2d');
  const img = g.createImageData(n, n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n * n; i++) {
    const v = 168 + (rnd() - 0.5) * 22;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v * 0.98; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.filter = 'blur(1px)';
  g.drawImage(cv, 0, 0);
  g.filter = 'none';
  g.strokeStyle = 'rgba(70,70,70,0.75)';           // expansion joints at the slab edges
  g.lineWidth = 3;
  g.strokeRect(0, 0, n, n);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(80, 80);                            // 5 m slabs on 400 m
  t.anisotropy = 8;
  return t;
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.92, metalness: 0 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const line = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 400),
  new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.8 }));
line.rotation.x = -Math.PI / 2;
line.position.set(4.2, 0.004, 0);
line.receiveShadow = true;
scene.add(line);

// ------------------------------------------------------------------------------------------ aircraft
const visual = new AircraftVisual({ scene, baseUrl: params.get('data') || '../data/aircraft/' });
const statusEl = document.getElementById('status');
const state = {
  controls: {}, ab: null, lights: { nav: false, anticoll: false, landing: false, formation: 0 },
  strut: {}, head: { yaw: 0, pitch: 0, tilt: 0 }, air: params.get('air') === '1', animate: false,
};

function placeAircraft() {
  const info = visual.rig.info;
  if (state.air) {
    visual.setPose(new THREE.Vector3(0, 4.2, 0), new THREE.Quaternion());
  } else {
    // parked as in the Blender scenes: nose up by the stance pitch, tyres on the apron
    const st = info.groundStance;
    visual.setPose(new THREE.Vector3(0, st.refHeight, 0),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), st.pitch));
  }
}

function applyState() {
  const c = { ...state.controls, lights: state.lights, strut: state.strut, head: state.head };
  c.ab = state.ab;
  if (state.air) c.strut = { nose: 0, left: 0, right: 0 };     // wheels hanging free
  visual.setControls(c);
}

// view presets: [camera position, target] in the body frame of the parked jet (+X right, -Z forward)
const VIEWS = {
  front34: { pos: [-11.5, 3.0, -13.0], target: [0.2, 0.5, 0.6], fov: 30 },
  side: { pos: [-21.0, 1.4, 0.4], target: [0, 0.65, 0.4], fov: 30 },
  rear34: { pos: [10.5, 4.2, 12.5], target: [0, 0.6, -0.8], fov: 30 },
  top: { pos: [0, 34, 0.01], target: [0, 0, 0.0], fov: 30, up: [0, 0, -1] },
  front: { pos: [0, 1.4, -20], target: [0, 0.6, 0], fov: 30 },
  rear: { pos: [0, 2.2, 20], target: [0, 0.6, 0], fov: 30 },
  gear: { pos: [-6.5, 0.2, -1.5], target: [-1.6, -1.0, 1.6], fov: 35 },
  nozzle: { pos: [3.2, 1.6, 13.5], target: [0, 0.1, 6.0], fov: 30 },
  canopy: { pos: [-4.5, 3.2, -7.5], target: [0, 1.0, -4.0], fov: 35 },
  nose: { pos: [-4.2, 0.9, -9.6], target: [-0.2, 0.25, -5.3], fov: 40 },
};

function setView(name) {
  if (name === 'cockpit') {
    const eye = visual.eyeWorld();
    const fwd = new THREE.Vector3().fromArray(visual.rig.info.eyeForward).applyQuaternion(visual.object3d.quaternion);
    camera.fov = 70;
    camera.up.set(0, 1, 0);
    camera.position.copy(eye);
    controls.target.copy(eye).addScaledVector(fwd, 0.25);
    camera.lookAt(controls.target);
    camera.updateProjectionMatrix();
    controls.update();
    return;
  }
  const v = VIEWS[name] || VIEWS.front34;
  const toWorld = (a) => new THREE.Vector3(...a).applyMatrix4(visual.object3d.matrixWorld);
  visual.object3d.updateMatrixWorld(true);
  camera.fov = v.fov;
  camera.up.set(...(v.up || [0, 1, 0]));
  camera.position.copy(toWorld(v.pos));
  controls.target.copy(toWorld(v.target));
  camera.lookAt(controls.target);
  camera.updateProjectionMatrix();
  controls.update();
}

// ------------------------------------------------------------------------------------------ panel
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
function slider(parent, label, min, max, step, value, onInput) {
  const row = document.createElement('div');
  row.className = 'row';
  const l = document.createElement('label');
  l.textContent = label;
  const r = document.createElement('input');
  Object.assign(r, { type: 'range', min, max, step, value });
  const s = document.createElement('span');
  s.textContent = fmt(+value);
  r.addEventListener('input', () => { s.textContent = fmt(+r.value); onInput(+r.value); });
  row.append(l, r, s);
  parent.appendChild(row);
  return { set(v) { r.value = v; s.textContent = fmt(+v); } };
}

function buildPanel() {
  const rig = visual.rig;
  const box = document.getElementById('controls');
  const order = ['stick_pitch', 'stick_roll', 'pedals', 'throttle', 'flaps', 'speedbrake', 'gear', 'nws',
    'roll_distance', 'weapon_bays', 'canopy', 'refuel_door', 'gun_door', 'tailhook'];
  for (const k of order) {
    const c = rig.controls[k];
    if (!c) continue;
    const [lo, hi] = k === 'roll_distance' ? [0, 12] : [c.min, c.max];
    slider(box, k, lo, hi, 0.01, state.controls[k] ?? c.default, (v) => { state.controls[k] = v; applyState(); });
  }
  slider(box, 'ab', -0.01, 1, 0.01, state.ab ?? -0.01, (v) => { state.ab = v < 0 ? null : v; applyState(); });
  const h2 = document.createElement('h2'); h2.textContent = 'Struts (compression, m)'; box.appendChild(h2);
  for (const g of rig.info.gearContacts) {
    slider(box, g.name, 0, g.travel, 0.005, state.strut[g.name] ?? g.staticCompression,
      (v) => { state.strut[g.name] = v; applyState(); });
  }
  const h3 = document.createElement('h2'); h3.textContent = 'Pilot head (deg)'; box.appendChild(h3);
  for (const [k, lo, hi] of [['yaw', -100, 100], ['pitch', -45, 60], ['tilt', -30, 30]]) {
    slider(box, k, lo, hi, 1, THREE.MathUtils.radToDeg(state.head[k]),
      (v) => { state.head[k] = THREE.MathUtils.degToRad(v); applyState(); });
  }
  const lights = document.getElementById('lights');
  for (const k of ['nav', 'anticoll', 'landing', 'formation']) {
    const l = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!state.lights[k];
    cb.addEventListener('change', () => { state.lights[k] = k === 'formation' ? (cb.checked ? 1 : 0) : cb.checked; applyState(); });
    l.append(cb, ' ' + k);
    lights.appendChild(l);
  }
  const views = document.getElementById('views');
  for (const name of [...Object.keys(VIEWS), 'cockpit']) {
    const b = document.createElement('button');
    b.textContent = name;
    b.addEventListener('click', () => setView(name));
    views.appendChild(b);
  }
  const night = document.getElementById('night');
  night.checked = params.get('night') === '1';
  night.addEventListener('change', () => window.dev.night(night.checked));
  const air = document.getElementById('air');
  air.checked = state.air;
  air.addEventListener('change', () => { state.air = air.checked; placeAircraft(); applyState(); });
  const anim = document.getElementById('animate');
  anim.addEventListener('change', () => { state.animate = anim.checked; });
  const panel = document.getElementById('panel');
  document.getElementById('toggle').addEventListener('click', () => panel.classList.toggle('hidden'));
  if (params.get('ui') === '0') {
    panel.classList.add('hidden');
    document.getElementById('toggle').style.display = 'none';
    statusEl.style.display = 'none';
  }
}

// ------------------------------------------------------------------------------------------ main
const timer = new THREE.Timer();
let frameWaiters = [];
let fpsT = 0, fpsN = 0, fps = 0;
const fixedTime = params.has('t') ? num('t', 0) : null;

function frame(timestamp) {
  timer.update(timestamp);
  let dt = timer.getDelta();
  if (fixedTime !== null) dt = 0;
  if (visual.loaded && state.animate) {
    const t = timer.getElapsed();
    state.controls.stick_pitch = 0.6 * Math.sin(t * 0.9);
    state.controls.stick_roll = 0.7 * Math.sin(t * 1.3);
    state.controls.pedals = 0.6 * Math.sin(t * 0.7);
    state.controls.roll_distance = (state.controls.roll_distance || 0) + dt * 3;
    applyState();
  }
  visual.viewportHeight = renderer.domElement.height / renderer.getPixelRatio();
  visual.update(dt, camera);
  renderer.render(scene, camera);
  fpsT += dt; fpsN++;
  if (fpsT > 0.5) { fps = fpsN / fpsT; fpsT = 0; fpsN = 0; }
  if (visual.loaded && params.get('ui') !== '0') {
    const i = renderer.info.render;
    statusEl.textContent = `${fps.toFixed(0)} fps  ${i.calls} draws  ${(i.triangles / 1000).toFixed(0)}k tris`;
  }
  const w = frameWaiters;
  frameWaiters = [];
  for (const f of w) f();
}
// with a fixed clock (t=...: automated screenshots) frames are drawn only on request (dev.frames):
// a software renderer would otherwise spend its time on frames nobody looks at
if (fixedTime === null) renderer.setAnimationLoop(frame);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function readParams() {
  for (const [k, c] of Object.entries(visual.rig.controls)) {
    if (params.has(k) && !k.startsWith('head_') && !k.startsWith('strut_')) state.controls[k] = num(k, c.default);
  }
  if (params.has('ab')) state.ab = num('ab', 0);
  for (const k of ['yaw', 'pitch', 'tilt']) if (params.has('head_' + k)) state.head[k] = THREE.MathUtils.degToRad(num('head_' + k, 0));
  const lights = (params.get('lights') || '').split(',').filter(Boolean);
  for (const k of lights) state.lights[k] = k === 'formation' ? 1 : true;
  for (const g of visual.rig.info.gearContacts) state.strut[g.name] = g.staticCompression;
}

const ready = (async () => {
  buildEnvironment(params.get('night') === '1' ? 'night' : 'day');
  await visual.load((f, label) => { statusEl.textContent = `${label} ${(f * 100).toFixed(0)} %`; });
  readParams();
  placeAircraft();
  applyState();
  buildPanel();
  if (fixedTime !== null) { visual.update(fixedTime, camera); }
  setView(params.get('view') || 'front34');
  // compile everything once, then wait two frames so shadows and the plume are in place
  renderer.compile(scene, camera);
  if (fixedTime !== null) { frame(); frame(); return true; }
  await new Promise((r) => { frameWaiters.push(r); });
  await new Promise((r) => { frameWaiters.push(r); });
  return true;
})();
ready.catch((e) => { statusEl.textContent = 'ERROR: ' + e.message; console.error(e); });

let isNight = params.get('night') === '1';
window.dev = {
  ready, visual, renderer, scene, camera, controls, state,
  set(c) { Object.assign(state.controls, c); applyState(); },
  view: setView,
  night(on) { isNight = !!on; buildEnvironment(on ? 'night' : 'day'); },
  air(on) { state.air = on; placeAircraft(); applyState(); },
  /** Back to the defaults (gear down, everything shut, lights off, day, parked). */
  reset() {
    state.controls = {};
    for (const [k, c] of Object.entries(visual.rig.controls)) {
      if (!k.startsWith('head_') && !k.startsWith('strut_')) state.controls[k] = c.default;
    }
    state.ab = null;
    state.lights = { nav: false, anticoll: false, landing: false, formation: 0 };
    state.head = { yaw: 0, pitch: 0, tilt: 0 };
    for (const g of visual.rig.info.gearContacts) state.strut[g.name] = g.staticCompression;
    if (isNight) this.night(false);
    state.air = false;
    placeAircraft();
    applyState();
  },
  /** {controls, ab, lights, head (rad), night, air, view}: one test shot's state. */
  apply(spec) {
    if (spec.night !== undefined && !!spec.night !== isNight) this.night(spec.night);
    if (spec.air !== undefined) { state.air = !!spec.air; placeAircraft(); }
    if (spec.controls) Object.assign(state.controls, spec.controls);
    if (spec.ab !== undefined) state.ab = spec.ab;
    if (spec.lights) Object.assign(state.lights, spec.lights);
    if (spec.head) Object.assign(state.head, spec.head);
    applyState();
    visual.update(spec.time || 0, camera);         // poses + the strobe clock
    setView(spec.view || 'front34');
  },
  frames(n = 1) {
    if (fixedTime !== null) {
      for (let i = 0; i < n; i++) frame();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let k = n;
      const tick = () => { if (--k <= 0) resolve(); else frameWaiters.push(tick); };
      frameWaiters.push(tick);
    });
  },
};
