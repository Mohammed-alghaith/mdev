# Option A — Native Agent UI via the Claude Agent SDK

Migrate the Code Generator app's conversation view from a raw PTY/xterm TUI to a
native React UI driven by the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`).
Messages, tool calls, and diffs become React components instead of ANSI escape
sequences. Claude Code is "packaged as a library" — we call `query(prompt, options)`
and consume a typed `SDKMessage` stream.

**Status:** feasibility confirmed (2026-08-14). This is the implementation plan.

---

## Goals / non-goals

**Goals**
- Replace `TerminalView` + PTY command plumbing with a structured agent message UI.
- Preserve the five permission modes (ask / plan / act / safe / auto) with equivalent semantics.
- Preserve the DeepSeek custom provider (env-var routing).
- Preserve the four app MCP tools + URL-scheme gating.
- Preserve session discovery, resume, and the context meter (transcripts still land in `~/.claude/projects/`).

**Non-goals (this pass)**
- Token-level streaming UI (`stream_event` / `includePartialMessages`) — do complete-turn rendering first.
- In-process MCP for *external* servers beyond the app's own four tools.
- Removing `node-pty`/`xterm` entirely — Fugu/codex and the plain shell tab still use the PTY (Phase 6 decision).

---

## Architecture decisions

### D1 — The SDK runs in the Electron **main process**, not the renderer
The SDK spawns the `claude` CLI as a subprocess, reads `process.env`, and writes
`~/.claude` transcripts — none of which a sandboxed renderer can do. The renderer
talks to an **agent host** in main over IPC, exactly like the existing `control:exec`
bridge. The SDK is ESM-only while `main.js` is CJS, so the host is a new
`electron/agent-host.mjs` loaded from `main.js` via dynamic `import()` (no need to
convert the 700-line `main.js` to ESM).

### D2 — One SDK session per tab, single-turn `query()` per submit
Each agent tab owns a session. `submitPrompt` runs one `query()` and `continue: true`
resumes the prior session in that tab's cwd (matching today's `--resume` semantics).
Single-turn is simpler than streaming-input mode and maps 1:1 onto the existing
tab/session model; a long-lived streaming-input `Query` (one warm subprocess per tab,
via `startup()` / `streamInput()`) is a later optimization.

### D3 — Event-driven IPC, mirroring `control:exec`/`control:reply`
Main pushes `agent:event` (one per `SDKMessage`) to the renderer; the renderer
accumulates them into per-tab state. For `canUseTool`/`AskUserQuestion`, main pauses
the query and sends `agent:permission`; the renderer shows a modal and replies
`agent:permission:reply`, which resolves the callback. This is the same shape as the
existing MCP control socket, minus the socket.

### D4 — MCP tools become in-process SDK `tool()` handlers
The four tools (`open_browser`, `navigate_browser`, `open_in_editor`,
`screenshot_browser`) are reimplemented as SDK `tool(name, description, schema, handler)`
handlers in the agent host. Each handler calls the **existing** `dispatchToRenderer()`
in `main.js` — so the `control:exec` renderer handler in `App.jsx` stays **unchanged**,
and the `mcp-server.js` stdio process + Unix socket go away. URL gating stays in two
layers: the tool handler (main) and the renderer handler.

### D5 — New `kind: 'agent'` tab, `terminal` kept for shell + Fugu
Claude/DeepSeek tabs become `kind: 'agent'` (rendered by a new `AgentView.jsx`).
`kind: 'terminal'` remains for the startup shell and the `codex`/Fugu path, which the
Agent SDK cannot drive. Phase 6 decides whether to drop Fugu or keep the PTY only for it.

### D6 — Packaging: `asarUnpack` the SDK's native binary
`@anthropic-ai/claude-agent-sdk` bundles the Claude Code CLI as an optional native
dependency (`@anthropic-ai/claude-agent-sdk-darwin-arm64` etc.). It must be unpacked
from the ASAR so the spawned subprocess can execute it. Add `asarUnpack` to the
`electron-builder` config in `package.json`.

---

## Phases

Each phase is independently shippable and ends with a verification step.

### Phase 0 — DeepSeek compatibility spike (de-risk first, ~30 min)

**Why first:** the SDK's `env` passthrough is documented for Anthropic-compatible
gateways, but DeepSeek's endpoint is not tested by the docs. Confirm it before building
UI around it.

- `npm i @anthropic-ai/claude-agent-sdk`
- Create `spike/deepseek-sdk.mjs`:

```js
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "Reply with exactly: OK",
  options: {
    model: "deepseek-v4-pro",
    cwd: process.cwd(),
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: process.env.DEEPSEEK_KEY,
    },
    permissionMode: "default",
    maxTurns: 3,
  },
});

