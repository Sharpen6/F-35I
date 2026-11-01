# F-35I "Adir" / F-35A: public reference data for the Blender model

**Scope.** These notes use only openly published material: manufacturer and air-force fact sheets, press articles, a university student report, and hobby and modelling references. No classified, export-controlled or otherwise sensitive data was looked for or used. Externally the F-35I is an F-35A (CTOL) airframe; its Israeli-unique systems are internal. All F-35A geometry therefore applies.

**Source tags** (used throughout):

| Tag | Meaning |
|---|---|
| **[O]** | Official figure (Lockheed Martin, USAF, Pratt & Whitney, MINDEF Singapore) |
| **[M]** | Measured by me on the project's 3-view drawing (see below) |
| **[S]** | Virginia Tech AOE student design report. Unofficial; derived from drawings |
| **[P]** | Estimated from public photos; limited by perspective |
| **[F]** | Forum, hobby or press claim; unconfirmed |

**About the 3-view.** The drawing is Wikimedia Commons "Lockheed Martin F-35I Adir 3-view drawing". The project notes give its licence as CC BY-SA 4.0. I measured a local copy, the one used by `scripts/review_compare.py`, because Commons was not reachable from this environment.
- Scale: 708 px = 15.67 m, which is 45.18 px/m.
- One pixel is about ±0.02 m, but the outlines are artwork, not survey data.
- The wingspan on the drawing checks within 0.6 % of the official value.

**Axes.**
- **X**: metres aft of the nose tip, with L = 15.67 m. LM's 51.4 ft is 15.67 m.
- **Y**: lateral distance from the centreline.
- **Z**: height above the nose-tip waterline (WL 0).
- The 3-view is drawn gear up.

## 1. Overall dimensions

| Item | Value | Tag |
|---|---|---|
| Length | 15.7 m (51.4 ft) | O |
| Wingspan | 10.7 m (35 ft). The 3-view gives 10.73 m | O / M |
| Height, gear down (ground to fin tip) | 4.38 m (14.4 ft) | O |
| Wing area | 42.7 m² (460 ft²) | O |
| **Horizontal-tail (stabilator) span** | **6.86 m (22.5 ft)**, so the half-span is 3.43 m | O |
| Aspect ratio | 2.66 | Wikipedia |
| Wing taper ratio | 0.243 | S |
| Wing root / tip chord | 6.46 m / 1.57 m. Tip chord on the 3-view is about 1.5–1.6 m | S / M |
| Mean aerodynamic chord (MAC) | 4.51 m | S |
| Wing sweep: LE / quarter-chord / TE | 34.13° / 24.16° / −13.0°. The trailing edge sweeps forward | S |
| Wing sweep on the 3-view | Main-panel LE 34.1° from X ≈ 8.0 m. LERX blend about 63° over X ≈ 7.1–8.0 m. TE about −14° | M |
| Stabilator sweep | LE ≈ 34.3°, TE ≈ −14°. The edges are parallel to the wing edges (planform alignment) | M |
| **Vertical-tail cant** | **20.2° (left) / 20.3° (right)**, outboard from vertical | M |
| Vertical-tail sweep, side projection | LE ≈ 42°, TE ≈ 28°, both swept back. In the canted plane this is about 40° / 26° | M |
| Vertical-tail chords and taper | Root ≈ 2.4 m, tip ≈ 1.46 m, taper ≈ 0.6. S gives taper 0.59 | M / S |
| Tail areas | Horizontal 11.96 m². Vertical 7.95 m² (apparently both fins together) | S |
| Wing dihedral | About 0° (±0.5°; limited by resolution) | M |
| Stabilator dihedral | About 4–5°: the tips sit level with the fin trailing-edge root (3-view side and front views; photos c14, c20, c26). An earlier reading of the drawing alone gave 0–2° | M |
| Wheel track | 4.34 m (14.24 ft). A rear-quarter photo, scaled by the fin-tip spacing, gives at least about 4.1 m | S / P |
| Wheelbase | 6.02 m (19.75 ft) | S |

- **Non-shape context [O]:**
  - empty weight 13,290 kg (29,300 lb)
  - internal fuel 8,278 kg (18,250 lb)
  - internal-plus-external payload 8,160 kg (18,000 lb)
  - maximum take-off weight in the 70,000 lb class
  - Mach 1.6 and 9 g
- **Other variants [O]:**
  - F-35B: tail span 6.65 m, height 4.36 m.
  - F-35C: span 13.1 m, wing area 62.1 m², tail span 8.02 m, height 4.48 m.

> **Caution: stabilator span on the 3-view.** The drawing's stabilators are too large compared with the official figure:
> - top view: 7.28 m tip to tip
> - front view: 7.13 m tip to tip
> - official span: 6.86 m
>
> That is about 4–6 % oversize. Every other check on the drawing agrees with official figures. If the model is registered to the drawing, keep the official 6.86 m span and accept a small silhouette mismatch at the stabilator tips.

## 2. Stations, cross-sections and positions

### Longitudinal stations

