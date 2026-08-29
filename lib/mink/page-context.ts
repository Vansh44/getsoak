import type { MinkSelectedResource } from "./types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MinkPageContextInput {
  currentPath?: unknown;
  selectedResource?: unknown;
}

export interface MinkPageContext {
  currentPath: string | null;
  selectedResource: MinkSelectedResource | null;
}

/** Browser context is navigation help, never authority. Keep only bounded dashboard values. */
export function normalizeMinkPageContext(
  input: MinkPageContextInput | undefined,
): MinkPageContext {
  const rawPath = input?.currentPath;
  const currentPath =
    typeof rawPath === "string" &&
    (rawPath === "/dashboard" || rawPath.startsWith("/dashboard/")) &&
    !rawPath.includes("\n") &&
    !rawPath.includes("\r")
      ? rawPath.slice(0, 500)
      : null;
  const rawResource = input?.selectedResource;
  let selectedResource: MinkSelectedResource | null = null;
  if (
    rawResource &&
    typeof rawResource === "object" &&
    !Array.isArray(rawResource)
  ) {
    const row = rawResource as Record<string, unknown>;
    if (
      (row.type === "product" || row.type === "order") &&
      typeof row.id === "string" &&
      UUID_PATTERN.test(row.id)
    ) {
      selectedResource = { type: row.type, id: row.id };
    }
  }
  return { currentPath, selectedResource };
}
