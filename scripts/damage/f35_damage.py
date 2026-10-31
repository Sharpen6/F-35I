"""F-35I 'Adir' damage model and flight-effect simulator (pure Python).

No Blender needed:  python3 scripts/damage/f35_damage.py --help

The model has three layers

1. Components (damage zones).  Each has hit points, a hitbox (oriented box
   in aircraft coordinates, see data/damage_model.json) and the aircraft
   attributes it feeds: lift share and lateral arm, roll / pitch / yaw
   control power, thrust path, fuel, structure and systems.
2. A damage state = health 0..1 per component (1 = intact, 0 = destroyed
   or missing).  Hits (point, ray or blast) are converted into health loss
   with the hitboxes.
3. evaluate(state, flight condition) -> attributes.  A small but
   physically consistent model: ISA atmosphere, drag polar with transonic
   rise, F135 thrust lapse and DSI pressure recovery, lift / roll balance
   with sideslip trim, structural g-limit, fuel leaks, system availability.

Intact reference values are public F-35A data (the F-35I is an F-35A
derivative).  Coefficients that are not public are typical fighter values
and are labelled as model assumptions; the drag rise is calibrated so the
intact aircraft reproduces the published Mach 1.6 limit.

Aircraft axes used here: x = left (port) positive, s = station aft of
the nose tip, z = up (same as the Blender model, see scripts/f35/geom.py).
"""
import argparse
import copy
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
JSON_PATH = os.path.join(REPO, "data", "damage_model.json")

G0 = 9.80665

# ------------------------------------------------------------------ intact
SPEC = {
    # geometry (official)
    "length_m": 15.67, "span_m": 10.70, "height_m": 4.38, "wing_area_m2": 42.7,
    # masses (official F-35A)
    "empty_kg": 13290.0, "internal_fuel_kg": 8278.0, "max_takeoff_kg": 31751.0,
    "ref_stores_kg": 2 * 161.5 + 2 * 934.0,     # 2 x AIM-120C + 2 x GBU-31 internal
    "ref_fuel_fraction": 0.60,
    # propulsion: F135-PW-100 (official)
    "thrust_dry_kN": 125.0, "thrust_ab_kN": 191.0,
    "tsfc_dry_kg_per_Nh": 0.0898,               # ~0.88 lb/lbf/h, model assumption
    "tsfc_ab_kg_per_Nh": 0.2040,                # ~2.0 lb/lbf/h, model assumption
    # limits (official / public)
    "mach_limit": 1.60, "vmax_kcas": 700.0, "g_max": 9.0, "g_min": -3.0,
    "ceiling_m": 15240.0, "aoa_max_deg": 50.0,
    # aerodynamics (model assumptions, typical for a low-AR stealth fighter)
    "cl_alpha_per_rad": 3.6, "cl_max": 1.55, "cd0_sub": 0.028, "k_induced_sub": 0.15,
    "clp": -0.32, "cl_beta": -0.10, "cy_beta": -0.95, "cn_beta_body": -0.08,
    "beta_max_deg": 8.0, "trim_reserve": 0.60,
}

# lift shares (fraction of total lift at the same AoA) and lateral arms (m)
BODY_LIFT = 0.24
PANEL_LIFT = 0.38                      # each exposed wing panel
ROOT_SHARE, OUTER_SHARE = 0.62, 0.38   # inner / outer part of a panel
ROOT_ARM, OUTER_ARM = 2.75, 4.35
WING_FUEL_ARM = 2.9

# roll control power at full deflection (rolling-moment coefficient)
ROLL_POWER = {"flaperon": 0.0060, "stab": 0.0045, "rudder": 0.0012, "lef": 0.0008}

