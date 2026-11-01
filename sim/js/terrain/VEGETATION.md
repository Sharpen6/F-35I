# Vegetation: trees, orchards, palms and shrubs

`js/terrain/Scatter.js` (the module) and `js/terrain/vegetation/` (placement, meshes, impostors,
shaders, worker). A graphics module of `main.js` (`addModule`), drawn with the terrain's sun, sky,
aerial perspective and logarithmic depth. No data files: the trees are placed at run time from the
terrain's own tiles, and every mesh and texture is made procedurally at start-up.

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
  steps), garrigue / maquis shrubs between them.
* **Towns**: garden and street trees where the imagery is green between the houses (ficus,
  pine, cypress, citrus, date palms; Washingtonia fan palms near the coast).
* **Farmland**: eucalyptus and cypress windbreaks along the narrow tree lines of the land cover,
  a lone tree now and then.
* **Nothing** on runways (+80 m to the sides, +300 m past the ends), no shrubs or lone trees on
  the airfields around them, nothing on water, bare ground, roads, roofs (grey or bright pixels)
  or in the desert.

## Data and licences

Read from the terrain tiles the app already streams (`data/terrain/`), in the worker:

| | |
| --- | --- |
| `landcover/tile_X_Z.png` | ESA WorldCover 2021, 10 m classes (tree cover, shrubland, grassland, cropland, built-up, bare, water, wetland) |
| `color/L0/tile_X_Z.jpg` | Sentinel-2 colour, 6.25 m: greenness (ExG = 2G - R - B), brightness, saturation; each tree's colour |
| `height/tile_X_Z.bin` | Copernicus DEM heights, 25 m: ground height, slope, terraces |
| `airports.json` | runways (exclusion zones) |

ESA WorldCover 2021 and the Sentinel-2 imagery: © ESA WorldCover project 2021 / Contains
modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium, CC BY 4.0. The
DEM: Copernicus DEM GLO-30 (see the terrain's credits). The module adds its line to the menu's
credits (`attribution`). The species, their proportions and where they grow are general
botanical knowledge of the region (KKL-JNF forests, the citrus belt of the coastal plain, the
olive terraces of the Judean and Samarian hills, the date plantations of the rift); no
copyrighted pictures, models or textures are used.

## Placement (`vegetation/placement.js`, `vegetation/worker.js`)

Per 6.4 km tile, once (`analyseTile`, about 0.25 s): per 10 m pixel the imagery's greenness,
brightness and saturation, the height and slope, and the land cover of the neighbourhood
(summed-area tables: built-up, cropland, tree cover around); the orchard and palm plantation
blocks (flat, lowland, very green and dark tree cover, 4-connected components of an eroded mask)
with their row direction (the block's moments, or the field pattern of the 1.6 km around it
when the block is square); the airport zones.

Per 200 m cell (`generateCell`, 0.15-0.3 ms): the trees of every 10 m pixel by its class
(rules above). Deterministic: every random number comes from the cell's or the row's own
seed, so a cell has the same trees whatever the order of requests. Each tree is 20 bytes:
position (float32 x, y, z; y = ground - 0.25 m, the heights interpolated as the terrain draws
its triangles), species | variant, height (0.125 m steps), crown width factor, rotation, the
imagery's colour under the crown, and a rank (uniform 0..255) that thins the trees with the
quality and with distance.

The colour: where the imagery is green the tree takes the imagery's mean over its crown
(blended with the species' own colour by the species' `tint`), else the species' colour (a lone
tree in a ploughed field must not take the field's colour).

## Species (`vegetation/species.js`, `vegetation/meshes.js`)

| species | height m | where |
| --- | --- | --- |
| Aleppo pine | 7-14 | KKL forests, hills and lowland |
| olive | 3.5-6.5 | terraces, groves, lone trees |
| citrus / avocado | 3-4.6 (avocado 5-7.5) | orchards of the coastal plain |
| broadleaf (ficus, plane, carob, oak, tamarisk) | 5-12 | towns, forests, lone trees |
| date palm | 6-15 | rift plantations, kibbutz and town gardens |
| Italian cypress | 8-17 | hedges, windbreaks, cemeteries, gardens |
| eucalyptus (river red gum) | 14-28 | windbreaks, roadsides, lowland stands |
| shrubs (garrigue, maquis) | 0.5-2.2 | rocky slopes, grassland |
| Washingtonia fan palm | 10-22 | coastal towns |

Each species has a procedural low-poly mesh in two variants (seeded): a trunk tube along a bent
polyline, branches, foliage clumps (icospheres displaced by noise, 300-1,350 triangles a tree),
palm fronds (V-folded strips with a leaflet pattern), fan leaves. Per vertex: albedo, ambient
occlusion (rays against the other clumps and the trunk, the depth in the crown), the part, the
sway weight. The foliage's lighting normal is bent towards the crown's own radial direction, so
a crown shades as one rounded mass; the fragment shader cuts the clumps' edges ragged with a
leafy noise (alpha to coverage).

## Drawing (`Scatter.js`, `vegetation/shaders.js`, `vegetation/impostors.js`)

* **Impostors**: every tree in range is one camera-facing quad in a single draw (an instanced
  buffer of 520,000 slots at medium, slab-allocated per cell, culled in the vertex shader). The
  atlas is rendered at start-up from the meshes: per model 6 elevation frames (0-90 degrees),
  albedo + coverage and normal + depth + ambient occlusion, 2x supersampled, colour dilated,
  coverage-preserving mips (distant trees keep their density). Per pixel: the frame for the view's
  elevation (blended), normal-mapped lighting, a depth offset into the logarithmic depth buffer
  (trees intersect each other and the ground properly), mirrored by rank.
* **Near meshes**: the trees within 70-160 m (quality) as instanced meshes, one per species and
  variant (18 draws at most), rebuilt on the CPU when the camera has moved 15 m. They fade into
  the impostors over a band with complementary dither (no pop, no double drawing), the range
  jittered per tree.
* **Thinning**: past the near range the trees thin out by rank towards the far range (2-4.2 km),
  each over a band, the planted rows and shrubs earlier (the imagery shows them).
* **Lighting** (shared by meshes and impostors): the environment's sun irradiance at the tree
  (`atmoSunIrradianceAt`), wrapped diffuse, the sun reaching the inside of the crown less,
  translucency against the sun (the rim of a backlit crown glows), sky and ground light, a faint
  sheen on waxy leaves (citrus, olive), the terrain's aerial perspective (`atmoAerialParts`).
  Wind: slow sway of the crowns and fast leaf shiver, gusts travelling over the land.
* **Shadows**: near the jet the meshes are drawn into the sun's shadow map (when it covers more
  than the aircraft) and receive it; elsewhere every tree drops a ground shadow: its silhouette
  from the sun's frame of the atlas, projected along the sun onto the ground and draped on the
  terrain's heights (one draw, the same instance buffer, up to 0.9-2.4 km). Shadows darken
  towards the sky's light, not to black.

