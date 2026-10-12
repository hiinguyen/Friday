// Motes spiralling into the reactor core, drawn into the reactor stage canvas.
// They spawn just inside the stage bounds so no full-screen layer is needed.

import { TAU, clamp, easeOutExpo, stage } from './fx.js';

const cyan = (a) => `rgba(79,216,255,${a})`;
const COUNT = 130;
const SPAWN_MIN = 1.2; // x R
const SPAWN_MAX = 1.75; // x R, keep below the stage half-size
const SINK = 0.45; // x R, respawn once this close to the core

function spawn(R) {
  return {
    a: Math.random() * TAU,
    d: R * (SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN)),
    speed: 10 + Math.random() * 26,
    swirl: (Math.random() < 0.5 ? -1 : 1) * (0.1 + Math.random() * 0.25),
    size: Math.random() < 0.15 ? 2 : 1,
    life: 0,
  };
}

export class Particles {
  constructor() {
    this.items = [];
  }

  reset(R) {
    this.items = Array.from({ length: COUNT }, () => spawn(R));
  }

  update(dt, voice, R) {
    const pull = 1 + voice * 3;
    for (let i = 0; i < this.items.length; i += 1) {
      const p = this.items[i];
      p.life += dt;
      p.d -= p.speed * pull * dt;
      p.a += p.swirl * pull * dt;
      if (p.d < R * SINK) this.items[i] = spawn(R);
    }
  }

  /** @param {CanvasRenderingContext2D} ctx  already translated to the reactor centre */
  draw(ctx, s) {
    const presence = easeOutExpo(stage(s.bootT, 0.2, 0.6)) * (1 - stage(s.exit, 0, 0.4));
    if (presence <= 0) return;
    const edge = s.R * SPAWN_MAX;
    for (const p of this.items) {
      const fadeIn = clamp(p.life / 0.6) * clamp((edge - p.d) / (s.R * 0.15));
      const fadeOut = clamp((p.d - s.R * SINK) / (s.R * 0.5));
      const alpha = (0.3 + s.voice * 0.5) * fadeIn * fadeOut * presence;
      if (alpha <= 0.01) continue;
      ctx.fillStyle = cyan(alpha);
      ctx.fillRect(Math.cos(p.a) * p.d, Math.sin(p.a) * p.d, p.size, p.size);
    }
  }
}
