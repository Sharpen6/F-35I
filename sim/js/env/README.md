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
| `Post.js` | the HDR frame: MSAA target, clouds pass, sun visibility, bloom, glare, AgX output |
| `Clouds.js`, `cloudField.js` | ray marched cumulus and cirrus, weather presets; the field's CPU twin |

## Units

Scene-referred radiance everywhere: the sun above the atmosphere is 4 (`SUN_ILLUMINANCE`), so a
white Lambert surface under the noon sun is about 1. Every material writes these values into the
HDR target; nothing is tone mapped before the last pass (`Post.js`). Self-luminous things (lights,
the burner, fire) should give real radiances in these units: a white surface in the sun is ~1, a
landing light seen head-on at night some tens.

## Exposure

`env.exposure` is metered like an incident-light meter on the light falling on the scene at the
camera, `K = 1.6 x direct sun + sky irradiance + a night floor` (`METER`), and mapped with a
curve fitted to how a camera (or the eye) treats the day: `exposure = 1.817 K^-0.385` (noon ~0.93),
and below K = 0.045 (sun near the horizon) steeper (`p2 = 0.6`) so twilight does not jump to grey.
It is clamped to 0.3..40. The eye's adaptation state is eased in log space (1.2 s towards light,
3.5 s towards the dark), so flying out of a cloud or into the dusk shows the short glare or gloom
an eye or camera has. `env.exposureBias` multiplies the result; `env.autoExposure = false`
freezes it. `env.lightScale` (set by Clouds.js: in a cloud's shadow, inside a cloud) scales what
the meter sees.

`env.nightVision` (0..1, from the adapted level between 0.012 and 0.0008) drives the scotopic
shift in the output pass: a dark-adapted eye loses colour and sees blue-grey.

Measured on 21 June (solar time, `few` cumulus, `sim/tests/lighting_shots.mjs --set times`):

| solar time | sun | Tel Nof (ground) | Jerusalem (1,500 m) | sea (300 m) |
| --- | --- | --- | --- | --- |
| 05:45 | 9.1 deg | 1.41 | 1.19 | 1.35 |
| 07:00 | 24.3 deg | 1.05 | 0.99 | 1.03 |
| 12:00 | 81.6 deg | 0.93 | 0.92 | 0.93 |
| 17:30 | 18.1 deg | 1.11 | 1.03 | 1.09 |
| 18:45 | 3.3 deg | 2.62 | 1.71 | 2.37 |
| 20:00 | -10.4 deg | 40 (night vision 1) | 40 | 40 |

Before, the exposure was 1.72 at 07:00 and 8.8 at 18:45 (a washed-out grey dusk), and it hit the
40 clamp at 19:15; now the sunset stays dark and warm, 19:15 (sun -2.4 deg, Ben Gurion) gives 17
and the clamp comes with the nautical twilight. Above the ground the sun is brighter for longer
(less air in the way), hence the lower values at 1,500 m.

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

## Night sky and the moon

* Stars (procedural: one star in 200 cells of a 3D lattice over the celestial sphere, a steep
  brightness distribution, three colour classes, kept a pixel wide at any resolution) and a faint
  Milky Way band (galactic plane from the north galactic pole, brighter towards the centre, dark
  dust lanes) turn with the sidereal time (`uCelestial`, `moon.js celestialFrame`), fading in as
  the sky darkens.
* The moon (`moon.js`, the low-precision lunar ephemeris of the Astronomical Almanac, with the
  topocentric parallax) has its position, phase and brightness for the sim's date (21 June of
  `env.year`, default 2026: first quarter at dusk; 2024 had a full moon). The disc is shaded with
  Lommel-Seeliger and an opposition surge, the dark side with earthshine; maria are procedural.
* Moonlight lights the scene "day for night": 500 x its physical irradiance (the eye's night
  adaptation is not modelled beyond the exposure clamp), tinted a little red. The directional light
  switches to the moon once it is brighter than the sun at the camera; moon shadows only near full
  moon and with the moon well up.
* Airglow and the glow of the coastal cities (`NIGHT`) give the night sky its floor.

## The HDR frame (`Post.js`)

```js
const post = new Post({ renderer, env, quality });   // main.js, after the Environment
post.render(scene, camera);                          // instead of renderer.render(scene, camera)
```

The canvas has no MSAA and no depth buffer; the scene goes into a half-float RGBA target with 4x
MSAA and a depth texture. Then:

1. clouds (optional module, below), composited with the resolved depth;
2. sun visibility: 21 samples of the disc in the HDR frame into a 1 x 1 target (terrain, the jet,
   the canopy frame or clouds in front of the sun), read by the output pass on the GPU (no readback);
