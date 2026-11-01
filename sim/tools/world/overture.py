#!/usr/bin/env python3
"""Read features of the Overture Maps Foundation open data set for a lon/lat box (any theme / type).

    python3 sim/tools/world/overture.py --theme buildings --type building --cache DIR [--release latest]

Overture publishes GeoParquet files on a public S3 bucket (anonymous HTTPS, no account):
https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/<release>/theme=<theme>/type=<type>/*.parquet
Each file has row groups with min / max statistics of the `bbox` struct columns, so only the
footers (~0.7 MB each) and the row groups whose bbox statistics touch the area are read, with
HTTP range requests (the same approach as sim/tools/terrain/osmcheck.py, whose RangeFile this uses).

The rows inside the box are cached as one small parquet per source file under
<cache>/overture/<release>/<theme>/<type>/, plus a scan.json with what was read, so a second run
does not touch the network. `read_cached()` returns them as one pyarrow table.

Licences: Overture data is distributed under ODbL (themes derived from OpenStreetMap, e.g.
buildings, transportation, base) or CDLA Permissive 2.0 (e.g. places, addresses); each row's
`sources` column names the upstream data set and its licence (OpenStreetMap, Microsoft ML
Buildings, Esri Community Maps, Google Open Buildings ...). See https://docs.overturemaps.org/attribution/.
"""
import argparse
import concurrent.futures as cf
import json
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..', 'terrain')))

import grid  # noqa: E402  (sim/tools/terrain/grid.py: the sim's projection and grids)
from osmcheck import RangeFile  # noqa: E402  (seekable HTTP range reader)

BASE = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com'


def log(*a):
    print('  [overture]', *a, flush=True)


def list_prefixes(prefix, delimiter='/'):
    """Common prefixes ("folders") under prefix."""
    q = f'{BASE}/?list-type=2&prefix={urllib.parse.quote(prefix)}&delimiter={urllib.parse.quote(delimiter)}'
    xml = urllib.request.urlopen(q, timeout=60).read().decode()
    return re.findall(r'<Prefix>([^<]+)</Prefix>', xml)


def list_keys(prefix):
    """All object keys under prefix (with their sizes)."""
    out, token = [], None
    while True:
        q = f'{BASE}/?list-type=2&prefix={urllib.parse.quote(prefix)}'
        if token:
            q += '&continuation-token=' + urllib.parse.quote(token)
        xml = urllib.request.urlopen(q, timeout=60).read().decode()
        keys = re.findall(r'<Key>([^<]+)</Key>', xml)
        sizes = [int(s) for s in re.findall(r'<Size>([^<]+)</Size>', xml)]
        out += list(zip(keys, sizes))
        m = re.search(r'<NextContinuationToken>([^<]+)</NextContinuationToken>', xml)
        if not m:
            return out
        token = m.group(1)


def latest_release():
    """Newest release name, e.g. '2026-10-21.0' (releases are dated, so they sort by name)."""
    rel = [p.rstrip('/').split('/')[-1] for p in list_prefixes('release/') if p.rstrip('/') != 'release']
    rel = [r for r in rel if re.match(r'^\d{4}-\d{2}-\d{2}\.\d+$', r)]
    if not rel:
        raise OSError('no Overture releases found')
    return sorted(rel, key=lambda r: (r.split('.')[0], int(r.split('.')[1])))[-1]


def core_bbox(pad_deg=0.01):
    """lon/lat box (W, S, E, N) of the sim's 102.4 km core (sim/DESIGN.md), padded a little."""
    h = grid.CORE_HALF
    return grid.lonlat_bounds(-h, -h, h, h, pad_deg=pad_deg)


def _scan_file(key, bbox, columns, out_path):
    """Read the rows of one Overture parquet file inside bbox; write them to out_path. -> stats."""
    import pyarrow.compute as pc
    import pyarrow.parquet as pq
    W, S, E, N = bbox
    f = RangeFile(f'{BASE}/{key}')
    pf = pq.ParquetFile(f)
    md = pf.metadata
    ix = {md.schema.column(i).path: i for i in range(md.num_columns)}
    keep = []
    for rg in range(md.num_row_groups):
        g = md.row_group(rg)
        st = {k: g.column(ix['bbox.' + k]).statistics for k in ('xmin', 'xmax', 'ymin', 'ymax')}
        if all(s is not None and s.has_min_max for s in st.values()) and (
                st['xmax'].max < W or st['xmin'].min > E or st['ymax'].max < S or st['ymin'].min > N):
            continue
        keep.append(rg)
    footer = f.nbytes
    rows = 0
    if keep:
        cols = [c for c in columns if c in pf.schema_arrow.names]
        t = pf.read_row_groups(keep, columns=cols)
        bb = t.column('bbox')
        m = pc.and_(pc.and_(pc.greater_equal(pc.struct_field(bb, 'xmax'), W),
                            pc.less_equal(pc.struct_field(bb, 'xmin'), E)),
                    pc.and_(pc.greater_equal(pc.struct_field(bb, 'ymax'), S),
                            pc.less_equal(pc.struct_field(bb, 'ymin'), N)))
        t = t.filter(m)
        rows = t.num_rows
        if rows:
            pq.write_table(t, out_path + '.tmp', compression='zstd')
            os.replace(out_path + '.tmp', out_path)
    return dict(key=key, row_groups=len(keep), rows=rows, footer_mb=round(footer / 1e6, 2),
                read_mb=round(f.nbytes / 1e6, 2))


