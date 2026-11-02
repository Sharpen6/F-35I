# Roads, railways and airfields (sim/tools/world: roads.py, airfields.py)

Two builders for the sim's ground network, and the runtime that draws it:

| file | what |
| --- | --- |
| `sim/tools/world/roads.py` | Overture transportation segments (roads, rail) of the 102.4 km core -> `data/world/roads/` |
| `sim/tools/world/airfields.py` | Overture aeroways (taxiways, aprons) of five airfields + light layouts -> `data/world/airfields/airfields.json` |
| `sim/js/world/Roads.js` | graphics module: streams the tiles, builds chunks in a worker, owns the airfield lights |
| `sim/js/world/roadMesh.js` | tile parser and chunk mesh builder (also runs in node) |
| `sim/js/world/roadsWorker.js` | module worker around roadMesh.js |
| `sim/js/world/roadShaders.js` | road / rail / taxiway / apron shader: surfaces, markings, lighting, depth bias |
| `sim/js/world/AirportLights.js` | runway, approach, PAPI, taxiway, floodlight and street lamp sprites |
| `sim/js/world/Traffic.js` | head and tail lights of cars on the main roads at night |
| `sim/js/world/Runways.js` | graphics module: the paved runway surfaces over the terrain's runway paint (below) |
| `sim/js/world/runwayMesh.js` | a runway rectangle cut exactly out of the terrain's 25 m triangles (also runs in node) |
| `sim/js/world/runwayShaders.js` | runway surface shader: pavement, rubber, cracks, concrete, markings, cables, lighting |
| `sim/js/world/runwayFixtures.js` | edge light fixtures, distance-remaining and arresting gear signs by day |

Data: **© OpenStreetMap contributors, ODbL 1.0, via the Overture Maps Foundation** (release
`2026-10-21.0`, themes `transportation` and `base/infrastructure`). Anyone who shares the data
must keep that attribution; the start menu shows it (`Roads.credits`) and both output files
carry it (`attribution`). Everything else (cross-sections, markings, textures, lights) is
procedural and made here.

## Rebuild

```sh
# roads: ~100 MB of parquet row groups read over anonymous HTTPS (no AWS SDK), ~2 min build
python3 sim/tools/world/roads.py --cache /tmp/roads_cache --out sim/data/world --stages fetch,build
python3 sim/tools/world/roads.py --cache /tmp/roads_cache --out sim/data/world --stages check
# airfields (needs sim/data/terrain/airports.json and the roads module for its helpers)
python3 sim/tools/world/airfields.py --cache /tmp/airfields_cache --stages fetch
python3 sim/tools/world/airfields.py --cache /tmp/airfields_cache --out sim/data/world --stages build
# runway surfaces (~3 s, no network: airports.json, the L0 imagery and airfields.json if there)
python3 sim/tools/world/airfields.py --out sim/data/world --terrain sim/data/terrain --stages runways
```

Needs `numpy` and `pyarrow` (and `Pillow` for `check`). Both tools only read the public bucket
`s3://overturemaps-us-west-2` through HTTPS range requests: the parquet footers, then only the row
groups whose bounding-box statistics touch the core (or an airfield). The default cache is
`sim/tools/world/_cache/` (it ignores itself in git).

Output (`sim/data/world/`, ~20 MB):

* `roads/index.json`: release, attribution, tile layout, class / flag ids, km and polylines per
  class, `files` (the tiles that exist, `"ix,iz"`).
* `roads/tile_<ix>_<iz>.bin`: one per terrain L0 tile that has roads (222 of 256, 19.5 MB).
* `roads/lamps_<ix>_<iz>.bin`: the street lamps of a tile (197 tiles, 555 k lamps, 4.4 MB);
  `index.json` `lamps.files` lists them with their counts.
* `roads/check.txt`: the alignment check (below).
* `airfields/airfields.json`: taxiways, aprons, holding positions, taxiway lights, floodlight
  masts and runway light configurations (0.2 MB).

## Classes and cross-sections

Overture `class` / `subclass` -> render class (id in the tiles; `roadMesh.js` CLASS):

