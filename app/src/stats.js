'use strict';

// Lightweight system telemetry for the HUD side panels.

const fs = require('node:fs');
const os = require('node:os');

const POWER_SUPPLY = '/sys/class/power_supply';

function cpuTimes() {
  return os.cpus().reduce(
    (acc, cpu) => {
      const { user, nice, sys, idle, irq } = cpu.times;
      return { busy: acc.busy + user + nice + sys + irq, total: acc.total + user + nice + sys + idle + irq };
    },
    { busy: 0, total: 0 },
  );
}

function readBattery() {
  try {
    const bat = fs.readdirSync(POWER_SUPPLY).find((name) => name.startsWith('BAT'));
    if (!bat) return null;
    const capacity = Number(fs.readFileSync(`${POWER_SUPPLY}/${bat}/capacity`, 'utf8').trim());
    const status = fs.readFileSync(`${POWER_SUPPLY}/${bat}/status`, 'utf8').trim();
    return { capacity, charging: status === 'Charging' || status === 'Full' };
  } catch {
    return null;
  }
}

function readNetBytes() {
  try {
    return fs
      .readFileSync('/proc/net/dev', 'utf8')
      .split('\n')
      .slice(2)
      .map((line) => line.trim().split(/[:\s]+/))
      .filter((cols) => cols.length > 9 && cols[0] !== 'lo')
      .reduce((acc, cols) => ({ rx: acc.rx + Number(cols[1]), tx: acc.tx + Number(cols[9]) }), { rx: 0, tx: 0 });
  } catch {
    return { rx: 0, tx: 0 };
  }
}

function createSampler() {
  let prevCpu = cpuTimes();
  let prevNet = readNetBytes();
  let prevAt = Date.now();

  return function sampleStats() {
    const cpu = cpuTimes();
    const net = readNetBytes();
    const now = Date.now();
    const seconds = Math.max((now - prevAt) / 1000, 0.001);
    const totalDelta = cpu.total - prevCpu.total;

    const sample = {
      cpu: totalDelta > 0 ? (cpu.busy - prevCpu.busy) / totalDelta : 0,
      mem: 1 - os.freemem() / os.totalmem(),
      memTotalGb: os.totalmem() / 1024 ** 3,
      battery: readBattery(),
      netDown: Math.max(0, (net.rx - prevNet.rx) / seconds),
      netUp: Math.max(0, (net.tx - prevNet.tx) / seconds),
      uptime: os.uptime(),
      load: os.loadavg()[0],
      cores: os.cpus().length,
      host: os.hostname(),
      user: os.userInfo().username,
    };

    prevCpu = cpu;
    prevNet = net;
    prevAt = now;
    return sample;
  };
}

module.exports = { createSampler };
