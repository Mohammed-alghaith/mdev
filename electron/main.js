const { app, BrowserWindow, ipcMain, shell, globalShortcut, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { execFileSync, execFile } = require('node:child_process');
const pty = require('node-pty');
const { getSettings, saveSettings } = require('./settings');

const isDev = !app.isPackaged;
const ptySessions = new Map();
let mainWindow = null;
let agentHost = null;

function currentWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const fallback = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) || null;
  mainWindow = fallback;
  return fallback;
}

function windowForEvent(event) {
  const owner = event?.sender && !event.sender.isDestroyed()
    ? BrowserWindow.fromWebContents(event.sender)
    : null;
  return owner && !owner.isDestroyed() ? owner : currentWindow();
}

function sendToWindow(win, channel, payload) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  win.webContents.send(channel, payload);
  return true;
}

const defaultShell =
  process.platform === 'win32'
    ? process.env.COMSPEC || 'powershell.exe'
    : process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');

const claudeHistoryPath = path.join(os.homedir(), '.claude', 'history.jsonl');
const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');

function encodeProjectPath(p) {
  // Matches Claude CLI's per-project directory convention: replace path
  // separators (and the Windows drive colon) with "-".
  // POSIX:   /Users/mohammed/Projects/app → -Users-mohammed-Projects-app
  // Windows: C:\Users\mohammed\Projects\app → C--Users-mohammed-Projects-app
  return String(p || '').replace(/[\\/]/g, '-').replace(/:/g, '-');
}

// ---------------------------------------------------------------------------
// Dynamic model discovery. The dropdown used to hardcode model names/versions,
// so a new release (e.g. Opus 4.8) didn't appear until someone edited the code.
// Instead we ask the Anthropic Models API at runtime. Auth reuses the Claude
// Code login the user already has — OAuth token from the macOS keychain (or the
// ~/.claude/.credentials.json file on other platforms), falling back to
// ANTHROPIC_API_KEY. The renderer keeps a hardcoded list as a last-resort
// fallback when this returns nothing (offline / not logged in).
function readClaudeAuth() {
  // 1. Explicit API key wins if present.
  if (process.env.ANTHROPIC_API_KEY) {
    return { type: 'apiKey', value: process.env.ANTHROPIC_API_KEY };
  }
  // 2. OAuth token from the Claude Code credential store.
  const parseOauth = (raw) => {
    try {
      const tok = JSON.parse(raw)?.claudeAiOauth?.accessToken;
      return tok ? { type: 'oauth', value: tok } : null;
    } catch { return null; }
  };
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf-8', timeout: 5000 }
      );
      const auth = parseOauth(raw);
      if (auth) return auth;
    } catch {}
  }
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf-8');
    const auth = parseOauth(raw);
    if (auth) return auth;
  } catch {}
  return null;
}

let modelsCache = null; // { at: epochMs, models: [...] }
async function fetchClaudeModels() {
  // Cache for 10 minutes so switching tabs doesn't hammer the API.
  if (modelsCache && Date.now() - modelsCache.at < 10 * 60 * 1000) {
    return modelsCache.models;
  }
  const auth = readClaudeAuth();
  if (!auth) return [];
  const headers = { 'anthropic-version': '2023-06-01' };
  if (auth.type === 'oauth') {
    headers['authorization'] = 'Bearer ' + auth.value;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  } else {
    headers['x-api-key'] = auth.value;
  }
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers });
    if (!res.ok) return modelsCache?.models || [];
    const json = await res.json();
    const models = (json.data || [])
      .filter((m) => typeof m.id === 'string' && m.id.startsWith('claude-'))
      .map((m) => ({
        id: m.id,
        displayName: m.display_name || m.id,
        maxInputTokens: m.max_input_tokens || 200000,
        effort: !!m.capabilities?.effort?.supported,
        createdAt: m.created_at || '',
      }));
    if (models.length) modelsCache = { at: Date.now(), models };
    return modelsCache?.models || [];
  } catch {
    return modelsCache?.models || [];
  }
}

