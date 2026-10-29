import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../errors.js';
import { extractJson } from './json-extract.js';

const MAX_STREAM_BYTES = 5 * 1024 * 1024;
const ENV_KEYS = ['PATH', 'HOME', 'LANG'];

// The child only needs the environment Claude Code itself reads; never the app's own secrets.
function childEnv(source) {
  const env = {};
  for (const name of Object.keys(source)) {
    if (ENV_KEYS.includes(name) || /^(ANTHROPIC_|CLAUDE_)/.test(name)) env[name] = source[name];
  }
  return env;
}

export function createClaudeCodeAdapter({ model = null, spawnImpl = spawn, tmpRoot = os.tmpdir() } = {}) {
  return {
    name: 'claude-code',
    run({ system, user, schema, signal }) {
      return new Promise((resolve, reject) => {
        const cwd = fs.mkdtempSync(path.join(tmpRoot, 'diagram-agent-'));
        let settled = false;
        const cleanup = () => {
          try {
            fs.rmSync(cwd, { recursive: true, force: true });
          } catch {
            /* the temp dir may already be gone */
          }
        };
        const fail = (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const done = (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const args = [
          '-p',
          '--output-format', 'json',
          '--json-schema', JSON.stringify(schema),
          '--system-prompt', system,
          '--tools', '',
          '--setting-sources', '',
          '--strict-mcp-config',
          '--no-session-persistence',
          ...(model ? ['--model', model] : []),
        ];

        let child;
        try {
          child = spawnImpl('claude', args, { cwd, env: childEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (error) {
          fail(new AppError('agent_error', error?.message ?? 'could not spawn claude'));
          return;
        }

        let stdout = '';
        let stdoutBytes = 0;
        let stderr = '';
        let stderrBytes = 0;
        const tooLarge = () => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          fail(new AppError('agent_failed'));
        };
        child.stdout.on('data', (chunk) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > MAX_STREAM_BYTES) {
            tooLarge();
            return;
          }
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderrBytes += chunk.length;
          if (stderrBytes > MAX_STREAM_BYTES) {
            tooLarge();
            return;
          }
          stderr += chunk;
        });
        child.on('error', (error) => {
          if (error?.code === 'ENOENT') {
            fail(new AppError('agent_unavailable', 'Không tìm thấy lệnh claude. Cài Claude Code hoặc đặt DIAGRAM_AGENT=hermes.'));
          } else {
            fail(new AppError('agent_error', error?.message ?? 'claude failed'));
          }
        });
        child.on('close', (code) => {
          if (settled) return;
          if (signal?.aborted) {
            fail(new AppError('cancelled'));
            return;
          }
          if (code !== 0) {
            fail(new AppError('agent_error', `Claude Code thoát với mã ${code}`, { detail: String(stderr).slice(-500) }));
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            fail(new AppError('agent_bad_output', undefined, { detail: String(stdout).slice(0, 2000) }));
            return;
          }
          if (parsed.is_error === true) {
            fail(new AppError('agent_error', undefined, { detail: String(parsed.result ?? '').slice(0, 2000) }));
            return;
          }
          if (parsed.structured_output && typeof parsed.structured_output === 'object') {
            done(parsed.structured_output);
            return;
          }
          try {
            done(extractJson(parsed.result ?? ''));
          } catch {
            fail(new AppError('agent_bad_output', undefined, { detail: String(parsed.result ?? '').slice(0, 2000) }));
          }
        });

        const abort = () => {
          try {
            child.kill('SIGTERM');
          } catch {
            /* already gone */
          }
          const killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }, 3000);
          if (typeof killTimer.unref === 'function') killTimer.unref();
        };
        if (signal) {
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort);
        }
        child.stdin.on('error', () => {});
        child.stdin.end(user);
      });
    },
  };
}