| Feature | X (m) | X/L | Notes |
|---|---|---|---|
| Nose tip | 0 | 0.000 | WL 0 |
| Radome aft joint | ≈ 1.1–1.3 | ≈ 0.07–0.08 | P (side photo of 926). The joint is not drawn on the 3-view |
| EOTS chin fairing (faceted window) | ≈ 1.5–2.0 | 0.10–0.13 | M. Fairing bottom at Z ≈ −0.61 m |
| Canopy frame front (windscreen base) | 1.83 | 0.117 | M. Glazing begins at 1.9–2.0 m |
| Canopy internal bow frame | About ⅓ of the canopy length aft of its front | — | P |
| Canopy top (highest point) | 3.1–4.1 | 0.20–0.26 | M. Z = +1.36 m |
| Canopy glazing max width | 1.05–1.08 m at X ≈ 3.2–3.7 | — | M (top view) |
| Canopy glazing rear / frame rear | 4.52–4.67 / 4.67 | 0.29–0.30 | M |
| **Inlet lip** (cowl front in plan view) | **4.25** | **0.27** | M. Top and side views agree. Outer half-width at the lip is 1.47 m |
| LERX begins to flare | ≈ 7.1 | 0.45 | M |
| Main-panel wing LE begins (34°) | ≈ 8.0 | 0.51 | M. S places the wing apex at 7.655 m |
| Wing tip LE | ≈ 10.0 | 0.64 | M. S polygon: 9.81 m |
| Wing tip TE | ≈ 11.5 | 0.74 | M. S polygon: 11.41 m |
| **Vertical-tail root LE** | **11.5** | **0.735** | M. Fin/body junction at Z ≈ +0.35 m, Y ≈ ±1.42 m |
| Wing root TE (at the body side) | 12.3–12.6 | 0.78–0.80 | M: 12.57 m at half-width 1.89 m. S: 12.28 m |
| Stabilator root LE | 12.6–12.7 | 0.80–0.81 | M |
| Vertical-tail tip LE | 13.45 | 0.86 | M. Tip at Z ≈ +2.60 m, Y ≈ ±2.24 m |
| Vertical-tail root TE | ≈ 13.95 | 0.89 | M |
| Rudder hinge line | 13.5 at the root to 14.45 at the tip | 0.86–0.92 | M. Full-span rudder; chord about 0.4 m, parallel to the TE |
| **Nozzle exit** | **≈ 14.0–14.05** | **0.89–0.90** | M. Top and side views agree |
| Stabilator tip LE | ≈ 14.1 | 0.90 | M |
| Vertical-tail tip TE | 14.9 | 0.95 | M |
| Stabilator tip TE | ≈ 15.0 | 0.955 | M |
| Stabilator root TE corner (aft-most point) | 15.67 | 1.00 | M. At half-width ≈ 1.0–1.4 m |

### Top-view outline half-width [M]

| X (m) | 0.53 | 1.24 | 2.30 | 3.36 | 4.07 | 4.25 | 4.6 | 5–7 | 7.26 | 7.97 | 9.92 | 10.1–11.5 | 12.39 | 12.57 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Half-width (m) | 0.28 | 0.50 | 0.63 | 0.75 | 0.85 | 1.47 (lip) | 1.65 | 1.69–1.78 | 1.87 | 2.34 | 5.23 | 5.37 (tip) | 2.08 | 1.89 |

**Maximum body width: about 3.4–3.56 m**, across the inlets at X ≈ 5–7 m [M].

### Side-view silhouette [M]

Gear up. Z is measured from the nose-tip waterline.

| X (m) | 0.40 | 0.80 | 1.20 | 1.59 | 2.00 | 2.39 | 2.79 | 3.6 | 4.4 | 5.2 | 6.0 | 7.2 | 8.8 | 10.0 | 11.2 | 12.0 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Top Z | +0.19 | +0.34 | +0.45 | +0.56 | +0.76 | +1.01 | +1.25 | +1.36 | +1.32 | +1.25 | +1.23 | +1.14 | +1.10 | +1.07 | +1.03 | +1.01 |
| Bottom Z | −0.21 | −0.37 | −0.48 | −0.59 | −0.54 | −0.56 | −0.59 | −0.61 | −0.65 | −0.68 | −0.81 | −0.83 | −0.85 | −0.85 | −1.03 | −0.92 |

- **Maximum fuselage depth, excluding the fins: about 2.0 m.**
  - Canopy top to belly at X ≈ 4 m: 1.99 m.
  - Mid-body: 1.93–1.99 m.
  - Aft belly bulge at X ≈ 11.2 m: 2.06 m.
- Wing plane: Z ≈ +0.25 m.
- Stabilator: roughly at the wing-plane height.
- Overall height with gear up: 3.65 m.
- Fin tips: 4.47 m apart, 2.37 m above the wing plane.
- **Derived ground line:** about Z = −1.78 m with gear down. This is the 4.38 m official height minus the 2.60 m fin-tip height, and assumes the jet sits level.

## 3. Movable parts and mechanisms

### Flight-control surfaces

| Surface | Description | Tag |
|---|---|---|
| Leading-edge flap (LEF) | One full-span flap per wing, driven by Moog geared rotary actuators with asymmetry brakes | O |
| Flaperon | One per wing on the inboard trailing edge. The F-35A has no separate aileron; the F-35C adds ailerons and wing fold | O |
| Rudder | One full-span rudder per canted fin. Hinge line about 0.4 m ahead of the TE | O / M |
| Stabilator | One all-moving surface per side | O |

- **Actuation:** the primary surfaces use electro-hydrostatic actuators (EHAs).
- **Deflection limits have not been published.** For rigging placeholders only, F-16 values from a forum are:

  | F-16 surface | Deflection |
  |---|---|
  | Stabilator | ±21° |
  | Rudder | ±30° |
  | Flaperon | 23° up / 21° down |
  | LEF | −2° / +25° |

