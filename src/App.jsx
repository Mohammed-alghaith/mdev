import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import TabBar from './components/TabBar.jsx';
import TerminalView from './components/TerminalView.jsx';
import AgentView from './components/AgentView.jsx';
import PermissionDialog from './components/PermissionDialog.jsx';
import Sidebar from './components/Sidebar.jsx';
import FileManager from './components/FileManager.jsx';
import PromptBar from './components/PromptBar.jsx';
import { FALLBACK_MODEL_GROUPS } from './modelGroups.js';
import EditorPane from './components/EditorPane.jsx';
import BrowserView from './components/BrowserView.jsx';
import SettingsDialog, { KNOWN_PROVIDERS, enabledProviderModels, buildProviderEnvPrefix } from './components/SettingsDialog.jsx';
// import CommandPalette from './components/CommandPalette.jsx'; // TEMP disabled to isolate crash

function basename(p) {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

function extractResumeId(cmd) {
  if (!cmd) return null;
  const m = String(cmd).match(/--resume\s+([0-9a-f-]{8,})/i);
  return m ? m[1] : null;
}

// Three distinct experiences:
//   ask  — Read-only tools only + a system prompt telling Claude to refuse
//          state-changing requests and tell the user to switch to Act mode.
//   plan — Claude's native plan-mode (shows "plan mode on" banner).
//   act  — Autonomous; auto-accepts edits and commands.
const ASK_ALLOWED_TOOLS = 'Read,Glob,Grep,WebFetch,WebSearch,TodoWrite,ExitPlanMode';
// --allowed-tools is an auto-approve list, NOT an exclusive whitelist — Claude
// can still attempt Edit/Write/Bash and the user just sees a permission prompt.
// To make Ask mode truly read-only at the tool layer we ALSO deny the
// state-changing tools so the model literally cannot call them.
const ASK_DISALLOWED_TOOLS = 'Edit,Write,MultiEdit,NotebookEdit,Bash,Task';

// Tools auto-approved in Act mode — strictly file edits. Any Bash command
// must still prompt the user (that's the whole point of Act vs Safe).
const ACT_ALLOWED_TOOLS = 'Edit,Write,MultiEdit,NotebookEdit';

// Bash commands that are typical project-scoped work — auto-approved in Safe mode.
// Anything that can easily escape the workspace (rm, sudo, curl, wget, ssh, kill,
// chmod, chown, network installers, system pkg managers) is intentionally omitted
// so Claude still asks before running them.
// Claude Code uses `Tool(cmd *)` (space + glob) for prefix matching — NOT the
// colon-asterisk we tried earlier. Confirmed via `claude --help`.
const SAFE_ALLOWED_TOOLS = [
  // File edits — same auto-approvals as Act mode.
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  // Inspection (already auto-approved by default mode, listed for clarity).
  'Bash(ls *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)',
  'Bash(grep *)', 'Bash(rg *)', 'Bash(find *)', 'Bash(fd *)',
  'Bash(file *)', 'Bash(stat *)', 'Bash(wc *)', 'Bash(diff *)',
  'Bash(sort *)', 'Bash(uniq *)', 'Bash(pwd)', 'Bash(echo *)',
  'Bash(date)', 'Bash(env)', 'Bash(which *)',
  // Package / build tooling.
  'Bash(npm *)', 'Bash(npx *)', 'Bash(pnpm *)', 'Bash(yarn *)', 'Bash(bun *)',
  'Bash(git *)', 'Bash(gh *)',
  'Bash(python *)', 'Bash(python3 *)', 'Bash(pip *)',
  'Bash(node *)', 'Bash(deno *)', 'Bash(tsc *)',
  'Bash(go *)', 'Bash(cargo *)',
  'Bash(make *)', 'Bash(cmake *)',
  // Project-scoped file ops (intentionally NOT rm — that always prompts).
  'Bash(mkdir *)', 'Bash(touch *)', 'Bash(cp *)', 'Bash(mv *)',
].join(',');

const ASK_SYSTEM_PROMPT =
  "You are running in ASK mode inside the Mdev app. " +
  "You have only read-only tools available: Read, Grep, Glob, WebFetch, WebSearch, TodoWrite. " +
  "If the user asks you to do anything that changes state — edit or create files, run shell commands, install packages, refactor code, mkdir, git operations, etc. — DO NOT attempt workarounds with any tool. " +
  "Respond with exactly this sentence first: " +
  '"I\'m in Ask mode — I can only read code and answer questions. Switch to Act mode (bottom of the prompt bar) and resend, and I\'ll do that for you." ' +
  "Then optionally outline in 1-2 short bullets what you would do in Act mode. Be concise.";

// Counter-instruction appended whenever the user switches OUT of Ask mode while
// resuming a session. Required because --resume replays the prior Ask system
// prompt, otherwise Claude keeps refusing with "I'm in Ask mode" forever.
const NON_ASK_OVERRIDE_PROMPT =
  "MODE OVERRIDE: Disregard any previous instructions in this conversation about being in 'Ask mode' or refusing to perform actions. " +
  "Those instructions are no longer in effect. " +
  "Use whatever tools your current permissions allow to fulfill the user's request, and do NOT respond with 'I'm in Ask mode'.";

// Always-on hint about the MCP tools this app exposes. Appended to every
// `claude` invocation so the model prefers in-app tools over external ones
// (`open`, `xdg-open`, Playwright) without the user having to maintain a
// CLAUDE.md per project. Only takes effect inside this app — Claude sessions
// run outside the app aren't told about tools that don't exist there.
const APP_TOOLS_HINT =
  "You're running inside the Mdev desktop app, which exposes four MCP tools via " +
  "mcp__mdev__*: open_browser(url), navigate_browser(url), open_in_editor(path), " +
  "screenshot_browser(). " +
  "Prefer these over `open`, `xdg-open`, Playwright, or any external browser when the user asks " +
  "to preview, view, or open something visual. The side-pane browser sits next to the terminal so " +
  "the user can see the page while you work. After making UI changes, call screenshot_browser to " +
  "verify the result visually instead of asking the user to check.";

// Quote a string for use as a single argument inside a shell command line
// that will be piped through the PTY to bash/zsh.
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Custom provider models (e.g. DeepSeek) are defined in SettingsDialog.jsx.
// The KNOWN_PROVIDERS map, enabledProviderModels(), and buildProviderEnvPrefix()
// are imported from there.

function modelBase(model) {
  return String(model || '').split(':')[0];
}

// Resolve the completion endpoint for the prompt's inline ghost-text autofill.
// Custom providers (DeepSeek) carry their key + base URL in settings, so we can
// resolve them in the renderer. Anthropic (or the default model) has no key in
// settings — we return an `anthropic` marker and let the main process resolve
// auth via readClaudeAuth(). Returns null only for an unconfigured custom
// provider (a provider whose model is selected but whose key is missing).
function resolveCompletionConfig(model, settings) {
  const base = modelBase(model);
  for (const [id, prov] of Object.entries(KNOWN_PROVIDERS)) {
    const match = prov.models.find((m) => m.base === base);
    if (!match) continue;
    const cfg = settings?.providers?.[id];
    if (!cfg?.apiKey) return null;
    return {
      baseUrl: cfg.baseUrl || prov.defaultBaseUrl,
      apiKey: cfg.apiKey,
      model: base,
    };
  }
  return { model: base, anthropic: true };
}

function commandAgentCli(cmd) {
  // Search for the CLI name anywhere — custom provider commands have inline
  // env-var prefixes (e.g. "ANTHROPIC_BASE_URL='...' claude ...") so the
  // old anchor-based regex missed them.
  return /\bclaude\b/i.test(String(cmd || '')) ? 'claude' : '';
}

function buildClaudeCommand({ resumeId, mode, model, settings } = {}) {
  // The dropdown packs "<model>:<effort>" into a single value so a single
  // <select> drives both flags. Split here: "opus:high" -> base "opus",
  // effort "high"; "opus" -> base "opus"; "" -> neither.
  let base = modelBase(model);
  let effort = '';
  if (model) {
    const colon = model.indexOf(':');
    effort = colon === -1 ? '' : model.slice(colon + 1);
  }
  // Custom provider models use the claude CLI with inline ANTHROPIC_* env vars
  // that redirect API calls to a non-Anthropic endpoint (e.g. DeepSeek).
  const isCustomProvider = Object.values(KNOWN_PROVIDERS).some((p) =>
    p.models.some((m) => m.base === base)
  );
  let cmd = '';
  if (isCustomProvider) {
    const envPrefix = buildProviderEnvPrefix(base, settings);
    if (!envPrefix) return ''; // Auth not configured — bail, CLI will error
    cmd = envPrefix + 'claude';
  } else {
    cmd = 'claude';
  }
  if (resumeId) cmd += ' --resume ' + resumeId;
  if (mode === 'ask') {
    cmd += ' --allowed-tools "' + ASK_ALLOWED_TOOLS + '"';
    cmd += ' --disallowed-tools "' + ASK_DISALLOWED_TOOLS + '"';
    cmd += ' --append-system-prompt ' + shellQuote(ASK_SYSTEM_PROMPT);
  } else if (mode === 'plan') {
    cmd += ' --permission-mode plan';
    if (resumeId) cmd += ' --append-system-prompt ' + shellQuote(NON_ASK_OVERRIDE_PROMPT);
  } else if (mode === 'act') {
    // Default mode + allowlist for edits only. We intentionally do NOT use
    // --permission-mode acceptEdits here: that mode does its own static safety
    // check on Bash and silently auto-runs commands it deems safe (verified
    // via the "cannot be statically validated in acceptEdits mode" string in
    // the Claude binary). That makes Act indistinguishable from Safe.
    cmd += ' --permission-mode default';
    cmd += ' --allowed-tools "' + ACT_ALLOWED_TOOLS + '"';
    if (resumeId) cmd += ' --append-system-prompt ' + shellQuote(NON_ASK_OVERRIDE_PROMPT);
  } else if (mode === 'safe') {
    // Default mode + explicit allowlist (edits + curated project-scoped Bash).
    // Anything outside the allowlist (rm, sudo, curl, ssh, brew/apt, chmod,
    // dd, etc.) still prompts. Using `default` instead of `acceptEdits` keeps
    // the auto-approval set predictable — only what's listed below runs
    // unattended, never whatever Claude's heuristic decides is "safe enough".
    cmd += ' --permission-mode default';
    cmd += ' --allowed-tools "' + SAFE_ALLOWED_TOOLS + '"';
    if (resumeId) cmd += ' --append-system-prompt ' + shellQuote(NON_ASK_OVERRIDE_PROMPT);
  } else if (mode === 'auto') {
    // Full autonomy: skip every permission check (YOLO). The dedicated
    // --dangerously-skip-permissions flag bypasses without the interactive
    // "Yes, I accept" dialog that --permission-mode bypassPermissions shows.
    cmd += ' --dangerously-skip-permissions';
    if (resumeId) cmd += ' --append-system-prompt ' + shellQuote(NON_ASK_OVERRIDE_PROMPT);
  }
  // Always tell the model about the app's MCP tools regardless of mode. The
  // CLI accepts --append-system-prompt multiple times; each chunk is appended
  // in order, so this stacks cleanly with the mode-specific instructions above.
  cmd += ' --append-system-prompt ' + shellQuote(APP_TOOLS_HINT);
  // Both args are single-quoted: the 1M variants are spelled "opus[1m]" and
  // "sonnet[1m]", and zsh treats `[1m]` as a glob character class — unquoted,
  // it errors out with "zsh: no matches found: opus[1m]" before Claude ever
  // sees the flag.
  // Custom provider models skip --model and --effort — the model is communicated
  // via the ANTHROPIC_MODEL env var in the inline prefix, and effort is not
  // supported by non-Anthropic providers.
  if (base && !isCustomProvider) cmd += ' --model ' + shellQuote(base);
  if (effort && !isCustomProvider) cmd += ' --effort ' + shellQuote(effort);
  return cmd;
}

// Split the comma-joined allow/disallow lists into the string[] the SDK expects.
// The `Bash(cmd *)` glob entries carry no commas, so a plain split round-trips.
function splitTools(csv) {
  return csv.split(',').map((s) => s.trim()).filter(Boolean);
}

// Resolve the full Agent SDK options for an agent tab from the current mode,
// model, and settings — the Phase 3 port of buildClaudeCommand()'s flag logic.
// Returns null for an unconfigured custom provider. `isResume` mirrors the CLI's
// `--resume` branch: it decides whether to append the NON_ASK override (only
// needed when continuing a session that may carry a stale Ask-mode system prompt).
function buildAgentOptions({ mode, model, settings, isResume = false } = {}) {
  const base = modelBase(model);

  let env = {};
  for (const [id, prov] of Object.entries(KNOWN_PROVIDERS)) {
    const match = prov.models.find((m) => m.base === base);
    if (!match) continue;
    const cfg = settings?.providers?.[id];
    if (!cfg?.apiKey) return null; // not configured
    env = {
      ANTHROPIC_BASE_URL: cfg.baseUrl || prov.defaultBaseUrl,
      ANTHROPIC_AUTH_TOKEN: cfg.apiKey,
      ANTHROPIC_MODEL: base,
    };
    break;
  }

  const options = { permissionMode: 'default' };

  // Mode → permissionMode / allowedTools / disallowedTools / system prompt.
  const promptChunks = [];
  if (mode === 'ask') {
    options.allowedTools = splitTools(ASK_ALLOWED_TOOLS);
    options.disallowedTools = splitTools(ASK_DISALLOWED_TOOLS);
    promptChunks.push(ASK_SYSTEM_PROMPT);
  } else if (mode === 'plan') {
    options.permissionMode = 'plan';
    if (isResume) promptChunks.push(NON_ASK_OVERRIDE_PROMPT);
  } else if (mode === 'act') {
    options.allowedTools = splitTools(ACT_ALLOWED_TOOLS);
    if (isResume) promptChunks.push(NON_ASK_OVERRIDE_PROMPT);
  } else if (mode === 'safe') {
    options.allowedTools = splitTools(SAFE_ALLOWED_TOOLS);
    if (isResume) promptChunks.push(NON_ASK_OVERRIDE_PROMPT);
  } else if (mode === 'auto') {
    options.permissionMode = 'bypassPermissions';
    options.allowDangerouslySkipPermissions = true;
    if (isResume) promptChunks.push(NON_ASK_OVERRIDE_PROMPT);
  }
  // Always-on app-tools hint, appended after any mode prompt (mirrors the CLI's
  // repeated --append-system-prompt flags stacking in order).
  promptChunks.push(APP_TOOLS_HINT);
  options.systemPrompt = { type: 'preset', preset: 'claude_code', append: promptChunks.join('\n\n') };

  // Empty base = SDK default model → omit the key rather than send undefined.
  if (base) options.model = base;
  // Omit an empty env so the host leaves process.env untouched when no custom
  // provider is in play (Claude default / Anthropic model).
  if (Object.keys(env).length) options.env = env;

  return options;
}

let tabCounter = 1;
let browserCounter = 1;
let agentCounter = 1;

// A dropped file counts as an image if its MIME type says so, or (for drops
// that carry no MIME) if its extension is a known image type. These always
// route to the prompt input — the agent's context is their only destination.
function isImageFile(f) {
  if (!f) return false;
  const mime = String(f.type || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|tiff?|avif|heic|svg)$/i.test(String(f.name || ''));
}

export default function App() {
  const [tabs, setTabs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  // The main pane shows terminals + full-mode browser tabs. The side pane shows
  // side-mode browser tabs. We remember the most recently active tab of each
  // category so when the user focuses a tab in one slot, the other slot keeps
  // showing what it was already showing.
  const [lastMainTabId, setLastMainTabId] = useState(null);
  const [lastSideTabId, setLastSideTabId] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [filesOpen, setFilesOpen] = useState(true);
  const [sessions, setSessions] = useState([]);
  const [hiddenIds, setHiddenIds] = useState(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [cwdByTab, setCwdByTab] = useState({});
  const [input, setInput] = useState('');
  const [mode, setMode] = useState(() => localStorage.getItem('claude-mode') || 'ask');
  const [model, setModel] = useState(() => localStorage.getItem('claude-model') || '');
  const [settings, setSettings] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('claude-theme') || 'dark');
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Per-tab record of which model string was actually launched, so the UI can
  // confirm what's running (especially useful when "Default model" is selected).
  const [launchedModelByTab, setLaunchedModelByTab] = useState({});
  // Agent-tab state: accumulated SDK messages and running flag, per tab.
  const [agentMessagesByTab, setAgentMessagesByTab] = useState({});
  const [agentRunningByTab, setAgentRunningByTab] = useState({});
  // The session id each agent tab is currently on (set from onExit), used to
  // decide whether the next submit resumes and appends the NON_ASK override.
  const [agentSessionByTab, setAgentSessionByTab] = useState({});
  // Queue of pending tool-permission requests (from canUseTool). The head is
  // rendered as a modal; replying pops it and resolves the host-side promise.
  const [pendingPermissions, setPendingPermissions] = useState([]);
  // Whether the OS reports the network as offline. When it drops while an agent
  // turn is running we cancel the stuck request and show an "Offline" badge.
  const [offline, setOffline] = useState(typeof navigator !== 'undefined' && !navigator.onLine);
  const agentSessionByTabRef = useRef({});
  agentSessionByTabRef.current = agentSessionByTab;
  const promptBarRef = useRef(null);
  useEffect(() => { localStorage.setItem('claude-mode', mode); }, [mode]);
  useEffect(() => { localStorage.setItem('claude-model', model); }, [model]);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('claude-theme', theme);
  }, [theme]);
  const modeRef = useRef(mode);
  const modelRef = useRef(model);
  const settingsRef = useRef(settings);
  modeRef.current = mode;
  modelRef.current = model;
  settingsRef.current = settings;

  // Completion endpoint for the prompt bar's ghost-text autofill (null when the
  // active model is Anthropic or the custom provider has no key configured).
  const completionConfig = useMemo(() => resolveCompletionConfig(model, settings), [model, settings]);

  // Load provider settings once on mount.
  useEffect(() => {
    window.api?.settings?.get?.().then((s) => setSettings(s || {})).catch(() => {});
  }, []);
  const termRefs = useRef(new Map());
  const browserRefs = useRef(new Map());
  const tabsRef = useRef(tabs);
  const tabToSessionIdRef = useRef(new Map());

  // Per-tab "is Claude currently working" state. Set true on prompt submit,
  // back to false once PTY output goes quiet for ~2s (Claude finished
  // responding) or the user hits stop. Used to toggle the submit button into
  // a stop button (Cursor-style UX).
  const [runningByTab, setRunningByTab] = useState({});
  const runningTabsRef = useRef(new Set());
  const idleTimersRef = useRef(new Map()); // tabId -> timeout id

  const scheduleIdle = useCallback((id) => {
    const existing = idleTimersRef.current.get(id);
    if (existing) clearTimeout(existing);
    idleTimersRef.current.set(id, setTimeout(() => {
      idleTimersRef.current.delete(id);
      runningTabsRef.current.delete(id);
      setRunningByTab((m) => (m[id] === false ? m : { ...m, [id]: false }));
    }, 2000));
  }, []);

  const markRunning = useCallback((id) => {
    runningTabsRef.current.add(id);
    setRunningByTab((m) => (m[id] === true ? m : { ...m, [id]: true }));
    scheduleIdle(id);
  }, [scheduleIdle]);

  const markIdle = useCallback((id) => {
    runningTabsRef.current.delete(id);
    const t = idleTimersRef.current.get(id);
    if (t) { clearTimeout(t); idleTimersRef.current.delete(id); }
    setRunningByTab((m) => (m[id] === false ? m : { ...m, [id]: false }));
  }, []);

  const homeDir = window.api?.homeDir || '';

  const createTab = useCallback(async ({ cwd, runAfter, title } = {}) => {
    if (!window.api) return null;
    const { id: ptyId, shell, cwd: spawnedCwd } = await window.api.pty.create({ cwd, runAfter });
    const tabTitle = title || (spawnedCwd ? basename(spawnedCwd) : (shell ? shell.split(/[\\/]/).pop() : 'Terminal ' + tabCounter));
    const agentCli = commandAgentCli(runAfter);
    setTabs((prev) => [...prev, {
      id: ptyId,
      kind: 'terminal',
      title: tabTitle,
      ptyId,
      project: spawnedCwd || '',
      spawnTime: Date.now(),
      explicitSessionId: extractResumeId(runAfter),
      spawnedAgent: !!agentCli,
      spawnedAgentCli: agentCli,
      spawnedClaude: agentCli === 'claude',
    }]);
    setActiveId(ptyId);
    if (spawnedCwd) {
      setCwdByTab((m) => ({ ...m, [ptyId]: spawnedCwd }));
    }
    tabCounter += 1;
    return ptyId;
  }, []);

  const createBrowserTab = useCallback(({ url = '', view = 'side' } = {}) => {
    const id = 'browser-' + browserCounter++;
    setTabs((prev) => [...prev, {
      id,
      kind: 'browser',
      title: 'New Browser',
      url,
      view,
    }]);
    setActiveId(id);
    return id;
  }, []);

  const createAgentTab = useCallback(({ cwd, title, resumeId } = {}) => {
    const id = 'agent-' + agentCounter++;
    setTabs((prev) => [...prev, {
      id,
      kind: 'agent',
      title: title || (cwd ? basename(cwd) : 'Agent'),
      project: cwd || '',
      spawnTime: Date.now(),
      // A Sidebar-resumed tab is pinned to an existing session; the first submit
      // passes it as options.resume so the host resumes instead of starting fresh.
      resumeId: resumeId || null,
    }]);
    setActiveId(id);
    if (cwd) setCwdByTab((m) => ({ ...m, [id]: cwd }));
    return id;
  }, []);

  const updateTabUrl = useCallback((id, url) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, url } : t)));
  }, []);

  const toggleBrowserView = useCallback((id) => {
    setTabs((prev) => prev.map((t) => {
      if (t.id !== id || t.kind !== 'browser') return t;
      return { ...t, view: t.view === 'side' ? 'full' : 'side' };
    }));
    setActiveId(id);
  }, []);

  // Each rendering "slot" remembers the most recently focused tab of its kind
  // so focusing the side browser doesn't blank out the terminal, and vice versa.
  useEffect(() => {
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab) return;
    const isSide = tab.kind === 'browser' && tab.view === 'side';
    if (isSide) setLastSideTabId(activeId);
    else setLastMainTabId(activeId);
  }, [activeId, tabs]);

  const isSideTab = (t) => t?.kind === 'browser' && t?.view === 'side';

  const mainPaneTab = useMemo(() => {
    const active = tabs.find((t) => t.id === activeId);
    if (active && !isSideTab(active)) return active;
    const last = tabs.find((t) => t.id === lastMainTabId);
    if (last && !isSideTab(last)) return last;
    return tabs.find((t) => !isSideTab(t)) || null;
  }, [tabs, activeId, lastMainTabId]);

  const sidePaneTab = useMemo(() => {
    const active = tabs.find((t) => t.id === activeId);
    if (isSideTab(active)) return active;
    const last = tabs.find((t) => t.id === lastSideTabId);
    if (isSideTab(last)) return last;
    return tabs.find(isSideTab) || null;
  }, [tabs, activeId, lastSideTabId]);

  // Terminal ops (prompt bar input, claude launch/relaunch, cwd/session
  // derivation) always target the terminal currently visible in the main pane,
  // even when the user has focused the side browser.
  const activeTerminalId = mainPaneTab?.kind === 'terminal' ? mainPaneTab.id : null;
  const activeAgentId = mainPaneTab?.kind === 'agent' ? mainPaneTab.id : null;

  const openAgentTab = useCallback(() => {
    const cwd = mainPaneTab?.project || homeDir;
    createAgentTab({ cwd, title: cwd ? basename(cwd) : 'Agent' });
  }, [mainPaneTab, homeDir, createAgentTab]);

  // Subscribe to agent IPC events pushed from main. Each tab's messages accumulate
  // into agentMessagesByTab; the running flag clears when a turn's query exits.
  useEffect(() => {
    if (!window.api?.agent) return;
    const offEvent = window.api.agent.onEvent(({ tabId, message }) => {
      setAgentMessagesByTab((m) => ({ ...m, [tabId]: [...(m[tabId] || []), message] }));
    });
    const offResult = window.api.agent.onResult(({ tabId, message }) => {
      setAgentMessagesByTab((m) => ({ ...m, [tabId]: [...(m[tabId] || []), message] }));
    });
    const offExit = window.api.agent.onExit(({ tabId, sessionId, error }) => {
      setAgentRunningByTab((m) => (m[tabId] === false ? m : { ...m, [tabId]: false }));
      if (sessionId) setAgentSessionByTab((m) => ({ ...m, [tabId]: sessionId }));
      // Surface a host-side error as a failed result line so a silent hang
      // (e.g. the SDK never spawning its CLI) isn't invisible to the user.
      if (error) {
        setAgentMessagesByTab((m) => ({
          ...m,
          [tabId]: [...(m[tabId] || []), { type: 'result', subtype: 'error', errors: [error] }],
        }));
      }
      // The host denies any parked permission for this tab on exit; drop its
      // modal too so it can't linger as a stale prompt.
      setPendingPermissions((q) => q.filter((r) => r.tabId !== tabId));
    });
    const offPermission = window.api.agent.onPermission((payload) => {
      setPendingPermissions((q) => [...q, payload]);
    });
    return () => { offEvent(); offResult(); offExit(); offPermission(); };
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!window.api) return;
    const [list, hidden] = await Promise.all([
      window.api.claude.listSessions(),
      window.api.claude.listHidden(),
    ]);
    setSessions(list || []);
    setHiddenIds(new Set(hidden || []));
  }, []);

  const initRef = useRef(false);
  useEffect(() => {
    if (!window.api) return;
    if (initRef.current) return;
    initRef.current = true;

    refreshSessions();
    const unsub = window.api.claude.onSessionsUpdated((list) => setSessions(list || []));
    // Periodic fallback poll — covers any case the main-side file watcher misses.
    const poll = setInterval(refreshSessions, 4000);
    // Also refresh when the window regains focus.
    const onFocus = () => refreshSessions();
    window.addEventListener('focus', onFocus);
    return () => {
      unsub?.();
      clearInterval(poll);
      window.removeEventListener('focus', onFocus);
    };
  }, [createTab, refreshSessions]);

  // Whenever PTY output flows for a tab that's marked running, extend the
  // idle timer. Output stopping for 2s means Claude is done responding.
  useEffect(() => {
    if (!window.api) return;
    return window.api.pty.onData(({ id }) => {
      if (runningTabsRef.current.has(id)) scheduleIdle(id);
    });
  }, [scheduleIdle]);

  // Re-fetch whenever the active tab (and thus active workspace) changes.
  useEffect(() => {
    if (activeId) refreshSessions();
  }, [activeId, refreshSessions]);

  // MCP control bridge: the in-process SDK tools (agent-host.mjs) forward each
  // call to main via dispatchToRenderer, which fires 'control:exec' here. We
  // dispatch by command, validate args (URL scheme gating mirrors the tool-layer
  // validation in agent-host.mjs — defense in depth: if Claude ever bypasses the
  // tool layer the renderer still refuses), and reply with the same id.
  useEffect(() => {
    if (!window.api?.control) return;

    // Pick a browser ref to act on: explicit tabId arg, else the side-pane
    // browser, else any full-mode browser. Returns null if no browser exists.
    const resolveBrowserRef = (argTabId) => {
      const id = argTabId || sidePaneTabIdRef.current || (() => {
        const main = tabsRef.current.find((t) => t.id === mainPaneTabIdRef.current);
        return main?.kind === 'browser' ? main.id : null;
      })();
      if (!id) return null;
      return { id, ref: browserRefs.current.get(id) || null };
    };

    return window.api.control.onExec(async ({ id, command, args }) => {
      const reply = (ok, payload) => window.api.control.reply(id, ok, payload);
      try {
        if (command === 'open_browser') {
          const url = String(args?.url || '').trim();
          if (!url) throw new Error('url is required');
          if (!/^https?:\/\//i.test(url)) throw new Error('Only http:// and https:// URLs are allowed');
          const tabId = createBrowserTab({ url, view: 'side' });
          return reply(true, { tabId, url });
        }

        if (command === 'navigate_browser') {
          const url = String(args?.url || '').trim();
          if (!url) throw new Error('url is required');
          if (!/^https?:\/\//i.test(url)) throw new Error('Only http:// and https:// URLs are allowed');
          const target = resolveBrowserRef(args?.tabId);
          if (!target) throw new Error('No browser tab is open. Call open_browser first.');
          if (!target.ref) throw new Error('Browser tab is not mounted yet — try again in a moment.');
          target.ref.navigate(url);
          return reply(true, { tabId: target.id, url });
        }

        if (command === 'open_in_editor') {
          const filePath = String(args?.path || '').trim();
          if (!filePath) throw new Error('path is required');
          if (!filePath.startsWith('/')) throw new Error('path must be absolute (start with /)');
          if (!editorRef.current?.openFile) throw new Error('editor is not available');
          editorRef.current.openFile(filePath);
          return reply(true, { path: filePath });
        }

        if (command === 'screenshot_browser') {
          const target = resolveBrowserRef(args?.tabId);
          if (!target) throw new Error('No browser tab is open. Call open_browser first.');
          if (!target.ref) throw new Error('Browser tab is not mounted yet — try again in a moment.');
          const { base64, width, height } = await target.ref.capture();
          // DeepSeek is text-only and drops image blocks, so OCR the PNG locally
          // and include the recognized text. The image block is kept too — it's
          // harmless to text-only models and useful for vision models.
          let ocrText = '';
          try {
            const r = await window.api?.vision?.ocr(base64);
            ocrText = (r && r.text) || '';
          } catch {}
          const caption = ocrText
            ? `Screenshot of tab ${target.id} (${width}x${height})\n\nOCR text:\n${ocrText}`
            : `Screenshot of tab ${target.id} (${width}x${height}) — no readable text detected`;
          // Return MCP rich-content shape so the server forwards it as an image
          // block instead of stringifying. The server passes content through
          // unmodified when result.content is an array.
          return reply(true, {
            content: [
              { type: 'image', data: base64, mimeType: 'image/png' },
              { type: 'text', text: caption },
            ],
          });
        }

        throw new Error('Unknown command: ' + command);
      } catch (err) {
        reply(false, err);
      }
    });
  }, [createBrowserTab]);

  const closeTab = useCallback((id) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const closing = prev[idx];
      const next = prev.filter((t) => t.id !== id);
      if (id === activeId) {
        // Prefer a neighbor in the same slot — closing a side-browser shouldn't
        // randomly throw focus into the terminal.
        const isSideTab = (t) => t.kind === 'browser' && t.view === 'side';
        const sameSlot = isSideTab(closing)
          ? next.filter(isSideTab)
          : next.filter((t) => !isSideTab(t));
        const fallback = sameSlot[0] || next[idx] || next[idx - 1] || null;
        setActiveId(fallback ? fallback.id : null);
      }
      return next;
    });
    setLastMainTabId((prev) => (prev === id ? null : prev));
    setLastSideTabId((prev) => (prev === id ? null : prev));
    setCwdByTab((m) => {
      if (!(id in m)) return m;
      const { [id]: _drop, ...rest } = m;
      return rest;
    });
    termRefs.current.delete(id);
    browserRefs.current.delete(id);
    if (tabsRef.current.find((t) => t.id === id)?.kind === 'agent') {
      window.api?.agent?.stop(id);
      setAgentMessagesByTab((m) => { const { [id]: _drop, ...rest } = m; return rest; });
      setAgentRunningByTab((m) => { const { [id]: _drop, ...rest } = m; return rest; });
      setAgentSessionByTab((m) => { const { [id]: _drop, ...rest } = m; return rest; });
      setPendingPermissions((q) => q.filter((r) => r.tabId !== id));
    }
    runningTabsRef.current.delete(id);
    const t = idleTimersRef.current.get(id);
    if (t) { clearTimeout(t); idleTimersRef.current.delete(id); }
    setRunningByTab((m) => {
      if (!(id in m)) return m;
      const { [id]: _drop, ...rest } = m;
      return rest;
    });
  }, [activeId]);

  const setTermRef = (id, ref) => {
    if (ref) termRefs.current.set(id, ref);
    else termRefs.current.delete(id);
  };

  const writeToActive = useCallback((data) => {
    if (!activeTerminalId || !window.api) return;
    window.api.pty.write(activeTerminalId, data);
  }, [activeTerminalId]);

  const submitAgent = useCallback((tabId, text) => {
    if (!window.api?.agent) return;
    const tab = tabsRef.current.find((t) => t.id === tabId);
    // Whether the host will resume a prior session for this tab — mirrors the
    // CLI's `--resume` branch when deciding whether to append the NON_ASK
    // override prompt. A Sidebar-resumed tab counts from the start (its resumeId
    // is set before any turn runs), not just after the host records a session.
    const isResume = !!agentSessionByTabRef.current[tabId] || !!tab?.resumeId;
    const options = buildAgentOptions({
      mode: modeRef.current,
      model: modelRef.current,
      settings: settingsRef.current,
      isResume,
    });
    if (!options) {
      // An unconfigured custom provider — the SDK can't drive it.
      setAgentRunningByTab((m) => ({ ...m, [tabId]: false }));
      return;
    }
    options.cwd = tab?.project || homeDir;
    // Pin a resumed tab to its session on the first submit (the host prefers an
    // explicit resume over its own per-tab tracking and seeds it for later turns).
    if (tab?.resumeId) options.resume = tab.resumeId;
    setAgentRunningByTab((m) => ({ ...m, [tabId]: true }));
    setAgentMessagesByTab((m) => ({
      ...m,
      [tabId]: [...(m[tabId] || []), { type: 'user-prompt', text }],
    }));
    window.api.agent.submit(tabId, text, options).catch(() => {
      setAgentRunningByTab((m) => ({ ...m, [tabId]: false }));
    });
  }, [homeDir]);

  const submitPrompt = useCallback((text) => {
    if (activeAgentId) {
      if (text && text.trim()) {
        submitAgent(activeAgentId, text);
        setInput('');
      }
      return;
    }
    if (!activeTerminalId) return;
    // Two writes, not one. A single `text + '\r'` burst gets detected as a
    // paste by Claude Code's TUI — pasted content lands in the input buffer
    // but doesn't auto-submit (same as Cmd+V'ing a block). Sending the Enter
    // on a separate tick makes the TUI treat it as a discrete keypress and
    // actually fire submit.
    writeToActive(text);
    setTimeout(() => writeToActive('\r'), 60);
    markRunning(activeTerminalId);
    setInput('');
    // Hand focus to the terminal so the user can navigate Claude's permission
    // prompts with arrows/Enter right away. Typing is still swallowed by the
    // TerminalView filter, so this can't cause accidental input — and Esc
    // returns focus to the prompt bar when it's time to type again.
    termRefs.current.get(activeTerminalId)?.focus?.();
  }, [activeAgentId, activeTerminalId, submitAgent, writeToActive, markRunning]);

  const stopAgent = useCallback((tabId) => {
    if (window.api?.agent) window.api.agent.stop(tabId);
    setAgentRunningByTab((m) => (m[tabId] === false ? m : { ...m, [tabId]: false }));
    // Interrupt denies any parked permission for this tab in the host; drop its
    // modal here so the queue doesn't hold a stale, unanswerable request.
    setPendingPermissions((q) => q.filter((r) => r.tabId !== tabId));
  }, []);

  // Latest running-state mirror so the offline handler (a stable event listener)
  // can read current running tabs without re-subscribing on every turn.
  const agentRunningRef = useRef(agentRunningByTab);
  agentRunningRef.current = agentRunningByTab;

  // When the OS drops offline, cancel any in-flight agent turn (it would hang on
  // a dead network — agent:exit never fires) and surface an "Offline" badge.
  useEffect(() => {
    const goOffline = () => {
      setOffline(true);
      for (const [id, isRunning] of Object.entries(agentRunningRef.current)) {
        if (isRunning) stopAgent(id);
      }
    };
    const goOnline = () => setOffline(false);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, [stopAgent]);

  // Resolve a pending permission request. `decision` is an SDK PermissionResult
  // ({ behavior:'allow' } | { behavior:'allow', updatedInput } | { behavior:'deny', message }).
  const replyPermission = useCallback((req, decision) => {
    if (!req) return;
    window.api?.agent?.replyPermission(req.tabId, req.requestId, decision);
    setPendingPermissions((q) => q.filter((r) => r.requestId !== req.requestId));
  }, []);

  const stopActiveAgent = useCallback(() => {
    if (activeAgentId) { stopAgent(activeAgentId); return; }
    if (!activeTerminalId || !window.api) return;
    // Single Ctrl+C cancels Claude's current response and returns to prompt.
    // (Double Ctrl+C is the exit chord — relaunchActiveClaude handles that
    // case separately when switching modes.)
    window.api.pty.write(activeTerminalId, '\x03');
    markIdle(activeTerminalId);
  }, [activeAgentId, activeTerminalId, markIdle, stopAgent]);

  const launchClaude = useCallback(() => {
    if (!activeTerminalId) return;
    const cmd = buildClaudeCommand({ mode: modeRef.current, model: modelRef.current, settings: settingsRef.current });
    writeToActive(cmd + '\r');
    // Record which model actually launched for this tab.
    setLaunchedModelByTab((m) => ({ ...m, [activeTerminalId]: modelRef.current }));
  }, [activeTerminalId, writeToActive]);

  // Kill the current PTY, spawn a fresh one in the same project, and re-launch
  // Claude with the current model/mode. Used by Cmd+N and the command palette.
  const restartActiveTab = useCallback(() => {
    if (!activeTerminalId || !window.api) return;
    const tab = tabsRef.current.find((t) => t.id === activeTerminalId);
    if (!tab || tab.kind !== 'terminal') return;
    const cwd = cwdByTab[activeTerminalId] || tab.project || '';
    const cmd = buildClaudeCommand({ mode: modeRef.current, model: modelRef.current, settings: settingsRef.current });
    // Kill old PTY — the TerminalView cleanup will fire.
    window.api.pty.kill(activeTerminalId);
    // Spawn a fresh tab in the same project, then close the old one.
    createTab({ cwd, runAfter: cmd, title: tab.title }).then((newId) => {
      if (newId) {
        setLaunchedModelByTab((m) => ({ ...m, [newId]: modelRef.current }));
        closeTab(activeTerminalId);
      }
    });
  }, [activeTerminalId, cwdByTab, createTab, closeTab]);

  // ─── Global keyboard shortcuts ───
  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      // Escape — focus the prompt bar from anywhere in the app.
      if (e.key === 'Escape' && !mod && !e.shiftKey) {
        // Don't steal Escape from open dialogs / modals.
        if (settingsOpen || paletteOpen) return;
        e.preventDefault();
        promptBarRef.current?.focus();
        return;
      }
      if (!mod) return;
      // Cmd+K / Ctrl+K — command palette.
      if (e.key === 'k' && !e.shiftKey) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // Cmd+N / Ctrl+N — restart session in current tab (new Claude instance).
      if (e.key === 'n' && !e.shiftKey) {
        e.preventDefault();
        restartActiveTab();
      }
      // Cmd+Shift+A / Ctrl+Shift+A — open a new agent tab.
      if (e.key.toLowerCase() === 'a' && e.shiftKey) {
        e.preventDefault();
        openAgentTab();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [settingsOpen, paletteOpen, restartActiveTab, openAgentTab]);

  // Cursor-style hot mode/model switching. Cancels any in-flight previous
  // relaunch, dismisses any open dialog with Esc, exits the TUI with paced
  // Ctrl-C keypresses, then clears the scrollback and runs
  // `claude --resume <id> --<flags>` so races don't double-fire.
  const relaunchTimerRef = useRef(null);
  const relaunchExitTimersRef = useRef([]);
  const relaunchActiveClaude = useCallback((newMode, newModel) => {
    if (!activeTerminalId || !window.api) return false;
    const tab = tabsRef.current.find((t) => t.id === activeTerminalId);
    if (!tab) return false;
    const sid = tab.explicitSessionId || tabToSessionIdRef.current.get(activeTerminalId) || null;
    const agentIsRunning = tab.spawnedAgent || tab.spawnedClaude || !!sid;
    if (!agentIsRunning) return false;

    // Abort whatever the previous click queued up so we don't double-launch.
    if (relaunchTimerRef.current) {
      clearTimeout(relaunchTimerRef.current);
      relaunchTimerRef.current = null;
    }
    if (relaunchExitTimersRef.current.length) {
      for (const t of relaunchExitTimersRef.current) clearTimeout(t);
      relaunchExitTimersRef.current = [];
    }

    // Exit Claude without leaving a "/exit" user message in the session
    // transcript (otherwise --resume replays "Goodbye!" / "Bye!" / etc.).
    //
    // Why paced one-key-at-a-time instead of one burst: a single PTY write
    // like "\x1b\x03\x03" can be coalesced into one keypress by the TUI's
    // input parser, so the "press Ctrl-C again to exit" path never fires.
    //
    // Why Ctrl-C twice (and a third for safety) instead of Ctrl-D: inside
    // Claude's TUI \x04 is just a keypress, not an EOF signal — it does NOT
    // exit the session. Ctrl-C twice is Claude's documented exit chord.
    //   Ctrl-C #1: cancels any in-flight stream / clears half-typed input
    //   Ctrl-C #2: triggers "press Ctrl-C again to exit"
    //   Ctrl-C #3: confirms exit (only needed when #1 cleared input, so #2
    //              is the one that triggered the prompt)
    const write = (data) => {
      try { window.api.pty.write(activeTerminalId, data); } catch {}
    };
    write('\x1b'); // Esc — dismiss any open dialog (bypass-perms confirm, etc.)
    relaunchExitTimersRef.current.push(
      setTimeout(() => write('\x03'), 120),
      setTimeout(() => write('\x03'), 320),
      setTimeout(() => write('\x03'), 520),
    );

    const cmd = buildClaudeCommand({ resumeId: sid, mode: newMode, model: newModel, settings: settingsRef.current });
    relaunchTimerRef.current = setTimeout(() => {
      try {
        // Wipe xterm's screen + scrollback buffer (`clear` alone keeps scrollback).
        termRefs.current.get(activeTerminalId)?.clear?.();
        // \x15 kills any stray input at the shell prompt before we run.
        window.api.pty.write(activeTerminalId, '\x15' + cmd + '\r');
        setLaunchedModelByTab((m) => ({ ...m, [activeTerminalId]: newModel }));
      } catch {}
      relaunchTimerRef.current = null;
      relaunchExitTimersRef.current = [];
    }, 2800);
    return true;
  }, [activeTerminalId]);

  const handleModeChange = useCallback((newMode) => {
    if (newMode === modeRef.current) return;
    setMode(newMode);
    // Hot-switch the running Claude session to the new mode immediately.
    // Falls through silently (false) when no agent is running — the new
    // mode then takes effect on the next manual launch.
    relaunchActiveClaude(newMode, modelRef.current);
  }, [relaunchActiveClaude]);

  const handleModelChange = useCallback((newModel) => {
    if (newModel === modelRef.current) return;
    setModel(newModel);
    // Hot-switch the running Claude session to the new model immediately.
    // Falls through silently (false) when no agent is running — the new
    // model then takes effect on the next manual launch.
    relaunchActiveClaude(modeRef.current, newModel);
  }, [relaunchActiveClaude]);

  // If there's already a blank-slate agent tab in this project (no session
  // linked, not pinned to a resume), switch to it instead of spawning a
  // duplicate. Otherwise open a fresh agent tab; its first prompt starts a new
  // session in that cwd.
  const focusOrSpawnFreshAgent = useCallback(async (project) => {
    if (!project) return;
    const existing = tabsRef.current.find(
      (t) => t.kind === 'agent' &&
        t.project === project &&
        !t.resumeId &&
        !agentSessionByTabRef.current[t.id]
    );
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    createAgentTab({ cwd: project, title: basename(project) });
  }, [createAgentTab]);

  const newWorkspace = useCallback(async () => {
    if (!window.api) return;
    const folder = await window.api.dialog.pickFolder();
    if (!folder) return;
    await focusOrSpawnFreshAgent(folder);
  }, [focusOrSpawnFreshAgent]);

  const newSessionInProject = useCallback(async (project) => {
    await focusOrSpawnFreshAgent(project);
  }, [focusOrSpawnFreshAgent]);

  const setSessionHidden = useCallback(async (sessionId, hidden) => {
    if (!window.api || !sessionId) return;
    const next = await window.api.claude.setHidden(sessionId, hidden);
    setHiddenIds(new Set(next || []));
  }, []);

  const deleteSession = useCallback(async (session) => {
    if (!window.api || !session?.sessionId) return;
    const r = await window.api.claude.deleteSession(session.sessionId, session.project);
    if (r?.ok) await refreshSessions();
  }, [refreshSessions]);

  const activeCwd = activeTerminalId
    ? cwdByTab[activeTerminalId] || ''
    : activeAgentId
      ? cwdByTab[activeAgentId] || ''
      : '';

  // History alone cannot represent a newly opened workspace until its first
  // Claude prompt is submitted. Include every currently open workspace (agent
  // tabs, plus terminal tabs where an agent was launched) so it appears in the
  // sidebar immediately.
  const openProjects = useMemo(() => {
    const projects = new Set();
    for (const tab of tabs) {
      if (tab.kind === 'agent') {
        const cwd = cwdByTab[tab.id] || tab.project;
        if (cwd) projects.add(cwd);
        continue;
      }
      if (tab.kind !== 'terminal') continue;
      // Only workspaces where an agent was launched count as "projects" — a
      // plain shell tab (e.g. the home-dir shell opened at startup) is not a
      // Claude workspace and would otherwise show up as a phantom group.
      // Tabs with history sessions already appear via the sessions loop.
      if (!tab.spawnedAgent && !tab.spawnedClaude) continue;
      const cwd = cwdByTab[tab.id] || tab.project;
      if (cwd) projects.add(cwd);
    }
    return Array.from(projects);
  }, [tabs, cwdByTab]);

  // For each tab, work out which Claude session it's currently running:
  //   - explicit: parsed from `claude --resume <id>` at spawn time
  //   - inferred: the latest session in tab.project whose firstTimestamp >= tab.spawnTime
  const tabToSessionId = useMemo(() => {
    const map = new Map();
    for (const tab of tabs) {
      if (tab.explicitSessionId) { map.set(tab.id, tab.explicitSessionId); continue; }
      if (!tab.project || !tab.spawnTime) continue;
      let best = null;
      for (const s of sessions) {
        if (s.project !== tab.project) continue;
        if (s.firstTimestamp < tab.spawnTime - 5000) continue;
        if (!best || s.firstTimestamp > best.firstTimestamp) best = s;
      }
      if (best) map.set(tab.id, best.sessionId);
    }
    return map;
  }, [tabs, sessions]);

  const openSessionIds = useMemo(
    () => new Set(Array.from(tabToSessionId.values()).filter(Boolean)),
    [tabToSessionId]
  );
  const activeSessionId = activeTerminalId
    ? tabToSessionId.get(activeTerminalId) || ''
    : activeAgentId
      ? (agentSessionByTab[activeAgentId] || mainPaneTab?.resumeId || '')
      : '';
  const activeTabProject = (mainPaneTab?.kind === 'terminal' || mainPaneTab?.kind === 'agent')
    ? (mainPaneTab.project || '')
    : '';
  // The context meter is backed by ~/.claude transcripts, so keep it scoped to
  // Claude tabs (terminal or agent).
  const claudeActiveHere = !!(
    (mainPaneTab?.kind === 'terminal' && (mainPaneTab.spawnedClaude || activeSessionId)) ||
    (mainPaneTab?.kind === 'agent' && activeSessionId)
  );

  // Keep refs in sync so callbacks can read the latest state without re-creating.
  tabsRef.current = tabs;
  tabToSessionIdRef.current = tabToSessionId;
  // Refs for the MCP control handler — it's subscribed once on mount but
  // needs to know the current side/main pane tabs each time a tool fires.
  const sidePaneTabIdRef = useRef(null);
  const mainPaneTabIdRef = useRef(null);
  sidePaneTabIdRef.current = sidePaneTab?.id || null;
  mainPaneTabIdRef.current = mainPaneTab?.id || null;

  // Live context-window usage for the active session. We poll the transcript
  // file every 2.5s while a session is active — short enough that the number
  // visibly updates after each Claude reply, cheap enough that scanning the
  // tail of a JSONL doesn't show up in profiles.
  const [contextUsage, setContextUsage] = useState(null);
  useEffect(() => {
    if (!window.api || !activeSessionId) { setContextUsage(null); return; }
    let cancelled = false;
    const tick = async () => {
      try {
        const usage = await window.api.claude.sessionContext(activeSessionId, activeTabProject);
        if (!cancelled) setContextUsage(usage);
      } catch {}
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeSessionId, activeTabProject]);

  // The file manager has its own "browse target" — defaults to the active tab's cwd,
  // but clicking a project in the sidebar pins it to that project. It re-follows the
  // active tab whenever the active tab's cwd changes (cd, tab switch, new tab).
  const [fileBrowseCwd, setFileBrowseCwd] = useState('');
  useEffect(() => {
    if (activeCwd) setFileBrowseCwd(activeCwd);
  }, [activeCwd]);
  const browseProject = useCallback((project) => {
    if (project) setFileBrowseCwd(project);
  }, []);

  const editorRef = useRef(null);
  const [editorEmpty, setEditorEmpty] = useState(true);
  const openInEditor = useCallback((p) => {
    editorRef.current?.openFile(p);
  }, []);

  // ─── Drag-and-drop: route by drop zone ───
  // 'terminal' pastes paths to the active terminal; 'editor' opens them in
  // Monaco; 'prompt' (the fallback for anywhere else) inserts @<path> into the
  // prompt so Claude reads each file as context. Quote paths with spaces for
  // shell pasting; @path syntax doesn't need quoting.
  const [dragOverZone, setDragOverZone] = useState(null);

  const handleFilesDrop = useCallback((files, zone) => {
    // Electron 32+ stripped File.path. Resolve via the preload-exposed
    // webUtils.getPathForFile; falling back to f.path for any older builds.
    const resolvePath = (f) =>
      (window.api?.getPathForFile && window.api.getPathForFile(f)) || f.path || '';
    const list = Array.from(files || []);
    const images = list.filter(isImageFile).map(resolvePath).filter(Boolean);
    const others = list.filter((f) => !isImageFile(f)).map(resolvePath).filter(Boolean);

    // @path tokens — Claude Code expands these into file/image attachments.
    const insertIntoPrompt = (paths) => {
      const inserted = paths.map((p) => '@' + p).join(' ');
      setInput((prev) => (prev ? prev + ' ' + inserted : inserted));
    };

    // Images always feed the prompt, no matter which pane they land on.
    if (images.length) insertIntoPrompt(images);
    if (!others.length) return;

    if (zone === 'editor') {
      for (const p of others) editorRef.current?.openFile(p);
      return;
    }
    if (zone === 'terminal') {
      const text = others.map((p) => (/\s/.test(p) ? '"' + p + '"' : p)).join(' ');
      if (activeTerminalId && window.api) window.api.pty.write(activeTerminalId, text);
      return;
    }
    // Default: non-image files dropped elsewhere feed the prompt as @path.
    insertIntoPrompt(others);
  }, [activeTerminalId]);

  // Document-level guard: without this, dropping a file outside any drop zone
  // would make Chromium try to navigate to file:// and Electron would block
  // it with no visible effect. Also catches the "missed all zones" case by
  // routing to the prompt input as a friendly fallback.
  useEffect(() => {
    const onDragOver = (e) => e.preventDefault();
    const onDrop = (e) => {
      e.preventDefault();
      // If no React handler claimed it (no stopPropagation called), it
      // reaches us here — route to prompt as fallback.
      if (e.defaultPrevented && e.dataTransfer?.files?.length) {
        handleFilesDrop(e.dataTransfer.files, 'prompt');
      }
    };
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    };
  }, [handleFilesDrop]);

  // Helper to build the per-pane drop handlers — keeps the JSX readable and
  // handles the dragleave-fires-on-child-entry flicker via contains() check.
  const dropZoneProps = useCallback((zone) => ({
    onDragOver: (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (dragOverZone !== zone) setDragOverZone(zone);
    },
    onDragLeave: (e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      setDragOverZone((cur) => (cur === zone ? null : cur));
    },
    onDrop: (e) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOverZone(null);
      handleFilesDrop(e.dataTransfer.files, zone);
    },
  }), [dragOverZone, handleFilesDrop]);

  // Horizontal splits for the side (browser) and editor panes. Each is
  // persisted as a percentage of the main area's width. Clamped to keep
  // the leftmost (main) pane visible when both side and editor are open.
  const [editorPct, setEditorPct] = useState(() => {
    const v = Number(localStorage.getItem('editor-split-pct'));
    return Number.isFinite(v) && v >= 15 && v <= 85 ? v : 50;
  });
  const [sidePct, setSidePct] = useState(() => {
    const v = Number(localStorage.getItem('side-split-pct'));
    return Number.isFinite(v) && v >= 15 && v <= 70 ? v : 40;
  });
  useEffect(() => { localStorage.setItem('editor-split-pct', String(editorPct)); }, [editorPct]);
  useEffect(() => { localStorage.setItem('side-split-pct', String(sidePct)); }, [sidePct]);
  const splitRef = useRef(null);
  // Tracks which splitter is being dragged: 'editor' | 'side' | null.
  const draggingRef = useRef(null);
  // Mirror in state so the JSX can render an overlay during drag. Electron
  // <webview> tags capture mouse events the moment the cursor enters them,
  // so without an overlay the mousemove listener never fires and splitters
  // appear frozen.
  const [dragging, setDragging] = useState(null);
  // Refs read inside the once-mounted mousemove handler — keep them current.
  const editorPctRef = useRef(editorPct);
  const editorEmptyRef = useRef(editorEmpty);
  editorPctRef.current = editorPct;
  editorEmptyRef.current = editorEmpty;
  const onEditorSplitDown = useCallback((e) => {
    draggingRef.current = 'editor';
    setDragging('editor');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  }, []);
  const onSideSplitDown = useCallback((e) => {
    draggingRef.current = 'side';
    setDragging('side');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  }, []);
  useEffect(() => {
    const onMove = (e) => {
      if (!draggingRef.current || !splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      if (draggingRef.current === 'editor') {
        const pct = ((rect.right - e.clientX) / rect.width) * 100;
        setEditorPct(Math.max(15, Math.min(85, pct)));
      } else if (draggingRef.current === 'side') {
        // Side pane sits to the LEFT of the editor — its right edge is at
        // (rect.right - editorPx). Drag leftward to grow it (taking from main).
        const editorPx = editorEmptyRef.current ? 0 : (rect.width * editorPctRef.current / 100);
        const sideRightEdge = rect.right - editorPx;
        const pct = ((sideRightEdge - e.clientX) / rect.width) * 100;
        setSidePct(Math.max(15, Math.min(70, pct)));
      }
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = null;
      setDragging(null);
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const resumeSession = useCallback(async (session) => {
    if (!session?.sessionId) return;
    setInput('');
    // If this session is already loaded in any tab, just focus that tab — no duplicates.
    for (const [tabId, sid] of tabToSessionId.entries()) {
      if (sid === session.sessionId) {
        setActiveId(tabId);
        return;
      }
    }
    for (const [tabId, sid] of Object.entries(agentSessionByTab)) {
      if (sid === session.sessionId) {
        setActiveId(tabId);
        return;
      }
    }
    // A resumed-but-not-yet-run agent tab is pinned by resumeId before any turn
    // records a session, so check tabs directly too.
    for (const t of tabs) {
      if (t.kind === 'agent' && t.resumeId === session.sessionId) {
        setActiveId(t.id);
        return;
      }
    }
    // Fetch the prior conversation first so we can seed the tab atomically — no
    // await sits between creating the tab and seeding it, so an immediate submit
    // can't race the seed. The SDK only streams the new turn on resume, so
    // without this a resumed tab would open blank until the next submit.
    let history = [];
    if (window.api?.claude?.sessionHistory) {
      history = await window.api.claude.sessionHistory(session.sessionId, session.project);
    }
    // Open an agent tab pinned to this session; its first submit passes
    // options.resume so the host resumes it (the SDK writes transcripts to the
    // same ~/.claude/projects tree, so the context meter and Sidebar keep working).
    const id = createAgentTab({ cwd: session.project, title: basename(session.project), resumeId: session.sessionId });
    if (history?.length) setAgentMessagesByTab((m) => ({ ...m, [id]: history }));
    // Recognize the resumed session now (not just after the first turn) so the
    // next submit resumes it and later clicks dedupe to this tab.
    setAgentSessionByTab((m) => ({ ...m, [id]: session.sessionId }));
  }, [createAgentTab, tabToSessionId, agentSessionByTab, tabs]);

  const updateTabTitle = useCallback((id, title) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title: title || t.title } : t)));
  }, []);

  const updateTabCwd = useCallback((id, cwd) => {
    setCwdByTab((m) => (m[id] === cwd ? m : { ...m, [id]: cwd }));
    setTabs((prev) => prev.map((t) => {
      if (t.id !== id) return t;
      // If the tab title is a path basename (or default shell name), let cwd updates rename it.
      const newTitle = basename(cwd) || t.title;
      return t.title === newTitle ? t : { ...t, title: newTitle };
    }));
  }, []);

  return (
    <div className="h-full w-full flex flex-col bg-ink-900 text-ink-100">
      {dragging && (
        <div
          className="fixed inset-0 z-50"
          style={{ cursor: 'col-resize' }}
        />
      )}
      <TabBar
        tabs={tabs}
        activeId={activeId}
        onSelect={setActiveId}
        onNewTab={() => createTab()}
        onNewBrowserTab={() => createBrowserTab()}
        onCloseTab={closeTab}
        onToggleSidebar={() => setSidebarOpen((s) => !s)}
        sidebarOpen={sidebarOpen}
        onToggleFiles={() => setFilesOpen((s) => !s)}
        filesOpen={filesOpen}
        onOpenSettings={() => setSettingsOpen(true)}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      />

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onSave={async (s) => {
          setSettings(s);
          await window.api?.settings?.set?.(s);
          setSettingsOpen(false);
        }}
        onClose={() => setSettingsOpen(false)}
      />

      <PermissionDialog
        request={pendingPermissions[0] || null}
        onRespond={(decision) => replyPermission(pendingPermissions[0], decision)}
      />

{/* <CommandPalette TEMP disabled to isolate crash */}
      {/* <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        model={model}
        mode={mode}
        modelGroups={[...FALLBACK_MODEL_GROUPS, ...enabledProviderModels(settings)]}
        onSelectModel={(m) => { setModel(m); handleModelChange(m); }}
        onSelectMode={(m) => { setMode(m); handleModeChange(m); }}
        onNewSession={() => {
          const cwd = activeTerminalId ? (cwdByTab[activeTerminalId] || '') : '';
          if (cwd) newSessionInProject(cwd);
        }}
        onNewWorkspace={newWorkspace}
        onRestartTab={restartActiveTab}
        onToggleSidebar={() => setSidebarOpen((s) => !s)}
        onToggleFiles={() => setFilesOpen((s) => !s)}
        onOpenSettings={() => setSettingsOpen(true)}
        hasActiveTerminal={!!activeTerminalId}
      /> */}

      <div className="flex-1 flex min-h-0">
        <Sidebar
          open={sidebarOpen}
          sessions={sessions}
          projects={openProjects}
          hiddenIds={hiddenIds}
          showHidden={showHidden}
          onToggleShowHidden={() => setShowHidden((v) => !v)}
          activeCwd={activeCwd}
          activeSessionId={activeSessionId}
          openSessionIds={openSessionIds}
          homeDir={homeDir}
          onResume={resumeSession}
          onNewWorkspace={newWorkspace}
          onNewSessionInProject={newSessionInProject}
          onBrowseProject={browseProject}
          onSetHidden={setSessionHidden}
          onDelete={deleteSession}
          onRefresh={refreshSessions}
        />

        <main className="flex-1 flex flex-col min-w-0">
          <div ref={splitRef} className="flex-1 flex flex-row min-h-0 min-w-0">
            <div
              {...dropZoneProps('terminal')}
              className={
                'flex-1 min-w-0 relative bg-ink-900 ' +
                (dragOverZone === 'terminal' ? 'ring-2 ring-inset ring-accent-500/60' : '')
              }
            >
              {!mainPaneTab ? (
                <div className="absolute inset-0 flex items-center justify-center text-ink-300">
                  <div className="text-center">
                    <p className="text-sm">No terminal open.</p>
                    <button
                      onClick={newWorkspace}
                      className="mt-3 inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-accent-500 text-accent-fg text-xs hover:bg-accent-400 transition"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                      New workspace
                    </button>
                    <button
                      onClick={openAgentTab}
                      className="mt-2 inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-ink-700 text-ink-200 text-xs hover:bg-ink-600 transition"
                    >
                      New agent
                    </button>
                  </div>
                </div>
              ) : null}
              {tabs.map((tab) => {
                // Main pane renders terminals and full-mode browsers.
                if (tab.kind === 'browser' && tab.view === 'side') return null;
                const visible = tab.id === mainPaneTab?.id;
                if (tab.kind === 'browser') {
                  return (
                    <BrowserView
                      key={tab.id}
                      ref={(r) => { if (r) browserRefs.current.set(tab.id, r); else browserRefs.current.delete(tab.id); }}
                      initialUrl={tab.url || ''}
                      view={tab.view}
                      visible={visible}
                      onTitle={(t) => updateTabTitle(tab.id, t)}
                      onUrlChange={(u) => updateTabUrl(tab.id, u)}
                      onToggleView={() => toggleBrowserView(tab.id)}
                    />
                  );
                }
                if (tab.kind === 'agent') {
                  return (
                    <AgentView
                      key={tab.id}
                      messages={agentMessagesByTab[tab.id] || []}
                      running={!!agentRunningByTab[tab.id]}
                      offline={offline}
                      visible={visible}
                      onStop={() => stopAgent(tab.id)}
                    />
                  );
                }
                return (
                  <TerminalView
                    key={tab.id}
                    ref={(r) => setTermRef(tab.id, r)}
                    ptyId={tab.ptyId}
                    visible={visible}
                    theme={theme}
                    onTitle={(t) => updateTabTitle(tab.id, t)}
                    onCwd={(c) => updateTabCwd(tab.id, c)}
                  />
                );
              })}
            </div>

            {sidePaneTab && (
              <div
                onMouseDown={onSideSplitDown}
                className="w-1 shrink-0 bg-ink-700 hover:bg-accent-500 cursor-col-resize transition-colors"
                title="Drag to resize browser"
              />
            )}

            {sidePaneTab && (
              <div className="min-w-0 relative" style={{ width: sidePct + '%' }}>
                {tabs.map((tab) => {
                  if (!(tab.kind === 'browser' && tab.view === 'side')) return null;
                  return (
                    <BrowserView
                      key={tab.id}
                      ref={(r) => { if (r) browserRefs.current.set(tab.id, r); else browserRefs.current.delete(tab.id); }}
                      initialUrl={tab.url || ''}
                      view={tab.view}
                      visible={tab.id === sidePaneTab.id}
                      onTitle={(t) => updateTabTitle(tab.id, t)}
                      onUrlChange={(u) => updateTabUrl(tab.id, u)}
                      onToggleView={() => toggleBrowserView(tab.id)}
                    />
                  );
                })}
              </div>
            )}

            {!editorEmpty && (
              <div
                onMouseDown={onEditorSplitDown}
                className="w-1 shrink-0 bg-ink-700 hover:bg-accent-500 cursor-col-resize transition-colors"
                title="Drag to resize editor"
              />
            )}

            <div
              {...dropZoneProps('editor')}
              className={
                (editorEmpty ? 'hidden' : 'min-w-0 flex flex-col relative') +
                (dragOverZone === 'editor' ? ' ring-2 ring-inset ring-accent-500/60' : '')
              }
              style={editorEmpty ? undefined : { width: editorPct + '%' }}
            >
              <EditorPane ref={editorRef} onEmptyChange={setEditorEmpty} theme={theme} />
            </div>
          </div>

          <div
            {...dropZoneProps('prompt')}
            className={
              'relative ' +
              (dragOverZone === 'prompt' ? 'ring-2 ring-inset ring-accent-500/60' : '')
            }
          >
            <PromptBar
              ref={promptBarRef}
              value={input}
              onChange={setInput}
              onSubmit={submitPrompt}
              onLaunchClaude={launchClaude}
              mode={mode}
              onModeChange={handleModeChange}
              model={model}
              onModelChange={handleModelChange}
              contextUsage={contextUsage}
              claudeActive={claudeActiveHere}
              agentRunning={!!(activeAgentId ? agentRunningByTab[activeAgentId] : (activeTerminalId && runningByTab[activeTerminalId]))}
              onStop={stopActiveAgent}
              onRestartTab={restartActiveTab}
              launchedModel={activeTerminalId ? launchedModelByTab[activeTerminalId] : ''}
              providerModels={enabledProviderModels(settings)}
              offline={offline}
              completionConfig={completionConfig}
            />
          </div>
        </main>

        <FileManager
          open={filesOpen}
          cwd={fileBrowseCwd}
          homeDir={homeDir}
          onToggleOpen={() => setFilesOpen((s) => !s)}
          onOpenFile={openInEditor}
        />
      </div>
    </div>
  );
}
