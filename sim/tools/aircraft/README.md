# tools/aircraft: the F-35I for the browser sim

`export_glb.py` builds the procedural Blender model (`scripts/build_f35i.py`, every part except the
damage model and the apron scene) and writes what `js/aircraft/AircraftVisual.js` loads:

| file | what |
| --- | --- |
| `data/aircraft/f35i.glb` | the aircraft, glTF 2.0: about 320k triangles (pilot decimated to 60k), 54 nodes (every moving part its own node), baked skin atlases, ~26 MB at 4096 px (323k triangles, 201 primitives, 93 materials) |
| `data/aircraft/f35i_rig.json` | how each control moves the nodes (sampled from the Blender rig `F35I_Rig`) and the reference data the app needs: eye point, gear contacts, nozzle, lights, dimensions |

## Running it

From the repository root, with Blender 5.1 (the `bpy` 5.1 module works too):

```
blender -b --factory-startup -P sim/tools/aircraft/export_glb.py -- --out sim/data/aircraft
python3 sim/tools/aircraft/export_glb.py --out sim/data/aircraft          # bpy as a Python module
```

On Windows: `"C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" -b --factory-startup -P sim\tools\aircraft\export_glb.py -- --out sim\data\aircraft`.

Options: `--atlas N` skin atlas size (default 4096; 1024 for a quick test), `--pilot-tris N` (60000),
`--blend file.blend` (skip the build, use a model saved by `build_f35i.py`), `--save-blend file`
(keep the export scene for inspection), `--work DIR` (keep the baked images). A full run takes about
6 minutes on 4 shared cores (building the model ~1 min, rig sampling 8 s, mesh copies 30 s, UV unwrap
30 s, bake ~3.5 min at 4096 of which the normal maps take 2.5 min, export 5 s). A quick test,
`--atlas 1024 --blend model.blend`, takes about 80 s.

`python3 sim/tools/aircraft/glb.py sim/data/aircraft/f35i.glb` prints a summary of a glb.

## What it does

1. **Build** the model, or open `--blend`. The rig root's static ground stance (1.45 deg nose up,
   raised 0.13 m) is reset to identity: the sim sets the attitude itself.
