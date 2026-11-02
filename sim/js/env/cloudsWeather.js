// The weather presets of the cumulus and the cirrus, and how the day changes them (pure JS: the
// field's parameters for js/env/cloudField.js; js/env/Clouds.js draws them).
//
// Israel in autumn (Sagi's season): fair-weather cumulus grow over the land with the day's heating
// (few at 07:00, the most from noon to ~16:00, dissolving towards the evening) and are flatter early
// (humilis) than in the afternoon (mediocris, now and then a congestus); over the sea they are
// thinner in the morning; on some days the wind lines them up in streets. The preset gives the
// coverage at the afternoon peak over the land.

/**
 * Weather presets: cumulus coverage (fraction of the land at the afternoon peak), base and top (m MSL:
 * the condensation level, the highest top), the big cells' size (m), extinction (1/m). Fair-weather
 * cumulus over Israel: bases ~1500-2000 m, tops ~2500-3500 m.
 */
export const CLOUD_PRESETS = {
  clear: { label: 'Clear' },
  few: { label: 'Few cumulus', cu: { coverage: 0.12, base: 1800, top: 2900, scale: 4500, density: 0.05 } },
  scattered: { label: 'Scattered', cu: { coverage: 0.32, base: 1700, top: 3500, scale: 4500, density: 0.055 } },
  broken: { label: 'Broken', cu: { coverage: 0.62, base: 1500, top: 3300, scale: 4000, density: 0.06 } },
  cirrus: { label: 'High cirrus', ci: { coverage: 0.5, alt: 9500, opacity: 0.5 }, cu: { coverage: 0.04, base: 1900, top: 2700, scale: 4500, density: 0.05 } },
};
export const DEFAULT_CLOUDS = 'few';

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A day's draw (0..1) from the date: the same day always has the same weather pattern. */
export function dayRandom(doy, year, salt = 0) {
  let h = (Math.imul((doy | 0) + 374761393 * salt, 668265263) ^ Math.imul((year | 0) + 1013, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * The field's parameters (cloudField.js FIELD) for a preset's cumulus at local solar time `hour`
 * on day `doy` of `year`: coverage over the land and the sea, streets, vertical development.
 */
export function fieldParams(cu, hour, doy, year) {
  const h = ((hour % 24) + 24) % 24;
  // the day's heating: the land's cumulus grow from ~09:00, peak 12-16, thin out towards the evening
  // (at night what is left of them: a preset chosen for the night still shows its clouds)
  const day = smooth(8.5, 12.5, h) * (1 - smooth(16, 20.5, h));
  const land = cu.coverage * (0.55 + 0.45 * day);
  // over the sea: thinner in the morning, a little more by the afternoon and at night
  const sea = cu.coverage * (0.4 + 0.25 * smooth(9, 15, h));
  // flatter early in the day, taller in the afternoon
  const vert = 0.75 + 0.3 * day;
  // streets on about a third of the days, of varying strength
  const r = dayRandom(doy, year, 1);
  const streets = r < 0.35 ? 0.55 + 0.4 * (r / 0.35) : 0;
  return { scale: cu.scale, land, sea, vert, streets, depth: cu.top - cu.base };
}