def fetch(theme, typ, cache, bbox=None, release='latest', columns=None, threads=6):
    """Cache the rows of theme/type inside bbox. Returns the cache folder of this theme/type."""
    if release == 'latest':
        release = latest_release()
    bbox = bbox or core_bbox()
    folder = os.path.join(cache, 'overture', release, theme, typ)
    os.makedirs(folder, exist_ok=True)
    scan_path = os.path.join(folder, 'scan.json')
    if os.path.exists(scan_path):
        with open(scan_path) as fh:
            scan = json.load(fh)
        if scan.get('bbox') == list(bbox) and scan.get('complete'):
            log(f'{theme}/{typ}: cached ({scan["rows"]} rows, release {release})')
            return folder
    keys = [(k, s) for k, s in list_keys(f'release/{release}/theme={theme}/type={typ}/') if k.endswith('.parquet')]
    log(f'{theme}/{typ}: {len(keys)} files, {sum(s for _, s in keys) / 1e9:.1f} GB in release {release}; '
        f'reading the footers and the row groups inside {tuple(round(v, 3) for v in bbox)}')
    columns = columns or ['id', 'geometry', 'bbox']
    done, lock, t0 = [], threading.Lock(), time.time()

    def job(k):
        name = os.path.basename(k).split('-')[1] if '-' in os.path.basename(k) else os.path.basename(k)
        out = os.path.join(folder, f'part-{name}.parquet')
        for attempt in range(4):
            try:
                r = _scan_file(k, bbox, columns, out)
                break
            except OSError as e:
                if attempt == 3:
                    raise
                log(f'retry {k}: {e}')
                time.sleep(3 + 5 * attempt)
        with lock:
            done.append(r)
            if r['rows'] or len(done) % 50 == 0:
                log(f'{len(done)}/{len(keys)} files, {sum(d["rows"] for d in done)} rows, '
                    f'{sum(d["read_mb"] for d in done):.0f} MB read, {time.time() - t0:.0f} s')
        return r

    with cf.ThreadPoolExecutor(threads) as ex:
        list(ex.map(job, [k for k, _ in keys]))
    scan = dict(release=release, theme=theme, type=typ, bbox=list(bbox), columns=columns, complete=True,
                rows=sum(d['rows'] for d in done), read_mb=round(sum(d['read_mb'] for d in done), 1),
                files=sorted([d for d in done if d['rows']], key=lambda d: d['key']))
    with open(scan_path + '.tmp', 'w') as fh:
        json.dump(scan, fh, indent=1)
    os.replace(scan_path + '.tmp', scan_path)
    log(f'{theme}/{typ}: {scan["rows"]} rows inside the box, {scan["read_mb"]} MB read in {time.time() - t0:.0f} s')
    return folder


def read_cached(folder, columns=None):
    """All cached rows of one theme/type folder as one pyarrow table (None if empty)."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    parts = sorted(p for p in os.listdir(folder) if p.endswith('.parquet'))
    tables = []
    for p in parts:
        path = os.path.join(folder, p)
        names = pq.read_schema(path).names
        tables.append(pq.read_table(path, columns=[c for c in columns if c in names] if columns else None))
    tables = [t for t in tables if t.num_rows]
    if not tables:
        return None
    return pa.concat_tables(tables, promote_options='permissive')


def scan_info(folder):
    with open(os.path.join(folder, 'scan.json')) as fh:
        return json.load(fh)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--theme', required=True)
    ap.add_argument('--type', required=True)
    ap.add_argument('--cache', default=os.path.join(HERE, '_cache'))
    ap.add_argument('--release', default='latest')
    ap.add_argument('--columns', default='id,geometry,bbox', help='comma separated (missing ones are skipped)')
    ap.add_argument('--threads', type=int, default=6)
    a = ap.parse_args()
    fetch(a.theme, a.type, a.cache, release=a.release, columns=a.columns.split(','), threads=a.threads)


if __name__ == '__main__':
    main()
