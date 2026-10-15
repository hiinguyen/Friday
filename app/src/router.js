'use strict';

// Jev intent router: every voice command is classified by Jev, TypeSafe's
// System One model, before anything handles it. One call asks typed questions
// in parallel and returns typed answers with calibrated confidence, so the
// code below, not a prompt, decides where the command goes:
//
//   new_conversation, cancel     handled by dispatch.js, no agent run (only when
//                                Jev is very sure: a wrong guess loses the request)
//   time, volume_*, (un)mute     handled on this machine (local.js)
//   simple                       a one-fact task; only labelled for now
//   agent                        the remote Hermes agent, as before Jev
//
// Jev never drops a command: no answer, an error, a timeout or low confidence
// all fall back to the agent, which is what Friday did before the router.
//
// Configured from the environment, which main.js fills from ROOT/.env. Without
// a key the router is disabled and every command goes to the agent.
//
//   JEV_API_KEY                 bearer key (a JevStation key, or TypeSafe's own)
//   FRIDAY_JEV_URL              endpoint (default JevStation's /api/v1/systemone;
//                               https://api.typesafe.ai/v1/systemone talks to TypeSafe directly)
//   FRIDAY_JEV_MODEL            model id (default jev-1.13.0: pinned, so the
//                               confidence threshold does not drift with an alias)
//   FRIDAY_JEV_MIN_CONFIDENCE   below this the answer is not trusted (default 0.5)
//   FRIDAY_JEV_TIMEOUT_S        give up and fall back to the agent (default 8; JevStation
//                               took 1.4 to 5.9 s per call in October 2026)
//
// Each call costs one JevStation credit while it asks at most five questions.

const DEFAULT_URL = 'https://jevstation.com/api/v1/systemone';
const DEFAULT_MODEL = 'jev-1.13.0';
const DEFAULT_MIN_CONFIDENCE = 0.5;
const DEFAULT_TIMEOUT_S = 8;
const FOLLOW_UP_MIN = 0.5;
// Routes that end the command or throw away the conversation: a wrong guess loses
// the user's request, so they need a surer answer than routes that only answer it.
const DROPPING_ROUTES = new Set(['cancel', 'new_conversation']);
const DROPPING_MIN_CONFIDENCE = 0.85;
const ERROR_BODY_CHARS = 200;

// Option keys are the routes; descriptions are what Jev judges against.
const INTENTS = {
  agent: 'Anything else: a question, a task, or a request for the assistant',
  new_conversation: 'Start a new conversation with the assistant, or change the subject of the chat',
  cancel: 'Never mind: the user drops their own request or tells the assistant to be quiet (not a request to stop or cancel something else)',
  time: 'Asks the current time, day or date',
  volume_up: 'Make the computer louder',
  volume_down: 'Make the computer quieter',
  mute: 'Mute the computer sound',
  unmute: 'Unmute the computer sound',
};

const COMPLEXITY = {
  simple: 'One quick fact that a single web search answers, such as the weather, a price, a score, a definition or a headline',
  complex: 'Needs several steps, files, apps or actions on the computer, a long answer, or anything a web search cannot settle',
};

const ROUTES = { intents: Object.keys(INTENTS), simple: 'simple', agent: 'agent' };

function positive(value, fallback) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function confidence(value, fallback) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}

/**
 * The Jev request for one voice command. `previous` ({command, reply}) is the
 * last exchange of a conversation that is still warm; only then is Jev asked
 * whether this command follows up on it.
 */
function buildRequest(text, previous, model) {
  const state = { voice_command: text };
  const questions = {
    intent: {
      type: 'choice',
      instructions: 'What does the user want from Friday, a voice assistant, with `voice_command`?',
      criteria: INTENTS,
    },
    complexity: {
      type: 'choice',
      instructions: 'How much work does `voice_command` take to answer?',
      criteria: COMPLEXITY,
    },
  };
  if (previous) {
    state.previous_exchange = previous;
    questions.follow_up = {
      type: 'noul',
      instructions: 'Does `voice_command` continue `previous_exchange`: does it refer to it, or make no sense without it?',
    };
  }
  return { model, state, questions };
}

