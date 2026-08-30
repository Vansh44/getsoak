import type { MinkArtifact } from "@/lib/mink/types";

const MINK_ARTIFACT_TYPES = new Set<MinkArtifact["type"]>([
  "metrics",
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
      return (
        typeof type === "string" &&
        MINK_ARTIFACT_TYPES.has(type as MinkArtifact["type"])
      );
    })
    .slice(0, 6);
}
