# F-35I Adir: flight over central Israel

Fly the Israeli Air Force F-35I "Adir" yourself, in the browser, over a 102 x 102 km piece of
central Israel built from real elevation data and satellite imagery: the coast from Ashdod to
Tel Aviv, Ben Gurion, Tel Nof, Hatzor and Palmachim, Jerusalem and the hills, down to the Dead
Sea. The jet is the procedural Blender model of this repository, with every control surface,
the gear, canopy and lights moving, a six-degree-of-freedom flight model with an F-35-like
fly-by-wire system, a helmet display and a procedural engine sound. Keyboard, mouse, gamepad
and joystick (HOTAS) all work.

Made for Windows 11 with a recent GPU (developed for an RTX 3070) and Chrome or Edge.

## Fly

**Windows:** double-click `sim\Fly_F-35I.bat`. It finds Python (the `py` launcher, `python` on
the PATH, or the Python inside Blender), starts the local server and opens the sim in your
browser. Keep the black window open while you fly; close it to stop.

**Any system with Python 3:**

```
python sim/serve.py --open          # http://127.0.0.1:8035/
```

`serve.py` options: `--port N` (default 8035; the next free port is used if it is taken),
`--open` (open the browser), `--page P` (the page `--open` opens), `--verbose` (log every request).
It serves the `sim` folder on 127.0.0.1 only, whatever the current directory, with the right
MIME types and no caching of the code. Any other static web server works too; opening
`index.html` as a file does not (browsers block ES modules from `file://`).

**The data.** `sim/data/` is generated and not in git: `data/terrain/` comes from
`sim/tools/terrain` (Copernicus DEM, ESA WorldCover imagery, OurAirports; see its README) and
`data/aircraft/` from `sim/tools/aircraft` (the Blender model exported to glTF; see its README).
Without it the loading screen says what is missing; `index.html?stubs=1` runs the app with
stand-ins (a flat field with one runway, a box-and-wings jet and simple kinematics) to try the
controls.

