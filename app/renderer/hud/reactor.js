// The central arc-reactor: concentric rings that sweep in on boot, spin at
// independent speeds, and react to voice level. Everything is stroked live:
// thin strokes touch few pixels, whereas blitting pre-rendered ring sprites
// blends their whole (mostly transparent) square every frame, which is what
// limits frame rate on integrated GPUs.

import { TAU, approach, clamp, easeInCubic, easeOutExpo, lerp, stage, wobble } from './fx.js';

const cyan = (a) => `rgba(79,216,255,${a})`;
const hot = (a) => `rgba(214,248,255,${a})`;

const BAR_COUNT = 96;
const RING_TEXT =
  'F.R.I.D.A.Y. // NEURAL INTERFACE v4.2 // VOICE AUTH ACTIVE // STARK INDUSTRIES // ' +
  'HEURISTIC CORE ONLINE // SUBSYSTEMS NOMINAL // ';
const BOOT_RING_DUR = 0.9;
const SONAR_PERIOD = 3.2; // s between sonar pulses
const SONAR_REACH = 1.78; // x R, just inside the stage bounds

let atlas = { key: '', glyphs: new Map() };

/**
 * Pre-rendered glyphs for the text ring. fillText per glyph per frame costs
 * ~8ms of CPU; blitting small cached glyph bitmaps is nearly free.
 */
function glyphAtlas(size, dpr) {
  const key = `${size}@${dpr}`;
  if (atlas.key === key) return atlas.glyphs;
  const font = `600 ${size}px Rajdhani, sans-serif`;
  const glyphs = new Map();
  for (const ch of new Set(RING_TEXT)) {
    if (ch === ' ') continue;
    const w = Math.ceil(size * 0.9);
    const h = Math.ceil(size * 1.3);
    const canvas = new OffscreenCanvas(Math.ceil(w * dpr), Math.ceil(h * dpr));
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    g.font = font;
    g.fillStyle = cyan(0.7);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(ch, w / 2, h / 2);
    glyphs.set(ch, { canvas, w, h });
  }
  atlas = { key, glyphs };
  return glyphs;
}

/** Static ring art, drawn around the origin at radius r (px); rotation is applied by the caller. */
const RING_ART = {
  ticks(ctx, r, R) {
    const count = 180;
    // One path per tick class keeps this to three draw calls.
    const classes = [
      { every: 15, len: 0.07, width: 2, alpha: 0.95 },
      { every: 5, len: 0.038, width: 1, alpha: 0.6 },
      { every: 1, len: 0.016, width: 1, alpha: 0.32 },
    ];
    classes.forEach(({ every, len, width, alpha }, c) => {
      ctx.beginPath();
      for (let k = 0; k < count; k += every) {
        if (c > 0 && k % classes[c - 1].every === 0) continue;
        const a = (k / count) * TAU;
        ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        ctx.lineTo(Math.cos(a) * (r - len * R), Math.sin(a) * (r - len * R));
      }
      ctx.strokeStyle = cyan(alpha);
      ctx.lineWidth = width;
      ctx.stroke();
    });
  },
  markers(ctx, r, R) {
    ctx.strokeStyle = cyan(0.22);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = cyan(0.9);
    const s = 0.028 * R;
    for (let q = 0; q < 4; q += 1) {
      ctx.save();
      ctx.rotate((q * TAU) / 4);
      ctx.beginPath();
      ctx.moveTo(r + s, 0);
      ctx.lineTo(r + s * 2.2, -s * 0.7);
      ctx.lineTo(r + s * 2.2, s * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  },
  segments(ctx, r, R) {
    const arcs = [
      [0.02, 0.3],
      [0.36, 0.48],
      [0.52, 0.8],
      [0.86, 0.96],
    ];
    ctx.lineCap = 'butt';
    for (const [from, to] of arcs) {
      ctx.strokeStyle = cyan(0.85);
      ctx.lineWidth = Math.max(3, 0.018 * R);
      ctx.beginPath();
      ctx.arc(0, 0, r, from * TAU, to * TAU);
      ctx.stroke();
      // End caps: short radial ticks that read as mechanical joints.
      for (const edge of [from, to]) {
        const a = edge * TAU;
        ctx.strokeStyle = hot(0.95);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * (r - 0.035 * R), Math.sin(a) * (r - 0.035 * R));
        ctx.lineTo(Math.cos(a) * (r + 0.035 * R), Math.sin(a) * (r + 0.035 * R));
        ctx.stroke();
      }
    }
  },
  dashes(ctx, r, R) {
    ctx.strokeStyle = cyan(0.4);
    ctx.lineWidth = 0.03 * R;
    const circumference = TAU * r;
    const unit = circumference / 240;
    ctx.setLineDash([unit * 0.35, unit * 0.65]);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
  },
  text(ctx, r, R) {
    const size = Math.max(10, Math.round(0.052 * R));
    const glyphs = glyphAtlas(size, window.devicePixelRatio || 1);
    // Repeat the text so it wraps the full circle with even spacing.
    const charAngle = (size * 0.78) / r;
    const total = Math.floor(TAU / charAngle);
    for (let k = 0; k < total; k += 1) {
      const glyph = glyphs.get(RING_TEXT[k % RING_TEXT.length]);
      if (!glyph) continue; // space
      ctx.save();
      ctx.rotate(k * (TAU / total));
      ctx.drawImage(glyph.canvas, -glyph.w / 2, -r - glyph.h / 2, glyph.w, glyph.h);
      ctx.restore();
    }
  },
  gapped(ctx, r, R) {
    ctx.strokeStyle = hot(0.75);
    ctx.lineWidth = Math.max(1.5, 0.008 * R);
    for (let q = 0; q < 4; q += 1) {
      const base = (q * TAU) / 4;
      ctx.beginPath();
      ctx.arc(0, 0, r, base + 0.12, base + TAU / 4 - 0.12);
      ctx.stroke();
    }
    ctx.strokeStyle = cyan(0.3);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, r - 0.03 * R, 0, TAU);
    ctx.stroke();
  },
};

