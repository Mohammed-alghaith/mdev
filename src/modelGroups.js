// ─── Shared model constants ───
// Extracted from PromptBar.jsx so App.jsx can import FALLBACK_MODEL_GROUPS
// without creating a circular dependency (PromptBar ↔ App).

// Effort levels are the CLI's --effort flag (low|medium|high|xhigh|max).
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Each entry's `base` is the literal --model value. The [1m] suffix selects
// the extended-context variants. `ceiling` is the real input context window
// for that variant. `effort` gates whether --effort sub-options are offered.
const CLAUDE_FALLBACK_MODEL_GROUPS = [
  { base: 'opus',       label: 'Opus',         ceiling: 200_000,   effort: true },
  { base: 'opus[1m]',   label: 'Opus · 1M',    ceiling: 1_000_000, effort: true },
  { base: 'sonnet',     label: 'Sonnet',       ceiling: 200_000,   effort: true },
  { base: 'sonnet[1m]', label: 'Sonnet · 1M',  ceiling: 1_000_000, effort: true },
  { base: 'haiku',      label: 'Haiku',        ceiling: 200_000,   effort: false },
];

export const FALLBACK_MODEL_GROUPS = CLAUDE_FALLBACK_MODEL_GROUPS;

// Priority so flagship families sort to the top; unknown families fall after.
const FAMILY_ORDER = ['opus', 'sonnet', 'haiku'];

// Turn the raw Models API list into dropdown groups.
export function buildModelGroups(models) {
  if (!Array.isArray(models) || models.length === 0) return FALLBACK_MODEL_GROUPS;
  const latestByFamily = new Map();
  for (const m of models) {
    const family = String(m.id || '').replace(/^claude-/, '').split('-')[0];
    if (!family) continue;
    const prev = latestByFamily.get(family);
    if (!prev || String(m.createdAt || '') > String(prev.createdAt || '')) {
      latestByFamily.set(family, m);
    }
  }
  const families = [...latestByFamily.keys()].sort((a, b) => {
    const ia = FAMILY_ORDER.indexOf(a), ib = FAMILY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  const groups = [];
  for (const family of families) {
    const m = latestByFamily.get(family);
    const label = String(m.displayName || family).replace(/^Claude\s+/i, '');
    groups.push({ base: family, label, ceiling: 200_000, effort: !!m.effort });
    if ((m.maxInputTokens || 0) >= 1_000_000) {
      groups.push({ base: family + '[1m]', label: label + ' · 1M', ceiling: m.maxInputTokens, effort: !!m.effort });
    }
  }
  return groups.length ? groups : FALLBACK_MODEL_GROUPS;
}

// Resolve the context ceiling for a model.
export function contextCeiling(model, tokens, modelGroups) {
  const base = String(model || '').split(':')[0];
  // 1. [1m] suffix variants → always 1M (Claude extended-context alias).
  if (base.includes('[1m]')) return 1_000_000;
  // 2. Provider models carry their own ceiling (e.g. DeepSeek V4 Pro → 1M).
  const group = (modelGroups || []).find((g) => g.base === base);
  if (group?.ceiling) return group.ceiling;
  // 3. Auto-promote: if actual usage exceeds 200K we're clearly on a 1M model.
  if (tokens > 195_000) return 1_000_000;
  // 4. Default (opus, sonnet, haiku, "").
  return 200_000;
}

export function modelBase(model) {
  return String(model || '').split(':')[0];
}