**Benchmark.** `index.html?bench=1` (e.g. http://127.0.0.1:8035/index.html?bench=1&quality=high)
flies a scripted 60 s take-off from Tel Nof 36 at noon: MIL, then afterburner, rotation at
150 kt, gear up, climb and a turn toward Tel Aviv, with the view going chase, cockpit, fly-by,
chase. At the end the sim stops and the results stay on screen (and in `window.__bench`, and as
`BENCH {...}` in the console): average fps, 1 % low fps (the mean frame rate of the slowest 1 %
of frames), minimum fps, frame-time percentiles, draw calls and triangles per frame, and an
estimate of the GPU memory the app uploaded (textures, geometry, render targets, the canvas).
The first 3 s (shader compiles, first terrain tiles) are not counted. Options: `&quality=`,
`&time=`, `&spawn=` (an airborne start point flies straight on), `&seconds=`. For a headless
screenshot of the result on a machine with a real GPU, wait in Playwright (headless Chrome with
`--enable-gpu`, or headed) until `document.title` is `F-35I bench: done`, then take the
screenshot; or open the page in a normal browser window and leave it for a minute.

## The start menu

* **Start**: on the runway at Tel Nof (36 or 33R, parking brake set, engine at idle), on a 10 km
  final to Tel Nof, over Tel Aviv at 3,000 m, over the Jerusalem hills at sunset, on runway 26 at
  Ben Gurion, low over the Dead Sea, or along the coast at 300 m.
* **Time of day**: 07:00, 12:30 or 19:00 (sunset), 21 June, local solar time (Israeli summer
  clock time is about 40 minutes later). `[` and `]` change it in flight.
* **Graphics**: Low (75 % resolution, small shadow map), Medium, High (full resolution up to 2x
  for high-DPI screens, 4096 px shadows). High is meant for an RTX 3070 at 1440p.
* **Options**: two AI wingmen in fingertip formation, the mouse stick, the volume.
* **Joystick & gamepad**: bind any axis or button of any controller (saved in the browser),
  deadzone and expo, invert the keyboard pitch.

## Controls

The same list is in the sim (F1 or the Controls help button).

**Flying (keyboard)**

| | |
| --- | --- |
| `↓` / `↑` | pull (nose up) / push (nose down) |
| `←` / `→` | roll left / right |
| `Z` / `X` | rudder and nose-wheel steering left / right |
| `Shift` / `Ctrl` or `+` / `-` | throttle up / down; it stops at MIL: hold on or press again for afterburner |
| `Page Up` / `Page Down` | full afterburner / idle |
| `B` (hold) | wheel brakes |
| `Shift`+`B` | parking brake on / off (set at the start) |
| `G` | landing gear up / down |
| `S` | speed brake |
| `C` | canopy (on the ground, below 30 kt) |
| `L` / `Shift`+`L` | exterior lights / landing light |

**View**

| | |
| --- | --- |
| `V` / `Shift`+`V` | next / previous camera |
| `1` `2` `3` `4` `5` | cockpit, chase, orbit, fly-by, tower |
| mouse drag, numpad `8` `4` `6` `2`, hat | look around (cockpit), turn the camera (outside) |
| `Home`, numpad `5`, middle click | look ahead again |
| mouse wheel | zoom (cockpit, fly-by, tower) or camera distance |
| `H` | helmet display on / off |
| `F` | full screen |

**Simulation**

| | |
| --- | --- |
| `P` or `Esc` | pause and menu |
| `R` | restart at the start point |
| `[` / `]` | time of day 15 minutes earlier / later |
| `M` | sound on / off |
| `F1` or `?` | help |

**Gamepad (Xbox / PlayStation layout)**

| | |
| --- | --- |
| left stick | pitch and roll |
| right stick left / right | rudder and nose wheel |
| right stick up / down, `RT` / `LT` | throttle up / down (MIL detent as on the keyboard) |
| `A` (hold) | wheel brakes |
| `Y` / `X` / `B` | gear / canopy / speed brake |
| `LB` / `RB` | previous / next camera |
| d-pad, `R3` | look around, look ahead |
| `L3` | parking brake |
| `View` / `Menu` | helmet display / pause (in menus: A select, B back, Y restart) |

**Mouse stick (option in the menu)**

| | |
| --- | --- |
| click the view | capture the mouse; it now moves the stick (the ring at the bottom) |
| move the mouse | down = pull, up = push, sideways = roll |
| right drag | look around |
| `Esc` | release the mouse (and pause) |

**Joysticks and HOTAS**: open *Joystick & gamepad* in the menu, press *Bind* next to an action
and move the axis or press the button. Axes: pitch, roll, rudder, throttle (an absolute lever:
the MIL detent is at 75 % of its travel), brakes; buttons for everything above. A hat switch
looks around. Bindings are kept per controller in the browser's local storage.

**Flying the F-35I**

| | |
| --- | --- |
| take-off | MIL or afterburner, release the parking brake (`Shift`+`B`); at 150 kt pull back and hold the nose about 10 deg up (on the ground the stick sets the pitch attitude), lift-off at about 160 kt; gear up (`G`) once climbing |
| fly-by-wire | the stick commands g (pitch rate when slow) and roll rate; let go and the jet holds its flight path and bank; the FCS limits AoA to 25 deg and g to +9 / -3 |
| landing | gear down, about 140 kt and 13 deg AoA on a 3 deg path; brakes (`B`) after touchdown |
| crash | the cause is shown (hard landing, gear up, water, terrain, over-g ...); `R` starts again |

## Cameras

* **Cockpit**: the pilot's eye from the model (station 3.36 m, the rig's `eye`), a 60 deg
  vertical field of view (94 deg across on a 16:9 screen) looking 8.5 deg down (the design eye
  line, 6 deg, plus 2.5 deg): the canopy bow runs along the top of the picture, the clear view
  ahead is over the glare shield and the panoramic display is below. Look around with the mouse
  (drag), the numpad or a hat; the head is pushed down a little under g and back under
  acceleration; the view greys out above about 7 g.
