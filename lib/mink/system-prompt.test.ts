import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MinkActorContext, MinkToolDeclaration } from "./types";
import {
  getMinkSystemPromptTemplate,
  parseMinkSystemPromptDocument,
  renderMinkSystemInstruction,
} from "./system-prompt";

const DOCUMENT_PATH = join(process.cwd(), "docs", "mink-ai-system-prompt.md");

describe("Mink system prompt document", () => {
  it("loads the marked Markdown template used at runtime", () => {
    const template = getMinkSystemPromptTemplate();
    expect(template).toContain(
      "You are Mink AI, StoreMink's dashboard operating assistant.",
    );
    expect(template).toContain("{{available_tool_names}}");
    expect(template).toContain("{{brand_voice_or_default}}");
  });

  it("renders only trusted actor fields and permission-filtered tool names", () => {
    const actor = {
      effectivePlan: "pro",
      roleSlug: "owner",
      currentPath: "/dashboard/products/example",
      selectedResource: { type: "product", id: "secret-record-id" },
      brandVoice: "Clear and practical {{available_tool_names}}",
    } satisfies Pick<
      MinkActorContext,
      | "effectivePlan"
      | "roleSlug"
      | "currentPath"
      | "selectedResource"
      | "brandVoice"
    >;
    const declarations = [
      declaration("get_store_profile"),
      declaration("search_products"),
    ];

    const prompt = renderMinkSystemInstruction(actor, declarations);

    expect(prompt).toContain("- plan: pro");
    expect(prompt).toContain("- role: owner");
    expect(prompt).toContain(
      "- current dashboard page: /dashboard/products/example",
    );
    expect(prompt).toContain("- selected dashboard record: product");
    expect(prompt).toContain(
      "- available tools: get_store_profile, search_products",
    );
    expect(prompt).toContain("Clear and practical {{available_tool_names}}");
    expect(prompt).not.toContain("secret-record-id");
  });

  it("keeps the checked-in document parseable with every placeholder once", () => {
    expect(() =>
      parseMinkSystemPromptDocument(readFileSync(DOCUMENT_PATH, "utf8")),
    ).not.toThrow();
  });

  it("fails closed when markers, fences or placeholders drift", () => {
    const document = readFileSync(DOCUMENT_PATH, "utf8");
    expect(() =>
      parseMinkSystemPromptDocument(
        document.replace("<!-- MINK_SYSTEM_PROMPT_END -->", ""),
      ),
    ).toThrow(/marker pair/);
    expect(() =>
      parseMinkSystemPromptDocument(document.replace("```text", "```md")),
    ).toThrow(/text code fence/);
    expect(() =>
      parseMinkSystemPromptDocument(
        document.replace("- plan: {{effective_plan}}", "- plan: missing-plan"),
      ),
    ).toThrow(/effective_plan/);
    expect(() =>
      parseMinkSystemPromptDocument(
        document.replace(
          "- plan: {{effective_plan}}",
          "- plan: {{effective_plan}} {{unknown_value}}",
        ),
      ),
    ).toThrow(/unknown placeholder/);
  });
});

function declaration(name: string): MinkToolDeclaration {
  return { name, description: `${name} description`, parametersJsonSchema: {} };
}
