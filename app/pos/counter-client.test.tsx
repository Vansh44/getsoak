import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pickupActions = vi.hoisted(() => ({
  findPickupByCode: vi.fn(),
  getCollectionCredit: vi.fn(),
  getPickupQueue: vi.fn(),
  markCollected: vi.fn(),
  markReadyForPickup: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/app/actions/pos-pickup-actions", () => pickupActions);
vi.mock("@/app/actions/pos-return-actions", () => ({
  findOrderForReturn: vi.fn().mockResolvedValue({ results: [] }),
}));
vi.mock("@/lib/pos/use-poll", () => ({ usePoll: vi.fn() }));
vi.mock("@/lib/pos/live", () => ({ fetchPickupQueue: vi.fn() }));
vi.mock("@/lib/pos/pickup-badge", () => ({
  claimPickupBadge: vi.fn(() => vi.fn()),
  publishPickupCount: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("./collection-detail", () => ({ CollectionDetail: vi.fn(() => null) }));
vi.mock("./sell/tender-panel", () => ({ TenderPanel: vi.fn(() => null) }));

const { CounterClient } = await import("./counter-client");

const ORDER = {
  id: "pickup-1",
  orderRef: "ORD100110576",
  customerName: "V G",
  itemCount: 1,
  total: 45,
  amountDue: 45,
  paidSoFar: 0,
  placedAt: "2026-08-23T06:00:00.000Z",
  expiresAt: "2099-08-27T06:00:00.000Z",
  status: "awaiting",
};

beforeEach(() => {
  vi.clearAllMocks();
  pickupActions.markReadyForPickup.mockResolvedValue({ success: true });
  pickupActions.getPickupQueue.mockResolvedValue({ orders: [ORDER] });
});

describe("pickup queue — marking an order ready", () => {
  it("moves the confirmed row into Ready to collect without a reload", async () => {
    render(
      <CounterClient
        mode="pickups"
        initial={[ORDER]}
        error={null}
        canRefund={false}
        canFulfilPickup
      />,
    );

    const toPrepare = screen.getByRole("heading", { name: /to prepare/i });
    const ready = screen.getByRole("heading", { name: /ready to collect/i });
    expect(within(toPrepare).getByText("1")).toBeVisible();
    expect(within(ready).getByText("0")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /mark ready/i }));

    await waitFor(() => {
      expect(pickupActions.markReadyForPickup).toHaveBeenCalledWith("pickup-1");
      expect(within(toPrepare).getByText("0")).toBeVisible();
      expect(within(ready).getByText("1")).toBeVisible();
    });

    const readySection = ready.closest("section");
    const toPrepareSection = toPrepare.closest("section");
    expect(readySection).not.toBeNull();
    expect(toPrepareSection).not.toBeNull();
    expect(within(readySection!).getByText("ORD100110576")).toBeVisible();
    expect(within(toPrepareSection!).queryByText("ORD100110576")).toBeNull();
    expect(screen.queryByRole("button", { name: /mark ready/i })).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Marked ready.");
    // The confirmed action already supplies the only changed field. No manual
    // action refresh is needed; the ordinary poll can reconcile later changes.
    expect(pickupActions.getPickupQueue).not.toHaveBeenCalled();
  });
});
