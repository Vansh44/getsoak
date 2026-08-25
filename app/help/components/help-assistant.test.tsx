import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HelpAssistant } from "./help-assistant";

const askHelpAssistant = vi.fn();

vi.mock("@/app/actions/help-assistant-actions", () => ({
  askHelpAssistant: (...args: unknown[]) => askHelpAssistant(...args),
}));

describe("HelpAssistant", () => {
  beforeEach(() => {
    localStorage.clear();
    askHelpAssistant.mockReset();
    askHelpAssistant.mockResolvedValue({
      success: true,
      data: {
        answer: "Use the Sell screen to complete the checkout.",
        steps: ["Open Sell.", "Add products.", "Select Take payment."],
        notes: ["Review the live total before completing the sale."],
        sources: [
          {
            title: "Process an in-store sale",
            url: "/help/point-of-sale/process-an-in-store-sale",
            excerpt: "Complete a counter checkout.",
          },
        ],
        followUps: ["How do I split a payment?"],
        needsHuman: false,
      },
    });
  });

  it("opens accessibly and renders structured, sourced guidance", async () => {
    render(<HelpAssistant />);

    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
    expect(
      screen.getByRole("dialog", { name: "Mink AI Help Assistant" }),
    ).toBeInTheDocument();

    fireEvent.change(
      screen.getByLabelText("Ask Mink AI a StoreMink question"),
      {
        target: { value: "How do I complete a POS sale?" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send question" }));

    expect(
      await screen.findByText("Use the Sell screen to complete the checkout."),
    ).toBeInTheDocument();
    expect(screen.getByText("Select Take payment.")).toBeInTheDocument();
    expect(screen.getByText("Verified guides")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Process an in-store sale/i }),
    ).toHaveAttribute("href", "/help/point-of-sale/process-an-in-store-sale");
    expect(askHelpAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How do I complete a POS sale?",
        history: [expect.objectContaining({ role: "assistant" })],
      }),
    );
  });

  it("supports suggested follow-ups and resetting the conversation", async () => {
    render(<HelpAssistant />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
    fireEvent.click(
      screen.getByRole("button", { name: "How do I process a POS sale?" }),
    );
    await screen.findByText("How do I split a payment?");

    fireEvent.click(
      screen.getByRole("button", { name: "How do I split a payment?" }),
    );
    await waitFor(() => expect(askHelpAssistant).toHaveBeenCalledTimes(2));

    fireEvent.click(
      screen.getByRole("button", { name: "Start a new conversation" }),
    );
    expect(
      screen.getByText(/Tell me what you want to do/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Use the Sell screen to complete the checkout."),
    ).not.toBeInTheDocument();
  });

  it("rejects keyboard noise instead of reusing an earlier topic", async () => {
    render(<HelpAssistant />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
    const input = screen.getByLabelText("Ask Mink AI a StoreMink question");

    fireEvent.change(input, { target: { value: "ll" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      await screen.findByText(/Please enter a complete StoreMink question/i),
    ).toBeInTheDocument();
    expect(askHelpAssistant).not.toHaveBeenCalled();
  });

  it("supports accessible keyboard resizing and remembers the width", async () => {
    render(<HelpAssistant />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Mink AI" }));
    const resizer = screen.getByRole("separator", {
      name: "Resize Mink AI drawer",
    });

    expect(resizer).toHaveAttribute("aria-valuenow", "480");
    fireEvent.keyDown(resizer, { key: "ArrowLeft" });
    expect(resizer).toHaveAttribute("aria-valuenow", "504");
    expect(localStorage.getItem("sm-help-mink-width")).toBe("504");
  });
});
