# The pilot: research notes

The detailed pilot (`scripts/pilot/`, used standing in the studio and seated in the jet) was built from these notes. They were written from 30 openly licensed photos of F-35 pilots (USAF, RAAF and the IAF at Red Flag), listed at the end as p00-p29, plus public anthropometry for a 1.78 m, 80 kg pilot.

Main findings:

* **Helmet.** The F-35 Gen III Helmet Mounted Display System: a carbon dome with a brow display module, a one-piece wrap-around visor, a night camera in the brow, and the HMD cable leaving the back of the shell. Positions below are in a head frame: origin between the corneas, +Y forward, +Z up, +X the pilot's left.
* **Coverall.** IAF aircrew wear a one-piece olive coverall in the CWU-27/P layout, with sage Nomex gloves (black leather palms, see the corrections below) and black lace-up boots.
* **Ensemble.** F-35 pilots wear the Survitec F-35 ensemble and sit in the Martin-Baker US16E seat, whose harness belongs to the seat. The pilot wears no torso harness, no Koch fittings, no leg garters and no survival vest. Over the coverall go a short sleeved jacket with the life preserver (LPU) built in, full-coverage anti-G trousers (FCAGS), and the personal equipment connector (PEC) on the left thigh, where the breathing-gas hose, the anti-G hose and the helmet cable meet.

Heights (Z) are for the standing pilot without boots unless a line says otherwise. The model adds a 25 mm sole.

### Corrections after a photo check of these notes (model v5.1)

A last pass checked the notes against the photos again, with white balance taken from whites in the same
frame. Where it found the notes wrong, the model follows the check; the sections below keep the
original wording.

