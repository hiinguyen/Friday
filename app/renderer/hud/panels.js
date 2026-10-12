// DOM side of the HUD: telemetry panel, neural-link log, clock, identity.

const $ = (id) => document.getElementById(id);
const SPARK_POINTS = 60;
const LOG_LIMIT = 11;
const WARN_THRESHOLD = 0.85;

function formatRate(bytesPerSec) {
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let v = bytesPerSec;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v < 10 && u > 0 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m` : `${pad(h)}h ${pad(m)}m`;
}

const timeStamp = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

export class Panels {
  constructor() {
    this.cpuHistory = [];
    this.timers = [];
    this.clockTimer = 0;
    this.spark = $('spark');
  }

  setMetric(key, fraction, label) {
    $(`${key}-bar`).style.width = `${Math.round(fraction * 100)}%`;
    $(`${key}-val`).textContent = label;
    $(`${key}-bar`).closest('.metric').classList.toggle('warn', fraction >= WARN_THRESHOLD);
  }

  updateStats(stats) {
    this.setMetric('cpu', stats.cpu, `${Math.round(stats.cpu * 100)}%`);
    this.setMetric('mem', stats.mem, `${Math.round(stats.mem * 100)}%`);
    if (stats.battery) {
      const { capacity, charging } = stats.battery;
      $('bat-label').textContent = charging ? 'Power cell +' : 'Power cell';
      this.setMetric('bat', capacity / 100, `${capacity}%`);
      // Low battery is the warning case, so invert the threshold.
      $('bat-bar').closest('.metric').classList.toggle('warn', capacity <= 20 && !charging);
    } else {
      this.setMetric('bat', 1, 'AC');
    }
    $('net-down').textContent = formatRate(stats.netDown);
    $('net-up').textContent = formatRate(stats.netUp);
    $('load').textContent = stats.load.toFixed(2);
    $('uptime').textContent = formatUptime(stats.uptime);
    $('identity').textContent = `${stats.user}@${stats.host}`.toUpperCase();

    this.cpuHistory = [...this.cpuHistory, stats.cpu].slice(-SPARK_POINTS);
    this.drawSpark();
  }

  drawSpark() {
    const canvas = this.spark;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(79,216,255,0.12)';
    ctx.lineWidth = 1;
    for (let gy = 0; gy <= 4; gy += 1) {
      const y = Math.round((gy / 4) * (h - 1)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const pts = this.cpuHistory;
    if (pts.length < 2) return;
    const step = w / (SPARK_POINTS - 1);
    const x0 = w - (pts.length - 1) * step;
    const yOf = (v) => h - 2 - v * (h - 4);

    ctx.beginPath();
    pts.forEach((v, i) => (i === 0 ? ctx.moveTo(x0, yOf(v)) : ctx.lineTo(x0 + i * step, yOf(v))));
    ctx.strokeStyle = 'rgba(79,216,255,0.95)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineTo(w, h);
    ctx.lineTo(x0, h);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, 0, 0, h);
    fill.addColorStop(0, 'rgba(79,216,255,0.28)');
    fill.addColorStop(1, 'rgba(79,216,255,0)');
    ctx.fillStyle = fill;
    ctx.fill();
  }

  log(text, kind = 'info', value = '') {
    const list = $('log');
    const li = document.createElement('li');
    li.className = kind;
    const time = document.createElement('time');
    time.textContent = timeStamp();
    const body = document.createElement('span');
    body.textContent = text;
    if (value) {
      const b = document.createElement('b');
      b.textContent = ` ${value}`;
      body.append(b);
    }
    li.append(time, body);
    list.append(li);
    while (list.children.length > LOG_LIMIT) list.firstElementChild.remove();
  }

  /** Schedule log lines relative to now; all are cancelled by stop(). */
  sequence(lines) {
    for (const [delayMs, text, kind, value] of lines) {
      this.timers.push(setTimeout(() => this.log(text, kind, value), delayMs));
    }
  }

  tickClock() {
    const now = new Date();
    $('clock').textContent = now.toLocaleTimeString('en-GB', { hour12: false });
    $('date').textContent = now
      .toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' })
      .toUpperCase();
  }

  start() {
    this.tickClock();
    this.clockTimer = setInterval(() => this.tickClock(), 1000);
  }

  stop() {
    clearInterval(this.clockTimer);
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  clear() {
    $('log').replaceChildren();
    this.cpuHistory = [];
  }
}
