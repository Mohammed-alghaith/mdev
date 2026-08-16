import React, { useState } from 'react';

// Static metadata for every provider the app knows about. The user supplies the
// API key (and optionally overrides the base URL) via the settings dialog; only
// providers with a non-empty key are considered "enabled" and their models
// appear in the prompt-bar dropdown.
export const KNOWN_PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/anthropic',
    models: [
      { base: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', ceiling: 1_000_000 },
    ],
  },
};

// Build the flat list of models from enabled providers (those whose apiKey is
// set in the current settings). Additional metadata (ceiling, effort, etc.) is
// carried through so PromptBar can render the dropdown correctly.
export function enabledProviderModels(settings) {
  const models = [];
  for (const [id, prov] of Object.entries(KNOWN_PROVIDERS)) {
    const configured = settings?.providers?.[id];
    if (!configured?.apiKey) continue;
    for (const m of prov.models) {
      models.push({ ...m, provider: id });
    }
  }
  return models;
}

// Resolve the inline env-var prefix for a model from a known provider. Returns
// '' if the provider is not configured (no key) so callers can bail gracefully.
export function buildProviderEnvPrefix(base, settings) {
  for (const [id, prov] of Object.entries(KNOWN_PROVIDERS)) {
    const match = prov.models.find((m) => m.base === base);
    if (!match) continue;
    const configured = settings?.providers?.[id];
    if (!configured?.apiKey) return '';
    // shellQuote each value so the command survives zsh/bash word-splitting.
    const sq = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
    return (
      'ANTHROPIC_BASE_URL=' + sq(configured.baseUrl || prov.defaultBaseUrl) + ' ' +
      'ANTHROPIC_AUTH_TOKEN=' + sq(configured.apiKey) + ' ' +
      'ANTHROPIC_MODEL=' + sq(base) + ' '
    );
  }
  return '';
}

function EyeIcon({ open }) {
  return open ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

export default function SettingsDialog({ open, settings, onSave, onClose }) {
  // Local mutable copy so Cancel discards edits without touching parent state.
  const [draft, setDraft] = useState(null);
  const [visibleKeys, setVisibleKeys] = useState({});

  const current = draft || settings || {};

  if (!open) return null;

  const set = (providerId, key, value) => {
    setDraft((prev) => {
      const base = prev || settings || {};
      return {
        ...base,
        providers: {
          ...(base.providers || {}),
          [providerId]: {
            ...(base.providers?.[providerId] || {}),
            [key]: value,
          },
        },
      };
    });
  };

  const toggleKeyVisibility = (id) => {
    setVisibleKeys((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleSave = () => {
    onSave(draft || settings);
    setDraft(null);
  };

  const handleClose = () => {
    setDraft(null);
    setVisibleKeys({});
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/60" onClick={handleClose} />

      <div className="relative w-full max-w-md mx-4 bg-ink-800 border border-ink-700 rounded-xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-ink-700">
          <h2 className="text-sm font-semibold text-ink-100">Settings</h2>
          <button
            onClick={handleClose}
            className="flex items-center justify-center w-7 h-7 rounded-md text-ink-300 hover:text-ink-100 hover:bg-ink-700 transition"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-5">
          {Object.entries(KNOWN_PROVIDERS).map(([id, prov]) => {
            const cfg = current.providers?.[id] || {};
            const apiKey = cfg.apiKey || '';
            const baseUrl = cfg.baseUrl || prov.defaultBaseUrl;
            const showKey = visibleKeys[id] || false;

            return (
              <div key={id}>
                <h3 className="text-xs font-semibold tracking-wide text-ink-300 uppercase mb-2">
                  {prov.name}
                </h3>

                {/* API Key */}
                <label className="block text-[10px] text-ink-300 mb-1">API Key</label>
                <div className="flex items-center gap-1 mb-3">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => set(id, 'apiKey', e.target.value)}
                    placeholder="Enter API key…"
                    spellCheck={false}
                    className="flex-1 bg-ink-900 text-ink-100 text-xs px-3 py-1.5 rounded-md border border-ink-700 focus:outline-none focus:border-accent-500 transition font-mono"
                  />
                  <button
                    onClick={() => toggleKeyVisibility(id)}
                    title={showKey ? 'Hide key' : 'Show key'}
                    className="shrink-0 flex items-center justify-center w-7 h-7 rounded-md text-ink-300 hover:text-ink-100 hover:bg-ink-700 transition"
                  >
                    <EyeIcon open={showKey} />
                  </button>
                </div>

                {/* Base URL */}
                <label className="block text-[10px] text-ink-300 mb-1">Base URL</label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => set(id, 'baseUrl', e.target.value)}
                  placeholder={prov.defaultBaseUrl}
                  spellCheck={false}
                  className="w-full bg-ink-900 text-ink-100 text-xs px-3 py-1.5 rounded-md border border-ink-700 focus:outline-none focus:border-accent-500 transition font-mono"
                />

                {/* Models hint */}
                <p className="text-[10px] text-ink-300 mt-2">
                  Models: {prov.models.map((m) => m.label).join(', ')}
                </p>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-ink-700">
          <button
            onClick={handleClose}
            className="px-4 py-1.5 text-xs rounded-md bg-ink-700 text-ink-200 hover:bg-ink-600 transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 text-xs rounded-md bg-accent-500 text-accent-fg font-semibold hover:bg-accent-400 transition"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
