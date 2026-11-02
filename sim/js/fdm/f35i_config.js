// F-35I "Adir" flight-model configuration: mass and inertia, geometry, aerodynamic tables,
// F135 engine, landing gear, fly-by-wire gains.  SI units; angles in radians unless a name says _deg.
//
// Public F-35A figures (DESIGN.md): empty 13,290 kg, internal fuel 8,278 kg, span 10.7 m,
// length 15.7 m, wing area 42.7 m^2, F135 ~125 kN MIL / ~191 kN max A/B at sea level, +9/-3 g,
// 25 deg AoA in normal mode (50 deg available), Mach 1.6 at altitude, ~700 KCAS low level,
// roll rate up to ~200 deg/s, takeoff 150-165 KIAS, approach ~140 KIAS at 13 deg AoA.
// The tables were designed to meet those numbers and checked by sim/tests/fdm.test.mjs; see
// sim/js/fdm/README.md for the reasoning behind each value and the tuning knobs.
//
// Body frame (DESIGN.md): +X right wing, +Y up, -Z forward, origin = the model reference point
// (station 7.835 m aft of the radome tip, Blender y = 0, z = 0).  Blender (x left, y aft, z up)
// -> body: (-x, z, y).

const D = Math.PI / 180;
const STATION_REF = 7.835;                         // body origin, m aft of the radome tip
/** Blender-style station coordinates (x left, s station, z up) -> body frame [x, y, z]. */
export function bodyFromStation(xLeft, s, zUp) {
  return [-xLeft, zUp, s - STATION_REF];
}

// Gear geometry from scripts/f35/gear.py + geom.py: the airframe is built level and sits on its gear
// 1.45 deg nose-up; the ground under station s lies at z = -1.76 - 0.13 - (10.27 - s) tan(1.45 deg).
const STANCE_PITCH = 1.45 * D;
const groundZ = (s) => -1.76 - 0.13 - (10.27 - s) * Math.tan(STANCE_PITCH);
export const DEFAULT_GEAR_CONTACTS = [
  { name: 'nose', pos: bodyFromStation(0, 4.25, groundZ(4.25)), radius: 0.2985 },     // 23.5x7.5R10
  { name: 'left_main', pos: bodyFromStation(2.17, 10.27, groundZ(10.27)), radius: 0.432 },   // 34x11.0R17
  { name: 'right_main', pos: bodyFromStation(-2.17, 10.27, groundZ(10.27)), radius: 0.432 },
];

// Points of the airframe that must never touch the ground (crash detection), from the fuselage,
// wing and tail definitions in scripts/f35 (station, half width, height).
const AIRFRAME_POINTS = [
  ['nose tip', 0, 0.0, 0.08], ['chin', 0, 1.2, -0.40], ['forward belly', 0, 4.1, -0.64],
  ['belly', 0, 6.8, -0.78], ['belly', 0, 10.3, -0.785], ['ventral bulge', 0, 11.4, -0.83],
  ['belly edge', 1.19, 8.8, -0.775], ['belly edge', -1.19, 8.8, -0.775],
  ['inlet', 1.2, 4.4, -0.5], ['inlet', -1.2, 4.4, -0.5],
  ['aft keel', 0, 12.9, -0.62], ['nozzle', 0, 15.6, -0.45],
  ['wingtip', 5.37, 10.0, 0.26], ['wingtip', 5.37, 11.6, 0.26],
  ['wingtip', -5.37, 10.0, 0.26], ['wingtip', -5.37, 11.6, 0.26],
  ['stabilator tip', 3.43, 14.8, 0.43], ['stabilator tip', -3.43, 14.8, 0.43],
  ['fin tip', 2.24, 14.2, 2.60], ['fin tip', -2.24, 14.2, 2.60],
  ['canopy', 0, 5.0, 1.25], ['spine', 0, 10.8, 1.05],
].map(([name, x, s, z]) => ({ name, pos: bodyFromStation(x, s, z) }));

