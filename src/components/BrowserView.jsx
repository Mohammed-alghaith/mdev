import React, { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';

// URL scheme gating. http(s) always allowed; file:// opt-in via the toolbar
// toggle; everything else (javascript:, data:, chrome:, etc.) blocked. About:
// is allowed as a special case for about:blank (the home page).
// Returns { url } on success or { error } on rejection.
function normalizeUrl(input, { allowFileUrls = false } = {}) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return { error: 'empty url' };

  if (/^https?:\/\//i.test(trimmed)) return { url: trimmed };
  if (/^about:/i.test(trimmed)) return { url: trimmed };
  if (/^file:\/\//i.test(trimmed)) {
    return allowFileUrls
      ? { url: trimmed }
      : { error: 'file:// is disabled — enable via the file-toggle in the toolbar' };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return { error: 'Unsupported URL scheme: ' + trimmed.split(':')[0] };
  }
  // Treat anything that looks like host[:port][/path] as an http URL.
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|[\w-]+(\.[\w-]+)+)(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return { url: 'http://' + trimmed };
  }
  // Otherwise fall back to a Google search.
  return { url: 'https://www.google.com/search?q=' + encodeURIComponent(trimmed) };
}

const HOME_URL = 'about:blank';

const BrowserView = forwardRef(function BrowserView({ initialUrl = '', visible, view = 'side', onTitle, onUrlChange, onToggleView }, ref) {
  const webviewRef = useRef(null);
  const [url, setUrl] = useState(initialUrl || HOME_URL);
  const [urlInput, setUrlInput] = useState(initialUrl);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [allowFileUrls, setAllowFileUrls] = useState(() => localStorage.getItem('allow-file-urls') === 'true');
  const [schemeError, setSchemeError] = useState(''); // transient message under the URL bar
  useEffect(() => { localStorage.setItem('allow-file-urls', String(allowFileUrls)); }, [allowFileUrls]);

  const onUrlChangeRef = useRef(onUrlChange);
  const onTitleRef = useRef(onTitle);
  onUrlChangeRef.current = onUrlChange;
  onTitleRef.current = onTitle;

  // Wire up webview events imperatively — the React JSX <webview> element
  // is just a custom DOM tag, so addEventListener is the right API.
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    const onDomReady = () => {
      setReady(true);
      try {
        setCanGoBack(wv.canGoBack());
        setCanGoForward(wv.canGoForward());
      } catch {}
    };
    const onDidStartLoading = () => setLoading(true);
    const onDidStopLoading = () => {
      setLoading(false);
      try {
        setCanGoBack(wv.canGoBack());
        setCanGoForward(wv.canGoForward());
      } catch {}
    };
    const onDidNavigate = (e) => {
      const next = e?.url || '';
      if (next) {
        setUrl(next);
        setUrlInput(next);
        onUrlChangeRef.current?.(next);
      }
    };
    const onPageTitleUpdated = (e) => {
      if (e?.title) onTitleRef.current?.(e.title);
    };

    wv.addEventListener('dom-ready', onDomReady);
    wv.addEventListener('did-start-loading', onDidStartLoading);
    wv.addEventListener('did-stop-loading', onDidStopLoading);
    wv.addEventListener('did-navigate', onDidNavigate);
    wv.addEventListener('did-navigate-in-page', onDidNavigate);
    wv.addEventListener('page-title-updated', onPageTitleUpdated);
    return () => {
      wv.removeEventListener('dom-ready', onDomReady);
      wv.removeEventListener('did-start-loading', onDidStartLoading);
      wv.removeEventListener('did-stop-loading', onDidStopLoading);
      wv.removeEventListener('did-navigate', onDidNavigate);
      wv.removeEventListener('did-navigate-in-page', onDidNavigate);
      wv.removeEventListener('page-title-updated', onPageTitleUpdated);
    };
  }, []);

  const go = useCallback((target) => {
    const result = normalizeUrl(target, { allowFileUrls });
    if (result.error) {
      setSchemeError(result.error);
      return;
    }
    setSchemeError('');
    setUrl(result.url);
    setUrlInput(result.url);
    const wv = webviewRef.current;
    if (wv && ready) {
      try { wv.loadURL(result.url); } catch {}
    }
  }, [ready, allowFileUrls]);

  const onSubmit = useCallback((e) => {
    e.preventDefault();
    go(urlInput);
  }, [go, urlInput]);

  const reload = () => { try { webviewRef.current?.reload(); } catch {} };
  const stop = () => { try { webviewRef.current?.stop(); } catch {} };
  const back = () => { try { webviewRef.current?.goBack(); } catch {} };
  const forward = () => { try { webviewRef.current?.goForward(); } catch {} };
  const openDevTools = () => { try { webviewRef.current?.openDevTools(); } catch {} };

  // Imperative API used by App.jsx to fulfill MCP tool calls
  // (navigate_browser, screenshot_browser).
  useImperativeHandle(ref, () => ({
    navigate: (target) => go(target),
    getUrl: () => url,
    capture: async () => {
      const wv = webviewRef.current;
      if (!wv) throw new Error('browser not ready');
      // capturePage returns a NativeImage. toDataURL gives "data:image/png;base64,...".
      const img = await wv.capturePage();
      const dataUrl = img.toDataURL();
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      const size = img.getSize();
      return { base64, width: size.width, height: size.height };
    },
  }), [go, url]);

  return (
    <div className={'absolute inset-0 flex flex-col bg-ink-900 ' + (visible ? '' : 'invisible pointer-events-none')}>
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-ink-700 bg-ink-800">
        <button
          onClick={back}
          disabled={!canGoBack}
          title="Back"
          className="w-7 h-7 flex items-center justify-center rounded text-ink-300 hover:text-ink-100 hover:bg-ink-700 disabled:opacity-30 disabled:hover:bg-transparent transition"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
        </button>
        <button
          onClick={forward}
          disabled={!canGoForward}
          title="Forward"
          className="w-7 h-7 flex items-center justify-center rounded text-ink-300 hover:text-ink-100 hover:bg-ink-700 disabled:opacity-30 disabled:hover:bg-transparent transition"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
        </button>
        <button
          onClick={loading ? stop : reload}
          title={loading ? 'Stop' : 'Reload'}
          className="w-7 h-7 flex items-center justify-center rounded text-ink-300 hover:text-ink-100 hover:bg-ink-700 transition"
        >
          {loading ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
          )}
        </button>

        <form onSubmit={onSubmit} className="flex-1 min-w-0">
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onFocus={(e) => e.target.select()}
            placeholder="Enter URL or search — e.g. localhost:5173"
            spellCheck={false}
            className="w-full h-7 px-2.5 rounded-md bg-ink-900 border border-ink-700 focus:border-accent-500 focus:outline-none text-xs text-ink-100 placeholder:text-ink-400"
          />
        </form>

        <button
          onClick={() => { setAllowFileUrls((v) => !v); if (schemeError) setSchemeError(''); }}
          title={
            allowFileUrls
              ? 'file:// URLs allowed — click to disable. Local-file URLs can read arbitrary files on your machine.'
              : 'file:// URLs blocked — click to allow. Useful for previewing built HTML from a dist folder.'
          }
          className={
            'w-7 h-7 flex items-center justify-center rounded transition ' +
            (allowFileUrls ? 'text-accent-400 bg-ink-700/60' : 'text-ink-300 hover:text-ink-100 hover:bg-ink-700')
          }
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            {!allowFileUrls && <line x1="3" y1="21" x2="21" y2="3" />}
          </svg>
        </button>
        <button
          onClick={openDevTools}
          title="Open DevTools for this page"
          className="w-7 h-7 flex items-center justify-center rounded text-ink-300 hover:text-ink-100 hover:bg-ink-700 transition"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
        </button>
        {onToggleView && (
          <button
            onClick={onToggleView}
            title={view === 'full' ? 'Show in side pane' : 'Show in full view'}
            className="w-7 h-7 flex items-center justify-center rounded text-ink-300 hover:text-ink-100 hover:bg-ink-700 transition"
          >
            {view === 'full' ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 14h6v6" /><path d="M20 10h-6V4" /><path d="M14 10l7-7" /><path d="M3 21l7-7" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
            )}
          </button>
        )}
      </div>

      {schemeError && (
        <div className="px-3 py-1 bg-red-500/15 border-b border-red-500/30 text-red-300 text-[11px] flex items-center justify-between">
          <span className="truncate">{schemeError}</span>
          <button onClick={() => setSchemeError('')} className="ml-2 text-red-300 hover:text-red-200 shrink-0" title="Dismiss">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 bg-white relative">
        <webview
          ref={webviewRef}
          src={url}
          allowpopups="true"
          style={{ display: 'inline-flex', width: '100%', height: '100%' }}
        />
        {url === HOME_URL && (
          <div className="absolute inset-0 flex items-center justify-center text-ink-400 text-sm bg-ink-900 pointer-events-none">
            Enter a URL above to start — e.g. <span className="ml-1 text-ink-200">localhost:5173</span>
          </div>
        )}
      </div>
    </div>
  );
});

export default BrowserView;
