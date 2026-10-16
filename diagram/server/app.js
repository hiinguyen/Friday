import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { AppError, toEnvelope, ok } from './errors.js';
import { createLocks } from './locks.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerAgentRoutes } from './routes/agent.js';
import { ingestText, ingestFile, ingestUrl } from './ingest/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const SHARED_DIR = path.join(ROOT, 'shared');
const require = createRequire(import.meta.url);

function importMapHash() {
  try {
    const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
    const match = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
    if (!match) return null;
    return `sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}`;
  } catch {
    return null;
  }
}

function equalToken(provided, expected) {
  const a = Buffer.from(String(provided ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function authHook(config) {
  return async (request) => {
    if (!request.url.startsWith('/api/') || request.url.startsWith('/api/health')) return;
    if (config.token === null) return;
    const header = request.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!equalToken(provided, config.token)) throw new AppError('unauthorized');
  };
}

function errorHandler(error, request, reply) {
  if (error instanceof AppError) {
    if (error.detail) request.log.warn({ detail: error.detail }, error.message);
    reply.code(error.status).send(toEnvelope(error));
    return;
  }
  const status = error.statusCode ?? 500;
  if (status >= 400 && status < 500) {
    reply.code(400).send(toEnvelope(new AppError('bad_input')));
    return;
  }
  request.log.error(error);
  reply.code(500).send(toEnvelope(new AppError('internal')));
}

export async function buildApp(config, { agent, store, ingest = { ingestText, ingestFile, ingestUrl }, logger = false } = {}) {
  const app = Fastify({ logger, bodyLimit: 2 * 1024 * 1024 });
  const locks = createLocks();
  const cspHash = importMapHash();

  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 }, throwFileSizeLimit: false });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'${cspHash ? ` '${cspHash}'` : ''}; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
  });
  app.addHook('onRequest', authHook(config));
  app.setErrorHandler(errorHandler);

  app.get('/vendor/opentype.mjs', async (request, reply) => {
    const dir = path.dirname(require.resolve('opentype.js/package.json'));
    return reply.type('text/javascript').send(fs.readFileSync(path.join(dir, 'dist', 'opentype.mjs')));
  });
  app.get('/vendor/dagre.esm.js', async (request, reply) => {
    const dir = path.dirname(require.resolve('@dagrejs/dagre/package.json'));
    return reply.type('text/javascript').send(fs.readFileSync(path.join(dir, 'dist', 'dagre.esm.js')));
  });

  registerProjectRoutes(app, { config, store, ingest });
  registerAgentRoutes(app, { store, agent, locks });

  await app.register(fastifyStatic, { root: WEB_DIR, prefix: '/' });
  await app.register(fastifyStatic, { root: SHARED_DIR, prefix: '/shared/', decorateReply: false });

  return app;
}

export { ok };