# ------------------------------------------------------------- components
# Each component: hp, side (+1 left / -1 right / 0), detachable, and
# contributions.  'objects' maps the component to Blender objects (visual
# damage / break-off); 'box' = explicit hitbox for internal components
# (centre (x, s, z), half extents, yaw deg) - the rest are fitted to the
# geometry by scripts/f35/destruct.py and saved to data/damage_model.json.
COMPONENTS = {
    "radome":        dict(hp=120, side=0, detach=True, objects=["Fuselage_Nose"], mass=55.0, arm=0.0,
                          systems=["radar"], drag=0.0030, mach_limit=1.20,
                          label="Nose radome / AN/APG-81 radar"),
    "cockpit":       dict(hp=160, side=0, detach=False, objects=["Canopy_Glass", "Canopy_Frame"],
                          systems=["pilot", "canopy"], drag=0.0040, q_limit=0.55,
                          box=((0.0, 3.85, 0.85), (0.50, 1.25, 0.55), 0.0), label="Cockpit and canopy"),
    "fwd_fuselage":  dict(hp=420, side=0, detach=False, objects=["Fuselage_Fwd", "EOTS_Window", "EOTS_Fairing"],
                          systems=["eots", "das", "avionics", "nose_gear"], drag=0.0020, structure=0.35,
                          label="Forward fuselage (avionics, EOTS, DAS)"),
    "inlet_L":       dict(hp=260, side=1, detach=False, objects=[], airflow=0.5, drag=0.0025,
                          box=((1.20, 6.10, 0.02), (0.50, 1.85, 0.45), -9.0), label="Left inlet and duct"),
    "inlet_R":       dict(hp=260, side=-1, detach=False, objects=[], airflow=0.5, drag=0.0025,
                          box=((-1.20, 6.10, 0.02), (0.50, 1.85, 0.45), 9.0), label="Right inlet and duct"),
    "center_fuselage": dict(hp=700, side=0, detach=False, objects=["Fuselage_Center"],
                            fuel=("fuselage", 4200.0), structure=1.0, drag=0.0020,
                            label="Centre fuselage (main fuel tanks, wing carry-through)"),
    "fuel_feed":     dict(hp=180, side=0, detach=False, objects=[], systems=["fuel_feed"],
                          box=((0.0, 8.30, 0.55), (0.45, 0.70, 0.30), 0.0), label="Fuel feed / boost pumps"),
    "weapon_bay_L":  dict(hp=220, side=1, detach=False,
                          objects=["BayDoor_Inner_L", "BayDoor_Outer_L", "GBU31_L", "AIM120_L"],
                          systems=["weapons_L"], drag=0.0015,
                          box=((0.61, 8.65, -0.64), (0.50, 2.12, 0.34), 0.0), label="Left weapon bay"),
    "weapon_bay_R":  dict(hp=220, side=-1, detach=False,
                          objects=["BayDoor_Inner_R", "BayDoor_Outer_R", "GBU31_R", "AIM120_R"],
                          systems=["weapons_R"], drag=0.0015,
                          box=((-0.61, 8.65, -0.64), (0.50, 2.12, 0.34), 0.0), label="Right weapon bay"),
    "engine":        dict(hp=520, side=0, detach=False, objects=["Nozzle"], thrust_core=True,
                          box=((0.0, 10.60, 0.12), (0.64, 2.60, 0.64), 0.0), label="F135 engine"),
    "nozzle":        dict(hp=200, side=0, detach=False, objects=["Nozzle"], thrust_nozzle=True,
                          label="Afterburner and nozzle"),
    "ipp":           dict(hp=150, side=0, detach=False, objects=[], systems=["electrical", "cooling"],
                          box=((0.45, 12.10, -0.35), (0.30, 0.45, 0.25), 0.0),
                          label="Power and thermal management (IPP, 270 V DC for the EHAs, cooling)"),
    "aft_fuselage":  dict(hp=450, side=0, detach=False, objects=["Fuselage_Aft"], structure=0.6,
                          fuel=("aft", 900.0), drag=0.0015, label="Aft fuselage / tail booms"),
    "gun":           dict(hp=90, side=1, detach=False, objects=["GunDoor"], systems=["gun"],
                          box=((1.30, 5.45, 0.66), (0.14, 0.45, 0.14), 0.0), label="GAU-22/A gun"),
    "pilot":         dict(hp=100, side=0, detach=False, objects=[], systems=["pilot"],
                          box=((0.0, 3.90, 0.85), (0.30, 0.45, 0.45), 0.0), label="Pilot"),
    "nose_gear":     dict(hp=150, side=0, detach=False, objects=[], systems=["nose_gear"],
                          label="Nose landing gear"),
}
for tag, sd in (("L", 1), ("R", -1)):
    side_name = "left" if sd > 0 else "right"
    COMPONENTS.update({
        f"wing_root_{tag}": dict(hp=460, side=sd, detach=True, objects=[f"Wing_{tag}"], mass=420.0, arm=2.5,
                                 lift=("root", sd), fuel=(f"wing_{tag}", 1589.0), structure=1.0, drag=0.0020,
                                 mach_limit=1.0, label=f"Inner {side_name} wing (wing box, fuel)"),
        f"wing_outer_{tag}": dict(hp=260, side=sd, detach=True, parent=f"wing_root_{tag}",
                                  objects=[f"WingOuter_{tag}", f"LEFOuter_{tag}"], mass=190.0, arm=4.35,
                                  lift=("outer", sd), drag=0.0010, mach_limit=1.20,
                                  label=f"Outer {side_name} wing panel"),
        f"lef_{tag}": dict(hp=120, side=sd, detach=True, parent=f"wing_root_{tag}", objects=[f"LEF_{tag}"],
                           mass=45.0, arm=3.0, roll=("lef", sd), clmax=0.06, mach_limit=1.40,
                           label=f"{side_name.capitalize()} leading-edge flap"),
        f"flaperon_{tag}": dict(hp=130, side=sd, detach=True, parent=f"wing_root_{tag}",
                                objects=[f"Flaperon_{tag}"], mass=65.0, arm=2.9, roll=("flaperon", sd),
                                clmax=0.08, mach_limit=1.40, label=f"{side_name.capitalize()} flaperon"),
        f"stab_{tag}": dict(hp=220, side=sd, detach=True, objects=[f"Stabilator_{tag}"], mass=150.0, arm=2.4,
                            roll=("stab", sd), pitch=0.5, drag=0.0010, mach_limit=1.20,
                            label=f"{side_name.capitalize()} stabilator"),
        f"fin_{tag}": dict(hp=220, side=sd, detach=True, objects=[f"Fin_{tag}", f"Rudder_{tag}"], mass=115.0,
                           arm=1.7, roll=("rudder", sd), yaw=0.5, drag=0.0010, mach_limit=1.30,
                           label=f"{side_name.capitalize()} vertical tail and rudder"),
        f"main_gear_{tag}": dict(hp=160, side=sd, detach=False, objects=[f"MainGearDoor_{tag}"],
                                 systems=[f"main_gear_{tag}"], label=f"{side_name.capitalize()} main gear"),
    })

