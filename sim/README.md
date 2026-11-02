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
of frames), minimum fps, frame-time percentiles, draw calls and triangles per frame, an
estimate of the GPU memory the app uploaded (textures, geometry, render targets including the HDR
chain's and the clouds', the canvas), and the GPU time of the scene, the clouds and the post
passes where the browser has timer queries (Chrome on Windows: `GPU time` line).
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
* **Options**: two AI wingmen in fingertip formation, the mouse stick, 3D buildings, the volume.
* **Weather**: clear, few cumulus (the default), scattered, broken, or high cirrus (lighting:
  `js/env/Clouds.js`). The clouds cast shadows on the ground and on the jet; fly into one and
  the view goes white.
* **Joystick & gamepad**: bind any axis or button of any controller (saved in the browser),
  deadzone and expo, invert the keyboard pitch, the mouse stick's roll spring.

## Controls

The same list is in the sim (F1 or the Controls help button).

**Flying (keyboard)**

| | |
| --- | --- |
| `↓` / `↑` | pull (nose up) / push (nose down): a tap is a small correction; held on, it is full stick after about 0.7 s |
| `←` / `→` | roll left / right |
| `Z` / `X` | rudder and nose-wheel steering left / right |
| `Shift` / `Ctrl` or `+` / `-` | throttle up / down; it stops at MIL: hold on or press again for afterburner |
| `Page Up` / `Page Down` | full afterburner / idle |
| `Y` | auto-throttle on / off: with the gear down in the air it flies the approach AoA (13 deg) with the throttle; any throttle input takes over (on at the 10 km final start) |
| `B` (hold) | wheel brakes (with `Ctrl` held too: throttle back and brakes) |
| `Shift`+`B` | parking brake on / off (set at the start); it locks the wheels: a take-off or landing on it bursts the tyres |
| `G` | landing gear up / down |
| `S` | speed brake |
| `A` | high-AoA mode on / off: the AoA limit is 50 deg instead of 25 (HI AOA on the helmet display) |
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
| `R` | restart at the start point (in flight: hold it for a second) |
| `[` / `]` | time of day 15 minutes earlier / later |
| `M` | sound on / off |
| `F1` or `?` | help |

**Gamepad (Xbox / PlayStation layout)**

| | |
| --- | --- |
| left stick | pitch and roll |
| right stick left / right | rudder and nose wheel |
| right stick up / down, `RT` / `LT` | throttle up / down (MIL detent as on the keyboard); the right stick works rudder or throttle, whichever it is pushed toward first, until it is back in the centre |
| `A` (hold) | wheel brakes |
| `Y` / `X` / `B` | gear / canopy / speed brake |
| `LB` / `RB` | previous / next camera |
| d-pad, `R3` | look around, look ahead |
| `L3` | parking brake on the ground, high-AoA mode in the air |
| `View` / `Menu` | helmet display / pause (in menus: A select, B back, Y restart) |

**Mouse stick (option in the menu)**

| | |
| --- | --- |
| click the view | capture the mouse; it now moves the stick (the ring at the bottom left) |
| move the mouse | down = pull, up = push, sideways = roll; near the centre (the small ring) the stick reads centred |
| let the mouse rest | roll springs back to the centre: roll in, stop, and the bank is held (the spring can be turned off under *Joystick & gamepad*) |
| middle click | centre the stick |
| right drag | look around |
| `Esc` | release the mouse (and pause) |

**Joysticks and HOTAS**: open *Joystick & gamepad* in the menu, press *Bind* next to an action
and move the axis or press the button. Axes: pitch, roll, rudder, throttle (an absolute lever:
the MIL detent is at 75 % of its travel), brakes; buttons for everything above. A hat switch
looks around. Bindings are kept per controller in the browser's local storage. A throttle lever
takes the throttle back only once it is moved through the throttle setting (after the
auto-throttle, the keys or a restart set it; until then the helmet display shows `LVR` and where
the lever is); pushed through MIL into afterburner it takes over at once (a go-around).

**Browser shortcuts**: `Ctrl` is also "throttle down", and the browser keeps some `Ctrl`
shortcuts for itself in a window (`Ctrl`+`W` / `T` / `N`, `Ctrl`+`Tab`, `Ctrl`+`Page Up` /
`Page Down`). In full screen (`F`) the sim takes them (Keyboard Lock); the auto-throttle is on `Y`
(it was `T`: `Ctrl`+`T` opened a tab).

