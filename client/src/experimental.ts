/**
 * Opt-in experiment flags, read from URL params on page load.
 *
 * Usage:
 *   http://localhost:5173/?char=quat   → swap to experimental Quaternius character
 *   http://localhost:5173/?char=reset  → force back to default (useful after testing)
 *
 * The value is cached in localStorage so survives reloads without re-typing
 * the query string. Set `?char=reset` to clear.
 */

const CHAR_OVERRIDE_MAP: Record<string, string> = {
  // Drop the pack's .glb at this path and it'll load when ?char=quat is used.
  // Pick a single GLB from the Quaternius Universal Base Characters pack.
  quat: '/Character models/quaternius_base.glb',
};

function parseCharOverride(): string | null {
  if (typeof window === 'undefined') return null;
  const qs = new URLSearchParams(window.location.search);
  const urlVal = qs.get('char');
  if (urlVal === 'reset') {
    localStorage.removeItem('experimental.char');
    return null;
  }
  if (urlVal && CHAR_OVERRIDE_MAP[urlVal]) {
    localStorage.setItem('experimental.char', urlVal);
    return CHAR_OVERRIDE_MAP[urlVal];
  }
  const stored = localStorage.getItem('experimental.char');
  if (stored && CHAR_OVERRIDE_MAP[stored]) return CHAR_OVERRIDE_MAP[stored];
  return null;
}

let cachedCharOverride: string | null | undefined;

export function getExperimentalCharacterPath(): string | null {
  if (cachedCharOverride === undefined) {
    cachedCharOverride = parseCharOverride();
    if (cachedCharOverride) {
      console.log(`[experimental] character model override active: ${cachedCharOverride}`);
    }
  }
  return cachedCharOverride;
}