FUEL_TANKS = {"fuselage": 4200.0, "aft": 900.0, "wing_L": 1589.0, "wing_R": 1589.0}


def set_lift_split(d):
    """Use the outer / inner wing split measured on the Blender mesh."""
    global ROOT_SHARE, OUTER_SHARE, ROOT_ARM, OUTER_ARM
    if not d:
        return
    OUTER_SHARE = float(d["outer_share"])
    ROOT_SHARE = 1.0 - OUTER_SHARE
    OUTER_ARM = float(d["outer_arm"])
    ROOT_ARM = float(d["root_arm"])


# ------------------------------------------------------------- atmosphere
def isa(h):
    h = max(0.0, h)
    if h < 11000.0:
        T = 288.15 - 0.0065 * h
        p = 101325.0 * (T / 288.15) ** 5.25588
    else:
        T = 216.65
        p = 22632.06 * math.exp(-(h - 11000.0) / 6341.62)
    rho = p / (287.053 * T)
    a = math.sqrt(1.4 * 287.053 * T)
    return T, p, rho, a


def kcas_to_q(kcas):
    v = kcas * 0.514444
    return 0.5 * 1.225 * v * v


# ----------------------------------------------------------- aero / prop
CAL = {"cd0_peak": 0.065}          # calibrated below


def cd0(M, extra=0.0):
    sub = SPEC["cd0_sub"]
    pk = CAL["cd0_peak"]
    if M <= 0.85:
        c = sub
    elif M <= 1.15:
        t = (M - 0.85) / 0.30
        c = sub + (pk - sub) * t * t * (3 - 2 * t)
    else:
        c = pk * max(0.75, 1.0 - 0.12 * (M - 1.15))
    return c + extra


def k_induced(M):
    k = SPEC["k_induced_sub"]
    return k if M <= 1.0 else k + 0.22 * (M - 1.0)


def inlet_recovery(M):
    return 1.0 if M <= 1.2 else max(0.3, 1.0 - 0.45 * (M - 1.2) ** 1.4)


def thrust(M, h, ab, mult=1.0, ab_ok=True):
    _, _, rho, _ = isa(h)
    sigma = rho / 1.225
    if ab and ab_ok:
        T = SPEC["thrust_ab_kN"] * 1000.0 * sigma ** 0.75 * (1.0 + 0.55 * M)
    else:
        T = SPEC["thrust_dry_kN"] * 1000.0 * sigma ** 0.80 * (1.0 + 0.20 * M)
    return T * inlet_recovery(M) * mult


def drag(M, h, W, extra_cd0=0.0, n=1.0, k_mult=1.0):
    _, p, rho, a = isa(h)
    q = 0.7 * p * M * M
    S = SPEC["wing_area_m2"]
    CL = n * W / (q * S)
    return q * S * (cd0(M, extra_cd0) + k_induced(M) * k_mult * CL * CL), CL, q


def max_mach_thrust(h, W, tmult=1.0, ab=True, ab_ok=True, extra_cd0=0.0, k_mult=1.0, cl_max=None):
    best = None
    M = 2.4
    while M >= 0.15:
        D, CL, _ = drag(M, h, W, extra_cd0, 1.0, k_mult)
        if cl_max is not None and CL > cl_max:
            break
        if thrust(M, h, ab, tmult, ab_ok) >= D:
            best = M
            break
        M -= 0.0025
    return best


def calibrate():
    """Pick the transonic drag peak so the intact jet just reaches M 1.6
    (thrust-limited) at 11 km with full afterburner and reference weight."""
    W = ref_weight() * G0
    lo, hi = 0.03, 0.15
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        CAL["cd0_peak"] = mid
        m = max_mach_thrust(11000.0, W)
        if m is not None and m > 1.62:
            lo = mid
        else:
            hi = mid
    CAL["cd0_peak"] = 0.5 * (lo + hi)
    return CAL["cd0_peak"]


def ref_weight():
    return SPEC["empty_kg"] + SPEC["ref_fuel_fraction"] * SPEC["internal_fuel_kg"] + SPEC["ref_stores_kg"]


# ------------------------------------------------------------ damage state
def intact_state():
    return {k: 1.0 for k in COMPONENTS}


def _h(state, k):
    return max(0.0, min(1.0, state.get(k, 1.0)))


def detached(st, k):
    """True when a breakable part is gone (its own health or its parent's is 0)."""
    c = COMPONENTS[k]
    if c.get("detach") and _h(st, k) <= 0.0:
        return True
    par = c.get("parent")
    return bool(par) and detached(st, par)


def effective_state(state):
    """Health per component after propagation: a part whose parent broke off is gone too."""
    st = {k: _h(state, k) for k in COMPONENTS}
    for k in st:
        if detached(st, k):
            st[k] = 0.0
    return st


