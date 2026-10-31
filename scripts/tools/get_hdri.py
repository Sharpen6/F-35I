"""Download a CC0 HDRI from Poly Haven (https://polyhaven.com) into references/hdri/.

The presentation scene (scripts/f35/scene.py) lights the jet with it when the file is there and
falls back to the procedural sky when it is not. The 2k file is small enough to keep in git; the
4k / 8k files are only used for sharper backgrounds in renders and stay local (.gitignore).

    python3 scripts/tools/get_hdri.py                      # driving_school, 2k and 4k
    python3 scripts/tools/get_hdri.py driving_school 8k    # one name, chosen sizes

Works the same inside Blender (import get_hdri; get_hdri.fetch("driving_school", ["8k"])).
"""
import json
import os
import sys
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEST = os.path.join(REPO, "references", "hdri")
UA = {"User-Agent": "F-35I-model-build/1.0 (+https://github.com/Sharpen6/F-35I)"}


def _get(url, timeout=60):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout)


def fetch(name="driving_school", sizes=("2k", "4k"), fmt="hdr", dest=DEST):
    """Download <name>_<size>.<fmt> for each size; skips files already present with the right size."""
    os.makedirs(dest, exist_ok=True)
    files = json.loads(_get(f"https://api.polyhaven.com/files/{name}").read())["hdri"]
    out = {}
    for size in sizes:
        info = files[size][fmt]
        path = os.path.join(dest, f"{name}_{size}.{fmt}")
        if os.path.exists(path) and os.path.getsize(path) == info["size"]:
            out[size] = path
            continue
        tmp = path + ".part"
        with _get(info["url"], timeout=300) as r, open(tmp, "wb") as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        os.replace(tmp, path)
        out[size] = path
    meta = json.loads(_get(f"https://api.polyhaven.com/info/{name}").read())
    with open(os.path.join(dest, f"{name}.json"), "w") as f:
        json.dump({"name": meta.get("name"), "authors": list(meta.get("authors", {})),
                   "license": "CC0", "source": f"https://polyhaven.com/a/{name}"}, f, indent=1)
    return out


if __name__ == "__main__":
    args = sys.argv[1:]
    name = args[0] if args else "driving_school"
    sizes = args[1:] or ["2k", "4k"]
    print(fetch(name, sizes))