* **Jacket and LPU cover:** a neutral mid grey, about #5A5958. The IAF cockpit photo p01 white-balances to
  neutral grey; the warm khaki-grey in the notes could not be reproduced. USAF and RAAF jackets are sage
  (#66705C). Confidence 0.45 (one overcast photo).
* **Gloves:** black leather palm and finger panels with an olive/sage knit back (p21, the one clear photo
  of F-35 flight gloves). No photo shows grey leather palms.
* **Breathing-gas hose:** a dark, low-saturation teal-grey, about #52605D. In daylight (p22) it is close to
  the grey trousers; the vivid teal in p27 is night lighting.
* **Mask hose:** plain corrugation. The microphone lead wound round it shows only in the older photos
  (p28 from 2014, p17 from 2015); the banding in p01, p25 and p27 is the shading of the corrugation.
  (`gear.MIC_CORD` puts the lead back.)
* **Seat harness:** dark neutral grey, about #404247, in the IAF cockpit photo.
* **Not changed (uncertain):** the HMDS cable. In p01 a ~14 mm cable leaves the back of the helmet and drops
  onto the left shoulder outside the collar, as modelled; where it goes from there is not visible. p27 is a
  front-left three-quarter view, not a front view, so widths taken from it carry 10-15 % error.

## 1. Helmet (Gen III HMDS), oxygen mask, hose and leads

Spec for the F-35 Gen III Helmet Mounted Display System (HMDS) and the oxygen mask, hose and leads, for an IAF F-35I pilot (1.78 m, 80 kg male).

**Coordinate frame.** All positions use a head frame:
- Origin O is the midpoint between the corneal apices, with the head in Frankfort horizontal.
- +Z is up, +Y is forward (anterior), +X is the pilot's left.
- Reference head landmarks:
  - Vertex: Y -0.07, Z +0.118.
  - Glabella: Y +0.010, Z +0.018.
  - Opisthocranion: Y -0.189, Z +0.03.
  - Tragion: X ±0.072, Y -0.080, Z -0.020.
  - Nasion: Y +0.012, Z +0.008.
  - Nose tip (pronasale): Y +0.032, Z -0.045.
  - Menton: Y +0.005, Z -0.120.
  - Head length 0.197 m, breadth 0.155 m.

**How scale was set.** Scale comes mainly from the side profile in p24 (face, eye and ear-cup visible, about 3150 px/m). It was cross-checked against:
- the eye-to-chin distance and iris in p28 (about 2900 px/m);
- the wrist-watch bezel and body proportions in p27 (about 1900 px/m);
- the thumbnail-scaled ear-cup cover in p25;
- the mouth width in p03.
Expect about ±10% on absolute sizes. Ratios between parts are more reliable.

**Helmet overall size.** About 0.29 m long to the front of the brow module, 0.30 m including the night-vision camera, and 0.34 m with the visor raised. About 0.27 m wide over the ear cups and 0.25 m tall. Mass is about 2.3 kg for the Gen III and 2.1 kg (4.63 lb) for the Gen III 'Lite' (DefenseNews 2016).

**Main parts.**
- An unpainted carbon-fibre shell.
- A bulging brow display module in checkered carbon, under a fixed clear cover, with a central night-vision camera.
- One wrap-around display visor on high side pivots, in a dark 'day' or clear 'night' version (interchangeable per Defense One). It flips up about 50–60°.
- Ear-cup domes with round black covers.
- Notched mask receivers on the cheeks.
- A braided helmet cable from the back of the helmet to the right side of the seat (Code One).
- A Gentex-type F-35 oxygen mask: matte black hard shell, light blue-grey silicone face seal, a low-front valve and a downward black elbow. Black webbing straps join on each side into a steel bayonet that plugs into the helmet receiver.
- A grey corrugated mask hose, about 0.03 m across and 0.4 m long. It runs down the chest to a quick-disconnect held in a webbing loop on the vest's right upper chest. A narrower dark teal/olive hose then continues to a connector block at the left hip.

**IAF recommendation.** p01 is the only photo of an IAF F-35I pilot. It shows the identical Gen III helmet: plain carbon, dark visor down, no decals. The mask is black with a grey corrugated hose, the same as on USAF (p17, p24, p25, p29) and RAAF (p27, p28) pilots.
- Use the dark day visor down for both the turntable and the cockpit renders, with the mask on.
- Confidence: about 90% that the helmet is the same, about 75% that the mask and hose are the same.
- Excluded photos: p02 is a painted legacy helmet in a two-seat F-16-type cockpit refuelling from a KC-135, not an F-35 HMDS. p10 and p11 show a full-face chemical/biological respirator being serviced, not the flight oxygen mask.

All crops (with pixel grids) are in /home/claude/pilot_ws/crops/helmet_mask/. Sources: photos p00–p29; Code One 'Lightning Sight'; DefenseNews 2016; Defense One 2017; Task & Purpose; Navy.mil; Gentex F-35 portfolio and aircrew catalogue; Collins/Elbit (redimec) brochure; Aviation Today 2015; Military Embedded Systems.

### Helmet shell (carbon composite dome)

**Shape.** Smooth egg-shaped dome, longer than wide, fullest at the back. The crown is about 0.06 m behind the corneal plane. The back is rounded and full. Its lower rear edge is a smooth arch over the nape that rises slightly toward the ear cups, then runs roughly straight forward under the ear-cup domes to a lower front corner at the cheek, where the mask receiver is. The face-opening edge climbs in front of the ear to the temple, and the forward-bulging brow display module closes the front above the eyes. The side walls bulge outward over the ears into broad, low ear-cup domes. Cross-sections are near-elliptical (breadth to length about 0.85). The shell wall is about 5 mm thick. The lower edge is finished with a rolled black rubber edge bead.

**Dimensions.** Built for a 1.78 m male (medium/large shell). Length: 0.29 m from the rear of the shell (Y -0.215, Z about +0.02) to the front of the brow module (Y +0.075); 0.30 m to the night-vision camera lens; 0.34 m with the visor raised. Breadth: 0.245 m across the dome at Z about +0.04; 0.26 m across the visor hubs; 0.27 m across the ear-cup covers (outer faces at X ±0.135). Height: 0.25 m from the crown (Z +0.160, Y about -0.06) to the rear lower edge (Z about -0.088 at Y -0.17 to -0.20). How far it sits past the head: top +0.04 m above the vertex; back about +0.025 m behind the opisthocranion; sides about +0.045 m beyond the head's widest point at the dome, about +0.06 m at the ear-cup covers; front, the brow module is +0.065 m ahead of the glabella and the camera lens +0.085 m ahead of the corneas. Face opening: top edge (liner) at Z +0.022, about 1 cm above the eyebrows; side edges at Y about -0.035 to -0.05, in front of the ears; lower front corners at Z about -0.07 to -0.09 (cheek/jaw). Lower edge under the ear cups at Z about -0.08. Edge bead diameter 0.008–0.010 m.

**Material.** Unpainted carbon-fibre composite: fine 2x2 twill (tow about 2–3 mm) under a satin clear coat. Base sRGB #1B1C1E (very dark charcoal), weave highlights #3C3F43. Clear-coat roughness about 0.3 (soft, satin highlights), metallic 0, coat IOR 1.5, slight scuffing on high points. Screws black oxide #151515. Edge bead black rubber #0E0E0E, roughness 0.7.

**Details.**

* Visible fine 2x2 twill carbon weave running diagonally over the whole dome (p24, p17, p01).
* Ear-cup dome bulges about 0.015 m on each side (p24, p27).
* Two shallow circular dimples, about 0.024 m across, on each upper side behind the visor hub at Y -0.10 to -0.125, Z +0.085 and +0.11. The lower one has a central black hex-socket screw (p24, p01, p17).
* Vertical-oval recess (about 0.055 x 0.030 m, about 6 mm deep) on each rear side at Y -0.16 to -0.19, Z +0.045 to +0.10, holding a black cam lever, probably the rear retention adjuster (p24, p01).
* Black button-head screws (about 7 mm) every 0.03–0.04 m along the lower edge and around the ear dome (p24).
* Black rubber edge bead all along the lower edge (p24, p13).
* No paint on USAF, RAAF or IAF helmets (p01, p17, p24, p27).
* Shell is offered in more than one size: small/medium/large shells per Code One for the Gen II; liner custom-milled from a laser head scan.

_photos p24, p17, p01, p27, p28, p25, p13, p03, p00; priority 1; confidence 0.6_

### Display visor (one-piece wrap-around, day/clear interchangeable)

**Shape.** One-piece, doubly curved visor (roughly spherical/toroidal: horizontal radius about 0.12–0.13 m, vertical radius about 0.15 m). It pivots on a transverse axis through the two side hubs. It is the display combiner, with the images projected from the brow module onto its inner surface.

Down (flight) position: covers the face from just below the night-vision camera down past the eyes. The lower edge has a deep inverted-U cut-out (flat-topped arch, corner radii about 0.015 m) that nests over the oxygen mask's nose section. The 'cheek' portions on either side reach down in front of the cheekbones. The sides taper back and up into mounting ears at the hubs. From the front it reads as a large bubble or ski-goggle covering the brow to mid-nose, with the mask in the notch (p27, p03, p13).

Up position: rotated about 50–60° about the hub axis. It then forms a forward-projecting transparent peak over the brow, with its top about 0.02 m above the shell crown, its lower edge at brow level and its front about 0.09–0.10 m ahead of the forehead (p24, p28, p17, p00). The lower edge is hand-trimmed to each pilot's mask (Code One); mask-to-visor clearance is checked at fitting (Task & Purpose).

**Dimensions.** Thickness about 0.0022 m (2–2.5 mm), edges rounded. Down position in the head frame:
- Inner surface about 0.05–0.06 m ahead of the corneas at eye level; outer front at Y about +0.065.
- Top edge at Z about +0.045 at the centre, rising to about +0.09 at the hubs.
- Lowest side points at Z about -0.06, X about ±0.055, Y about +0.02.
- Mask cut-out about 0.085 m wide at its base, about 0.055 m at its top, about 0.05 m deep. The top of the cut-out sits at Z about -0.01 over the nasal bridge, with 5–10 mm clearance to the mask shell.
- Height about 0.055 m at the centre (top edge to cut-out top), about 0.10–0.11 m on the eye lines, about 0.12 m at most.
- Chord width at eye level about 0.22 m; hub to hub about 0.245 m; developed length around the front about 0.40 m; mounting ears about 0.045 m tall.

**Material.** Optical polycarbonate, IOR 1.585, roughness 0.01–0.02.

Day visor: neutral smoke, luminous transmission about 15–20% (tint about #2A2A2C), plus a partly mirrored coating with F0 about 0.15–0.25, neutral to slightly bronze. From outside it looks near-black with sharp mirror reflections: sky and ground reflections, olive-bronze tones on the IAF pilot (p01), gold and white highlights (p25).

Clear visor: transmission about 75–85%, faint neutral grey, same semi-mirror coating (F0 about 0.15), giving a silvery look (p13, p28).

**Details.**

* Two interchangeable versions: dark 'day' visor (p17, p25, p27, p03, p01, p26) and clear 'night' visor (p13, p28). Defense One: 'quickly-changeable clear and dark visors'.
* Part numbers differ by one digit: clear 'DISPLAY VISOR' PNO 2ZCH82730-0020 (p13); dark visor PNO 2ZCH82731-0002 (p17).
* The inner face is a partly reflective combiner, so even the clear visor looks silvery and mirror-like from outside (p13 reflects the room sharply).
* No rubber edge trim: bare, polished polycarbonate edges with a thin bright edge line (p13, p17, p28).
* Clear mounting ears at the hubs with about 10 radial moulded stiffening ribs fanning out from the pivot boss (p13, p17, p24, p28).
* Black ID labels on the upper part near the pilot's RIGHT hub (p13, p17, p03); see the labels component.
* Fitting example 'TRIM VISOR L0001' (clear, with a white label) in p24 is a fitting tool; do not use it for the flight model.
* Recommended for the IAF renders: dark visor, down.

_photos p13, p17, p24, p28, p00, p03, p27, p25, p01, p26; priority 1; confidence 0.55_

### Brow display module and clear brow cover

**Shape.** A forward-bulging fairing over the forehead and temples. It carries the two display projectors (one above each eye) and the central night-vision camera. It has two visible layers.

(a) A structural housing in checkered spread-tow carbon. Internal optics show through: black lens barrels, silvery prism or mirror glints, small screws, a white plastic tab.

(b) A fixed, one-piece clear polycarbonate cover over the housing. It runs from just behind the visor's top edge up and back over the front half of the crown and down each side to the visor hubs, which gives the front-top of the helmet a glossy bubble look. Its rear edge runs from about the crown diagonally down to the hub and carries a thin black rubber bead. With the visor raised, the visor lies over this cover with a gap of about 1–2 cm.

**Dimensions.** Housing: about 0.21 m wide (temple to temple); projects about 0.06–0.065 m ahead of the forehead, with its front face at Y about +0.075 between Z about +0.03 and +0.10. Its lower edge, with the black brow pad of the liner below it, is at Z +0.022. Cover: about 0.002 m thick, 0.005–0.015 m above the housing. It spans from Z about +0.045 at the front (just above or behind the visor top edge) to the crown, reaching back to Y about -0.07 on top and to the hubs (Y -0.058, Z +0.092) at the sides. Checker squares about 0.007–0.008 m. Rear-edge bead about 6–8 mm across.

**Material.** Housing: spread-tow carbon checker, squares #121314 and #4A4D52, glossy under the cover. Internal parts: black #0E0E0E, with silver glints #C0C4C8. Cover: clear polycarbonate, transmission 0.9, very faint grey tint #E6E8EA, roughness 0.01, IOR 1.585. Bead: black rubber #0E0E0E, roughness 0.7.

**Details.**

* Alternating matte-dark and silvery-grey carbon checks are visible through the cover and through the visor's side portions (p24, p17, p25).
* On each side of the camera, black lens barrels and bright prism glints are visible through the cover (p28, p13).
* Short rows of small round holes or screw heads (3–4 mm) on the cover's upper surface (p24, p27, p03, p00).
* Helmet ID label strip on the cover near the pilot's right hub (p17, p13).
* Small black clip or stop at the top centre, where the raised visor rests (p17, p24); low confidence.
* In the front view, the cover's upper edge makes a slight step in the helmet outline (p27).

_photos p24, p17, p28, p13, p25, p03, p27, p00; priority 1; confidence 0.5_

### Oxygen mask hard shell

**Shape.** Fighter pressure-breathing mask. The rigid outer shell is a rounded inverted triangle or teardrop from the front: narrow at the nasal bridge, widest over the cheeks and mouth, ending in a rounded chin cup.

In profile, a pronounced nose section (the 'beak') runs forward and down from the nasal bridge. Below it the lower front recedes slightly to a round valve boss at mouth level, then curves back under the chin.

On the pilot's left side, a large rounded-rectangular opening in the side of the nose section shows the grey silicone underneath (p24). Strap-anchor lugs are moulded at the upper corners (beside the nose bridge) and the lower corners (chin) on each side. A small black label with white text is on the front (p27).

**Dimensions.** Height about 0.13 m (Z about +0.010 at the nasal bridge to about -0.125 below the chin). Maximum width about 0.105 m at cheek/mouth level (Z about -0.06); about 0.045 m wide at the bridge. Depth about 0.07 m from the face-seal plane. Most forward point (nose section) at Y about +0.068, Z about -0.02. Valve boss front at Y about +0.05–0.055, Z about -0.075. Chin cup at Y about +0.02–0.03. Wall about 0.003 m. Side window about 0.04 x 0.035 m, centred at Y about +0.04, Z about -0.03.

**Material.** Rigid plastic/composite, matte black #151515, roughness 0.55, slight sheen on edges, metallic 0.

**Details.**

* Made by Gentex: 'Oxygen Mask' and an anti-suffocation valve are listed in Gentex's F-35 portfolio. The model designation was not found.
* Black shell confirmed in p24 (fitting, side), p22 and p29 (hanging), p01 (IAF pilot holding the mask to their face).
* In p27 (RAAF, night lighting) the mask looks partly light grey: the silicone shows around the shell, or the colouring is from the light.
* Not on the face: in p28 and p22 it hangs on the chest by its hose; in p29 it hangs from one bayonet.
* p10 and p11 are a chemical/biological respirator, not this mask.

_photos p24, p27, p22, p29, p01, p00, p26, p28; priority 1; confidence 0.55_

### Oxygen mask hose (mask to chest)

**Shape.** Deeply corrugated, flexible elastomer hose with ring or fine helical corrugation. It leaves the mask's bottom outlet elbow and runs straight down the front of the neck and chest, then sweeps to the pilot's RIGHT to a quick-disconnect on the vest's right upper chest (p27, p28). Near the chest end it forms a loose 'S' or loop when the mask is unclipped (p28). A thin black microphone lead runs alongside it or loosely wound round it (p28).

**Dimensions.** About 0.030 m across the corrugation crests, about 0.024 m at the roots. Corrugation pitch about 0.009 m (about 110 rings per metre); wall about 0.002 m. Length about 0.40 m ±0.05 from the mask outlet to the chest connector. A moulded grey cuff at each end, about 0.032 m across and 0.025–0.04 m long. Standing path (p27): from the outlet (X 0, Z about -0.12 in the head frame) down the midline about 0.12 m, then curving to X about -0.10 (pilot's right), ending about 0.22–0.25 m below the chin at upper-chest level.

**Material.** Medium grey rubber/silicone #6E747A, darker valleys #4B5055, satin roughness 0.5. Reads dark grey in shade (p01, p29) and blue-grey in cool light (p27, p22).

**Details.**

* Same grey corrugated hose on USAF (p24, p29, p22), RAAF (p27, p28) and IAF (p01) pilots.
* At the mask end it fits over the black elbow through a grey rubber cuff (p24).
* Corrugation: deep, rounded rings. The crests catch the light and the valleys go dark (p01, p29).
* Leave enough slack for head turns. Under the helmet in the cockpit it drapes over the chest harness.

_photos p24, p27, p28, p29, p22, p01, p00; priority 1; confidence 0.65_

### Night-vision camera (brow centre)

**Shape.** A single forward-looking camera on the helmet centre-line at the front of the brow module, above the nose. It is a short black lens barrel with a slightly larger bezel or hood, pointing forward and about 5–10° down. The front glass has a strongly coloured anti-reflection coating that flashes blue-violet (or green/gold) in almost every photo. A small round secondary lens or sensor (about 0.012 m) sits just above and to the side of it, with a tiny white plastic tab next to it (p28). With the visor down, the camera sits just above the visor's top edge, behind or flush with the clear cover, and is the front-most point of the helmet.

**Dimensions.** Lens centre at X 0, Y about +0.085 (lens front), Z about +0.075–0.08 (about 0.08 m above the eye line). Bezel about 0.040 m across; front glass clear aperture about 0.028 m. Barrel protrudes about 0.02 m from the module face. Secondary lens about 0.012 m across, about 0.025 m above and to the side of the main lens.

**Material.** Housing black anodised aluminium/plastic #101112, roughness 0.4, with fine ring grooves on the barrel. Lens glass IOR 1.5 with a thin-film anti-reflection coating: reflection tint blue-violet #4A3CC8, shifting to green at grazing angles; dark interior #050505.

**Details.**

* Fully visible with the visor raised in p28, a 3/4 front view.
* Through the cover and above the visor in p27, p03 and p13 (centre top); seen side-on in p24.
* Integrated digital night vision: no separate night-vision goggles (Collins/Elbit brochure; Navy.mil).
* Aperture about twice that of the previous camera (Aviation Today 2015).

_photos p28, p24, p27, p03, p13, p29; priority 2; confidence 0.65_

### Visor pivot hubs and visor latch (both sides)

**Shape.** On each side at the upper temple, a round boss where the clear mounting ears of the visor and brow cover are screwed to the shell.
- About 10 moulded radial ribs fan out from the boss like a starburst, in the clear plastic.
- A central stainless pivot screw (Torx or hex socket) with a white nylon washer.
- Around and behind the screw, an angular black latch or lever plate (visor lock/detent) with one or two small screws and a hooked tip pointing rearward or downward.
- A small black block with two screws below it.

**Dimensions.** Hub centre at X ±0.123 (outer face ±0.135), Y about -0.058, Z about +0.092, i.e. about 0.06 m behind and 0.09 m above the eye. Rib fan about 0.045 m across; boss about 0.020 m; screw head about 0.008 m; washer about 0.012 m. Black lever about 0.035 x 0.015 x 0.006 m. Protrudes about 0.012–0.015 m from the shell.

**Material.** Ribs: clear polycarbonate. Screw: brushed stainless #B8BBBE, metallic 1, roughness 0.3. Washer: white nylon #E6E6E3. Lever and block: matte black anodised #141414, roughness 0.45.

**Details.**

* Pilot's right side, close-up: p17, p13.
* Pilot's left side: p24, p28.
* The visor rotates about the line through the two hub screws.

_photos p17, p24, p13, p28, p01; priority 2; confidence 0.65_

### Ear-cup domes and covers

**Shape.** The shell bulges outward over each ear into a broad, low dome. On it sits a round black ear-cup cap: a flat disc with a raised outer ring (fine embossed lettering or knurl on the ring) and a slightly recessed centre plate. The plate is held by small screws: two pairs of two-hole spanner screws, top and bottom, in p28; four screws in p25 and p13.

**Dimensions.** Cover about 0.058 m across; stands about 8–10 mm proud of the surrounding shell; outer ring about 5 mm wide. Centre at X ±0.128 (face at ±0.135), Y about -0.085, Z about -0.045, i.e. just below and behind the ear canal. Surrounding shell dome about 0.09 m across, bulging about 0.015 m. Bottom of the cover at Z about -0.075.

**Material.** Matte black plastic #121212, roughness 0.55; embossed text slightly glossier. Screws black oxide or dull steel #6A6A6A.

**Details.**

* Side views: p24 (pilot's left), p28 (pilot's left), p17 (pilot's right).
* Close views: p13, p25 (held helmet).
* The mask receiver sits at the front edge of the cover; the chin strap leaves just behind it.
* The helmet has active noise reduction ear cups (Collins/Elbit brochure; Navy.mil).

_photos p24, p28, p25, p13, p27, p17; priority 2; confidence 0.6_

### Mask face seal (silicone)

**Shape.** Soft silicone face-piece inside the hard shell. Its rolled edge stands about 1–1.5 cm beyond the shell all round and seals on the nasal bridge, the cheeks and under the chin. Seen from inside (p28) it is a deep cup with a nose pocket and the inhalation/exhalation valve at the bottom; small blue and red parts are visible deep inside. From outside it shows as a grey rim around the black shell and in the side window.

**Dimensions.** Seal rim about 0.012 m wide, lip about 0.004 m thick; internal depth about 0.06 m. Contact line: from the nasion (Z about +0.008) along the cheeks at X about ±0.05 to under the menton (Z about -0.125).

**Material.** Silicone rubber, light-medium blue-grey: #9AA0A6 inside, slightly darker #8A9096 outside. Roughness 0.45, slight subsurface scattering.

**Details.**

* Inside view: p28 (mask hanging on the chest).
* Grey rim visible outside: p22, p29, p24, p27.

_photos p28, p24, p27, p22, p29; priority 2; confidence 0.6_

### Mask valve, outlet elbow and side port

**Shape.** A round valve housing low on the front of the mask, with a short, glossy black elbow turning straight down. A grey rubber cuff on the elbow takes the corrugated hose (p24). On the pilot's RIGHT side of the mask is a round light-grey port with a dark centre, probably the Gentex anti-suffocation valve, which Gentex lists as used on the F-35 mask (p27). On the left side, the grey window (see hard shell) is seen instead (p24).

**Dimensions.** Valve boss about 0.035 m across, at Y about +0.05, Z about -0.075, about 0.010 m proud. Elbow about 0.020 m across, about 0.035 m long, down to Z about -0.115. Cuff about 0.032 m across, 0.025 m long. Side port about 0.030 m across, about 0.008 m proud, dark centre about 0.012 m, at X about -0.045 (pilot's right), Z about -0.05.

**Material.** Valve and elbow: black glossy plastic #0C0C0C, roughness 0.25. Cuff: grey rubber #7D8288, roughness 0.6. Side port: grey silicone #A3A8AD with a black centre.

**Details.**

* Elbow and cuff clearly visible in the side view (p24).
* Round side port visible in the front view (p27).

_photos p24, p27, p28; priority 2; confidence 0.5_

### Mask straps and bayonets

**Shape.** On each side, an upper and a lower black webbing strap leave the mask's anchor lugs and converge in a V about 0.06 m behind the mask. They meet at a black plastic ladder-lock style adjuster buckle and end in a flat, polished steel bayonet tongue. The tongue pushes forward into the helmet's mask receiver in front of the ear cup. When unclipped on one side, the mask hangs from the other bayonet, showing the steel tongue (p29).

**Dimensions.** Webbing about 0.015–0.019 m wide, 1.5 mm thick. Upper strap runs from about Y +0.01, Z -0.02 to the bayonet at Y about -0.05, Z about -0.045; lower strap starts at about Y 0.0, Z -0.09. Buckle about 0.025 x 0.020 x 0.006 m. Bayonet tongue about 0.055 x 0.012 x 0.003 m, with a slot or hole near the tip.

**Material.** Webbing: black nylon #141414, roughness 0.8, fine weave texture. Buckle: black plastic #111111. Bayonet: polished steel #C9CCCF, metallic 1, roughness 0.2.

**Details.**

* Fitting close-up showing the strap V, buckles and steel bayonets: p24.
* Hanging mask with an exposed bayonet: p29, p22.

_photos p24, p29, p22, p28; priority 2; confidence 0.55_

### Helmet cable (power/video/data) and connector

**Shape.** A single black braided cable leaves the lower rear of the shell near the centre back, at about occipital level, through a black moulded boot. It drops down the back of the neck and is routed to the right side of the ejection seat. Code One: the power/data cable 'runs from the middle of the back of the helmet down the flight suit and plugs into the right side of the seat'; it disconnects automatically on ejection.

Its end is an olive-drab circular military connector with a knurled coupling ring, a multi-pin face (about 6 pins visible), a black rubber back-shell boot and a thin lilac/blue-grey lanyard wire (p25). In p27 a black cable with a yellow band and a connector hangs at the right hip, probably the seat end of this lead.

**Dimensions.** Cable about 0.010 m across (braid over core). Exits at Y about -0.21, Z about -0.02 to -0.06. Free length to the seat-side connector about 1.0 m including slack. Connector about 0.038 m across, about 0.035 m long, plus a boot about 0.03 m; lanyard about 2 mm across. Yellow band (p27) about 0.06 m long.

**Material.** Braid: black PET #111111, fine diagonal weave texture, roughness 0.6. Connector: olive-drab cadmium #5F5D44, metallic 0.6, roughness 0.45. Boot: black rubber. Lanyard: #8E86A8. Band: yellow #E2C21E.

**Details.**

* Cable exit from the back: p24, p01 (IAF, looping behind the neck).
* Connector close-up: p25.
* Coiled under the helmet on the table: p13.
* Gentex lists a 'Helmet Cable Interface (HCI) Cable' in its F-35 portfolio.

_photos p25, p24, p01, p27, p13; priority 2; confidence 0.55_

### Mask receivers on the helmet (mask attachment points)

**Shape.** On each side, at the front edge of the ear-cup region, a curved black rail runs down along the cheek, following the face. Its forward face is notched (5–6 detents) to take the mask's steel bayonet at different heights. An angular black upper mount with two screws ties it to the shell below the visor hub. The visor's side edge passes above it.

**Dimensions.** Rail about 0.08–0.09 m long, 0.018 m wide, 0.012 m thick. It runs from Z about -0.005 (eye level) to Z about -0.09 (mouth level), at Y about -0.04 to -0.06, X about ±0.105–0.115. The bayonet engages at about Y -0.05, Z -0.05 in p24. Upper mount about 0.03 x 0.025 m.

**Material.** Satin black plastic #111111, roughness 0.4. Screws black or dull steel.

**Details.**

* Pilot's right side, seen past the nose: p28.
* With the bayonets engaged: p24.
* In front of the ear: p17.

_photos p28, p24, p17, p13; priority 2; confidence 0.45_

### Rear hardware: retention levers, chin strap, nape pad, edge bead

**Shape.** At the back:
- On each rear side, an oval recess holding a black cam lever (probably the nape-strap tension).
- A black fabric-covered nape pad just visible under the rear lower edge.
- A black webbing chin strap anchored inside the lower edge behind each ear cup, passing under the jaw, with a black plastic end tab (hangs loose in p24; pulled during donning in p17).
- A rolled black rubber edge bead round the whole lower edge, with black button-head screws.
- A black padded strap with red zig-zag stitching, seen along the top-rear while the helmet is being pulled on (p17). Its purpose is unclear.

**Dimensions.** Recess about 0.055 x 0.030 m at Y -0.16 to -0.19, Z +0.045 to +0.10; lever about 0.045 x 0.015 m. Nape pad about 0.10 m wide, about 0.015 m visible below the edge, at Z about -0.09. Chin strap webbing about 0.019 m wide, end tab about 0.03 x 0.015 m. Edge bead 8–10 mm. Screws about 7 mm every 0.03–0.04 m.

**Material.** Levers and tabs black plastic #121212, roughness 0.5. Webbing and pads black nylon/fabric #131313, roughness 0.85. Red stitching #B0201E (p17 only).

**Details.**

* Recess with lever: p24, p01.
* Chin strap: p24, p17.
* Red-stitched strap during donning: p17.

_photos p24, p01, p17, p25; priority 3; confidence 0.45_

### Chest hose connector and lower oxygen hose to the left-hip connector block

**Shape.** The mask hose's lower cuff plugs into a quick-disconnect clipped into an olive webbing/Velcro keeper loop on the vest's RIGHT upper chest (p28; RAAF in p27; IAF in p01, where an olive tab with a brass snap sits next to the hose). From there a narrower corrugated supply hose runs diagonally across the abdomen to the pilot's LEFT hip. It ends at a black connector block that mates with the seat's left side. Code One: the oxygen hose and comms link go to a 'pilot interface connector on the left side of the seat'. The black block is visible on the left hip in p22.

**Dimensions.** Connector at X about -0.09 (pilot's right), about 0.22–0.25 m below the chin, on the vest surface. Cuff about 0.032 m across, about 0.04 m long. Keeper loop about 0.04 m wide. Lower hose about 0.020 m across, about 0.55 m long. Hip block about 0.12 x 0.06 x 0.04 m, with 2–3 round connectors.

**Material.** Cuff: grey rubber #7D8288. Keeper: olive webbing #4E5A3A. Lower hose: dark teal #2E5458 in p27 and p28; p22 shows a dark green smooth hose with a green tape band, so use dark teal/olive. Block: black plastic #111111 with steel connector rings.

**Details.**

* Keeper loop and connector: p28.
* Lower hose crossing the torso: p27, p28.
* Black block at the left hip: p22.
* The vest itself belongs to another area; only the hose path and plug points are given here.

_photos p28, p27, p22, p01; priority 3; confidence 0.45_

### Inner liner and face-opening padding

**Shape.** Along the face opening: a black foam brow pad edge (leather- or fabric-covered) across the forehead and down the temples, with black cheek padding. Deeper inside, the custom-milled liner and comfort pads look bright royal blue. A blue ring is visible through the face opening of the helmet on the table (p13), and a blue band through the dark visor (p25). The liner is a custom-milled foam cap from a laser head scan (Navy.mil; Task & Purpose).

**Dimensions.** Pad edge about 0.015 m thick at the face opening, lower edge at Z +0.022. Liner thickness about 0.02–0.025 m.

**Material.** Edge pad black #121212, roughness 0.8. Liner blue #1F3FA8, roughness 0.9.

**Details.**

* Black pad edge: p28, p17.
* Blue liner parts: p13, p25.
* Only visible when looking into the visor or face opening.

_photos p28, p17, p13, p25; priority 3; confidence 0.35_

### Labels and decals (helmet and mask)

**Shape.** Flat stickers following the curved surfaces.

**Dimensions.** Visor label about 0.045 x 0.018 m; helmet ID strip about 0.04 x 0.008 m; QR stickers about 0.010 m square; mask tag about 0.02 x 0.008 m.

**Material.** Labels: matte black vinyl #0D0D0D with white #F2F2F2 print. Mask tag: teal #2AB3B0.

**Details.**

* Display visor label: black rectangle on the visor's upper part near the pilot's RIGHT hub. White text in 4–5 lines with a 'VSI' logo, e.g. 'DISPLAY VISOR / CAG 06VL3 SEQ 1CH694 / PNO 2ZCH82730-0020 / VSI NO 353300-01-12', plus a white data-matrix about 0.010 m (p13). Dark visor (p17): 'CAG 0Y7X6 (reading uncertain) / SEQ EV6192 / PNO 2ZCH82731-0002 / RG PN 987-0006-460' with a small data-matrix, and a separate VSI logo label.
* Helmet ID strip: thin black strip on the clear cover's edge near the right hub, white text '09344 · 987-0006-460 REV U S/N EV6192' (p17, p13).
* Two white QR/data-matrix stickers with three short text lines on the visor's upper right (p03).
* No paint, call sign, national or squadron insignia on any F-35 helmet in these photos; the IAF helmet in p01 is plain carbon.
* p02's painted helmet ('VÖN' call sign, yellow Las Vegas skyline, red dashed outlines) is a legacy F-16-type helmet; do not copy it.
* Mask: a small teal/turquoise tag on the left side of the shell (p22, p26) and a small black label with white text on the front (p27).

_photos p13, p17, p03, p01, p22, p26, p27, p02; priority 3; confidence 0.6_

### Communication leads (mask microphone lead, earplug leads)

**Shape.** Mask microphone lead: a thin black cable from a small right-angle connector with a metal ring on the mask's upper side (p29). It runs along the hose (p28) and has a yellow-jacketed section near the chest connector. It ends in a black multi-ring plug hanging just below the keeper loop (p28).

Earplug leads: very thin black cords from in-ear communication plugs (seen without a helmet in p22 and p21). With the helmet on, only short loops hang below the shell edge near the ears (p27, both sides).

**Dimensions.** Microphone lead about 0.004 m across, about 0.5 m long. Plug about 0.007 m across, about 0.06 m long. Yellow section about 0.10 m. Earplug cords 2–3 mm across; visible loops about 0.05–0.15 m.

**Material.** Black PVC #111111, roughness 0.5. Yellow jacket #E0C020. Plug rings brushed steel.

**Details.**

* Microphone lead and plug: p28, p29.
* Earplug cords: p22, p21; loops under the helmet edge: p27.

_photos p28, p29, p27, p22, p21; priority 3; confidence 0.4_

### Open questions

* Absolute scale comes from facial landmarks, a hand, a watch bezel and anthropometric averages. Expect about ±10% on all sizes; ratios between parts are more reliable. The p24 subject may be a smaller (possibly female) pilot, so the shell lengths were scaled up for an 80 kg male.
* Helmet shell sizes exist (small/medium/large per Code One for the Gen II). The male pilot would wear the larger shell.
* No well-lit straight-on photo shows the visor down. The down-position visor outline, the cut-out size and the 0.05–0.06 m standoff from the eyes are partly inferred from the raised-visor geometry (p24, p28, p17) and from p13, p03 and p27.
* Visor rotation angle (about 50–60°) and the exact hub height (about 0.09 m above the eyes) are estimates; p17 and p28 show the helmet not fully seated.
* Exactly which piece is the fixed clear brow cover and which is the movable visor is partly inferred from the labels and layering in p13, p17, p24 and p28.
* The notched black rails on the cheeks are read as mask receivers. Their exact form and function are not documented publicly.
* The mask's model designation and exact geometry are not published. Gentex lists an F-35 oxygen mask with an anti-suffocation valve. The round grey port (p27) and grey side window (p24) are interpreted, not confirmed.
* Mask colour: black shell in p24, p22, p29 and p01, but partly light grey in the night-lit RAAF photo p27 (lighting, or a variant).
* Lower supply hose colour: dark teal in p27 and p28, dark green with a green band in p22.
* Helmet cable: Code One says it runs to the right side of the seat. Thin black loops seen at the left rear (p27, p01) may be earplug or microphone leads, not the main cable.
* Blue liner colour is inferred from blue parts seen through the visor and face opening (p13, p25); it may be a fitting fixture or stand.
* Tint, reflectance and transmission values are visual estimates, not specifications.
* IAF-specific: only p01 shows an IAF F-35I pilot. Helmet, visor and hose appear identical to USAF/RAAF; about 90% confident on the helmet, about 75% on the mask and hose. No IAF decals are seen, but it cannot be ruled out that some IAF pilots add small stickers.
* Excluded photos: p02 is not an F-35 HMDS (legacy painted helmet, two-seat F-16-type cockpit, KC-135 tanker). p10 and p11 show a chemical/biological full-face respirator being serviced, not the flight oxygen mask.

## 2. Flight coverall, gloves, boots, watch and kneeboard

Spec for the IAF F-35I pilot's flight suit, gloves, boots, watch and kneeboard, built from 28 reference photos. I checked photos p00-p08, p12, p14-p29 and p09 in close crops, which are saved in /home/claude/pilot_ws/crops/suit_gloves_boots/ (labelled montages M1-M8 plus single crops). I also estimated colours by white-balancing against flag and T-shirt whites in each photo.

Key findings and recommendations for the IAF F-35I pilot:
(1) Flight suit. Israeli aircrew wear a one-piece olive Nomex coverall with exactly the US CWU-27/P layout. That means slanted zippered chest pockets, a left-chest hook-and-loop name field, a left-sleeve pen pocket with a zippered pocket, a right thigh pocket zipped across the top and a left thigh pocket zipped vertically. It also has a knife pocket on the inner left thigh, zippered shin pockets, ankle zippers, waist tabs and hook-and-loop cuff tabs (p06, p19). The IAF colour is darker and more yellow-olive than USAF/RAAF sage; p06 shows both in the same light. Use about #646246 for IAF, against about #6E6D57 for USAF sage.
(2) IAF-only items: shoulder straps carrying navy rank slides (p01, p05, p06, p19). The F-35I pilot in p01 wears a navy slide with a single white leaf, which is the IDF Major (Rav Seren) insignia. Other IAF items are a white T-shirt at the open collar and a blank (or navy, p05) left-chest name field; IAF photos usually show it blank. There is a round squadron patch on the right chest, an Israeli flag on the left upper arm and a round unit patch on the right upper arm. No separate pilot-wings badge is visible.
(3) Boots: Israeli aircrew wear black smooth-leather lace-up ankle boots (p06, p18, p20). USAF pilots wear coyote suede 8-inch boots (p12, p07).
(4) Gloves: no photo shows an IAF pilot with gloves on; on the ground all pilots are bare-handed. I recommend the US-issue sage Nomex flyer's glove with a grey leather palm and long gauntlet (GS/FRP-2 type, seen in p26), at low confidence. The tan/black tactical gloves with cut-off fingertips in p21 are not typical.
(5) A steel wristwatch on the left wrist is near-universal in the photos (p27, p06, p05, p24, p17). A thigh-strapped tablet kneeboard is optional (seen only in p22).

In full flight gear the survival vest covers the chest and the G-suit covers waist to ankle (p27). Priorities are therefore set for what stays visible in the standing and cockpit renders: suit body, sleeves, cuffs, collar, sleeve patches, rank slides, gloves and boots.

Public specs used: CWU-27/P listings at https://www.mypilotstore.com/MyPilotStore/sep/9244 and https://valleyapparel.net/product/cwu-27p-flight-suit, and GS/FRP-2 colourways at https://lifesupportintl.com/products/glo-1000-ds.

### Flight suit - base one-piece coverall (IAF olive, CWU-27/P pattern)

**Shape.** One-piece, long-sleeve, straight-leg coverall with a loose cut. The torso is boxy and blouses 0.02-0.03 m over a waist seam that is gathered by two front tabs and a back elastic. Sleeves are set in with slightly dropped shoulders. The crotch is dropped and the legs are wide and straight, ending in zippered leg openings. Panels: left and right fronts joined by the centre zipper; one back panel with a bi-swing/action back (pleats behind the armholes); felled side seams from armpit to ankle along the outer leg line; inseams from crotch to hem; under-arm sleeve seams. The single-layer lightweight fabric drapes in soft folds. Pockets are applied patches or zippered openings in the fabric, with double-needle edges. Standing pose folds: 3-4 long vertical drape folds per leg; diagonal drag folds from the crotch toward the inner knees; 2-3 stacked horizontal ripples above the boots; concertina folds inside the elbows; radial gathers at the cuffs and waist tabs; drag folds from the collar to the armpits. Seated (cockpit) folds: deep horizontal folds across the hip crease and lower abdomen; tension over the knees; bunching behind the knees; legs ride up about 0.05 m, exposing the boot shafts; sleeves ride up toward the glove gauntlets when the hands are forward on stick and throttle. Fold depths: main folds 0.01-0.03 m, secondary wrinkles 0.003-0.008 m.

**Dimensions.** Sized for a 1.78 m / 80 kg wearer (about US size 42R; the public chart gives 40R as chest 0.99-1.04 m, sleeve inseam 0.58 m, leg inseam 0.775 m). Heights (z) are above the floor. Garment circumferences: chest 1.20 m at z=1.30 m; waist seam at z=1.09 m, 1.15 m open and about 1.02 m with tabs closed; seat 1.18 m at z=0.92 m; thigh 0.72 m at z=0.76 m; knee 0.56 m at z=0.50 m; hem 0.48 m (zipper closed) to 0.62 m (open). Shoulder seam runs from the neck point (z=1.50 m, 0.075 m off centre) to the shoulder point (z=1.45 m, 0.225 m off centre, about 0.02 m beyond the acromion). Sleeve: bicep 0.44 m, elbow 0.38 m, forearm 0.34 m; shoulder point to sleeve end 0.63 m, so with the arm hanging the end reaches about 0.02 m past the wrist bone. The crotch seam hangs at z=0.80 m, about 0.035 m below the body crotch (0.835 m). The front hem rests on the boot vamp at z=0.09 m; the back hem is about 0.04 m above the floor. Average stand-off from the body is 0.02-0.04 m on the torso and 0.03-0.06 m on the legs. Fabric thickness is 0.00045 m (about 153 g/m2, '4.5 oz' Nomex), doubled at plackets, cuffs and pockets.

**Material.** IAF (recommended): olive, sRGB #646246 = RGB(0.392, 0.384, 0.275), linear (0.127, 0.122, 0.061). Allow +/-6% value variation between panels. USAF/RAAF alternative: sage, sRGB #6E6D57 = RGB(0.431, 0.427, 0.341), linear (0.156, 0.153, 0.095). The fabric is a matte, lightweight plain-weave aramid (Nomex with anti-static fibre). Shader: roughness 0.85; specular/IOR level about 0.35 (IOR 1.45); sheen weight 0.25-0.3 with sheen roughness 0.5, which gives a soft lighter rim on folds. The weave pattern is not visible at render distance; an optional micro-weave bump (0.3 mm pitch) should be very weak. Wear: knees, seat, elbows, cuff edges and pocket edges are about 8% lighter and less saturated; collar and cuff edges carry slightly darker grime. The cadet suits in p19 show sun fading and heavy creasing.

**Details.**

* Colour comparison in one frame, p06 (Blue Flag 2019, Ovda). The two IAF pilots (helmets on) wear suits estimated at albedo #5D5B3F-#6E6847 (hue about 56-64 deg, saturation about 0.18). The two USAF suits next to them are greyer and lighter, about #6A6653-#838771 (saturation 0.09-0.12). Greek and Italian suits in the same frame are close to the IAF olive.
* Other IAF olive suits: p05 (2013 senior officer), p18/p19 (flight academy cadets, sun-faded), and p01 (F-35I '927' pilot, Red Flag 2023), where the suit reads dark olive-grey in overcast light inside the cockpit.
* USAF sage CWU-27/P suits: p07, p25, p16, p17, p21, p22, p04. RAAF sage suits: p27, p28. The RNoAF suit in p24 is a brighter green.
* The IAF suits (p06) have exactly the same pocket and closure layout as the USAF CWU-27/P (p07). The public CWU-27/P spec lists: 2 tilted zippered chest pockets; a hook-and-loop name field on the left breast only; a left-sleeve covered pen pocket plus zippered pocket; 2 thigh and 2 shin zippered pockets; a knife pocket on the left inseam; a two-way front zipper with cloth pull; zippered leg openings; hook-and-loop waist belt and cuffs; felled seams; reinforced shoulders; bi-swing/gusseted back; 92/5/3 Nomex N303 fabric.
* The only IAF difference in construction: shoulder straps carrying navy rank slides (separate component).
* Seams are double-needle felled, with rows about 0.006 m apart, stitch length about 0.003 m and tone-on-tone thread. Pocket corners are bar-tacked. Seams pucker slightly (p25 collar crop).
* No back pockets. The back has a gathered elastic waist, vertical bi-swing pleats and a centre-back seat seam (p04).
* Visibility in full gear: the survival vest covers most of the chest and the G-suit covers waist to ankle (p27). The suit stays visible at the shoulders, upper arms, forearms, cuffs and neck.

_photos p06, p07, p05, p18, p19, p01, p04, p25, p27, p28; priority 1; confidence 0.75_

### Flight suit - collar, two-way front zipper and visible undershirt

**Shape.** Shirt-type collar made of a collar stand plus a fall with pointed tips. When the zipper is lowered the collar lies open on the chest; when zipped it stands around the neck. An exposed two-way metal zipper runs down the centre front from the collar base to the crotch. In the open V at the neck a crew-neck T-shirt shows.

**Dimensions.** Neckline circumference about 0.44 m at z=1.46-1.50 m. Collar stand height 0.03-0.035 m; fall depth 0.045 m at the back; tip length 0.075-0.08 m; tips about 0.13 m apart when the collar is closed. Zipper about 0.64 m long, from z=1.46 m to z=0.82 m (crotch). Visible tooth chain about 0.006 m wide, with about 0.012 m of tape on each side. On the ground it is usually unzipped down to z=1.33-1.38 m, a V 0.10-0.15 m deep. The top slider has a small fabric pull loop about 0.02 x 0.01 m; the second (bottom) slider sits just above the crotch. The visible T-shirt V is about 0.06 m wide x 0.08 m deep.

**Material.** Collar in the suit fabric. Zipper teeth: brass #8C7340 = RGB(0.549, 0.451, 0.251), metallic 1.0, roughness 0.35. Slider: brass or gunmetal #6E6A60, metallic. IAF white T-shirt: cotton jersey #ECECEC = RGB(0.925, 0.925, 0.925), roughness 0.95, sheen 0.3. USAF tan T-shirt #C2B59B; RAAF navy #1F2A44.

**Details.**

* Teeth are brass/gold-tone metal and exposed: p19 (right cadet, clearly gold), p06 (IAF pilot 1), p25 (collar crop).
* Two sliders: the bottom slider shows just above the crotch in p06 (both IAF pilots) and p07.
* Undershirt colour differs by force: IAF white crew-neck (p06 both pilots, p19 both cadets); USAF tan/sand (p07, p25, p16, p21); RAAF navy (p27, sampled #1D283D). Recommend white for IAF (confidence 0.8).
* In full gear with vest and mask (p27) the collar is still open at the throat and the undershirt shows.
* The collar has a top-stitch line about 0.005 m from its edge. Collar points curl slightly upward.

_photos p06, p19, p25, p07, p27, p05, p16, p21; priority 2; confidence 0.75_

### Flight suit - sleeve cuffs and hook-and-loop cuff tabs

**Shape.** Each sleeve ends in a doubled cuff band about 0.07 m deep. A grey-green webbing strap circles the sleeve just above the band and ends in a tab with hook velcro on its underside. The tab wraps round and closes onto an olive-drab (OD) loop-velcro patch on the outer cuff. Tightened, the sleeve gathers into 4-6 radial folds at the wrist; loosened, the cuff flares.

**Dimensions.** Cuff band 0.07 m deep. Sleeve-end circumference 0.30 m open and 0.22-0.24 m closed (wrist circumference 0.175 m). Loop-velcro patch 0.09 x 0.045 m on the outer (back-of-wrist / little-finger) side, starting at the sleeve end. Webbing strap 0.025 m wide, about 0.07-0.10 m from the sleeve end; free tab about 0.08 x 0.03 m. Velcro stands about 0.0015 m proud of the fabric.

**Material.** Cuff band in the suit fabric. Loop velcro, OD green #5A6440 = RGB(0.353, 0.392, 0.251) (p17 sampled #536232): roughness 1.0, sheen 0.6, fine fuzzy noise bump. Webbing, grey-green #69716D = RGB(0.412, 0.443, 0.427): roughness 0.8, woven-rib bump along the strap. Edges are zig-zag stitched.

**Details.**

* p17 (forearm crop): a vivid OD loop-velcro panel at the cuff end, with a grey-green webbing band with zig-zag stitching just behind it.
* p28 (RAAF, both wrists): the same arrangement; on the left wrist a watch sits partly under the cuff.
* p06 (IAF pilot 2): a vertical OD velcro strip about 0.10 m long on the right cuff, so IAF suits use the same tab system. p01 (IAF F-35I pilot): green velcro tab on the left cuff.
* p03: cuff tab with velcro; a black watch is worn just beyond the cuff.
* With gloves on, the glove gauntlet sits over or just below the cuff. p26 shows a light band, either skin or a wrist strap, between the gauntlet and the sleeve.

_photos p17, p28, p03, p06, p01, p26; priority 2; confidence 0.75_

### Flyer's gloves (recommended GS/FRP-2 type, sage Nomex with grey leather palm)

**Shape.** Thin, close-fitting five-finger gloves. The back of the hand and the backs of the fingers are knitted Nomex. A thin leather panel covers the palm and the palm side of all fingers, wraps over each fingertip, and covers the palm side of the thumb. The side gussets between the fingers (fourchettes) are knit. A shirred elastic band crosses the back of the wrist, and a long, soft knit gauntlet runs up the forearm. Expect wrinkles across the knuckles and at the wrist, and leather creases in the palm.

**Dimensions.** For hand length 0.19 m and breadth 0.088 m: overall glove length about 0.30 m (fingertip to gauntlet edge); palm width 0.095 m. The gauntlet extends 0.10 m past the wrist crease, with an opening circumference of about 0.25 m. Material thickness about 0.0008 m for the knit and 0.0006 m for the leather. The leather wraps about 0.01 m onto the back of each fingertip. The wrist shirring band is about 0.015 m wide, at the wrist crease on the back of the hand.

**Material.** Knit back: sage #6E6D57 = RGB(0.431, 0.427, 0.341); roughness 0.9, sheen 0.4, fine knit bump. Leather palm: cool grey #74726A = RGB(0.455, 0.447, 0.416); roughness 0.55, slight specular, fine grain bump. Palm and fingertip pads are darker and glossier from grime (value -15%, roughness 0.45). Alternative colourway: OD knit #4E5236 with black leather #1E1E1E.

**Details.**

* No photo shows an IAF pilot wearing gloves; every ground photo shows bare hands (p01, p17, p24, p25, p27, p28, p00, p03).
* p26 (USAF F-35A demo pilot in the cockpit): a sage/grey-green knit glove with a long gauntlet.
* p21 (USAF F-35 pilot): non-standard tactical gloves with a coyote-tan back, black padded panels across the knuckles and finger backs, a black thumb, and the index and middle fingertips cut off. Not recommended for IAF.
* Standard US issue colourway is 'Sage Green / Gray leather'; another issue colourway is 'OD Green / Black leather' (lifesupportintl.com/products/glo-1000-ds).
* Recommendation for the IAF F-35I pilot: sage knit with a grey leather palm, since the IAF uses largely US aircrew equipment (confidence 0.45). Alternative: OD knit with a black palm.
* Seams: double-stitched finger seams join the leather and knit along each finger side; a palm seam runs across the base of the fingers; a hem finishes the gauntlet edge.
* In the cockpit the right hand is on the side-stick and the left on the throttle, with the gauntlets pulled over the suit cuffs.

_photos p26, p21, p17, p25, p27, p28; priority 2; confidence 0.45_

### Shoulder straps with IAF navy rank slides

**Shape.** IAF suits have a fabric shoulder strap (epaulette) on each shoulder, running from the sleeve head toward the collar. A navy cloth rank slide (a tube of cloth) slides over the strap. It is rectangular with a pointed or rounded end at the collar and carries white/silver embroidered IDF rank insignia. USAF/RAAF CWU-27/P suits have no straps; their rank is a small embroidered patch sewn on the shoulder (p07).

**Dimensions.** Strap about 0.05 m wide x 0.14 m long, lying on top of the shoulder from the sleeve-head seam (z=1.45 m) toward the collar, ending about 0.02 m short of it. Slide about 0.115 x 0.055 m and 0.002-0.003 m thick. Insignia about 0.03 m tall.

**Material.** Slide: dark navy cloth #1C2541 = RGB(0.110, 0.145, 0.255); roughness 0.75, sheen 0.3. Embroidery: white #E6E6E6, roughness 0.6, raised 0.0008 m with a bump that follows the thread direction. Strap in the suit fabric.

**Details.**

* p01 (IAF F-35I '927', Red Flag 2023): a navy slide on the left shoulder with a single white leaf, the IDF Rav Seren (Major) insignia. This is the most F-35I-specific evidence.
* p05 (IAF senior officer, Ovda 2013): navy slide with a white embroidered emblem, with the edge of the Israeli flag patch just below it.
* p06 (IAF pilots, Blue Flag 2019): navy slides on both shoulders.
* p19 (IAF cadets): navy slide with a lighter edge/interior on the left shoulder.
* The fastening (button or velcro) is not visible; keep it hidden under the slide.
* Recommendation: navy slides with one white leaf (Major) or two leaves (Lt Col).

_photos p01, p05, p06, p19; priority 2; confidence 0.7_

### Sleeve insignia - Israeli flag (left upper arm) and round unit patch (right upper arm)

**Shape.** Flat embroidered patches, sewn or velcroed onto the outer upper arms: a rectangular Israeli flag on the left arm and a round coloured unit patch on the right. They follow the curve of the sleeve.

**Dimensions.** Israeli flag about 0.085 x 0.055 m, long edge horizontal with the arm hanging. Its centre is 0.05-0.06 m below the shoulder seam (z=1.39 m), on the lateral line of the left upper arm. The two blue stripes are about 0.008 m tall, inset about 0.007 m from the top and bottom edges; Star of David about 0.025 m; blue overlocked (merrow) edge about 0.003 m. Right-arm round patch: diameter about 0.085 m, at the same height. Patch thickness about 0.002 m.

**Material.** Embroidered thread: flag white #F0F0F0, flag blue #0038B8 = RGB(0.0, 0.220, 0.722); roughness 0.6, sheen 0.35; slightly raised stitch bump; rolled overlocked (merrow) edge. Unit patches: multicolour embroidery with a dark overlocked border.

**Details.**

* IAF left-arm flag: p06 (both IAF pilots), p19 (right cadet, flag directly above the sleeve pocket), p05 (edge visible).
* IAF right arm: round coloured unit or course patch. In p06, pilot 1's is white/navy/red and pilot 2's is blue/white; in p19 it is green/blue with a black bird.
* RAAF: Australian flag with an 'AUSTRALIA' tab on the left shoulder (p27).
* USAF: squadron patch on one shoulder (left in p07, right in p25). Small call-sign or qualification tabs on the left sleeve: 'Wild Weasel' (p07), 'SPIKE' (p24, RNoAF), blue F-35 tab (p25).
* The patch designs of the F-35I squadrons (140 'Golden Eagle', 116 'Lions of the South', 117 'First Jet') are not visible on any pilot in these photos. The jet in p01 carries a white eagle emblem on the intake, probably 140 Sqn.

_photos p06, p19, p05, p27, p07, p24, p25, p01; priority 2; confidence 0.7_

### Boots - IAF black leather lace-up ankle boots (USAF coyote variant noted)

**Shape.** Black smooth-leather lace-up ankle boot (6-inch class). Rounded plain toe; vamp and quarters with double stitch rows; padded collar; gusseted tongue; 6-7 pairs of eyelets, some with brass hooks at the top; flat black laces tied in a bow at the front of the ankle. Black rubber outsole with a slight welt line, a low heel step and chevron (V) lugs. The suit hem stacks over the shaft, so usually only the foot and 0.03-0.05 m of shaft show.

**Dimensions.** For a foot length of 0.27 m: boot length 0.305 m; ball width 0.11 m; heel width 0.075 m; instep height about 0.10 m; shaft top 0.15-0.18 m above the floor at the back; toe spring 0.01 m. Outsole 0.012 m thick at the forefoot; total heel stack about 0.03 m; welt line at about 0.015 m. Laces about 0.005 m wide. Eyelets about 0.008 m in diameter, spaced about 0.02 m apart. USAF coyote variant: 8-inch class, shaft top about 0.21 m; lugged outsole 0.03-0.035 m thick with lugs about 0.006 m deep.

**Material.** Upper leather: black #1B1B1D = RGB(0.106, 0.106, 0.114); roughness 0.35 overall, 0.25 on the polished toe, 0.45 on the shaft; coat 0.3; crease normal detail at the flex line. Sole: black rubber #202020, roughness 0.85. Laces: black matte nylon. Eyelets: black-painted metal, or brass #8C7340 (p18). USAF alternative: coyote suede #9C7B58 (p12 sunlit sample #B5916C), roughness 0.95 with a fuzzy nap; nylon panel #A7937E; coyote rubber sole #8E8070.

**Details.**

* p06 (IAF pilots, Blue Flag 2019): polished black leather boots with rounded toes and black soles; the suit's ankle zippers are partly open over them.
* p20 (Israeli pilots with MV-22B): polished black leather ankle boots with visible laces through 5 or more eyelets and black soles with a slight welt.
* p18 (IAF cadets, seated): black leather boots, some with brass eyelets or hooks; the soles show a chevron (V) lug pattern.
* USAF differs: coyote-brown rough-out suede with a nylon side panel, a cluster of punched vent holes near the ankle (2 columns of 3-4 holes), suede toe and heel overlays, speed lacing and a deep 'pebble' lug coyote sole (p12 close-up; also p07, p04, p22). An older USAF variant is sage-green suede with a black rubber sole and black laces (p07, right pilot). RAAF boots are not visible (p27 is cropped).
* Recommendation for the IAF F-35I pilot: black leather. Confidence 0.75 for the colour, 0.5 for the exact model, height and sole.
* Wear: polish highlights on the toe; creases across the flex line; tan desert dust on the welt and sole edge.

_photos p06, p20, p18, p12, p07, p04, p22; priority 2; confidence 0.65_

### Chest - slanted zipper chest pockets, left-chest name-tag field, right-chest squadron patch

**Shape.** Two pockets sit inside the chest, opened by slanted zippers whose upper end is outboard near the armpit and lower end inboard near the centre zipper; only the zipper line and its stitched placket show. Above the left one is a rectangular loop-velcro name-tag field. On the right chest, at the same height, is a round squadron patch.

**Dimensions.** Slanted zippers: about 0.17 m long, 33-35 deg from vertical, running from 0.14 m off centre at z=1.33 m down to 0.05 m off centre at z=1.19 m, mirrored on both sides; placket about 0.012 m wide. Name-tag field: 0.102 x 0.051 m, centred 0.095 m left of centre at z=1.375 m (top about 1.40 m, just below the collar point). Right-chest round patch: diameter about 0.08 m, centred 0.10 m right of centre at z=1.37 m. Patches about 0.002 m thick.

**Material.** Zipper placket in the suit fabric. Zipper teeth dark (blackened brass or black), with a small metal pull. Velcro loop: OD #5A6440 or tan #7D6E53 = RGB(0.490, 0.431, 0.325); roughness 1.0, sheen 0.6, fuzzy noise bump, raised 0.0015 m. Navy tag #1C2541 with white #E6E6E6 embroidery. Squadron patch: multicolour embroidery, roughness 0.6, sheen 0.3.

**Details.**

* IAF: the name-tag field is usually blank loop velcro, as IAF aircrew identities are protected. It is OD on IAF pilot 1 in p06 and on the cadets in p19, and tan on IAF pilot 2 in p06.
* IAF alternative name tag (p05, senior officer): navy rectangle with a white overlocked border, white embroidered text lines, a small white emblem at the top centre and 'I.A.F.' lettering.
* IAF right chest: round patch. In p06 both pilots wear one with a cream field, a red-and-black emblem and a black edge. In p19 the cadets wear a white round patch with a red/black bird (flight academy). In p05 it is a navy oval with white embroidery.
* USAF: coloured name tag with pilot wings and name on the left chest (red in p07; blue with F-35 silhouette in p25) and a command (MAJCOM) shield on the right (USAFE in p07, AETC in p25).
* No separate metal or embroidered IAF pilot-wings badge appears on any flight suit in these photos. If wanted, it would be embroidered on the navy name tag (low confidence).
* In full gear the vest covers most of this area (p27, p28), so it is secondary for the cockpit renders.

_photos p06, p19, p05, p07, p25, p27; priority 3; confidence 0.7_

### Left sleeve pen pocket and zippered utility pocket, with pens

**Shape.** A patch pocket on the outer front of the left upper arm, with a zippered opening plus 2-3 narrow pen slots along its front edge; the CWU-27/P spec calls this a covered pen pocket plus zippered pocket. Pens stand up out of the slots, and small call-sign tabs sit below the pocket.

**Dimensions.** Pocket about 0.13 m wide x 0.16 m tall. Its top is 0.10-0.12 m below the shoulder seam (z=1.33 m with the arm hanging), just under the flag patch. Zipper about 0.11 m. Pen slots about 0.018 m wide x 0.12 m deep. Pens 0.010-0.012 m in diameter, sticking out 0.02-0.04 m, with clips.

**Material.** Suit fabric. Zipper with dark teeth and a small brass/gunmetal pull. Pens: white, blue or black plastic (roughness 0.3) with metal clips (metallic, roughness 0.25).

**Details.**

* p06 (IAF pilot 2): 2-3 pens with silver clips at the top of the left-sleeve pocket. p06 (pilot 1): vertical zipper or stitched channels on the pocket.
* p01 (IAF F-35I pilot): a large rectangular patch pocket on the left upper arm, opening at the top, with a bright-green cord running into it.
* p24: white 4-colour pen and blue pen in the slots, with a 'SPIKE' tab below. p25: two silver pens and a small blue F-35 tab below. p07: black pens and a 'Wild Weasel' tab below.
* p19 (cadets): an older bellows variant with a flap about 0.05 m deep and a small snap.

_photos p06, p01, p24, p25, p07, p19; priority 3; confidence 0.7_

### Waist adjustment tabs and back construction (elastic waist, bi-swing pleats, reinforced shoulders)

**Shape.** A waist seam runs all round. At the front, two short fabric tabs (one each side of the zipper) pull the side fullness forward and close with hook-and-loop, creating vertical gathers. The back has an elastic-gathered waistband, a bi-swing back with vertical pleats behind the armholes, and a centre-back seat seam. The tops of the shoulders are reinforced with a second layer.

**Dimensions.** Waist seam at z=1.09 m. Tabs about 0.11 x 0.035 m, spanning 0.06-0.17 m each side of centre; loop patches about 0.08 x 0.03 m. Back elastic band about 0.05 m tall between the side seams. Bi-swing pleats run from z=1.38 m down about 0.25 m. The lower edge of the shoulder reinforcement is 0.05-0.06 m below the shoulder line, front and back.

**Material.** Suit fabric. Velcro OD #5A6440. The elastic produces small pleats 0.005-0.01 m deep.

**Details.**

* IAF: tabs with OD velcro clearly visible in p19 (both cadets) and p06 (both pilots); p05 shows a long horizontal waist strap.
* USAF: OD velcro tabs on both sides (p07). p04 back view: gathered waistband, vertical back seams and the seat seam.
* p25 collar crop: a puckered seam across the front of the shoulder marks the edge of the reinforcement layer.
* Hidden under the G-suit in full gear; visible in the casual (no G-suit) variant.

_photos p19, p06, p05, p07, p04, p25; priority 3; confidence 0.6_

### Thigh pockets (right: zipper across the top; left: vertical zipper)

**Shape.** Two large patch pockets on the front-outer upper thighs, both double-stitched. The right pocket closes with a horizontal zipper along its top edge; the left pocket closes with a vertical zipper along its inner (front) edge.

**Dimensions.** Right pocket: about 0.16 m wide x 0.21 m tall; top (zipper) at z=0.71 m, bottom at z=0.49 m; zipper about 0.15 m with the pull at one end. Left pocket: about 0.16 x 0.23 m, spanning z=0.49-0.73 m; vertical zipper about 0.17 m from z=0.73 down to 0.56 m, pull at the bottom. Both pockets sit slightly outboard of the front line of the thigh and wrap round its curve.

**Material.** Suit fabric, double layer. Zipper teeth dark (black nylon or blackened metal); pulls brass #8C7340 or nickel #A0A0A0, metallic.

**Details.**

* IAF (p06): right thigh zipper runs across the top, with the pull at the outer end on pilot 1 and the inner end on pilot 2; left thigh zipper runs vertically with the pull at the bottom.
* IAF cadets (p19): same layout; the right-thigh zipper has a brass pull, and one cadet has a vertical OD velcro strip about 0.03 x 0.12 m sewn on the pocket face.
* USAF (p07): identical layout.
* Hidden under the G-suit in full gear.

_photos p06, p19, p07; priority 3; confidence 0.75_

### Lower legs - shin pockets, ankle zippers and hem over the boots

**Shape.** A zippered shin pocket on the outer front of each lower leg. Zippered leg openings (ankle zippers) run up from the hem on the front-outer side, and the hems pool over the boots in 2-3 ripples.

**Dimensions.** Shin pocket about 0.13 m wide x 0.16 m tall; top at z=0.42 m, with the zipper pull at the top-outer corner (z=0.40 m); bottom at z=0.26 m. Ankle zipper about 0.20 m long, from the hem (z=0.09 m at the front) up to z=0.30 m, in a double-stitched placket 0.03 m wide; pull at the bottom. Usually worn partly open, leaving a V-gap of 0.04-0.06 m over the boot. Hem circumference 0.48 m with the zipper closed.

**Material.** Suit fabric. Gusset slightly darker and greener, #46483E = RGB(0.275, 0.282, 0.243). Zippers with dark teeth and metal pulls.

**Details.**

* IAF (p06): a short horizontal zipper on the outer leg just below the knee, and ankle-zipper plackets on both legs with pulls at the hem.
* USAF (p07): zipper pull on the outer leg at about 0.41 m (scaled); ankle zippers open at the bottom over the boots.
* p12: hem turned up, with a zig-zag stitched band about 0.03 m above the edge. Inside the open ankle zipper a greener, darker gusset shows (#46483E).
* p20: ankle zippers open, showing the boot shafts.

_photos p06, p07, p12, p20; priority 3; confidence 0.65_

### Knife pocket (inner left thigh)

**Shape.** A narrow pocket on the inner front of the left thigh, along the inseam. A top flap closes with a snap; a metal grommet or ring near the bottom anchors the knife lanyard. The knife itself is not visible.

**Dimensions.** About 0.05 m wide x 0.13 m tall. Top at z=0.70 m (about 0.10 m below the crotch); bottom at z=0.57 m. Snap about 0.012 m in diameter at the top centre; flap about 0.04 m deep. Grommet about 0.008 m in diameter, about 0.015 m above the bottom.

**Material.** Suit fabric. Snap and grommet brass #8C7340, metallic 1.0, roughness 0.35.

**Details.**

* p19 (right cadet): rounded-top flap with a brass snap, and a brass grommet below it.
* p06 (IAF pilots): a small pocket with a metal ring/clip on the inner left thigh.
* p07 (USAF): brass grommet in the same place.
* Public CWU-27/P spec: knife pocket on the left leg inseam.

_photos p19, p06, p07; priority 4; confidence 0.7_

### Wristwatch (left wrist)

**Shape.** A round steel wristwatch worn on top of the left wrist, just beyond the sleeve cuff: a dive watch with a rotating bezel or a chronograph, on a link bracelet. Some pilots wear a black resin digital watch instead.

**Dimensions.** Case diameter 0.042 m, thickness 0.013 m, lug-to-lug 0.050 m. Bezel ring 0.003 m wide. Bracelet 0.020 m wide, tapering to 0.017 m, with links about 0.007 m long. Worn about 0.02 m above the wrist crease, right at the cuff edge.

**Material.** Stainless steel #C9CBCD, metallic 1.0; roughness 0.2 polished, 0.35 on brushed links. Dial black #0F0F10 or silver-white #DADADA; black bezel insert; clear glass crystal (or a glossy coat).

**Details.**

* p27 (RAAF F-35 pilot in full gear): steel dive watch with black dial and bezel on a steel bracelet, on the left wrist just beyond the cuff.
* p06 (IAF pilot 1): large steel watch with a light dial on a steel bracelet. p05 (IAF officer): steel watch.
* p24: steel bracelet chronograph. p17: steel bracelet watch partly under the cuff. p22: large steel watch with a black dial.
* Black resin or strap watches: p07 (USAF pilot, G-Shock style), p03, p25.
* No photo shows whether the watch goes over or under the glove gauntlet in flight.

_photos p27, p06, p05, p24, p17, p22, p07, p03; priority 4; confidence 0.55_

### Kneeboard (thigh-strapped tablet board, optional)

**Shape.** A wide black elastic strap round the thigh (with white 'PIVOT' lettering in p22) holding a black rigid tablet/clipboard board on the top or outer thigh, with silver swivel hardware.

**Dimensions.** Strap about 0.05 m wide, round a thigh of 0.58-0.62 m circumference, 0.10-0.15 m above the knee. Board about 0.25 x 0.17 m and 0.015-0.02 m thick, sized for a small tablet (about 0.20 x 0.135 m).

**Material.** Board: black plastic/aluminium #121212, roughness 0.45. Strap: black nylon webbing/elastic #151515, roughness 0.85, white print #F0F0F0. Hardware: steel, metallic.

**Details.**

* p22 (Luke AFB F-35 pilot climbing the ladder): black 'PIVOT' strap and an edge-on black board along the thigh, with silver hardware near its lower end.
* Not seen on any IAF pilot. Optional: in cockpit renders it would sit on the top of a thigh above the knee.

_photos p22; priority 4; confidence 0.35_

### Open questions

* Absolute colours are estimates from photos: white references were flag and T-shirt whites, with a linear-light correction, accurate to roughly +/-15% in value and +/-5 deg in hue. The relative finding is solid: IAF suits are darker and more yellow-olive than USAF/RAAF sage when they stand in the same light in p06.
* p01 is the only photo of an actual F-35I pilot, and it shows only the shoulder (navy slide), the sleeve pocket and the cuff tab. Using the 2019 Blue Flag IAF suit (p06) as the F-35I suit is an inference.
* Gloves: no photo shows an IAF pilot gloved. The sage Nomex / grey leather recommendation rests on US practice (p26) and public issue catalogues; the IAF could use OD/black or other gloves.
* Boots: three photos of Israeli aircrew (p06, p18, p20) show black leather lace-ups, but the exact model, shaft height and sole pattern for F-35I aircrew are unknown.
* The 'Israeli pilots' in p20 wear US-style vests and white helmets, probably borrowed USMC gear, so their sage suits may not be IAF issue; only their black boots are taken as IAF evidence.
* Squadron and unit patch artwork for the F-35I squadrons (140, 116, 117) is not visible in any photo. IAF photos usually show the name field blank, and identities are protected, so patch art must be generic or left out.
* How the rank slide fastens (button or velcro) and the exact strap length are not visible. The IDF insignia reading (single leaf = Major) comes from p01 at low resolution.
* Dimensions come from stature proportions in p06 and p07, the standard 4 x 2 inch name-tag field and public size charts, scaled to a 1.78 m wearer: about +/-10-15%.
* Sleeve pocket style varies: zippered with pen slots (p06, CWU-27/P) versus a flapped bellows pocket (p19 cadets) versus a top-opening patch pocket (p01).
* In full flight gear the G-suit covers waist to ankle and the vest covers the chest (p27). Thigh, shin and knife pockets and the waist tabs matter only for a no-G-suit or casual variant.
* The watch and kneeboard are personal items and are not shown on IAF F-35I pilots. The kneeboard appears only in p22 (USAF).
* Public-source references: https://www.mypilotstore.com/MyPilotStore/sep/9244 (CWU-27/P features and sizes), https://valleyapparel.net/product/cwu-27p-flight-suit (CWU-27/P features), https://lifesupportintl.com/products/glo-1000-ds (GS/FRP-2 colourways: Sage/Gray leather, OD/Black leather).

## 3. The F-35 flight equipment ensemble over the coverall

Scope: everything an IAF F-35I 'Adir' pilot wears over the flight coverall, sized for a 1.78 m / 80 kg pilot.

BOTTOM LINE: F-35 pilots wear the Survitec F-35 pilot flight equipment ensemble and sit in the Martin-Baker US16E seat. This applies to USAF and RAAF pilots, and to the IAF going by the one IAF photo, p01. The US16E's MG5 integrated harness belongs to the seat, so the pilot wears:
- NO torso harness
- NO Koch fittings
- NO leg garters
- NO survival vest and NO raft pack (component J).

WHAT THE PILOT DOES WEAR:
1. A short, waist-length, sleeved flight jacket. It carries a stowed LPU collar with two chest lobes, arm-restraint (ARS) webbing and modular pockets (components A, B, C, G).
2. A full-coverage anti-G garment (FCAGS), stepped into like trousers over the coverall (D).
3. A grey corrugated mask hose to a quick-disconnect at mid-sternum. From there a teal BGHA (breathing gas hose) runs diagonally to the next item (E).
4. One black PEC (Personal Equipment Connector) block on the front/outer upper left thigh. It mates with the seat's left side (F).
5. Thin comms and HMD cables (I).

In the cockpit, the seat's straps (H) lie over the LPU lobes and lock into one quick-release box (QRB) at the lap. The arm lanyards (AREL) clip into the same QRB.

LAYERING, INSIDE TO OUT (Z = height above the floor, standing; left/right = the pilot's own):
1. Coverall (another agent's area).
2. FCAGS. Front top edge Z≈1.03-1.04 m.
3. Jacket. Hem Z≈1.08 m. Standing, a ≈0.05 m band of coverall shows between the jacket hem and the FCAGS top (p27).
4. Hoses and cables on top. Mask hose, then the disconnect at Z≈1.31 m, then the BGHA over the jacket front and the FCAGS abdomen, ending at the PEC (centre Z≈0.75-0.80 m).
5. Cockpit only. Shoulder straps over the lobes, lap straps, the QRB, the AREL lanyards, and the PEC plugged into the seat. When the pilot is unstrapped with the canopy open, the shoulder straps can sit on the headrest, as they are held there for entry (ejectionsite).

LANDMARKS (m): vertex 1.78, chin 1.545, suprasternal notch 1.45, acromion 1.455, navel 1.07, crotch 0.84, knee 0.50.

SCALES (mm per pixel): p27 0.5 from the watch bezel and helmet (the most reliable); p25 0.29-0.38; p17 0.4; p29 0.43; p16 1.0; p22 1.5; p01 2.1-2.4. Expect ±10-20 %. Re-measuring on p27 reduced the hose diameters: mask hose ≈0.025 m, BGHA ≈0.018 m.

WHERE IAF PRACTICE MAY DIFFER (recommendation, confidence):
- Same Survitec ensemble and US16E seat (0.8).
- Sleeved jacket (0.6). p01 shows a forearm hook-and-loop field, the lime arm-restraint cord and an upper-sleeve pocket.
- Jacket and LPU colour reads khaki-grey ≈#5A5650 in p01, against USAF/RAAF sage #66705C. Part of this may be lighting (0.35).
- A navy shoulder tab with a white leaf rank device where the RAAF wears a flag patch (0.6).
- Mask-hose keeper is an olive strap with a brass snap, not a grey tab (0.5).
- Seat straps look dark grey #4C4D49 rather than black (0.4).
- The IAF FCAGS is not visible. Use the full-coverage type (0.55) in grey #6A6C6E, as on USAF examples from 2021 on (0.4).
- No body-worn harness (0.85).

CROPS: 84 files in /home/claude/pilot_ws/crops/harness_gsuit_vest/. The key ones are p22_pec, p27_grid, p27_waist, p27_junction, p25_kid_chest, p01_torso_hgv, p28_chest, p17_torso, p12_leg, p16_torso and p09_back. Measuring tools are in /home/claude/hgv_tools/ (crop, grid, sample, samp_crop, profile .py).

SOURCES:
- [Survitec F-35 pilot ensemble PDF](https://survitecgroup.com/media/348144/survitec-f35-pilot-ensemble.pdf)
- [Survitec F-35 brochure](https://survitecgroup.com/pdf/displaypdf/survitec-f35-brochure.pdf)
- [Luke AFB: New G-suit comes to Luke](https://www.luke.af.mil/News/Article-Display/Article/358586/new-g-suit-comes-to-luke/)
- [Luke AFB photo caption](https://www.luke.af.mil/News/Photos/igphoto/2000091029/)
- [ATAGS patent US5537686A](https://patents.google.com/patent/US5537686A/en)
- [Survitec patent US8925112](https://patents.google.com/patent/US8925112)
- [ejectionsite: Mk US16E](https://ejectionsite.com/mbmkus16e.html)
- [Martin-Baker US16E](https://martin-baker.com/ejection-seats/us16e/)
- [Martin-Baker US16E data sheet](https://martin-baker.com/wp-content/uploads/2023/06/US16E-2026-Data-Sheet.pdf)
- [f-16.net: Defense News 2012 quote](https://www.f-16.net/forum/viewtopic.php?p=233003)
- [f-16.net: Air Force Times 2009 quote](https://www.f-16.net/forum/viewtopic.php?p=224666)
- [f-16.net: F-35 flight gear thread](http://www.f-16.net/forum/viewtopic.php?f=22&p=284123&t=26815)
- [f-16.net: ATAGS thread](https://www.f-16.net/forum/viewtopic.php?p=96113)
- [StrategyPage 2009](https://www.strategypage.com/htmw/htairfo/20090506.aspx)
- [euro-sd: Survitec 2,000th set](https://euro-sd.com/2023/03/news/30471/survitec-delivers-2000th-set-of-aircrew-flight-equipment-for-f-35-pilots)
- [Survitec: 2,000th F-35 pilot](https://survitecgroup.com/media/news/survitec-equips-2-000th-f-35-pilot-with-aircrew-flight-equipment-ensemble)
- [Misawa photo caption (p09)](https://www.misawa.af.mil/News/Photos/igphoto/2001482858)
- [DVIDS: CMDx flight tests](https://www.dvidshub.net/news/printable/376510)
- [DVIDS image 6855145 (p04)](https://dvidshub.net/image/6855145/afe-personnel-keep-pilots-safe-and-ready)

### A. Flight jacket shell (Survitec F-35 sleeved jacket; carries the LPU, ARS and pockets)

**Shape.** A short, boxy zip-front jacket that ends at the waist, worn over the coverall, with full-length set-in sleeves. The torso is a soft cylinder with a flatter front. The hem is straight and level at about navel height. There is no fabric collar: the LPU horseshoe (component B) forms the collar. One heavy front zipper sits just right of the midline, along the inner edge of the right LPU lobe. Panels are flat with light creasing. The cloth is slightly stiffer than the coverall.

**Dimensions.** Hem Z≈1.08 m (0.36-0.37 m below the notch, p27). Width across the deltoids and upper sleeves ≈0.50-0.53 m (p27). Chest girth over the coverall ≈1.10-1.15 m (anthropometric estimate, not measured). Front zipper chain ≈0.009 m (≈0.03 m with tape), 0.02-0.04 m right of the midline, running from the neck (Z≈1.47) to the hem. Lower-front right webbing loops 0.025 m wide × ≈0.03 m tall, in a column 0.07-0.10 m right of the midline, Z≈1.09-1.24 (p27). Webbing/slotted grid on the side and back ≈0.20-0.29 m wide × 0.11-0.15 m tall, 5 or more rows at ≈0.02-0.03 m pitch, just above the waist adjuster, roughly Z 1.12-1.27 (p22, p28). Waist adjuster: 0.025 m webbing through a ≈0.045-0.05 m slide buckle at each side, just above the hem (p22). Forearm hook-and-loop field ≈0.12 × 0.045 m. Grey sleeve bands 0.025 m. Cuff tab ≈0.05 m wide. Model the shell as a 0.004-0.006 m thick solidified layer offset from the coverall.

**Material.** Matte woven technical fabric; the fibre is not visible. USAF/RAAF sage base #66705C (samples #495F55 in p17, #597170 in p28). Roughness 0.8, sheen 0.25 with a lighter sage tint, fine plain-weave bump at 1 mm scale. IAF option ≈#5A5650 (p01 samples #595451-#5C5755 under overcast light; confidence 0.35). Tonal double-needle seams. Hook-and-loop #4E5A3E (IAF sample #434B34). Grey-green webbing ≈#6B7166 (estimated). Zipper tape olive ≈#4F5A44, teeth near-black #1E1F22. Wear: soft creases at the elbows and waist, scuffing at pocket edges and cuffs.

**Details.**

* Front closure: #8-#10 moulded-plastic zipper with olive tape, dark teeth and a green pull tab. It runs from neck to hem along the inner edge of the right LPU lobe (p25, p27).
* Lower-front right panel: 2-3 rows of vertical grey-green 25 mm webbing loops, used as hose and accessory keepers. One similar loop sits on the lower-front left near the BGHA path (p27).
* Right flank: a box pouch with a snap flap at Z≈1.09-1.21 (component C; p27, p17).
* Sides and back: a PALS-style grid of 5 or more horizontal rows, with one short vertical slot near its front-upper corner. It wraps from the side toward the back (p22, p28). The pitch is finer than MIL-STD PALS (0.05 m). The full back layout was not photographed.
* Each side: a waist adjuster made of a webbing tab through a rectangular grey-green slide/ladder buckle, lying horizontally (p22).
* Sleeves (USAF/RAAF): an olive hook-and-loop field on the outer forearm, grey 25 mm tape bands and a hook-and-loop cuff tab (p17, p28). Two black ARS straps on each upper arm (component G; p25).
* Shoulder insignia: the RAAF jacket has an Australian flag patch with an 'AUSTRALIA' tab, ≈0.06-0.08 × 0.04-0.05 m, on the upper left sleeve (p27). The IAF jacket in p01 has a navy tab ≈0.05-0.06 m with a white leaf-shaped rank device in the same place. A single leaf device is the IDF rav-seren (major) rank.
* IAF p01 (Red Flag 2023) shows the same cut, plus: a flapped pocket ≈0.12-0.14 × 0.10-0.14 m on the upper left sleeve, with the lime arm-restraint cord along its top edge; a light-olive hook-and-loop field on the left flank and at the forearm/cuff; and a dark-grey band near the cuff.
* Survitec lists sleeved and sleeveless jacket/LPU/ARS versions, an automatic LPU inflation unit, and JSAM mask compatibility (ensemble PDF). Recommendation for the IAF: the sleeved version (confidence 0.6).

_photos p27, p25, p22, p28, p17, p01, p29; priority 1; confidence 0.75_

### B. LPU collar and chest lobes (integral life preserver, stowed)

**Shape.** A horseshoe-shaped padded tube. Behind the neck it stands up as a soft roll at about jaw height. It runs over each trapezius and shoulder, then continues down the chest as two flattened lobes, one on each side of the front zipper, ending in rounded tips at lower-chest level. The cross-section is a rounded rectangle or D, flat against the body and convex outward. The lobes run almost vertically and converge slightly toward the bottom. In the cockpit the seat shoulder straps lie on top of the lobes (p28, p17, p01). An optional inflated state is a bright-orange bladder (p15); its volume was not measured.

**Dimensions.** Rear roll: top at Z≈1.57-1.59 m, ≈0.08-0.09 m above the shoulder line; section ≈0.07 m tall × 0.045 m thick (p25). Lobes: ≈0.30 m from shoulder top to tip, 0.075-0.085 m wide, 0.045-0.055 m thick. Tips at Z≈1.21-1.26 m (0.19-0.25 m below the notch; p27, p25). Inner edges ≈0.065 m apart (±0.0325 m from the midline), outer edges ≈0.215 m apart (p27). Tip radius ≈0.04 m. Grey binding 0.025-0.030 m wide. Mesh panel 0.035-0.04 × 0.10-0.12 m. Snaps ≈0.012 m diameter, at 0.05 m and 0.13 m below the notch on the left lobe. Inflation toggle ≈0.025 × 0.03-0.04 m, hanging at each lobe tip.

**Material.** Cover in the jacket fabric (sage #66705C, or IAF ≈#5A5650), slightly smoother where stretched (roughness 0.7). Binding grey #7B807C, roughness 0.85, fine twill. Mesh #6E6534 (sample #676233), using an alpha diamond pattern. Snaps glossy black #161616, roughness 0.3. Toggle olive #4A4B3A, matte plastic. Cord grey ≈#7B807C. Inflated bladder bright orange ≈#E8641E (not sampled).

**Details.**

* The inner (medial) edge of each lobe is bound with grey 25-30 mm binding, which continues up over the shoulder (p25, p17, p29).
* Left lobe: two black ring snaps on the binding. The lower one closes a grey webbing tab looped around the mask hose (p25). In IAF p01 an olive/khaki strap with a brass snap does this job.
* Olive-tan open diamond mesh, with cells of ≈3 mm, covers the outer face of each lobe's lower half (p17, p25, p28, p29).
* Manual inflation toggles hang at both lobe tips. In p25 they are olive bell/teardrop shapes on a grey cord; in p27 dark ovals; in p28 a black D-shaped pull ≈0.045 m. Recommendation: olive teardrop (confidence 0.4).
* A black zipper pull sits on the right lobe cover, which zips closed over the stowed bladder (p17).
* The covers are smooth and pillowy, with a few soft lengthwise creases.
* IAF p01: a raised collar roll is visible behind the neck. The front lobes are partly hidden by the seat strap. Same overall form.
* The automatic inflation unit is built in (Survitec). There is no separate waist LPU and no horse-collar LPU like the legacy units in p09 and p20.
* Inflated: bright orange (p15); geometry not measured.

_photos p25, p27, p17, p28, p29, p15, p01; priority 1; confidence 0.8_

### D. Full-coverage anti-G garment (FCAGS), lower body

**Shape.** A trouser-like garment from the lower abdomen to the ankles. It is stepped into like trousers (Luke AFB) and worn over the coverall. It is one large bladder covering over 90 % of the lower body (Luke AFB). Its parts:
- a front abdominal panel with a soft rolled top edge
- two full-wrap leg tubes
- a shell panel that fully covers the buttocks (p22)
- an open crotch
- covered knees with fuller fabric so they can bend (no cut-outs)
Each leg has a full-length inseam zipper (p27). Fit strings run the length of each leg (Luke AFB) but are hidden. The outline is slightly puffy and smooth, with soft horizontal wrinkles at the hip crease and knee. The ankle cuff gathers over the boot top.

**Dimensions.** Front top edge Z≈1.03-1.04 m (≈0.41 m below the notch), ≈0.05 m below the jacket hem (p27). Crotch Z≈0.84-0.845 m. Inseam zippers run from crotch to ankle (≈0.65 m). Cuff Z≈0.18-0.20 m, with a hem band ≈0.03 m (p12). Girths over the coverall (estimates, ±15 %): waist 0.95, upper thigh 0.65, mid-thigh 0.60, knee 0.46, calf 0.45, cuff 0.31-0.33 m. Shell plus deflated bladder ≈0.010-0.015 m thick. Shin strip ≈0.05 m wide (p12). Black dome fitting ≈0.025 m diameter at Z≈0.98-0.99, 0.02-0.04 m left of the midline (p27).

**Material.** Smooth, tightly woven shell with a slight sheen (roughness 0.6, sheen 0.3, soft specular along folds). Grey variant #6A6C6E (p12 samples #636365-#6C6E71; p22 #475059 in shade), recommended for a 2020s IAF model (confidence 0.4). Sage variant ≈#66705C. Zipper teeth metal #8C8F92 on black #1C1D1F and grey #6A6C6E tapes. Dome glossy black #161616. Shin strip sage ≈#66705C with a coarse-weave bump. Tonal stitching.

**Details.**

* Inseam zippers, one per leg, with metal teeth. One has a black tape and one a grey tape. Both start at the crotch (p27).
* A zipper pull tab hangs at the left hip/waist (p22).
* The buttocks are fully covered by a smooth shell panel (p22). The crotch is open.
* Abdominal panel: a glossy black dome fitting at the front-left (p27), probably a bladder or hose port.
* The inflation hose is on the left (Luke AFB: moved from the right side to the left). A short grey-green hose runs from the left hip into the PEC block on the thigh (p22). f-16.net quotes describe an integrated wire-coiled fill hose.
* Fit strings run the length of the legs (Luke AFB) but appear in no photo. Hide them under a cover strip; the outer-side seam is the suggested place (confidence 0.3).
* Ankle cuff on the grey 2026 example (p12): a zigzag-stitched hem band, a side seam, and a sage coarse-weave (Cordura-like) strip down the front of the shin.
* The PEC block (component F) sits on the front/outer upper left thigh.
* Colour by era: sage on RAAF pilots in p28 and p27 (2015-2018); neutral grey on USAF pilots in p22 (2021) and p12 (2026).
* Optional accessory, not part of the garment: a PIVOT kneeboard on a black elastic strap ≈0.05 m wide with white 'PIVOT' lettering, just above the left knee (p22).
* Survitec rates the full-coverage version above 24 psig burst. A skeletal version exists but was not seen on any F-35 pilot photo.
* Air Force Times 2009 (quoted on f-16.net) reports a line-cutter pocket. Its position was not seen.

_photos p27, p22, p12, p28; priority 1; confidence 0.6_

### H. Seat-borne MG5 integrated harness (cockpit only; part of the seat, not worn)

**Shape.** Part of the US16E seat. Two shoulder straps come from the seat back and lie over the LPU lobes. Two lap straps come from the sides of the seat bucket. All four lock into one quick-release box (QRB) fixed to the seat at the lap; the QRB also acts as the negative-G restraint (ejectionsite). The flat webbing follows the torso, with adjusters on the upper chest.

**Dimensions.** Webbing 0.040-0.045 m wide, ≈0.002 m thick (p16). Steel end lugs ≈0.045 × 0.035 × 0.004 m (p16). QRB on the midline, ≈0.10-0.15 m above the seat cushion. Shoulder straps cross the clavicle ≈0.06-0.10 m from the midline, on top of the lobes.

**Material.** Webbing black #1C1D1F-#1E1F22, or dark grey #4C4D49 (IAF p01). Roughness 0.85 with visible twill. White bar-tack thread #E8E8E8. Stainless lugs #A9ACB0 (metallic, roughness 0.3). Black plastic adjuster with a silver screw.

**Details.**

* Black or dark-grey webbing with white zigzag bar-tacks near the steel lug ends (p16).
* A black strap over the right shoulder (p28, p17), with a black adjuster that has a silver screw (p17).
* IAF p01: a dark-grey strap over the left shoulder (sample #4C4D49).
* The QRB shape is not seen in any photo. Placeholder: a rounded box ≈0.10 × 0.08 × 0.03 m with a single central release (confidence 0.2).
* The AREL arm lanyards also clip into the QRB (ejectionsite).
* Leg restraint is passive: lanyards from the cockpit floor around the leg tunnels and calves. The pilot wears no garters (ejectionsite; Martin-Baker 'passive system').
* MWARS releases the harness on landing in water (Martin-Baker).
* Canopy closed (flight): pilot strapped in, PEC mated. Canopy open: strapped or unstrapped. For entry the shoulder straps are held on the headrest (ejectionsite photo caption).

_photos p16, p17, p28, p01; priority 2; confidence 0.65_

### E. Breathing-gas hoses: mask hose, chest disconnect and BGHA

**Shape.** A grey corrugated mask hose drops from the mask, curves to the pilot's right and back to the midline, and ends at a cylindrical quick-disconnect at mid-sternum. A black mic cord is wound in a helix around it. Below the disconnect, a teal corrugated BGHA (breathing gas hose assembly) runs diagonally down and to the pilot's left. It crosses the jacket front and the FCAGS abdominal panel, passes through webbing keepers, and enters the PEC on the upper left thigh through a black elbow.

**Dimensions.** Mask hose OD ≈0.025 m (range 0.022-0.030), visible length ≈0.45 m, corrugation pitch ≈0.006-0.008 m. Mic cord ≈0.005 m diameter, coil pitch ≈0.01 m (p25, p27). Disconnect body ≈0.03 m diameter × 0.05 m long, at Z≈1.31-1.32 m, slightly right of the midline (p27). BGHA OD ≈0.018 m (range 0.015-0.022; re-measured on p27 at 0.5 mm/px), length ≈0.6-0.7 m to the PEC. Teal-green ID band ≈0.01-0.02 m wide near the PEC end (p22).

**Material.** Mask hose grey rubber #8A929A, roughness 0.55. Mic cord black #1C1D1F. Disconnect grey plastic #8A929A with a chrome clip (metallic, roughness 0.2). BGHA teal #3E7F76 in daylight (p22 shade sample #132D30), roughness 0.5; model the corrugation as geometry or a normal map. ID band bright teal-green ≈#027464 (p22). Yellow ≈#E0C21A with black (p29; not sampled).

**Details.**

* Mask hose: grey corrugated rubber with a black mic cord wound around it, which gives it a banded look (p25, p27). IAF p01 shows the same grey-and-black banded hose.
* Hose keeper: a grey webbing tab from the lower snap on the left lobe loops around the mask hose (p25). In IAF p01 it is an olive strap with a brass snap.
* Disconnect: a grey moulded body with a chrome spring clip/bayonet, with the teal corrugated BGHA continuing below it (p27_junction crop).
* A yellow/black ID band on the hose near the disconnect (p29); a yellow clip (p17).
* BGHA route: down and to the pilot's left across the lower jacket front, through the webbing loops, then across the FCAGS abdomen to the PEC elbow (p27, p22, p25, p28, p16).
* Survitec describes the BGHA as 'flexible and adjustable'.
* Seated, the route is the same: the hose drops from the chest to the left hip and PEC (p16, p28).

_photos p25, p27, p22, p29, p17, p28, p16, p01; priority 2; confidence 0.7_

### F. PEC block (Personal Equipment Connector, pilot-worn half) on the left thigh

**Shape.** A flat, black, rectangular block with rounded ends, attached flat against the front/outer surface of the upper left thigh. Standing, its long axis is tilted ≈30-40° from horizontal, with the connector end toward the rear and down. The BGHA enters through a black elbow at the upper rear corner. Round connectors stand proud of the top face and the rear end.

**Dimensions.** ≈0.19 × 0.10-0.11 × 0.03-0.035 m (p22). Seen edge-on in p27 as ≈0.16 × 0.025 m. Centre Z≈0.75-0.80 m standing, 0.04-0.09 m below crotch level. Elbow ≈0.02-0.025 m diameter. Inline cable module ≈0.045-0.06 × 0.02-0.025 m. Circular connectors ≈0.02 m diameter, standing ≈0.01-0.015 m proud.

**Material.** Black moulded housing #141416 (p22 shade sample #1D2834), roughness 0.45, light edge wear toward dark grey. Chrome connector ring metallic, roughness 0.2. Blue ring #2A5BD7. Black cable #1C1D1F.

**Details.**

* Black housing with edges radiused ≈0.01 m and a slight top bevel (p22).
* Rear end: a chrome knurled circular connector and a blue-ringed one. Top face: one dark round knob or connector (p22).
* A black cable leaves the rear end and loops up, with an inline black module (p22).
* A short grey-green hose from the FCAGS enters the block's upper front end, probably the anti-G feed (p22).
* Seat half: ejectionsite says the PEC 'is on the side of the bucket', on the left. Martin-Baker lists the seat services as oxygen, mic/tel, anti-g, thermal cooling and the helmet interface. With the canopy closed, the block is mated to the seat. The mating geometry was not seen.
* The attachment method (garment pocket or strap) was not seen.

_photos p22, p27; priority 2; confidence 0.55_

### C. Survival pockets and pouches on the jacket

**Shape.** Flat flapped pockets and shallow box pouches sewn or attached to the jacket front and flanks. Each is a rectangle with rounded corners and a flap closed by hook-and-loop or a snap. There are also hook-and-loop ID fields and small cord loops. No survival hardware is visible on the outside.

**Dimensions.** Left-chest flapped pocket ≈0.11-0.13 × 0.07-0.08 m (flap ≈0.04 m), ≈0.02-0.03 m deep, centred ≈0.14 m left of the midline at Z≈1.25 m (p25). Below it, a hook-and-loop field ≈0.12-0.14 × 0.06 m (p25). Comms slot ≈0.05 m wide at the top of the upper-left chest pocket (p25). Right-flank box pouch ≈0.15-0.17 × 0.13-0.15 × 0.05 m at Z≈1.09-1.21 m, on the front/side of the right ribs (p17, p27). Sage pouch at the lower-left front (p28); size not measured.

**Material.** Same fabric and colour as the jacket. Hook-and-loop #4E5A3E (IAF light olive ≈#434B34). Grey cord #7B807C. Black snaps #161616.

**Details.**

* Left chest, top to bottom: a flapped pocket, an olive hook-and-loop field, then a grey cord loop ≈0.04 m (p25).
* Upper-left chest: a welted slot through which the comms pigtail comes out (p25; see component I).
* Right flank: a box pouch with a hook-and-loop face, a black-snap flap and a short olive strap (p27, p17).
* Lower-left front: a sage pouch (p28).
* Left flank: a light-olive hook-and-loop field (IAF p01).
* The Survitec brochure gives the jacket more than 15 modular survival pockets. No photo shows an identifiable radio antenna, knife handle, signal mirror, flare or strobe, so model them all as closed pouches.
* The survival kit and liferaft are in the US16E seat, with automatic deployment and raft inflation (Martin-Baker). There is no raft pack or survival vest on the body.
* Air Force Times 2009 (via f-16.net) reports a line-cutter pocket on the anti-G garment. Its position was not seen.

_photos p25, p27, p17, p28, p01; priority 2; confidence 0.6_

### G. Arm restraint system (ARS) on the jacket, with AREL lanyards

**Shape.** Narrow black webbing straps around each upper arm, built into the jacket sleeves. A thin braided lanyard runs from the inner upper arm or armpit down the side toward the waist and ends in a small toggle. Seated, the lanyards run to the lap and clip into the seat QRB. On ejection they pull the arms in (ejectionsite).

**Dimensions.** Upper-arm straps 0.020-0.025 m wide, two per arm (p25). Lanyard ≈0.004-0.005 m diameter (p17). Toggle ≈0.010 × 0.025 m. Small metal ring ≈0.02 m on the left chest (p29; size estimated).

**Material.** Black webbing #1C1D1F. Lime cord ≈#7AD94E (p01 sample #86CFA1, overexposed). Grey-black braid ≈#3A3B3D. Toggle #4A4B3A. Ring stainless #A9ACB0.

**Details.**

* Two black ARS straps on each upper arm (p25).
* A lime/fluorescent braided cord runs from the inner upper arm, changes to grey-black braid, and ends in a black toggle (p17).
* A metal ring on the left chest (p29).
* Seated, the cord runs down to the lap (p16).
* IAF p01: the lime cord runs along the top edge of the upper-left sleeve pocket.
* Survitec: the jacket carries the arm restraint system ('restrains arm on ejection'), and the coverall carries the AREL.
* ejectionsite: the lanyards connect to the QRB along with the other harness straps. On ejection they are routed between the thighs and pull the arms toward the centre of the body.

_photos p17, p25, p29, p16, p01; priority 3; confidence 0.5_

### I. Comms and HMD cables on the jacket

**Shape.** Thin round cables lying over the jacket:
- The HMDS cable runs from the rear left of the helmet over the left shoulder.
- A short comms pigtail comes out of a slot on the upper left chest.
- A black cable with a yellow band runs down the right side to a plug at the right hip.
- The mic cord coils around the mask hose (component E).

**Dimensions.** HMD cable ≈0.008 m (p27, p01). Comms pigtail: a circular connector ≈0.012 m diameter × 0.04 m with gold pins, plus a two-pin plug (p25); slot ≈0.05 m. Right-side black cable ≈0.006-0.008 m, ≈0.13 m right of the midline, with a yellow band ≈0.04 m long at Z≈0.97-1.02 and a plug at Z≈0.89-0.97 (p27). Grey braided-sleeve cable ≈0.012 m (p28).

**Material.** Black cable #1C1D1F, roughness 0.5. Yellow band ≈#E0C21A. Gold pins #C9A94B, metallic. Grey braided sleeve #8A8D90 with a braid normal map.

**Details.**

* Upper-left chest: a pigtail with a circular gold-pin connector and a two-pin plug, coming out of a welted slot (p25).
* Right side: a black cable with a yellow band emerges from under the jacket hem and runs to a black plug at the right hip (p27). Its purpose is unknown.
* The HMDS cable leaves the back-left of the helmet and loops over the left shoulder (p27, p01).
* A grey braided-sleeve cable at the chest (p28).

_photos p25, p27, p28, p01; priority 3; confidence 0.5_

### J. NOT WORN on the F-35I: torso harness, Koch fittings, leg garters, survival vest

**Shape.** Do not model these on the F-35I pilot. Per ejectionsite, US aircraft usually use a body-worn torso harness, but the US16E follows the international practice of building the harness into the seat. No photo of a standing F-35 pilot shows torso straps, Koch fittings, chest buckles or leg garters (p27, p25, p22, p12).

**Dimensions.** Not applicable. For reference only: the legacy harness in p09 uses ≈0.044 m grey webbing.

**Material.** Not applicable.

**Details.**

* p09 (F-16, Misawa, ACES II-era gear): grey 44 mm straps crossing in an X on the back, a 6-grommet lacing tab with olive cord, a brass-zip name tab and a horse-collar LPU. Not F-35 gear.
* p04 (AFE shop): body harnesses, collar LPUs, coyote MOLLE vests and CSU-13B/P cut-out G-suits. Not F-35 gear; the unit is unconfirmed.
* p20 (IAF non-F-35 aircrew): an olive MOLLE survival vest, a grey-green collar LPU, and leg straps with black quick-fit buckles. Do not reuse these for the F-35I.
* There is no survival vest. Survival items go in the jacket pockets (component C); the raft and survival kit are in the seat.
* There is no harness-mounted block for oxygen, comms or anti-G. All services go through the single PEC on the thigh (component F). The only chest connection is the mask-hose disconnect (component E).

_photos p09, p04, p20, p27, p25, p22, p12; priority 4; confidence 0.85_

### Open questions

* Only one photo shows an IAF F-35I pilot (p01). It is small and overcast, and shows the pilot seated, from the left. The IAF jacket's true colour, sleeved vs sleeveless, the right side, the front lobes and the whole lower body (FCAGS, PEC) cannot be seen.
* All hex values are approximate. p27 is a night shot with a cyan/orange cast, p16 has a warm cast, p22 is HDR with blue shadows, and p01 is small and cool.
* Scales carry ±10-20 % error. The p25 scale came from a teenager's face, so sizes taken from p25 may be about 10-15 % too large. Re-measuring on p27 (0.5 mm/px) gave a BGHA OD of ≈0.016-0.02 m and a mask hose of ≈0.02-0.03 m, smaller than the earlier p25-based values.
* The FCAGS top edge was measured only at the front (p27). It may sit higher at the sides and back.
* The location of the fit strings (lacing) is not visible in any photo. The inseam zippers were seen only in p27.
* The grey item in p12 could be a different overgarment rather than the FCAGS.
* The PEC identification is inferred from its position, the hose entry and the connectors. The p22 block could instead be a cooling or comms hub, and how it attaches to the leg was not seen.
* The teal hose is called the BGHA because of its route from the mask disconnect. It could also carry cooling or anti-G services.
* Identifying the lime cord and the chest ring as ARS/AREL parts is an inference.
* Neither the QRB shape nor the seat half of the PEC is visible in any photo. The QRB in component H is a placeholder.
* The LPU toggle style differs between photos: an olive teardrop in p25, a dark oval in p27 and a black D-handle in p28. It may depend on unit or modification state.
* The inflated LPU's geometry and exact orange were not measured (p15).
* The dark-grey seat strap in p01 may just be black webbing under flat light.
* Only the side/back grid in p22 shows the jacket back; the full back layout is unknown.
* The leaf device on the p01 tab is about 25 px wide in the original image. Reading it as IDF major relies on public IDF insignia, not a clear view.
* No radio, knife, mirror, flares or strobe can be identified in any photo, so which pocket holds which item is unknown.
* p09, p04 and p20 show non-F-35 gear and are useful only to say what NOT to model. p02 shows an HGU-55-type helmet from a two-seat jet, not the Gen III HMDS; the helmet agent should be told. The p04 unit is still unconfirmed.

## Photos

From Wikimedia Commons: U.S. Air Force and Defense Department photos in the public domain, and a few under Creative Commons licences (credited below).

| id | photo | by | licence |
|---|---|---|---|
| p00 | [220812-F-NY200-1177 - 33rd FW Flightline Operations, Northern Lightning 2022.jpg](https://commons.wikimedia.org/wiki/File:220812-F-NY200-1177_-_33rd_FW_Flightline_Operations,_Northern_Lightning_2022.jpg) | Airman 1st Class Leandra Garcia | Public domain |
| p01 | [230315-F-UT528-1036 - Israeli Air Force at Red Flag-Nellis 23-2, 15 Mar, 2023.jpg](https://commons.wikimedia.org/wiki/File:230315-F-UT528-1036_-_Israeli_Air_Force_at_Red_Flag-Nellis_23-2,_15_Mar,_2023.jpg) | William Lewis | Public domain |
| p02 | [230316-F-LY743-1425 - Bet on Red.jpg](https://commons.wikimedia.org/wiki/File:230316-F-LY743-1425_-_Bet_on_Red.jpg) | Senior Airman Zachary Rufus | Public domain |
| p03 | [48 FW MX operations at Cold Response (9567383).jpg](https://commons.wikimedia.org/wiki/File:48_FW_MX_operations_at_Cold_Response_(9567383).jpg) | U.S. Air Force photo by Staff Sgt. (name on the Commons page) | Public domain |
| p04 | [AFE personnel keep pilots safe and ready (6855145).jpg](https://commons.wikimedia.org/wiki/File:AFE_personnel_keep_pilots_safe_and_ready_(6855145).jpg) | U.S. Air Force photo by Tech. Sgt. (name on the Commons page) | Public domain |
| p05 | [Blue Flag 2013. Ovda air base. November 25, 2013 (11067038915).jpg](https://commons.wikimedia.org/wiki/File:Blue_Flag_2013._Ovda_air_base._November_25,_2013_(11067038915).jpg) | U.S. Embassy Tel Aviv | CC BY-SA 2.0 |
| p06 | [Blue Flag November 2019 (191111-F-YU906-0016).jpg](https://commons.wikimedia.org/wiki/File:Blue_Flag_November_2019_(191111-F-YU906-0016).jpg) | Airman 1st Class Kyle Cope / U.S. Air Force | Public domain |
| p07 | [Blue Flag November 2019 (191111-F-YU906-0040).jpg](https://commons.wikimedia.org/wiki/File:Blue_Flag_November_2019_(191111-F-YU906-0040).jpg) | Airman 1st Class Kyle Cope / U.S. Air Force | Public domain |
| p08 | [Combined Strike 25 Pre-Flight (9271574).jpg](https://commons.wikimedia.org/wiki/File:Combined_Strike_25_Pre-Flight_(9271574).jpg) | U.S. Air Force photo by Senior Airman (name on the Commons page) | Public domain |
| p09 | [Equipment fit for a fighter pilot 160308-F-FK724-057.jpg](https://commons.wikimedia.org/wiki/File:Equipment_fit_for_a_fighter_pilot_160308-F-FK724-057.jpg) | Senior Airman Deana Heitzman | Public domain |
| p10 | [Equipped for flight, prepared to fight (9766878).jpg](https://commons.wikimedia.org/wiki/File:Equipped_for_flight,_prepared_to_fight_(9766878).jpg) | U.S. Air Force photo by Airman 1st Class (name on the Commons page) | Public domain |
| p11 | [Equipped for flight, prepared to fight (9766879).jpg](https://commons.wikimedia.org/wiki/File:Equipped_for_flight,_prepared_to_fight_(9766879).jpg) | U.S. Air Force photo by Airman 1st Class (name on the Commons page) | Public domain |
| p12 | [F-35 Lightning II Prepares to take off in support of Operation Epic Fury (9593659).jpg](https://commons.wikimedia.org/wiki/File:F-35_Lightning_II_Prepares_to_take_off_in_support_of_Operation_Epic_Fury_(9593659).jpg) | [null Courtesy] | Public domain |
| p13 | [F-35 pilot helmet.jpg](https://commons.wikimedia.org/wiki/File:F-35_pilot_helmet.jpg) | US Air Force / Ministerie van Defensie | CC BY-SA 4.0 |
| p14 | [F-35 water survival instructor keeps training afloat 141030-F-SI788-037.jpg](https://commons.wikimedia.org/wiki/File:F-35_water_survival_instructor_keeps_training_afloat_141030-F-SI788-037.jpg) | Staff Sgt. Marleah Robertson | Public domain |
| p15 | [F-35 water survival instructor keeps training afloat 141031-F-SI788-084.jpg](https://commons.wikimedia.org/wiki/File:F-35_water_survival_instructor_keeps_training_afloat_141031-F-SI788-084.jpg) | Staff Sgt. Marleah Robertson | Public domain |
| p16 | [First F-35-trained pilot hops out after bringing first DOD F-35 home to Eglin AFB.jpg](https://commons.wikimedia.org/wiki/File:First_F-35-trained_pilot_hops_out_after_bringing_first_DOD_F-35_home_to_Eglin_AFB.jpg) | U.S. Air Force photo by Samuel King Jr. | Public domain |
| p17 | [First female F-35 pilot begins training (6).jpg](https://commons.wikimedia.org/wiki/File:First_female_F-35_pilot_begins_training_(6).jpg) | Staff Sgt. Marleah Robertson | Public domain |
| p18 | [Flickr - Israel Defense Forces - 163rd IAF Flight Course Graduates.jpg](https://commons.wikimedia.org/wiki/File:Flickr_-_Israel_Defense_Forces_-_163rd_IAF_Flight_Course_Graduates.jpg) | Israel Defense Forces | CC BY-SA 2.0 |
| p19 | [Flickr - Israel Defense Forces - Air Force Pilots.jpg](https://commons.wikimedia.org/wiki/File:Flickr_-_Israel_Defense_Forces_-_Air_Force_Pilots.jpg) | https://www.flickr.com/people/ | CC BY-SA 3.0 |
| p20 | [Israeli pilots with MV-22B.jpg](https://commons.wikimedia.org/wiki/File:Israeli_pilots_with_MV-22B.jpg) | 2nd Marine Aircraft Wing &amp; Marine Corps Air Station Cherry Point | Public domain |
| p21 | [Lining Up on the Line- RAFL26 Officially Kicks Off (9734593).jpg](https://commons.wikimedia.org/wiki/File:Lining_Up_on_the_Line-_RAFL26_Officially_Kicks_Off_(9734593).jpg) | U.S. Air Force photo by Tech. Sgt. (name on the Commons page) | Public domain |
| p22 | [Luke AFB pilots complete first cMDx test 01.jpg](https://commons.wikimedia.org/wiki/File:Luke_AFB_pilots_complete_first_cMDx_test_01.jpg) | Staff Sgt. Alexander Cook | Public domain |
| p23 | [Luke AFB pilots complete first cMDx test 05.jpg](https://commons.wikimedia.org/wiki/File:Luke_AFB_pilots_complete_first_cMDx_test_05.jpg) | Staff Sgt. Alexander Cook | Public domain |
| p24 | [Luke Generation lll helmet 151016-F-PJ020-059.jpg](https://commons.wikimedia.org/wiki/File:Luke_Generation_lll_helmet_151016-F-PJ020-059.jpg) | Airman 1st Class Ridge Shan | Public domain |
| p25 | [Luke Pilot for a Day 160407-F-EC705-023.jpg](https://commons.wikimedia.org/wiki/File:Luke_Pilot_for_a_Day_160407-F-EC705-023.jpg) | Senior Airman Devante Williams | Public domain |
| p26 | [Maj Andrew "Dojo" Olsen Hang Ten - Aviation Nation 2019.jpg](https://commons.wikimedia.org/wiki/File:Maj_Andrew_%22Dojo%22_Olsen_Hang_Ten_-_Aviation_Nation_2019.jpg) | Noah Wulf | CC BY-SA 4.0 |
| p27 | [RAAF F-35 pilot wearing a helmet in August 2018.jpg](https://commons.wikimedia.org/wiki/File:RAAF_F-35_pilot_wearing_a_helmet_in_August_2018.jpg) | U.S. Air Force photo by Staff Sgt. Jensen Stidham | Public domain |
| p28 | [Squadron Leader Andrew Jackson becomes first RAAF pilot to fly the F-35 (4).JPG](https://commons.wikimedia.org/wiki/File:Squadron_Leader_Andrew_Jackson_becomes_first_RAAF_pilot_to_fly_the_F-35_(4).JPG) | US Air Force | Public domain |
| p29 | [USAF Lt Col Christine Mau the first and only female F-35 fighter pilot in the world looks back from her Lightning II cockpit (170227-F-HX320-005).jpg](https://commons.wikimedia.org/wiki/File:USAF_Lt_Col_Christine_Mau_the_first_and_only_female_F-35_fighter_pilot_in_the_world_looks_back_from_her_Lightning_II_cockpit_(170227-F-HX320-005).jpg) | U.S. Air Force photo by Staff Sgt. Peter Thompson | Public domain |
