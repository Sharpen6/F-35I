# sim/js/fdm: F-35I "Adir" flight dynamics

A rigid-body 6-DOF flight model with an F-35-like fly-by-wire system. It is plain ES modules: the
only import is `three` (Vector3, Quaternion), from the vendored copy through the page's import map.

```js
import { FlightModel } from './fdm/FlightModel.js';
import { F35I_CONFIG, loadF35IConfig, configWithRig } from './fdm/f35i_config.js';

const config = await loadF35IConfig('data/aircraft/');   // or configWithRig(F35I_CONFIG, visual.info)
const fdm = new FlightModel(config, terrain);             // terrain: {heightAt, normalAt, surfaceAt}
const { throttle, gearDown, apc } = fdm.reset(terrain.spawns.telnof_36);  // match the input levers to these
// every frame:
fdm.step(dt, input);                                      // input as in DESIGN.md (+ optional extras)
visual.setPose(fdm.state.position, fdm.state.quaternion);
visual.setControls(fdm.state.controls);
```

Tests: run `node --import ./sim/tests/node-three.mjs sim/tests/fdm.test.mjs` from the repo root. The
`--only takeoff,landing` option runs a subset. The suite has 106 checks and takes a few seconds. Each check
prints its value, its band and the reason for the band. The exit code is 1 if any check fails.

| file | contents |
|---|---|
| `FlightModel.js` | state, fixed sub-stepping, forces and moments, integration, spawn and trim, the approach auto-throttle, crash detection, published `state` |
| `f35i_config.js` | every number: mass and inertia, aero tables, engine, gear, FCS gains, limits; rig helpers |
| `aero.js` | coefficient model: lift, drag and side force; moments with the control-free part and the control effectiveness kept separate (for the FCS inversion) |
| `engine.js` | F135: N2 spool, afterburner light-off and fill, thrust lapse with density and Mach, fuel flow, flame-out |
| `gear.js` | three oleo struts, tyre friction (rolling, anti-skid braking, cornering), nose-wheel steering, parking brake |
| `fcs.js` | fly-by-wire: C* pitch law with g, AoA and pitch-rate limiters, roll-rate law, sideslip law, holds, ground and takeoff modes |
| `atmosphere.js` | ISA 1976 to 47 km (geopotential height), pitot CAS (subsonic and Rayleigh supersonic) and its inverse |
| `tables.js` | interpolation and small math helpers |

## Frames and conventions

* World: X east, Y up, Z south (north = -Z). Heading 0 = north, positive clockwise (DESIGN.md).
* Body: +X right wing, +Y up, -Z forward. The origin is the model reference point, station 7.835 m
  aft of the radome tip, at Blender y = 0 and z = 0. A Blender point (x left, y aft, z up) maps to the
  body frame as (-x, z, y), and `bodyFromStation(xLeft, s, zUp)` does this mapping.
* Inside the dynamics the code uses the classic aero body axes: x forward, y right, z down, with rates
  p, q, r. The body angular velocity in the three.js frame is (q, -r, -p).
* `state.heading`, `pitch`, `roll`, `alpha` and `beta` are in radians. Heading is in [0, 2π).
  Speeds are in m/s. Each `_kt`, `_ft` or `_fpm` extra gives the same value in that unit.

## Physics core

* **Fixed step.** Physics runs in fixed sub-steps of 1/240 s (`substepHz`) from an accumulator, so a
  run does not depend on the frame rate. `step(dt)` clamps dt to 0.1 s. The published pose is
  interpolated (lerp and slerp) between the last two sub-steps, so motion stays smooth at any frame
  rate.
* **Integration.** Translation uses semi-implicit Euler. Rotation uses the full Euler equations with
  the Ixz product of inertia, and the attitude quaternion is advanced with the exponential map. Rates
  are clamped to ±20 rad/s as a safety net.
* **Centre of gravity (the one deviation).** DESIGN.md makes the body origin the CG. That point is
  1.4 m ahead of where an F-35's CG sits. With the CG there the nose wheel carries 40 % of the weight: the
  nose comes up only at about 160 KIAS and the jet lifts off near 175 KIAS. The dynamics use a CG at
  body (0, 0.10, 1.415), which is station 9.25 m and about 30 % MAC. The CG sits 1.02 m ahead of the
  main wheels, which puts 17 % of the weight on the nose wheel. `state.position` is still the world
  position of the **body origin**, which is what `AircraftVisual.setPose` needs. Other modules see no
  difference. `config.mass.cg` holds the offset; setting it to [0, 0, 0] gives the literal DESIGN.md
  behaviour (40 % on the nose wheel, a much later rotation).
