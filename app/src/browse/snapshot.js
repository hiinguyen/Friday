'use strict';

// The browser-side snapshot script, kept as its own file so its text is never
// parsed as Node code. `snapshot.browser.js` is a verbatim copy of
// REF/jev_ultrafast/snapshot.js (MIT, Copyright (c) 2026 Browser Use) plus an
// attribution header; page.js evaluates it in the page as one atomic read.

const fs = require('node:fs');
const path = require('node:path');

const READ_STATE = fs.readFileSync(path.join(__dirname, 'snapshot.browser.js'), 'utf8');

/** Cheap full-page guard: evaluate this and compare its value with state.marker. */
const MARKER = `(() => { const state=${READ_STATE}; return state?.marker ?? null; })()`;

module.exports = { MARKER, READ_STATE };
