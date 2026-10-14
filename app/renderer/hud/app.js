// HUD orchestrator: state machine (off -> active -> exit -> off), frame loop,
// and wiring between the Electron bridge and the visual layers.
//
// Performance model: full-screen layers (backdrop, hex lattice, sonar,
// leaders, shockwaves) are static CSS animated with transform/opacity/
// clip-path, so the compositor handles them. The only per-frame raster work
// is the reactor stage canvas, sized to the reactor's bounding box.

import { CommandTracker, dismissDeadline } from './command.js';
import { scrambleText, typeText } from './fx.js';
import { Panels } from './panels.js';
import { Particles } from './particles.js';
import { Reactor } from './reactor.js';
import { VoiceTracker } from './voice.js';

const EXIT_DURATION_S = 0.9;
const MAX_DT = 0.05;
const REACTOR_SCALE = 0.19; // reactor radius as a fraction of the short screen side
const STAGE_HALF = 1.8; // stage half-size in reactor radii; outermost ring is ~1.6R
const BLOOM_DOWNSCALE = 4;
const SHOCK_DIAMETER = 5.2; // x R
const SHOCK_MS = 1150;
const PERF_WINDOW_MS = [2000, 5000]; // steady-state sample window after wake
const LOG_ERROR_CHARS = 64;

const $ = (id) => document.getElementById(id);
const bridge = window.friday;

const fx = $('fx').getContext('2d');
const bloom = $('bloom').getContext('2d');
const reactor = new Reactor();
const particles = new Particles();
const panels = new Panels();
const voice = new VoiceTracker();
const command = new CommandTracker();

const view = { dpr: 1, cx: 0, cy: 0, R: 0, stage: 0 };
const hud = {
  state: 'off',
  time: 0,
  bootT: 0,
  exitT: 0,
  wakeAt: 0,
  raf: 0,
  last: 0,
  userName: 'Boss',
  debug: false,
  seq: 0, // main-process session number of the latest wake
  perf: null,
  cancelTyping: () => {},
  cancelScramble: () => {},
};
let listenerStatus = { listener: 'starting', message: '', voiceprint: 'off' };
const VOICEPRINT_BOOT = {
  armed: ['ok', 'ARMED'],
  unusable: ['err', 'FAULT'],
  off: ['warn', 'NOT ENROLLED'],
};

function setState(state) {
  hud.state = state;
  document.body.dataset.state = state;
}

function sizeCanvas(canvas, cssSize, pixelSize) {
  canvas.style.width = `${cssSize}px`;
  canvas.style.height = `${cssSize}px`;
  canvas.width = pixelSize;
  canvas.height = pixelSize;
}

function layout() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const R = Math.min(w, h) * REACTOR_SCALE;
  const stageCss = Math.ceil(R * STAGE_HALF * 2);
  Object.assign(view, { dpr, R, stage: stageCss, cx: stageCss / 2, cy: stageCss / 2 });
  sizeCanvas($('fx'), stageCss, Math.round(stageCss * dpr));
  sizeCanvas($('bloom'), stageCss, Math.round(stageCss / BLOOM_DOWNSCALE));
  document.documentElement.style.setProperty('--r', `${R}px`);
  placeLeaders(w / 2, h / 2, R);
}

function placeLeaders(cx, cy, R) {
  const start = R * 1.62;
  const left = document.querySelector('.panel.left').getBoundingClientRect();
  const right = document.querySelector('.panel.right').getBoundingClientRect();
  const spans = {
    left: { from: left.right + 10, to: cx - start },
    right: { from: cx + start, to: right.left - 10 },
  };
  for (const [side, { from, to }] of Object.entries(spans)) {
    const el = document.querySelector(`.leader.${side}`);
    const width = to - from;
    el.style.display = width > 24 ? 'block' : 'none';
    Object.assign(el.style, { left: `${from}px`, top: `${Math.round(cy)}px`, width: `${Math.max(0, width)}px` });
  }
}