* **Wind.** `fdm.wind` is a world Vector3 in m/s. The air mass moves with it and the aero uses the
  air-relative velocity. It is constant: there is no turbulence model.

## Mass and inertia

* **Mass.** Empty 13,290 kg plus 120 kg of pilot and miscellany, plus fuel. Internal fuel is 8,278 kg
  and a spawn starts with 60 % of it. The reference mass is 18,377 kg.
* **Inertia.** At the reference mass: Ixx 30,000, Iyy 165,000, Izz 185,000 and Ixz 2,000 kg m². These
  are the F-16 values (Stevens & Lewis) scaled by mass (×1.98) and by size squared (span 10.7 against
  9.96 m, length 15.7 against 15.0 m). They scale linearly with the current mass.
* **CG.** Fixed. It does not move as fuel burns (see the limitations).

## Aerodynamics (`aero.js`, `config.aero`)

Reference geometry: S = 42.7 m², b = 10.7 m (aspect ratio 2.68), mean aerodynamic chord 4.58 m (from
the `scripts/f35/wings.py` planform). Every coefficient comes from a table in α (deg) and/or Mach.

**Lift**

* The table runs over -90..90°. The slope is 0.063/deg, which is 3.6/rad: the AR 2.7 wing (about
  3.0/rad by Helmbold) plus the body and chine lift. Chine vortex lift holds the slope to about 20°.
  CLmax is 1.57 at 35°, typical of a LEX or chine fighter (the F/A-18 reaches about 1.6-1.8). The
  post-stall break is gentle and the curve reaches zero at 90°. Reverse flow (|α| > 90°) mirrors the
  table.
* **Mach effects.** The part of the curve up to 10° α is scaled by `machLinear`: +30 % at M 1.0 (the
  subsonic Prandtl-Glauert / DATCOM trend for this sweep), then the supersonic fall-off (0.87 at M 1.6).
  The vortex and high-α remainder is scaled by `machHigh`, so high-α lift is lost at high subsonic
  Mach.
* **Flaps.** dCL +0.30 at full flap, faded out between 15° and 32° α. The flaps are scheduled: with the
  gear down they are full below 180 KCAS and up at 220 KCAS. With the gear up they work as manoeuvre
  flaps above 10° α, up to 0.35, below M 0.9.
* **Ground effect.** McCormick factor φ = (16h/b)² / (1 + (16h/b)²). Induced drag is multiplied by φ,
  and lift gains up to +10 %.

**Drag**

* CD = max(CD0 + K·CL², CD0 + 1.55 sin²α) + 0.4 sin²β.
* **CD0.** 0.021 subsonic. The drag rise starts at M 0.85 and peaks at 0.063 at M 1.1-1.2, high
  because of the F-35's large cross-section. It falls slowly to 0.050 at M 2.
* **Increments.** Gear +0.020, full flaps +0.022, speedbrake +0.035, open canopy +0.010.
* **K.** 0.170 subsonic, which is 1/(π e A) with e ≈ 0.75 and partial leading-edge suction. It rises
  to 0.32 at M 1.6, which is 1/CLα (no suction). Above CL 0.6 it is further multiplied by
  (1 + 0.8 (CL - 0.6)) for separation. This sets the sustained turn: 4.63 g at M 0.8 and 15,000 ft
  against the published F-35A 4.6 g (the 2013 revised specification; the original was 5.3 g).

**Pitch**

* The static margin is -3 % MAC subsonic: relaxed stability, the jet is unstable without the FCS. It
  becomes stable through the transonic region (+4 % at M 1.0) and reaches +14 % at M 1.6.
* A nose-down break grows from 25° to 60° α, reaching -0.12 in Cm. Pitch damping Cmq is -5.
* Increments: flaps -0.045 and gear +0.004.
* **Stabilators.** Full stabilator gives Cm ±0.30, which rotates the jet from about 125 kt. The
  effectiveness falls to 0.62 at M 1.6 and to 0.75 at 40° α.

**Lateral-directional**

* Side force: CYβ = -0.9 and CYδr = -0.06.
* Dihedral effect: Clβ from -0.08 (low α) to -0.12 (20-30°).
* Roll damping: Clp from -0.32 to -0.10 at high α. Clr = 0.04 + 0.25·CL.
* **Ailerons.** Cl per unit aileron command (the flaperons plus differential stabilators): 0.060 at
  low α, falling to 0.028 at 40° α and to 0.62 of that at M 1.6.
* **Directional stability.** Cnβ is 0.14 at low α. It reaches zero at about 35° α and is slightly
  negative beyond: the twin tails are blanked at high α. It is reduced supersonic.
