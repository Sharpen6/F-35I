# The cockpit: display, interior, canopy, the pilot's view

The pilot's side of the player's F-35I, as a graphics module (`js/aircraft/Cockpit.js`, added in
`main.js` `_addGraphicsModules`) and the cockpit camera (`js/ui/Cameras.js`). Everything is made
at start-up from the glb and from code: no new data files, nothing downloaded.

## What it does

**The panoramic cockpit display (PCD)** (`PCD.js`, `pages.js`, `systems.js`). The glb's baked
picture on the 20 x 8 inch glass (material `F35_PCD_Screen`) becomes a live canvas, redrawn 4-10
times a second from the flight model, in the layout of the public F-35 descriptions: a status bar
of format buttons with CAS, ALT, MACH, HDG, the steerpoint and the clock; a two-portal TSD moving
map (the terrain's own imagery, dimmed, heading up, range rings, the airfields, the wingmen, the
magenta line to the steerpoint, the range 5 / 10 / 20 / 40 NM chosen from the flight phase);
FUEL (the planform with its tanks filling, total, internal, flow, endurance, joker and bingo,
gross weight; the flight model's one fuel total split over the F-35A's tanks in a fixed transfer
order); ENG (N2, TET, nozzle, oil, fuel flow, thrust, IDLE / MIL / AB; TET and nozzle follow N2
and the afterburner inside the published F135 envelope); ICAWS (warnings, cautions and
advisories from the state: pull up, engine, gear, over-g, AoA, overspeed, canopy, fuel, parking
brake, gear in transit, speed brake, nose-wheel steering, hook); EFI (attitude, CAS, Mach,
altitude, vertical speed, AoA, g). Black background, the F-35 colour code (white, red, yellow,
green, magenta, purple for fuel). The clock is Israel's (UTC+2/+3) from the solar time.
The glass has an anti-reflection coat: a faint sky reflection over the picture. Its brightness
follows the exposure every frame (an automatic brightness control): the same picture level by
day and at night, a little dimmer at night. The canvas is only redrawn while it can be seen.

**The interior** (`interior.js`, `interiorWorker.js`, `detail.js`). The glb's light greys become
a dark grey satin (the real tub is a dark charcoal), the canopy bow a matte dark frame, the two
light pads on the glare shield dark. The airframe and canopy meshes are one skin, painted outside
grey: a worker finds the skin's faces that the pilot sees (a voxel flood fill of the cockpit air
from the eye, then exact rays against a triangle grid: towards the eye points, through the glass,
out of the tub) and an interior mesh draws them with the interior paint (same vertex buffers,
the index reordered into ranges, no copy). A floor plate closes the gap between the pedals. Per
vertex ambient occlusion (rays in the same grid): the tub is lit by the sky through the canopy
only. A shader patch on the cockpit and pilot materials applies that occlusion to the sky light,
adds the display's glow (a small area light at the PCD) and a triplanar detail (paint grain and
smudges). The glow and the canopy reflections use the display's physical luminance (~1,000 cd/m2,
`PCD_LIGHT_MAX`): lost in the daylight, as in reality, and at night glowGain (x120, a
dark-adapted eye) on the tub. The switch LEDs and the kneeboard tablet follow the exposure like
the PCD. The paint applies at start-up; the analysis runs once in a worker (1-6 s on a loaded
machine) and the inner faces, the occlusion, the glow and the detail follow when it is done.

**The canopy glass** (`canopy.js`). A third pass over the glb's canopy (`materials.js` draws the
amber tint and the outer reflections): dust, smudges and fine cleaning scratches on the acrylic
scatter the sunlight (a forward-peaked Henyey-Greenstein phase): nearly invisible on the clean
glass, a glare that lights up the streaks when looking towards a low sun. From inside, the inner
surface reflects the cockpit with Fresnel: the lit PCD, ray-traced off the glass onto the
display's rectangle and its live canvas at the display's physical luminance (lost in the
daylight; at night the reflections pilots know), and a faint veil from the sunlit interior.
Additive, no depth write, one draw, four texture reads per pixel.

