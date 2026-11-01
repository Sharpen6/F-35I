// EngineSound: procedural F135 sound with WebAudio (no audio files).
//
//   const sound = new EngineSound();
//   sound.start();                                   // after a user gesture (the Fly button)
//   sound.update(state, viewMode, dt, { cameraPosition, canopyOpen, active });   // every frame
//   sound.setVolume(0.8); sound.toggleMute(); sound.crash();
//
// Sources, all generated:
// * rumble: low-passed brown noise, louder and brighter with N2;
// * roar: band-passed white noise (the broadband jet mixing noise), with thrust;
// * afterburner: a deep roar plus "crackle" (sparse random pops) while the burner is lit;
// * turbine whine: two detuned tones that follow N2 (strongest in front of the jet);
// * wind: band-passed noise that rises with airspeed (and with an open canopy);
// * one-shots: gear lock thunks, touchdown thumps, the crash;
// * warning tones: PULL UP (fast two-tone), OVER G / AOA (beeps), GEAR (horn), caution chime.
// Inside the cockpit the engine is muffled by a low-pass filter (less so with the canopy open);
// outside it fades with distance, loses its highs (air absorption), shifts with the Doppler
// effect (fly-by and tower cameras) and is louder behind the jet than in front of it.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const SPEED_OF_SOUND = 340;

function noiseBuffer(ctx, seconds, kind) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  if (kind === 'brown') {
    let b = 0;
    for (let i = 0; i < n; i++) {
      b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = b * 3.5;
    }
  } else if (kind === 'crackle') {
    // sparse pops: short decaying bursts at random times and strengths
    d.fill(0);
    let i = 0;
    while (i < n) {
      i += Math.floor(ctx.sampleRate * (0.004 + Math.random() * 0.03));
      const len = Math.floor(ctx.sampleRate * (0.002 + Math.random() * 0.006));
      const a = 0.3 + Math.random() * 0.7;
      for (let k = 0; k < len && i + k < n; k++) d[i + k] += a * (Math.random() * 2 - 1) * Math.exp(-k / (len * 0.3));
    }
  } else {
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }
  // fade the loop seam
  const f = Math.min(256, n >> 3);
  for (let i = 0; i < f; i++) { const w = i / f; d[i] *= w; d[n - 1 - i] *= w; }
  return buf;
}

export class EngineSound {
  constructor() {
    this.ctx = null;
    this.volume = 0.8;
    this.muted = false;
    this.started = false;
    this._prev = { gear: null, wow: null, crashed: false, camPos: null };
    this._warnT = 0;
    this._doppler = 1;
  }

  /** Create the audio graph (call from a click / key handler: browsers block audio before one). */
  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const white = noiseBuffer(ctx, 4.1, 'white');
    const brown = noiseBuffer(ctx, 5.3, 'brown');
    const crackle = noiseBuffer(ctx, 2.7, 'crackle');

    // master chain: limiter -> output
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.knee.value = 8;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.005;
    this.limiter.release.value = 0.25;
    this.master.connect(this.limiter).connect(ctx.destination);

    // engine bus: muffle / air absorption, then distance gain
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 0.5;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter.connect(this.engineGain).connect(this.master);

