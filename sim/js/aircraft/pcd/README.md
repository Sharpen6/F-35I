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
day and at night, a little dimmer at night. The systems model runs every frame; the canvas is
redrawn only while it can be read: from the seat, or in view and over ~60 px wide. The TSD's
imagery would be minified 3-6:1 at the long ranges, where a canvas's smoothing skips texels and
the map sparkled as it turned: the imagery has its own mip levels (2048 down to 256 px, made
once) and the TSD draws the one minified at most ~1.4:1. No garbage per frame (the systems'
messages, the fuel split and the wingmen's symbols are kept objects). The canvas texture is stored
as plain RGBA8 and the display material and the canopy decode its sRGB in their shaders (as
three.js does for video): as an sRGB texture every upload of the canvas stalled the main thread
for 55-65 ms in Chrome on Windows (ANGLE / D3D11, measured on an RTX 3070 at both canvas sizes,
with and without mip levels), ten times a second, and the cockpit view juddered.

**The interior** (`interior.js`, `interiorWorker.js`, `shadow.js`, `detail.js`). The glb's light
greys become the real tub's dark grey: a satin #45484b, the panels a shade darker, the canopy bow
and the two pads on the glare shield a near-black matte. The airframe and canopy meshes are one
skin, painted outside grey: a worker finds the skin's faces that the pilot sees (a voxel flood
fill of the cockpit air from the eye, then exact rays against a triangle grid: towards the eye
points, through the glass, out of the tub) and an interior mesh draws them with the interior
paint (same vertex buffers, the index reordered into ranges, no copy). Along the sills the skin's
triangles cross from inside to outside: each vertex gets the share of interior faces round it
(by area, over welded positions) and the paint ends on the 0.5 line of that share, cut with a
pixel of coverage (alpha to coverage) and drawn 0.03 % nearer the eye over the skin: a smooth
line instead of the triangles' saw-tooth. A floor plate closes the gap between the pedals.

How the tub is lit: per-vertex ambient occlusion (rays in the same grid) lets the sky in through
the canopy only, never below 33 % (the light the tub's own surfaces pass round, on the sky and its
reflections alike); a bounce term spreads 20 % of the light that falls on the canopy's opening (the
sun on it, the sky) over the tub, less in its corners. The sun itself is shadowed by the cockpit's
own shadow map (`shadow.js`): the scene's sun shadow covers hundreds of metres with a ~0.8 m bias,
so inside the tub it shadowed nothing and a low sun lit the knees and the floor through the sills.
A depth map of the aircraft seen from the sun, framed on the cockpit (1024 or 2048 texels, 2-4 mm
each), looked up with a normal offset of a few millimetres: the sills, the canopy frame, the seat
and the pilot (his head too, hidden at the eye) cast their shadows inside. It lives in the
aircraft's frame: redrawn when the light turns there (0.1-0.15 deg), the canopy moves, or the stick
and the throttle move (10-20 times a second at most; parked, every 2 s); the lookup matrix (view
space to the map) is made in doubles every frame. A shader patch on the cockpit and pilot materials
applies all of it, adds the display's glow (a small area light at the PCD) and a triplanar detail
(paint grain and smudges). The glow and the canopy reflections use the display's physical luminance
(~1,000 cd/m2, `PCD_LIGHT_MAX`): lost in the daylight, as in reality, and at night glowGain (x120,
a dark-adapted eye) on the tub. The switch LEDs and the kneeboard tablet follow the exposure like
the PCD. The paint applies at start-up; the analysis runs once in a worker (1-6 s on a loaded
machine) and the inner faces, the occlusion, the shadow, the glow and the detail follow when it is
done. The frame constants (analysis box, floor plate, eye offsets, outside points) are checked
against the model at start (`_checkFrame`: the box grown to hold the canopy glass, the plate left
out unless it sits under the pedals, a warning otherwise).

**Displays in an HDR frame.** The PCD, the switch LEDs and the kneeboard tablet write alpha 0
into the frame (`DISPLAY_ALPHA` in interior.js; opaque materials write 1, blended ones at least
0.75 over them): a post chain can keep them in colour when its night vision greys the dark scene
(they are photopic, hundreds of cd/m2 at their picture level). In `js/env/Post.js` that is one
line after its night-vision weight: `k *= step(0.5, texture(tScene, vUv).a);`. Drawn straight to
the canvas (no alpha) it has no effect.

