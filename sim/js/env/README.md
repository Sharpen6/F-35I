# Light, sky, clouds and the HDR frame (`js/env`)

How the sim turns sunlight, skylight, moonlight and clouds into the picture on the screen. The
atmosphere itself (Hillaire 2020 look-up tables, aerial perspective) is described in
`js/terrain/README.md`; this file covers what is built on top of it: exposure and tone mapping,
ambient light, the night sky and the moon, the HDR post chain, the clouds and the sun's shadow box.

| file | |
| --- | --- |
| `Environment.js` | sun, moon, sky dome, lights, environment map, shadow box, exposure |
| `atmosphere.js`, `atmosphereGLSL.js` | the clear-sky atmosphere (CPU and GPU twins), the cumulus field's GLSL |
| `sun.js`, `moon.js` | sun position; moon position, phase and brightness, the sidereal frame of the stars |
| `Post.js` | the HDR frame: MSAA target, clouds composite, sun visibility, bloom, glare, AgX output, GPU timers |
| `Clouds.js`, `cloudField.js` | ray marched cumulus and cirrus with a temporal filter, weather presets; the field's CPU twin |
| `cloudShadowChunk.js` | the cumulus' shadow in three.js's own lit materials (the jet, buildings on three materials) |
| `displayLevels.js` | the jet's displays (the glb's PCD glass, the tablet, the switch LEDs) at a fixed picture level |
| `warmup.js` | the shader warm-up: every program built behind the loading screen, misses logged |

## Units

Scene-referred radiance everywhere: the sun above the atmosphere is 4 (`SUN_ILLUMINANCE`, about
128 klux), so a white Lambert surface under the noon sun is about 1. One scene unit of illuminance
is `LUX_PER_UNIT` = 32,000 lux (exported by `Environment.js`): a lamp of I candela lights a
surface d metres away with I / LUX_PER_UNIT / d^2 scene units, so a three.js `PointLight` or
`SpotLight` (decay 2) takes `cd / LUX_PER_UNIT` as its intensity, and an emissive surface of
L cd/m^2 has the radiance L / LUX_PER_UNIT. Every material writes these values into the HDR
target; nothing is tone mapped before the last pass (`Post.js`).

## Exposure

`env.exposure` is metered like an incident-light meter on the light falling on the scene at the
camera, `K = 1.6 x direct sun + sky irradiance + the night glow + 0.2 x the moonlight` (`METER`),
and mapped with a curve fitted to how a camera (or the eye) treats the day:
`exposure = 1.817 K^-0.385` (noon ~0.93), and below K = 0.045 (the sun near the horizon) steeper
(`p2 = 0.78`): the eye opens up through the civil twilight and reaches the night's exposure, 285,
with the sun ~6 deg down. Below that the scene goes on darkening on the screen (the eye stops
keeping up) until the night glow takes over at ~-9 deg. `meterExposure(K)` and its inverse
`meteredLight(exposure)` are exported (Effects.js lights its smoke sprites with the latter).

