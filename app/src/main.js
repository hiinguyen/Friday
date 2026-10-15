'use strict';

// F.R.I.D.A.Y. background shell: keeps a hidden transparent HUD window ready
// and reveals it whenever the wake-word listener hears "Friday".
//
// Control a running instance from the command line:
//   friday wake | friday hide | friday toggle | friday gesture

const path = require('node:path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
// Before anything reads its settings: every module below may.
require('./env').loadEnvFile();
const { HermesAgent } = require('./agent');
const { Badge } = require('./badge');
const { Conversation } = require('./conversation');
const { CommandDispatcher } = require('./dispatch');
const { GestureDebug } = require('./gesture-debug');
const { GestureControl } = require('./gestures');
const { HandWorker } = require('./hands');
const hypr = require('./hypr');
const { runLocal } = require('./local');
const { JevRouter } = require('./router');
const { WakeListener } = require('./listener');
const { SpeechOutput } = require('./speech');
const { createSampler } = require('./stats');

const WINDOW_TITLE = 'F.R.I.D.A.Y.';
const STATS_INTERVAL_MS = 1000;
// Time for Hyprland to hand focus back after the HUD unmaps, before a gesture acts on the focused window.
const HUD_UNMAP_MS = 120;
const COMMANDS = new Set(['wake', 'hide', 'toggle', 'gesture']);
// FRIDAY_DEBUG=1 makes the renderer log steady-state fps after each wake.
const DEBUG = process.env.FRIDAY_DEBUG === '1';

function log(message) {
  process.stdout.write(`[friday] ${message}\n`);
}

function commandFromArgv(argv) {
  return argv.find((arg) => COMMANDS.has(arg)) ?? null;
}

const initialCommand = commandFromArgv(process.argv);
if (!app.requestSingleInstanceLock({ command: initialCommand })) {
  // Another instance owns the HUD; it receives our command via 'second-instance'.
  app.quit();
  process.exit(0);
}

let win = null;
let loaded = false; // renderer listeners exist only after did-finish-load
let pendingWake = null; // wake that arrived while the page was (re)loading
let visible = false;
// Every wake gets a sequence number. The renderer echoes the number of the
// session it powered down; a 'hidden' for an older session means a newer wake
// raced the power-down animation and must not hide the window.
let wakeSeq = 0;
let statsTimer = null;
let listenerStatus = { listener: 'starting', message: 'Starting wake-word engine', voiceprint: 'off' };
const VOICEPRINT_LOG = { armed: 'enrolled voice only', unusable: 'voiceprint unusable, rejecting every command', off: 'any voice' };
const sampleStats = createSampler();
const listener = new WakeListener();
const agent = new HermesAgent();
const router = new JevRouter();
const speech = new SpeechOutput();
const badge = new Badge();
const gestureDebug = new GestureDebug();
const handWorker = new HandWorker();
const gestures = new GestureControl({ worker: handWorker, hypr, beforeAction: clearHudForGesture });
let conversation = null; // created once app paths are known
let dispatcher = null; // routes each finished command; created with the conversation

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function stopStats() {
  clearInterval(statsTimer);
  statsTimer = null;
}

function startStats() {
  stopStats();
  send('hud:stats', sampleStats());
  statsTimer = setInterval(() => send('hud:stats', sampleStats()), STATS_INTERVAL_MS);
}

function markHidden() {
  visible = false;
  stopStats();
  if (win && !win.isDestroyed()) win.hide();
}

function createWindow() {
  // Initial size only. On Hyprland the window rule in hypr/friday.conf sizes
  // the overlay to whichever monitor is focused, so the window must stay
  // resizable: resizable:false pins xdg min/max size and blocks the rule.
  const { width, height } = screen.getPrimaryDisplay().bounds;
  win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    title: WINDOW_TITLE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const { webContents } = win;
  // The HUD is a local, always-on-top surface: never let it navigate or spawn windows.
  webContents.on('will-navigate', (event) => event.preventDefault());
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('did-finish-load', () => {
    loaded = true;
    send('hud:status', listenerStatus);
    if (pendingWake !== null) {
      const conf = pendingWake;
      pendingWake = null;
      showHud(conf);
    }
  });
  webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
    if (level === 'warning' || level === 'error') {
      console.error(`[renderer:${level}] ${message} (${path.basename(sourceId)}:${lineNumber})`);
    }
  });
  webContents.on('render-process-gone', (_event, details) => {
    console.error(`[friday] renderer gone: ${details.reason}; reloading`);
    loaded = false;
    markHidden();
    win.reload();
  });
  win.on('page-title-updated', (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function showHud(conf) {
  if (!loaded) {
    // Showing now would map an empty, focused, fullscreen window.
    pendingWake = conf;
    return;
  }
  wakeSeq += 1;
  send('hud:wake', { conf, seq: wakeSeq, debug: DEBUG });
  if (visible) return;
  visible = true;
  win.show();
  win.focus();
  send('hud:status', listenerStatus);
  startStats();
}

function hideHud() {
  if (!visible) return;
  // The renderer plays its power-down animation, then reports 'hud:hidden'.
  send('hud:dismiss');
}

// The HUD covers the monitor and holds focus: a gesture right after "Friday,
// turn on gesture control" must switch the workspace behind it and carry the
// owner's window, not the HUD. Hide it at once, without the power-down animation.
async function clearHudForGesture() {
  if (!visible) return;
  send('hud:dismiss');
  markHidden();
  await new Promise((resolve) => setTimeout(resolve, HUD_UNMAP_MS));
}

function onHudHidden(_event, seq) {
  if (seq !== wakeSeq) return; // stale: a newer wake already rebooted the HUD
  // Dismissed (Esc, a click, or idle): the run is abandoned and she stops talking.
  dispatcher.abandon();
  router.cancel();
  agent.cancel();
  speech.cancel();
  markHidden();
}

function runCommand(command) {
  if (command === 'wake') showHud(1);
  else if (command === 'hide') hideHud();
  else if (command === 'toggle') (visible ? hideHud() : showHud(1));
  else if (command === 'gesture') gestures.toggle();
}

function setListenerStatus(status) {
  listenerStatus = { ...listenerStatus, ...status };
  send('hud:status', listenerStatus);
}

app.on('second-instance', (_event, argv, _cwd, additionalData) => {
  const command = additionalData?.command ?? commandFromArgv(argv) ?? 'wake';
  log(`command: ${command}`);
  runCommand(command);
});

app.whenReady().then(() => {
  ipcMain.on('hud:hidden', onHudHidden);

  listener.on('ready', ({ voiceprint }) => {
    log(`wake-word engine ready, listening for "Friday" (${VOICEPRINT_LOG[voiceprint]})`);
    setListenerStatus({ listener: 'ready', message: 'Listening for wake word', voiceprint });
  });
  listener.on('wake', (conf) => {
    log(`wake word detected (conf=${conf})`);
    dispatcher.abandon(); // a new command abandons whatever the last one was still doing
    router.cancel();
    agent.cancel();
    speech.cancel(); // and she stops talking to listen
    showHud(conf);
  });
  listener.on('level', (value) => {
    if (visible) send('hud:level', value);
  });
  // The renderer ignores these while powered down; ids discard stale ones.
  listener.on('capture', (event) => {
    if (event.error) console.error(`[friday] voiceprint check #${event.id} failed: ${event.error}`);
    else if (event.state === 'unclear') log(`command #${event.id}: too little speech to verify the voice`);
    else if (event.state === 'verified' || event.state === 'rejected') {
      log(`command #${event.id}: voice ${event.state} (score=${event.score})`);
    }
    send('hud:capture', event);
  });
  listener.on('transcript', (event) => {
    // Spoken words stay out of the journal unless debugging.
    if (event.final) log(`command #${event.id}: ${DEBUG ? JSON.stringify(event.text) : `${event.text.length} chars`}`);
    if (event.error) console.error(`[friday] transcription #${event.id} failed: ${event.error}`);
    send('hud:transcript', event);
    // The wake word alone or an empty transcript is not a command: nothing to run.
    if (!event.final || !event.text || !(agent.enabled || router.enabled)) return;
    dispatcher.handle(event.id, event.text);
  });
  listener.on('error', (message) => {
    console.error(`[friday] ${message}`);
    setListenerStatus({ listener: 'error', message });
  });

  agent.on('start', (a) => {
    const session = dispatcher.fresh ? 'new' : 'continued';
    log(`agent #${a.id}: working (${session} conversation)`);
    send('hud:agent', { id: a.id, state: 'working', session });
  });
  agent.on('tool', (a) => {
    log(`agent #${a.id}: ${a.label}`);
    send('hud:agent', { id: a.id, state: 'working', tool: a.label });
  });
  agent.on('delta', (a) => {
    send('hud:reply', { id: a.id, delta: a.text });
    if (!dispatcher.isSilenced(a.id)) speech.say(a.id, a.text); // spoken sentence by sentence while the rest streams in
  });
  agent.on('done', (a) => {
    log(`agent #${a.id}: replied ${a.text.length} chars`);
    send('hud:reply', { id: a.id, text: a.text, final: true });
    send('hud:agent', { id: a.id, state: 'done' });
    speech.end(a.id);
    conversation.touch();
    dispatcher.onAgentDone(a.id, a.text);
  });
  agent.on('error', (a) => {
    console.error(`[friday] agent #${a.id} failed: ${a.message}`);
    send('hud:agent', { id: a.id, state: 'error', error: a.message });
    speech.end(a.id); // finish the sentence it was on, if any
    conversation.touch();
    dispatcher.onAgentError(a.id);
  });

  speech.on('ready', ({ voice }) => log(`voice ready: ${voice}`));
  speech.on('disabled', (reason) => log(`voice: off (${reason})`));
  speech.on('speech', (s) => {
    if (s.state === 'skipped') log(`reply #${s.id}: not English, shown but not spoken`);
    send('hud:speech', s);
  });
  speech.on('error', (message) => console.error(`[friday] voice: ${message}`));

  let gestureMode = 'off';
  gestures.on('state', (state) => {
    // State also changes with every pose; the journal only wants the mode changes.
    if (state.mode !== gestureMode) {
      if (state.mode === 'off') log(`gesture control: off${state.reason && state.reason !== 'off' ? ` (${state.reason})` : ''}`);
      else if (state.mode === 'on') log('gesture control: on, camera open');
      gestureMode = state.mode;
    }
    badge.state(state);
    gestureDebug.state(state);
  });
  handWorker.on('frame', (frame) => gestureDebug.frame(frame));
  gestures.on('action', (action) => {
    log(`gesture: ${action.action} ${action.workspace ?? action.direction} -> ${action.dispatcher}`);
    badge.action(action);
  });
  gestures.on('error', (message) => console.error(`[friday] gestures: ${message}`));

  conversation = new Conversation({
    prefix: agent.session,
    idleMs: agent.sessionIdleMs,
    file: path.join(app.getPath('userData'), 'conversation.json'),
    onError: (message) => console.error(`[friday] ${message}`),
  });
  dispatcher = new CommandDispatcher({
    router,
    agent,
    conversation,
    speech,
    runLocal: (route, text) => runLocal(route, text, { gestures }),
    send,
    log,
    logError: (message) => console.error(`[friday] ${message}`),
  });
  if (agent.enabled) {
    const session = agent.session
      ? `, sessions ${agent.session}-*, new after ${agent.sessionIdleMs / 1000}s idle`
      : ', stateless';
    log(`agent bridge: ${agent.baseUrl} (model ${agent.model}${session})`);
  } else {
    log('agent bridge: disabled (set FRIDAY_AGENT_URL and FRIDAY_AGENT_KEY)');
  }
  if (router.enabled) {
    log(`jev router: ${router.url} (model ${router.model}, min confidence ${router.minConfidence})`);
  } else {
    log(`jev router: disabled (${router.disabledReason}), every command goes to the agent`);
  }

  if (initialCommand === 'wake' || initialCommand === 'toggle') pendingWake = 1;
  createWindow();
  badge.create();
  gestureDebug.create();
  if (gestureDebug.enabled) log('gesture debug view on (FRIDAY_GESTURE_DEBUG=1)');
  // SUPER+ALT+G while Friday was not running started this instance: do what it asked.
  if (initialCommand === 'gesture') gestures.enable();
  listener.start();
  speech.start();
});

app.on('window-all-closed', (event) => event.preventDefault());
app.on('before-quit', () => {
  gestures.disable('quit');
  listener.stop();
  router.cancel();
  agent.close();
  speech.stop();
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => app.quit());
}
