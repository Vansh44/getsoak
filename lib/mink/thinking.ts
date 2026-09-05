import type { MinkToolDeclaration } from "./types";

export type MinkThinkingLevel = "low" | "high";

const STOREFRONT_CODE_TOOL = "propose_storefront_custom_code";
const CREATION_WORDS =
  "create|build|redesign|generate|write|edit|update|replace|improve|fix|restyle|animate|code";
const STOREFRONT_WORDS =
  "storefront|website|home ?page|landing page|page|section|hero|banner|carousel|custom code|html|css|javascript|js";
const STOREFRONT_CODE_REQUEST = new RegExp(
  `(?:\\bdesign\\b[\\s\\S]{0,120}\\b(?:${STOREFRONT_WORDS})\\b)|(?:\\b(?:${CREATION_WORDS})\\b[\\s\\S]{0,240}\\b(?:${STOREFRONT_WORDS})\\b)|(?:\\b(?:${STOREFRONT_WORDS})\\b[\\s\\S]{0,240}\\b(?:${CREATION_WORDS})\\b)`,
  "i",
);

/**
 * Select expensive reasoning only for an explicit code-generation request and
 * only when the trusted registry has exposed the Phase 7B proposal tool. The
 * user's text can request effort, but it cannot grant itself a capability.
 */
export function selectMinkThinkingLevel(
  message: string,
  declarations: Pick<MinkToolDeclaration, "name">[],
): MinkThinkingLevel {
  const canProposeStorefrontCode = declarations.some(
    (declaration) => declaration.name === STOREFRONT_CODE_TOOL,
  );
  return canProposeStorefrontCode && STOREFRONT_CODE_REQUEST.test(message)
    ? "high"
    : "low";
}
