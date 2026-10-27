#!/usr/bin/env node
// Run one browse goal against the user's own Chrome, for end-to-end checks:
//
//   cd app && node scripts/browse.mjs [--url URL] "goal"
//
// Loads the root .env the way the service does, prints one line per step, then a
// JSON summary. Exits 0 on done, 1 on blocked or cancelled, 2 on setup errors.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Before the agent reads its settings: fill the environment from the root .env.
require('../src/env').loadEnvFile();
const { BrowserAgent } = require('../src/browse/agent.js');
const { Chrome } = require('../src/browse/cdp.js');

const args = process.argv.slice(2);
let url = null;
const words = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--url') {
    url = args[index + 1];
    index += 1;
    if (!url) {
      console.error('--url needs a value');
      process.exit(2);
    }
  } else {
    words.push(args[index]);
  }
}

const goal = words.join(' ').trim();
if (!goal) {
  console.error('usage: node scripts/browse.mjs [--url URL] "goal"');
  process.exit(2);
}
if (url) process.env.FRIDAY_BROWSE_START_URL = url;

const chrome = new Chrome();
const agent = new BrowserAgent({ chrome });
if (!agent.enabled) {
  console.error(`browse agent disabled: ${agent.disabledReason}`);
  process.exit(2);
}

process.on('SIGINT', () => {
  console.error('cancelling');
  agent.cancel();
});

let code = 0;
try {
  const result = await agent.run(goal, {
    onStep: (step) => {
      const value = step.text ? ` ${JSON.stringify(step.text)}` : '';
      console.log(`step ${step.step} ${step.operation} ${step.label}${value}`);
    },
  });
  if (!result) {
    console.error('cancelled');
    code = 1;
  } else {
    console.log(JSON.stringify(result));
    code = result.status === 'done' ? 0 : 1;
  }
} catch (err) {
  console.error(`browse failed: ${err.message}`);
  code = 2;
} finally {
  // The run is over: release the one CDP connection so the process can exit.
  if (chrome.conn) chrome.conn.close();
}
process.exit(code);
