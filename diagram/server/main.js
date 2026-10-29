import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { createAgent } from './agent/index.js';
import { buildApp } from './app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function onPath(name) {
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

async function main() {
  dns.setDefaultResultOrder('ipv4first');
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const config = loadConfig(process.env);
  const store = createStore(config.dataDir, { maxProjects: config.maxProjects });
  const agent = createAgent(config);
  const app = await buildApp(config, { agent, store, logger: true });

  if (config.agent === 'claude-code' && !onPath('claude')) app.log.warn('claude is not on PATH; set DIAGRAM_AGENT=hermes or install Claude Code');
  if (config.agent === 'hermes' && (!config.hermes.url || !config.hermes.key)) app.log.warn('DIAGRAM_HERMES_URL or DIAGRAM_HERMES_KEY is missing');

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Diagram Studio: http://${config.host}:${config.port} (agent: ${agent.name})`);

  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
