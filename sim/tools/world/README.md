# sim/tools/world: world data beside the terrain

Builders for what stands on the terrain of the flight sim. Each one writes into
`sim/data/world/<what>/` (not in git, like `sim/data/terrain/`) and needs the terrain data
(`sim/data/terrain/`, built by `sim/tools/terrain`) because objects are placed on its heights.

| file | what |
| --- | --- |
| `overture.py` | reads any theme / type of the [Overture Maps](https://overturemaps.org/) open data release for the core's lon / lat box (GeoParquet on a public S3 bucket, HTTP range requests on row-group bbox statistics) and caches the rows |
| `buildings.py` | 3D buildings: `sim/data/world/buildings/` (this page) |
| `geom.py` | polygon helpers (WKB parsing, cleaning, oriented boxes, point in polygon) |
| `airbases.py`, `airbases.json` | the buildings of Tel Nof, Hatzor and Palmachim, traced in the imagery (below) |
| `shots.mjs` | screenshots of the scenes the buildings are judged by (Playwright, `window.__sim`) |

Python 3 with numpy, pyarrow and Pillow (as `sim/tools/terrain`).

## Buildings

```
python3 sim/tools/world/buildings.py                       # both stages
python3 sim/tools/world/buildings.py --stages tiles        # rebuild from the cache (no network)
python3 sim/tools/world/buildings.py --stages tiles --only '4,7;5,7'   # some tiles only (keeps the rest of index.json)
```

Options: `--cache DIR` (default `sim/tools/world/_cache`, ~90 MB), `--out DIR` (default
`sim/data/world/buildings`), `--terrain DIR` (default `sim/data/terrain`), `--release` (an
Overture release name, default the newest), `--airfields FILE` (taxiways and aprons kept clear of
the air base buildings, default `sim/data/world/airfields/airfields.json` from `airfields.py`;
without it only the runways are).

**fetch** (~1.5 min, reads ~0.65 GB of 512 remote files): every Overture `buildings/building` and
`buildings/building_part` row inside the core's lon / lat box (102.4 km square, sim/DESIGN.md),
883,093 buildings in release 2026-10-21.0.

**tiles** (~6 min on 4 cores):

1. Building parts replace the outline of their building (OpenStreetMap's simple 3D buildings).
2. Footprints are projected into the sim's frame (`sim/tools/terrain/grid.py`), cleaned (duplicate
   and collinear points, Douglas-Peucker 0.5 m, which keeps right angles) and dropped when
   underground, outside the core, tiny or slivers (< 6 m², thinner than 1.4 m, or walls: thinner
   than 3.2 m and longer than 24 m), on a runway with its overruns and 15 m shoulders
   (airports.json) or in the sea / the Dead Sea (land cover).
3. Ground: the terrain's heights at the footprint's vertices and inside it, with exactly the
   interpolation of `HeightField.heightAt` (25 m grid, cells split NW-SE). Floor 0 is the lowest
   ground point (`base`); the walls reach `sink` below it (0.6 m + a quarter of the slope's rise).
4. Height: the tagged `height` or `num_floors` (2 % of the buildings carry one), else by
   kind, area and context: the mean floors of tagged neighbours (~1 km window, towers left out),
   the building density, named regions (Tel Aviv centre and Gush Dan 4-8 floors, Bnei Brak, Jerusalem, Modiin,
   Ramallah ...), so suburbs come out at 2-4 floors, kibbutzim and moshavim at 1-2, industrial
   halls at 7-12 m, hangars at 10-15 m, greenhouses at 4-5 m, sheds at about 3 m.
5. Roof: `roof_shape` when tagged; else pitched (hipped or gabled, 28-36 degrees) for houses
   whose roof looks reddish in the imagery, barrel vaults for hangars, flat otherwise. The roof
   colour is the L0 imagery (6.25 m / px) under the footprint, cleaned of tree green; clay tiles
   on most pitched roofs.
6. Walls: a style per building (plaster, Jerusalem stone, old stone, curtain-wall glass, office,
   tower, industrial, house, public, concrete, greenhouse) from the class, the region (the
   Jerusalem stone law, old Jaffa, the Old City) and the height; flags for an open ground floor on
   columns (Tel Aviv's pilotis), shop fronts and balconies; colours from palettes per style
   (the White City's whites and creams, limestone, glass tints); floor height and window bay
   width for the facade shader.

**Air bases** (`airbases.py`, `airbases.json`): the buildings inside Tel Nof, Hatzor and Palmachim
are in neither OpenStreetMap nor the Microsoft footprints, so they are traced in the L0 imagery
inside a hand-drawn outline of each base (along its perimeter road). Roof pixels are brighter than
their surroundings at two scales (medians over 56 m and 131 m), unsaturated, in WorldCover's
built-up class, and off the runways (+25 m), taxiways and aprons (+8 m) and existing footprints;
connected roofs of 110-6,000 m² that fill at least 45 % of their oriented box become buildings of
3-10 m (1-3 floors), halls of 8-12 m or vaulted hangars of 11-16 m (over 1,800 m²), in sand, cream
and concrete colours. Each base also gets a control tower (concrete shaft, glass cab; a plausible
place by the runways, not surveyed). 10 m imagery does not resolve small buildings: this gives the
bases' built-up pattern, not their exact buildings. `python3 sim/tools/world/airbases.py --plot
DIR` draws the result over the imagery for review. Tel Nof 385 structures, Hatzor 218,
Palmachim 158.

Output: `index.json` and one `tile_<ix>_<iz>.bin` per terrain L0 tile (6.4 km) with buildings:
222 tiles, 839,394 buildings (759 of them traced at the air bases), 4.2 million footprint vertices,
32.0 MB (gzip; 46.5 MB unpacked).

### Tile format (`tile_<ix>_<iz>.bin`, gzip, little-endian)

64-byte header: `char[4] 'F35B'`, `u16 version (1)`, `u16 header size (64)`, `u8 ix, iz`,
`u8 chunks per side (8)`, `u8 0`, `f32 ox, oz` (origin of the quantised coordinates: the tile's
north-west corner minus 896 m), `f32 quantum (0.125 m)`, `u32 N` (buildings), `u32 R` (rings),
`u32 V` (vertices), `f32 max top`, `f32 min base` (m above sea level), `u32 0`, zero padding.

Then `u32[65]` chunk starts (buildings are sorted by 800 m chunk, then by visibility size) and
these arrays, each padded to 4 bytes:

| array | type | per | meaning |
| --- | --- | --- | --- |
| cx, cz | u16 | building | centre of the oriented box, `ox + cx * quantum` |
| oa, ob | u16 | building | half length / half width of the oriented box (0.05 m) |
| yaw | u16 | building | angle of the long axis from +x towards +z (pi / 65536) |
| base | i16 | building | floor 0: the lowest ground under the footprint (0.1 m) |
| top | u16 | building | apex above floor 0 (0.1 m) |
| minh | u16 | building | bottom of raised parts (bridges, canopies) above floor 0 (0.1 m) |
| ring_n | u16 | ring | vertices per ring (outer ring first, then holes) |
| vx, vz | u16 | vertex | `ox + vx * quantum`; outer rings counter-clockwise on a north-up map, holes clockwise |
| sink | u8 | building | how far the walls reach below floor 0 (0.1 m) |
| rise | u8 | building | roof rise (0.2 m) |
| shape | u8 | building | 0 flat, 1 gabled, 2 hipped, 3 pyramidal, 4 skillion, 5 dome, 6 round (vault) |
| style | u8 | building | wall style (low 4 bits: 0 plaster, 1 stone, 2 glass, 3 office, 4 industrial, 5 house, 6 greenhouse, 7 concrete, 8 public, 9 tower, 10 old stone) + 16 pilotis, 32 shops, 64 balconies |
| rstyle | u8 | building | roof style: 0 residential flat, 1 flat, 2 industrial, 3 tiles, 4 metal, 5 greenhouse, 6 dome, 7 concrete, 8 solar |
| floorh, bay | u8 | building | floor height, window bay (0.05 m) |
| vs | u8 | building | visibility size, log scale 2 m .. 2000 m (`2 * 1000^(vs / 255)`) |
| seed | u8 | building | random seed of the facade |
| floors | u8 | building | floors above ground |
| nrings | u8 | building | rings of the footprint |
| wall, roof | u8 x 3 | building | sRGB colours |

`index.json`: format and version, the source (Overture release, licences, buildings per upstream
data set), the attribution line, per tile its file, count, vertices, sizes, max top and min base,
what was dropped and why, counts per kind / style / shape, and the tallest buildings.

### At run time

`sim/js/world/Buildings.js` (a graphics module of `main.js`) streams the tiles around the camera;
`BuildingsWorker.js` parses them and builds the geometry off the main thread;
`buildingShaders.js` draws them. See the comments at the top of those files and `sim/README.md`.

### Screenshots

```
node sim/tools/world/shots.mjs --port 8140 --scenes tlv300,tlv1500c,jlm,telnof,tlvnight --tag after
```

writes `<scene>_<tag>.png` and `info_<tag>.jsonl` (renderInfo, timing, GPU memory estimate,
building statistics) into `--out` (default `/home/claude/simdata/shots/buildings`); `--query
buildings=0` turns the buildings off, `--query buildingsDebug=1` tints boxes blue and full-detail
chunks red.

## Licences

Overture Maps buildings combine OpenStreetMap (ODbL 1.0, (c) OpenStreetMap contributors) and
Microsoft ML Building Footprints (ODbL 1.0), among others; in the core 491,386 buildings come
from OpenStreetMap and 347,249 from Microsoft. The derived tiles are therefore under the ODbL;
the app credits them in its menu (the `attribution` line of index.json). See
https://docs.overturemaps.org/attribution/. The 759 air base buildings are traced from the
terrain's imagery and land cover (ESA WorldCover 2021, contains modified Copernicus Sentinel data,
CC BY 4.0, credited with the terrain and in the attribution line). Facades, roofs and all other
building detail are procedural (no textures or models).