**Flying the F-35I**

| | |
| --- | --- |
| take-off | MIL or afterburner, release the parking brake (`Shift`+`B`); at 150 kt pull back and hold the nose about 10 deg up (on the ground the stick sets the pitch attitude), lift-off at about 160 kt; gear up (`G`) once climbing, then centre the stick: the jet holds the climb (a pull held on keeps the nose coming up) |
| fly-by-wire | the stick commands g (pitch rate when slow) and roll rate; let go and the jet holds its flight path and bank; the FCS limits AoA to 25 deg and g to +9 / -3 |
| landing | gear down, about 140 kt and 13 deg AoA on a 3 deg path: keep the flight path marker in the middle of the bracket beside it (high in the bracket: fast, low: slow) with the throttle, or let the auto-throttle (`Y`) do it; flare gently from about 30 ft (the radar altitude shows beside the marker below 100 ft): the auto-throttle adds no power below 50 ft and closes the throttle from 10 ft (`APC RETARD`), the flare is yours; idle and brakes (`B`) after touchdown |
| crash | the cause is shown (hard landing, gear up, water, terrain, over-g ...); `R` starts again. A firm touchdown without a flare shows HARD LANDING; above about 15 ft/s (4.6 m/s) the gear collapses |

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

<!-- cockpit track (gfx-cockpit): the cockpit graphics module; details in js/aircraft/pcd/README.md -->
## Cockpit

The player's cockpit is a graphics module (`js/aircraft/Cockpit.js`, `js/aircraft/pcd/`): a live
panoramic cockpit display (status bar, TSD moving map, FUEL, ENG, ICAWS, EFI, redrawn 4-10 times
a second from the flight model while it can be read, its brightness following the exposure);
the tub repainted dark grey satin with grain, smudges, ambient occlusion and the light it passes
round, the skin's inner faces painted to a smooth edge along the sills, the cockpit's own sun
shadow (sills, canopy frame, seat and pilot), the display's glow at night; a pass on the canopy
glass (haze and scratch arcs round the sun, the display reflected at night). The side-stick, the
throttle, the hands and the pedals follow the pilot's inputs. The cockpit camera turns the head
about the neck, vibrates on the runway, at the touchdown and in the buffet, and zooms with the
wheel (20-80 deg). `?cockpit=0` shows the glb's cockpit as exported, `?shake=0` stops the
vibration; `quality` sets the display's resolution and rate, the canopy pass and the cockpit
shadow map (none / 1024 / 2048). The displays write alpha 0 into an HDR frame, for a post
chain's night vision to leave them in colour. All procedural, no new data (the moving map shows
the terrain imagery credited below). Design, overridden materials and costs:
`js/aircraft/pcd/README.md`.

The canopy bow, the coaming, the display's bezel, the side consoles, the seat's headbox and beams,
the canopy's side frame and the sills are rebuilt at start-up from the glb's own parts, in their
places and sizes, one part per task and each all or nothing: a slim bow at the glb's band with
sealant beads and handholds, a hooded anti-glare coaming whose outline from the eye is the
helmet's coaming line, Dzus-fastened console panels, a lined canopy frame with its bolts and seal,
a rounded sill cap; fastener heads in their part's paint (`js/aircraft/pcd/parts.js`;
`?ckparts=0` shows the glb's).

## Helmet display