| id | class | from Overture | lanes (oneway / two-way) x width | shoulder R / L | sidewalk (town) |
| --- | --- | --- | --- | --- | --- |
| 0 | motorway | motorway | 3 / 6 x 3.6 m | 2.5 / 1.0 m | - |
| 1 | motorway_link | motorway, subclass link | 1 / 2 x 3.8 m | 2.0 / 0.8 m | - |
| 2 | trunk | trunk | 2 / 2 x 3.5 m | 1.5 / 0.6 m | - |
| 3 | trunk_link | trunk / primary / secondary / tertiary links | 1 / 2 x 3.6 m | 1.5 / 0.6 m | - |
| 4 | primary | primary | 2 / 2 x 3.4 m | 1.0 / 0.4 m | 2.6 m |
| 5 | secondary | secondary | 2 / 2 x 3.3 m | 0.8 / 0.3 m | 2.3 m |
| 6 | tertiary | tertiary | 1 / 2 x 3.2 m | 0.5 / 0.3 m | 2.0 m |
| 7 | residential | residential, living_street, unclassified | 1 / 2 x 2.9 m | - | 1.8 m |
| 8 | service | service (not parking aisles, driveways) | 1 x 3.5 m | - | - |
| 9 | track | track (paved tracks drawn as roads) | 1 x 3.0 m | - | - |
| 10 | rail | rail (standard / narrow gauge): one track per way | 3.0 m ballast top | 0.7 m slopes | - |
| 11 | light_rail | light rail, tram | 2.8 m slab | 0.3 m | - |
| 12 | taxiway | airfields.py | per airfield (23 m Ben Gurion, 20 m Tel Nof / Hatzor) | paved shoulders | - |
| 13 | apron | airfields.py (triangles) | - | - | - |

Overture has no lane counts: named motorways get theirs from `NAMED_LANES` (Ayalon 4 per
direction, Highways 1, 2, 4, 6 and Begin 3). Widths follow Israeli practice (Netivei Israel
design guide: 3.6-3.75 m motorway lanes with a 2.5-3 m right shoulder, 3.3-3.5 m main roads,
2.75-3 m streets). Left out: footways, paths, steps, cycleways, sidewalks and crossings mapped as
ways, parking aisles, driveways, tunnels (cut out of their roads), roads under construction or
abandoned, roads on runways (the terrain paints those).

Flags (u8): `1` oneway (one carriageway; dual carriageways are two oneway ways), `2` bridge
(level >= 1 or the bridge flag), `4` urban: the land beside the road, 15-120 m beyond its edges
on both sides, is mostly built-up (ESA WorldCover class 50 over half of it, 35 % for streets and
service roads), with every road corridor (half the paved width plus 6 m) taken out of the land
cover first: the classifier counts a 20 m wide motorway's own asphalt as built-up, which made
84 % of the motorways "urban". Motorways and their ramps are never urban (no kerbs, sidewalks or
zebra crossings on the Ayalon). `8` unpaved (surface or class track), `16` solid centre line
(rural two-way trunk and primary), `32` lit (town roads; other roads where the land within
~300 m is built-up), `64` taxiway edge markings (airfields.json only).

## Tile format `RDS1` (little endian)

```
header  16 B   char[4] 'RDS1', u32 nPolylines, u32 nPoints, u32 nBreaks
records 24 B   u8 class, u8 flags, u8 lanes, i8 level, u16 carriageway width (cm),
               u8 left margin (dm), u8 right margin (dm), u16 nPoints, u16 nBreaks,
               u32 first point, u32 first break, f32 u0 (arc length of the first point, m)
points  4 B    u16 x, u16 z: 0.1 m from the tile's north-west corner (x east, z south)
breaks  8 B    f32 u (arc length along the polyline, m), f32 r (junction radius, m)
```

A tile is 6400 m, tile (ix, iz) has its NW corner at world (-51200 + 6400 ix, -51200 + 6400 iz)
(sim/DESIGN.md frame: X east, Z = -north). Polylines are cut at tile edges; `u0` keeps dashes and
textures continuous across the cut. Breaks are the junctions (Overture connectors shared by two
or more roads) with the widest half-width meeting there plus a metre: the shader keeps markings
out of them and puts stop lines, zebra crossings and kerb colours around them. Points are
simplified to 0.15 m. Pieces of one road meet on the same 0.1 m point (also across tiles: tile
edges are multiples of 0.1 m and polylines are cut exactly on them): that is how the traffic
carries on from one polyline to the next.

