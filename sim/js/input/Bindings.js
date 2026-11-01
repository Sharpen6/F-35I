// Joystick / HOTAS / gamepad bindings: the bindable actions, the defaults for gamepads with the
// browser's "standard" layout, and the per-device bindings the player sets up in the binding
// screen (js/ui/BindingsUI.js), kept in localStorage.
//
// A binding is one of
//   {type: 'axis',   index, invert}            an axis action (pitch, roll, yaw, throttle, brake)
//   {type: 'button', index}                    a button (value > 0.5 = pressed)
//   {type: 'axisdir', index, dir: 1 | -1}      a button action on one side of an axis (> 0.5)
//   {type: 'pov',    index, dir: 'up'|...}     one direction of a POV hat that the browser
//                                              reports as a single axis (-1 = up ... 1, rest 1.29)
// Throttle axes are absolute: the lever position is the throttle (0.75 = MIL).

const STORAGE_KEY = 'f35i.bindings.v1';

/** Axis actions: id, label, and the move the binding screen asks for (defines the + direction). */
export const AXIS_ACTIONS = [
  { id: 'pitch', label: 'Pitch', prompt: 'pull the stick back (nose up)' },
  { id: 'roll', label: 'Roll', prompt: 'move the stick to the right' },
  { id: 'yaw', label: 'Rudder and nose wheel', prompt: 'push the right pedal (or twist right)' },
  { id: 'throttle', label: 'Throttle lever', prompt: 'move the throttle to full power' },
  { id: 'brake', label: 'Wheel brakes (axis)', prompt: 'press the brakes fully' },
];

/** Button actions (edges unless noted as held). */
export const BUTTON_ACTIONS = [
  { id: 'gearToggle', label: 'Landing gear up / down' },
  { id: 'brakes', label: 'Wheel brakes (hold)' },
  { id: 'parkingBrakeToggle', label: 'Parking brake' },
  { id: 'canopyToggle', label: 'Canopy open / close' },
  { id: 'speedbrakeToggle', label: 'Speed brake' },
  { id: 'throttleUp', label: 'Throttle up (hold)' },
  { id: 'throttleDown', label: 'Throttle down (hold)' },
  { id: 'cameraNext', label: 'Next camera' },
  { id: 'cameraPrev', label: 'Previous camera' },
  { id: 'lookUp', label: 'Look up (hat)' },
  { id: 'lookDown', label: 'Look down (hat)' },
  { id: 'lookLeft', label: 'Look left (hat)' },
  { id: 'lookRight', label: 'Look right (hat)' },
  { id: 'lookCenter', label: 'Look ahead' },
  { id: 'hmdToggle', label: 'Helmet display on / off' },
  { id: 'lightsToggle', label: 'Exterior lights' },
  { id: 'pause', label: 'Pause / menu' },
  { id: 'reset', label: 'Restart at the start point' },
];

/** Held (not edge) button actions. */
export const HELD_ACTIONS = new Set(['brakes', 'throttleUp', 'throttleDown', 'lookUp', 'lookDown', 'lookLeft', 'lookRight']);

/**
 * Defaults for a gamepad with mapping === 'standard' (Xbox / PlayStation layout):
 * left stick pitch and roll, right stick X rudder, right stick Y and the triggers throttle,
 * A brakes, X canopy, Y gear, B speed brake, bumpers camera, d-pad head look,
 * L3 parking brake, R3 look ahead, View/Back HMD, Menu/Start pause.
 */
export const STANDARD_GAMEPAD = {
  axes: {
    roll: { type: 'axis', index: 0, invert: false },
    pitch: { type: 'axis', index: 1, invert: false },   // stick back = +1 = pull
    yaw: { type: 'axis', index: 2, invert: false },
  },
  // throttle on a self-centring stick or trigger is a rate, not a position (handled in Input)
  throttleRate: { stickAxis: 3, upTrigger: 7, downTrigger: 6 },
  buttons: {
    brakes: { type: 'button', index: 0 },
    speedbrakeToggle: { type: 'button', index: 1 },
    canopyToggle: { type: 'button', index: 2 },
    gearToggle: { type: 'button', index: 3 },
    cameraPrev: { type: 'button', index: 4 },
    cameraNext: { type: 'button', index: 5 },
    hmdToggle: { type: 'button', index: 8 },
    pause: { type: 'button', index: 9 },
    parkingBrakeToggle: { type: 'button', index: 10 },
    lookCenter: { type: 'button', index: 11 },
    lookUp: { type: 'button', index: 12 },
    lookDown: { type: 'button', index: 13 },
    lookLeft: { type: 'button', index: 14 },
    lookRight: { type: 'button', index: 15 },
  },
};