let hiddenIdsPath;
function readHiddenIds() {
  try {
    return new Set(JSON.parse(fs.readFileSync(hiddenIdsPath, 'utf-8')) || []);
  } catch {
    return new Set();
  }
}
function writeHiddenIds(set) {
  try {
    fs.mkdirSync(path.dirname(hiddenIdsPath), { recursive: true });
    fs.writeFileSync(hiddenIdsPath, JSON.stringify(Array.from(set)));
  } catch (err) {
    console.error('hidden ids write failed', err);
  }
}

// Walks a session transcript from the end backwards and returns the most
// recent assistant message's token usage. That equals the current size of
// the model's input context (input + cache_creation + cache_read), i.e. what
// the next API call will send. We read the tail-most ~256KB of the file so
// large transcripts don't block the UI thread — long sessions can be many
// MB, but the most recent usage entry is always near the end.
function readSessionContext(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    const chunkSize = Math.min(256 * 1024, size);
    const buf = Buffer.alloc(chunkSize);
    fs.readSync(fd, buf, 0, chunkSize, size - chunkSize);
    fs.closeSync(fd); fd = null;
    const text = buf.toString('utf-8');
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || line[0] !== '{') continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const usage = row?.message?.usage;
      if (!usage) continue;
      const input = usage.input_tokens || 0;
      const cacheCreate = usage.cache_creation_input_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const total = input + cacheCreate + cacheRead;
      if (total === 0) continue;
      return {
        tokens: total,
        input,
        cacheCreate,
        cacheRead,
        output: usage.output_tokens || 0,
      };
    }
  } catch {}
  finally { if (fd) try { fs.closeSync(fd); } catch {} }
  return null;
}

// Reads a full session transcript and normalizes its lines into the message
// shapes AgentView renders (user-prompt, assistant, user/tool_result). Internal
// bookkeeping lines (queue-operation, ai-title, last-prompt, mode, attachment,
// result) are skipped. The SDK does NOT re-emit prior turns on `resume`, so this
// is what lets a resumed tab show its full history immediately.
async function readSessionHistory(file) {
  let raw;
  try { raw = await fs.promises.readFile(file, 'utf-8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'assistant') {
      if (row.message) out.push({ type: 'assistant', message: row.message });
    } else if (row.type === 'user') {
      const content = row.message?.content;
      const toolResults = [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            out.push({ type: 'user-prompt', text: block.text });
          } else if (block?.type === 'tool_result') {
            toolResults.push(block);
          }
        }
      } else if (typeof content === 'string' && content.trim()) {
        out.push({ type: 'user-prompt', text: content });
      }
      if (toolResults.length) out.push({ type: 'user', message: { content: toolResults } });
    }
  }
  return out;
}

// Read only the first `maxBytes` of a file — transcripts can be multi-MB, and
// session discovery only needs the header (sessionId/cwd/model/prompt/title).
// Returns the head text plus the file's mtime (a cheap "last activity" signal).
function readFileHead(filePath, maxBytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return { text: buf.toString('utf8'), mtimeMs: st.mtimeMs };
  } catch {
    return { text: '', mtimeMs: 0 };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function isoToMs(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

// Inverse of encodeProjectPath(). Lossy for paths whose segments contain "-",
// so it's only a last-resort fallback when a transcript header lacks `cwd`.
function decodeProjectDir(name) {
  return '/' + String(name).replace(/^-/, '').replace(/-/g, '/');
}

// Parse an SDK transcript header into a session record, or null if it's not a
// usable transcript (no sessionId and no project). `cwd` is authoritative.
function parseTranscriptHeader(filePath, dirName) {
  const { text, mtimeMs } = readFileHead(filePath);
  if (!text) return null;
  let sessionId = null, project = '', model = '', prompt = '';
  let firstTimestamp = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!sessionId && row.sessionId) sessionId = row.sessionId;
    if (!project && row.cwd) project = row.cwd;
    if (!model && row.model) model = row.model;
    if (!prompt && row.type === 'ai-title' && row.aiTitle) prompt = row.aiTitle;
    if (!prompt && row.type === 'user') {
      const content = row.message?.content;
      let userText = '';
      if (Array.isArray(content)) {
        userText = content
          .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join(' ')
          .trim();
      } else if (typeof content === 'string') {
        userText = content.trim();
      }
      if (userText) prompt = userText.slice(0, 200);
    }
    if (!prompt && row.type === 'last-prompt' && row.lastPrompt) prompt = row.lastPrompt;
    if (!firstTimestamp && row.timestamp) firstTimestamp = isoToMs(row.timestamp);
  }
  if (!sessionId) sessionId = path.basename(filePath, '.jsonl');
  if (!project) project = decodeProjectDir(dirName);
  if (!project) return null;
  return {
    sessionId,
    project,
    model,
    prompt,
    firstTimestamp: firstTimestamp || mtimeMs,
    mtimeMs,
  };
}