- A public Lockheed/MathWorks flight-control talk (Nixon) plots the rudder over −30° to +20°. These are chart axis ranges, not limits.
- **Angle of attack:** 50° was flown in flight test.
- **Speed brake:** there is no dedicated surface. In-flight braking is "an all-around deflection of various control surfaces" (Air & Space Forces). Hobby sources describe the rudders toeing in, the trailing-edge surfaces going up and the LEFs going down [F].

### Weapons bays

There are two internal bays, each with two doors (four doors in total).

| Door | Hinge and features | Tag |
|---|---|---|
| Inboard | Narrow, hinged at the keel. Carries the door-mounted AIM-120 station | press |
| Outboard | Wider, hinged at the bay's outer edge, next to the main-gear bay | press / F |

- **Door motion:** the doors swing down to roughly vertical, about 90° [F]. An open–release–close cycle takes under 2 s [press].
- **Loads:** the outboard station takes up to 2,500 lb on the F-35A/C. The Sidekick adapter (stations 4 and 8) adds a third AMRAAM per bay [press].
- **Bay length:** more than about 4.1 m [F estimate].

### Landing gear

- **Layout:** tricycle, with single-wheel nose and main gear [P].
- **Retraction:**
  - Nose leg: reported to retract forward, inferred from press reports of nose-gear collapses [F].
  - Main gear: the retraction geometry is not described in public text. For the F-35C, the drag braces roll around the strut and there is a shrink strut.
- **Stance on the gear [M][P]:**
  - The jet sits 1.45° nose-up. The camera matches of c14, c22, c29 and c51 give this, and the nose-tip to fin-tip line in the long-lens side view c48 agrees within 0.3°.
  - Measured in tyre diameters (nose 0.597 m, main 0.864 m), the lower edges of the open doors sit 0.88–1.0 m above the nose-wheel centre and 0.90–0.96 m above the main-wheel centre (c48, c51, c53). The camera solves were not precise enough for this 10 cm check.
  - The model now sits 13 cm above its main-wheel contact datum (8 cm higher than before): the nose door edge is 0.85 m above the wheel centre at the strut, the main door edge 0.91 m, and the fin tips 4.41 m above the ground against the published 4.38 m.
- **Nose leg (model, from c20, c29, c48, c51, c53, ref_04, ref_05) [M][P]:**
  - Under the doors: a boxy white steering housing with one lamp on its front, then a neck and a collar ring, a short chrome piston (about 13 cm showing), the yoke and a single trailing arm on the left. The upper strut and the drag brace stay hidden in the well.
  - The lamp sits at the top of the housing front: a round lamp in a chrome reflector about 0.12 m across, inside a square white bezel 0.14–0.16 m wide (c20: 54 px against the 197 px tyre diameter; c29: 54 px against the 75 px tyre width; c22 and ref_04 show one lamp, not two).
  - Head-on (c22) the retraction actuator shows in the well: a cylinder from high on the aircraft's right side of the well down to the top of the housing. c20 shows a coil spring and links along the drag brace.
  - The drag brace runs from a lug under the well roof down to the strut just above the housing. Its upper link is the longer one (65 % of the length), so the brace folds nearly flat and its knee stays under the roof as the leg swings forward into the well.
- **Suppliers:** Goodrich, now Collins, makes the gear; Honeywell makes the wheels and brakes [press].
- **Tyres** (DLA NSN listings for the F-35):

  | Tyre | Size | Approx. dimensions |
  |---|---|---|
  | Main | 34×11.0R17, 26 PR | ≈ 864 × 279 mm |
  | Nose | 23.5×7.5R10, 22 PR | ≈ 597 × 191 mm |
  | STOVL main (separate listing) | 34×10.5R16 | — |

- **Finish:** gear legs and bay interiors are white [P].
- **Door counts:** not found in public text. Use walkaround photos (see Sources).
- **Nose-gear doors** (photos c20, c22, c34, c51, c53) [P]:
  - Two long doors stay open while the gear is down, one each side of the leg. The aircraft number is often painted on them.
  - In the model they run from about station 2.30 m (just behind the EOTS window) to 4.62 m (the strut). The hinge lines sit at |x| ≈ 0.50 m at the front and narrow to 0.33 m at the strut, so by the strut the doors are shallow enough to show the leg's white steering housing below them (c48, c51, c53).
  - The front edge is sawtoothed. The aft edge is raked, so the free edge is slightly longer than the hinge edge.
  - Between the open doors the well reads darker than the chin skin and is busy with frames, lines and boxes, while the doors' inner faces stay light, with hinge arms and gussets (c20, c22, c29, ref_04).
  - Seen head-on (c22) the open doors close in towards the bottom; the model hangs them 25° inboard of vertical.
  - Back-projection through the c51 camera puts the hinge line higher at the front (z ≈ −0.16) than the model (−0.49). The model keeps the hinges on the bottom because the closed doors must fit the fuselage's lower skin.

### Canopy

