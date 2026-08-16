import React, { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';

const DARK_THEME = {
  background: '#181818',
  foreground: '#ececec',
  cursor: '#c08cff',
  cursorAccent: '#181818',
  selectionBackground: 'rgba(192,140,255,0.30)',
  black: '#202020',
  red: '#ff6b8a',
  green: '#7ee787',
  yellow: '#f0c674',
  blue: '#82aaff',
  magenta: '#c08cff',
  cyan: '#7fd5ea',
  white: '#cccccc',
  brightBlack: '#4a4a4a',
  brightRed: '#ff8aa3',
  brightGreen: '#9af2a3',
  brightYellow: '#ffd98a',
  brightBlue: '#a5c2ff',
  brightMagenta: '#d4b1ff',
  brightCyan: '#a4e6f4',
  brightWhite: '#ffffff',
};

const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1f2333',
  cursor: '#7c3aed',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(124,58,237,0.25)',
  black: '#1f2333',
  red: '#d3364f',
  green: '#1a9e5b',
  yellow: '#a57800',
  blue: '#2f6fed',
  magenta: '#7c3aed',
  cyan: '#0e7c9e',
  white: '#e6e8f0',
  brightBlack: '#6b7087',
  brightRed: '#e5484d',
  brightGreen: '#1fae6a',
  brightYellow: '#c79a00',
  brightBlue: '#4a86ff',
  brightMagenta: '#9d5cff',
  brightCyan: '#0aa3c9',
  brightWhite: '#ffffff',
};

// Decide whether a keystroke should reach the Claude CLI. Forward control bytes
// (Ctrl+*, Enter, Tab, Backspace) and escape sequences (Esc, arrow keys,
// Option/Alt+key, Home/End/PageUp/PageDown), but block printable text so the
// terminal can't be typed into by mistake — the PromptBar is the only text input.
function shouldForwardKey(data) {
  if (!data) return false;
  // Escape sequences (Esc, arrows, Option/Alt+key, …) always start with 0x1b.
  if (data.charCodeAt(0) === 0x1b) return true;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    // Printable ASCII (0x20–0x7e) and multibyte UTF-8 (>= 0x80) are "typing" → block.
    if (c >= 0x20 && c !== 0x7f) return false;
  }
  return true;
}

function safeFit(fitAddon, term, ptyId) {
  if (!fitAddon || !term) return;
  try {
    const dims = fitAddon.proposeDimensions?.();
    if (!dims || !dims.cols || !dims.rows) return;
    fitAddon.fit();
    if (ptyId && window.api) window.api.pty.resize(ptyId, term.cols, term.rows);
  } catch {}
}

const TerminalView = forwardRef(function TerminalView({ ptyId, visible, onTitle, onCwd, theme }, ref) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const unsubDataRef = useRef(null);
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const onCwdRef = useRef(onCwd);
  onCwdRef.current = onCwd;

  useImperativeHandle(ref, () => ({
    focus: () => termRef.current?.focus(),
    fit: () => safeFit(fitRef.current, termRef.current, ptyId),
    clear: () => termRef.current?.clear(),
    write: (data) => termRef.current?.write(data),
  }), [ptyId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !ptyId) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: false,
      allowProposedApi: true,
      scrollback: 5000,
      scrollSensitivity: 5,
      fastScrollSensitivity: 8,
      theme: theme === 'light' ? LIGHT_THEME : DARK_THEME,
      macOptionIsMeta: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(container);

    termRef.current = term;
    fitRef.current = fitAddon;

    // Defer fit until the container has measurable size + xterm's renderer is ready.
    let fitTries = 0;
    const tryFit = () => {
      const { clientWidth, clientHeight } = container;
      if (clientWidth < 10 || clientHeight < 10) {
        if (fitTries++ < 30) requestAnimationFrame(tryFit);
        return;
      }
      safeFit(fitAddon, term, ptyId);
    };
    requestAnimationFrame(tryFit);

    const dataHandler = ({ id, data }) => {
      if (id === ptyId) term.write(data);
    };
    unsubDataRef.current = window.api.pty.onData(dataHandler);

    // The terminal stays display-only for text (typing goes through the
    // PromptBar), but the Claude CLI is still driven by keyboard shortcuts
    // (Ctrl+O to expand thinking, Ctrl+C to interrupt, arrows, Esc, Enter, …).
    // Forward control/escape sequences while swallowing printable text, so
    // shortcuts work without risking accidental typing into the CLI.
    term.onData((data) => {
      if (shouldForwardKey(data) && window.api) {
        window.api.pty.write(ptyId, data);
      }
    });

    const titleDisp = term.onTitleChange?.((t) => onTitleRef.current?.(t));

    // OSC 7 cwd report: shells emit "ESC ] 7 ; <path-or-file://> BEL" on init + every cd.
    const oscDisp = term.parser?.registerOscHandler?.(7, (raw) => {
      let cwd = String(raw || '');
      if (cwd.startsWith('file://')) {
        try {
          const u = new URL(cwd);
          cwd = u.pathname;
          // Windows drive-letter form ("/C:/Users/…" → "C:/Users/…").
          if (/^\/[A-Za-z]:[\\/]/.test(cwd)) cwd = cwd.slice(1);
        } catch {
          cwd = cwd.replace(/^file:\/\/[^/]*/, '');
        }
      }
      try { cwd = decodeURIComponent(cwd); } catch {}
      if (cwd) onCwdRef.current?.(cwd);
      return true;
    });

    const ro = new ResizeObserver(() => safeFit(fitAddon, term, ptyId));
    ro.observe(container);

    return () => {
      ro.disconnect();
      titleDisp?.dispose?.();
      oscDisp?.dispose?.();
      unsubDataRef.current?.();
      try { term.dispose(); } catch {}
      window.api.pty.kill(ptyId);
      termRef.current = null;
      fitRef.current = null;
    };
  }, [ptyId]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = theme === 'light' ? LIGHT_THEME : DARK_THEME;
  }, [theme]);

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      safeFit(fitRef.current, termRef.current, ptyId);
      try { termRef.current?.focus(); } catch {}
    }, 0);
    return () => clearTimeout(t);
  }, [visible, ptyId]);

  return (
    <div
      className={
        'absolute inset-0 p-2 ' + (visible ? 'block' : 'invisible pointer-events-none')
      }
      aria-hidden={!visible}
    >
      <div ref={containerRef} className="w-full h-full rounded-lg overflow-hidden bg-ink-800 border border-ink-700 shadow-soft" />
    </div>
  );
});

export default TerminalView;