* Rudders: Cnδr = 0.045, falling with α. Yaw damping Cnr is -0.40 at low α.

These are design values chosen to meet the DESIGN.md targets. They are not F-35 wind-tunnel data,
which is not public.

## Engine (`engine.js`, `config.engine`)

* **Throttle.** 0 is idle, 0.75 is MIL (N2 100 %, no afterburner) and 0.75..1 is the afterburner range.
  Steady dry thrust is linear in throttle. N2 is scheduled as idle + Δ·throttle^(1/1.6) and
  thrust ∝ (N2 fraction)^1.6.
* **Static thrust.** 125 kN at MIL and 191 kN in max A/B at sea level (DESIGN.md). Idle is 6 kN. At
  high Mach the idle thrust becomes net ram drag.
* **Lapse.**
  * MIL: σ^0.75 in the troposphere and ∝ σ above 11 km. The Mach factor is (1 - 0.20 M + 0.25 M²).
  * Afterburner increment: σ^0.70 with (1 + 0.08 M + 0.08 M²). The ram recovery helps the
    afterburner more.
  * Above M 1.4 the fixed diverterless inlet loses recovery: thrust × (1 - 1.5 (M - 1.4)²). This is
    what holds the top speed near M 1.6.
* **Spool.** The N2 rate is 3.0 %/s plus 0.36 %/s per % above idle (accelerating) and 4.0 + 0.30
  (decelerating). Idle to MIL takes 4.7 s. The afterburner lights at N2 ≥ 97 % after 0.25 s and fills
  at 1.35 per second, so it is full in about 1.0 s.
* **Fuel.** The flows are calibrated to the brief: 0.80 kg/s at MIL and 3.50 kg/s in max A/B at sea
  level static, with +25 % per unit Mach and a 0.10 kg/s idle floor. At zero fuel the engine flames
  out. N2 then windmills at about 22 % per unit Mach and the thrust becomes a ram drag of 0.25 m²·q̄.

## Landing gear (`gear.js`, `config.gear`)

* **Contact points.** The defaults come from `scripts/f35/gear.py` and the `geom.py` stance:
  * nose wheel at station 4.25 m, tyre radius 0.2985 m
  * main wheels at ±2.17 m and station 10.27 m, radius 0.432 m
  * all on the ground plane of the modelled stance, which is 1.45° nose-up
  The points are body-frame positions where each tyre meets the ground with the jet standing on its
  gear. `configWithRig(config, rig)` or `fdm.setGearContacts(list)` takes `[{name, pos, radius}]` from
  `f35i_rig.json` (`gearContacts`) or from `AircraftVisual.info.gearContacts`. `pos` can be an array
  or {x, y, z}. The nose wheel is the most forward contact, and the other wheels carry brakes.
* **Struts.**
  * One spring-damper per wheel (oleo and tyre combined), acting along the body Y axis.
  * The spring is progressive, F = (k/2)(c + c³/cs²). It is sized so the reference weight compresses
    each strut by exactly its static stroke: 9 cm on the mains and 7 cm on the nose. The jet therefore
    sits at the modelled 1.45° stance.
  * Damping is 0.35 of critical in compression and 0.70 in rebound. A stiff end stop acts at the full
    stroke (0.32 m / 0.28 m).
  * A strut load above 7 static loads breaks the gear.
* **Tyres.**
  * Friction is multiplied by `surfaceAt().friction`: 0.8 on the runway in the tests.
  * Rolling resistance is 0.015 on runway, 0.06 on ground and 0.2 in water.
  * Anti-skid braking uses 0.70 of the available μ·Fn on the mains.
  * Cornering force is linear up to a 0.12 rad slip angle, inside a friction circle.
  * With nose-wheel steering off, the nose wheel casters.
* **Parking brake.** With the parking brake set, or a pedal brake of 0.5 or more on a stopped wheel,
  the wheel is anchored by a stiff spring and damper. Idle thrust then moves the jet about 1 cm.
  The anchor lets go when the tyre friction is exceeded (the brakes hold MIL only just, not the
  afterburner); a parking brake left on then keeps braking like full pedal brakes, so a take-off
  against it is long (565 m instead of 356 m in full afterburner) and shows `PARKING BRAKE`.
* **Nose-wheel steering.** It follows the pedals when `nwsEnable` is on and the nose wheel has weight
  on it. The rate is 60°/s. Full lock is 60° while taxiing; at speed the angle is limited to a 0.35 g
  side load: atan(wheelbase·3.4/v²), which is about 1.2° at 60 kt.
* **Retraction.** It takes 6 s each way. The gear cannot retract while any wheel has weight on it.
  The wheels only make contact when the gear is fully down (`gear` ≥ 0.999).