3. bloom: physically thresholded (about twice a white surface in the sun, after exposure), a
   13-tap downsample chain with a Karis average on the first level and a tent upsample chain
   (Jimenez, SIGGRAPH 2014);
4. output: exposure, analytic sun glare (a core and a veil, normalised Lorentzian lobes scaled by
   the sun's measured visibility), faint lens ghosts, night vision, AgX (Troy Sobotka; the three.js
   / Blender fit) with a look (contrast 1.12 about a 0.42 pivot, saturation 1.12), optional vignette
   and grain (off by default: `post.options`), triangular dither, sRGB.

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

Presets (`CLOUD_PRESETS`): `clear`, `few` (default: 12 % fair-weather cumulus, base 1,350 m,
tops to 2,350 m), `scattered` (32 %, 1,250-2,700 m), `broken` (62 %, 1,050-2,300 m), `cirrus`
(a high streaked sheet at 9,500 m over a few small cumulus). The menu's Weather row sets
`settings.clouds`; `?clouds=` overrides it for the session.

Where the cumulus stand is one procedural field (four octaves of value noise on an integer hash,
`atmoCloudField` in GLSL and `cloudField.js` in JS give the same numbers), drifting with a 5.7 m/s
westerly. A preset's coverage is turned into a field threshold by the field's measured quantile.
Every frame:

1. the field around the camera goes into a 1024 x 1024 map (+-60 km, snapped to its texels);
2. at half (high, medium) or quarter (low) resolution each pixel's ray crosses the cumulus slab
   (spherical shells: the deck curves away at the horizon) up to the scene depth. Steps grow with
   distance (a pixel covers more there) with a minimum number across the slab (a deck seen
   edge-on). Density: the field's footprint x a height profile (flat base, domed top, taller in the
   middle of a cloud), eroded by a tiling 64^3 Perlin-Worley noise made on the GPU at start-up,
   and finer detail at the edges. Light: the sun's (or the moon's) light at the cloud's height,
   single scattering with a two-lobe phase function (the silver lining) and multiple scattering as
   diffusion, `~1 / (1 + 0.11 tau)` of the optical depth towards the light (5 light steps), so
   sunlit tops are white and a 1 km cumulus has a grey base; the sky light from above and the
   ground's from below. Aerial perspective to the cloud's mean distance;
3. the cirrus sheet (2D, streaked along the wind) above;
4. a depth-aware 3 x 3 upsample composites `scene x transmittance + light` into the HDR frame.

Inside a cloud the view fades to white. The exposure meter (`env.lightScale`) sees 55 % less light
at the centre of a cloud, and up to 38 % less in a cloud's shadow, so the eye opens up a little
under a cloud deck.

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
  relative, height MSL) through the atmosphere and in the clouds' shadow. The terrain already
  uses it, so the ground gets the cloud shadows with no change to `terrainShaders.js`;
  `atmoSunIrradianceClear` is the same without clouds.
* `float atmoCloudCover(vec2 xz)`: 0..1, inside a cumulus' footprint.

On the CPU, `cloudField.shadowAt(x, y, z, sunDir, layer, wind)` is the same shadow;
`app.clouds.layer` and `app.clouds.wind` hold the current layer. The standard materials (the jet,
buildings, trees) get the shadow at the jet: `Clouds.update` dims the sun's directional light by
it (after `env.update`, before the frame is drawn). The shadow is exp(-1.8) under a cloud's
centre: the light a cumulus lets through diffusely (~17 %).

## Shadows

One shadow map (the terrain shaders read the sun's). `Environment._fitShadow` fits its box in the
light's frame: in the air, tight around the jet (its shadow on the ground and its own shadows on
itself, ~1 cm texels at 4096); with the camera less than ~150 m above the ground, also a disc
ahead of the camera (`env.shadowNear`: 160 m at 4096, 110 m at 2048, the jet only at 1024) so
buildings, hangars and trees cast shadows around the runway while the jet's stays sharp
(~10 cm texels and a narrower filter). The wide box is quantised in size and snapped to whole
texels (no crawling); the depth bias is held at 0.8 m whatever the box. Modules only set
`castShadow` / `receiveShadow` on their meshes near the ground.

## Quality tiers

