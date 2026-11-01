// The joystick / HOTAS / gamepad binding screen (#bindings in index.html).
// Pick a device, press Bind next to an action, then move the axis or press the button.
// Bindings are kept per device in localStorage (js/input/Bindings.js).

import { AXIS_ACTIONS, BUTTON_ACTIONS, describeBinding } from '../input/Bindings.js';

const $ = (id) => document.getElementById(id);

export class BindingsUI {
  constructor(input, ui) {
    this.input = input;
    this.ui = ui;
    this.body = $('bindings-body');
    this.padIndex = null;
    this.waiting = null;          // action id being bound
    this.open = false;
    this._raf = 0;
    this._sig = '';
  }

  show() {
    this.open = true;
    this.ui.showBindingsPanel(true);
    this._render();
    const tick = () => {
      if (!this.open) return;
      this._live();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  hide() {
    this.open = false;
    cancelAnimationFrame(this._raf);
    if (this.input.capturing) this.input.cancelCapture();
    this.waiting = null;
  }

  _pad() {
    const pads = this.input.gamepads();
    if (!pads.length) return null;
    let p = pads.find((x) => x.index === this.padIndex);
    if (!p) { p = pads[0]; this.padIndex = p.index; }
    return p;
  }

  _render() {
    const pads = this.input.gamepads();
    this._sig = pads.map((p) => p.index + p.id).join('|');
    const pad = this._pad();
    const B = this.input.bindings;
    const tun = B.tuning;
    let h = '';
    if (!pads.length) {
      h += '<p class="note">No joystick or gamepad found. Connect one and press any of its buttons (browsers only report a controller after it has been used).</p>';
    } else {
      h += '<div class="bind-devices">';
      for (const p of pads) h += `<button data-pad="${p.index}" class="${p.index === pad.index ? 'selected' : ''}">${escapeHtml(shortName(p.id))}</button>`;
      h += '</div>';
      const eff = B.forPad(pad);
      h += `<p class="note">${escapeHtml(pad.id)}<br>${pad.mapping === 'standard' ? 'Standard gamepad layout' : 'Joystick / HOTAS'}: ${eff.custom ? 'your bindings' : 'default bindings'} &middot; ${pad.axes.length} axes, ${pad.buttons.length} buttons</p>`;
      h += '<table class="bind-table"><tr><th>Axis</th><th>Bound to</th><th>Live</th><th></th></tr>';
      for (const a of AXIS_ACTIONS) {
        const b = eff.axes && eff.axes[a.id];
        const wait = this.waiting === 'axis:' + a.id;
        h += `<tr><td>${a.label}</td><td class="cur ${b ? '' : 'none'}">${wait ? 'now ' + a.prompt + '...' : describeBinding(b)}</td>`
          + `<td class="val"><div class="meter"><i data-meter="${a.id}"></i></div></td>`
          + `<td><button data-bind-axis="${a.id}" class="${wait ? 'waiting' : ''}">${wait ? 'Cancel' : 'Bind'}</button> `
          + `${b ? `<button data-invert="${a.id}">Invert</button> <button data-clear-axis="${a.id}">Clear</button>` : ''}</td></tr>`;
      }
      h += '</table>';
      if (pad.mapping === 'standard' && !(eff.axes && eff.axes.throttle)) {
        h += '<p class="note">Throttle on this gamepad: right stick up / down and the triggers move it (bind a throttle axis to use a lever instead).</p>';
      }
      h += '<table class="bind-table" style="margin-top:12px"><tr><th>Button</th><th>Bound to</th><th></th></tr>';
      for (const a of BUTTON_ACTIONS) {
        const b = eff.buttons && eff.buttons[a.id];
        const wait = this.waiting === 'btn:' + a.id;
        h += `<tr><td>${a.label}</td><td class="cur ${b ? '' : 'none'}">${wait ? 'press a button or the hat...' : describeBinding(b)}</td>`
          + `<td><button data-bind-btn="${a.id}" class="${wait ? 'waiting' : ''}">${wait ? 'Cancel' : 'Bind'}</button> `
          + `${b ? `<button data-clear-btn="${a.id}">Clear</button>` : ''}</td></tr>`;
      }
      h += '</table>';
      h += `<div class="buttons"><button data-reset-dev="1">Reset this device to its defaults</button></div>`;
    }
    h += '<div class="bind-tune">'
      + `<label>Deadzone <input type="range" min="0" max="0.3" step="0.01" value="${tun.deadzone}" data-tune="deadzone"><span>${tun.deadzone.toFixed(2)}</span></label>`
      + `<label title="The flight control system already softens the stick around the centre">Expo (softer centre) <input type="range" min="0" max="0.9" step="0.05" value="${tun.expo}" data-tune="expo"><span>${tun.expo.toFixed(2)}</span></label>`
      + `<label><input type="checkbox" data-tune="invertKeyboardPitch" ${tun.invertKeyboardPitch ? 'checked' : ''}> Keyboard: up arrow = nose up</label>`
      + '</div>';
    this.body.innerHTML = h;
    this._wire();
  }

  _wire() {
    const pad = this._pad();
    const B = this.input.bindings;
    const q = (sel) => this.body.querySelectorAll(sel);
    for (const el of q('[data-pad]')) el.onclick = () => { this.padIndex = +el.dataset.pad; this._cancel(); this._render(); };
    for (const el of q('[data-bind-axis]')) el.onclick = () => this._bindAxis(el.dataset.bindAxis);
    for (const el of q('[data-bind-btn]')) el.onclick = () => this._bindButton(el.dataset.bindBtn);
    for (const el of q('[data-invert]')) el.onclick = () => {
      const eff = B.forPad(pad);
      const b = eff.axes[el.dataset.invert];
      if (b) { B.setAxis(pad, el.dataset.invert, { ...b, invert: !b.invert }); this._render(); }
    };
    for (const el of q('[data-clear-axis]')) el.onclick = () => { B.setAxis(pad, el.dataset.clearAxis, null); this._render(); };
    for (const el of q('[data-clear-btn]')) el.onclick = () => { B.setButton(pad, el.dataset.clearBtn, null); this._render(); };
    for (const el of q('[data-reset-dev]')) el.onclick = () => { B.resetDevice(pad.id); this._render(); };
    for (const el of q('[data-tune]')) {
      el.oninput = el.onchange = () => {
        const k = el.dataset.tune;
        if (el.type === 'checkbox') B.setTuning({ [k]: el.checked });
        else {
          B.setTuning({ [k]: Number(el.value) });
          el.nextElementSibling.textContent = Number(el.value).toFixed(2);
        }
      };
    }
  }

  _cancel() {
    if (this.input.capturing) this.input.cancelCapture();
    this.waiting = null;
  }

  _bindAxis(action) {
    if (this.waiting === 'axis:' + action) { this._cancel(); this._render(); return; }
    this._cancel();
    this.waiting = 'axis:' + action;
    this._render();
    this.input.startCapture('axis', (res) => {
      this.waiting = null;
      if (res) {
        this.padIndex = res.pad.index;
        // the player moved the control in the + direction of the action
        this.input.bindings.setAxis(res.pad, action, { type: 'axis', index: res.index, invert: res.sign < 0 });
        this.ui.toast(`${action}: axis ${res.index}${res.sign < 0 ? ' (inverted)' : ''}`);
      }
      if (this.open) this._render();
    });
  }

  _bindButton(action) {
    if (this.waiting === 'btn:' + action) { this._cancel(); this._render(); return; }
    this._cancel();
    this.waiting = 'btn:' + action;
    this._render();
    this.input.startCapture('button', (res) => {
      this.waiting = null;
      if (res) {
        this.padIndex = res.pad.index;
        this.input.bindings.setButton(res.pad, action, res.binding);
        this.ui.toast(`${action}: ${describeBinding(res.binding)}`);
      }
      if (this.open) this._render();
    });
  }

  /** Live meters; re-render when controllers come or go. */
  _live() {
    const pads = this.input.gamepads();
    const sig = pads.map((p) => p.index + p.id).join('|');
    if (sig !== this._sig) { this._render(); return; }
    const pad = this._pad();
    if (!pad) return;
    const eff = this.input.bindings.forPad(pad);
    for (const el of this.body.querySelectorAll('[data-meter]')) {
      const b = eff.axes && eff.axes[el.dataset.meter];
      let v = b && Number.isFinite(pad.axes[b.index]) ? pad.axes[b.index] : 0;
      if (b && b.invert) v = -v;
      v = Math.max(-1, Math.min(1, v));
      el.style.left = `${50 + Math.min(0, v) * 50}%`;
      el.style.width = `${Math.abs(v) * 50}%`;
    }
  }
}

function shortName(id) {
  return String(id).replace(/\s*\(.*?\)\s*/g, ' ').trim().slice(0, 40) || 'controller';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