* **Touchdown sink.** The closing speed at a wheel's first contact is graded: above 3.05 m/s (10 ft/s,
  the design sink rate of land-based fighter gear) the landing is marked hard (`lastTouchdown.hard`)
  and `HARD LANDING` shows for 6 s; above 4.6 m/s (15 ft/s) the gear collapses. Heavy jets break a
  little earlier, from about 4.2 m/s, through the strut overload (7 static loads). A 3° path flown
  onto the runway without a flare is 3.6-4.0 m/s: hard, not a crash.
* **Bounces.** Contacts within 2 s of leaving the ground belong to the same landing: `lastTouchdown`
  keeps the first contact and counts `bounces`; `sink` and `closing` keep the worst.

## Fly-by-wire (`fcs.js`, `config.fcs`)

The inner loops use nonlinear dynamic inversion, as the real F-35 control laws do. The outer loops
turn the stick into a commanded body-rate change. The inversion uses the same aero model to compute
the moment that change needs, and from it the surface command. `Aero.evaluate` returns the
control-free moments (Cm0, Cl0, Cn0) and the effectiveness (Cm_δe, Cl_δa, Cl_δr, Cn_δa, Cn_δr). Roll
and yaw are inverted together as a 2×2 system.

**Pitch in the air: the C\* law**

* C\* = (nz - cosθ cosφ) + (Vco/g)·q, with Vco = 120 m/s. At high speed the stick commands g; at low
  speed it commands pitch rate.
* Full aft stick gives C\* +13, which is 9 g at 450 kt and above. Full forward gives -6. With the gear
  down the values are +5 / -3, softer for the approach.
* The stick is shaped as 0.55x + 0.45x³ for fine control near the centre.
* Feedback gain: 0.5. The inner loop time constant is 0.10 s.
* **Stabilator rate.** The stabilators move at a finite rate, so the pitch acceleration can only
  change so fast. Large pitch-rate errors are therefore closed along sqrt(2·J·e), with J built on 30 %
  of the stabilator rate (`pitchJerkShare`), instead of e/0.10 s. The surface starts back early
  enough that the pitch rate does not overshoot at low q̄. At high q̄ the pull is unchanged.

**Limiters**

* **g limiter.** +9 / -3 g. The pitch rate is predicted from the load factor per radian of AoA (Nα),
  with a 0.3 s correction.
* **AoA limiter.** 25° α, or 50° with `input.highAoA`, and -10°. It uses α̇ = q + Qα computed from the
  current forces, a braking curve sqrt(2·a·e) built on 40 % of the nose-down stabilator authority,
  and a lead term. A full pull at 200 kt peaks at 25.0° and holds 25.0°. Random full-deflection inputs
  for minutes stay within 25.0° (normal mode) and within 52° (high-AoA mode).
* **Pitch rate.** Limited to 45°/s.
* **Tail-strike protection.** With the gear down below 5 m AGL, pitch is capped at 14°. The geometric
  tail strike is at the nozzle: 16° on extended struts, 15° on statically compressed ones, ~13.5°
  with the mains a further 0.2 m in (a firm touchdown). 14° leaves the 13° on-speed approach a flare.

**Hands-off pitch: auto-trim**

* When the stick is released, the jet captures and holds the flight-path angle with a PI loop: 0.35/s
  proportional and 0.04/s² integral, at up to 4°/s.
* The hands-off load factor is perpendicular to the path (wind axes) and is turned into body axes
  for the C\* law: nz = n·cos α - (thrust - drag)/W·sin α, which in steady flight is exactly cos θ.
  (Using n directly left a bias of cos γ - cos θ, 0.014 g on a 13° approach: the path flattened and
  the jet bled speed on the back of the drag curve.)
* On the approach the jet is on the back of the drag curve: with the path held and the throttle
  fixed, a speed error grows, doubling about every 9 s (2 kt fast at 140 KIAS becomes 20 kt after
  30 s; hands off, the jet slides to the front side of the curve, about 300 kt down the path). Fly
  the AoA (on-speed 13°) with the throttle, or let the auto-throttle do it (below).

**Auto-throttle (approach power compensator, `config.apc`)**

* With `input.apc` and the gear down in the air, the throttle flies the on-speed AoA (13°) while the
  FCS holds the flight path, as the real jet's approach mode does: a PI loop on the AoA error (0.08
  throttle per degree, integral 1.2/s per rad) with damping on the acceleration along the path
  (filtered over 0.4 s), from idle to MIL (never the burner), slewed at 0.3/s. It starts from the
  throttle in use, so engaging it does not jump.
