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
{
  let x = 0, t = 0;
  for (; t < 0.3 - 1e-9; t += DT) x = keyRamp(x, 1, DT);
  const tap = x;
  for (; x < 1; t += DT) x = keyRamp(x, 1, DT);
  // a 0.3 s tap used to be 0.78 of full stick (20 deg of bank, or 5 g)
  check('keyboard: a 0.3 s tap', tap > 0.3 && tap < 0.5, `${tap.toFixed(2)} of full stick`);
  check('keyboard: full stick when held', t > 0.45 && t < 0.7, `after ${t.toFixed(2)} s`);
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
