# sim/tools/world: world data beside the terrain

Builders for what stands on the terrain of the flight sim. Each one writes into
`sim/data/world/<what>/` (not in git, like `sim/data/terrain/`) and needs the terrain data
(`sim/data/terrain/`, built by `sim/tools/terrain`) because objects are placed on its heights.

| file | what |
| --- | --- |
| `overture.py` | reads any theme / type of the [Overture Maps](https://overturemaps.org/) open data release for the core's lon / lat box (GeoParquet on a public S3 bucket, HTTP range requests on row-group bbox statistics) and caches the rows |
| `buildings.py` | 3D buildings: `sim/data/world/buildings/` (this page) |
| `geom.py` | polygon helpers (WKB parsing, cleaning, oriented boxes, point in polygon) |
| `volumes.py` | building volumes for `buildings.py`: parts and their outline, raised volumes onto what holds them up, duplicates |
| `airbases.py`, `airbases.json` | the buildings of Tel Nof, Hatzor and Palmachim, traced in the imagery (below) |
| `shots.mjs` | screenshots of the scenes the buildings are judged by (Playwright, `window.__sim`) |
| `shore.py` | breakwaters, quays, piers, the container cranes of Ashdod and the Dead Sea south basin's buildings: `sim/data/landscape/shore.json` (below) |

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

**tiles** (~14 min on 4 cores):

1. Footprints are projected into the sim's frame (`sim/tools/terrain/grid.py`), cleaned (duplicate
   and collinear points, Douglas-Peucker 0.5 m, which keeps right angles) and dropped when
   underground, outside the core, tiny or slivers (< 6 m², thinner than 1.4 m, or walls: thinner
   than 3.2 m and longer than 24 m), on a runway with its overruns and 15 m shoulders
   (airports.json) or in the sea / the Dead Sea (land cover).