function readClaudeSessions() {
  const sessions = new Map();

  // 1. ~/.claude/history.jsonl — the interactive CLI's session index.
  let raw = '';
  try { raw = fs.readFileSync(claudeHistoryPath, 'utf-8'); } catch {}
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const sessionId = row.sessionId;
    if (!sessionId) continue;
    const project = row.projectPath || row.project || '';
    const prompt = row.display || row.prompt || '';
    const timestamp = Number(row.timestamp) || 0;
    const model = row.model || '';
    const existing = sessions.get(sessionId);
    if (!existing) {
      sessions.set(sessionId, {
        sessionId,
        project,
        prompt,
        model,
        firstTimestamp: timestamp,
        lastTimestamp: timestamp,
        messageCount: 1,
      });
    } else {
      existing.lastTimestamp = Math.max(existing.lastTimestamp, timestamp);
      if (timestamp && (timestamp < existing.firstTimestamp || existing.firstTimestamp === 0)) {
        existing.firstTimestamp = timestamp;
        if (prompt) existing.prompt = prompt;
      }
      if (!existing.project && project) existing.project = project;
      // Prefer the last (most recent) model — it's what the session is currently using.
      if (model) existing.model = model;
      existing.messageCount += 1;
    }
  }

  // 2. SDK/agent sessions write transcripts to ~/.claude/projects/ but never
  // append a history.jsonl row, so scan the transcript files to surface them.
  // Only each file's header is read (cheap), and sessions history.jsonl already
  // covers are skipped.
  try {
    for (const entry of fs.readdirSync(claudeProjectsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const projectDir = path.join(claudeProjectsDir, entry.name);
        let files;
        try { files = fs.readdirSync(projectDir); } catch { continue; }
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          const sessionId = file.slice(0, -'.jsonl'.length);
          if (sessions.has(sessionId)) continue;
          let rec = null;
          try { rec = parseTranscriptHeader(path.join(projectDir, file), entry.name); } catch { continue; }
          if (!rec || sessions.has(rec.sessionId)) continue;
          sessions.set(rec.sessionId, {
            sessionId: rec.sessionId,
            project: rec.project,
            prompt: rec.prompt,
            model: rec.model,
            firstTimestamp: rec.firstTimestamp,
            lastTimestamp: rec.mtimeMs,
            messageCount: 1,
          });
        }
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        // Defensive: a transcript sitting directly under projects/ (unusual).
        const sessionId = entry.name.slice(0, -'.jsonl'.length);
        if (sessions.has(sessionId)) continue;
        let rec = null;
        try { rec = parseTranscriptHeader(path.join(claudeProjectsDir, entry.name), entry.name); } catch { continue; }
        if (!rec || sessions.has(rec.sessionId)) continue;
        sessions.set(rec.sessionId, {
          sessionId: rec.sessionId,
          project: rec.project,
          prompt: rec.prompt,
          model: rec.model,
          firstTimestamp: rec.firstTimestamp,
          lastTimestamp: rec.mtimeMs,
          messageCount: 1,
        });
      }
    }
  } catch (err) {
    console.warn('could not scan claude projects for sessions', err);
  }

  return Array.from(sessions.values()).sort((a, b) => b.lastTimestamp - a.lastTimestamp);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#0b0b10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    rejectPendingControlForWindow(win, 'window closed');
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.once('did-finish-load', () => {
      try { win.webContents.openDevTools({ mode: 'detach' }); } catch {}
    });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  return win;
}