* It gives way on the ground, with the gear moving, in the 50° AoA mode, below 30 m/s and with the
  engine out; `state.apc` says when it flies. At touchdown it retards to idle until `input.apc` is
  cleared (the input layer does that, with the lever following the engine meanwhile).
* Hands off from the 10 km final (140 KIAS, 45 % fuel) it holds 13.0° within 0.01° and 140.4-140.7
  KIAS down to the runway, touching down 243 m past the threshold at 3.6 m/s (no flare: hard, not a
  crash). From 160 or 125 KIAS it settles on-speed within 40 s; a turn on the approach moves the
  speed by about 1 kt.
* Bank compensation 1/cos φ holds the height in turns up to 70° bank, which is 2.9 g. Beyond 70° it
  eases to 0 at knife edge, and cos φ applies inverted.
* Rolling into a turn adds a 0.35 s lead on the bank rate, because the load factor lags the C\*
  command by about 0.4 s.
* Both the compensation and the lead fade out at bank rates between 45 and 120°/s. A fast aileron
  roll is therefore flown at about 1 g and the jet does not porpoise.

**Roll and yaw**

* **Roll.** The stick commands the stability-axis roll rate (the roll is about the velocity vector):
  up to 200°/s at q̄ ≥ 11 kPa. The rate is reduced:
  * to 35 % at low q̄
  * above 12° α, down to 55 % at 30° α
  * above M 1.1, down to 55 % at M 1.8
* **High-AoA coordination.** A stability-axis roll needs the yaw rate p_s·sin α, and the sideslip
  grows as β̇ = p sin α - r cos α + a_y/V while the yaw lags (gravity adds g sin φ/V as the bank
  grows). Where the rudders cannot build that yaw rate quickly (slow flight, 20-30° α) the command is
  capped to what the yaw axis already does plus a bounded sideslip build-up (6°, 3/s). Full stick at
  120 kt and 25° α: 90° of bank in 3.1 s, peak 38°/s, sideslip ≤ 6° (before: 3.4 s, 33°/s).
