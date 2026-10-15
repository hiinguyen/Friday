'use strict';

// Commands Friday answers on this machine, without the remote agent: the time,
// and the volume of the default PipeWire sink. The Jev router (router.js)
// picks them; this module only carries them out and says what it did, in the
// language the command was spoken in.

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const SINK = '@DEFAULT_AUDIO_SINK@';
const STEP = '10%';
const MAX_VOLUME = '1.0'; // never boost past 100%
const WPCTL_TIMEOUT_MS = 3000;
const VIETNAMESE = /[àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]/i;
const VI_WEEKDAYS = ['Chủ nhật', 'thứ Hai', 'thứ Ba', 'thứ Tư', 'thứ Năm', 'thứ Sáu', 'thứ Bảy'];

const execFileAsync = promisify(execFile);
const defaultExec = (file, args) => execFileAsync(file, args, { timeout: WPCTL_TIMEOUT_MS });

/** True when the command is Vietnamese: no other language Friday hears uses these letters. */
function isVietnamese(text) {
  return VIETNAMESE.test(String(text).normalize('NFC'));
}

const pad = (n) => String(n).padStart(2, '0');

function timeReply(text, date) {
  if (isVietnamese(text)) {
    const day = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
    return `Bây giờ là ${date.getHours()}:${pad(date.getMinutes())}, ${VI_WEEKDAYS[date.getDay()]}, ${day}.`;
  }
  // ICU puts a narrow no-break space before AM/PM; the voice and the HUD want a plain one.
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ');
  const day = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return `It's ${time}, ${day}.`;
}

async function volumeReply(text, exec) {
  const { stdout } = await exec('wpctl', ['get-volume', SINK]);
  const level = Number.parseFloat(/Volume:\s*([\d.]+)/.exec(stdout)?.[1]);
  if (!Number.isFinite(level)) throw new Error(`unexpected wpctl output: ${stdout.trim()}`);
  const percent = Math.round(level * 100);
  const muted = stdout.includes('[MUTED]');
  if (isVietnamese(text)) return `Âm lượng ${percent}%${muted ? ', vẫn đang tắt tiếng' : ''}.`;
  return `Volume ${percent}%${muted ? ', still muted' : ''}.`;
}

const HANDLERS = {
  time: async (text, { now }) => timeReply(text, now()),
  volume_up: async (text, { exec }) => {
    await exec('wpctl', ['set-volume', '-l', MAX_VOLUME, SINK, `${STEP}+`]);
    return volumeReply(text, exec);
  },
  volume_down: async (text, { exec }) => {
    await exec('wpctl', ['set-volume', SINK, `${STEP}-`]);
    return volumeReply(text, exec);
  },
  mute: async (text, { exec }) => {
    await exec('wpctl', ['set-mute', SINK, '1']);
    return isVietnamese(text) ? 'Đã tắt tiếng.' : 'Muted.';
  },
  unmute: async (text, { exec }) => {
    await exec('wpctl', ['set-mute', SINK, '0']);
    return isVietnamese(text) ? 'Đã bật tiếng.' : 'Sound on.';
  },
};

const LOCAL_ROUTES = new Set(Object.keys(HANDLERS));

/** Carry out a local route for the command `text`; resolves to the reply to show and speak. */
async function runLocal(route, text, { exec = defaultExec, now = () => new Date() } = {}) {
  if (!LOCAL_ROUTES.has(route)) throw new Error(`${route} is not a local route`);
  return HANDLERS[route](text, { exec, now });
}

module.exports = { LOCAL_ROUTES, isVietnamese, runLocal, timeReply };