for await (const m of q) {
  if (m.type === "result") console.log(m.subtype, m.result, m.total_cost_usd);
  else if (m.type === "assistant") console.log(JSON.stringify(m.message?.content));
}
```

- If it 400s, retry adding `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` and
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` to `env`, then a minimal read-only tool
  call to exercise tool-use round-trips.
- **Done (verified 2026-08-14):** both runs succeeded with **no compatibility flags** —
  `[result] subtype=success` for a trivial prompt, and a full `Bash` tool round-trip
  (`tool_use(Bash)` → `tool_result(ok)` → final answer). Findings that affect later phases:
  - DeepSeek streams a **thinking** trail — `system` messages with subtype
    `thinking_tokens` plus `assistant` content blocks of type `thinking`. Phase 2 must
    render these (collapsible "thinking" pane), not drop them.
  - `result.total_cost_usd` is the CLI's **internal Anthropic-rate estimate** (~$0.12 for
    a trivial reply, dominated by ~24K tokens of harness/system-prompt overhead), NOT
    DeepSeek's actual bill. Don't surface it as authoritative cost on custom providers.

### Phase 1 — SDK wiring + agent host + IPC + `agent` tab type

- **`package.json`**: add `asarUnpack` for the SDK native binary (and confirm the
  optional dep installs in the packaged build).
- **`electron/agent-host.mjs`** (new, ESM): owns the live `query()` per tab id.
  Exports:
  - `start(tabId, { cwd, model, mode, settings, resumeId, systemPromptChunks })` → begins
    a `query()` and streams each `SDKMessage` out via a callback.
  - `sendInput(tabId, text)` — for single-turn this is a new `query()` with `continue`/`resume`.
  - `interrupt(tabId)` — call `Query.interrupt()` on the in-flight query.
  - `resolvePermission(tabId, decision)` — resolve the paused `canUseTool` promise.
- **`electron/main.js`**: `const agentHost = await import('./agent-host.mjs')`, then IPC
  handlers `agent:start`, `agent:input`, `agent:stop`, `agent:permission:reply`, and push
  channels `agent:event`, `agent:permission`, `agent:result`, `agent:exit`. Reuse
  `windowForEvent()`/`sendToWindow()`.
- **`electron/preload.js`**: expose `window.api.agent.{ start, input, stop, replyPermission, onEvent, onPermission, onResult }`.
- **`src/App.jsx`**: add `createAgentTab({ cwd, title })` producing `{ id, kind: 'agent', project, title, sessionId }`;
  render `AgentView` for `kind === 'agent'` in the main pane (next to the existing
  `BrowserView`/`TerminalView` branch at `App.jsx:1151-1176`). Keep `activeTerminalId`
  logic working by adding an `activeAgentId` alongside it, or generalize to
  `mainPaneTab.id` for agent/terminal alike.