/**
 * Ring stack, outermost first. `r` is a multiple of the reactor radius R,
 * `delay` staggers the boot sweep, `speed` is rad/s (sign = direction).
 */
const RINGS = [
  { id: 'ticks', r: 1.55, delay: 0.0, speed: -0.05, art: 'ticks' },
  { id: 'markers', r: 1.43, delay: 0.06, speed: 0.035, art: 'markers' },
  { id: 'segments', r: 1.32, delay: 0.1, speed: 0.24, art: 'segments' },
  { id: 'dashes', r: 1.21, delay: 0.16, speed: -0.15, art: 'dashes' },
  { id: 'text', r: 1.1, delay: 0.22, speed: 0.06, art: 'text' },
  { id: 'bars', r: 0.86, delay: 0.3, speed: 0.02 },
  { id: 'gapped', r: 0.8, delay: 0.34, speed: -0.34, art: 'gapped' },
  { id: 'coil', r: 0.66, delay: 0.4, speed: 0.13 },
  { id: 'comet', r: 0.5, delay: 0.46, speed: 1.5 },
  { id: 'triangle', r: 0.34, delay: 0.52, speed: -0.22 },
];

export class Reactor {
  constructor() {
    this.angles = RINGS.map(() => Math.random() * TAU);
    this.bars = new Float32Array(BAR_COUNT);
    this.spinBoost = 0;
    this.sweep = 0;
  }

  reset() {
    this.bars.fill(0);
    this.spinBoost = 0;
  }

  /** Acknowledge a wake word: spin burst and core flare (the shockwave ring is CSS). */
  ping(strength = 1) {
    this.spinBoost = Math.max(this.spinBoost, strength);
  }