def load_hitboxes(path=JSON_PATH):
    if not os.path.exists(path):
        return {k: v["box"] for k, v in COMPONENTS.items() if "box" in v}
    with open(path) as f:
        data = json.load(f)
    out = {}
    for k, c in data.get("components", {}).items():
        hb = c.get("hitbox")
        if hb:
            out[k] = (tuple(hb["centre"]), tuple(hb["half"]), hb.get("yaw_deg", 0.0), hb.get("roll_deg", 0.0))
    return out


def _to_box(p, box):
    (cx, cs, cz), (hx, hs, hz), yaw = box[0], box[1], box[2]
    roll = box[3] if len(box) > 3 else 0.0
    dx, ds, dz = p[0] - cx, p[1] - cs, p[2] - cz
    cy, sy = math.cos(math.radians(-yaw)), math.sin(math.radians(-yaw))
    x1, s1 = dx * cy - ds * sy, dx * sy + ds * cy
    cr, sr = math.cos(math.radians(-roll)), math.sin(math.radians(-roll))
    x2, z2 = x1 * cr - dz * sr, x1 * sr + dz * cr
    return x2, s1, z2, hx, hs, hz


def point_in_box(p, box):
    x, s, z, hx, hs, hz = _to_box(p, box)
    return abs(x) <= hx and abs(s) <= hs and abs(z) <= hz


def box_distance(p, box):
    x, s, z, hx, hs, hz = _to_box(p, box)
    dx, ds, dz = max(abs(x) - hx, 0.0), max(abs(s) - hs, 0.0), max(abs(z) - hz, 0.0)
    return math.sqrt(dx * dx + ds * ds + dz * dz)


def box_volume(box):
    return 8.0 * box[1][0] * box[1][1] * box[1][2]


def components_at(point, hitboxes=None):
    hb = hitboxes or load_hitboxes()
    inside = [k for k, b in hb.items() if point_in_box(point, b)]
    return sorted(inside, key=lambda k: box_volume(hb[k]))


def apply_hit(state, point, damage_hp, hitboxes=None):
    """Point impact: the smallest (innermost) box takes 70 %, the others share 30 %."""
    st = dict(state)
    comps = components_at(point, hitboxes)
    if not comps:
        return st, []
    shares = [0.7] + [0.3 / max(1, len(comps) - 1)] * (len(comps) - 1) if len(comps) > 1 else [1.0]
    for k, w in zip(comps, shares):
        st[k] = max(0.0, _h(st, k) - w * damage_hp / COMPONENTS[k]["hp"])
    return st, comps


def apply_blast(state, centre, damage_hp, radius, hitboxes=None):
    """Proximity blast: damage falls off linearly with distance to each box."""
    st = dict(state)
    hb = hitboxes or load_hitboxes()
    hit = []
    for k, b in hb.items():
        d = box_distance(centre, b)
        if d < radius:
            dmg = damage_hp * (1.0 - d / radius)
            st[k] = max(0.0, _h(st, k) - dmg / COMPONENTS[k]["hp"])
            hit.append((k, round(dmg, 1)))
    return st, hit


# --------------------------------------------------------------- evaluate
def _thrust_multiplier(st):
    he = _h(st, "engine")
    core = 0.0 if he < 0.15 else he ** 1.2
    air = 0.5 * (_h(st, "inlet_L") ** 0.8 + _h(st, "inlet_R") ** 0.8)
    air_f = air ** 1.3
    noz = 0.8 + 0.2 * _h(st, "nozzle")
    feed = 1.0 if _h(st, "fuel_feed") >= 0.25 else 0.5
    return core * air_f * noz * feed, _h(st, "nozzle") > 0.5 and he > 0.4


def _lift_sections(st):
    """[(share, arm_signed)] for every lifting section incl. body."""
    secs = [(BODY_LIFT * (0.6 + 0.4 * _h(st, "center_fuselage")), 0.0)]
    for tag, sd in (("L", 1), ("R", -1)):
        root_h = _h(st, f"wing_root_{tag}")
        outer_h = _h(st, f"wing_outer_{tag}") if root_h > 0.05 else 0.0
        secs.append((PANEL_LIFT * ROOT_SHARE * (0.35 + 0.65 * root_h) if root_h > 0.05 else 0.0, sd * ROOT_ARM))
        secs.append((PANEL_LIFT * OUTER_SHARE * outer_h, sd * OUTER_ARM))
    return secs


def _roll_budget(st):
    tot = 0.0
    for tag in ("L", "R"):
        wing_ok = _h(st, f"wing_root_{tag}") > 0.05
        tot += ROLL_POWER["flaperon"] * _h(st, f"flaperon_{tag}") * (1.0 if wing_ok else 0.0)
        tot += ROLL_POWER["stab"] * _h(st, f"stab_{tag}")
        tot += ROLL_POWER["rudder"] * _h(st, f"fin_{tag}")
        tot += ROLL_POWER["lef"] * _h(st, f"lef_{tag}") * _h(st, f"wing_outer_{tag}")
    if _h(st, "ipp") < 0.3:          # EHAs fall back to the battery: reduced rates/authority
        tot *= 0.6
    return tot