const MASS_EMPTY = 13290;
const MASS_PILOT_MISC = 120;                       // pilot, survival kit, oil, gun ammunition
const FUEL_CAPACITY = 8278;
const MASS_REF = MASS_EMPTY + MASS_PILOT_MISC + 0.6 * FUEL_CAPACITY;   // 18,377 kg

export const F35I_CONFIG = {
  name: 'F-35I Adir',
  substepHz: 240,                                  // fixed physics step (>= 200 Hz)
  g: 9.80665,

  mass: {
    empty: MASS_EMPTY,
    pilotMisc: MASS_PILOT_MISC,
    fuelCapacity: FUEL_CAPACITY,
    fuelDefault: 0.6,                              // fraction at spawn
    massRef: MASS_REF,
    // inertia at the reference mass (kg m^2, aero body axes x fwd / y right / z down), scaled with mass;
    // estimated from the F-16's (Stevens & Lewis) scaled by mass and size, fuel in the wings and body
    Ixx: 30000, Iyy: 165000, Izz: 185000, Ixz: 2000,
    // Centre of gravity in the body frame.  DESIGN.md puts the CG at the body origin (station 7.835),
    // but that is ~1.4 m ahead of the real one: with it the nose wheel would carry 40 % of the weight
    // and the nose would only come up at ~160 KIAS (lift-off ~175).  Station 9.25 m is ~30 % MAC
    // (MAC 4.58 m, leading edge at station 7.86), 1.02 m ahead of the main wheels (nose wheel ~17 %).
    // state.position is still the world position of the body origin, as the visual expects.
    cg: [0, 0.10, 9.25 - STATION_REF],
  },

  // ------------------------------------------------------------------------------ aerodynamics
  aero: {
    S: 42.7, b: 10.7, cbar: 4.58,
    // Low-speed clean lift curve: slope 3.6/rad (0.063/deg) for the AR 2.7 wing plus body and chines,
    // chine vortex lift holding the slope to ~20 deg, CLmax 1.57 at 35 deg, gentle post-stall.
    CL: {
      alpha: [-90, -60, -40, -30, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90],
      cl: [0, -0.60, -0.90, -0.98, -0.95, -0.83, -0.60, -0.285, 0.03, 0.345, 0.66, 0.97, 1.24, 1.42, 1.53, 1.57,
        1.54, 1.45, 1.32, 1.02, 0.68, 0.34, 0],
      linearTo: 10,                                // deg: the part of the curve the Mach factor below scales
      // lift-slope Mach factor (Helmbold / DATCOM trend for AR 2.7, 34 deg LE sweep: +30 % at M 1,
      // supersonic 4/sqrt(M^2-1) fall-off) and the factor on the high-alpha (vortex) lift
      machLinear: { x: [0, 0.4, 0.6, 0.8, 0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.4, 1.6, 1.8, 2.0],
        y: [1, 1.02, 1.06, 1.14, 1.22, 1.27, 1.30, 1.26, 1.18, 1.07, 0.96, 0.87, 0.77, 0.68] },
      machHigh: { x: [0, 0.4, 0.6, 0.8, 0.9, 0.95, 1.0, 1.1, 2.0],
        y: [1, 1.0, 0.97, 0.85, 0.72, 0.66, 0.62, 0.60, 0.60] },
    },
    // Zero-lift drag: CD0 0.021 subsonic, drag rise from M 0.85, peak 0.063 at M 1.1-1.2 (the F-35's
    // large cross-section), slowly falling supersonic.  With the F135 lapse below this gives
    // ~700 KCAS on the deck in full A/B and about Mach 1.6 at 11 km.
    CD0: { x: [0, 0.5, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.4, 1.6, 1.8, 2.0],
      y: [0.0210, 0.0210, 0.0215, 0.0225, 0.0240, 0.0285, 0.0380, 0.0500, 0.0590, 0.0630, 0.0630, 0.0590,
        0.0550, 0.0520, 0.0500] },
    // Induced drag CD = CD0 + K CL^2: K ~ 1/(pi e A) with partial leading-edge suction subsonic,
    // -> CL^2/CLalpha (no suction) supersonic; grows with CL above 0.6 (separation), which sets the
    // sustained turn (~4.6-5 g at M 0.8 / 15,000 ft, the published F-35A figure is 4.6 g).
    K: { x: [0, 0.6, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4, 1.6, 2.0],
      y: [0.170, 0.170, 0.180, 0.195, 0.220, 0.245, 0.265, 0.295, 0.320, 0.400] },
    kHighCL: 0.8, kHighCLFrom: 0.6,
    CDflat: 1.55,                                  // separated-flow drag ~ CDflat sin^2(alpha)
    CDbeta: 0.4,
    groundEffect: { dCL: 0.10 },
    flaps: { dCL: 0.30, dCD: 0.022, dCm: -0.045, fadeAlpha: [15, 32] },
    gear: { dCD: 0.020, dCm: 0.004 },
    speedbrake: { dCD: 0.035, dCm: 0.0 },
    canopy: { dCD: 0.010 },
    // Pitch: relaxed static stability (statically unstable by 3 % MAC subsonic), aerodynamic centre
    // moving aft through the transonic region (stable supersonic), nose-down break at high alpha.
    Cm0: 0.0,
    staticMargin: { x: [0, 0.8, 0.9, 1.0, 1.1, 1.2, 1.6, 2.0], y: [-0.03, -0.03, -0.01, 0.04, 0.08, 0.11, 0.14, 0.15] },
    CmHighAlpha: 0.12, CmHighAlphaFrom: [25, 60],
    Cmq: -5.0,
    // all-moving stabilators: full nose-up command = +0.30 in Cm (rotates the jet at ~125 kt and up)
    Cm_de: 0.30,
    Cm_deMach: { x: [0, 0.9, 1.0, 1.2, 1.6, 2.0], y: [1, 1, 0.85, 0.70, 0.62, 0.55] },
    Cm_deAlpha: { x: [0, 20, 40, 60, 90], y: [1, 1, 0.75, 0.6, 0.5] },
    // lateral-directional (per rad of beta; per unit normalised surface command; rates nondimensional)
    CYbeta: -0.90, CYdr: -0.06,
    Clbeta: { x: [0, 10, 20, 30, 40, 60, 90], y: [-0.08, -0.10, -0.12, -0.12, -0.10, -0.06, -0.03] },
    Clp: { x: [0, 20, 30, 40, 60, 90], y: [-0.32, -0.28, -0.20, -0.14, -0.10, -0.08] },
    Clr0: 0.04, ClrCL: 0.25,
    Cl_da: { x: [0, 10, 20, 30, 40, 60, 90], y: [0.060, 0.058, 0.050, 0.038, 0.028, 0.018, 0.010] },
    Cl_daMach: { x: [0, 0.9, 1.2, 1.6, 2.0], y: [1, 1, 0.80, 0.62, 0.50] },
    Cl_dr: 0.008,
    Cnbeta: { x: [0, 10, 20, 25, 30, 40, 60, 90], y: [0.14, 0.13, 0.09, 0.05, 0.02, -0.02, -0.04, -0.02] },
    directionalMach: { x: [0, 1.1, 1.6, 2.0], y: [1, 1, 0.75, 0.6] },
    Cnp: -0.03,
    Cnr: { x: [0, 20, 40, 60, 90], y: [-0.40, -0.35, -0.25, -0.15, -0.10] },
    Cn_dr: { x: [0, 20, 30, 40, 60, 90], y: [0.045, 0.040, 0.030, 0.020, 0.012, 0.008] },
    Cn_da: -0.004,
  },

  // ------------------------------------------------------------------------------ engine (F135)
  engine: {
    milThrust: 125000, maxThrust: 191000, idleThrust: 6000,      // N, sea level static
    // lapse: thrust ~ sigma^n below 11 km (sigma above), times (1 + m1 M + m2 M^2), times the inlet
    milLapse: 0.75, milMach: [-0.20, 0.25],
    abLapse: 0.70, abMach: [0.08, 0.08],
    idleMachDrag: 1.6,                             // idle thrust turns into net ram drag above ~M 0.6
    inlet: { fromMach: 1.4, loss: 1.5 },           // fixed diverterless inlet: recovery falls past M 1.4 (top speed ~M 1.6)
    rpmIdle: 66, rpmMil: 100,                      // N2 percent
    thrustRpmExponent: 1.6,                        // dry thrust ~ ((N2 - idle) / (MIL - idle))^1.6
    milThrottle: 0.75, abThrottle: 0.76,           // throttle positions: MIL detent, A/B zone starts
    spoolTau: 0.35,                                // s, small-signal response
    spoolUp: [3.0, 0.36],                          // %/s at idle, extra %/s per % above idle: idle->MIL ~4.5 s
    spoolDown: [4.0, 0.30],
    abMinRpm: 97, abLightDelay: 0.25, abRateUp: 1.35, abRateDown: 2.5,   // A/B lit and full in ~1 s
    // fuel: the brief asks for ~0.8 kg/s at MIL and ~3.5 kg/s in full A/B (sea level static)
    tsfcDry: 0.8 / 125000, tsfcAb: (3.5 - 0.8) / (191000 - 125000), tsfcMach: 0.25,
    idleFuelFlow: 0.10,
    windmillRpm: 22, windmillDragArea: 0.25,        // flamed out: N2 ~22 % per Mach, ram drag 0.25 m^2 * qbar
  },

  // ------------------------------------------------------------------------------ landing gear
  gear: {
    g: 9.80665,
    contacts: DEFAULT_GEAR_CONTACTS,
    airframePoints: AIRFRAME_POINTS,
    // oleo + tyre as one strut each; staticCompression is how far the reference weight compresses it
    main: { staticCompression: 0.09, stroke: 0.32, dampingCompression: 0.35, dampingRebound: 0.70 },
    nose: { staticCompression: 0.07, stroke: 0.28, dampingCompression: 0.35, dampingRebound: 0.70 },
    bottomStiffness: 25,                           // end stop, times the strut's k
    overloadFactor: 7,                             // strut load beyond this many static loads breaks it
    retractTime: 6,                                // s, down -> up (and up -> down)
    brakeMu: 0.70,                                 // anti-skid braking uses 70 % of the surface friction
    holdBrake: 0.5,                                // pedal brake above this holds a stopped wheel
    lateralMu: 1.0, slipPeak: 0.12, slipMinSpeed: 1.5,
    casterDamping: 2000,
    rollingResistance: { runway: 0.015, ground: 0.06, water: 0.2 },
    anchorStiffness: 4e5, anchorDamping: 6e4, anchorCapture: 0.10, anchorRelease: 0.6,
    steering: { maxAngle: 60 * D, lateralAccel: 3.4, rate: 60 * D },   // NWS full lock while taxiing
    // Sink rate at a wheel's first contact.  Land-based fighter gear is designed for 10 ft/s
    // (3.05 m/s): beyond it the landing is logged and shown as HARD LANDING; the struts give way at
    // 15 ft/s (4.6 m/s), a heavy jet from ~4.2 m/s already (strut load over overloadFactor).  A 3 deg
    // path flown onto the runway without a flare is ~3.8 m/s: hard, not a crash.  Contacts within
    // bounceTime of leaving the ground belong to the same landing.
    touchdownHardSink: 3.05, touchdownCrashSink: 4.6, bounceTime: 2.0,
  },

  // ------------------------------------------------------------------------------ fly-by-wire
  fcs: {
    freeStick: 0.03,
    stickShapePitch: 0.45, stickShapeRoll: 0.45,   // cubic blend for fine control near the centre
    minQbar: 300,
    // pitch
    nMax: 9.0, nMin: -3.0,
    alphaMax: 25 * D, alphaMaxHigh: 50 * D, alphaMin: -10 * D,
    Vco: 120,                                      // C* crossover speed (m/s, ~235 kt)
    cstarUp: 13, cstarDown: 6,                     // full stick: 9 g at 450 kt and above, -3 g
    cstarUpPA: 5, cstarDownPA: 3,                  // gear down: softer for the approach and flare
    kCstar: 0.5,
    tauQ: 0.10,                                    // s, inner pitch-rate loop
    pitchJerkShare: 0.3,                           // share of the stabilator rate the pitch loop plans with
    tauN: 0.30, kNmin: 0.03, kNmax: 1.5,           // g limiter time constant
    kAlpha: 2.5,                                   // 1/s, AoA limiter
    alphaBrakeShare: 0.4,                          // share of the stabilator authority the AoA limiter plans with
    pitchRateMax: 45 * D,
    kGamma: 0.35, kiGamma: 0.04, gammaIntMax: 0.5, gammaRateMax: 4 * D, gammaHoldMax: 70 * D,
    bankCompKnee: 70 * D,                          // 1/cos(phi) turn compensation up to 70 deg bank (2.9 g)
    bankCompLead: 0.35, bankCompLeadMax: 0.6,      // s, g: lead on the bank rate while rolling in / out
    bankCompRate: [45 * D, 120 * D],               // bank rates (rad/s) over which compensation and lead fade out
    // ground / takeoff
    groundPitch: STANCE_PITCH, takeoffPitch: 12 * D,
    rotateStick: 0.6,                              // raw aft stick that already asks for the full take-off attitude
    kTheta: 2.5, rotationRate: 8 * D, derotationRate: 3 * D, kiGround: 6.0,
    groundLawSpeed: [15, 35],                      // m/s: direct stick-to-stabilator below, attitude law above
    groundRollGain: 0.5,
    takeoffModeTime: 10, takeoffModeMaxCas: 230 * 0.514444,
    // A take-off roll: at least takeoffRollTime s on the wheels and takeoffRollGain m/s faster at
    // lift-off than at the slowest point of the ground contact (a bounce or a landing roll only slows
    // down).  After a bounce the attitude it left the runway with is held for up to bounceHoldTime s.
    takeoffRollTime: 3, takeoffRollGain: 5, bounceHoldTime: 4,
    // s: a pull still held when the take-off law hands over to C* comes in over this time constant
    // (fcs.js).  Taken away for good, a held pull flew the path the jet had just after lift-off and
    // the nose sank while the pilot held it back (a scripted climb needed 150 s instead of 85); all
    // at once it was the old jolt (23 deg/s of pitch rate within a second).  3 s: under 7 deg/s in
    // the first 1.5 s, and a pull let go a second after the hand-over adds about 2 deg of pitch.
    ratchetTau: 3,
    // The nozzle's lower lip clears the runway up to ~15 deg on statically compressed mains (16 deg
    // with the struts extended, ~13.5 deg with them 0.2 m further in): 14 deg leaves the on-speed
    // 13 deg AoA approach a flare.
    tailStrikeAgl: 5, tailStrikePitch: 14 * D,
    // roll
    rollRateMax: 200 * D,
    rollQbar: [0.35, 1500, 11000],                 // fraction at low qbar, qbar (Pa) where it starts / is full
    rollAlpha: [12 * D, 30 * D, 0.55],             // full below 12 deg AoA, down to 55 % at 30 deg
    rollMach: [1.1, 1.8, 0.55],
    // High-AoA roll / yaw coordination (fcs.js).  In slow flight the velocity-vector roll is limited by
    // the yaw rate the rudders can build, not by the schedule above (which would allow ~57 deg/s at
    // 25 deg AoA and 125 kt): full rudder adds ~11 deg/s^2 of yaw acceleration there, so the roll
    // builds up to ~25-35 deg/s and 90 deg of bank takes ~2.8 s (~2.2 s at 150 kt, ~1.9 s at 180 kt).
    // Sideslip limit and its linear gain close to the limit, the share of the rudder authority the
    // roll command plans with (the rest is left to the sideslip loop), and the floor of the cap.
    rollBetaMax: 6 * D, rollBetaGain: 3.0, rollYawShare: 0.7, rollCoordMin: 8 * D,
    tauP: 0.12,
    kPhi: 1.2, bankSnap: 5 * D, bankHoldRate: 45 * D, bankHoldMaxPitch: 70 * D,
    // yaw
    tauR: 0.18, kBeta: 2.0, betaMax: 12 * D, betaMin: 1.5 * D, betaQbarRef: 5000,
  },

  // ------------------------------------------------------------------------------ auto-throttle
  // Approach power compensator (T key; on at the telnof_final spawn): with the gear down in the air
  // it flies the on-speed AoA with the engine while the FCS holds the flight path. On the back side
  // of the drag curve (the approach) a fixed throttle runs away in speed: from the trimmed 140 kt
  // the jet was at 300 kt on the runway 100 s later. Throttle per rad of AoA error (0.08 per deg),
  // its integral, damping on the acceleration along the path (per m/s^2, filtered over vdotTau s),
  // the range (idle to MIL, never the afterburner) and the slew rate (per s).  Close to the runway
  // (main-wheel height): no added power below noAddAgl (50 ft), RETARD to idle over retardTime from
  // retardAgl (30 ft; airliner auto-throttles retard at ~27 ft), so the flare bleeds the speed.
  apc: { alpha: 13 * D, kp: 4.6, ki: 1.2, kd: 0.03, vdotTau: 0.4, min: 0.03, max: 0.75, rate: 0.3,
    noAddAgl: 50 * 0.3048, retardAgl: 10 * 0.3048, retardTime: 2.0 },

  // ------------------------------------------------------------------------------ actuators
  actuators: {
    de: { rate: 3.0, tau: 0.025 },                 // 1/s of the normalised range: stabilators ~60 deg/s
    da: { rate: 4.0, tau: 0.025 },                 // flaperons / differential stabs ~80 deg/s
    dr: { rate: 3.2, tau: 0.025 },                 // rudders ~80 deg/s
    flaps: 0.5, speedbrake: 1.0, canopy: 0.25,
  },

  // ------------------------------------------------------------------------------ schedules, limits
  schedules: {
    flapsFullCas: 180 * 0.514444, flapsUpCas: 220 * 0.514444,    // landing flaps with the gear down
    maneuverFlaps: { fromAlpha: 10 * D, perRad: 1.3, max: 0.35, maxMach: 0.9 },
    autoSpeedbrakeOnRollout: true,
  },
  limits: {
    overstressG: 13.5, overstressNegG: -6.0,       // 1.5 x the design limits: structural failure
    vne: 700 * 0.514444, mmo: 1.6,                 // for warnings
  },
};

