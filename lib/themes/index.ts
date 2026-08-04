// Server-side theme resolution. NEVER import this from a client component —
// definitions embed page, menu, and sample-catalog payloads. Client surfaces
// import the lightweight lib/themes/meta.ts catalog instead.
import { DEFAULT_THEME_ID, THEME_META } from "./meta";
import { basket } from "./definitions/basket";
import type { ThemeDefinition } from "./types";

/** Keep older immutable releases here when a preset version advances. */
export const THEME_DEFINITIONS: readonly ThemeDefinition[] = [basket];

const BY_RELEASE = new Map(
  THEME_DEFINITIONS.map((theme) => [
    `${theme.id}@${theme.release.version}`,
    theme,
  ]),
);

function currentRelease(id: string): ThemeDefinition | undefined {
  const meta = THEME_META.find((theme) => theme.id === id);
  return meta ? BY_RELEASE.get(`${id}@${meta.release.version}`) : undefined;
}

/** Resolve an installed preset. A supplied version is honored when its
 * immutable definition remains registered. Missing/legacy versions fall back
 * to that preset's current release, then the platform default. */
export function getThemeDefinition(
  id: unknown,
  version?: unknown,
): ThemeDefinition {
  if (typeof id === "string") {
    if (typeof version === "string") {
      const pinned = BY_RELEASE.get(`${id}@${version}`);
      if (pinned) return pinned;
    }
    const current = currentRelease(id);
    if (current) return current;
  }
  const fallback = currentRelease(DEFAULT_THEME_ID);
  if (!fallback) {
    throw new Error(
      `Default theme release is not registered: ${DEFAULT_THEME_ID}`,
    );
  }
  return fallback;
}