  update(dt, time, voice) {
    const spin = 1 + this.spinBoost * 5 + voice * 1.8;
    RINGS.forEach((ring, i) => {
      this.angles[i] += ring.speed * spin * dt;
    });
    this.sweep += (0.9 + voice * 1.5) * dt;
    this.spinBoost = approach(this.spinBoost, 0, 2.2, dt);

    for (let i = 0; i < BAR_COUNT; i += 1) {
      // Mirror the index so the "spectrum" is symmetric left/right like a real visualiser.
      const m = i < BAR_COUNT / 2 ? i : BAR_COUNT - 1 - i;
      const idle = 0.05 + 0.03 * Math.sin(time * 1.6 + m * 0.4);
      const target = idle + voice * (0.5 + 0.5 * wobble(m, time * 1.4)) * (1 - (m / BAR_COUNT) * 0.6);
      const rate = target > this.bars[i] ? 28 : 7; // fast attack, slow release
      this.bars[i] = approach(this.bars[i], clamp(target), rate, dt);
    }

  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {{cx:number, cy:number, R:number, time:number, bootT:number, exit:number, voice:number}} s
   */
  draw(ctx, s) {
    ctx.save();
    ctx.translate(s.cx, s.cy);
    ctx.globalCompositeOperation = 'lighter';

    this.drawRadar(ctx, s);
    this.drawSonar(ctx, s);
    RINGS.forEach((ring, i) => {
      const appear = easeOutExpo(stage(s.bootT, ring.delay, BOOT_RING_DUR));
      // Collapse outer rings first on exit.
      const leave = easeInCubic(stage(s.exit, (i / RINGS.length) * 0.35, 0.6));
      const p = appear * (1 - leave);
      if (p <= 0.001) return;
      const scale = lerp(1, 0.35, leave) * lerp(0.86, 1, appear);
      ctx.save();
      ctx.globalAlpha = Math.min(1, p * 1.4);
      ctx.scale(scale, scale);
      if (ring.art) this.drawArt(ctx, ring, this.angles[i], appear, s.R);
      else this[`draw_${ring.id}`](ctx, ring.r * s.R, this.angles[i], appear, s);
      ctx.restore();
    });
    this.drawCore(ctx, s);

    ctx.restore();
  }

  drawArt(ctx, ring, angle, appear, R) {
    const r = ring.r * R;
    ctx.rotate(angle);
    if (appear < 1) {
      // Boot sweep: reveal the ring as a growing pie slice.
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r + 0.12 * R, -Math.PI / 2, -Math.PI / 2 + TAU * appear);
      ctx.closePath();
      ctx.clip();
    }
    RING_ART[ring.art](ctx, r, R);
  }

  draw_bars(ctx, r, angle, appear, s) {
    const inner = r + 3;
    const reach = 0.3 * s.R;
    const visible = Math.floor(BAR_COUNT * appear);
    ctx.lineWidth = Math.max(2, 0.014 * s.R);
    ctx.lineCap = 'round';
    for (let pass = 0; pass < 2; pass += 1) {
      ctx.beginPath();
      for (let i = 0; i < visible; i += 1) {
        const v = this.bars[i];
        const loud = v > 0.45;
        if ((pass === 1) !== loud) continue;
        const a = angle + (i / BAR_COUNT) * TAU - Math.PI / 2;
        const outer = inner + v * reach + 2;
        ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
        ctx.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
      }
      ctx.strokeStyle = pass === 1 ? hot(0.95) : cyan(0.55 + s.voice * 0.4);
      ctx.stroke();
    }
  }

