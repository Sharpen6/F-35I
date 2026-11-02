# Light, sky, clouds and the HDR frame (`js/env`)

How the sim turns sunlight, skylight, moonlight and clouds into the picture on the screen. The
atmosphere itself (Hillaire 2020 look-up tables, aerial perspective) is described in
`js/terrain/README.md`; this file covers what is built on top of it: exposure and tone mapping,
ambient light, the night sky and the moon, the HDR post chain, the clouds and the sun's shadow box.

| file | |
| --- | --- |
| `Environment.js` | sun, moon, sky dome, lights, environment map, shadow box, exposure, the gain of artificial lights at night (`lightGain`) |
| `atmosphere.js`, `atmosphereGLSL.js` | the clear-sky atmosphere (CPU and GPU twins), the cumulus field's GLSL |
| `sun.js`, `moon.js` | sun position; moon position, phase and brightness, the sidereal frame of the stars |
| `Post.js` | the HDR frame: MSAA target, clouds composite, sun visibility, bloom, glare, AgX output, GPU timers |
| `Clouds.js`, `cloudField.js` | ray marched cumulus and cirrus with a temporal filter, weather presets; the field's CPU twin |
| `cloudShadowChunk.js` | the cumulus' shadow in three.js's own lit materials (the jet, buildings on three materials) |
| `displayLevels.js` | the jet's displays (the glb's PCD glass, the tablet, the switch LEDs) at a fixed picture level |

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

**Night lights.** Everything that makes its own light follows one rule and one switch-on
schedule, below ("Lights at night"), the terrain's city lights and the clouds' city glow too: they
were tuned by eye at the old night exposure of 40 (`NIGHT_LIGHTS_EXPOSURE`) and get the rule
through `uNight` = `env.lightsOn` x `env.nightLightGain` (= lightGain x 40 / 1400: 40 / exposure
at night, the brightness on the screen they were tuned to).

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

## Lights at night

One rule for every artificial light and self-lit surface: street lamps and the streets they
light, cars, lit windows and facades, the airfield's lights and PAPI, obstruction lights, the
jet's position lights, strobes and landing-light pool. The meter's exposure (up to 285) is for
the sky and the moonlit land, which the night boosts so the land reads ("day for night", above);
next to lit streets and aprons the eye is adapted much further, to the lights themselves. Drawn at
the meter's exposure every lamp would come out several times too bright (a white ball for the
jet's tail light, white slabs of windows). So artificial light is drawn as

    scene radiance = physical value / LUX_PER_UNIT x lightGain
    lightGain      = max(1, 1 + lightNight x (NIGHT_ADAPTED_EXPOSURE / exposure - 1))

* the physical value: a luminance in cd/m^2 (a lit window, a lens), an illuminance in lux x
  albedo / pi (a street or a facade under the lamps, the runway under the landing light), or for
  a point light its intensity in cd (lux at the eye: I / d^2);
* `lightNight` (`env.lightNight`, `lightNight(el)`): how far the eye has gone over to the lights,
  0 while the sky lights the ground with more than ~30 lux (the sun above ~-4.5 deg), 1 below
  ~0.3 lux (~-7.5 deg), smooth in log lux in between (`skyIlluminance(el)`);
* `NIGHT_ADAPTED_EXPOSURE` = 1400: the exposure of an eye adapted to lit streets.

`env.lightGain` holds it every frame (and after `setTime`). By day and in the blue hour the gain
is 1: a lamp is what it is next to the daylight. Once the sky is dark, radiance x exposure =
physical x 1400 / 32000 = 0.044 per cd/m^2, whatever the meter does: the lights look the same at
exposure 40 and at 285, and the moonlit land between them stays as dark as the meter makes it. On
the screen: a lit window of 10-40 cd/m^2 is 0.4-1.7, a warm amber pane (offices a paler warm
white); a street under its lamps (~1 cd/m^2) 0.044, a dim warm grey; a facade under 8 lux 0.04;
the runway 15 m ahead of the landing light (400,000 cd) ~0.2-0.5, brighter under the nose.

**One switch-on schedule.** `lightsOn(el)` / `env.lightsOn` (0..1) says whether a light is on,
the rule above how bright it is once on. It follows the sky's light on the ground: off above
~1000 lux (the sun ~0.7 deg up), half on a degree after sunset, all on by ~100 lux (-2.5 deg), the
spread of photocells and clocks switching street lamps, people switching on their rooms, the
airfield's lights going on at sunset (ICAO). Everything reads it: the street lamps and floodlit
aprons (`js/world/Roads.js`), the airfield's lights (`AirportLights.js`; their intensity then
steps down to the night setting by `lightNight`, x (1 - 0.65 lightNight)), the cars
(`Traffic.js`), lit windows, the street light on the walls and the obstruction lights
(`Buildings.js`), the terrain's city lights and the clouds' city glow (`uNight`), and the output
pass's path for lights (below). All on before the gain starts to rise (`lightNight` > 0 from
~-4 deg): in the blue hour the lamps are on at their physical level, faint against the sky, and
take over as it darkens.

