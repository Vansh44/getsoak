"use client";

import {
  ArrowUp,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  MessageSquarePlus,
  Mic,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useChat } from "./chat-context";
import { MinkAnswer } from "./mink-answer";
import { ASSISTANT_NAME, type MinkConversationSummary } from "./mink-ai";
import { MinkMark } from "./mink-mark";

const PANEL_WIDTH_KEY = "storemink:mink-panel-width";
const DEFAULT_PANEL_WIDTH = 380;
const MAX_PANEL_WIDTH = 720;
const MAX_COMPOSER_HEIGHT = 160;

export function clampMinkPanelWidth(width: number, viewportWidth: number) {
  const safeViewport = Math.max(280, viewportWidth);
  const min = Math.min(320, Math.floor(safeViewport * 0.92));
  const max =
    safeViewport < 1200
      ? Math.floor(safeViewport * 0.92)
      : Math.min(MAX_PANEL_WIDTH, Math.floor(safeViewport * 0.62));
  return Math.min(Math.max(Math.round(width), min), Math.max(min, max));
}

export function minkComposerHeight(scrollHeight: number) {
  return Math.min(Math.max(Math.ceil(scrollHeight), 24), MAX_COMPOSER_HEIGHT);
}

export function shouldSubmitMinkComposer(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}) {
  return input.key === "Enter" && !input.shiftKey && !input.isComposing;
}

