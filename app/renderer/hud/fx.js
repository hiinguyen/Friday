// Small animation helpers shared by the HUD layers.

export const TAU = Math.PI * 2;

export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
export const easeInCubic = (t) => t * t * t;

/** Progress 0..1 of a staged animation that starts at `delay` and lasts `dur` seconds. */
export const stage = (time, delay, dur) => clamp((time - delay) / dur);

/** Frame-rate independent exponential approach of `current` toward `target`. */
export const approach = (current, target, rate, dt) => current + (target - current) * (1 - Math.exp(-rate * dt));

/** Smooth pseudo-noise in [-1, 1] from layered sines; cheap and deterministic per index. */
export function wobble(i, t) {
  return (Math.sin(i * 1.7 + t * 2.3) + Math.sin(i * 0.63 - t * 3.1) * 0.6 + Math.sin(i * 2.9 + t * 5.3) * 0.3) / 1.9;
}

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&/<>[]';

/**
 * "Decode" text into an element: every character cycles through random glyphs
 * until its reveal time, sweeping left to right. Returns a cancel function.
 */
export function scrambleText(el, text, durationMs = 900) {
  const start = performance.now();
  let raf = 0;
  const tick = (now) => {
    const progress = (now - start) / durationMs;
    let out = '';
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      const revealAt = (i / text.length) * 0.75;
      if (ch === ' ' || ch === '.' || progress >= revealAt + 0.25) out += ch;
      else if (progress < revealAt) out += progress > revealAt - 0.15 ? GLYPHS[(Math.random() * GLYPHS.length) | 0] : ' ';
      else out += GLYPHS[(Math.random() * GLYPHS.length) | 0];
    }
    el.textContent = out;
    if (progress < 1) raf = requestAnimationFrame(tick);
    else el.textContent = text;
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

/** Type text one character at a time with a blinking caret. Returns a cancel function. */
export function typeText(el, text, cps = 38) {
  let i = 0;
  let caretTimer = 0;
  el.textContent = '';
  el.classList.add('typing');
  const timer = setInterval(() => {
    i += 1;
    el.textContent = text.slice(0, i);
    if (i >= text.length) {
      clearInterval(timer);
      caretTimer = setTimeout(() => el.classList.remove('typing'), 1600);
    }
  }, 1000 / cps);
  return () => {
    clearInterval(timer);
    clearTimeout(caretTimer);
    el.classList.remove('typing');
  };
}
