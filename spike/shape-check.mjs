#!/usr/bin/env node
// Phase 2 shape check: confirm the runtime field names the AgentView renderer
// relies on — thinking blocks, Write/Edit tool_use input, tool_result content,
// result text — match what DeepSeek actually emits through the SDK.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const settings = JSON.parse(readFileSync(join(homedir(), '.claude-terminal', 'settings.json'), 'utf8'));
const ds = settings.providers?.deepseek || {};
const apiKey = ds.apiKey || process.env.DEEPSEEK_KEY;
if (!apiKey) { console.error('no deepseek key'); process.exit(2); }
const baseUrl = ds.baseUrl || 'https://api.deepseek.com/anthropic';
const MODEL = 'deepseek-v4-pro';

const q = query({
  prompt: 'Create a file /tmp/phase2-shape-check.md with a short markdown doc: a heading "## Test" and a bullet list of two items. Then reply in one sentence confirming the file path.',
  options: {
    cwd: process.cwd(),
    model: MODEL,
    env: { ...process.env, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_MODEL: MODEL },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: 6,
  },
});

let thinking = 0, toolUse = 0, toolResult = 0;
for await (const m of q) {
  if (m.type === 'assistant') {
    for (const b of (m.message?.content || [])) {
      if (b.type === 'thinking') {
        thinking++;
        console.log('[thinking] field present:', typeof b.thinking === 'string', '| len', (b.thinking || '').length);
      }
      if (b.type === 'tool_use') {
        toolUse++;
        console.log('[tool_use]', b.name, '| input keys:', Object.keys(b.input || {}).join(','));
        if (b.name === 'Write' || b.name === 'Edit') {
          console.log('   file_path:', JSON.stringify(b.input?.file_path),
            '| content len:', (b.input?.content || '').length,
            '| old_string:', b.input?.old_string != null, '| new_string:', b.input?.new_string != null);
        }
      }
    }
  }
  if (m.type === 'user') {
    for (const b of (m.message?.content || [])) {
      if (b.type === 'tool_result') {
        toolResult++;
        console.log('[tool_result] is_error:', b.is_error, '| content:', typeof b.content, Array.isArray(b.content) ? 'array(' + b.content.length + ')' : '');
      }
    }
  }
  if (m.type === 'result') {
    console.log('[result]', m.subtype, '| result:', JSON.stringify(m.result).slice(0, 140));
  }
}
console.log('---');
console.log('thinking blocks:', thinking, '| tool_use:', toolUse, '| tool_result:', toolResult);
