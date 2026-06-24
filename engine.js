(function () {
  'use strict';

  // ===== Synth: shared AudioContext + square-wave tone generator =====
  const Synth = {
    ctx: null,
    init() {
      try {
        if (!this.ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) this.ctx = new AC();
        }
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) {
        this.ctx = null;
      }
    },
    tone(freq, start, dur, gain, out) {
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime + start;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain, t0 + 0.005);
      g.gain.linearRampToValueAtTime(gain * 0.6, t0 + dur * 0.6);
      g.gain.linearRampToValueAtTime(0, t0 + dur);
      osc.connect(g).connect(out || this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },
  };

  // ===== Sequencer: two-track (melody + bass) square-wave looper =====
  // `mel` and `bass` are flat [freq, dur, freq, dur, ...] arrays. Both tracks
  // route through a single master gain node so the whole mix can be ducked.
  class Sequencer {
    constructor({ synth, mel, bass, masterGain = 0.032, melGain = 0.032, bassGain = 0.025 }) {
      this.synth = synth;
      this.mel = mel;
      this.bass = bass;
      this.masterGain = masterGain;
      this.melGain = melGain;
      this.bassGain = bassGain;
      this.mi = 0;
      this.bi = 0;
      this.nextMel = 0;
      this.nextBass = 0;
      this.id = null;
      this.resumeId = null;
      this.gain = null;
    }

    play() {
      if (!this.synth.ctx) return;
      this.stop();
      this.gain = this.synth.ctx.createGain();
      this.gain.gain.value = this.masterGain;
      this.gain.connect(this.synth.ctx.destination);
      this.mi = this.bi = 0;
      const t = this.synth.ctx.currentTime + 0.05;
      this.nextMel = t;
      this.nextBass = t;
      this.step();
      this.id = setInterval(() => this.step(), 50);
    }

    step() {
      if (!this.synth.ctx) return;
      const t = this.synth.ctx.currentTime;
      if (t + 0.12 >= this.nextMel) {
        const f = this.mel[this.mi * 2];
        const d = this.mel[this.mi * 2 + 1];
        this.synth.tone(f, this.nextMel - t, d, this.melGain, this.gain);
        this.nextMel += d;
        this.mi = (this.mi + 1) % (this.mel.length / 2);
      }
      if (t + 0.12 >= this.nextBass) {
        const f = this.bass[this.bi * 2];
        const d = this.bass[this.bi * 2 + 1];
        this.synth.tone(f, this.nextBass - t, d, this.bassGain, this.gain);
        this.nextBass += d;
        this.bi = (this.bi + 1) % (this.bass.length / 2);
      }
    }

    stop() {
      if (this.id) {
        clearInterval(this.id);
        this.id = null;
      }
    }

    // Mute the master gain now, then fade back to `masterGain` after
    // `durationMs` + a 100ms pad. Used to duck the music under SFX.
    duck(durationMs) {
      if (!this.synth.ctx || !this.gain) return;
      this.gain.gain.setValueAtTime(0, this.synth.ctx.currentTime);
      clearTimeout(this.resumeId);
      this.resumeId = setTimeout(() => {
        this.gain.gain.linearRampToValueAtTime(this.masterGain, this.synth.ctx.currentTime + 0.2);
      }, durationMs + 100);
    }
  }

  // ===== Keyboard: keydown dispatcher =====
  // Bind keys to handlers with `.on(...)`. Each handler returns true to
  // consume the event (auto-preventDefault + stop dispatch), or false /
  // undefined to fall through to the next binding or the fallback. This
  // contract lets callers reproduce state-dependent control flow exactly.
  const Keyboard = {
    _bindings: [],
    _fallback: null,
    _installed: false,

    on(keys, handler) {
      const list = Array.isArray(keys) ? keys : [keys];
      this._bindings.push({ keys: list, handler });
      return this;
    },

    fallback(handler) {
      this._fallback = handler;
      return this;
    },

    install() {
      if (this._installed) return this;
      this._installed = true;
      window.addEventListener('keydown', (e) => {
        let consumed = false;
        for (const b of this._bindings) {
          if (b.keys.includes(e.key) && b.handler(e) === true) {
            consumed = true;
            break;
          }
        }
        if (!consumed && this._fallback && this._fallback(e) === true) {
          consumed = true;
        }
        if (consumed) e.preventDefault();
      });
      return this;
    },
  };

  // ===== Util =====
  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  window.Engine = { Synth, Sequencer, Keyboard, Util: { randInt, clamp, shuffle } };
})();
