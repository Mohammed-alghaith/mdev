import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';

function basename(p) {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

const EditorPane = forwardRef(function EditorPane({ onEmptyChange, theme }, ref) {
  // path -> { content, original, loading, error }
  const [files, setFiles] = useState(new Map());
  const [order, setOrder] = useState([]);
  const [active, setActive] = useState(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    onEmptyChange?.(order.length === 0);
  }, [order.length, onEmptyChange]);

  const loadFile = useCallback(async (p) => {
    setFiles((m) => {
      const next = new Map(m);
      next.set(p, { content: '', original: '', loading: true, error: null });
      return next;
    });
    const res = await window.api?.fs.readFile(p);
    setFiles((m) => {
      const next = new Map(m);
      if (res?.ok) {
        next.set(p, { content: res.content, original: res.content, loading: false, error: null });
      } else {
        next.set(p, { content: '', original: '', loading: false, error: res?.error || 'failed to read' });
      }
      return next;
    });
  }, []);

  const openFile = useCallback((p) => {
    if (!p) return;
    setOrder((prev) => (prev.includes(p) ? prev : [...prev, p]));
    setActive(p);
    if (!filesRef.current.has(p)) loadFile(p);
  }, [loadFile]);

  const closeFile = useCallback((p) => {
    setOrder((prev) => {
      const idx = prev.indexOf(p);
      if (idx === -1) return prev;
      const next = prev.filter((x) => x !== p);
      if (activeRef.current === p) {
        const fallback = next[idx] || next[idx - 1] || null;
        setActive(fallback);
      }
      return next;
    });
    setFiles((m) => {
      if (!m.has(p)) return m;
      const next = new Map(m);
      next.delete(p);
      return next;
    });
  }, []);

  const saveFile = useCallback(async (p) => {
    const f = filesRef.current.get(p);
    if (!f || f.loading) return;
    if (f.content === f.original) return;
    const res = await window.api?.fs.writeFile(p, f.content);
    if (res?.ok) {
      setFiles((m) => {
        const cur = m.get(p);
        if (!cur) return m;
        const next = new Map(m);
        next.set(p, { ...cur, original: cur.content });
        return next;
      });
    } else {
      setFiles((m) => {
        const cur = m.get(p);
        if (!cur) return m;
        const next = new Map(m);
        next.set(p, { ...cur, error: res?.error || 'failed to save' });
        return next;
      });
    }
  }, []);

  useImperativeHandle(ref, () => ({ openFile, closeFile }), [openFile, closeFile]);

  // Cmd/Ctrl+S saves the active file even when focus is outside the Monaco
  // surface (e.g. when the prompt bar has focus).
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 's' || e.key === 'S')) {
        if (activeRef.current) {
          e.preventDefault();
          saveFile(activeRef.current);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveFile]);

  const onChange = useCallback((value) => {
    const p = activeRef.current;
    if (!p) return;
    setFiles((m) => {
      const cur = m.get(p);
      if (!cur) return m;
      const next = new Map(m);
      next.set(p, { ...cur, content: value ?? '' });
      return next;
    });
  }, []);

  const handleMount = useCallback((editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (activeRef.current) saveFile(activeRef.current);
    });
  }, [saveFile]);

  if (order.length === 0) return null;

  const activeFile = active ? files.get(active) : null;
  const dirty = activeFile && activeFile.content !== activeFile.original;

  return (
    <div className="flex flex-col h-full min-h-0 bg-ink-900 border-b border-ink-700">
      <div className="flex items-center bg-ink-800 border-b border-ink-700 shrink-0 overflow-x-auto scroll-thin">
        {order.map((p) => {
          const f = files.get(p);
          const isDirty = f && f.content !== f.original;
          const isActive = p === active;
          return (
            <div
              key={p}
              onClick={() => setActive(p)}
              className={
                'group flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer border-r border-ink-700 shrink-0 select-none ' +
                (isActive
                  ? 'bg-ink-900 text-ink-100'
                  : 'text-ink-300 hover:bg-ink-700/60')
              }
              title={p}
            >
              <span className="truncate max-w-[180px]">{basename(p)}</span>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: isDirty ? '#c08cff' : 'transparent' }} />
              <button
                onClick={(e) => { e.stopPropagation(); closeFile(p); }}
                className="opacity-50 hover:opacity-100 hover:text-ink-100"
                title="Close"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 relative">
        {!active ? null : activeFile?.loading ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-ink-300">Reading…</div>
        ) : activeFile?.error ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-red-400 px-4 text-center">
            {activeFile.error}
          </div>
        ) : (
          <Editor
            theme={theme === 'light' ? 'vs' : 'vs-dark'}
            path={active}
            value={activeFile?.content || ''}
            onChange={onChange}
            onMount={handleMount}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              automaticLayout: true,
              scrollBeyondLastLine: false,
              tabSize: 2,
              renderWhitespace: 'selection',
              smoothScrolling: true,
              padding: { top: 8 },
            }}
          />
        )}
      </div>

      {active && (
        <div className="flex items-center justify-between px-3 py-1 border-t border-ink-700 bg-ink-800 text-[10px] text-ink-300 shrink-0">
          <span className="truncate">{active}</span>
          <span>{dirty ? 'unsaved · ⌘S to save' : 'saved'}</span>
        </div>
      )}
    </div>
  );
});

export default EditorPane;
