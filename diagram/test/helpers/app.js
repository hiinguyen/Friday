import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../server/config.js';
import { buildApp } from '../../server/app.js';
import { createStore } from '../../server/store.js';
import { createAgent } from '../../server/agent/index.js';

export async function makeTestApp({ env = {}, agent } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diagram-test-'));
  const config = loadConfig({ DIAGRAM_AGENT: 'fake', DIAGRAM_DATA_DIR: dataDir, ...env });
  const store = createStore(config.dataDir);
  const app = await buildApp(config, { agent: agent ?? createAgent(config), store });
  const inject = app.inject.bind(app);
  const defaultHost = `127.0.0.1:${config.port}`;
  app.inject = (options = {}) => inject({ ...options, headers: { host: defaultHost, ...(options.headers ?? {}) } });
  return {
    app, store, config, dataDir,
    async close() {
      await app.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

export function json(response) {
  return JSON.parse(response.body);
}
