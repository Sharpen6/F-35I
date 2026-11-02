# Terrain and environment (`js/world`, `js/terrain`, `js/env`)

What the jet flies over and under: 409.6 x 409.6 km of terrain from `data/terrain/` (the
102.4 km core at full resolution), the sky, sun, haze, light and shadows. Plain ES modules
plus the vendored three.js r187. The contract is `sim/DESIGN.md`; this file describes the
implementation and the few things the app has to know beyond it.

## Use

```js
import * as THREE from 'three';
import { Environment } from './js/env/Environment.js';
import { Terrain } from './js/terrain/Terrain.js';

// reversed depth where EXT_clip_control exists, else three falls back to a logarithmic depth
// buffer (it logs a harmless warning that the log buffer is ignored when reversed depth works)
const renderer = new THREE.WebGLRenderer({ antialias: true, reversedDepthBuffer: true, logarithmicDepthBuffer: true });
const camera = new THREE.PerspectiveCamera(60, aspect, 0.5, 2e6);   // far >= ~600 km: horizon from 15 km
const scene = new THREE.Scene();
const env = new Environment({ renderer, scene });          // optional: visibilityKm (60), shadowMapSize (2048)
const terrain = new Terrain({ renderer, scene, env });     // optional: baseUrl ('data/terrain/')
await terrain.load((fraction, label) => {});               // ~50 MB, a few seconds from localhost
env.setTime(10.5);                                         // local solar time; day 172 by default
env.setShadowTarget(aircraft.object3d);                    // the sun's shadow map follows it

function frame(dt) {
  env.update(camera, dt);      // sun, sky LUT, lights, exposure, shadow camera
  terrain.update(camera);      // LOD, L0 tile streaming, camera uniforms
  renderer.render(scene, camera);
}
// physics: terrain.heightAt(x, z), terrain.normalAt(x, z, v3), terrain.surfaceAt(x, z)
```

`terrain.update(camera)` must run after the camera has moved for the frame (the terrain is
drawn relative to the camera). Rendering the same scene from a second camera (mirror, map)
needs its own `terrain.update(cam2)` before that render.

**Environment takes over these renderer / scene settings** (set them through Environment, not
directly): `renderer.toneMapping` (ACES filmic), `renderer.toneMappingExposure` (automatic
exposure times `env.exposureBias`; `env.autoExposure = false` freezes it at `env.exposure`),
`renderer.shadowMap` (enabled, PCF), `scene.fog` (FogExp2 with the haze colour and the
extinction at the camera altitude, so standard three.js materials fade like the terrain) and
`scene.environment` (a PMREM of the sky, for PBR materials). The sky is a mesh in the scene
(`env.sky`); do not set `scene.background`.

## Files

| file | what |
|---|---|
| `world/coords.js` | WGS84 transverse Mercator (Krueger n-series, order 6) lon/lat <-> world X/Z; agrees with PROJ to < 0.001 mm |
| `env/Environment.js` | sun, sky, aerial perspective, lights, env map, shadows, exposure, shared uniforms |
| `env/atmosphere.js` | clear-sky atmosphere model (Rayleigh, Mie haze, ozone) and CPU LUTs, pure JS |
| `env/atmosphereGLSL.js` | GLSL side: shared uniforms, transmittance, sky-view LUT pass, sky dome, aerial perspective |
| `env/sun.js` | sun direction at 31.8 N from local solar time and day of year |
| `terrain/Terrain.js` | the Terrain class: loading, LOD, tile streaming, materials, physics queries |
| `terrain/HeightField.js` | heights in memory, `heightAt` / `normalAt` exactly on the rendered mesh, node min / max |
| `terrain/QuadTree.js` | CDLOD node selection (pure JS) |
| `terrain/Surface.js` | runway rectangles, land cover water weights, `surfaceAt` (pure JS) |
| `terrain/terrainShaders.js` | terrain vertex and fragment shaders (ground materials, water, runway paint, city lights) |
| `terrain/textures.js` | GPU textures: packed integer height / land cover grids, normal maps, L0 tile textures |
| `terrain/detailTextures.js` | the procedural detail texture array (13 layers: relief, waves, runway glyphs), made at start |
| `terrain/fieldAnalysis.js` | the 16-bit field texel layout; per L0 tile without field data: segmentation of the imagery into fields, row direction and seed per field (pure JS) |
| `terrain/tileWorker.js` | worker: fetch and decode an L0 tile and its field data (`data/terrain_extra/fields/`), or run the field analysis |
| `terrain/horizonCore.js` | horizon angles toward the sun over a height field (pure JS) |
| `terrain/horizonWorker.js` | worker: the near and far horizon maps |
| `terrain/horizonMap.js` | terrain shadows: the maps on the GPU, `HORIZON_GLSL`, CPU queries |
| `terrain/loaders.js` | fetch helpers |

