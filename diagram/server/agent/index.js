import { AppError } from '../errors.js';
import { TASKS, BadOutput } from './tasks.js';
import { validateSchema } from './validate.js';
import { createClaudeCodeAdapter } from './claude-code.js';
import { createHermesAdapter } from './hermes.js';
import { createFakeAdapter } from './fake.js';

const DEFAULT_TIMEOUT_MS = 180000;

function pickAdapter(config) {
  if (config.agent === 'hermes') return createHermesAdapter(config.hermes);
  if (config.agent === 'fake') return createFakeAdapter({ delayMs: Number(process.env.DIAGRAM_FAKE_DELAY_MS ?? 0) });
  return createClaudeCodeAdapter({ model: config.claudeModel ?? null });
}

function mapAbort(error, callerSignal, timeoutSignal) {
  if (error instanceof AppError && error.code === 'cancelled') {
    if (timeoutSignal?.aborted) return new AppError('agent_timeout');
    if (callerSignal?.aborted) return new AppError('cancelled');
  }
  return error;
}

function describe(raw) {
  try {
    return JSON.stringify(raw) ?? String(raw);
  } catch {
    return String(raw);
  }
}

export function createAgent(config, { adapter } = {}) {
  const chosen = adapter ?? pickAdapter(config);
  return {
    name: chosen.name,
    async run(taskName, context = {}, { signal } = {}) {
      const task = TASKS[taskName];
      if (!task) throw new AppError('internal', `unknown agent task "${taskName}"`);
      const timeoutSignal = AbortSignal.timeout(config.agentTimeoutMs ?? DEFAULT_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const system = task.system();
      let user = task.user(context);
      let lastRaw = '';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let raw;
        try {
          raw = await chosen.run({ task: taskName, system, user, schema: task.schema, signal: combined });
        } catch (error) {
          throw mapAbort(error, signal, timeoutSignal);
        }
        lastRaw = describe(raw);
        let errors = validateSchema(task.schema, raw);
        if (errors.length === 0) {
          try {
            return task.postprocess(raw, context);
          } catch (error) {
            if (!(error instanceof BadOutput)) throw error;
            errors = [error.message];
          }
        }
        user = `${task.user(context)}\n\nYour previous answer was rejected: ${errors.join('; ')}. Return a corrected JSON object.`;
      }
      throw new AppError('agent_bad_output', undefined, { detail: lastRaw.slice(0, 2000) });
    },
  };
}