- One-piece transparency in an integral frame with an internal bow. There is no separate windscreen.
- Hinged at the front and opens upward.
- **Opening angle is not published.** Photos suggest roughly 30–40° [P].
- A pyrotechnic Transparency Removal System cuts through the canopy before ejection; the canopy is not jettisoned.
- The canopy has a light gold tint.
- Frame stencil: "WARNING – DO NOT CUT CANOPY WITHIN 3 INCHES OF CANOPY FRAME".
- **Bow and pilot position (measured for the model) [M][P]:**
  - Photos c09 and c34 show the internal bow as a dark band about 8–9 cm wide, a third of the way back from the canopy tip, leaning forward at the top. On the model it crosses the crest at station 2.84 m and meets the sill at 3.01 m.
  - The pilot's helmet sits just behind the bow, near the middle of the canopy, not at its back. The 3-view side and top views put the head at station ≈ 3.3 m and photo c34 at ≈ 3.35 m, with the seat headbox at ≈ 3.7 m and a long deck behind the seat under the rear of the canopy.
  - Until this check the model's whole cockpit (pilot, seat, consoles, display) sat about 0.55 m too far back; it is now moved forward as a block (`cockpit.COCKPIT_DS`), with the display 0.70 m ahead of the design eye and narrowed to fit under the canopy.
- **Frame band (measured for the model) [M][P]:**
  - In side view the opaque band under the glass is a chevron of constant width, about 0.115–0.125 m. Both of its edges are straight and parallel and kink in a sharp V at the same station, under the bow foot. Measured in c34 against the chine-to-crest height; c09 and c51 agree, and ref_05 (901, canopy open) shows the same width on both runs.
  - The band's lower edge is the canopy's own edge (ref_05). Photos show it as a dark gap with a lit step line below it. At the rear it meets a straight, near-vertical aft pillar in a square corner, behind a tight glass corner.
  - Measured against the chine, c34 puts the glass edge 3.3–3.9 cm higher than the 3-view line from the V to station ≈ 3.75 m, parallel to it. The band's lower V lies on the sill. The model's glass V is at z 0.672 m (station 3.0 m), and the band is 0.115 m wide.

### Gun, doors and other external features

- **Gun:** GAU-22/A, four-barrel 25 mm.

  | Property | Value |
  |---|---|
  | Rate of fire | 3,300 rounds/min |
  | Rounds carried | 181–182 |
  | Weight | ≈ 104 kg |
  | Length | ≈ 2.1 m (GAU-12 family) |

  It is internal, near the left wing root. The gun port has a door that opens only for firing.
- **Air refuelling:** the F-35A uses a boom receptacle under a door on the dorsal spine, aft of the canopy. The position comes from photos.
  - The 3-view shows a group of doors on the centreline at X ≈ 6.5–8.2 m, which is consistent with that position.
  - The F-35B and F-35C use a retractable probe instead.
- **No dorsal auxiliary-inlet doors and no lift-fan door** on the F-35A/I. Those exist only on the F-35B.
- **Other features on the 3-view top view:**
  - Upper-shoulder vents and doors at X ≈ 5.2–7.8 m. Their identity is not documented in text.
  - Red (left) and green (right) navigation lights on the wingtips.
- **Tailhook:** the F-35A has an emergency arresting hook.
- **Drag chute:** a pod between the vertical tails, used by Norway and some other European operators. It is not listed for Israel.
- **Sensors:**
  - EOTS sits behind a faceted sapphire window under the nose. Its window spans stations ≈ 1.4–2.2 m, about 0.25 m ahead of the nose-gear doors (back-projected from c51; c34 and c53 agree) [P]. The window has seven flat facets with a gold sheen, set in a shallow box-like housing (c20).
  - There are six DAS apertures distributed around the airframe [O]. Public text does not give their positions. Photos show one just ahead of the windscreen, one behind the canopy, and one on each lower side of the nose just above the front of the nose-gear doors (a small hexagonal window that flashes pink or teal, c34, c51, c53) [P]. The model puts the two remaining (lower) apertures on the centre line under the chin and under the aft fuselage; that placement is a guess.
  - L-shaped air-data probes stick out from the lower sides of the nose beside the "CAUTION HOT" panels, at about station 1.95 m (c20, c34) [P].
- **Formation lights:** a pair of light-green strips on the outer side of each inlet, aft of the lip, at stations ≈ 4.9–5.9 m and about 0.16 m above the datum (back-projected from c51; also visible in c20 and c53) [P].

## 4. Cockpit

- **Panoramic cockpit display:**
  - one 20 × 8 in (≈ 50 × 20 cm) touchscreen, made of two 10 × 8 in halves
  - can be divided into windows (2 × 10×8 or 4 × 5×8)
  - original supplier L3 (now L3Harris); an Elbit America replacement unit has been reported
- **No head-up display (HUD).** The helmet takes its place.
- **Controls:**
  - active side-stick on the right console
  - active throttle on the left console, with no cut-off detent
  - about 20 hard switches in total [press]
- Locations of the gear handle, master arm and jettison controls are not given in text. Use cockpit and walkaround photos.
- **Ejection seat: Martin-Baker US16E.**
  - twin catapult tubes
  - underseat rocket
  - firing handle at the front of the seat bucket
  - IGQ 6000 parachute in the headbox
  - canopy cut by the Transparency Removal System rather than jettisoned
  - 0/0 to 600 KEAS
  - occupant mass 46.7–111.1 kg
  - seat-height adjustment ≈ 188 mm
- **Helmet: HMDS Gen III** (Collins Elbit Vision Systems).
  - biocular 30° × 40° field of view
  - symbology projected on the visor
  - built-in night camera
  - about 2 kg (4.5 lb, as reported)

