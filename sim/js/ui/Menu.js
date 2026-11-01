// The page's DOM screens (sim/index.html): loading progress, start menu, pause, help, crash
// message and short toasts. The app (main.js) owns the logic; this module only shows things
// and calls back into the app:
//   app.selectSpawn(name), app.setTimeOfDay(hours), app.setQuality(q), app.setOption(key, value),
//   app.startFlight(), app.resume(), app.restart(), app.toMenu(), app.openBindings().

import { helpHTML } from './Help.js';

const $ = (id) => document.getElementById(id);

export const TIME_PRESETS = [
  { h: 7.0, label: '07:00', note: 'morning' },
  { h: 12.5, label: '12:30', note: 'midday' },
  { h: 19.0, label: '19:00', note: 'sunset' },
];

export function formatHours(h) {
  const hh = Math.floor(((h % 24) + 24) % 24);
  const mm = Math.round((h - Math.floor(h)) * 60) % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export class UI {
  constructor(app) {
    this.app = app;
    this.screen = 'loading';
    this._toastTimer = 0;
    this._overlay = null;          // 'help' | 'bindings' on top of whatever screen
    // buttons
    $('btn-fly').addEventListener('click', () => app.startFlight());
    $('btn-help').addEventListener('click', () => this.showHelp(true));
    $('btn-controls').addEventListener('click', () => app.openBindings());
    $('btn-resume').addEventListener('click', () => app.resume());
    $('btn-reset').addEventListener('click', () => app.restart());
    $('btn-menu').addEventListener('click', () => app.toMenu());
    $('btn-pause-help').addEventListener('click', () => this.showHelp(true));
    $('btn-pause-controls').addEventListener('click', () => app.openBindings());
    for (const b of document.querySelectorAll('[data-close]')) {
      b.addEventListener('click', () => this.closeOverlay());
    }
    for (const b of $('quality-list').querySelectorAll('button')) {
      b.addEventListener('click', () => app.setQuality(b.dataset.q));
    }
    // lighting: weather presets (js/env/Clouds.js reads settings.clouds; choose() drops a ?clouds= override)
    for (const b of $('clouds-list')?.querySelectorAll('button') || []) {
      b.addEventListener('click', () => {
        app.setOption('clouds', b.dataset.clouds);
        app.clouds?.choose?.(b.dataset.clouds);
        this.syncMenu(app.settings, app.spawn);
      });
    }
    $('opt-wingmen').addEventListener('change', (e) => app.setOption('wingmen', e.target.checked));
    $('opt-mousestick').addEventListener('change', (e) => app.setOption('mouseStick', e.target.checked));
    $('opt-volume').addEventListener('input', (e) => {
      app.setOption('volume', Number(e.target.value) / 100);
      $('opt-volume-val').textContent = e.target.value;
    });
    $('help-body').innerHTML = helpHTML();
  }

  // ------------------------------------------------------------------------------ loading
  progress(which, fraction, label) {
    const bar = $(`bar-${which}`), lab = $(`label-${which}`);
    if (!bar) return;
    const f = Math.max(0, Math.min(1, fraction || 0));
    bar.style.width = `${(f * 100).toFixed(1)}%`;
    bar.classList.toggle('done', f >= 1);
    if (label != null) lab.textContent = String(label).replace(/^(terrain|aircraft):\s*/, '');
  }

  loadError(text) {
    const e = $('load-error');
    e.textContent = text;
    e.classList.remove('hidden');
  }

  // ------------------------------------------------------------------------------ screens
  show(screen) {
    this.screen = screen;
    $('loading').classList.toggle('hidden', screen !== 'loading');
    $('menu').classList.toggle('hidden', screen !== 'menu');
    $('pause').classList.toggle('hidden', screen !== 'pause');
    document.body.classList.toggle('flying', screen === 'flying');
    if (screen === 'menu') setTimeout(() => $('btn-fly').focus({ preventScroll: true }), 0);
    if (screen === 'pause') setTimeout(() => $('btn-resume').focus({ preventScroll: true }), 0);
  }

  /** Fill the start menu: spawns from spawns.json, times, current settings, attribution. */
  buildMenu({ spawns, settings, attribution, model }) {
    const list = $('spawn-list');
    list.innerHTML = '';
    for (const [name, s] of Object.entries(spawns)) {
      const b = document.createElement('button');
      b.dataset.spawn = name;
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = s.label || name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = s.on_ground !== false
        ? 'on the ground, engine at idle, parking brake set'
        : `airborne, ${Math.round((s.speed_ms || 0) / 0.514444)} kt, gear ${(s.gear || 0) > 0.5 ? 'down' : 'up'}`;
      b.append(lbl, meta);
      b.addEventListener('click', () => this.app.selectSpawn(name));
      list.appendChild(b);
    }
    $('attribution').textContent = [attribution, model].filter(Boolean).join(' ');
    this.syncMenu(settings);
  }

  /** Reflect the settings in the menu controls. */
  syncMenu(settings, spawn) {
    for (const b of $('spawn-list').querySelectorAll('button')) b.classList.toggle('selected', b.dataset.spawn === settings.spawn);
    // times: the presets, plus the scenario's own time when the spawn has one
    const tl = $('time-list');
    tl.innerHTML = '';
    const presets = TIME_PRESETS.slice();
    if (spawn && Number.isFinite(spawn.time_h) && !presets.some((p) => Math.abs(p.h - spawn.time_h) < 0.01)) {
      presets.push({ h: spawn.time_h, label: formatHours(spawn.time_h), note: 'scenario' });
    }
    if (!presets.some((p) => Math.abs(p.h - settings.time) < 0.01)) presets.push({ h: settings.time, label: formatHours(settings.time), note: 'custom' });
    for (const p of presets) {
      const b = document.createElement('button');
      b.textContent = `${p.label} ${p.note}`;
      b.classList.toggle('selected', Math.abs(p.h - settings.time) < 0.01);
      b.addEventListener('click', () => this.app.setTimeOfDay(p.h));
      tl.appendChild(b);
    }
    for (const b of $('quality-list').querySelectorAll('button')) b.classList.toggle('selected', b.dataset.q === settings.quality);
    const clouds = this.app.clouds?.preset || settings.clouds || 'few';
    for (const b of $('clouds-list')?.querySelectorAll('button') || []) b.classList.toggle('selected', b.dataset.clouds === clouds);
    $('opt-wingmen').checked = !!settings.wingmen;
    $('opt-mousestick').checked = !!settings.mouseStick;
    $('opt-volume').value = Math.round(settings.volume * 100);
    $('opt-volume-val').textContent = Math.round(settings.volume * 100);
  }

  setPadStatus(text) { $('pad-status').textContent = text || ''; }

  // ------------------------------------------------------------------------------ overlays
  get overlay() { return this._overlay; }

  showHelp(on = true) {
    this._overlay = on ? 'help' : null;
    $('help').classList.toggle('hidden', !on);
    $('bindings').classList.add('hidden');
  }

  showBindingsPanel(on = true) {
    this._overlay = on ? 'bindings' : null;
    $('bindings').classList.toggle('hidden', !on);
    $('help').classList.add('hidden');
  }

  closeOverlay() {
    const was = this._overlay;
    this._overlay = null;
    $('help').classList.add('hidden');
    $('bindings').classList.add('hidden');
    if (was) this.app.overlayClosed?.(was);
  }

  // ------------------------------------------------------------------------------ in flight
  showMessage(title, text, hint) {
    $('message-title').textContent = title;
    $('message-text').textContent = text || '';
    if (hint != null) $('message-hint').innerHTML = hint;
    $('message').classList.remove('hidden');
  }

  hideMessage() { $('message').classList.add('hidden'); }

  toast(text, ms = 1600) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }
}
