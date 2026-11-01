#!/usr/bin/env python3
"""Build sim/data/terrain/ for the F-35I flight sim from public data.

    python3 sim/tools/terrain/build.py --cache /path/to/cache --out sim/data/terrain [--stages ...]

Stages (default: all, in this order):
    fetch      download / cache the needed parts of the sources (network)
    landcover  ESA WorldCover -> landcover/ tiles, overview, far + masks for later stages
    color      Sentinel-2 composite -> color/ L0 tiles, overview, far (sea and Dead Sea recoloured)
    runways    OurAirports runways, verified and corrected against the colour tiles
    heights    Copernicus DEM -> height/ tiles + far.bin (water, buildings/trees, runways flattened)
    json       airports.json, spawns.json
    osmcheck   independent check of runways / coastline against OpenStreetMap via Overture (optional:
               needs pyarrow; verification only, nothing from it enters the data)
    previews   previews/*.jpg and previews/checks.txt
    manifest   manifest.json (written last: its presence means the data set is complete)

Intermediate products live in <cache>/work/. Every stage can be re-run on its own.
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

STAGES = ['fetch', 'landcover', 'color', 'runways', 'heights', 'json', 'osmcheck', 'previews', 'manifest']


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument('--cache', default=os.path.join(here, '_cache'), help='download cache and work dir')
    ap.add_argument('--out', default=os.path.normpath(os.path.join(here, '..', '..', 'data', 'terrain')),
                    help='output directory (data/terrain)')
    ap.add_argument('--stages', default=','.join(STAGES), help='comma separated subset of: ' + ','.join(STAGES))
    args = ap.parse_args()
    stages = [s.strip() for s in args.stages.split(',') if s.strip()]
    for s in stages:
        if s not in STAGES:
            ap.error(f'unknown stage {s}')
    cache, out = os.path.abspath(args.cache), os.path.abspath(args.out)
    os.makedirs(cache, exist_ok=True)
    os.makedirs(out, exist_ok=True)
    os.makedirs(os.path.join(cache, 'work'), exist_ok=True)

    for s in STAGES:
        if s not in stages:
            continue
        t0 = time.time()
        print(f'==== stage {s}', flush=True)
        if s == 'fetch':
            import fetch
            fetch.run(cache)
        elif s == 'landcover':
            import landcover
            landcover.run(cache, out)
        elif s == 'color':
            import color
            color.run(cache, out)
        elif s == 'runways':
            import runways
            runways.run(cache, out)
        elif s == 'heights':
            import heights
            heights.run(cache, out)
        elif s == 'json':
            import outputs
            outputs.run_json(cache, out)
        elif s == 'osmcheck':
            import osmcheck
            osmcheck.run(cache, out)
        elif s == 'previews':
            import previews
            previews.run(cache, out)
        elif s == 'manifest':
            import outputs
            outputs.run_manifest(cache, out)
        print(f'==== stage {s} done in {time.time() - t0:.0f} s', flush=True)


if __name__ == '__main__':
    main()
