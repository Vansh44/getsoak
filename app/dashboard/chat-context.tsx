"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useMinkAi, type MinkMessage } from "./mink-ai";

interface ChatContextType {
  isChatOpen: boolean;
  // Full-view "takeover" mode (Shopify Sidekick style) vs the narrow side panel.
  isExpanded: boolean;
  toggleChat: () => void;
  closeChat: () => void;
  toggleExpand: () => void;
  // Home "Ask anything…" box → open the chat in full view AND send the message.
  startExpandedChat: (message: string) => void;
  // The shared Mink AI conversation (one thread across the Home box + panel).
  messages: MinkMessage[];
  input: string;
  setInput: (value: string) => void;
  isReplying: boolean;
  send: (raw?: string) => void;
  reset: () => void;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  // Conversation state lives here (not in each surface) so a message typed in
  // the Home box carries over into the panel/full view that opens.
  const mink = useMinkAi();
  const { send } = mink;

  const toggleChat = useCallback(() => setIsChatOpen((prev) => !prev), []);
  const closeChat = useCallback(() => {
    setIsChatOpen(false);
    setIsExpanded(false);
  }, []);
  const toggleExpand = useCallback(() => setIsExpanded((prev) => !prev), []);

  const startExpandedChat = useCallback(
    (message: string) => {
      setIsChatOpen(true);
      setIsExpanded(true);
      send(message);
    },
    [send],
  );

  const value = useMemo(
    () => ({
      isChatOpen,
      isExpanded,
      toggleChat,
      closeChat,
      toggleExpand,
      startExpandedChat,
      ...mink,
    }),
    [
      isChatOpen,
      isExpanded,
      toggleChat,
      closeChat,
      toggleExpand,
      startExpandedChat,
      mink,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const context = useContext(ChatContext);
  if (context === undefined) {
    // Defensive default so a stray consumer never crashes the shell — the
    // shared DashboardTopbar is also rendered by the platform console layout,
    // which intentionally has no ChatProvider (the assistant is a store-only
    // feature). Mirrors useMobileNav's non-throwing fallback.
    return {
      isChatOpen: false,
      isExpanded: false,
      toggleChat: () => {},
      closeChat: () => {},
      toggleExpand: () => {},
      startExpandedChat: () => {},
      messages: [],
      input: "",
      setInput: () => {},
      isReplying: false,
      send: () => {},
      reset: () => {},
    } satisfies ChatContextType;
  }
  return context;
}
