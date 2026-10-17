'use strict';
// 音效：Web Audio 实时合成（无外部音频文件）。首次用户操作后解锁；开关与音量由「设置」保存。
(function (CM) {
  const S = CM.Settings;
  const pref = { enabled: S ? S.get('sound') : true, volume: S ? S.get('volume') : 0.6 };
  let ac = null, master = null, noiseBuf = null;
  const last = {};

  function ensure() {
    if (!pref.enabled) return null;
    if (!ac) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ac = new AC();
        const comp = ac.createDynamicsCompressor();
        comp.threshold.value = -16; comp.ratio.value = 4;
        master = ac.createGain(); master.gain.value = pref.volume * 0.9;
        master.connect(comp); comp.connect(ac.destination);
        noiseBuf = ac.createBuffer(1, ac.sampleRate * 1, ac.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      } catch (e) { ac = null; return null; }
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  window.addEventListener('pointerdown', function () { if (pref.enabled) ensure(); }, true);
  window.addEventListener('keydown', function () { if (pref.enabled) ensure(); }, true);

  // 单音：频率、时长、波形、音量、起始延迟、滑音终点
  function tone(f, dur, type, gain, delay, f2, attack) {
    const t0 = ac.currentTime + (delay || 0);
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f, t0);
    if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t0 + dur);
    const a = attack || 0.006;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  // 铃声：基频 + 泛音
  function bell(f, dur, gain, delay) {
    tone(f, dur, 'sine', gain, delay, null, 0.004);
    tone(f * 2.01, dur * 0.6, 'sine', gain * 0.35, delay, null, 0.004);
    tone(f * 3.02, dur * 0.35, 'sine', gain * 0.12, delay, null, 0.004);
  }
  // 噪声：带通/低通，可扫频
  function noise(dur, type, freq, q, gain, delay, freq2) {
    const t0 = ac.currentTime + (delay || 0);
    const src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const flt = ac.createBiquadFilter(); flt.type = type || 'bandpass'; flt.Q.value = q || 1;
    flt.frequency.setValueAtTime(freq, t0);
    if (freq2) flt.frequency.exponentialRampToValueAtTime(freq2, t0 + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.03, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(flt); flt.connect(g); g.connect(master);
    src.start(t0, Math.random() * 0.5); src.stop(t0 + dur + 0.02);
  }

  const SFX = {
    click: function () { tone(2100, 0.03, 'triangle', 0.035); },
    soft: function () { tone(660, 0.07, 'sine', 0.06); },
    open: function () { tone(520, 0.09, 'sine', 0.05, 0, 780); },
    close: function () { tone(760, 0.08, 'sine', 0.04, 0, 500); },
    tool: function () { tone(880, 0.06, 'triangle', 0.06); tone(1320, 0.08, 'triangle', 0.045, 0.05); },
    place: function () { tone(190, 0.14, 'sine', 0.22, 0, 85); noise(0.06, 'highpass', 2500, 0.7, 0.05); },
    lay: function () { noise(0.16, 'bandpass', 500, 0.8, 0.09); tone(392, 0.09, 'triangle', 0.07, 0.02); tone(587, 0.12, 'triangle', 0.06, 0.09); },
    demolish: function () { noise(0.4, 'lowpass', 1100, 0.6, 0.22, 0, 200); tone(120, 0.3, 'sawtooth', 0.05, 0, 55); },
    build: function () {
      for (let k = 0; k < 3; k++) { noise(0.05, 'bandpass', 1800, 2, 0.12, k * 0.09); tone(150, 0.07, 'square', 0.03, k * 0.09, 90); }
      bell(784, 0.5, 0.09, 0.32); bell(988, 0.5, 0.08, 0.46); bell(1175, 0.8, 0.08, 0.6);
    },
    good: function () { tone(784, 0.1, 'sine', 0.06); tone(1047, 0.16, 'sine', 0.06, 0.08); },
    error: function () { tone(230, 0.11, 'square', 0.045); tone(175, 0.16, 'square', 0.045, 0.1); },
    notify: function () { bell(988, 0.22, 0.045); bell(1319, 0.3, 0.04, 0.09); },
    fanfare: function () { const n = [523, 659, 784, 1047]; n.forEach(function (f, i) { tone(f, 0.22, 'triangle', 0.07, i * 0.09); }); bell(1568, 0.7, 0.06, 0.38); },
    unlock: function () { [660, 880, 1100, 1320].forEach(function (f, i) { bell(f, 0.35, 0.045, i * 0.07); }); },
    month: function () { bell(1568, 0.12, 0.02); },
    whoosh: function () { noise(0.55, 'bandpass', 300, 1.2, 0.12, 0, 3200); },
    swoosh: function () { noise(0.28, 'bandpass', 600, 1, 0.07, 0, 2400); },
    chime: function () { bell(1047, 0.4, 0.07); bell(784, 0.6, 0.07, 0.16); },
    pause: function () { tone(620, 0.09, 'sine', 0.05, 0, 400); },
    play: function () { tone(420, 0.09, 'sine', 0.05, 0, 680); },
    toggle: function () { tone(900, 0.05, 'triangle', 0.05); tone(1250, 0.06, 'triangle', 0.045, 0.05); },
    fail: function () { [392, 330, 262].forEach(function (f, i) { tone(f, 0.3, 'sawtooth', 0.04, i * 0.18); }); },
    coin: function () { bell(1319, 0.18, 0.035); bell(1976, 0.3, 0.03, 0.07); },
    celebrate: function () {
      [523, 659, 784, 1047, 1319].forEach(function (f, i) { tone(f, 0.28, 'triangle', 0.06, i * 0.07); });
      noise(0.5, 'highpass', 5000, 0.7, 0.05, 0.32);
      bell(2093, 0.9, 0.05, 0.42); bell(1568, 0.9, 0.04, 0.5);
    },
  };

  const Sound = {
    get enabled() { return pref.enabled; },
    get volume() { return pref.volume; },
    play: function (name) {
      if (!pref.enabled || !SFX[name]) return;
      const a = ensure(); if (!a || a.state !== 'running' && a.state !== 'suspended') return;
      const now = performance.now();
      if (last[name] && now - last[name] < 45) return;
      if (name === 'click' && last._any && now - last._any < 25) return;
      last[name] = now; last._any = now;
      try { SFX[name](); } catch (e) { /* 忽略音频错误 */ }
    },
    setEnabled: function (on) { pref.enabled = !!on; if (on) ensure(); },
    setVolume: function (v) { pref.volume = Math.max(0, Math.min(1, v)); if (master) master.gain.value = pref.volume * 0.9; },
  };
  CM.Sound = Sound;
})(window.CM);
