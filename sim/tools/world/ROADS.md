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
| `sim/js/world/AirportLights.js` | runway, approach, PAPI, taxiway and floodlight sprites |

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
```

Needs `numpy` and `pyarrow` (and `Pillow` for `check`). Both tools only read the public bucket
`s3://overturemaps-us-west-2` through HTTPS range requests: the parquet footers, then only the row
groups whose bounding-box statistics touch the core (or an airfield). The default cache is
`sim/tools/world/_cache/` (it ignores itself in git).

Output (`sim/data/world/`, ~20 MB):

* `roads/index.json`: release, attribution, tile layout, class / flag ids, km and polylines per
  class, `files` (the tiles that exist, `"ix,iz"`).
* `roads/tile_<ix>_<iz>.bin`: one per terrain L0 tile that has roads (222 of 256, 19.5 MB).
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
(level >= 1 or the bridge flag), `4` urban (ESA WorldCover built-up over half the way), `8`
unpaved (surface or class track), `16` solid centre line (rural two-way trunk and primary), `32`
lit (town roads; motorways and trunks within reach of built-up land), `64` taxiway edge
markings (airfields.json only).

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
simplified to 0.15 m.

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
  terrain. Normals are the terrain's. 36 bytes per vertex.
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
  floodlights, with the eye's adaptation the capped exposure lacks once the sky is dark.
* **Airfield lights** (`AirportLights.js`): one `THREE.Points` per airfield, camera-facing
  sprites. Each light has a colour and intensity (cd) per side of its axis and a beam; the
  vertex shader computes the illuminance at the eye through the atmosphere (`I T / d^2`) against
  the threshold of a point source on the background (Allard: `E_t = 10^(0.64 log B - 5.7)` lux,
  `B` from the sun's elevation), and sizes (pixel-clamped) and brightens the sprite with the log
  of the excess, in HDR (bright lights exceed 1 for bloom). PAPI white above its unit's angle,
  red below (2 white 2 red on 3 deg). Runway, approach and taxiway lights on from sun 8 deg
  (dimmer steps at night), floodlights from sunset, PAPI always.
* URL parameters: `roads=0` (no roads, airfield surfaces or lights), `airportlights=0`.
* Shader samplers (the D3D11 limit is 16): the road program 5, 6 with the sun's shadow map
  (atmosphere transmittance LUT, the two sky-view LUTs, noise, overview colour), the lights 0.

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
* Bridges are drawn on the ground (flat on the terrain, over everything): no decks or piers.
  Tunnels are left out.
* Junctions are blended, not modelled: no turn lanes, islands or roundabout geometry beyond the
  OSM lines.
* Sidewalks and kerbs only beside streets in built-up land (WorldCover), not along every street.