**The canopy glass** (`canopy.js`, its texture `makeGlassTexture` in `detail.js`). A third pass
over the glb's canopy (`materials.js` draws the amber tint and the outer reflections): dust,
smudges and wipe marks on the acrylic scatter the sunlight forward (a Henyey-Greenstein lobe): a
veil round the sun when looking towards it, nothing away from it. The cleaning scratches (swirls
and a few straight ones, 0.25-0.45 mm hairlines in a 1024² texture made the first time the pass
is on) carry their direction in the texture: a scratch scatters the light into a cone about its
own line, so only those lying across the line to the sun light up: thin arcs round the sun, as
through every cleaned canopy, fading with the angle from it. From inside, the
inner surface reflects the cockpit with Fresnel: the lit PCD, ray-traced off the glass onto the
display's rectangle and its live canvas at the display's physical luminance (lost in the
daylight; at night the reflections pilots know), and a faint veil from the sunlit interior
(its albedo, the sun and the sky on it). All of it is radiance in scene units: into the HDR frame
of a post chain it is added as it is, before the exposure and the tone curve; drawn straight to
the canvas (each material tone-maps itself) it adds the tone curve's increment over a typical
background with a screen blend. The maths runs in the glass mesh's own frame, the camera and the
sun brought into it on the CPU in doubles: world positions 30 km out sit on a 2 mm float32 grid,
which showed as blocks in the glare. Additive, no depth write, one draw, four texture reads per
pixel.

**The pilot's view** (`js/ui/Cameras.js`). Framing from the model's design eye: the view centre 8.5
deg below the jet's axis puts the canopy bow's apex (its lower to its upper edge) 18-26 deg above
the centre along the top of the picture and the glare shield 11.6 deg below the horizon in cruise
(measured, 3 deg AoA), the PCD below it. Look-around (mouse drag, hat, numpad) with rates that
build up and die away and a little smoothing of the view (a head has mass); the head turns about
the neck (the eyes 7 cm above and 9 cm ahead of the pivot), beyond ~60 deg the torso twists and
leans out to see behind, and the pilot leans forward to look down into the consoles. The seat
vibrates on the runway (a knock at every slab joint, roughness growing with speed), drops at the
touchdown with the sink rate, shakes in the high-AoA buffet: damped springs per axis, millimetres
and hundredths of a degree. The wheel zooms smoothly between 20 and 80 deg (vertical field of
view).

**The pilot and the controls.** The glb's pilot (body, arms, knees, hands on the stick and the
throttle) stays in the cockpit view; only the face and neck (`P2_Skin`, `P2_TShirt`, part of the
merged airframe mesh) are hidden with the camera at the eye. The side-stick, the hand on it and the
rudder pedals follow the pilot's inputs (the rig moved them with the control surfaces, which in a
fly-by-wire jet are not where the pilot holds them; 50 ms of lag); the throttle follows the lever.
The exported rig turns the Stick about swapped axes (a pull slid it to the right) and swings the
Throttle sideways into the left wall (the bones' roll in `scripts/f35/rig.py` points their X axis
fore and aft): each lever's hinge is checked against the motion a positive input must give (pull
aft, roll right to the right, more throttle forward) and rebuilt about the right axis through the
same pivot when it disagrees, the hands turning with it (`cockpit.inceptorFix` lists what was
rebuilt; a corrected export is used as it is).

## Switches and quality

| | |
| --- | --- |
| `?cockpit=0` | the module off: the glb's cockpit as exported |
| `?shake=0` | no cockpit vibration (runway, touchdown, buffet); `app.cams.vibration` scales it (0-1) |
| `quality=low` | PCD 1024 x 410 px at 4 Hz, no canopy pass, no paint detail, no cockpit shadow map |
| `quality=medium` | PCD 1600 x 640 px at 6 Hz, canopy pass, paint detail, cockpit shadow 1024² (redrawn at a 0.15 deg turn of the light, at 10 Hz with the stick moving) |
| `quality=high` | PCD 2048 x 819 px at 10 Hz, canopy pass, paint detail, cockpit shadow 2048² (0.1 deg, 20 Hz) |

(`COCKPIT_QUALITY` in Cockpit.js, `PCD_QUALITY` in PCD.js, `SHADOW_QUALITY` in shadow.js.) In
the console: `__sim.app.cockpit` (`.pcd.drawMs`, `.pcd.redraws`, `.interiorStats`,
`.interior.glowGain`, `.interior.fill`, `.interior.setEnabled(false)`, `.shadow.redraws`,
`.shadow.setQuality('low')` (the shadow map off),
`.canopy.dirt`, `.displayDay`, `.displayNight`, `.inceptorFix`, `.leverTips()`),
`__sim.app.cams.cockpitLookDown`, `.cockpitFovRange`.

