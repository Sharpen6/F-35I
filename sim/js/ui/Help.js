// Controls help (the F1 / ? overlay and the README's table come from the same list).

export const CONTROLS = [
  {
    title: 'Flying (keyboard)',
    rows: [
      ['<kbd>&darr;</kbd> / <kbd>&uarr;</kbd>', 'pull (nose up) / push (nose down): a tap is a small correction; held on, it is full stick after about 0.7 s'],
      ['<kbd>&larr;</kbd> / <kbd>&rarr;</kbd>', 'roll left / right'],
      ['<kbd>Z</kbd> / <kbd>X</kbd>', 'rudder and nose-wheel steering left / right'],
      ['<kbd>Shift</kbd> / <kbd>Ctrl</kbd> or <kbd>+</kbd> / <kbd>-</kbd>', 'throttle up / down; it stops at MIL: hold on or press again for afterburner'],
      ['<kbd>Page Up</kbd> / <kbd>Page Down</kbd>', 'full afterburner / idle'],
      ['<kbd>Y</kbd>', 'auto-throttle on / off: with the gear down in the air it flies the approach AoA (13 deg) with the throttle; any throttle input takes over (on at the 10 km final start)'],
      ['<kbd>B</kbd> (hold)', 'wheel brakes (with <kbd>Ctrl</kbd> held too: throttle back and brakes)'],
      ['<kbd>Shift</kbd>+<kbd>B</kbd>', 'parking brake on / off (set at the start)'],
      ['<kbd>G</kbd>', 'landing gear up / down'],
      ['<kbd>S</kbd>', 'speed brake'],
      ['<kbd>A</kbd>', 'high-AoA mode on / off: the AoA limit is 50 deg instead of 25 (HI AOA on the helmet display)'],
      ['<kbd>C</kbd>', 'canopy (on the ground, below 30 kt)'],
      ['<kbd>L</kbd> / <kbd>Shift</kbd>+<kbd>L</kbd>', 'exterior lights / landing light'],
    ],
  },
  {
    title: 'View',
    rows: [
      ['<kbd>V</kbd> / <kbd>Shift</kbd>+<kbd>V</kbd>', 'next / previous camera'],
      ['<kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> <kbd>5</kbd>', 'cockpit, chase, orbit, fly-by, tower'],
      ['mouse drag, numpad <kbd>8</kbd><kbd>4</kbd><kbd>6</kbd><kbd>2</kbd>, hat', 'look around (cockpit), turn the camera (outside)'],
      ['<kbd>Home</kbd>, numpad <kbd>5</kbd>, middle click', 'look ahead again'],
      ['mouse wheel', 'zoom (cockpit, fly-by, tower) or camera distance'],
      ['<kbd>H</kbd>', 'helmet display on / off'],
      ['<kbd>F</kbd>', 'full screen'],
    ],
  },
  {
    title: 'Simulation',
    rows: [
      ['<kbd>P</kbd> or <kbd>Esc</kbd>', 'pause and menu'],
      ['<kbd>R</kbd>', 'restart at the start point (in flight: hold it for a second)'],
      ['<kbd>[</kbd> / <kbd>]</kbd>', 'time of day 15 minutes earlier / later'],
      ['<kbd>M</kbd>', 'sound on / off'],
      ['<kbd>F1</kbd> or <kbd>?</kbd>', 'this help'],
    ],
  },
  {
    title: 'Gamepad (Xbox / PlayStation layout)',
    rows: [
      ['left stick', 'pitch and roll'],
      ['right stick left / right', 'rudder and nose wheel'],
      ['right stick up / down, <kbd>RT</kbd> / <kbd>LT</kbd>', 'throttle up / down (MIL detent as on the keyboard); the right stick works rudder or throttle, whichever it is pushed toward first, until it is back in the centre'],
      ['<kbd>A</kbd> (hold)', 'wheel brakes'],
      ['<kbd>Y</kbd> / <kbd>X</kbd> / <kbd>B</kbd>', 'gear / canopy / speed brake'],
      ['<kbd>LB</kbd> / <kbd>RB</kbd>', 'previous / next camera'],
      ['d-pad, <kbd>R3</kbd>', 'look around, look ahead'],
      ['<kbd>L3</kbd>', 'parking brake on the ground, high-AoA mode in the air'],
      ['<kbd>View</kbd> / <kbd>Menu</kbd>', 'helmet display / pause (in menus: A select, B back, Y restart)'],
    ],
  },
  {
    title: 'Mouse stick (option in the menu)',
    rows: [
      ['click the view', 'capture the mouse; it now moves the stick (the ring at the bottom left)'],
      ['move the mouse', 'down = pull, up = push, sideways = roll; near the centre (the small ring) the stick reads centred'],
      ['let the mouse rest', 'roll springs back to the centre: roll in, stop, and the bank is held (the spring can be turned off under Joystick &amp; gamepad)'],
      ['middle click', 'centre the stick'],
      ['right drag', 'look around'],
      ['<kbd>Esc</kbd>', 'release the mouse (and pause)'],
    ],
  },
  {
    title: 'Flying the F-35I',
    rows: [
      ['take-off', 'MIL or afterburner, release the parking brake (Shift+B); at 150 kt pull back and hold the nose about 10 deg up (on the ground the stick sets the pitch attitude), lift-off at about 160 kt; gear up (G) once climbing, then centre the stick: the jet holds the climb (a pull held on keeps the nose coming up)'],
      ['fly-by-wire', 'the stick commands g (pitch rate when slow) and roll rate; let go and the jet holds its flight path and bank; the FCS limits AoA to 25 deg and g to +9 / -3'],
      ['landing', 'gear down, about 140 kt and 13 deg AoA on a 3 deg path: keep the flight path marker in the middle of the bracket beside it (high in the bracket: fast, low: slow) with the throttle, or let the auto-throttle (Y) do it; flare gently from about 30 ft (the radar altitude shows beside the marker below 100 ft); idle and brakes (B) after touchdown'],
      ['helmet display', 'speed (KIAS) left, altitude (ft) right with radar altitude below 5,000 ft, magnetic heading on top; the circle with wings is where the jet is going, the W is where the nose points; dive rungs are dashed with minus numbers'],
    ],
  },
];

export function helpHTML() {
  let h = '';
  for (const sec of CONTROLS) {
    h += `<div><h3>${sec.title}</h3><table>`;
    for (const [k, v] of sec.rows) h += `<tr><td>${k}</td><td>${v}</td></tr>`;
    h += '</table></div>';
  }
  h += '<p class="help-note">Joysticks and HOTAS: open <b>Joystick &amp; gamepad</b> in the menu, press <b>Bind</b> next to an action and move the axis or press the button. Bindings are saved in this browser.'
    + ' A throttle lever takes the throttle back only once it is moved through the throttle setting (after the auto-throttle, the keys or a restart set it; until then the helmet display shows <b>LVR</b> and where the lever is); pushed through MIL into afterburner it takes over at once (go-around).</p>';
  return h;
}
