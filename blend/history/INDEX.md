# Model history

One blend per milestone, oldest first (`index.csv` has the same table).
Counts leave out the hidden hitbox helpers.
From 12 on the sky image is linked relative to `blend/`, so a copy opened from here shows a
pink sky until it is pointed at `references/hdri/` (File > External Data > Find Missing Files).
Copying the file next to `blend/F-35I_Adir.blend` also works.

| # | File | Date | Commit | What changed | MB | Objects | Vertices | Faces | Materials |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | `00_2026-10-31_1445_77893ec_airframe.blend` | 2026-10-31 14:45 | 77893ec | Procedural F-35I airframe: fuselage with DSI inlets, wings, tails, nozzle, canopy, cockpit (WIP) (rebuilt from that commit's scripts; no blend was committed) | 1.4 | 119 | 48918 | 47893 | 18 |
| 1 | `01_2026-10-31_1516_86b0337_gear-bays-rig.blend` | 2026-10-31 15:16 | 86b0337 | Landing gear with solved retraction kinematics, weapon bays with JDAM/AMRAAM, animation rig (rebuilt from that commit's scripts; no blend was committed) | 1.7 | 337 | 72026 | 71293 | 35 |
| 2 | `02_2026-10-31_1628_b5af2bb_destructible.blend` | 2026-10-31 16:28 | b5af2bb | Destructible F-35I: hitboxes, damage simulator, breakable parts, switch actions | 3.3 | 464 | 132988 | 129690 | 54 |
| 3 | `03_2026-10-31_1742_958740b_nose-chines-inlets.blend` | 2026-10-31 17:42 | 958740b | Reshape nose, chines, spine and DSI inlets to match the reference photos | 3.3 | 464 | 133152 | 129736 | 54 |
| 4 | `04_2026-10-31_1830_06dbeef_panel-lines.blend` | 2026-10-31 18:30 | 06dbeef | Panel lines, photo-matched review tools, turntable v2 | 5.1 | 464 | 133152 | 129736 | 54 |
| 5 | `05_2026-10-31_1915_19af105_main-gear-rework.blend` | 2026-10-31 19:15 | 19af105 | Main gear rework: wing-root facets, three doors per well, clearance checks | 5.1 | 470 | 134078 | 129833 | 54 |
| 6 | `06_2026-10-31_1922_c0390a7_main-gear-legs.blend` | 2026-10-31 19:22 | c0390a7 | Main gear legs: thick white oleo body and a wide main fitting | 5.1 | 472 | 134114 | 129913 | 54 |
| 7 | `07_2026-10-31_1928_08d7840_gun-in-shoulder.blend` | 2026-10-31 19:28 | 08d7840 | Gun: bury the GAU-22 inside the left shoulder after the shoulder was lowered | 5.1 | 472 | 134114 | 129913 | 54 |
| 8 | `08_2026-10-31_1951_943f989_canopy-tint-shading.blend` | 2026-10-31 19:51 | 943f989 | Canopy gold tint, clean fuselage shading, smooth body behind the canopy | 5.1 | 472 | 133932 | 129753 | 54 |
| 9 | `09_2026-10-31_2028_b0923b8_aft-end-nozzle.blend` | 2026-10-31 20:28 | b0923b8 | Aft end: free-standing F135 nozzle behind a sawtooth shroud | 5.4 | 472 | 142142 | 137897 | 54 |
| 10 | `10_2026-10-31_2115_0d8356b_dsi-inlets.blend` | 2026-10-31 21:15 | 0d8356b | Inlets: DSI compression bump and drawn aperture with swept cowl lips | 5.7 | 472 | 144212 | 139929 | 54 |
| 11 | `11_2026-10-31_2151_231dc42_nose-doors-eots.blend` | 2026-10-31 21:51 | 231dc42 | Nose: long nose-gear doors, faceted EOTS housing, DAS windows, air-data probes | 5.8 | 478 | 145489 | 141185 | 54 |
| 12 | `12_2026-10-31_2222_ef50029_paint-sky.blend` | 2026-10-31 22:22 | ef50029 | Paint and sky: HDRI lighting with a matched sun, satin coat paint tuned to photos | 5.8 | 478 | 145489 | 141185 | 54 |
| 13 | `13_2026-10-31_2256_5ee45a6_afterburner.blend` | 2026-10-31 22:56 | 5ee45a6 | Afterburner: volumetric flame with shock diamonds and flicker (Volumetric afterburner flame with shock diamonds; darker apron) | 5.8 | 477 | 144343 | 140017 | 53 |
| 14 | `14_2026-10-31_2323_c5a582d_cockpit-forward.blend` | 2026-10-31 23:23 | c5a582d | Cockpit: pilot, seat and display moved 0.55 m forward; canopy bow and frame band (Cockpit moved 0.55 m forward, canopy bow and frame band) | 5.8 | 483 | 145263 | 140947 | 54 |
| 15 | `15_2026-11-01_0009_668b330_pilot-rebuilt.blend` | 2026-11-01 00:09 | 668b330 | Pilot rebuilt: one smooth skinned body, real flight gear, HMDS helmet; destruction clip effects (Pilot rebuilt: smooth skinned body, IAF flight gear, HMDS helmet, mask, vest, gloves) | 8.1 | 494 | 205818 | 201631 | 61 |
| 16 | `16_2026-11-01_0058_5441f41_stencils.blend` | 2026-11-01 00:58 | 5441f41 | Canopy frame band: stand off along the true surface normal and close over the front tip (Photo-based stencils (RESCUE, DANGER EJECTION SEAT / JET INTAKE, canopy warning); canopy band follows the glass normal and closes the front tip) | 8.1 | 497 | 206868 | 202541 | 64 |
| 17 | `17_2026-11-01_0111_23cd547_aft-deck.blend` | 2026-11-01 01:11 | 23cd547 | Aft deck: wider upper shroud-blend ramp removes the ridge ahead of the nozzle (Aft deck between the booms smoothed: no ridge ahead of the nozzle shroud) | 8.1 | 497 | 206836 | 202515 | 64 |
| 18 | `18_2026-11-01_0359_c19dbee_canopy-v2.blend` | 2026-11-01 03:59 | c19dbee | Canopy rebuilt from the photos and the 3-view: flat frame band with a V, taller glass (Canopy rebuilt: flush frame band with a V under the bow, taller and wider glass, lower sill, windscreen base, rear frame, spine fairing; pilot and seat lower) | 8.1 | 501 | 209308 | 204717 | 64 |
