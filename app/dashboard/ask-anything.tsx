"use client";

import { ArrowUp, Sparkles } from "lucide-react";
import { useState } from "react";
import { useChat } from "./chat-context";
import { ASSISTANT_NAME } from "./mink-ai";

// The Home "Ask anything…" box. Submitting opens Mink AI in full view (a
// Shopify Sidekick-style takeover) with the typed message carried over — it
// does NOT answer inline, and does NOT open the narrow side panel.
export function AskAnything() {
  const { isChatOpen, startExpandedChat } = useChat();
  const [text, setText] = useState("");

  // Once Mink AI is open (side panel or full view) the conversation lives there,
  // so the Home box steps aside — mirrors Shopify's home when Sidekick is active.
  if (isChatOpen) return null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    startExpandedChat(value);
    setText("");
  }

  return (
    <form
      onSubmit={submit}
      className="group flex w-full items-center gap-3 rounded-[var(--dash-radius)] border border-[var(--dash-border)] bg-[var(--dash-surface)] px-4 py-3.5 shadow-[var(--dash-shadow-xs)] transition-colors focus-within:border-[var(--dash-accent)]"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--dash-accent-soft)] text-[var(--dash-accent)]">
        <Sparkles className="h-4 w-4" />
      </span>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ask anything…"
        aria-label={`Message ${ASSISTANT_NAME}`}
        // Same keyboard contract as the chat composer — see dashboard-chat.tsx.
        // Submitting here opens the full view and sends, so Return is a send.
        enterKeyHint="send"
        autoComplete="off"
        autoCapitalize="sentences"
        autoCorrect="on"
        className="min-w-0 flex-1 bg-transparent text-base text-[var(--dash-text)] outline-none placeholder:text-[var(--dash-text-3)] sm:text-[15px]"
      />
      {text.trim() ? (
        <button
          type="submit"
          aria-label="Send message"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--dash-accent)] text-white transition-opacity hover:opacity-90"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      ) : (
        <span className="hidden text-[12px] font-medium text-[var(--dash-text-3)] sm:inline">
          {ASSISTANT_NAME}
        </span>
      )}
    </form>
  );
}
