# js/aircraft: the F-35I in three.js

`AircraftVisual` loads `data/aircraft/f35i.glb` and `f35i_rig.json` (built by
`tools/aircraft/export_glb.py`) and animates them: every control surface, door, the gear sequence,
wheels, struts, canopy, stick, throttle and pedals, the pilot's head, the nozzle petals, the
afterburner plume and the exterior lights. `AircraftFX` (a graphics module of `main.js`) adds what
the jet does to the air and the ground: vapour, contrail, tyre smoke, the landing light's pool.

```js
import { AircraftVisual } from './aircraft/AircraftVisual.js';

const visual = new AircraftVisual({ scene, baseUrl: 'data/aircraft/' });
await visual.load((fraction, label) => progressBar(fraction, label));

// every frame
visual.setPose(state.position, state.quaternion);   // world position of the CG, body -> world
visual.setControls({ ...state.controls, ab: state.engine.ab, wheels: state.wheels, lights });
visual.update(dt, camera);
renderer.render(scene, camera);
```

## Frames

`visual.object3d` is a `THREE.Group` in the sim's **body frame** (+X right wing, +Y up, -Z forward,
origin = the reference point / CG, sim/DESIGN.md). Inside it the glTF model (Blender's +X left,
+Z forward) is turned 180 deg about Y. `setPose` copies the position and quaternion onto it.

## setControls(c)

All keys optional; missing keys keep their last value.

| key | range | effect |
| --- | --- | --- |
| `stick_pitch`, `stick_roll`, `pedals` | -1..1 (+ pull / right / right) | stabilators, flaperons, rudders (mixed and clamped as in the Blender drivers), stick and pedals in the cockpit, the pilot's right hand |
| `throttle` | 0..1 (0.75 MIL) | throttle lever and the pilot's left hand; nozzle petals and plume when `ab` is not given |
| `flaps` | 0..1 | flaperons down, LEFs down |
| `speedbrake` | 0..1 | rudders split outwards |
| `gear` | 0 up .. 1 down | the whole sequence: doors open, legs swing, doors close (the 201-sample Blender sequence) |
| `nws` | -1..1 (+ right) | nose wheel steering (only with the gear down and locked) |
| `roll_distance` | m | wheel rotation (each wheel at its own radius) |
| `weapon_bays`, `canopy`, `refuel_door`, `gun_door`, `tailhook` | 0..1 | doors, canopy (40 deg), hook |
| `ab` | 0..1 | afterburner plume and nozzle opening (omit or `null`: follow the throttle above 0.75) |
| `lights` | `{nav, anticoll, landing, formation}` | booleans; `formation` may be 0..1 (dimmer) |
| `wheels` | `[{name: 'nose'/'left'/'right', compression, steer}]` | strut compression in m from fully extended (0 = wheels hanging, `info.gearContacts[i].travel` = bottomed); the nose wheel's `steer` (rad, + right) is used when `nws` is not given; FlightModel's `state.wheels` fits |
| `strut` | `{nose, left, right}` | the same as an object |
| `head` | `{yaw, pitch, tilt}` rad | the pilot's helmet (+ = look left / up / tilt right) |

## info (body frame)

`visual.info` is `rig.info` with every 3-vector turned into an `InfoPoint` (a `THREE.Vector3`
that also reads as an array: `p.x === p[0]`); `visual.info.raw` is the plain json.

* `eye`, `eyeForward`: the pilot's eye point (between the corneas) and his straight-ahead.
  `visual.eyeWorld(out)` gives the eye in world coordinates.
* `gearContacts[]`: `{name, pos, radius, axis, travel, staticCompression, posParked, axle, axleDir,
  width, tyreDeflection, control, node}`. `pos` is the tyre bottom with the gear down and the
  strut **fully extended**; the strut compresses along `axis` (unit, roughly +Y) by up to `travel`
  (0.21 m nose, 0.225 m mains). The model is parked with `staticCompression` (0.05 m) used, so a
  spring that settles there under the parked weight puts the jet at the Blender stance
  (`groundStance`: 1.45 deg nose up).
