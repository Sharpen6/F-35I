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
// Environment also owns the exposure (env.exposure: metered on the light falling on the scene,
// see METER; env.exposureBias on top), turns shadow maps on, sets scene.environment (PMREM of
// the sky and of the ground around the camera at its land-cover albedo) and scene.fog (FogExp2
// matched to uFogColor / uFogDensity). The HDR output transform (AgX with a look, bloom, glare)
// is js/env/Post.js; with ?post=0 the renderer's own AgX tone mapping is the fallback.
//
// Below sea level (the Dead Sea at -430 m) the sky-view LUT's ground sphere is lowered to the
// lowest terrain around the camera (uGroundDatum), so the haze over the basin is continuous.

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
import { moonDirection, celestialFrame } from './moon.js';
import { installCloudShadowChunk, CLOUD_SHADOW_LAYER, CLOUD_SHADOW_WIND } from './cloudShadowChunk.js';

export { ATMOSPHERE_PARS, ATMOSPHERE_CORE, ATMOSPHERE_SKYVIEW };

/** Top-of-atmosphere sun irradiance in scene units (a white Lambert surface at noon ~ 1.0). */
export const SUN_ILLUMINANCE = 4.0;
/**
 * Lux per scene unit of illuminance (the sun's 4 units are ~128 klux above the atmosphere). A
 * light given in candela lights a surface d metres away with cd / d^2 lux: in scene units that is
 * cd / LUX_PER_UNIT / d^2, so a three.js PointLight or SpotLight (decay 2) takes cd / LUX_PER_UNIT
 * as its intensity. Emissive surfaces: cd/m^2 / LUX_PER_UNIT is their radiance.
 */
export const LUX_PER_UNIT = 32000;

const LUMA = [0.2126, 0.7152, 0.0722];
const luma = (c) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];

/**
 * Exposure metering. The eye (or a camera on auto) adapts to the light falling on what it looks
 * at: the sun on the surfaces that face it (weighted: the sunlit side dominates a scene even with
 * the sun low), the sky, the night sky's glow and a part of the moon's light. Adaptation is
 * partial: exposure = key * K^-p. Fitted to exposures set by hand at Tel Nof that looked right
 * (0.93 at noon, 2.2 with the sun 3.3 deg up, 6.0 at 0.45 deg). Below that (twilight, K < k1) the
 * eye adapts harder (p2), up to the night's exposure (max) with the sun ~6 deg down, the end of
 * civil twilight: the sky goes on darkening on screen from there, as the eye stops keeping up,
 * and the night glow takes over by ~9 deg (NIGHT). (A ceiling of 40, reached at -4.5 deg under a
 * night glow as bright as the sky at -4 deg, turned dusk into a flat grey night by -5 deg.) The
 * eye darkens fast and adapts to the dark slowly (tauUp / tauDown, s). moon: the share of the
 * moon's (boosted) light in K: the dark-adapted eye adapts only a little to it, so a full moon
 * night is clearly brighter than a quarter moon one.
 */
const METER = { sun: 1.6, key: 1.817, p: 0.385, k1: 0.045, p2: 0.78, moon: 0.2, min: 0.3, max: 285, tauUp: 1.2, tauDown: 3.5 };
/** The exposure for an adapted light level K (scene units; see METER). */
export function meterExposure(K) {
  const e = K >= METER.k1 ? METER.key * Math.pow(K, -METER.p)
    : METER.key * Math.pow(METER.k1, -METER.p) * Math.pow(METER.k1 / Math.max(K, 1e-12), METER.p2);
  return Math.min(METER.max, Math.max(METER.min, e));
}
/**
 * The inverse: the adapted light level K that gives exposure e (for things that are lit by the
 * scene's light but drawn unlit, like smoke sprites). At the ceiling it returns the K where the
 * ceiling starts, the most light a night scene can have.
 */
