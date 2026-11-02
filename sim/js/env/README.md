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
| `lightPollution.js` | the cities' glow in the night sky and under the clouds where the camera is (JS and GLSL twins) |
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
* The night sky's own glow (airglow, starlight and, in central Israel mostly, the cities' light
  in the haze) is the light pollution model below, for where the camera is. It fades in under the
  last of the twilight as the sun goes from -2 to -10 deg (`NIGHT.fadeFrom / fadeTo`), so the dusk
  goes on darkening on the screen to ~-8 deg and the western glow shows until ~-10 deg.
* Stars (procedural: one cell in ~140 of a 3D lattice over the celestial sphere holds a star at
  a jittered point taken straight out to the sphere, ~6,500 in the whole sky, three colour
  classes, kept a pixel wide at any resolution) each have a magnitude from their rank: the number
  brighter than m grows ~3 x a magnitude (`N(<m) ~ 7 x 10^(0.47 m)` in the whole sky, as the real
  sky's), so they run from -1.8 (Sirius, the planets) to 6.3. A star shows when it is brighter
  than the naked-eye limit of the sky behind it (Schaefer's fit, as the light pollution atlases use
  it: `NELM = 7.93 - 5 log10(0.824 sqrt(B) + 1)`, B in natural units, below), B the sky as it
  physically is: the twilight that is left (the sky-view LUT's alpha: read from its colour, which
  also holds the night term, the half float's rounding of the sunlit part, ~6e-8 x the sun, read
  as ~20 n.u. and a dark site's sky as Gush Dan's), the moonlit sky (unboosted) and the cities'
  glow in that direction, each star dimmed and reddened by the air on its way. So they come out
  one by one at dusk, the brightest first, and the count follows the place. The stars brighter
  than the limit where they are (moonless, above the horizon; the limit at the zenith in
  brackets), counted by a JS replica of the shader (the same lattice, hash, magnitudes, sky model
  and extinction) and checked against a picture of the sky over the Dead Sea (90 deg field of view
  straight up: 757 stars found in it, 837 expected, the faintest at the limit lost in the count):

  | where (the spawn) | stars | of them above 10 deg |
  | --- | --- | --- |
  | central Tel Aviv, ground (3.8) | ~20 | ~20 |
  | Tel Aviv, 3,000 m (`tlv_3000`, 4.5) | ~95 | ~95 |
  | Ben Gurion (`bengurion_26`, 5.0) | ~290 | ~290 |
  | Tel Nof (`telnof_36`, 5.5) | ~590 | ~580 |
  | Jerusalem, 1,500 m (`jerusalem_sunset`, 5.65) | ~830 | ~810 |
  | off Ashdod, 300 m (`coast_low`, 5.8) | ~940 | ~920 |
  | north of the Dead Sea (`deadsea_low`, 6.25) | ~1,460 | ~1,440 |
  | the Negev south of Beer Sheva, 500 m (6.5) | ~2,140 | ~2,080 |

  Fewer under the moon. Before, a star showed only where its cell's point lay within ~1.3 pixels
  of the sphere: the count followed the pixel size (~5,400 in the whole sky at 1080p, ~8,800 at
  960 x 540, ~3,300 at 4K) and the stars went out when zooming in. On the screen the brightness is
  compressed (x1.6 a magnitude, not 2.5: the bright ones would be blobs, the faint ones nothing).
* The Milky Way (galactic plane from the north galactic pole, brighter towards the centre, dark
  dust lanes) adds ~1.2 natural units at its brightest: it shows where that is more than ~8-25 %
  of the sky behind it (`smoothstep(0.08, 0.25, contrast)`), so faintly over the Dead Sea, the
  Negev and out at sea on a moonless night, and not at all in Gush Dan or under a bright moon
  (Falchi et al.: it is hidden for 98 % of Israelis). It is drawn at the night's gain for the
  place (below), so its contrast with the sky is its real one. Stars and Milky Way turn with the
  sidereal time (`uCelestial`, `moon.js celestialFrame`).
* The moon (`moon.js`, the low-precision lunar ephemeris of the Astronomical Almanac, with the
  topocentric parallax) has its position, phase and brightness for the sim's date (21 June of
  `env.year`, default 2026: first quarter at dusk; 2024 had a full moon). The disc is shaded with
  Lommel-Seeliger and an opposition surge, the dark side with earthshine; maria are procedural.