## 5. F-35I Adir specifics

### Differences from the F-35A

- Israeli-unique C4I and EW systems are internal. Israeli weapons integration has been reported (SPICE 1000, Python-5).
- **No confirmed external shape difference** appears in public photos. Only the markings differ.
- IAI is a production supplier of F-35A outer wings. This is not specific to the F-35I.
- **External fuel tanks:** a contract with Elbit/Cyclone was signed on 14 May 2026 (over $34M). The tank shape and capacity are not public.

### Units

All are based at Nevatim.

| Squadron | Name | Status | Markings |
|---|---|---|---|
| 140 | "Golden Eagle" | First F-35I unit. First jets arrived 12 Dec 2016 | Large outline eagle-head art on the fins (adopted 2021). Outline eagle badge on the intake side, with mission marks |
| 116 | "Lions of the South" | Re-formed 16 Jan 2020 | Lion's-head tail art |
| 117 | "First Jet" | Third unit, reported as the training squadron from 2021 | Two-tone grey tail art plus an intake badge |

Reported jet allocations (April 2021):
- 116 Squadron: 905, 909, 928, 930, 932, 933, 935, 937, 939, 941, 943
- 140 Squadron: 901, 902, 904, 907, 908, 911, 913, 916–919, 921, 925–927

### Serials

- Three-digit IAF numbers in the **9xx** series.
- The early jets match the Lockheed MSN (AS-01 = 901, AS-11 = 911), but not always: the test jet AS-15 is **924**, based at the Flight Test Center, Tel Nof.
- The jets also have US FMS serials, for example 901 = 14-5112, and 939/941/943 = 18-5436/7/8.

### Markings placement

Positions are taken from the 3-view and from photos of 901, 905 and 926.

| Marking | Position and size |
|---|---|
| Nose number | Light-grey numerals, sometimes with a thin darker shadow. On the upper nose side between the radome joint and the windscreen, above the chine. About 0.1–0.15 m tall [P] |
| Fuselage roundel | Below the canopy. On the 3-view it is centred at X ≈ 2.66 m, Z ≈ 0, about 0.5 m across. Photos give about 0.45 m [P] |
| Wing roundels (3-view) | Upper surface of both wings, centred at X ≈ 10.4 m, Y ≈ ±3.0 m, about 1.0 m across [M] |
| Stencils | Rescue arrow with "RESCUE … master latch" text below the canopy rear; ejection-seat warning triangles; the canopy-cut warning on the frame |
| Inlet eagle | White outline eagle swooping towards the nose on both inlet sides (901, 919, 926): long pointed wings raised in a wide V with parallel feather lines, a small hooked head low at the front, talons forward and down, a striated tail aft and down. About 0.46 m wide and wider than tall (196 × 163 px in ref_05), with a fine line about 1.8 % of its width (about 0.8 cm) [P] |
| Fin eagle | On 919 (ref_07): a large hooked eagle head with a brow, one breast curve below it, talons reaching forward, and a line from the crown aft towards the tip / trailing-edge corner; no perch. The head is about 30 % of the emblem's height. 901 had no fin art in 2016 (ref_06) [P] |

### Roundel style

- The IAF roundel is a blue Star of David on a white disc, with no border.
- The F-35I uses a **low-visibility** version: a light-grey disc with a dark-grey star.
- Early jets were photographed in delivery without roundels; the roundels were applied after arrival.

### Paint

| Area | Callout | Source |
|---|---|---|
| Overall | FS 36170, satin. SAM also states that all F-35s are FS 595C-36170 | Isradecal; SAM |
| RAM-treated panels and edges | FS 36134, matt | Isradecal |

- The "Have Glass" coating gives a slight metallic sheen depending on the light.
- Modellers often use FS 36270 or 36231 for the lighter-looking RAM panels.
- RAM tape frames (photos ref_06 of 901 from above, c51, c53): bold bands about 7-9 cm wide outline
  the upper fuselage panels. The outer edges of each panel group step like a staircase (each jog about
  one band width); inner rungs are straight; no seam shows inside most bands. Under sky light they
  read 6-10 % lighter than the paint, in sun they read darker than the paint's sheen. The model's
  layout (panels.layout) was traced from ref_06 mapped onto the top skin through its solved camera
  (data/camera_matches/ref06.json) and checked on dark-band profiles of that rectified image.
- Inlet-side panels below the wing root (c51 right side, measured by ray casts through its solved
  camera after an affine fit on the crescent index marks and formation strips, residuals under 6 px of
  3840; checked on c53, ref_05 of 901, ref_07 of 919, ref_04 of 926). The crescent-mark access panel
  spans s 5.73-6.55, z -0.28..0.05, with a big chamfer at its top-front corner (about 0.21 x 0.11 m)
  and a small one at its bottom-aft corner. A seam runs about 4-7 cm ahead of it (s ≈ 5.67-5.70)
  from under the strips to just below it. On the left only, a hexagon about 0.35 x 0.15 m sits over
  its aft half. The long panel aft of it reaches the main-gear door: its top is about 0.11 m above
  the access panel's top (c51; 0.16-0.18 m in c53 and ref_05), with a chamfer of about 0.29 x 0.17 m
  down to the access panel's top-aft corner. Its bottom steps between z -0.28 and -0.23 and it has
  fastener rows inside its edges. Below it, a long seam at z ≈ -0.40 hooks down and forward at
  s ≈ 6.25, and a lower panel with chamfered ends spans s ≈ 7.06-8.2, z -0.40..-0.55. Outlines read
  as light sealant bands or dark seams. Fastener heads are about 0.8-1.2 cm across at 3-4 cm pitch
  (ref_05, ref_03).

