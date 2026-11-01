# js/aircraft: the F-35I in three.js

`AircraftVisual` loads `data/aircraft/f35i.glb` and `f35i_rig.json` (built by
`tools/aircraft/export_glb.py`) and animates them: every control surface, door, the gear sequence,
wheels, struts, canopy, stick, throttle and pedals, the pilot's head, the nozzle petals, the
afterburner plume and the exterior lights.

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
* `Afterburner.js`: a ray-marched additive plume in a bounding cylinder behind the nozzle exit
  (32 steps per pixel, only drawn while `ab > 0`): orange envelope turning pink, a flame front at
  the exit, six shock diamonds, turbulent flicker; length 2-5.4 m and brightness scale with `ab`.
  A glow disc in the nozzle throat: dull red at idle, orange at MIL, yellow-white in burner.
* `lights.js`: lens emission on the glTF light materials, small additive glow sprites (kept a few
  pixels big at any distance, nav lights visible only from their side), the anti-collision beacons
  flashing 80 ms each second, formation strips dimmable, and a `THREE.SpotLight` (60 000 cd, 13 deg)
  on the nose leg while `lights.landing` and gear > 0.9.
* With the camera within 0.3 m of the eye (`headHideDistance`) the pilot's head (helmet, visor,
  mask) is hidden and the canopy's tint is softened for the view from inside.

## Rendering notes

* PBR materials (metallic-roughness, clear coat and sheen on the skin): they need an environment
  map, `scene.environment` (a PMREM of the sky, as `Environment` builds it) or
  `visual.setEnvironment(texture, intensity)`; without one the coating looks flat and dark.
  Tone mapping (ACES or AgX) and `outputColorSpace = SRGBColorSpace` are assumed.
* Glass (canopy, EOTS window, helmet visor) does not use three.js transmission (that re-renders
  the whole opaque scene, terrain included, each frame): a multiply pass tints what is behind
  per surface crossing (the canopy's amber through both walls, as in Cycles) and an additive
  physical pass (thin-film iridescence for the canopy's gold coating) adds the reflections on the
  outer surface only.
* Draw order of the transparent parts: decals 1, glass tint 2 / reflection 3, plume and throat
  glow 4, light sprites 5. Decals use polygon offset; all custom shaders support the logarithmic
  depth buffer.
* Shadows: every mesh casts and receives (not the decals, glass, plume or sprites). The app's sun
  shadow camera should follow the jet.
* Cost: about 320k triangles in ~200 draw calls (plus the shadow pass), 4096 px skin atlases
  (two base-colour, two normal maps; 2048 px roughness / metallic), about 0.4 GB of VRAM with mips.
  Frustum culling works per part (the plume's bounds follow its length; the 15 glow sprites are
  not culled).

## Files

| file | |
| --- | --- |
| `AircraftVisual.js` | the class (sim/DESIGN.md interface) |
| `rig.js` | `RigPlayer`: plays f35i_rig.json on the glTF nodes |
| `materials.js` | glass, decals, texture filtering, shadow flags |
| `lights.js` | `AircraftLights`: lenses, glow sprites, beacon strobe, landing light |
| `Afterburner.js` | plume and nozzle glow |

Test page: `sim/dev/aircraft.html` (orbit camera, sliders for every control, lights, day / night,
view presets; `?view=rear34&ab=1&night=1` etc.). Tests: `node --import ./sim/tests/node-three.mjs
sim/tests/aircraft.test.mjs` (rig playback) and `node sim/tests/aircraft_shots.mjs [outdir]`
(Playwright screenshots, fails on console errors).