**Lights in the HDR frame** (`emitters.js`). AgX bleaches any bright saturated colour: a PAPI's
red at 64 on the display comes out (255, 252, 246), a red light at 3 pink, and the night-vision
shift greys what is left. A light is not a lit surface: the eye sees its colour with the cones. So
every light leaves a mark in the scene target's alpha (half float, otherwise 1 for surfaces, ~0
for the cockpit's displays):

    alpha = -64 - 1024 w        w: the light's share of the pixel (0..1)

written through a MIN blend on the alpha (`emitterBlending`: the colour adds, the strongest mark
stays whatever the drawing order). Point lights write it from their own display brightness
(`emitterShare`, `pointLightAlpha`), opaque things that glow (lit windows, the jet's lenses) by the
share of their own light in the pixel's. `Post.js` reads w back: from sunset (`env.lightsOn`, so by
day nothing changes) such a pixel skips the night-vision shift and goes through a hue-preserving
tone curve, AgX's own curve on its brightest channel with the others in proportion (`agxHue`):
the PAPI's red is (255, 75, 48), CIE x 0.58. `Clouds.js` carries the mark through its composite,
faded by a cloud in front. Who writes it: the airfield's lights, street lamps, cars and
obstruction lights (the point-light GLSL), lit windows (`buildingShaders.js`), the jet's glows and
lenses (`js/aircraft/lights.js`), the night burner and the glow in the nozzle
(`js/aircraft/Afterburner.js`).

