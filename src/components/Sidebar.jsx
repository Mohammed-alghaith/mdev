import React, { useMemo, useState } from 'react';

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return sec + 's';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h';
  const d = Math.floor(hr / 24);
  if (d < 30) return d + 'd';
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + 'mo';
  return Math.floor(mo / 12) + 'y';
}

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

function ChevronIcon({ open }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 120ms' }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

function EyeIcon({ off }) {
  return off ? (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export default function Sidebar({
  open,
  sessions,
  projects = [],
  hiddenIds,
  showHidden,
  onToggleShowHidden,
  activeCwd,
  homeDir,
  onResume,
  onNewWorkspace,
  onNewSessionInProject,
  onBrowseProject,
  onSetHidden,
  onDelete,
  onRefresh,
  activeSessionId,
  openSessionIds,
}) {
  const openSet = openSessionIds || new Set();
  const [query, setQuery] = useState('');
  const [collapsedProjects, setCollapsedProjects] = useState({});

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map();

    // Keep currently open workspaces visible before they have a history entry.
    // Claude only appends to ~/.claude/history.jsonl after the first submitted
    // prompt.
    for (const project of projects) {
      if (!project) continue;
      if (q && !project.toLowerCase().includes(q)) continue;
      if (!map.has(project)) map.set(project, []);
    }

    for (const s of sessions) {
      if (!s.project) continue;
      const isHidden = hiddenIds.has(s.sessionId);
      if (isHidden && !showHidden) continue;
      if (q && !(s.prompt || '').toLowerCase().includes(q) && !s.project.toLowerCase().includes(q)) continue;
      if (!map.has(s.project)) map.set(s.project, []);
      map.get(s.project).push({ ...s, hidden: isHidden });
    }
    const list = [];
    for (const [project, items] of map.entries()) {
      items.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
      list.push({ project, items, lastTimestamp: items[0]?.lastTimestamp || 0 });
    }
    list.sort((a, b) => {
      if (a.project === activeCwd) return -1;
      if (b.project === activeCwd) return 1;
      return b.lastTimestamp - a.lastTimestamp || a.project.localeCompare(b.project);
    });
    return list;
  }, [sessions, projects, hiddenIds, showHidden, activeCwd, query]);

  const totalVisibleSessions = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups]);
  const hiddenCount = hiddenIds.size;

  const isGroupOpen = (project) => {
    if (project === activeCwd) return true;
    if (project in collapsedProjects) return !collapsedProjects[project];
    return false;
  };
  const toggleGroup = (project) => {
    if (project === activeCwd) return;
    setCollapsedProjects((m) => ({ ...m, [project]: !((project in m) ? m[project] : true) }));
  };

  return (
    <aside
      className={
        'bg-ink-800 border-r border-ink-700 transition-all duration-200 overflow-hidden flex flex-col ' +
        (open ? 'w-80' : 'w-0')
      }
    >
      <div className="px-4 pt-3 pb-2 border-b border-ink-700 shrink-0">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xs font-semibold tracking-wide text-ink-300 uppercase">
            Claude Sessions
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={onRefresh}
              title="Refresh sessions"
              className="flex items-center justify-center w-6 h-6 rounded-md text-ink-300 hover:text-ink-100 hover:bg-ink-700 transition"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
            </button>
            <button
              onClick={onNewWorkspace}
              title="Pick or create a folder, open it as a Claude workspace"
              className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-md bg-accent-500/20 text-accent-400 hover:bg-accent-500/40 transition"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                <line x1="12" y1="11" x2="12" y2="17" />
                <line x1="9" y1="14" x2="15" y2="14" />
              </svg>
              New
            </button>
          </div>
        </div>
        <p className="text-[10px] text-ink-300 truncate" title={activeCwd || ''}>
          {activeCwd ? shortenPath(activeCwd, homeDir) : 'no workspace detected'}
        </p>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions or paths…"
          className="mt-2 w-full text-xs bg-ink-900 text-ink-100 placeholder-ink-300 px-3 py-1.5 rounded-md border border-ink-700 focus:outline-none focus:border-accent-500 transition"
        />
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin">
        {groups.length === 0 ? (
          <div className="p-4 text-xs text-ink-300 leading-relaxed">
            {sessions.length === 0
              ? 'No Claude sessions found in ~/.claude/history.jsonl.'
              : (hiddenCount && !showHidden
                ? 'All matching sessions are hidden. Toggle "Show hidden" below.'
                : 'No sessions match your search.')}
          </div>
        ) : (
          groups.map((g) => {
            const opened = isGroupOpen(g.project);
            const isActive = g.project === activeCwd;
            return (
              <div key={g.project} className="mb-1 group/section">
                <div
                  className={
                    'w-full pl-2 pr-1 py-2 flex items-center gap-1 ' +
                    (isActive ? 'bg-accent-500/10 border-l-2 border-accent-500' : 'hover:bg-ink-700/40')
                  }
                >
                  <button
                    onClick={() => {
                      onBrowseProject?.(g.project);
                      toggleGroup(g.project);
                    }}
                    className="flex items-center gap-2 flex-1 min-w-0 text-left cursor-pointer"
                    title={'Browse ' + g.project + ' in file manager'}
                  >
                    <span className="text-ink-300 shrink-0 pl-1">
                      <ChevronIcon open={opened} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={'text-xs font-semibold truncate ' + (isActive ? 'text-accent-400' : 'text-ink-100')}>
                          {basename(g.project)}
                        </span>
                        {isActive && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-accent-500/30 text-accent-400 uppercase tracking-wide">
                            active
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] text-ink-300 truncate">
                        {shortenPath(g.project, homeDir)}
                      </p>
                    </div>
                    <span className="text-[10px] text-ink-300 shrink-0 pr-1">{g.items.length}</span>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onNewSessionInProject(g.project); }}
                    title={'Start a new Claude session in ' + g.project}
                    className="flex items-center justify-center w-6 h-6 rounded-md text-ink-300 hover:text-accent-400 hover:bg-ink-700 transition shrink-0"
                  >
                    <PlusIcon />
                  </button>
                </div>

                {opened && (
                  <ul className="pb-1">
                    {g.items.map((s) => {
                      const isActiveSession = s.sessionId === activeSessionId;
                      const isOpenSession = openSet.has(s.sessionId);
                      return (
                      <li
                        key={s.sessionId}
                        className={
                          'group mx-3 my-1 px-3 py-2 rounded-lg cursor-pointer transition selectable ' +
                          (isActiveSession
                            ? 'bg-accent-500/15 border border-accent-500 ring-1 ring-accent-500/30 shadow-soft'
                            : isOpenSession
                              ? 'bg-ink-700/40 border border-ink-500 hover:bg-ink-700/70'
                              : (s.hidden
                                  ? 'bg-ink-700/10 opacity-50 hover:opacity-100 border border-transparent hover:border-ink-600'
                                  : 'bg-ink-700/30 hover:bg-ink-700/70 border border-transparent hover:border-ink-600'))
                        }
                        onClick={() => onResume(s)}
                        title={
                          isActiveSession
                            ? 'Active session in current tab'
                            : isOpenSession
                              ? 'Open in another tab — click to open another instance'
                              : ('Resume session ' + s.sessionId)
                        }
                      >
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <div className="flex items-start gap-1.5 flex-1 min-w-0">
                            {isActiveSession ? (
                              <span className="mt-1 w-1.5 h-1.5 rounded-full bg-accent-400 shrink-0 shadow-[0_0_6px_rgba(192,140,255,0.7)]" />
                            ) : isOpenSession ? (
                              <span className="mt-1 w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                            ) : null}
                            <p className={'text-xs font-medium leading-snug line-clamp-2 break-words flex-1 ' + (s.hidden ? 'text-ink-300 line-through' : (isActiveSession ? 'text-accent-100' : 'text-ink-100'))}>
                              {s.prompt || '(untitled)'}
                            </p>
                          </div>
                          <span className="text-[10px] text-ink-300 shrink-0 pt-0.5">
                            {timeAgo(s.lastTimestamp)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-[10px] text-ink-300">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="px-1.5 py-0.5 rounded bg-ink-900/60 font-mono shrink-0">
                              {s.sessionId.slice(0, 8)}
                            </span>
                            {s.model ? (
                              <span className="px-1.5 py-0.5 rounded bg-accent-500/15 text-accent-400 font-medium shrink-0 truncate max-w-[100px]" title={s.model}>
                                {s.model.replace(/^claude-/, '').replace(/-/g, ' ')}
                              </span>
                            ) : null}
                            <span>·</span>
                            <span>{s.messageCount} msg{s.messageCount === 1 ? '' : 's'}</span>
                            {isActiveSession && (
                              <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-accent-500/30 text-accent-400 uppercase tracking-wide shrink-0">
                                active
                              </span>
                            )}
                            {!isActiveSession && isOpenSession && (
                              <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-300 uppercase tracking-wide shrink-0">
                                open
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition shrink-0">
                            <button
                              onClick={(e) => { e.stopPropagation(); onSetHidden(s.sessionId, !s.hidden); }}
                              title={s.hidden ? 'Unhide session' : 'Hide session from sidebar'}
                              className="flex items-center justify-center w-6 h-6 rounded text-ink-300 hover:text-ink-100 hover:bg-ink-600/60 transition"
                            >
                              <EyeIcon off={!s.hidden} />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); onDelete(s); }}
                              title="Permanently delete session"
                              className="flex items-center justify-center w-6 h-6 rounded text-ink-300 hover:text-red-400 hover:bg-red-500/10 transition"
                            >
                              <TrashIcon />
                            </button>
                          </div>
                        </div>
                      </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="px-4 py-2 border-t border-ink-700 text-[10px] text-ink-300 shrink-0 flex items-center justify-between gap-2">
        <span className="truncate">
          {groups.length} project{groups.length === 1 ? '' : 's'} · {totalVisibleSessions} session{totalVisibleSessions === 1 ? '' : 's'}
        </span>
        <button
          onClick={onToggleShowHidden}
          disabled={!hiddenCount}
          className={
            'shrink-0 px-2 py-0.5 rounded transition ' +
            (hiddenCount
              ? (showHidden ? 'bg-accent-500/20 text-accent-400 hover:bg-accent-500/40' : 'hover:bg-ink-700 hover:text-ink-100')
              : 'opacity-40 cursor-not-allowed')
          }
          title={hiddenCount ? (showHidden ? 'Hide them again' : 'Show hidden sessions') : 'No hidden sessions'}
        >
          {showHidden ? 'Hide hidden' : 'Show hidden'} ({hiddenCount})
        </button>
      </div>
    </aside>
  );
}
