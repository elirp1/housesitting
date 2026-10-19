/*
  Canary song + sound toggle, shared by every page.

  - The song is synthesised in the browser (Web Audio), so there is no audio file to host.
  - Browsers only allow sound after the visitor has interacted with the page. The password
    screen provides that interaction; if it isn't available, the song starts on the first click,
    tap or key press instead.
  - On the home page, if an element with id="canary" exists, it gets the class "singing"
    while a phrase is playing so the bird can animate in time with the song.
*/
(function () {
  'use strict';

  var MUTE_KEY = 'canaryMuted';
  var MASTER_LEVEL = 0.24;          // overall volume: soft and relaxing
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
    var tone = c.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 7000;
    var bus = c.createGain();
    var wet = c.createGain();  wet.gain.value = 0.32;
    var verb = c.createConvolver(); verb.buffer = impulse(c, 1.7, 2.6);
    bus.connect(tone); bus.connect(verb); verb.connect(wet); wet.connect(tone);
    tone.connect(out); out.connect(c.destination);
    return { bus: bus, out: out };
  }

  // One syllable: a short gliding whistle, optionally with vibrato, plus a faint overtone for sparkle.
  function chirp(c, bus, t, o) {
    var parts = [{ mult: 1, vol: 1 }, { mult: 2, vol: 0.14 }];
    for (var p = 0; p < parts.length; p++) {
      var m = parts[p].mult;
      var osc = c.createOscillator(); osc.type = 'sine';
      osc.frequency.setValueAtTime(o.f0 * m, t);
      osc.frequency.exponentialRampToValueAtTime(o.f1 * m, t + o.dur);
      if (o.vib) {
        var lfo = c.createOscillator(), depth = c.createGain();
        lfo.frequency.value = o.vib; depth.gain.value = (o.depth || 0) * m;
        lfo.connect(depth); depth.connect(osc.frequency);
        lfo.start(t); lfo.stop(t + o.dur + 0.05);
      }
      var g = c.createGain();
      var peak = o.gain * parts[p].vol;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.014, o.dur * 0.3));
      g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
      osc.connect(g); g.connect(bus);
      osc.start(t); osc.stop(t + o.dur + 0.05);
    }
  }

  function rnd(a, b) { return a + Math.random() * (b - a); }

  var motifs = {
    whistle: function (c, bus, t, b) {               // soft rising or falling "tweeee"
      var up = Math.random() < 0.6, d = rnd(0.3, 0.5);
      chirp(c, bus, t, { f0: up ? b : b * 1.5, f1: up ? b * 1.5 : b * 1.1, dur: d, gain: 0.5, vib: rnd(6, 9), depth: b * 0.012 });
      return t + d + 0.1;
    },
    roll: function (c, bus, t, b) {                  // the classic canary trill
      var n = Math.floor(rnd(8, 21)), hi = b * rnd(1.55, 1.75), lo = b * 1.15;
      for (var i = 0; i < n; i++) {
        var a = i % 2 === 0;
        chirp(c, bus, t, { f0: a ? hi : lo * 1.05, f1: a ? lo : hi * 0.97, dur: 0.05, gain: 0.36 });
        t += 0.062;
      }
      return t + 0.06;
    },
    warble: function (c, bus, t, b) {                // little descending warble
      var f = b * rnd(1.8, 2.0), n = Math.floor(rnd(4, 7));
      for (var i = 0; i < n; i++) {
        chirp(c, bus, t, { f0: f, f1: f * 0.8, dur: 0.1, gain: 0.42, vib: 28, depth: f * 0.03 });
        f *= 0.9; t += 0.125;
      }
      return t + 0.08;
    },
    chips: function (c, bus, t, b) {                 // a few bright chip notes
      var n = Math.floor(rnd(3, 6));
      for (var i = 0; i < n; i++) {
        chirp(c, bus, t, { f0: b * 1.4, f1: b * 1.7, dur: 0.07, gain: 0.4 });
        t += 0.17;
      }
      return t + 0.05;
    },
    sigh: function (c, bus, t, b) {                  // slow, gentle falling finish
      chirp(c, bus, t, { f0: b * 1.7, f1: b * 1.05, dur: 0.55, gain: 0.38, vib: 5, depth: b * 0.015 });
      return t + 0.62;
    }
  };

  // Build one song phrase starting at time `at`; returns its length in seconds.
  function phrase(c, bus, at) {
    var base = rnd(2200, 2800), t = at;
    t = (Math.random() < 0.6 ? motifs.whistle : motifs.chips)(c, bus, t, base);
    var middle = Math.random() < 0.5 ? 2 : 1;
    for (var i = 0; i < middle; i++) t = (Math.random() < 0.55 ? motifs.roll : motifs.warble)(c, bus, t, base);
    if (Math.random() < 0.7) t = motifs.sigh(c, bus, t, base);
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
      schedule(d * 1000 + rnd(5000, 11000));          // rest between phrases
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
