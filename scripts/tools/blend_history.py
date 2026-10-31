"""Numbered backups of the built model for progress analysis.

Every milestone's blend is kept in blend/history/ as
    NN_<date>_<time>_<commit>_<slug>.blend
with one row per file in blend/history/index.csv (date, commit, summary and
size counts: objects, mesh vertices / faces, materials) and a readable
blend/history/INDEX.md.  Git stores identical files once, so the copies cost
the repository nothing beyond the commits that already hold them.

    python3 scripts/tools/blend_history.py add <slug> [--commit SHA] [--note TEXT]
        copy blend/F-35I_Adir.blend (as committed at SHA, default HEAD)
    python3 scripts/tools/blend_history.py add <slug> --file X.blend --commit SHA
        add a blend rebuilt from an older commit's scripts
    python3 scripts/tools/blend_history.py index
        recount every file and rewrite index.csv / INDEX.md
Counting needs the bpy module (pip install bpy==5.1.2).
"""
import csv
import os
import shutil
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HIST = os.path.join(REPO, "blend", "history")
MODEL = os.path.join(REPO, "blend", "F-35I_Adir.blend")
FIELDS = ["n", "file", "date", "commit", "summary", "note", "mb", "objects", "meshes",
          "vertices", "faces", "materials"]


def _git(*args):
    return subprocess.run(["git", "-C", REPO] + list(args), capture_output=True, text=True,
                          check=True).stdout.strip()


def stats(path):
    """Object / mesh / vertex / face / material counts of a blend (needs bpy)."""
    try:
        import bpy
    except ImportError:
        return {}
    bpy.ops.wm.open_mainfile(filepath=path)
    obs = [o for o in bpy.data.objects if not o.name.startswith(("HB_", "Hitbox"))]
    meshes = [o for o in obs if o.type == 'MESH' and o.data is not None]
    return {
        "objects": len(obs),
        "meshes": len(meshes),
        "vertices": sum(len(o.data.vertices) for o in meshes),
        "faces": sum(len(o.data.polygons) for o in meshes),
        "materials": len([m for m in bpy.data.materials if m.users]),
    }


def _rows():
    p = os.path.join(HIST, "index.csv")
    if not os.path.exists(p):
        return []
    with open(p, newline="") as f:
        return list(csv.DictReader(f))


def _write(rows):
    rows.sort(key=lambda r: int(r["n"]))
    with open(os.path.join(HIST, "index.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, FIELDS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in FIELDS})
    lines = ["# Model history", "",
             "One blend per milestone, oldest first (`index.csv` has the same table).",
             "Counts leave out the hidden hitbox helpers.",
             "From 12 on the sky image is linked relative to `blend/`, so a copy opened from here shows a",
             "pink sky until it is pointed at `references/hdri/` (File > External Data > Find Missing Files).",
             "Copying the file next to `blend/F-35I_Adir.blend` also works.", "",
             "| # | File | Date | Commit | What changed | MB | Objects | Vertices | Faces | Materials |",
             "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for r in rows:
        what = r["summary"] + (f" ({r['note']})" if r.get("note") else "")
        lines.append(f"| {r['n']} | `{r['file']}` | {r['date']} | {r['commit']} | {what} | {r['mb']} | "
                     f"{r.get('objects', '')} | {r.get('vertices', '')} | {r.get('faces', '')} | "
                     f"{r.get('materials', '')} |")
    with open(os.path.join(HIST, "INDEX.md"), "w") as f:
        f.write("\n".join(lines) + "\n")


def add(slug, commit="HEAD", src=None, note=""):
    os.makedirs(HIST, exist_ok=True)
    sha = _git("rev-parse", "--short", commit)
    date = _git("show", "-s", "--format=%ad", "--date=format:%Y-%m-%d_%H%M", sha)
    shown = _git("show", "-s", "--format=%ad", "--date=format:%Y-%m-%d %H:%M", sha)
    summary = _git("show", "-s", "--format=%s", sha)
    rows = _rows()
    n = max([int(r["n"]) for r in rows] + [-1]) + 1
    name = f"{n:02d}_{date}_{sha}_{slug}.blend"
    dst = os.path.join(HIST, name)
    if src:
        shutil.copyfile(src, dst)
    else:
        with open(dst, "wb") as f:
            f.write(subprocess.run(["git", "-C", REPO, "show", f"{sha}:blend/F-35I_Adir.blend"],
                                   capture_output=True, check=True).stdout)
    row = {"n": str(n), "file": name, "date": shown, "commit": sha,
           "summary": summary, "note": note, "mb": f"{os.path.getsize(dst) / 1e6:.1f}"}
    row.update({k: str(v) for k, v in stats(dst).items()})
    rows.append(row)
    _write(rows)
    return name


def index():
    rows = _rows()
    for r in rows:
        r.update({k: str(v) for k, v in stats(os.path.join(HIST, r["file"])).items()})
    _write(rows)


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0] not in ("add", "index"):
        sys.exit(__doc__)
    if a[0] == "index":
        index()
    else:
        opts = {"--commit": "HEAD", "--file": None, "--note": ""}
        slug = a[1]
        i = 2
        while i < len(a):
            opts[a[i]] = a[i + 1]
            i += 2
        print(add(slug, opts["--commit"], opts["--file"], opts["--note"]))
