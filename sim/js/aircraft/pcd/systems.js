// Systems model behind the panoramic cockpit display: what the flight model does not simulate
// but the FUEL, ENG and ICAWS pages show, derived from its state so every number moves with it.
//
//   const sys = new Systems();
//   sys.update(dt, st, levers, oatC);     // st: FlightModel.state, levers: Input.levers
//   sys.fuel.tanks, sys.eng.tet, sys.icaws ...
//
// Fuel: the flight model carries one total (st.engine.fuelKg). It is split over the F-35A's internal
// tanks with a fixed transfer order (wings first, then the fuselage tanks, the feed tank last), the
// way the fuel system keeps the centre of gravity and the engine feed: a display model, the centre of
// gravity in the flight model does not depend on it. Engine: N2 and the afterburner come from the
// flight model; turbine exhaust temperature (TET), nozzle area and oil pressure follow N2, the
// afterburner and the ambient temperature with first-order lags, inside the published F135
// envelope (TET about 500 C at idle and 800-850 C at MIL, the nozzle open at ground idle, nearly
// closed at MIL and fully open in maximum afterburner).

const LB = 0.453592;
const KT = 0.514444;
const FT = 0.3048;
const DEG = Math.PI / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lag = (x, target, dt, tau) => x + (target - x) * (1 - Math.exp(-dt / Math.max(1e-3, tau)));

/**
 * F-35A internal tanks (lb, 18,250 in all; F-35A public figure 18,250 lb / 8,278 kg), with the order
 * they empty in: lower number first; equal numbers empty together. x, y: the tank's place on the
 * FUEL page planform (fraction of its width / height, the nose up), w, h: its size.
 */
export const TANKS = [
  { id: 'LW', label: 'L WING', max: 3400, order: 1, x: 0.10, y: 0.56, w: 0.26, h: 0.17 },
  { id: 'RW', label: 'R WING', max: 3400, order: 1, x: 0.64, y: 0.56, w: 0.26, h: 0.17 },
  { id: 'F1', label: 'F1', max: 1650, order: 3, x: 0.42, y: 0.24, w: 0.16, h: 0.10 },
  { id: 'F2', label: 'F2', max: 2300, order: 2, x: 0.40, y: 0.36, w: 0.20, h: 0.11 },
  { id: 'F3', label: 'F3', max: 2600, order: 2, x: 0.40, y: 0.49, w: 0.20, h: 0.11 },
  { id: 'F4', label: 'F4', max: 2050, order: 4, x: 0.40, y: 0.62, w: 0.20, h: 0.10 },
  { id: 'F5', label: 'F5', max: 1650, order: 3, x: 0.41, y: 0.74, w: 0.18, h: 0.09 },
  { id: 'FD', label: 'FEED', max: 1200, order: 5, x: 0.44, y: 0.85, w: 0.12, h: 0.07 },
];
export const FUEL_MAX_LB = TANKS.reduce((a, t) => a + t.max, 0);
export const BINGO_LB = 1800;          // the flight model's BINGO FUEL warning: 800 kg
export const JOKER_LB = 3500;
const EMPTY_LB = 29300;                // F-35A empty weight (13,290 kg)

/** Split a total (lb) over the tanks: the last to empty fill first. */
function splitFuel(totalLb, out) {
  let rest = clamp(totalLb, 0, FUEL_MAX_LB);
  const orders = [...new Set(TANKS.map((t) => t.order))].sort((a, b) => b - a);   // feed tank first
  for (const o of orders) {
    const group = TANKS.filter((t) => t.order === o);
    const cap = group.reduce((a, t) => a + t.max, 0);
    const put = Math.min(rest, cap);
    for (const t of group) out[t.id] = put * t.max / cap;
    rest -= put;
  }
  return out;
}

/** ICAWS message: {text, level: 'W' (warning, red) | 'C' (caution, yellow) | 'A' (advisory, green)}. */
const W = (text) => ({ text, level: 'W' });
const C = (text) => ({ text, level: 'C' });
const A = (text) => ({ text, level: 'A' });

export class Systems {
  constructor() {
    this.fuel = { totalLb: 0, tanks: {}, flowPph: 0, bingo: BINGO_LB, joker: JOKER_LB, grossLb: 0, endurance: 0 };
    this.eng = { n2: 0, tet: 20, noz: 70, oil: 0, ffPph: 0, thr: 0, ab: 0, running: true, stage: 'OFF' };
    this.icaws = [];
    this.master = null;           // 'W' | 'C' | null
    this.gearPos = 1;             // 0 up .. 1 down and locked
    this.flaps = 0;
    this.flight = { cas: 0, alt: 0, mach: 0, hdg: 0, hdgTrue: 0, vs: 0, g: 1, aoa: 0, pitch: 0, roll: 0, agl: 0, gs: 0 };
    this._init = false;
  }

  /** A new start: the lagged values (temperatures, nozzle) take the next state at once. */
  reset() { this._init = false; }

