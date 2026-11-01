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
  (`flameExposureComp`): no white ball at dusk or night. Throat glow: a dull red at idle, orange at
  MIL (both only seen in the dark), orange-yellow in burner. Nozzle petals: open at idle (the
  F135's idle nozzle), closed at MIL, opening again with the burner (`nozzleIdleOpen`).
* `lights.js`: photometric exterior lights (scene radiance 1 = ~30,000 cd/m^2). Lens emission on
  the glTF light materials; one `THREE.Points` draw for the glows of all lights: a core (the light
  reaching the camera, I / d^2, while the lens is smaller than a few pixels) and a halo (glare)
  only once it is dark (exposure > ~3), so by day a lit lens is a small dot, not an LED glow.
  Nav lights (red left, green right; white tail light, glow only) seen only within their sectors;
  the anti-collision beacons (spine, belly) flash 90 ms a second each, alternating; formation
  strips a soft green at night; the landing light (400,000 cd, 9 deg 1/e beam, 5 deg below the
  body axis) brightens its lens when the camera is in the beam and publishes the beam on
  `visual.lights.landing` `{on, position, direction, intensity, spread}` (world) for the ground pool.
  At night the glows get a visibility gain (`AircraftLights.nightGain`): the sim's exposure stops
  at 40, far below a dark-adapted eye. With an HDR bloom pass lower `visual.lights.haloGain`.
* `materials.js`: calibration of Blender's Cycles materials for three.js (`TUNE`): the skin
  without the clear coat and sheen (they read as chrome plastic in three.js's BRDF) and a little
  rougher, rubber tyres, light grey wheel wells and bay interiors, painted gear legs; the nozzle
  gets its own material (`NOZZLE`): heat staining towards the exit (bronze / taupe) and soot on
  the inner petals. Ambient occlusion from the export (below) applied to the ambient light only.
* With the camera within 0.3 m of the eye (`headHideDistance`) the pilot's head (helmet, visor,
  mask) is hidden and the canopy's tint is softened for the view from inside.

## Effects: `AircraftFX.js` (graphics module)

Registered in `main.js` `_addGraphicsModules()` with `this.addModule(new AircraftFX(ctx))`. It reads
the player's FlightModel state and the AircraftVisual, never changes them, and draws:

| file | what |
| --- | --- |
| `Vapor.js` | wing-tip vortex trails (thin white lines, high lift in humid air), chine vortex tubes over the wing roots at high alpha, vapour sheets over the upper wings at high g low down (streaky, drifting aft, two layers), the transonic vapour cone (a misty shell around the aft fuselage at Mach 0.93-1.01 in humid air: streaks over a soft base, a dense collar at the shock, fading at its outline), the contrail above ~8-9 km (a gap of clear exhaust first, spreading and fading over 25 s) |
| `TyreSmoke.js` | puffs of rubber smoke from each wheel at touchdown (ground speed > 25 m/s), denser the faster and harder: one GPU-animated point cloud (rise, growth, drift, fade over ~3 s) |
| `LandingPool.js` | the landing light on the ground: a terrain-following grid ahead of the lamp, lit per fragment `E = I(theta) cos(i) / r^2` (9 deg 1/e half width), added to the ground (the terrain's shaders ignore three.js lights) with its own visibility gain `poolGain` = (exposure / 6)^2 (~44 at night, ~4 at sunset, 1 by day: gentler than the glows', a lit surface is no point source) and a soft highlight roll-off (a graded pool, not a flat white wedge); invisible by day, faint at sunset |
| `fxshared.js` | the air model (temperature, humidity, dew point), `condensation(state)`, a tileable noise texture, the vapour lighting (sun with forward scattering + sky, from the Environment), camera-facing trail ribbons, `fxExposure` |

Condensation (`fxshared.condensation`): the local cooling `V^2 / (2 cp)` x a factor x CL (CL from
`n W / (q S)`) against the dew-point depression of a warm humid Levant day (ISA + 8 K near the
ground, 65 % humidity at sea level falling to ~10 % aloft). A 7 g turn at 300 m gives vortices and
sheets, 4 g only vortices; the cone needs Mach 0.93-1.01 below a few km; contrails need the air
colder than -34..-42 C. Amounts are smoothed over ~0.15 s (contrail 1 s): vapour builds and fades.

Quality (`FX_QUALITY`): low = tip vortices, cone and contrail, burner 16 steps; medium = + chine
vortices and one sheet layer, 24 steps; high = two sheet layers, 32 steps (the wingmen's burners
take the same steps; the effects are drawn for the player's jet only). Everything is hidden (no
draw calls) when not needed. Switches: `?acfx=0` (all off), `?vapour=0`, `?tyresmoke=0`,
`?landingpool=0`; `setEnabled(on)` at run time.

Hooks for other modules: `fxExposure.get(renderer)` (fxshared.js) is where the lights, the burner
and the effects read the scene's exposure (default `renderer.toneMappingExposure`); an HDR post
chain that keeps its exposure elsewhere replaces `fxExposure.get`. `visual.lights.landing` is the
beam for a terrain shader that wants to light itself (then `?landingpool=0`).

## Ambient occlusion

Exports with `rig.ao` (`tools/aircraft`, see its README) carry occlusion: the skin atlases in the
ORM texture's R channel (`occlusionTexture`; with `rig.ao.orm` the app also uses the ORM as `aoMap`
when the exporter did not write it), every other part per vertex in `COLOR_0`. Both darken the
ambient light only (sky and environment; the sun's shadows come from the shadow map): three.js's
`aoMap` for the atlases, a shader patch (`materials.js` `patchVertexAO`) for COLOR_0, which would
otherwise tint the albedo. The current `data/aircraft` export predates this and has neither.

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
* Draw order of the transparent parts: landing pool 1, decals 1, glass tint 2 / reflection 3,
  plume and throat glow 4, light glows 5, trails, smoke and the cone's back 6, sheets 7, the cone's
  front 8. Decals use polygon offset; all custom shaders support the logarithmic depth buffer and
  tone-map themselves (premultiplied alpha for the vapour and smoke).
* Shadows: every mesh casts and receives (not the decals, glass, plume or sprites). The app's sun
  shadow camera should follow the jet.
* Cost: about 320k triangles in ~200 draw calls (plus the shadow pass), 4096 px skin atlases
  (two base-colour, two normal maps; 2048 px roughness / metallic), about 0.4 GB of VRAM with mips.
  Frustum culling works per part (the plume's bounds follow its length; the glows are one draw).
  The effects add nothing while idle; in a hard turn up to 4 trail ribbons + 2 sheet draws, near
  Mach 1 two cone draws (~2k triangles), a touchdown one point draw (<= 160 points), the pool one
  draw (1,024 triangles) at night with the gear down: a few draw calls, under 10k triangles.
  Measured in the whole app (`aircraft_scenes.mjs`, high, 41 shots against the commit before this
  work): draw calls and triangles the same within the terrain's streaming noise (-12..+10 calls,
  +0..4k triangles), GPU memory the same (~750-780 MB), fewer shader programs after all scenes (59
  against 74).

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

Test page: `sim/dev/aircraft.html` (orbit camera, sliders for every control, lights, day / night,
view presets; `?view=rear34&ab=1&night=1` etc.). Tests: `node --import ./sim/tests/node-three.mjs
sim/tests/aircraft.test.mjs` (rig playback) and `node sim/tests/aircraft_shots.mjs [outdir]`
(Playwright screenshots, fails on console errors); `node --import ./sim/tests/node-three.mjs
sim/tests/aircraft_fx.test.mjs` (beacon pattern, burner exposure, the condensation model, the
pool's gain);
`node sim/tests/aircraft_scenes.mjs --port 8150 [--only park_,ab_] [--shots chase,side]` (the
jet in the whole app: parked at noon / 07:00 / sunset / night, take-off roll in burner by day,
dusk and night, a 7 g turn at 300 m, Mach 0.98 at 100 m over the sea, a contrail at 10 km, a dusk
landing at Ben Gurion, gear up from below; orbit, chase, flyby and tower views; renderInfo and
GPU memory per shot in report.json).
