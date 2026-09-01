import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AskAnything } from "./ask-anything";
import { useChat } from "./chat-context";

vi.mock("./chat-context", () => ({
  useChat: vi.fn(),
}));

describe("dashboard Ask anything", () => {
  it("uses an iOS-safe input size and carries the prompt into full view", () => {
    const startExpandedChat = vi.fn();
    vi.mocked(useChat).mockReturnValue({
      isChatOpen: false,
      startExpandedChat,
    } as unknown as ReturnType<typeof useChat>);

    render(<AskAnything />);

    const input = screen.getByLabelText("Message Mink AI");
    expect(input).toHaveClass("min-w-0", "text-base", "sm:text-[15px]");

    fireEvent.change(input, { target: { value: "What is my plan?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(startExpandedChat).toHaveBeenCalledWith("What is my plan?");
  });
});