function spawnPty({ cols = 100, rows = 30, cwd, env, runAfter } = {}) {
  let effectiveCwd = cwd || os.homedir();
  try {
    if (!fs.existsSync(effectiveCwd)) effectiveCwd = os.homedir();
  } catch {
    effectiveCwd = os.homedir();
  }

  const ptyEnv = {
    ...process.env,
    ...(env || {}),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  // The terminal app is NOT a child Claude session — this marker leaks in
  // from the parent shell and would disable transcript saving for every
  // session launched inside the PTY.
  delete ptyEnv.CLAUDE_CODE_CHILD_SESSION;

  const ptyProcess = pty.spawn(defaultShell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: effectiveCwd,
    env: ptyEnv,
  });
  // Hide the raw system prompt, emit OSC 7 (cwd reports) on every cd, clear screen.
  if (process.platform !== 'win32') {
    const setup = [
      "unset PROMPT_COMMAND 2>/dev/null",
      "__emit_cwd() { printf '\\e]7;%s\\a' \"$PWD\"; }",
      "typeset -ga chpwd_functions 2>/dev/null && chpwd_functions+=(__emit_cwd) 2>/dev/null",
      '[ -n "$BASH" ] && PROMPT_COMMAND="__emit_cwd"',
      "__emit_cwd",
      "PROMPT=$'\\e[35m▸\\e[0m '",
      "PS1=$'\\e[35m▸\\e[0m '",
      "RPROMPT=''",
      "clear",
    ].join("; ") + "\r";
    setTimeout(() => {
      try { ptyProcess.write(setup); } catch {}
      if (runAfter) {
        // Give the setup (incl. `clear`) time to finish before the follow-up command.
        setTimeout(() => {
          try { ptyProcess.write('\x15' + runAfter + '\r'); } catch {}
        }, 350);
      }
    }, 60);
  } else if (runAfter) {
    setTimeout(() => { try { ptyProcess.write(runAfter + '\r'); } catch {} }, 400);
  }
  return { ptyProcess, cwd: effectiveCwd };
}