## Materials it overrides (player's jet only; the wingmen keep the glb)

| material | change |
| --- | --- |
| `F35_PCD_Screen` | replaced by `F35_PCD_Screen_live` (live canvas as emissive map, AR-coated black glass, alpha 0) |
| `F35_cockpit`, `F35_cockpit_panel` | repainted dark grey satin (#45484b, #3a3c40), detail, occlusion, bounce, sun shadow, glow |
| `F35_canopy_bow` | matte dark frame (#2a2b2e, roughness 0.86) |
| `F35_glare_pad` | dark (#2c2d30) |
| `F35_seat`, `F35_seat_cushion` | dark grey (#45484a), olive-grey cushion (#575b4e) |
| `F35_Skin_A` (inner faces) | drawn by the new `F35_cockpit_interior` / `_back` (#45484c) on `Airframe_2_interior`, `Canopy_2_interior`, `*_interior_back`; the paint's edge cut along the interior share |
| `F35_yellow_black`, `F35_switch_guard`, `F35_switch`, `F35_gear_handle`, `F35_hose`, all `P2_*` | occlusion, bounce, sun shadow and glow only |
| `F35_SwitchLED`, `P2_TabletScreen` | emission follows the exposure; alpha 0 (displays) |
| `P2_Skin`, `P2_TShirt` | hidden with the camera at the eye |
| `F35_canopy_tint` (mesh) | an extra pass `F35_canopy_cockpit` (dust, scratches, reflections) |
| new `Cockpit_FloorPlate` | the floor between the pedals |
| rig nodes `Stick`, `Pilot_Hand_R`, `Throttle`, `Pilot_Hand_L`, `Pedal_L`, `Pedal_R` | re-posed from the inputs after the rig (lever hinges rebuilt where the rig's are swapped) |

`setEnabled(false)` on the interior (paint, inner faces, floor plate, the patch's terms, the
emission) and `?cockpit=0` give the original look back.

## Cost

Measured in SwiftShader at 960 x 540 (`renderInfo()` of the cockpit view, the module of the first
round (4c292c5) -> this one; the terrain streams, so the draw calls move by 1-2 between runs):

| quality | view | draw calls | triangles | programs |
| --- | --- | --- | --- | --- |
| low | Tel Nof 36, noon, ahead | 257 -> 257 | 1,060,504 -> 1,064,078 | 28 -> 31 |
| low | Tel Nof 36, noon, looking down | 268 -> 268 | 507,970 -> 511,544 | 30 -> 33 |
| low | cruise 3,000 m, noon, ahead | 262 -> 262 | 976,534 -> 980,108 | 45 -> 50 |
| medium | Tel Nof 36, noon, ahead | 258 -> 258 | 1,079,532 -> 1,083,106 | 29 -> 33 |
| medium | Tel Nof 36, noon, looking down | 269 -> 269 | 526,998 -> 530,572 | 31 -> 35 |
| medium | cruise 3,000 m, noon, ahead | 265 -> 264 | 995,562 -> 999,136 | 46 -> 52 |
| high | Tel Nof 36, noon, ahead | 258 -> 258 | 1,079,532 -> 1,083,106 | 29 -> 33 |
| high | Tel Nof 36, noon, looking down | 269 -> 269 | 526,998 -> 530,572 | 31 -> 35 |
| high | cruise 3,000 m, noon, ahead | 265 -> 265 | 995,562 -> 999,136 | 46 -> 52 |

The whole module at medium (`?cockpit=0` -> on, Tel Nof ahead): 250 -> 258 draw calls, 1,057,024 ->
1,083,106 triangles, 24 -> 33 programs, `gpuMemory()` 670.0 -> 682.1 MB. This round adds the
paint's edge strip along the sills (3,574 triangles) and 3-6 programs (the cockpit shadow variants,
the display's alpha, the depth pass). `gpuMemory()` 643.1 -> 641.9 MB (low), 677.9 -> 682.1
(medium), 777.3 -> 781.4 (high): the glass texture (1024², made only with the canopy pass) is the
change; the estimate counts the interior meshes' shared buffers again and does not see the cockpit
shadow map (5 / 20 MB at medium / high). The other real additions (MB of 2^20 bytes, as
`gpuMemory()`): the PCD canvas 2.1 / 5.2 / 8.5 MB at low / medium / high with mips, the paint
detail texture 1.3 MB, the occlusion attribute 0.2 MB, the TSD imagery's smaller mip levels 6.5
MB (bitmaps the canvas draws, beside the 2048 / 1024 copies' 20 MB). Samplers: at most 5 in a
patched cockpit program (the shadow map is the fifth), 2 in the canopy pass (limit 16). The shadow
pass (not in `renderInfo()`, which counts the last render): 100-109 depth draws of the airframe
when it is redrawn: parked once every 2 s, 10-20 times a second at most with the stick moving or
the aircraft turning against the sun. CPU: a PCD redraw 1.8-6.6 ms (4-10 per second, only while it
can be read; the first one 0.1-0.9 s at start-up with the TSD's imagery), the interior analysis 3-6
s once in a worker, the glass texture 0.1-0.2 s once; 61 materials patched, the new programs
compiled once by the first render after the analysis, normally behind the menu. Expected on an RTX
3070 at 1080p: about 0.3-0.5 ms a frame in the cockpit view (the canopy pass over most of the
screen from inside, the five shadow taps and the detail on the cockpit, the canvas upload a few
times a second), and when the shadow map is redrawn 0.1-0.3 ms of GPU and 0.3-0.6 ms of CPU for its
~100 draws. Measured there (PC trial 3, tlv_3000, 1080p high, uncapped): 4.2 ms a frame on average
in the cockpit, 4.4 ms with the cockpit module off; with the canvas still an sRGB texture it was
5.3 ms, with ten frames a second of 55-65 ms (each canvas upload).

## How it was checked

Screenshots through the test API (`?test=1`, 960 x 540) at Tel Nof 36 on the runway and in
cruise at 3,000 m off Tel Aviv, at noon, 07:00, sunset and night, looking ahead, left, right,
down, at the sills and into the sun; outside views of the tub with the canopy closed; A/B against
`?cockpit=0` and with the glow and reflections off; on this branch alone (three's ACES per
material) and on a trial merge with the lighting fix (`js/env/Post.js`: HDR frame, AgX), on
which the walls were calibrated: the side walls below the sills at noon, looking left and right,
an 8-bit median of 37-58 (1-19 before, on the lighting branch), 16-32 on this branch alone (0-10
before). At sunset the sunlit patch on the knees through the sill (8-bit p90 112) is gone (p90
50; 29 in the merged frame). At night on the merged frame with the Post.js line the display keeps
its colours (mean saturation of its lit pixels 0.30, 0.12 without the line, 0.40 on this branch).
The stick and throttle tops measured in the glTF frame: a full pull 3.6 cm aft, full right roll
3.6 cm to the right, MIL 8.2 cm forward, the right pedal 4.5 cm forward with right rudder.
The TSD at the 40 NM range, turned 0.3 deg: the mean change of its portal (the turn plus the
sparkle) 4.2 before the mip levels, 3.5 with them on the high canvas, 4.9 and 2.8 on the low.
`tests/e2e.mjs` checks the interior analysis (over 3,000 inner faces, no gap), the display
redrawn in the cockpit and not from the chase view, the cockpit shadow on, and the stick (a pull
aft, roll right to the right) and the throttle (MIL forward) moving the right way; it passes.

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
* `gpuMemory()` counts the shared geometry of the interior meshes twice, and does not see the
  cockpit shadow map (5 / 20 MB at medium / high: `cockpit.shadow.bytes()`).
* The pilot's head node does not turn with the look in the outside views.
* The interior analysis runs once at start-up (1-6 s, a module worker); until it is done the
  skin's inner faces keep the outside grey and there is no occlusion or cockpit shadow. If it
  fails (a console warning), the paint and the glow still apply, without the inner faces and the
  occlusion.
* No cockpit shadow map with a reversed depth buffer (`?depth=reversed`, a console note): the
  tub then has the scene's sun shadow only.
* The displays' alpha mask (`DISPLAY_ALPHA`) needs the one-line use in the post chain's night
  vision (above); until then a dark-adapted night greys the PCD's darker colours like the scene.
* The rig's Stick and Throttle hinges are rebuilt at run time; the export
  (`scripts/f35/rig.py`: the bones' roll) should give them the right axes.
