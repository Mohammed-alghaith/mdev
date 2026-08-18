import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Native agent message view. Accumulated SDK messages render as structured
// React components — markdown text, collapsible thinking panes, tool cards with
// diff views for file edits, and a turn status line. No ANSI, no TUI.

// ─── small helpers ─────────────────────────────────────────────────────────

function prettyJson(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function oneLine(s) {
  return (s || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function salientArg(name, input) {
  const i = (input && typeof input === 'object') ? input : {};
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return i.file_path || '';
    case 'Bash': return typeof i.command === 'string' ? i.command : '';
    case 'Glob':
    case 'Grep': return i.pattern || '';
    case 'WebFetch': return i.url || '';
    case 'WebSearch': return i.query || '';
    case 'Task': return i.description || i.prompt || '';
    default: return '';
  }
}

function toolLabel(name, input) {
  const arg = salientArg(name, input);
  if (!arg) return name;
  return name + ' ' + (arg.length > 60 ? arg.slice(0, 60) + '…' : arg);
}

// tool_result content is a string (Bash) or an array of text/image blocks.
function resultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((x) => {
      if (typeof x === 'string') return x;
      if (x && x.type === 'text') return x.text;
      if (x && (x.type === 'image' || x.type === 'image_url')) return '[image]';
      return JSON.stringify(x);
    }).join('\n');
  }
  if (c == null) return '';
  return JSON.stringify(c);
}

// ─── atoms ─────────────────────────────────────────────────────────────────

function Chevron({ open }) {
  return (
    <svg
      className={'shrink-0 transition-transform ' + (open ? 'rotate-90' : '')}
      width="10" height="10" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

const mdComponents = {
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-ink-950/70 border border-ink-700 p-3 text-xs leading-relaxed font-mono text-ink-200">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    const isBlock = /language-/.test(className || '') || String(children).includes('\n');
    if (isBlock) return <code className={className}>{children}</code>;
    return (
      <code className="bg-ink-700/60 text-accent-200 px-1.5 py-0.5 rounded text-[0.85em] font-mono">
        {children}
      </code>
    );
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent-300 hover:text-accent-200 underline underline-offset-2">
      {children}
    </a>
  ),
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 pl-5 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 pl-5 list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="text-ink-200">{children}</li>,
  h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-base font-semibold text-ink-100">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-sm font-semibold text-ink-100">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2.5 mb-1 text-sm font-semibold text-ink-100">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-ink-600 pl-3 text-ink-300">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto"><table className="border-collapse text-xs">{children}</table></div>
  ),
  th: ({ children }) => <th className="border border-ink-700 px-2 py-1 text-left font-semibold text-ink-200">{children}</th>,
  td: ({ children }) => <td className="border border-ink-700 px-2 py-1 text-ink-300">{children}</td>,
  hr: () => <hr className="my-3 border-ink-700" />,
};

function Markdown({ text }) {
  if (!text || !text.trim()) return null;
  return (
    <div className="text-sm text-ink-100 leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function ThinkingBlock({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-ink-700/60 bg-ink-900/40">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-ink-300 hover:text-ink-100 transition"
      >
        <Chevron open={open} />
        <span>Thinking</span>
      </button>
      {open && (
        <div className="px-3 pb-2.5 pt-0.5 text-xs text-ink-400 italic whitespace-pre-wrap break-words border-t border-ink-800">
          {text || '[empty]'}
        </div>
      )}
    </div>
  );
}

