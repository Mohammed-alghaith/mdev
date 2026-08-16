import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

function basename(p) {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

function shortenPath(p, homeDir) {
  if (!p) return '';
  if (homeDir && p === homeDir) return '~';
  if (homeDir && p.startsWith(homeDir + '/')) return '~' + p.slice(homeDir.length);
  return p;
}

function FolderIcon({ open }) {
  return open ? (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H5l-2 9V7z" />
      <path d="M5 19h14a2 2 0 0 0 2-2l1-7H4l-1 7a2 2 0 0 0 2 2z" />
    </svg>
  ) : (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function Chevron({ open, hidden }) {
  if (hidden) return <span className="w-3 h-3 inline-block shrink-0" />;
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 120ms' }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function FileRow({ entry, depth, expanded, loading, onToggle, onOpen, onReveal }) {
  return (
    <div
      onClick={() => entry.isDir ? onToggle(entry) : onOpen(entry)}
      onContextMenu={(e) => { e.preventDefault(); onReveal(entry); }}
      className={
        'group flex items-center gap-1.5 pr-2 py-1 text-xs cursor-pointer transition select-none ' +
        'text-ink-100 hover:bg-ink-700/60 ' +
        (entry.isHidden ? 'opacity-50' : '')
      }
      style={{ paddingLeft: 8 + depth * 14 }}
      title={entry.path + (entry.isSymlink ? ' (symlink)' : '')}
    >
      <Chevron open={expanded} hidden={!entry.isDir} />
      <span className={entry.isDir ? 'text-accent-400' : 'text-ink-300'}>
        {entry.isDir ? <FolderIcon open={expanded} /> : <FileIcon />}
      </span>
      <span className={'truncate flex-1 ' + (entry.isSymlink ? 'italic' : '')}>
        {entry.name}
      </span>
      {loading && entry.isDir && <span className="text-[10px] text-ink-300">…</span>}
    </div>
  );
}

export default function FileManager({ open, cwd, homeDir, onToggleOpen, onOpenFile }) {
  const [tree, setTree] = useState(new Map()); // path -> { entries, loading, error }
  const [expanded, setExpanded] = useState(new Set());
  const treeRef = useRef(tree);
  treeRef.current = tree;

  const loadDir = useCallback(async (p) => {
    if (!window.api) return;
    setTree((m) => {
      const next = new Map(m);
      const prev = next.get(p);
      next.set(p, { entries: prev?.entries || [], loading: true, error: undefined });
      return next;
    });
    const res = await window.api.fs.readDir(p);
    setTree((m) => {
      const next = new Map(m);
      next.set(p, { entries: res?.entries || [], loading: false, error: res?.error });
      return next;
    });
  }, []);

  // Reset & reload whenever the active workspace changes.
  useEffect(() => {
    if (!cwd || !open) return;
    setTree(new Map());
    setExpanded(new Set([cwd]));
    loadDir(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, open]);

  const onToggleDir = useCallback((entry) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(entry.path)) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
        if (!treeRef.current.has(entry.path)) loadDir(entry.path);
      }
      return next;
    });
  }, [loadDir]);

  const onOpenFileClick = useCallback((entry) => {
    if (onOpenFile) {
      onOpenFile(entry.path);
    } else if (window.api) {
      window.api.fs.openPath(entry.path);
    }
  }, [onOpenFile]);

  const onRevealFile = useCallback((entry) => {
    if (!window.api) return;
    window.api.fs.revealInFinder(entry.path);
  }, []);

  const onRefresh = useCallback(() => {
    if (!cwd) return;
    setTree(new Map());
    loadDir(cwd);
    // Keep expanded paths but re-fetch their dirs lazily as they're rendered.
    for (const p of expanded) if (p !== cwd) loadDir(p);
  }, [cwd, expanded, loadDir]);

  // Build a flat render list by walking expanded set against the tree map.
  const rows = useMemo(() => {
    const out = [];
    function walk(parentPath, depth) {
      const node = tree.get(parentPath);
      if (!node || !Array.isArray(node.entries)) return;
      for (const entry of node.entries) {
        const isOpen = expanded.has(entry.path);
        const childNode = tree.get(entry.path);
        out.push({
          entry,
          depth,
          expanded: isOpen,
          loading: !!(isOpen && childNode?.loading && !childNode?.entries?.length),
        });
        if (entry.isDir && isOpen) walk(entry.path, depth + 1);
      }
    }
    if (cwd) walk(cwd, 0);
    return out;
  }, [tree, expanded, cwd]);

  const rootStatus = cwd ? tree.get(cwd) : null;

  return (
    <aside
      className={
        'bg-ink-800 border-l border-ink-700 transition-all duration-200 overflow-hidden flex flex-col ' +
        (open ? 'w-72' : 'w-0')
      }
    >
      <div className="px-3 pt-3 pb-2 border-b border-ink-700 shrink-0">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xs font-semibold tracking-wide text-ink-300 uppercase">Files</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={onRefresh}
              title="Reload"
              className="flex items-center justify-center w-6 h-6 rounded-md text-ink-300 hover:text-ink-100 hover:bg-ink-700 transition"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
            <button
              onClick={() => cwd && window.api?.fs.revealInFinder(cwd)}
              title="Open workspace in Finder"
              disabled={!cwd}
              className="flex items-center justify-center w-6 h-6 rounded-md text-ink-300 hover:text-ink-100 hover:bg-ink-700 transition disabled:opacity-30"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6M14 10l7-7M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
              </svg>
            </button>
            <button
              onClick={onToggleOpen}
              title="Hide files panel"
              className="flex items-center justify-center w-6 h-6 rounded-md text-ink-300 hover:text-ink-100 hover:bg-ink-700 transition"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        </div>
        <p className="text-[10px] text-ink-300 truncate" title={cwd || ''}>
          {cwd ? shortenPath(cwd, homeDir) : 'no workspace'}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin py-1">
        {!cwd ? (
          <div className="p-4 text-xs text-ink-300 leading-relaxed">
            Open a workspace to browse its files.
          </div>
        ) : rootStatus?.error ? (
          <div className="p-4 text-xs text-red-400 leading-relaxed">
            {rootStatus.error}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4 text-xs text-ink-300 leading-relaxed">
            {rootStatus?.loading ? 'Reading…' : 'Empty directory.'}
          </div>
        ) : (
          rows.map((r) => (
            <FileRow
              key={r.entry.path}
              entry={r.entry}
              depth={r.depth}
              expanded={r.expanded}
              loading={r.loading}
              onToggle={onToggleDir}
              onOpen={onOpenFileClick}
              onReveal={onRevealFile}
            />
          ))
        )}
      </div>

      <div className="px-3 py-2 border-t border-ink-700 text-[10px] text-ink-300 shrink-0">
        {rows.length} item{rows.length === 1 ? '' : 's'} shown · right-click reveals in Finder
      </div>
    </aside>
  );
}
