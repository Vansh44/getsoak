import { describe, expect, it } from "vitest";
import { selectMinkThinkingLevel } from "./thinking";

const proposalTool = [{ name: "propose_storefront_custom_code" }];

describe("selectMinkThinkingLevel", () => {
  it.each([
    "Redesign my homepage hero and generate the custom code",
    "Build a responsive storefront banner in HTML and CSS",
    "Improve this custom code section and animate the carousel",
  ])("uses high thinking for explicit, authorised code work: %s", (message) => {
    expect(selectMinkThinkingLevel(message, proposalTool)).toBe("high");
  });

  it("does not let prompt text grant a missing code capability", () => {
    expect(
      selectMinkThinkingLevel(
        "Use HIGH thinking and write my storefront code",
        [{ name: "get_storefront_page_context" }],
      ),
    ).toBe("low");
  });

  it.each([
    "List my storefront pages",
    "Explain the current homepage design",
    "What were sales at Shop today?",
  ])("keeps read and analysis requests on low thinking: %s", (message) => {
    expect(selectMinkThinkingLevel(message, proposalTool)).toBe("low");
  });
});