Approximate sRGB values (sources disagree, so treat these as guides only):

| FS 595 colour | sRGB |
|---|---|
| 36170 | #5C5C5B (w3schools) to #6D6C6B (Wikipedia list). The MRP-280 chip is #686765 |
| 36270 | #858691 |
| 36231 | #7E7E87 |
| 36118 | #5B5E6A |
| 36134 | Not found |

How the paint looks in photos, measured as sRGB brightness (0..1) on c51 and c29 and on the model
rendered from the same solved cameras (before = procedural sky and the old flat grey, after = this
paint under the HDRI sky, sun placed roughly as in each photo):

| Photo | Region | Photo | Before | After |
|---|---|---|---|---|
| c51 (bright cloud) | Upper fuselage behind the canopy | 0.67 | 0.23 | 0.41 |
| c51 | Wing top | 0.80 | 0.29 | 0.46 |
| c51 | Forward fuselage side | 0.19 | 0.16 | 0.22 |
| c51 | Centre fuselage side | 0.15 | 0.14 | 0.17 |
| c29 (clear sky) | Nose top | 0.52 | 0.37 | 0.55 |
| c29 | Inlet cheek | 0.42 | 0.25 | 0.37 |
| c29 | Wing on the image left | 0.25 | 0.15 | 0.23 |
| c29 | Fin on the image left | 0.68 | 0.76 | 0.63 |

- The same paint is almost black where it faces the camera and silvery where it catches the sky at a
  glancing angle. A plain matt grey cannot do both, so the model uses a darker base than the paint
  chip (linear 0.094) under a satin clear coat (weight 0.6, roughness 0.3) with a little sheen (0.15).
- c51's upper surfaces are still about 0.25 darker than the photo: its sky is solid bright cloud, the
  HDRI's is blue with cumulus. The image-right wing in c29 is not in the table because the sun
  position there is only estimated (it is lit in the render and shaded in the photo).
- The lighting is a CC0 HDRI from Poly Haven (Kloofendal 48d Partly Cloudy, Greg Zaal): open horizon,
  bright cumulus, sun at 48 degrees. The sun is clipped out of the HDRI and replaced by a sun lamp with
  the same direction and irradiance, so shadows stay sharp.

## 6. Signature features

- **Nozzle:** the F135 axisymmetric convergent–divergent nozzle has two overlapping sets of **15 flaps** (15 + 15).
  - The outer "tail feathers" are tiled and end in chevrons, which gives a **sawtooth exit edge**.
  - The inner surfaces are white or tan.
  - On the 3-view, the exit is at X ≈ 14.0 m. The nozzle tapers from about 1.2 m wide at X ≈ 13.5 m to about 0.85 m of dark nozzle at the exit [M].
  - The F135 engine is 5.59 m long, with a 1.09 m inlet diameter and 1.17 m maximum diameter [O].
  - Close-up photos of a JASDF F-35A (Komatsu, 2023; see Sources) show how the nozzle meets the body [P]:
    - The aft fuselage ends in a **sawtooth shroud all round the nozzle**: roughly 60 small teeth (about 6 cm pitch) just over the outer flap roots. The teeth show above and below the nozzle.
    - Beside the nozzle only the **stabilator booms** continue aft. Their inner faces wrap closely round the nozzle's sides, and the booms end at about the nozzle exit.
    - The lower aft fuselage converges smoothly onto the bottom of the nozzle.
    - The outer flaps are flat metal plates with rivet rows. The pale, soot-streaked divergent flaps reach just past them and form the light, serrated ring seen at the exit.
  - **Afterburner (how the model shows it) [M]:**
    - With the throttle above MIL (0.75) the nozzle opens (exit radius 0.47 to 0.56 m, throat by 20 %) and a glowing volume lights behind it: a cone of hot gas about 4.6 m long that narrows downstream, orange at the nozzle and pinker towards its tail, with the inside of the nozzle glowing as well.
    - A row of yellow-white **shock diamonds** sits on the axis, the first about 0.5 m behind the exit and then one every 0.78 m, each smaller and fainter than the one before. The spacing follows the usual shock-cell estimate of about 1.2 D √(M² − 1) for an exit diameter D of about 1.1 m and an exit Mach number of about 1.2.
    - In daylight photos of F-35 take-offs the flame is mostly the bright nozzle interior and a short orange cone with faint diamonds; the model is tuned to that, not to night photos where the whole plume glows.
    - The envelope flickers: a noise pattern drifts downstream with the frame while the diamonds stay put, as standing shock waves do.
- **DSI (diverterless supersonic inlet):** each inlet has a 3-D compression bump with a forward-swept cowl lip and no boundary-layer splitter plate. It was first flown on an F-16 testbed on 11 Dec 1996.
  - How the model's inlets were shaped, traced from the public front-view drawing and checked against photos c20, c28 and c29 [M][P]:
    - Seen head-on, the opening is a raked, roughly trapezoidal aperture from about 1.00 to 1.46 m out from the centreline. Its top edge slopes down outboard from the chine, its outboard edge leans inward towards the bottom, and its floor is flat.
    - The compression bump bulges out of the inboard wall between stations 3.0 and 5.8 m. It is deepest (about 0.29 m) at mid-height and fills the inboard part of the opening, so only a crescent of dark duct shows from the front.
    - The cowl lip is thin and swept: its tip, at the outboard top corner, sits at station 4.28 m, about 1.50 m out from the centreline. Below the tip the lip rakes back to the floor.
    - Behind the lip the duct is light grey and darkens within about 0.9 m, as the photos show.
