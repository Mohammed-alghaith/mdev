#!/usr/bin/env node
// Phase 1 verification: exercise the real production code path — the agent
// host in electron/agent-host.mjs — against DeepSeek, with a Bash tool
// round-trip. This tests submit() → message stream → result → exit, i.e. the
// exact bridge the renderer drives over IPC. No secret is hardcoded.
//
//   node spike/host-test.mjs

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { submit } from '../electron/agent-host.mjs';

const SETTINGS = join(homedir(), '.claude-terminal', 'settings.json');
const settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
const deepseek = settings.providers?.deepseek || {};
const apiKey = deepseek.apiKey || process.env.DEEPSEEK_KEY || '';
const baseUrl = deepseek.baseUrl || 'https://api.deepseek.com/anthropic';
const MODEL = 'deepseek-v4-pro';

if (!apiKey) {
  console.error('No DeepSeek API key found in', SETTINGS, 'or DEEPSEEK_KEY env.');
  process.exit(2);
}

const tabId = 'host-test-' + Date.now();
let result = null;
let sawInit = false;
let sawBash = false;
let exitPayload = null;

console.log('agent-host.submit() test against DeepSeek');
console.log('  tabId:', tabId);
console.log('  key:   set (len ' + apiKey.length + ')');
console.log('---');

const resumedSessionId = await submit(tabId, {
  text: 'Run `echo phase1-ok` with the Bash tool, then reply with exactly the tool output.',
  options: {
    cwd: process.cwd(),
    model: MODEL,
    permissionMode: 'default',
    maxTurns: 5,
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: MODEL,
    },
  },
  onMessage: (msg) => {
    if (msg.type === 'system' && msg.subtype === 'init') {
      sawInit = true;
      console.log('[system/init] session_id=', msg.session_id);
    } else if (msg.type === 'assistant') {
      for (const b of msg.message?.content || []) {
        if (b.type === 'tool_use') {
          if (b.name === 'Bash') sawBash = true;
          console.log('[tool_use]', b.name);
        }
      }
    }
  },
  onResult: (msg) => { result = msg; },
  onExit: (payload) => { exitPayload = payload; },
});

console.log('  submit() returned resumedSessionId =', resumedSessionId, '(expected null for fresh tab)');
console.log('---');

// submit() returns before the query loop finishes; poll for completion.
const deadline = Date.now() + 120000;
while (!result && !exitPayload && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 250));
}

console.log('---');
if (!result) {
  console.error('FAIL: timed out — no result message');
  console.error('exitPayload:', JSON.stringify(exitPayload));
  process.exit(1);
}

console.log('sawInit:', sawInit, '| sawBashToolUse:', sawBash);
console.log('result.subtype:', result.subtype);
console.log('result.text:', JSON.stringify(result.result).slice(0, 400));
console.log('exit.error:', exitPayload?.error || null);

const pass = sawInit && sawBash && result.subtype === 'success' && !exitPayload?.error;
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
