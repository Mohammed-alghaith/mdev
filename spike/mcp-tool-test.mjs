#!/usr/bin/env node
// Phase 4 check: confirm the in-process MCP tools (mcp__code-generator__*) are
// registered, callable by DeepSeek through the SDK, and forward to the
// dispatcher (simulating the renderer). Uses bypassPermissions so no canUseTool
// prompt interferes — this exercises the tool round-trip directly.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { submit, setToolDispatcher } from '../electron/agent-host.mjs';

const settings = JSON.parse(readFileSync(join(homedir(), '.claude-terminal', 'settings.json'), 'utf8'));
const ds = settings.providers?.deepseek || {};
const apiKey = ds.apiKey || process.env.DEEPSEEK_KEY;
if (!apiKey) { console.error('no deepseek key'); process.exit(2); }
const baseUrl = ds.baseUrl || 'https://api.deepseek.com/anthropic';
const MODEL = 'deepseek-v4-pro';

// Simulate the renderer: record each dispatched command and return a canned
// result, exactly the shape App.jsx's control:exec handler would reply with.
const calls = [];
setToolDispatcher(async (command, args) => {
  calls.push({ command, args });
  if (command === 'open_in_editor') return { path: args.path };
  if (command === 'open_browser') return { tabId: 'browser-1', url: args.url };
  if (command === 'screenshot_browser') return { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'screenshot of tab browser-1' }] };
  throw new Error('unexpected command: ' + command);
});

const TAB = 'mcp-tool-test';
const toolUses = [];
const toolResults = [];

const result = await new Promise((resolve) => {
  submit(TAB, {
    text: 'Use the open_in_editor tool to open the file /tmp/phase4-test.txt, then reply in one sentence confirming you did it.',
    options: {
      cwd: process.cwd(),
      model: MODEL,
      env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_MODEL: MODEL },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 4,
    },
    onMessage: (msg) => {
      for (const b of (msg.message?.content || [])) {
        if (b.type === 'tool_use') toolUses.push({ name: b.name, input: b.input });
        if (b.type === 'tool_result') toolResults.push({ is_error: b.is_error, content: b.content });
      }
    },
    onResult: () => {},
    onExit: (payload) => resolve({ label: payload.error ? 'error' : 'exit', error: payload.error, sessionId: payload.sessionId }),
  });
});

console.log('exit:', result.label, result.error ? 'ERR ' + result.error : 'ok');
console.log('tool_use:', JSON.stringify(toolUses.map((t) => t.name)));
console.log('dispatcher calls:', JSON.stringify(calls.map((c) => c.command)));
console.log('tool_result:', JSON.stringify(toolResults));

const usedTool = toolUses.some((t) => t.name === 'mcp__code-generator__open_in_editor');
const dispatched = calls.some((c) => c.command === 'open_in_editor' && c.args?.path === '/tmp/phase4-test.txt');
const gotResult = toolResults.length > 0 && !toolResults[0].is_error;

const ok = usedTool && dispatched && gotResult && !result.error;
console.log('---');
console.log(ok ? 'PASS: in-process MCP tool registered, called, dispatched, and returned a result.' : 'FAIL: see above');
process.exit(ok ? 0 : 1);