Optional bridge deck section after the breaks (readers of the first version stop before it):

```
deck    8 B    char[4] 'DCK1', u32 nDecks
        per deck polyline: u32 polyline index, f32 structure depth under the deck surface (m),
                           f32 deck height (m) per point of the polyline
```

Bridge decks (`bridge_decks` in roads.py): the bridge pieces that share end points are one
bridge; its ends on the ground (where a non-bridge road meets it, or a dead end) take the terrain
height and the joints between them are interpolated along the bridge, so each piece gets a
straight deck. Where the elevation model (a 30 m surface model: the valley under a viaduct)
sags more than 2 m under that line the bridge gets a deck (297 bridges, 67 km; the A1 railway
viaduct and Highway 1 at Motza 80-90 m over their valleys); smaller dips stay draped. Structure
depth 1.6-4.5 m (a slab on an overpass, a girder on a tall viaduct).

## Street lamp tiles `LMP1`

```
header  8 B    char[4] 'LMP1', u32 nLamps
lamps   8 B    u16 x, u16 z (0.1 m from the tile's NW corner), u16 lamp head height (0.05 m
               above -500 m), u8 flags (1 LED, 2 on a minor road: residential, service, track),
               u8 rank (a hash, 0-255: thinning with distance)
```

Exactly where the road shader puts its pools of light (`street_lamps` in roads.py, the same
rules as roadShaders.js): along lit roads every 42 m on main roads (high-pressure sodium on 12 m
poles) and 33 m elsewhere (warm LED, 9 m), from u = S / 2 on (the polyline's u, continuous across
tiles), in the median of a dual carriageway, staggered on both sides of a two-way road beyond the
kerb (0.7 m) or shoulder (1 m); on a bridge deck at the deck's height.

## airfields.json

```
{ version, format: 'ROADS.md', release, attribution, tile_m: 6400, origin: [-51200, -51200],
  tiles: { "ix,iz": { taxiways: [ { cls: 12, flags, lanes: 1, cw, left, right, u0,
                                    pts: [[x, z], ...] (tile-local m), holds: [[u, dir], ...] } ],
                      aprons: [ { cls: 13, flags: 0, tris: [x, z, ...] (tile-local m), axis: [ux, uz] } ] } },
  masts: [[x, z, height m, lux at the foot]], taxiLights: [[x, z]],
  runwayLights: { ICAO: { endId: { als, flash, papi, tdz, cl, inst } } },
  airfields: { ICAO: { taxiways, taxiway_km, holds, aprons, apron_m2, apron_triangles } }, built }
```

* Taxiways: OSM `aeroway=taxiway` lines, cut where they enter a runway (the terrain paints the
  runways), width per airfield (`AIRFIELDS` in airfields.py: Ben Gurion 23 m + 5 m shoulders,
  Tel Nof and Hatzor 20 m + 2 m, Palmachim 18 m + 2 m, Herzliya 10.5 m). A holding position
  (ICAO pattern A, `[u, dir]`, dir +1 when the runway lies ahead along the polyline) where the
  taxiway crosses the airfield's holding distance from a runway centreline (Ben Gurion 90 m,
  military fields 75 m, Herzliya 40 m), unless it runs within 25 deg of the runway.
* Aprons: OSM `aeroway=apron` polygons with their holes, ear-clipped, minus the runway strips.
* Taxiway edge lights: blue, every 30 m on both edges, not on runways or where taxiways join.
  Floodlight masts: every 110 m, 6 m outside aprons over 12000 m2 (Ben Gurion 30 m masts at 80
  lux, military fields 22 m at 40-45 lux, none at Herzliya).