- **Done (verified 2026-08-14):** the full bridge works end-to-end. A new agent tab
  opens (Cmd+Shift+A, or the empty-state "New agent" button), PromptBar submit reaches
  the SDK, and the renderer renders accumulated messages as raw summaries in
  `AgentView`. `spike/host-test.mjs` drove `agent-host.submit()` against DeepSeek with a
  `Bash` round-trip → `result.subtype === success`. One deviation from the sketch above:
  the host exposes a single `submit(tabId, { text, options, onMessage, onResult, onExit })`
  that auto-resumes the tab's prior session (no separate `start`/`sendInput`), and IPC is
  `agent:submit`/`agent:stop` (not `agent:start`/`agent:input`). `permissionMode` is
  hardcoded to `"default"` until Phase 3.

### Phase 2 — Message rendering (`src/components/AgentView.jsx`)

- Replace `TerminalView` for agent tabs with `AgentView`, which accumulates
  `SDKMessage` events into a list and renders:
  - `assistant` → markdown text (add `react-markdown` or `marked`); also render
    `thinking` content blocks and `system` messages of subtype `thinking_tokens` in a
    collapsible "thinking" pane (DeepSeek streams these).
  - `tool_use` → collapsible card showing tool name + pretty-printed `input` JSON.
  - `tool_result` → collapsible result; for `Edit`/`Write`/`MultiEdit`, extract and
    render the diff/patch text as a diff view.
  - `result` → terminal status line (success / error subtype / cost).