export function meteredLight(e) {
  e = Math.min(METER.max, Math.max(METER.min, e));
  const e1 = METER.key * Math.pow(METER.k1, -METER.p);
  return e <= e1 ? Math.pow(e / METER.key, -1 / METER.p) : METER.k1 * Math.pow(e / e1, -1 / METER.p2);
}
/**
 * The night exposure that the artificial lights of the other modules (the terrain's city lights)
 * were tuned for. Above it, uNight falls as NIGHT_LIGHTS_EXPOSURE / exposure, so those lights keep
 * the brightness on screen they were tuned to while the eye adapts further to the dark.
 */
export const NIGHT_LIGHTS_EXPOSURE = 40;
/**
 * The light level the eye is adapted to (physical: the night glow and the moon without their
 * boosts, scene units) at which colour vision starts to fade and is gone: ~50 lux (the end of
 * civil twilight) to ~0.6 lux (a full moon is ~0.25 lux). Post.js shifts the colours towards
 * rod vision in between.
 */
const MESOPIC = [0.0015, 0.00002];

/**
 * Broadband albedo of the ESA WorldCover classes (the land-cover codes the terrain carries), for
 * the light bounced off the ground around the camera: the jet's underside, the environment map's
 * lower half. Typical values for the eastern Mediterranean (dry soils and loess are bright).
 */
const COVER_ALBEDO = { 0: 0.06, 10: 0.11, 20: 0.18, 30: 0.2, 40: 0.18, 50: 0.17, 60: 0.3, 70: 0.6, 80: 0.06, 90: 0.12, 95: 0.1, 100: 0.15 };

/**
 * The night (scene units). The sky's own glow (airglow, starlight, and in central Israel mostly
 * the cities' light scattered in the haze: warmer and brighter at the horizon) is part of the
 * sky-view LUT, so the haze, the sea's reflection and the ambient light all see it; the light it
 * sheds on the ground is the night floor of uAmbient. It fades in as the sun goes from -2 to -10
 * deg (fadeFrom / fadeTo), under the last of the twilight. It is ~50x the real night sky (the
 * exposure ceiling is far below a dark-adapted eye's), and as bright as the sky at the end of
 * civil twilight, so dusk still darkens on screen down to ~-8 deg and the western glow shows
 * until ~-10 deg. (It was 20x this, as bright as the sky with the sun 4 deg down: dusk ended there.)
 * Moonlight is real (full moon 2.5e-6 of the sun above the atmosphere, its phase from js/env/moon.js)
 * on the moon's disc, but the light it casts on the scene is boosted ("day for night"): with it,
 * the quarter moon of the default date (day 172) shows the land dimly, a full moon clearly.
 */
