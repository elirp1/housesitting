/*
  Canary song + sound toggle, shared by every page.

  - The song is synthesised in the browser (Web Audio), so there is no audio file to host.
  - Browsers only allow sound after the visitor has interacted with the page. The password
    screen provides that interaction; if it isn't available, the song starts on the first click,
    tap or key press instead.
  - On the home page, if an element with id="canary" exists, it gets the class "singing"
    while a phrase is playing so the bird can animate in time with the song.

  Realism notes: every syllable follows a curved pitch contour (not a straight glide), has
  several harmonics, a touch of breath noise, tiny random pitch/timing/volume variation and its
  own position in the stereo field. Songs are built from "tours" (one syllable repeated, speeding
  up or slowing down) like a real canary, with a gentle room reverb and a soft compressor.
*/
(function () {
  'use strict';

  var MUTE_KEY = 'canaryMuted';
  var MASTER_LEVEL = 0.26;          // overall volume: soft and relaxing
  var ctx = null, graph = null;
  var started = false, muted = false, loopOn = false, waiting = false;
  var loopTimer = null, singTimer = null;
  var bird = null, btn = null;

  try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) {}

  /* ---------------------------------------------------------------- sound */

  function impulse(c, seconds, decay) {            // gentle room reverb
    var rate = c.sampleRate, len = Math.floor(rate * seconds);
    var buf = c.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function buildGraph(c) {
    var out = c.createGain();  out.gain.value = 0;                 // master volume (fades in and out)
    var comp = c.createDynamicsCompressor();                       // keeps busy trills from clipping
    comp.threshold.value = -20; comp.knee.value = 18; comp.ratio.value = 3;
    comp.attack.value = 0.004; comp.release.value = 0.12;
    var tone = c.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 9000;
    var bus = c.createGain();
    var wet = c.createGain();  wet.gain.value = 0.26;
    var verb = c.createConvolver(); verb.buffer = impulse(c, 1.5, 2.8);
    bus.connect(tone); bus.connect(verb); verb.connect(wet); wet.connect(tone);
    tone.connect(comp); comp.connect(out); out.connect(c.destination);
    return { bus: bus, out: out };
  }

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function jit(v, amt) { return v * (1 + rnd(-amt, amt)); }

  var curPan = 0;                                   // the bird sits slightly off-centre per phrase
  function pan() { return Math.max(-0.7, Math.min(0.7, curPan + rnd(-0.1, 0.1))); }

  function noiseBuffer(c) {
    if (!c._canaryNoise) {
      var len = Math.floor(c.sampleRate * 0.6);
      var buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      c._canaryNoise = buf;
    }
    return c._canaryNoise;
  }

  /*
    One syllable. Options:
      f0, f1   start / end frequency (Hz)
      bend     curve of the pitch in log-units (+ arches up in the middle, - dips down)
      ease     <1 jumps quickly then settles, >1 holds then sweeps
      dur, gain, attack
      vib, depth   vibrato rate (Hz) and depth (Hz)
      harm     array of [multiple, volume] overtones
      breath   0-1 amount of airy noise
      pan      stereo position
  */
  function chirp(c, bus, t, o) {
    var dur = o.dur;
    var n = Math.max(10, Math.min(48, Math.round(dur * 600)));
    var lf0 = Math.log(o.f0), lf1 = Math.log(o.f1), bend = o.bend || 0, ease = o.ease || 1;
    var curve = new Float32Array(n), i, x;
    for (i = 0; i < n; i++) {
      x = i / (n - 1);
      curve[i] = Math.exp(lf0 + (lf1 - lf0) * Math.pow(x, ease) + bend * Math.sin(Math.PI * x));
    }

    var g = c.createGain();
    var peak = o.gain;
    var a = Math.min(o.attack || 0.012, dur * 0.35);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    if (dur > 0.12) g.gain.exponentialRampToValueAtTime(peak * 0.8, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    var out = g;
    if (c.createStereoPanner) {
      var p = c.createStereoPanner(); p.pan.value = o.pan === undefined ? pan() : o.pan;
      g.connect(p); out = p;
    }
    out.connect(bus);

    var lfo = null;
    if (o.vib) {
      lfo = c.createOscillator(); lfo.frequency.value = o.vib * rnd(0.92, 1.08);
      lfo.start(t); lfo.stop(t + dur + 0.05);
    }

    var harm = o.harm || [[1, 1], [2, 0.2], [3, 0.06]];
    for (var h = 0; h < harm.length; h++) {
      var m = harm[h][0], v = harm[h][1];
      var osc = c.createOscillator(); osc.type = 'sine';
      var scaled = new Float32Array(n);
      for (i = 0; i < n; i++) scaled[i] = curve[i] * m;
      osc.frequency.setValueCurveAtTime(scaled, t, dur);
      if (lfo) {
        var depth = c.createGain(); depth.gain.value = (o.depth || 0) * m;
        lfo.connect(depth); depth.connect(osc.frequency);
      }
      var hg = c.createGain(); hg.gain.value = v;
      osc.connect(hg); hg.connect(g);
      osc.start(t); osc.stop(t + dur + 0.05);
    }

    if (o.breath) {                                  // a little air in the voice
      var ns = c.createBufferSource(); ns.buffer = noiseBuffer(c);
      var bp = c.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = (o.f0 + o.f1) * 0.9; bp.Q.value = 1.2;
      var ng = c.createGain(); ng.gain.value = o.breath;
      ns.connect(bp); bp.connect(ng); ng.connect(g);
      ns.start(t, Math.random() * 0.3, dur + 0.02);
    }
  }

  var motifs = {
    whistle: function (c, bus, t, b) {               // soft, vibrato "tweeee"
      var d = rnd(0.28, 0.55), r = Math.random();
      var f0 = b * rnd(0.95, 1.1), f1, bend;
      if (r < 0.4)      { f1 = f0 * rnd(1.35, 1.6); bend = rnd(-0.04, 0.04); }   // rising
      else if (r < 0.75){ f1 = f0 * rnd(0.85, 1.0); bend = rnd(0.2, 0.35); }     // arch
      else              { f0 *= 1.55; f1 = f0 * rnd(0.7, 0.85); bend = 0; }      // falling
      chirp(c, bus, t, { f0: f0, f1: f1, bend: bend, dur: d, gain: 0.5, attack: 0.04,
        vib: rnd(5.5, 9), depth: b * rnd(0.01, 0.025), breath: 0.05 });
      return t + d + rnd(0.05, 0.14);
    },

    roll: function (c, bus, t, b) {                  // the classic canary trill (a "tour")
      var n = Math.floor(rnd(10, 28));
      var hi = b * rnd(1.5, 1.8), lo = b * rnd(1.1, 1.28);
      var step = rnd(0.052, 0.072), accel = rnd(-0.015, 0.02);
      var drift = rnd(-0.004, 0.004);
      for (var i = 0; i < n; i++) {
        var up = i % 2 === 1;
        var swell = 0.55 + 0.45 * Math.sin(Math.PI * (i + 0.5) / n);
        chirp(c, bus, t, {
          f0: jit(up ? lo : hi, 0.015), f1: jit(up ? hi : lo, 0.015),
          bend: rnd(-0.04, 0.04), dur: step * 0.88,
          gain: 0.34 * swell * rnd(0.88, 1.08), attack: 0.006, breath: 0.03 });
        t += step * rnd(0.96, 1.04);
        step *= 1 + accel; hi *= 1 + drift; lo *= 1 + drift;
      }
      return t + rnd(0.04, 0.1);
    },

    warble: function (c, bus, t, b) {                // rippling, falling warble
      var f = b * rnd(1.8, 2.05), n = Math.floor(rnd(4, 8));
      var step = rnd(0.1, 0.14);
      for (var i = 0; i < n; i++) {
        chirp(c, bus, t, { f0: f, f1: f * rnd(0.74, 0.86), bend: rnd(0.05, 0.12),
          dur: step * 0.85, gain: 0.4 * rnd(0.9, 1.05), vib: rnd(24, 34), depth: f * 0.03, breath: 0.04 });
        f *= rnd(0.88, 0.95); t += step * rnd(0.95, 1.08);
      }
      return t + 0.07;
    },

    chips: function (c, bus, t, b) {                 // bright "chip chip chip", often speeding up
      var n = Math.floor(rnd(3, 7)), gap = rnd(0.13, 0.2), f = b * rnd(1.35, 1.5);
      for (var i = 0; i < n; i++) {
        chirp(c, bus, t, { f0: f * 0.95, f1: f * rnd(1.22, 1.4), ease: 0.6, dur: rnd(0.055, 0.08),
          gain: 0.4 * rnd(0.85, 1.05), attack: 0.005, breath: 0.05 });
        t += gap; gap *= rnd(0.86, 0.97);
      }
      return t + 0.05;
    },

    peeps: function (c, bus, t, b) {                 // quick up-down "pee-oo" pairs
      var n = Math.floor(rnd(2, 5)), f = b * rnd(1.5, 1.8);
      for (var i = 0; i < n; i++) {
        var d = rnd(0.09, 0.14);
        chirp(c, bus, t, { f0: f, f1: f * 0.9, bend: rnd(0.12, 0.2), dur: d, gain: 0.42, breath: 0.04 });
        t += d + rnd(0.05, 0.09);
        f *= rnd(0.97, 1.05);
      }
      return t + 0.04;
    },

    sweepUp: function (c, bus, t, b) {               // fast rising run of little notes
      var n = Math.floor(rnd(5, 10)), f = b * rnd(1.1, 1.25);
      for (var i = 0; i < n; i++) {
        chirp(c, bus, t, { f0: f, f1: f * 1.12, dur: 0.055, gain: 0.36, attack: 0.006 });
        f *= rnd(1.03, 1.06); t += 0.07;
      }
      return t + 0.05;
    },

    sigh: function (c, bus, t, b) {                  // slow, gentle falling finish
      var d = rnd(0.45, 0.7);
      chirp(c, bus, t, { f0: b * rnd(1.6, 1.8), f1: b * rnd(1.0, 1.1), ease: 0.8, dur: d,
        gain: 0.38, attack: 0.05, vib: rnd(4.5, 6.5), depth: b * 0.015, breath: 0.06 });
      return t + d + 0.05;
    }
  };

  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

  // Build one song phrase starting at time `at`; returns its length in seconds.
  function phrase(c, bus, at) {
    var base = rnd(2100, 2800), t = at;
    curPan = rnd(-0.35, 0.35);

    t = pick([motifs.whistle, motifs.whistle, motifs.chips, motifs.peeps])(c, bus, t, base);

    var parts = Math.floor(rnd(2, 5)), last = null;
    for (var i = 0; i < parts; i++) {
      var m;
      do { m = pick([motifs.roll, motifs.roll, motifs.warble, motifs.peeps, motifs.sweepUp, motifs.whistle]); }
      while (m === last);
      last = m;
      t = m(c, bus, t, base * rnd(0.95, 1.08));
      t += rnd(0.0, 0.12);
    }

    if (Math.random() < 0.75) t = motifs.sigh(c, bus, t, base);
    return t - at;
  }

  /* ----------------------------------------------------------- bird + loop */

  function setSinging(on) {
    if (bird) bird.classList.toggle('singing', !!on);
  }

  function fade(to, secs) {
    if (!graph) return;
    var p = graph.out.gain, now = ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(to, now + secs);
  }

  function sing() {
    var d = phrase(ctx, graph.bus, ctx.currentTime + 0.05);
    setSinging(true);
    clearTimeout(singTimer);
    singTimer = setTimeout(function () { setSinging(false); }, d * 1000 + 250);
    return d;
  }

  function schedule(delayMs) {
    clearTimeout(loopTimer);
    loopTimer = setTimeout(function () {
      if (!loopOn || muted || document.hidden) return;
      var d = sing();
      // Real birds sometimes answer themselves quickly, then rest for a while.
      var rest = Math.random() < 0.25 ? rnd(1500, 3000) : rnd(4500, 10000);
      schedule(d * 1000 + rest);
    }, delayMs);
  }

  function begin(thenSingNow) {
    if (!started || muted) return;
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      graph = buildGraph(ctx);
    }
    var go = function () {
      if (ctx.state !== 'running' || muted) return;
      fade(MASTER_LEVEL, 1.2);
      if (!loopOn) { loopOn = true; schedule(thenSingNow ? 50 : 1400); }
      else if (thenSingNow) schedule(50);
    };
    if (ctx.state === 'running') go();
    else ctx.resume().then(go, function () {});
  }

  function pause() {
    loopOn = false;
    clearTimeout(loopTimer);
    if (graph) fade(0, 0.3);
    setSinging(false);
  }

  // If the browser hasn't allowed sound yet, wait for the first real interaction.
  function waitForGesture() {
    if (waiting) return;
    waiting = true;
    var evts = ['pointerdown', 'keydown', 'touchend', 'click'];
    var once = function () {
      evts.forEach(function (e) { document.removeEventListener(e, once, true); });
      waiting = false;
      begin(false);
    };
    evts.forEach(function (e) { document.addEventListener(e, once, true); });
  }

  /* ----------------------------------------------------------- mute button */

  var ICON_ON  = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>';
  var ICON_OFF = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>';

  function paintButton() {
    if (!btn) return;
    btn.innerHTML = muted ? ICON_OFF : ICON_ON;
    btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    btn.setAttribute('aria-label', muted ? 'Turn canary song on' : 'Mute canary song');
    btn.title = muted ? 'Turn canary song on' : 'Mute canary song';
  }

  function setMuted(m) {
    muted = m;
    try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch (e) {}
    paintButton();
    if (m) pause(); else begin(false);
  }

  function makeButton() {
    if (btn) return;
    var css = document.createElement('style');
    css.textContent =
      '.canary-sound{position:fixed;right:16px;bottom:16px;z-index:60;width:46px;height:46px;border-radius:50%;' +
      'border:2px solid #b4cf7a;background:rgba(42,20,56,.92);color:#f3eaf7;display:flex;align-items:center;justify-content:center;' +
      'cursor:pointer;padding:0;box-shadow:0 4px 14px rgba(0,0,0,.35);transition:transform .15s,background .15s}' +
      '.canary-sound:hover{transform:scale(1.07);background:#3b1d4e}' +
      '.canary-sound:focus-visible{outline:3px solid #b4cf7a;outline-offset:3px}';
    document.head.appendChild(css);
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'canary-sound';
    btn.addEventListener('click', function () { setMuted(!muted); });
    document.body.appendChild(btn);
    paintButton();
  }

  /* --------------------------------------------------------------- public */

  function start() {
    if (started) return;
    started = true;
    bird = document.getElementById('canary');
    makeButton();
    if (bird) {
      bird.addEventListener('click', function () {      // click the bird to hear it sing now
        if (muted) { muted = false; try { localStorage.setItem(MUTE_KEY, '0'); } catch (e) {} paintButton(); }
        begin(true);
      });
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) pause(); else begin(false);
    });
    var active = navigator.userActivation ? navigator.userActivation.hasBeenActive : false;
    if (active) begin(false); else waitForGesture();
  }

  // Renders one phrase offline (no speakers needed); used to check the sound.
  function renderPhrase(seconds) {
    var Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var c = new Off(2, Math.floor(44100 * seconds), 44100);
    var g = buildGraph(c);
    g.out.gain.value = MASTER_LEVEL;
    var d = phrase(c, g.bus, 0.05);
    return c.startRendering().then(function (buf) {
      return { duration: d, data: Array.prototype.slice.call(buf.getChannelData(0)) };
    });
  }

  window.Canary = {
    start: start,
    renderPhrase: renderPhrase,
    state: function () { return { started: started, muted: muted, loopOn: loopOn, ctx: ctx ? ctx.state : 'none' }; }
  };
})();
