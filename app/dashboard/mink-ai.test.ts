import { describe, expect, it, vi } from "vitest";
import { consumeMinkSse } from "./mink-ai";

describe("consumeMinkSse", () => {
  it("parses events split across network chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: sta"));
        controller.enqueue(
          encoder.encode(
            'tus\ndata: {"conversationId":"conversation-1"}\n\nevent: message\n',
          ),
        );
        controller.enqueue(encoder.encode('data: {"text":"Ready"}\n\n'));
        controller.close();
      },
    });
    const onEvent = vi.fn();

    await consumeMinkSse(stream, onEvent);

    expect(onEvent).toHaveBeenNthCalledWith(1, "status", {
      conversationId: "conversation-1",
    });
    expect(onEvent).toHaveBeenNthCalledWith(2, "message", { text: "Ready" });
  });

  it("rejects malformed JSON instead of displaying untrusted stream text", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode("event: message\ndata: not-json\n\n"),
        );
        controller.close();
      },
    });

    await expect(consumeMinkSse(stream, vi.fn())).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });
});