// Two surfaces, one conversation (state lives in ChatProvider):
//  - "panel"   → the resizable right sheet opened from the topbar
//  - "overlay" → the full-view takeover opened from Home/maximize
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
    conversations,
    activeConversationId,
    activeConversationTitle,
    input,
    setInput,
    isReplying,
    isHistoryLoading,
    deletingConversationId,
    statusText,
    error,
    send,
    cancel,
    retry,
    reset,
    loadConversation,
    deleteConversation,
  } = useChat();
  const isOverlay = variant === "overlay";
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(isOverlay);
  const [deleteTarget, setDeleteTarget] =
    useState<MinkConversationSummary | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);

  useEffect(() => {
    if (isOverlay) return;
    const resize = () =>
      setPanelWidth((width) => clampMinkPanelWidth(width, window.innerWidth));
    const restoreFrame = window.requestAnimationFrame(() => {
      try {
        const stored = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
        if (Number.isFinite(stored) && stored > 0) {
          setPanelWidth(clampMinkPanelWidth(stored, window.innerWidth));
        } else {
          resize();
        }
      } catch {
        resize();
      }
    });
    window.addEventListener("resize", resize);
    return () => {
      window.cancelAnimationFrame(restoreFrame);
      window.removeEventListener("resize", resize);
    };
  }, [isOverlay]);

  useEffect(() => {
    if (isOverlay) return;
    try {
      window.localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
    } catch {
      // A private browser may disable storage; resizing still works in-session.
    }
  }, [isOverlay, panelWidth]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, isReplying, error, statusText]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "0px";
    const height = minkComposerHeight(composer.scrollHeight);
    composer.style.height = `${height}px`;
    composer.style.overflowY =
      composer.scrollHeight > MAX_COMPOSER_HEIGHT ? "auto" : "hidden";
  }, [historyOpen, input, isOverlay, panelWidth]);

  useEffect(() => {
    if (!deleteTarget) return;
    deleteButtonRef.current?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !deletingConversationId) {
        setDeleteTarget(null);
        setDeleteFailure(null);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [deleteTarget, deletingConversationId]);

  const updateWidth = useCallback((width: number) => {
    setPanelWidth(clampMinkPanelWidth(width, window.innerWidth));
  }, []);

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: panelWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    updateWidth(resize.startWidth + resize.startX - event.clientX);
  };

  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      updateWidth(panelWidth + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      updateWidth(panelWidth - step);
    }
  };

  const composerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      !shouldSubmitMinkComposer({
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
      })
    ) {
      return;
    }
    event.preventDefault();
    if (input.trim() && !isHistoryLoading && !isReplying) send();
  };

  if (!isChatOpen) return null;
  if (isOverlay !== isExpanded) return null;

  const hasThread = messages.length > 0 || isReplying || Boolean(error);
  const wrapperClass = isOverlay
    ? "absolute inset-0 z-20 flex flex-col overflow-hidden bg-white"
    : "dash-chat relative flex h-full flex-shrink-0 flex-col overflow-hidden border-l border-t border-[#e5e5e5] bg-white shadow-sm";
  const columnClass = isOverlay ? "mx-auto w-full max-w-3xl" : "w-full";
  const panelStyle = isOverlay
    ? undefined
    : ({ "--mink-chat-width": `${panelWidth}px` } as CSSProperties);

  return (
    <div className={wrapperClass} style={panelStyle}>
      {!isOverlay && (
        <div
          role="separator"
          aria-label="Resize Mink AI panel"
          aria-orientation="vertical"
          aria-valuemin={280}
          aria-valuemax={MAX_PANEL_WIDTH}
          aria-valuenow={panelWidth}
          tabIndex={0}
          onPointerDown={beginResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onKeyDown={resizeWithKeyboard}
          className="mink-chat-resizer group absolute inset-y-0 left-0 z-30 hidden w-2 -translate-x-1/2 touch-none cursor-col-resize outline-none sm:block"
        >
          <span className="absolute inset-y-0 left-1/2 w-px bg-transparent transition-colors group-hover:bg-[#7f4afa]" />
        </div>
      )}

      <header className="flex min-h-[64px] items-center justify-between gap-3 border-b border-[#ededed] px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            onClick={() => setHistoryOpen((open) => !open)}
            aria-label={
              historyOpen
                ? "Hide conversation sidebar"
                : "Show conversation sidebar"
            }
            aria-expanded={historyOpen}
            className="rounded-lg p-2 text-[#5c5f62] transition-colors hover:bg-[#f1f1f1] hover:text-[#1a1a1a]"
          >
            {historyOpen ? (
              <PanelLeftClose className="h-4 w-4" />
            ) : (
              <PanelLeftOpen className="h-4 w-4" />
            )}
          </button>
          <MinkMark />
          <span className="min-w-0">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[#6d4dff]">
              {ASSISTANT_NAME}
            </span>
            <span className="block truncate text-sm font-semibold text-[#1a1a1a]">
              {activeConversationTitle ?? "New conversation"}
            </span>
          </span>
          {isHistoryLoading && (
            <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-[#8c9196]" />
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1 text-[#5c5f62]">
          <button
            type="button"
            onClick={toggleExpand}
            className="rounded-md p-1.5 transition-colors hover:bg-[#f1f1f1]"
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
            type="button"
            onClick={closeChat}
            className="rounded-md p-1.5 transition-colors hover:bg-[#f1f1f1]"
            aria-label="Close chat"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {historyOpen && (
          <ConversationSidebar
            conversations={conversations}
            activeConversationId={activeConversationId}
            isOverlay={isOverlay}
            isReplying={isReplying}
            isHistoryLoading={isHistoryLoading}
            deletingConversationId={deletingConversationId}
            onNewConversation={() => {
              reset();
              if (!isOverlay) setHistoryOpen(false);
            }}
            onSelect={(conversation) => {
              void loadConversation(conversation.id);
              if (!isOverlay) setHistoryOpen(false);
            }}
            onDelete={(conversation) => {
              setDeleteFailure(null);
              setDeleteTarget(conversation);
            }}
          />
        )}

        <main className="flex min-w-0 flex-1 flex-col bg-white">
          {!hasThread ? (
            <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto p-6 text-center">
              <div className="mb-4">
                <MinkMark size="lg" />
              </div>
              <h2 className="mb-1 text-lg font-semibold text-[#1a1a1a]">
                Hey there
              </h2>
              <h3 className="mb-6 text-xl font-bold text-[#1a1a1a]">
                I&apos;m {ASSISTANT_NAME}. How can I help?
              </h3>
              <button
                type="button"
                onClick={() => send("What's new?")}
                className="flex items-center gap-2 rounded-full border border-[#e5e5e5] px-4 py-2 text-sm font-medium text-[#1a1a1a] shadow-sm transition-colors hover:bg-[#f9f9f9]"
              >
                <div className="h-2 w-2 rounded-full bg-[#6d4dff]" />
                What&apos;s new?
              </button>
            </div>
          ) : (
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
              <div className={`${columnClass} space-y-4`}>
                {messages.map((message) =>
                  message.role === "user" ? (
                    <div key={message.id} className="flex justify-end">
                      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-[#f4f0ff] px-3.5 py-2.5 text-sm text-[#1a1a1a]">
                        {message.text}
                      </div>
                    </div>
                  ) : (
                    <div key={message.id} className="flex gap-2.5">
                      <MinkMark size="sm" />
                      <div className="max-w-[85%]">
                        <div className="mb-1 text-[11px] font-semibold text-[#5c5f62]">
                          {ASSISTANT_NAME}
                        </div>
                        <div className="rounded-2xl rounded-tl-sm bg-[#f6f6f7] px-3.5 py-2.5 text-sm text-[#1a1a1a]">
                          <MinkAnswer text={message.text} />
                        </div>
                      </div>
                    </div>
                  ),
                )}

                {isReplying && (
                  <div className="flex gap-2.5" aria-live="polite">
                    <MinkMark size="sm" />
                    <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm bg-[#f6f6f7] px-3.5 py-2.5 text-xs text-[#5c5f62]">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#6d4dff]" />
                      {statusText ?? "Thinking…"}
                    </div>
                  </div>
                )}

                {error && (
                  <div className="flex gap-2.5" role="alert">
                    <MinkMark size="sm" />
                    <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-[#fff4f4] px-3.5 py-2.5 text-sm text-[#5c1b14]">
                      <div>{error.message}</div>
                      <button
                        type="button"
                        onClick={retry}
                        className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[#6d4dff] hover:underline"
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

          <div className="border-t border-[#f1f1f1] p-4">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
              className={`${columnClass} flex items-end rounded-2xl border border-[#e5e5e5] bg-white px-3 py-2 shadow-sm transition-all focus-within:border-[#6d4dff] focus-within:ring-1 focus-within:ring-[#6d4dff]`}
            >
              <textarea
                ref={composerRef}
                rows={1}
                maxLength={4000}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={composerKeyDown}
                placeholder="Ask anything..."
                aria-label={`Message ${ASSISTANT_NAME}`}
                className="min-h-6 max-h-40 flex-1 resize-none border-none bg-transparent py-0.5 text-sm leading-5 text-[#1a1a1a] outline-none placeholder:text-[#8c9196]"
              />
              <div className="ml-2 flex shrink-0 items-center gap-1 self-end text-[#8c9196]">
                <button
                  type="button"
                  className="rounded-md p-1.5 transition-colors hover:bg-[#f1f1f1] hover:text-[#1a1a1a]"
                  aria-label="Attach"
                >
                  <Plus className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="rounded-md p-1.5 transition-colors hover:bg-[#f1f1f1] hover:text-[#1a1a1a]"
                  aria-label="Voice input"
                >
                  <Mic className="h-4 w-4" />
                </button>
                {isReplying ? (
                  <button
                    type="button"
                    onClick={cancel}
                    className="rounded-md bg-[#1a1a1a] p-1.5 text-white"
                    aria-label="Stop Mink AI"
                  >
                    <Square className="h-4 w-4 fill-current" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!input.trim() || isHistoryLoading}
                    className="rounded-md bg-[#6d4dff] p-1.5 text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-30"
                    aria-label="Send message"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                )}
              </div>
            </form>
          </div>
        </main>
      </div>

      {deleteTarget && (
        <div
          className="absolute inset-0 z-[70] flex items-center justify-center bg-black/30 p-4"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="mink-delete-title"
          aria-describedby="mink-delete-description"
        >
          <div className="w-full max-w-sm rounded-2xl border border-[#dedede] bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-start gap-3">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#fff1f0] text-[#b42318]">
                <Trash2 className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h2
                  id="mink-delete-title"
                  className="text-base font-semibold text-[#1a1a1a]"
                >
                  Delete conversation?
                </h2>
                <p
                  id="mink-delete-description"
                  className="mt-1 text-sm leading-5 text-[#5c5f62]"
                >
                  “{deleteTarget.title}” and its messages will be permanently
                  deleted.
                </p>
                {deleteFailure && (
                  <p
                    role="alert"
                    className="mt-2 rounded-lg bg-[#fff4f4] px-2.5 py-2 text-xs leading-5 text-[#8a1c13]"
                  >
                    {deleteFailure}
                  </p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteFailure(null);
                }}
                disabled={Boolean(deletingConversationId)}
                className="rounded-lg border border-[#dedede] px-3 py-2 text-sm font-medium text-[#1a1a1a] hover:bg-[#f6f6f7] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                ref={deleteButtonRef}
                type="button"
                disabled={Boolean(deletingConversationId)}
                onClick={async () => {
                  setDeleteFailure(null);
                  const failure = await deleteConversation(deleteTarget.id);
                  if (!failure) {
                    setDeleteTarget(null);
                  } else {
                    setDeleteFailure(failure.message);
                  }
                }}
                className="inline-flex min-w-[76px] items-center justify-center gap-1.5 rounded-lg bg-[#b42318] px-3 py-2 text-sm font-semibold text-white hover:bg-[#912018] disabled:opacity-60"
              >
                {deletingConversationId === deleteTarget.id && (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                )}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ConversationSidebar({
  conversations,
  activeConversationId,
  isOverlay,
  isReplying,
  isHistoryLoading,
  deletingConversationId,
  onNewConversation,
  onSelect,
  onDelete,
}: {
  conversations: MinkConversationSummary[];
  activeConversationId: string | null;
  isOverlay: boolean;
  isReplying: boolean;
  isHistoryLoading: boolean;
  deletingConversationId: string | null;
  onNewConversation: () => void;
  onSelect: (conversation: MinkConversationSummary) => void;
  onDelete: (conversation: MinkConversationSummary) => void;
}) {
  return (
    <aside
      aria-label="Mink AI conversations"
      className={
        isOverlay
          ? "flex w-72 shrink-0 flex-col border-r border-[#e7e7e7] bg-[#f7f7f8]"
          : "absolute inset-y-0 left-0 z-40 flex w-[min(300px,100%)] flex-col border-r border-[#e7e7e7] bg-[#f7f7f8] shadow-xl"
      }
    >
      <div className="p-3">
        <button
          type="button"
          onClick={onNewConversation}
          disabled={isReplying}
          className="flex w-full items-center gap-2 rounded-xl border border-[#dedede] bg-white px-3 py-2.5 text-left text-sm font-semibold text-[#1a1a1a] shadow-sm transition-colors hover:border-[#cfc4ff] hover:bg-[#fbfaff] disabled:opacity-50"
        >
          <MessageSquarePlus className="h-4 w-4 text-[#6d4dff]" />
          New conversation
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-2 pb-3">
        <div className="flex h-8 items-center justify-between px-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8c9196]">
          <span>Recent</span>
          {isHistoryLoading && (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          )}
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {conversations.map((conversation) => {
            const selected = conversation.id === activeConversationId;
            const deleting = deletingConversationId === conversation.id;
            return (
              <div
                key={conversation.id}
                className={`group relative rounded-xl transition-colors ${
                  selected
                    ? "bg-[#eee9ff]"
                    : "hover:bg-[#ededee] focus-within:bg-[#ededee]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(conversation)}
                  disabled={isReplying || deleting}
                  aria-current={selected ? "page" : undefined}
                  className="flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 pr-10 text-left disabled:opacity-50"
                >
                  <MessageSquare
                    className={`mt-0.5 h-4 w-4 shrink-0 ${
                      selected ? "text-[#6d4dff]" : "text-[#8c9196]"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[#1a1a1a]">
                      {conversation.title}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-[#8c9196]">
                      {formatConversationDate(conversation.lastMessageAt)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(conversation)}
                  disabled={isReplying || deleting}
                  aria-label={`Delete ${conversation.title}`}
                  title="Delete conversation"
                  className={`absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-[#8c9196] transition hover:bg-white hover:text-[#b42318] focus:opacity-100 disabled:opacity-40 ${
                    selected
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100"
                  }`}
                >
                  {deleting ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            );
          })}
          {conversations.length === 0 && !isHistoryLoading && (
            <div className="px-3 py-5 text-center text-xs leading-5 text-[#8c9196]">
              Your recent conversations will appear here.
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function formatConversationDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recent";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