Green symbology as in the F-35's helmet, drawn crisp at the screen's resolution. In the
cockpit: airspeed (KIAS) in the box on the left, altitude (ft) on the right with the radar
altitude below 5,000 ft and the vertical speed, a heading tape on top, the flight-path marker
(where the jet is going), the waterline (where the nose points), a pitch ladder every 5 deg
around the flight path (dashed with minus numbers below the horizon, stopping at the glare
shield as seen from the eye, wherever the head is; above about 15 deg AoA the flight path marker
stops just above it, crossed out), Mach, g (and the peak g), AoA (HI AOA in the 50 deg mode),
thrust (MIL and burner; APC while the auto-throttle flies it, APC RETARD as it closes the throttle
in the flare; LVR and an arrow while a HOTAS lever has not picked the throttle up), fuel, gear,
parking brake, brakes and speed brake, and the warnings of the flight model under the heading
tape (PULL UP, OVER G, AOA LIMIT, GEAR, OVERSPEED, ENGINE, TYRE BURST, HARD LANDING, BINGO FUEL,
PARKING BRAKE); messages (toasts) show just below the warnings. The heading is magnetic, as on
the real display and the runway numbers (the map grid heading plus the grid convergence, minus the WMM2025
variation of about 5 deg E): lined up on Tel Nof 36 it reads 358. With the gear down in the air an
AoA bracket stands beside the flight path marker (the marker in its middle: on-speed, 13 deg AoA;
high: fast; low: slow), a dashed line marks the -3 deg glide path, and below 100 ft the radar
altitude shows beside the marker for the flare. In the outside views a one-line strip at the
bottom shows the same numbers.

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
| `vegetation=0` | no trees, orchards, palms or shrubs (see Vegetation) |
| `stubs=1` | stand-in modules from `dev/stubs` (no data needed) |
| `depth=reversed` | reversed depth buffer instead of the logarithmic one (where `EXT_clip_control` exists) |
| `clouds=clear` / `few` / `scattered` / `broken` / `cirrus` | weather for this session (the menu's Weather row otherwise) |
| `post=0` | no HDR post-processing: straight to the canvas with three's AgX (a fallback; no clouds, bloom or glare) |
| `test=1` | the automation API `window.__sim` (see Tests); the render loop starts paused |
| `bench=1` | the 60 s benchmark flight (see Fly); `seconds=N` for another length |
| `buildings=0` | no 3D buildings (the menu's option turns them off too) |
| `buildingsDebug=1` | buildings tinted by level of detail: boxes blue, full detail red |
| `acfx=0` | none of the aircraft's effects (vapour, contrail, tyre smoke, landing-light pool); `vapour=0`, `tyresmoke=0`, `landingpool=0` one each |
| `roads=0` / `airportlights=0` / `traffic=0` | no roads, railways and airfield surfaces / no airfield lights / no night traffic (see Roads) |
| `bshadows=0` / `blights=0` | no ground shadows of the buildings / no obstruction lights |

## Vegetation

Trees, orchards, palms and shrubs over the core of the map: `js/terrain/Scatter.js`, a graphics
module, with `js/terrain/vegetation/` (placement worker, procedural species meshes, impostor
atlas, shaders); the details in [`js/terrain/VEGETATION.md`](js/terrain/VEGETATION.md). Placed
at run time from the terrain's own land cover (ESA WorldCover), imagery and heights: citrus
orchards in rows on the coastal plain, the KKL pine forests, olives on the hill terraces, garden
and street trees in the towns, eucalyptus windbreaks, date palms in the rift; nothing on runways,
roads, railways, airfield surfaces, buildings, roofs or water. Near trees are meshes, far ones
impostors (one draw), with one shadow each (the sun's shadow map near the camera when it covers
them, a ground decal elsewhere). A terrain that paints crowns for the far view
(`terrain.setVegetationCover`) is told where the 3D trees stand, so no forest is drawn twice.
Off with `vegetation=0` or the menu option (off for 10 s, its memory is freed); range and
density follow the quality. Cost: 2 draw calls in the air (none when no trees are in view; up
to 36 more for the meshes near the ground, plus the trees that cast into the shadow map), about
30 MB of GPU memory at medium (16.5 MB low, 39 MB high).

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
| `tests/vegetation_shots.mjs` | screenshots and frame statistics of the vegetation scenes (see `js/terrain/VEGETATION.md`) |
| `tests/vegetation_placement.test.mjs` | the vegetation placement against the mapped roads and buildings, in node |

The other modules (sim/DESIGN.md): `js/env` (sky, sun, haze, lighting), `js/terrain` and
`js/world` (terrain rendering and queries), `js/aircraft` (the jet), `js/fdm` (flight model).

### Roads, railways and airfield lights

`js/world/Roads.js` (a graphics module) drapes the roads, railways, taxiways and aprons of
`data/world/roads/` and `data/world/airfields/airfields.json` (OpenStreetMap via Overture, built
by `tools/world/roads.py` and `airfields.py`) exactly on the terrain within 3.4 km (high), 2.4
km (medium) or 1.5 km (low), with lane markings, kerbs, rails, taxiway lines and holding
positions, street lights and floodlit aprons at night, fading into the imagery beyond. Bridges
that span a valley stand on their decks (sides, parapets, piers); far roads thinner than 1.5 px
are drawn 1.5 px wide at a lower opacity instead of breaking into dots. It owns
`js/world/AirportLights.js`: runway edge, threshold, centreline and touchdown lights, approach
lights with flashers, PAPI, blue taxiway lights and floodlight masts, switched by the sun, and
the street lamps out to 20 / 14 / 8 km (lit cities to the horizon at night), and
`js/world/Traffic.js`: the head and tail lights of cars driving along the main roads at night.
Without the data it draws nothing. Formats, layouts and rebuild: `tools/world/ROADS.md`.

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
node sim/tests/input.test.mjs                                          (keyboard, mouse stick, gamepad; no browser)
node sim/tests/lighting_shots.mjs [--port 8148] [--out DIR] [--set quick|times|night|sky|clouds|shadows|twilight|flicker|all] [--only a,b] [--quality q] [--frames N] [--resume]
python3 sim/tests/frame_diff.py DIR [--threshold 4]                    (frame-to-frame change of the flicker pairs)
node --import ./sim/tests/node-three.mjs sim/tests/aircraft_fx.test.mjs  (lights, burner, vapour models)
node --import ./sim/tests/node-three.mjs sim/tests/cockpit_parts.test.mjs (the rebuilt cockpit parts against the glb and the helmet's coaming line)
node sim/tests/aircraft_scenes.mjs [--port 8150] [--only park_,ab_] [--shots chase,side]   (the jet's looks)
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

**`tests/lighting_shots.mjs`** takes the screenshots of the light, sky and clouds work
(`js/env/README.md`): the same places at six times of day, dusk and night, the weather presets
from below, inside and above, the shadows near the ground, the dusk in steps from sunset to
night; the exposure of each shot and `renderInfo()` / `gpuMemory()` go to its log and
`report.json`. `--frames N` draws N frames before each shot (the clouds' temporal filter settles);
the `flicker` set takes two consecutive frames of a still camera, which `frame_diff.py` compares.

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
| `hmd()` | the numbers the helmet display drew last: `iasKt`, `altFt`, `hdg` (magnetic; `hdgGrid` the flight model's, `hdgTrue`, `conv`, `magVar`), `g`, `mach`, `alphaDeg`, `vsFpm`, `aglFt`, `thr`, `ab`, `fuelLb`, `gear`, `apc`, `approach`, `warnings` ... |
| `renderInfo()`, `timing()`, `gpuMemory()` | renderer.info of the last drawn frame; step and frame times, fps, GPU name, canvas size; the GPU memory estimate (MB, the largest textures) |

Example (Playwright, after `waitForFunction(() => window.__sim?.ready)`):
`page.evaluate(() => { __sim.start('telnof_36', {time: 12}); __sim.autopilot('takeoff'); return __sim.fly({until: 'climb'}); })`,
then `page.evaluate(() => __sim.settle(2000))` and `page.screenshot()`.

## Buildings (`js/world/Buildings.js`)

The 836,000 buildings of the core: Overture Maps (OpenStreetMap and Microsoft ML footprints) and
the air bases traced in the imagery, made into `data/world/buildings/` (222 tiles, 32 MB) by
`sim/tools/world/buildings.py` with heights, roof shapes, styles and colours estimated from tags,
neighbours and region (`sim/tools/world/README.md`).

* **Streaming**: a worker (`BuildingsWorker.js`) parses the 6.4 km tiles around the camera and
  builds two levels of detail. Every building is an instanced box with its roof shape (one draw
  call per tile) that grows out of the ground at its visibility distance (no popping); near the
  camera, 800 m chunks get the real footprints (walls, roofs, parapets, roof houses, pitched
  roofs, domes, vaults). The switch cross-fades over 0.6 s (the chunk and its boxes drawn with
  complementary dither masks), so nothing pops. Start-up does not wait for buildings.
* **Shading** (`buildingShaders.js`): procedural, filtered facades per style (White City plaster
  with balconies and pilotis, Jerusalem limestone, glass curtain walls, offices, towers,
  industrial halls, houses, greenhouses, old stone, the power stations' banded stacks, the air
  bases' steel-clad halls and hangars with their doors, the Azrieli Spiral's bare concrete frame),
  windows that reflect the sky and show rooms behind them, lit windows and shop fronts at night
  (fewer after midnight), roofs with tiles, metal, solar water heaters and clutter, the Dome of the
  Rock's gilding. Lit like the terrain (sun, sky, aerial perspective, logarithmic depth).
* **Shadows**: every building receives the sun's shadow map, and the full-detail chunks cast into
  it when the shadow camera covers more than the aircraft (300 m or more across; js/env sizes it to
  the jet, so in this tree they do not). At every height each building casts a ground shadow: a
  decal of its box's shadow (one instanced draw per tile, within 4 / 8 / 12 km at low / medium /
  high) that takes the sun's share of the ground's light away (less through haze), faded out where
  the shadow map holds the buildings. Overlapping shadows darken once. Buildings are not shadowed
  by other buildings beyond the shadow map, and on a slope the decal lies on the building's lowest
  ground level (cut off uphill, displaced downhill).
* **Obstruction lights**: red lights on the structures of 45 m or more at dusk and night; the
  stacks and the structures of 150 m or more flash, and the latter carry a second ring at half
  height.

| quality | full detail within | boxes up to | full-detail chunks |
| --- | --- | --- | --- |
| low | 1.2 km | 15 km (a house to ~2.3 km) | 24 |
| medium | 2 km | 21 km (a house to ~3.5 km) | 44 |
| high | 3 km (towers further) | 28 km (a house to ~5 km) | 72 |

Cost over Tel Aviv at 300 m (scene `tlv300` of `sim/tools/world/shots.mjs` against
`?buildings=0`): high +72 draw calls, +2.9 M triangles, +61 MB geometry; medium +52, +2.2 M,
+44 MB; low +29, +1.3 M, +26 MB. The ground shadows are part of it: a draw call per tile within
their distance, 4 triangles (0.8 M at high, most of them collapsed in the vertex shader: small
buildings far off) and 16 bytes per building. Low over the Azrieli towers, the view with the most
full detail, the geometry comes to +77 MB at high. The building shaders use 4 texture units
(3 atmosphere tables and the sun's shadow map), the ground shadows 3, the lights none.

## The jet up close
`js/aircraft` (see its README): the skin calibrated against photos of IAF F-35Is (satin, no clear
coat: the exported Cycles values read as chrome plastic in three.js), a heat-stained nozzle whose
petals open at idle and in burner, white wells, rubber tyres; photometric exterior lights (nav
lights in their sectors, alternating anti-collision flashes, formation strips, a landing light
that lights the runway at night, glare only in the dark); a burner that is short and pale by day
and long with attached shock diamonds at night, never a white ball; and, as the graphics module
`AircraftFX`, vortex trails and vapour sheets in hard turns, the vapour cone near Mach 1 low over
the sea, a contrail above ~9 km and tyre smoke at touchdown. `sim/tools/aircraft` can bake ambient
occlusion into the export (ORM texture + per vertex); the app uses it when the data has it.
Hooks for other modules (no change to `main.js`): every day / night switch of the jet's effects
follows the sun's elevation (`fxEnv`, `js/aircraft/fxshared.js`), never the exposure meter; an HDR
chain that keeps its exposure elsewhere replaces `fxExposure.get` (and sets `fxEnv.noonExposure`);
the landing and taxi beams are published on `visual.lights.landing.beams` for a terrain or roads
shader that wants to light itself (then `?landingpool=0`). `AircraftFX` builds every effect's
shader program, the wingmen's too, in the first frame drawn: no hitch when the burner or the
vapour first shows.

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
  peak g, the mouse-stick position, and `leverMismatch`: a HOTAS lever's position until it has
  picked the throttle up, from `input.leverMismatch`).
* `EngineSound.update(state, viewMode, dt, opts)`: optional `opts` (camera position for distance
  and Doppler, canopy, active); also `setVolume`, `setMuted`, `toggleMute`, `setPaused`.
* `Input.update(dt)` also returns `brake`, `speedbrake`, `highAoA`, `apc`, look axes, drag and
  wheel, and the edges `parkingBrakeToggle`, `speedbrakeToggle`, `highAoAToggle`, `apcToggle`,
  `resetHint`, `lightsToggle`, `landingLightToggle`, `mute`, `timeEarlier`, `timeLater`, `camera`
  (1-5), `fullscreen`, `lookCenter`, `confirm`, `menuBack`; the levers (throttle with the MIL
  detent, gear handle, parking brake, canopy, speed brake, high-AoA mode, auto-throttle) live in
  `input.levers`. The app tells it each frame whether the jet is `airborne` (L3's two roles) and
  whether a restart needs R held (`resetNeedsHold`: in flight).
* A spawn's `apc: true` (the 10 km final) starts on the auto-throttle; `fuel` sets the fuel
  fraction (and with it the on-speed AoA at the spawn's speed).
* A spawn's `time_h` / `day_of_year` (the Jerusalem sunset) set the time of day when it is
  chosen.
* `serve.py` listens on 127.0.0.1 only and moves to the next free port when 8035 is taken.
* Extra modules: `js/ai/Wingmen.js` (optional, off by default) and `js/ui/Effects.js`.
* **Light and the HDR frame** (`js/env`, see `js/env/README.md`): the scene is drawn into a
  half-float 4x MSAA target in physical units and finished by `js/env/Post.js` (clouds, bloom, sun
  glare, AgX with a look, night vision); the canvas itself has no MSAA or depth buffer. The
  exposure is metered on the light at the camera and adapts like an eye; the ambient light is the
  sky plus the ground around the camera at its land-cover albedo; the moon and the stars have
  their real positions and phase for the date. Transparent things near the camera (burner plume,
  canopy, sprites) are drawn after the clouds; the sun's shadow box widens near the ground to take
  in buildings and trees ahead of the camera.
* **Units for lights** (lighting fix): one scene unit of illuminance is `LUX_PER_UNIT` = 32,000 lux
  (`js/env/Environment.js`): a three.js point or spot light takes `candela / LUX_PER_UNIT`, an
  emissive surface `cd/m^2 / LUX_PER_UNIT`. The night exposure goes up to 285 (it stopped at 40);
  lights tuned by eye at 40 keep their look through `env.nightLightGain` (= min(1, 40 / exposure),
  already in the `uNight` uniform), displays drawn at a fixed picture level divide by the exposure
  (`js/env/displayLevels.js` does it for the glb's PCD glass, tablet and switch LEDs, and steps
  aside when a cockpit module sets `app.cockpit`).
* **Clouds** are filtered in time (no boiling; `app.clouds.temporal`), cast their shadows per
  fragment on three.js's own materials too (`js/env/cloudShadowChunk.js`, a patch of three's light
  chunk made once at start-up), and on high step down to the medium tier if their measured GPU
  time stays over `app.clouds.budgetMs` (2.5 ms).

## Credits

* **Aircraft**: the procedural F-35I Adir Blender model of this repository (`scripts/f35`,
  `scripts/pilot`), exported for the browser by `sim/tools/aircraft`.
* **Terrain** (from `data/terrain/manifest.json`): Copernicus DEM GLO-30, produced using
  Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018
  provided under COPERNICUS by the European Union and ESA; all rights reserved. Imagery and land
  cover: © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021)
  processed by ESA WorldCover consortium (CC BY 4.0). Airports: OurAirports (public domain).
  The menu shows the attribution of the data set it loaded.
* **Buildings**: © OpenStreetMap contributors and Microsoft ML Building Footprints (ODbL 1.0),
  via the Overture Maps Foundation; the air bases traced from the ESA WorldCover Sentinel-2
  imagery (CC BY 4.0). Facades and roofs are procedural.
* **Roads, railways and airfields** (`data/world/roads`, `data/world/airfields`): © OpenStreetMap
  contributors, ODbL 1.0, via the Overture Maps Foundation (release 2026-10-21.0). The menu
  shows it with the terrain's credits.
* **Vegetation**: placed from the terrain's ESA WorldCover 2021 land cover and Sentinel-2
  imagery (credited above, CC BY 4.0) and kept off the mapped roads, railways, airfield surfaces
  and buildings of the world layers when they are there (© OpenStreetMap contributors and
  Microsoft ML Buildings, ODbL 1.0, via Overture Maps Foundation); the tree and palm meshes and
  their impostor textures are made procedurally at start-up (`js/terrain/vegetation`), no model
  or image files.
* **three.js** r187 (MIT licence), vendored in `vendor/three`.
* Everything else (sounds, helmet display, effects, the splash picture from this repository's
  renders) is made here. The sky, stars, moon and clouds are procedural (formulas: Hillaire 2020
  atmosphere, the Astronomical Almanac's low-precision sun and moon, Perlin-Worley cloud noise);
  the land-cover albedo that lights the shadows is ESA WorldCover (above, CC BY 4.0).
