# F-35I Adir browser flight sim: design and module contract

Sagi asked to fly the F-35I himself over a ~100 x 100 km landscape of central Israel.
This is a browser flight sim (three.js, WebGL2) served from his PC (Windows 11, RTX 3070),
flown with keyboard, mouse, gamepad or joystick. Everything here is the contract between
the modules; change it only together with every module it affects.

## Layout

```
sim/
  index.html            entry page, import map, loading screen, start menu
  serve.py              static dev/PC server (python3 serve.py [--port 8035] [--open])
  Fly_F-35I.bat         Windows launcher: finds Python (py / python / Blender's python), runs serve.py --open
  js/main.js            app shell: renderer, loop, camera modes, menus, glue
  js/world/coords.js    lon/lat <-> world X/Z (the projection below)
  js/terrain/           Terrain class (+ helpers, shaders)
  js/env/               Environment class: sun, sky, fog, lighting, time of day
  js/aircraft/          AircraftVisual class (loads the glb + rig json, moves parts)
  js/fdm/               FlightModel class (6-DOF, FCS, engine, landing gear), config
  js/input/             Input class (keyboard, mouse, gamepad / joystick, bindings)
  js/ui/                HMD (helmet display symbology), help overlay, menus
  js/audio/             EngineSound (WebAudio, procedural, no audio files)
  tools/terrain/        Python pipeline that builds data/terrain/ from public data
  tools/aircraft/       Blender (bpy) exporter that builds data/aircraft/
  tests/                node tests (FDM) and Playwright smoke tests
  vendor/three/         three.js r187 (MIT), import map "three" and "three/addons/"
  data/                 GENERATED, git-ignored (container: symlink to /home/claude/simdata)
```

No bundler, no npm runtime dependencies: plain ES modules plus the vendored three.js.
Import map in index.html:
`{"imports": {"three": "./vendor/three/build/three.module.js", "three/addons/": "./vendor/three/examples/jsm/"}}`.

## World frame and units

SI units everywhere (m, s, kg, N, rad) except where a name says otherwise (`ias_kt`, `alt_ft`).