def fuel_state(st, minutes=0.0, burn_kg_min=0.0):
    """Fuel per tank after `minutes` of flight since the damage.

    A tank inside a part that broke off is lost at once.  A damaged tank
    leaks (rate grows with the damage); the engine burn is drawn evenly
    from the tanks that still hold fuel (the fuel system keeps the
    aircraft balanced, it cannot correct for a leak).
    """
    frac = SPEC["ref_fuel_fraction"]
    tanks = {name: cap * frac for name, cap in FUEL_TANKS.items()}
    leaks, lost = {}, 0.0
    for k, c in COMPONENTS.items():
        if "fuel" not in c:
            continue
        tank, _ = c["fuel"]
        if detached(st, k):
            lost += tanks[tank]
            tanks[tank] = 0.0
            leaks[tank] = 0.0
            continue
        loss = 1.0 - _h(st, k)
        leaks[tank] = 55.0 * loss ** 1.5 * (FUEL_TANKS[tank] / 1600.0) ** 0.5 if loss > 0.02 else 0.0
    # integrate in 1-minute steps so leaks stop when a tank runs dry
    t = 0.0
    while t < minutes - 1e-9:
        dt = min(1.0, minutes - t)
        for tank, r in leaks.items():
            tanks[tank] = max(0.0, tanks[tank] - r * dt)
        full = [n for n, v in tanks.items() if v > 0.0]
        if full:
            share = burn_kg_min * dt / len(full)
            for n in full:
                tanks[n] = max(0.0, tanks[n] - share)
        t += dt
    return tanks, {k: (v if tanks[k] > 0 else 0.0) for k, v in leaks.items()}, lost


def lost_mass(st):
    """Structural mass (kg) of the parts that broke off and its lateral moment (kg m, + = left)."""
    m, mom = 0.0, 0.0
    for k, c in COMPONENTS.items():
        if c.get("mass") and detached(st, k):
            m += c["mass"]
            mom += c["mass"] * c.get("arm", 0.0) * c["side"]
    return m, mom


GROUND_ATTITUDE = {}      # filled from data/damage_model.json (measured on the Blender mesh)


def ground_attitude(st):
    """Resting attitude on the ground when gear legs collapse (roll + = left wing down)."""
    roll = pitch = 0.0
    for k, att in GROUND_ATTITUDE.items():
        if _h(st, k) < 0.25:
            roll += att.get("roll_deg", 0.0)
            pitch += att.get("pitch_deg", 0.0)
    return {"roll_deg": round(roll, 1), "pitch_deg": round(pitch, 1)}