  /**
   * @param {number} dt s
   * @param {object} st FlightModel.state
   * @param {object} lev Input.levers (throttle, gearHandle, parkingBrake, speedbrake, canopy, nwsEnable)
   * @param {number} oatC outside air temperature, C (TET follows the inlet temperature)
   */
  update(dt, st, lev = {}, oatC = 15) {
    if (!st) return this;
    const e = st.engine || {};
    // ---- flight data: the numbers the helmet shows (HMD._data), from the same flight model state
    //      (headings from the flight model; PCD.variation turns them to the helmet's)
    const F = this.flight;
    F.hdg = F.hdgTrue = ((((st.heading || 0) / DEG) % 360) + 360) % 360;
    F.cas = st.ias_kt ?? (st.ias || 0) / KT;
    F.alt = st.alt_ft ?? (st.altitude || 0) / FT;
    F.mach = st.mach || 0;
    F.vs = st.vs_fpm ?? (st.vs || 0) / FT * 60;
    F.g = st.gLoad ?? 1;
    F.aoa = (st.alpha || 0) / DEG;
    F.pitch = (st.pitch || 0) / DEG;
    F.roll = (st.roll || 0) / DEG;
    F.agl = (st.agl || 0) / FT;
    F.gs = (st.groundSpeed ?? (st.velocity ? Math.hypot(st.velocity.x, st.velocity.z) : 0)) / KT;
    this.gearPos = st.gear ?? 1;
    this.flaps = st.controls ? st.controls.flaps || 0 : 0;

    // ---- fuel
    const fu = this.fuel;
    fu.totalLb = Math.max(0, (e.fuelKg || 0) / LB);
    splitFuel(fu.totalLb, fu.tanks);
    fu.flowPph = Math.max(0, (e.fuelFlow || 0) * 3600 / LB);
    fu.grossLb = EMPTY_LB + fu.totalLb + 1900;      // + pilot, gun ammunition, oil and the rest
    fu.endurance = fu.flowPph > 1 ? fu.totalLb / fu.flowPph * 60 : 0;   // minutes

    // ---- engine
    const en = this.eng;
    const running = e.running !== false;
    const n2 = Number.isFinite(e.rpm) ? e.rpm : 0;
    const ab = clamp(e.ab || 0, 0, 1);
    const thr = Number.isFinite(lev.throttle) ? lev.throttle : (e.throttle || 0);
    // N2 from idle (~66 %) to MIL (100 %): x 0..1
    const x = clamp((n2 - 66) / 34, 0, 1.05);
    const tetT = running ? oatC + 460 + 380 * Math.pow(x, 1.5) + 25 * ab : oatC + 30;
    const ground = !!st.onGround;
    // nozzle: open at ground idle (less idle thrust), half open at flight idle, nearly closed at
    // MIL, opening with the afterburner zones
    const nozDry = (ground ? 78 : 46) + ((ground ? 14 : 16) - (ground ? 78 : 46)) * Math.min(1, x);
    const nozT = ab > 0.005 ? 28 + 72 * ab : nozDry;
    const oilT = running ? 24 + 34 * Math.min(1, n2 / 100) : Math.max(0, n2 / 100 * 20);
    if (!this._init) { en.tet = tetT; en.noz = nozT; en.oil = oilT; this._init = true; }
    en.tet = lag(en.tet, tetT, dt, tetT > en.tet ? 1.6 : 3.0);
    en.noz = lag(en.noz, nozT, dt, 0.6);
    en.oil = lag(en.oil, oilT, dt, 0.8);
    en.n2 = n2;
    en.ab = ab;
    en.thr = thr;
    en.ffPph = fu.flowPph;
    en.running = running;
    en.stage = !running ? 'OFF' : ab > 0.005 ? 'AB' : thr >= 0.74 ? 'MIL' : thr < 0.02 ? 'IDLE' : '';

    // ---- ICAWS: warnings (red), cautions (yellow), advisories (green)
    const list = this.icaws;
    list.length = 0;
    const wn = Array.isArray(st.warnings) ? st.warnings : [];
    const has = (w) => wn.includes(w);
    if (st.crashed) list.push(W('CRASH'));
    if (has('PULL UP')) list.push(W('PULL UP'));
    if (has('ENGINE') || !running) list.push(W('ENGINE FAIL'));
    if (has('GEAR')) list.push(W('L/G NOT DOWN'));
    if (has('OVER-G')) list.push(W('OVER G'));
    if (has('AOA')) list.push(W('AOA HIGH'));
    if (has('OVERSPEED')) list.push(C('OVERSPEED'));
    const canopy = st.controls ? st.controls.canopy || 0 : 0;
    if (canopy > 0.01 || lev.canopy) list.push(canopy > 0.01 && (thr > 0.5 || (F.gs || 0) > 5) ? W('CANOPY') : C('CANOPY UNLKD'));
    if (has('BINGO FUEL')) list.push(C('FUEL BINGO'));
    else if (fu.totalLb < JOKER_LB) list.push(A('FUEL JOKER'));
    if (has('PARKING BRAKE')) list.push(C('PARK BRK ON'));
    else if (lev.parkingBrake) list.push(A('PARK BRK ON'));
    const gear = st.gear ?? 1;
    if (gear > 0.01 && gear < 0.99) list.push(A('L/G TRANSIT'));
    if ((st.controls?.speedbrake || 0) > 0.05) list.push(A('SPD BRK OUT'));
    if (ground && lev.nwsEnable !== false && F.gs < 60) list.push(A('NWS ENGAGED'));
    if ((st.controls?.tailhook || 0) > 0.05) list.push(A('HOOK DOWN'));
    this.master = list.some((m) => m.level === 'W') ? 'W' : list.some((m) => m.level === 'C') ? 'C' : null;
    return this;
  }
}