Projection: transverse Mercator, WGS84, `+proj=tmerc +lat_0=31.80 +lon_0=35.025 +k=1 +x_0=0 +y_0=0`.
World (three.js, right-handed, Y up): **X = easting (east), Y = height above mean sea level
(the DEM's EGM2008 heights), Z = -northing (north is -Z).** Heading 0 = north (-Z), 90 deg = east (+X).

Core area: X and Z in [-51200, +51200] m (102.4 km square; about 34.48-35.57 E, 31.34-32.26 N:
the coast from south of Ashdod to north Tel Aviv, Ben Gurion, the air bases Tel Nof, Hatzor and
Palmachim, Jerusalem and the hills, the north end of the Dead Sea at about -435 m).
Far area: X and Z in [-204800, +204800] m, coarse, so the horizon is real land and sea.

Earth curvature: physics is flat. Every terrain/water/far shader lowers vertices by
`d^2 / (2 * 6371000)` where d is the horizontal distance to the camera (camera-relative),
so the far area drops below the horizon correctly (3.3 km at 205 km).

## Data: data/terrain/ (built by tools/terrain)

`manifest.json` lists everything below with sizes, encodings, sources and the attribution text
the app shows (Copernicus DEM, ESA WorldCover 2021 and its Sentinel-2 composite, OurAirports...).

Heights, encoding for every .bin: little-endian Uint16, `h_m = v * 0.05 - 500` (-500 .. 2776 m).
* `height/tile_{ix}_{iz}.bin`: core, 16 x 16 tiles, 6400 m each, 257 x 257 samples, 25 m spacing,
  shared edges. ix = 0..15 west to east, iz = 0..15 north to south. Tile (ix, iz) covers
  X in [-51200 + 6400 ix, ... + 6400], Z in [-51200 + 6400 iz, ... + 6400]; sample (row r, col c)
  is at X = X0 + 25 c, Z = Z0 + 25 r (row 0 = north edge). Row-major.
* `height/far.bin`: 2049 x 2049 samples, 200 m spacing, X and Z from -204800, same row order.
  Inside the core it holds the core heights downsampled.
Runways are flattened into both (level across, smooth along their length) and water is flat:
the Mediterranean at 0.0 m, the Dead Sea at its DEM level.

Colour (sRGB JPEG, top row = north):
* `color/L0/tile_{ix}_{iz}.jpg`: 1024 x 1024 per core tile (6.25 m/px, pixel centres
  at X0 + 6.25 (i + 0.5)).
* `color/overview.jpg`: 4096 x 4096 for the whole core (25 m/px).
* `color/far.jpg`: 2048 x 2048 for the far area (200 m/px).

Land cover (8-bit PNG, ESA WorldCover codes: 10 tree, 20 shrub, 30 grass, 40 crop, 50 built-up,
60 bare/sparse, 70 snow, 80 water, 90 wetland, 95 mangrove, 100 moss; 0 = no data), top row north:
* `landcover/tile_{ix}_{iz}.png`: 640 x 640 per core tile (10 m/px).
* `landcover/overview.png`: 4096 x 4096 for the core. `landcover/far.png`: 2048 x 2048.

Airports, `airports.json`:
```
[{"icao": "LLEK", "name": "Tel Nof", "elev_m": 59,
  "runways": [{"ids": ["15", "33"], "width_m": 45, "length_m": 2400, "surface": "asphalt",
               "ends": [{"id": "15", "x": .., "z": .., "y": .., "heading_deg": ..}, {"id": "33", ...}]}]}]
```
`spawns.json`: named starts, e.g.
`{"telnof_33": {"label": "Tel Nof, runway 33, ready for takeoff", "x":.., "y":.., "z":.., "heading_deg":..,
"on_ground": true, "speed_ms": 0}, "tlv_3000": {"label": "Over Tel Aviv, 3,000 m", ..., "on_ground": false,
"speed_ms": 200}, "telnof_final": {...}}`. y is the ground height under the spawn (the FDM puts the wheels on it).

## Data: data/aircraft/ (built by tools/aircraft from the Blender model)

* `f35i.glb`: the model in glTF 2.0 (metallic-roughness PBR, baked skin textures incl. panel lines,
  RAM tape and markings; KHR_materials_transmission for the canopy; target under 400k triangles,
  the seated pilot included and decimated).
* `f35i_rig.json`: everything the app needs to animate it and to fly it:
  body frame origin and reference point (see below), eye point, gear contact points (gear down,
  bottom of each tyre) with tyre radius, nozzle exit, landing/taxi light, and per control the
  moving nodes and how they move (exported from the Blender rig, F35I_Rig).

Aircraft body frame (used by FDM, visual and cameras): **+X = right wing, +Y = up, -Z = forward**
(a three.js camera's convention). Origin = the model's reference point (Blender Y = 0, i.e.
station s = 7.835 m aft of the radome tip, on the centreline at Blender z = 0), which the FDM
uses as its centre of gravity. glTF from Blender is +X = left, +Y = up, +Z = forward, so the
visual wraps it in a group turned 180 deg about Y.

Control names follow the Blender rig: stick_pitch (+ = pull, nose up), stick_roll (+ = right),
pedals (+ = yaw right), throttle (0 idle, 0.75 MIL, 1.0 max afterburner), flaps (0..1),
speedbrake (0..1), gear (0 up .. 1 down, doors sequenced), nws (-1..1, + = right),
roll_distance (m rolled, spins wheels), weapon_bays, canopy, refuel_door, gun_door, tailhook (0..1).

## Module interfaces (JS)

```js
// js/world/coords.js
export const ORIGIN = { lat: 31.80, lon: 35.025 };
export function lonLatToXZ(lon, lat) -> {x, z};  export function xzToLonLat(x, z) -> {lon, lat};

// js/env/Environment.js
export class Environment {
  constructor({ renderer, scene })
  setTime(hoursLocal, dayOfYear = 172)   // sun for 31.8 N; 19.0 on day 172 is sunset
  update(camera, dt)
  uniforms   // shared shader uniforms: uSunDir, uSunColor, uAmbient, uFogColor, uFogDensity,
             // uCameraPos, uEarthRadius; Terrain and any custom shader use these objects
  sunDirection   // THREE.Vector3 towards the sun
}

// js/terrain/Terrain.js
export class Terrain {
  constructor({ renderer, scene, env, baseUrl = 'data/terrain/' })
  async load(onProgress)     // manifest, all height tiles (kept in memory for physics), overviews, far
  update(camera)             // LOD, L0 colour streaming, uniforms
  heightAt(x, z)             // m MSL, smooth (at least bilinear), any x/z (far grid outside the core)
  normalAt(x, z, out)        // THREE.Vector3
  surfaceAt(x, z)            // {type: 'runway'|'ground'|'water', friction}
  airports, spawns           // parsed json
}

// js/aircraft/AircraftVisual.js
export class AircraftVisual {
  constructor({ scene, baseUrl = 'data/aircraft/' })
  async load(onProgress)
  object3d                   // THREE.Group in the body frame above
  setPose(position, quaternion)        // world, body -> world
  setControls(c)             // the control names above, plus ab (0..1 flame), lights {nav, landing, formation, anticoll}
  update(dt, camera)
  info                       // {eye, gearContacts: [{name, pos, radius}], nozzle, length, span, ...} in body frame
}

// js/fdm/FlightModel.js
export class FlightModel {
  constructor(config, ground /* {heightAt, normalAt, surfaceAt} */)
  reset(spawn)               // spawn from spawns.json (+ throttle, gear)
  step(dt, input)            // input: {pitch, roll, yaw: -1..1 (+ pull / right / right), throttle 0..1
                             //  (0.75 MIL, >0.75 afterburner), brake 0..1, parkingBrake, gearHandle (bool down),
                             //  canopy (bool open), nwsEnable}
  state                      // position (world, CG), quaternion (body -> world), velocity (world),
                             // angularVelocity (body), alpha, beta, ias, tas, mach, gLoad, altitude, agl,
                             // heading, pitch, roll, vs, onGround, wheels [{name, wow, compression, steer}],
                             // gear (0..1 actual), engine {rpm, thrust, ab, fuelKg}, controls (rig-named
                             // deflections for AircraftVisual.setControls), crashed, crashReason, warnings []
}

// js/input/Input.js
export class Input { constructor(domElement); update(dt) -> input object above + edges
                     {gearToggle, canopyToggle, cameraNext, cameraPrev, pause, reset, hmdToggle, help, ...} }
// js/ui/HMD.js
export class HMD { constructor(container); draw(state, camera, viewMode); visible }
// js/audio/EngineSound.js
export class EngineSound { constructor(); start() /* after a user gesture */; update(state, viewMode, dt) }
```

## Flight model targets (F-35A-like, public figures)

Mass empty 13,290 kg, internal fuel 8,278 kg (start with about 60 %), span 10.7 m, length 15.7 m,
wing area 42.7 m^2, F135 thrust about 125 kN MIL and 191 kN max afterburner at sea level (lapse
with density and Mach), +9 / -3 g, about 50 deg AoA available but limited to 25 deg in normal
mode, max Mach 1.6 at altitude, about 700 KCAS at low level, roll rate up to about 200 deg/s.
Fly-by-wire feel: stick commands pitch rate / g and roll rate, the jet holds its attitude with the
stick centred, auto-trim, turn coordination, AoA and g limiting, carefree handling. Takeoff about
150-165 KIAS with MIL at a typical weight, approach about 140 KIAS at 13 deg AoA, landing gear
on springs/dampers with brakes and nose-wheel steering. Crashes: hitting the ground beyond gear
limits, water, or terrain; the app offers a reset.

## Performance and look

60 fps at 2560 x 1440 on an RTX 3070: CPU-built chunked LOD terrain (quadtree, skirts) or GPU
displacement; satellite colour plus a detail texture by land cover up close, a water shader
(sun glint, Fresnel, waves) for the sea and the Dead Sea, aerial perspective (height fog, haze to
the horizon), sky and sun from Environment (morning, noon, sunset), shadows for the aircraft.

## Testing

* `node sim/tests/fdm.test.mjs`: scripted flights (takeoff roll, rotation, climb, level 1 g trim,
  sustained turn, loop, roll rate, approach and landing, braking) with pass/fail numbers.
* Playwright (preinstalled, `require('playwright')`, Chromium with `--use-angle=swiftshader
  --enable-unsafe-swiftshader`), against `python3 sim/serve.py`: screenshots of the start menu,
  the jet on the runway, a climb-out, the coast and Jerusalem from altitude, sunset.