def evaluate(state, mach=0.80, alt_m=6000.0, minutes=0.0):
    """All aircraft attributes for a damage state at a flight condition.

    minutes = time flown at that condition since the damage (fuel burn + leaks).
    """
    st = effective_state(state)
    out = {}
    S, b = SPEC["wing_area_m2"], SPEC["span_m"]
    m_lost, m_mom = lost_mass(st)
    # ---- drag increments from damage (holes, missing parts, open/broken panels)
    extra = 0.0
    for k, c in COMPONENTS.items():
        if "drag" in c:
            loss = 1.0 - st[k]
            extra += c["drag"] * min(1.0, loss * 1.6) * (0.6 if detached(st, k) else 1.0)
    # ---- lift
    secs = _lift_sections(st)
    lift_frac = sum(sh for sh, _ in secs) / (BODY_LIFT + 2 * PANEL_LIFT)
    clmax = SPEC["cl_max"] * lift_frac
    for tag in ("L", "R"):
        clmax -= 0.5 * COMPONENTS[f"lef_{tag}"]["clmax"] * (1 - st[f"lef_{tag}"])
        clmax -= 0.5 * COMPONENTS[f"flaperon_{tag}"]["clmax"] * (1 - st[f"flaperon_{tag}"])
    clmax = max(0.15, clmax)
    k_mult = 1.0 / max(0.3, lift_frac) ** 1.5      # less span -> more induced drag
    # ---- thrust
    tmult, ab_ok = _thrust_multiplier(st)
    # ---- fuel and mass (burn at the evaluated condition, thrust = drag)
    m0 = SPEC["empty_kg"] - m_lost + SPEC["ref_stores_kg"] + SPEC["ref_fuel_fraction"] * SPEC["internal_fuel_kg"]
    burn = cruise_fuel_flow(m0 * G0, tmult, extra, k_mult, mach, alt_m) / 60.0
    tanks, leaks, fuel_lost = fuel_state(st, minutes, burn)
    fuel = sum(tanks.values())
    mass = SPEC["empty_kg"] - m_lost + fuel + SPEC["ref_stores_kg"]
    W = mass * G0
    out["thrust_dry_kN_SL"] = round(SPEC["thrust_dry_kN"] * tmult, 1)
    out["thrust_ab_kN_SL"] = round(SPEC["thrust_ab_kN"] * tmult, 1) if ab_ok else None
    out["thrust_percent"] = round(100.0 * tmult)
    out["afterburner_available"] = ab_ok
    out["thrust_to_weight"] = round((SPEC["thrust_ab_kN"] if ab_ok else SPEC["thrust_dry_kN"]) * 1000 * tmult / W, 3)
    # ---- structure / limits
    struct = 1.0
    for k, c in COMPONENTS.items():
        if "structure" in c and not detached(st, k):
            struct = min(struct, 1.0 - c["structure"] * (1.0 - st[k]) ** 0.8)
    struct = max(0.0, struct)
    q_lim_f = 1.0
    for k, c in COMPONENTS.items():
        if "q_limit" in c and st[k] < 1.0:
            q_lim_f = min(q_lim_f, 1.0 - (1.0 - c["q_limit"]) * (1.0 - st[k]))
    if any(detached(st, k) for k in st):
        q_lim_f = min(q_lim_f, 0.85)
    mach_lim = SPEC["mach_limit"] * (0.75 + 0.25 * struct)
    for k, c in COMPONENTS.items():           # placards for damaged / missing surfaces
        if "mach_limit" in c and st[k] < 1.0:
            f = min(1.0, 1.5 * (1.0 - st[k]))
            mach_lim = min(mach_lim, SPEC["mach_limit"] - (SPEC["mach_limit"] - c["mach_limit"]) * f)
    pitch_auth = 0.5 * (st["stab_L"] + st["stab_R"])
    g_struct = SPEC["g_max"] * max(0.15, struct)
    g_ctrl = 1.0 + (SPEC["g_max"] - 1.0) * pitch_auth ** 1.2
    out["g_limit"] = round(max(1.0, min(g_struct, g_ctrl)), 2)
    out["mach_placard"] = round(mach_lim, 2)

    # ---- max speeds
    def vmax_at(h):
        m_thr = max_mach_thrust(h, W, tmult, True, ab_ok, extra, k_mult, clmax) if tmult > 0 else None
        _, p, rho, a = isa(h)
        q_max = kcas_to_q(SPEC["vmax_kcas"]) * q_lim_f
        m_q = math.sqrt(q_max / (0.7 * p))
        if m_thr is None:
            return None, "cannot hold level flight"
        m = min(m_thr, mach_lim, m_q)
        why = "thrust" if m == m_thr else ("Mach limit" if m == mach_lim else "q / KCAS limit")
        return m, why
    out["max_mach_11km"], out["max_mach_11km_limited_by"] = vmax_at(11000.0)
    out["max_mach_SL"], out["max_mach_SL_limited_by"] = vmax_at(0.0)
    m_dry = max_mach_thrust(11000.0, W, tmult, False, ab_ok, extra, k_mult, clmax) if tmult > 0 else None
    out["max_mach_dry_11km"] = None if m_dry is None else round(min(m_dry, mach_lim), 3)
    for k in ("max_mach_11km", "max_mach_SL"):
        out[k] = None if out[k] is None else round(out[k], 3)
    out["max_speed_kmh_11km"] = None if out["max_mach_11km"] is None else round(out["max_mach_11km"] * isa(11000.0)[3] * 3.6)
    out["max_speed_kmh_SL"] = None if out["max_mach_SL"] is None else round(out["max_mach_SL"] * isa(0.0)[3] * 3.6)
    # ---- stall / minimum speed (sea level)
    vs = math.sqrt(2 * W / (1.225 * S * clmax))
    out["cl_max"] = round(clmax, 3)
    out["stall_speed_kt_SL"] = round(vs / 0.514444, 1)
    # ---- roll balance at the requested flight condition
    roll = roll_trim(st, secs, W, mach, alt_m, tanks, m_mom, clmax)
    out.update(roll)
    out["v_min_control_kt_SL"] = min_control_speed(st, secs, W, tanks, m_mom, clmax)
    # ---- directional stability
    cnb = SPEC["cn_beta_body"] + 0.11 * (st["fin_L"] + st["fin_R"])
    out["cn_beta_per_rad"] = round(cnb, 3)
    out["aoa_limit_deg"] = round(SPEC["aoa_max_deg"] if cnb > 0.10 else (25.0 if cnb > 0.01 else 12.0), 1)
    out["directionally_stable"] = cnb > 0.0
    out["departure_risk"] = ("high" if (cnb <= 0.0 or not out["controllable"]) else
                             "moderate" if (cnb < 0.10 or (out.get("roll_control_used") or 0) > 0.6) else "low")
    out["pitch_authority"] = round(pitch_auth, 2)
    out["roll_authority"] = round(_roll_budget(st) / _roll_budget(intact_state()), 2)
    # ---- fuel and mass
    out["fuel_kg"] = round(fuel)
    out["fuel_lost_with_parts_kg"] = round(fuel_lost)
    out["fuel_leak_kg_min"] = round(sum(leaks.values()), 1)
    out["fuel_burn_kg_min"] = round(burn, 1)
    out["fuel_lateral_imbalance_kg"] = round(tanks["wing_L"] - tanks["wing_R"])
    out["structure_lost_kg"] = round(m_lost)
    out["mass_kg"] = round(mass)
    rate = burn + out["fuel_leak_kg_min"]
    out["endurance_min"] = round(0.9 * fuel / rate, 1) if rate > 0 and fuel > 0 else 0.0
    # ---- systems
    sysv = {}
    for k, c in COMPONENTS.items():
        for sname in c.get("systems", []):
            sysv[sname] = min(sysv.get(sname, 1.0), st[k])
    systems = {sname: v > 0.5 for sname, v in sorted(sysv.items())}
    systems["afterburner"] = ab_ok
    systems["engine_running"] = tmult > 0.0
    systems["flight_controls_power"] = "IPP / 270 V DC" if st["ipp"] >= 0.3 else "battery (limited)"
    systems["fire"] = (st["engine"] < 0.5 and st["fuel_feed"] < 0.6) or st["engine"] < 0.2
    out["systems"] = systems
    out["ground_attitude"] = ground_attitude(st)
    out["missing_parts"] = sorted(k for k in st if detached(st, k))
    return out


