import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
const catalog = vi.hoisted(() => ({
  ready: true,
  version: 1,
  syncing: false,
  count: 1,
  all: vi.fn(),
  search: vi.fn(),
  scan: vi.fn(() => []),
  resync: vi.fn(),
  applySold: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/app/actions/pos-sale-actions", () => ({
  lookupProducts: vi.fn(async () => ({ items: [] })),
  placePosSale: vi.fn(),
  resolvePosCustomerByPhone: vi.fn(),
  startPosGatewayPayment: vi.fn(),
  confirmPosGatewayPayment: vi.fn(),
  verifyManagerPin: vi.fn(),
}));
vi.mock("@/app/actions/pos-layout-actions", () => ({
  getPosLayout: vi.fn(async () => ({ items: [], canEdit: false })),
  resetPosLayout: vi.fn(),
  savePosLayout: vi.fn(),
}));
vi.mock("@/app/actions/pos-park-actions", () => ({
  listParkedSales: vi.fn(async () => ({ sales: [] })),
  parkSale: vi.fn(),
}));
vi.mock("@/lib/pos/use-catalog", () => ({ useCatalog: () => catalog }));
vi.mock("@/lib/pos/barcode-camera", () => ({
  isCameraScanSupported: () => false,
}));
vi.mock("@/lib/pos/keyboard-wedge", () => ({
  createKeyboardWedge: () => ({ handleKey: () => ({ type: "ignored" }) }),
  isEditableTarget: () => false,
  isTouchPrimary: () => true,
  subscribeTouchPrimary: () => () => undefined,
}));
vi.mock("@/lib/payments/razorpay-client", () => ({
  openRazorpayModal: vi.fn(),
}));
vi.mock("./layout-editor", () => ({ LayoutEditMode: () => null }));
vi.mock("./tender-panel", () => ({ TenderPanel: () => null }));
vi.mock("./parked-panel", () => ({ ParkedPanel: () => null }));
vi.mock("./receipt-overlay", () => ({ ReceiptOverlay: () => null }));
vi.mock("./camera-scanner", () => ({ CameraScanner: () => null }));

import { SellClient, shouldRefocusPosSearch } from "./sell-client";
import type {
  PosCatalogItem,
  RegisterConfig,
} from "@/app/actions/pos-sale-actions";

const ITEM: PosCatalogItem = {
  productId: "p1",
  variantId: null,
  name: "Multigrain Bread",
  variantName: null,
  sku: "BREAD-1",
  barcode: "8901",
  price: 52,
  image: "/bread.jpg",
  stock: 5,
  trackInventory: true,
  allowBackorder: false,
  taxClassId: null,
  categoryId: null,
};

const CONFIG: RegisterConfig = {
  storeId: "store-1",
  locationId: "loc-1",
  locationName: "Shop",
  operatorName: "Priya",
  role: "manager",
  taxEnabled: false,
  gstEnabled: false,
  pricesIncludeTax: true,
  taxRates: {},
  defaultTaxClassId: null,
  currency: "INR",
  canDiscount: false,
  canOverridePrice: false,
  onlinePayments: false,
  gatewayKeyId: null,
  offers: [],
  offerPolicy: {
    onSalePrice: "best",
    maxTotalDiscountPercent: 50,
    autoApply: false,
  },
  storeName: "Echoes",
};

beforeEach(() => {
  vi.clearAllMocks();
  catalog.all.mockReturnValue([ITEM]);
  catalog.search.mockReturnValue([ITEM]);
});

describe("Sell cart", () => {
  it("does not restore scanner focus while live hardware is touch-primary", () => {
    expect(
      shouldRefocusPosSearch({
        reportedTouchPrimary: false,
        liveTouchPrimary: true,
        overlayOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldRefocusPosSearch({
        reportedTouchPrimary: false,
        liveTouchPrimary: false,
        overlayOpen: false,
      }),
    ).toBe(true);
  });

  it("keeps the selected product photo on the cart line", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });

    expect(container.querySelectorAll('img[src="/bread.jpg"]')).toHaveLength(2);
  });

  it("keeps phone products and cart in separate switchable panes", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });

    const productsPane = screen.getByRole("button", { name: "Products" });
    const cartPane = screen.getByRole("button", { name: "Cart, empty" });
    expect(productsPane).toHaveAttribute("aria-pressed", "true");
    expect(cartPane).toHaveAttribute("aria-pressed", "false");

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });

    expect(
      screen.getByRole("button", { name: "Cart, 1 item" }),
    ).toHaveTextContent("Cart1");
    const viewCart = screen.getByRole("button", {
      name: "View cart, 1 item, total ₹52",
    });
    expect(viewCart).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(viewCart);
    });

    expect(screen.getByRole("button", { name: "Products" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      screen.getByRole("button", { name: "Cart, 1 item" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector("aside")?.className).toContain("flex");
  });

  it("keeps the phone search and intended scroll areas within the viewport", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });

    const search = screen.getByPlaceholderText(
      "Scan a barcode or search products…",
    );
    expect(search).toHaveClass("min-w-0", "text-base", "sm:text-sm");
    expect(search.parentElement).toHaveClass("min-w-0");
    expect(container.querySelectorAll(".pos-scroll-area")).toHaveLength(2);
  });
});
