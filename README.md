# Mdev

A desktop wrapper for the **Claude CLI / Claude Agent SDK** in a friendly multi-pane UI, with built-in support for routing through **DeepSeek** (or any Anthropic-compatible endpoint). Built with Electron + React 18 + Tailwind + xterm.js + node-pty + Monaco.

It does **not** call `api.anthropic.com` directly. Every agent runs through the Agent SDK's CLI, and the model provider is switchable — paste a DeepSeek API key in Settings and you're running DeepSeek models inside a full Claude Code experience.

## Features

- **Terminal tabs** — each is an independent `node-pty` session running the Claude Code TUI (and still a plain `zsh`/`bash`/PowerShell shell when Claude isn't running).
- **Agent tabs** — a native Agent SDK surface with rendered markdown, streaming output, and tool-permission prompts (`Cmd/Ctrl+Shift+A`).
- **Browser preview** — a side-pane `<webview>` for previewing a running dev server, plus a full-mode toggle. The agent can open and navigate it itself.
- **Code editor** — a Monaco-backed pane with syntax highlighting and save support.
- **File manager** — browse the active project and open files in the editor.
- **Voice dictation** — a mic button transcribes into the prompt via the Web Speech API.
- **Session sidebar** — every Claude session across your projects, with resume / hide / delete and a live context-window meter.
- **Five permission modes** — Ask / Plan / Act / Safe / Auto, hot-switchable mid-session.
- **Model picker** — Claude (Opus / Sonnet / Haiku, incl. 1M variants) plus custom providers.
- **Dark / light theme**.

## Requirements

- Node.js **20+**
- npm

The Agent SDK ships its own CLI binary, so you do **not** need a global `claude` install.

## Install

```bash
npm install
```

`node-pty` is a native module and is rebuilt against Electron's Node ABI automatically. If that step is skipped (or you change Electron versions), run:

```bash
npm run rebuild
```

## Configure a provider (DeepSeek)

Open **Settings** and paste a DeepSeek API key (base URL defaults to `https://api.deepseek.com/anthropic`). Models from any configured provider appear in the prompt-bar dropdown.

Under the hood this sets the standard `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` env vars on the spawned CLI, redirecting API calls to DeepSeek's Anthropic-compatible endpoint.

## Develop

```bash
npm run dev
```

Starts Vite on port 5173 and launches Electron once it's ready.

## Build

```bash
npm run dist   # macOS (.dmg)
```

Windows and macOS installers are also built automatically by the GitHub Actions workflow in `.github/workflows/build-windows.yml` — an NSIS `.exe` and a `.dmg`, uploaded as artifacts on every push to `main`, on version tags, and manually.

## The agent's tools (MCP)

Four in-process tools are exposed to every agent as `mcp__mdev__*`:

- `open_browser(url)` — open a new browser tab in the side pane (http/https only).
- `navigate_browser(url, [tabId])` — navigate the existing side-pane browser.
- `open_in_editor(path)` — open a file in the Monaco editor (absolute paths).
- `screenshot_browser([tabId])` — capture the rendered page as PNG **plus OCR text**, so the agent can visually verify a UI change even with a text-only model like DeepSeek.

URL validation runs in both the tool handler and the renderer (defense in depth); `file://` is currently blocked everywhere.

## Keyboard shortcuts

- `Cmd/Ctrl + Shift + A` — new agent tab
- `Cmd/Ctrl + N` — restart the current session
- `Esc` — focus the prompt bar

## Project layout

```
electron/
  main.js            Electron main process — PTY spawn, IPC, session/history store
  preload.js         contextBridge API exposed to the renderer
  agent-host.mjs     Agent SDK host + in-process MCP tools
src/
  App.jsx            Top-level layout, tabs, modes, keyboard shortcuts
  components/
    TerminalView.jsx    xterm.js host bound to one PTY
    AgentView.jsx       Agent SDK message stream UI
    BrowserView.jsx     side-pane <webview> preview
    EditorPane.jsx      Monaco editor
    FileManager.jsx     project file browser
    Sidebar.jsx         session/project history
    PromptBar.jsx       prompt input, mode/model pickers, context meter
    SettingsDialog.jsx  provider (API key / base URL) config
    PermissionDialog.jsx tool-permission prompts
  hooks/
    useSpeech.js        Web Speech API wrapper
  modelGroups.js        model constants + context-window ceilings
index.html             renderer entry
```

## Notes

- Uses `contextIsolation: true` and never enables `nodeIntegration`; the only renderer↔main surface is the typed `window.api` exposed in `preload.js`.
- Provider settings and preferences are stored locally (`localStorage` / Electron `userData`).
- Voice dictation uses the browser's native `SpeechRecognition`.
