const { contextBridge, ipcRenderer, webUtils } = require('electron');
const os = require('node:os');

const dataListeners = new Set();
const exitListeners = new Set();
const sessionListeners = new Set();

ipcRenderer.on('pty:data', (_evt, payload) => {
  for (const cb of dataListeners) cb(payload);
});

ipcRenderer.on('pty:exit', (_evt, payload) => {
  for (const cb of exitListeners) cb(payload);
});

ipcRenderer.on('claude:sessionsUpdated', (_evt, list) => {
  for (const cb of sessionListeners) cb(list);
});

contextBridge.exposeInMainWorld('api', {
  pty: {
    create: (opts) => ipcRenderer.invoke('pty:create', opts),
    write: (id, data) => ipcRenderer.invoke('pty:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.invoke('pty:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.invoke('pty:kill', { id }),
    onData: (cb) => {
      dataListeners.add(cb);
      return () => dataListeners.delete(cb);
    },
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
  },
  claude: {
    listSessions: () => ipcRenderer.invoke('claude:sessions'),
    listModels: () => ipcRenderer.invoke('claude:listModels'),
    onSessionsUpdated: (cb) => {
      sessionListeners.add(cb);
      return () => sessionListeners.delete(cb);
    },
    listHidden: () => ipcRenderer.invoke('claude:hiddenIds'),
    setHidden: (sessionId, hidden) => ipcRenderer.invoke('claude:setHidden', { sessionId, hidden }),
    deleteSession: (sessionId, project) => ipcRenderer.invoke('claude:deleteSession', { sessionId, project }),
    sessionContext: (sessionId, project) => ipcRenderer.invoke('claude:sessionContext', { sessionId, project }),
    sessionHistory: (sessionId, project) => ipcRenderer.invoke('claude:sessionHistory', { sessionId, project }),
  },
  dialog: {
    pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  },
  fs: {
    readDir: (p) => ipcRenderer.invoke('fs:readDir', p),
    openPath: (p) => ipcRenderer.invoke('fs:openPath', p),
    revealInFinder: (p) => ipcRenderer.invoke('fs:revealInFinder', p),
    readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
    writeFile: (p, content) => ipcRenderer.invoke('fs:writeFile', { path: p, content }),
  },
  vision: {
    ocr: (base64) => ipcRenderer.invoke('vision:ocr', base64),
  },
  control: {
    // Subscribe to commands dispatched from the MCP server via main.
    // Returns a teardown function for use in React effects.
    onExec: (cb) => {
      const listener = (_evt, payload) => cb(payload);
      ipcRenderer.on('control:exec', listener);
      return () => ipcRenderer.removeListener('control:exec', listener);
    },
    reply: (id, ok, payload) => ipcRenderer.send(
      'control:reply',
      ok ? { id, ok: true, result: payload } : { id, ok: false, error: String(payload?.message || payload) },
    ),
  },
  agent: {
    submit: (tabId, text, options) => ipcRenderer.invoke('agent:submit', { tabId, text, options }),
    stop: (tabId) => ipcRenderer.invoke('agent:stop', { tabId }),
    onEvent: (cb) => {
      const l = (_evt, p) => cb(p);
      ipcRenderer.on('agent:event', l);
      return () => ipcRenderer.removeListener('agent:event', l);
    },
    onResult: (cb) => {
      const l = (_evt, p) => cb(p);
      ipcRenderer.on('agent:result', l);
      return () => ipcRenderer.removeListener('agent:result', l);
    },
    onExit: (cb) => {
      const l = (_evt, p) => cb(p);
      ipcRenderer.on('agent:exit', l);
      return () => ipcRenderer.removeListener('agent:exit', l);
    },
    onPermission: (cb) => {
      const l = (_evt, p) => cb(p);
      ipcRenderer.on('agent:permission', l);
      return () => ipcRenderer.removeListener('agent:permission', l);
    },
    replyPermission: (tabId, requestId, decision) =>
      ipcRenderer.invoke('agent:permission:reply', { tabId, requestId, decision }),
  },
  complete: (payload) => ipcRenderer.invoke('ai:complete', payload),
  platform: process.platform,
  homeDir: os.homedir(),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (s) => ipcRenderer.invoke('settings:set', s),
  },
  // Electron 32 deprecated File.path. Renderer code must use webUtils to
  // resolve a dropped File back to a filesystem path. webUtils itself isn't
  // exposed to the renderer under contextIsolation, so we proxy it through
  // preload. Safe — getPathForFile only works on File objects that
  // originated from a real drag-and-drop or <input type=file>.
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; }
    catch { return ''; }
  },
});
