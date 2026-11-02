# Vegetation: trees, orchards, palms and shrubs

`js/terrain/Scatter.js` (the module) and `js/terrain/vegetation/` (placement, meshes, impostors,
shaders, worker). A graphics module of `main.js` (`addModule`), drawn with the terrain's sun, sky,
aerial perspective and logarithmic depth. No data files of its own: the trees are placed at run
time from the terrain's own tiles (kept off the world layers' roads and buildings when they are
there), and every mesh and texture is made procedurally at start-up.

Off: `?vegetation=0` or the menu (Options: *Trees, orchards, palms and shrubs*), stored in the
settings (`settings.vegetation`). Quality follows the graphics quality (`setQuality`).

## What it looks like

* **Orchards**: the citrus and avocado blocks of the coastal plain as dense rounded trees in
  regular rows, 4 x 6 m (avocado 5 x 7 m), along each block's long axis (or the field pattern
  around it), cut to the block's edge in the imagery; paths between blocks stay open, often with
  a cypress or eucalyptus hedge. Paler blocks become olive groves (5.5 x 7 m); plantations below
  -150 m (Jordan valley, Dead Sea) date palms (8.5-10 m).
* **Forests**: KKL-JNF Aleppo pine forests (Ben Shemen, Hulda, Sha'ar HaGai, the Jerusalem
  forest) with oak, carob and terebinth (broadleaf) and some cypress; in the lowland pine,
  eucalyptus, broadleaf and cypress. Species come in stands (150 m noise), density follows the
  imagery's greenness and darkness, heights a 260 m vigour noise.
* **Hills**: olive groves on the stone terraces (trees moved onto the contour lines, 2.2-3 m
  steps), garrigue / maquis shrubs between them, in patches (45 m noise) and clumps of one to
  three, never an even sprinkle.
* **Towns**: garden and street trees where the imagery is green between the houses (ficus,
  pine, cypress, citrus, date palms; Washingtonia fan palms near the coast).
* **Farmland**: eucalyptus and cypress windbreaks along the narrow tree lines of the land cover,
  planted 3-4 m apart (kept whole at every quality), a lone tree now and then.
* **Nothing** on runways (+80 m to the sides, +300 m past the ends), no shrubs or lone trees on
  the airfields around them, nothing on water, bare ground, roofs (grey or bright pixels, over
  the crown and at the trunk's own pixel) or in the desert, and nothing on the mapped roads,
  railways, taxiways, aprons or in a building's footprint (the world layers, below): the
  imagery's 6 m pixels cannot resolve a 7-30 m road under a crown, nor a roof that is not grey.

## Data and licences

Read from the terrain tiles the app already streams (`data/terrain/`), in the worker:

| | |
| --- | --- |
| `landcover/tile_X_Z.png` | ESA WorldCover 2021, 10 m classes (tree cover, shrubland, grassland, cropland, built-up, bare, water, wetland) |
| `color/L0/tile_X_Z.jpg` | Sentinel-2 colour, 6.25 m: greenness (ExG = 2G - R - B), brightness, saturation; each tree's colour |
| `height/tile_X_Z.bin` | Copernicus DEM heights, 25 m: ground height, slope, terraces |
| `airports.json` | runways (exclusion zones) |
| `../world/roads/tile_X_Z.bin`, `index.json` | roads and railways (centre lines, widths, classes, bridge decks): no trunk on a carriageway, a crown not over a main road |
| `../world/airfields/airfields.json` | taxiways and aprons |
| `../world/buildings/` | building footprints (and heights): no tree in a building, a crown not into a wall |

ESA WorldCover 2021 and the Sentinel-2 imagery: © ESA WorldCover project 2021 / Contains
modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium, CC BY 4.0. The
DEM: Copernicus DEM GLO-30 (see the terrain's credits). The world layers (when they are there:
without them only the imagery keeps the trees off roads and roofs): roads, railways, airfield
surfaces © OpenStreetMap contributors, buildings © OpenStreetMap contributors and Microsoft ML
Buildings, all ODbL 1.0, via Overture Maps Foundation (release 2026-10-21.0). The module adds
its line to the menu's credits (`attribution`). The species, their proportions and where they
grow are general botanical knowledge of the region (KKL-JNF forests, the citrus belt of the coastal plain, the
olive terraces of the Judean and Samarian hills, the date plantations of the rift); no
copyrighted pictures, models or textures are used.

## Placement (`vegetation/placement.js`, `vegetation/worker.js`)

Per 6.4 km tile, once (`analyseTile`, about 0.25 s): the obstacles of the tile and its
neighbours (`vegetation/obstacles.js`, 0.3-0.5 s: road and railway segments with their widths
and classes, taxiways, aprons and building footprints in a 32 m bucket grid). A tree is refused
closer to a road's or railway's paved edge than its class's clearance (a fixed distance plus a
share of the crown radius: a motorway or a railway keeps its verge clear, a town street lets
the crowns hang over the sidewalk, a dirt track runs right past an orchard), on a taxiway's strip
or by an apron, or with its trunk or half its crown inside a building's walls; under a bridge
deck only if it fits under it. Then per 10 m pixel the imagery's greenness,
brightness and saturation, the height and slope, and the land cover of the neighbourhood
(summed-area tables: built-up, cropland, tree cover around); the orchard and palm plantation
blocks (flat, lowland, very green and dark tree cover, 4-connected components of an eroded mask)
with their row direction (the block's moments, or the field pattern of the 1.6 km around it
when the block is square); the airport zones.

