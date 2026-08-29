"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const ASSISTANT_NAME = "Mink AI";
export const CANNED_REPLY = `Hi, I'm ${ASSISTANT_NAME} — your store assistant. I'm coming soon, and I'll be able to answer questions about your products, orders and customers right here.`;
const REPLY_DELAY_MS = 500;

export type MinkMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
};

export type MinkUiError = {
  code: string;
  message: string;
};

type SsePayload = Record<string, unknown>;

export function useMinkAi({ enabled }: { enabled: boolean }) {
  const [messages, setMessages] = useState<MinkMessage[]>([]);
  const [input, setInput] = useState("");
  const [isReplying, setIsReplying] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [error, setError] = useState<MinkUiError | null>(null);
  const nextId = useRef(0);
  const isReplyingRef = useRef(false);
  const conversationId = useRef<string | null>(null);
  const lastFailedMessage = useRef<string | null>(null);
  const abortController = useRef<AbortController | null>(null);
  const replyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setReplying = useCallback((value: boolean) => {
    isReplyingRef.current = value;
    setIsReplying(value);
  }, []);

  useEffect(() => {
    return () => {
      abortController.current?.abort();
      if (replyTimer.current) clearTimeout(replyTimer.current);
    };
  }, []);

  const run = useCallback(
    async (text: string, appendUser: boolean) => {
      if (!text || isReplyingRef.current) return;
      if (appendUser) {
        setMessages((previous) => [
          ...previous,
          { id: nextId.current++, role: "user", text },
        ]);
      }
      setInput("");
      setError(null);
      lastFailedMessage.current = null;
      setStatusText(enabled ? "Thinking…" : "Getting ready…");
      setReplying(true);

      if (!enabled) {
        replyTimer.current = setTimeout(() => {
          setMessages((previous) => [
            ...previous,
            {
              id: nextId.current++,
              role: "assistant",
              text: CANNED_REPLY,
            },
          ]);
          setStatusText(null);
          setReplying(false);
        }, REPLY_DELAY_MS);
        return;
      }

      const controller = new AbortController();
      abortController.current = controller;
      let receivedMessage = false;
      let streamedError: MinkUiError | null = null;

      try {
        const response = await fetch("/api/mink/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            ...(conversationId.current
              ? { conversationId: conversationId.current }
              : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw await responseError(response);
        if (!response.body) {
          throw new Error("Mink AI returned an unreadable response.");
        }

        await consumeMinkSse(response.body, (event, data) => {
          if (event === "status") {
            if (typeof data.conversationId === "string") {
              conversationId.current = data.conversationId;
            }
            setStatusText("Thinking…");
          } else if (event === "tool") {
            const name =
              typeof data.name === "string"
                ? readableToolName(data.name)
                : "store data";
            setStatusText(
              data.state === "failed"
                ? `Couldn’t read ${name}`
                : `Reading ${name}…`,
            );
          } else if (event === "message" && typeof data.text === "string") {
            const responseText = data.text;
            receivedMessage = true;
            setMessages((previous) => [
              ...previous,
              {
                id: nextId.current++,
                role: "assistant",
                text: responseText,
              },
            ]);
          } else if (event === "error") {
            streamedError = {
              code: typeof data.code === "string" ? data.code : "mink_failed",
              message:
                typeof data.message === "string"
                  ? data.message
                  : "Mink AI couldn't complete that request.",
            };
          }
        });

        if (streamedError) throw streamedError;
        if (!receivedMessage) {
          throw new Error("Mink AI finished without an answer.");
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          const nextError = toUiError(caught);
          setError(nextError);
          lastFailedMessage.current = text;
        }
      } finally {
        if (abortController.current === controller) {
          abortController.current = null;
          setStatusText(null);
          setReplying(false);
        }
      }
    },
    [enabled, setReplying],
  );

  const send = useCallback(
    (raw?: string) => {
      const text = (raw ?? input).trim();
      void run(text, true);
    },
    [input, run],
  );

  const cancel = useCallback(() => {
    setStatusText("Stopping…");
    abortController.current?.abort();
  }, []);

  const retry = useCallback(() => {
    const text = lastFailedMessage.current;
    if (text) void run(text, false);
  }, [run]);

  const reset = useCallback(() => {
    abortController.current?.abort();
    if (replyTimer.current) clearTimeout(replyTimer.current);
    conversationId.current = null;
    lastFailedMessage.current = null;
    setMessages([]);
    setInput("");
    setStatusText(null);
    setError(null);
    setReplying(false);
  }, [setReplying]);

  return {
    enabled,
    messages,
    input,
    setInput,
    isReplying,
    statusText,
    error,
    send,
    cancel,
    retry,
    reset,
  };
}

export async function consumeMinkSse(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: SsePayload) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let separator = buffer.match(/\r?\n\r?\n/);
    while (separator?.index !== undefined) {
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      emitSseBlock(block, onEvent);
      separator = buffer.match(/\r?\n\r?\n/);
    }
    if (done) break;
  }
  if (buffer.trim()) emitSseBlock(buffer, onEvent);
}

function emitSseBlock(
  block: string,
  onEvent: (event: string, data: SsePayload) => void,
) {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:"))
      dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return;
  const parsed = JSON.parse(dataLines.join("\n")) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    onEvent(event, parsed as SsePayload);
  }
}

async function responseError(response: Response): Promise<MinkUiError> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") {
      return { code: `http_${response.status}`, message: body.error };
    }
  } catch {
    // Fall through to the safe status-based message.
  }
  return {
    code: `http_${response.status}`,
    message: "Mink AI couldn't start that request. Try again.",
  };
}

function toUiError(error: unknown): MinkUiError {
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return error as MinkUiError;
  }
  return {
    code: "mink_failed",
    message: "Mink AI couldn't complete that request. Try again.",
  };
}

function readableToolName(name: string): string {
  const labels: Record<string, string> = {
    get_store_profile: "store details",
    get_catalog_summary: "catalog",
    search_products: "products",
  };
  return labels[name] ?? name.replaceAll("_", " ");
}
