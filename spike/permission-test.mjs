#!/usr/bin/env node
// Phase 3 check: drive agent-host.submit() against DeepSeek and confirm the
// canUseTool bridge fires, and both allow and deny decisions flow back into the
// SDK without hanging the query. Uses Write (always prompts in default mode).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { submit, resolvePermission } from '../electron/agent-host.mjs';

const settings = JSON.parse(readFileSync(join(homedir(), '.claude-terminal', 'settings.json'), 'utf8'));
const ds = settings.providers?.deepseek || {};
const apiKey = ds.apiKey || process.env.DEEPSEEK_KEY;
if (!apiKey) { console.error('no deepseek key'); process.exit(2); }
const baseUrl = ds.baseUrl || 'https://api.deepseek.com/anthropic';
const MODEL = 'deepseek-v4-pro';

function baseOptions() {
  return {
    cwd: process.cwd(),
    model: MODEL,
    env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_MODEL: MODEL },
    permissionMode: 'default',
    maxTurns: 4,
  };
}

// Run one turn. `decide(payload)` returns an SDK PermissionResult; the test
// resolves the parked request through the host's resolvePermission export,
// exactly as main.js's agent:permission:reply IPC handler would.
function run(tabId, text, options, decide) {
  return new Promise((resolve) => {
    let perms = 0;
    const toolsSeen = [];
    const done = (result) => resolve({ ...result, perms, toolsSeen });
    submit(tabId, {
      text,
      options,
      onMessage: (msg) => {
        for (const b of (msg.message?.content || [])) {
          if (b.type === 'tool_use') toolsSeen.push(b.name);
        }
      },
      onResult: () => {},
      onPermission: (payload) => {
        perms += 1;
        console.log(`  [canUseTool] ${payload.toolName} | title="${payload.title}" displayName="${payload.displayName}" requestId=${payload.requestId}`);
        resolvePermission(tabId, payload.requestId, decide(payload));
      },
      onExit: (payload) => done({ label: payload.error ? 'error' : 'exit', error: payload.error, sessionId: payload.sessionId }),
    });
  });
}

const allow = await run('perm-test-allow', 'Create a file /tmp/perm-test-allow.txt containing exactly: hello',
  baseOptions(), () => ({ behavior: 'allow' }));
console.log('ALLOW →', allow.label, '| tools:', allow.toolsSeen.join(',') || '(none)', '| perms fired:', allow.perms, '|', allow.error ? 'ERR ' + allow.error : 'ok');

const deny = await run('perm-test-deny', 'Create a file /tmp/perm-test-deny.txt containing exactly: hello',
  baseOptions(), () => ({ behavior: 'deny', message: 'test deny' }));
console.log('DENY  →', deny.label, '| tools:', deny.toolsSeen.join(',') || '(none)', '| perms fired:', deny.perms, '|', deny.error ? 'ERR ' + deny.error : 'ok');

const ok = allow.perms >= 1 && deny.perms >= 1 && !allow.error;
console.log('---');
console.log(ok ? 'PASS: canUseTool fired for both allow and deny, neither hung.' : 'FAIL: see above');
process.exit(ok ? 0 : 1);