Per 200 m cell (`generateCell`, 0.15-0.3 ms): the trees of every 10 m pixel by its class
(rules above). Deterministic: every random number comes from the cell's or the row's own
seed, so a cell has the same trees whatever the order of requests. Each tree is 20 bytes:
position (float32 x, y, z; y = ground - 0.25 m, the heights interpolated as the terrain draws
its triangles), species | variant | the imagery's weight in its colour (3 bits), height
(0.125 m steps), crown width factor, rotation, the colour under the crown, and a rank (uniform
0..255) that thins the trees with the quality and with distance.

The colour: where the imagery is green the tree takes the imagery's mean over its crown
(blended with the species' own colour by the species' `tint`, more so with distance: at 1.5 km
a forest has the colour of the ground it stands on), else the species' colour (a lone tree in a
ploughed field must not take the field's colour). The shaders apply it as a ratio to the
species' colour, so a crown keeps its light and dark sprays. Where the colour came from the
imagery, the imagery already shows the canopy's shade, so that tree's ground shadow is lighter.

## Species (`vegetation/species.js`, `vegetation/meshes.js`)

| species | height m | where |
| --- | --- | --- |
| Aleppo pine | 8-18 | KKL forests, hills and lowland |
| olive | 3.5-6.5 | terraces, groves, lone trees |
| citrus / avocado | 3-4.6 (avocado 5-7.5) | orchards of the coastal plain |
| broadleaf (ficus, plane, carob, oak, tamarisk) | 5-12 | towns, forests, lone trees |
| date palm | 6-15 | rift plantations, kibbutz and town gardens |
| Italian cypress | 8-17 | hedges, windbreaks, cemeteries, gardens |
| eucalyptus (river red gum) | 15-30 | windbreaks, roadsides, lowland stands |
| shrubs (garrigue, maquis) | 0.5-2.2 | rocky slopes, grassland |
| Washingtonia fan palm | 10-22 | coastal towns |