- **Canted twin tails:** about 20° outboard, with full-span rudders.
- **Chined nose:** a sharp chine runs from the nose tip back along the fuselage side into the LERX and the inlet top. The faceted EOTS window sits underneath.
- **Planform alignment:** the wing and stabilator LE/TE angles match (about 34° and −14°).
- **Sawtooth edges** on the bay doors, gear doors and access panels.

## Sources

**Official dimensions and data**
- LM F-35 Fast Facts (Dec 2013): https://www.slideshare.net/slideshow/f-35-fast-facts-december2013/30162920
- LM F-35A product card: https://www.lockheedmartin.com/content/dam/lockheed-martin/aero/f35/documents/fg15-1280_001_f-35a_pc_final.pdf
- MINDEF Singapore fact sheet: https://www.mindef.gov.sg/web/portal/mindef/news-and-events/latest-releases/article-detail/2024/February/28feb24_fs
- 388th FW F-35A fact sheet: https://www.388fw.acc.af.mil/Portals/103/F35A_LightningII_ACC%20Fact%20Sheet.pdf
- https://en.wikipedia.org/wiki/F-35
- Wikipedia F-35 page (IPFS mirror, with the specifications box): https://ipfs.ssi.eecc.de/ipns/en.wikipedia-on-ipfs.org/wiki/Lockheed_Martin_F-35_Lightning_II

**Student reports (unofficial)**
- https://archive.aoe.vt.edu/mason/Mason_f/F35ASpr11.pdf
- https://archive.aoe.vt.edu/mason/Mason_f/F35unknownS03.pdf
- https://archive.aoe.vt.edu/mason/Mason_f/F35EvanS03.pdf

