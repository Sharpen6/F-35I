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
and the glare shield near-black (both rebuilt below). The airframe and canopy meshes are one
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

**The frame, coaming, display bezel, consoles, seat and sills** (`parts.js`, built from
`frame.js`, `coaming.js`, `bezel.js`, `consoles.js`, `seat.js`, `sills.js` on `shapes.js`). The
glb (`scripts/f35/canopy.py`, `cockpit.py`) makes the pilot's surroundings from boxes: the canopy
bow a slab under the glass, 8.5 cm wide and 2.6 cm deep with square edges (from the seat, 35-50 cm
away, a thick matte black arch over the forward view), the glare shield a 3 cm slab with two boxes
on it ("a flat box with two bumps"), the display in four square bars, the consoles two flat slabs,
the seat's headbox and beams blocks, the canopy's side frame a bare strip. At start-up, before the
interior analysis (so that the worker's occlusion, the cockpit shadow and the paint take them like
the glb's own parts), each is rebuilt from the glb's own geometry, in its place and at its size:

* the bow (`frame.js`): the glb's arch kept exactly (its rings walked off the glb mesh: seen from
  outside through the glass it does not move) and its band too, ring by ring (8.6-9.0 cm: the glb
  narrows it towards the sills), swept with the section of a frame bonded under the one-piece
  transparency (photos of the F-35's canopy from outside and over the pilot's shoulder): a 4 mm
  flange against the glass, a body 3.7 cm wide and 2.2 cm deep whose 6.5 mm rounded edges catch the
  sky, a light grey bead of sealant along both edges where the band meets the glass, and on each
  leg a light grey handhold, a round bar standing 3.4 cm off the body's aft side a hand's width
  above the sill. No bolt heads on its inner face and no mirrors (the F-35 has none: the view behind
  is the DAS on the helmet). From the eye at the top of the arch it is 5.4 deg thick (the glb's
  slab 7.7); satin dark grey (#3d4044, roughness 0.5), between the panels' grey and the tub's. Its
  target: at noon looking ahead a body no darker than the glb slab's face (40 or more, 8-bit) with
  a lighter edge, at 07:00 into the sun legs of 30 or more; measured a body of 42-57 (mean 51-52)
  between edges of 97-159 (the glb's face 46-49) and legs of 35-36 (below, how it was checked);
* the coaming (`coaming.js`): the F-35 has no HUD; a low hood in the glb slab's place: a bull-nosed
  lip 2 cm high over the display, the top sloping 10 deg down to a rounded front edge, the
  underside rising from the front as a brow over the display, the ends bevelled at 45 deg (the
  glb's sides) and the lip's rear corners rounded in plan (8 mm), a flat black anti-glare finish
  (#1e1f21, roughness 0.93); the two pads as low housings with rounded edges (#57534b), both their
  ends chamfered down to the hood. Its outline seen from the eye is the helmet's `COAMING` line
  (`js/ui/HMD.js`, which holds the flight path marker above it; measured from the glb every 1 deg):
  the hood and the pads are fitted to it from the rig's eye, and where the line cuts a corner
  between two of its samples (the pads' ends, the lip's rear corners) the part follows the cut.
  Measured every 0.5 deg by exact rays (`tests/cockpit_parts.test.mjs`): at most 0.015 deg above
  the line, at most 0.095 deg under it; the helmet and its e2e check are unchanged;
* the display's bezel (`bezel.js`): a moulded frame round the 20 x 8 in glass, its face 1.8 cm
  wide and 4.5 mm proud with a chamfered lip down to the glass and rounded corners, a slim mullion
  between the two halves, eight screws in the bezel's own paint; the glb's bars and divider
  dropped (the glass, its picture and its mapping are the glb's);
* the side consoles (`consoles.js`): each console's top (the panel mesh's long boxes out at the
  sides) cut into Dzus-fastened panels, a fighter's 5.75 in panels held by a quarter-turn fastener
  at every corner (its head in the panel's paint): one panel per row of the glb's switches, blank
  panels fore and aft, plates round the throttle's track and the stick's base, a black base that
  reads as the seams between them; the panels in a low-sheen paint (roughness 0.66);
* the seat (`seat.js`): the headbox and the two main beams of the glb's seat (its islands inside
  three boxes, sized from their own points) as rounded boxes, the headbox under a lid, the beams
  with a guide strip and a row of bolts in the seat's paint;
* the canopy's side frame and the sills (`sills.js`): the tub's wall, the canopy frame and the
  glass are sliced every 2.5 cm from behind the seat to the instrument panel; along the canopy
  frame's inner face a liner panel with the transparency's retaining strip, a bolt every 9 cm and a
  rubber seal at its foot (built with the canopy shut, in the frame mesh: it moves with the
  canopy); over the tub wall's crest a rounded cap with screws every 7 cm (the sky catches it as a
  soft highlight instead of a hard line).

The replaced glb meshes are hidden (and skipped by the analysis, `userData.ckSkip`); in the merged
cockpit and seat meshes their islands (found inside fixed boxes) are dropped from the index. The
new meshes take the material of the part they replace or one of three new ones
(`F35_glare_shield`, `F35_canopy_fitting`, `F35_console_panel`), clones of the cockpit panels'
material: the same shader program before and after the interior's patch, so nothing compiles when
they first come into view. A fastener's head is part of the surface it holds (one mesh, its
paint, its crown the surface's own cavity): a low dome with a dark foot that catches the light
like the panel round it, not a bright dot (at noon, zoomed: -2 to +12 sRGB against the panel round
it on the consoles, mean +3; a soft shading on the liner; the bare metal heads of the first round
stood 55-77 over it). A fixed occlusion per vertex (`ckCavity`, multiplied into the analysis's)
darkens the creases the analysis's 1.5 cm voxels cannot resolve (a fastener's foot, a flange's
root, a panel seam); it is 1 on the open faces. The bow and the frame's liner are 'frame' parts
for the analysis: walls for the rest of the cockpit but not for their own vertices (a 2 cm part in
1.5 cm voxels shaded itself), and their occlusion counts what lies within 45 cm only (they hang
under the glass, open on both sides: the sunlit cockpit below them is light, which the bounce term
stands for, not shade): the bow's mean occlusion 0.85 (0.48 in the first round; the glb slab
0.88). Ten meshes, merged by parent, transform and material into seven; 35,442 triangles.

`build()` makes one part per task (it yields before each, `scheduler.yield()`, else a timeout:
the browser draws and handles input between them, and the first is not added to the model's load;
the glb meshes' welds are made once, a hash weld) and each part is a transaction: its new meshes,
the glb meshes it hides and the triangles it drops are all made first and put in place at once,
so a part whose glb source is not as expected (a console warning; `cockpit.parts.stats` says
which) leaves the glb's part exactly as it was. The interior analysis starts in a task after the
last part (`cockpit.ready`). `cockpit.parts.setEnabled(false)` puts the glb's
parts back and `?ckparts=0` leaves them all. Not built: rear-view mirrors (the F-35 has none) and
legends on the console panels.

## Switches and quality

| | |
| --- | --- |
| `?cockpit=0` | the module off: the glb's cockpit as exported |
| `?ckparts=0` | the glb's bow, glare shield, display frame, consoles, seat and canopy frame as exported (the rest of the module on) |
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
| `F35_canopy_bow` | satin dark grey frame (#3d4044, roughness 0.5); on the rebuilt bow and the canopy frame's liner |
| `F35_glare_pad` | the pads' housings (#57534b, roughness 0.85) |
| `F35_seat`, `F35_seat_cushion` | dark grey (#3a3c3f), olive-grey cushion (#575b4e) |
| new `F35_glare_shield`, `F35_console_panel`, `F35_canopy_fitting` | clones of `F35_cockpit_panel`: the coaming's hood, the consoles' base and the display's bezel flat black (#1e1f21, roughness 0.93); the console panels in a low-sheen paint (#2b2d30, roughness 0.66); the bow's sealant beads and handholds light grey (#8b8e90, roughness 0.62). Fastener heads take the paint of the part they hold |
| new meshes (`parts.js`) | `Canopy_Bow_Frame+Canopy_Frame_Liner`, `Canopy_Bow_Fittings` (under the canopy), `Coaming_Hood+Console_Base+PCD_Bezel`, `Coaming_Pads`, `Seat_Rebuilt`, `Console_Panels`, `Cockpit_Sill_Cap`; the glb's `Canopy` bow and glare pads hidden, the glare shield, the display's frame and the seat's headbox and beams dropped from their merged meshes |
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
~100 draws. Measured there (PC trial 3, tlv_3000 at 3,000 m, 1080p high, uncapped, 5 s): 4.4 ms a
frame on average in the cockpit, worst 13.5 ms, the same as with the module off (4.4 ms, worst
11 ms); with the canvas still an sRGB texture it was 5.3 ms, with ten frames a second of 55-65 ms
(each canvas upload).

The rebuilt parts (`parts.js`): 35,442 triangles and 23,479 vertices in seven meshes, in place of
two glb meshes (the bow, the pads) and 492 triangles dropped from the cockpit's and the seat's
merged meshes; 0.74 MB of buffers (positions, normals, the index) and the occlusion byte (23 KB).
`gpuMemory()`, which counts what is drawn, 690.6 -> 690.1 MB at low and 737.7 -> 736.9 at medium:
the glb's bow and pads, hidden before the first frame, are never uploaded. Each of the seven is
drawn once in every pass that draws the jet: the view, the sun's shadow map (the environment makes
every mesh of the jet a caster) and the cockpit's own shadow map when it is redrawn (100 -> 105
draws, 196 k -> 230 k triangles at medium): 5 draws more a pass. Measured at Tel Nof 36 at noon in
one page, the glb's parts (`cockpit.parts.setEnabled(false)`) -> the rebuilt ones, the fewest
calls and triangles of two frames each:

| quality | view | draw calls | triangles |
| --- | --- | --- | --- |
| low | ahead | 288 -> 296 | 1,688,593 -> 1,711,515 |
| low | looking down | 315 -> 321 | 1,206,116 -> 1,253,492 |
| low | looking back | 369 -> 378 | 1,493,327 -> 1,560,645 |
| low | down and left | 317 -> 327 | 1,285,526 -> 1,354,210 |
| medium | ahead | 277 -> 284 | 1,659,382 -> 1,727,146 |
| medium | looking down | 312 -> 319 | 1,245,854 -> 1,291,666 |
| medium | looking back | 364 -> 374 | 1,627,221 -> 1,695,505 |
| medium | down and left | 319 -> 329 | 1,471,378 -> 1,540,062 |
| high | ahead | 285 -> 292 | 1,677,833 -> 1,744,790 |
| high | looking down | 323 -> 331 | 1,331,207 -> 1,395,371 |
| high | looking back | 384 -> 390 | 1,798,094 -> 1,801,055 |
| high | down and left | 330 -> 340 | 1,832,735 -> 1,901,419 |

(The terrain streams: at high the triangles of a view move by up to 170 k between two frames, the
calls by up to 10. At high `gpuMemory()` read 872.4 -> 852.3 MB, its textures streaming between
the two readings; the geometry 74.8 -> 73.1 MB.)

No new shader program at any quality: the seven draw with the program of the glb's cockpit
panels, pads, seat and bow (one program for all, read from each material at low, medium and
high), so nothing compiles when they first come into view; no texture, so no new sampler. CPU:
nothing a frame; built once at start-up, one part per task on the main thread, before the
interior's worker starts. A Chrome trace of the start-up here (SwiftShader, each part marked):
2-10 ms of the main thread's time a part (the bow the longest), 52 ms for all nine; their wall
times 7-33 ms on four cores shared at a load of 20, one of 96 ms that held an 82 ms garbage
collection of the page's heap (the part itself 7 ms). Each part allocates 1-12 MB of short-lived
arrays (node). Expected on an RTX 3070 at 1080p: under 0.05 ms a frame (5-10 more draws of a
program already in use, 23-69 k triangles more a frame, most of them on pixels the glb's parts
covered already), and nine tasks of 1-5 ms once at start-up.

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

The rebuilt parts are checked in node on the glb's own primitives
(`tests/cockpit_parts.test.mjs`: `CockpitParts` on a scene made from the glb, no browser): every
part built, seven draws, no warning; the coaming's outline seen from the rig's eye against the
helmet's `COAMING` line, by exact rays through the hood and the pads every 0.5 deg from -24.5 to
24.5 deg (at most 0.015 deg above the line, 0.095 deg under it; the test allows 0.03 above, half a
pixel at 1080p, and 0.1 under); the bow no wider than the glb's band and 5.36 deg thick from the eye
at the top of the arch (the glb's 7.68); a part made to fail half way, after its meshes are made,
leaves the glb's meshes, their indices and their visibility exactly as they were;
`setEnabled(false)` and `(true)` restore either set exactly. Besides: every triangle wound along
its normals (none wrong of 35,442, none degenerate), each part's box against the glb part it
replaces, the bytes each part allocates (1-12 MB of short-lived arrays, 0.1-1.7 MB of buffers).
Then in screenshots (`?test=1`, 960 x 540) at Tel Nof 36 at noon, over the Jerusalem hills at
1,500 m at 07:00 (into the sun) and at sunset (the sun behind), at Ben Gurion 26 at dusk, over Tel
Aviv at 3,000 m at noon and at night: ahead, left, right, down, back and at both wings; zoomed on
the bow's crest and leg, the coaming, the display's bezel, the consoles, the seat and the sills;
from outside at 6-7 m; A/B with `?ckparts=0` (the glb's parts analysed as usual) and the same frame
with `cockpit.parts.setEnabled(false)`. The bow at noon looking ahead (8-bit luminance down two
columns 21 deg either side of the nose): its body 42-57 (mean 51-52) between lit edges of 97-118
above and 109-159 below; the glb's slab (`?ckparts=0`) a face of 46-49 between edges of 60-99 and
54-69; zoomed on the crest, 47-64 against the glb's 48-50. At 07:00 into the sun its legs 35-36
(the glb's 35-38). The fastener heads at noon, zoomed: on the consoles -2 to +12 against the panel
round each (mean +3), on the liner and the seat within their surface's own shading. A Chrome trace
of the start-up (each part marked) gave the main thread's time per part. `tests/e2e.mjs` checks
that every part is built, with the expected draws and no `Cockpit:` warning, and passes with the
parts (79 of 79 checks: the flight path marker held above the coaming at 22 deg AoA, 9 px over it,
the interior analysis 3,822 faces, no gap).

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
* The rebuilt parts are made at start-up on the main thread, one part per task (2-10 ms of the
  main thread's time each in a trace here; on this machine, four cores shared at a load of 20, a
  part's wall time in `cockpit.parts.stats` is 2-80 ms, 170 ms once, when the scheduler or a
  garbage collection of the page's heap falls in it); the export
  (`scripts/f35/canopy.py`, `cockpit.py`) could make the same shapes, and the matching builders in
  `parts.js` would go. The wingmen keep the glb's (`parts.js` works on the player's jet only). A
  part whose glb source moves out of its box (`SHIELD_BOX`, `SEAT_BOXES`) or whose sections no
  longer match stays as exported, with a console warning.
* The helmet's coaming line (`js/ui/HMD.js` `COAMING`) is the glb's outline, and the hood is fitted
  to it from the rig's eye: a new glb shield or eye needs the line measured again
  (`tests/cockpit_parts.test.mjs` fails when the two part).
* No rear-view mirrors on the bow (the F-35 has none) and no legends on the console panels.