2. **Sample the rig** (`rigsample.py`). For every control, its range is sampled (9-201 values:
   the gear's door sequence gets 201) with all other controls at their defaults, and every node's
   transform is recorded as a delta from its rest pose (rest = all controls at default: gear down,
   surfaces neutral, canopy shut). Each node / control is fitted as a **hinge** (pivot, axis, angle
   per sample: surfaces, doors, canopy, gear legs), a **spin** (wheels: angle = rate x roll
   distance) or a general **rigid motion** (quaternion + translation per sample: gear links,
   oleos, pedals, the pilot's head). Samples are thinned while linear interpolation stays within
   1.5 mm everywhere on the part. When all of a node's controls turn it about one line, the node
   gets one hinge whose angles add and are clamped like the Blender driver (stabilator, flaperon,
   rudder, LEF). Three pseudo-controls `strut_nose / strut_left / strut_right` are added to the
   oleo drivers so the app can compress the shock struts.
3. **Reference data** (`info.py`): eye point (between the seated pilot's corneas, from the pilot
   skeleton), gear contacts, nose-wheel steering axis, nozzle, light positions and directions,
   bounding box. All in the sim's body frame.
4. **Mesh copies** (`prepare.py`): one plain mesh per Blender object at the rest pose, modifiers
   applied, n-gons triangulated (tangents), expressed relative to its node's pivot; the seated pilot
   is decimated to about 60k triangles (small parts keep a floor of 300). Objects follow the bone
   they are parented to; skinned garments are frozen in the seated pose (part of `Airframe`).
5. **Skin bake** (`bake.py`). The Blender skin has no UVs (panel lines, RAM tape and coating patches
   are projected maps over a noise mottle). The skin copies get a Smart-UV-Project atlas, packed:
   atlas **A** (fuselage, fillets, fairings, canopy frame and sill, all doors) and atlas **B**
   (wings, stabilators, fins, flaperons, LEFs, rudders + the inlet lining and the nozzle). Cycles
   bakes base colour (EMIT pass of the Base Color input), roughness and metallic (combined into one
   ORM png: G roughness, B metallic) and tangent-space normals (the panel-line grooves and fastener
   heads; the 180/m grain bump is left out, it would alias). One joined stand-in object is baked
   with everything else hidden from render (Cycles otherwise rebuilds the whole scene per object).
   The skin materials become `F35_Skin_A`, `F35_Skin_B` (satin coat 0.5 / roughness 0.3, sheen 0.15
   as in Blender) and `F35_Misc_B` (inlet, nozzle; no coat).
6. **Materials** (`gltf_materials.py`): the other procedural materials become constant PBR with the
   same average look (ramps, mixes, checker weaves and noise reduced to their means); image textures
   are kept (decals, the PCD page, the pilot's patches and tablet). Light lenses keep their names
   (`F35_nav_red`, `F35_nav_green`, `F35_beacon`, `F35_formation`, `F35_landing_light`, plus the
   cockpit `F35_SwitchLED`) with emission strength 1 (the app switches them). Look-alike materials
   are merged (mostly the pilot's fabrics): 93 materials.
7. **Join** the copies per node, export glTF (Y up, tangents, the nozzle's `AB_Open` shape key as
   a morph target, no animations / skins), mark the decal materials `alphaMode BLEND`, write the
   rig json.

## Nodes

`Airframe` (everything fixed, incl. the pilot's body), `Canopy` (glass + frame + bow, hinged at the
front), `Stabilator_L/R`, `Flaperon_L/R`, `LEF_L/R`, `Rudder_L/R`, doors (`NoseGearDoor_L/R`,
`MainGearDoor_L/R`, `MainGearDoor_Fwd_L/R`, `MainGearDoor_Inner_L/R`, `BayDoor_Inner_L/R`,
`BayDoor_Outer_L/R`, `RefuelDoor`, `GunDoor`), `Tailhook`, the gear (`NG_Strut`, `NG_Steer`,
`NG_Wheel`, `NG_BraceUp`, `NG_BraceLo`, `NG_ActBarrel`, `NG_ActRod`, `MG_Strut_L/R`, `MG_Oleo_L/R`,
`MG_Wheel_L/R`, `MG_BraceUp_L/R`, `MG_BraceLo_L/R`, `MG_ActBarrel_L/R`, `MG_ActRod_L/R`), the
cockpit controls (`Stick`, `Throttle`, `Pedal_L/R`), the pilot's `Pilot_Head` (helmet, visor, mask)
and hands (`Pilot_Hand_L` on the throttle, `Pilot_Hand_R` on the stick) and `Nozzle` (with the
`AB_Open` morph target). All nodes are children of the glTF scene root, with a rest translation and
no rest rotation.

## f35i_rig.json

```
format "f35i-rig", version 1, generator, git (commit of the model scripts), blender, glb
frames      model: glTF scene frame (+X left, +Y up, +Z forward); body: +X right, +Y up, -Z forward
units       "m, rad"
compose     control order, innermost first (wheel spin inside the strut inside the retraction ...)
controls    name -> {default, min, max, desc, unit, x: [sample positions, ascending]}
            stick_pitch, stick_roll, pedals, throttle, flaps, speedbrake, gear, nws, roll_distance,
            weapon_bays, canopy, refuel_door, gun_door, tailhook (the sim's names, sim/DESIGN.md),
            head_yaw, head_pitch, head_tilt (rad; + = look left / up / tilt), strut_nose,
            strut_left, strut_right (m of compression from the modelled parked pose)
nodes       name -> {rest: [x,y,z] (model frame), controls: {...}, hinge?: {pivot, axis, min?, max?}}
            with a node hinge:      controls[c] = {a: [angle per sample]}  (angles add, then clamp)
            otherwise per control:  {pivot, axis, a: [...]}                 hinge of its own
                                    {q: [[x,y,z,w]...], t: [[x,y,z]...]}    rigid motion per sample
                                    {spin: {pivot, axis, rate}}             angle = rate * value
            pivots are relative to the node's rest position, model frame
morphs      node -> target -> control -> [weight per sample]   (Nozzle / AB_Open / throttle)
materials   {lights: material -> role, canopy: [...], decals: [...], all: [...]}
info        reference data, body frame (below)
stats       triangles, nodes, primitives, glb_mb, seconds
```

A node's transform is `T(rest) * L(outermost) * ... * L(innermost)` in `compose` order, where each
`L` is that control's delta (interpolated between samples). That is how the bone chain combines
them, so controls compose (a spinning wheel on a retracting, compressing, steering leg).

`info` (body frame: +X right wing, +Y up, -Z forward, origin = Blender (0, 0, 0) = station 7.835 m
behind the radome tip on the fuselage reference line, the FDM's CG):

| key | meaning |
| --- | --- |
| `eye`, `eyeForward` | pilot's eye point (between the corneas) and the helmet's straight-ahead (6 deg down) |
| `gearContacts[]` | `name` (nose / left / right), `pos` tyre bottom with the gear down and the **strut fully extended**, `radius`, `axis` (unit, the way the wheel moves as the strut compresses), `travel` (full stroke, m), `staticCompression` (stroke used in the modelled parked pose, 0.05 m), `posParked` (tyre bottom as modelled), `axle`, `axleDir`, `width`, `tyreDeflection` (the parked model's flattened tyre), `control` (rig strut control), `node` |
| `noseSteer` | steering axis, max angle (60 deg), control |
| `nozzle` | `exit` centre, `radius` (dry) / `radiusAB`, `axis` (exhaust direction, +Z), `throat`, `throatRadius`, `node`, `morph` |
| `lights[]` | `name`, `role` (nav, beacon, formation, landing), `pos`, `dir` (outward), `size`, `colour`, `node`, `nodePos` / `nodeDir` (model frame, relative to the node) |
| `landingLight` | the nose-gear lamp (on with the gear down and locked) |
| `bbox`, `length`, `span`, `height` | 15.69 m, 10.78 m, 4.68 m (gear down, model as parked) |
| `groundStance` | how the Blender scenes park it: `pitch` 1.45 deg nose up, reference point `refHeight` above the apron |
| `referencePoint` | station of the origin |

Struts: the model's gear is posed parked. The rig can extend each oleo 0.05 m below that pose
(fully extended, wheels in the air) and compress it by its stowage stroke (0.16 m nose, 0.175 m
main) above it, so `travel` is 0.21 m (nose) and 0.225 m (mains) and `pos` is the fully extended
contact. An FDM spring that settles at `staticCompression` under the parked weight puts the jet at
the Blender stance.

## Notes and limits

* The pilot's body is frozen in his seated pose; his hands follow the stick and throttle as rigid
  parts and the helmet turns with `head_*` (forearms do not bend, so large throttle travel shows a
  small gap at the wrist from outside).
* The nose-gear lamp sits square to the raked leg (its lens axis points ~12 deg up); the app aims
  the beam 3 deg below the body axis.
* The afterburner flame (`AB_Flame` in Blender) is not exported: the app draws a volumetric plume.
* Glass materials keep `KHR_materials_transmission` (canopy: gold-tinted, IOR 1.5, a 131 nm thin
  film of n 1.62 in Blender); the app replaces it by a cheaper two-pass glass.
* Decals are separate alpha-blended meshes lifted 1.8 mm off the skin.