const NIGHT = {
  zenith: [2.6e-5, 3.5e-5, 6.5e-5], horizon: [8.0e-5, 6.8e-5, 5.6e-5],
  fadeFrom: -2, fadeTo: -10,     // sun elevation (deg): no night glow .. all of it
  moonFull: 4.0 * 2.5e-6,        // irradiance of the full moon above the atmosphere
  moonTint: [1.04, 1.0, 0.93],   // a little redder than the sun (the lunar soil)
  boost: 1600,                   // moonlight on the scene (full from -12 deg; real at -6 deg and above)
  boostFrom: -6, boostTo: -12,   // in twilight the sky outshines the real moon: no boost there
  earthshine: 0.004,             // the dark side of a crescent, relative to the lit side
  physical: 1e-7,                // the real night sky's light on the ground (~3 mlux: night vision)
};

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
  constructor({ renderer, scene, visibilityKm = 40, shadowMapSize = 2048 } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    /** Direction of the directional light: the sun, or the moon at night (lightIsMoon). */
    this.lightDirection = new THREE.Vector3(0, 1, 0);
    this.lightIsMoon = false;
    this._tMoon = [0, 0, 0];
    this.timeOfDay = 10.5;
    this.dayOfYear = 172;
    /** The year of the sim's date: the moon's position and phase (js/env/moon.js). */
    this.year = 2026;
    /** Multiplier on top of the automatic exposure. */
    this.exposureBias = 1.0;
    this.autoExposure = true;
    this.exposure = 1.0;
    /** 0 photopic .. 1 dark-adapted (Post.js shifts colours towards rod vision). */
    this.nightVision = 0;
    /**
     * Gain for artificial night lights tuned for a night exposure of NIGHT_LIGHTS_EXPOSURE (40):
     * min(1, 40 / exposure). Lights given in physical units (LUX_PER_UNIT) do not need it.
     */
    this.nightLightGain = 1;
    /** Albedo of the ground around the camera (from the terrain's land cover, see setTerrain). */
    this.groundAlbedo = 0.2;
    /** Height of the atmosphere's ground sphere (m MSL, <= 0): the lowest terrain near the camera. */
    this.groundDatum = 0;
    this._terrain = null;
    this._groundAt = new THREE.Vector3(1e9, 0, 1e9);
    this._groundTime = -1e9;
    this._datumTarget = 0;
    this._lutDatum = 0;
    this._skyLuma = 0.3;

    if (!renderer.extensions.has('EXT_color_buffer_float')) {
      console.warn('Environment: EXT_color_buffer_float missing, sky LUT precision reduced');
    }
    // the cumulus' shadow on three's own lit materials (js/env/cloudShadowChunk.js), before any compile
    installCloudShadowChunk();

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
      uGroundDatum: { value: 0 },
      uNight: { value: 0 },
      uNightZenith: { value: new THREE.Color(0, 0, 0) },
      uNightHorizon: { value: new THREE.Color(0, 0, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonLight: { value: new THREE.Vector4(0, 0, 0, 0) },
      uCelestial: { value: new THREE.Matrix3() },
      uStarVis: { value: 0 },
      // the cumulus layer (set by js/env/Clouds.js; w = 0: no clouds, no cloud shadows)
      uCloudLayer: { value: new THREE.Vector4(1300, 2300, 1, 0) },
      uCloudWind: { value: new THREE.Vector4(0, 0, 3000, 0) },
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
    /**
     * Sky / ground fill for materials without an environment map. The ambient light of the
     * standard materials is scene.environment (sky irradiance plus the light bounced off the
     * ground around the camera), so this stays at 0 unless a module turns it up: adding it on top
     * double counted the sky and lifted matte dark surfaces.
     */
    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.hemiLight.name = 'SkyFill';
    this.hemiFraction = 0;
    scene.add(this.hemiLight);
    this._shadowTarget = null;
    this._shadowRadius = 12;
    this._shadowMeshCount = -1;
    /**
     * Near the ground the sun's shadow box takes in this much (m) around and ahead of the camera
     * (buildings, hangars, trees); null: by the shadow map size (4096: 160 m, 2048: 110 m, 1024:
     * the jet only). In the air it stays tight around the jet.
     */
    this.shadowNear = null;
    this._shadowWide = false;
    this._shadowMap = 0;
    this._sx = new THREE.Vector3();
    this._sy = new THREE.Vector3();
    this._sv = new THREE.Vector3();

    // --- renderer / scene defaults ---
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // only used with ?post=0 (Post.js does its own AgX with a look; render targets skip this)
    renderer.toneMapping = THREE.AgXToneMapping;
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
    // night: the artificial lights come on as the sun goes from -1 to -9 deg (uNight, see update()),
    // the night sky's glow fades in from -2 to -10 deg (NIGHT), the stars come out from -3 deg
    // (the brightest) to -11 deg (all of them: the sky shader fades each one in by its brightness)
    const e = s.elevationDeg;
    const U = this.uniforms;
    const night = Math.min(1, Math.max(0, (-1 - e) / 8));
    this.nightFade = night;
    U.uNight.value = night * this.nightLightGain;
    U.uStarVis.value = Math.min(1, Math.max(0, (-3 - e) / 8));
    const glow = Math.min(1, Math.max(0, (NIGHT.fadeFrom - e) / (NIGHT.fadeFrom - NIGHT.fadeTo)));
    // the moon's boost comes in as the twilight goes (else a quarter moon outshone the dusk sky)
    const mb = Math.min(1, Math.max(0, (NIGHT.boostFrom - e) / (NIGHT.boostFrom - NIGHT.boostTo)));
    this._moonBoost = 1 + (NIGHT.boost - 1) * mb * mb * (3 - 2 * mb);
    // moon (position and phase for env.year) and the turning star field
    const m = moonDirection(hoursLocal, dayOfYear, this.year);
    this.moon = m;
    U.uMoonDir.value.set(m.x, m.y, m.z).normalize();
    // mean radiance of the full disc; the shader's sphere shading gives the phase, and the
    // opposition surge brightens the moon near full beyond what the shading alone gives
    const R = 0.00452;
    const surge = (1 + 0.35 * Math.exp(-m.phaseAngleDeg / 8)) / 1.35;
    const L = NIGHT.moonFull / (Math.PI * R * R) * surge * (m.elevationDeg > -1 ? 1 : 0);
    U.uMoonLight.value.set(L * NIGHT.moonTint[0], L * NIGHT.moonTint[1], L * NIGHT.moonTint[2], NIGHT.earthshine * (1 - m.illumination));
    const cf = celestialFrame(hoursLocal, dayOfYear, this.year);
    U.uCelestial.value.set(...cf.A, ...cf.B, ...cf.P);
    // the night sky's glow, plus the blue of a moonlit sky (boosted like the moonlight; it fades
    // in with the night glow: in twilight the sky-view LUT's own sky outshines it)
    const moonH = this._moonLightBoosted(Math.max(0, m.y));
    const z = [0, 0, 0], h = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const ms = moonH * [0.03, 0.045, 0.09][c];
      z[c] = (NIGHT.zenith[c] + ms) * glow;
      h[c] = (NIGHT.horizon[c] + ms) * glow;
    }
    U.uNightZenith.value.setRGB(z[0], z[1], z[2]);
    U.uNightHorizon.value.setRGB(h[0], h[1], h[2]);
    this._nightSky = { z, h };
    // the light the night glow sheds on the ground (as in _updateGroundLight): part of the metered light
    this._floorLuma = Math.PI * luma([0, 1, 2].map((c) => 0.65 * z[c] + 0.35 * h[c]));
    this._groundLight = null;           // the night floor and the moon change the ambient light
  }

  /** Moonlight on the scene (scene units, normal incidence), boosted at night, before the atmosphere. */
  _moonLightBoosted(scale = 1) {
    const m = this.moon;
    if (!m || m.elevationDeg < -1) return 0;
    return NIGHT.moonFull * m.brightness * (this._moonBoost ?? NIGHT.boost) * scale;
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
    this._groundTime = -1e9;
  }

  /**
   * The terrain (heightAt, landCover): the ground albedo around the camera and the lowest
   * ground nearby (the Dead Sea) come from it. Without it: albedo 0.2, ground sphere at MSL.
   */
  setTerrain(terrain) {
    this._terrain = terrain || null;
    this._groundTime = -1e9;
  }

  /** Mean radiance of the sun's disc seen from the camera (scene units; Post.js measures its visibility). */
  sunDiscRadiance() {
    const R = 0.004654;           // angular radius, rad; the limb darkening keeps ~80 % on average
    const c = this.uniforms.uSunColor.value;
    return Math.max(1e-6, (c.r * LUMA[0] + c.g * LUMA[1] + c.b * LUMA[2]) * 0.8 / (Math.PI * R * R));
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

  /**
   * The sun's (or moon's) shadow box. There is one shadow map (the terrain shaders read the sun's),
   * so its box is fitted to what needs it most: in the air, tight around the jet (a crisp shadow,
   * and the jet's own shadows on itself, ~1 cm texels); with the camera near the ground, also the
   * ground around and ahead of it (shadowNear), so buildings, hangars and trees cast shadows there
   * too while the jet's stays sharp (4096 map: ~10 cm texels). The box is fitted in the light's
   * frame; when wide, its size is quantised and its centre snapped to whole texels, so standing
   * shadows do not crawl as the camera moves. The depth bias is kept constant in metres.
   */
  _fitShadow(jet, camera) {
    const L = this.sunLight, sc = L.shadow.camera;
    const z = this.lightDirection;
    // the light's frame as three's lookAt builds it (up +y)
    const x = this._sx.set(0, 1, 0).cross(z);
    if (x.lengthSq() < 1e-10) x.set(1, 0, 0); else x.normalize();
    const y = this._sy.copy(z).cross(x);
    const jr = this._shadowRadius;
    let minX = jet.dot(x) - jr, maxX = minX + 2 * jr, minY = jet.dot(y) - jr, maxY = minY + 2 * jr;
    // near the ground: a disc ahead of the camera (its centre R/2 ahead), plus 30 m for what stands on it
    const map = L.shadow.mapSize.x;
    const R = this.shadowNear ?? (map >= 4096 ? 160 : map >= 2048 ? 110 : 0);
    const cp = this._camPos;
    const gh = this._terrain?.loaded && typeof this._terrain.heightAt === 'function' ? this._terrain.heightAt(cp.x, cp.z) : 0;
    const agl = cp.y - (Number.isFinite(gh) ? gh : 0);
    this._shadowWide = R > 0 && agl < (this._shadowWide ? 220 : 150);
    if (this._shadowWide) {
      const f = camera.getWorldDirection(this._sv);
      f.y = 0;
      if (f.lengthSq() < 1e-6) f.set(0, 0, -1); else f.normalize();
      const c = f.multiplyScalar(R * 0.5).add(cp);
      c.y = Number.isFinite(gh) ? gh : 0;
      const cx = c.dot(x), cy = c.dot(y), rr = R + 30;
      minX = Math.min(minX, cx - rr); maxX = Math.max(maxX, cx + rr);
      minY = Math.min(minY, cy - rr); maxY = Math.max(maxY, cy + rr);
    }
    let r = 0.5 * Math.max(maxX - minX, maxY - minY);
    let cx = 0.5 * (minX + maxX), cy = 0.5 * (minY + maxY);
    if (this._shadowWide) {
      r = Math.ceil(r / 16) * 16;
      const texel = 2 * r / map;
      cx = Math.round(cx / texel) * texel;
      cy = Math.round(cy / texel) * texel;
    }
    const D = 1000;
    L.target.position.copy(x).multiplyScalar(cx).addScaledVector(y, cy).addScaledVector(z, jet.dot(z));
    L.position.copy(L.target.position).addScaledVector(z, D);
    const near = D - Math.max(2 * r, 60), far = D + 2000;
    if (sc.right !== r || sc.near !== near || sc.far !== far || this._shadowMap !== map) {
      this._shadowMap = map;                     // (setQuality changes the map size)
      sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r;
      sc.near = near; sc.far = far;
      sc.updateProjectionMatrix();
      // the same bias in metres whatever the depth range (0.8 m, as tuned for the jet), and a
      // normal offset of half a texel against acne on the wider maps
      L.shadow.bias = -0.8 / (far - near);
      L.shadow.normalBias = Math.max(0.03, r / map);
      // the filter kernel is counted in texels: narrower on the wide map, so the jet keeps a
      // sharp shadow (~1.2 x 10 cm instead of 2.5 x 10 cm of blur)
      L.shadow.radius = this._shadowWide ? 1.2 : 2.5;
    }
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
    // night floor: the light of the night sky's own glow (NIGHT, in the sky-view LUT too), and
    // the (boosted) moon: the terrain has no moon term of its own, so it is part of the ambient
    const ns = this._nightSky || { z: [0, 0, 0], h: [0, 0, 0] };
    const floor = ns.z.map((z, c) => Math.PI * (0.65 * z + 0.35 * ns.h[c]));
    const md = this.uniforms.uMoonDir.value;
    const tMoon = sunTransmittance(P, L, 0, [md.x, md.y, md.z]);
    const moonH = this._moonLightBoosted(Math.max(0, md.y));
    const amb = sky0.irradiance.map((v, c) => v * E + floor[c] + moonH * tMoon[c] * NIGHT.moonTint[c]);
    this.uniforms.uAmbient.value.setRGB(amb[0], amb[1], amb[2]);
    this._groundLight = { tGround, sky0, muS, amb };
    this._groundSun.copy(this.sunDirection);
    this._updateGroundRadiance();
  }

  /** Radiance of the ground around the camera: its albedo lit by the sun and the sky. */
  _updateGroundRadiance() {
    const G = this._groundLight;
    if (!G) return;
    const g = this.groundAlbedo / Math.PI, E = SUN_ILLUMINANCE;
    const gr = G.tGround.map((t, c) => g * (E * t * G.muS + G.amb[c]));
    this.uniforms.uGroundRadiance.value.setRGB(gr[0], gr[1], gr[2]);
    this._groundAlbedoUsed = this.groundAlbedo;
  }

  /**
   * Land-cover albedo of the ground the camera sees below it (a disc that grows with the height
   * above ground) and the lowest terrain within 30 km (the atmosphere's ground sphere). Cheap: a
   * few hundred grid lookups, redone when the camera has moved or every two seconds.
   */
  _sampleGround(now) {
    const T = this._terrain, p = this._camPos;
    if (!T || !T.loaded || typeof T.heightAt !== 'function') return;
    const h0 = T.heightAt(p.x, p.z);
    const agl = Math.max(0, p.y - (Number.isFinite(h0) ? h0 : 0));
    const R = Math.min(15000, 300 + 1.5 * agl);
    const moved = Math.hypot(p.x - this._groundAt.x, p.z - this._groundAt.z);
    if (moved < Math.max(250, R * 0.25) && now - this._groundTime < 2000) return;
    this._groundAt.copy(p);
    this._groundTime = now;
    // albedo: the centre and two rings (the land cover grids hold WorldCover codes)
    const lc = T.landCover;
    if (lc && (lc.overview || lc.far)) {
      let sum = 0, wsum = 0;
      const add = (x, z, w) => {
        const a = COVER_ALBEDO[this._coverAt(lc, x, z)];
        if (a !== undefined) { sum += a * w; wsum += w; }
      };
      add(p.x, p.z, 1);
      for (let k = 0; k < 12; k++) {
        const a = k / 12 * 2 * Math.PI;
        add(p.x + Math.cos(a) * R * 0.45, p.z + Math.sin(a) * R * 0.45, 0.5);
        add(p.x + Math.cos(a + 0.26) * R, p.z + Math.sin(a + 0.26) * R, 0.75);
      }
      if (wsum > 0) this.groundAlbedo = sum / wsum;
    }
    // ground sphere: the lowest ground nearby, a little below it (0 away from the Dead Sea)
    let m = 0;
    const D = 30000, N = 6;
    for (let j = -N; j <= N; j++) {
      for (let i = -N; i <= N; i++) {
        const h = T.heightAt(p.x + i * D / N, p.z + j * D / N);
        if (Number.isFinite(h) && h < m) m = h;
      }
    }
    if (Number.isFinite(h0) && h0 < m) m = h0;
    this._datumTarget = m < 0 ? m - 20 : 0;
  }

  /** WorldCover code at (x, z): the core overview (25 m) or the far grid (200 m). */
  _coverAt(lc, x, z) {
    const CORE = 51200, FAR = 204800;
    if (lc.overview && Math.abs(x) < CORE && Math.abs(z) < CORE) {
      const n = lc.overviewN || 4096;
      const i = Math.min(n - 1, Math.max(0, Math.floor((x + CORE) / (2 * CORE) * n)));
      const j = Math.min(n - 1, Math.max(0, Math.floor((z + CORE) / (2 * CORE) * n)));
      return lc.overview[j * n + i];
    }
    if (lc.far) {
      const n = lc.farN || 2048;
      const i = Math.min(n - 1, Math.max(0, Math.floor((x + FAR) / (2 * FAR) * n)));
      const j = Math.min(n - 1, Math.max(0, Math.floor((z + FAR) / (2 * FAR) * n)));
      return lc.far[j * n + i];
    }
    return 0;
  }

  /** CPU lighting terms that depend on the camera altitude. */
  _updateCameraLight(alt) {
    const P = this.params, L = this._cpuLuts;
    const sun = [this.sunDirection.x, this.sunDirection.y, this.sunDirection.z];
    const E = SUN_ILLUMINANCE;
    const sky = skyIrradiance(P, L, Math.max(alt, 0), sun);
    this._skyLuma = E * luma(sky.irradiance);
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
    const now = performance.now();
    const snap = this._frame < 3;

    const sunMoved = this._lutSun.distanceToSquared(this.sunDirection) > 1e-10;
    // the CPU sky integrals cost a few ms: only for sun moves of more than ~0.15 deg
    if (!this._groundLight || this._groundSun.angleTo(this.sunDirection) > 0.0025) this._updateGroundLight();

    // the ground around the camera: its albedo (bounced light) and the lowest ground nearby
    // (the Dead Sea basin lowers the atmosphere's ground sphere; eased so the sky never jumps)
    this._sampleGround(now);
    const kd = snap ? 1 : 1 - Math.exp(-Math.min(dt, 1) / 2.0);
    this.groundDatum += (this._datumTarget - this.groundDatum) * kd;
    if (Math.abs(this.groundDatum - this._datumTarget) < 0.5) this.groundDatum = this._datumTarget;
    U.uGroundDatum.value = this.groundDatum;
    if (Math.abs((this._groundAlbedoUsed ?? -1) - this.groundAlbedo) > 0.004) this._updateGroundRadiance();

    // sky-view LUT: cheap, so redo it for any real change
    if (sunMoved || Math.abs(alt - this._lutAlt) > 2 || Math.abs(this.groundDatum - this._lutDatum) > 0.5) {
      this._renderSkyLUT();
      this._lutAlt = alt;
      this._lutDatum = this.groundDatum;
      this._lutSun.copy(this.sunDirection);
    }

    // sun light at the camera
    const sun = [this.sunDirection.x, this.sunDirection.y, this.sunDirection.z];
    const t = sunTransmittance(this.params, this._cpuLuts, Math.max(alt, 0), sun);
    const E = SUN_ILLUMINANCE;
    U.uSunColor.value.setRGB(t[0] * E, t[1] * E, t[2] * E);
    // the directional light (the standard materials: the jet, buildings, trees) is the sun, or
    // the moon once the sun's light at the camera is weaker than the (boosted) moonlight
    const md = U.uMoonDir.value;
    const moonE = md.y > -0.02 ? this._moonLightBoosted() : 0;
    let moonLuma = 0;
    if (moonE > 0) {
      sunTransmittance(this.params, this._cpuLuts, Math.max(alt, 0), [md.x, md.y, md.z], this._tMoon);
      moonLuma = moonE * luma(this._tMoon);
    }
    this.lightIsMoon = moonLuma > E * luma(t);
    if (this.lightIsMoon) {
      this.lightDirection.copy(md);
      const tm = this._tMoon, k = NIGHT.moonTint;
      this.sunLight.color.setRGB(tm[0] * moonE * k[0], tm[1] * moonE * k[1], tm[2] * moonE * k[2]);
    } else {
      this.lightDirection.copy(this.sunDirection);
      this.sunLight.color.copy(U.uSunColor.value);
    }
    this.sunLight.intensity = 1;
    U.uFogDensity.value = extinctionGreen(this.params, alt);
    if (this.scene.fog?.isFogExp2) this.scene.fog.density = U.uFogDensity.value;

    if (this._lightSun.angleTo(this.sunDirection) > 0.0025 ||
        Math.abs(alt - this._lightAlt) > Math.max(150, 0.1 * Math.abs(alt))) {
      this._updateCameraLight(alt);
      this._lightAlt = alt;
      this._lightSun.copy(this.sunDirection);
    }

    // environment map: rate limited (PMREM filtering costs a few ms); redone when the sun, the
    // altitude or the ground below changed (a time jump snaps it at once)
    const envStale = this._envSun.angleTo(this.sunDirection) > 0.004 ||
      Math.abs(alt - this._envAlt) > Math.max(300, 0.2 * Math.abs(alt)) ||
      Math.abs((this._envAlbedo ?? -1) - this.groundAlbedo) > 0.015;
    if (!this._envRT || (envStale && (snap || now - this._envTime > 1000))) {
      this._renderEnvMap();
      this._envTime = now;
      this._envAlt = alt;
      this._envAlbedo = this.groundAlbedo;
      this._envSun.copy(this.sunDirection);
    }

    // sun (or moon) light / shadow camera (_fitShadow)
    const L = this.sunLight;
    const sunUp = this.lightDirection.y > -0.01;
    if (this._shadowTarget) {
      this._prepareShadowTarget();
      this._fitShadow(this._shadowTarget.getWorldPosition(this._tmp), camera);
      // moon shadows only near full moon and with the moon well up (the pass costs ~180 draw calls)
      L.castShadow = sunUp && (!this.lightIsMoon || (this.moon.brightness > 0.25 && this.lightDirection.y > 0.14));
    } else {
      L.target.position.copy(this._camPos);
      L.position.copy(this._camPos).addScaledVector(this.lightDirection, 1000);
      L.castShadow = false;
    }
    L.updateMatrixWorld();
    L.target.updateMatrixWorld();

    // exposure: metered on the light falling on the scene at the camera (METER): the sun, the
    // sky, the night glow and a share of the moon (boosted, as it lights the scene)
    const sc = U.uSunColor.value;
    const Edn = sc.r * LUMA[0] + sc.g * LUMA[1] + sc.b * LUMA[2];
    const K = METER.sun * Edn + this._skyLuma + (this._floorLuma || 0) + METER.moon * moonLuma;
    this.meteredLight = K;
    // the same without the night's boosts, for the eye's colour vision (MESOPIC)
    const Kp = METER.sun * Edn + this._skyLuma + NIGHT.physical + METER.sun * moonLuma / (this._moonBoost ?? NIGHT.boost);
    // the eye's adaptation state: the light level it is adapted to (eased in log space; adapting
    // to the dark is slower than to the light)
    const ls = this.lightScale ?? 1;
    const lk = Math.log(K * ls), lp = Math.log(Kp * ls);
    if (snap || !Number.isFinite(this._logK) || !Number.isFinite(this._logKp)) { this._logK = lk; this._logKp = lp; }
    else {
      const a = (x, y) => 1 - Math.exp(-Math.min(dt, 1) / (x < y ? METER.tauDown : METER.tauUp));
      this._logK += (lk - this._logK) * a(lk, this._logK);
      this._logKp += (lp - this._logKp) * a(lp, this._logKp);
    }
    const Ka = Math.exp(this._logK);
    this.adaptedLight = Ka;
    if (this.autoExposure) this.exposure = meterExposure(Ka);
    // night vision: rods take over as the (real) light falls through the mesopic range
    const nv = Math.min(1, Math.max(0, Math.log(MESOPIC[0] / Math.exp(this._logKp)) / Math.log(MESOPIC[0] / MESOPIC[1])));
    this.nightVision = nv * nv * (3 - 2 * nv);
    this.renderer.toneMappingExposure = this.exposure * this.exposureBias;
    // the artificial lights tuned for the old night exposure keep their brightness on screen
    this.nightLightGain = Math.min(1, NIGHT_LIGHTS_EXPOSURE / Math.max(this.exposure, 1e-3));
    U.uNight.value = (this.nightFade ?? 0) * this.nightLightGain;
    // the cumulus layer for the cloud shadows on three's materials (js/env/cloudShadowChunk.js)
    U.uCloudLayer.value.toArray(CLOUD_SHADOW_LAYER);
    U.uCloudWind.value.toArray(CLOUD_SHADOW_WIND);
  }

  /** Render targets this module owns (GPU memory estimate; the PMREM is scene.environment). */
  targets() {
    return [this._skyRT, this._cubeRT].filter(Boolean);
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