**3-view**
- Wikimedia Commons, "Lockheed Martin F-35I Adir 3-view drawing" (local copy; Commons blocked by this environment's proxy)

**Control surfaces and flight control**
- https://moog.com/content/dam/moog/literature/Aircraft/military_aftermarket/2025/Moog-F35-Brochure.pdf
- https://www.airandspaceforces.com/1023seven
- https://la.mathworks.com/content/dam/mathworks/mathworks-dot-com/solutions/aerospace-defense/miadc/presentations/10_F35_Flight_Control_DevelopmentDaveNixon.pdf
- https://www.f-16.net/forum/viewtopic.php?p=44061
- https://combatace.com/forums/topic/28811-f-35a-lightning-ii/?page=6
- https://sldinfo.com/2012/11/the-f-35-and-high-angle-of-attack-flight-testing/

**Weapons bays**
- https://www.f-16.net/forum/viewtopic.php?p=158513
- https://www.f-16.net/forum/viewtopic.php?p=78758
- https://grendelreport.blogspot.com/2012/09/f-35-bay-presents-challenges-to-weapons.html
- https://www.wionews.com/photos/why-the-f-35-internal-weapons-bays-open-so-quickly-1787440984317
- https://www.twz.com/adapter-for-f-35-internal-carriage-of-six-aim-120-missiles-is-progressing.md

**Landing gear and tyres**
- https://strasam.org/en/defense/aerospace-industry/the-chronic-problem-of-f-35-aircraft-why-do-nose-landing-gear-collapse-2936
- https://www.pprune.org/9490117-post9687.html
- https://flightglobal.com/goodrich-ships-landing-nose-gear-for-f-35-/60975.article
- https://www.gknaerospace.com/news-insights/news/honeywell-gkn-aerospace-signs-license-and-parts-supply-agreement-for-f-35-wheels-and-brakes/
- https://www.wbparts.com/rfq/2620-01-619-8205.html
- https://wbparts.com/rfq/2620-01-619-8190.html
- https://www.wbparts.com/rfq/2620-01-619-8197.html
- https://www.luke.af.mil/News/Article-Display/Article/641096/wheels-in-sky-keep-turning/
- https://www.f-16.net/forum/viewtopic.php?p=449663

**Canopy, gun, refuelling, hook, drag chute and sensors**
- https://www.edwards.af.mil/News/AFMC-News/Article/2174727/second-vendor-f-35-canopy-testing-complete/
- https://theaviationist.com/2025/05/03/hill-afbs-f-35s-receive-improved-canopies/
- https://en.wikipedia.org/wiki/GAU-12_Equalizer
- https://breakingdefense.com/2015/08/show-and-tell-f-35-test-fires-gau-22-gun/
- https://www.af.mil/News/Article-Display/Article/610801/ground-testing-for-f-35-gun-conducted-at-edwards-afb
- https://www.edwards.af.mil/News/Article/394532/f-35a-completes-first-night-refueling-mission
- https://www.pprune.org/9619911-post10037.html
- https://www.edwards.af.mil/News/Display/Article/828341/jsf-tailhook-testing-begins-at-edwards/
- https://www.f35.com/f35/news-and-features/the-f35a-drag-chute-system.html
- https://news.lockheedmartin.com/2009-11-30-Lockheed-Martin-Delivers-First-Production-F-35-Electro-Optical-Targeting-System
- https://www.codeonemagazine.com/article.html?item_id=35

**Cockpit, seat and helmet**
- https://www.militaryaerospace.com/sensors/article/14276510/panoramic-display-f-35-cockpit-avionics
- https://www.defenseindustrydaily.com/l3-wins-f35-jsf-panoramic-cockpit-display-contract-worth-up-to-200m-01518/
- https://sldinfo.com/whitepapers/an-overview-of-the-f-35-cockpit-what-5th-generation-aircraft-are-all-about/
- https://www.jsf.mil/cockpit
- https://theaviationist.com/2020/07/28/enjoy-this-new-walkaround-tour-of-the-u-s-air-force-f-35a-lightning-ii/
- https://martin-baker.com/wp-content/uploads/2023/06/US16E-2026-Data-Sheet.pdf
- https://ejectionsite.com/mbmkus16e.html
- https://www.redimec.com.ar/contenido/productos/pdf/1426684093_1.pdf
- https://www.aviationtoday.com/2015/09/04/f-35-gen-iii-helmet-a-generational-leap-in-technology/
- https://www.businessinsider.in/i-wore-the-helmet-of-americas-most-expensive-war-machine-and-theres-nothing-quite-like-it/amp_articleshow/54533877.cms

**F-35I, squadrons, serials and markings**
- https://www.wikiwand.com/en/articles/F-35I_Adir
- https://en.wikipedia.org/wiki/List_of_Israeli_Air_Force_aircraft_squadrons
- https://en.wikipedia.org/wiki/116_Squadron_(Israel)
- https://en.wikipedia.org/wiki/140_Squadron_(Israel)
- https://theaviationist.com/2020/01/19/the-israeli-air-force-has-inaugurated-its-second-f-35i-adir-squadron
- https://www.infolotnicze.pl/?p=62128
- https://scramble.nl/military-news/israeli-air-force-squadron-updates
- https://www.scramble.nl/military-news/israeli-adirs
- https://www.scramble.nl/military-news/first-israeli-air-force-adir-delivered-to-the-flight-testing-centre
- https://www.airfighters.com/photosearch.php?con=AS-01
- https://www.airhistory.net/photo/561516/911
- https://hobbymasterarchive.org/HA4432/
- https://theaviationist.com/2016/12/10/here-are-the-photos-of-the-first-two-f-35a-stealth-jets-en-route-to-give-israel-the-edge-in-the-middle-east/
- https://www.keymilitary.com/article/israel-receives-f-35s
- https://crwflags.com/fotw/flags/il%5Eairfo.html
- https://theaviationist.com/2026/05/14/israel-signs-deal-for-f-35i-fuel-tanks/
- https://www.twz.com/air/israels-f-35s-are-getting-external-fuel-tanks
- https://nationalsecurityjournal.org/does-israel-have-a-secret-extended-range-f-35i-adir-stealth-fighter/

**Paint and colours**
- Isradecal F-35I instructions: https://isradecal.com/_files/ugd/ddb4b4_ba84724c1add4daa9882e4818bb8d8e2.pdf
- https://www.themodellingnews.com/2024/01/preview-mengs-148th-scale-f-35i-adir.html
- https://pocketmags.com/es/scale-aircraft-modelling-magazine/november-2017/articles/adir-part-2
- https://www.themodellingnews.com/2018/03/ptiv-painting-weathering-guide-lockheed.html
- https://scalemodellingnow.com/aircraft-tamiya-lockheed-martin-f35a-lightning-ii-dc/4
- https://www.f-16.net/forum/viewtopic.php?p=495786
- https://www.tamiya.com/english/products/61124/index.html
- https://w3schools.com/colors/colors_fs595.asp
- https://www.scalemates.com/colors/color.php?id=12675
- https://www.myperfectcolor.com/paint/29397-us-government-fed-std-595c-36118
- Wikipedia "Federal Standard 595 camouflage colours" (IPFS mirror): https://ipfs.aleph.im/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco/wiki/Federal_Standard_595_camouflage_colours.html

**Nozzle and inlet**
- https://aviationweek.com/aerospace/program-management/closer-look-stealth-part-5-nozzles-exhausts
- Wikimedia Commons photos of JASDF F-35A 09-8718 at Komatsu Air Base, 7 Oct 2023 (CC BY-SA 4.0). They were used as modelling references only and are not redistributed here:
  - "exhaust nozzle right rear view", "exhaust nozzle left rear view", "exhaust nozzle right rear low-angle view"
  - "right rear view ... 01", "left rear view ... 02", "left rear low-angle view ... 01"
  - "IPP exhaust left rear view"
  - All are at https://commons.wikimedia.org/wiki/File:JASDF_F-35A_(09-8718)_exhaust_nozzle_right_rear_view_at_Komatsu_Air_Base_October_7,_2023.jpg and its sibling pages.
- Wikimedia Commons "F-35A at Eglin Air Force Base 2 Aug 2016" (public domain).
- https://pdf.aeroexpo.online/pdf/pratt-whitney/f-35c/170325-4929.html
- https://en.wikipedia.org/wiki/Diverterless_supersonic_inlet
- https://www.globalsecurity.org/military/systems/aircraft/dsi.htm
- https://planeandpilotmag.com/bonus-oshkosh-gallery-8/
