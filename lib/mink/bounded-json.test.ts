import { describe, it, expect } from "vitest";
import { readMinkBoundedJson } from "./bounded-json";
describe("bounded Mink JSON", () => {
  it("accepts bounded objects without trusting a length header", async () => {
    expect(
      await readMinkBoundedJson(
        new Request("https://example.test", {
          method: "POST",
          body: '{"ok":true}',
        }),
        20,
      ),
    ).toEqual({ ok: true });
  });
  it("refuses oversized bodies with missing or forged content length", async () => {
    await expect(
      readMinkBoundedJson(
        new Request("https://example.test", {
          method: "POST",
          headers: { "Content-Length": "1" },
          body: JSON.stringify({ text: "x".repeat(200) }),
        }),
        20,
      ),
    ).rejects.toMatchObject({ status: 413 });
  });
  it.each(["[]", "null", "no-json"])(
    "rejects malformed/nonobject input %s",
    async (body) => {
      await expect(
        readMinkBoundedJson(
          new Request("https://example.test", { method: "POST", body }),
          100,
        ),
      ).rejects.toMatchObject({ status: 400 });
    },
  );
});