- Auto-scroll, an in-progress spinner for the current turn, and an interrupt/stop button.
- **Done (verified 2026-08-14):** `AgentView` renders `assistant` text as markdown
  (`react-markdown` + `remark-gfm`, raw HTML inert by default), `thinking` blocks in
  collapsible panes (empty trailing thinking blocks filtered), `tool_use` cards
  (`Edit`/`Write`/`MultiEdit` as red/green diff views, others as pretty-printed JSON),
  `tool_result` cards (string or text/image array content), and a `result` status line
  (success/error subtype + duration + `~$cost est.`). Auto-scrolls; a floating Stop
  button (wired to `agent:stop`) appears while running. A `spike/shape-check.mjs` run
  confirmed DeepSeek's runtime fields (`thinking.thinking`, `Write.input.{file_path,
  content}`, `tool_result.content`, `result.result`) match the renderer.

### Phase 3 — Permissions (`canUseTool` + approval UI)

- Port the mode mapping from `buildClaudeCommand()` (`App.jsx:149-224`) into an options
  builder `buildAgentOptions({ mode, model, settings })`:

  | App mode | SDK options |
  |---|---|
  | ask | `permissionMode:"default"`, `allowedTools:[Read,Glob,Grep,WebFetch,WebSearch,TodoWrite,ExitPlanMode]`, `disallowedTools:[Edit,Write,MultiEdit,NotebookEdit,Bash,Task]`, system prompt (`ASK_SYSTEM_PROMPT`) |
  | plan | `permissionMode:"plan"` (+ `NON_ASK_OVERRIDE_PROMPT` on resume) |
  | act | `permissionMode:"default"`, `allowedTools:[Edit,Write,MultiEdit,NotebookEdit]` |
  | safe | `permissionMode:"default"`, `allowedTools:[SAFE list]` |
  | auto | `permissionMode:"bypassPermissions"`, `allowDangerouslySkipPermissions:true` |

  (`allowedTools`/`disallowedTools` become string arrays; the `Bash(cmd *)` glob syntax
  carries over unchanged. `--append-system-prompt` chunks become `systemPrompt` options
  — verify the SDK's `systemPrompt` append flag so `APP_TOOLS_HINT` stacks with the
  mode prompt.)
- Implement `canUseTool(toolName, input, { signal })` in the host: pause, emit
  `agent:permission`, await the renderer's `allow`/`deny`. Render an approval modal with
  the tool name + input. Special-case `toolName === "AskUserQuestion"` to render the
  question UI and return `{ behavior:"allow", updatedInput: { questions, answers } }`.
- Wire the PromptBar stop button to `agent.stop` (→ `interrupt()`).
- **Done (verified 2026-08-14):** `buildAgentOptions()` in `App.jsx` maps the five modes
  to SDK options (`permissionMode`, `allowedTools`/`disallowedTools` string arrays,
  `allowDangerouslySkipPermissions` for auto, `systemPrompt:{type:'preset',preset:'claude_code',append}`
  stacking the mode prompt + `APP_TOOLS_HINT`). The host bridges `canUseTool` through a
  `pendingPermissions` map keyed `${tabId}:${requestId}` (AbortSignal deny on interrupt,
  `resolvePermission()` from the `agent:permission:reply` IPC). `PermissionDialog.jsx`
  renders the approval modal + a full `AskUserQuestion` form (answers keyed by question
  text; multi-select comma-separated, per the SDK's `AskUserQuestionInput`/`Output` types).
  `spike/permission-test.mjs` drove `submit()` against DeepSeek and confirmed allow AND
  deny both fire `canUseTool` and settle without hanging (a denied `Write` even cascaded
  to a follow-up `Bash`, both handled).

### Phase 4 — MCP tools as in-process SDK tools

- In the agent host, define the four tools with the same names, descriptions, and
  schemas as `electron/mcp-server.js:23-82`, registering them via the SDK's `tool()` +
  `createSdkMcpServer()` (server name `code-generator`, so tools remain
  `mcp__code-generator__*`).
- Each handler validates args (URL gating mirrors `mcp-server.js::validateUrl`) and
  calls `dispatchToRenderer(command, args)` — reusing the existing socket→renderer
  plumbing minus the socket. `screenshot_browser` returns the existing
  `{ content: [{ type:"image", … }, …] }` shape.
- Delete `electron/mcp-server.js`, the `CONTROL_SOCK_PATH` server, and the socket
  cleanup in `main.js`.
- **Done (verified 2026-08-14):** the four tools are in-process SDK tools in
  `agent-host.mjs` (`tool()` + Zod schemas, `createSdkMcpServer({name:'code-generator',
  alwaysLoad:true})`, merged into every query's `mcpServers`). `setToolDispatcher()` lets
  `main.js` hand the host `dispatchToRenderer`, so the renderer's `control:exec`/`control:reply`
  handler is unchanged. URL gating lives in both the tool handler (`validateUrl`) and the
  renderer. Deleted `electron/mcp-server.js`, `.mcp.json`/`.mcp.json.example`, the
  `CONTROL_SOCK_PATH` socket server + `will-quit` unlink, and the `net` import; added `zod`
  to deps (SDK peer). `spike/mcp-tool-test.mjs` drove DeepSeek to call
  `mcp__code-generator__open_in_editor` → the mock dispatcher received
  `open_in_editor {path:'/tmp/phase4-test.txt'}` → a text `tool_result` came back (PASS).

### Phase 5 — Sessions, resume, context meter

- Resume: `Sidebar`'s `resumeSession` (`App.jsx:1019-1035`) becomes
  `createAgentTab({ cwd: session.project, resumeId: session.sessionId })`; the host
  passes `options.resume` on first submit. New-turn submits use `options.continue: true`.
- Session discovery: **unchanged** — the SDK writes transcripts to the same
  `~/.claude/projects/` tree, so `readClaudeSessions()`, the file watcher, and the
  Sidebar keep working.
- Context meter: keep the existing transcript-tail polling (`claude:sessionContext`), or
  optionally switch to `usage` from `result`/`system` init messages. Keep polling for now
  (no regression, works mid-stream).
- **Done (verified 2026-08-14):** `resumeSession` now opens an agent tab pinned to the
  session (`createAgentTab({ resumeId })`), dedupes against terminal + agent tabs, and the
  first submit passes `options.resume` — the host prefers an explicit resume over its own
  per-tab tracking and seeds `tabSessions` so later turns keep the session (spike
  `resume-test.mjs` PASSED). The context meter derives `activeSessionId` from agent tabs
  (`agentSessionByTab` + `tab.resumeId`) and tracks them. Multiple agent tabs are
  independent sessions.

### Phase 6 — Fugu decision + cleanup

- Decide Fugu: the Agent SDK is Claude-only, so `codex --profile` has no SDK path.
  **Decided (2026-08-14): remove Fugu.** `FUGU_MODELS`, `buildCodexCommand`, the codex
  branch of `commandAgentCli`, the `fugu`/`fugu-ultra` model groups, and all
  Fugu/Codex handling are gone (verified: no `fugu`/`codex` refs remain, `vite build`
  passes).
- **Done (2026-08-14):** "New Workspace" / "New Session in project" now open **agent**
  tabs (`focusOrSpawnFreshAgent` reuses a blank-slate agent tab or `createAgentTab`).
  `openProjects` includes agent workspaces and `activeCwd` is agent-aware, so the
  Sidebar shows/highlights them immediately.
- **Remaining (undecided):** the Claude PTY launch path is still reachable from shell
  tabs — `launchClaude` (▶ button), `restartActiveTab` (Cmd+N), and
  `relaunchActiveClaude` (model/mode hot-switch) all run `claude` in a PTY. Making the
  terminal shell-only would remove the paced Ctrl-C exit dance, the paste-detection
  workaround, `buildClaudeCommand`, `launchClaude`, and `restartActiveTab`'s PTY-kill
  path — but that changes what the ▶ button and Cmd+N do, so it's a separate decision.

---

## File-by-file change map

| File | Change |
|---|---|
| `package.json` | add `@anthropic-ai/claude-agent-sdk`; add `asarUnpack` for its native binary; add `react-markdown`/`marked` |
| `electron/agent-host.mjs` | **new** — SDK lifecycle, per-tab `query()`, `canUseTool` bridge, in-process MCP tools |
| `electron/main.js` | dynamic-import the host; add `agent:*` IPC; **remove** control socket + `mcp-server` wiring (Phase 4) |
| `electron/preload.js` | expose `window.api.agent` |
| `electron/mcp-server.js` | **delete** (Phase 4) |
| `src/components/AgentView.jsx` | **new** — message/tool/diff rendering + approval modal |
| `src/App.jsx` | add `createAgentTab`, render `AgentView`, port mode→options builder, rewire submit/stop/resume for agent tabs |
| `src/components/PromptBar.jsx` | minor: stop/launch semantics for agent tabs (likely no change to dropdowns) |
| `src/components/SettingsDialog.jsx` | reuse `buildProviderEnvPrefix` logic (or a new non-shell-quoted variant) to feed the SDK `env` |
| `src/components/TerminalView.jsx` | unchanged; scoped to Fugu/shell tabs only |

---

## Risks & rollback

- **DeepSeek field compatibility** — resolved by Phase 0 (no flags needed for basic
  query or Bash tool round-trip). Keep `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` /
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` in reserve if an edge-case request 400s.
- **`options.env` replaces the whole environment**: always spread `...process.env` or
  the spawned CLI loses `PATH`/`HOME`.
- **ESM/ASAR packaging**: if the native binary isn't unpacked, `query()` fails to spawn
  at runtime in the packaged app (works in dev). Verify with a packaged build early.
- **Session parity**: SDK session IDs and transcript format must match what the Sidebar/
  context meter already parse — confirmed same `~/.claude/projects/<encoded-cwd>/<id>.jsonl`.
- **Rollback**: phases are additive until Phase 6; the PTY path stays fully functional
  as a fallback until Claude tabs are switched to `kind: 'agent'`. No data migration.

## Follow-ups (after this lands)

- Token-level streaming (`includePartialMessages` → `stream_event` deltas).
- Warm subprocess per tab via `startup()` + streaming-input mode (fewer spawns, faster turns).
- Rich diff view (side-by-side, syntax-highlighted) instead of raw patch text.
- Surface `total_cost_usd`/`usage` per turn in the UI.