  draw_coil(ctx, r, angle, appear, s) {
    const count = 10;
    const span = (TAU / count) * 0.72;
    const visible = Math.ceil(count * appear);
    ctx.rotate(angle);
    for (let k = 0; k < visible; k += 1) {
      const a = (k * TAU) / count;
      const flicker = 0.85 + 0.15 * Math.sin(s.time * 9 + k * 2.1);
      ctx.strokeStyle = cyan((0.2 + 0.55 * s.voice) * flicker);
      ctx.lineWidth = 0.09 * s.R;
      ctx.beginPath();
      ctx.arc(0, 0, r, a, a + span);
      ctx.stroke();
      ctx.strokeStyle = hot(0.85 * flicker);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, r - 0.045 * s.R, a, a + span);
      ctx.arc(0, 0, r + 0.045 * s.R, a + span, a, true);
      ctx.closePath();
      ctx.stroke();
    }
  }

  draw_comet(ctx, r, angle, appear, s) {
    ctx.strokeStyle = cyan(0.18);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU * appear);
    ctx.stroke();
    for (const offset of [0, Math.PI]) {
      const head = angle + offset;
      const tail = 1.3;
      const grad = ctx.createConicGradient(head - tail, 0, 0);
      grad.addColorStop(0, cyan(0));
      grad.addColorStop(tail / TAU, hot(0.95));
      grad.addColorStop(tail / TAU + 0.001, cyan(0));
      ctx.strokeStyle = grad;
      ctx.lineWidth = Math.max(2.5, 0.016 * s.R);
      ctx.beginPath();
      ctx.arc(0, 0, r, head - tail, head);
      ctx.stroke();
      ctx.fillStyle = hot(1);
      ctx.beginPath();
      ctx.arc(Math.cos(head) * r, Math.sin(head) * r, ctx.lineWidth * 0.9, 0, TAU);
      ctx.fill();
    }
  }

  draw_triangle(ctx, r, angle, appear, s) {
    ctx.rotate(angle);
    ctx.strokeStyle = cyan(0.65);
    ctx.lineWidth = Math.max(2, 0.022 * s.R);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let k = 0; k < 3; k += 1) {
      const a = -Math.PI / 2 + (k * TAU) / 3;
      const px = Math.cos(a) * r * appear;
      const py = Math.sin(a) * r * appear;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  }

  drawRadar(ctx, s) {
    const p = easeOutExpo(stage(s.bootT, 0.6, 0.8)) * (1 - stage(s.exit, 0, 0.3));
    if (p <= 0) return;
    const inner = 0.9 * s.R;
    const outer = 1.5 * s.R;
    const head = this.sweep;
    const grad = ctx.createConicGradient(head - 0.9, 0, 0);
    grad.addColorStop(0, cyan(0));
    grad.addColorStop(0.9 / TAU, cyan(0.16 * p));
    grad.addColorStop(0.9 / TAU + 0.002, cyan(0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, outer, 0, TAU);
    ctx.arc(0, 0, inner, TAU, 0, true);
    ctx.fill();
  }

  /** A soft ring that expands from the core to the stage edge every few seconds. */
  drawSonar(ctx, s) {
    const p = stage(s.bootT, 1.0, 0.4) * (1 - stage(s.exit, 0, 0.25));
    if (p <= 0) return;
    const k = ((s.bootT - 1.0) % SONAR_PERIOD) / SONAR_PERIOD;
    const r = lerp(0.35, SONAR_REACH, easeOutExpo(k * 1.2)) * s.R;
    const alpha = (1 - k) ** 1.6 * 0.5 * p;
    ctx.strokeStyle = cyan(alpha);
    ctx.lineWidth = 2 + 6 * (1 - k);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();
  }

  drawCore(ctx, s) {
    const appear = easeOutExpo(stage(s.bootT, 0.15, 0.8));
    const leave = stage(s.exit, 0.2, 0.55);
    const p = appear * (1 - easeInCubic(leave));
    if (p <= 0.001) return;
    const pulse = 0.06 * Math.sin(s.time * 3.2) + 0.32 * s.voice + 0.35 * this.spinBoost;
    const rc = 0.3 * s.R * (1 + pulse) * p;
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rc);
    grad.addColorStop(0, hot(1));
    grad.addColorStop(0.22, hot(0.85));
    grad.addColorStop(0.5, cyan(0.45));
    grad.addColorStop(1, cyan(0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, rc, 0, TAU);
    ctx.fill();

    ctx.strokeStyle = hot(0.9 * p);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 0.17 * s.R * p, 0, TAU);
    ctx.stroke();

    // Boot flash: a hot white bloom in the first fraction of a second.
    const flash = 1 - stage(s.bootT, 0, 0.35);
    if (flash > 0 && s.exit === 0) {
      const fr = s.R * (0.2 + 1.4 * (1 - flash));
      const fg = ctx.createRadialGradient(0, 0, 0, 0, 0, fr);
      fg.addColorStop(0, hot(0.9 * flash));
      fg.addColorStop(1, cyan(0));
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.arc(0, 0, fr, 0, TAU);
      ctx.fill();
    }
  }
}
