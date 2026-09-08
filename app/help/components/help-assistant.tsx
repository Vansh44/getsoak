"use client";

import Image from "next/image";
import { STOREMINK_MARK } from "@/lib/brand-assets";
import Link from "next/link";
import {
  Bot,
  ExternalLink,
  Maximize2,
  MessageCircle,
  Minimize2,
  RefreshCw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  askHelpAssistant,
  type HelpAssistantAnswer,
  type HelpAssistantTurn,
} from "@/app/actions/help-assistant-actions";
import {
  HELP_ASSISTANT_MAX_MESSAGE_LENGTH,
  helpAssistantQuestionError,
  normalizeHelpAssistantQuestion,
} from "@/lib/help/assistant-input";

type UserMessage = {
  id: number;
  role: "user";
  content: string;
};

type AssistantMessage = {
  id: number;
  role: "assistant";
  content: string;
  answer?: HelpAssistantAnswer;
};

type ChatMessage = UserMessage | AssistantMessage;

type ScrollTarget = { kind: "end" } | { kind: "message"; messageId: number };

const INTRO: AssistantMessage = {
  id: 1,
  role: "assistant",
  content:
    "Hi! I’m Mink AI. Tell me what you want to do, or describe the StoreMink screen where you’re stuck. I’ll guide you using published Help Centre guides.",
};

const STARTERS = [
  "How do I add my first product?",
  "How do I connect my domain?",
  "How do I process a POS sale?",
];

const DRAWER_MIN_WIDTH = 360;
const DRAWER_MAX_WIDTH = 760;
const DRAWER_DEFAULT_WIDTH = 480;
const DRAWER_PAGE_FLOOR = 280;
const DRAWER_WIDTH_STORAGE_KEY = "sm-help-mink-width";

