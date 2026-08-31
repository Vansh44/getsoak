import type { MinkArtifact } from "@/lib/mink/types";

const MINK_ARTIFACT_TYPES = new Set<MinkArtifact["type"]>([
  "metrics",
  "catalog",
  "records",
  "sources",
  "proposal",
]);

export function readMinkArtifacts(value: unknown): MinkArtifact[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((artifact): artifact is MinkArtifact => {
      if (!artifact || typeof artifact !== "object") return false;
      const type = (artifact as { type?: unknown }).type;
      const allowed =
        typeof type === "string" &&
        MINK_ARTIFACT_TYPES.has(type as MinkArtifact["type"]);
      if (!allowed) return false;
      if (type !== "catalog") return true;
      const catalog = artifact as Record<string, unknown>;
      return (
        catalog.counts !== null &&
        typeof catalog.counts === "object" &&
        !Array.isArray(catalog.counts) &&
        Array.isArray(catalog.items) &&
        catalog.items.length <= 20 &&
        Array.isArray(catalog.filters)
      );
    })
    .slice(0, 6);
}