* **Chase**: behind and above, on a spring, drawing back with speed; drag to look at the jet
  from another side (it swings back), wheel for the distance.
* **Orbit**: free orbit around the jet (drag, wheel); also the backdrop of the menu.
* **Fly-by**: a camera placed ahead of the jet beside its path; it lets the jet pass and moves
  on.
* **Tower**: the nearest airfield's tower, a long lens following the jet.

## Helmet display

Green symbology as in the F-35's helmet, drawn crisp at the screen's resolution. In the
cockpit: airspeed (KIAS) in the box on the left, altitude (ft) on the right with the radar
altitude below 5,000 ft and the vertical speed, a heading tape on top, the flight-path marker
(where the jet is going), the waterline (where the nose points), a pitch ladder every 5 deg
around the flight path, Mach, g (and the peak g), AoA, thrust (MIL and burner), fuel, gear,
parking brake, brakes and speed brake, and the warnings of the flight model (PULL UP, OVER G,
AOA LIMIT, GEAR, OVERSPEED, ENGINE, BINGO FUEL, PARKING BRAKE). In the outside views a one-line
strip at the bottom shows the same numbers.

## Sound

All synthesised with WebAudio, no sound files: the F135's low rumble, roar and turbine whine
following the engine speed, the afterburner's roar and crackle, wind with airspeed, the gear
thumps, warning tones, Doppler and distance outside, muffled behind the canopy in the cockpit.
Browsers start sound only after a click or key press: it begins with *Fly*.

## URL parameters

| | |
| --- | --- |
| `spawn=telnof_36` | preselect a start point (names from `data/terrain/spawns.json`) |
| `autostart=1` | fly at once, without the menu |
| `time=7` | time of day, solar hours |
| `quality=low` / `medium` / `high` | graphics |
| `cam=cockpit` / `chase` / `orbit` / `flyby` / `tower` | first camera |
| `wingmen=0` / `1` | wingmen off / on |
| `stubs=1` | stand-in modules from `dev/stubs` (no data needed) |
| `depth=reversed` | reversed depth buffer instead of the logarithmic one (where `EXT_clip_control` exists) |
| `test=1` | the automation API `window.__sim` (see Tests); the render loop starts paused |
| `bench=1` | the 60 s benchmark flight (see Fly); `seconds=N` for another length |

## Files (the app shell)

| file | |
| --- | --- |
| `index.html`, `css/sim.css`, `css/splash.jpg` | page, import map, loading screen, menus |
| `js/main.js` | the app: renderer, loading, fixed-step loop, glue between the modules |
| `js/input/Input.js`, `Bindings.js` | keyboard, mouse, mouse stick, gamepads, joystick bindings |
| `js/ui/Cameras.js` | the five camera modes |
| `js/ui/HMD.js` | helmet display (a 2D canvas over the 3D view) |
| `js/ui/Menu.js`, `Help.js`, `BindingsUI.js` | menus, help, the bindings screen |
| `js/ui/Effects.js` | crash fireball and smoke |
| `js/audio/EngineSound.js` | procedural engine and cockpit sounds |
| `js/ai/Wingmen.js` | the two AI wingmen |
| `dev/stubs/` | stand-ins for Environment, Terrain, AircraftVisual and FlightModel (`?stubs=1`) |
| `serve.py`, `Fly_F-35I.bat` | local server and the Windows launcher |
| `js/test/TestApi.js` | the automation API `window.__sim` (`?test=1`) |
| `js/test/TestPilot.js` | scripted pilot (take-off and climb, approach and landing) for the tests and the benchmark |
| `js/test/Bench.js`, `stats.js` | the `?bench=1` benchmark; frame statistics, GPU memory estimate |
| `tests/smoke.mjs`, `tests/e2e.mjs` | Playwright smoke test, end-to-end test |

