import React from 'react';

export default function TabBar({ tabs, activeId, onSelect, onNewTab, onNewBrowserTab, onCloseTab, onToggleSidebar, sidebarOpen, onToggleFiles, filesOpen, onOpenSettings, theme, onToggleTheme }) {
  return (
    <div className="titlebar-drag flex items-center gap-1 px-3 pt-2 pb-1 bg-ink-900 border-b border-ink-700 select-none">
      {/* Mac traffic-light spacer */}
      <div className="w-20 h-7 shrink-0" />

      <button
        onClick={onToggleSidebar}
        title={sidebarOpen ? 'Hide history' : 'Show history'}
        className="titlebar-nodrag flex items-center justify-center w-8 h-8 rounded-md text-ink-300 hover:text-ink-100 hover:bg-ink-700 transition"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      <div className="titlebar-nodrag flex items-end gap-1 overflow-x-auto scroll-thin flex-1 min-w-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            className={
              'group flex items-center gap-2 px-3 h-8 rounded-t-lg cursor-pointer transition shrink-0 ' +
              (tab.id === activeId
                ? 'bg-ink-800 text-ink-100 border-t border-x border-ink-700'
                : 'bg-transparent text-ink-300 hover:text-ink-100 hover:bg-ink-800/50')
            }
          >
            {tab.kind === 'browser' ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={tab.id === activeId ? 'text-accent-500' : 'text-ink-400'}>
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            ) : (
              <span className={'w-1.5 h-1.5 rounded-full ' + (tab.id === activeId ? 'bg-accent-500' : 'bg-ink-400')} />
            )}
            <span className="text-xs font-medium truncate max-w-[180px]">{tab.title}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              className="opacity-0 group-hover:opacity-100 text-ink-300 hover:text-ink-100 transition rounded p-0.5"
              title="Close tab"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        ))}
        <button
          onClick={onNewTab}
          title="New terminal tab"
          className="flex items-center justify-center w-8 h-8 rounded-md text-ink-300 hover:text-ink-100 hover:bg-ink-700 transition"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          onClick={onNewBrowserTab}
          title="New browser tab"
          className="flex items-center justify-center w-8 h-8 rounded-md text-ink-300 hover:text-ink-100 hover:bg-ink-700 transition"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </button>
      </div>

      <button
        onClick={onToggleTheme}
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        className="titlebar-nodrag flex items-center justify-center w-8 h-8 rounded-md text-ink-300 hover:text-ink-100 hover:bg-ink-700 transition shrink-0"
      >
        {theme === 'dark' ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="4" />
            <line x1="12" y1="2" x2="12" y2="4" />
            <line x1="12" y1="20" x2="12" y2="22" />
            <line x1="4.93" y1="4.93" x2="6.34" y2="6.34" />
            <line x1="17.66" y1="17.66" x2="19.07" y2="19.07" />
            <line x1="2" y1="12" x2="4" y2="12" />
            <line x1="20" y1="12" x2="22" y2="12" />
            <line x1="4.93" y1="19.07" x2="6.34" y2="17.66" />
            <line x1="17.66" y1="6.34" x2="19.07" y2="4.93" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        )}
      </button>

      <button
        onClick={onOpenSettings}
        title="Settings"
        className="titlebar-nodrag flex items-center justify-center w-8 h-8 rounded-md text-ink-300 hover:text-ink-100 hover:bg-ink-700 transition shrink-0"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      <span className="titlebar-nodrag text-[10px] text-accent-400 font-semibold px-1.5 py-0.5 rounded bg-accent-500/15 shrink-0" title="v0.2.0 — hot-switch, ⌘K palette, ⌘N restart">v0.2.0</span>

      <button
        onClick={onToggleFiles}
        title={filesOpen ? 'Hide files panel' : 'Show files panel'}
        className={
          'titlebar-nodrag flex items-center justify-center w-8 h-8 rounded-md transition shrink-0 ' +
          (filesOpen ? 'text-accent-400 bg-ink-700/50' : 'text-ink-300 hover:text-ink-100 hover:bg-ink-700')
        }
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      </button>
    </div>
  );
}