**The pilot's view** (`js/ui/Cameras.js`). Framing from the model's design eye: the view centre
8.5 deg below the jet's axis puts the canopy bow's apex (its lower to its upper edge) 18-26 deg
above the centre along the top of the picture and the glare shield 11.6 deg below the horizon in
cruise (measured, 3 deg AoA), the PCD below it. Look-around (mouse drag, hat, numpad) with
rates that build up and die away and a little smoothing of the view (a head has mass); the head
turns about the neck (the eyes 7 cm above and 9 cm ahead of the pivot), beyond ~60 deg the torso
twists and leans out to see behind, and the pilot leans forward to look down into the consoles. The seat vibrates on the runway (a knock
at every slab joint, roughness growing with speed), drops at the touchdown with the sink rate,
shakes in the high-AoA buffet: damped springs per axis, millimetres and hundredths of a degree.
The wheel zooms smoothly between 20 and 80 deg (vertical field of view).

**The pilot and the controls.** The glb's pilot (body, arms, knees, hands on the stick and the
throttle) stays in the cockpit view; only the face and neck (`P2_Skin`, `P2_TShirt`, part of the
merged airframe mesh) are hidden with the camera at the eye. The side-stick, the hand on it and the
rudder pedals follow the pilot's inputs (the rig moved them with the control surfaces, which in a
fly-by-wire jet are not where the pilot holds them; 50 ms of lag); the throttle follows the lever.

## Switches and quality

| | |
| --- | --- |
| `?cockpit=0` | the module off: the glb's cockpit as exported |
| `?shake=0` | no cockpit vibration (runway, touchdown, buffet); `app.cams.vibration` scales it (0-1) |
| `quality=low` | PCD 1024 x 410 px at 4 Hz, no canopy pass, no paint detail |
| `quality=medium` | PCD 1600 x 640 px at 6 Hz, canopy pass, paint detail |
| `quality=high` | PCD 2048 x 819 px at 10 Hz, canopy pass, paint detail |

(`COCKPIT_QUALITY` in Cockpit.js, `PCD_QUALITY` in PCD.js.) In the console:
`__sim.app.cockpit` (`.pcd.drawMs`, `.interiorStats`, `.interior.glowGain`, `.displayDay`,
`.displayNight`), `__sim.app.cams.cockpitLookDown`, `.cockpitFovRange`.

## Materials it overrides (player's jet only; the wingmen keep the glb)

