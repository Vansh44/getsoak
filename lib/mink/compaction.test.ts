import { describe, expect, it } from "vitest";
import {
  historyWithCompaction,
  MINK_HISTORY_COMPACTION_THRESHOLD,
  MINK_HISTORY_RECENT_MESSAGES,
} from "./compaction";

describe("historyWithCompaction", () => {
  it("keeps short conversations verbatim", () => {
    const messages = [{ role: "user" as const, text: "hello" }];
    expect(historyWithCompaction(messages)).toEqual({
      history: messages,
      summary: null,
      summarizedMessageCount: 0,
    });
  });

  it("summarizes older turns and preserves the newest turns verbatim", () => {
    const messages = Array.from(
      { length: MINK_HISTORY_COMPACTION_THRESHOLD + 2 },
      (_, index) => ({
        role: index % 2 ? ("assistant" as const) : ("user" as const),
        text: `turn ${index}`,
      }),
    );
    const compacted = historyWithCompaction(messages);
    expect(compacted.summarizedMessageCount).toBe(
      messages.length - MINK_HISTORY_RECENT_MESSAGES,
    );
    expect(compacted.summary).toContain("Merchant: turn 0");
    expect(compacted.history.slice(-MINK_HISTORY_RECENT_MESSAGES)).toEqual(
      messages.slice(-MINK_HISTORY_RECENT_MESSAGES),
    );
  });
});
