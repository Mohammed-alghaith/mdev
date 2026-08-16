import React, { useEffect, useState } from 'react';

// Approval modal for tool-permission requests bridged from the SDK's canUseTool.
// Two shapes:
//   - AskUserQuestion (toolName === 'AskUserQuestion') → renders the questions
//     as a form and answers with { behavior:'allow', updatedInput:{...input, answers} }.
//   - any other tool → a compact "Claude wants to <action>" card with the tool
//     input (diff view for edits, pretty JSON otherwise) and Allow / Deny.
//
// The parent (App.jsx) owns the pending-permission queue and passes the head as
// `request` plus an `onRespond(decision)` callback that replies over IPC and
// pops the queue.

function prettyJson(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
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

function minus(s) {
  return (s != null && s !== '') ? s : null;
}

// Compact red/green old-new view for file edits (mirrors AgentView's DiffView).
function EditPreview({ name, input }) {
  const file = input.file_path || '';
  const line = (clr, s) => (
    <pre className={'overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed ' + clr}>{s}</pre>
  );
  if (name === 'Write') {
    return (
      <div className="mt-2">
        {file && <div className="text-ink-400 font-mono text-[11px] mb-1">{file}</div>}
        {line('text-green-300', (input.content != null ? '+ ' + input.content : '+ (new file)'))}
      </div>
    );
  }
  if (name === 'Edit') {
    return (
      <div className="mt-2 space-y-1">
        {file && <div className="text-ink-400 font-mono text-[11px] mb-1">{file}</div>}
        {minus(input.old_string) && line('text-red-300', '- ' + input.old_string)}
        {minus(input.new_string) && line('text-green-300', '+ ' + input.new_string)}
      </div>
    );
  }
  if (name === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return (
      <div className="mt-2 space-y-1">
        {file && <div className="text-ink-400 font-mono text-[11px] mb-1">{file}</div>}
        {edits.map((e, i) => (
          <div key={i} className="border-l-2 border-ink-700 pl-2 space-y-1">
            {minus(e.old_string) && line('text-red-300', '- ' + e.old_string)}
            {minus(e.new_string) && line('text-green-300', '+ ' + e.new_string)}
          </div>
        ))}
      </div>
    );
  }
  return <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-ink-300 font-mono text-[11px]">{prettyJson(input)}</pre>;
}

function ToolBody({ name, input }) {
  const arg = salientArg(name, input);
  const isEdit = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name);
  return (
    <div className="mt-1 rounded-md border border-ink-700/60 bg-ink-900/40 p-2 max-h-64 overflow-y-auto">
      {arg && name !== 'Bash' && (
        <div className="text-ink-300 font-mono text-[11px] mb-1 break-words">{arg}</div>
      )}
      {isEdit ? <EditPreview name={name} input={input} /> : (
        <pre className="whitespace-pre-wrap break-words text-ink-300 font-mono text-[11px] leading-relaxed">{prettyJson(input)}</pre>
      )}
    </div>
  );
}