function shockwave() {
  const size = view.R * SHOCK_DIAMETER;
  const ring = document.createElement('i');
  ring.className = 'shock';
  Object.assign(ring.style, { width: `${size}px`, height: `${size}px`, margin: `${-size / 2}px 0 0 ${-size / 2}px` });
  $('shocks').append(ring);
  ring
    .animate(
      [
        { transform: 'scale(0.12)', opacity: 1 },
        { transform: 'scale(1)', opacity: 0 },
      ],
      { duration: SHOCK_MS, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    )
    .finished.then(() => ring.remove(), () => ring.remove());
}

function greetingFor(date) {
  const h = date.getHours();
  const part = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${hud.userName}. How can I help?`;
}

function bootSequence(conf) {
  panels.sequence([
    [120, 'Wake word acknowledged', 'ok', `${Math.round(conf * 100)}%`],
    [420, 'Voiceprint lock', ...(VOICEPRINT_BOOT[listenerStatus.voiceprint] ?? VOICEPRINT_BOOT.off)],
    [720, 'Neural interface', 'ok', 'ONLINE'],
    [1020, 'Telemetry uplink', 'ok', 'SYNCED'],
    [1320, 'Audio channel', 'ok', 'OPEN'],
    [1650, 'Awaiting instructions', 'info'],
  ]);
}

function boot(conf) {
  hud.time = 0;
  hud.bootT = 0;
  hud.exitT = 0;
  hud.wakeAt = performance.now();
  hud.perf = hud.debug ? { frames: [], reported: false } : null;
  voice.lastSpeechAt = 0;
  command.reset();
  renderCommand();
  renderReply();
  layout();
  reactor.reset();
  particles.reset(view.R);
  panels.clear();
  panels.start();
  setState('active');
  shockwave();

  hud.cancelScramble();
  hud.cancelScramble = scrambleText($('title'), 'F.R.I.D.A.Y.', 1100);
  hud.cancelTyping();
  $('greeting').textContent = '';
  panels.timers.push(
    setTimeout(() => {
      hud.cancelTyping = typeText($('greeting'), greetingFor(new Date()));
    }, 1100),
  );
  bootSequence(conf);
  startLoop();
}

function onWake({ conf, seq, debug }) {
  hud.debug = Boolean(debug);
  hud.seq = seq;
  if (hud.state === 'off') {
    boot(conf);
    return;
  }
  if (hud.state === 'exit') {
    // Woken again mid power-down: reverse into the active state.
    hud.exitT = 0;
    setState('active');
  }
  hud.wakeAt = performance.now();
  reactor.ping(1);
  shockwave();
  panels.log('Wake word re-acquired', 'ok', `${Math.round(conf * 100)}%`);
}

function dismiss() {
  if (hud.state !== 'active') return;
  hud.exitT = 0;
  setState('exit');
  panels.log('Standing by', 'info');
}

function finishExit() {
  // Dismissed mid-command (Esc): its remaining events are dropped while the HUD
  // is off, so forget it; ids keep any late ones stale.
  command.reset();
  renderReply();
  stopLoop();
  panels.stop();
  hud.cancelTyping();
  hud.cancelScramble();
  $('shocks').replaceChildren();
  for (const ctx of [fx, bloom]) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
  setState('off');
  // Let the compositor present the cleared frame before the window unmaps,
  // otherwise the next show() flashes the last frame of this session. If a
  // wake rebooted the HUD meanwhile, stay silent: the window must stay up.
  const seq = hud.seq;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (hud.state === 'off' && hud.seq === seq) bridge.hidden(seq);
    }),
  );
}

function statusText() {
  if (listenerStatus.listener === 'error') return 'Microphone offline';
  if (hud.state === 'exit') return 'Standing by';
  if (command.speaking) return 'Speaking';
  if (command.agent === 'working') return command.tool ? `Running ${command.tool}` : 'Working';
  switch (command.phase) {
    case 'listening':
      return voice.speaking ? 'Voice input detected' : 'Listening';
    case 'transcribing':
      return 'Transcribing';
    case 'done':
      return 'Command received';
    case 'error':
      return 'Transcription failed';
    case 'rejected':
      return command.error ? 'Voiceprint unavailable' : 'Voice not recognized';
    case 'unclear':
      return 'Too short to verify, say it again';
    default:
      return 'Say "Friday" to command'; // idle (woken from the CLI) or nothing was said
  }
}

function renderCommand() {
  const el = $('command');
  const spoken = command.text.charAt(0).toUpperCase() + command.text.slice(1);
  const text = spoken ? `\u201C${spoken}\u201D` : '';
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('typing', command.phase === 'transcribing' && Boolean(text));
  document.body.classList.toggle('command-error', command.phase === 'error' || command.phase === 'rejected');
}

const clip = (text) => (text.length > LOG_ERROR_CHARS ? `${text.slice(0, LOG_ERROR_CHARS)}...` : text);

function renderReply() {
  const el = $('reply');
  // Hermes may open a reply with blank lines, which pre-wrap would show as empty rows.
  const text = command.reply.trimStart();
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('typing', command.agent === 'working' && !text);
}

function onAgent(event) {
  if (hud.state === 'off' || !command.onAgent(event, performance.now())) return;
  if (event.session === 'new') panels.log('Hermes link', 'info', 'NEW CONVERSATION');
  if (event.session === 'continued') panels.log('Hermes link', 'info', 'CONTINUING');
  if (event.session === 'reset') panels.log('Conversation reset', 'ok');
  if (event.tool) panels.log(`Hermes: ${clip(event.tool)}`, 'info');
  if (event.state === 'error') panels.log(`Hermes: ${clip(event.error || 'failed')}`, 'err');
  // Progress keeps the HUD awake for as long as the agent works.
  hud.wakeAt = performance.now();
  renderReply();
}

function onReply(event) {
  if (hud.state === 'off' || !command.onReply(event, performance.now())) return;
  if (event.error) panels.log(`Hermes: ${clip(event.error)}`, 'err');
  if (event.final) reactor.ping(0.5);
  hud.wakeAt = performance.now();
  renderReply();
}

function onSpeech(event) {
  if (hud.state === 'off' || !command.onSpeech(event, performance.now())) return;
  if (event.state === 'skipped') panels.log('Voice', 'warn', 'ENGLISH ONLY');
  // Give the user the full idle window after she stops talking.
  if (event.state === 'done') hud.wakeAt = performance.now();
}

function onCapture(event) {
  if (hud.state === 'off' || !command.onCapture(event, performance.now())) return;
  if (event.state === 'processing') panels.log('Command captured', 'ok', `${event.seconds.toFixed(1)}s`);
  if (event.state === 'cancelled') panels.log('Command interrupted', 'warn');
  if (event.state === 'verified') panels.log('Voiceprint match', 'ok', 'CONFIRMED');
  if (event.state === 'unclear') panels.log('Voiceprint', 'warn', 'INCONCLUSIVE');
  if (event.state === 'rejected') {
    if (event.error) panels.log(`Voiceprint: ${clip(event.error)}`, 'err');
    else panels.log('Voiceprint mismatch', 'err', 'DENIED');
  }
  if (event.state === 'empty') {
    panels.log('No command heard', 'info');
    hud.wakeAt = performance.now();
  }
  renderCommand();
}

function onTranscript(event) {
  if (hud.state === 'off' || !command.onTranscript(event, performance.now())) return;
  if (event.error) {
    panels.log(`Speech link: ${clip(event.error)}`, 'err');
  } else if (event.final) {
    if (command.phase === 'done') {
      panels.log('Transcript', 'ok', 'RECEIVED');
      reactor.ping(0.6);
    } else {
      panels.log('No command heard', 'info');
    }
  }
  // Give the user the full idle window to read the result.
  if (!command.busy) hud.wakeAt = performance.now();
  renderCommand();
}

function render(scene) {
  fx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  fx.clearRect(0, 0, view.stage, view.stage);
  reactor.draw(fx, scene);
  fx.save();
  fx.translate(scene.cx, scene.cy);
  particles.draw(fx, scene);
  fx.restore();

  bloom.clearRect(0, 0, bloom.canvas.width, bloom.canvas.height);
  bloom.drawImage(fx.canvas, 0, 0, bloom.canvas.width, bloom.canvas.height);
}

/** FRIDAY_DEBUG=1: log steady-state fps and JS frame cost once per session. */
function recordPerf(now, jsMs) {
  const perf = hud.perf;
  if (!perf || perf.reported) return;
  const elapsed = now - hud.wakeAt;
  if (elapsed > PERF_WINDOW_MS[0] && elapsed < PERF_WINDOW_MS[1]) perf.frames.push(jsMs);
  if (elapsed < PERF_WINDOW_MS[1]) return;
  perf.reported = true;
  const sorted = [...perf.frames].sort((a, b) => a - b);
  const seconds = (PERF_WINDOW_MS[1] - PERF_WINDOW_MS[0]) / 1000;
  const pct = (q) => (sorted[Math.floor(sorted.length * q)] ?? 0).toFixed(1);
  console.warn(`perf fps=${(sorted.length / seconds).toFixed(1)} js_p50=${pct(0.5)}ms js_p95=${pct(0.95)}ms`);
}

function frame(now) {
  const started = performance.now();
  const dt = Math.min((now - hud.last) / 1000, MAX_DT);
  hud.last = now;
  hud.time += dt;
  hud.bootT += dt;
  if (hud.state === 'exit') hud.exitT += dt;

  voice.update(dt, now);
  document.body.classList.toggle('speaking', voice.speaking);
  const status = statusText();
  if ($('status').textContent !== status) $('status').textContent = status;

  if (command.expire(now)) {
    panels.log('Speech link timed out', 'err');
    renderCommand();
  }
  if (command.busy) hud.wakeAt = now; // never power down mid-command
  if (hud.state === 'active' && now > dismissDeadline(command, hud.wakeAt, voice.lastSpeechAt)) dismiss();

  const exit = hud.state === 'exit' ? Math.min(1, hud.exitT / EXIT_DURATION_S) : 0;
  reactor.update(dt, hud.time, voice.value);
  particles.update(dt, voice.value, view.R);
  render({ ...view, time: hud.time, bootT: hud.bootT, exit, voice: voice.value });
  recordPerf(now, performance.now() - started);

  if (exit >= 1) {
    finishExit();
    return;
  }
  hud.raf = requestAnimationFrame(frame);
}

function startLoop() {
  if (hud.raf) return;
  hud.last = performance.now();
  hud.raf = requestAnimationFrame(frame);
}

function stopLoop() {
  cancelAnimationFrame(hud.raf);
  hud.raf = 0;
}

function onStatus(status) {
  const wasError = listenerStatus.listener === 'error';
  listenerStatus = status;
  document.body.classList.toggle('listener-error', status.listener === 'error');
  if (hud.state === 'off') return;
  if (status.listener === 'error') panels.log(status.message, 'err');
  else if (wasError && status.listener === 'ready') panels.log('Microphone', 'ok', 'RESTORED');
}

bridge.on('hud:wake', onWake);
bridge.on('hud:dismiss', dismiss);
bridge.on('hud:level', (level) => voice.push(level, performance.now()));
bridge.on('hud:stats', (stats) => {
  hud.userName = stats.user.charAt(0).toUpperCase() + stats.user.slice(1);
  panels.updateStats(stats);
});
bridge.on('hud:status', onStatus);
bridge.on('hud:capture', onCapture);
bridge.on('hud:transcript', onTranscript);
bridge.on('hud:agent', onAgent);
bridge.on('hud:reply', onReply);
bridge.on('hud:speech', onSpeech);

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') dismiss();
});
window.addEventListener('mousedown', (event) => {
  if (!event.target.closest('.panel')) dismiss();
});
window.addEventListener('resize', layout);
document.fonts.ready.then(layout);
layout();