Start-up is spread over frames (a few ms each; 40 ms behind the menu): the 18 meshes, the
materials, the programs (compiled in parallel where the browser has
`KHR_parallel_shader_compile`), the atlas one model per frame, its mips a few layers per frame.
Placement starts at once in the worker; trees appear when the atlas is done.

## Quality

| | low | medium | high |
| --- | --- | --- | --- |
| trees kept | 45 % (no shrubs) | 70 % | 100 % |
| near meshes | 70 m | 110 m | 160 m |
| impostors to | 2,000 m | 3,000 m | 4,200 m |
| ground shadows to | 900 m | 1,600 m | 2,400 m |
| instance buffer | 260,000 | 520,000 | 900,000 |
| atlas frame | 64 px (4.5 MB) | 128 px (18 MB) | 128 px (18 MB) |

The near meshes shorten their range by themselves if a dense forest overflows their buffers.
Tuning at run time (console): `app.modules.find((m) => m.isScatter).tuning`
(`tintGain`, `wind`, `brightness`, `shadowStrength`).

## Cost

See the numbers in the track's report (renderInfo / gpuMemory before and after, per quality).
Draw calls: 2 (impostors, ground shadows) + up to 18 near meshes (+ up to 18 into the shadow
map). Memory: the atlas (18 MB at medium / high), the instance buffer (20 bytes a slot: 10 MB
at medium, 18 MB at high), the near meshes' buffers (about 2 MB).

## Tests

`node sim/tests/vegetation_shots.mjs [--quality medium] [--only telnof_chase,orchards_150]
[--tag t1]` takes the scenes (Tel Nof 36 cockpit and chase, the citrus blocks west of Tel Nof
at 150 m, Ben Shemen and the Jerusalem forest at 600 m, 3,000 m cruise, Tel Aviv at 300 m,
Kalia's palms, sunset over the hills) with the frame statistics and the module's own
(`statsJSON()`), waiting until the module is idle (`idle()`). `--params vegetation=0` gives the
same scenes without trees. The placement rules run in node too (`placement.js` has no DOM).