Each species has a procedural low-poly mesh in two variants (seeded): a trunk tube along a bent
polyline, branches, foliage clumps (icospheres displaced by noise), palm fronds (V-folded strips
with a leaflet pattern), fan leaves; at two levels of detail, the same tree (the same random
numbers, so the same clumps in the same places) with coarser clumps further out (full 310-3,400
triangles, reduced 80-740). The Aleppo pine: a trunk bare to almost half its height, seven or
eight branches climbing out of it with tufts of needles along their outer two thirds and at
their ends (tilted with the branch, frayed rims, darker inside and underneath), an open dome
with sky between the clusters. The river red gum: a pale trunk forking at a third of its height
into three or four steep limbs that fork again, 28-34 small drooping masses of grey-green leaves
on their outer half, the crown's middle open. Per vertex: albedo, ambient
occlusion (rays against the other clumps and the trunk, the depth in the crown), the part, the
sway weight. The foliage's lighting normal is bent towards the crown's own radial direction, so
a crown shades as one rounded mass; the fragment shader cuts the clumps' edges ragged with a
leafy noise (alpha to coverage).

## Drawing (`Scatter.js`, `vegetation/shaders.js`, `vegetation/impostors.js`)

* **Impostors**: every tree in range is one camera-facing quad in a single draw (an instanced
  buffer, slab-allocated per cell, culled in the vertex shader). The atlas is rendered at
  start-up from the full meshes: per model 6 elevation frames (0-90 degrees), albedo + coverage
  and normal + depth + ambient occlusion, 2x supersampled, colour dilated, coverage-preserving
  mips (distant trees keep their density). Per pixel: the frame for the view's elevation
  (blended), normal-mapped lighting, a depth offset into the logarithmic depth buffer (trees
  intersect each other and the ground properly), mirrored by rank.