The eye's adaptation state is eased in log space (1.2 s towards light, 3.5 s towards the dark),
so flying out of a cloud or into the dusk shows the short glare or gloom an eye or camera has.
`env.exposureBias` multiplies the result; `env.autoExposure = false` freezes it.
`env.lightScale` (set by Clouds.js: in a cloud's shadow, inside a cloud) scales what the meter sees.

The ceiling was 40, reached with the sun 4.5 deg down under a night glow as bright as the sky
at -4 deg: dusk turned into a flat grey night by -5 deg and the stars were all out at once.

**Night lights.** The terrain's city lights (and anything else tuned by eye at the old night
exposure of 40) would be seven times brighter at 285. `env.nightLightGain = min(1, 40 / exposure)`
(`NIGHT_LIGHTS_EXPOSURE`) and the `uNight` uniform (0..1, the night's fade with the sun from -1
to -9 deg) carries it, so they keep the brightness on the screen they were tuned to. Lights given
in physical units (candela / LUX_PER_UNIT, the jet's landing light) and displays drawn at a fixed
picture level (emission / exposure) need nothing. The jet's own displays are such: their glb
emission is a fixed radiance, right for the day, that turned the PCD into a white slab at night;
`DisplayLevels` (`displayLevels.js`) sets it every frame to a level / exposure (1.05 by day, 0.5
at night for the PCD, as an automatic brightness control would), on the player's jet and the
wingmen's. When the cockpit module is there (`app.cockpit`) it drives those materials itself and
`DisplayLevels` steps aside.

**Night vision.** `env.nightVision` (0..1) follows the light the eye is adapted to without the
night's boosts (the real sky and moon): from ~50 lux (the end of civil twilight) to ~0.6 lux
(`MESOPIC`). The output pass shifts the darker colours towards rod vision, at most 60 %: blues
hold, reds fade and colours partly desaturate; lights bright enough for the cones keep their
colour.

Measured at Ben Gurion on 21 June (solar time, `few` cumulus, chase view, `sim/tests/lighting_shots.mjs
--set twilight`; exposure after 6 frames of adaptation):

| solar time | sun | exposure | night vision | the picture (looking west) |
| --- | --- | --- | --- | --- |
| 19:00 | +0.4 deg | 7.3 | 0 | sunset: the disc on the horizon, long shadows |
| 19:15 | -2.4 deg | 25 | 0 | an orange band under a blue sky, the cumulus lit from below |
| 19:24 | -4.0 deg | 64 | 0 | a pink-orange band, the land in a blue dusk, the clouds mauve |
| 19:30 | -5.1 deg | 159 | 0.11 | the band narrows, the clouds turn grey against the sky |
| 19:36 | -6.2 deg | 285 | 0.53 | the end of civil twilight: the ceiling; the brightest stars |
| 19:45 | -7.8 deg | 285 | 0.91 | the screen darkens, a warm glow low in the west, the clouds dark (in the earth's shadow), stars |
| 20:00 | -10.4 deg | 228 | 1 | the quarter moon's light takes over (boosted from -6 to -12 deg): grey moonlit cloud tops |
| 20:30 | -15.4 deg | 212 | 1 | night under the quarter moon, stars over the whole sky |
| 21:30 | -24.1 deg | 270 | 1 | the moon lower in the west: a little darker |

With the full moon (`env.year = 2024`, 22:00 over Tel Aviv) the meter settles at ~95: the cloud
tops are light grey and the jet clearly lit, a brighter night than the quarter moon's.

## Ambient light

* `scene.environment` is a PMREM of the sky dome without the sun (the sky-view LUT) over a lower
  hemisphere of ground radiance: the land-cover albedo around the camera (ESA WorldCover classes,
  `COVER_ALBEDO`, averaged on two rings out to 300 m + 1.5 x the height above ground) times the
  sun and sky light on it. It is re-filtered when the sun, the altitude or the albedo change.
* The hemisphere light stays at 0 (it double counted the sky); `uGroundRadiance` is the same
  ground radiance for the custom shaders.
* The regional mean albedo is 0.2 (bright loess and limestone, fields, towns), not 0.13: the
  shadows are lit by a brighter ground and no longer crush to navy.

## Dead Sea

The sky-view LUT used the sea-level ground sphere: below sea level the view rays ran into the
ground sphere at the shore and the haze turned into a black band. The LUT's ground sphere is now
`uGroundDatum`: the lowest ground on a 13 x 13 grid of +-30 km around the camera (`-447 m` over
the Dead Sea, `0` elsewhere), eased over 2 s. The densities stay relative to sea level.

## Twilight, the night sky and the moon

* The sky's colours through the dusk come from the LUTs. The ozone's absorption in the red
  channel is the mean over the sRGB red band (1.3e-6 /m, not the 0.65e-6 at 680 nm): with the
  latter the twilight sky was lavender instead of the deep blue over a yellow-orange band seen
  after sunset. The daytime sky is unchanged; the setting sun is ~9 % less red.
* The night sky's own glow (`NIGHT`: airglow, starlight and, in central Israel mostly, the
  cities' light in the haze, warmer at the horizon) fades in under the last of the twilight as the
  sun goes from -2 to -10 deg. It is part of the sky-view LUT, so the haze, the sea's reflection
  and the ambient light all see it. It is ~50 x the real night sky (a "day for night" floor, as
  bright as the sky at the end of civil twilight) and 20 x dimmer than before, so the dusk goes
  on darkening on the screen to ~-8 deg and the western glow shows until ~-10 deg.
* Stars (procedural: one star in 200 cells of a 3D lattice over the celestial sphere, a steep
  brightness distribution, three colour classes, kept a pixel wide at any resolution) come out
  one by one, the brightest first (Sirius and the planets by the end of civil twilight, the faint
  ones by the end of nautical twilight), and each only where it outshines the sky behind it 1.5-4
  times: the moon's glow and the cities' glow at the horizon hide the faint ones. The Milky Way
  (galactic plane from the north galactic pole, brighter towards the centre, dark dust lanes)
  shows only in a fully dark sky away from the city glow. Both turn with the sidereal time
  (`uCelestial`, `moon.js celestialFrame`).
* The moon (`moon.js`, the low-precision lunar ephemeris of the Astronomical Almanac, with the
  topocentric parallax) has its position, phase and brightness for the sim's date (21 June of
  `env.year`, default 2026: first quarter at dusk; 2024 had a full moon). The disc is shaded with
  Lommel-Seeliger and an opposition surge, the dark side with earthshine; maria are procedural.
* Moonlight lights the scene "day for night": 1,600 x its physical irradiance, tinted a little
  red, faded in as the sun goes from -6 to -12 deg (in twilight the real sky outshines the moon;
  boosted at once, a quarter moon lit the jet blue at -5 deg). The meter takes in 0.2 of it, so a
  full-moon night is clearly brighter than a quarter-moon one. The directional light switches to
  the moon once it is brighter than the sun at the camera; moon shadows only near full moon and
  with the moon well up.

## The HDR frame (`Post.js`)

```js
const post = new Post({ renderer, env, quality });   // main.js, after the Environment
post.render(scene, camera);                          // instead of renderer.render(scene, camera)
```

The canvas has no MSAA and no depth buffer; the scene goes into a half-float RGBA target with 4x
MSAA and a depth texture. Then:

1. clouds (optional module, below): marched and filtered at low resolution, then composited over
   the resolved frame into a single-sample half-float target (`PostComposite`), which also gets
   the scene's depth (the composite writes it); the transparent things near the camera are drawn
   into it after the clouds, depth tested. One MSAA resolve per frame: colour, plus the depth only
   when there are clouds. (Before, the composite and the near things went back into the MSAA
   target: three colour + depth resolves a frame, and blending over colour three had already
   invalidated);
2. sun visibility: 21 samples of the disc in the HDR frame into a 1 x 1 target (terrain, the jet,
   the canopy frame or clouds in front of the sun), read by the output pass on the GPU (no readback);
3. bloom: physically thresholded (about twice a white surface in the sun, after exposure), a
   13-tap downsample chain with a Karis average on the first level and a tent upsample chain
   (Jimenez, SIGGRAPH 2014);
4. output: exposure, analytic sun glare (a core and a veil, normalised Lorentzian lobes scaled by
   the sun's measured visibility), faint lens ghosts, night vision, AgX (Troy Sobotka; the three.js
   / Blender fit) with a gentle look after its sigmoid (contrast 1.04 about a 0.42 pivot,
   saturation 1.04) and a toe lift there (`c += 0.25 c (1 - c)^4`: the sigmoid crushes the deep
   shadows),
   optional vignette and grain (off by default: `post.options`), triangular dither, sRGB. The old
   look (1.12 / 1.12) turned the shade under a clear sky, 10:1 below the sunlit side, into navy at
   ~35/255.

`post.gpuTimes` (`{ scene, clouds, post }`, ms, smoothed) are measured with timer queries where
the browser has `EXT_disjoint_timer_query_webgl2` (Chrome on Windows does; `null` otherwise); the
bench (`?bench=1`) shows them. `post.targets()` lists its render targets for the memory estimate.

The HTML helmet display and the menus are separate elements on top and are not touched.
`?post=0` draws straight to the canvas with three's AgX (a fallback; no clouds then).

**Transparent things near the camera that do not write depth** (bounds < 150 m within 800 m:
the burner plume, canopy glass, light sprites, smoke; not decals, which have `polygonOffset`) are
moved to layer 31 for the main pass and drawn after the clouds, depth tested against the scene: a
cloud behind the jet must not cover its plume. They are out of the shadow pass then (glass,
plumes and sprites should not cast shadows anyway). Modules with such objects need do nothing.
Transparent materials that write depth (foliage cards, say) stay in the main pass, cast their
shadows, and their depth stops the clouds in front of them; far transparent things stay in the
main pass, under the clouds.

## Clouds (`Clouds.js`)

Presets (`CLOUD_PRESETS`): `clear`, `few` (default: 12 % fair-weather cumulus, base 1,800 m,
tops to 2,850 m), `scattered` (32 %, 1,700-3,150 m), `broken` (62 %, 1,500-2,850 m), `cirrus`
(a high streaked sheet at 9,500 m over a few small cumulus). Summer cumulus over Israel have
their bases at ~1,500-2,000 m; the bases were 1,050-1,350 m, and the Jerusalem sunset start
(1,500 m) was inside the clouds. The menu's Weather row sets `settings.clouds`; `?clouds=`
overrides it for the session.

Where the cumulus stand is one procedural field (four octaves of value noise on an integer hash,
`atmoCloudField` in GLSL and `cloudField.js` in JS give the same numbers), drifting with a 5.7 m/s
westerly. A preset's coverage is turned into a field threshold by the field's measured quantile.
Every frame:

1. the field around the camera, in the wind's frame, in a 1024 x 1024 map (+-60 km); redrawn only
   when the camera or the drift has moved it by a texel (~117 m), not every frame;
2. at half (high, medium) or quarter (low) resolution each pixel's ray crosses the cumulus slab
   (spherical shells: the deck curves away at the horizon) up to the scene depth. Empty air is
   crossed in long steps (three at a time while the cover map shows no cloud near), cloud in short
   ones (12 m near the camera on high, growing with the distance), with a minimum number across
   the slab (a deck seen edge-on). Density: the field's footprint, pushed around in 3D by the
   noise (up to ~150 m) and narrowing towards the top (towers, not extruded walls), times a height
   profile (flat base, rounded top, taller in the middle of a cloud), eroded by a tiling 64^3
   Perlin-Worley noise made on the GPU at start-up and, within 6-9 km, by a finer Worley octave
   (800 m tiles, ~100 m cells): wispy at the base, billowy above. Light: the sun's (or the
   moon's) light at the cloud's height, single scattering with a two-lobe phase function (the
   silver lining), multiple scattering as diffusion (5 light steps), and the "powder" darkening
   of the sunlit creases; the sky's light from above and the ground's from below, each dimmed by
   the cloud between (the base is darker than the top); at night the cities' sodium glow on the
   bases near Tel Aviv and Jerusalem (with the street lights, `uNight`). Aerial perspective to the
   cloud's light-weighted distance, which also goes to a second target for the filter;
3. the cirrus sheet (2D, streaked along the wind) above;
4. the temporal filter: each ray starts at a different offset every frame (interleaved gradient
   noise, a 16-frame cycle); last frame's filtered result is reprojected to this frame by the
   cloud's own distance (so it holds while the camera turns and flies), clipped to this frame's
   3 x 3 neighbourhood (variance clipping, Salvi 2016: no ghosts behind a moving edge) and ~10 %
   of the new frame is blended in (more while the view moves). After a cut (teleport, time or
   weather change, > 400 m or > 34 deg in a frame) it restarts as a running mean: a clean picture
   in a few frames. Before, the march's white-noise jitter changed every frame: 9 to 30 % of the
   detail pixels (cloud edges, terrain) changed by more than 4/255 from one frame to the next of
   a still camera ("boiling"); now under 0.1 % (`sim/tests/frame_diff.py` on the `flicker` set).
   `clouds.temporal = false` shows it again;
5. a depth-aware 3 x 3 upsample composites `scene x transmittance + light` into Post's composite
   target.

Inside a cloud the view fades to white. The exposure meter (`env.lightScale`) sees 55 % less light
at the centre of a cloud, and up to 38 % less in a cloud's shadow, so the eye opens up a little
under a cloud deck.

On high, if the clouds' measured GPU time (`post.gpuTimes.clouds`, where the browser gives it)
stays over `clouds.budgetMs` (2.5 ms) for two seconds, they step down to the medium tier
(`clouds.fallback`; a quality change resets it; `budgetMs = null` never steps down).

### Cloud shadows: the interface for other shaders

The uniforms live in `env.uniforms` (shared by reference, like the rest of the atmosphere):

| uniform | |
| --- | --- |
| `uCloudLayer` | cumulus base, top (m MSL), field threshold, shadow optical depth (`w = 0`: no clouds) |
| `uCloudWind` | field offset x, z (m: the wind's drift so far), feature scale (m) |

and `ATMOSPHERE_PARS` (or `ATMOSPHERE_CORE`) brings the functions:

* `float atmoCloudShadow(vec3 worldPos)`: transmittance of the sun's light through the cumulus
  above a world point, the field sampled where the sun's ray crosses the layer's middle; 1 above
  the tops or without clouds. ~150 ALU, no texture: nothing counts against the 16 samplers.
* `vec3 atmoSunIrradianceAt(vec3 relToCamera, float h)`: the sun's irradiance at a point (camera
  relative, height MSL) through the atmosphere and in the clouds' shadow. The terrain, buildings,
  roads and vegetation shaders use it, so they get the cloud shadows with no change of their own;
  `atmoSunIrradianceClear` is the same without clouds.
* `float atmoCloudCover(vec2 xz)`: 0..1, inside a cumulus' footprint.

**three.js's own materials** (`MeshStandardMaterial`, `Physical`, `Lambert`, `Phong`, `Toon`: the
jet, anything built on them) get the same shadow per fragment from `cloudShadowChunk.js`: the
Environment patches three's light loop once at start-up (`ShaderChunk.lights_fragment_begin`,
after `getDirectionalLightInfo`) so each fragment's directional light is multiplied by the
cumulus' transmittance along the light's ray at its own world position. Its uniforms
(`csCloudLayer`, `csCloudWind`) are shared `Float32Array`s that `env.update` copies the layer
into; a `ShaderMaterial` that includes three's light chunks without them reads zeros (no shadow).
Before, `Clouds.update` dimmed the whole directional light by the shadow at the jet: the jet under
a cloud darkened every sunlit building around it, and the jet in the sun lit everything standing
in a cloud's shadow. The shadow is exp(-1.8) under a cloud's centre: the light a cumulus lets
through diffusely (~17 %).

