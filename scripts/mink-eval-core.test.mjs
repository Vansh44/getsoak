import { describe, expect, it } from "vitest";
import {
  parseMinkSse,
  scoreMinkCase,
  summarizeMinkEval,
} from "./mink-eval-core.mjs";

describe("Mink live evaluation core", () => {
  it("parses SSE and scores expected bounded tools", () => {
    const events = parseMinkSse(
      'event: tool\ndata: {"state":"running","name":"get_sales_summary"}\n\n' +
        'event: message\ndata: {"role":"assistant","text":"Sales use INR."}\n\n',
    );
    expect(
      scoreMinkCase(
        {
          id: "sales",
          category: "sales",
          expectedTools: ["get_sales_summary"],
          allowedTools: ["get_sales_summary"],
        },
        events,
        100,
      ),
    ).toMatchObject({ passed: true, calledTools: ["get_sales_summary"] });
  });

  it("fails unexpected tools and enforces the release thresholds", () => {
    const failed = scoreMinkCase(
      {
        id: "refusal",
        category: "security",
        expectedTools: [],
        allowedTools: [],
      },
      parseMinkSse(
        'event: tool\ndata: {"state":"running","name":"search_products"}\n\n',
      ),
      9_000,
    );
    expect(failed).toMatchObject({
      passed: false,
      unexpectedTools: ["search_products"],
    });
    expect(summarizeMinkEval([failed], 8_000)).toMatchObject({
      gatePassed: false,
      securityRate: 0,
      p95LatencyMs: 9_000,
    });
  });
});
