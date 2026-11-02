# tools/terrain: the terrain data builder

Builds `sim/data/terrain/` (heights, colour, land cover, airports, spawns, manifest) for the F-35I
flight sim from public data, exactly in the formats of `sim/DESIGN.md` ("Data: data/terrain/").

## Run

```
pip install numpy scipy rasterio pyproj pillow        # + pyarrow for the optional osmcheck stage
python3 sim/tools/terrain/build.py --cache /path/to/cache --out sim/data/terrain
```

* `--cache` (default `sim/tools/terrain/_cache`, git-ignored): downloads and intermediate
  products. A second run, or a run on another machine with a copied cache, does not touch the
  network.
* `--out` (default `sim/data/terrain`): the data set the app loads.
* `--stages fetch,landcover,...`: run only some stages (each stage re-runs on its own; later stages
  read what earlier ones left in `<cache>/work/` and `--out`).

Stages, in order:

| stage | does | time* |
|---|---|---|
| fetch | downloads the needed parts of the sources (COG windows and overviews over HTTP) | ~3 min |
| landcover | WorldCover -> `landcover/` + water masks (sea, Dead Sea, other water) | ~1 min |
| color | Sentinel-2 composite -> `color/` (graded, sea and Dead Sea recoloured) | ~2 min |
| runways | OurAirports runways checked and corrected against the colour tiles | <1 min |
| heights | Copernicus DEM -> `height/` (water flat, buildings/trees cut, runways flattened) | <1 min |
| json | `airports.json`, `spawns.json` | seconds |
| osmcheck | optional independent check against OpenStreetMap (needs pyarrow; verification only) | ~1 min first time |
| previews | `previews/*.jpg` and `previews/checks.txt` | <1 min |
| manifest | `manifest.json`, written last (its presence means the set is complete) | seconds |

\* on the 4-CPU build container, run with `nice -n 10`. Disk: the cache needs about 1 GB for
downloads plus about 0.8 GB for `work/`; the output is about 125 MB.

Tested with Python 3.13, numpy 2.5, scipy 1.18, rasterio 1.5 (GDAL 3.12), pyproj 3.8, Pillow 12,
pyarrow 26. Network access is only needed for `fetch` (and `osmcheck`): the AWS open-data buckets
`copernicus-dem-30m`, `esa-worldcover`, `esa-worldcover-s2`, `overturemaps-us-west-2`, and
raw.githubusercontent.com for OurAirports.

## Sources and licences

| data | source | licence / attribution |
|---|---|---|
| heights | Copernicus DEM GLO-30, 2021 release (COGs on AWS); EGM2008 heights | produced using Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved |
| colour | ESA WorldCover 10 m 2021 v200 Sentinel-2 RGBNIR composite (per-pixel 2021 median of cloud-free L2A) | CC BY 4.0, (c) ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium |
| land cover | ESA WorldCover 10 m 2021 v200 map | CC BY 4.0, same attribution |
| airports | OurAirports `airports.csv`, `runways.csv` | public domain |
| checks only | OpenStreetMap runway lines and coastline via Overture Maps (base theme, release 2026-10-21.0) | ODbL; used only to verify, nothing from it is in the data |

`manifest.json` carries the attribution text the app shows (`attribution`) and the source list.

## Processing

World frame and grids are those of DESIGN.md: transverse Mercator `+proj=tmerc +lat_0=31.80
+lon_0=35.025 +k=1` on WGS84, X east, Y up, Z = -northing. Everything is computed on a work square
of +-64 km (the core plus a 12.8 km ring) so the core edges and the far area join without seams.

* **Land cover**: WorldCover reprojected to 10 m by mode. The open sea is the water connected to the
  western edge after a 110 m opening (rivers and harbour channels stay "other water"); WorldCover's
  no-data offshore becomes 80. The Dead Sea is the water component at 35.50 E 31.55 N. Tiles 640 px
  (10 m), overview 4096 px (mode), far 2048 px (WorldCover's own overviews, mode; core downsampled
  inside the core).
* **Colour**: the composite (reflectance) is reprojected with cubic interpolation to 6.25 m (L0) and
  graded to a summer aerial photo look (`colorgrade.py`): a small per-band dark offset against the
  milky path radiance, exposure and white balance, a highlight shoulder, sRGB, a mild S-curve, a
  small saturation boost, a light NDVI push of orchards and pines towards deep green, and a
  hue-preserving gamut limit so no channel clips (JPEGs are 4:4:4). The Mediterranean is
  replaced by a natural blue graded by distance from the shore (turquoise at the beach, deep blue
  offshore, faint large-scale variation), blended over a soft shoreline from the land-cover mask
  so beaches, surf and harbour moles of the imagery stay. The Dead Sea is turquoise blue, lighter
  over its shallow shelf; the salt and mud flats around it are land and keep their imagery
  colour. Overview (25 m) and the core of far.jpg (200 m) are box-filtered in linear light from
  L0; outside the core far.jpg is the composite's 8x overviews graded the same way, with a
  correction field that fades any brightness difference along the core edge out over 8 km.
