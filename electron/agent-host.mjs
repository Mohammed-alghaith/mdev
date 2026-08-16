// Agent host: runs the Claude Agent SDK in the Electron main process and
// bridges its message stream to the renderer over IPC.
//
// This file is ESM because the SDK (@anthropic-ai/claude-agent-sdk) is ESM-only.
// main.js (CommonJS) dynamic-imports it via `await import('./agent-host.mjs')`.
//
// One live query per tab. A tab's session ID persists across turns so each new
// submit resumes the prior session (the SDK writes transcripts to the same
// ~/.claude/projects/ tree the app already reads for its sidebar/context meter).
//
// Tool-permission decisions bridge through `canUseTool`: a query parks until the
// renderer replies via `resolvePermission()`. In `bypassPermissions` mode (the
// app's "auto" mode) this callback is never invoked.

import { z } from 'zod';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

// In the packaged Electron app the SDK is loaded from inside app.asar, and its
// internal resolution of the native CLI binary (relative to its own
// import.meta.url) yields a virtual `app.asar/node_modules/...` path. That path
// can't be spawned — child_process sees it as a file inside the asar archive,
// not a real executable — so query() parks forever before the CLI ever starts.
// We resolve the real on-disk binary (electron-builder unpacks it to
// app.asar.unpacked) and pass it explicitly. In dev (no resourcesPath) the SDK
// resolves it fine on its own, so we leave it alone.
function resolveClaudeBinary() {
  if (!process.resourcesPath) return null;
  const pkg = 'claude-agent-sdk-' + process.platform + '-' + process.arch;
  const bin = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    pkg,
    process.platform === 'win32' ? 'claude.exe' : 'claude',
  );
  return existsSync(bin) ? bin : null;
}

// tabId -> sessionId (persists across turns, used to resume)
const tabSessions = new Map();
// tabId -> { query, onMessage, onResult, onExit } (only while a query runs)
const active = new Map();
// Pending tool-permission requests, keyed `${tabId}:${requestId}`. canUseTool
// parks here until the renderer replies via resolvePermission().
const pendingPermissions = new Map();
let permissionCounter = 0;

// Guarantee structured-clone-safe payloads for webContents.send. SDK messages
// are plain data, but a JSON round-trip also strips any stray undefined/typed
// fields that would make Electron's structured clone throw.
function safeJson(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

// ─── in-process MCP tools ─────────────────────────────────────────────────
// The four app tools (open_browser / navigate_browser / open_in_editor /
// screenshot_browser) are reimplemented as in-process SDK tools instead of the
// old stdio MCP server + Unix socket. Each handler validates args (URL gating
// mirrors the old mcp-server.js::validateUrl) and forwards the call to the
// renderer via the dispatcher that main.js registers with setToolDispatcher().
// The renderer's control:exec / control:reply handler is unchanged.

let dispatchToRenderer = null;
export function setToolDispatcher(dispatch) { dispatchToRenderer = dispatch; }

// http(s) always; everything else blocked at the tool layer too, so the model
// can't bypass renderer-side validation by calling us directly.
function validateUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return 'url must be a non-empty string';
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return 'Only http:// and https:// URLs are allowed. Got: ' + trimmed.slice(0, 60);
  }
  return null;
}

// The renderer returns either a rich MCP content array (screenshot) or a plain
// value. Forward rich content as-is; wrap everything else in a single text block.
function toToolResult(result) {
  if (result && Array.isArray(result.content)) return result;
  return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
}

