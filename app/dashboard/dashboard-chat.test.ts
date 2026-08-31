import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampMinkPanelWidth,
  DashboardChat,
  minkComposerHeight,
  shouldSubmitMinkComposer,
} from "./dashboard-chat";
import { useChat } from "./chat-context";

vi.mock("./chat-context", () => ({
  useChat: vi.fn(),
}));

const baseChatState = {
  isChatOpen: true,
  isExpanded: true,
  closeChat: vi.fn(),
  toggleExpand: vi.fn(),
  messages: [],
  conversations: [],
  activeConversationId: null,
  activeConversationTitle: null,
  input: "",
  setInput: vi.fn(),
  isReplying: false,
  isHistoryLoading: false,
  deletingConversationId: null,
  statusText: null,
  error: null,
  feedbackSubmittingRunId: null,
  send: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
  reset: vi.fn(),
  loadConversation: vi.fn(),
  deleteConversation: vi.fn(),
  submitFeedback: vi.fn(),
};

beforeEach(() => {
  vi.mocked(useChat).mockReturnValue(
    baseChatState as unknown as ReturnType<typeof useChat>,
  );
});

describe("Mink full view", () => {
  it("covers the entire viewport above the dashboard chrome", () => {
    render(createElement(DashboardChat, { variant: "overlay" }));

    expect(screen.getByTestId("mink-chat-surface")).toHaveClass(
      "fixed",
      "inset-0",
      "z-[90]",
    );
  });
});

describe("clampMinkPanelWidth", () => {
  it("keeps desktop resizing within the usable dashboard range", () => {
    expect(clampMinkPanelWidth(100, 1920)).toBe(320);
    expect(clampMinkPanelWidth(900, 1920)).toBe(720);
    expect(clampMinkPanelWidth(512, 1920)).toBe(512);
  });

  it("keeps the overlay inside a small viewport", () => {
    expect(clampMinkPanelWidth(720, 390)).toBe(358);
    expect(clampMinkPanelWidth(100, 300)).toBe(276);
  });
});

describe("Mink composer", () => {
  it("grows with wrapped content and caps before becoming scrollable", () => {
    expect(minkComposerHeight(8)).toBe(24);
    expect(minkComposerHeight(96.2)).toBe(97);
    expect(minkComposerHeight(400)).toBe(160);
  });

  it("submits on Enter while preserving Shift+Enter and IME composition", () => {
    expect(
      shouldSubmitMinkComposer({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
      }),
    ).toBe(true);
    expect(
      shouldSubmitMinkComposer({
        key: "Enter",
        shiftKey: true,
        isComposing: false,
      }),
    ).toBe(false);
    expect(
      shouldSubmitMinkComposer({
        key: "Enter",
        shiftKey: false,
        isComposing: true,
      }),
    ).toBe(false);
  });
});
