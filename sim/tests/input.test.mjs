// Input tests: the keyboard, mouse-stick and gamepad behaviour of js/input/Input.js, in node with a
// stand-in window / document / navigator (no browser).
//   node sim/tests/input.test.mjs          (from the repo root; exit code 1 if any check fails)
//
// Each check names the problem it guards against (the flight-track review, November 2026).

const listeners = {};
const on = (k) => (type, fn) => { (listeners[k + type] = listeners[k + type] || []).push(fn); };
globalThis.window = { addEventListener: on('w'), removeEventListener() {}, localStorage: null };
globalThis.document = { addEventListener: on('d'), removeEventListener() {}, pointerLockElement: null };
const pads = [];
Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => pads }, configurable: true });
const dom = { addEventListener: on('e'), removeEventListener() {}, requestPointerLock() {} };

const { Input, keyRamp } = await import('../js/input/Input.js');
const inp = new Input(dom);
const key = (type, code, extra = {}) => (listeners['w' + type] || []).forEach((fn) => fn({
  code, key: '', target: null, repeat: false, preventDefault() {}, shiftKey: false, ctrlKey: false, ...extra,
}));
const DT = 1 / 60;
let passed = 0, failed = 0;
function check(name, cond, info) {
  if (cond) passed++; else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}: ${info}`);
}
const run = (n) => { let f; for (let i = 0; i < n; i++) f = inp.update(DT); return f; };

// ---- keyboard stick: a tap is a small correction, a held key reaches full stick quickly
// (what a press does to the jet, bank and g, is checked in fdm.test.mjs "keyboard stick")
{
  let x = 0, t = 0, press = 0;
  for (; t < 0.3 - 1e-9; t += DT) x = keyRamp(x, 1, DT);
  const tap = x;
  for (; t < 0.4 - 1e-9; t += DT) x = keyRamp(x, 1, DT);
  press = x;
  for (; x < 1; t += DT) x = keyRamp(x, 1, DT);
  // a 0.3 s tap used to be 0.78 of full stick (20 deg of bank, or 5 g); then a 0.4 s press was
  // still 0.68 (the second stage rose at 3 /s)
  check('keyboard: a 0.3 s tap', tap > 0.3 && tap < 0.4, `${tap.toFixed(2)} of full stick`);
  check('keyboard: a 0.4 s press', press > 0.4 && press < 0.5, `${press.toFixed(2)} of full stick`);
  check('keyboard: full stick when held', t > 0.6 && t < 0.75, `after ${t.toFixed(2)} s`);
  let back = 0;
  for (x = 1; x > 0; back += DT) x = keyRamp(x, 0, DT);
  check('keyboard: back to centre when released', back < 0.25, `${back.toFixed(2)} s`);
}

// ---- Ctrl + B (throttle down and brake): it used to put the throttle back and lock it
{
  inp.setLevers({ throttle: 0.6, gearDown: true, parkingBrake: false });
  inp.update(DT);
  key('keydown', 'ControlLeft', { ctrlKey: true });
  run(30);
  key('keydown', 'KeyB', { ctrlKey: true });
  const brake = inp.update(DT).brake;
  run(30);
  const held = inp.levers.throttle;
  key('keyup', 'KeyB'); key('keyup', 'ControlLeft');
  run(2);
  check('Ctrl + B: the throttle keeps coming back, the brakes are on', held < 0.15 && Math.abs(inp.levers.throttle - held) < 1e-9 && brake === 1,
    `throttle 0.60 -> ${held.toFixed(2)} (stays ${inp.levers.throttle.toFixed(2)}), brake ${brake}`);
  // Shift + B is a shortcut: Shift must not move the throttle then
  inp.setLevers({ throttle: 0.4, gearDown: true, parkingBrake: false });
  key('keydown', 'ShiftLeft', { shiftKey: true });
  run(6);
  key('keydown', 'KeyB', { shiftKey: true });
  inp.update(DT);
  key('keyup', 'KeyB'); key('keyup', 'ShiftLeft');
  run(6);
  check('Shift + B: parking brake, throttle unchanged', inp.levers.parkingBrake === true && Math.abs(inp.levers.throttle - 0.4) < 1e-9,
    `parking brake ${inp.levers.parkingBrake}, throttle ${inp.levers.throttle.toFixed(3)}`);
}

// ---- R: at once when stopped or crashed; in flight it must be held (a stray press ended the flight)
{
  inp.resetNeedsHold = false;
  key('keydown', 'KeyR');
  const now = inp.update(DT).reset;
  key('keyup', 'KeyR');
  inp.update(DT);
  check('R when stopped: restart at once', now === true, `reset ${now}`);
  inp.resetNeedsHold = true;
  key('keydown', 'KeyR');
  const f = inp.update(DT);
  const hint = f.resetHint, early = f.reset;
  let fired = -1;
  for (let n = 0; n < 40 && fired < 0; n++) if (inp.update(DT).reset) fired = n;
  key('keyup', 'KeyR');
  inp.update(DT);
  check('R tapped in flight: a hint, no restart', hint && !early && fired < 0, `hint ${hint}, restart ${fired < 0 ? 'none' : `after ${fired} frames`}`);
  key('keydown', 'KeyR');
  inp.update(DT);
  fired = -1;
  for (let n = 1; n < 120 && fired < 0; n++) if (inp.update(DT).reset) fired = n;
  key('keyup', 'KeyR');
  inp.update(DT);
  check('R held in flight: restart after a second', fired * DT > 0.9 && fired * DT < 1.1, `after ${(fired * DT).toFixed(2)} s`);
}

// ---- A: the 50 deg high-AoA mode had no key
{
  key('keydown', 'KeyA'); const a = inp.update(DT).highAoA; key('keyup', 'KeyA');
  key('keydown', 'KeyA'); const b = inp.update(DT).highAoA; key('keyup', 'KeyA');
  check('A: high-AoA mode on / off', a === true && b === false, `${a} -> ${b}`);
}

// ---- Y: the auto-throttle; any throttle input hands the throttle back to the pilot.  It was T:
// Ctrl + T (Ctrl is "throttle down") opens a browser tab, which a page cannot cancel.
{
  inp.setLevers({ throttle: 0.3, apc: true });
  const spawned = inp.update(DT).apc;
  key('keydown', 'Equal'); inp.update(DT); key('keyup', 'Equal');
  const afterKey = inp.levers.apc;
  key('keydown', 'KeyY'); const on = inp.update(DT).apc; key('keyup', 'KeyY');
  key('keydown', 'KeyT'); const t = inp.update(DT).apc; key('keyup', 'KeyT');
  key('keydown', 'KeyY'); const off = inp.update(DT).apc; key('keyup', 'KeyY');
  check('auto-throttle: on from the spawn, Y toggles it (T does nothing), the throttle keys take over', spawned && !afterKey && on && t && !off,
    `spawn ${spawned}, after = ${afterKey}, Y ${on}, T ${t}, Y ${off}`);
  // fullscreen: the Keyboard Lock API keeps Ctrl + W / T / N / Tab / Page Up / Page Down in the page
  let locked = null, unlocked = false;
  navigator.keyboard = { lock: (keys) => { locked = keys; return Promise.resolve(); }, unlock: () => { unlocked = true; } };
  document.fullscreenElement = {};
  (listeners.dfullscreenchange || []).forEach((fn) => fn());
  document.fullscreenElement = null;
  (listeners.dfullscreenchange || []).forEach((fn) => fn());
  const want = ['KeyW', 'KeyT', 'KeyN', 'Tab', 'PageUp', 'PageDown'];
  check('fullscreen: browser Ctrl shortcuts locked to the page, released after', !!locked && want.every((k) => locked.includes(k)) && unlocked,
    `locked ${locked ? locked.join(' ') : 'nothing'}, unlocked ${unlocked}`);
  delete navigator.keyboard;
}

// ---- HOTAS throttle lever: soft takeover.  It used to take the throttle wherever it was, so a
// nudge with the auto-throttle on (here flying 45 %, the lever left at idle) cut it to idle.
{
  const stick = {
    index: 1, id: 'test HOTAS throttle', mapping: '', connected: true, axes: [0, 0, -1],
    buttons: Array.from({ length: 4 }, () => ({ pressed: false, value: 0 })),
  };
  inp.bindings.devices[stick.id] = { axes: { throttle: { type: 'axis', index: 2, invert: false } }, buttons: {} };
  pads.push(stick);
  const lever = (x) => { stick.axes[2] = 2 * x - 1; };
  // the auto-throttle flies the throttle (main.js writes the engine command into the lever)
  const apcFrames = (n, thr) => { let f; for (let i = 0; i < n; i++) { if (inp.levers.apc) inp.levers.throttle = thr(i); f = inp.update(DT); } return f; };
  inp.setLevers({ throttle: 0.45, gearDown: true, apc: true });
  lever(0); apcFrames(10, () => 0.45);
  lever(0.05); apcFrames(10, () => 0.45);
  const nudged = { thr: inp.levers.throttle, apc: inp.levers.apc, shown: inp.leverMismatch };
  check('HOTAS: a nudge with the auto-throttle on does not move the throttle; the HMD shows the lever',
    Math.abs(nudged.thr - 0.45) < 1e-9 && nudged.apc && Math.abs(nudged.shown - 0.05) < 1e-6,
    `throttle ${nudged.thr.toFixed(3)}, auto-throttle ${nudged.apc}, lever shown ${nudged.shown}`);
  // the auto-throttle's command passing a lever at rest does not pick it up
  lever(0.40); apcFrames(40, () => 0.45);
  apcFrames(30, (i) => 0.45 - 0.004 * i);
  check('HOTAS: the throttle passing a lever at rest leaves the auto-throttle on', inp.levers.apc && inp.leverMismatch !== null,
    `auto-throttle ${inp.levers.apc}, throttle ${inp.levers.throttle.toFixed(3)}, lever shown ${inp.leverMismatch}`);
  // moved up through the throttle: picks it up there and the auto-throttle is off
  inp.levers.throttle = 0.45;
  let pick = null;
  for (let x = 0.40; x <= 0.62 + 1e-9; x += 0.03) {
    lever(x);
    const was = inp.levers.throttle;
    apcFrames(1, () => 0.45);
    if (!pick && !inp.levers.apc) pick = { from: was, to: inp.levers.throttle };
  }
  apcFrames(5, () => 0.45);
  check('HOTAS: moved through the throttle it takes over there, then follows the lever',
    pick && Math.abs(pick.to - pick.from) < 0.04 && Math.abs(inp.levers.throttle - 0.61) < 0.011 && inp.leverMismatch === null,
    pick ? `picked up at ${pick.to.toFixed(3)} (throttle was ${pick.from.toFixed(3)}), now ${inp.levers.throttle.toFixed(3)}, lever shown ${inp.leverMismatch}` : 'never picked up');
  // the keys move the throttle: the lever lets go until it is moved through the throttle again
  key('keydown', 'ShiftLeft', { shiftKey: true }); run(20); key('keyup', 'ShiftLeft');
  const keyed = inp.levers.throttle;
  lever(0.64); run(5);
  check('HOTAS: after the throttle keys the lever must pick the throttle up again', keyed > 0.7 && Math.abs(inp.levers.throttle - keyed) < 1e-9 && Math.abs(inp.leverMismatch - 0.64) < 1e-9,
    `keys -> ${keyed.toFixed(3)}, lever 0.64 -> throttle ${inp.levers.throttle.toFixed(3)}, lever shown ${inp.leverMismatch}`);
  // go-around: pushed up through the MIL detent it takes over at once
  inp.setLevers({ throttle: 0.45, gearDown: true, apc: true });
  lever(0.6); apcFrames(30, () => 0.45);
  for (const x of [0.66, 0.72, 0.78, 0.84, 0.9, 0.96, 1]) { lever(x); apcFrames(1, () => 0.45); }
  check('HOTAS: pushed through the MIL detent (go-around) it takes over at once', !inp.levers.apc && inp.levers.throttle === 1,
    `auto-throttle ${inp.levers.apc}, throttle ${inp.levers.throttle.toFixed(3)}`);
  pads.length = 0;
  delete inp.bindings.devices[stick.id];
  inp.update(DT);
}

// ---- standard gamepad: right stick (rudder X, throttle Y) and L3
{
  const pad = {
    index: 0, id: 'test pad (standard)', mapping: 'standard', connected: true, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
  pads.push(pad);
  inp.setLevers({ throttle: 0.5, gearDown: true, parkingBrake: false });
  inp.update(DT);
  // a rudder push that is not quite straight used to move the throttle too
  pad.axes[2] = 0.5; pad.axes[3] = -0.35;
  inp.update(DT);
  pad.axes[2] = 0.7; pad.axes[3] = -0.75;
  let thr = inp.levers.throttle;
  let f = run(30);
  check('right stick: rudder first, the throttle stays', f.yaw > 0.4 && Math.abs(inp.levers.throttle - thr) < 1e-9,
    `rudder ${f.yaw.toFixed(2)}, throttle ${thr.toFixed(2)} -> ${inp.levers.throttle.toFixed(2)}`);
  pad.axes[2] = 0; pad.axes[3] = 0;
  inp.update(DT);
  pad.axes[2] = 0.3; pad.axes[3] = -0.8;
  thr = inp.levers.throttle;
  f = run(30);
  check('right stick: throttle first, no rudder', f.yaw === 0 && inp.levers.throttle > thr + 0.1,
    `rudder ${f.yaw.toFixed(2)}, throttle ${thr.toFixed(2)} -> ${inp.levers.throttle.toFixed(2)}`);
  pad.axes[2] = 0; pad.axes[3] = 0;
  inp.update(DT);
  const press = () => {
    pad.buttons[10] = { pressed: true, value: 1 };
    const t = inp.update(DT).highAoAToggle;
    pad.buttons[10] = { pressed: false, value: 0 };
    inp.update(DT);
    return t;
  };
  inp.airborne = false;
  let pb = inp.levers.parkingBrake;
  press();
  check('L3 on the ground: parking brake', inp.levers.parkingBrake !== pb && !inp.levers.highAoA,
    `parking brake ${pb} -> ${inp.levers.parkingBrake}, high-AoA ${inp.levers.highAoA}`);
  inp.airborne = true;
  pb = inp.levers.parkingBrake;
  const t = press();
  check('L3 in the air: high-AoA mode', t && inp.levers.parkingBrake === pb && inp.levers.highAoA,
    `parking brake ${pb} -> ${inp.levers.parkingBrake}, high-AoA ${inp.levers.highAoA}`);
  pads.length = 0;
  inp.update(DT);
}

// ---- mouse stick: a deadzone at the centre, and roll springs back once the mouse rests
{
  inp.mouseStick = true;
  inp._locked = true;                   // as if the pointer were locked to the view
  inp.setLevers({ throttle: 0.5 });
  inp.mouseStickPos.x = 0.04; inp.mouseStickPos.y = 0.03;
  let f = inp.update(DT);
  check('mouse stick: centred inside the deadzone', f.pitch === 0 && f.roll === 0, `pitch ${f.pitch}, roll ${f.roll}`);
  inp.mouseStickPos.x = 0.6; inp.mouseStickPos.y = 0.3; inp._mouseIdle = 0;
  const roll = inp.update(DT).roll;
  f = run(40);
  check('mouse stick: roll springs back, pitch stays', roll > 0.5 && Math.abs(f.roll) < 1e-9 && f.pitch > 0.2,
    `roll ${roll.toFixed(2)} -> ${f.roll.toFixed(2)}, pitch ${f.pitch.toFixed(2)}`);
  inp.bindings.tuning.mouseRollReturn = false;
  inp.mouseStickPos.x = 0.6; inp._mouseIdle = 0;
  f = run(40);
  check('mouse stick: roll stays where it is with the spring off', f.roll > 0.5, `roll ${f.roll.toFixed(2)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
