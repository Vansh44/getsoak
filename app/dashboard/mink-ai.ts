"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Mink AI is a placeholder assistant: every message gets the same canned reply
// until the real assistant ships. Both surfaces (the Home "Ask anything…" box
// and the DashboardChat side panel) share this one hook, so there's a single
// place to swap when it does.
export const ASSISTANT_NAME = "Mink AI";
export const CANNED_REPLY = `Hi, I'm ${ASSISTANT_NAME} — your store assistant. I'm coming soon, and I'll be able to answer questions about your products, orders and customers right here.`;
const REPLY_DELAY_MS = 500;

export type MinkMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
};

export function useMinkAi() {
  const [messages, setMessages] = useState<MinkMessage[]>([]);
  const [input, setInput] = useState("");
  const [isReplying, setIsReplying] = useState(false);
  const nextId = useRef(0);
  // Tracked so an unmount (or a reset) never fires a reply into a conversation
  // the user has already moved on from.
  const replyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (replyTimer.current) clearTimeout(replyTimer.current);
    };
  }, []);

  const send = useCallback(
    (raw?: string) => {
      const text = (raw ?? input).trim();
      if (!text || isReplying) return;

      setMessages((prev) => [
        ...prev,
        { id: nextId.current++, role: "user", text },
      ]);
      setInput("");
      setIsReplying(true);

      replyTimer.current = setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          { id: nextId.current++, role: "assistant", text: CANNED_REPLY },
        ]);
        setIsReplying(false);
      }, REPLY_DELAY_MS);
    },
    [input, isReplying],
  );

  const reset = useCallback(() => {
    if (replyTimer.current) clearTimeout(replyTimer.current);
    setMessages([]);
    setInput("");
    setIsReplying(false);
  }, []);

  return { messages, input, setInput, isReplying, send, reset };
}