function assistantHistoryText(answer: HelpAssistantAnswer): string {
  return [
    answer.answer,
    answer.steps.length
      ? `Steps: ${answer.steps.map((step, index) => `${index + 1}. ${step}`).join(" ")}`
      : "",
    answer.notes.length ? `Important: ${answer.notes.join(" ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1_200);
}

function clampWidth(value: number, maximum: number) {
  return Math.min(Math.max(value, DRAWER_MIN_WIDTH), maximum);
}

function viewportDrawerMaximum() {
  if (typeof window === "undefined") return DRAWER_MAX_WIDTH;
  return Math.max(
    DRAWER_MIN_WIDTH,
    Math.min(DRAWER_MAX_WIDTH, window.innerWidth - DRAWER_PAGE_FLOOR),
  );
}

function persistDrawerWidth(value: number) {
  try {
    localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, String(value));
  } catch {
    // Storage can be disabled; resizing should continue for the current visit.
  }
}

export function HelpAssistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([INTRO]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [drawerWidth, setDrawerWidth] = useState(DRAWER_DEFAULT_WIDTH);
  const [drawerMaximum, setDrawerMaximum] = useState(DRAWER_MAX_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const nextId = useRef(2);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollTargetRef = useRef<ScrollTarget | null>(null);
  const hasConversationContext = messages.some(
    (message) => message.role === "user",
  );
  const draftError = helpAssistantQuestionError(draft, {
    hasConversationContext,
  });

  const closeAssistant = useCallback(() => {
    setIsResizing(false);
    setIsMaximized(false);
    setOpen(false);
    requestAnimationFrame(() => launcherRef.current?.focus());
  }, []);

  useEffect(() => {
    function syncWidth() {
      const maximum = viewportDrawerMaximum();
      setDrawerMaximum(maximum);
      setDrawerWidth((current) => clampWidth(current, maximum));
    }

    const maximum = viewportDrawerMaximum();
    setDrawerMaximum(maximum);
    try {
      const saved = Number(localStorage.getItem(DRAWER_WIDTH_STORAGE_KEY));
      if (Number.isFinite(saved) && saved > 0) {
        setDrawerWidth(clampWidth(saved, maximum));
      } else {
        setDrawerWidth(clampWidth(DRAWER_DEFAULT_WIDTH, maximum));
      }
    } catch {
      setDrawerWidth(clampWidth(DRAWER_DEFAULT_WIDTH, maximum));
    }

    window.addEventListener("resize", syncWidth);
    return () => window.removeEventListener("resize", syncWidth);
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAssistant();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeAssistant, open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      endRef.current?.scrollIntoView?.({ block: "end" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open || !scrollTargetRef.current) return;
    const target = scrollTargetRef.current;
    const frame = requestAnimationFrame(() => {
      if (target.kind === "end") {
        endRef.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
      } else {
        messagesRef.current
          ?.querySelector<HTMLElement>(
            `[data-message-id="${target.messageId}"]`,
          )
          ?.scrollIntoView?.({ block: "start", behavior: "smooth" });
      }
      if (scrollTargetRef.current === target) scrollTargetRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, open, pending]);

  useEffect(() => {
    if (!open || !isMaximized) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMaximized, open]);

  useEffect(() => {
    if (!isResizing) return;
    const previousCursor = document.body.style.cursor;
    const previousSelection = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function resize(event: PointerEvent) {
      setDrawerWidth(
        clampWidth(window.innerWidth - event.clientX, drawerMaximum),
      );
    }
    function finish(event: PointerEvent) {
      const width = clampWidth(
        window.innerWidth - event.clientX,
        drawerMaximum,
      );
      setDrawerWidth(width);
      persistDrawerWidth(width);
      setIsResizing(false);
    }
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish, { once: true });
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelection;
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finish);
    };
  }, [drawerMaximum, isResizing]);

  function conversationHistory(): HelpAssistantTurn[] {
    return messages.slice(-8).map((message) => ({
      role: message.role,
      content:
        message.role === "assistant" && message.answer
          ? assistantHistoryText(message.answer)
          : message.content,
    }));
  }

  async function sendMessage(value = draft) {
    const content = normalizeHelpAssistantQuestion(value);
    const validationError = helpAssistantQuestionError(content, {
      hasConversationContext,
    });
    if (pending) return;
    if (validationError) {
      setError(validationError);
      return;
    }
    const history = conversationHistory();
    const userMessage: UserMessage = {
      id: nextId.current++,
      role: "user",
      content: content.slice(0, HELP_ASSISTANT_MAX_MESSAGE_LENGTH),
    };
    scrollTargetRef.current = { kind: "end" };
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setError("");
    setPending(true);
    try {
      const result = await askHelpAssistant({
        message: userMessage.content,
        history,
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      const assistantMessage: AssistantMessage = {
        id: nextId.current++,
        role: "assistant",
        content: result.data.answer,
        answer: result.data,
      };
      scrollTargetRef.current = {
        kind: "message",
        messageId: assistantMessage.id,
      };
      setMessages((current) => [...current, assistantMessage]);
    } catch {
      setError(
        "Mink AI couldn’t respond. Check your connection and try again.",
      );
    } finally {
      setPending(false);
    }
  }

  function resetConversation() {
    scrollTargetRef.current = { kind: "end" };
    setMessages([INTRO]);
    setDraft("");
    setError("");
    nextId.current = 2;
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function resizeWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = drawerWidth + 24;
    if (event.key === "ArrowRight") next = drawerWidth - 24;
    if (event.key === "Home") next = DRAWER_MIN_WIDTH;
    if (event.key === "End") next = drawerMaximum;
    if (next === null) return;
    event.preventDefault();
    const width = clampWidth(next, drawerMaximum);
    setDrawerWidth(width);
    persistDrawerWidth(width);
  }

  function startResizing(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setIsResizing(true);
  }

  return (
    <div className="hc-assistant">
      <button
        ref={launcherRef}
        type="button"
        className="hc-assistant-launcher"
        onClick={() => (open ? closeAssistant() : setOpen(true))}
        aria-expanded={open}
        aria-controls="hc-mink-ai-drawer"
        aria-label={open ? "Close Mink AI" : "Ask Mink AI"}
      >
        {open ? <X size={18} /> : <MessageCircle size={18} />}
        <span>{open ? "Close" : "Ask Mink AI"}</span>
      </button>

      {open && (
        <>
          <div
            className="hc-assistant-backdrop"
            onClick={closeAssistant}
            aria-hidden
          />
          <section
            id="hc-mink-ai-drawer"
            ref={panelRef}
            className={`hc-assistant-panel${isResizing ? " is-resizing" : ""}${isMaximized ? " is-maximized" : ""}`}
            style={isMaximized ? undefined : { width: drawerWidth }}
            role="dialog"
            aria-modal="true"
            aria-label="Mink AI Help Assistant"
            aria-describedby="hc-assistant-description"
          >
            {!isMaximized && (
              <div
                className="hc-assistant-resizer"
                role="separator"
                aria-label="Resize Mink AI drawer"
                aria-orientation="vertical"
                aria-valuemin={DRAWER_MIN_WIDTH}
                aria-valuemax={drawerMaximum}
                aria-valuenow={drawerWidth}
                tabIndex={0}
                onPointerDown={startResizing}
                onKeyDown={resizeWithKeyboard}
              />
            )}

            <header className="hc-assistant-header">
              <div className="hc-assistant-identity">
                <span className="hc-assistant-avatar" aria-hidden>
                  <Bot size={20} />
                </span>
                <div>
                  <h2>Mink AI</h2>
                  <p id="hc-assistant-description">
                    <span aria-hidden /> Grounded in published Help guides
                  </p>
                </div>
              </div>
              <div className="hc-assistant-header-actions">
                <button
                  type="button"
                  onClick={resetConversation}
                  aria-label="Start a new conversation"
                  title="New conversation"
                >
                  <RefreshCw size={17} />
                </button>
                <button
                  type="button"
                  className="hc-assistant-maximize"
                  onClick={() => {
                    setIsResizing(false);
                    setIsMaximized((current) => !current);
                  }}
                  aria-label={
                    isMaximized ? "Restore Mink AI drawer" : "Maximize Mink AI"
                  }
                  aria-pressed={isMaximized}
                  title={isMaximized ? "Restore drawer" : "Maximize"}
                >
                  {isMaximized ? (
                    <Minimize2 size={17} />
                  ) : (
                    <Maximize2 size={17} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={closeAssistant}
                  aria-label="Close Mink AI"
                >
                  <X size={19} />
                </button>
              </div>
            </header>

            <div
              ref={messagesRef}
              className="hc-assistant-messages"
              aria-live="polite"
            >
              {messages.map((message) => (
                <div
                  className={`hc-assistant-row ${message.role}`}
                  key={message.id}
                  data-message-id={message.id}
                >
                  {message.role === "assistant" && (
                    <span className="hc-assistant-mini-avatar" aria-hidden>
                      <Sparkles size={14} />
                    </span>
                  )}
                  <div className="hc-assistant-message">
                    <p>{message.content}</p>
                    {message.role === "assistant" && message.answer && (
                      <>
                        {message.answer.steps.length > 0 && (
                          <ol className="hc-assistant-steps">
                            {message.answer.steps.map((step, index) => (
                              <li key={`${index}-${step}`}>{step}</li>
                            ))}
                          </ol>
                        )}
                        {message.answer.notes.length > 0 && (
                          <div className="hc-assistant-notes">
                            <strong>Important</strong>
                            <ul>
                              {message.answer.notes.map((note) => (
                                <li key={note}>{note}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {message.answer.sources.length > 0 && (
                          <div className="hc-assistant-sources">
                            <strong>Verified guides</strong>
                            {message.answer.sources.map((source) => (
                              <Link
                                href={source.url}
                                key={source.url}
                                onClick={closeAssistant}
                              >
                                <span>{source.title}</span>
                                <ExternalLink size={14} aria-hidden />
                              </Link>
                            ))}
                          </div>
                        )}
                        {(message.answer.clarificationPrompts ?? []).length >
                          0 && (
                          <div className="hc-assistant-clarifications">
                            <strong>Include these details in your reply</strong>
                            <ul>
                              {(message.answer.clarificationPrompts ?? []).map(
                                (prompt) => (
                                  <li key={prompt}>{prompt}</li>
                                ),
                              )}
                            </ul>
                          </div>
                        )}
                        {message.answer.followUps.length > 0 && (
                          <div className="hc-assistant-followups">
                            {message.answer.followUps.map((question) => (
                              <button
                                type="button"
                                key={question}
                                onClick={() => void sendMessage(question)}
                                disabled={pending}
                              >
                                {question}
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}

              {messages.length === 1 && (
                <div
                  className="hc-assistant-starters"
                  aria-label="Example questions"
                >
                  {STARTERS.map((starter) => (
                    <button
                      type="button"
                      onClick={() => void sendMessage(starter)}
                      key={starter}
                    >
                      {starter}
                    </button>
                  ))}
                </div>
              )}

              {pending && (
                <div className="hc-assistant-row assistant">
                  <span className="hc-assistant-mini-avatar" aria-hidden>
                    <Sparkles size={14} />
                  </span>
                  <div
                    className="hc-assistant-thinking"
                    role="status"
                    aria-label="Finding the best answer"
                  >
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              )}
              {error && (
                <div className="hc-assistant-error" role="alert">
                  {error}
                </div>
              )}
              <div ref={endRef} />
            </div>

            <form
              className="hc-assistant-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void sendMessage();
              }}
            >
              <label
                htmlFor="hc-assistant-input"
                className="hc-assistant-sr-only"
              >
                Ask Mink AI a StoreMink question
              </label>
              <textarea
                id="hc-assistant-input"
                ref={inputRef}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (error) setError("");
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder="Ask how to do something…"
                // Same keyboard contract as the dashboard composer — Return
                // sends here too, and an un-hinted field in a <form> gets iOS's
                // password/card/address bar instead of word suggestions.
                enterKeyHint="send"
                autoComplete="off"
                autoCapitalize="sentences"
                autoCorrect="on"
                rows={1}
                maxLength={HELP_ASSISTANT_MAX_MESSAGE_LENGTH}
                disabled={pending}
              />
              <button
                type="submit"
                aria-label="Send question"
                disabled={pending || Boolean(draftError)}
              >
                <Send size={18} />
              </button>
            </form>
            <footer className="hc-assistant-footer">
              <div
                className="hc-assistant-powered"
                aria-label="Powered by StoreMink"
              >
                <span>Powered by</span>
                <Image
                  src={STOREMINK_MARK}
                  alt=""
                  width={18}
                  height={18}
                  aria-hidden
                />
                <strong>StoreMink</strong>
              </div>
            </footer>
          </section>
        </>
      )}
    </div>
  );
}