2. Ground: the terrain's heights at the footprint's vertices and inside it, with exactly the
   interpolation of `HeightField.heightAt` (25 m grid, cells split NW-SE). Floor 0 is the lowest
   ground point (`base`); the walls reach `sink` below it (0.6 m + a quarter of the slope's rise).
3. Height: the tagged `height` or `num_floors` (2 % of the buildings carry one), else by
   kind, area and context: the mean floors of tagged neighbours (~1 km window, towers left out),
   the building density, named regions (Tel Aviv centre and Gush Dan 4-8 floors, Bnei Brak, Jerusalem, Modiin,
   Ramallah ...), so suburbs come out at 2-4 floors, kibbutzim and moshavim at 1-2, industrial
   halls at 7-12 m, hangars at 10-15 m, greenhouses at 4-5 m, sheds at about 3 m. The rules for
   big low halls only apply to low buildings: a tagged tower is never an industrial hall, nor a
   "greenhouse" over 15 m. Stacks are recognised by their shape (40 m or more, no floors, slender:
   height over 6 diameters, round: 8 or more vertices filling 70-86 % of their box): the
   chimneys of the Rutenberg (Ashkelon, 250 m), Eshkol (Ashdod) and Reading (Tel Aviv) power
   stations.
4. Roof: `roof_shape` when tagged; else pitched (hipped or gabled, 28-36 degrees) for houses
   whose roof looks reddish in the imagery, barrel vaults for hangars, flat otherwise. The roof
   colour is the L0 imagery (6.25 m / px) under the footprint, cleaned of tree green; clay tiles
   on most pitched roofs.
5. Walls: a style per building (plaster, Jerusalem stone, old stone, curtain-wall glass, office,
   tower, industrial, house, public, concrete, greenhouse, stack, hangar) from the class, the
   region (the Jerusalem stone law, old Jaffa, the Old City) and the height; flags for an open
   ground floor on columns (Tel Aviv's pilotis), shop fronts and balconies; colours from palettes
   per style (the White City's whites and creams, limestone, glass tints). Tagged facade colours
   (a mapper's pick from a short list: pure #0000FF, #FF0000 ...) are tamed: saturation at most
   0.45, value at most 0.85 (0.93 for greys), then 40 % of the style's base colour mixed in.
   Floor height and window bay width for the facade shader; the floors count up to the eaves
   from the lowest ground, so on a slope the windows still reach the top.
6. `OVERRIDES` (by Overture id) for what the tags get wrong: the Azrieli Spiral (tagged finished
   at 350 m, under construction until 2028) is drawn as a bare concrete frame of 60 floors
   (235 m) with its curtain wall nine floors behind; the Dome of the Rock's faience octagon and
   gilded dome.
7. Volumes (`volumes.py`). OpenStreetMap's simple 3D buildings draw a building from its parts,
   and mappers often map only some of them (the crown and a few floors of a tower): the parts
   stay, every member of the building shares one ground reference, and the outline fills what
   they leave out: the plan area no part covers, and band by band the floors under a part that
   nothing holds up (fillers thinner than 3 m are mapping slack, dropped). Then duplicates go:
   near-identical footprints (OpenStreetMap and Microsoft's ML footprint of one building, doubled
   mapping; IoU > 0.8) keep the better one, a volume hidden inside another is dropped, and
   overlapping volumes that remain are flagged so the runtime steps the lesser one's walls in by
   0.3 m (no coplanar walls fighting in the depth buffer); two tall volumes mostly inside each
   other are one tower mapped twice and share one facade. Last, bottom up, any raised volume
   (more than 3 m off the ground) still standing on nothing is lowered onto what is under it, or
   dropped if it is a small piece high up (a rooftop fragment whose tower is not mapped).

Every build checks itself and stops when a check fails: no raised volume more than 5 m above
what is under it (`volumes.floating`), no air base structure on a runway strip, taxiway or apron
(`airbases.intrusions`). It prints the 30 tallest buildings with their styles and the landmarks of
`EXPECTED_TALL` (found by position, +-12 % of their height from the List of tallest buildings in
Israel): Azrieli Sarona, Moshe Aviv, the Azrieli round tower, ToHa 2, the Beyond office tower,
the Spiral's frame and the Rutenberg stacks.

**Air bases** (`airbases.py`, `airbases.json`): the buildings inside Tel Nof, Hatzor and Palmachim
are in neither OpenStreetMap nor the Microsoft footprints, so they are traced in the L0 imagery
inside a hand-drawn outline of each base (along its perimeter road). Roof pixels are brighter than
their surroundings at two scales (medians over 56 m and 131 m), unsaturated, in WorldCover's
built-up class, and off the runways (+25 m), taxiways and aprons (+8 m) and existing footprints;
connected roofs of 110-6,000 m² that fill at least 45 % of their oriented box become buildings of
3-10 m (1-3 floors), halls of 8-12 m or vaulted hangars of 11-16 m (over 1,800 m²), in sand, cream
and concrete colours. The boxes are then held clear of the paving exactly: nothing within 75 m of
a runway centre line (the graded strip, to 60 m past the overruns), within 7.5 m beyond a
taxiway's shoulders, or on an apron; a box reaching in is cut back from that side, or dropped.
Halls and hangars are clad in steel sheet without windows (style `hangar`), their doors (leaves
under the box beam of their track) in the wall facing the nearest apron or taxiway. Each base also
gets a control tower (concrete shaft, glass cab; a plausible place by the runways, not surveyed).
10 m imagery does not resolve small buildings: this gives the bases' built-up pattern, not their
exact buildings. `python3 sim/tools/world/airbases.py --plot DIR` draws the result over the
imagery for review. Tel Nof 382 structures, Hatzor 208, Palmachim 154.

Output: `index.json` and one `tile_<ix>_<iz>.bin` per terrain L0 tile (6.4 km) with buildings:
222 tiles, 835,734 buildings (744 of them traced at the air bases), 4.2 million footprint vertices,
32.0 MB (gzip; 46.3 MB unpacked).

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
| minh | u16 | building | bottom of raised volumes (bridges, canopies, the parts of a tower) above floor 0 (0.1 m; 0: on the ground) |
| ring_n | u16 | ring | vertices per ring (outer ring first, then holes) |
| vx, vz | u16 | vertex | `ox + vx * quantum`; outer rings counter-clockwise on a north-up map, holes clockwise |
| sink | u8 | building | how far the walls reach below floor 0 (0.1 m) |
| rise | u8 | building | roof rise (0.2 m) |
| shape | u8 | building | 0 flat, 1 gabled, 2 hipped, 3 pyramidal, 4 skillion, 5 dome, 6 round (vault) |
| style | u8 | building | wall style (low 4 bits: 0 plaster, 1 stone, 2 glass, 3 office, 4 industrial, 5 house, 6 greenhouse, 7 concrete, 8 public, 9 tower, 10 old stone, 11 stack, 12 hangar, 13 frame: a tower under construction) + 16 pilotis, 32 shops, 64 balconies, 128 inset (the volume overlaps another: its walls step in by 0.3 m). A hangar reads 16 as "doors on the - side" and 32 as "doors in an end wall (facing along the long axis a), not a long side" |
| rstyle | u8 | building | roof style: 0 residential flat, 1 flat, 2 industrial, 3 tiles, 4 metal, 5 greenhouse, 6 dome, 7 concrete, 8 solar, 9 gilded |
| floorh, bay | u8 | building | floor height, window bay (0.05 m); a hangar's floor height is its door height |
| vs | u8 | building | visibility size, log scale 2 m .. 2000 m (`2 * 1000^(vs / 255)`) |
| seed | u8 | building | random seed of the facade |
| floors | u8 | building | floors from floor 0 to the eaves; a stack's height in 2 m steps |
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

## Shore structures (`shore.py`)

```
python3 sim/tools/world/shore.py --out sim/data/landscape [--cache DIR] [--release latest]
```

The terrain draws the coast from imagery on a 25 m grid, so a 15 m wide breakwater 800 m out
to sea was a few sea-coloured pixels and the ports had nothing standing in them. This writes the
coast's structures between Ashkelon and Herzliya as small 3D data for `js/world/Shore.js`
(about 80 kB, a few seconds from the Overture cache):

* **breakwaters** (Overture `base/infrastructure` class `breakwater` / `groyne`, from
  OpenStreetMap): the mapped outline is the footprint at sea level, the crest the outline
  inset along the vertex bisectors by the slope's run (1 : 1.5), never more than 42 % of the
  local width, at a height by size: the short detached breakwaters off the Tel Aviv and Bat Yam
  beaches 1.8 m, marinas 4-5 m, the Ashdod main breakwater 6.5 m. The few mapped as lines
  become 8-12 m wide mounds. Each footprint edge gets its exposure to the swell (`exp`, 0-100):
  how far it faces the west-north-west (285 deg, the open Mediterranean's fetch), 0 where
  another structure lies within 1.5 km in that direction (a port's inner faces). The white
  water is drawn there.
* **decks** (class `pier` / `quay`): polygons become decks 1.2 m (piers) or 2 m (quays) above
  the sea with vertical sides; lines become 2.5-4 m wide jetties and marina pontoons
  (0.9-1.5 m).
* **cranes**: 25 ship-to-shore container cranes at Ashdod, spaced along six container quays
  (`CRANE_QUAYS`: edges of the OSM coastline, which follows the quay walls, picked against the
  Sentinel-2 imagery where the container stacks are), the boom toward the side the ocean
  polygon is on, about a third with the boom raised. Their size follows the port's published
  figures (44 m lift height, 60.5 m outreach); the build only places them, `Shore.js` models
  them.
* **blocks**: the buildings of the Dead Sea's south basin, outside the core whose buildings
  `buildings.py` builds: the hotels of Ein Bokek and Hamei Zohar, Neve Zohar and the Dead Sea
  Works at Sdom (Overture `buildings/building` in 35.30-35.45 E, 31.00-31.24 N; footprints
  under 40 m^2 dropped). Kind 0 hotels and apartment blocks (footprints over 900 m^2 or 4+
  levels), 1 industry (south of 31.075 N: the works), 2 houses. Heights: OSM's levels where
  mapped (23 of ~1,700 footprints), else a guess by kind and footprint (hotels 5-10 floors,
  sheds 6-22 m, houses 1-2 floors); `Shore.js` stands them on the terrain's heights.

Output `shore.json` (format `f35i-shore` v1): world metres (sim/DESIGN.md), rings with signed
area < 0 (`geom.py`):

```
{ "breakwaters": [ { "foot": [[x, z], ...], "crest": [[x, z], ...], "h": 1.8, "exp": [0..100 per edge] } ],
  "decks":       [ { "ring": [[x, z], ...], "h": 2.0 } ],
  "cranes":      [ { "x": .., "z": .., "heading": rad from north toward east (the boom), "boom_up": false, "variant": 0 } ],
  "blocks":      [ { "ring": [[x, z], ...], "h": 24.6, "kind": 0 } ],
  "attribution": "..." }
```

Counts of the current build: 48 breakwater polygons and 11 lines, 19 decks, 100 jetties and
pontoons, 25 cranes, 1,014 blocks (45 hotels, 520 industrial, 449 houses); 219 kB. At run time
`js/world/Shore.js` builds one mesh per 8 km area from it (plus the white water bands and the
cranes' obstruction lights); see that file and `sim/README.md`. Without the file the app runs
as before. The buildings are read with `overture.fetch('buildings', 'building', ...)` for the
box above (~5 minutes the first time: the footers of all 512 files), cached beside the base
theme in `--cache`.

## Licences

Overture Maps buildings combine OpenStreetMap (ODbL 1.0, (c) OpenStreetMap contributors) and
Microsoft ML Building Footprints (ODbL 1.0), among others; in the core 491,386 buildings come
from OpenStreetMap and 347,249 from Microsoft. The derived tiles are therefore under the ODbL;
the app credits them in its menu (the `attribution` line of index.json). See
https://docs.overturemaps.org/attribution/. The 759 air base buildings are traced from the
terrain's imagery and land cover (ESA WorldCover 2021, contains modified Copernicus Sentinel data,
CC BY 4.0, credited with the terrain and in the attribution line). Facades, roofs and all other
building detail are procedural (no textures or models).

The shore structures and the south basin's blocks (`shore.py`) come from the same Overture
release (OpenStreetMap, ODbL 1.0, (c) OpenStreetMap contributors; the buildings theme as
above), credited by the `attribution` line of `shore.json`; the
crane positions are picked against the terrain's Sentinel-2 imagery (CC BY 4.0), the cranes'
shape and colours are made up.