| | low | medium | high |
| --- | --- | --- | --- |
| MSAA (HDR target) | 4x | 4x | 4x |
| bloom levels | 5 | 6 | 7 |
| lens ghosts | off | on | on |
| clouds resolution | 1/4 | 1/2 | 1/2 |
| cloud steps (most / across the slab / light) | 48 / 14 / 3 | 72 / 20 / 4 | 96 / 28 / 5 |
| cloud detail erosion | off | on | on |
| shadow box near the ground | jet only | 110 m | 160 m |

## Cost

Measured in the container with `sim/tests/lighting_shots.mjs` (`renderInfo()` and `gpuMemory()`
in `report.json`; SwiftShader, a 960 x 540 window, so its frame times mean nothing), before this
work (`069c902`) and after, noon chase views (`few` cumulus after):

| | low before | low after | medium before | medium after | high before | high after |
| --- | --- | --- | --- | --- | --- | --- |
| draw calls, Tel Nof / Tel Aviv | 415 / 430 | 435 / 445 | 411 / 424 | 428 / 442 | 423 / 432 | 428 / 449 |
| triangles, Tel Nof | 1.20 M | 1.20 M | 1.20 M | 1.20 M | 1.20 M | 1.20 M |
| GPU memory (MB) | 644.9 | 663.1 | 667.0 | 691.9 | 780.9 | 804.3 |
| of it the frame (MB) | 10.0 | 23.6 | 17.8 | 41.2 | 17.8 | 41.2 |

The draw calls include the shadow pass and every full-screen pass: about +15 to +18 (clouds 3,
sun visibility 1, bloom 9 to 13, output 1; the counts move by a few with the terrain tiles
loaded). The frame's memory after is the canvas without MSAA or depth (3.3 / 5.9 MB) plus the
half-float 4x MSAA target with its depth and the bloom chain (18.2 / 32.3 MB) plus the clouds
(2.1 / 3.0 MB: the 64^3 noise, the 1024^2 cover map, the low-resolution cloud target). It grows
with the pixels: at 1920 x 1080 (pixel ratio 1) about 675 -> 728 MB (low), 720 -> 810 MB
(medium), 834 -> 922 MB (high), +53 to +89 MB.

GPU time on an RTX 3070 at 1080p, high: there is no GPU here, so these are estimates from each
pass's pixels, steps, texture fetches and ALU:

| | ms |
| --- | --- |
| scene into the half-float target instead of 8-bit, MSAA resolve of colour and depth | +0.3 to 0.5 |
| sun visibility, bloom (7 levels), output (glare, AgX, dither) | 0.4 to 0.5 |
| clouds, `few`, from the ground (cover map, march at 960 x 540, composite) | ~0.5 |
| clouds above a `scattered` deck | ~0.8 |
| clouds, flying inside a `broken` deck (the worst case) | up to ~2.5 |
| cloud shadows in the terrain shader (~150 ALU, no texture) | < 0.1 |

About 1.2 to 1.6 ms in fair weather, up to ~3.5 ms at worst. Medium is close to high (the clouds
at the same resolution, fewer steps); low is about half (75 % resolution, clouds at a quarter).
The wider shadow box near the ground keeps the 4096 map: it costs only the draw calls of whatever
casts shadows within ~190 m.

## Limits

* The clouds have no temporal filter: the jitter of the march shows as a fine grain that changes
  every frame (at 60 fps the eye averages it; a still screenshot shows it).
* `?post=0` has no clouds (they need the HDR target and its depth).
* What is drawn after the clouds (the plume, the glass, sprites) is not dimmed when the jet is
  inside a cloud; the view is white there anyway.
* Moonlight is boosted ("day for night", above); the eye's real night vision is far dimmer.
* Low quality keeps the shadow box around the jet: no building or tree shadows near the ground.
* There is no GPU in the development container: the costs above are estimates.

## Sources

* S. Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique", EGSR 2020.
* J. Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare", SIGGRAPH 2014
  (the bloom chain).
* T. Sobotka, AgX (the three.js / Blender 4 fit of the sigmoid).
* A. Schneider, "The Real-time Volumetric Cloudscapes of Horizon Zero Dawn", SIGGRAPH 2015, and
  "Nubis" (2017): Perlin-Worley noise, the height profile, the light march.
* M. Wrenninge et al., "Oz: The Great and Volumetric", SIGGRAPH 2013 talk (multiple scattering
  approximations); the diffusion falloff here is the two-stream estimate of a cloud's diffuse
  transmission.
* The Astronomical Almanac's low-precision formulas for the sun and the moon (as in J. Meeus,
  "Astronomical Algorithms").
* ESA WorldCover 2021 (CC BY 4.0) for the land cover whose albedo lights the shadows.

Everything here is procedural: no textures, photographs or models are loaded.
