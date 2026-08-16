const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SETTINGS_PATH = path.join(os.homedir(), '.claude-terminal', 'settings.json');

function defaults() {
  return {
    providers: {
      deepseek: {
        apiKey: '',
        baseUrl: 'https://api.deepseek.com/anthropic',
      },
    },
  };
}

function getSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    // Deep-merge with defaults so new provider entries appear automatically.
    const base = defaults();
    if (data && data.providers) {
      for (const [id, def] of Object.entries(base.providers)) {
        base.providers[id] = { ...def, ...(data.providers[id] || {}) };
      }
      // Also carry over any user-added providers not in defaults.
      for (const id of Object.keys(data.providers)) {
        if (!base.providers[id]) {
          base.providers[id] = data.providers[id];
        }
      }
    }
    return base;
  } catch {
    return defaults();
  }
}

function saveSettings(obj) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2), 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

module.exports = { getSettings, saveSettings, SETTINGS_PATH };