app.whenReady().then(async () => {
  hiddenIdsPath = path.join(app.getPath('userData'), 'hidden-sessions.json');
  createWindow();

  // Load the Agent SDK host (ESM-only). Resolve to a file URL for ESM import.
  // The host owns the in-process MCP tools (mcp__mdev__*), which
  // forward calls to the renderer via dispatchToRenderer below.
  try {
    agentHost = await import(pathToFileURL(path.join(__dirname, 'agent-host.mjs')).href);
    agentHost.setToolDispatcher(dispatchToRenderer);
  } catch (err) {
    console.error('failed to load agent host:', err);
  }

  // Pre-compile the OCR helper in the background so the first screenshot's
  // OCR doesn't pay the swiftc latency.
  getOcrBinary();

  globalShortcut.register('CommandOrControl+Shift+S', async () => {
    try {
      const win = currentWindow();
      if (!win || win.webContents.isDestroyed()) throw new Error('window not available');
      const img = await win.webContents.capturePage();
      const out = path.join(app.getPath('temp'), 'mdev-' + Date.now() + '.png');
      fs.writeFileSync(out, img.toPNG());
      console.log('SCREENSHOT_SAVED', out);
    } catch (err) {
      console.error('screenshot failed', err);
    }
  });

  ipcMain.handle('pty:create', (evt, opts = {}) => {
    const ownerWindow = windowForEvent(evt);
    const { ptyProcess, cwd: spawnedCwd } = spawnPty(opts);
    const id = String(ptyProcess.pid) + '-' + Date.now();
    ptySessions.set(id, ptyProcess);

    ptyProcess.onData((data) => {
      sendToWindow(ownerWindow, 'pty:data', { id, data });
    });
    ptyProcess.onExit(({ exitCode, signal }) => {
      sendToWindow(ownerWindow, 'pty:exit', { id, exitCode, signal });
      ptySessions.delete(id);
    });

    return { id, shell: defaultShell, cwd: spawnedCwd };
  });

  ipcMain.handle('fs:readDir', async (_evt, dirPath) => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      const out = [];
      for (const ent of entries) {
        const full = path.join(dirPath, ent.name);
        let isDir = ent.isDirectory();
        if (!isDir && ent.isSymbolicLink()) {
          try { isDir = (await fs.promises.stat(full)).isDirectory(); } catch {}
        }
        out.push({
          name: ent.name,
          path: full,
          isDir,
          isSymlink: ent.isSymbolicLink(),
          isHidden: ent.name.startsWith('.'),
        });
      }
      out.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });
      return { ok: true, entries: out };
    } catch (err) {
      return { ok: false, error: String(err?.message || err), entries: [] };
    }
  });

  ipcMain.handle('fs:openPath', async (_evt, p) => {
    if (!p) return { ok: false };
    const err = await shell.openPath(p);
    return { ok: !err, error: err || undefined };
  });

  ipcMain.handle('fs:readFile', async (_evt, p) => {
    if (!p) return { ok: false, error: 'no path' };
    try {
      const stat = await fs.promises.stat(p);
      // Refuse anything obviously not editable in a code editor — keeps the
      // user from accidentally loading a 200MB binary into Monaco.
      if (stat.size > 8 * 1024 * 1024) return { ok: false, error: 'file too large (>8MB)' };
      const buf = await fs.promises.readFile(p);
      // Crude binary sniff: NUL byte in the first 4KB.
      const head = buf.subarray(0, Math.min(4096, buf.length));
      for (let i = 0; i < head.length; i++) {
        if (head[i] === 0) return { ok: false, error: 'binary file' };
      }
      return { ok: true, content: buf.toString('utf-8'), size: stat.size, mtimeMs: stat.mtimeMs };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  ipcMain.handle('fs:writeFile', async (_evt, { path: p, content } = {}) => {
    if (!p) return { ok: false, error: 'no path' };
    try {
      await fs.promises.writeFile(p, content ?? '', 'utf-8');
      const stat = await fs.promises.stat(p);
      return { ok: true, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  ipcMain.handle('fs:revealInFinder', (_evt, p) => {
    if (!p) return { ok: false };
    try { shell.showItemInFolder(p); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('dialog:pickFolder', async (evt) => {
    const win = windowForEvent(evt);
    const options = {
      title: 'Choose or create a workspace folder',
      buttonLabel: 'Open Workspace',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: os.homedir(),
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('pty:write', (_evt, { id, data }) => {
    const session = ptySessions.get(id);
    if (session) session.write(data);
    return true;
  });

  ipcMain.handle('pty:resize', (_evt, { id, cols, rows }) => {
    const session = ptySessions.get(id);
    if (session) {
      try {
        session.resize(Math.max(cols | 0, 1), Math.max(rows | 0, 1));
      } catch (err) {
        console.warn('pty resize failed', err);
      }
    }
    return true;
  });

  ipcMain.handle('pty:kill', (_evt, { id }) => {
    const session = ptySessions.get(id);
    if (session) {
      try { session.kill(); } catch {}
      ptySessions.delete(id);
    }
    return true;
  });

  ipcMain.handle('claude:sessions', () => readClaudeSessions());

  ipcMain.handle('claude:listModels', () => fetchClaudeModels());

  // ───────── Inline autocomplete (ghost text) ─────────
  // One-shot completion for the prompt input. The renderer resolves a custom
  // provider's base URL + API key (mirroring buildAgentOptions) and sends them
  // here; for Anthropic models it sends an `anthropic` marker instead and we
  // resolve auth via readClaudeAuth(). The fetch runs in main to avoid renderer
  // CORS. Anthropic Messages format — custom providers expose an
  // Anthropic-compatible /v1/messages endpoint (the SDK drives them through
  // ANTHROPIC_BASE_URL the same way, with ANTHROPIC_AUTH_TOKEN ↔ Bearer).
  ipcMain.handle('ai:complete', async (_evt, { baseUrl, apiKey, model, text, anthropic } = {}) => {
    if (typeof text !== 'string' || !text.trim()) return { ok: false };
    try {
      let url;
      let headers;
      if (anthropic) {
        const auth = readClaudeAuth();
        if (!auth) return { ok: false };
        url = 'https://api.anthropic.com';
        headers = { 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
        if (auth.type === 'oauth') {
          headers['authorization'] = 'Bearer ' + auth.value;
          headers['anthropic-beta'] = 'oauth-2025-04-20';
        } else {
          headers['x-api-key'] = auth.value;
        }
      } else {
        if (!baseUrl || !apiKey || !model) return { ok: false };
        url = String(baseUrl).replace(/\/+$/, '');
        headers = {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'authorization': 'Bearer ' + apiKey,
        };
      }
      const body = {
        max_tokens: 40,
        system: "You are an inline autocomplete assistant. Continue the user's input " +
          'naturally. Return ONLY the continuation text (a few words to one short ' +
          'sentence). Do not repeat the input and do not add explanation.',
        messages: [{ role: 'user', content: text }],
      };
      if (model) body.model = model;
      const res = await fetch(url + '/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) return { ok: false };
      const data = await res.json();
      const completion = (Array.isArray(data?.content)
        ? data.content.find((b) => b && b.type === 'text')?.text
        : null) || '';
      return { ok: true, completion };
    } catch {
      return { ok: false };
    }
  });

  // ───────── Agent SDK bridge ─────────
  // The renderer submits a prompt; the host runs the SDK in the main process
  // and streams SDKMessage events back via agent:event / agent:result / agent:exit.
  ipcMain.handle('agent:submit', (evt, { tabId, text, options } = {}) => {
    if (!agentHost || !tabId || text == null) return { ok: false, error: 'invalid args' };
    const win = windowForEvent(evt);
    const send = (channel, payload) => sendToWindow(win, channel, { tabId, ...payload });
    return agentHost.submit(tabId, {
      text,
      options: options || {},
      onMessage: (message) => send('agent:event', { message }),
      onResult: (message) => send('agent:result', { message }),
      onExit: (payload) => send('agent:exit', payload),
      onPermission: (payload) => send('agent:permission', payload),
    }).then((resumedSessionId) => ({ ok: true, resumedSessionId }));
  });

  ipcMain.handle('agent:stop', async (_evt, { tabId } = {}) => {
    if (!agentHost || !tabId) return false;
    await agentHost.interrupt(tabId);
    return true;
  });

  ipcMain.handle('agent:permission:reply', (_evt, { tabId, requestId, decision } = {}) => {
    if (!agentHost || !tabId || !requestId || !decision) return false;
    return agentHost.resolvePermission(tabId, requestId, decision);
  });

  ipcMain.handle('settings:get', () => getSettings());

  ipcMain.handle('settings:set', (_evt, obj) => saveSettings(obj));

  ipcMain.handle('vision:ocr', async (_evt, base64) => {
    if (typeof base64 !== 'string' || !base64) return { ok: true, text: '' };
    const pngPath = path.join(app.getPath('temp'), 'mdev-ocr-' + Date.now() + '.png');
    try {
      fs.writeFileSync(pngPath, Buffer.from(base64, 'base64'));
      const text = await ocrImage(pngPath);
      return { ok: true, text };
    } catch {
      return { ok: true, text: '' };
    } finally {
      try { fs.unlinkSync(pngPath); } catch {}
    }
  });

  ipcMain.handle('claude:sessionContext', (_evt, { sessionId, project } = {}) => {
    if (!sessionId) return null;
    const tryPaths = [];
    if (project) {
      tryPaths.push(path.join(claudeProjectsDir, encodeProjectPath(project), sessionId + '.jsonl'));
    } else {
      // Fall back to scanning all project dirs when caller doesn't know the project.
      try {
        for (const d of fs.readdirSync(claudeProjectsDir)) {
          tryPaths.push(path.join(claudeProjectsDir, d, sessionId + '.jsonl'));
        }
      } catch {}
    }
    for (const p of tryPaths) {
      try { if (!fs.statSync(p).isFile()) continue; } catch { continue; }
      const usage = readSessionContext(p);
      if (usage) return usage;
    }
    return null;
  });

  ipcMain.handle('claude:sessionHistory', async (_evt, { sessionId, project } = {}) => {
    if (!sessionId) return [];
    const tryPaths = [];
    if (project) {
      tryPaths.push(path.join(claudeProjectsDir, encodeProjectPath(project), sessionId + '.jsonl'));
    } else {
      try {
        for (const d of fs.readdirSync(claudeProjectsDir)) {
          tryPaths.push(path.join(claudeProjectsDir, d, sessionId + '.jsonl'));
        }
      } catch {}
    }
    for (const p of tryPaths) {
      try { if (!fs.statSync(p).isFile()) continue; } catch { continue; }
      return await readSessionHistory(p);
    }
    return [];
  });

  ipcMain.handle('claude:hiddenIds', () => Array.from(readHiddenIds()));

  ipcMain.handle('claude:setHidden', (_evt, { sessionId, hidden }) => {
    if (!sessionId) return Array.from(readHiddenIds());
    const set = readHiddenIds();
    if (hidden) set.add(sessionId);
    else set.delete(sessionId);
    writeHiddenIds(set);
    return Array.from(set);
  });

  ipcMain.handle('claude:deleteSession', async (evt, { sessionId, project }) => {
    if (!sessionId) return { ok: false, reason: 'no sessionId' };
    const win = windowForEvent(evt);
    const options = {
      type: 'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Delete session',
      message: 'Permanently delete this Claude session?',
      detail:
        'This removes the session transcript and all prompts for session ' +
        sessionId.slice(0, 8) + '… from ~/.claude. This cannot be undone.',
    };
    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    if (result.response !== 0) return { ok: false, reason: 'cancelled' };

    // 1. Delete the per-session transcript file (if present).
    if (project) {
      const transcript = path.join(claudeProjectsDir, encodeProjectPath(project), sessionId + '.jsonl');
      try { fs.unlinkSync(transcript); } catch {}
    } else {
      // Fall back to scanning all project dirs for a matching session file.
      try {
        for (const d of fs.readdirSync(claudeProjectsDir)) {
          const candidate = path.join(claudeProjectsDir, d, sessionId + '.jsonl');
          try { if (fs.statSync(candidate).isFile()) fs.unlinkSync(candidate); } catch {}
        }
      } catch {}
    }

    // 2. Strip all rows for this sessionId from the global history.jsonl.
    try {
      const raw = fs.readFileSync(claudeHistoryPath, 'utf-8');
      const lines = raw.split('\n');
      const keep = lines.filter((line) => {
        if (!line.trim()) return false;
        try {
          const row = JSON.parse(line);
          return row.sessionId !== sessionId;
        } catch {
          return true; // leave malformed lines alone
        }
      });
      fs.writeFileSync(claudeHistoryPath, keep.join('\n') + (keep.length ? '\n' : ''));
    } catch {}

    // 3. Also drop from the hidden list if it was there.
    const set = readHiddenIds();
    if (set.delete(sessionId)) writeHiddenIds(set);

    return { ok: true };
  });

  // Watch ~/.claude/history.jsonl. Use BOTH fs.watch (event-based, instant) and
  // fs.watchFile (stat-poll, reliable fallback when kqueue misses an append).
  let lastSnapshot = '';
  let pushTimer = null;
  const pushSessions = () => {
    try {
      const list = readClaudeSessions();
      const snap = JSON.stringify(list.map((s) => s.sessionId + ':' + s.lastTimestamp + ':' + s.messageCount));
      if (snap === lastSnapshot) return;
      lastSnapshot = snap;
      sendToWindow(currentWindow(), 'claude:sessionsUpdated', list);
    } catch (err) {
      console.error('sessions push failed', err);
    }
  };
  const schedulePush = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      pushSessions();
    }, 150);
  };
  try {
    fs.mkdirSync(path.dirname(claudeHistoryPath), { recursive: true });
    // Stat-poll fallback at 800ms — catches anything fs.watch missed (e.g. on FUSE/SMB).
    fs.watchFile(claudeHistoryPath, { interval: 800 }, schedulePush);
    // Event-based watcher fires the instant claude appends.
    try { fs.watch(claudeHistoryPath, { persistent: true }, schedulePush); } catch {}
    // Seed lastSnapshot so the first watch tick doesn't ship duplicate data.
    pushSessions();
  } catch (err) {
    console.warn('could not watch claude history', err);
  }

  app.on('activate', () => {
    const win = currentWindow();
    if (!win) {
      createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
});

// ───────── MCP tool dispatch ─────────
// The app's four MCP tools now run in-process as SDK tools (see
// agent-host.mjs). Their handlers call dispatchToRenderer() here, which sends
// a command to the renderer via webContents.send('control:exec', ...); the
// renderer replies on 'control:reply' with the matching id. The old stdio MCP
// server + Unix socket are gone. Adding a new tool only requires a new case in
// the renderer's handler and a matching tool() in agent-host.mjs.

const pendingControl = new Map();
let nextControlId = 1;

function rejectPendingControlForWindow(win, reason) {
  for (const [id, pending] of pendingControl) {
    if (pending.win !== win) continue;
    clearTimeout(pending.timer);
    pendingControl.delete(id);
    pending.reject(new Error(reason || 'window not available'));
  }
}

function dispatchToRenderer(command, args) {
  return new Promise((resolve, reject) => {
    const win = currentWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      return reject(new Error('window not available'));
    }
    const id = String(nextControlId++);
    const timer = setTimeout(() => {
      if (pendingControl.has(id)) {
        pendingControl.delete(id);
        reject(new Error('renderer did not reply within 8s'));
      }
    }, 8000);
    pendingControl.set(id, { resolve, reject, timer, win });
    win.webContents.send('control:exec', { id, command, args });
  });
}

ipcMain.on('control:reply', (_evt, { id, ok, result, error } = {}) => {
  const pending = pendingControl.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingControl.delete(id);
  if (ok) pending.resolve(result);
  else pending.reject(new Error(error || 'unknown renderer error'));
});

// ───────── macOS-native OCR (Vision framework) ──────────────────────────
// DeepSeek is text-only and silently drops image blocks (verified), so
// screenshot_browser OCRs its PNG locally via Apple's Vision framework —
// offline, no API key — and returns the recognized text so the model can
// actually "read" the screenshot. The Swift helper is compiled once to
// <userData>/mdev-ocr on first use and cached across launches; if swiftc
// isn't available the OCR degrades gracefully to an empty string.

const OCR_SWIFT_SOURCE = `
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else { exit(2) }
let path = args[1]
guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(3) }
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([req]) } catch { exit(4) }
let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
print(lines.joined(separator: "\\n"))
`;

let ocrReady = null; // Promise<string|null> → compiled binary path or null

function getOcrBinary() {
  if (!ocrReady) {
    ocrReady = new Promise((resolve) => {
      const bin = path.join(app.getPath('userData'), 'mdev-ocr');
      if (fs.existsSync(bin)) return resolve(bin);
      const src = path.join(app.getPath('userData'), 'mdev-ocr.swift');
      try { fs.writeFileSync(src, OCR_SWIFT_SOURCE); } catch { return resolve(null); }
      execFile('/usr/bin/swiftc', ['-O', src, '-o', bin], { timeout: 60000 }, (err) => {
        resolve(err ? null : bin);
      });
    });
  }
  return ocrReady;
}

function ocrImage(pngPath) {
  return getOcrBinary().then((bin) => {
    if (!bin) return '';
    return new Promise((resolve) => {
      execFile(bin, [pngPath], { timeout: 10000 }, (err, stdout) => {
        resolve(err ? '' : String(stdout || '').trim());
      });
    });
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  for (const session of ptySessions.values()) {
    try { session.kill(); } catch {}
  }
  ptySessions.clear();
  if (process.platform !== 'darwin') app.quit();
});