def cruise_fuel_flow(W, tmult, extra, k_mult, M=0.85, h=10000.0):
    """kg/h at thrust = drag (dry power) for the given condition."""
    if tmult <= 0:
        return 0.0
    D, _, _ = drag(M, h, W, extra, 1.0, k_mult)
    return D * SPEC["tsfc_dry_kg_per_Nh"]


def _asym_cl(st, secs, W, q, tanks, m_mom=0.0):
    """Rolling-moment coefficient to be trimmed (+ = rolls right, towards -x)."""
    S, b = SPEC["wing_area_m2"], SPEC["span_m"]
    tot = sum(sh for sh, _ in secs)
    CL = W / (q * S)
    # the FCS raises AoA so the remaining surfaces carry the full lift
    mom = sum((sh / tot) * arm for sh, arm in secs) * CL      # + = left wing lifts more -> rolls right
    d_cl = mom / b
    fuel_m = (tanks["wing_L"] - tanks["wing_R"]) * G0 * WING_FUEL_ARM   # heavier left wing -> rolls left
    d_cl -= fuel_m / (q * S * b)
    d_cl += m_mom * G0 / (q * S * b)                           # mass lost on the left -> rolls right
    return d_cl, CL


def roll_trim(st, secs, W, mach, alt, tanks, m_mom=0.0, clmax=None):
    """Lateral balance in straight flight.  The FCS trims the asymmetry with
    up to `trim_reserve` of its roll authority; the rest is balanced with a
    sideslip (dihedral effect) which, to keep flying straight, needs a bank
    angle: the aircraft settles 'tilted' towards the damaged side.  If even
    full control + max sideslip cannot hold it, it rolls off continuously."""
    _, p, rho, a = isa(alt)
    V = mach * a
    q = 0.5 * rho * V * V
    d_cl, CL = _asym_cl(st, secs, W, q, tanks, m_mom)
    budget = _roll_budget(st)
    res = {"flight_condition": f"M{mach:.2f} at {alt / 1000:.1f} km", "required_CL": round(CL, 3),
           "asymmetric_Cl": round(d_cl, 5), "roll_control_budget_Cl": round(budget, 5)}
    mag = abs(d_cl)
    sign = 1.0 if d_cl > 0 else -1.0                 # +: rolls right (towards -x)
    side = "none" if mag < 3e-4 else ("right" if sign > 0 else "left")
    clb = abs(SPEC["cl_beta"])
    bmax = math.radians(SPEC["beta_max_deg"])
    reserve = SPEC["trim_reserve"]
    ctrl = min(mag, reserve * budget)
    rest = mag - ctrl
    beta = min(rest / clb, bmax)
    rest -= beta * clb
    if rest > 1e-9:
        extra_ctrl = min(rest, (1 - reserve) * budget)
        ctrl += extra_ctrl
        rest -= extra_ctrl
    controllable = rest <= 1e-9
    stalled = CL > (clmax if clmax is not None else SPEC["cl_max"])
    phi = 0.0
    if beta > 0 and not stalled:
        # side force of the sideslip balanced by tilting the lift: tan(phi) = Y / W
        phi = math.degrees(math.atan(abs(SPEC["cy_beta"]) * beta / max(CL, 1e-3)))
    res["roll_control_used"] = round(ctrl / budget, 2) if budget > 0 else None
    res["sideslip_deg"] = round(math.degrees(beta), 2)
    res["tilt_towards"] = side
    res["stalled"] = stalled
    res["controllable"] = controllable and not stalled
    if not controllable:
        p_rate = rest / abs(SPEC["clp"]) * 2 * V / SPEC["span_m"]
        res["tilt_bank_deg"] = None
        res["roll_off_rate_deg_s"] = round(math.degrees(p_rate), 1)
        res["bank_after_1s_deg"] = round(min(180.0, math.degrees(p_rate) * 0.6), 1)
    else:
        res["tilt_bank_deg"] = round(phi, 1)          # wing down on the 'tilt_towards' side
        res["roll_off_rate_deg_s"] = 0.0
        avail = budget - ctrl
        pmax = avail / abs(SPEC["clp"]) * 2 * V / SPEC["span_m"]
        res["max_roll_rate_deg_s"] = round(min(math.degrees(pmax), 250.0), 1)
    return res


