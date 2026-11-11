/* Afterglow — sound. Six generated tracks (Web Audio only, no samples), microphone, and file upload.
   Everything is analysed in the browser; nothing is recorded or sent anywhere. */
(function () {
  'use strict';
  const AG = (window.AG = window.AG || {});
  const B = AG.B;
  let ctx = null, pre, master, analyser, reverb, fft, vol = 0.8;
  let cur = null;          // { kind:'track'|'mic'|'file', idx, name, hue, stop() }
  const listeners = [];
  const emit = () => listeners.forEach((f) => f(cur));

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      pre = ctx.createGain(); master = ctx.createGain(); master.gain.value = vol;
      analyser = ctx.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.78;
      fft = new Uint8Array(analyser.frequencyBinCount);
      const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 3;
      pre.connect(comp); comp.connect(master); master.connect(ctx.destination); pre.connect(analyser);
      reverb = ctx.createConvolver();
      const len = ctx.sampleRate * 3, ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
      reverb.buffer = ir; const rg = ctx.createGain(); rg.gain.value = 0.5; reverb.connect(rg); rg.connect(pre);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  const noiseCache = {};
  function noise(kind) {
    if (noiseCache[kind]) return noiseCache[kind];
    const len = ctx.sampleRate * 4, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let l = 0, b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else if (kind === 'brown') { l = (l + 0.02 * w) / 1.02; d[i] = l * 3.5; }
      else if (kind === 'pink') { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
      else if (kind === 'crackle') d[i] = Math.random() < 0.0009 ? (Math.random() * 2 - 1) * 0.9 : w * 0.012;
    }
    return (noiseCache[kind] = buf);
  }

  /* A voice kit bound to one track's output bus */
  function kit(out, wet) {
    const live = [];
    const K = {
      loop(kind, gain, ftype, freq, q) {
        const s = ctx.createBufferSource(); s.buffer = noise(kind); s.loop = true;
        const f = ctx.createBiquadFilter(); f.type = ftype || 'lowpass'; f.frequency.value = freq || 8000; if (q) f.Q.value = q;
        const g = ctx.createGain(); g.gain.value = gain;
        s.connect(f); f.connect(g); g.connect(out); s.start(); live.push(s);
        return { g, f };
      },
      lfo(param, rate, depth) {
        const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = rate; g.gain.value = depth;
        o.connect(g); g.connect(param); o.start(); live.push(o);
      },
      drone(freq, type, gain, cutoff, det) {
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
        const g = ctx.createGain(); g.gain.value = gain; f.connect(g); g.connect(out); if (wet) g.connect(wet);
        [-(det || 6), det || 6].forEach((dt) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; o.detune.value = dt; o.connect(f); o.start(); live.push(o); });
        return { f, g };
      },
      note(freq, t, dur, o) {
        o = o || {};
        const osc = ctx.createOscillator(), g = ctx.createGain(); osc.type = o.type || 'sine'; osc.frequency.value = freq; if (o.detune) osc.detune.value = o.detune;
        const pk = o.gain || 0.1, at = o.attack || 0.01;
        g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(pk, t + at);
        if (o.sustain) { g.gain.setValueAtTime(pk, t + dur - (o.release || 0.3)); g.gain.linearRampToValueAtTime(0.0001, t + dur); }
        else g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        let node = osc;
        if (o.cutoff) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.cutoff; osc.connect(f); node = f; }
        node.connect(g); g.connect(out); if (wet && o.wet) { const w = ctx.createGain(); w.gain.value = o.wet; g.connect(w); w.connect(wet); }
        osc.start(t); osc.stop(t + dur + 0.05);
      },
      keys(m, t, dur, gain) {           // soft electric-piano: sine + quiet octave, quick attack, long decay
        const f = mtof(m);
        K.note(f, t, dur, { gain: gain, attack: 0.008, wet: 0.35 });
        K.note(f * 2, t, dur * 0.5, { gain: gain * 0.22, attack: 0.004 });
        K.note(f * 1.003, t, dur, { gain: gain * 0.5, type: 'triangle', cutoff: 1400 });
      },
      pluck(m, t, gain) {
        const f = mtof(m);
        K.note(f, t, 0.9, { gain: gain, attack: 0.003, wet: 0.5 });
        K.note(f * 3.01, t, 0.12, { gain: gain * 0.25, attack: 0.002 });
      },
      bell(m, t, gain) {
        const f = mtof(m);
        K.note(f, t, 4.5, { gain: gain, attack: 0.01, wet: 0.9 });
        K.note(f * 2.76, t, 1.6, { gain: gain * 0.2, attack: 0.005, wet: 0.9 });
      },
      pad(ms, t, dur, gain, type, cutoff) {
        ms.forEach((m, i) => K.note(mtof(m), t, dur, { gain: gain, type: type || 'triangle', attack: dur * 0.3, sustain: true, release: dur * 0.35, cutoff: cutoff || 1200, detune: i % 2 ? 5 : -5, wet: 0.6 }));
      },
      kick(t, gain) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.setValueAtTime(115, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
        g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.35);
      },
      hit(t, gain, ftype, freq, dur) {   // noise burst: snare / hat
        const s = ctx.createBufferSource(); s.buffer = noise('white');
        const f = ctx.createBiquadFilter(); f.type = ftype; f.frequency.value = freq;
        const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        s.connect(f); f.connect(g); g.connect(out); s.start(t, Math.random() * 3); s.stop(t + dur + 0.02);
      },
      stereo(freq, pan, gain) {         // one steady tone in one ear
        const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = freq; g.gain.value = gain; o.connect(g);
        if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(out); } else g.connect(out);
        o.start(); live.push(o);
      },
      pulse(freqs, rate, gain) {        // tones switched on and off `rate` times a second
        const am = ctx.createGain(); am.gain.value = 0.5; const g = ctx.createGain(); g.gain.value = gain; am.connect(g); g.connect(out);
        freqs.forEach((f) => { const o = ctx.createOscillator(); o.frequency.value = f; o.connect(am); o.start(); live.push(o); });
        const l = ctx.createOscillator(), lg = ctx.createGain(); l.frequency.value = rate; lg.gain.value = 0.5; l.connect(lg); lg.connect(am.gain); l.start(); live.push(l);
      },
      stop() { live.forEach((n) => { try { n.stop(); } catch (e) {} }); },
    };
    return K;
  }

  const pick = (a) => a[(Math.random() * a.length) | 0];

  /* Each track: { name, hue, mood, bpm, cutoff, init(K), step(K, i, t, spb) } — step is called once per 16th note */
  const TRACKS = [
    { name: 'Night Desk', icon: 'desk', mood: 'Lofi · 72 bpm', hue: 226, bpm: 72, cutoff: 3200,
      chords: [[50, 57, 60, 64, 65], [43, 53, 57, 59, 64], [48, 55, 59, 62, 64], [45, 55, 60, 64, 67]],
      init(K) { K.loop('crackle', 0.5, 'highpass', 1200); },
      step(K, i, t, s) {
        const bar = (i >> 4) % 4, p = i % 16, ch = this.chords[bar], sw = p % 2 ? s * 0.28 : 0;
        if (p === 0 || p === 7) ch.slice(1).forEach((m, k) => K.keys(m, t + sw + k * 0.012, s * 7, 0.055));
        if (p === 0 || p === 10) K.note(mtof(ch[0] - 12), t, s * 5, { gain: 0.2, attack: 0.02 });
        if (p === 0 || p === 6 || p === 10) K.kick(t + sw, p === 6 ? 0.3 : 0.5);
        if (p === 4 || p === 12) K.hit(t, 0.16, 'bandpass', 1700, 0.16);
        if (p % 2 === 0 || Math.random() < 0.2) K.hit(t + sw, p % 4 === 2 ? 0.05 : 0.028, 'highpass', 7500, 0.04);
        if (p % 4 === 2 && Math.random() < 0.3) K.keys(pick(ch.slice(2)) + 12, t + sw, s * 4, 0.035);
      } },
    { name: 'Rain on Glass', icon: 'rain', mood: 'Rain · slow piano', hue: 190, bpm: 60, cutoff: 9000,
      chords: [[53, 57, 60, 64], [57, 60, 64, 67], [50, 57, 60, 65], [48, 55, 59, 64]],
      init(K) { K.loop('white', 0.075, 'highpass', 2200); const b = K.loop('pink', 0.3, 'lowpass', 900); K.lfo(b.g.gain, 0.07, 0.1); },
      step(K, i, t, s) {
        const bar = (i >> 5) % 4, ch = this.chords[bar];
        if (i % 32 === 0) K.pad(ch, t, s * 34, 0.035, 'triangle', 900);
        if (i % 4 === 0 && Math.random() < 0.42) K.keys(pick(ch) + pick([12, 12, 24]), t + Math.random() * 0.05, s * 10, 0.05);
        if (Math.random() < 0.05) K.pluck(pick(ch) + 24, t, 0.025);
      } },
    { name: 'Slow Tide', icon: 'tide', mood: 'Ambient · drone', hue: 163, bpm: 60, cutoff: 6000,
      init(K) {
        [38, 45, 50, 54].forEach((m, k) => { const d = K.drone(mtof(m), 'sawtooth', 0.05, 500, 7 + k); K.lfo(d.f.frequency, 0.03 + k * 0.017, 320); });
        const sea = K.loop('pink', 0.22, 'lowpass', 700); K.lfo(sea.g.gain, 0.09, 0.2); K.lfo(sea.f.frequency, 0.09, 400);
      },
      step(K, i, t, s) {
        if (i % 16 === 0 && Math.random() < 0.55) K.note(mtof(pick([62, 66, 69, 74, 76])), t, s * 30, { gain: 0.03, attack: s * 10, sustain: true, release: s * 12, wet: 1 });
      } },
    { name: 'Paper Lanterns', icon: 'lantern', mood: 'Lofi · 84 bpm', hue: 30, bpm: 84, cutoff: 4200,
      chords: [[48, 55, 59, 64], [52, 55, 59, 62], [53, 57, 60, 64], [55, 59, 62, 64]],
      scale: [60, 62, 64, 67, 69, 72, 74, 76],
      init(K) { K.loop('crackle', 0.35, 'highpass', 1500); },
      step(K, i, t, s) {
        const bar = (i >> 4) % 4, p = i % 16, ch = this.chords[bar], sw = p % 2 ? s * 0.22 : 0;
        if (p === 0) K.pad(ch, t, s * 17, 0.03, 'triangle', 1000);
        if (p === 0 || p === 8 || p === 11) K.note(mtof(ch[0] - 12), t + sw, s * 3, { gain: 0.17, attack: 0.015 });
        if (p % 2 === 0 ? Math.random() < 0.6 : Math.random() < 0.22) K.pluck(pick(this.scale), t + sw, 0.07);
        if (p === 0 || p === 9) K.kick(t + sw, 0.38);
        if (p === 4 || p === 12) K.hit(t, 0.1, 'bandpass', 2100, 0.12);
        if (p % 2 === 0) K.hit(t + sw, 0.022, 'highpass', 8000, 0.03);
      } },
    { name: 'Deep Field', icon: 'field', mood: 'Space · bells', hue: 268, bpm: 60, cutoff: 10000,
      init(K) {
        K.drone(mtof(36), 'sine', 0.16, 300, 3);
        [60, 67, 74, 76].forEach((m, k) => { const d = K.drone(mtof(m), 'sine', 0.022, 4000, 4); K.lfo(d.g.gain, 0.05 + k * 0.03, 0.018); });
        K.loop('pink', 0.03, 'bandpass', 3000, 2);
      },
      step(K, i, t) {
        if (i % 8 === 0 && Math.random() < 0.5) { const m = pick([72, 74, 79, 81, 84, 86, 88]); K.bell(m, t, 0.05); K.bell(m, t + 0.42, 0.02); K.bell(m, t + 0.84, 0.009); }
      } },
    { name: 'Brown Noise', icon: 'noise', mood: 'Noise · steady', hue: 208, bpm: 60, cutoff: 12000,
      init(K) { K.loop('brown', 0.5, 'lowpass', 650); K.loop('pink', 0.05, 'lowpass', 2500); K.drone(55, 'sine', 0.03, 200, 2); },
      step() {} },
    { name: 'Gamma 40 Binaural', icon: 'phones', mood: '40 Hz · headphones', hue: 338, bpm: 60, cutoff: 9000,
      // 200 Hz in the left ear, 240 Hz in the right: the 40 Hz difference only exists with headphones on
      init(K) { K.stereo(200, -1, 0.16); K.stereo(240, 1, 0.16); K.loop('pink', 0.09, 'lowpass', 1400); K.loop('brown', 0.16, 'lowpass', 500); },
      step(K, i, t, s) { if (i % 64 === 0) K.pad([50, 57, 62], t, s * 60, 0.014, 'sine', 900); } },
    { name: 'Gamma 40 Pulse', icon: 'pulse', mood: '40 Hz · speakers ok', hue: 52, bpm: 60, cutoff: 9000,
      // a soft chord pulsed 40 times a second, audible on any speaker
      init(K) { K.pulse([220, 330, 440], 40, 0.075); K.loop('pink', 0.1, 'lowpass', 1600); K.loop('brown', 0.14, 'lowpass', 500); },
      step(K, i, t, s) { if (i % 64 === 0) K.pad([45, 57, 64], t, s * 60, 0.014, 'sine', 900); } },
  ];

  function startTrack(idx) {
    const tr = TRACKS[idx];
    const bus = ctx.createGain(); bus.gain.value = 0.0001; bus.gain.linearRampToValueAtTime(1, ctx.currentTime + 1.2);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = tr.cutoff;
    const wet = ctx.createGain(); wet.gain.value = 1;
    bus.connect(lp); lp.connect(pre); wet.connect(reverb);
    const K = kit(bus, wet);
    tr.init(K);
    const spb = 60 / tr.bpm / 4;
    let i = 0, next = ctx.currentTime + 0.12, alive = true;
    // schedules ~1.6 s ahead so it keeps playing when the tab is in the background (timers slow to 1/s there)
    const pump = () => { if (!alive) return; while (next < ctx.currentTime + 1.7) { tr.step(K, i, next, spb); i++; next += spb; } };
    pump(); const iv = setInterval(pump, 250);
    return {
      stop() {
        alive = false; clearInterval(iv);
        const t = ctx.currentTime; bus.gain.cancelScheduledValues(t); bus.gain.setValueAtTime(bus.gain.value, t); bus.gain.linearRampToValueAtTime(0.0001, t + 0.7);
        wet.gain.linearRampToValueAtTime(0.0001, t + 0.7);
        setTimeout(() => { K.stop(); try { bus.disconnect(); wet.disconnect(); } catch (e) {} }, 900);
      },
    };
  }

  function stop() { if (cur) { try { cur.stop(); } catch (e) {} cur = null; } emit(); }

  const A = (AG.audio = {
    TRACKS,
    get current() { return cur; },
    get playing() { return !!cur; },
    get supported() { return !!(window.AudioContext || window.webkitAudioContext); },
    on(f) { listeners.push(f); },
    stop,
    playTrack(idx) {
      if (!ensure()) return false;
      idx = ((idx % TRACKS.length) + TRACKS.length) % TRACKS.length;
      if (cur) { try { cur.stop(); } catch (e) {} }
      const h = startTrack(idx), tr = TRACKS[idx];
      cur = { kind: 'track', idx, name: tr.name, hue: tr.hue, icon: tr.icon, stop: h.stop }; A.lastTrack = idx; emit(); return true;
    },
    lastTrack: 0,
    toggle() { if (cur) stop(); else A.playTrack(A.lastTrack); },
    next(d) { A.playTrack((cur && cur.kind === 'track' ? cur.idx : A.lastTrack) + (d || 1)); },
    async mic() {
      if (!ensure()) throw new Error('no-audio');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('unsupported');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      if (cur) { try { cur.stop(); } catch (e) {} }
      const src = ctx.createMediaStreamSource(stream), g = ctx.createGain(); g.gain.value = 2.2;
      src.connect(g); g.connect(analyser);   // analysed only — never sent to the speakers or stored
      cur = { kind: 'mic', name: 'Microphone', hue: 150, stop() { stream.getTracks().forEach((t) => t.stop()); try { g.disconnect(); } catch (e) {} } };
      emit();
    },
    /* Analyse the sound of another browser tab (desktop Chrome / Edge). The tab keeps playing through
       your speakers or headphones as normal; this page only reads the signal. Nothing is recorded. */
    get tabSupported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia); },
    async tab() {
      if (!ensure()) throw new Error('no-audio');
      if (!A.tabSupported) throw new Error('unsupported');
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false }, systemAudio: 'include' });
      if (!stream.getAudioTracks().length) { stream.getTracks().forEach((t) => t.stop()); const e = new Error('no-tab-audio'); e.name = 'NoAudio'; throw e; }
      stream.getVideoTracks().forEach((t) => (t.enabled = false));   // the picture is never used
      if (cur) { try { cur.stop(); } catch (e) {} }
      const src = ctx.createMediaStreamSource(stream), g = ctx.createGain(); g.gain.value = 1.4; src.connect(g); g.connect(analyser);
      const me = (cur = { kind: 'tab', name: 'Another tab', hue: 286, stop() { stream.getTracks().forEach((t) => t.stop()); try { g.disconnect(); } catch (e) {} } });
      stream.getAudioTracks()[0].addEventListener('ended', () => { if (cur === me) { cur = null; emit(); } });
      emit();
    },
    file(file) {
      if (!ensure()) return;
      if (cur) { try { cur.stop(); } catch (e) {} }
      const el = new Audio(); const url = URL.createObjectURL(file); el.src = url; el.loop = true;
      const src = ctx.createMediaElementSource(el); src.connect(pre);
      el.play().catch(() => {});
      cur = { kind: 'file', name: file.name.replace(/\.[^.]+$/, '').slice(0, 40), hue: 312, stop() { el.pause(); try { src.disconnect(); } catch (e) {} URL.revokeObjectURL(url); } };
      emit();
    },
    setVolume(v) { vol = v; if (master) master.gain.value = v; },
    get volume() { return vol; },
    chime(up) {
      if (!ensure()) return; const t = ctx.currentTime, K = kit(master, null);
      (up ? [72, 76, 79, 84] : [79, 72]).forEach((m, k) => K.note(mtof(m), t + k * 0.16, 1.4, { gain: 0.07 }));
    },
    /* 16 log-spaced bands, 0..1, with slow automatic gain so quiet sources still shape the form */
    bands: new Float32Array(B), level: 0, bass: 0, mid: 0, high: 0,
    sample() {
      const out = A.bands;
      if (!ctx || !cur) { for (let b = 0; b < B; b++) out[b] *= 0.9; A.level *= 0.9; A.bass *= 0.9; A.mid *= 0.9; A.high *= 0.9; return out; }
      analyser.getByteFrequencyData(fft);
      const ny = ctx.sampleRate / 2, n = fft.length; let mx = 0;
      for (let b = 0; b < B; b++) {
        const f0 = 45 * Math.pow(13000 / 45, b / B), f1 = 45 * Math.pow(13000 / 45, (b + 1) / B);
        const i0 = Math.max(1, Math.floor((f0 / ny) * n)), i1 = Math.max(i0 + 1, Math.ceil((f1 / ny) * n));
        let s = 0; for (let i = i0; i < i1 && i < n; i++) s += fft[i];
        const v = (s / (i1 - i0) / 255) * (1 + b * 0.09);
        raw[b] = v; if (v > mx) mx = v;
      }
      peak = Math.max(peak * 0.9985, mx, 0.12);
      let lv = 0;
      for (let b = 0; b < B; b++) { const v = Math.min(1, raw[b] / peak); out[b] += (v - out[b]) * 0.35; lv += out[b]; }
      A.level = lv / B;
      A.bass = (out[0] + out[1] + out[2] + out[3]) / 4; A.mid = (out[5] + out[6] + out[7] + out[8] + out[9]) / 5; A.high = (out[11] + out[12] + out[13] + out[14]) / 4;
      return out;
    },
  });
  const raw = new Float32Array(B); let peak = 0.3;
})();
