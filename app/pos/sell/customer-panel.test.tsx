import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  createPosCustomer: vi.fn(),
  searchPosCustomers: vi.fn(),
}));

vi.mock("@/app/actions/pos-sale-actions", () => actions);

const { CustomerPanel } = await import("./customer-panel");

beforeEach(() => {
  vi.clearAllMocks();
  actions.searchPosCustomers.mockResolvedValue({ customers: [] });
  actions.createPosCustomer.mockResolvedValue({
    customer: {
      id: "pos_1",
      name: "Asha Rao",
      phone: "9876543210",
      email: "asha@example.com",
      storeCredit: 0,
    },
  });
});

function setup() {
  const onPick = vi.fn();
  render(
    <CustomerPanel
      customer={null}
      gstin=""
      gstEnabled={false}
      onPick={onPick}
      onGstin={() => {}}
      onClose={() => {}}
    />,
  );
  return { onPick };
}

describe("POS customer capture", () => {
  it("offers search and new-customer creation on the same screen", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Add customer" })).toBeVisible();
    expect(screen.getByPlaceholderText(/phone, name or email/i)).toBeVisible();
    expect(
      screen.getByRole("button", { name: /create new customer/i }),
    ).toBeVisible();
  });

  it("can create without forcing an empty search first", async () => {
    const { onPick } = setup();
    fireEvent.click(
      screen.getByRole("button", { name: /create new customer/i }),
    );
    fireEvent.change(screen.getByPlaceholderText("Name"), {
      target: { value: "Asha Rao" },
    });
    fireEvent.change(screen.getByPlaceholderText("Mobile number"), {
      target: { value: "9876543210" },
    });
    fireEvent.change(screen.getByPlaceholderText("Email (optional)"), {
      target: { value: "asha@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save & attach/i }));

    await waitFor(() =>
      expect(actions.createPosCustomer).toHaveBeenCalledWith({
        name: "Asha Rao",
        phone: "9876543210",
        email: "asha@example.com",
      }),
    );
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pos_1", phone: "9876543210" }),
    );
  });

  it("carries an email search into the email field, not the name", () => {
    setup();
    fireEvent.change(screen.getByPlaceholderText(/phone, name or email/i), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /create new customer/i }),
    );

    expect(screen.getByPlaceholderText("Name")).toHaveValue("");
    expect(screen.getByPlaceholderText("Email (optional)")).toHaveValue(
      "new@example.com",
    );
  });
});
