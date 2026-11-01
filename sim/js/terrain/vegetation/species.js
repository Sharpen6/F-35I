// The trees and shrubs of central Israel that the vegetation layer draws, one entry per species.
// Pure data (no three.js): the worker's placement rules (placement.js), the procedural meshes
// (meshes.js), the impostor atlas (impostors.js) and the shaders all read this table.
//
// What grows where (sources in VEGETATION.md): Aleppo pine forests planted by KKL-JNF on the
// foothills and the Jerusalem hills (Ben Shemen, Hulda, Sha'ar HaGai, the Jerusalem forest), olive
// groves on the stone terraces of the hills, citrus (and some avocado) orchards in dense rows on
// the coastal plain, eucalyptus lines along roads, fields and streams, date palm plantations in the
// rift (Jericho, Kalia, Almog) and in kibbutz gardens, Italian cypress rows, garrigue (batha) and
// maquis shrubs on the rocky slopes, almost nothing in the Judean desert.
//
// Colours are sRGB (0-255) as the species looks in summer aerial photos; the instance colour
// taken from the imagery under each tree is blended over it (tint, 0..1: how much the imagery
// decides). Sizes in metres: height range [min, max], crown width / height, crown base / height.
// translucency: light through the leaves; shadow: density of the ground shadow; sway: wind;
// fluff: how ragged the crown's edge is; specular: waxy leaves; far: share of the far range
// (planted rows and shrubs give up earlier: the imagery shows them).

export const SPECIES = [
  {
    id: 0, name: 'pine', label: 'Aleppo pine (Pinus halepensis)',
    foliage: [66, 82, 44], wood: [92, 74, 58],
    height: [7, 14], crown: 0.62, crownBase: 0.38,
    tint: 0.55, translucency: 0.25, shadow: 0.78, sway: 0.5, fluff: 0.75, specular: 0.0, far: 1.0,
  },
  {
    id: 1, name: 'olive', label: 'olive (Olea europaea)',
    foliage: [104, 116, 82], wood: [96, 86, 72],
    height: [3.5, 6.5], crown: 1.15, crownBase: 0.3,
    tint: 0.35, translucency: 0.3, shadow: 0.72, sway: 0.4, fluff: 0.7, specular: 0.25, far: 0.75,
  },
  {
    id: 2, name: 'citrus', label: 'citrus / avocado orchard tree',
    foliage: [38, 64, 28], wood: [80, 66, 52],
    height: [3.0, 4.6], crown: 1.05, crownBase: 0.1,
    tint: 0.6, translucency: 0.2, shadow: 0.9, sway: 0.25, fluff: 0.45, specular: 0.6, far: 0.6,
  },
  {
    id: 3, name: 'broadleaf', label: 'broadleaf tree (ficus, plane, carob, oak, tamarisk)',
    foliage: [52, 78, 36], wood: [88, 76, 62],
    height: [5, 12], crown: 0.95, crownBase: 0.3,
    tint: 0.5, translucency: 0.35, shadow: 0.85, sway: 0.45, fluff: 0.6, specular: 0.15, far: 1.0,
  },
  {
    id: 4, name: 'datepalm', label: 'date palm (Phoenix dactylifera)',
    foliage: [100, 118, 80], wood: [118, 98, 74],
    height: [6, 15], crown: 0.55, crownBase: 0.72,
    tint: 0.25, translucency: 0.45, shadow: 0.6, sway: 0.6, fluff: 0.5, specular: 0.1, far: 0.9,
  },
  {
    id: 5, name: 'cypress', label: 'Italian cypress (Cupressus sempervirens)',
    foliage: [34, 52, 30], wood: [70, 58, 46],
    height: [8, 17], crown: 0.2, crownBase: 0.04,
    tint: 0.35, translucency: 0.1, shadow: 0.9, sway: 0.3, fluff: 0.35, specular: 0.0, far: 1.0,
  },
  {
    id: 6, name: 'eucalyptus', label: 'river red gum (Eucalyptus camaldulensis)',
    foliage: [92, 108, 74], wood: [196, 186, 166],
    height: [14, 28], crown: 0.6, crownBase: 0.42,
    tint: 0.4, translucency: 0.35, shadow: 0.65, sway: 0.7, fluff: 0.95, specular: 0.1, far: 1.0,
  },
  {
    id: 7, name: 'shrub', label: 'garrigue and maquis shrubs (thorny burnet, mastic, buckthorn)',
    foliage: [96, 98, 66], wood: [88, 76, 60],
    height: [0.5, 2.2], crown: 1.6, crownBase: 0.0,
    tint: 0.55, translucency: 0.2, shadow: 0.7, sway: 0.15, fluff: 0.6, specular: 0.0, far: 0.24,
  },
  {
    id: 8, name: 'fanpalm', label: 'Mexican fan palm (Washingtonia robusta), Tel Aviv streets',
    foliage: [86, 108, 62], wood: [128, 110, 88],
    height: [10, 22], crown: 0.22, crownBase: 0.86,
    tint: 0.2, translucency: 0.35, shadow: 0.5, sway: 0.5, fluff: 0.4, specular: 0.1, far: 1.0,
  },
];

export const SPECIES_COUNT = SPECIES.length;
export const SP = Object.fromEntries(SPECIES.map((s) => [s.name, s.id]));

/** Height quantisation of the instance records (m per step of the stored byte). */
export const HEIGHT_STEP = 0.125;   // 0 .. 31.9 m
/** Crown width factor quantisation: byte / 128 (0 .. 2). */
export const WIDTH_STEP = 1 / 128;

/** sRGB byte -> linear. */
export function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
