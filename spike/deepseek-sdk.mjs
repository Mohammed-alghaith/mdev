#!/usr/bin/env node
// Phase 0 spike: drive the Claude Agent SDK against the DeepSeek
// Anthropic-compatible endpoint and confirm it works before building UI.
//
// Reads the DeepSeek key from the app's settings (~/.claude-terminal/settings.json)
// so no secret is hardcoded here. Usage:
//   node spike/deepseek-sdk.mjs            # faithful env setup (matches the app)
//   node spike/deepseek-sdk.mjs --compat   # add the two compatibility flags
//   node spike/deepseek-sdk.mjs --tool     # also exercise a read-only tool round-trip
//   node spike/deepseek-sdk.mjs --compat --tool

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const args = new Set(process.argv.slice(2));
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

// Faithful to the app: env vars redirect the SDK-spawned CLI to DeepSeek.
const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: baseUrl,
  ANTHROPIC_AUTH_TOKEN: apiKey,
  ANTHROPIC_MODEL: MODEL,
};
if (args.has('--compat')) {
  // Non-Anthropic endpoints can reject Claude-specific fields (thinking/betas).
  env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = '1';
  env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
}

const prompt = args.has('--tool')
  ? 'List the current directory with the Bash tool, then tell me the name of the first file listed.'
  : 'Reply with exactly: OK';

console.log('Claude Agent SDK spike against DeepSeek');
console.log('  baseUrl:', baseUrl);
console.log('  model:  ', MODEL);
console.log('  key:    set (len ' + apiKey.length + ')');
console.log('  compat: ', args.has('--compat') ? 'on' : 'off');
console.log('  tool:   ', args.has('--tool') ? 'on' : 'off');
console.log('  prompt: ', JSON.stringify(prompt));
console.log('---');

const q = query({
  prompt,
  options: {
    model: MODEL,
    cwd: process.cwd(),
    env,
    permissionMode: 'default',
    maxTurns: 5,
  },
});

let sawTool = false;
try {
  for await (const m of q) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          console.log('[system/init] session_id=', m.session_id, 'tools=', (m.tools || []).length);
        } else {
          console.log('[system]', m.subtype);
        }
        break;
      case 'assistant': {
        const blocks = m.message?.content || [];
        console.log('[assistant]', blocks.map((b) => {
          if (b.type === 'text') return 'text(' + b.text.slice(0, 60).replace(/\n/g, ' ') + ')';
          if (b.type === 'tool_use') { sawTool = true; return 'tool_use(' + b.name + ')'; }
          return b.type;
        }).join(', '));
        break;
      }
      case 'user': {
        const blocks = m.message?.content || [];
        console.log('[user]', blocks.map((b) =>
          b.type === 'tool_result' ? 'tool_result(' + (b.is_error ? 'err' : 'ok') + ')' : b.type
        ).join(', '));
        break;
      }
      case 'result':
        console.log('[result] subtype=', m.subtype);
        console.log('[result] text=', JSON.stringify(m.result));
        console.log('[result] cost_usd=', m.total_cost_usd, 'usage=', JSON.stringify(m.usage));
        console.log('[result] session_id=', m.session_id, 'num_turns=', m.num_turns);
        break;
      default:
        console.log('[?]', m.type);
    }
  }
  console.log('---');
  console.log('SUCCESS: query completed');
  console.log(sawTool ? 'tool round-trip: exercised' : 'tool round-trip: not requested');
} catch (err) {
  console.error('---');
  console.error('FAILED:', err?.message || err);
  if (err?.stack) console.error(err.stack.split('\n').slice(0, 6).join('\n'));
  console.error('---');
  console.error('If this is a 400/field error, retry with: node spike/deepseek-sdk.mjs --compat');
  process.exit(1);
}