// Edit/Write/MultiEdit patch as a colored old/new view — red removals, green
// additions — without pulling in a diff library.
function DiffView({ name, input }) {
  const file = input.file_path || '';
  const minus = (s) => (s != null && s !== '' ? s : null);
  const line = (clr, s) => (
    <pre className={'overflow-x-auto whitespace-pre-wrap break-words font-mono ' + clr}>{s}</pre>
  );

  if (name === 'Write') {
    return (
      <div className="mt-2">
        {file && <div className="text-ink-400 font-mono">{file}</div>}
        {line('text-green-300', (input.content != null ? '+ ' + input.content : '+ (new file)'))}
      </div>
    );
  }
  if (name === 'Edit') {
    const oldS = minus(input.old_string);
    const newS = minus(input.new_string);
    return (
      <div className="mt-2 space-y-1">
        {file && <div className="text-ink-400 font-mono">{file}</div>}
        {oldS && line('text-red-300', '- ' + oldS)}
        {newS && line('text-green-300', '+ ' + newS)}
      </div>
    );
  }
  if (name === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return (
      <div className="mt-2 space-y-1">
        {file && <div className="text-ink-400 font-mono">{file}</div>}
        {edits.map((e, i) => (
          <div key={i} className="border-l-2 border-ink-700 pl-2 space-y-1">
            {minus(e.old_string) && line('text-red-300', '- ' + e.old_string)}
            {minus(e.new_string) && line('text-green-300', '+ ' + e.new_string)}
          </div>
        ))}
      </div>
    );
  }
  return <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-ink-300 font-mono">{prettyJson(input)}</pre>;
}