* **Near meshes**: the trees within 100-150 m (quality) as instanced meshes, one per species,
  variant and level of detail (36 draws at most): the full mesh within 30-60 m, the reduced one
  beyond (each tree at its own jittered distance), rebuilt on the CPU when the camera has moved
  15 m. They fade into the impostors over an 8-10 m band, the range jittered per tree: by alpha
  to coverage where the target is multisampled (the canvas, or a post chain's target), staggered
  so the tree never thins (the impostor stays whole while the mesh comes in, then fades out
  under it; the resolve blends them, no screen-door pattern), else with complementary dither.
* **Thinning and streaming**: past the near range the trees thin out by rank towards the far
  range, each over a band, the planted rows and shrubs earlier (the imagery shows them). The
  far range grows with the height above the ground (2-4.2 km near the ground, up to twice that
  from a cruise: the same reach over the ground). A cell uploads only the trees that can be
  seen from its distance (the far fade's thinning, counting the margin the camera may close in
  before the cell is looked at again) and more of them as the camera comes closer, so the
  buffer holds about half of what an upload of every tree in range would. An upload that does
  not fit evicts the cells no longer wanted, then the farthest (they come back when there is
  room), compacts the buffer and tries again; only when nearer trees fill it does the far range
  shrink until they fit (`statsJSON().uploadFailures` counts these).
* **Skipped draws**: the impostors and the ground shadows are not drawn when no cell with trees
  is in the view (from a cruise the trees below are out of the chase view), the ground shadows
  not above their range or with the sun down.
* **The terrain's painted crowns**: a terrain that paints tree crowns into its ground for the
  far view (`terrain.setVegetationCover`, when it has it) is told where the 3D trees stand: plain
  forest floor under them out to 38 % of the far range (every forest tree is drawn there), its
  crowns coming back over the rest of the range as the trees thin out; switched off, the
  painted crowns are back at once. Without it the near forests would be drawn twice.
* **Lighting** (shared by meshes and impostors): the environment's sun irradiance at the tree
  (`atmoSunIrradianceAt`), none where the hillside the tree stands on faces away from a low sun,
  and none behind the hills when the terrain has horizon maps (`terrain.horizon`: the terrain's
  `HORIZON_GLSL` is put into the vegetation's vertex shaders); in a stand (forest, orchard: the
  imagery gave the colour) the lower part of each crown is in its neighbours' shade at a low
  sun (a neighbour of the same height about a crown width away); wrapped diffuse, the sun
  reaching the inside of the crown less, translucency against the sun (the rim of a backlit
  crown glows), sky and ground light, a faint sheen on waxy leaves (citrus, olive), the
  terrain's aerial perspective (`atmoAerialParts`).
  Wind: slow sway of the crowns and fast leaf shiver, gusts travelling over the land.
* **Shadows**, one per tree: where the sun's shadow map covers the ground around the camera
  (the lighting's wide box near the ground) the near meshes within 60-80 m that lie wholly
  inside it cast into it (`vegCasts`, the same test in the depth pass and in the decal shader)
  and have no ground decal; every other tree drops a ground shadow: its silhouette from the
  sun's frame of the atlas, projected along the sun onto the ground and draped on the terrain's
  heights (one draw, the same instance buffer, up to 0.9-2.4 km). They follow the sun down to
  its last degree: the long shadows of the golden hour, up to 20 tree heights for a lone tree,
  6 in a stand (where they merge into one shade). Shadows darken towards the sky's light, not
  to black. Meshes and impostors receive the shadow map with a normal offset (no acne).

Start-up is spread over frames (a few ms each; 40 ms behind the menu): the 36 meshes, the
materials, the programs (compiled in parallel where the browser has
`KHR_parallel_shader_compile`), the atlas up to three models per frame, their frames read back
asynchronously (a pixel buffer and a fence: the GPU is never waited for), its mips a few layers
per frame. Placement starts at once in the worker; trees appear when the atlas is done. A
quality change bakes the new atlas the same way while the old one is drawn. Switched off (menu
or `setOption`) for 10 s, the module frees its buffers, meshes, atlas and worker (30 MB at
medium); switched on, it starts up again.

## Quality

| | low | medium | high |
| --- | --- | --- | --- |
| trees kept | 45 % (no shrubs) | 70 % | 100 % |
| near meshes: full / reduced to | 30 / 100 m | 45 / 110 m | 60 / 150 m |
| fade into the impostors over | 8 m | 8 m | 10 m |
| impostors to (near the ground) | 2,000 m | 3,000 m | 4,200 m |
| ground shadows to | 900 m | 1,600 m | 2,400 m |
| trees casting into the shadow map (when it covers them) | none | 60 m | 80 m |
| instance buffer (slots) | 200,000 | 400,000 | 800,000 |
| near mesh buffers (trees per model) | 3,000 | 6,000 | 10,000 |
| atlas frame | 96 px (10.1 MB) | 128 px (18 MB) | 128 px (18 MB) |

The near meshes shorten their range by themselves if a dense forest overflows their buffers.
Tuning at run time (console): `app.modules.find((m) => m.isScatter).tuning`
(`tintGain`, `wind`, `brightness`, `shadowStrength`).

## Cost

Draw calls: 2 (impostors, ground shadows); 1 above the ground shadows' range or with the sun
down; none when no cell with trees is in the view (from a cruise the trees below are out of the
chase view). Near the ground one more per species, variant and level of detail with trees in
the mesh range (36 at most), and the same again into the sun's shadow map for the trees that
cast. GPU memory (`statsJSON().memMB`): the atlas (10.1 MB at low, 18 MB at medium and high),
the instance buffer (20 bytes a slot: 3.8 / 7.6 / 15.3 MB), the near meshes' buffers (1.4 /
2.9 / 4.8 MB) and the meshes (1.1 MB): 16.5 / 29.6 / 39.2 MB, all of it freed when the trees
have been off for 10 s (the app's estimate, `gpuMemory()`, at medium: 670 MB then, 700 MB with
the trees).

`tests/vegetation_shots.mjs --ab` (the same frame with and without the trees, 960 x 540), at
low / medium / high, before -> after the fixes of the review (a cell now uploads only the trees
that can be seen from its distance; the near meshes have two levels of detail):

| scene | trees uploaded | draw calls | triangles (three's count) |
| --- | --- | --- | --- |
| Tel Nof 36, chase | 7,700 / 27,800 / 98,800 -> 5,000 / 12,000 / 26,600 | +4 / +5 / +15 -> +3 / +7 / +17 | +0.03 / +0.12 / +0.47 -> +0.02 / +0.05 / +0.14 M |
| citrus blocks, 150 m | 20,000 / 66,500 / 153,700 -> 11,900 / 27,500 / 56,000 | +2 | +0.08 / +0.27 / +0.62 -> +0.05 / +0.11 / +0.22 M |
| Ben Shemen, 600 m | 25,000 / 93,500 / 235,300 -> 12,700 / 37,500 / 84,100 | +2 | +0.10 / +0.37 / +0.94 -> +0.05 / +0.15 / +0.34 M |
| Jerusalem forest, 600 m | 78,300 / 270,800 / 693,600 -> 45,900 / 118,500 / 243,200 | +2 | +0.31 / +1.08 / +2.77 -> +0.18 / +0.47 / +0.97 M |
| sunset over the hills, 200 m | 99,500 / 306,900 / 864,700 -> 48,600 / 130,600 / 282,500 | +2 / +2 / +13 -> +2 / +2 / +8 | +0.40 / +1.23 / +3.55 -> +0.19 / +0.52 / +1.13 M |
| cruise, 3,000 m | 39,600 (medium) -> 8,700 / 20,200 / 41,800, none in view | +1 -> 0 | +0.16 -> 0 M |

The triangles are 2 per uploaded tree for the impostors and 2 for the ground shadows: the
vertex shader drops the trees outside the view, beyond their range or drawn as meshes before
any lighting work, so most of them never reach the rasteriser. SwiftShader (a CPU rasteriser,
on a machine shared with other jobs: a rough ratio only) takes 0.9-1.3 times as long for the
whole frame with the trees at low and medium (the reviewer measured up to 2.7 at medium in the
Jerusalem forest), 2.5-2.7 at high in the densest forests and at sunset. There the cost is in
the pixels, not the vertices: the impostors' overdraw and, at a low sun, the long ground
shadows of a forest overlapping (up to about 16 layers); the uploads only dropped trees that
were not drawn anyway. Estimated from these counts for an RTX 3070 at 1440p: 0.1-0.2 ms over
open country, about 0.3-0.6 ms at medium and 0.5-1.2 ms at high over the densest forests at
sunset (`?bench=1` with and without `vegetation=0` gives the real number).

## Tests

`node sim/tests/vegetation_shots.mjs [--quality medium] [--only telnof_chase,orchards_150]
[--tag t1]` takes the scenes (Tel Nof 36 cockpit and chase, the citrus blocks west of Tel Nof
at 150 m, Ben Shemen and the Jerusalem forest at 600 m, 3,000 m cruise, Tel Aviv at 300 m,
Kalia's palms, sunset over the hills) with the frame statistics and the module's own
(`statsJSON()`), waiting until the module is idle (`idle()`). `--ab` draws every scene with and
without the trees in the same page (draw calls, triangles, time; `<scene>_off.png`);
`--params vegetation=0` loads the app without the module. Free-camera scenes (`free_*`: the jet
parked out of the way) look at single trees, a gum line, a forest road, windbreaks and the
forests from 10-60 m. `--shadow-radius 190` gives the sun's shadow map the lighting track's wide
box near the ground (the `dbl_*` scenes: each tree's shadow once) and `--decal-ab` measures how
much of each frame the ground shadows darken (`<scene>_nodecal.png`, the same frame without
them). `--cover-ab` (with a terrain that paints crowns) saves each scene again with the
terrain's crowns left under the trees (`<scene>_nocover.png`); `--root DIR` serves another
checkout of `sim/` (a trial merge with the terrain track's branch). `--checks` changes the
quality (the atlas baked again over frames: the longest module update), then switches the
trees off for 11 s (the memory freed) and on again. `--long` flies
10 km at 250 m above the foothills into the Jerusalem hills at 250 m/s (each 1 km leg started
again 250 m above the ground, the hills rise faster than a hands-off jet climbs): no upload may
fail and the queue must drain (at high: none failed, the buffer's high water 600,000 of 800,000).
The placement rules run in node too (`placement.js` has no DOM;
`tests/vegetation_placement.test.mjs` counts the trees kept off roads and buildings).