* **Allocation.** Roll and yaw are inverted together; when one surface saturates the other axis is
  solved again for the deflection the saturated one really has. (The joint solution counted on the
  rudders' rolling moment at 10x their travel, and the ailerons wound down to nothing.)
* **Bank hold.** When the stick is released, the jet holds the current bank. Below 5° it rolls wings
  level.
* **Yaw.** The yaw law keeps sideslip at zero (turn coordination): r_cmd = (p sin α + a_y/V
  + 2.0 (β - β_cmd)) / cos α. Pedals command sideslip up to 12° at low q̄, shrinking as 5,000 Pa/q̄
  (4.2° at 300 KCAS), with a 1.5° minimum.

**Ground and takeoff**

* **Ground pitch.** On the ground the stick commands a pitch attitude: the 1.45° stance, up to 12° at
  60 % aft stick or more (`rotateStick`, linear in the raw stick: the cubic shaping left a half pull
  at ~4°, which only flew off at ~260 kt). The rotation rate is limited to 8°/s. Lift-off with MIL
  at 60 % fuel: 162 KIAS for any pull from half to full, 178 KIAS for a 30 % pull.
* **Rotation.** The inversion feeds forward the main-gear pitching moment once the nose wheel is off.
  A ground integrator covers the remaining error.
* **Taxi speeds.** Below 15-35 m/s the stick drives the stabilators directly (control check). A push
  always holds the nose wheel down.
* **After lift-off.** The attitude mode is kept while the stick stays aft. It hands over to the air
  laws when the stick is released, after 10 s, when the gear moves up, or above 230 KCAS. Lift-off
  comes at about 160 KIAS.
* **Stick ratchet.** A pull still held at the hand-over set an attitude; the same stick asks the C\*
  law for g (full aft: the AoA limit). The air law only sees the stick beyond what was held, the
  reference follows the stick down as it is released and fades out over `ratchetTau` (3 s), so the
  held pull comes in smoothly. Full aft stick held through gear up used to jolt the jet to 23°/s of
  pitch rate within a second (a pull let go a second later still threw the nose to 29°); now the
  pitch rate builds to 6.6°/s over 1.5 s, and a pull let go a second after gear up adds about 2°.
  Held on, a pull is a pull, as in the air. (Ratcheted for good, the held stick was ignored: the
  jet flew its lift-off path and the nose sank while the pilot held it back.)
* **Ground roll and yaw.** Roll is half authority, direct; the pedals drive the rudders and the nose
  wheel.

**Actuators**

* Rate-limited first-order response with a 25 ms lag.
* Stabilators about 60°/s (3.0 of the normalised range per second); flaperons and rudders about 80°/s.

## Crash detection

`state.crashed` and `state.crashReason` are set and the jet freezes in place. `reset()` clears them.

| cause | crashReason |
|---|---|
| \|nz\| above 13.5 g or below -6 g (1.5 × the limits) | `Structural failure: 13.5 g` |
| touchdown closing speed above 4.6 m/s at a wheel | `Hard landing: 5.0 m/s sink at touchdown, the gear collapsed` |
| strut overload | `Landing gear collapsed (overload)` |
| wheels on a water surface | `Ditched: the wheels touched water` |
| airframe point in water | `Crashed into the water` |
| gear not down, only underside points touching | `Belly landing: the landing gear was not down` |
| only wingtips or stabilator tips touching | `Wingtip struck the ground` (or `Stabilator tip ...`) |
| nozzle or aft keel on the runway with the gear down | `Tail strike` |
| any other airframe point | `Crashed: the nose tip hit the ground` (first point, nose to tail) |

There are 22 airframe points: nose tip, chin, belly line, inlets, aft keel, nozzle, wingtips,
stabilator tips, fin tips, canopy and spine, all from `scripts/f35`. They are tested against
`heightAt` whenever the CG is within 16 m of the ground. The test also runs when the ground under the
nose, 9 m ahead, is within 16 m, which covers steep slopes.

## Output (`state`)

All the DESIGN.md fields are present.

**Pose and motion**

* `position` is the world position of the body origin. `quaternion` rotates body to world.
* `velocity` is in the world frame. `angularVelocity` is in the body frame (three.js axes).

**Air data**

* `alpha`, `beta`, `ias` (CAS), `tas`, `mach`, `gLoad` (body normal load factor).
* `altitude` is the body origin's height in m MSL.
* `agl` is the height of the wheels above the ground under the jet: 0 when standing.
* `heading`, `pitch`, `roll`, `vs`.

**Ground contact**

* `onGround`.
* `wheels`: `{name, wow, compression, steer, force, staticCompression}`. `compression` is in m from
  the fully extended strut, so standing gives about `staticCompression`. `steer` is in rad,
  + = right. `force` is the strut load in N.
* `gear`: the actual position, 0..1.

**Engine**

* `engine`: `{rpm, thrust, ab, fuelKg, fuelFlow, running, throttle}`.
* `rpm` is N2 in %: 66 at idle, 100 at MIL.
* `thrust` is in N and goes negative as ram drag.

**`controls`, for `AircraftVisual.setControls`**

* `stick_pitch`, `stick_roll` and `pedals` are the actual surface commands from the FCS (actuator
  outputs, -1..1), not the pilot's stick.
* `flaps` (scheduled), `speedbrake` (auto on the landing roll), `gear` (actual position).
* `nws` is the steer angle / 60°. `roll_distance` is the mean main-wheel travel in m.
* `throttle`, `ab`, `canopy`.
* `lights`: `{nav, landing (on with the gear down), formation, anticoll}`.
* `weapon_bays`, `refuel_door`, `gun_door` and `tailhook` are 0: they are not modelled.

**Crashes and warnings**

* `crashed`, `crashReason`.
* `warnings` can contain `GEAR`, `PULL UP`, `AOA`, `OVER-G`, `OVERSPEED`, `ENGINE`, `BINGO FUEL`,
  `PARKING BRAKE` (set, throttle above 0.5, on the ground) and `HARD LANDING` (6 s after a touchdown
  above 3.05 m/s).

**Extras, for the HMD and the tests**

* `ias_kt`, `tas_kt`, `alt_ft`, `vs_fpm`, `gamma`, `groundSpeed`, `qbar`, `mass`, `time`.
* `fcsMode` (`ground`, `takeoff` or `air`).
* `p`, `q`, `r` (aero axes) and `gLateral`.
* `lastTouchdown`: `{time, sink, closing, ias, gs, pitch, alpha, wheel, bounces, hard}` of the last
  landing (its first contact; `sink`/`closing` the worst of its bounces).
* `highAoA`: the 50° AoA mode is selected (`input.highAoA`).
* `apc`: the auto-throttle is flying the throttle (`input.apc`, the gear down in the air).
* `trimThrottle`.

## Interface notes (additions to DESIGN.md, all backward compatible)

**`reset(spawn)`**

* Accepts the spawns.json entries. It also uses `throttle`, `gear` (bool or 0..1), `fuel` (fraction),
  `fuelKg`, `flight_path_deg` and `apc` (start on the auto-throttle: the 10 km final).
* It returns `{throttle, gearDown, apc}`, the values it set up (`apc` only in the air with the gear
  down). The input layer can set its levers to them.
* **On the ground.** The wheels are put on `heightAt(x, z)` and the struts are settled on the parking
  brake for 2.5 s of simulated time. The jet is then put back exactly on the spot.
* **In the air.** `y` is the altitude MSL and `speed_ms` the true airspeed. The jet is trimmed for 1 g
  on the given flight path: AoA, stabilator, flaps, and the throttle unless the spawn gives one.

**Optional inputs**

* `highAoA` (bool) selects the 50° AoA limit.
* `apc` (bool) selects the auto-throttle; `throttle` is then ignored while it flies.
* `speedbrake` is a bool or 0..1.
* `brakeLeft` and `brakeRight` (0..1) give differential braking.

**Methods**

* `trim(V, h, gamma, gearPos)` returns `{alpha, throttle, thrust, de, flaps, cas, mach}`.
* `setGround(ground)`, `setGearContacts(list)`, `mass()`.

**Config exports** (`f35i_config.js`)

* `F35I_CONFIG` (also the default export).
* `configWithRig(config, rig)`: reads `rig.gearContacts`, `rig.gear.contacts` or `rig.contacts`.
* `parseContacts(list)`, `loadF35IConfig(baseUrl)`, `bodyFromStation(...)`, `DEFAULT_GEAR_CONTACTS`.

**Ground object**

* `normalAt` may be missing: it then comes from finite differences of `heightAt`.
* `surfaceAt` may be missing: it then defaults to runway, friction 0.8.

## Test results (60 % fuel unless noted)

| check | result | target / reason |
|---|---|---|
| parked at idle, parking brake, 60 s | drift 0.01 m, stance 1.44°, nose 17 % | stays put; 1.45° modelled stance |
| takeoff MIL (pull at 150 KIAS) | lift-off 162 KIAS after a 589 m roll, rotates to 12.1° | 150-165 KIAS; energy estimate ~600 m with T/W 0.69 and spool-up from idle |
| takeoff max A/B (pull at 140 KIAS) | lift-off 161 KIAS after a 357 m roll, 12.1° | T/W 1.06, ~380 m |
| takeoff MIL, half aft stick | lift-off 162 KIAS, 10.3° (before: 265 KIAS) | a partial pull rotates too |
| full aft stick through gear up (+2 s) | pitch rate ≤ 6.6°/s in the 1.5 s after the hand-over (before: 23°/s); let go 1 s after gear up: max pitch 13.8°, AoA 11.2° (before: 29° / 21.5°); 0.35 aft held on: +20.6° of pitch in 6 s | a smooth hand-over to C\*, which then answers the stick |
| max A/B with the parking brake left on | 565 m roll (1.58 × 357 m); warning on the ground only (before: 0.98 ×, warning in the air) | the brake drags once the wheels slide |
| full stick at 25° AoA, ~111 KIAS | 90° of bank in 3.05 s, peak 37°/s, β ≤ 6.2° (before: 3.38 s, 33°/s) | coordinated within the rudder authority |
| hands-off final, 140 KCAS / 13° AoA, gear down, 45 % fuel | path within 0.02° of -3° for 10 s (before: 0.23°); +1.9 kt in 20 s | no 1 g bias in the hold |
| the same on the auto-throttle, to the runway | 13.0° AoA within 0.01°, 140.4-140.7 KIAS; touchdown 243 m past the threshold, 3.6 m/s, then idle | a stable on-speed approach (fixed throttle: 300 kt in 100 s) |
| 3° path into the runway without a flare, 146 KCAS | 3.8 m/s first contact, 1 bounce, logged hard, no crash (before: logged 0.54 m/s) | 3.05 m/s hard .. 4.6 m/s collapse |
| climb, 300 KCAS, MIL, 1.6-3 km | 76.5 m/s (15,000 ft/min) | excess-power estimate 11,000-20,000 ft/min |
| hands-off level, 350 KCAS, 5,000 m, 60 s | 0.3 m drift | < 30 m |
| max level speed, sea level / 11 km | 717 KCAS (M 1.09) / M 1.61 | ~700 KCAS / M 1.6 |
| full pull at 450 KCAS | peak 8.73 g, 8 g in 0.72 s | never above 9 g |
| full pull at 200 KCAS | peak 25.0°, held 25.0°; high-AoA mode peak 50.8°, held 50.0° | 25° (50°) limit |
| loop, 450 KCAS, 6.5 g, max A/B | 360° in 25 s, +1,290 m at the top, exit +147 m, 163 KCAS over the top, peak 6.8 g | radius about V²/(g(n - 1)): about 1.35 km at the bottom, about 0.3 km over the top |
| full roll, 350 KCAS | 200°/s, 360° in 2.05 s, β ≤ 0.8° | ~200°/s about the velocity vector |
| hands-off 60° bank turn | 9 m height change, bank 60.9°, turn rate 1.00 × g tan φ/V | holds the path in turns |
| sustained turn, M 0.8 / 15,000 ft | 4.63 g | F-35A 4.6 g |
| pedals at 300 KCAS | β 4.2° (command 4.2°), wings level | sideslip command |
| approach and landing, 35 % fuel | 137 KIAS at 13.0° AoA; touchdown 1.0 m/s at 134 KIAS; stopped 865 m later, peak 0.40 g | ~140 KIAS at 13°; < 3 m/s |
| gear | 6.0 s each way; WOW interlock; taxi radius 10 m; NWS 1.2° at 60-70 kt | brief |
| engine at sea level static | idle to MIL 4.7 s; A/B full in 1.0 s; 125 / 191 kN; 0.80 / 3.50 kg/s | brief |
| crashes | 3.6 m/s touchdown hard but intact; 5 m/s collapse; belly landing, water, terrain, overstress (limiter off), tail strike | brief |
| engine out, manoeuvring, 45 s | mechanical energy never rises (largest one-frame rise 0) | conservation |
| random full-deflection inputs, jittery frame times; zoom to zero airspeed | state finite, AoA ≤ 25.0°; zoom peaks at 26.9° AoA and flies out at 126 KIAS | carefree handling, numerical robustness |

## Tuning knobs (`f35i_config.js`)

| to change | edit |
|---|---|
| top speed, acceleration | `engine.milThrust`/`maxThrust`, `milLapse`/`abLapse`/`abMach`, `engine.inlet.loss` (Mach 1.6 cap), `aero.CD0` |
| turn performance, energy bleed | `aero.K`, `kHighCL` |
| takeoff and landing speeds | `aero.CL` (table), `aero.flaps.dCL`, `schedules.flapsFullCas`/`flapsUpCas` |
| rotation | `fcs.takeoffPitch` (12°), `rotateStick` (0.6: raw stick for the full attitude), `rotationRate` (8°/s), `kTheta`, `kiGround`; `aero.Cm_de` (authority); `mass.cg` (nose-wheel share); `takeoffModeTime`/`takeoffModeMaxCas`, `ratchetTau` (the hand-over to C\*) |
| stick feel | `fcs.cstarUp`/`cstarDown` (g per stick), `cstarUpPA`/`cstarDownPA` (gear down), `stickShapePitch`/`stickShapeRoll` (centre softness), `rollRateMax`, `tauP`/`tauQ`/`tauR`, `pitchJerkShare` (crisp vs damped at low speed) |
| limits | `fcs.nMax`/`nMin`, `alphaMax`/`alphaMaxHigh`/`alphaMin`, `pitchRateMax`; `limits.overstressG` (crash) |
| hands-off holds | `fcs.kGamma`/`kiGamma`, `bankCompKnee`/`bankCompLead`/`bankCompRate`, `kPhi`, `bankSnap` |
| stability feel (FCS off) | `aero.staticMargin`, `Cnbeta`, `Clbeta`, damping derivatives |
| gear | `gear.main`/`nose` (static compression, stroke, damping), `brakeMu`, `steering.maxAngle`/`lateralAccel`, `retractTime`, `touchdownHardSink`/`touchdownCrashSink`, `bounceTime` |
| engine response | `engine.spoolUp`/`spoolDown`, `abLightDelay`/`abRateUp`; fuel `tsfcDry`/`tsfcAb` |
| auto-throttle | `apc.alpha` (on-speed AoA), `kp`/`ki`/`kd` (gains), `vdotTau`, `min`/`max` (throttle range), `rate` (slew) |
| physics rate | `substepHz` (240; keep ≥ 200) |

## Known limitations

* **Fuel.** Fuel flows follow the brief: 0.8 kg/s at MIL and 3.5 kg/s in max A/B, sea level static. A
  real F135 burns about three to four times that, so endurance in the sim is generous.
* **CG and inertia.** The CG does not move as fuel burns, and the inertia scales with mass only.
* **Stores and failures.** No stores, weapons-bay drag, external tanks, damage, engine fires or
  failures. Flame-out happens only when the fuel runs out. No turbulence or gusts; the wind is
  constant.
* **Not real data.** The aero data are design values that meet public performance figures. They are
  not F-35 data.
* **Visual struts.** The visual is posed at the static stance and does not compress the oleos. As the
  wings take the weight on the takeoff roll the struts extend by up to about 9 cm, so the wheels can
  show a small gap above the runway just before lift-off. The visual can use
  `wheels[i].compression - wheels[i].staticCompression` to move each strut.
