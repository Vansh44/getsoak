"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  MapPin,
  Plus,
  Pencil,
  Trash2,
  Check,
  Banknote,
  CreditCard,
  ShieldCheck,
  Truck,
  Lock,
  ShoppingBag,
  Store,
  ChevronRight,
  Search,
  X,
} from "lucide-react";
import { useCart } from "@/app/(storefront)/components/cart/CartProvider";
import { useCartTax } from "@/app/(storefront)/components/cart/useCartTax";
import {
  placeOrder,
  getCartStock,
  getCheckoutConfig,
  getPickupOptions,
  type PickupOptions,
  confirmOnlinePayment,
  CheckoutFormData,
  type CheckoutConfig,
  type PaymentMethod,
} from "@/app/actions/checkout-actions";
import {
  getMyAddresses,
  upsertAddress,
  deleteAddress,
  type SavedAddress,
  type AddressInput,
} from "@/app/actions/address-actions";
import { useAuth } from "@/app/(storefront)/components/auth/AuthProvider";
import {
  PolicyConsent,
  usePolicyLinks,
} from "@/app/(storefront)/components/policy-consent";
import { openRazorpayModal } from "@/lib/payments/razorpay-client";
import { formatPrice } from "@/lib/pricing";
import { Button } from "@/components/ui/button";
import styles from "./checkout.module.css";

const EMPTY_ADDR: AddressInput = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  postalCode: "",
  country: "India",
};

// Build the placeOrder payload from a saved address, falling back to the
// account's contact details when the address itself doesn't carry them.
function addressToForm(
  a: SavedAddress,
  fallbackEmail?: string | null,
): CheckoutFormData {
  return {
    firstName: a.first_name || "",
    lastName: a.last_name || "",
    email: a.email || fallbackEmail || "",
    phone: a.phone || "",
    addressLine1: a.address_line1,
    addressLine2: a.address_line2 || "",
    city: a.city,
    state: a.state,
    postalCode: a.postal_code,
    country: a.country || "India",
  };
}

