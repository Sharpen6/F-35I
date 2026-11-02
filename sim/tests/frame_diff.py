#!/usr/bin/env python3
"""Frame-to-frame change of the pairs lighting_shots.mjs --set flicker takes (NAME.png, NAME_b.png).

    python3 sim/tests/frame_diff.py DIR [--threshold 4]

For each pair: the share of all pixels, and of the pixels that differ from the sky's smooth
gradient (a rough "cloud or detail" mask: local contrast), whose colour changed by more than
--threshold / 255 in any channel between two consecutive frames of a still camera. The clouds'
ray march used to boil (white noise per frame, no temporal filter): 9 to 30 % of the detail
pixels changed by more than 4/255 from one frame to the next (30 % under a scattered deck seen
from below, 9-10 % in and beside a broken deck); with the temporal filter under 0.1 %.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def load(p):
    return np.asarray(Image.open(p).convert('RGB'), dtype=np.int16)


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 1
    d = Path(args[0])
    th = 4
    if '--threshold' in args:
        th = int(args[args.index('--threshold') + 1])
    for a in sorted(d.glob('*_b.png')):
        # pairs NAME.png + NAME_b.png (lighting_shots.mjs) or NAME_a.png + NAME_b.png
        base = a.with_name(a.name[:-6] + '.png')
        if not base.exists():
            base = a.with_name(a.name[:-6] + '_a.png')
        if not base.exists():
            continue
        x, y = load(base), load(a)
        diff = np.abs(x - y).max(axis=2)
        # detail mask: pixels whose luminance differs from the 9x9 mean by > 3/255 (clouds, terrain)
        lum = x.mean(axis=2)
        k = 9
        pad = np.pad(lum, k // 2, mode='edge')
        cs = pad.cumsum(0).cumsum(1)
        cs = np.pad(cs, ((1, 0), (1, 0)))
        h, w = lum.shape
        mean = (cs[k:k + h, k:k + w] - cs[:h, k:k + w] - cs[k:k + h, :w] + cs[:h, :w]) / (k * k)
        detail = np.abs(lum - mean) > 3
        changed = diff > th
        print(f'{base.stem:28s} changed>{th}: all {changed.mean() * 100:5.2f} %   detail {changed[detail].mean() * 100 if detail.any() else 0:5.2f} %'
              f'   mean |d| {diff.mean():.2f}   max {diff.max()}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