/** Defaults for any other joystick until it is bound: stick X roll, stick Y pitch. */
export const GENERIC_JOYSTICK = {
  axes: {
    roll: { type: 'axis', index: 0, invert: false },
    pitch: { type: 'axis', index: 1, invert: false },
  },
  buttons: {},
};

/** POV hat reported as one axis (Chrome / Windows): 8 directions from -1 in steps of 2/7. */
const POV_DIRS = ['up', 'up-right', 'right', 'down-right', 'down', 'down-left', 'left', 'up-left'];
export function povDirection(v) {
  if (!(v >= -1.05 && v <= 1.05)) return null;          // rest value is about 1.29
  const i = Math.round((v + 1) * 3.5);
  return POV_DIRS[((i % 8) + 8) % 8];
}
/** Does a POV value point (also diagonally) in direction dir ('up' | 'down' | 'left' | 'right')? */
export function povHas(v, dir) {
  const d = povDirection(v);
  return !!d && d.split('-').includes(dir);
}

function safeStorage() {
  try { return window.localStorage; } catch (e) { return null; }
}

export class Bindings {
  constructor() {
    this.devices = {};                  // gamepad id -> {axes: {}, buttons: {}}
    // light expo: the F-35I's flight control system already softens the stick around the centre
    this.tuning = { deadzone: 0.08, expo: 0.15, invertKeyboardPitch: false };
    this.load();
  }

  load() {
    const ls = safeStorage();
    if (!ls) return;
    try {
      const raw = JSON.parse(ls.getItem(STORAGE_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        this.devices = raw.devices && typeof raw.devices === 'object' ? raw.devices : {};
        Object.assign(this.tuning, raw.tuning || {});
      }
    } catch (e) {
      this.devices = {};
    }
  }

  save() {
    const ls = safeStorage();
    if (!ls) return;
    try { ls.setItem(STORAGE_KEY, JSON.stringify({ devices: this.devices, tuning: this.tuning })); } catch (e) { /* quota / private mode */ }
  }

  /** Bindings the player made for this device, or null. */
  custom(padId) {
    return this.devices[padId] || null;
  }

  /** Effective bindings for a pad: custom ones, else the standard or generic defaults. */
  forPad(pad) {
    const c = this.devices[pad.id];
    if (c) return { ...c, custom: true };
    return pad.mapping === 'standard' ? { ...STANDARD_GAMEPAD, custom: false } : { ...GENERIC_JOYSTICK, custom: false };
  }

  /** Start custom bindings for a device from its defaults (so binding one action keeps the rest). */
  ensure(pad) {
    if (!this.devices[pad.id]) {
      const base = pad.mapping === 'standard' ? STANDARD_GAMEPAD : GENERIC_JOYSTICK;
      this.devices[pad.id] = JSON.parse(JSON.stringify({ axes: base.axes, buttons: base.buttons, throttleRate: base.throttleRate || null }));
    }
    return this.devices[pad.id];
  }

  setAxis(pad, action, binding) {
    const d = this.ensure(pad);
    // an axis drives one action only
    for (const [k, b] of Object.entries(d.axes)) if (b && binding && b.index === binding.index && k !== action) delete d.axes[k];
    if (binding) d.axes[action] = binding; else delete d.axes[action];
    // a bound throttle lever replaces the gamepad throttle-rate controls on that axis
    if (d.throttleRate && binding && d.throttleRate.stickAxis === binding.index) d.throttleRate.stickAxis = -1;
    this.save();
  }

  setButton(pad, action, binding) {
    const d = this.ensure(pad);
    if (binding) {
      // one physical control per button action; clear others on the same control
      for (const [k, b] of Object.entries(d.buttons)) {
        if (k !== action && b && b.type === binding.type && b.index === binding.index && (b.dir || 0) === (binding.dir || 0)) delete d.buttons[k];
      }
      d.buttons[action] = binding;
    } else {
      delete d.buttons[action];
    }
    this.save();
  }

  resetDevice(padId) {
    delete this.devices[padId];
    this.save();
  }

  setTuning(patch) {
    Object.assign(this.tuning, patch);
    this.save();
  }
}

/** Human-readable text for a binding. */
export function describeBinding(b) {
  if (!b) return '-';
  if (b.type === 'axis') return `axis ${b.index}${b.invert ? ' (inverted)' : ''}`;
  if (b.type === 'button') return `button ${b.index}`;
  if (b.type === 'axisdir') return `axis ${b.index} ${b.dir > 0 ? '+' : '-'}`;
  if (b.type === 'pov') return `hat (axis ${b.index}) ${b.dir}`;
  return '?';
}
