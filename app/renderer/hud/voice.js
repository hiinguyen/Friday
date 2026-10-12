// Turns raw mic loudness (0..1 dB-scaled, ~20 Hz) into a smooth "voice"
// intensity relative to an adaptive noise floor, so the HUD reacts to speech
// rather than to fan hum or a noisy headset.

import { approach, clamp } from './fx.js';

// Slow (~0.03/s at 20 Hz) so a long sentence does not get absorbed into the floor.
const FLOOR_RISE_PER_SAMPLE = 0.0015;
const FLOOR_FALL_MIX = 0.3; // fast: quieter sample pulls the floor down
const GATE = 0.06; // headroom above the floor before it counts as voice
const RANGE = 0.3; // level span (above gate) mapped onto 0..1
const STALE_MS = 400; // no samples for this long = listener is silent
const SPEAKING = 0.28;

export class VoiceTracker {
  constructor() {
    this.raw = 0;
    this.floor = null;
    this.value = 0;
    this.lastSampleAt = 0;
    this.lastSpeechAt = 0;
  }

  push(level, now) {
    this.raw = level;
    this.lastSampleAt = now;
    if (this.floor === null || level < this.floor) {
      this.floor = this.floor === null ? level : this.floor + (level - this.floor) * FLOOR_FALL_MIX;
    } else {
      this.floor += FLOOR_RISE_PER_SAMPLE;
    }
  }

  update(dt, now) {
    if (now - this.lastSampleAt > STALE_MS) this.raw = 0;
    const target = this.floor === null ? 0 : clamp((this.raw - this.floor - GATE) / RANGE);
    this.value = approach(this.value, target, target > this.value ? 22 : 5, dt);
    if (target > SPEAKING) this.lastSpeechAt = now;
  }

  get speaking() {
    return this.value > SPEAKING;
  }
}