function buildAppTools() {
  return [
    tool('open_browser',
      'Open a new browser tab in the Mdev app to preview a URL. ' +
      'Use this to view a running dev server, documentation page, or any HTTP(S) URL. ' +
      "The tab opens in the app's side pane next to the user's terminal so they can see the page while you work. " +
      'Only http:// and https:// URLs are accepted.',
      { url: z.string() },
      async (args) => {
        const err = validateUrl(args.url);
        if (err) return { isError: true, content: [{ type: 'text', text: err }] };
        try { return toToolResult(await dispatchToRenderer('open_browser', args)); }
        catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message || e) }] }; }
      }),

    tool('navigate_browser',
      'Navigate the currently open browser tab to a new URL (instead of opening a fresh tab). ' +
      'Defaults to the browser in the side pane next to the terminal. ' +
      'Use this when you want to update the preview after a code change instead of stacking new tabs. ' +
      'Only http:// and https:// URLs are accepted.',
      { url: z.string(), tabId: z.string().optional() },
      async (args) => {
        const err = validateUrl(args.url);
        if (err) return { isError: true, content: [{ type: 'text', text: err }] };
        try { return toToolResult(await dispatchToRenderer('navigate_browser', args)); }
        catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message || e) }] }; }
      }),

    tool('open_in_editor',
      "Open a file in the app's code editor pane (Monaco-backed, with syntax highlighting and save support). " +
      "Use this when the user wants to read a file alongside their terminal, or when you want them to review a file you're discussing. " +
      'Path must be absolute. Files over 8MB and binary files are rejected.',
      { path: z.string() },
      async (args) => {
        if (typeof args.path !== 'string' || !args.path.trim()) {
          return { isError: true, content: [{ type: 'text', text: 'path must be a non-empty string' }] };
        }
        if (!path.isAbsolute(args.path)) {
          return { isError: true, content: [{ type: 'text', text: 'path must be absolute' }] };
        }
        try { return toToolResult(await dispatchToRenderer('open_in_editor', args)); }
        catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message || e) }] }; }
      }),

    tool('screenshot_browser',
      'Capture a PNG screenshot of the currently rendered browser tab. ' +
      'The result includes the image plus the on-screen text extracted by OCR, so you can read what the page shows without image vision. ' +
      'Use this to verify what the user is seeing after a UI change — the rendered output, not just the HTML. ' +
      'Defaults to the side-pane browser.',
      { tabId: z.string().optional() },
      async (args) => {
        try { return toToolResult(await dispatchToRenderer('screenshot_browser', args)); }
        catch (e) { return { isError: true, content: [{ type: 'text', text: String(e?.message || e) }] }; }
      }),
  ];
}

let appMcpServer = null;
// Lazily build the in-process server on first use. When no dispatcher is set
// (e.g. the spike tests), no server is created and no app tools are offered.
function appMcpServerConfig() {
  if (!dispatchToRenderer) return null;
  if (!appMcpServer) {
    appMcpServer = createSdkMcpServer({
      name: 'mdev',
      version: '0.1.0',
      alwaysLoad: true,
      tools: buildAppTools(),
    });
  }
  return appMcpServer;
}

// Park a canUseTool decision: emit the request to the renderer and resolve when
// it replies (or when the query's AbortSignal fires on interrupt).
function requestPermission(tabId, toolName, input, info, onPermission) {
  return new Promise((resolve) => {
    const requestId = 'perm-' + (++permissionCounter);
    const key = tabId + ':' + requestId;
    let settled = false;
    const settle = (decision) => {
      if (settled) return;
      settled = true;
      pendingPermissions.delete(key);
      resolve(decision);
    };
    // Interrupt/stop/new-submit aborts the in-flight query — deny so the loop
    // unwinds instead of parking forever.
    if (info?.signal) {
      info.signal.addEventListener('abort', () => settle({ behavior: 'deny', message: 'interrupted' }), { once: true });
    }
    pendingPermissions.set(key, { settle });
    // Forward the bridge's rich display fields so the renderer can show a human
    // prompt without reconstructing it from toolName + input.
    onPermission?.({
      tabId,
      requestId,
      toolName,
      input: safeJson(input),
      title: info?.title,
      displayName: info?.displayName,
      description: info?.description,
      blockedPath: info?.blockedPath,
      decisionReason: info?.decisionReason,
    });
  });
}

function denyPendingForTab(tabId) {
  const prefix = tabId + ':';
  for (const [key, rec] of pendingPermissions) {
    if (key.startsWith(prefix)) rec.settle({ behavior: 'deny', message: 'cancelled' });
  }
}

/**
 * Start (or continue) the agent for a tab.
 * @param {string} tabId
 * @param {{ text: string, options: object, onMessage: Function, onResult: Function, onExit: Function, onPermission: Function }} params
 * @returns {Promise<string|null>} the sessionId being resumed, or null for a new session
 */