/**
 * Copy of a config with the gear contact points taken from the aircraft rig
 * (data/aircraft/f35i_rig.json `gearContacts`, or AircraftVisual.info.gearContacts).
 * Accepts entries {name, pos: [x, y, z] | {x, y, z}, radius}; anything unusable keeps the defaults.
 */
export function configWithRig(config, rig) {
  const list = rig && (rig.gearContacts || (rig.gear && rig.gear.contacts) || rig.contacts);
  const out = { ...config, gear: { ...config.gear } };
  const contacts = parseContacts(list);
  if (contacts) out.gear.contacts = contacts;
  return out;
}

export function parseContacts(list) {
  if (!Array.isArray(list) || list.length < 3) return null;
  const res = [];
  for (const e of list) {
    const p = e.pos || e.position || e.p || e.point;
    let v = null;
    if (Array.isArray(p) && p.length >= 3) v = [+p[0], +p[1], +p[2]];
    else if (p && typeof p === 'object' && 'x' in p) v = [+p.x, +p.y, +p.z];
    if (!v || v.some((x) => !Number.isFinite(x))) return null;
    res.push({ name: String(e.name || `wheel${res.length}`), pos: v, radius: +(e.radius || e.r || 0.35) });
  }
  // sanity: one contact clearly ahead of the others, all below the origin
  if (res.some((k) => k.pos[1] > -0.5)) return null;
  return res;
}

/** Fetch data/aircraft/f35i_rig.json (if present) and return the config with its gear contacts. */
export async function loadF35IConfig(baseUrl = 'data/aircraft/') {
  try {
    const r = await fetch(baseUrl + 'f35i_rig.json');
    if (r.ok) return configWithRig(F35I_CONFIG, await r.json());
  } catch (e) { /* no rig yet: defaults */ }
  return F35I_CONFIG;
}

export default F35I_CONFIG;
