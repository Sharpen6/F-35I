// Stand-in for js/env/Environment.js (sim/DESIGN.md interface), used with index.html?stubs=1:
// a plain gradient sky that follows the camera, a sun light with a shadow around the jet, a
// hemisphere fill light, ACES tone mapping and exponential fog. No atmosphere model.

import * as THREE from 'three';

const DEG = Math.PI / 180;

function sunDir(hours, day) {
  const phi = 31.8 * DEG;
  const dec = -23.44 * DEG * Math.cos(2 * Math.PI / 365 * (day + 10));
  const H = (hours - 12) * 15 * DEG;
  const east = -Math.cos(dec) * Math.sin(H);
  const north = Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(H);
  const up = Math.sin(dec) * Math.sin(phi) + Math.cos(dec) * Math.cos(phi) * Math.cos(H);
  return new THREE.Vector3(east, up, -north).normalize();
}

export class Environment {
  constructor({ renderer, scene }) {
    this.renderer = renderer;
    this.scene = scene;
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.uniforms = {
      uSunDir: { value: this.sunDirection },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uAmbient: { value: new THREE.Color(0.35, 0.4, 0.5) },
      uFogColor: { value: new THREE.Color(0.7, 0.78, 0.86) },
      uFogDensity: { value: 1 / 45000 },
      uCameraPos: { value: new THREE.Vector3() },
      uEarthRadius: { value: 6371000 },
    };
    this.skyUniforms = {
      uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
      uSun: { value: this.sunDirection }, uSunCol: { value: new THREE.Color() },
    };
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({
      uniforms: this.skyUniforms, side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false,
      vertexShader: `varying vec3 vDir; void main() { vDir = position;
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0); gl_Position = vec4(p.xy, 0.5 * p.w, p.w); }`,
      fragmentShader: `uniform vec3 uZenith, uHorizon, uSun, uSunCol; varying vec3 vDir;
        void main() { vec3 d = normalize(vDir); float h = max(d.y, 0.0);
          vec3 c = mix(uHorizon, uZenith, pow(h, 0.45));
          if (d.y < 0.0) c = mix(uHorizon, uHorizon * 0.6, min(1.0, -d.y * 4.0));
          float s = max(dot(d, normalize(uSun)), 0.0);
          c += uSunCol * (pow(s, 1200.0) * 30.0 + pow(s, 16.0) * 0.18);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    sky.frustumCulled = false;
    sky.renderOrder = -1e6;
    sky.name = 'StubSky';
    this.sky = sky;
    scene.add(sky);

    this.sunLight = new THREE.DirectionalLight(0xffffff, 3);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.03;
    const sc = this.sunLight.shadow.camera;
    sc.left = -14; sc.right = 14; sc.top = 14; sc.bottom = -14; sc.near = 500; sc.far = 3000;
    scene.add(this.sunLight, this.sunLight.target);
    this.hemi = new THREE.HemisphereLight(0xbcd3ff, 0x5a5040, 0.9);
    scene.add(this.hemi);
    scene.fog = new THREE.FogExp2(0xb4c4d4, 1 / 45000);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    this._target = null;
    this.setTime(12.5);
  }

  setTime(hoursLocal, dayOfYear = 172) {
    this.timeOfDay = hoursLocal;
    this.dayOfYear = dayOfYear;
    this.sunDirection.copy(sunDir(hoursLocal, dayOfYear));
    const e = Math.max(-0.2, this.sunDirection.y);
    const warm = 1 - Math.min(1, Math.max(0, e) / 0.35);       // 1 at the horizon
    const day = Math.min(1, Math.max(0, (e + 0.05) / 0.25));
    const sunCol = new THREE.Color(1, 0.95 - 0.35 * warm, 0.88 - 0.6 * warm);
    this.uniforms.uSunColor.value.copy(sunCol).multiplyScalar(3.2 * day);
    this.sunLight.color.copy(sunCol);
    this.sunLight.intensity = 3.2 * day;
    this.skyUniforms.uZenith.value.setRGB(0.12, 0.28, 0.62).multiplyScalar(0.25 + 0.75 * day);
    this.skyUniforms.uHorizon.value.setRGB(0.72 + 0.2 * warm, 0.78 - 0.1 * warm, 0.88 - 0.35 * warm).multiplyScalar(0.25 + 0.75 * day);
    this.skyUniforms.uSunCol.value.copy(sunCol);
    this.hemi.intensity = 0.25 + 0.75 * day;
    this.uniforms.uFogColor.value.copy(this.skyUniforms.uHorizon.value);
    this.scene.fog.color.copy(this.skyUniforms.uHorizon.value);
  }

  setShadowTarget(obj) {
    this._target = obj || null;
    if (!obj) return;
    // shadow box sized to the target (the jet, or the wingmen's line-up), as the real one does
    const sphere = new THREE.Box3().setFromObject(obj).getBoundingSphere(new THREE.Sphere());
    const r = Math.max(14, Number.isFinite(sphere.radius) ? sphere.radius * 1.1 : 14);
    const sc = this.sunLight.shadow.camera;
    sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r;
    sc.updateProjectionMatrix();
  }
  snapExposure() {}

  update(camera, dt) {
    camera.getWorldPosition(this.uniforms.uCameraPos.value);
    const t = this._target ? this._target.getWorldPosition(new THREE.Vector3()) : this.uniforms.uCameraPos.value;
    this.sunLight.target.position.copy(t);
    this.sunLight.position.copy(t).addScaledVector(this.sunDirection, 1000);
    this.sunLight.castShadow = !!this._target && this.sunDirection.y > 0;
    this.sunLight.target.updateMatrixWorld();
    this.sunLight.updateMatrixWorld();
  }
}