export async function submit(tabId, { text, options = {}, onMessage, onResult, onExit, onPermission }) {
  // Stop any in-flight query for this tab before starting the next.
  await interrupt(tabId);

  const opts = { ...options };

  // The SDK's `env` option REPLACES the spawned process's environment, so we
  // merge the caller's overrides (e.g. ANTHROPIC_BASE_URL for DeepSeek) over the
  // main process's full env. When there are no overrides, omit env so the SDK
  // inherits process.env untouched.
  const overrides = opts.env && Object.keys(opts.env).length ? opts.env : null;
  if (overrides) opts.env = { ...process.env, ...overrides };
  else delete opts.env;

  // A caller-supplied resume id (Sidebar resume of a known session) wins over the
  // host's own per-tab tracking; otherwise resume the tab's prior session, or
  // start fresh. Seed tabSessions either way so later turns keep the same session.
  const explicitResume = opts.resume || null;
  delete opts.resume;
  const sessionId = explicitResume || tabSessions.get(tabId) || null;
  if (sessionId) {
    opts.resume = sessionId;
    tabSessions.set(tabId, sessionId);
  } else {
    delete opts.resume;
  }

  // Offer the app's in-process MCP tools on every query (when the main process
  // has registered a dispatcher). Merged under a fixed server name so the model
  // sees them as mcp__mdev__*; caller-supplied servers are preserved.
  const appServer = appMcpServerConfig();
  if (appServer) {
    opts.mcpServers = { ...(opts.mcpServers || {}), 'mdev': appServer };
  }

  // Point the SDK at the real unpacked CLI binary when packaged (see
  // resolveClaudeBinary above). Omitted in dev so the SDK resolves it itself.
  const claudeBinary = resolveClaudeBinary();
  if (claudeBinary) opts.pathToClaudeCodeExecutable = claudeBinary;

  // Bridge tool-permission decisions to the renderer. The SDK only calls this in
  // permission modes that prompt (default/acceptEdits/auto-classifier); under
  // bypassPermissions (the app's auto mode) it is skipped entirely.
  opts.canUseTool = (toolName, input, info) =>
    requestPermission(tabId, toolName, input, info, onPermission);

  const q = query({ prompt: text, options: opts });
  const rec = { query: q, onMessage, onResult, onExit };
  active.set(tabId, rec);

  (async () => {
    let error = null;
    try {
      for await (const msg of q) {
        // A newer submit superseded this query — stop forwarding.
        if (active.get(tabId) !== rec) return;

        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
          tabSessions.set(tabId, msg.session_id);
        }
        if (msg.type === 'result') {
          if (msg.session_id) tabSessions.set(tabId, msg.session_id);
          onResult?.(safeJson(msg));
        } else {
          onMessage?.(safeJson(msg));
        }
      }
    } catch (err) {
      error = String(err?.message || err);
    } finally {
      // Only the current query's completion means "this tab is now idle".
      if (active.get(tabId) === rec) {
        active.delete(tabId);
        denyPendingForTab(tabId);
        onExit?.({ tabId, sessionId: tabSessions.get(tabId), error });
      }
    }
  })();

  return sessionId;
}

export async function interrupt(tabId) {
  const rec = active.get(tabId);
  if (!rec) return;
  try { await rec.query.interrupt(); } catch {}
  // The interrupt should abort the in-flight canUseTool signal; this is a
  // belt-and-suspenders settle in case the abort hasn't propagated yet.
  denyPendingForTab(tabId);
}

/**
 * Resolve a parked tool-permission request. Called by main's
 * `agent:permission:reply` IPC handler with the renderer's decision
 * (`{ behavior: 'allow' }` / `{ behavior: 'allow', updatedInput }` / `{ behavior: 'deny', message }`).
 * @returns {boolean} true if a matching pending request was settled
 */
export function resolvePermission(tabId, requestId, decision) {
  const key = tabId + ':' + requestId;
  const rec = pendingPermissions.get(key);
  if (!rec) return false;
  rec.settle(decision);
  return true;
}

export function sessionIdFor(tabId) {
  return tabSessions.get(tabId) || null;
}