function ToolCall({ block }) {
  const [open, setOpen] = useState(false);
  const name = block.name || 'Tool';
  const input = block.input || {};
  const isEdit = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name);
  return (
    <div className="rounded-md border border-ink-700/60 bg-ink-900/40 overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-ink-200 hover:text-ink-100 transition"
      >
        <Chevron open={open} />
        <span className="text-accent-400">⟳</span>
        <span className="truncate font-mono">{toolLabel(name, input)}</span>
      </button>
      {open && (
        <div className="px-3 pb-2.5 pt-0.5 text-xs border-t border-ink-800">
          {isEdit ? <DiffView name={name} input={input} /> : (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-ink-300 font-mono">{prettyJson(input)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function ToolResult({ block }) {
  const [open, setOpen] = useState(false);
  const text = resultText(block);
  const isErr = !!block.is_error;
  return (
    <div className={'rounded-md border px-2.5 py-1.5 text-xs ' + (isErr ? 'border-red-500/40 bg-red-500/5' : 'border-ink-700/60 bg-ink-900/30')}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 text-ink-300 hover:text-ink-100 transition"
      >
        <Chevron open={open} />
        <span>{isErr ? '✗ tool failed' : '✓ tool result'}</span>
        {!open && <span className="truncate text-ink-400 flex-1 text-left">{oneLine(text)}</span>}
      </button>
      {open && (
        <pre className="mt-1.5 whitespace-pre-wrap break-words text-ink-300 font-mono">{text}</pre>
      )}
    </div>
  );
}

function ResultLine({ msg }) {
  const ok = msg.subtype === 'success';
  const errs = Array.isArray(msg.errors) ? msg.errors : [];
  const dur = msg.duration_ms != null ? (msg.duration_ms / 1000).toFixed(1) + 's' : null;
  const cost = msg.total_cost_usd != null ? '~$' + msg.total_cost_usd.toFixed(2) + ' est.' : null;
  return (
    <div className={'rounded-md border px-3 py-2 text-xs ' + (ok ? 'border-accent-500/30 bg-accent-500/5' : 'border-red-500/40 bg-red-500/5')}>
      <div className={'font-semibold ' + (ok ? 'text-accent-300' : 'text-red-300')}>
        {ok ? '✓ Turn complete' : '✗ ' + (msg.subtype || 'error')}
        {dur && <span className="ml-2 font-normal text-ink-400">{dur}</span>}
        {cost && <span className="ml-2 font-normal text-ink-500">{cost}</span>}
      </div>
      {!ok && errs.length ? (
        <div className="mt-1 text-red-300 whitespace-pre-wrap break-words">{errs.join('\n')}</div>
      ) : null}
    </div>
  );
}

function UserTurn({ text }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-lg bg-accent-500/15 text-accent-100 px-3 py-2 text-sm whitespace-pre-wrap break-words">
        {text}
      </div>
    </div>
  );
}

function InitLine({ msg }) {
  const tools = Array.isArray(msg.tools) ? msg.tools.length : 0;
  return (
    <div className="text-[10px] text-ink-500 text-center font-mono">
      session {String(msg.session_id || '').slice(0, 8)} · {msg.model} · {tools} tools
    </div>
  );
}

// ─── message dispatch ──────────────────────────────────────────────────────

function ContentBlock({ block }) {
  if (block.type === 'text') return <Markdown text={block.text} />;
  if (block.type === 'thinking') return block.thinking ? <ThinkingBlock text={block.thinking} /> : null;
  if (block.type === 'redacted_thinking') return <ThinkingBlock text="[thinking redacted]" />;
  if (block.type === 'tool_use') return <ToolCall block={block} />;
  return null;
}

function Message({ msg }) {
  switch (msg.type) {
    case 'user-prompt':
      return <UserTurn text={msg.text} />;
    case 'assistant':
      return (
        <div className="space-y-2">
          {(msg.message?.content || []).map((block, j) => <ContentBlock key={j} block={block} />)}
        </div>
      );
    case 'user':
      return (
        <div className="space-y-1.5">
          {(msg.message?.content || []).map((block, j) => (
            block.type === 'tool_result' ? <ToolResult key={j} block={block} /> : null
          ))}
        </div>
      );
    case 'result':
      return <ResultLine msg={msg} />;
    case 'system':
      if (msg.subtype === 'init') return <InitLine msg={msg} />;
      return null; // thinking_tokens and other system noise are hidden
    default:
      return null;
  }
}

// ─── view ──────────────────────────────────────────────────────────────────

export default function AgentView({ messages = [], running, offline = false, visible, onStop }) {
  const scrollRef = useRef(null);
  // Whether the user wants to follow new content to the bottom. Auto-scroll
  // only while following, so incoming messages don't yank the view away while
  // the user is reading up.
  const followRef = useRef(true);
  const wasRunningRef = useRef(running);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // A new turn starts → snap to the bottom once, then let the user scroll up.
  useLayoutEffect(() => {
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = running;
    if (running && !wasRunning) {
      followRef.current = true;
      scrollToBottom();
    }
  }, [running]);

  // Follow new content while the user is already at the bottom. useLayoutEffect
  // runs before paint, so each appended chunk lands already scrolled instead of
  // flashing above the fold first.
  useLayoutEffect(() => {
    if (followRef.current) scrollToBottom();
  }, [messages, running]);

  // Follow height changes that don't correspond to a new `messages` entry — an
  // expanded ThinkingBlock, markdown that reflows after mount, or any async
  // layout. Observing the real content height (not the array) also re-pins the
  // view after a stale scroll event briefly mislabeled it as "scrolled up".
  useEffect(() => {
    const el = scrollRef.current;
    const target = el?.firstElementChild;
    if (!target) return;
    const ro = new ResizeObserver(() => {
      if (followRef.current) scrollToBottom();
    });
    ro.observe(target);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div
      className={'absolute inset-0 ' + (visible ? '' : 'invisible pointer-events-none')}
      aria-hidden={!visible}
    >
      {(running || offline) && (
        <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
          {offline ? (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-red-500/20 text-red-300 text-xs ring-2 ring-red-500/50 animate-pulse">
              Offline
            </span>
          ) : (
            <span className="text-xs text-ink-400">Working…</span>
          )}
          {!offline && (
            <button
              onClick={onStop}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-red-500/20 text-red-300 text-xs hover:bg-red-500/30 transition"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="1.5" />
              </svg>
              Stop
            </button>
          )}
        </div>
      )}

      <div ref={scrollRef} onScroll={onScroll} className="absolute inset-0 overflow-y-auto selectable">
        <div className="max-w-3xl mx-auto px-4 py-4 space-y-3">
          {messages.length === 0 && !running ? (
            <div className="text-center text-ink-400 text-xs py-10">
              Submit a prompt below to start the agent.
            </div>
          ) : null}

          {messages.map((m, i) => <Message key={i} msg={m} />)}

          {offline ? (
            <div className="flex items-center gap-2 text-xs text-red-300 pt-1">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span>Offline</span>
            </div>
          ) : running ? (
            <div className="flex items-center gap-2 text-xs text-ink-400 pt-1">
              <span className="inline-block w-2 h-2 rounded-full bg-accent-400 animate-pulse" />
              <span>Working…</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
