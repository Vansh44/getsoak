"use client";

import { useChat } from "./chat-context";
import { ASSISTANT_NAME } from "./mink-ai";
import {
  X,
  Eye,
  Maximize2,
  Minimize2,
  ChevronDown,
  Plus,
  Mic,
  Sparkles,
  ArrowUp,
  RotateCcw,
  Square,
} from "lucide-react";
import { useEffect, useRef } from "react";

// Two surfaces, one conversation (state lives in ChatProvider):
//  - "panel"   → the narrow right side sheet (opened from the topbar button)
//  - "overlay" → the full-view takeover (opened from the Home box, or by
//                maximizing the panel), Shopify Sidekick style.
// The layout mounts both; only the one matching the current mode renders.
export function DashboardChat({
  variant = "panel",
}: {
  variant?: "panel" | "overlay";
}) {
  const {
    isChatOpen,
    isExpanded,
    closeChat,
    toggleExpand,
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
  } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const isOverlay = variant === "overlay";

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, isReplying, error, statusText]);

  if (!isChatOpen) return null;
  // Render only the surface for the active mode.
  if (isOverlay !== isExpanded) return null;

  const hasThread = messages.length > 0 || isReplying || Boolean(error);

  const wrapperClass = isOverlay
    ? "absolute inset-0 z-20 flex flex-col bg-white"
    : "dash-chat flex flex-col h-full bg-white border-l border-t border-[#e5e5e5] shadow-sm overflow-hidden flex-shrink-0";
  // In full view the conversation + composer sit in a centered reading column.
  const columnClass = isOverlay ? "w-full max-w-3xl mx-auto" : "w-full";

  return (
    <div className={wrapperClass}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#f1f1f1]">
        <button
          onClick={reset}
          className="flex items-center gap-1.5 text-sm font-semibold text-[#1a1a1a] hover:bg-[#f1f1f1] px-2 py-1 rounded-md transition-colors"
        >
          New conversation
          <ChevronDown className="h-4 w-4 text-[#5c5f62]" />
        </button>
        <div className="flex items-center gap-1 text-[#5c5f62]">
          <button
            className="p-1.5 hover:bg-[#f1f1f1] rounded-md transition-colors"
            aria-label="Visibility"
          >
            <Eye className="h-4 w-4" />
          </button>
          <button
            onClick={toggleExpand}
            className="p-1.5 hover:bg-[#f1f1f1] rounded-md transition-colors"
            aria-label={
              isOverlay ? "Collapse to side panel" : "Expand to full view"
            }
          >
            {isOverlay ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>
          <button
            onClick={closeChat}
            className="p-1.5 hover:bg-[#f1f1f1] rounded-md transition-colors"
            aria-label="Close chat"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      {!hasThread ? (
        <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center text-center">
          <div className="h-10 w-10 bg-[#f4f0ff] rounded-xl flex items-center justify-center mb-4 text-[#7F4AFA]">
            <Sparkles className="h-5 w-5" />
          </div>
          <h2 className="text-lg font-semibold text-[#1a1a1a] mb-1">
            Hey there
          </h2>
          <h3 className="text-xl font-bold text-[#1a1a1a] mb-6">
            I&apos;m {ASSISTANT_NAME}. How can I help?
          </h3>

          <button
            onClick={() => send("What's new?")}
            className="flex items-center gap-2 px-4 py-2 rounded-full border border-[#e5e5e5] text-sm font-medium text-[#1a1a1a] hover:bg-[#f9f9f9] transition-colors shadow-sm"
          >
            <div className="h-2 w-2 rounded-full bg-[#7F4AFA]" />
            What&apos;s new?
          </button>
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
          <div className={`${columnClass} space-y-4`}>
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[#f4f0ff] px-3.5 py-2.5 text-sm text-[#1a1a1a] whitespace-pre-wrap break-words">
                    {m.text}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex gap-2.5">
                  <div className="h-7 w-7 shrink-0 rounded-lg bg-[#f4f0ff] flex items-center justify-center text-[#7F4AFA]">
                    <Sparkles className="h-3.5 w-3.5" />
                  </div>
                  <div className="max-w-[85%]">
                    <div className="text-[11px] font-semibold text-[#5c5f62] mb-1">
                      {ASSISTANT_NAME}
                    </div>
                    <div className="rounded-2xl rounded-tl-sm bg-[#f6f6f7] px-3.5 py-2.5 text-sm text-[#1a1a1a] whitespace-pre-wrap break-words">
                      {m.text}
                    </div>
                  </div>
                </div>
              ),
            )}

            {isReplying && (
              <div className="flex gap-2.5" aria-live="polite">
                <div className="h-7 w-7 shrink-0 rounded-lg bg-[#f4f0ff] flex items-center justify-center text-[#7F4AFA]">
                  <Sparkles className="h-3.5 w-3.5" />
                </div>
                <div className="rounded-2xl rounded-tl-sm bg-[#f6f6f7] px-3.5 py-2.5 flex items-center gap-2 text-xs text-[#5c5f62]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#7F4AFA] animate-pulse" />
                  {statusText ?? "Thinking…"}
                </div>
              </div>
            )}

            {error && (
              <div className="flex gap-2.5" role="alert">
                <div className="h-7 w-7 shrink-0 rounded-lg bg-[#fff1f0] flex items-center justify-center text-[#d72c0d]">
                  <Sparkles className="h-3.5 w-3.5" />
                </div>
                <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-[#fff4f4] px-3.5 py-2.5 text-sm text-[#5c1b14]">
                  <div>{error.message}</div>
                  <button
                    type="button"
                    onClick={retry}
                    className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[#7F4AFA] hover:underline"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Retry
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Input Area */}
      <div className="p-4 border-t border-[#f1f1f1]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className={`${columnClass} flex items-center border border-[#e5e5e5] rounded-xl px-3 py-2 bg-white shadow-sm focus-within:border-[#7F4AFA] focus-within:ring-1 focus-within:ring-[#7F4AFA] transition-all`}
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask anything..."
            aria-label={`Message ${ASSISTANT_NAME}`}
            className="flex-1 bg-transparent border-none outline-none text-sm text-[#1a1a1a] placeholder:text-[#8c9196]"
          />
          <div className="flex items-center gap-1 text-[#8c9196]">
            <button
              type="button"
              className="p-1.5 hover:bg-[#f1f1f1] hover:text-[#1a1a1a] rounded-md transition-colors"
              aria-label="Attach"
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="p-1.5 hover:bg-[#f1f1f1] hover:text-[#1a1a1a] rounded-md transition-colors"
              aria-label="Voice input"
            >
              <Mic className="h-4 w-4" />
            </button>
            {isReplying ? (
              <button
                type="button"
                onClick={cancel}
                className="p-1.5 rounded-md bg-[#1a1a1a] text-white"
                aria-label="Stop Mink AI"
              >
                <Square className="h-4 w-4 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="p-1.5 rounded-md bg-[#7F4AFA] text-white transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="Send message"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