## Terrain rendering

* **One CDLOD quadtree over the whole far area** (Strugar 2010). Level-0 nodes are 1600 m with
  a 64 x 64 grid (25 m, the core sample spacing); the root (level 8) is the 409.6 km far
  area, so the far area is not a separate mesh and there is no seam or z-fight between "near"
  and "far" terrain. A node is split while the camera is within its range (4800 m at level 0,
  doubling per level); vertices morph to the next coarser grid over 80 - 98 % of the range, so
  levels meet without cracks (checked in `tests/terrain_lod.test.mjs`) and LOD changes do
  not pop. Partly split nodes draw their remaining quarters as 32 x 32 patches. Frustum
  culling uses per-node height min / max (`HeightField.buildMinMax`) and the curvature drop.
* **Instanced draws**: every patch is an instance of the same grid; the vertex shader reads
  heights from R16UI textures with `texelFetch` (the exact integers `heightAt` uses),
  bilinear in the core and on the 200 m far grid outside it. Patches are grouped by
  material: one group for the base material and one per resident L0 colour tile, so the
  terrain is about 5 - 30 draw calls.
* **Precision**: positions are built relative to the camera from exact integers (the camera
  split into a multiple of 64 grid units plus a remainder), so there is no float32 jitter at
  200 km from the origin.
* **Earth curvature**: every terrain (and water) vertex is lowered by `d^2 / 2R` with `d` the
  horizontal distance to the camera (`atmoCurvatureDrop`); lighting tilts the normals to
  match. Physics stays flat.
* **Colour**: the far image (200 m / px) everywhere, the core overview (25 m / px) inside the
  core with a 4 km blend at the core edge, and the L0 tiles (6.25 m / px) near the camera:
  the tiles within 17 km (3D) are streamed in nearest first, at most 64 resident (~6 MB of
  VRAM each), one GPU upload per frame, faded in over 0.7 s and blended to the overview
  between 9 and 14 km. All colour textures are mipmapped with the GPU's maximum anisotropy.
* **Land cover** (ESA WorldCover codes, bilinear class weights from the 10 m / 25 m / 200 m
  grids) picks a procedural macro detail (generated at startup, nothing downloaded): grain
  for grass, crops and shrubs, crowns for trees, stones for bare ground, blotches for
  built-up areas. The detail is mean-free, so it never shifts the imagery's tone, and fades
  out by 4 km.
