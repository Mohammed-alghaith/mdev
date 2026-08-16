#!/usr/bin/env node
// Phase 5 check: an explicit `options.resume` (Sidebar resume) is preferred by
// the host and actually resumes a session — on a *fresh* tab with no prior
// session of its own, so only the explicit path can produce the id. Also
// confirms per-tab session independence (a never-submitted tab has no session).
//
// 1. tab-a starts a fresh session -> capture sid.
// 2. tab-b resumes sid via options.resume -> init/result/exit session_id all match sid.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { submit, sessionIdFor } from '../electron/agent-host.mjs';

const settings = JSON.parse(readFileSync(join(homedir(), '.claude-terminal', 'settings.json'), 'utf8'));
const ds = settings.providers?.deepseek || {};
const apiKey = ds.apiKey || process.env.DEEPSEEK_KEY;
if (!apiKey) { console.error('no deepseek key'); process.exit(2); }
const baseUrl = ds.baseUrl || 'https://api.deepseek.com/anthropic';
const MODEL = 'deepseek-v4-pro';

const env = { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_MODEL: MODEL };
const opts = (extra = {}) => ({
  cwd: process.cwd(),
  model: MODEL,
  env,
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  maxTurns: 3,
  ...extra,
});

function run(tabId, text, options) {
  return new Promise((resolve) => {
    const seen = { submitReturn: null, init: null, result: null };
    submit(tabId, {
      text,
      options,
      onMessage: (m) => {
        if (m.type === 'system' && m.subtype === 'init' && m.session_id) seen.init = m.session_id;
      },
      onResult: (m) => { if (m.session_id) seen.result = m.session_id; },
      onExit: (payload) => resolve({ ...seen, exit: payload }),
    }).then((sid) => { seen.submitReturn = sid; });
  });
}

// Step 1: fresh session on tab-a.
const a1 = await run('tab-a', 'Reply with exactly: OK', opts());
const sid = a1.exit.sessionId;
console.log('tab-a fresh ->', JSON.stringify({ submitReturn: a1.submitReturn, init: a1.init, result: a1.result, exit: sid, error: a1.exit.error }));
const freshOk = !!sid && a1.init === sid && !a1.exit.error;
const independentOk = sessionIdFor('tab-b') === null; // never submitted -> no session leaked

// Step 2: resume sid on tab-b (fresh tab, no prior session of its own).
const a2 = await run('tab-b', 'Reply with exactly: RESUME', opts({ resume: sid }));
console.log('tab-b resume ->', JSON.stringify({ submitReturn: a2.submitReturn, init: a2.init, result: a2.result, exit: a2.exit.sessionId, error: a2.exit.error }));
const resumedOk =
  a2.submitReturn === sid &&
  a2.init === sid &&
  a2.result === sid &&
  a2.exit.sessionId === sid &&
  sessionIdFor('tab-b') === sid &&
  !a2.exit.error;

const ok = freshOk && independentOk && resumedOk;
console.log('---');
console.log(ok
  ? 'PASS: explicit resume resumes the requested session on a fresh tab; sessions stay per-tab.'
  : 'FAIL: see above');
process.exit(ok ? 0 : 1);