* Runway lights per landing end (only lit runways of `data/terrain/airports.json`): `als`
  `calvert900` (900 m centreline of 5-light barrettes every 30 m, crossbars every 150 m) or
  `simple420` (420 m, 3-light barrettes every 60 m, crossbar at 300 m) or none; `flash` sequenced
  flashers; `papi` side (`L`); `tdz` touchdown zone barrettes; `cl` centreline lights; `inst`
  instrument runway (yellow edge lights in the last 600 m). Ben Gurion 26 / 08 / 12 Calvert with
  flashers and centreline (TDZ on 26 and 12), Tel Nof, Hatzor and Palmachim simple 420 m on
  their main runways, PAPI on the left everywhere.

## Runtime (js/world)

* **Streaming**: per L0 tile and 1600 m chunk (the terrain's level-0 node), two groups per
  chunk: 0 main roads, railways, taxiways and aprons, 1 streets, service roads and tracks. Draw
  range by 3D distance and quality: high 3400 / 1600 m, medium 2400 / 1100 m, low 1500 / 650 m,
  the last quarter a fade into the imagery (inside the terrain's exact 25 m mesh, 3.84 km). Chunks
  are built in a module worker, nearest first, up to 3 / 2 / 1 at a time.
* **Draping**: every ribbon polygon is clipped to the terrain's own triangles (25 m cells split
  NW-SE, exactly `HeightField.heightAt`), merged over planar areas in blocks of at most 100 m
  (the vertex shader's earth-curvature drop is quadratic), so roads lie exactly on the rendered
  terrain. Normals: the terrain's slope along the road, level across on paved roads and
  railways (a built road is cut and filled out of the natural cross slope, so its carriageway
  does not take the light and shade of the slope it crosses), the terrain's own on tracks,
  taxiways and aprons. 38 bytes per vertex.
* **Bridges**: on a deck polyline (DCK1) the surface is max(terrain, deck): each piece is split
  along the line where the deck plane meets the terrain plane (both parts share that line: no
  cracks), the lifted part takes the deck's plane and normal. Where the deck stands at least
  0.3 m off the ground the structure is added (class 14, concrete): fascia walls down to the
  structure depth, parapets 0.9 m high with their inner faces and caps, the underside, end walls
  where the deck meets the ground and piers every 40 / 80 / 120 m (by height; 1.4 m + 3.5 % of the
  height wide, two columns under decks over 14 m wide, none where another road passes under).
  Lit by the sun, half the sky on the walls and the light the ground reflects up (the shaded
  side and the underside of a viaduct). Not cast into the sun's shadow map.
* **Thin ribbons**: a ribbon narrower than 1.5 px on screen is widened to 1.5 px in the vertex
  shader (on the terrain's tangent plane along the mitred cross direction, aDir), with its
  coverage lowered to match: distant roads stay continuous lines of the right weight instead of
  dotted, crawling ones.
* **Depth**: priority by class (rail and taxiways over motorways over streets, bridges over
  everything) as a depth bias written in the fragment shader (the logarithmic depth buffer
  writes `gl_FragDepth`, so `polygonOffset` does nothing): (priority + 7) steps of 2 units of a
  24-bit buffer plus 1.2 % of the depth slope per step; shoulders, verges and sidewalks take 6
  steps, under every carriageway, so side roads cut through them at junctions. No z-fighting
  with the terrain or between roads at any distance in the test views.
* **Shading**: asphalt aged per polyline, grain, wheel tracks and oil strip per lane, patches;
  markings (yellow left edge and white right edge on dual carriageways, dashed lanes 3 m in 12 m
  / 9 m, single or double centre lines, rural edge lines, stop lines and zebras at junctions,
  none inside junctions); kerbs (red / white near junctions) and paved sidewalks in town; dirt
  tracks in the local soil colour with ruts; railways with ballast, concrete sleepers every 0.6 m
  and rusty rails with polished heads; taxiways with yellow centre line, edge lines and holding
  positions; aprons as 5 m concrete slabs with stains. Lit exactly as the terrain (sun through
  the atmosphere, sky, the aircraft's shadow) plus GGX sheen, then the same aerial perspective.
  At night: street lights along lit roads (sodium on main roads, warm LED in town) and apron
  floodlights, with the eye's adaptation the capped exposure lacks once the sky is dark
  (`env.lightGain`, the rule every module's lights follow: js/env/README.md "Lights at night"). The
  terrain's own shadows (hills over valleys at a low sun) when gfx-terrain's horizon maps are in
  (`terrain.horizon.uniforms` and `HORIZON_GLSL` of js/terrain/horizonMap.js, loaded only then;
  one more sampler).
* **Airfield lights** (`AirportLights.js`): one `THREE.Points` per airfield, camera-facing sprites.
  Each light has a colour and intensity (cd) per side of its axis and a beam; the vertex shader
  computes the illuminance at the eye through the atmosphere (`I T / d^2`) against the threshold of
  a point source on the background (Allard: `E_t = 10^(0.64 log B - 5.7)` lux, `B` from the sun's
  elevation: `env.pointThreshold`); the same GLSL (`POINT_LIGHT_VERT_GLSL`,
  `POINT_LIGHT_FRAG_GLSL`) draws the cars and the buildings' obstruction lights. The light's
  irradiance is spread over a Gaussian of at least 0.65 px (wider when bright, as glare) integrated
  over each pixel (erf), so a light keeps its energy wherever it falls between pixel centres: no
  twinkling as it moves. A display cannot show a point as bright as the eye sees it, so a light the
  eye sees well is at least as bright as its excess over the threshold says (as star magnitudes),
  up to 0.8 on the display in its brightest channel once the lights are on (the colour normalised
  by its maximum, not its luminance: a red at the floor is a full red, not a red at 3x white; by
  day, without Post.js's lights' path, by its luminance up to 0.85, as before); only physically bright
  (near) lights saturate, up to 64 in HDR (the bloom). Each sprite writes its mark as a light into
  the alpha (js/env/emitters.js, blended with `emitterBlending`): Post.js tone maps it by its
  brightest channel and keeps its hue, and night vision leaves it alone, so a red stays red (CIE x
  ~0.58; AgX alone turned the PAPI's red units white and every red light salmon, x ~0.42).
  Radians per pixel from the drawing buffer (HiDPI counted once). PAPI white above its unit's
  angle, red below (2 white 2 red on 3 deg); sequenced flashers held 40 ms (two or three frames; an
  8 ms flash fell between frames). Runway, approach, taxiway lights and floodlights switch on by
  the one schedule of js/env (`env.lightsOn`: from just before sunset, full with the sun 2.5 deg
  down), the PAPI always; at night the runway, approach and PAPI lights step down to 35 % (as ATC
  sets them on a clear night) as the eye adapts (`env.lightNight`).
* **Street lamps** (`AirportLights.js`, `lamps_<ix>_<iz>.bin`): one `THREE.Points` per road tile
  within 20 / 14 / 8 km (high / medium / low), their own program (16 bytes a lamp). The luminaire
  (cut-off optics: 3000 cd sodium / 1200 cd LED from below its horizontal plane, ~8 % of that from
  above: the glow of its glass) and, beyond the range where the ribbons show the pool of light on
  the road, the pool as a point (600 / 250 cd from straight above, Lambertian). Thinned with
  distance to (4 km / d)^2 of the lamps (at least 1 in 16), the ones kept carrying the light of
  the others; faded out at the end of the range. On with the street lights (`env.lightsOn`, the
  road shader's pools too), with the sprites' mark as a light. Cities are lit lines
  of lamps to the horizon instead of black beyond the road range. `Roads.lampRange`: where the
  terrain's procedural city lights should start (gfx-terrain), so the two do not count twice.
* **Traffic at night** (`Traffic.js`): cars on the lanes of motorways, trunk, primary, secondary
  and tertiary roads and their ramps within 3.8 / 2.8 / 1.8 km (high / medium / low, at most
  7000 / 3500 / 1200), right-hand traffic, one sprite each with the lights' shader: warm white
  low beams seen from ahead (500 cd within about 30 deg of the travel axis), red tail lights from
  behind (18 cd). The worker sends each tile's lanes (`trafficLanes` in roadMesh.js: centre lines
  every <= 20 m with the height of the surface the ribbons lie on, bridge decks included, the
  cross slope, and the end point keys); the main thread parses nothing. A car drives on from the
  end of its polyline along one that starts there (mostly the straightest, a ramp now and then,
  never against a one-way road or back), its lateral offset on the mitre of the two (no jump at
  the joint), easing into its lane and speed on the new road. Where no road carries on (a
  tunnel, a smaller street, the loaded tiles' edge) it fades out over its last 40 m; such a car,
  one that falls behind the radius and the surplus after a quality change come back elsewhere,
  fading in. Positions on the CPU (~0.3 ms a frame for 3500 cars here), uploaded for the slots in
  use only. Shown while the street lights are on (`env.lightsOn`): there are no car models by day.
* URL parameters: `roads=0` (no roads, airfield surfaces or lights), `airportlights=0` (no
  airfield lights, no traffic), `traffic=0`.
* Shader samplers (the D3D11 limit is 16): the road program 5, 6 with the sun's shadow map
  (atmosphere transmittance LUT, the two sky-view LUTs, noise, overview colour), 7 with the
  terrain's horizon map; the lights and lamps 0.
* Main thread: the noise texture is computed in the worker (it took 0.15-0.4 s at start-up), the
  floodlight masts are chosen again only after 100 m of travel (no garbage per frame).

## Runway surfaces (airfield track: `runways.json`, `js/world/Runways.js`)

The terrain paints every runway one uniform asphalt grey (`runwayShade` in
js/terrain/terrainShaders.js, faded out at 5-9 km). `Runways.js` draws the paved runways, their
shoulders and overruns over it as they look from the cockpit lined up, on the roll, on final,
from 3,000 ft and from the tower: one mesh per airfield, each runway's rectangle cut exactly out
of the terrain's 25 m triangles (`runwayMesh.js`, `tests/airfield_mesh.mjs`), so it lies on the
rendered terrain at every distance. `?runways=0` turns it off.

**Data** (`airfields.py --stages runways`, 2.8 s): from `data/terrain/airports.json` (positions,
widths, displaced thresholds, overruns as the terrain has them, plus `OVERRUN_FIX`), the
terrain's L0 imagery (6.25 m / px Sentinel-2 mosaic, `color/L0`) and the taxiways of
`airfields.json` when it is there. Per airfield (`RUNWAY_SURFACE`): military or not, the paved
shoulder each side (Ben Gurion, Tel Nof, Hatzor 7.5 m; Palmachim 3 m), how worn the paint is.

```
runways.json: { version, format: 'ROADS.md', attribution, built,
  strip: { file: 'runways.bin', samples: 1024, rows: 32, layers, rubberDark: 0.3 },
  runways: [ { icao, ids: [end 0, end 1], len, hw (half width), sh (shoulder), ov: [overrun 0, 1],
               disp: [displaced threshold 0, 1], layer, strip: [s0, s1, T] (the strip's extent:
               s from end 0, +-T across), conc: [concrete from pavement end 0, end 1 (m)],
               rubber: [mean deposit share of touchdown zone 0, 1], tone (the clean pavement's linear
               luminance in the imagery), cables: [s, s] (arresting gear), dtg: [[s, thousands of
               feet left towards end 1, towards end 0]], military, wear, closed, lit,
               cl: [centreline lights 0, 1], tdzl: [touchdown zone lights 0, 1],
               cross: [[sB, tB, cos, sin, half width, from, to]] (a longer runway crossing this
               one: its end 0 and direction in this frame), turns: [[s, side, ds, dt]] (taxiway
               turn-offs: where a taxiway leaves the side +1 right / -1 left, its direction) } ] }
runways.bin: uint8 RGBA, layers x 32 rows x 1024 samples: rgb the imagery's pavement (sRGB),
             a the share m of it darkened by rubber and oil (x 255)
```

* **Strip**: the imagery sampled along the runway (1024 x 32 samples, 4 m beyond the shoulders
  and 12 m beyond the pavement ends), the paint taken out (the ICAO markings' footprint inpainted
  from the samples beside them along each row), the edge rows and ends repeated from inside the
  pavement (the 10 m pixels there mix in the soil), smoothed (~4 m along, ~2 m across). The clean
  pavement `P` is the 85th percentile across the runway (over ~60 m along); a sample `Y` darker
  than that is covered by deposits of RUBBER_DARK times its albedo over the share
  `m = (1 - Y / P) / (1 - RUBBER_DARK)`.
* **Concrete ends** (military fields): where the clean pavement is more than 10 % lighter than
  the runway's middle from a pavement end inwards, at most 330 m past the threshold (Tel Nof
  15L/33R and 15R/33L, Hatzor 11L/29R).
* **Arresting gear** (military runways of 2000 m and more): a BAK-12 cable 460 m past each
  threshold. **Distance-remaining signs** every 1000 ft both sides (FAA AC 150/5340-18: the
  excess over whole thousands split between the ends).
* **Turn-offs**: taxiway end points within 3 m of a runway's side (102 at the seven fields).

**Shading** (`runwayShaders.js`, in the runway frame: s along from end 0, t across):

* Tone: the pavement's albedo (aged asphalt 0.10-0.20 by how light the imagery shows the
  runway, `PAVE` in Runways.js; concrete ~0.25) times the imagery's own light and dark sections
  relative to the runway's median (compressed), tinted a little by it. The imagery as it is
  makes a runway as light as the sand beside it (its 10 m pixels mix in paint and soil, and the
  terrain's albedo gain is tuned for soil), so the pavement's own tone is kept out to the
  fade-out: turning into the imagery's (2-3 x lighter) made a runway on a long final as light as
  the fields, then dark closer in. Beyond the fade-out the terrain's imagery shows, as before.
* Rubber and oil: streaks along the runway (long streaks of the keel, short tyre marks in the
  touchdown zones) whose mean cover is the strip's `m`, so the heaviest deposits are where the
  imagery has them (the main landing ends) and fade toward mid-runway; far away, where the
  streaks filter out, the mean is the imagery's again. Glossier than the dusty pavement.
* Asphalt: paving lanes (~4.6 m) with their own tone per ~280 m session, longitudinal joints
  sealed in ~70 m pieces, transverse cracks every ~13 m sealed across some lanes, meandering sealed
  cracks (more on the shoulders), darker patches with sealed rims, aggregate grain and
  mottling, oil drips along the keel and where the jets hold at the ends.
* Concrete ends: 7.5 m slabs a lane wide, sealed joints, replaced (lighter) slabs, corner cracks,
  dirt and water stains drifting across the slabs.
* Shoulders: older, dustier asphalt, more cracks; blast pads and overruns: yellow chevrons
  (0.9 m, 30 m apart, apex towards the runway).
* Markings (ICAO Annex 14): threshold stripes (4-16 by width) 6-36 m past the threshold,
  designation digits 9 m tall (and the L / R / C letter), centreline 30 m stripes / 20 m gaps,
  aiming point (400 m on runways of 2400 m and more, else 300 m), touchdown zone pattern A
  (3-3-2-2-1 bars per side, every 150 m), 0.9 m edge stripes, displaced threshold bar and arrows
  (on the displaced section, in place of the centreline: one every 60 m pointing at the
  threshold, an 8 m head 4 x the centreline's width, a 30 m shaft; whole arrows only).
  Worn by the field's `wear`, chipped (noise), blackened by the rubber in the touchdown zone,
  crossed by the sealant.
* By day: the arresting cable (32 mm, on rubber supports every 2.4 m) under yellow discs 3 m across
  9 m apart; inset light fixtures (steel rings with a lens slot: centreline every 30 m,
  touchdown zone barrettes, threshold and end bars) on runways that have those lights; tyre marks
  of the turns between the centreline and each taxiway (both ways, radius by the turn's angle:
  the swept band and the gear's tracks, varied smoothly along each arc in its own frame, darkest
  where it leaves the centreline, thinning out towards the taxiway).
* Every pattern is box-filtered by the pixel's footprint along and across the runway (bands,
  dashes, discs), the noise is a mipmapped texture sampled with true gradients, and detail too
  fine for a pixel fades into its mean: no crawling or moire at grazing angles.
* Lit as the terrain (sun through the atmosphere, sky, the sun's shadow map, the terrain's horizon
  shadow), GGX sheen, the terrain's aerial perspective; faded out at 8.8-11 km (high), 7.4-9.5 km
  (medium), 5.25-7 km (low).
* Depth: (5 + priority) steps of the roads' bias (priority: the longer of two crossing runways
  over the shorter), plus up to 64 more between 3.2 and 12 km, where the terrain's coarser levels
  leave the flat runway by up to a metre. The roads' taxiways (39+ steps) and aprons (7+) stay on
  top of the shoulders they cross.
* Samplers: 4 (strip atlas, per-runway data, noise, glyphs) + 3 atmosphere LUTs + the shadow map
  + the terrain's horizon map = 9. Fixtures: 5.

**Fixtures** (`runwayFixtures.js`, one merged mesh per airfield, drawn within 2.2 / 1.5 / 0.9 km):
elevated edge lights on lit runways (every <= 60 m, 1 m outside the edge: frangible stem, yellow
body, clear dome; AirportLights.js lights them at night), distance-remaining signs 12 m beyond
the shoulders (a white number on black, the other end's on the back), arresting gear signs
(a yellow disc on black) and the arresting engines' housings 28 m beyond the shoulders.

**Taxiways and aprons** (`roadShaders.js`, the airfield track's part): concrete slabs on the
taxiways from 60 m before each holding position to the runway (where jets wait and run up, oil
stains there), the main gears' tracks and nose-wheel drips along the centreline; on the aprons
replaced slabs, corner cracks, fuel and hydraulic drips and darker, oil-stained parking stands.

Precompiled at start-up (a stand-in mesh of each program, with and without the shadow map) like
the other modules. Built one runway per frame after the data loads (14 frames, 0.1-0.4 s in all
and at most 30-100 ms in one on the loaded 4-core test VM: `stats.buildMs`, `stats.buildMaxMs`).

**Cost** (960 x 540 on the SwiftShader test VM, against `?runways=0`; Tel Nof 36 lined up / from
3,000 ft): +5 / +2-3 draw calls (one per airfield in view, the fixtures within range), +22k /
+4-18k triangles, +8 programs (surface and fixtures, with and without the sun's shadow map, for
the canvas and the post chain's target, compiled in the background at start-up) and +10.7 MB of
GPU memory (geometry 6.1 MB, mostly the fixtures; textures 4.6 MB), the same on every quality.
On an RTX 3070 at 1080p some 0.1-0.2 ms lined up (~250k runway pixels, ~30 texture reads and a few
hundred ALU operations each, drawn over the terrain) and under 0.05 ms from altitude.

## Alignment check

`roads.py --stages check` rasterises the motorways, trunk and primary roads of the 8 tiles with
the most of them and cross-correlates the mask with the local contrast of the L0 imagery
(6.25 m pixels, Sentinel-2) over +-25 m. Result (`roads/check.txt`): where the roads stand out
(5 of 8 tiles) OpenStreetMap and the imagery agree to within a pixel (median +5.5 m east,
+0.6 m south); in town the peak is unreliable. The ribbons are drawn where OpenStreetMap has
them; the imagery's own roads show beyond the fade.

## Known limits

* Overture has no lane counts, widths or markings: cross-sections are per class (with a few
  named roads); interchanges get the ramp class's width.
* Bridge decks come from the bridge's ends on the ground (straight between them): a deck that
  really arches or bends in profile is drawn straight. Decks and piers cast no shadow. Overpasses
  whose dip under the deck line is under 2 m stay draped on the terrain. Tunnels are left out.
* The road surface is the terrain's 25 m surface (that is what keeps it watertight with the
  terrain at every distance), so a road rides whatever the height data has under it: in the
  Sha'ar HaGai gorge the grade of the height field under Highway 1, taken over 5 m, varies by
  10-12 % (standard deviation, up to 32-40 %) where the road climbs at about 6 %, and the
  carriageways step over the bumps. Smoothing it needs a benched road in the terrain's height
  data (gfx-terrain): the profile smoothed along the motorway and trunk polylines of
  `data/world/roads`, level across, the shoulders blended into the slopes.
* Junctions are blended, not modelled: no turn lanes, islands or roundabout geometry beyond the
  OSM lines.
* Sidewalks and kerbs only beside streets in built-up land (WorldCover), not along every street.
