import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
  byId: vi.fn(),
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
import type { PosExchangeContext } from "@/app/actions/pos-return-actions";

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

const storedCartKeys = () =>
  Object.keys(sessionStorage).filter((k) => k.startsWith("sm-pos-cart-v"));

beforeEach(() => {
  vi.clearAllMocks();
  // The register now keeps its in-progress basket in sessionStorage, which is
  // shared across tests in this file — an uncleared basket would restore into
  // the next test and pass or fail it for the wrong reason (the ordering trap
  // `test:shuffle` exists to catch).
  sessionStorage.clear();
  // Shared hoisted object: a test that opens the register on a cold catalogue
  // must not leave the next one cold.
  catalog.ready = true;
  catalog.all.mockReturnValue([ITEM]);
  catalog.search.mockReturnValue([ITEM]);
  catalog.byId.mockImplementation((productId: string) =>
    productId === ITEM.productId ? ITEM : null,
  );
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

  // ★★ A REFRESH USED TO EMPTY THE TILL. `cart` was plain component state
  // written nowhere, so an F5 mid-sale made the cashier re-scan the basket
  // with the customer standing there. Unmounting and remounting is the closest
  // a jsdom test gets to a reload; sessionStorage survives it, exactly as it
  // survives one in the tab.
  it("restores the basket after a reload, re-priced from the catalogue", async () => {
    await act(async () => {
      render(<SellClient config={CONFIG} initialItems={[ITEM]} />);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });
    expect(
      screen.getByRole("button", { name: "Cart, 2 items" }),
    ).toBeInTheDocument();

    cleanup();

    // The catalogue has repriced since; the restored line must quote TODAY's
    // price, never the one stored with the choice.
    catalog.byId.mockImplementation(() => ({ ...ITEM, price: 60 }));
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });

    // findBy*, not getBy*: the restore arrives from an effect, so a
    // synchronous query can lose the race on a loaded machine and fail for
    // reasons that have nothing to do with the code.
    expect(
      await screen.findByRole("button", { name: "Cart, 2 items" }),
    ).toBeInTheDocument();
    expect(container.textContent).toContain("Multigrain Bread");
    // 2 x today's ₹60, not 2 x the ₹52 in force when the basket was built:
    // choices are stored, prices are re-read (lib/pos/cart-storage.ts).
    expect(container.textContent).toContain("₹120");
    expect(container.textContent).not.toContain("₹104");
    expect(container.textContent).not.toContain(
      "Scan or tap a product to start a sale.",
    );
  });

  it("starts empty when the register is opened fresh", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });
    expect(container.textContent).toContain(
      "Scan or tap a product to start a sale.",
    );
  });

  // A completed or held sale must leave nothing behind: the counter is free
  // for the next customer, and their basket is not the previous one.
  it("forgets the basket once the cart is emptied", async () => {
    await act(async () => {
      render(<SellClient config={CONFIG} initialItems={[ITEM]} />);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });
    expect(storedCartKeys()).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    expect(storedCartKeys()).toHaveLength(0);

    cleanup();
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });
    expect(container.textContent).toContain(
      "Scan or tap a product to start a sale.",
    );
  });

  // ★★ THE WRITER'S RESTORE GATE. Every path that changes the basket saves it,
  // and on mount the cart is empty — so without the gate that writer clears the
  // stored basket before the restore has had a chance to run. It survives one
  // refresh either way (the payload is already in memory by then), which is
  // what makes this worth a test of its own: the loss only shows on a SECOND
  // reload while the catalogue is still cold, and then the basket is gone for
  // good.
  it("keeps the stored basket while the catalogue is still warming up", async () => {
    await act(async () => {
      render(<SellClient config={CONFIG} initialItems={[ITEM]} />);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });
    cleanup();

    catalog.ready = false;
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });
    // Nothing can be priced yet, so nothing is shown — but the basket must
    // still be there, and the till must not claim the sale started empty.
    expect(storedCartKeys()).toHaveLength(1);
    expect(
      await screen.findByText("Restoring the sale in progress…"),
    ).toBeInTheDocument();
    expect(container.textContent).not.toContain(
      "Scan or tap a product to start a sale.",
    );

    cleanup();
    catalog.ready = true;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });
    // The basket is back — asserted on the cart counter, since the product
    // name also appears on its grid tile.
    expect(
      await screen.findByRole("button", { name: "Cart, 1 item" }),
    ).toBeInTheDocument();
  });

  // ★★ THE CASHIER IN FRONT OF THE CUSTOMER WINS. If the catalogue is still
  // warming when they start ringing up, the stored basket is abandoned rather
  // than swapped in underneath them — handing a cashier a different basket
  // mid-sale is the money error this whole feature must never cause.
  it("abandons the stored basket once the cashier has started a new one", async () => {
    await act(async () => {
      render(<SellClient config={CONFIG} initialItems={[ITEM]} />);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });
    expect(
      await screen.findByRole("button", { name: "Cart, 1 item" }),
    ).toBeInTheDocument();
    cleanup();

    // Opened cold: the stored basket cannot be priced yet.
    catalog.ready = false;
    await act(async () => {
      render(<SellClient config={CONFIG} initialItems={[ITEM]} />);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });

    // The catalogue warms up mid-sale, which is when the restore becomes
    // possible — and must not happen.
    catalog.ready = true;
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });

    expect(
      await screen.findByRole("button", { name: "Cart, 2 items" }),
    ).toBeInTheDocument();
  });

  // ★ A basket built for one register must not reappear on another: stock is
  // per location, and a browser can be shared between stores.
  it("does not restore another register's basket", async () => {
    await act(async () => {
      render(<SellClient config={CONFIG} initialItems={[ITEM]} />);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });
    cleanup();

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient
          config={{ ...CONFIG, locationId: "loc-2" }}
          initialItems={[ITEM]}
        />,
      ));
    });
    expect(container.textContent).toContain(
      "Scan or tap a product to start a sale.",
    );
  });

  // ★★ THE EXCHANGE GUARD. A counter exchange is a replacement priced against
  // one specific completed return, with the original customer attached and
  // locked; letting its basket return as an ordinary sale would tender the
  // replacement as an unrelated one.
  it("does not restore an exchange basket into an ordinary sale", async () => {
    const exchange: PosExchangeContext = {
      returnId: "ret-1",
      originalLabel: "ORD100110006",
      returnedValue: 52,
      customer: {
        id: "cust-1",
        name: "Asha",
        phone: "9876543210",
        email: null,
        storeCredit: 0,
      },
    };

    await act(async () => {
      render(
        <SellClient
          config={CONFIG}
          initialItems={[ITEM]}
          exchange={exchange}
        />,
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });
    cleanup();

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });
    expect(container.textContent).toContain(
      "Scan or tap a product to start a sale.",
    );
  });
});