* **Ground materials near the camera** (where a pixel's footprint is under ~4-8 m along its
  short axis, but at least a quarter of its long axis (half on medium), so a grazing view
  keeps its detail as far as it can resolve it; `uGroundDetail`; the `GROUND_DETAIL` define
  per quality, see Settings). Per 10 m texel a 640 x 640 R16UI texture per L0 tile holds the
  land cover class (WorldCover, plus orchards, vineyards and greenhouses mapped in
  OpenStreetMap), the field's row direction and a random number. **Field data**: built
  offline for the whole core by `tools/terrain/fields.py` into `data/terrain_extra/fields/`
  (19 MB): one Felzenszwalb-Huttenlocher segmentation of the imagery in tile windows with
  800 m of context, stitched into regions across the tile edges, OSM field outlines as extra
  edges; per field the 4-fold gradient direction of its texture and a random number from its
  world position. A field cut by a tile edge keeps its rows and seed: over the whole core the
  row direction differs (> 15 deg) on 7.5 % of neighbouring crop texel pairs across tile edges
  and 5.2 % inside the tiles (it was 44-56 % across the edges when each tile was analysed on
  its own; `dev/terrain.analysis.test.mjs` checks it). Without the data the tile worker still
  analyses each tile on its own (`fieldAnalysis.js`). **Field edges**: a pixel's class is
  a vote of the four texels around it (bilinear weights; on high also weighted by how close
  each texel's imagery colour is to the pixel's own, a joint bilateral upsampling, so the
  6.25 m imagery places the edge inside the 10 m steps), sharpened toward the winner as
  pixels get small: edges run as smooth lines, antialiased, not as 10 m stairs. The shader
  turns that into 0.3-40 m detail: ploughed fields (furrows across the
  field's lands, clods), green crops (rows or beds with drip lines), stubble (harvester
  passes, windrows, straw bales with shadows (high), tramlines), orchards (each crown an
  ellipsoid found along the view ray, so it hides the soil behind it, lit by its own normal,
  its shadow traced along the sun's ray (high); further away, and on medium, hedgerow bands,
  then their mean, all with the crown cover the eye sees, which grows toward the horizon),
  vineyards (trellis rows with
  rounded tops and shadows, the same view parallax), greenhouses (arched plastic bays,
  gutters, film seams, dust), woodland canopy and shrubs with cast shadows, grass, rock and
  soil, coastal sand ripples, Dead Sea salt crust with shoreline bands and mud cracks,
  built-up ground, and stone terraces on the Judean hills (risers and benches following the
  contours, wall shadows). Every periodic pattern fades to its mean before its period is down
  to two pixels along its own axis, so rows seen end-on stay sharp while rows seen across
  fade instead of aliasing. Every pattern is built around the imagery colour of its texel (mean-preserving
  mixes: shrubs, crowns and the soil between them are reference colours scaled to the
  imagery's mean, so they keep a natural hue), so from altitude the ground keeps the
  imagery's tone; the relief (slopes) lights with the sun. Patterns use exact camera-relative
  coordinates (`uCamMod`), box filters or mip-mapped layers, so they do not shimmer. The
  generated layers tile every 2-64 m, so their content coarser than 1/16 - 1/4 of a tile is
  taken out when they are made (their coarse mips are flat): seen from a distance, a tile's
  repetition would otherwise show as a grid of light lines. `/dev/terrain.compile.html`
  checks that, and that every layer wraps without a seam. The imagery itself is magnified
  with a B-spline bicubic filter where a pixel is under ~1.5-3 m (high; no 6 m blocks).
* **Terrain shadows** (`horizonMap.js`): two horizon maps toward the sun (near: 51.2 km at
  25 m, far: 204.8 km at 100 m on high quality; 512 / 1024 / 2048 texels a side on low /
  medium / high) in one R8 texture array, computed in a worker with a convex-hull sweep along
  the sun's azimuth, earth curvature included. A point is lit when the sun stands above its
  horizon (soft over the sun's disc), so hills shade valleys at sunrise and sunset and the
  Judean desert's cliffs shade the Dead Sea shore. Recomputed when the sun's azimuth moves
  0.5 deg (2 deg with a high sun) or the camera moves 1/8 of the near map; the old maps stay
  in use meanwhile (a few hundred ms on a desktop CPU), except after a time jump of more than
  5 deg of sun azimuth, when the terrain casts no shadow until the new maps are there. The
  maps are double-buffered: a new pair goes to the GPU in bands of ~0.5 MB per frame
  (`copyTextureToTexture` into the back texture, `horizon.setRenderer`), then the textures
  swap, so there is no 8 MB upload in one frame. Other modules can use
  `HORIZON_GLSL` + `terrain.horizon.uniforms` (`terrainSunVisibility(xz, h, up)` in GLSL for
  the terrain surface, `terrainSunVisibilityAbove(xz, dh, up)` for a point dh metres above it,
  e.g. a tree crown or a roof: the map is read where the sun's ray from that point comes down
  to the ground; one sampler) or `terrain.sunVisibilityAt(x, y, z, dir)` on the CPU (a ray
  march over the heights at any altitude, earth curvature included). **The jet in the hills'
  shadow**: the terrain module dims `env.sunLight` (the DirectionalLight of the standard
  three.js materials: the aircraft and the wingmen; the terrain, roads, buildings and trees
  light themselves from the atmosphere uniforms and can use the GLSL functions above) by the
  terrain's sun visibility at the light's target (the jet), smoothed over 0.15 s
  (`terrain.sunOcclusion`, `stats.sunVisibility`); so at dawn over the Dead Sea or in a valley
  at sunset the jet is in the shadow the ground shows (at 05:06 solar time, the sun 1.6 deg
  up over the Moab plateau: 60 m over the water the jet is in shade with the sea, at 400 m
  above sea level it is lit with the Judean cliffs; scenes `deadsea0506_60_chase` and
  `deadsea0506_400_chase` of `dev/terrain.shots.mjs`). One factor for the light: a wingman
  far from the jet gets the jet's.
* **City lights at night** (`uNight`): street lamps along street grids turned to the
  district's direction (from the field analysis) in built-up land, sodium orange and LED
  white, main roads brighter, each lamp's pool of light stretched along its street so the
  streets read as lit lines between darker blocks; a lamp keeps its energy as a spot of at
  least one pixel, so it stays a point from altitude, and lamps closer than ~2 pixels merge
  into the district's glow. Lamp density and the share of white LEDs follow how urban the
  surroundings are: the share of built-up land within ~3 km (a triangle filter, 100 m cells
  in the core, 400 m outside), computed at load into a spare corner of the land cover texture
  (`writeUrbanShare`), so city centres (Tel Aviv, Bnei Brak, Jerusalem: 0.7-0.85) are denser
  and whiter than towns (Rehovot 0.4) and villages, with no city hard-coded. Where another
  module draws real street lamps (`terrain.lampSource`: any object with a `lampRange` getter
  in metres, such as the roads module), these synthetic lights only fade in beyond 0.8-1.0 of
  that range, and only as the glow (no made-up street grid next to the real streets), so the
  two do not double up. `?cityLights=0` turns them off.
* **Samplers**: heights (core and far) are one packed R16UI texture, land cover (overview and
  far) one packed R8UI texture, all generated detail one texture array; the L0 material
  drops the far colour and far normal map. Every terrain program uses at most 12 texture
  units including the shadow map (ANGLE / D3D11 allows 16 for vertex + fragment together).
* **Water** is land cover 80 (and "no data" at sea level, i.e. the open sea): waves from a
  generated normal map at three scales and drift directions (`uTime`), Fresnel reflection of
  the sky (the same sky-view LUT as the sky dome), GGX sun glint whose roughness grows with
  distance, the satellite colour as the body colour, and the shoreline blended by the
  land cover weight. The Mediterranean (0 m) and the Dead Sea (-427 m) are flat in the data.
* **Runways** from `airports.json` are painted procedurally in the L0 tiles (ICAO-like
  markings: designators from the runway ids including L / R / C, threshold stripes,
  centreline, aiming point, touchdown zone, edge lines, displaced thresholds, rubber
  deposits) over asphalt, with yellow chevrons on the paved overruns (`overrun_m`). The
  rectangles agree with the runways in the imagery (`telnof_top_*` screenshots). Three
  overruns the build used to measure too short (Tel Nof 36 and 15R 390 m, Palmachim 21 300 m,
  measured on the L0 imagery) are now set by the build (`tools/terrain/runways.py`
  `OVERRUN_CONFIRMED_M`, flattened with the runway); `Surface.js` `OVERRUN_FIX` keeps them as a
  lower bound for data sets built before (the delivered one).
* **Light**: sun irradiance through the atmosphere at each point (transmittance LUT), sky
  irradiance from `uAmbient` (less in furrows and between crowns), the aircraft's shadow from
  three's shadow map (terrain receives; its own shadows come from the horizon maps), aerial
  perspective from the sky-view LUT (so the haze has the
  sky's colour at every sun angle and thickens near the ground), and the far edge of the
  terrain dissolving into the sky's own colour below the horizon.

## Physics queries

* `heightAt(x, z)`: m MSL, the exact surface of the full-resolution mesh: piecewise linear on
  the 25 m grid, each cell split along its NW-SE diagonal like the rendered triangles. The browser check
  in `tests/terrain_screens.mjs` renders the surface height under the camera at 33 points and
  finds it within 0.001 m of `heightAt` in the core (0.004 m outside it, where the far grid is
  bilinear). Away from the camera the rendered mesh is coarser, but the jet's wheels are
  always near the camera.
* `normalAt(x, z, out)`: the geometric normal of that triangle (unit, +Y up). The shading
  normal is smoother (normal map from central differences).
* `surfaceAt(x, z)`: `{type: 'runway', friction: 0.8}` on a paved runway or its paved overrun
  (`0.55` for grass / dirt runways), `{type: 'water', friction: 0.1}` where the land cover
  water weight is >= 0.5 (the rendered shoreline), else `{type: 'ground', friction: 0.6}`.
  Land cover comes from the 10 m tiles where resident (always the case near the camera), else
  the 25 m overview, else the far grid.
* `airports`, `spawns`, `manifest`, `attribution` (string for the credits), `runways.list`
  (rectangles with centre, unit direction, half sizes, overruns).

## Environment

* `setTime(hoursLocal, dayOfYear = 172)`: **local solar time** (12 = the sun due south and
  highest); 19.0 on day 172 is sunset (sun elevation ~0 deg). Israel summer clock time
  (UTC+3) is about solar time + 0:40.
* Atmosphere: Rayleigh + Mie haze (visibility 60 km by default, `setVisibility(km)`) + ozone,
  multiple scattering (Hillaire 2020): transmittance (256 x 64) and multiple-scattering (32 x
  32) LUTs built on the CPU at start and on `setVisibility`, a sky-view LUT (256 x 128,
  in-scatter and transmittance per direction from the camera) re-rendered on the GPU when the
  sun or the camera altitude changes. The sky dome, the terrain haze, the water reflections
  and the environment map all read it, so they always match: blue noon, white-hot haze
  around the sun, orange and purple sunsets, stars after dusk.
* Lights: `env.sunLight` (DirectionalLight, colour = the sun's irradiance at the camera,
  casts the shadow of `setShadowTarget(object)` from an orthographic camera fitted around
  it), `env.hemiLight` (weak sky / ground fill) and `scene.environment` (PMREM of the sky,
  refreshed at most once a second when the sun or the altitude changed noticeably).
* Exposure: automatic from the light falling on the ground (partial adaptation, ~0.6 s);
  `env.snapExposure()` skips the adaptation once (after a teleport or a time jump).
* Scene units: a white Lambert surface under the noon sun is ~1.2; the imagery is treated
  as display-referred and scaled by `terrain.albedoGain` (0.7), so sunlit ground at noon
  looks about like the imagery and keeps its relief shading.

### Shared uniforms (`env.uniforms`)

Shared by reference with every custom shader (include `ATMOSPHERE_PARS` from
`js/env/atmosphereGLSL.js` for the declarations and the helper functions; spread
`env.uniforms` into the material's uniforms):

| uniform | |
|---|---|
| `uSunDir` | vec3, unit vector towards the sun (same object as `env.sunDirection`) |
| `uSunColor` | sun irradiance at the camera, linear RGB, scene units |
| `uAmbient` | sky irradiance on a horizontal surface at ground level |
| `uFogColor`, `uFogDensity` | horizon haze radiance and extinction (1/m) at the camera altitude, for a simple `1 - exp(-d * density)` fog |
| `uCameraPos`, `uCamAltitude` | camera world position, height MSL |
| `uEarthRadius` | 6371000 |
| `uTime` | seconds (animation) |
| `uSunIlluminance`, `uAtmoGeom`, `uRayleigh`, `uMie`, `uOzone`, `uGroundRadiance`, `uNight` | atmosphere parameters |
| `uTransmittanceLUT`, `uMultiScatLUT`, `uSkyViewLUT`, `uSkyViewTLUT` | the LUTs |

GLSL helpers: `atmoSunIrradianceAt(relToCamera, h)`, `atmoSkyRadiance(dir)`,
`atmoAerial(radiance, dir, distance, hPoint)` (haze over a path from the camera),
`atmoCurvatureDrop(relXZ)`, `atmoTransmittance(r, mu)`.

## Performance

* Terrain per frame (measured at 960 x 540 in the test views): 0.05 - 0.6 M triangles, 3 - 26
  draw calls for the whole scene without the aircraft; the selection costs ~0.04 ms of CPU.
  Worst case before frustum culling is 1.7 M triangles (`terrain_lod.test.mjs`). SwiftShader
  needs seconds per frame (it pays per triangle for the large fragment shader), a GPU does not:
  on an RTX 3070 at 2560 x 1440 the terrain is a few ms (one pass, no overdraw-heavy effects,
  about 40 texture fetches per pixel, ~0.4 M vertices).
* VRAM: ~0.7 GB (heights 42 MB, normal maps ~110 MB, overview and far colour ~110 MB, 64 L0
  tiles ~360 MB plus their field data ~50 MB, land cover ~50 MB, detail array 18 MB, horizon
  maps 8 MB on high). CPU memory ~90 MB (heights and land cover for physics), plus a copy of the
  heights in the horizon worker (~45 MB).
* Ground materials cost only where a pixel is under 8 m (the near L0 patches); the horizon
  map is one fetch per pixel; city lights only at night in built-up land.

### Settings

| | |
|---|---|
| quality (menu) | `low`: `GROUND_DETAIL 0` (no near ground materials, the land cover macro detail only), 512^2 horizon maps; `medium`: `GROUND_DETAIL 1` (the materials without their second, larger soil / straw / grass layers, orchards as hedgerow bands without single crowns, no bales, field edges from the 10 m vote without the imagery's guidance, plain bilinear imagery; detail while the footprint's short axis is >= half its long one), 1024^2; `high`: `GROUND_DETAIL 2` (all of it), 2048^2 (`TERRAIN_QUALITY` in `Terrain.js`; the define is compiled in, so the cheaper tiers really cost less) |
| `?terrainDetail=0` | near ground materials off (`terrain.groundDetail`) |
| `?terrainShadows=0` | terrain shadows off (`terrain.shadows`) |
| `?cityLights=0` | city lights off (`terrain.cityLights`) |
| `terrain.debug.view` | false colours: 1 land cover classes, 2 row directions, 3 near detail weight / fade / cast shadows, 4 crop state, 5 terrain shadow |

## Test page and tests

* `dev/terrain.html` (serve `sim/` and open `/dev/terrain.html`): free flight over the terrain:
  drag or double-click for mouse look, WASD, R/F (Space/C) up/down, wheel or +/- speed, Shift
  x5, H hides the panel; time-of-day / day / haze sliders, spawn buttons (teleport), LOD
  colours, wireframe, a stand-in jet (`data/aircraft/f35i.glb` if present) for the shadow;
  fps, draw calls, triangles, tiles, position, ground height and surface type. URL parameters
  are listed at the top of `dev/terrain.js` (`?spawn=`, `?x=&z=&agl=&hdg=&pitch=&t=`,
  `?data=<url>` for another data folder, `?lod=1`, `?wire=1`, `?jet=1`, `?hud=0`).
* `python3 sim/dev/make_synthetic_terrain.py [--out DIR] [--quick]` writes a synthetic
  `data/terrain/` (same formats, coast, hills, rift, airports) for working without the real
  data; open the page with `?data=` pointing at it.
* `node --import ./sim/tests/node-three.mjs sim/tests/terrain_coords.test.mjs` (projection vs
  PROJ), `terrain_lod.test.mjs` (coverage, cracks, morph, budget), `terrain_surface.test.mjs`
  (runways, water, surface types, airports.json consistency).
* `node sim/dev/terrain.analysis.test.mjs`: horizon maps against brute force (with earth
  curvature), field analysis on synthetic fields, the built field data's tile edges against
  the tiles' insides (when `data/terrain_extra/fields/` is there), the overrun corrections.
* `/dev/terrain.compile.html` (served `sim/`, any GPU): compiles the twelve terrain programs
  (base and L0 material, `GROUND_DETAIL` 0 / 1 / 2, with and without the sun's shadow map)
  and lists their sampler units (at most 16 on ANGLE / D3D11), then builds the generated
  ground textures and checks every material layer for seams at its tile edges and for coarse
  content that would show the tile's repetition. `window.__terrainCheck` has the result.
* `node sim/dev/terrain.shots.mjs [--port 8146] [--out DIR] [--scenes a,b] [--view 1,5]`:
  look-development screenshots of the terrain brief's scenes (Tel Nof 36, fields at 120 m and
  40 m, Judean hills at sunset, Jerusalem from 1.5 km, the coast at 300 m, 3,000 m cruise, the
  Dead Sea, dunes, Tel Aviv at night; the mapped orchards, vineyards and greenhouses; the
  Dead Sea at 05:06 with the jet in and above the Moab plateau's shadow) with draw calls,
  triangles, GPU memory, `stats.sunVisibility` and the sampler count of every terrain program;
  `--perf` adds the frame time with each terrain feature switched off in turn.
* `node sim/dev/terrain.waterpop.mjs [--port 8146] [--out DIR]`: the sea from two camera
  positions 2 cm apart across a 256 m and a 1280 m wrap line of the periodic texture
  coordinates, against a control pair away from any line; fails if a wrap pair differs more
  than the control pair (the wave layers would jump as the camera crosses the line).
* `node sim/tests/terrain_screens.mjs [--out DIR] [--only a,b]` (Playwright, SwiftShader,
  960 x 540; serves `sim/` itself or takes `--base`): the GPU height / surface checks, then
  screenshots: Tel Nof runway from 30 m, the Tel Aviv coast from 3 km and at sunset, the
  Jerusalem hills from 1.5 km, the Dead Sea from 2 km, the horizon from 10 km, runway paint
  vs imagery, LOD colours, wireframe, the core edge, the aircraft shadow, sun glint, dawn,
  dusk, night, 15 km and the panel. Fails on page errors or over the budget (1.5 M terrain
  triangles, 300 draw calls).

## Notes and small deviations from DESIGN.md

* `Terrain.load` works without `manifest.json` (the layout is fixed by DESIGN.md); it uses
  the manifest's attribution when present.
* `surfaceAt` counts the paved overruns from `airports.json` (`overrun_m`) as runway.
* Spawns: `y` of airborne spawns is the altitude MSL (as `manifest.json` documents); the test
  page also applies a spawn's `time_h` / `day_of_year` when it has them.
* Extra API beyond the contract: `env.setVisibility`, `env.setShadowTarget`,
  `env.snapExposure`, `env.exposureBias`, `env.autoExposure`, `env.sunLight`, `env.hemiLight`,
  `env.sky`, `env.dispose`; `terrain.runways`, `terrain.stats`, `terrain.debug` (`lod`,
  `wireframe`, `runways`, `heightProbe`), `terrain.detailStrength`, `terrain.albedoGain`,
  `terrain.group`, `terrain.dispose`; `terrain.groundDetail`, `terrain.shadows`,
  `terrain.cityLights` (switches), `terrain.setQuality(q)` and `terrain.module` (for
  `app.addModule`), `terrain.horizon` (the horizon maps: `uniforms`, `stats`),
  `terrain.sunVisibilityAt(x, y, z, dir = sun)`, `terrain.sunOcclusion` (the factor on
  `env.sunLight`), `terrain.setVegetationCover({range, fade})` (a 3D tree
  module tells the terrain where it draws trees, so the shader paints plain ground under them
  instead of crowns), `terrain.lampSource` (an object with `lampRange` in m, e.g. the roads
  module: the city lights fade in beyond it), `terrain.fields` (the field data's index when
  loaded; its OSM attribution is added to `terrain.attribution`), `textures.hCore` (alias of
  the packed height texture for other modules' shaders); `coords.js` also exports `lonLatToEN`, `enToLonLat`,
  `headingDegFromXZ`, `xzFromHeadingDeg`, `CORE_HALF`, `FAR_HALF`.
