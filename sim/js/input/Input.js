// Input: keyboard, mouse (head look, zoom, optional mouse stick), gamepads with the standard
// layout, and any joystick / HOTAS through the player's bindings (js/input/Bindings.js).
//
//   const input = new Input(renderer.domElement);
//   const f = input.update(dt);    // every frame
//   fdm.step(h, f);                // f has the FlightModel inputs (sim/DESIGN.md):
//     pitch, roll, yaw (-1..1, + = pull / right / right), throttle (0..1, 0.75 = MIL),
//     brake (0..1), parkingBrake, gearHandle (true = down), canopy (true = open), nwsEnable,
//     speedbrake (0..1)
//   and the edges of this frame (true once per press): gearToggle, canopyToggle, cameraNext,
//   cameraPrev, camera (1..5 or 0), pause, reset, hmdToggle, help, lightsToggle,
//   landingLightToggle, mute, timeEarlier, timeLater, parkingBrakeToggle, speedbrakeToggle,
//   lookCenter, fullscreen, menuBack; plus head look: lookX / lookY (rates -1..1 from hats and
//   the numpad), dragX / dragY (mouse drag in px this frame), wheel (scroll steps this frame).
//
// The levers (throttle, gear handle, parking brake, canopy, speed brake) live here; the app
// may veto a change by writing input.levers back (e.g. the gear handle is locked on the ground).
//
// Throttle: Shift / Ctrl, + / -, gamepad triggers or right stick move it; it stops at the MIL
// detent (0.75): keep holding (0.5 s) or press again to go into afterburner (and the same on the
// way back). Page Up = full afterburner, Page Down = idle. A bound HOTAS lever sets it directly.

import { Bindings, STANDARD_GAMEPAD, HELD_ACTIONS, povHas, povDirection } from './Bindings.js';

const MIL = 0.75;
const THROTTLE_RATE = 0.55;          // lever travel per second at full key / trigger
const DETENT_HOLD = 0.5;             // s of holding at the MIL detent before it lets go
const KEY_RISE = 2.6;                // keyboard stick: deflection per s while held
const KEY_RETURN = 5.0;              // ... and back to centre when released
const LOOK_KEYS = { Numpad8: [0, 1], Numpad2: [0, -1], Numpad4: [-1, 0], Numpad6: [1, 0] };

/** Keys this module uses: their browser defaults are suppressed while flying. */
const OWN_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyZ', 'KeyX', 'KeyB', 'KeyG', 'KeyC', 'KeyL',
  'KeyH', 'KeyV', 'KeyM', 'KeyP', 'KeyR', 'KeyS', 'KeyF', 'PageUp', 'PageDown', 'Home', 'F1',
  'BracketLeft', 'BracketRight', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'Slash',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Numpad8', 'Numpad2', 'Numpad4', 'Numpad6',
  'Numpad5', 'Space', 'Tab',
]);
const THR_UP_KEYS = new Set(['ShiftLeft', 'ShiftRight', 'Equal', 'NumpadAdd']);
const THR_DOWN_KEYS = new Set(['ControlLeft', 'ControlRight', 'Minus', 'NumpadSubtract']);
const MODIFIERS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight']);

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const approach = (x, target, rate) => (x < target ? Math.min(target, x + rate) : Math.max(target, x - rate));

/** Deadzone (rescaled so the output starts at 0) and expo (cubic blend) for a stick axis. */
export function shapeAxis(v, deadzone, expo) {
  const a = Math.abs(v);
  if (a <= deadzone) return 0;
  const x = Math.min(1, (a - deadzone) / (1 - deadzone));
  return Math.sign(v) * ((1 - expo) * x + expo * x * x * x);
}

const EDGE_NAMES = ['gearToggle', 'canopyToggle', 'cameraNext', 'cameraPrev', 'pause', 'reset', 'hmdToggle',
  'help', 'lightsToggle', 'landingLightToggle', 'mute', 'timeEarlier', 'timeLater', 'parkingBrakeToggle',
  'speedbrakeToggle', 'lookCenter', 'fullscreen', 'menuBack', 'confirm'];