* `nozzle`: `{exit, radius, radiusAB, axis, throat, throatRadius}`, `noseSteer`, `lights[]`,
  `landingLight`, `bbox`, `length` (15.69 m), `span` (10.78 m), `height`, `groundStance`.
* `visual.info.controls`: the rig's control table (ranges, defaults).

## What it does each frame (`update`)

* `RigPlayer` (`rig.js`) interpolates every control's samples and sets each moving node's position
  and quaternion: `T(rest) * L(outermost) * ... * L(innermost)` (wheel spin inside the strut inside
  the retraction), so all controls combine correctly. Surfaces on one hinge add their angles and
  clamp like the Blender drivers. The nozzle's `AB_Open` morph target follows `ab` (or throttle).
* `Afterburner.js`: a ray-marched emitting volume in a bounding cylinder behind the nozzle exit
  (16 / 24 / 32 steps per pixel by quality, only drawn while `ab > 0`). By day a short, mostly
  transparent orange-yellow core that fills the exit and tapers within ~2 m, a faint blue at the
  lip, pale diamonds close in; the faint back half fades out against a daylight sky (no pink tail
  over blue). At night the whole core (3.2 m at full burner) and a train of five yellow-white shock
  diamonds, each weighted by the core where it sits (attached, none past the flame). Each channel
  saturates at a hot orange-yellow and the flame covers what is behind by its opacity
  (premultiplied; higher by day, as the core is in reality several times brighter than the sky:
  a transparent flame over blue sky would come out as a pale, whitish puff, worst seen from the
  front quarter), and its display brightness grows only with the 4th root of the exposure
  (`flameDisplayGain`, normalised to the meter's noon value `fxEnv.noonExposure`) and then goes
  through a hue-preserving shoulder (the brightest channel rolls off, the others keep their ratio):
  seen end-on at dusk and night the core is a saturated ~(240, 205, 140), never a white disc. Day
  and night look (`flameDayLook`) come from the light level `fxEnv` (the sun's elevation), not from
  the exposure. Throat glow: a dull red at idle, orange at MIL (both only seen in the dark),
  orange-yellow in burner; with the burner lit it is drawn inside the plume shader, under the same
  shoulder (two separately tone-mapped layers added up to white before). Nozzle petals: open at idle
  (the F135's idle nozzle), closed at MIL, opening again with the burner (`nozzleIdleOpen`); they
  follow the engine, not the lever (`lagThrottle`, first order, `NOZZLE_TAU` 1.3 s: the spool takes
  ~4.5 s from idle to MIL).
* `lights.js`: photometric exterior lights (scene radiance 1 = ~30,000 cd/m^2). Lens emission on
  the glTF light materials; one `THREE.Points` draw for the glows of all lights: a core (the light
  reaching the camera, I / d^2, while the lens is smaller than a few pixels) and a halo (glare)
  only once it is dark (`fxEnv.darkness`, from the sun's elevation), so by day a lit lens is a small
  dot, not an LED glow. The core's profile has a soft skirt, `(1 + 2 r^2 / a^2)^-2` (a lens's
  spread, energy-conserving): a light brighter than the display can show looks bigger, as glare
  does, and fades out at its edge rather than ending as a flat disc. A hue-preserving shoulder in
  the glow shader (lower for a saturated light) keeps a distant red or green light red or green (no
  white core with a coloured rim); on the canvas it is the glow's whole tone curve (three's ACES on
  top of it bleached a bright green to a pale mint): green tops out at ~(85, 243, 152), red at
  ~(243, 66, 46). The sprite is drawn 0.6 m (+ 0.2 % of the distance) nearer the camera than the
  lamp, so the lamp's housing and the wing's edge beside it do not bite into the glow. On the
  canvas the brighter of glow and frame wins, channel by channel (`MaxEquation`): the wing-tip and
  the fuselage light of one side seen from abeam, or a lens on the sunlit skin, no longer add up
  to white; on the HDR chain's float target the glows add.
  Nav lights (red left, green right; white tail light, glow only) seen only within their sectors;
  the anti-collision beacons (spine, belly) flash 90 ms a second each, alternating; formation
  strips a soft green at night. The landing lamp has two beams: the landing beam (400,000 cd, 7 deg
  1/e half width) aimed 12 deg below the body axis, which on a 3 deg approach at ~12 deg alpha points
  along the glide path and at the flare lights the touchdown zone, and the wider taxi beam
  (250,000 cd, 13 deg) 5 deg below the axis, which takes over with weight on wheels (blended over
  0.8 s). The lens brightens when the camera is in a beam; `visual.lights.landing` `{on, position,
  direction, intensity, spread, spill, beams: [{name, direction, intensity, spread, weight}]}`
  (world) publishes both for the ground pool (`direction` and `intensity` are the dominant beam's).
  In the dark the glows get a visibility gain (`AircraftLights.nightGain(darkness)`, up to ~200):
  the sim's exposure stops at 40, far below a dark-adapted eye. When the frame goes to the HDR
  chain's float target (`fxEnv.bloomOn`) the halo is fainter (the bloom makes the glare) and the
  shoulder higher; `visual.lights.haloGain` scales the halo further.
* `materials.js`: calibration of Blender's Cycles materials for three.js (`TUNE`): the skin
  without the clear coat and sheen (they read as chrome plastic in three.js's BRDF) and a little
  rougher, rubber tyres, light grey wheel wells and bay interiors, painted gear legs; the nozzle
  gets its own material (`NOZZLE`): heat staining towards the exit (bronze / taupe) and soot on
  the inner petals. Ambient occlusion from the export (below) applied to the ambient light only.
* `effectMeshes()`: the plume, the throat glow and the light glows (their shader programs are
  built by `AircraftFX` before they first show).
* With the camera within 0.3 m of the eye (`headHideDistance`) the pilot's head (helmet, visor,
  mask) is hidden and the canopy's tint is softened for the view from inside.

## Effects: `AircraftFX.js` (graphics module)

Registered in `main.js` `_addGraphicsModules()` with `this.addModule(new AircraftFX(ctx))`. It reads
the player's FlightModel state and the AircraftVisual, never changes them, and draws:

| file | what |
| --- | --- |
| `Vapor.js` | wing-tip vortex trails (thin white lines, high lift in humid air), chine vortex tubes over the wing roots at high alpha, vapour sheets over the upper wings at high g low down (streaky, drifting aft, up to two layers hugging the skin from the leading-edge flap's hinge aft, fading where seen edge-on: no hairlines from ahead), the transonic vapour cone (Mach 0.93-1.01 in humid air: up to three nested, slightly irregular shells, densest near the skin, each fading where seen edge-on, streaks along the flow from the side and a mottled cloud along the axis, a sharp but ragged aft edge at the shock), the contrail above ~8-9 km (a gap of clear exhaust first, spreading and fading over 25 s; its points are spaced by speed so that they always cover the whole life: no blunt end) |
| `TyreSmoke.js` | puffs of rubber smoke from each wheel at touchdown (ground speed > 25 m/s), denser the faster and harder: one GPU-animated point cloud (rise, growth, drift, fade over ~3 s) |
| `LandingPool.js` | the landing and taxi beams on the ground (the terrain's shaders ignore three.js lights): a terrain-following grid ahead of the lamp, `E = sum I(theta) cos(i) / r^2` per fragment against the light already on the ground `E_amb`. By day, at sunset and at dusk the physical ratio `E / E_amb` is all there is (a faint brightening near the nose wheel); in the dark a visibility gain `poolGain(fxEnv.logLux)` (1 down to the sun ~3 deg below the horizon, up to 300 once the sky is dark) under a logarithmic roll-off on the brightness (`POOL_KNEE` 4, the channels kept in proportion): a lit runway fading out along the beam, not a flat white wedge. The canvas is already tone-mapped, and the tone curve is no multiplication (its toe crushes the red of the dark bluish night ground, its shoulder squeezes white paint), so the pool is worked out on two reference grounds, the runway's asphalt and its paint (`POOL_ALBEDO` 0.115 / 0.62), without and with the lamp through the renderer's own tone curve, and the canvas gets the map per channel that is exact on both, `drawn = dst x M + A`: three draws multiply (an 8-bit canvas clamps a blend factor at x2 a draw), one adds. The asphalt turns the lamp's warm grey, not the night's blue made brighter; the paint stays brighter and turns white, not bluish. On the HDR chain's float target the draws multiply by `1 + gain E / E_amb` per channel instead (right for any albedo). Faded by the fog; no draws with the sun more than ~4 deg up |
| `fxshared.js` | the light level `fxEnv` (sky illuminance from the sun's elevation after the twilight tables, `darkness` 0..1, `noonExposure`, bloom detection), `fxExposure`, the air model (temperature, humidity, dew point), `condensation(state, mass, out)`, a tileable noise texture, the vapour lighting (sun with forward scattering + sky, from the Environment), three's fog for premultiplied and additive effects (`fogUniforms`, `FOG_PARS_GLSL`), camera-facing trail ribbons (a preallocated ring, vertex arrays written in place) |

Condensation (`fxshared.condensation`): the local cooling `V^2 / (2 cp)` x a factor x CL (CL from
`n W / (q S)`) against the dew-point depression of a warm humid Levant day (ISA + 8 K near the
ground, 65 % humidity at sea level falling to ~10 % aloft). A 7 g turn at 300 m gives vortices and
sheets, 4 g only vortices; the cone needs Mach 0.93-1.01 below a few km; contrails need the air
colder than -34..-42 C. Amounts are smoothed over ~0.15 s (contrail 1 s): vapour builds and fades.

Quality (`FX_QUALITY`): low = tip vortices, cone (one shell) and contrail, burner 16 steps;
medium = + chine vortices, one sheet layer, two cone shells, 24 steps; high = two sheet layers,
three cone shells, 32 steps (the wingmen's burners take the same steps; the effects are drawn for
the player's jet only). Everything is hidden (no draw calls) when not needed. Switches: `?acfx=0`
(all off), `?vapour=0`, `?tyresmoke=0`, `?landingpool=0`; `setEnabled(on)` at run time.

Day and night: every switch between the two (the burner's day look, the glare round the lights,
the pool's gain, the throat's heat glow) reads `fxEnv` (fxshared.js), which `AircraftFX` updates
every frame and on `setTime` from `env.sunElevationDeg` or `env.sunDirection`: the same sun
elevation whatever exposure meter the Environment uses. The exposure is only used for brightness
(`fxExposure.get`), normalised to the meter's noon value `fxEnv.noonExposure` (0.93 for main's
meter and the HDR chain's).

Shader warm-up: three.js builds a program the first time a material is drawn (tens of ms on
ANGLE / D3D11 for the plume's ray march). `AircraftFX` draws every effect material once in the
first frame, the player's and, as soon as they load, the wingmen's (`visual.effectMeshes()`, the
effects' `effectMeshes()`), through stand-ins with an empty geometry in the real frame: three builds
the very variant the real draw uses (fog, tone mapping, colour space of the canvas or the HDR
chain's target) and draws nothing; `renderer.compile()` would only build the canvas variant.

Hooks for other modules: `fxExposure.get(renderer)` (fxshared.js) is where the lights, the burner
and the effects read the scene's exposure (default `renderer.toneMappingExposure`); an HDR post
chain that keeps its exposure elsewhere replaces `fxExposure.get` and, if its noon value differs,
sets `fxEnv.noonExposure`; `fxEnv.bloom = true / false` overrides the bloom detection (a float
render target). `visual.lights.landing.beams` are the lamp's beams for a terrain or roads shader
that wants to light itself (then `?landingpool=0`). All the effects take three's scene fog.

## Ambient occlusion

Exports with `rig.ao` (`tools/aircraft`, see its README) carry occlusion: the skin atlases in the
ORM texture's R channel (`occlusionTexture`; with `rig.ao.orm` the app also uses the ORM as `aoMap`
when the exporter did not write it), every other part per vertex in `COLOR_0`. Both darken the
ambient light only (sky and environment; the sun's shadows come from the shadow map): three.js's
`aoMap` for the atlases, a shader patch (`materials.js` `patchVertexAO`) for COLOR_0, which would
otherwise tint the albedo. The cockpit interior and the pilot take none of it (`COCKPIT_AO`:
`F35_cockpit*`, `F35_seat*`, `F35_canopy_bow`, `F35_glare_pad`, the switches, `P2_*`): the
cockpit computes its own occlusion of the tub (`pcd/interior.js`), and the export bakes them as
occluders only. The export bakes the weapon bays, the gun port and the refuelling receptacle open
(their shut doors left out of the bake): they are only seen open. The current `data/aircraft`
export predates all this and has neither (re-export on the PC, `tools/aircraft/README.md`).

## Rendering notes

* PBR materials (metallic-roughness; the exported clear coat and sheen are switched off, see
  `TUNE`): they need an environment map, `scene.environment` (a PMREM of the sky, as `Environment` builds it) or
  `visual.setEnvironment(texture, intensity)`; without one the coating looks flat and dark.
  Tone mapping (ACES or AgX) and `outputColorSpace = SRGBColorSpace` are assumed.
* Glass (canopy, EOTS window, helmet visor) does not use three.js transmission (that re-renders
  the whole opaque scene, terrain included, each frame): a multiply pass tints what is behind
  per surface crossing (the canopy's amber through both walls, as in Cycles) and an additive
  physical pass (thin-film iridescence for the canopy's gold coating) adds the reflections on the
  outer surface only.
* Draw order of the transparent parts: landing pool 1 (its additive draw 1.5), decals 1, glass
  tint 2 / reflection 3, plume and throat glow 4, light glows 5, trails, smoke and the cone's back
  6, sheets 7, the cone's front 8. Decals use polygon offset; all custom shaders support the
  logarithmic depth buffer and three's fog, and tone-map themselves (premultiplied alpha for the
  vapour and smoke).
* Per frame the effects allocate nothing: the ribbons keep their points in a ring and write the
  vertex arrays in place, `condensation()` and `air()` fill reused objects, the light glows and the
  beacon pattern reuse their arrays.
* Shadows: every mesh casts and receives (not the decals, glass, plume or sprites). The app's sun
  shadow camera should follow the jet. In the app the jet's own shadow map takes over (below,
  "Exterior"): the jet then casts nothing into the scene's map.
* Cost: about 320k triangles in ~200 draw calls (plus the shadow pass), 4096 px skin atlases
  (two base-colour, two normal maps; 2048 px roughness / metallic), about 0.4 GB of VRAM with mips.
  Frustum culling works per part (the plume's bounds follow its length; the glows are one draw).
  The effects add nothing while idle; in a hard turn up to 4 trail ribbons + 2 sheet draws, near
  Mach 1 two cone draws (one to three shells by quality, ~2-7k triangles), a touchdown one point
  draw (<= 160 points), the pool four draws of one grid (1,024 triangles) at night with the gear
  down: a few draw calls, under 10k triangles.
  Measured in the whole app (`aircraft_scenes.mjs --shots parked,chase`, the parked jet, a night
  take-off roll in burner, a 7 g turn, Mach 0.98 over the sea; against the commit before the fix
  round, low / medium / high): draw calls -1..+6, triangles +0..7k (the cone's shells), GPU memory
  the same within the terrain's streaming (-3..+5 MB; +10 MB in the first frame at low, where the
  warm-up now allocates what the effects used to allocate when they first showed), 43 shader
  programs after the first frame against 36 (every effect's built up front).

## Exterior: `skin.js`, `JetShadow.js`, `Exterior.js` (exterior track)

What the jet looks like from outside in the light: the coating, and the jet's own sun shadow on
itself and on the ground. `setupMaterials` patches every exterior material (not the cockpit, the
pilot, the glass, the lenses, the hoses); `Exterior.js` is a graphics module of `main.js` that
drives the shadow. `?exterior=0` leaves the materials as exported and the shadow as before;
`?jetshadow=0` keeps the coating and gives the shadow back to the scene's map.

**Coating** (`skin.js`, `SKIN` constants as uniforms; the skins `F35_Skin_A` / `_B`, the rest gets
the jet shadow only):

* a second, sharper specular lobe (`SKIN.lobe` 0.35 of the coat's specular at roughness
  `lobeRough` 0.3) over the atlases' broad one (~0.46): the satin coat's dim mirror of the sky at
  grazing angles and a soft hot spot towards the sun, in the direct light (`RE_Direct` wrapped) and
  in the environment (a second IBL lookup at the lobe's roughness). Both lobes are widened by the
  normal's variance across the pixel (`dFdx` / `dFdy` of the normal), so the normal maps' panel
  lines do not sparkle at 30-300 m;
* panel tones: `skinTones.js` (run in `skinWorker.js` from the ORM atlas's roughness channel, ~0.5 s
  off the main thread at load) flood-fills the regions the caulk / tape lines enclose and gives each
  a small hash-based shift of tone and sheen, one in eight clearly different (a re-coated door);
  big regions (the open skin between taped doors) are damped by area so they read as one sheet.
  An RG8 texture at half the atlas's resolution (1024 px, 2.7 MB with mips per skin). Plus a
  body-space mottle (two octaves of value noise, 0.4-1.2 m, `SKIN.mottle`);
* caulk / tape lines (ORM roughness ~0.72 against the coat's ~0.46) a little lighter
  (`SKIN.tape`) and duller, with a faint grime halo beside them (a blurred lookup of the same
  channel); dead flat, darker leading edges (RAM: the surfaces facing forward, `SKIN.ram`); gun
  gas soot aft of the port (`GUN`, `SKIN.soot`) and a slightly dirtier underside (`SKIN.grime`);
* metallic flakes: 2.5 mm cells in body space, each with its own normal, sparkling in the sun's
  glint (`SKIN.glitter`) only where a cell covers more than a pixel (the cockpit's view of the nose
  and wings, a close walk-around); further away they average into the lobes.

Canopy (`materials.js` `GLASS_F0`, `GLASS_REFLECT`): seen from outside, its coated outer surface
reflects 3.2x bare glass (F0 0.045 -> 0.14, in the tint pass's loss and the reflection pass), in a
warm colour (the gold film reflects the red end more): a bronze mirror of the sky over the amber
glass, the pilot and the helmet still seen through it, as in photos of taxiing jets. The view from
the cockpit keeps the bare glass's loss (the reflection pass draws only the shell's outer faces).

**The jet's own shadow** (`JetShadow.js`). The scene has one shadow map (`Environment.js`) with a
0.8 m depth bias: on the jet it erased every shadow shorter than that along the light (the canopy
on the spine, the doors, the gear, every junction); on the runway the shadow was a 10-25 cm blur
that started 0.8 m behind the tyres. Here:

* a depth map of the jet alone in its body frame (an ortho camera on the light's side of the jet's
  box), redrawn only when the light turns in that frame (`turn`), a part moves (the rig's
  signature: surfaces, gear, doors, struts, canopy, nozzle) or every 2 s; every exterior material
  samples it with a bias of ~1 texel, a normal offset and 4 rotated hardware-PCF taps, in place of
  the scene's map for the directional light (the sun or the moon);
* an underside map (coverage and height of the jet above its ground plane, from below, mipmapped),
  redrawn when a part moves (at most twice a second): the sky's occlusion under the jet;
* a ground pass: a grid draped on the terrain under the jet and along its shadow (up to 250 m;
  heights from `terrain.heightAt`), drawn after the opaque scene (multiply blend, a log-depth pull
  over the runway's), factor per channel `sky * (1 - ao) + sun * visibility` with the sun's share of
  the open ground's light taken from the environment's own terms (the light's colour at its
  elevation, the sky's irradiance), the occluded sky turned a little towards neutral (horizon band,
  bounce off the underside); the penumbra grows with the distance along the ray (the sun's disc,
  0.53 deg) and long low-sun shadows fade as it eats them; shown below 60 m above the ground (the
  occlusion below 14 m);
* `Exterior.js` keeps the jet's meshes out of the scene's map while the jet's own shadow is on (one
  shadow, not a blurred second one 0.8 m behind); everything goes back when it is off.

All lookups go through matrices made per camera in doubles (`viewHook`): no world coordinates on
the GPU. No program variants by state (everything is a uniform); a reversed depth buffer
(`?depth=reversed`) turns the jet's map off (the scene's as before).

| quality | jet map | ground taps | underside map | grid | redraw |
| --- | --- | --- | --- | --- | --- |
| low | off (the scene's map, as before) | - | - | - | - |
| medium | 1024 (~17 mm texels); 5.4 MB with the underside map | 4 | 128 | 16x16 | turn > 0.1 deg, at most 20 / s |
| high | 2048 (~8 mm); 21.6 MB | 8 | 256 | 24x24 | turn > 0.05 deg, every frame |

The coating is on at every quality. Cost: a redraw of the jet's map is the jet's 188 opaque meshes
depth-only (0.32 M triangles); the scene's shadow pass loses the same 188 draws every frame, so a
frame without a redraw has 188 draws fewer than before and one with a redraw the same count; the
underside map is another 188 draws when a part moves; the ground pass is one draw of 1,152
triangles (512 on medium). Shader cost in the jet's materials: 4 shadow taps, the second lobe
(direct and IBL), the flake cell and the tone lookup (measured: 10 of the 16 samplers a fragment
shader may have on ANGLE / D3D11 in the skins' program, the jet map and the tone texture included).

Measured (SwiftShader 960x540, `&vegetation=0&buildings=0`, a frame's `renderInfo` and the
`gpuMemory` estimate, against `?exterior=0` at the same quality; the redraws happen before the
frame's counters start, so they are not in these counts):

| view, quality | draws | triangles | GPU estimate |
| --- | --- | --- | --- |
| menu orbit 26 m over Tel Aviv, low | 446 (446) | 1.10 M (1.10) | 694.8 MB (694.8) |
| same, medium | 261 (449) | 0.83 M (1.12) | 759.3 MB (743.1) |
| same, high | 263 (451) | 0.83 M (1.12) | 913.0 MB (848.4) |
| ramp at noon, front 3/4, medium | 271 (458) | 0.85 M (1.14) | 789.2 MB (779.1) |
| same, high | 276 (463) | 0.86 M (1.15) | 944.1 MB (879.5) |

The estimate (`test/stats.js`) counts a depth texture at 16 B a texel: +64 MB on high and +16 MB
on medium for a real 21.6 MB and 5.4 MB; the two tone textures (5.6 MB) are not in it.

The ground pass was checked against the light it stands for (a frame at noon on the ramp with the
pass, without the sky's occlusion, and hidden, read back through the output transform): beside the
jet it leaves exactly the sky's share of the light, (0.113, 0.148, 0.229) of the sunlit ground for
a computed (0.113, 0.147, 0.228); under the fuselage about half of that. The scene's own map had
left 0.24-0.43 there: the sun leaking through its 0.8 m bias.

Tests: `node sim/tests/exterior_shots.mjs --port 8700 [--only park1230,rwy1648] [--shots gear,chase]
[--url "&exterior=0"]` (the views the track is judged in: the chase on the Tel Nof runway at 16:48
in burner, the lift-off from the side, the menu's 26 m orbit over Tel Aviv at noon, the Jerusalem
sunset, the Dead Sea at 09:00, close-ups on the ramp at noon, the wings and tails from the cockpit,
low-sun glints; the module's stats per shot in report.json). The e2e checks that the jet's map and
ground pass are on with the jet out of the scene's map, and that both skins' panel tones were built.

Export-side items (Blender, `scripts/f35/panels.py`, not done here): `layout()` draws the wings'
LEF / flaperon / trailing-edge panel outlines, the stabilators' spar lines and the fins' rudder
outline with `pt.line(...)` without `tape=True`, so the wing and tail atlas (`F35_Skin_B`) has
almost no caulk / tape lines in its ORM roughness channel (5 regions) and wings and tails get no
panel patchwork; `Painter.line()` strokes every tape at one G value (0.55, about 0.72 in the
atlas), the sawtooth (`saw=`) door and bay edges included, so they cannot be told apart and
darkened. The fix: `tape=True` on those lines (and outlines for the wings' access panels), a
distinct G value for sawtooth tape, a re-export (`sim/tools/aircraft/bake.py`); `skinTones.js`
then floods the new regions on its own, and `skin.js` would darken the sawtooth value with one
more `smoothstep`.

## Files

| file | |
| --- | --- |
| `AircraftVisual.js` | the class (sim/DESIGN.md interface) |
| `rig.js` | `RigPlayer`: plays f35i_rig.json on the glTF nodes |
| `materials.js` | glass, decals, texture filtering, shadow flags, calibration (`TUNE`, `NOZZLE`), occlusion |
| `lights.js` | `AircraftLights`: lenses, glows, beacon pattern, landing beam |
| `Afterburner.js` | plume and nozzle glow |
| `AircraftFX.js` | the effects module (quality, switches) |
| `Vapor.js`, `TyreSmoke.js`, `LandingPool.js`, `fxshared.js` | the effects (above) |
| `skin.js`, `skinTones.js`, `skinWorker.js` | the coating and the jet-shadow receiver (Exterior) |
| `JetShadow.js`, `Exterior.js` | the jet's own shadow map, underside map, ground pass; the module |

Test page: `sim/dev/aircraft.html` (orbit camera, sliders for every control, lights, day / night,
view presets; `?view=rear34&ab=1&night=1` etc.). Tests: `node --import ./sim/tests/node-three.mjs
sim/tests/aircraft.test.mjs` (rig playback) and `node sim/tests/aircraft_shots.mjs [outdir]`
(Playwright screenshots, fails on console errors); `node --import ./sim/tests/node-three.mjs
sim/tests/aircraft_fx.test.mjs` (beacon pattern, the light level, burner exposure and day look,
the petals' lag, the condensation model, the contrail's ring buffer, the pool's gain and roll-off);
`node sim/tests/aircraft_scenes.mjs --port 8150 [--only park_,ab_] [--shots chase,side]` (the
jet in the whole app: parked at noon / 07:00 / sunset / night, take-off roll in burner by day,
dusk and night, a 7 g turn at 300 m, Mach 0.98 at 100 m over the sea, a contrail at 10 km and its
end after two minutes, a night approach to Tel Nof down to the flare, nav lights from 600 m at
night, a dusk landing at Ben Gurion, gear up from below; orbit, chase, flyby and tower views;
renderInfo and GPU memory per shot in report.json). Some shots measure the frame and fail the run
(exit code 1) when the look is wrong: the burner's core seen from behind (warm, not white), the
pool at dusk (faint) and at night (lit, not clipped, not blue) and on the approach (the ground
ahead lit), each measured on the same pixels drawn with the pool and without it (the runway's paint
does not count as pool), a distant nav light's core (its own colour), the contrail's end (faded
out), every effect's shader program built before the effect first shows.
