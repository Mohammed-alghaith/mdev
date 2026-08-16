#!/usr/bin/env node
// Does `query({ options: { resume } })` re-emit the prior conversation as
// messages (so a resume tab would double-render if we also pre-load history),
// or only stream the new turn? Logs the message type sequence to find out.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { submit } from '../electron/agent-host.mjs';

const settings = JSON.parse(readFileSync(join(homedir(), '.claude-terminal', 'settings.json'), 'utf8'));
const ds = settings.providers?.deepseek || {};
const apiKey = ds.apiKey || process.env.DEEPSEEK_KEY;
if (!apiKey) { console.error('no deepseek key'); process.exit(2); }
const baseUrl = ds.baseUrl || 'https://api.deepseek.com/anthropic';
const MODEL = 'deepseek-v4-pro';

const env = { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_MODEL: MODEL };
const SID = '83f0408a-0152-4365-857a-dbba08dea1df';

const snippet = (m) => {
  const c = m?.message?.content;
  if (!Array.isArray(c)) return '';
  return c.map((b) => {
    if (b.type === 'text') return 'text:' + (b.text || '').slice(0, 40);
    if (b.type === 'thinking') return 'thinking';
    if (b.type === 'tool_use') return 'tool_use:' + b.name;
    if (b.type === 'tool_result') return 'tool_result';
    return b.type;
  }).join(' | ');
};

const seq = [];
await new Promise((resolve) => {
  submit('replay-tab', {
    text: 'Reply with exactly: REPLAY',
    options: {
      cwd: process.cwd(),
      model: MODEL,
      env,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 3,
      resume: SID,
    },
    onMessage: (m) => {
      const tag = m.type + (m.subtype ? '/' + m.subtype : '');
      seq.push(tag + ' :: ' + snippet(m));
    },
    onResult: (m) => seq.push('result/' + (m.subtype || '') + ' sid=' + (m.session_id || '').slice(0, 8)),
    onExit: () => resolve(),
  });
});

console.log('--- message sequence (resume SID ' + SID.slice(0, 8) + ') ---');
seq.forEach((s, i) => console.log(String(i).padStart(2), s));
console.log('---');
const replayed = seq.some((s) => /user|assistant/.test(s) && /text:Reply with exactly: (OK|RESUME)/.test(s));
console.log(replayed ? 'REPLAYED prior history' : 'ONLY new turn streamed');