**Coloured point lights** are normalised by their brightest channel once the lights are on (a red
light's red channel carries its intensity), and the visibility floor and the 64 cap apply to that
channel: a saturated light's centre stays at ~0.8 at most where the floor sets it, its hue intact.
By day (no lights' path in `Post.js`, AgX's own curve) they are normalised by their luminance as
the day look was tuned (the floor up to 0.85: the PAPI's red stands out bright against a sunlit
field); the point-light GLSL blends the two by `env.lightsOn` (`uLightsOn`), so noon is as it was.

**Point lights** (the airfield's lights, street lamps seen from afar, cars, obstruction lights, the
jet's position lights and strobes) are sprites: the light's energy at the eye (I / d^2 x
lightGain) spread over a pixel-sized blur, plus a floor from the threshold of a point source
against the ground behind it (Allard / Blondel-Rey, E_t = 10^(0.64 log10 B - 5.7) lux for a
background of B cd/m^2: `pointLightThreshold(el)`, `env.pointThreshold`). A light a few times over
its threshold stays a visible dot even where its energy over a pixel would be too faint (an edge
light 3 km out): the dot's peak (its brightest channel) rises from 0 at the threshold to ~0.35
three stops over and never past 0.8 (no white blobs). A near light's centre is at most 64 on the
display (where the HDR chain's bloom clamps): a small hard point with a modest bloom, never a
ball. One GLSL for all of them, `js/world/AirportLights.js` `POINT_LIGHT_VERT_GLSL` /
`POINT_LIGHT_FRAG_GLSL` (the airfield, the cars of `Traffic.js`, the obstruction lights of
`js/world/Buildings.js`); the jet's lights use the same numbers on the CPU (`js/aircraft/lights.js`
`visibleFloor`, `coreCap`: at night only, by day they keep their look; the cap is eased in over
the first tenth of `lightNight` and then holds whatever the exposure, so a blue-hour tail light is
the same point as at night; under the cap the core keeps its base radius instead of growing as it
does by day, so it is the size of any point light at the cap (the tail light from the chase seat:
4 px over white in 8 px at half height); the sprite reaches out to where its skirt is invisible).
At night the jet's lenses are a coloured surface at 0.8 on the display (`LENS_NIGHT`) under their
glow.

**Light on dark land.** The landing and taxi lights light land that nothing else lights (a
runway, a field), seen by an eye adapted to that land rather than to lit streets, and the land is
drawn boosted (the moonlit ground ~20 lux as drawn, "day for night"). By the rule alone the
landing beam's ~0.5 lux on the runway 370 m ahead on short final came out x1.2 against it, which
is nothing, where the real runway there is tens of times brighter than by the moon. So the pool
keeps a floor, as a point light keeps its: the lamp against the ground's real light
(`env.groundLightPhysical`: the night's glow, ~0.003 lux, and the moon, without their boosts),
its brightening the log of the ratio (Fechner: brightness goes with the log of the light),

    F >= 1 + ln(1 + E_lamp / E_real)

a lit stretch of runway on short final, brighter in the flare (Tel Nof at 21:30, the median of the
ground at the beam's centre: x5 from 65 m up, x15 in the flare); near the nose the rule's own
value is the higher. By day and at dusk nothing is boosted and the floor stays under the rule
(`js/aircraft/LandingPool.js`). The pool's own light draws its edges: each beam ends at 3.4 of its
1/e widths (a reflector's rim) and the grid on the ground reaches past that (1.2-3 km ahead), so
no border of the grid shows across the approach. The same lamp lights the buildings' walls and
roofs in its beams under the same rule (`LAMP_GLSL` / `LAMP_UNIFORMS` of `LandingPool.js`, used by
`js/world/buildingShaders.js`; nothing while the pool is off): on short final over a town the pool
was lit ground between dark blocks, and a wall facing the lamp takes the beam head-on, more than
the ground under it. Trees are not lit by it.

**Picture levels.** A few self-lit things are set by eye or lie far outside anything an exposure
holds; they are drawn at a fixed brightness on the screen, level / exposure:
* the cockpit's displays, the switch LEDs and the kneeboard (`displayLevels.js`,
  `js/aircraft/Cockpit.js`): 1.05 by day, 0.5 at night for the PCD, as a pilot dims them. Under
  the rule that is ~11 cd/m^2 at night, a dimmed display; the light the display throws on the
  canopy and the tub is that luminance, so its reflections fade with it;
* the burner's flame (~10^4-10^5 cd/m^2, `js/aircraft/Afterburner.js`): by day its brightness on
  the screen grows with the exposure's 4th root; at night it is a fixed picture level with its own
  colours, shown by their hue (a light's mark): a long orange flame (~1-2 on the display) with
  crisp yellow-white shock diamonds (~3-5), a red-orange tail and a blue-violet sheath. The glow inside the nozzle is the engine's heat by the rule
  (the luminance of a body at ~930 K at idle to ~1030 K at MIL: a dim dark red, an orange-red;
  next to nothing in the dusk) plus the burner's picture level.

| module | light | physical value |
| --- | --- | --- |
| `js/world/Roads.js` | street lamps and apron floodlights on the roads and aprons | ~26-32 lux at a lamp's foot, up to 300 lux under a mast |
| `js/world/AirportLights.js` | runway, taxiway, approach lights, PAPI; street lamp heads | cd per light (ICAO); 3,000 cd sodium, 1,200 cd LED (seen from below their horizontal plane) |
| `js/world/Traffic.js` | head and tail lights | 500 cd and 18 cd towards a viewer above the road (`HEAD_CD`, `TAIL_CD`) |
| `js/world/Buildings.js` | lit windows, facades under the street lamps, obstruction lights | 20 cd/m^2 (`WINDOW_CD`, x 0.47-1.9 from room to room; homes 2700-3200 K, offices 3500-4500 K; 15-30 % of office windows lit after 20:00), 8 lux (`FACADE_LUX`), 32 cd steady / 2,000 cd flashing (`OBSTRUCTION_CD`) |
| `js/aircraft/lights.js` | position lights, tail light, anti-collision beacons | 150 cd, 40 cd, 600 cd; lenses 0.8 on the display at night |
| `js/aircraft/LandingPool.js` | the landing and taxi beams on the ground and on the buildings' walls and roofs | 400,000 cd (20 deg below the body axis: 10 deg below the horizon on the approach) and 250,000 cd, 7 and 13 deg 1/e, ending at 3.4 widths; a roll-off far above the night's light (`POOL_KNEE` 64); on dark land at least 1 + ln(1 + E / E_real) |
| `js/aircraft/Afterburner.js` | the flame; the glow in the nozzle | a picture level; the engine's heat as a black body (930-1030 K) by the rule |
| `js/aircraft/Cockpit.js`, `displayLevels.js` | PCD, LEDs, kneeboard | a picture level |

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
   ~35/255. From sunset a light's pixels (the mark in the scene's alpha, `emitters.js`) skip the
   night vision and go through `agxHue` instead of AgX (README "Lights at night": `uEmitters` =
   `env.lightsOn`; 0 by day, so the day's frame is AgX's throughout).

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
* Light that a module tuned by eye at the old night exposure (40) shows ~7 x brighter at night
  (285) unless it follows the rule ("Lights at night") or `uNight` / `env.nightLightGain` (the
  terrain's city lights and the clouds' city glow do the latter).
* Night vision (`Post.js`) shifts colours darker than display ~0.6 towards rod vision; under the
  rule that is ~14 cd/m^2, where the eye still sees colour (CIE mesopic: down to ~5 cd/m^2). The
  lit streets and the facades lose some of their warmth to it; the cockpit's displays (their
  alpha ~0) and the lights (their mark) are exempt.
* A light's mark is per pixel: a light half hidden behind the glass passes still counts as one
  (their alpha adds a little to the mark), a light seen through a cloud loses it with the cloud's
  transmittance. The terrain's city lights are drawn into the terrain itself and carry no mark
  (AgX shows them; they are warm and dim enough to keep their tint).
* There is no GPU in the development container: the GPU costs above are estimates; the bench's
  GPU time line measures them on a real GPU.

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
