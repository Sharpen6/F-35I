# F-35I "Adir" — procedural, rigged & destructible Blender model

A fully scripted (Python / `bpy`) 3D model of the Israeli Air Force F-35I Adir,
built from publicly available reference material (see [`docs/research.md`](docs/research.md)).

**Status:** work in progress — see `renders/progress/` for the build history.

## Layout
| Path | Contents |
| --- | --- |
| `scripts/build_f35i.py` | Entry point – builds the whole aircraft into a fresh scene |
| `scripts/f35/` | Modules: fuselage, wings, tails, nozzle, canopy, cockpit, gear, bays, pilot, rig, damage … |
| `scripts/review_compare.py` | Renders orthographic silhouettes registered to the public 3-view drawing and reports overlap (IoU) |
| `scripts/preview.py` | Fast Workbench/Cycles review renders from preset cameras |
| `renders/` | Images & GIFs (progress shots, turntables, animations) for the making-of video |
| `docs/` | Research notes, damage-model spec, rig controls |

## Build
```bash
pip install bpy==5.1.2            # or run inside Blender 5.1
python3 scripts/build_f35i.py --out blend/F-35I_Adir.blend
```