On the CPU, `cloudField.shadowAt(x, y, z, sunDir, layer, wind)` is the same shadow;
`app.clouds.layer` and `app.clouds.wind` hold the current layer.

## Shadows

One shadow map (the terrain shaders read the sun's). `Environment._fitShadow` fits its box in the
light's frame: in the air, tight around the jet (its shadow on the ground and its own shadows on
itself, ~1 cm texels at 4096); with the camera less than ~150 m above the ground, also a disc
ahead of the camera (`env.shadowNear`: 160 m at 4096, 110 m at 2048, the jet only at 1024) so
buildings, hangars and trees cast shadows around the runway while the jet's stays sharp
(~10 cm texels and a narrower filter). The wide box is quantised in size and snapped to whole
texels (no crawling); the depth bias is held at 0.8 m whatever the box. Modules only set
`castShadow` / `receiveShadow` on their meshes near the ground.

## Shader warm-up (`warmup.js`)

three.js builds a material's shader program the first time the material is drawn. On the PC
(Chrome on ANGLE / Direct3D 11) a new program costs 100-850 ms of main-thread time on its first
use: the menu's first frame took 5.7 s (59 programs), the first second of a flight had two frames
of ~0.5 s (the cockpit shadow's depth program, the roads, the near terrain), and the first dusk,
each kind of tree, road and building streaming in and the wingmen had their own stops. Now every
program is built behind the loading screen (its *Shaders* row), and the loading screen keeps
drawing while they compile. `?warmup=0` turns it off.

`main.js` creates a `ShaderWarmup` right after the renderer (before any module compiles) and runs
`warmUpApp(app)` once the data and the jet are loaded:

1. `install()` wraps `renderer.compile` (and so `compileAsync`): every compile, a module's own
   too, builds the variant the frame really draws. Under the HDR chain everything but the output
   pass goes into a float target (no tone mapping, linear output), so a compile with no target
   bound binds a 1 x 1 half-float one. Against the main scene, lit materials are built for both
   states of the sun's shadow (by day with the shadow map, after dusk without). The number of
   lights is part of every program's key, but three builds an unlit material once more at its
   first draw and then keeps that program whatever the lights do; compiled here it keeps the
   compiled one from the start (`_keep`: a street lamp compiled by day would otherwise have been
   a new program at dusk).
2. The environment's own passes (the sky-view LUT, the environment map's sky, the PMREM filters,
   which three makes on the first PMREM), one environment update (`scene.environment` and the
   sun's shadow as the first frame has them), and update-only frames until the vegetation and the
   cockpit interior have made their materials.
3. `compileAll`: the scene graph, hidden objects included, a few objects at a time (stand-ins
   against the whole scene's lights, one per material and kind of object), the page drawing a
   frame between the slices (building a hundred programs' sources is a few hundred ms of
   script); the shadow pass's depth programs
   (`compileDepth`: three's `MeshDepthMaterial` or the caster's `customDepthMaterial`, with the
   side, maps and alpha test `WebGLShadowMap` gives them, without fog, into a target, the sun
   casting); each module's `warmup(w, camera)` for what is not in the scene yet (Post's and the
   clouds' passes; through `Roads`, the road chunks, airfield lights, street lamps and traffic);
   the modules' own precompiles made before (buildings, trees, terrain) once more, now that the
   environment map is set; the cockpit shadow's depth program (`pcd/shadow.js precompile`).
4. `finish()`: three's first use of each program (link status, uniform locations), one at a
   time, the page drawing a frame between them. With `KHR_parallel_shader_compile` (the PC) the
   driver compiles them all at once on its own threads and a program is touched only when it is
   ready; without it each first use waits for its compile.
5. The textures of the scene's materials not on the GPU yet (`renderer.initTexture`), a few a
   frame; then six real frames behind the loading screen (the menu's view, the cockpit, the chase
   view, the same two by the other light, the menu's view again) for the driver's own per-draw
   state, and a fence polled once a frame until the GPU has done them.

After start-up, `check(label)` runs when a flight starts, the camera, the time of day or the
quality changes and when the wingmen load: whatever in the scene was not compiled yet (a new
material, or a kind of object a material was not compiled for) is compiled at once, finished in
the background and logged as a miss. `beforeDraw` sets the scene's light state up again when the
sun starts or stops casting (three's shadow pass reads the state of the frame before and would
build depth programs for it), `afterDraw` logs every program a frame made. The log is
`app.warmup.late` (`app.warmup.info()` for a summary); `tests/e2e.mjs` fails on a program made in
the menu, the first 5 s of a flight or the first switch to each camera; `tests/pc_check.py`
records, per scene, the programs made after it started (`programs_made`, `warmup_late`) and its
worst frame in the first 3 s; `tests/shader_warmup.mjs` lists them for every phase below.

For a module:

* things added later (streamed tiles, lights that switch on at night): a `warmup(w, camera)`
  method that compiles stand-ins with `w.compile(group, camera, { scene })`. A mesh of the
  material with a one-vertex geometry is enough: only the material, the kind of object
  (instanced, points ...) and the geometry's standard attributes (normal, tangent, colour, uv)
  select the program, not its own attributes;
* shadow casters: `app.warmup.compileDepth(root, camera)` builds their depth programs as the shadow
  pass draws them (`castShadow` and `customDepthMaterial` set on root's meshes);
* or keep calling `renderer.compile` / `compileAsync`: through the wrapper they build the right
  variants, and after start-up their programs are finished in the background.

Measured with `tests/shader_warmup.mjs` (headless Chromium, SwiftShader, high quality, 480 x 270;
the first rows of *before* at 960 x 540): the shader programs made after the loading screen.

| | before (23c6169) | after |
| --- | --- | --- |
| programs when the loading screen goes | 16 | 111 (106 built by the warm-up) |
| the menu's first frames | 63 (the sky and its PMREM filters, the shadow depth programs, the jet, terrain, airport lights, the plume and vapour, clouds, the HDR passes, buildings ...) and 101 texture uploads | 0, no uploads |
| the first 5 s of a flight (Tel Nof 36, cockpit) | 7: `CockpitShadowDepth`, `TerrainL0`, `Roads0`, `VegetationBake`, `VegetationMesh`, `VegetationImpostor`, `VegetationShadow` | 0 |
| first switch to the chase, tower, fly-by camera | 0 (8 uploads each) | 0 |
| first switch to the orbit, cockpit camera | (not reached: the browser was killed) | 0 |
| afterburner | (not on its own: that run started with it, 72 with the menu's) | 0 |
| take-off with the gear and doors moving; vapour | 4 (the trees: depth, mesh, impostor, shadow); 0 | 0; 0 |
| dusk 19:15; 21:30 chase; 21:30 cockpit | 30 (`TerrainL0` and every lit material of the jet without the sun's shadow); 1 (`Roads0`); 0 | 0; 0; 0 |
| 05:00; noon again | (not reached) | 0; 0 |
| quality low, medium, high | (not reached) | 0, 0, 0 |
| 250 m over Tel Aviv, by day and at 21:30 (buildings, roads, lamps, trees streaming in) | (not reached) | 0, 0 |
| the wingmen | none when they load; built when they first come into view | 11 when they load, finished before they show |

SwiftShader has no parallel compile, and the container's 4 CPUs were shared with other jobs: the
warm-up took 31-65 s there (each first use waits for its compile), and its first frames take
seconds; that says nothing about the PC. On the PC each of the menu's 59 programs cost ~90 ms
of main-thread time (5.3 s for its first frame); compiled in parallel by the driver behind the
loading screen, the ~106 programs should add roughly 2-4 s to the loading screen, which keeps
moving (`app.warmup.info().worstGapMs` is its longest frame, `worstGapBy` per step). The menu,
the first flight, every camera, dusk and night, a quality change and the streaming then make no
program. Run `tests/pc_check.py` on the PC to see it: `programs_made` per scene should be empty.

## Quality tiers

| | low | medium | high |
| --- | --- | --- | --- |
| MSAA (HDR target) | 4x | 4x | 4x |
| bloom levels | 5 | 6 | 7 |
| lens ghosts | off | on | on |
| clouds resolution | 1/4 | 1/2 | 1/2 |
| cloud steps (most / across the slab / light) | 64 / 14 / 3 | 104 / 20 / 4 | 144 / 28 / 5 |
| shortest cloud step, its growth with distance | 30 m, 3 % | 18 m, 2.2 % | 12 m, 1.6 % |
| cloud detail erosion | off | to 6 km | to 9 km |
| cloud temporal filter | on | on | on |
| shadow box near the ground | jet only | 110 m | 160 m |

(The step counts are the most a ray may take; with the empty-space skipping, rays through the
clear air between the clouds take far fewer.)

## Cost

Measured in the container with `sim/tests/lighting_shots.mjs --frames 2 --only
telnof_1200_chase,tlv_1200_chase,cl_coast_1200_sct` (SwiftShader in a 960 x 540 window, so its
frame times mean nothing), on the base of this fix (`8cd2cc4`, measured with the new memory
estimate) and after; noon, `few` cumulus at Tel Nof and Tel Aviv, `scattered` over the sea:

| | low before | low after | medium before | medium after | high before | high after |
| --- | --- | --- | --- | --- | --- | --- |
| draw calls: Tel Nof / Tel Aviv / sea under `scattered` | 439 / 445 / 445 | 436 / 445 / 442 | 426 / 445 / 445 | 430 / 443 / 445 | 432 / 449 / 447 | 428 / 446 / 447 |
| triangles, Tel Nof (M) | 1.20 | 1.20 | 1.20 | 1.20 | 1.20 | 1.20 |
| GPU memory estimate (MB) | 667 | 669 | 708 | 716 | 804 | 812 |
| of it the HDR chain / clouds / sky LUTs (MB) | 18.2 / 2.1 / 1.3 | 21.5 / 2.6 / 1.3 | 32.3 / 3.0 / 1.3 | 38.2 / 6.0 / 1.3 | 32.3 / 3.0 / 1.3 | 38.2 / 6.0 / 1.3 |

* Draw calls: ~176 of them are the jet in the shadow map (its 183 opaque primitives: the
  aircraft's own meshes; a single shadow caster for its rigid parts would save ~150). The
  lighting's own passes are ~20: the sky-view LUT 1, the clouds 3 (march, temporal filter,
  composite; the cover map only when it moves a texel), sun visibility 1, bloom 9 / 11 / 13,
  output 1. On the frame the environment map is re-filtered (at most once a second, when the sun,
  the altitude or the ground's albedo has moved enough) the cube faces and PMREM's blur passes add
  ~55 more: the 491-505 calls in the e2e's first shot.
* Memory: the HDR chain at 960 x 540 is the 4x MSAA half-float colour and its depth (~23 MB), the
  resolved colour and depth (6.2), the composite target with its depth (6.2, new: it saves two
  MSAA resolves a frame) and the bloom chain (2.8). The clouds' march writes a second (distance)
  target and the filter keeps two history targets (+3 MB at this size). They grow with the
  pixels: at 1920 x 1080 the HDR chain is ~153 MB (before ~129) and the clouds ~19 MB on high
  (before ~6). The rest of the difference between the tiers is the shadow map (4096 on high).

GPU time on an RTX 3070 at 1080p, high. There is no GPU here: these are estimates from each
pass's pixels, steps, texture fetches and ALU; `?bench=1` measures them (`GPU time` line):

| | ms |
| --- | --- |
| scene into the half-float MSAA target, one resolve (colour; + depth with clouds) | 0.3 to 0.4 (two resolves fewer: about -0.3) |
| sun visibility, bloom (7 levels), output (glare, AgX, dither) | 0.4 to 0.5 |
| clouds, `few`, from the ground (march at 960 x 540 with the empty-space skipping, filter, composite) | ~0.5 |
| clouds above a `scattered` deck | ~1 |
| clouds along a `broken` deck from within the layer (the worst case) | up to ~2.5; past `budgetMs` for 2 s: medium, ~1.5 |
| temporal filter (a 3 x 3 neighbourhood and one history fetch a pixel) | ~0.03 |
| cumulus shadows: terrain shaders and three's materials (~150 ALU, no texture) | < 0.1 |
| environment map re-filter (on that frame only, at most once a second) | ~0.3 |

About 1.2 to 1.5 ms in fair weather, up to ~3 ms at worst. Medium marches fewer, longer steps at
the same resolution (~70 %); low marches at a quarter resolution with no detail noise (~30 %).

## Limits

* The temporal filter trades the boiling for a little softness while the camera moves fast, and
  a cloud edge that moves against the background (a turn, a roll) can show a faint trail for a
  few frames (the neighbourhood clip keeps it short).
* `?post=0` has no clouds (they need the HDR target and its depth).
* What is drawn after the clouds (the plume, the glass, sprites) is not dimmed when the jet is
  inside a cloud; the view is white there anyway.
* Moonlight and the night glow are boosted ("day for night", above); the eye's real night vision
  is far dimmer, and the night exposure (285) still stops short of a fully dark-adapted eye.
* Low quality keeps the shadow box around the jet: no building or tree shadows near the ground.
* Light that other modules tuned by eye at the old night exposure (40) shows ~7 x brighter at
  night (285) until it is multiplied by `env.nightLightGain`: here the jet's throat glow at idle
  (`js/aircraft/Afterburner.js`, an orange disc in the night shots); the aircraft track's light
  sprites and landing-light pool when they are merged.
* There is no GPU in the development container: the GPU costs above are estimates; the bench's
  GPU time line measures them on a real GPU.
* Shader warm-up: the wingmen's cockpit materials are not the player's (the cockpit interior
  patches only his), so loading the wingmen builds their programs then (11, both shadow states),
  compiled in parallel and finished before they show. What ANGLE builds on the first draw of a
  program with a new vertex layout or target (Direct3D's own variants) cannot be seen from
  WebGL; the frames drawn behind the loading screen make it for the views they show.
  SwiftShader (the tests) has no `KHR_parallel_shader_compile`: there each first use waits.
  Uploads that are not a first use stay where they are: the terrain's 1024 x 1024 tiles as they
  stream in (`js/terrain`) and the live PCD's canvas, redrawn a few times a second
  (`js/aircraft/pcd`). A vegetation pass that has not settled in 12 s (a slow machine) is
  compiled as it is; what it makes later is caught at the next check (`late`).

## Sources

* S. Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique", EGSR 2020.
* J. Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare", SIGGRAPH 2014
  (the bloom chain, the interleaved gradient noise).
* T. Sobotka, AgX (the three.js / Blender 4 fit of the sigmoid).
* A. Schneider, "The Real-time Volumetric Cloudscapes of Horizon Zero Dawn", SIGGRAPH 2015, and
  "Nubis" (2017): Perlin-Worley noise, the height profile, the light march, the powder effect.
* M. Wrenninge et al., "Oz: The Great and Volumetric", SIGGRAPH 2013 talk (multiple scattering
  approximations); the diffusion falloff here is the two-stream estimate of a cloud's diffuse
  transmission.
* B. Karis, "High Quality Temporal Supersampling", SIGGRAPH 2014, and M. Salvi, "An Excursion in
  Temporal Supersampling", GDC 2016 (reprojection, neighbourhood variance clipping).
* The Astronomical Almanac's low-precision formulas for the sun and the moon (as in J. Meeus,
  "Astronomical Algorithms").
* ESA WorldCover 2021 (CC BY 4.0) for the land cover whose albedo lights the shadows.

Everything here is procedural: no textures, photographs or models are loaded.
