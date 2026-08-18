import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, useCallback } from 'react';
import { useSpeech } from '../hooks/useSpeech.js';
import { EFFORTS, FALLBACK_MODEL_GROUPS, buildModelGroups, contextCeiling } from '../modelGroups.js';

const MODES = [
  { id: 'ask', label: 'Ask', desc: 'Read-only chat. Edit/Write/Bash are denied at the tool layer; the agent can only read, search, and answer.' },
  { id: 'plan', label: 'Plan', desc: 'Planning mode where supported.' },
  { id: 'act', label: 'Act', desc: 'Auto-accepts file edits ONLY. Every Bash command still prompts.' },
  { id: 'safe', label: 'Safe', desc: 'Auto-accepts edits + a curated allowlist of project-scoped Bash (git, npm, ls, mkdir, cp, mv, etc.). Anything outside the allowlist (rm, sudo, curl, ssh, brew/apt, chmod…) still prompts.' },
  { id: 'auto', label: 'Auto', desc: '--dangerously-skip-permissions — skips every permission check (YOLO). No confirm dialog.' },
];

function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + 'K';
  if (n < 1_000_000) return Math.round(n / 1000) + 'K';
  return (n / 1_000_000).toFixed(2) + 'M';
}

const PromptBar = forwardRef(function PromptBar({
  value,
  onChange,
  onSubmit,
  onLaunchClaude,
  mode = 'ask',
  onModeChange,
  model = '',
  onModelChange,
  contextUsage = null,
  claudeActive = false,
  agentRunning = false,
  onStop,
  onRestartTab,
  launchedModel = '',
  providerModels = [],
  offline = false,
  completionConfig = null,
}, ref) {
  const textareaRef = useRef(null);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }), []);
  const [interim, setInterim] = useState('');
  const baseTextRef = useRef('');
  // Inline ghost-text autofill state. `suggestion` is the grey continuation;
  // `suggestionBaseRef` records the input it was computed for so we only show
  // it while the text is unchanged; `suggestionSeqRef` discards stale responses.
  const [suggestion, setSuggestion] = useState('');
  const suggestionBaseRef = useRef('');
  const suggestionSeqRef = useRef(0);

  // Model list, fetched once from the Anthropic Models API via the main process
  // so new releases appear automatically. Falls back to the hardcoded list until
  // (or unless) the fetch succeeds.
  const [modelGroups, setModelGroups] = useState(FALLBACK_MODEL_GROUPS);
  useEffect(() => {
    let alive = true;
    window.api?.claude?.listModels?.()
      .then((models) => { if (alive) setModelGroups(buildModelGroups(models)); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Merge provider models from settings (e.g. DeepSeek) into the dropdown.
  const allModelGroups = useMemo(() => {
    if (!providerModels?.length) return modelGroups;
    const seen = new Set(modelGroups.map((g) => g.base));
    return [...modelGroups, ...providerModels.filter((m) => !seen.has(m.base))];
  }, [modelGroups, providerModels]);

  const handleFinal = useCallback((text) => {
    const merged = (baseTextRef.current + ' ' + text).trim();
    baseTextRef.current = merged;
    onChange(merged);
    setInterim('');
  }, [onChange]);

  const handleInterim = useCallback((text) => {
    setInterim(text);
  }, []);

  const speech = useSpeech({ onFinal: handleFinal, onInterim: handleInterim });

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  }, [value, interim]);

  // Debounced ghost-text completion. Clears any prior suggestion on input, then
  // after a short idle asks the main process for a continuation of the prompt.
  useEffect(() => {
    setSuggestion('');
    if (!completionConfig) return;
    const text = value || '';
    if (!text.trim()) return;
    const seq = ++suggestionSeqRef.current;
    const timer = setTimeout(async () => {
      try {
        const res = await window.api?.complete?.({ ...completionConfig, text });
        if (!res?.ok || seq !== suggestionSeqRef.current) return;
        const completion = String(res.completion || '').trim();
        if (!completion || completion === text) return;
        suggestionBaseRef.current = text;
        setSuggestion(completion);
      } catch {}
    }, 350);
    return () => clearTimeout(timer);
  }, [value, completionConfig]);

  const onKeyDown = (e) => {
    const hasSuggestion = suggestion && suggestionBaseRef.current === value;
    if (e.key === 'Tab' && hasSuggestion) {
      e.preventDefault();
      onChange(value + suggestion);
      setSuggestion('');
      return;
    }
    if (e.key === 'Escape' && suggestion) {
      e.preventDefault();
      setSuggestion('');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const text = (value || '').trim();
      if (text.length === 0) return;
      setSuggestion('');
      onSubmit(text);
    }
  };

  const toggleMic = () => {
    if (!speech.supported) return;
    if (speech.listening) {
      speech.stop();
    } else {
      baseTextRef.current = value || '';
      setInterim('');
      speech.start();
    }
  };

  const displayValue = speech.listening && interim
    ? (baseTextRef.current ? baseTextRef.current + ' ' : '') + interim
    : value;

  return (
    <div className="px-4 pb-4 pt-2 bg-ink-900 border-t border-ink-700">
      <div className="flex items-end gap-2 bg-ink-800 border border-ink-700 rounded-2xl px-3 py-2 focus-within:border-accent-500 transition shadow-soft">
        <button
          type="button"
          onClick={onLaunchClaude}
          title="Launch selected agent in active tab"
          className="shrink-0 flex items-center justify-center w-9 h-9 rounded-full bg-ink-700 hover:bg-ink-600 text-accent-400 transition"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </button>

        <div className="relative flex-1 min-w-0">
          <textarea
            ref={textareaRef}
            value={displayValue}
            onChange={(e) => {
              if (speech.listening) speech.stop();
              baseTextRef.current = e.target.value;
              onChange(e.target.value);
            }}
            onKeyDown={onKeyDown}
            rows={1}
            spellCheck
            placeholder={speech.listening ? 'Listening… speak now' : 'Type a prompt — Enter to send, Shift+Enter for newline'}
            className="w-full resize-none bg-transparent outline-none text-sm text-ink-100 placeholder-ink-300 leading-relaxed max-h-60 selectable"
          />
          {!speech.listening && suggestion && suggestionBaseRef.current === value && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 text-sm leading-relaxed whitespace-pre-wrap break-words overflow-hidden text-ink-400 select-none"
            >
              <span className="text-transparent">{value}</span>{suggestion}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={toggleMic}
          disabled={!speech.supported}
          title={speech.supported ? (speech.listening ? 'Stop dictation' : 'Voice input') : 'Speech recognition not supported in this build'}
          className={
            'shrink-0 flex items-center justify-center w-9 h-9 rounded-full transition ' +
            (speech.listening
              ? 'bg-red-500/20 text-red-300 ring-2 ring-red-500/50 animate-pulse'
              : 'bg-ink-700 hover:bg-ink-600 text-ink-200 disabled:opacity-30')
          }
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => {
            if (agentRunning) { onStop?.(); return; }
            const text = (value || '').trim();
            if (text) onSubmit(text);
          }}
          title={agentRunning ? 'Stop (Ctrl+C)' : 'Send (Enter)'}
          className={
            'shrink-0 flex items-center justify-center w-9 h-9 rounded-full transition text-accent-fg ' +
            (agentRunning ? 'bg-red-500 hover:bg-red-400' : 'bg-accent-500 hover:bg-accent-400')
          }
        >
          {agentRunning ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <rect x="6" y="6" width="12" height="12" rx="1.5" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          )}
        </button>
      </div>
      <div className="mt-1.5 px-2 text-[10px] text-ink-300 flex items-center justify-between gap-3 flex-wrap">
        {offline && (
          <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 ring-1 ring-red-500/50 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            Offline
          </span>
        )}
        <span className="shrink-0">
          <kbd className="px-1 py-0.5 rounded bg-ink-700 text-ink-200">Enter</kbd> send
          <span className="mx-1.5">·</span>
          <kbd className="px-1 py-0.5 rounded bg-ink-700 text-ink-200">Shift+Enter</kbd> newline
        </span>

        {claudeActive && (() => {
          // Until the first assistant reply lands in the transcript, usage is
          // null — show an empty bar at 0K so users see the indicator exists
          // and watch it tick up after each turn.
          const tokens = contextUsage?.tokens || 0;
          const ceiling = contextCeiling(model, tokens, allModelGroups);
          const pct = Math.min(100, Math.round((tokens / ceiling) * 100));
          // Green up to 60%, yellow up to 85%, red after — colours match the
          // mental model that hitting context limit truncates older turns.
          let barCls = 'bg-accent-500';
          let textCls = 'text-ink-200';
          if (pct >= 85) { barCls = 'bg-red-500'; textCls = 'text-red-300'; }
          else if (pct >= 60) { barCls = 'bg-amber-400'; textCls = 'text-amber-200'; }
          const ceilingLabel = ceiling >= 1_000_000 ? '1M' : '200K';
          const tooltip = contextUsage
            ? 'Context window usage for the active Claude session.\n' +
              'input: ' + fmtTokens(contextUsage.input || 0) + '\n' +
              'cache create: ' + fmtTokens(contextUsage.cacheCreate || 0) + '\n' +
              'cache read: ' + fmtTokens(contextUsage.cacheRead || 0) + '\n' +
              'last output: ' + fmtTokens(contextUsage.output || 0) + '\n' +
              'total: ' + tokens.toLocaleString() + ' / ~' + ceilingLabel
            : 'No transcript entries yet — counter updates after Claude responds to the first prompt.';
          return (
            <span className="shrink-0 inline-flex items-center gap-1.5" title={tooltip}>
              <span className="text-ink-300">ctx</span>
              <span className={textCls + ' font-mono tabular-nums'}>
                {fmtTokens(tokens)}
                <span className="text-ink-400"> / {ceilingLabel}</span>
              </span>
              <span className="relative inline-block w-16 h-1 rounded-full bg-ink-700 overflow-hidden">
                <span
                  className={'absolute inset-y-0 left-0 ' + barCls + ' transition-[width] duration-300'}
                  style={{ width: pct + '%' }}
                />
              </span>
              <span className={textCls + ' tabular-nums w-7 text-right'}>{pct}%</span>
            </span>
          );
        })()}

        <div className="flex items-center gap-2 ml-auto shrink-0">
          <div
            className="inline-flex rounded-md overflow-hidden border border-ink-700 text-[10px]"
            title="Mode applied when launching the selected agent (▶ button, new session, or resume)"
          >
            {MODES.map((m) => {
              const selected = mode === m.id;
              const danger = m.id === 'auto';
              const selClass = danger
                ? 'bg-red-500/90 text-white font-semibold'
                : 'bg-accent-500 text-accent-fg font-semibold';
              return (
                <button
                  key={m.id}
                  onClick={() => onModeChange?.(m.id)}
                  title={m.desc}
                  className={
                    'px-2 py-0.5 transition ' +
                    (selected
                      ? selClass
                      : (danger
                          ? 'bg-ink-800 hover:bg-red-500/30 text-ink-300 hover:text-red-300'
                          : 'bg-ink-800 hover:bg-ink-700 text-ink-300 hover:text-ink-100'))
                  }
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          <div className="inline-flex items-center gap-1">
            {claudeActive && launchedModel !== undefined ? (
              <span
                className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0 shadow-[0_0_6px_rgba(52,211,153,0.6)]"
                title={launchedModel ? 'Running: ' + launchedModel : 'Running with default model'}
              />
            ) : null}
            <select
              value={model}
              onChange={(e) => onModelChange?.(e.target.value)}
              title="Model + effort level applied on next launch. Effort tunes reasoning depth where supported."
              className="text-[10px] bg-ink-800 text-ink-200 rounded-md px-1.5 py-0.5 border border-ink-700 hover:border-ink-600 focus:outline-none focus:border-accent-500 transition max-w-[14rem]"
            >

            <option value="">Default model</option>
            {allModelGroups.map((g) => (
              g.effort ? (
                <optgroup key={g.base} label={g.label}>
                  <option value={g.base}>{g.label} · default effort</option>
                  {(g.efforts || EFFORTS).map((e) => (
                    <option key={e} value={g.base + ':' + e}>{g.label} · {e}</option>
                  ))}
                </optgroup>
              ) : (
                <option key={g.base} value={g.base}>{g.label}</option>
              )
            ))}
            </select>
          </div>
        </div>

        {speech.error && <span className="text-red-400 w-full text-right">mic: {speech.error}</span>}
      </div>
    </div>
  );
});

export default PromptBar;
