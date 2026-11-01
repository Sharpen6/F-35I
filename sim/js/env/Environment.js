// Environment: sun, sky, aerial perspective, lights, environment map, shadows, exposure.
//
//   const env = new Environment({ renderer, scene });
//   env.setTime(10.5);                 // local solar time, day 172 by default
//   env.setShadowTarget(aircraft.object3d);
//   // every frame, before terrain.update() and renderer.render():
//   env.update(camera, dt);
//
// The sky is a physically based clear-sky atmosphere (js/env/atmosphere.js): a transmittance
// and a multiple-scattering LUT built once on the CPU, and a sky-view LUT (in-scattered light
// and transmittance per view direction, seen from the camera) re-rendered on the GPU when
// the camera altitude or the sun changes. The sky dome, the terrain haze and the water
// reflections all read that one LUT, so the horizon, the haze and the sky always match.
//
// Environment also owns the renderer's tone mapping (ACES filmic) and exposure (auto, with
// env.exposureBias on top), turns shadow maps on, sets scene.environment (PMREM of the sky
// and a hazy ground) and scene.fog (FogExp2 matched to uFogColor / uFogDensity).

import * as THREE from 'three';
import {
  makeAtmosphereParams, buildLUTs, TRANSMITTANCE_W, TRANSMITTANCE_H, MS_SIZE,
  skyIrradiance, sunTransmittance, extinctionGreen, EARTH_RADIUS,
} from './atmosphere.js';
import {
  SKY_LUT_W, SKY_LUT_H, SKYVIEW_LUT_VERT, SKYVIEW_LUT_FRAG, SKY_DOME_VERT, SKY_DOME_FRAG,
  ATMOSPHERE_PARS, ATMOSPHERE_CORE, ATMOSPHERE_SKYVIEW,
} from './atmosphereGLSL.js';
import { sunDirection as solarDirection } from './sun.js';

export { ATMOSPHERE_PARS, ATMOSPHERE_CORE, ATMOSPHERE_SKYVIEW };

/** Top-of-atmosphere sun irradiance in scene units (a white Lambert surface at noon ~ 1.0). */
export const SUN_ILLUMINANCE = 4.0;

const LUMA = [0.2126, 0.7152, 0.0722];
const luma = (c) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];

