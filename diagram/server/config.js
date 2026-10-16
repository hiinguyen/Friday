import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIAGRAM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = ['claude-code', 'hermes', 'fake'];
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const DEFAULT_PORT = 8790;
const DEFAULT_TIMEOUT_S = 180;
const DEFAULT_HERMES_MODEL = 'hermes-agent';

function nonEmpty(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : text;
}

function parsePositive(value, fallback, name) {
  if (nonEmpty(value) === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number, got "${value}"`);
  return number;
}

export function loadConfig(env) {
  const agent = nonEmpty(env.DIAGRAM_AGENT) ?? 'claude-code';
  if (!AGENTS.includes(agent)) throw new Error(`DIAGRAM_AGENT must be one of ${AGENTS.join(', ')}, got "${agent}"`);
  const host = nonEmpty(env.DIAGRAM_HOST) ?? '127.0.0.1';
  const port = parsePositive(env.DIAGRAM_PORT, DEFAULT_PORT, 'DIAGRAM_PORT');
  if (!Number.isInteger(port) || port > 65535) throw new Error(`DIAGRAM_PORT must be a port number, got "${env.DIAGRAM_PORT}"`);
  const token = nonEmpty(env.DIAGRAM_TOKEN);
  if (!LOOPBACK.has(host) && token === null) {
    throw new Error(`DIAGRAM_TOKEN is required when DIAGRAM_HOST (${host}) is not a loopback address`);
  }
  const dataDir = path.resolve(DIAGRAM_ROOT, '..', nonEmpty(env.DIAGRAM_DATA_DIR) ?? path.join('diagram', 'data'));
  const url = nonEmpty(env.DIAGRAM_HERMES_URL) ?? nonEmpty(env.FRIDAY_AGENT_URL);
  return {
    agent,
    host,
    port,
    token,
    dataDir,
    agentTimeoutMs: parsePositive(env.DIAGRAM_AGENT_TIMEOUT_S, DEFAULT_TIMEOUT_S, 'DIAGRAM_AGENT_TIMEOUT_S') * 1000,
    claudeModel: nonEmpty(env.DIAGRAM_CLAUDE_MODEL),
    hermes: {
      url: url === null ? null : url.replace(/\/+$/, ''),
      key: nonEmpty(env.DIAGRAM_HERMES_KEY) ?? nonEmpty(env.FRIDAY_AGENT_KEY),
      model: nonEmpty(env.DIAGRAM_HERMES_MODEL) ?? nonEmpty(env.FRIDAY_AGENT_MODEL) ?? DEFAULT_HERMES_MODEL,
    },
  };
}

export { DIAGRAM_ROOT };