* **Runways**: every OurAirports runway of an airport in the core (types small/medium/large; the
  closed Atarot runway is kept because its pavement is still there; Sde Dov is gone and left out)
  is checked in the delivered colour tiles: pavement is the low-saturation trough in cross profiles
  (median along the runway, angle fan, then 200 m segments for consistency). When the fit is
  consistent the centreline is moved onto the imagery (lateral shift; the CSV heading is kept
  unless the imagery rotation exceeds 15 m at the ends, because angles from 10 m imagery are
  less reliable than the CSV's). A move of more than half a runway width is only made when the
  CSV line is off the pavement (otherwise the fit has found a parallel taxiway or apron and the
  CSV is kept). Ends off the pavement are pulled onto it; pavement beyond the thresholds is
  measured (`overrun_m`). Runways without coordinates in the CSV (Rishon LeZion) are located from
  the airport reference point and the CSV heading. Ben Gurion 08/26 was 29 m off in the CSV and
  Atarot 15 m; the other corrections applied are under 7 m. The independent OpenStreetMap check
  puts 27 of 28 runway ends within 10 m (median 3.3 m); the exception is Herzliya's end 10
  (12.5 m), a narrow strip inside a wide paved area where the 10 m imagery is ambiguous and the
  CSV is kept.
* **Heights**: Copernicus DEM tiles mosaicked and reprojected with cubic resampling to 25 m points.
  Water is made flat: the Mediterranean at 0.0, the Dead Sea at its DEM level (-427.0 m; the DEM
  was acquired 2011-2015, the lake is lower today), inland water bodies at their median if nearly
  flat; land next to the water rises from just above it. The DEM is a surface model, so buildings
  and trees (WorldCover built-up / tree cover) standing above a 225 m grey opening are cut to the
  local ground plus 1.5 m (built) or 2 m (trees); the threshold grows with the convexity of the
  terrain so built-up hill tops (Jerusalem) keep their height. Runways are flattened, longest
  first: a robust quadratic/cubic longitudinal profile through the DEM along the paved length
  (overruns included), level across the pavement and 15 m shoulders (+ one grid cell), blended
  into the terrain over 60 m. The far grid (200 m) is the GLO-30 4x overview averaged; inside the
  core it is the core box-filtered to 200 m, within 1 km of the core edge it takes the core's own
  samples (the far mesh meets the core at identical heights), and across 51.2-63.2 km it blends to
  the far DEM. Heights are quantised to 0.05 m (uint16 LE, h = v * 0.05 - 500).
* **airports.json / spawns.json**: all y values are read back from the delivered height tiles,
  bilinearly, as `Terrain.heightAt` does.

## Output notes (in addition to DESIGN.md)

* `airports.json`: per airport also `elev_terrain_m` (highest runway end in the terrain),
  `full_name`, `closed`, `lon`, `lat`, `x`, `z`; per runway `lighted`, `length_published_m`,
  `position_source`; per end `lon`, `lat`, `overrun_m` (pavement beyond the threshold, flattened
  too), `displaced_threshold_m`. `elev_m` is the published elevation, as in the DESIGN example.
  Surfaces are words (`asphalt`, `concrete`, ...). Headings are world headings (grid north).
* `spawns.json`: Tel Nof's longest runway is 18/36 (published 7880 ft vs 7835/7830 ft for 15R/33L
  and 15L/33R; 2409 m threshold to threshold here), which has no end "33": the takeoff spawn is
  `telnof_36` (36, into the prevailing west-north-westerly wind) and `telnof_final` is a 10 km
  final to 36. `telnof_33r` is there as well. Others: `tlv_3000`, `jerusalem_sunset`,
  `bengurion_26`, `deadsea_low`, `coast_low`. On-ground spawns: `y` is the ground height
  (wheels on it), 25 m past the threshold on the centreline. Airborne spawns: `y` is the altitude
  above MSL and `ground_y` the ground height below. Extra hints: `gear` (1 down, 0 up),
  `throttle` (0 = idle, on-ground spawns only: airborne spawns carry none, so the flight model
  trims the throttle for 1 g at the spawn's speed and flight path), `flight_path_deg` (final),
  `time_h` / `day_of_year` (sunset), `airport` / `runway`.
* `previews/`: `core_hillshade.jpg`, `far_hillshade.jpg`, crops `telnof.jpg`, `tel_aviv_coast.jpg`,
  `jerusalem.jpg`, `dead_sea.jpg`, `telnof_runways.jpg` (runways and spawns drawn on),
  `runway_strips.jpg` (each runway straightened: red = pavement edges, cyan = thresholds, yellow =
  OpenStreetMap centreline) and `checks.txt` (formats, shared edges, seams, heights at known points,
  water, coastline, runways, spawns, colour statistics). Not used by the app.

## Known limitations

* The Dead Sea is at its DEM level, -427.0 m (TanDEM-X 2011-2015); today it is about -435 to -438 m.
* The land-cover shoreline lies on average 15 m (up to 29 m) landward of the OpenStreetMap
  coastline along the Tel Aviv - Ashdod coast: the 10 m map counts the wet swash zone as water.
* Runway gradients come from the DEM: Tel Nof's 15/33 runways rise about 16 m to the south-east
  (thresholds 50-66 m against a published field elevation of 59 m), Palmachim 13/31 reaches 3.5 %.
* Paved strips that OurAirports does not list are not runways here (OpenStreetMap shows a 1.7 km
  strip parallel to Palmachim 03/21 and a few agricultural strips); `checks.txt` lists them.
* On steep built-up slopes the building cut is conservative, so some building height remains.
* Far area: inland water other than the Dead Sea keeps its imagery colour (the Sea of Galilee is a
  dark green-blue); a few dark brine ponds at the Bardawil lagoon (Sinai, ~190 km away) stay dark.

## Files

`build.py` (CLI and stage order), `grid.py` (projection, grids, height encoding), `fetch.py`,
`landcover.py`, `colorgrade.py`, `color.py`, `runways.py`, `heights.py`, `outputs.py` (airports,
spawns, manifest), `osmcheck.py`, `previews.py`.

`overrun_check.py` is a separate check of a built set (it writes nothing into it): it follows
the pavement beyond every runway end in the colour tiles and flags ends where it runs well past
the painted overrun (`overrun_m`), with a contact sheet to look at
(`/home/claude/simdata/terrain_extra/overrun_check.jpg` by default). The `runways` stage's
saturation test stops early where an overrun is paler, yellower concrete than the runway; the
cases confirmed on that sheet (Tel Nof 36 and 15R 390 m, Palmachim 21 300 m) are applied by the
`runways` stage itself (`OVERRUN_CONFIRMED_M`, a lower bound, with a note in the report), so
the `heights` stage flattens the whole blast pad and `airports.json` carries it. Data sets built
before that (the delivered one: 145 / 195 / 25 m) get the lengths from the runtime fallback in
`sim/js/terrain/Surface.js` (`OVERRUN_FIX`); their ground under the outer part of those pads is
the DEM, up to 0.8 m off a straight grade with up to 2.3 % cross slope, which a rebuild of the
`runways,heights,json,previews,manifest` stages removes (0.07 m, 0.02 %; measured by
re-running the flattening on the delivered tiles).

## Field data (`fields.py`, optional)

`fields.py` adds `data/terrain_extra/fields/` next to a built set (it only reads the set): per
10 m texel of every core tile the land cover class (WorldCover, plus orchards, vineyards and
greenhouses mapped in OpenStreetMap), the row direction and a random number of the field the
texel lies in; the terrain shader draws crop rows, orchards, vineyards and greenhouses from it.

    python3 sim/tools/terrain/fields.py [--data sim/data/terrain] [--out DIR] [--cache DIR]
                                        [--stages fetch,prepare,segment,check]

`fetch` reads OpenStreetMap land use for the core from Overture Maps (anonymous HTTPS range
requests, a few tens of MB); `prepare` makes mosaics of the whole core (~0.5 GB in the cache);
`segment` (`fields_segment.mjs`, node) segments the whole core in tile windows with 800 m of
context and stitches the regions across tile edges, so a field cut by a tile edge keeps its rows
(over the whole core, neighbouring crop texels more than 15 deg apart in row direction: 7.5 % of
the pairs across tile edges, 5.2 % inside the tiles; 44-56 % across the edges when every tile is
analysed on its own; `sim/dev/terrain.analysis.test.mjs` checks it); `check` writes `check.txt`
(statistics) and previews. The delivered run took ~4 min on 4 cores and wrote 19 MB (256 gzip tiles,
`index.json` with the attribution and the Overture release). Field outlines, orchards, vineyards
and greenhouses: © OpenStreetMap contributors, ODbL 1.0, via Overture Maps Foundation. Without
the folder the app analyses each imagery tile on its own in the browser.