    const src = (buf, rateJitter) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.playbackRate.value = 1 + rateJitter;
      s.start(0, Math.random() * buf.duration);
      return s;
    };
    const filt = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };

    // rumble
    this.sRumble = src(brown, 0);
    this.fRumble = filt('lowpass', 120, 0.7);
    this.gRumble = gain();
    this.sRumble.connect(this.fRumble).connect(this.gRumble).connect(this.engineFilter);
    // roar
    this.sRoar = src(white, 0.01);
    this.fRoar = filt('bandpass', 700, 0.6);
    this.gRoar = gain();
    this.sRoar.connect(this.fRoar).connect(this.gRoar).connect(this.engineFilter);
    // high hiss of the exhaust (outside only)
    this.sHiss = src(white, -0.013);
    this.fHiss = filt('highpass', 2500, 0.5);
    this.gHiss = gain();
    this.sHiss.connect(this.fHiss).connect(this.gHiss).connect(this.engineFilter);
    // afterburner roar and crackle
    this.sAB = src(brown, 0.03);
    this.fAB = filt('lowpass', 500, 0.9);
    this.gAB = gain();
    this.sAB.connect(this.fAB).connect(this.gAB).connect(this.engineFilter);
    this.sCrackle = src(crackle, 0);
    this.fCrackle = filt('bandpass', 900, 0.8);
    this.gCrackle = gain();
    this.sCrackle.connect(this.fCrackle).connect(this.gCrackle).connect(this.engineFilter);
    // turbine whine: two tones, slightly detuned, gentle vibrato
    this.whine = [ctx.createOscillator(), ctx.createOscillator()];
    this.whine[0].type = 'sine';
    this.whine[1].type = 'triangle';
    this.gWhine = gain();
    this.fWhine = filt('bandpass', 2000, 1.2);
    for (const o of this.whine) { o.frequency.value = 1000; o.connect(this.fWhine); o.start(); }
    this.fWhine.connect(this.gWhine).connect(this.engineFilter);
    this.vib = ctx.createOscillator();
    this.vib.frequency.value = 5.3;
    this.vibGain = gain(6);
    this.vib.connect(this.vibGain);
    for (const o of this.whine) this.vibGain.connect(o.frequency);
    this.vib.start();
    // wind and cockpit air (not muffled by the engine filter)
    this.sWind = src(white, 0.021);
    this.fWind = filt('bandpass', 600, 0.45);
    this.gWind = gain();
    this.sWind.connect(this.fWind).connect(this.gWind).connect(this.master);
    this.sEcs = src(white, -0.031);
    this.fEcs = filt('highpass', 3500, 0.4);
    this.gEcs = gain();
    this.sEcs.connect(this.fEcs).connect(this.gEcs).connect(this.master);
    // warning tone
    this.warnOsc = ctx.createOscillator();
    this.warnOsc.type = 'square';
    this.warnOsc.frequency.value = 900;
    this.fWarn = filt('lowpass', 2500, 0.5);
    this.gWarn = gain();
    this.warnOsc.connect(this.fWarn).connect(this.gWarn).connect(this.master);
    this.warnOsc.start();
    this._white = white;
    this._brown = brown;
    this.started = true;
    this._applyVolume();
  }

  setVolume(v) { this.volume = clamp(+v || 0, 0, 1); this._applyVolume(); }
  setMuted(m) { this.muted = !!m; this._applyVolume(); }
  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  _applyVolume() {
    if (!this.ctx) return;
    const v = this.muted ? 0 : this.volume * this.volume;     // perceptual taper
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Pause: silence (the context keeps running so resuming is instant). */
  setPaused(p) {
    if (!this.ctx) return;
    this._paused = !!p;
    this.master.gain.setTargetAtTime(p || this.muted ? 0 : this.volume * this.volume, this.ctx.currentTime, 0.08);
  }

  _set(param, v, tau = 0.06) {
    param.setTargetAtTime(v, this.ctx.currentTime, tau);
  }

  /** A short mechanical thump: gear locks, touchdowns. strength 0..1. */
  thunk(strength = 0.5, pitch = 1) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this._white;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 260 * pitch;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(clamp(strength, 0, 1) * 1.4, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random() * 3);
    s.stop(t + 0.3);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(75 * pitch, t);
    o.frequency.exponentialRampToValueAtTime(40 * pitch, t + 0.15);
    const og = ctx.createGain();
    og.gain.setValueAtTime(clamp(strength, 0, 1) * 0.8, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.25);
  }

  /** The crash: a long low boom. */
  crash() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this._brown;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1800, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 2.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(2.2, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 3.5);
    s.connect(f).connect(g).connect(this.master);
    s.start(t);
    s.stop(t + 3.6);
    this.thunk(1, 0.6);
  }

  /**
   * state: FlightModel.state; viewMode: 'cockpit' | 'chase' | ...;
   * opts: {cameraPosition (THREE.Vector3), canopyOpen (0..1), active (false in menus), warnings}.
   */
  update(state, viewMode, dt, opts = {}) {
    if (!this.ctx || !state) return;
    if (this._paused) return;
    const t = this.ctx.currentTime;
    const eng = state.engine || {};
    const active = opts.active !== false && !state.crashed;
    // engine values
    const rpm = eng.rpm != null ? eng.rpm : 66 + 34 * Math.min(1, (state.controls && state.controls.throttle || 0) / 0.75);
    const running = eng.running !== false;
    const n = clamp((rpm - 55) / 45, 0, 1.12);             // 0 at windmill, ~0.25 idle, 1 at MIL
    const ab = clamp(eng.ab || 0, 0, 1);
    const thrustFrac = eng.thrust != null ? clamp(eng.thrust / 125000, 0, 1.6) : n;
    const V = state.velocity ? state.velocity.length() : (state.tas || 0);

    // listener geometry
    const inside = viewMode === 'cockpit';
    let dist = 0, front = 0, doppler = 1;
    const cam = opts.cameraPosition;
    if (!inside && cam && state.position) {
      const dx = cam.x - state.position.x, dy = cam.y - state.position.y, dz = cam.z - state.position.z;
      dist = Math.hypot(dx, dy, dz);
      if (dist > 0.1 && state.quaternion) {
        // forward axis of the jet (body -Z) in the world
        const q = state.quaternion;
        const fx = -(2 * (q.x * q.z + q.w * q.y));
        const fy = -(2 * (q.y * q.z - q.w * q.x));
        const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
        front = (fx * dx + fy * dy + fz * dz) / dist;          // +1 in front of the nose, -1 behind
        // Doppler: source speed towards the listener, listener speed towards the source
        const v = state.velocity;
        let vs = v ? (v.x * dx + v.y * dy + v.z * dz) / dist : 0;
        let vo = 0;
        if (this._prev.camPos && dt > 0) {
          const p = this._prev.camPos;
          vo = -((cam.x - p.x) * dx + (cam.y - p.y) * dy + (cam.z - p.z) * dz) / dist / dt;
        }
        vs = clamp(vs, -0.8 * SPEED_OF_SOUND, 0.8 * SPEED_OF_SOUND);
        doppler = clamp((SPEED_OF_SOUND + vo) / (SPEED_OF_SOUND - vs), 0.5, 2.2);
      }
    }
    if (cam) {
      if (!this._prev.camPos) this._prev.camPos = { x: 0, y: 0, z: 0 };
      this._prev.camPos.x = cam.x; this._prev.camPos.y = cam.y; this._prev.camPos.z = cam.z;
    }
    // smooth the Doppler factor (camera cuts would click otherwise)
    if (Math.abs(doppler - this._doppler) > 0.25) this._doppler = doppler;
    else this._doppler += (doppler - this._doppler) * clamp(dt * 6, 0, 1);
    const dop = this._doppler;

    // distance attenuation and air absorption; cockpit muffling
    const canopy = clamp(opts.canopyOpen || 0, 0, 1);
    let lp, distGain;
    if (inside) {
      lp = 650 + 2600 * canopy;
      distGain = 0.8 + 0.4 * canopy;
    } else {
      distGain = 1 / Math.pow(1 + dist / 70, 0.9);
      lp = 16000 / (1 + dist / 450);
    }
    this._set(this.engineFilter.frequency, clamp(lp, 120, 18000), 0.08);
    this._set(this.engineGain.gain, active ? distGain : 0, active ? 0.08 : 0.4);
    // jet noise is loudest behind the jet, the whine in front of it
    const rear = inside ? 0.7 : clamp(1 - 0.55 * front, 0.4, 1.6);
    const fore = inside ? 1.0 : clamp(0.7 + 0.8 * front, 0.3, 1.6);

    const on = running ? 1 : 0.15;
    this._set(this.gRumble.gain, on * (0.22 + 0.55 * n * n) * (inside ? 1.3 : rear));
    this._set(this.fRumble.frequency, (70 + 110 * n) * dop);
    this._set(this.gRoar.gain, on * (0.03 + 0.42 * Math.pow(thrustFrac, 1.4)) * rear);
    this._set(this.fRoar.frequency, (380 + 900 * n + 300 * ab) * dop);
    this._set(this.gHiss.gain, inside ? 0 : on * 0.12 * Math.pow(thrustFrac, 1.5) * rear);
    this._set(this.gAB.gain, on * 0.85 * ab * (inside ? 1.1 : rear * 1.2));
    this._set(this.fAB.frequency, (320 + 380 * ab) * dop);
    const flutter = 0.75 + 0.25 * Math.sin(t * 17.3) * Math.sin(t * 4.1);
    this._set(this.gCrackle.gain, on * 0.55 * ab * flutter * (inside ? 0.35 : rear), 0.03);
    // whine: N2 tone (the fan / HP spool), quiet inside
    const fW = (700 + 2900 * Math.pow(n, 1.3)) * dop;
    this._set(this.whine[0].frequency, fW, 0.1);
    this._set(this.whine[1].frequency, fW * 1.503, 0.1);
    this._set(this.fWhine.frequency, fW * 1.2, 0.1);
    this._set(this.gWhine.gain, running ? (0.035 + 0.05 * n) * (inside ? 0.6 : fore) : 0);
    for (const s of [this.sRumble, this.sRoar, this.sHiss, this.sAB, this.sCrackle]) this._set(s.playbackRate, dop, 0.08);

    // wind (and the cockpit's air conditioning hiss)
    const w = clamp(V / 260, 0, 1.6);
    this._set(this.gWind.gain, active ? w * w * (inside ? 0.16 + 0.5 * canopy : 0.05) : 0);
    this._set(this.fWind.frequency, 250 + 5 * V);
    this._set(this.gEcs.gain, active && inside ? 0.018 : 0);

    // one-shots: gear locks and touchdowns
    const gear = state.gear;
    if (this._prev.gear != null && gear != null && active) {
      if (this._prev.gear >= 0.999 && gear < 0.999) this.thunk(0.25, 1.3);          // unlock
      if (this._prev.gear < 0.999 && gear >= 0.999) this.thunk(0.6, 1.0);           // down and locked
      if (this._prev.gear > 0.001 && gear <= 0.001) this.thunk(0.45, 0.9);          // up and locked
    }
    this._prev.gear = gear;
    if (Array.isArray(state.wheels)) {
      const wow = state.wheels.some((x) => x.wow);
      if (this._prev.wow === false && wow && active) this.thunk(clamp(0.3 + Math.abs(state.vs || 0) / 3, 0.3, 1), 0.8);
      this._prev.wow = wow;
    }
    if (state.crashed && !this._prev.crashed) this.crash();
    this._prev.crashed = !!state.crashed;

    this._warnings(opts.warnings || state.warnings || [], dt, active);
  }

  _warnings(list, dt, active) {
    this._warnT += dt;
    const T = this._warnT;
    let f = 0, on = false;
    if (active && list.length) {
      if (list.includes('PULL UP')) { on = (T % 0.3) < 0.24; f = (T % 0.6) < 0.3 ? 1250 : 950; }
      else if (list.includes('OVER-G') || list.includes('AOA')) { on = (T % 0.25) < 0.12; f = 1100; }
      else if (list.includes('GEAR')) { on = (T % 1.0) < 0.85; f = (T % 0.5) < 0.25 ? 620 : 820; }
      else if (list.includes('ENGINE') || list.includes('BINGO FUEL') || list.includes('OVERSPEED')) { on = (T % 3) < 0.12 || ((T % 3) > 0.25 && (T % 3) < 0.37); f = 700; }
    } else {
      this._warnT = 0;
    }
    if (f) this.warnOsc.frequency.setValueAtTime(f, this.ctx.currentTime);
    this._set(this.gWarn.gain, on ? 0.09 : 0, 0.01);
  }
}
