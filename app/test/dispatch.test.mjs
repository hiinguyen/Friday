import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { CommandDispatcher, NEW_CONVERSATION_REPLY, PREVIOUS_REPLY_CHARS } = require('../src/dispatch.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A dispatcher wired to fakes that record everything it does. */
function setup({ decision = { route: 'agent', confidence: 0.9, ms: 1 }, routerEnabled = true, agentEnabled = true, warm = true, local } = {}) {
  const calls = { classify: [], ask: [], said: [], ended: [], speechCancelled: 0, sent: [], local: [], resets: 0 };
  const router = {
    enabled: routerEnabled,
    classify: async (text, previous) => {
      calls.classify.push({ text, previous });
      return typeof decision === 'function' ? decision(text) : decision;
    },
  };
  const agent = { enabled: agentEnabled, ask: (id, text, session) => calls.ask.push({ id, text, session }) };
  const conversation = {
    warm,
    begin: () => ({ session: 'friday-1', fresh: true }),
    reset: () => {
      calls.resets += 1;
    },
  };
  const speech = {
    say: (id, text) => calls.said.push({ id, text }),
    end: (id) => calls.ended.push(id),
    cancel: () => {
      calls.speechCancelled += 1;
    },
  };
  const runLocal =
    local ??
    (async (route, text) => {
      calls.local.push({ route, text });
      return `local ${route}`;
    });
  const dispatcher = new CommandDispatcher({
    router,
    agent,
    conversation,
    speech,
    runLocal,
    send: (channel, payload) => calls.sent.push([channel, payload]),
    log: () => {},
    logError: () => {},
  });
  return { dispatcher, calls, conversation };
}

const agentEvents = (calls) => calls.sent.filter(([channel]) => channel === 'hud:agent').map(([, p]) => p);
const replies = (calls) => calls.sent.filter(([channel]) => channel === 'hud:reply').map(([, p]) => p);

test('an exact reset phrase starts a new conversation without asking Jev', async () => {
  const { dispatcher, calls } = setup();
  await dispatcher.handle(1, 'New conversation.');
  assert.equal(calls.classify.length, 0);
  assert.equal(calls.resets, 1);
  assert.deepEqual(replies(calls), [{ id: 1, text: NEW_CONVERSATION_REPLY, final: true }]);
  assert.deepEqual(calls.said, [{ id: 1, text: NEW_CONVERSATION_REPLY }]);
});

test('without Jev every command goes straight to the agent, as before the router', async () => {
  const { dispatcher, calls } = setup({ routerEnabled: false });
  await dispatcher.handle(1, 'what is in my downloads');
  assert.equal(calls.classify.length, 0);
  assert.deepEqual(calls.ask, [{ id: 1, text: 'what is in my downloads', session: 'friday-1' }]);
  assert.equal(dispatcher.fresh, true);
});

test('the HUD hears that Jev is routing, then which route it picked', async () => {
  const { dispatcher, calls } = setup({ decision: { route: 'agent', confidence: 0.92, ms: 1 } });
  await dispatcher.handle(1, 'list my downloads');
  assert.deepEqual(agentEvents(calls).slice(0, 2), [
    { id: 1, state: 'working', phase: 'routing' },
    { id: 1, state: 'working', route: 'agent', confidence: 0.92, reason: undefined, routeError: undefined },
  ]);
  assert.equal(calls.ask.length, 1);
});

test('a Jev failure still reaches the agent', async () => {
  const { dispatcher, calls } = setup({ decision: { route: 'agent', confidence: 0, reason: 'error', error: 'Jev timed out', ms: 8000 } });
  await dispatcher.handle(1, 'hello');
  assert.equal(calls.ask.length, 1);
  assert.equal(agentEvents(calls)[1].routeError, 'Jev timed out');
});

test('a local route is answered here, shown and spoken', async () => {
  const { dispatcher, calls } = setup({ decision: { route: 'time', confidence: 1, ms: 1 } });
  await dispatcher.handle(1, 'what time is it');
  assert.deepEqual(calls.local, [{ route: 'time', text: 'what time is it' }]);
  assert.deepEqual(replies(calls), [{ id: 1, text: 'local time', final: true }]);
  assert.deepEqual(calls.said, [{ id: 1, text: 'local time' }]);
  assert.deepEqual(calls.ended, [1]);
  assert.equal(calls.ask.length, 0);
});

test('a failing local command is reported as a local error', async () => {
  const local = async () => {
    throw new Error('spawn wpctl ENOENT');
  };
  const { dispatcher, calls } = setup({ decision: { route: 'mute', confidence: 1, ms: 1 }, local });
  await dispatcher.handle(1, 'mute');
  assert.deepEqual(agentEvents(calls).at(-1), { id: 1, state: 'error', error: 'mute: spawn wpctl ENOENT', source: 'Local' });
  assert.equal(calls.said.length, 0);
});

test('cancel stops her talking and ends the command, leaving the HUD up', async () => {
  const { dispatcher, calls } = setup({ decision: { route: 'cancel', confidence: 0.99, ms: 1 } });
  await dispatcher.handle(1, 'never mind');
  assert.equal(calls.speechCancelled, 1);
  assert.deepEqual(agentEvents(calls).at(-1), { id: 1, state: 'done' });
  assert.ok(!calls.sent.some(([channel]) => channel === 'hud:dismiss'));
  assert.equal(calls.ask.length, 0);
});

test('a simple task is only labelled: nothing answers it yet', async () => {
  const { dispatcher, calls } = setup({ decision: { route: 'simple', confidence: 0.98, ms: 1 } });
  await dispatcher.handle(1, 'gold price today');
  assert.deepEqual(agentEvents(calls).at(-1), { id: 1, state: 'done' });
  assert.equal(calls.ask.length, 0);
  assert.equal(calls.said.length, 0);
  assert.equal(replies(calls).length, 0);
});

test('Jev picking new_conversation resets the session like the exact phrase does', async () => {
  const { dispatcher, calls } = setup({ decision: { route: 'new_conversation', confidence: 0.99, ms: 1 } });
  await dispatcher.handle(1, "let's talk about something else");
  assert.equal(calls.resets, 1);
  assert.deepEqual(agentEvents(calls).at(-1), { id: 1, state: 'done', session: 'reset' });
});

test('with the agent bridge off, an agent route says so instead of vanishing', async () => {
  const { dispatcher, calls } = setup({ agentEnabled: false });
  await dispatcher.handle(1, 'list my downloads');
  assert.equal(calls.ask.length, 0);
  assert.equal(agentEvents(calls).at(-1).state, 'error');
  assert.match(agentEvents(calls).at(-1).error, /FRIDAY_AGENT_URL/);
});

test('a wake or dismissal while Jev decides drops the command', async () => {
  const pending = deferred();
  const { dispatcher, calls } = setup({ decision: () => pending.promise });
  const handled = dispatcher.handle(1, 'what time is it');
  await flush();
  dispatcher.abandon();
  pending.resolve({ route: 'time', confidence: 1, ms: 1 }); // the router answered anyway
  await handled;
  assert.equal(calls.local.length, 0);
  assert.equal(calls.ask.length, 0);
  assert.equal(agentEvents(calls).length, 1, 'only the routing notice was sent');
});

test('a wake while a local command runs keeps its late reply off the HUD and silent', async () => {
  const pending = deferred();
  const { dispatcher, calls } = setup({ decision: { route: 'volume_up', confidence: 1, ms: 1 }, local: () => pending.promise });
  const handled = dispatcher.handle(1, 'louder');
  await flush();
  dispatcher.abandon();
  pending.resolve('Volume 60%.');
  await handled;
  assert.equal(replies(calls).length, 0);
  assert.equal(calls.said.length, 0);
});

test('a newer command supersedes the older one still being routed', async () => {
  const first = deferred();
  const { dispatcher, calls } = setup({ decision: (text) => (text === 'one' ? first.promise : { route: 'time', confidence: 1, ms: 1 }) });
  const older = dispatcher.handle(1, 'one');
  await flush();
  await dispatcher.handle(2, 'two');
  first.resolve({ route: 'mute', confidence: 1, ms: 1 });
  await older;
  assert.deepEqual(calls.local, [{ route: 'time', text: 'two' }]);
});

test('the agent reply of a dismissed command stays silent, a new command speaks again', async () => {
  const { dispatcher } = setup();
  await dispatcher.handle(1, 'list my downloads');
  dispatcher.abandon();
  assert.equal(dispatcher.isSilenced(1), true);
  await dispatcher.handle(2, 'and the documents');
  assert.equal(dispatcher.isSilenced(1), false);
  assert.equal(dispatcher.isSilenced(2), false);
});

test('Jev sees the last agent exchange while the conversation is warm, trimmed', async () => {
  const { dispatcher, calls, conversation } = setup();
  await dispatcher.handle(1, 'list my downloads');
  assert.equal(calls.classify[0].previous, null, 'nothing said yet');
  dispatcher.onAgentDone(1, 'x'.repeat(PREVIOUS_REPLY_CHARS + 50));
  await dispatcher.handle(2, 'how big is the first one');
  assert.deepEqual(calls.classify[1].previous, { command: 'list my downloads', reply: 'x'.repeat(PREVIOUS_REPLY_CHARS) });
  conversation.warm = false;
  await dispatcher.handle(3, 'unrelated');
  assert.equal(calls.classify[2].previous, null, 'a cold conversation has no previous exchange');
});

test('a failed agent run or a reset forgets the last exchange', async () => {
  const { dispatcher, calls } = setup();
  await dispatcher.handle(1, 'list my downloads');
  dispatcher.onAgentDone(1, 'three files');
  await dispatcher.handle(2, 'open the first');
  dispatcher.onAgentError(2);
  await dispatcher.handle(3, 'try again');
  assert.equal(calls.classify[2].previous, null);

  dispatcher.onAgentDone(3, 'done');
  await dispatcher.handle(4, 'New conversation.');
  await dispatcher.handle(5, 'hello');
  assert.equal(calls.classify.at(-1).previous, null);
});

test('handle never rejects, even when a collaborator throws', async () => {
  const { dispatcher } = setup();
  dispatcher.router.classify = async () => {
    throw new Error('boom');
  };
  await dispatcher.handle(1, 'hello');
});