def min_control_speed(st, secs, W, tanks, m_mom=0.0, clmax=None):
    """Lowest sea-level speed (kt) where 1 g flight and the lateral balance can be held."""
    for kt in range(80, 801, 5):
        V = kt * 0.514444
        M = V / 340.29
        r = roll_trim(st, secs, W, M, 0.0, tanks, m_mom, clmax)
        if r["controllable"]:
            return kt
    return None


# ------------------------------------------------------------------ export
def export_json(hitboxes=None, path=JSON_PATH, extra=None):
    """Write the model (spec, components, hitboxes, intact attributes) for other tools."""
    hb = hitboxes or {k: v["box"] for k, v in COMPONENTS.items() if "box" in v}
    data = {"aircraft": "F-35I Adir (F-35A derivative)",
            "units": "SI; aircraft axes x = left, s = aft of the nose tip, z = up (Blender: y = s - 7.835)",
            "spec": SPEC, "calibration": dict(CAL), "components": {}}
    for k, c in COMPONENTS.items():
        d = {kk: vv for kk, vv in c.items() if kk not in ("box",)}
        if k in hb:
            b = hb[k]
            d["hitbox"] = {"centre": [round(x, 4) for x in b[0]], "half": [round(x, 4) for x in b[1]],
                           "yaw_deg": round(b[2], 2), "roll_deg": round(b[3] if len(b) > 3 else 0.0, 2)}
        data["components"][k] = d
    if extra:
        data.update(extra)
    if extra and extra.get("lift_split"):
        set_lift_split(extra["lift_split"])
    if extra and extra.get("ground_attitude"):
        GROUND_ATTITUDE.update(extra["ground_attitude"])
    data["intact_attributes"] = evaluate(intact_state())
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=1)
    return path


def load_model_data(path=JSON_PATH):
    """Pick up what the Blender build measured (lift split, gear-collapse attitude)."""
    if not os.path.exists(path):
        return False
    with open(path) as f:
        data = json.load(f)
    set_lift_split(data.get("lift_split"))
    GROUND_ATTITUDE.update(data.get("ground_attitude", {}))
    return True


SCENARIOS = {
    "intact": {},
    "outer_left_wing_lost": {"wing_outer_L": 0.0},
    "left_wing_lost": {"wing_outer_L": 0.0, "wing_root_L": 0.0, "lef_L": 0.0, "flaperon_L": 0.0},
    "engine_power_50pct": {"engine": round(0.5 ** (1 / 1.2), 4)},
    "engine_power_75pct": {"engine": round(0.75 ** (1 / 1.2), 4)},
    "right_inlet_destroyed": {"inlet_R": 0.0},
    "nozzle_damaged_no_ab": {"nozzle": 0.3},
    "left_fin_lost": {"fin_L": 0.0},
    "both_fins_lost": {"fin_L": 0.0, "fin_R": 0.0},
    "left_stabilator_lost": {"stab_L": 0.0},
    "right_wing_tank_leak_20min": {"wing_root_R": 0.55},
    "ipp_failure": {"ipp": 0.0},
    "radome_shot_off": {"radome": 0.0},
    "left_main_gear_collapsed": {"main_gear_L": 0.0},
    "cockpit_hit_pilot_wounded": {"cockpit": 0.6, "pilot": 0.4},
}

SCENARIO_MINUTES = {"right_wing_tank_leak_20min": 20.0}


def run_scenario(name, mach=0.8, alt=6000.0, minutes=0.0):
    st = intact_state()
    st.update(SCENARIOS[name])
    minutes = SCENARIO_MINUTES.get(name, minutes)
    return evaluate(st, mach, alt, minutes)


load_model_data()
calibrate()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--scenario", choices=sorted(SCENARIOS), help="predefined damage scenario")
    ap.add_argument("--set", nargs="*", default=[], help="component=health pairs, e.g. engine=0.5")
    ap.add_argument("--mach", type=float, default=0.8)
    ap.add_argument("--alt", type=float, default=6000.0, help="altitude (m)")
    ap.add_argument("--minutes", type=float, default=0.0, help="time since damage (fuel leaks)")
    ap.add_argument("--blast", nargs=5, type=float, metavar=("X", "S", "Z", "HP", "RADIUS"),
                    help="apply a proximity blast at (x, s, z) with damage HP and radius (m)")
    ap.add_argument("--list", action="store_true", help="list components")
    ap.add_argument("--all", action="store_true", help="run every predefined scenario")
    a = ap.parse_args()
    if a.list:
        for k, c in COMPONENTS.items():
            print(f"{k:18s} hp={c['hp']:4d}  {c['label']}")
        return
    if a.all:
        for n in SCENARIOS:
            print(n, json.dumps(run_scenario(n, a.mach, a.alt), indent=None))
        return
    st = intact_state()
    if a.scenario:
        st.update(SCENARIOS[a.scenario])
    for kv in a.set:
        k, v = kv.split("=")
        st[k] = float(v)
    if a.blast:
        st, hit = apply_blast(st, a.blast[:3], a.blast[3], a.blast[4])
        print("blast hit:", hit)
    print(json.dumps(evaluate(st, a.mach, a.alt, a.minutes), indent=1))


if __name__ == "__main__":
    main()