export default function CheckoutPage() {
  const router = useRouter();
  const { customer, loading: authLoading, openAuthModal } = useAuth();
  const cart = useCart();

  const [placing, setPlacing] = useState(false);
  // Set once the order is placed so clearing the cart below doesn't trip the
  // "cart empty → /shop" effect and steal the redirect to the success page.
  const orderPlaced = useRef(false);

  // Consent to the payment + refund terms, at the moment money moves. Only
  // these two — naming the privacy policy in a sentence about paying is noise.
  const { links: policyLinks, required: policyRequired } =
    usePolicyLinks("checkout");
  const [policyAgreed, setPolicyAgreed] = useState(false);

  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addrLoaded, setAddrLoaded] = useState(false);

  // Address add/edit form. `editingId`: null = closed, "new" = adding, else the
  // id of the address being edited.
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [addrForm, setAddrForm] = useState<AddressInput>(EMPTY_ADDR);
  const [savingAddr, setSavingAddr] = useState(false);
  const [addrError, setAddrError] = useState<string | null>(null);

  const [notes, setNotes] = useState("");

  // Payment method. Online payments render only when the store's gateway is
  // connected + enabled + plan-allowed (server-computed; placeOrder re-checks).
  const [payConfig, setPayConfig] = useState<CheckoutConfig | null>(null);
  // Pick up in store (roadmap Phase F). Absent/disabled ⇒ the section never
  // renders and checkout behaves exactly as before.
  const [pickup, setPickup] = useState<PickupOptions | null>(null);
  const [fulfilmentChoice, setFulfilment] = useState<"delivery" | "pickup">(
    "delivery",
  );
  const [pickupId, setPickupId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  // Billing defaults to the delivery address — that's true for almost every
  // order, so the common case is one already-ticked box and no extra typing.
  const [billingSame, setBillingSame] = useState(true);
  const [billing, setBilling] = useState({
    firstName: "",
    lastName: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
    phone: "",
  });
  const [payMethod, setPayMethod] = useState<PaymentMethod>("cod");
  // A placed-but-unpaid online order (modal dismissed / payment failed). Kept
  // so "Retry payment" reopens the SAME Razorpay order instead of placing a
  // duplicate; the reaper cancels it server-side if the shopper walks away.
  // `cartKey` snapshots the cart it was priced from — see activePendingPayment.
  const [pendingPayment, setPendingPayment] = useState<{
    orderId: string;
    orderRef: string;
    rzpOrderId: string;
    keyId: string;
    amountPaise: number;
    cartKey: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    getCheckoutConfig()
      .then((cfg) => {
        if (active) setPayConfig(cfg);
      })
      .catch(() => {
        // COD-only fallback; placeOrder would reject online anyway.
      });
    return () => {
      active = false;
    };
  }, []);

  // Which shops could hand this basket over. Re-fetched when the cart changes
  // because "has stock" is a property of the basket, not of the store.
  const items = cart.items;
  useEffect(() => {
    let active = true;
    // An empty cart bounces off this page anyway — nothing to clear.
    if (!items.length) return;
    getPickupOptions(items)
      .then((opts) => {
        if (active) {
          setPickup(opts);
          // A shop that dropped out of the list (sold its last unit while the
          // shopper hesitated) must not stay selected and fail at placeOrder.
          setPickupId((cur) =>
            cur && opts.locations.some((l) => l.id === cur && l.hasStock)
              ? cur
              : null,
          );
        }
      })
      .catch(() => {
        // Delivery still works; pickup is the extra.
      });
    return () => {
      active = false;
    };
    // `items` is cart state: a new array only when the cart actually changes,
    // which is exactly when "which shop has this?" needs re-asking.
  }, [items]);

  // Derived, not stored: if the last shop selling this basket sells out while
  // the shopper hesitates, the choice silently reverts to delivery rather than
  // being "corrected" by an effect a render later.
  const fulfilment: "delivery" | "pickup" = pickup?.enabled
    ? fulfilmentChoice
    : "delivery";

  // Pre-select the first shop that has the whole basket, so choosing "Pickup"
  // shows a real shop rather than an empty slot the shopper must go and fill.
  const chosenShop =
    pickup?.locations.find((l) => l.id === pickupId) ??
    pickup?.locations.find((l) => l.hasStock) ??
    null;

  // Plain substring match over what a person would type: shop name, street,
  // city or postcode. A store has a handful of shops, all already loaded, so
  // this needs no geocoding and no round trip.
  // Three shops in front, the rest behind "See all N" — a wall of twenty
  // addresses is not a choice, it's a search problem.
  const INLINE_SHOPS = 3;
  const pickerResults = (pickup?.locations ?? []).filter((l) => {
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return true;
    return (l.name + " " + l.address + " " + l.city + " " + l.postalCode)
      .toLowerCase()
      .includes(q);
  });

  // A retryable unpaid order is only valid for the exact cart it was priced
  // from — any cart/coupon change invalidates it (a fresh order gets placed
  // instead; the reaper cancels the abandoned one server-side). Derived, so
  // no effect is needed: a stale pending payment simply stops matching.
  const cartKey = `${cart.items.length}:${cart.total}:${cart.appliedCoupon?.code ?? ""}`;
  const activePendingPayment =
    pendingPayment && pendingPayment.cartKey === cartKey
      ? pendingPayment
      : null;

  // Tax for the order summary — resolved once per product-set change, recomputed
  // locally on quantity/coupon edits (see useCartTax). Display only; placeOrder
  // recomputes authoritatively at order time.
  const taxInfo = useCartTax(
    cart.items,
    cart.hydrated,
    cart.couponValid ? cart.couponDiscount : 0,
  );

  const selected = addresses.find((a) => a.id === selectedId) ?? null;

  // Not signed in → open the auth modal IN PLACE (no redirect). After sign-in
  // `customer` populates and the checkout renders right here.
  useEffect(() => {
    if (!authLoading && !customer) openAuthModal();
  }, [authLoading, customer, openAuthModal]);

  // Load saved addresses; preselect the default so the shopper doesn't retype.
  useEffect(() => {
    if (!customer) return;
    let active = true;
    getMyAddresses().then((list) => {
      if (!active) return;
      setAddresses(list);
      const def = list.find((a) => a.is_default) ?? list[0];
      if (def) setSelectedId(def.id);
      setAddrLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [customer]);

  // First-time shopper with no saved address → open the add form straight away,
  // prefilled with their account contact details.
  useEffect(() => {
    if (!addrLoaded || !customer) return;
    if (addresses.length === 0 && editingId === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditingId("new");
      setAddrForm({
        ...EMPTY_ADDR,
        firstName: customer.first_name || "",
        lastName: customer.last_name || "",
        email: customer.email || "",
        phone: customer.phone || "",
      });
    }
  }, [addrLoaded, customer, addresses.length, editingId]);

  // Redirect if cart empty (but not when we just emptied it after a successful
  // order — that navigates to the success page instead).
  useEffect(() => {
    if (orderPlaced.current) return;
    if (cart.hydrated && cart.items.length === 0) {
      toast.info("Your cart is empty");
      router.push("/shop");
    }
  }, [cart.hydrated, cart.items.length, router]);

  // Revalidate the cart against LIVE stock as soon as checkout opens (see the
  // long note in checkout-actions.ts). placeOrder still re-reserves atomically.
  const stockChecked = useRef(false);
  useEffect(() => {
    if (stockChecked.current) return;
    if (!cart.hydrated || cart.items.length === 0) return;
    stockChecked.current = true;
    const lines = cart.items.map((i) => ({
      productId: i.productId,
      variantId: i.variantId,
    }));
    getCartStock(lines)
      .then((info) => {
        const { removed, reduced } = cart.reconcileStock(info);
        if (removed.length > 0) {
          toast.error(
            removed.length === 1
              ? `${removed[0]} is no longer available and was removed from your cart.`
              : `${removed.length} items are no longer available and were removed from your cart.`,
          );
        }
        if (reduced.length > 0) {
          toast.info(
            reduced.length === 1
              ? `Only ${reduced[0].to} of ${reduced[0].name} left — quantity updated.`
              : "Some items had limited stock; quantities were updated.",
          );
        }
      })
      .catch(() => {
        // Non-fatal — placeOrder revalidates stock atomically regardless.
      });
  }, [cart]);

  const startAdd = useCallback(() => {
    setEditingId("new");
    setAddrError(null);
    setAddrForm({
      ...EMPTY_ADDR,
      firstName: customer?.first_name || "",
      lastName: customer?.last_name || "",
      email: customer?.email || "",
      phone: customer?.phone || "",
    });
  }, [customer]);

  const startEdit = useCallback((a: SavedAddress) => {
    setEditingId(a.id);
    setAddrError(null);
    setAddrForm({
      firstName: a.first_name,
      lastName: a.last_name ?? "",
      email: a.email ?? "",
      phone: a.phone ?? "",
      addressLine1: a.address_line1,
      addressLine2: a.address_line2 ?? "",
      city: a.city,
      state: a.state,
      postalCode: a.postal_code,
      country: a.country,
    });
  }, []);

  const cancelAddr = useCallback(() => {
    setEditingId(null);
    setAddrError(null);
  }, []);

  const changeAddr = (e: React.ChangeEvent<HTMLInputElement>) =>
    setAddrForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const submitAddr = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddrError(null);

    // Checkout needs a complete contact + address (placeOrder rejects otherwise).
    const missing = (
      [
        ["firstName", "First name"],
        ["lastName", "Last name"],
        ["phone", "Phone"],
        ["email", "Email"],
        ["addressLine1", "Address"],
        ["city", "City"],
        ["state", "State"],
        ["postalCode", "Postal code"],
        ["country", "Country"],
      ] as Array<[keyof AddressInput, string]>
    ).find(([k]) => !String(addrForm[k] ?? "").trim());
    if (missing) {
      setAddrError(`${missing[1]} is required.`);
      return;
    }

    setSavingAddr(true);
    const res = await upsertAddress(
      addrForm,
      editingId === "new" ? undefined : (editingId ?? undefined),
    );
    if (res.error || !res.id) {
      setSavingAddr(false);
      setAddrError(res.error || "Could not save address.");
      return;
    }

    const savedId = res.id;
    const list = await getMyAddresses();
    setAddresses(list);
    setSelectedId(savedId);
    setEditingId(null);
    setSavingAddr(false);
    toast.success("Address saved");
  };

  const handleDelete = async (id: string) => {
    const res = await deleteAddress(id);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    setAddresses((prev) => prev.filter((a) => a.id !== id));
    if (selectedId === id) setSelectedId(null);
    if (editingId === id) setEditingId(null);
    toast.success("Address removed");
  };

  const finishOrder = useCallback(
    (orderId: string, orderRef: string, online = false) => {
      orderPlaced.current = true;
      // `pm=rzp` tells the success page to reconcile the payment server-side
      // in case the confirm call was dropped (network blip after paying).
      router.push(
        `/checkout/success?orderId=${orderId}&ref=${encodeURIComponent(orderRef)}${online ? "&pm=rzp" : ""}`,
      );
      cart.clear(); // Clear the cart state after navigating away.
    },
    [router, cart],
  );

  // Open Razorpay Standard Checkout for an already-placed order and confirm
  // the payment server-side (HMAC-verified). The order/cart are only released
  // once payment succeeds; a dismissed modal keeps the order retryable.
  const startOnlinePayment = useCallback(
    async (payment: NonNullable<typeof pendingPayment>) => {
      const opened = await openRazorpayModal({
        keyId: payment.keyId,
        rzpOrderId: payment.rzpOrderId,
        amountPaise: payment.amountPaise,
        name: payConfig?.storeName || "Checkout",
        description: payment.orderRef || undefined,
        prefill: {
          name:
            `${customer?.first_name ?? ""} ${customer?.last_name ?? ""}`.trim() ||
            undefined,
          email: customer?.email || undefined,
          contact: customer?.phone || undefined,
        },
        onSuccess: async (res) => {
          const confirm = await confirmOnlinePayment(
            payment.orderId,
            res.razorpay_payment_id,
            res.razorpay_signature,
          );
          setPlacing(false);
          if (confirm.error) {
            // The money may have been taken but our confirm failed (network /
            // transient). Send the shopper to the confirmation page anyway —
            // the server reconciles pending payments against Razorpay.
            toast.info(
              "Payment received — we're confirming it with the gateway.",
            );
          } else {
            toast.success("Payment successful!");
          }
          setPendingPayment(null);
          finishOrder(payment.orderId, payment.orderRef, true);
        },
        onDismiss: () => {
          setPlacing(false);
          setPendingPayment(payment);
          toast.error(
            "Payment not completed. You can retry the payment or switch to Cash on Delivery.",
          );
        },
      });
      if (!opened) {
        setPlacing(false);
        setPendingPayment(payment);
        toast.error(
          "Couldn't load the payment window. Please check your connection and retry.",
        );
      }
    },
    [payConfig, customer, finishOrder],
  );

  const handlePlaceOrder = async () => {
    if (!selected) {
      toast.error("Please select a delivery address.");
      return;
    }
    // placeOrder writes the acceptance server-side; this is the UI affordance.
    if (policyRequired && !policyAgreed) {
      toast.error("Please accept the store policies to place your order.");
      return;
    }
    if (fulfilment === "pickup" && !chosenShop) {
      toast.error("Choose the shop you'd like to collect from.");
      return;
    }
    setPlacing(true);

    // Retry path: an online order was already placed for this exact cart —
    // reopen the SAME Razorpay order rather than creating a duplicate.
    if (activePendingPayment && payMethod === "razorpay") {
      await startOnlinePayment(activePendingPayment);
      return;
    }

    const form = addressToForm(selected, customer?.email);
    if (notes.trim()) form.notes = notes.trim().slice(0, 500);

    const result = await placeOrder(
      form,
      cart.items,
      cart.appliedCoupon?.code,
      fulfilment === "pickup" && payMethod === "cod"
        ? "pay_at_store"
        : payMethod,
      fulfilment === "pickup" ? (chosenShop?.id ?? null) : null,
      // A collection has no delivery address to differ from, so the billing
      // question is only asked — and only sent — for a shipped order.
      fulfilment === "delivery" && !billingSame ? billing : null,
    );

    if ("error" in result) {
      toast.error(result.error);
      setPlacing(false);
      return;
    }

    if (result.payment) {
      await startOnlinePayment({
        orderId: result.orderId,
        orderRef: result.orderRef,
        ...result.payment,
        cartKey,
      });
      return;
    }

    toast.success("Order placed successfully!");
    setPlacing(false);
    finishOrder(result.orderId, result.orderRef);
  };

  // ---- Loading / gate states ----
  if (authLoading || !cart.hydrated) {
    return (
      <main className={styles.center}>
        <p className={styles.muted}>Loading checkout…</p>
      </main>
    );
  }

  if (!customer) {
    return (
      <main className={styles.center}>
        <h1 className={styles.centerTitle}>Sign in to continue</h1>
        <p className={styles.centerText}>
          Please sign in to review your order and check out — your cart is
          saved.
        </p>
        <Button size="lg" onClick={openAuthModal}>
          Sign in
        </Button>
      </main>
    );
  }

  if (cart.items.length === 0) {
    return (
      <main className={styles.center}>
        <p className={styles.muted}>Loading checkout…</p>
      </main>
    );
  }

  const formOpen = editingId !== null;

  return (
    <main className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.heading}>
          <h1 className={styles.title}>Checkout</h1>
          <p className={styles.subtitle}>
            Review your delivery details and place your order.
          </p>
        </div>

        <div className={styles.layout}>
          {/* ---- Left: steps ---- */}
          <div className={styles.main}>
            {/* Delivery method — asked FIRST, because it decides what the rest
                of the step needs: a shipping address, or a shop. Every shop
                that can hand the basket over is listed and the SHOPPER picks —
                geography is their business, not the merchant's: they know
                whether they collect near home, near work, or on a route. Ship
                the default and needs one. */}
            {pickup?.enabled && (
              <section className={styles.card}>
                <div className={styles.sectionHead}>
                  <h2 className={styles.sectionTitle}>Delivery</h2>
                </div>

                <div className={styles.methodToggle} role="group">
                  <button
                    type="button"
                    className={`${styles.methodBtn}${fulfilment === "delivery" ? ` ${styles.methodBtnOn}` : ""}`}
                    onClick={() => setFulfilment("delivery")}
                    aria-pressed={fulfilment === "delivery"}
                  >
                    <Truck size={17} />
                    Ship
                  </button>
                  <button
                    type="button"
                    className={`${styles.methodBtn}${fulfilment === "pickup" ? ` ${styles.methodBtnOn}` : ""}`}
                    onClick={() => setFulfilment("pickup")}
                    aria-pressed={fulfilment === "pickup"}
                  >
                    <Store size={17} />
                    Pickup
                  </button>
                </div>

                {fulfilment === "pickup" && (
                  <div className={styles.pickupBox}>
                    <p className={styles.pickupCount}>
                      {pickup.inStockCount === 1
                        ? "There is 1 location with your items"
                        : `There are ${pickup.inStockCount} locations with your items`}
                    </p>

                    <div className={styles.shopList}>
                      {pickup.locations.slice(0, INLINE_SHOPS).map((l) => (
                        <label
                          key={l.id}
                          className={`${styles.shopCard}${l.hasStock ? "" : ` ${styles.shopCardOut}`}`}
                        >
                          <input
                            type="radio"
                            name="pickup-shop"
                            checked={chosenShop?.id === l.id}
                            disabled={!l.hasStock}
                            onChange={() => setPickupId(l.id)}
                            className={styles.pickerRadio}
                          />
                          <span className={styles.shopMain}>
                            <span className={styles.shopName}>{l.name}</span>
                            {l.address && (
                              <span className={styles.shopAddr}>
                                {l.address}
                              </span>
                            )}
                            <span
                              className={`${styles.shopMeta}${l.hasStock && pickup.readyToday ? ` ${styles.readyToday}` : ""}`}
                            >
                              {!l.hasStock
                                ? "Not everything in your bag is in stock here"
                                : pickup.readyToday
                                  ? "Available today"
                                  : `Ready ${pickup.readyDate}`}
                            </span>
                          </span>
                          <span className={styles.shopFree}>FREE</span>
                        </label>
                      ))}
                    </div>

                    {pickup.locations.length > INLINE_SHOPS && (
                      <button
                        type="button"
                        className={styles.shopMore}
                        onClick={() => setPickerOpen(true)}
                      >
                        See all {pickup.locations.length} stores
                        <ChevronRight size={16} />
                      </button>
                    )}

                    {/* What they've actually agreed to, once a shop is picked. */}
                    {chosenShop && (
                      <div className={styles.pickupDetails}>
                        <div className={styles.pickupDetailRow}>
                          <span>Collect from</span>
                          <strong>{chosenShop.name}</strong>
                        </div>
                        {chosenShop.address && (
                          <div className={styles.pickupDetailRow}>
                            <span>Address</span>
                            <strong>{chosenShop.address}</strong>
                          </div>
                        )}
                        <div className={styles.pickupDetailRow}>
                          <span>Ready</span>
                          <strong
                            className={
                              pickup.readyToday ? styles.readyToday : undefined
                            }
                          >
                            {pickup.readyToday
                              ? "Available today"
                              : pickup.readyDate}
                          </strong>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* Step 1 — Delivery address (contact details when collecting) */}
            <section className={styles.card}>
              <div className={styles.sectionHead}>
                <span className={styles.stepNum}>1</span>
                <h2 className={styles.sectionTitle}>
                  {fulfilment === "pickup"
                    ? "Contact Details"
                    : "Delivery Address"}
                </h2>
                {addresses.length > 0 && !formOpen && (
                  <span className={styles.sectionHint}>
                    {addresses.length} saved
                  </span>
                )}
              </div>

              {addresses.length > 0 && (
                <div className={styles.addrGrid}>
                  {addresses.map((a) => {
                    const active = selectedId === a.id;
                    return (
                      <div
                        key={a.id}
                        role="button"
                        tabIndex={0}
                        aria-pressed={active}
                        onClick={() => setSelectedId(a.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedId(a.id);
                          }
                        }}
                        className={`${styles.addrCard} ${active ? styles.addrCardActive : ""}`}
                      >
                        <span className={styles.radio} />
                        <div className={styles.addrBody}>
                          <div className={styles.addrName}>
                            {a.first_name} {a.last_name}
                            {a.is_default && (
                              <span className={styles.badge}>Default</span>
                            )}
                          </div>
                          <div className={styles.addrLines}>
                            {a.address_line1}
                            {a.address_line2
                              ? `, ${a.address_line2}`
                              : ""}, {a.city}, {a.state} {a.postal_code}
                          </div>
                          {a.phone && (
                            <div className={styles.addrPhone}>
                              Phone: {a.phone}
                            </div>
                          )}
                          <div className={styles.addrActions}>
                            <button
                              type="button"
                              className={styles.linkBtn}
                              onClick={(e) => {
                                e.stopPropagation();
                                startEdit(a);
                              }}
                            >
                              <Pencil size={13} /> Edit
                            </button>
                            <button
                              type="button"
                              className={`${styles.linkBtn} ${styles.linkBtnDanger}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDelete(a.id);
                              }}
                            >
                              <Trash2 size={13} /> Delete
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {!formOpen && (
                    <button
                      type="button"
                      className={styles.addTile}
                      onClick={startAdd}
                    >
                      <span className={styles.addTileIcon}>
                        <Plus size={18} />
                      </span>
                      Add a new address
                    </button>
                  )}
                </div>
              )}

              {formOpen && (
                <form onSubmit={submitAddr} className={styles.form}>
                  <div className={styles.formTitle}>
                    {editingId === "new" ? "Add a new address" : "Edit address"}
                  </div>

                  <div className={styles.twoCol}>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="firstName">
                        First Name
                      </label>
                      <input
                        id="firstName"
                        name="firstName"
                        className={styles.input}
                        value={addrForm.firstName}
                        onChange={changeAddr}
                        disabled={savingAddr}
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="lastName">
                        Last Name
                      </label>
                      <input
                        id="lastName"
                        name="lastName"
                        className={styles.input}
                        value={addrForm.lastName}
                        onChange={changeAddr}
                        disabled={savingAddr}
                      />
                    </div>
                  </div>

                  <div className={styles.twoCol}>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="email">
                        Email
                      </label>
                      <input
                        id="email"
                        name="email"
                        type="email"
                        className={styles.input}
                        value={addrForm.email}
                        onChange={changeAddr}
                        disabled={savingAddr}
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="phone">
                        Phone
                      </label>
                      <input
                        id="phone"
                        name="phone"
                        type="tel"
                        className={styles.input}
                        value={addrForm.phone}
                        onChange={changeAddr}
                        disabled={savingAddr}
                      />
                    </div>
                  </div>

                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="addressLine1">
                      Address Line 1
                    </label>
                    <input
                      id="addressLine1"
                      name="addressLine1"
                      className={styles.input}
                      placeholder="House no., building, street"
                      value={addrForm.addressLine1}
                      onChange={changeAddr}
                      disabled={savingAddr}
                    />
                  </div>

                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="addressLine2">
                      Address Line 2 (Optional)
                    </label>
                    <input
                      id="addressLine2"
                      name="addressLine2"
                      className={styles.input}
                      placeholder="Area, landmark"
                      value={addrForm.addressLine2}
                      onChange={changeAddr}
                      disabled={savingAddr}
                    />
                  </div>

                  <div className={styles.twoCol}>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="city">
                        City
                      </label>
                      <input
                        id="city"
                        name="city"
                        className={styles.input}
                        value={addrForm.city}
                        onChange={changeAddr}
                        disabled={savingAddr}
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="state">
                        State
                      </label>
                      <input
                        id="state"
                        name="state"
                        className={styles.input}
                        value={addrForm.state}
                        onChange={changeAddr}
                        disabled={savingAddr}
                      />
                    </div>
                  </div>

                  <div className={styles.twoCol}>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="postalCode">
                        Postal Code
                      </label>
                      <input
                        id="postalCode"
                        name="postalCode"
                        className={styles.input}
                        value={addrForm.postalCode}
                        onChange={changeAddr}
                        disabled={savingAddr}
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="country">
                        Country
                      </label>
                      <input
                        id="country"
                        name="country"
                        className={styles.input}
                        value={addrForm.country}
                        onChange={changeAddr}
                        disabled={savingAddr}
                      />
                    </div>
                  </div>

                  {addrError && <p className={styles.formError}>{addrError}</p>}

                  <div className={styles.formActions}>
                    {(addresses.length > 0 || editingId !== "new") && (
                      <button
                        type="button"
                        className={styles.ghostBtn}
                        onClick={cancelAddr}
                        disabled={savingAddr}
                      >
                        Cancel
                      </button>
                    )}
                    <button
                      type="submit"
                      className={styles.primaryBtn}
                      disabled={savingAddr}
                    >
                      <MapPin size={16} />
                      {savingAddr ? "Saving…" : "Save & deliver here"}
                    </button>
                  </div>
                </form>
              )}
            </section>

            {/* Billing address. Ticked by default because it matches the
                delivery address on almost every order; only a shipped order
                has one to differ from. */}
            {fulfilment === "delivery" && (
              <section className={styles.card}>
                <div className={styles.sectionHead}>
                  <h2 className={styles.sectionTitle}>Billing Address</h2>
                </div>

                <label className={styles.billingCheck}>
                  <input
                    type="checkbox"
                    checked={billingSame}
                    onChange={(e) => setBillingSame(e.target.checked)}
                  />
                  <span>Same as my delivery address</span>
                </label>

                {!billingSame && (
                  <div className={styles.billingGrid}>
                    {(
                      [
                        ["firstName", "First name", ""],
                        ["lastName", "Last name", ""],
                        ["addressLine1", "Address", "full"],
                        ["addressLine2", "Apartment, suite (optional)", "full"],
                        ["city", "City", ""],
                        ["state", "State", ""],
                        ["postalCode", "Postcode", ""],
                        ["phone", "Phone (optional)", ""],
                      ] as const
                    ).map(([key, label, span]) => (
                      <div
                        key={key}
                        className={span === "full" ? styles.billingFull : ""}
                      >
                        <label className={styles.label} htmlFor={`bill-${key}`}>
                          {label}
                        </label>
                        <input
                          id={`bill-${key}`}
                          className={styles.input}
                          value={billing[key]}
                          onChange={(e) =>
                            setBilling((b) => ({ ...b, [key]: e.target.value }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* Step 2 — Payment */}
            <section className={styles.card}>
              <div className={styles.sectionHead}>
                <span className={styles.stepNum}>2</span>
                <h2 className={styles.sectionTitle}>Payment Method</h2>
              </div>

              {payConfig?.onlinePayments ? (
                <div className={styles.payStack}>
                  <button
                    type="button"
                    className={`${styles.payOption}${payMethod === "cod" ? "" : ` ${styles.payOptionMuted}`}`}
                    onClick={() => setPayMethod("cod")}
                    aria-pressed={payMethod === "cod"}
                  >
                    <span className={styles.payIcon}>
                      <Banknote size={22} />
                    </span>
                    <div>
                      <div className={styles.payName}>
                        {fulfilment === "pickup"
                          ? "Pay at store"
                          : "Cash on Delivery"}
                      </div>
                      <div className={styles.payDesc}>
                        {fulfilment === "pickup"
                          ? "Pay at the counter when you collect your order."
                          : "Pay with cash when your order arrives at your doorstep."}
                      </div>
                    </div>
                    <span className={styles.payCheck}>
                      <Check size={20} />
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`${styles.payOption}${payMethod === "razorpay" ? "" : ` ${styles.payOptionMuted}`}`}
                    onClick={() => setPayMethod("razorpay")}
                    aria-pressed={payMethod === "razorpay"}
                  >
                    <span className={styles.payIcon}>
                      <CreditCard size={22} />
                    </span>
                    <div>
                      <div className={styles.payName}>Pay online</div>
                      <div className={styles.payDesc}>
                        UPI, cards or netbanking — secured by Razorpay.
                      </div>
                    </div>
                    <span className={styles.payCheck}>
                      <Check size={20} />
                    </span>
                  </button>
                </div>
              ) : (
                <div className={styles.payOption}>
                  <span className={styles.payIcon}>
                    <Banknote size={22} />
                  </span>
                  <div>
                    <div className={styles.payName}>
                      {fulfilment === "pickup"
                        ? "Pay at store"
                        : "Cash on Delivery"}
                    </div>
                    <div className={styles.payDesc}>
                      {fulfilment === "pickup"
                        ? "Pay at the counter when you collect your order."
                        : "Pay with cash when your order arrives at your doorstep."}
                    </div>
                  </div>
                  <span className={styles.payCheck}>
                    <Check size={20} />
                  </span>
                </div>
              )}

              <div className={styles.field} style={{ marginTop: 18 }}>
                <label className={styles.label} htmlFor="notes">
                  {fulfilment === "pickup"
                    ? "Notes for the shop (Optional)"
                    : "Delivery instructions (Optional)"}
                </label>
                <input
                  id="notes"
                  name="notes"
                  className={styles.input}
                  placeholder="e.g. Leave at the front desk"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={500}
                />
              </div>
            </section>
          </div>

          {/* ---- Right: order summary ---- */}
          <aside className={styles.aside}>
            <div className={styles.summaryCard}>
              <h2 className={styles.summaryTitle}>Order Summary</h2>

              <ul className={styles.items}>
                {cart.items.map((item, idx) => (
                  <li key={idx} className={styles.item}>
                    <div className={styles.thumb}>
                      {item.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.image} alt={item.name} />
                      ) : (
                        <span className={styles.thumbFallback}>
                          <ShoppingBag size={18} />
                        </span>
                      )}
                      <span className={styles.qtyBubble}>{item.quantity}</span>
                    </div>
                    <div className={styles.itemBody}>
                      <div className={styles.itemName}>{item.name}</div>
                      {item.variantName && (
                        <div className={styles.itemVariant}>
                          {item.variantName}
                        </div>
                      )}
                    </div>
                    <div className={styles.itemPrice}>
                      {formatPrice(item.price * item.quantity)}
                    </div>
                  </li>
                ))}
              </ul>

              <div className={styles.rows}>
                <div className={styles.row}>
                  <span>Subtotal</span>
                  <span>{formatPrice(cart.subtotal)}</span>
                </div>
                {cart.appliedCoupon &&
                  cart.couponValid &&
                  cart.couponDiscount > 0 && (
                    <div className={`${styles.row} ${styles.rowDiscount}`}>
                      <span>Discount ({cart.appliedCoupon.code})</span>
                      <span>−{formatPrice(cart.couponDiscount)}</span>
                    </div>
                  )}
                <div className={styles.row}>
                  <span>
                    {fulfilment === "pickup" ? "Pickup in store" : "Shipping"}
                  </span>
                  <span className={styles.free}>Free</span>
                </div>
                {taxInfo?.enabled && taxInfo.tax > 0 && (
                  <div className={styles.row}>
                    <span>
                      {taxInfo.inclusive ? "Tax (included)" : "Tax"}
                      {taxInfo.byRate.length === 1
                        ? ` · ${taxInfo.byRate[0].label}`
                        : ""}
                    </span>
                    <span>
                      {taxInfo.inclusive ? "" : "+"}
                      {formatPrice(taxInfo.tax)}
                    </span>
                  </div>
                )}
              </div>

              <div className={styles.totalRow}>
                <span className={styles.totalLabel}>Total</span>
                <span className={styles.totalValue}>
                  {formatPrice(
                    taxInfo?.enabled && !taxInfo.inclusive
                      ? cart.total + taxInfo.tax
                      : cart.total,
                  )}
                </span>
              </div>

              <PolicyConsent
                links={policyLinks}
                checked={policyAgreed}
                onChange={setPolicyAgreed}
                className={styles.policyConsent}
                verb="I have read and accept the"
              />

              <button
                type="button"
                className={styles.placeBtn}
                onClick={handlePlaceOrder}
                disabled={
                  placing || !selected || (policyRequired && !policyAgreed)
                }
              >
                {placing
                  ? "Processing…"
                  : activePendingPayment && payMethod === "razorpay"
                    ? "Retry Payment"
                    : payMethod === "razorpay"
                      ? "Pay & Place Order"
                      : fulfilment === "pickup"
                        ? "Place Order (Pay at store)"
                        : "Place Order (COD)"}
              </button>
              {!selected && (
                <p className={styles.placeHint}>
                  {fulfilment === "pickup"
                    ? "Choose a store to continue"
                    : "Add a delivery address to continue"}
                </p>
              )}
            </div>

            <div className={styles.trust}>
              <div className={styles.trustItem}>
                <ShieldCheck size={16} /> Your details are kept private &amp;
                secure
              </div>
              <div className={styles.trustItem}>
                <Truck size={16} />{" "}
                {fulfilment === "pickup"
                  ? "Free to collect in store"
                  : "Free delivery on this order"}
              </div>
              <div className={styles.trustItem}>
                <Lock size={16} />{" "}
                {payMethod === "razorpay"
                  ? "Payments secured by Razorpay"
                  : fulfilment === "pickup"
                    ? "No payment needed until you collect"
                    : "No payment needed until delivery"}
              </div>
            </div>
          </aside>
        </div>
      </div>

      {/* Pickup location picker. A dialog, like ALDO/IKEA/Shopify: choosing a
          shop is a decision with its own list and its own search, not a fifth
          radio buried in the flow. */}
      {pickerOpen && pickup && (
        <div
          className={styles.pickerOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="Pickup locations"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPickerOpen(false);
          }}
        >
          <div className={styles.picker}>
            <div className={styles.pickerHead}>
              <h3 className={styles.pickerTitle}>Pickup locations</h3>
              <button
                type="button"
                className={styles.pickerClose}
                onClick={() => setPickerOpen(false)}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <div className={styles.pickerSearch}>
              <Search size={16} className={styles.pickerSearchIcon} />
              <input
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                placeholder="Postcode, city or shop name"
                className={styles.pickerInput}
                autoFocus
              />
            </div>

            <p className={styles.pickerCount}>
              {pickerResults.length} of {pickup.locations.length} location
              {pickup.locations.length === 1 ? "" : "s"}
            </p>

            <div className={styles.pickerList}>
              {pickerResults.map((l) => (
                <label
                  key={l.id}
                  className={`${styles.pickerRow}${l.hasStock ? "" : ` ${styles.pickerRowOut}`}`}
                >
                  <input
                    type="radio"
                    name="pickup-location"
                    checked={chosenShop?.id === l.id}
                    disabled={!l.hasStock}
                    onChange={() => setPickupId(l.id)}
                    className={styles.pickerRadio}
                  />
                  <span className={styles.shopMain}>
                    <span className={styles.shopName}>{l.name}</span>
                    {l.address && (
                      <span className={styles.shopAddr}>{l.address}</span>
                    )}
                    {!l.hasStock && (
                      <span className={styles.shopMeta}>
                        Not everything in your bag is in stock here
                      </span>
                    )}
                  </span>
                  <span className={styles.shopFree}>FREE</span>
                </label>
              ))}
              {pickerResults.length === 0 && (
                <p className={styles.pickerEmpty}>
                  No shops match that. Try a city or postcode.
                </p>
              )}
            </div>

            <div className={styles.pickerFoot}>
              <button
                type="button"
                className={styles.pickerSave}
                onClick={() => setPickerOpen(false)}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