The other modules (sim/DESIGN.md): `js/env` (sky, sun, haze, lighting), `js/terrain` and
`js/world` (terrain rendering and queries), `js/aircraft` (the jet), `js/fdm` (flight model).

### How the shell runs

* The flight model steps at a fixed 120 Hz from an accumulator; the display runs at its own rate
  and draws the jet between the last two steps. A frame longer than 0.25 s (a hitch, a hidden
  tab) is clamped instead of being caught up. The sim pauses when the tab is hidden.
* Each frame: input, physics steps, the jet's pose and moving parts, cameras, `Environment.update`,
  `Terrain.update` (after the camera has moved), render, helmet display, sound.
* The aircraft's gear contact points go to the flight model (`configWithRig`): each rig contact's
  `posParked` (the round tyre's bottom with the oleo at its static compression) raised by the
  tyre's `tyreDeflection`. That is the stance the Blender scenes use (`groundStance`: 1.45 deg
  nose-up), the flight model's own default contacts and the pitch the FCS holds on the ground,
  so the jet stands exactly on its modelled stance: oleos at their parked compression, tyres
  pressed into the runway by their deflection (3 cm nose, 4.5 cm mains; the tyre meshes are
  round). The flight model's strut (oleo and tyre in one spring, static compression 7 / 9 cm)
  is drawn on the modelled oleo: up to the static point in proportion (the oleo's 5 cm share),
  beyond it one to one, so the struts are fully out in the air and compress with
  `state.wheels` on touchdown and over bumps.
* The Environment owns the renderer's tone mapping and exposure, the shadow maps, the fog and
  `scene.environment` (which the aircraft's materials need); `main.js` only creates the renderer
  (logarithmic depth, see below), the camera (far plane 650 km) and the scene.
* Wingmen: two more `AircraftVisual`s that share the player's textures (so they add little video
  memory). They are kinematic: each flies a target point (its slot 14 m out, 11 m back, 1.2 m low
  in the leader's frame, rolling with him) through a position / velocity / acceleration chase
  with the leader's own acceleration fed forward; the attitude follows from the motion and
  blends into the leader's in the slot. On a ground start they line up beside you for a
  formation take-off; from an airborne start they join from 450 m behind; when you land or crash
  they hold overhead and rejoin when you are airborne again.

## Tests

```
node sim/tests/e2e.mjs   [--port 8110] [--out DIR] [--size 960x540] [--quality low|medium|high] [--root SIM_FOLDER]
node sim/tests/smoke.mjs [--mode stubs|real|both] [--port 8103] [--out DIR] [--root SIM_FOLDER]
node --import ./sim/tests/node-three.mjs sim/tests/fdm.test.mjs        (flight model, no browser)
```

Both browser tests start `serve.py` on their port and open the app in headless Chromium
(SwiftShader WebGL2, Playwright) with `?test=1`. The render loop stays paused: the simulation
runs in fixed 1/120 s steps much faster than real time and a frame is drawn only for a check or
a screenshot (SwiftShader takes seconds per frame). Both fail on any console error, page error or
failed request.

**`tests/e2e.mjs`** (the real data and modules; a few minutes) checks, with the numbers in its
log and in `report.json`:

1. Tel Nof runway 36 at noon: every wheel on the runway with the tyre pressed in by its modelled
   deflection (no sinking or floating), the flight model's struts and the modelled oleos at
   their static compression, the stance pitch (1.45 deg plus the runway's slope), nose wheel on
   the centreline, nothing moving; the helmet display's numbers (IAS, altitude in feet, heading,
   g, vertical speed, Mach) against the flight model; the model's controls (surfaces, gear,
   canopy, burner) against the flight model; the five cameras (cockpit at the eye with the head
   hidden, chase behind, orbit, fly-by and tower looking at the jet).
2. Take-off with the scripted pilot: MIL, then afterburner, the centreline held by nose-wheel
   steering, rotation at 150 kt, gear up only after a positive climb, climb to 3,000 m and the
   turn toward Tel Aviv; the HMD, the model and the cameras checked again in flight.
3. `telnof_final`: the 3 deg glide slope and the localizer at 145 kt, flare, touchdown below
   3 m/s, brakes to a stop on the runway, then the canopy opens.
4. `jerusalem_sunset` at the spawn's time of day.

Screenshots (`/home/claude/simdata/shots/e2e/` by default): `01`/`02` on the runway (chase,
cockpit), `03` the take-off roll in afterburner, `04` the climb-out (chase), `05` the HMD in the
cockpit at 3,000 m, `06` a fly-by, `07` short final from the cockpit, `08` stopped after the
landing, `09`/`10` Jerusalem at sunset (chase, cockpit).

**`tests/smoke.mjs`** checks the shell with the stand-in modules (`?stubs=1`) and, when the data
is there, for real: menu, a manual take-off, the tower view, two airborne start points.

### Test API (`index.html?test=1`)

`window.__sim` (js/test/TestApi.js), for the tests and for the browser console. Units are SI
and radians unless a name says otherwise (`_kt`, `_deg`, `Ft`).

| | |
| --- | --- |
| `ready`, `error`, `state`, `live` | loaded / load error; the app's state (`menu`, `flying`, `paused`); the render loop running |
| `pause()`, `resume()` | stop / restart the app's own requestAnimationFrame loop (`?test=1` starts paused; `setLive(on)` does the same) |
| `start(spawn, {time, camera})` | fly from a start point (names: `spawns()`), hands off, inputs cleared; returns `summary()` |
| `camera(mode)` / `view(mode)`, `time(hours)` | the camera (`cockpit`, `chase`, `orbit`, `flyby`, `tower`); the time of day (solar hours) |
| `setInput({...})`, `clearInput()` | hold inputs until changed (merged; `setInput(null)` clears): `pitch`, `roll`, `yaw` (-1..1: nose up, right, right), `throttle` (0..1, 0.75 = MIL, above = afterburner), `brake` (0..1), `gear` (true = down), `parkingBrake`, `speedbrake`, `canopy` (true = open), `nws` |
| `autopilot(plan, opts)`, `pilot()` | the scripted pilot flies through the same inputs: `'takeoff'` (`vrKt` 150, `altitude` 3000, `target {x, z}` or `heading`, `cruiseKt`) or `'land'` (`approachKt` 145, `glideDeg` 3, `aimM` 300), on the spawn's runway or `runway` / `icao`; `autopilot(null)` stops it. `pilot()`: `{plan, phase, done, t, events, out}`; phases `roll`, `rotate`, `liftoff`, `gear up`, `climb`, `cruise` / `approach`, `flare`, `touchdown`, `rollout`, `stopped` |
| `step(n)` | n fixed steps of 1/120 s without drawing (cameras, terrain streaming and crash handling follow every 12 steps); returns `summary()` |
| `advance(seconds, draw = true)` | the same for a time, then draws one frame |
| `fly({until, seconds})` | runs until the scripted pilot reaches phase `until`, finishes, the jet crashes, or `seconds` pass: `{t, summary, pilot}` |
| `settle(ms)` | lets wall time pass without simulating (terrain tiles load, the exposure adapts), then draws one frame |
| `render()` | draws one frame now: `{ms, calls, triangles, points, lines, geometries, textures, programs}` (`ms` includes the GPU) |
| `summary()` | `{state, camera, ias_kt, alt_m, agl_m, vs, onGround, gear, throttle, pitch_deg, roll_deg, heading_deg, g, crashed, crashReason, rpm, ab, phase, time, wingmen, fps}` |
| `fdm()` | the whole FlightModel state (sim/DESIGN.md) as JSON: position, quaternion, velocity, alpha, ias, altitude, agl, gLoad, wheels, engine, controls, warnings, lastTouchdown ... |
| `visual()` | the AircraftVisual: rig control values (`rig`), what the app gave it (`given`), head visible, plume `{visible, ab, length}`, throat glow colour, eye point (body and world) |
| `gear()` | per wheel: `wow`, the flight model's `fdmCompression` / `fdmStatic`, the modelled `oleo` / `rigStatic` / `rigValue`, `travel`, `tyreDeflection`, the tyre's lowest point `tyreBottom`, the `ground` height and the `gap` (negative: pressed in), `steer_deg`, `along` / `cross` on the spawn's runway |
| `runway(id, icao)` | the jet against a runway end (default the spawn's): `along`, `cross` (m, + = right), `headingError_deg`, `onRunway`, threshold, length, width |
| `hmd()` | the numbers the helmet display drew last: `iasKt`, `altFt`, `hdg`, `g`, `mach`, `alphaDeg`, `vsFpm`, `aglFt`, `thr`, `ab`, `fuelLb`, `gear`, `warnings` ... |
| `renderInfo()`, `timing()`, `gpuMemory()` | renderer.info of the last drawn frame; step and frame times, fps, GPU name, canvas size; the GPU memory estimate (MB, the largest textures) |

Example (Playwright, after `waitForFunction(() => window.__sim?.ready)`):
`page.evaluate(() => { __sim.start('telnof_36', {time: 12}); __sim.autopilot('takeoff'); return __sim.fly({until: 'climb'}); })`,
then `page.evaluate(() => __sim.settle(2000))` and `page.screenshot()`.

## Notes and small deviations from DESIGN.md

* **Depth buffer**: logarithmic by default. The view spans the cockpit (0.04 m near plane) and
  a 400 km horizon; on the 24-bit depth buffer of a WebGL canvas reversed-Z gives no better
  precision than ordinary Z, the logarithmic buffer does. `?depth=reversed` uses
  `reversedDepthBuffer` where `EXT_clip_control` exists.
* **Shadows**: three r187 removed `PCFSoftShadowMap`; `PCFShadowMap` is used (the Environment
  owns the shadow settings). The sun's shadow follows the jet (`env.setShadowTarget`);
  while the wingmen stand beside it the shadow box covers all three.
* `HMD.draw(state, camera, viewMode, extra)`: the optional `extra` carries what is not in the
  flight model state (the drawn pose, throttle lever, brakes, parking brake, speed brake, the
  peak g, the mouse-stick position).
* `EngineSound.update(state, viewMode, dt, opts)`: optional `opts` (camera position for distance
  and Doppler, canopy, active); also `setVolume`, `setMuted`, `toggleMute`, `setPaused`.
* `Input.update(dt)` also returns `brake`, `speedbrake`, look axes, drag and wheel, and the edges
  `parkingBrakeToggle`, `speedbrakeToggle`, `lightsToggle`, `landingLightToggle`, `mute`,
  `timeEarlier`, `timeLater`, `camera` (1-5), `fullscreen`, `lookCenter`, `confirm`, `menuBack`;
  the levers (throttle with the MIL detent, gear handle, parking brake, canopy, speed brake)
  live in `input.levers`.
* A spawn's `time_h` / `day_of_year` (the Jerusalem sunset) set the time of day when it is
  chosen.
* `serve.py` listens on 127.0.0.1 only and moves to the next free port when 8035 is taken.
* Extra modules: `js/ai/Wingmen.js` (optional, off by default) and `js/ui/Effects.js`.

## Credits

* **Aircraft**: the procedural F-35I Adir Blender model of this repository (`scripts/f35`,
  `scripts/pilot`), exported for the browser by `sim/tools/aircraft`.
* **Terrain** (from `data/terrain/manifest.json`): Copernicus DEM GLO-30, produced using
  Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018
  provided under COPERNICUS by the European Union and ESA; all rights reserved. Imagery and land
  cover: © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021)
  processed by ESA WorldCover consortium (CC BY 4.0). Airports: OurAirports (public domain).
  The menu shows the attribution of the data set it loaded.
* **three.js** r187 (MIT licence), vendored in `vendor/three`.
* Everything else (sounds, helmet display, effects, the splash picture from this repository's
  renders) is made here.