| material | change |
| --- | --- |
| `F35_PCD_Screen` | replaced by `F35_PCD_Screen_live` (live canvas as emissive map, AR-coated black glass) |
| `F35_cockpit`, `F35_cockpit_panel` | repainted dark grey satin (#303336, #26282b), detail, occlusion, glow |
| `F35_canopy_bow` | matte dark frame (#1d1e20, roughness 0.86) |
| `F35_glare_pad` | dark (#27282b) |
| `F35_seat`, `F35_seat_cushion` | dark grey (#35383a), olive-grey cushion (#4d5145) |
| `F35_Skin_A` (inner faces) | drawn by the new `F35_cockpit_interior` / `_back` (#313437) on `Airframe_2_interior`, `Canopy_2_interior`, `*_interior_back` |
| `F35_yellow_black`, `F35_switch_guard`, `F35_switch`, `F35_gear_handle`, `F35_hose`, all `P2_*` | occlusion and glow only |
| `F35_SwitchLED`, `P2_TabletScreen` | emission follows the exposure |
| `P2_Skin`, `P2_TShirt` | hidden with the camera at the eye |
| `F35_canopy_tint` (mesh) | an extra pass `F35_canopy_cockpit` (dust, scratches, reflections) |
| new `Cockpit_FloorPlate` | the floor between the pedals |
| rig nodes `Stick`, `Pilot_Hand_R`, `Pedal_L`, `Pedal_R` | re-posed from the inputs after the rig |

`setEnabled(false)` on the interior and `?cockpit=0` give the original look back.

## Cost

Measured in SwiftShader at 960 x 540 (`renderInfo()`, `?cockpit=0` -> on; the terrain streams,
so the draw calls move by 1-2 between runs):

| quality | view | draw calls | triangles | programs |
| --- | --- | --- | --- | --- |
| low | Tel Nof 36, noon, ahead | 242 -> 249 | 1,057,024 -> 1,060,504 | 24 -> 28 |
| low | Tel Nof 36, noon, looking down | 260 -> 268 | 503,801 -> 507,970 | 26 -> 30 |
| low | cruise 3,000 m, noon, ahead | 257 -> 264 | 960,766 -> 964,246 | 37 -> 45 |
| medium | Tel Nof 36, noon, ahead | 234 -> 242 | 1,057,024 -> 1,079,532 | 24 -> 29 |
| medium | Tel Nof 36, noon, looking down | 260 -> 269 | 503,801 -> 526,998 | 26 -> 31 |
| medium | cruise 3,000 m, noon, ahead | 257 -> 264 | 960,766 -> 983,274 | 37 -> 46 |
| high | Tel Nof 36, noon, ahead | 232 -> 242 | 1,057,024 -> 1,079,532 | 23 -> 29 |
| high | Tel Nof 36, noon, looking down | 260 -> 269 | 503,801 -> 526,998 | 26 -> 31 |
| high | cruise 3,000 m, noon, ahead | 257 -> 265 | 960,766 -> 983,274 | 37 -> 46 |

`gpuMemory()` 650.5 -> 654.9 MB (low), 682.3 -> 686.1 MB (medium), 779.9 -> 787.0 MB (high): an
estimate that counts the interior meshes' shared buffers again; the real additions are the PCD
canvas 2.1 / 5.2 / 8.5 MB at low / medium / high with mips, the detail texture 1.3 MB and the
occlusion attribute 0.2 MB. Samplers: at most 4 in a patched
cockpit program, 2 in the canopy pass (limit 16). CPU: a PCD redraw 1-2.7 ms (4-10 per second,
only while visible; the first one 60-350 ms at start-up), the interior analysis 1.4-5.7 s once in
a worker, 65-95 ms on the main thread at start-up to gather the meshes; 61 materials patched,
5-9 new programs (compiled once by the first render after the analysis, normally behind the
menu). Expected on an RTX 3070 at 1080p: about 0.3-0.5 ms a frame (the canopy pass over most of
the screen from inside, the detail on the cockpit, the canvas upload a few times a second).

## How it was checked

Screenshots through the test API (`?test=1`, 960 x 540) at Tel Nof 36 on the runway and in
cruise at 3,000 m off Tel Aviv, at noon, 07:00, sunset and night, looking ahead, left, right,
down and back; outside views of the tub with the canopy closed; A/B against `?cockpit=0` and
with the glow and reflections off. `tests/e2e.mjs` passes.

## Credits and licences

All of it is procedural and made here (the display pages, the detail texture, the paint, the
analysis). The TSD's moving map shows the terrain's imagery (`data/terrain/color`, ESA
WorldCover / Copernicus Sentinel-2, CC BY 4.0, credited in `sim/README.md` and in the menu).
The display's layout and colour code follow public descriptions of the F-35 PCD; no picture of
it was copied.

## Known limits

* The PCD picture level and the reflections use the exposure of `renderer.toneMappingExposure`
  (or `env.displayExposure` when the lighting provides it); a post chain that changes the meaning
  of the exposure needs the two in step.
* The PCD's headings follow the helmet's reference where the helmet publishes it
  (`hmd.last.magVar`, `hmd.last.conv`: magnetic in the flight branch); otherwise both show the
  flight model's grid heading.
* `gpuMemory()` counts the shared geometry of the interior meshes twice.
* The pilot's head node does not turn with the look in the outside views.
* The interior paint ends where the skin's triangles end: a stepped edge along the top of the
  canopy sills, hidden under the closed canopy's frame, visible with the canopy open.
* The interior analysis runs once at start-up (1-6 s, a module worker); until it is done the
  skin's inner faces keep the outside grey and there is no occlusion. If it fails (a console
  warning), the paint and the glow still apply, without the inner faces and the occlusion.