/** Answers from either JevStation's {data: {...}} envelope or TypeSafe's bare body. */
function parseAnswers(body) {
  const payload = body?.data ?? body;
  if (!payload?.answers || typeof payload.answers !== 'object') throw new Error('Jev returned no answers');
  return {
    answers: payload.answers,
    model: typeof payload.model === 'string' ? payload.model : '',
    credits: Number.isFinite(payload.credits?.remaining) ? payload.credits.remaining : null,
  };
}

/** Where the command goes, from Jev's answers. Anything uncertain goes to the agent. */
function decide(answers, minConfidence) {
  const intent = answers.intent;
  const intentConfidence = Number.isFinite(intent?.confidence) ? intent.confidence : 0;
  const needed = DROPPING_ROUTES.has(intent?.choice) ? Math.max(minConfidence, DROPPING_MIN_CONFIDENCE) : minConfidence;
  if (!Object.hasOwn(INTENTS, intent?.choice ?? '') || intentConfidence < needed) {
    return { route: ROUTES.agent, confidence: intentConfidence, reason: 'unsure' };
  }
  if (intent.choice !== ROUTES.agent) return { route: intent.choice, confidence: intentConfidence };
  if (answers.follow_up?.noul >= FOLLOW_UP_MIN) {
    return { route: ROUTES.agent, confidence: intentConfidence, reason: 'follow-up' };
  }
  const complexity = answers.complexity;
  if (complexity?.choice === ROUTES.simple && complexity.confidence >= minConfidence) {
    return { route: ROUTES.simple, confidence: complexity.confidence };
  }
  return { route: ROUTES.agent, confidence: intentConfidence };
}

async function errorDetail(res) {
  const text = await res.text().catch(() => '');
  let detail = text;
  try {
    const body = JSON.parse(text);
    detail = body.detail?.message ?? body.message ?? body.error?.message ?? text;
  } catch {
    // not JSON: keep the raw text
  }
  return String(detail).trim().slice(0, ERROR_BODY_CHARS) || res.statusText;
}

class JevRouter {
  constructor(options = {}) {
    const env = options.env ?? process.env;
    this.key = options.key ?? env.JEV_API_KEY ?? '';
    this.url = options.url ?? (env.FRIDAY_JEV_URL || DEFAULT_URL);
    this.model = options.model ?? (env.FRIDAY_JEV_MODEL || DEFAULT_MODEL);
    this.minConfidence = confidence(options.minConfidence ?? env.FRIDAY_JEV_MIN_CONFIDENCE, DEFAULT_MIN_CONFIDENCE);
    this.timeoutMs = positive(options.timeoutSeconds ?? env.FRIDAY_JEV_TIMEOUT_S, DEFAULT_TIMEOUT_S) * 1000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.controller = null;
  }

  /** Why the router is off ('' when on); then every command goes to the agent. */
  get disabledReason() {
    if (!this.key) return 'set JEV_API_KEY';
    // The bearer key goes wherever the URL points: never in the clear.
    if (!this.url.startsWith('https://')) return `FRIDAY_JEV_URL must be https, got ${this.url}`;
    return '';
  }

  get enabled() {
    return !this.disabledReason;
  }

  /** Abandon the classification in flight, if any (a new wake, or the HUD dismissed). */
  cancel() {
    if (this.controller) this.controller.abort();
  }

  /**
   * Classify one command. Resolves to {route, confidence, reason?, error?,
   * model?, credits?, followUp, ms}, or null when cancelled or superseded by a newer call.
   * Never rejects: a failure is an agent decision with reason 'error'.
   */
  async classify(text, previous) {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    const startedAt = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: JSON.stringify(buildRequest(text, previous, this.model)),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Jev ${res.status}: ${await errorDetail(res)}`);
      const { answers, model, credits } = parseAnswers(await res.json());
      const followUp = Number.isFinite(answers.follow_up?.noul) ? answers.follow_up.noul : null;
      return { ...decide(answers, this.minConfidence), model, credits, followUp, ms: Date.now() - startedAt };
    } catch (err) {
      if (controller.signal.aborted && !timedOut) return null;
      const error = timedOut ? 'Jev timed out' : err.message;
      return { route: ROUTES.agent, confidence: 0, reason: 'error', error, ms: Date.now() - startedAt };
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }
  }
}

module.exports = { JevRouter, ROUTES, buildRequest, decide, parseAnswers };
