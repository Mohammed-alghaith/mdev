import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';

const MODES = [
  { id: 'ask', label: 'Ask' },
  { id: 'plan', label: 'Plan' },
  { id: 'act', label: 'Act' },
  { id: 'safe', label: 'Safe' },
  { id: 'auto', label: 'Auto' },
];

function modelBase(model) {
  return String(model || '').split(':')[0];
}

export default function CommandPalette({
  open,
  onClose,
  model = '',
  mode = '',
  modelGroups = [],
  onSelectModel,
  onSelectMode,
  onNewSession,
  onNewWorkspace,
  onRestartTab,
  onToggleSidebar,
  onToggleFiles,
  onOpenSettings,
  hasActiveTerminal = false,
}) {
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);

  // Build command list dynamically based on available models / state.
  const allCommands = useMemo(() => {
    const cmds = [];

    // Model switching
    const base = modelBase(model);
    for (const g of modelGroups) {
      const isCurrent = g.base === base || (g.base === base + '[1m]');
      cmds.push({
        id: 'model:' + g.base,
        group: 'Model',
        label: g.label,
        detail: isCurrent ? 'current' : '',
        action: () => onSelectModel?.(g.base),
      });
      // Effort sub-options for models that support it.
      if (g.effort) {
        for (const e of (g.efforts || ['low', 'medium', 'high', 'xhigh', 'max'])) {
          const val = g.base + ':' + e;
          cmds.push({
            id: 'model:' + val,
            group: 'Model',
            label: g.label + ' · ' + e,
            detail: model === val ? 'current' : '',
            action: () => onSelectModel?.(val),
          });
        }
      }
    }

    // Mode switching
    for (const m of MODES) {
      cmds.push({
        id: 'mode:' + m.id,
        group: 'Mode',
        label: 'Switch to ' + m.label + ' mode',
        detail: mode === m.id ? 'current' : '',
        action: () => onSelectMode?.(m.id),
      });
    }

    // Actions
    if (hasActiveTerminal) {
      cmds.push({
        id: 'restart-tab',
        group: 'Session',
        label: 'Restart session in current tab',
        detail: '⌘N',
        action: () => onRestartTab?.(),
      });
    }
    cmds.push(
      {
        id: 'new-session',
        group: 'Session',
        label: 'New session in current project',
        detail: '',
        action: () => onNewSession?.(),
      },
      {
        id: 'new-workspace',
        group: 'Session',
        label: 'New workspace…',
        detail: '',
        action: () => onNewWorkspace?.(),
      },
      {
        id: 'toggle-sidebar',
        group: 'View',
        label: 'Toggle sidebar',
        detail: '',
        action: () => onToggleSidebar?.(),
      },
      {
        id: 'toggle-files',
        group: 'View',
        label: 'Toggle file manager',
        detail: '',
        action: () => onToggleFiles?.(),
      },
      {
        id: 'settings',
        group: 'View',
        label: 'Open settings',
        detail: '',
        action: () => onOpenSettings?.(),
      },
    );

    return cmds;
  }, [modelGroups, model, mode, hasActiveTerminal, onSelectModel, onSelectMode, onNewSession, onNewWorkspace, onRestartTab, onToggleSidebar, onToggleFiles, onOpenSettings]);

  const filtered = useMemo(() => {
    if (!query.trim()) return allCommands;
    const q = query.toLowerCase();
    return allCommands.filter((c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
  }, [allCommands, query]);

  // Reset state when opening.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      // Focus after a tick so the modal is painted.
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Scroll active item into view.
  useEffect(() => {
    const el = listRef.current?.children[activeIdx];
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIdx]);

  const execute = useCallback((idx) => {
    const cmd = filtered[idx];
    if (!cmd) return;
    onClose();
    setTimeout(() => cmd.action(), 50);
  }, [filtered, onClose]);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, filtered.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter') { e.preventDefault(); execute(activeIdx); }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      <div className="relative w-full max-w-lg mx-4 bg-ink-800 border border-ink-700 rounded-xl shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-700">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-ink-300 shrink-0">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
            onKeyDown={onKeyDown}
            placeholder="Switch model, mode, or run a command…"
            spellCheck={false}
            className="flex-1 bg-transparent outline-none text-sm text-ink-100 placeholder-ink-300"
          />
          <kbd className="px-1.5 py-0.5 rounded bg-ink-700 text-[10px] text-ink-300 shrink-0">⌘K</kbd>
        </div>

        {/* Command list */}
        <div ref={listRef} className="max-h-72 overflow-y-auto scroll-thin py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-xs text-ink-300 text-center">No matching commands</div>
          ) : (
            (() => {
              let lastGroup = '';
              const rows = [];
              for (let i = 0; i < filtered.length; i++) {
                const cmd = filtered[i];
                // Group header
                if (cmd.group !== lastGroup) {
                  lastGroup = cmd.group;
                  rows.push(
                    <div key={'hdr-' + cmd.group} className="px-4 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-300">
                      {cmd.group}
                    </div>
                  );
                }
                const isActive = i === activeIdx;
                rows.push(
                  <button
                    key={cmd.id}
                    onMouseEnter={() => setActiveIdx(i)}
                    onMouseDown={(e) => e.preventDefault()} // prevent blur on input
                    onClick={() => execute(i)}
                    className={
                      'w-full flex items-center justify-between px-4 py-2 text-left transition text-xs ' +
                      (isActive ? 'bg-accent-500/20 text-accent-100' : 'text-ink-200 hover:bg-ink-700/50')
                    }
                  >
                    <span>{cmd.label}</span>
                    {cmd.detail && (
                      <span className="text-[10px] text-ink-300 shrink-0 ml-2">{cmd.detail}</span>
                    )}
                  </button>
                );
              }
              return rows;
            })()
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-ink-700 text-[10px] text-ink-300 flex items-center gap-3">
          <span><kbd className="px-1 py-0.5 rounded bg-ink-700">↑↓</kbd> navigate</span>
          <span><kbd className="px-1 py-0.5 rounded bg-ink-700">Enter</kbd> select</span>
          <span><kbd className="px-1 py-0.5 rounded bg-ink-700">Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