* Moonlight lights the scene "day for night", tinted a little red: boosted by the night's gain
  for the place (`SkyGlow.gain`, the sky's zenith as drawn over the zenith as it is, below), so
  the moonlit land and clouds keep their real contrast with the sky; the gain falls as the moon
  brightens the sky (at 21:30 over Tel Aviv at 3,000 m ~400 x on a moonless night, ~370 under the
  first quarter of 2026, ~270 under the full moon of 2024; over the Dead Sea ~2,000, ~980 and
  ~360). The boost fades in as
  the sun goes from -6 to -12 deg (in twilight the real sky outshines the moon; boosted at once, a
  quarter moon lit the jet blue at -5 deg). It was a fixed 1,600 x, 4-8 x the sky's gain over
  Gush Dan: moonlit clouds glowed there, and a full moon read as a dull day (the exposure fell to
  ~100). The meter takes in 0.1 of the boosted moonlight (the dark-adapted eye adapts only a
  little to it), so a full-moon night is clearly brighter than a quarter-moon one: above a deck
  over Tel Aviv under a near-full moon the exposure is ~240-260, the deck sRGB ~55-75 with its
  moonlit tops at ~80-85 under a blue-grey to grey sky (~[40, 40, 46]); in the deck it stays at
  285 (with 0.2 it fell to ~190-200 and the deck was hardly brighter than under the quarter
  moon). The directional light switches to the moon once it is
  brighter than the sun at the camera; moon shadows only near full moon and with the moon well
  up. The moonlit sky is the day's blue Rayleigh sky at ~1/7 of a white surface under the moon
  (`MOON_SKY`: ~40 n.u., 18 mag / arcsec^2, under a full moon 30 deg up in hazy summer air),
  drawn at the same gain, and counted as it physically is for the stars. A new date can move the
  moon alone: `setTime` redraws the sky-view LUT and the environment map.

### The cities' glow (light pollution, `lightPollution.js`)

In central Israel the night sky is lit far more by the cities than by the stars and the airglow:
in the light pollution atlas (Falchi et al. 2016) most of Gush Dan is tens of times the natural
sky, the Judean desert and the Dead Sea near natural, with the glows of Jerusalem, Amman and the
Dead Sea works on their horizons. The sky had one glow for everywhere (a navy zenith, a warmer
horizon all round). Now, in natural units (n.u.: 1 = the natural sky at the zenith, 22.0 mag /
arcsec^2 = 174 ucd/m^2; near the horizon the airglow and scattered starlight make it ~2.5):

* 19 light sources (`CITIES`: Gush Dan in seven parts, Jerusalem - Ramallah - Bethlehem, Haifa,
  Gaza, Beer Sheva, Amman - Zarqa, the Dead Sea works and more), each a light output P (~ million
  inhabitants at Israeli street lighting levels) and a lit radius R. Each adds at the zenith
  `Z = 1500 P (D^2 + R^2)^-1.25` n.u. (Walker's law, D km away, levelling off inside the city) and
  a dome towards it: `Z A lobe(azimuth) exp(-tan(elevation) D / H)`, A (2-25) growing with the
  distance (a far city is all horizon glow, a near one fills the sky), the lobe as wide as the
  city seen from there plus the haze's spread, H ~ 4 km the height of the scattering haze, dimmed
  by the haze over the distance; above the camera the glow fades with height (4 km).
* `SkyGlow.update` (Environment, when the camera has moved 200 m or 50 m in height, or the cloud
  base has changed; ~20 us) hands the ten strongest domes to the shaders as uniforms (`uLPSrc`,
  `uLPCity`, `uLPBase`) and their mean over the azimuth to the sky-view LUT's night term
  (`uNightZenith / Horizon`, with the moonlit sky): the haze, the sea's reflection, the ambient
  light's night floor and the meter see the place's glow. The sky dome adds each dome in its own
  direction (the deviation from that mean). The LUT is redrawn with each update (~0.05 ms), the
  environment map when the night sky's light has changed by 5 % (at most once a second). Updated
  every kilometre, the sky stepped 10-12 % at a time over Gush Dan; now the steps are 2-3 %.
* Calibrated to the atlas (`sim/tests/light_pollution.test.mjs`; mag / arcsec^2 in brackets):

  | where | zenith (n.u.) | the brightest horizon | naked-eye limit | zenith drawn (scene units) |
  | --- | --- | --- | --- | --- |
  | central Tel Aviv, ground | 47 (17.8) | ~150, all round | 3.8 | 7.0e-5 |
  | Tel Aviv, 3,000 m | 23 | ~70 | 4.5 | 5.0e-5 |
  | Ben Gurion | 11.5 (19.4) | 37 towards Tel Aviv (NW), 3.3 x the zenith | 5.0 | 3.8e-5 |
  | Tel Nof (the runway) | 6.2 (20.0) | 24 towards Rehovot - Tel Aviv (N) | 5.5 | 3.0e-5 |
  | north of the Dead Sea | 2.0 (21.2) | 6 towards Jerusalem (W), Amman (E) | 6.25 | 2.2e-5 |
  | 30 km out at sea off Tel Aviv | 1.9 (21.3) | 7 towards Tel Aviv | 6.3 | 2.2e-5 |
  | the Negev south of Beer Sheva | 1.2 (21.8) | 3 towards Beer Sheva | 6.5 | 2.0e-5 |

* The display: the sim's night is "day for night" (the exposure stops at 285, far below a
  dark-adapted eye's), and the eye adapts further in a darker place. One gain per place: the
  zenith (B0 n.u.: the cities' glow, the natural sky and the moonlit sky) is drawn as
  `3.7e-5 x ((B0 + 3) / 14)^0.5` scene units (`LP_MODEL.level, floor, ref, gamma`), and everything
  else in the night sky at the same gain (drawn / B0 per n.u.): the domes on the horizons, the
  moonlit sky, the Milky Way and the moon's light on the land and the clouds keep their real
  contrasts within the view. Ben Gurion's zenith is drawn at 3.8e-5, central Tel Aviv's at 1.9 x
  that, the Dead Sea's at 0.59 x and the Negev's at 0.54 x (physically 4.1 x, 1/5.7 and 1/9.6): the floor
  (3 n.u.) keeps a dark site's sky above the land it outlines, so the skyline of the Judean hills
  still shows against the sky over the Dead Sea (it was drawn at ~1/3 of Ben Gurion's and crushed
  to black there). The colour follows the cities' share of B: their light (sodium and warm LEDs
  seen through the haze, ~[1, 0.5, 0.1]: `LP_RGB`), greyer towards the zenith where the air's own
  scattering mixes in, over the natural sky's blue (`NAT_RGB`). On the screen, after the night
  vision pass, the sky over Tel Aviv at 3,000 m is a brownish orange-grey (sRGB ~[47, 38, 31] 15-25
  deg up), over the Dead Sea a dark blue-grey (~[15, 15, 19] high up, ~[22, 23, 27] near the
  horizon) above darker hills (~[18, 18, 22]). (A 3300 K glow came out pinkish grey through the night vision
  pass: its blue-grey rod picture outweighs a weak orange.) The stars and the Milky Way are seen by
  the physical B (above), not by the drawn one.
* Under a cloud deck the cities' light is reflected down: a cloud base over Tel Aviv is ~15 x
  the clear sky there (~700 n.u.; Kyba et al. 2015 measured overcast city nights at 5-25 x the
  clear ones), falling off within a few km beyond a city (`lpCloudBase`): orange-grey bases over
  Gush Dan (~40 n.u. over Ben Gurion; seen from 800 m over Tel Aviv sRGB ~[72, 59, 46], the clear
  sky there ~[42, 34, 28]), dark ones over the desert and the sea. Drawn at the
  geometric mean of the base and the zenith (`gain x sqrt(base x zenith)`: ~4 x the sky over
  central Tel Aviv, not ~15 x), as the eye would not adapt to a deck it only glances at. See the
  clouds below.

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
   the sun's measured visibility; an eye's or a camera's, below), faint lens ghosts in the camera
   views only, night vision, AgX (Troy Sobotka; the three.js
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

### Sun glare and lens ghosts: an eye or a camera

`post.view` is the camera mode (main.js sets it every frame). The cockpit view is the pilot's
own eye behind the canopy; chase, orbit, fly-by and tower are a camera (`VIEW_OPTICS`):

* **eye** (cockpit): no lens, so no ghosts, ever. The sun is a blinding disc in the eye's own
  scatter: the CIE 135 disability glare (`L_veil / E = 10 / th^3 + 5 / th^2 + ...`, th in degrees:
  ~15 / sr at 1 deg, 0.07 at 10 deg) is the reference; the glare drawn is about a third of it out
  to ~10 deg (core 3 % of the sun's irradiance in a lobe 0.43 deg wide, veil 0.6 % 5.7 deg wide)
  and less beyond: the full veil, added to a picture on a screen, reads as a washed-out scene
  round the sun rather than as dazzle. The canopy adds its own haze and scratch glow round the sun
  (`js/aircraft/pcd/canopy.js`).
* **camera** (the outside views): a modern multicoated lens. Its glare (diffraction and the
  glass' veiling glare) is half to two thirds of the eye's (as it was for every view); its
  ghosts (`GHOSTS`) are each the sun's light reflected twice inside the lens, so they carry ~R^2
  of it (R ~ 0.2-0.3 % per coated surface): 0.5-8 millionths of the sun's irradiance, spread over
  the ghost's disc (the defocused aperture, 0.5-2.4 % of the image height, a little brighter at
  its rim), on the line from the sun through the centre of the frame, tinted by the coatings
  (green, magenta-amber). The radiance a ghost adds is `E f / solid angle` (0.004-0.007 E / sr):
  faint discs over dark ground at sunset, none against the bright sky round the sun, as in
  photographs from a good lens.

The ghosts were `0.012 E / sr` whatever their size (10-70 x too bright), up to a tenth of the frame
wide, and drawn in the cockpit too: at Ben Gurion at sunset three orange discs lay over the left
half of the chase view (one large at the edge), and over the HUD and the instrument panel in the
cockpit. The bloom (a physical threshold at ~2 x a white surface in the sun, 8 %) is the same for
both: it only spreads what is far brighter than the scene, so the scene round the sun keeps its
contrast.

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
   the cloud between (the base is darker than the top); at night the cities' light from below
   (night clouds, below). Aerial perspective to the cloud's light-weighted distance, which also
   goes to a second target for the filter;
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

**Night clouds.** By night a cumulus is lit by the moon (its march light, boosted like the
moonlight on the land), by the sky's own glow from above, by the ground from below and by the
cities' light under its base (`lpCloudBase` from `lightPollution.js`, the same uniforms as the
sky dome: ~15 x the clear sky under a cloud over Tel Aviv, ~3 x over Ben Gurion, nothing over
the desert or far out at sea), which lights the base and fades faster into the cloud, down to the
~15 % a thick cumulus lets through diffusely. The sky's light on the clouds is the sky alone
(`env.skyAmbient`): it was the terrain's ambient light, which carries the moon's light too (the
terrain has no moon term of its own), so the moon lit every cloud twice, its shadowed side as
well: at 21:30 under the quarter moon the clouds were light grey all over, with bright tops,
against a black-blue sky (an underexposed day). Now:

* no moon: dark grey shapes against the sky's glow, hiding the stars; their bases orange-grey
  over Gush Dan and Jerusalem, a little lighter than the sky there, darker than it over the
  desert and the sea;
* the moon up: the sides and tops that face it silver-grey, the rest dark (far dimmer than by
  day: the night's exposure is the eye's ceiling);
* dusk (the sun from 0 to -10 deg) and the day are unchanged: the night terms are faded in with
  the night glow.

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
| lens ghosts (outside views only) | off | on | on |
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

The night sky's light pollution, the stars' naked-eye limit and the per-view glare add no pass,
target, texture or program: uniforms and a little ALU. The sky dome's pixels evaluate ten domes
(an exp each) and the limit (~60 ALU), well under 0.01 ms at 1080p; the twilight for the stars
rides in the sky-view LUT's alpha (written already, no fetch more); the cloud march adds one
`lpCloudBase` (ten terms) per ray at its first cloud sample; the ghosts are four discs as before.
On the CPU `SkyGlow.update` and its azimuth mean (~20 us) run when the camera has moved 200 m (or
50 m in height) at night, about once a second at 400 kt; the sky-view LUT is redrawn with them
(~0.05 ms), the environment map at most once a second if the night sky's light moved 5 %. Draw
calls, programs, samplers and the GPU memory estimate are unchanged.

## Limits

* The temporal filter trades the boiling for a little softness while the camera moves fast, and
  a cloud edge that moves against the background (a turn, a roll) can show a faint trail for a
  few frames (the neighbourhood clip keeps it short).
* `?post=0` has no clouds (they need the HDR target and its depth).
* What is drawn after the clouds (the plume, the glass, sprites) is not dimmed when the jet is
  inside a cloud; the view is white there anyway.
* Moonlight and the night glow are boosted ("day for night", above); the eye's real night vision
  is far dimmer, and the night exposure (285) still stops short of a fully dark-adapted eye. From
  place to place the gain changes (the sky over Tel Aviv drawn ~3 x the Dead Sea's, not 25 x);
  within a view the contrasts are real, except for the cities' light on the cloud bases (drawn
  compressed against the sky, above).
* The moon: its sky is one blue glow (`MOON_SKY`, the same in every direction: no brightening
  towards the moon, no darker sky opposite it, no halo or corona in thin cloud), as bright as in
  hazy summer air (in clean air it would be ~2 x darker); it lights the clouds and the land as a
  single directional light with no colour change by its height (a low moon is not yellower); the
  terrain and the clouds get the moon's light, the night sky's glow and the cities' light from
  below, but no moonlight reflected off the clouds onto the ground. The phase and the position
  are for 21 June of `env.year` only (the sim has no other date).
* The light pollution model has 19 sources and ten domes at a time; small towns, the villages
  and the roads' own glow are folded into the larger sources. The domes are smooth (no
  structure from the haze layers or the terrain in front of a city); the sea reflects their mean.
  Light pollution is the same every night (no weather other than the cloud deck, no curfew).
* Low quality keeps the shadow box around the jet: no building or tree shadows near the ground.
* Light that other modules tuned by eye at the old night exposure (40) shows ~7 x brighter at
  night (285) until it is multiplied by `env.nightLightGain`: here the jet's throat glow at idle
  (`js/aircraft/Afterburner.js`, an orange disc in the night shots); the aircraft track's light
  sprites and landing-light pool when they are merged.
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
* F. Falchi et al., "The new world atlas of artificial night sky brightness", Science Advances 2
  (2016): the natural unit, the zenith brightness the light pollution model is calibrated to.
* C. Kyba et al., "Worldwide variations in artificial skyglow", Scientific Reports 5 (2015):
  overcast city skies 5-25 x the clear ones, clouds darkening the sky at dark sites.
* M. Walker, "The effects of urban lighting on the brightness of the night sky", PASP 89 (1977):
  sky glow ~ population x distance^-2.5.
* B. Schaefer, "Telescopic limiting magnitudes", PASP 102 (1990), and K. Krisciunas and B. Schaefer,
  "A model of the brightness of moonlight", PASP 103 (1991): the naked-eye limit, the moonlit sky.
* CIE 135/1-6 (1999), "Disability glare" (Vos et al.): the eye's glare spread function.

Everything here is procedural: no textures, photographs or models are loaded.