function halfFloatTexture(f32, w, h) {
  const u16 = new Uint16Array(f32.length);
  for (let i = 0; i < f32.length; i++) u16[i] = THREE.DataUtils.toHalfFloat(f32[i]);
  const t = new THREE.DataTexture(u16, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export class Environment {
  constructor({ renderer, scene, visibilityKm = 60, shadowMapSize = 2048 } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.timeOfDay = 10.5;
    this.dayOfYear = 172;
    /** Multiplier on top of the automatic exposure. */
    this.exposureBias = 1.0;
    this.autoExposure = true;
    this.exposure = 1.0;

    if (!renderer.extensions.has('EXT_color_buffer_float')) {
      console.warn('Environment: EXT_color_buffer_float missing, sky LUT precision reduced');
    }

    this.params = makeAtmosphereParams(visibilityKm);
    const P = this.params;
    this.uniforms = {
      uSunDir: { value: this.sunDirection },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uAmbient: { value: new THREE.Color(0.3, 0.35, 0.45) },
      uFogColor: { value: new THREE.Color(0.6, 0.7, 0.8) },
      uFogDensity: { value: 2e-5 },
      uCameraPos: { value: new THREE.Vector3() },
      uEarthRadius: { value: EARTH_RADIUS },
      uTime: { value: 0 },
      uSunIlluminance: { value: SUN_ILLUMINANCE },
      uCamAltitude: { value: 100 },
      uAtmoGeom: { value: new THREE.Vector4(P.Rg, P.Rt, P.rayleighH, P.mieH) },
      uRayleigh: { value: new THREE.Vector3(...P.rayleighScattering) },
      uMie: { value: new THREE.Vector3(P.mieScattering, P.mieExtinction, P.mieG) },
      uOzone: { value: new THREE.Vector3(...P.ozoneAbsorption) },
      uGroundRadiance: { value: new THREE.Color(0.05, 0.05, 0.05) },
      uNight: { value: 0 },
      uTransmittanceLUT: { value: null },
      uMultiScatLUT: { value: null },
      uSkyViewLUT: { value: null },
      uSkyViewTLUT: { value: null },
    };
    this._buildLUTs();

    // --- sky-view LUT pass (two targets: in-scatter, transmittance) ---
    this._skyRT = new THREE.WebGLRenderTarget(SKY_LUT_W, SKY_LUT_H, {
      count: 2, type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    });
    this._skyRT.textures.forEach((t) => { t.colorSpace = THREE.NoColorSpace; });
    this.uniforms.uSkyViewLUT.value = this._skyRT.textures[0];
    this.uniforms.uSkyViewTLUT.value = this._skyRT.textures[1];
    this._lutMaterial = new THREE.ShaderMaterial({
      name: 'SkyViewLUT', glslVersion: THREE.GLSL3, uniforms: this.uniforms,
      vertexShader: SKYVIEW_LUT_VERT, fragmentShader: SKYVIEW_LUT_FRAG, depthTest: false, depthWrite: false,
    });
    this._lutScene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._lutMaterial);
    quad.frustumCulled = false;
    this._lutScene.add(quad);
    this._lutCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // --- sky dome ---
    const skyGeo = new THREE.SphereGeometry(1, 64, 32);
    this.skyMaterial = new THREE.ShaderMaterial({
      name: 'SkyDome', uniforms: { ...this.uniforms, uShowSun: { value: 1 } },
      vertexShader: SKY_DOME_VERT, fragmentShader: SKY_DOME_FRAG,
      side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false,
    });
    this.sky = new THREE.Mesh(skyGeo, this.skyMaterial);
    this.sky.name = 'Sky';
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1e6;
    scene.add(this.sky);

    // --- environment map: the sky without the sun disc (and the hazy ground below) ---
    this._envScene = new THREE.Scene();
    const envSky = new THREE.Mesh(skyGeo, new THREE.ShaderMaterial({
      name: 'SkyDomeEnv', uniforms: { ...this.uniforms, uShowSun: { value: 0 } },
      vertexShader: SKY_DOME_VERT, fragmentShader: SKY_DOME_FRAG,
      side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false,
    }));
    envSky.frustumCulled = false;
    this._envScene.add(envSky);
    this._cubeRT = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType, generateMipmaps: false });
    this._cubeCamera = new THREE.CubeCamera(0.1, 10, this._cubeRT);
    this._pmrem = new THREE.PMREMGenerator(renderer);
    this._pmrem.compileCubemapShader();
    this._envRT = null;
    this._envTime = -1e9;
    this._envAlt = -1e9;
    this._envSun = new THREE.Vector3(0, -2, 0);

    // --- lights ---
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1);
    this.sunLight.name = 'Sun';
    this.sunLight.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.03;
    this.sunLight.shadow.radius = 2.5;
    this.sunLight.castShadow = false;
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);
    /** Weak sky/ground fill; most ambient light comes from scene.environment. */
    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.hemiLight.name = 'SkyFill';
    this.hemiFraction = 0.15;
    scene.add(this.hemiLight);
    this._shadowTarget = null;
    this._shadowRadius = 12;
    this._shadowMeshCount = -1;

    // --- renderer / scene defaults ---
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = this.exposure;
    scene.fog = new THREE.FogExp2(0xa0b0c0, 2e-5);

    this._camPos = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._lutAlt = -1e9;
    this._lutSun = new THREE.Vector3(0, -2, 0);
    this._lightAlt = -1e9;
    this._lightSun = new THREE.Vector3(0, -2, 0);
    this._groundLight = null;
    this._groundSun = new THREE.Vector3(0, -2, 0);
    this._frame = 0;
    this.setTime(this.timeOfDay, this.dayOfYear);
  }

  _buildLUTs() {
    const luts = buildLUTs(this.params);
    this._cpuLuts = luts;
    this.uniforms.uTransmittanceLUT.value?.dispose();
    this.uniforms.uMultiScatLUT.value?.dispose();
    this.uniforms.uTransmittanceLUT.value = halfFloatTexture(luts.transmittance, TRANSMITTANCE_W, TRANSMITTANCE_H);
    this.uniforms.uMultiScatLUT.value = halfFloatTexture(luts.ms, MS_SIZE, MS_SIZE);
  }

  /** Meteorological visibility of the boundary-layer haze, km (default 60). */
  setVisibility(km) {
    this.params = makeAtmosphereParams(km);
    const P = this.params;
    this.uniforms.uMie.value.set(P.mieScattering, P.mieExtinction, P.mieG);
    this._buildLUTs();
    this._invalidate();
  }

  /**
   * Sun for 31.8 N at local solar time hoursLocal (12 = noon; 19.0 on day 172 is sunset).
   */
  setTime(hoursLocal, dayOfYear = 172) {
    this.timeOfDay = hoursLocal;
    this.dayOfYear = dayOfYear;
    const s = solarDirection(hoursLocal, dayOfYear);
    this.sunDirection.set(s.x, s.y, s.z).normalize();
    this.sunElevationDeg = s.elevationDeg;
    this.sunAzimuthDeg = s.azimuthDeg;
    // night: sun from -1 to -9 degrees below the horizon
    const e = s.elevationDeg;
    this.uniforms.uNight.value = Math.min(1, Math.max(0, (-1 - e) / 8));
  }

  _invalidate() {
    this._lutAlt = -1e9;
    this._lightAlt = -1e9;
    this._envAlt = -1e9;
    this._groundLight = null;
  }

  /** Skips the exposure adaptation once (after a teleport or a time jump). */
  snapExposure() {
    this._frame = 0;
  }

  /** Cast the sun's shadow around this object (the aircraft); null turns shadows off. */
  setShadowTarget(object3d) {
    this._shadowTarget = object3d || null;
    this._shadowMeshCount = -1;
    if (!object3d) this.sunLight.castShadow = false;
  }

  _prepareShadowTarget() {
    const obj = this._shadowTarget;
    let count = 0;
    obj.traverse((o) => { if (o.isMesh) count++; });
    if (count === this._shadowMeshCount) return;
    this._shadowMeshCount = count;
    obj.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const seeThrough = mats.some((m) => m && (m.transparent || (m.transmission || 0) > 0));
      o.castShadow = !seeThrough;
      o.receiveShadow = true;
    });
    const sphere = new THREE.Box3().setFromObject(obj).getBoundingSphere(new THREE.Sphere());
    this._shadowRadius = Math.max(4, Number.isFinite(sphere.radius) ? sphere.radius * 1.1 : 12);
  }

  _renderSkyLUT() {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    r.setRenderTarget(this._skyRT);
    r.render(this._lutScene, this._lutCamera);
    r.setRenderTarget(prevTarget);
    r.xr.enabled = prevXr;
  }

  _renderEnvMap() {
    const r = this.renderer;
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    this._cubeCamera.update(r, this._envScene);
    this._envRT = this._pmrem.fromCubemap(this._cubeRT.texture, this._envRT);
    r.xr.enabled = prevXr;
    this.scene.environment = this._envRT.texture;
  }

  /** CPU lighting terms that depend on the sun only (ground level). */
  _updateGroundLight() {
    const P = this.params, L = this._cpuLuts;
    const sun = [this.sunDirection.x, this.sunDirection.y, this.sunDirection.z];
    const tGround = sunTransmittance(P, L, 0, sun);
    const sky0 = skyIrradiance(P, L, 0, sun);
    const muS = Math.max(0, sun[1]);
    const E = SUN_ILLUMINANCE;
    // night floor: starlight / city glow so the land never goes fully black
    const night = this.uniforms.uNight.value;
    const floor = [0.0010, 0.0013, 0.0022].map((v) => v * night);
    const amb = sky0.irradiance.map((v, c) => v * E + floor[c] * E);
    this.uniforms.uAmbient.value.setRGB(amb[0], amb[1], amb[2]);
    const g = P.groundAlbedo / Math.PI;
    const gr = tGround.map((t, c) => g * (E * t * muS + amb[c]));
    this.uniforms.uGroundRadiance.value.setRGB(gr[0], gr[1], gr[2]);
    // auto exposure from the light falling on the ground (partial adaptation)
    const Eg = E * (luma(tGround) * muS) + luma(amb);
    const Enoon = E * 0.82;
    this._exposureTarget = Math.min(40, Math.max(0.5, Math.pow(Enoon / Math.max(Eg, 1e-5), 0.62)));
    this._groundLight = { tGround, sky0 };
    this._groundSun.copy(this.sunDirection);
  }

  /** CPU lighting terms that depend on the camera altitude. */
  _updateCameraLight(alt) {
    const P = this.params, L = this._cpuLuts;
    const sun = [this.sunDirection.x, this.sunDirection.y, this.sunDirection.z];
    const E = SUN_ILLUMINANCE;
    const sky = skyIrradiance(P, L, Math.max(alt, 0), sun);
    const h = sky.horizon;
    this.uniforms.uFogColor.value.setRGB(h[0] * E, h[1] * E, h[2] * E);
    this.scene.fog?.color?.copy(this.uniforms.uFogColor.value);
    const f = this.hemiFraction;
    this.hemiLight.color.setRGB(sky.irradiance[0] * E * f, sky.irradiance[1] * E * f, sky.irradiance[2] * E * f);
    const gr = this.uniforms.uGroundRadiance.value;
    this.hemiLight.groundColor.setRGB(gr.r * Math.PI * f, gr.g * Math.PI * f, gr.b * Math.PI * f);
    this.hemiLight.intensity = 1;
  }

  update(camera, dt = 1 / 60) {
    this._frame++;
    camera.getWorldPosition(this._camPos);
    const U = this.uniforms;
    U.uCameraPos.value.copy(this._camPos);
    const alt = this._camPos.y;
    U.uCamAltitude.value = alt;
    U.uTime.value += dt;

    const sunMoved = this._lutSun.distanceToSquared(this.sunDirection) > 1e-10;
    // the CPU sky integrals cost a few ms: only for sun moves of more than ~0.15 deg
    if (!this._groundLight || this._groundSun.angleTo(this.sunDirection) > 0.0025) this._updateGroundLight();

    // sky-view LUT: cheap, so redo it for any real change
    if (sunMoved || Math.abs(alt - this._lutAlt) > 2) {
      this._renderSkyLUT();
      this._lutAlt = alt;
      this._lutSun.copy(this.sunDirection);
    }

    // sun light at the camera
    const sun = [this.sunDirection.x, this.sunDirection.y, this.sunDirection.z];
    const t = sunTransmittance(this.params, this._cpuLuts, Math.max(alt, 0), sun);
    const E = SUN_ILLUMINANCE;
    U.uSunColor.value.setRGB(t[0] * E, t[1] * E, t[2] * E);
    this.sunLight.color.copy(U.uSunColor.value);
    this.sunLight.intensity = 1;
    U.uFogDensity.value = extinctionGreen(this.params, alt);
    if (this.scene.fog?.isFogExp2) this.scene.fog.density = U.uFogDensity.value;

    if (this._lightSun.angleTo(this.sunDirection) > 0.0025 ||
        Math.abs(alt - this._lightAlt) > Math.max(150, 0.1 * Math.abs(alt))) {
      this._updateCameraLight(alt);
      this._lightAlt = alt;
      this._lightSun.copy(this.sunDirection);
    }

    // environment map: rate limited (PMREM filtering costs a few ms)
    const now = performance.now();
    const envStale = this._envSun.angleTo(this.sunDirection) > 0.004 ||
      Math.abs(alt - this._envAlt) > Math.max(300, 0.2 * Math.abs(alt));
    if (!this._envRT || (envStale && now - this._envTime > 1000)) {
      this._renderEnvMap();
      this._envTime = now;
      this._envAlt = alt;
      this._envSun.copy(this.sunDirection);
    }

    // sun light / shadow camera
    const L = this.sunLight;
    const sunUp = this.sunDirection.y > -0.01;
    if (this._shadowTarget) {
      this._prepareShadowTarget();
      this._shadowTarget.getWorldPosition(this._tmp);
      const D = 1000, r = this._shadowRadius;
      L.target.position.copy(this._tmp);
      L.position.copy(this._tmp).addScaledVector(this.sunDirection, D);
      const sc = L.shadow.camera;
      if (sc.right !== r || sc.far !== D + 2000) {
        sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r;
        sc.near = D - 2 * r; sc.far = D + 2000;
        sc.updateProjectionMatrix();
      }
      L.castShadow = sunUp;
    } else {
      L.target.position.copy(this._camPos);
      L.position.copy(this._camPos).addScaledVector(this.sunDirection, 1000);
      L.castShadow = false;
    }
    L.updateMatrixWorld();
    L.target.updateMatrixWorld();

    // exposure
    if (this.autoExposure) {
      const k = 1 - Math.exp(-Math.min(dt, 1) / 0.6);
      const target = this._exposureTarget ?? 1;
      this.exposure = this._frame < 3 ? target : this.exposure + (target - this.exposure) * k;
    }
    this.renderer.toneMappingExposure = this.exposure * this.exposureBias;
  }

  dispose() {
    this.scene.remove(this.sky, this.sunLight, this.sunLight.target, this.hemiLight);
    this.sky.geometry.dispose();
    this.skyMaterial.dispose();
    this._lutMaterial.dispose();
    this._skyRT.dispose();
    this._cubeRT.dispose();
    this._envRT?.dispose();
    this._pmrem.dispose();
    this.uniforms.uTransmittanceLUT.value?.dispose();
    this.uniforms.uMultiScatLUT.value?.dispose();
    if (this.scene.environment === this._envRT?.texture) this.scene.environment = null;
  }
}