function AskQuestionForm({ questions, onSubmit }) {
  const [selected, setSelected] = useState(() => {
    const init = {};
    (questions || []).forEach((_q, i) => { init[i] = null; });
    return init;
  });

  const toggle = (qi, label, multi) => {
    setSelected((s) => {
      if (multi) {
        const cur = Array.isArray(s[qi]) ? s[qi] : [];
        const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
        return { ...s, [qi]: next };
      }
      return { ...s, [qi]: label };
    });
  };

  const complete = (questions || []).every((q, i) => {
    const v = selected[i];
    return q.multiSelect ? (Array.isArray(v) && v.length > 0) : !!v;
  });

  const submit = () => {
    const answers = {};
    (questions || []).forEach((q, i) => {
      const v = selected[i];
      answers[q.question] = Array.isArray(v) ? v.join(',') : (v || '');
    });
    onSubmit(answers);
  };

  return (
    <div className="space-y-4">
      {(questions || []).map((q, qi) => (
        <div key={qi}>
          <div className="flex items-center gap-2 mb-1.5">
            {q.header && (
              <span className="text-[10px] uppercase tracking-wide text-accent-400 font-semibold px-1.5 py-0.5 rounded bg-accent-500/10">{q.header}</span>
            )}
            <span className="text-xs text-ink-200 font-medium leading-snug">{q.question}</span>
          </div>
          <div className="space-y-1">
            {(q.options || []).map((opt) => {
              const isOn = q.multiSelect
                ? (Array.isArray(selected[qi]) && selected[qi].includes(opt.label))
                : selected[qi] === opt.label;
              return (
                <button
                  key={opt.label}
                  onClick={() => toggle(qi, opt.label, q.multiSelect)}
                  className={'w-full text-left flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs transition ' +
                    (isOn ? 'border-accent-500/60 bg-accent-500/10' : 'border-ink-700 bg-ink-900/40 hover:border-ink-600')}
                >
                  <span className={'mt-0.5 shrink-0 inline-flex items-center justify-center w-4 h-4 rounded border ' +
                    (isOn ? 'bg-accent-500 border-accent-500 text-accent-fg' : 'border-ink-500')}>
                    {isOn && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium text-ink-100">{opt.label}</span>
                    {opt.description && <span className="block text-ink-400 mt-0.5">{opt.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={() => onSubmit(null)}
          className="px-3 py-1.5 rounded-md bg-ink-700 text-ink-200 text-xs hover:bg-ink-600 transition"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!complete}
          className={'px-3 py-1.5 rounded-md text-xs transition ' +
            (complete ? 'bg-accent-500 text-accent-fg hover:bg-accent-400' : 'bg-ink-700 text-ink-500 cursor-not-allowed')}
        >
          Submit
        </button>
      </div>
    </div>
  );
}

export default function PermissionDialog({ request, onRespond }) {
  // Escape denies (and stops the app's global Escape-from-focusing-promptbar).
  useEffect(() => {
    if (!request) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onRespond({ behavior: 'deny', message: 'Cancelled' });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [request, onRespond]);

  if (!request) return null;

  const isQuestion = request.toolName === 'AskUserQuestion';
  const name = request.toolName || 'Tool';
  const title = request.title || request.displayName || name;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative w-full max-w-md mx-4 rounded-lg border border-ink-700 bg-ink-900 shadow-xl">
        <div className="px-4 py-3 border-b border-ink-700 flex items-start gap-2.5">
          <span className="mt-0.5 shrink-0 text-accent-400">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink-100">{isQuestion ? 'Claude has a question' : title}</div>
            {request.description && <div className="text-xs text-ink-400 mt-0.5">{request.description}</div>}
            {request.decisionReason && <div className="text-[11px] text-ink-500 mt-0.5">{request.decisionReason}</div>}
            {request.blockedPath && (
              <div className="text-[11px] text-red-400/80 mt-0.5 font-mono break-all">blocked: {request.blockedPath}</div>
            )}
          </div>
        </div>

        <div className="px-4 py-3">
          {isQuestion ? (
            <AskQuestionForm
              questions={request.input?.questions || []}
              onSubmit={(answers) => {
                if (answers == null) {
                  onRespond({ behavior: 'deny', message: 'Cancelled' });
                } else {
                  onRespond({ behavior: 'allow', updatedInput: { ...(request.input || {}), answers } });
                }
              }}
            />
          ) : (
            <>
              <ToolBody name={name} input={request.input || {}} />
              <div className="flex justify-end gap-2 pt-3">
                <button
                  onClick={() => onRespond({ behavior: 'deny', message: 'Denied by user' })}
                  className="px-3 py-1.5 rounded-md bg-ink-700 text-ink-200 text-xs hover:bg-ink-600 transition"
                >
                  Deny
                </button>
                <button
                  onClick={() => onRespond({ behavior: 'allow' })}
                  className="px-3 py-1.5 rounded-md bg-accent-500 text-accent-fg text-xs hover:bg-accent-400 transition"
                >
                  Allow
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
