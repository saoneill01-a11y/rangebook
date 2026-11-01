/* Copyright (C) 2026 Sean O'Neill. SPDX-License-Identifier: AGPL-3.0-or-later. See the LICENSE file. */
/* Range Book shot timer (2.43.7): runs inside the browser's audio engine and finds the start of each loud sound from the
   microphone, to the sample, so splits are exact. Nothing is recorded or sent anywhere: it only reports times and levels.
   An onset counts when the sound's envelope rises past the threshold (and well above the background noise), the last one
   has died back down to half the threshold (or the new sound jumps to almost twice what's already playing, like a shot
   during a beep), and at least the minimum gap has passed (so one shot's echo isn't a second shot).
   Each onset is reported 12 ms later with "tone": how much of that first 12 ms is a single pitch at the timer's beep
   frequencies (2,400 or 3,200 Hz). The timer's own beeps score near 1; a shot is noise across every pitch and scores near 0,
   so the page can ignore its own beeps without ignoring a shot fired at the same moment. A jump over a sound that's already
   playing is always reported as tone 0: beeps start from quiet. */
class RBShots extends AudioWorkletProcessor {
  constructor() {
    super();
    this.th = 0.3;          // threshold, 0..1 of full scale
    this.ratio = 6;         // and this many times the background level
    this.gap = Math.round(sampleRate * 0.08); // shortest split, in samples
    this.last = -1e12;      // frame of the last onset
    this.armed = true;
    this.env = 0;
    this.bg = 0.002;
    this.decay = Math.exp(-1 / (sampleRate * 0.01)); // envelope falls with a 10 ms time constant
    this.ref = 0;       // the level of what's already playing, averaged over about 20 ms
    this.rd = Math.exp(-1 / (sampleRate * 0.02));
    this.pk = 0;
    this.n = 0;
    this.win = Math.round(sampleRate * 0.012); // samples looked at after an onset
    this.col = null;    // {t, a, buf, k} while collecting them
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.th != null) this.th = d.th;
      if (d.ratio != null) this.ratio = d.ratio;
      if (d.gap != null) this.gap = Math.round(sampleRate * d.gap);
    };
  }
  // Goertzel: the share of the window's energy at each beep pitch, the larger of the two (about 1 for a pure tone)
  tone(x) {
    let tot = 0; for (let i = 0; i < x.length; i++) tot += x[i] * x[i];
    if (!(tot > 0)) return 0;
    let best = 0;
    for (const fq of [2400, 3200]) {
      const w = 2 * Math.PI * fq / sampleRate, c = 2 * Math.cos(w);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < x.length; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
      const p = s1 * s1 + s2 * s2 - c * s1 * s2;
      best = Math.max(best, p / (tot * x.length / 2));
    }
    return Math.min(1, best);
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]), f = currentFrame + i, prev = this.ref, pe = this.env;
      this.env = a > this.env ? a : this.env * this.decay;
      this.ref = this.ref * this.rd + this.env * (1 - this.rd);
      if (a > this.pk) this.pk = a;
      if (!this.armed && this.env < this.th * 0.5) this.armed = true;
      // a jump: something much louder over a sound that was already steady (a shot during a beep)
      const jump = !this.armed && pe < prev * 1.3 && a > prev * 1.8;
      if ((this.armed || jump) && this.env >= this.th && this.env >= this.bg * this.ratio && f - this.last >= this.gap) {
        this.last = f;
        this.armed = false;
        if (!this.col) this.col = { t: f / sampleRate, a: this.env, buf: new Float32Array(this.win), k: 0, jump };
      }
      if (this.col) {
        this.col.buf[this.col.k++] = ch[i];
        if (this.col.k >= this.win) {
          const c = this.col, tone = this.tone(c.buf); this.col = null;
          if (tone > 0.35 && !c.jump) this.last = -1e12; // the timer's own beep: it doesn't start the minimum-split gap
          this.port.postMessage({ t: c.t, a: c.a, tone: c.jump ? 0 : tone, jump: c.jump });
        }
      }
      // background: a slow average that loud sounds barely move
      this.bg = this.bg * 0.9998 + Math.min(this.env, this.bg * 3) * 0.0002;
      if (this.bg < 0.0005) this.bg = 0.0005;
    }
    this.n += ch.length;
    if (this.n >= sampleRate * 0.05) { this.port.postMessage({ pk: this.pk }); this.pk = 0; this.n = 0; }
    return true;
  }
}
registerProcessor("rb-shots", RBShots);
