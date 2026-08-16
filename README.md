# Code Generator

A lightweight desktop terminal that wraps the official **Claude CLI** (`@anthropic-ai/claude-code`) in a friendly UI. Built with Electron + React + Tailwind + xterm.js + node-pty.

The app **never** calls `api.anthropic.com` directly. It spawns the locally installed `claude` binary inside a child PTY, so it runs entirely on top of your existing Claude Pro/Max terminal subscription.

## Features

- **Multi-tab terminals** — each tab is an independent `node-pty` session.
- **Chat-style prompt bar** — large bottom textarea (Enter to send, Shift+Enter for newline) instead of a raw shell prompt.
- **Voice dictation** — built-in mic button uses the Web Speech API to transcribe locally into the input box.
- **Visual history sidebar** — every submitted prompt is saved; click to load, "Run again" to re-send.
- **System shell fallback** — when `claude` isn't running, the tab behaves as a normal `zsh`/`bash`/PowerShell session.

## Requirements

- Node.js **20+**
- npm or pnpm
- The Claude CLI installed globally and on your `PATH`:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude --version
  ```

## Install

```bash
npm install
```

`node-pty` is a native module and will be rebuilt against Electron's Node ABI by the `postinstall` script. If that step is skipped (or you change Electron versions), run:

```bash
npm run rebuild
```

## Develop

```bash
npm run dev
```

This starts Vite on port 5173 and launches Electron once it's ready.

## Build

```bash
npm run dist
```

Builds the renderer with Vite and packages the app via electron-builder.

## Project layout

```
electron/
  main.js         Electron main process — spawns node-pty, IPC, history store
  preload.js      Secure contextBridge API exposed to the renderer
src/
  App.jsx         Top-level layout, tab/state management
  components/
    TabBar.jsx       Tabs + new/close + sidebar toggle
    TerminalView.jsx xterm.js host bound to a single PTY
    Sidebar.jsx      Collapsible history panel
    PromptBar.jsx    Chat-style textarea + mic + send
  hooks/
    useSpeech.js  Web Speech API wrapper
index.html         Renderer entry
vite.config.js     Vite config
tailwind.config.js Tailwind theme
```

## Giving Claude control of the app (MCP)

The four app tools (`mcp__code-generator__*`) are defined in-process as Claude Agent SDK tools in `electron/agent-host.mjs` — no stdio server or `.mcp.json` setup required. Any Claude/DeepSeek agent tab (Cmd+Shift+A) can call them out of the box.

**Available tools:**
- `open_browser(url)` — open a new browser tab in the side pane. http(s) only.
- `navigate_browser(url, [tabId])` — navigate the existing side-pane browser instead of stacking a new tab. http(s) only.
- `open_in_editor(path)` — open a file in the Monaco editor pane. Absolute paths only.
- `screenshot_browser([tabId])` — capture a PNG of the rendered browser and return it inline so Claude can visually verify a UI change. This unlocks the "see your change and iterate" loop.

URL scheme validation runs in both the tool handler (main) and the renderer so Claude cannot bypass it. `file://` is currently blocked everywhere; we'll add an opt-in toggle for it later.

## Notes

- The app uses **`contextIsolation: true`** and never enables `nodeIntegration`. The only renderer↔main surface is the typed `window.api` exposed in `preload.js`.
- Command history is stored as plain JSON at `app.getPath('userData') + '/history.json'` (capped at 500 entries).
- The "▶" button in the prompt bar sends `claude\r` to the active tab to launch the CLI; you can also just type any shell command.
- Voice dictation uses the browser's native `SpeechRecognition`. On macOS Electron this connects to Apple's speech service.