export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.bindings = new Bindings();
    /** false while a menu has the keyboard (flight keys are then ignored). */
    this.enabled = true;
    /** Mouse stick: the mouse (pointer locked to the view) moves a virtual stick. */
    this.mouseStick = false;
    this.mouseStickPos = { x: 0, y: 0 };
    this.levers = { throttle: 0, gearHandle: true, parkingBrake: true, canopy: false, speedbrake: false, nwsEnable: true };
    this.detent = { hold: 0, t: 0 };     // at the MIL detent: +1 stopped going up, -1 going down
    this.kb = { pitch: 0, roll: 0, yaw: 0 };
    this.keys = new Set();
    this.lastDevice = 'keyboard';
    this.padStatus = [];                 // [{index, id, standard, custom}] for the UI
    this._queue = [];                    // key / mouse edges since the last update
    this._drag = { active: false, button: -1, dx: 0, dy: 0 };
    this._wheel = 0;
    this._modUsed = new Map();           // modifier code -> {throttleAtPress, used}
    this._padPrev = new Map();           // pad index -> {buttons: bool[], axes: number[]}
    this._throttleAxisLast = new Map();  // pad id -> last absolute lever value
    this._capture = null;                // binding capture {kind, pad, rest, callback}
    this._trigPrev = { up: false, down: false };
    this._wasEnabled = true;
    this._quietPads = false;             // one frame without pad edges after a menu closes / opens

    this.frame = {
      pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, parkingBrake: true, gearHandle: true, canopy: false,
      nwsEnable: true, speedbrake: 0, camera: 0, lookX: 0, lookY: 0, dragX: 0, dragY: 0, wheel: 0, dragButton: -1,
    };
    for (const k of EDGE_NAMES) this.frame[k] = false;

    this._onKeyDown = (e) => this._keyDown(e);
    this._onKeyUp = (e) => this._keyUp(e);
    this._onBlur = () => { this.keys.clear(); this._drag.active = false; this._modUsed.clear(); };
    this._onMouseDown = (e) => this._mouseDown(e);
    this._onMouseUp = (e) => { if (e.button === this._drag.button) this._drag.active = false; };
    this._onMouseMove = (e) => this._mouseMove(e);
    this._onWheel = (e) => this._mouseWheel(e);
    this._onContext = (e) => e.preventDefault();
    this._onLockChange = () => { if (document.pointerLockElement !== this.dom) this._locked = false; else this._locked = true; };
    window.addEventListener('keydown', this._onKeyDown, { capture: true });
    window.addEventListener('keyup', this._onKeyUp, { capture: true });
    window.addEventListener('blur', this._onBlur);
    domElement.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    domElement.addEventListener('wheel', this._onWheel, { passive: false });
    domElement.addEventListener('contextmenu', this._onContext);
    document.addEventListener('pointerlockchange', this._onLockChange);
    this._locked = false;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown, { capture: true });
    window.removeEventListener('keyup', this._onKeyUp, { capture: true });
    window.removeEventListener('blur', this._onBlur);
    this.dom.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    this.dom.removeEventListener('wheel', this._onWheel);
    this.dom.removeEventListener('contextmenu', this._onContext);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }

  /** Put the levers where the flight model set them up (after reset(spawn)). */
  setLevers({ throttle, gearDown, parkingBrake, canopy, speedbrake } = {}) {
    const L = this.levers;
    if (throttle != null) L.throttle = clamp(+throttle, 0, 1);
    if (gearDown != null) L.gearHandle = !!gearDown;
    if (parkingBrake != null) L.parkingBrake = !!parkingBrake;
    if (canopy != null) L.canopy = !!canopy;
    if (speedbrake != null) L.speedbrake = !!speedbrake;
    this.detent.hold = 0;
    this.kb.pitch = this.kb.roll = this.kb.yaw = 0;
    this.mouseStickPos.x = this.mouseStickPos.y = 0;
    this._throttleAxisLast.clear();
  }

  /** Mouse stick on/off; with it on, clicking the view captures the mouse (Esc releases it). */
  setMouseStick(on) {
    this.mouseStick = !!on;
    this.mouseStickPos.x = this.mouseStickPos.y = 0;
    if (!on && document.pointerLockElement === this.dom) document.exitPointerLock?.();
  }

  get pointerLocked() { return this._locked; }

  // ------------------------------------------------------------------------------ keyboard
  _keyDown(e) {
    const code = e.code;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') && code !== 'Escape') return;
    if (this._capture && code === 'Escape') { this.cancelCapture(); e.preventDefault(); return; }
    // menus own the keyboard: only Escape (close / back) and F1 get through
    if (!this.enabled) {
      if (code === 'Escape') { this._queue.push('menuBack'); e.preventDefault(); }
      if (code === 'F1') { this._queue.push('help'); e.preventDefault(); }
      if (code === 'KeyP' && !e.repeat) this._queue.push('pause');
      if ((code === 'Enter' || code === 'NumpadEnter') && !e.repeat) this._queue.push('confirm');
      return;
    }
    // a modifier pressed with another key is a modifier, not a throttle move: undo what it did
    if (!MODIFIERS.has(code)) {
      for (const [mod, m] of this._modUsed) {
        if (!m.used && this.keys.has(mod) && (code === 'KeyB' || code === 'KeyL' || code === 'KeyV' || code === 'Slash')) {
          m.used = true;
          this.levers.throttle = m.throttleAtPress;
          this.detent.hold = m.holdAtPress;
        }
      }
    }
    if (MODIFIERS.has(code) && !e.repeat) {
      this._modUsed.set(code, { throttleAtPress: this.levers.throttle, holdAtPress: this.detent.hold, used: false });
    }
    if (OWN_KEYS.has(code) || MODIFIERS.has(code) || code === 'Escape' || e.ctrlKey) {
      // keep the browser out (F1 help, Ctrl+P print, space scroll, ...); not Ctrl+Shift+I / F12 / F5
      if (!(e.ctrlKey && e.shiftKey && code === 'KeyI') && code !== 'F12' && code !== 'F5' && code !== 'F11') e.preventDefault();
    }
    if (THR_UP_KEYS.has(code) && !e.repeat) this._queue.push('thrUpPress');
    if (THR_DOWN_KEYS.has(code) && !e.repeat) this._queue.push('thrDownPress');
    this.keys.add(code);
    this.lastDevice = 'keyboard';

    const shift = e.shiftKey;
    const q = (name) => this._queue.push(name);
    if (e.repeat) {
      // only the time-of-day keys repeat
      if (code === 'BracketLeft') q('timeEarlier');
      if (code === 'BracketRight') q('timeLater');
      return;
    }
    switch (code) {
      case 'KeyG': q('gearToggle'); break;
      case 'KeyC': q('canopyToggle'); break;
      case 'KeyB': if (shift) q('parkingBrakeToggle'); break;
      case 'KeyL': q(shift ? 'landingLightToggle' : 'lightsToggle'); break;
      case 'KeyH': q('hmdToggle'); break;
      case 'F1': q('help'); break;
      case 'Slash': if (shift || e.key === '?') q('help'); break;
      case 'BracketLeft': q('timeEarlier'); break;
      case 'BracketRight': q('timeLater'); break;
      case 'KeyV': q(shift ? 'cameraPrev' : 'cameraNext'); break;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5':
        this._queue.push('cam' + code.slice(5)); break;
      case 'KeyM': q('mute'); break;
      case 'KeyP': case 'Escape': q('pause'); break;
      case 'KeyR': q('reset'); break;
      case 'KeyS': q('speedbrakeToggle'); break;
      case 'KeyF': q('fullscreen'); break;
      case 'Home': case 'Numpad5': q('lookCenter'); break;
      case 'PageUp': q('throttleMax'); break;
      case 'PageDown': q('throttleIdle'); break;
      case 'Enter': case 'NumpadEnter': q('confirm'); break;
      default: if (e.key === '?') q('help');
    }
  }

  _keyUp(e) {
    this.keys.delete(e.code);
    if (MODIFIERS.has(e.code)) this._modUsed.delete(e.code);
  }

  // ------------------------------------------------------------------------------ mouse
  _mouseDown(e) {
    if (this.mouseStick && !this._locked && e.button === 0 && this.enabled) {
      this.dom.requestPointerLock?.();
      return;
    }
    if (e.button === 1) { this._queue.push('lookCenter'); e.preventDefault(); return; }
    // left or right drag: head look / orbit (right only while the mouse flies the jet)
    if (e.button === 2 || (e.button === 0 && !(this.mouseStick && this._locked))) {
      this._drag.active = true;
      this._drag.button = e.button;
    }
  }

  _mouseMove(e) {
    if (this.mouseStick && this._locked && this.enabled) {
      const s = 0.22 * Math.min(window.innerWidth, window.innerHeight);
      const p = this.mouseStickPos;
      p.x += e.movementX / s;
      p.y += e.movementY / s;              // mouse down (towards you) = pull
      const r = Math.hypot(p.x, p.y);
      if (r > 1) { p.x /= r; p.y /= r; }
      this.lastDevice = 'mouse';
    }
    if (this._drag.active) {
      this._drag.dx += e.movementX;
      this._drag.dy += e.movementY;
    }
  }

  _mouseWheel(e) {
    e.preventDefault();
    const steps = e.deltaMode === 1 ? e.deltaY / 3 : e.deltaMode === 2 ? e.deltaY : e.deltaY / 100;
    this._wheel += clamp(steps, -5, 5);
  }

  // ------------------------------------------------------------------------------ gamepads
  /** Connected gamepads (snapshot objects from the Gamepad API). */
  gamepads() {
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    const out = [];
    for (const p of list) if (p && p.connected !== false) out.push(p);
    return out;
  }

  /**
   * Binding capture: calls back with the next axis moved or button pressed on any pad.
   * kind 'axis': {pad, index, sign} (sign of the move from rest); kind 'button': {pad, binding}.
   */
  startCapture(kind, callback) {
    const rest = new Map();
    for (const p of this.gamepads()) rest.set(p.index, { axes: [...p.axes], buttons: p.buttons.map((b) => b.pressed || b.value > 0.5) });
    this._capture = { kind, callback, rest, t0: performance.now() };
  }

  cancelCapture() {
    if (this._capture) { const c = this._capture; this._capture = null; c.callback(null); }
  }

  get capturing() { return !!this._capture; }

  _pollCapture() {
    const c = this._capture;
    if (!c) return;
    if (performance.now() - c.t0 < 250) return;     // ignore the click that started it
    for (const p of this.gamepads()) {
      let r = c.rest.get(p.index);
      if (!r) { r = { axes: [...p.axes], buttons: p.buttons.map((b) => b.pressed || b.value > 0.5) }; c.rest.set(p.index, r); continue; }
      if (c.kind === 'button') {
        for (let i = 0; i < p.buttons.length; i++) {
          const down = p.buttons[i].pressed || p.buttons[i].value > 0.5;
          if (down && !r.buttons[i]) { this._capture = null; c.callback({ pad: p, binding: { type: 'button', index: i } }); return; }
        }
      }
      for (let i = 0; i < p.axes.length; i++) {
        const v = p.axes[i], v0 = r.axes[i];
        if (!Number.isFinite(v) || !Number.isFinite(v0)) continue;
        if (c.kind === 'button') {
          // POV hat on one axis: rest outside [-1, 1], directions inside
          if (Math.abs(v0) > 1.05 && Math.abs(v) <= 1.05) {
            const d = povDirection(v);
            if (d && !d.includes('-')) { this._capture = null; c.callback({ pad: p, binding: { type: 'pov', index: i, dir: d } }); return; }
            continue;
          }
          if (Math.abs(v - v0) > 0.6 && Math.abs(v) > 0.5) {
            this._capture = null; c.callback({ pad: p, binding: { type: 'axisdir', index: i, dir: Math.sign(v) } }); return;
          }
        } else if (Math.abs(v - v0) > 0.5 && Math.abs(v0) <= 1.05) {
          this._capture = null; c.callback({ pad: p, index: i, sign: Math.sign(v - v0), rest: v0 }); return;
        }
      }
    }
  }

  /** Reads one binding as a held button. */
  _held(pad, b) {
    if (!b) return false;
    if (b.type === 'button') { const x = pad.buttons[b.index]; return !!x && (x.pressed || x.value > 0.5); }
    if (b.type === 'axisdir') { const v = pad.axes[b.index]; return Number.isFinite(v) && v * b.dir > 0.5; }
    if (b.type === 'pov') { return povHas(pad.axes[b.index], b.dir); }
    return false;
  }

  _pollPads(dt, out) {
    const pads = this.gamepads();
    const tun = this.bindings.tuning;
    const seen = new Set();
    this.padStatus = [];
    let thrRate = 0, upPress = false, downPress = false;
    for (const pad of pads) {
      seen.add(pad.index);
      const B = this.bindings.forPad(pad);
      this.padStatus.push({ index: pad.index, id: pad.id, standard: pad.mapping === 'standard', custom: !!B.custom });
      let prev = this._padPrev.get(pad.index);
      if (!prev || prev.id !== pad.id) { prev = { id: pad.id, held: {} }; this._padPrev.set(pad.index, prev); }
      let active = false;
      // stick axes
      for (const name of ['pitch', 'roll', 'yaw']) {
        const b = B.axes && B.axes[name];
        if (!b) continue;
        let v = pad.axes[b.index];
        if (!Number.isFinite(v)) continue;
        if (b.invert) v = -v;
        v = shapeAxis(v, tun.deadzone, name === 'yaw' ? tun.expo * 0.5 : tun.expo);
        if (v !== 0) active = true;
        out[name] += v;
      }
      // absolute throttle lever (HOTAS): it wins whenever it moves
      const tb = B.axes && B.axes.throttle;
      if (tb && Number.isFinite(pad.axes[tb.index])) {
        let v = pad.axes[tb.index];
        if (tb.invert) v = -v;
        const lever = clamp((v + 1) / 2, 0, 1);
        const last = this._throttleAxisLast.get(pad.id);
        if (last === undefined || Math.abs(lever - last) > 0.015) {
          if (last !== undefined) { this.levers.throttle = lever; this.detent.hold = 0; active = true; }
          this._throttleAxisLast.set(pad.id, lever);
        }
      }
      // brake axis (toe brakes): resting end = 0
      const bb = B.axes && B.axes.brake;
      if (bb && Number.isFinite(pad.axes[bb.index])) {
        let v = pad.axes[bb.index];
        if (bb.invert) v = -v;
        out.brake = Math.max(out.brake, clamp((v + 1) / 2, 0, 1) > 0.05 ? clamp((v + 1) / 2, 0, 1) : 0);
      }
      // gamepad throttle as a rate: right stick Y and the triggers
      const tr = B.throttleRate !== undefined ? B.throttleRate : (pad.mapping === 'standard' ? STANDARD_GAMEPAD.throttleRate : null);
      if (tr) {
        if (tr.stickAxis >= 0 && Number.isFinite(pad.axes[tr.stickAxis])) {
          const v = -shapeAxis(pad.axes[tr.stickAxis], Math.max(0.15, tun.deadzone), 0);
          if (v !== 0) { thrRate += v; active = true; }
        }
        const up = pad.buttons[tr.upTrigger], dn = pad.buttons[tr.downTrigger];
        const uv = up ? (up.value || (up.pressed ? 1 : 0)) : 0, dv = dn ? (dn.value || (dn.pressed ? 1 : 0)) : 0;
        if (uv > 0.08) { thrRate += uv; active = true; if (!this._trigPrev.up) upPress = true; }
        if (dv > 0.08) { thrRate -= dv; active = true; if (!this._trigPrev.down) downPress = true; }
        this._trigPrev.up = uv > 0.08;
        this._trigPrev.down = dv > 0.08;
      }
      // buttons
      const btns = B.buttons || {};
      for (const [action, b] of Object.entries(btns)) {
        const h = this._held(pad, b);
        const was = !!prev.held[action];
        prev.held[action] = h;
        if (h) active = true;
        if (HELD_ACTIONS.has(action)) {
          if (!h) continue;
          if (action === 'brakes') out.brake = 1;
          else if (action === 'throttleUp') { thrRate += 1; if (!was) upPress = true; }
          else if (action === 'throttleDown') { thrRate -= 1; if (!was) downPress = true; }
          else if (action === 'lookUp') out.lookY += 1;
          else if (action === 'lookDown') out.lookY -= 1;
          else if (action === 'lookLeft') out.lookX -= 1;
          else if (action === 'lookRight') out.lookX += 1;
        } else if (h && !was && !this._quietPads) {
          this._padEdge(action, out);
        }
      }
      if (active) this.lastDevice = pad.mapping === 'standard' ? 'gamepad' : 'joystick';
    }
    for (const k of [...this._padPrev.keys()]) if (!seen.has(k)) this._padPrev.delete(k);
    return { thrRate, upPress, downPress };
  }

  _padEdge(action, out) {
    // while the game is paused or in a menu, the pad navigates instead (see main.js)
    if (action in out) out[action] = true;
    if (action === 'pause') out.pause = true;
  }

  // ------------------------------------------------------------------------------ throttle
  _moveThrottle(rate, dt, upPress, downPress) {
    const L = this.levers, D = this.detent;
    let t = L.throttle;
    const atDetent = Math.abs(t - MIL) < 1e-6;
    // a fresh press in the held direction lets the lever through the detent at once
    if (atDetent && ((D.hold > 0 && upPress) || (D.hold < 0 && downPress))) { D.hold = 0; D.t = 0; }
    if (rate === 0) { D.t = 0; return; }
    const target = t + rate * THROTTLE_RATE * dt;
    if (rate > 0 && t < MIL - 1e-6 && target >= MIL) { t = MIL; D.hold = 1; D.t = 0; }
    else if (rate < 0 && t > MIL + 1e-6 && target <= MIL) { t = MIL; D.hold = -1; D.t = 0; }
    else if (atDetent && D.hold !== 0 && Math.sign(rate) === D.hold) {
      D.t += dt;
      if (D.t >= DETENT_HOLD) { D.hold = 0; D.t = 0; t = clamp(target, 0, 1); }
    } else {
      t = clamp(target, 0, 1);
      if (!atDetent) D.hold = 0;
    }
    L.throttle = t;
  }

  // ------------------------------------------------------------------------------ per frame
  update(dt) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    const f = this.frame;
    for (const k of EDGE_NAMES) f[k] = false;
    f.camera = 0;
    f.lookX = f.lookY = 0;
    f.brake = 0;

    this._pollCapture();
    this._quietPads = this.enabled !== this._wasEnabled;
    if (this._quietPads) {
      // a menu opened or closed: buttons held through the switch must not fire again
      for (const pr of this._padPrev.values()) {
        for (const k of Object.keys(pr.held)) pr.held[k] = true;
      }
      this._trigPrev.up = this._trigPrev.down = true;
    }
    this._wasEnabled = this.enabled;

    // keyboard stick, rudder, brakes, look
    const K = this.keys;
    const on = this.enabled;
    let tp = 0, tr = 0, ty = 0;
    if (on) {
      const inv = this.bindings.tuning.invertKeyboardPitch ? -1 : 1;
      if (K.has('ArrowDown')) tp += inv;
      if (K.has('ArrowUp')) tp -= inv;
      if (K.has('ArrowRight')) tr += 1;
      if (K.has('ArrowLeft')) tr -= 1;
      if (K.has('KeyX')) ty += 1;
      if (K.has('KeyZ')) ty -= 1;
      if (K.has('KeyB') && !K.has('ShiftLeft') && !K.has('ShiftRight')) f.brake = 1;
      for (const [code, [x, y]] of Object.entries(LOOK_KEYS)) if (K.has(code)) { f.lookX += x; f.lookY += y; }
    }
    const kb = this.kb;
    kb.pitch = approach(kb.pitch, tp, (tp !== 0 && Math.sign(tp) === Math.sign(kb.pitch) ? KEY_RISE : KEY_RETURN) * dt);
    kb.roll = approach(kb.roll, tr, (tr !== 0 && Math.sign(tr) === Math.sign(kb.roll) ? KEY_RISE : KEY_RETURN) * dt);
    kb.yaw = approach(kb.yaw, ty, (ty !== 0 && Math.sign(ty) === Math.sign(kb.yaw) ? KEY_RISE * 0.8 : KEY_RETURN) * dt);
    f.pitch = kb.pitch;
    f.roll = kb.roll;
    f.yaw = kb.yaw;

    // queued key / mouse edges
    let upPress = false, downPress = false;
    for (const e of this._queue) {
      if (e === 'thrUpPress') upPress = true;
      else if (e === 'thrDownPress') downPress = true;
      else if (e === 'throttleMax') { this.levers.throttle = 1; this.detent.hold = 0; }
      else if (e === 'throttleIdle') { this.levers.throttle = 0; this.detent.hold = 0; }
      else if (e.startsWith('cam')) f.camera = +e.slice(3);
      else if (e in f) f[e] = true;
    }
    this._queue.length = 0;

    // gamepads and joysticks (add to the keyboard)
    const pad = on ? this._pollPads(dt, f) : { thrRate: 0, upPress: false, downPress: false };
    if (!on) { this._pollPadsMenu(f); }

    // mouse stick
    if (this.mouseStick && this._locked && on) {
      f.pitch += this.mouseStickPos.y;
      f.roll += this.mouseStickPos.x;
    }
    f.pitch = clamp(f.pitch, -1, 1);
    f.roll = clamp(f.roll, -1, 1);
    f.yaw = clamp(f.yaw, -1, 1);
    f.lookX = clamp(f.lookX, -1, 1);
    f.lookY = clamp(f.lookY, -1, 1);

    // throttle lever
    let rate = pad.thrRate;
    if (on) {
      for (const k of THR_UP_KEYS) if (K.has(k) && !(this._modUsed.get(k) || {}).used) { rate += 1; break; }
      for (const k of THR_DOWN_KEYS) if (K.has(k) && !(this._modUsed.get(k) || {}).used) { rate -= 1; break; }
    }
    this._moveThrottle(clamp(rate, -1, 1), dt, upPress || pad.upPress, downPress || pad.downPress);

    // lever toggles that need no veto
    const L = this.levers;
    if (f.parkingBrakeToggle) L.parkingBrake = !L.parkingBrake;
    if (f.speedbrakeToggle) L.speedbrake = !L.speedbrake;
    if (f.gearToggle) L.gearHandle = !L.gearHandle;      // the app may put it back
    if (f.canopyToggle) L.canopy = !L.canopy;            // the app may put it back

    f.throttle = L.throttle;
    f.parkingBrake = L.parkingBrake;
    f.gearHandle = L.gearHandle;
    f.canopy = L.canopy;
    f.speedbrake = L.speedbrake ? 1 : 0;
    f.nwsEnable = L.nwsEnable;

    // mouse drag and wheel
    f.dragX = this._drag.dx;
    f.dragY = this._drag.dy;
    f.dragButton = this._drag.active ? this._drag.button : -1;
    this._drag.dx = this._drag.dy = 0;
    f.wheel = this._wheel;
    this._wheel = 0;
    return f;
  }

  /** In menus a gamepad navigates: A confirms, B / Start go back. */
  _pollPadsMenu(f) {
    for (const pad of this.gamepads()) {
      let prev = this._padPrev.get(pad.index);
      if (!prev || prev.id !== pad.id) { prev = { id: pad.id, held: {} }; this._padPrev.set(pad.index, prev); }
      const read = (i) => { const b = pad.buttons[i]; return !!b && (b.pressed || b.value > 0.5); };
      const map = pad.mapping === 'standard' ? { confirm: 0, menuBack: 1, pause: 9, reset: 3 } : {};
      for (const [name, i] of Object.entries(map)) {
        const h = read(i), was = !!prev.held['menu_' + name];
        prev.held['menu_' + name] = h;
        if (h && !was && !this._quietPads) f[name] = true;
      }
    }
  }
}
