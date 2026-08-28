"use client";

// The counter: a customer is standing here with an order that already exists.
// TWO DOORS — /pos/pickups and /pos/returns — and ONE search behind both.
//
// ★ WHY THE LOOKUP IS SHARED. These were once two screens with two search
// boxes. The collections queue searched a collection code or an order number;
// the returns lookup searched an order number, a phone or an email — and
// NEITHER COULD FIND WHAT THE OTHER COULD. So a cashier had to know which kind
// of visit this was BEFORE they knew which order it was. The customer holding
// the phone does not present that way: they hand over a number, and the till
// works out what can be done with it. It is the ONE-BOX-TAKES-BOTH rule the
// queue already had for scanned codes, carried one step further.
//
// ★ WHY THERE ARE STILL TWO DOORS. Discoverability is a separate problem from
// lookup. Someone holding goods a customer just handed back would not think to
// tap "Pickups", so Returns keeps its own name in the rail — and its own
// capability gate, since a cashier cannot give money back. What the two doors
// differ in is ONLY what is on screen before you search (`mode` below);
// splitting the query again would rebuild the problem the merge removed.
//
// ★ WHY "PICKUPS", NOT "ORDERS". It shipped as Orders (Shopify POS names the
// equivalent screen that way) and sat two rows above "Sales" in the rail, where
// a cashier reads both as "the things we sold".
//
// ★ THE QUEUE IS SECTIONED BY WHO IT IS WAITING ON — see the split below.
//
// ★ THE ROW OFFERS WHAT THE ORDER CAN DO, AND WHAT THIS OPERATOR MAY DO. Both
// halves matter. "Mark ready" is `fulfil_pickup` and handing over is `sell` —
// every POS role holds both, so in practice the row's buttons follow the ORDER's
// state — while taking a return is `refund`, which a cashier does not have.
// Every one of them is re-checked in the action. Hiding what would be refused is
// not the security boundary, it is not making someone fail in front of a
// customer.

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Loader2,
  PackageCheck,
  RotateCcw,
  Search,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { isCollectionCode } from "@/lib/fulfilment/collection-code";
import {
  collectionNote,
  collectionState,
  isExpiringSoon,
  PICKUP_WARN_HOURS,
} from "@/lib/pos/collection-state";
import {
  getCollectionCredit,
  findPickupByCode,
  getPickupQueue,
  markCollected,
  markReadyForPickup,
  type PickupOrder,
} from "@/app/actions/pos-pickup-actions";
import {
  findOrderForReturn,
  type FoundOrder,
} from "@/app/actions/pos-return-actions";
import {
  confirmPosGatewayPayment,
  startPosGatewayPayment,
  type PosTender,
} from "@/app/actions/pos-sale-actions";
import { TenderPanel } from "./sell/tender-panel";
import { CollectionDetail } from "./collection-detail";
import { PosScreen } from "./pos-screen";
import { usePoll } from "@/lib/pos/use-poll";
import { fetchPickupQueue } from "@/lib/pos/live";
import { claimPickupBadge, publishPickupCount } from "@/lib/pos/pickup-badge";
import { CustomerPhoneVerification } from "./customer-phone-verification";
import type { PosCustomerVerificationPurpose } from "@/lib/pos/customer-verification";
import { openRazorpayModal } from "@/lib/payments/razorpay-client";

const money = (n: number) => `₹${n.toFixed(2)}`;

/** "Expires in 3 days" beats a timestamp nobody can subtract in their head. */
function expiryLabel(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "Expired";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} left`;
  const hours = Math.max(1, Math.floor(ms / 3_600_000));
  return `${hours} hour${hours === 1 ? "" : "s"} left`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        // Rendered on the client here, but pinned for the same reason §24
        // pins it server-side: the shop is in India and the browser's zone is
        // whatever the device says.
        timeZone: "Asia/Kolkata",
      });
}

/** The two things a counter can be handed, in one list. Discriminated rather
 *  than flattened: a collection has a queue position, an expiry and money that
 *  may still be owed; a past order has none of that and is only ever a doorway
 *  to the return screen. Squashing them into one shape would mean a row full of
 *  fields that are null half the time. */
type CounterRow =
  | { kind: "pickup"; order: PickupOrder }
  | { kind: "past"; order: FoundOrder };

/**
 * Which door the operator came through.
 *
 * ★ TWO DOORS, ONE SEARCH — and that is the whole point. The screens were
 * merged because a customer at the counter hands over a number without
 * announcing which kind of visit it is, and the search still finds everything
 * from either entry. What the mode changes is only what you see BEFORE you
 * search: `pickups` opens on the shelf (a queue of work), `returns` opens on
 * the box (there is no returns queue at a till — a return starts when someone
 * walks in). Splitting the LOOKUP again would rebuild the exact problem the
 * merge removed.
 */
export type CounterMode = "pickups" | "returns";

export function CounterClient({
  mode,
  initial,
  error,
  canRefund,
  canFulfilPickup,
  gateway,
}: {
  mode: CounterMode;
  initial: PickupOrder[];
  error: string | null;
  /** Taking a return is a manager capability — a cashier hands collections
   *  over and reprints, but does not give money back. */
  canRefund: boolean;
  /** Marking a box packed and ready. Every POS role holds this today; the prop
   *  stays so a future restricted role does not silently get the button. */
  canFulfilPickup: boolean;
  gateway?: {
    keyId: string;
    storeName: string;
    locationName: string;
  } | null;
}) {
  const [queue, setQueue] = useState(initial);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CounterRow[] | null>(null);
  const [lastSearched, setLastSearched] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // `acked` rides along so the attestation survives the tender pad — otherwise
  // confirming an unprepared order, then paying, would be refused by the server
  // after the cashier had already keyed the cash in.
  const [tendering, setTendering] = useState<{
    order: PickupOrder;
    acked: boolean;
    /** Carried on the row so a retry after an error re-sends the same
     *  acknowledgement instead of re-opening the dialog for it. */
    ackUnverified?: boolean;
  } | null>(null);
  /** The attached customer's spendable credit, or null while it loads. */
  const [collectionCredit, setCollectionCredit] = useState<number | null>(null);
  const [confirmUnprepared, setConfirmUnprepared] =
    useState<PickupOrder | null>(null);
  /** The collection whose full detail is open. Holds the ROW, so the panel can
   *  paint its header before the read lands. */
  const [detailFor, setDetailFor] = useState<PickupOrder | null>(null);
  /** Bumped when something changes the money on the open order — a deposit
   *  leaves the panel showing figures the server has already moved past. */
  const [detailReload, setDetailReload] = useState(0);
  const [pending, start] = useTransition();
  const boxRef = useRef<HTMLInputElement>(null);
  // ★★ AWAITABLE, NOT A CALLBACK — and that is what keeps the tender pad
  // honest. `takePayment` is the panel's `onComplete`: returning `{}` to it
  // while a dialog opened behind the scenes reads as SUCCESS, so the panel
  // cleared its spinner, showed no error, and left an enabled "Complete sale"
  // under the verification dialog. The retry then ran OUTSIDE the panel, so
  // its own failure had nowhere to be displayed either.
  //
  // Awaiting it means `finish` never returns until the whole thing resolves:
  // the panel stays busy, and every outcome — verified, overridden, cancelled,
  // failed — comes back through the one path that already renders errors.
  //
  // Resolves `false` for a real proof, `true` for an acknowledged override
  // (which travels to the server as its own flag), and `null` for cancelled.
  const verificationResolve = useRef<((ack: boolean | null) => void) | null>(
    null,
  );
  const [verification, setVerification] = useState<{
    orderId: string;
    purpose: PosCustomerVerificationPurpose;
  } | null>(null);

  const trimmed = query.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < 4;
  const searching = trimmed.length >= 4;
  // ★ DERIVED, NOT CLEARED FROM AN EFFECT. Backspacing below the floor hides
  // stale hits on the SAME render — an effect that reset them would leave a
  // frame showing the last search's results under a box that no longer says
  // what they were for. The same rule the old returns lookup followed.
  const found = searching ? results : null;
  const searched = searching && lastSearched !== null;

  const refreshQueue = useCallback(() => {
    start(async () => {
      const res = await getPickupQueue();
      if (res.error) toast.error(res.error);
      else setQueue(res.orders);
    });
  }, []);

  // ── The queue, kept live ──────────────────────────────────────────────────
  // A collection is created by a SHOPPER, so nothing on this screen makes one
  // appear — without this the counter only learns about an order when somebody
  // reloads the page, which is what a shop actually hit.
  //
  // ★ QUIET, AND NOT A TRANSITION. `start()` sets `pending`, which draws the
  // spinner in the search box — a background re-read that flashes "searching…"
  // every thirty seconds is worse than no refresh, because it looks like the
  // till is doing something the cashier didn't ask for. Errors are swallowed
  // for the same reason: a toast nobody triggered, on a repeating timer, is how
  // a shop learns to dismiss toasts without reading them. The next explicit
  // action still surfaces the failure.
  //
  // ★ SUSPENDED WHILE THE CASHIER IS MID-ACTION. `settle()` removes a row
  // optimistically, so a poll landing between the tap and the server's answer
  // would put it back — under the finger of someone who has just handed the
  // goods over. Searching pauses it too: the queue isn't on screen, so re-reading
  // it is a request for nothing.
  const idle =
    !busy &&
    !tendering &&
    !confirmUnprepared &&
    !verification &&
    !searching &&
    !pending;

  // ★ THE QUEUE ALREADY CARRIES THE COUNT, so publishing it stops the rail
  // making a second request for the same fact — and, more importantly, keeps
  // the badge exactly in step with the list. Before this the row vanished on
  // hand-over while the badge kept the old number for up to an interval.
  //
  // The claim is tied to `idle`, not to being mounted: this poll suspends while
  // the cashier is mid-action or searching, and a claim held across that would
  // freeze the badge for as long as somebody left a search box full. Released,
  // the nav picks polling straight back up.
  useEffect(() => {
    if (!idle) return;
    return claimPickupBadge();
  }, [idle]);

  useEffect(() => {
    // Includes the server-rendered first paint, so the badge agrees with the
    // list before any poll has run.
    if (!searching) publishPickupCount(queue.length);
  }, [queue.length, searching]);

  usePoll(
    useCallback(async (run) => {
      const res = await fetchPickupQueue(run.signal);
      // Failure is not "unchanged". Returning undefined keeps retries at the
      // base interval instead of backing an outage off to two minutes.
      if (!res || res.error || !run.isCurrent()) return undefined;
      let moved = false;
      setQueue((cur) => {
        if (!run.isCurrent()) return cur;
        moved = !sameQueue(cur, res.orders);
        return moved ? res.orders : cur;
      });
      return moved;
    }, []),
    { enabled: idle, backOff: true },
  );

  /**
   * One query, resolved against everything this operator may look at.
   *
   * A collection code is a cheap shape check first (isCollectionCode), so a
   * scanner pointed at a milk carton never becomes three database lookups — and
   * a code belonging to a sister branch names THAT branch rather than coming
   * back "not found" with the customer standing there.
   */
  const runSearch = useCallback(
    (q: string) => {
      start(async () => {
        if (isCollectionCode(q)) {
          const res = await findPickupByCode(q);
          setLastSearched(q);
          if (res.error) {
            toast.error(res.error);
            setResults([]);
            return;
          }
          if (res.otherLocation) {
            toast.error(`That order is waiting at ${res.otherLocation}.`);
            setResults([]);
            return;
          }
          setResults(res.order ? [{ kind: "pickup", order: res.order }] : []);
          return;
        }

        // Only ask for what this operator is allowed to be told. A cashier has
        // no `refund`, and firing findOrderForReturn anyway would return an
        // error string on every keystroke of an ordinary collection lookup.
        const [pickups, past] = await Promise.all([
          getPickupQueue(q),
          canRefund
            ? findOrderForReturn(q)
            : Promise.resolve({ results: [] as FoundOrder[] }),
        ]);

        const rows: CounterRow[] = pickups.orders.map((order) => ({
          kind: "pickup" as const,
          order,
        }));
        // An order waiting on the shelf is shown as a collection, not twice —
        // the collection row is the one with something to do on it.
        const seen = new Set(pickups.orders.map((o) => o.id));
        for (const order of past.results) {
          if (!seen.has(order.orderId)) rows.push({ kind: "past", order });
        }
        setResults(rows);
        setLastSearched(q);
      });
    },
    [canRefund],
  );

  const requestVerification = (
    orderId: string,
    purpose: PosCustomerVerificationPurpose,
  ): Promise<boolean | null> =>
    new Promise((resolve) => {
      // A dialog already open would otherwise strand its awaiter forever.
      verificationResolve.current?.(null);
      verificationResolve.current = resolve;
      setVerification({ orderId, purpose });
    });

  const settleVerification = (ack: boolean | null) => {
    const resolve = verificationResolve.current;
    verificationResolve.current = null;
    setVerification(null);
    resolve?.(ack);
  };

  // Debounced so a scanner burst or a fast typist doesn't fire per keystroke.
  // This lookup is unrelated to checkout customer capture: a counter search is
  // intentionally live, while the customer mobile is explicitly submit-only.
  useEffect(() => {
    if (trimmed.length < 4) return;
    const handle = setTimeout(() => runSearch(trimmed), 300);
    return () => clearTimeout(handle);
  }, [trimmed, runSearch]);

  /** A completed hand-over leaves the work queue. Mark-ready is deliberately
   *  separate below: that order is still work, now waiting on the customer. */
  const settle = (id: string, message: string) => {
    toast.success(message);
    setQueue((cur) => cur.filter((o) => o.id !== id));
    setResults((cur) => (cur ? cur.filter((r) => rowId(r) !== id) : cur));
  };

  /**
   * Marking a parcel ready moves the SAME row between the two queue sections.
   *
   * ★ SERVER-CONFIRMED, THEN LOCAL. Moving before the action returns could tell
   * a cashier the customer was notified when the write actually failed. Once
   * it succeeds, though, waiting for the next poll makes the row disappear for
   * up to two minutes because `settle()` used to remove it like a hand-over.
   * Update every local view of the row in the confirmation frame; the normal
   * queue poll remains the eventual reconciliation for changes from elsewhere.
   */
  const markReady = async (id: string) => {
    setBusy(id);
    const res = await markReadyForPickup(id);
    setBusy(null);
    if (res.error) {
      toast.error(res.error);
      // Refused means the list is stale — someone else got there first.
      refreshQueue();
      return;
    }

    const ready = (order: PickupOrder): PickupOrder =>
      order.id === id ? { ...order, status: "ready" } : order;

    toast.success("Marked ready.");
    setQueue((cur) => cur.map(ready));
    setResults((cur) =>
      cur
        ? cur.map((row) =>
            row.kind === "pickup" && row.order.id === id
              ? { ...row, order: ready(row.order) }
              : row,
          )
        : cur,
    );
    setDetailFor((cur) => (cur ? ready(cur) : cur));
  };

  /**
   * Nothing owed hands over straight away; money due opens the tender pad.
   *
   * An order nobody marked ready is confirmed first (`handoverGate`): the shop
   * may genuinely be packing it while the customer waits, so this is a question,
   * not a refusal — but it must never be the thing a mis-tap does.
   */
  const continueHandOver = (
    o: PickupOrder,
    acked: boolean,
    ackUnverified = false,
  ) => {
    if (o.amountDue > 0) {
      setTendering({ order: o, acked, ackUnverified });
      // Fetched here rather than carried on the queue row: the queue is polled
      // every 30s and is deliberately one cheap indexed read (§22). Starts at
      // null so the option stays hidden until we actually know.
      setCollectionCredit(null);
      void getCollectionCredit(o.id)
        .then(setCollectionCredit)
        .catch(() => setCollectionCredit(0));
      return;
    }
    setBusy(o.id);
    void (async () => {
      try {
        const res = await markCollected(o.id, [], {
          acknowledgeUnprepared: acked,
          acknowledgeUnverifiedCustomer: ackUnverified,
        });
        // A stale/cleared proof can happen after a long confirmation dialog.
        // Re-open the same verification instead of reducing this to a toast
        // that makes the cashier start the whole hand-over again.
        if (res.verificationRequired || res.verificationUnavailable) {
          const ack = await requestVerification(o.id, "pickup");
          if (ack !== null) continueHandOver(o, acked, ack);
          return;
        }
        if (res.error) {
          toast.error(res.error);
          refreshQueue();
          return;
        }
        settle(o.id, "Handed over.");
        // The order has left the shelf, so the panel describing it has nothing
        // left to offer. A no-op when the hand-over came from the row.
        setDetailFor(null);
      } catch {
        toast.error("Couldn't reach the server. Try the hand-over again.");
      } finally {
        setBusy(null);
      }
    })();
  };

  const handOver = (o: PickupOrder, acked = false) => {
    if (!acked && o.status !== "ready") {
      setConfirmUnprepared(o);
      return;
    }
    void requestVerification(o.id, "pickup").then((ack) => {
      if (ack !== null) continueHandOver(o, acked, ack);
    });
  };

  /**
   * Take the money and hand over, retrying once behind a verification dialog.
   *
   * ★ SEPARATE FROM `takePayment`, and not just a second parameter on it.
   * `takePayment` IS the panel's `onComplete`, whose second argument is the
   * manager `approvalToken` — a string, and truthy. A positional `ackOverride`
   * there would have the panel's own approval flow silently assert "proceed
   * without verifying the customer". (TypeScript caught it; it would not have
   * been visible in review.)
   */
  const runCollect = async (
    o: PickupOrder,
    acked: boolean,
    tenders: PosTender[],
    ackUnverified: boolean,
    // Bounded: a server that keeps refusing a proof it just accepted would
    // otherwise re-open the dialog forever.
    attempt = 0,
  ): Promise<{ error?: string }> => {
    const res = await markCollected(o.id, tenders, {
      acknowledgeUnprepared: acked,
      acknowledgeUnverifiedCustomer: ackUnverified,
    });
    if (res.verificationRequired || res.verificationUnavailable) {
      // ★ AWAITED, so the panel's `finish` is still running: its spinner stays
      // up and the retry's own result is returned to it like any other. The
      // previous shape returned `{}` here — a SUCCESS to the panel — and then
      // retried outside it, where an error had nowhere to go.
      if (attempt >= 1) return { error: res.error };
      const ack = await requestVerification(o.id, "pickup");
      if (ack === null) {
        return { error: "Verification was cancelled, so nothing was taken." };
      }
      setTendering((cur) => (cur ? { ...cur, ackUnverified: ack } : cur));
      return runCollect(o, acked, tenders, ack, attempt + 1);
    }
    if (res.error) {
      // The panel stays open — the customer is standing there and the cashier
      // needs to see why, and to retry, without re-entering the tender. But the
      // queue behind it may be the reason it failed, so re-read it rather than
      // leaving a list that disagrees with the server.
      refreshQueue();
      return { error: res.error };
    }
    setTendering(null);

    // ★★ A DEPOSIT IS NOT A HAND-OVER, and the message must not imply it is.
    // The parcel stays on the shelf until the balance is settled, so saying
    // "handed over" here would have a cashier give away goods the server
    // deliberately kept. `settle` removes the row from the queue, which is also
    // wrong for a deposit — the order is still work.
    if (res.partial) {
      toast.success(
        `₹${res.partial.paid.toLocaleString("en-IN")} taken. ₹${res.partial.remaining.toLocaleString("en-IN")} still to pay — the order stays on the shelf.`,
      );
      refreshQueue();
      // The panel stays OPEN — the order is still work — but its figures have
      // just moved, and a deposit shown as "still to collect ₹340" is the
      // Step 18 bug on a different screen. Applied optimistically from the
      // server's own answer so nothing stale is on screen for the length of a
      // round trip, THEN re-read: `remaining` is authoritative, but the
      // payments list underneath it can only come from the database.
      const taken = res.partial;
      setDetailFor((cur) =>
        cur && cur.id === o.id
          ? {
              ...cur,
              amountDue: taken.remaining,
              paidSoFar: cur.paidSoFar + taken.paid,
            }
          : cur,
      );
      setDetailReload((k) => k + 1);
      return {};
    }

    settle(
      o.id,
      res.changeDue
        ? `Handed over. Change ₹${res.changeDue.toLocaleString("en-IN")}.`
        : "Paid and handed over.",
    );
    setDetailFor(null);
    return {};
  };

  /** The tender pad's `onComplete`. Its shape must stay exactly what
   *  TenderPanel expects — see the note on `runCollect`. */
  const takePayment = async (tenders: PosTender[]) => {
    if (!tendering) return {};
    const { order: o, acked, ackUnverified } = tendering;
    return runCollect(o, acked, tenders, ackUnverified === true);
  };

  const takeOnlinePayment = async (
    amount: number,
  ): Promise<{ reference?: string; error?: string }> => {
    if (!gateway?.keyId) {
      return { error: "Razorpay isn't connected for this store." };
    }
    const amountPaise = Math.round(amount * 100);
    const started = await startPosGatewayPayment(amountPaise);
    if ("error" in started) return { error: started.error };

    return new Promise((resolve) => {
      void openRazorpayModal({
        keyId: started.keyId,
        rzpOrderId: started.rzpOrderId,
        amountPaise: started.amountPaise,
        name: gateway.storeName,
        description: `${gateway.locationName} · pickup`,
        onSuccess: (result) => {
          void confirmPosGatewayPayment({
            rzpOrderId: result.razorpay_order_id,
            paymentId: result.razorpay_payment_id,
            signature: result.razorpay_signature,
            amountPaise: started.amountPaise,
          }).then((confirmed) =>
            resolve(
              "error" in confirmed
                ? { error: confirmed.error }
                : { reference: confirmed.paymentId },
            ),
          );
        },
        onDismiss: () => resolve({ error: "Payment cancelled." }),
      }).then((opened) => {
        if (!opened) {
          resolve({
            error: "Couldn't open the payment window. Check the connection.",
          });
        }
      });
    });
  };

  const isReturns = mode === "returns";

  // No search on screen ⇒ the shelf, on the Pickups door: the queue is that
  // screen's default view because it is the work waiting to be done, not a
  // blank box. Returns has no equivalent — a return begins when a customer
  // walks in — so its idle state is the prompt below, not an empty queue.
  const rows: CounterRow[] =
    found ??
    (isReturns
      ? []
      : queue.map((order) => ({ kind: "pickup" as const, order })));

  // ★★ THE QUEUE SPLITS BY WHO IT IS WAITING ON.
  //
  // One flat list mixed two unrelated states behind a small "Ready" badge:
  // orders nobody has packed yet, and packed parcels sitting on the shelf. They
  // demand opposite things — the first is work for STAFF right now, the second
  // waits on a CUSTOMER walking in — so a shop reading the list had to sort them
  // by eye every time. Sectioned, "3 to prepare" is answerable at a glance.
  //
  // getPickupQueue only ever returns awaiting|ready, so these two are exhaustive
  // — but `others` catches anything a future status adds rather than silently
  // dropping it off a screen that is someone's work queue.
  const pickups = rows.flatMap((r) => (r.kind === "pickup" ? [r.order] : []));
  const toPrepare = pickups.filter((o) => o.status === "awaiting");
  const readyToCollect = pickups.filter((o) => o.status === "ready");
  const others = pickups.filter(
    (o) => o.status !== "awaiting" && o.status !== "ready",
  );
  const pastOrders = rows.flatMap((r) => (r.kind === "past" ? [r.order] : []));

  // ── Expiring soon (roadmap Step 18) ──────────────────────────────────────
  // ★ THE ROW ALREADY SAID "2 days left"; nothing SUMMARISED it. On a queue of
  // twenty parcels that means reading every row to find the one that matters,
  // which is the same as not knowing.
  //
  // ★ READY ONLY, deliberately. A parcel still to pack is the SHOP's work and
  // the deadline is not yet the customer's problem; chasing someone about an
  // order nobody has packed is the wrong conversation. This counts what is on
  // the shelf waiting for a person who has not come in.
  const expiringSoon = readyToCollect.filter((o) =>
    isExpiringSoon(o.expiresAt),
  );

  /** A collection waiting on this shop's shelf. Defined here rather than as a
   *  component so the two sections and the search results share ONE row — three
   *  copies of a row carrying money and a Hand over button is three places to
   *  fix the next time one of them is wrong. */
  const renderPickup = (o: PickupOrder) => {
    // ONE answer for the button and the wording — see lib/pos/collection-state.
    const state = collectionState(o.status, o.expiresAt);
    const note = collectionNote(state, o.status);
    const gone = state === "gone";
    return (
      <li
        key={`pickup:${o.id}`}
        className={`rounded-xl border p-4 ${
          // Dimmed and grey-bordered: this row is a record, not work. It renders
          // at all because the customer is standing there and the counter has to
          // be able to say what happened.
          gone
            ? "border-[var(--pos-border)] bg-[var(--pos-surface)] text-[var(--pos-ink-2)]"
            : "border-[var(--pos-border)] bg-[var(--pos-surface)]"
        }`}
      >
        {/* ★ THE INFORMATIONAL HALF OF THE ROW OPENS THE ORDER; the action
          buttons below stay outside it. Wrapping the WHOLE card would nest
          those buttons inside a button — invalid, and on a touch till it makes
          "Hand over" ambiguous with "let me look at this first". */}
        <button
          type="button"
          onClick={() => setDetailFor(o)}
          aria-label={`Open ${o.orderRef}`}
          className="group w-full rounded-lg text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pos-accent)]"
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-base font-semibold group-hover:underline">
              {o.orderRef}
            </span>
            {/* ★ BOTH BADGES ARE SEARCH-ONLY. Under a section heading they repeat
            it — "Collection" on every row of a list called Pickups, "Ready"
            under a heading that says Ready to collect — and a badge that always
            says the same thing is the kind of noise people stop reading. In
            search results there is no heading, and the list mixes collections
            with returnable past orders, so both earn their place. */}
            {searching && (
              <>
                <span className="rounded-full bg-sky-500/20 px-2 py-0.5 text-xs font-medium text-[var(--pos-info)]">
                  Collection
                </span>
                {o.status === "ready" && (
                  <span className="rounded-full bg-[var(--pos-ok-soft)] px-2 py-0.5 text-xs font-medium text-[var(--pos-ok)]">
                    Ready
                  </span>
                )}
              </>
            )}
            {/* Whether to ask for money is the first thing the cashier needs to
            know — before they open the order, not after. Silent once the order
            is gone: nothing is owed on something that will not be handed over,
            and "₹45 to pay" beside a cancelled order invites taking it. */}
            {o.amountDue > 0 && !gone && (
              <span className="rounded-full bg-[var(--pos-warn-soft)] px-2 py-0.5 text-xs font-medium text-[var(--pos-warn)]">
                {money(o.amountDue)} to pay
              </span>
            )}
            <span className="ml-auto flex items-baseline gap-1 text-base font-semibold">
              {money(o.total)}
              <ChevronRight className="h-4 w-4 self-center text-[var(--pos-ink-3)]" />
            </span>
          </div>
          <p
            className={`mt-1 text-sm ${gone ? "text-[var(--pos-ink-3)]" : "text-[var(--pos-ink-2)]"}`}
          >
            {o.customerName ?? "Customer"} · {o.itemCount} item
            {o.itemCount === 1 ? "" : "s"}
            {/* Only while the countdown is still RUNNING. Past the deadline
            expiryLabel just says "Expired", which sat immediately beside a note
            saying the order could still be handed over — two contradictory
            answers to the same question. The note is the better one, so it
            wins, and it carries the date itself on a gone order. */}
            {o.paidSoFar > 0
              ? ` · ₹${o.paidSoFar.toLocaleString("en-IN")} paid`
              : ""}
            {o.expiresAt && state === "collectable"
              ? ` · ${expiryLabel(o.expiresAt)}`
              : ""}
          </p>
        </button>

        {/* ★ THE NOTE REPLACES THE GUESS. The old failure path returned "That
          order isn't waiting for collection here. It may already have been
          collected." — a hedge, given AFTER the tap, that was wrong whenever
          the real answer was "it expired". */}
        {note && (
          <p
            className={`mt-2 rounded-lg px-3 py-2 text-sm ${
              state === "lapsed"
                ? "bg-[var(--pos-warn-soft)] text-[var(--pos-warn)]"
                : "bg-[var(--pos-surface)] text-[var(--pos-ink-2)]"
            }`}
          >
            {note}
            {gone && o.expiresAt ? ` Expired ${fmtDate(o.expiresAt)}.` : ""}
          </p>
        )}

        {/* No buttons once it is gone: markCollected's claim is scoped to
          awaiting|ready, so every control here could only ever fail — in front
          of the customer. Same rule as the discount fields and the BORIS cash
          button. */}
        {!gone && (
          <div className="mt-3 flex flex-wrap gap-2">
            {o.status === "awaiting" && canFulfilPickup && (
              <button
                type="button"
                disabled={busy === o.id}
                onClick={() => void markReady(o.id)}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-50 text-white"
              >
                <PackageCheck className="h-4 w-4" />
                Mark ready
              </button>
            )}
            {/* ★ WHICH ONE IS LOUD FOLLOWS WHICH ONE IS EXPECTED. On an
              unprepared order the next step is packing it, so hand-over drops
              to secondary while "Mark ready" takes the green. Every POS role
              holds `fulfil_pickup` now, but the check stays: a future role that
              may sell without it would otherwise be left with its one available
              action greyed into the background. */}
            <button
              type="button"
              disabled={busy === o.id}
              onClick={() => handOver(o)}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm disabled:opacity-50 ${
                o.status === "awaiting" && canFulfilPickup
                  ? "bg-[var(--pos-surface-2)] font-medium hover:bg-[var(--pos-surface-3)]"
                  : "bg-emerald-600 font-semibold text-white hover:bg-emerald-500"
              }`}
            >
              {busy === o.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : o.amountDue > 0 ? (
                <Wallet className="h-4 w-4" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              {o.amountDue > 0 ? "Take payment" : "Hand over"}
            </button>
          </div>
        )}
      </li>
    );
  };

  /** A past order a customer has brought back — a doorway to the return screen,
   *  nothing more. */
  const renderPastOrder = (o: FoundOrder) => (
    <li
      key={`past:${o.orderId}`}
      className="rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] p-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-base font-semibold">{o.label}</span>
        {/* Said up front, so the cashier knows before they open it that this
            one depends on the shop's BORIS settings. */}
        {o.broughtIn && (
          <span className="rounded-full bg-[var(--pos-surface-2)] px-2 py-0.5 text-xs font-medium text-[var(--pos-ink-2)]">
            Bought elsewhere
          </span>
        )}
        <span className="ml-auto text-base font-semibold tabular-nums">
          {money(o.total)}
        </span>
      </div>
      <p className="mt-1 text-sm text-[var(--pos-ink-2)]">
        {fmtDate(o.createdAt)}
        {o.paymentMethod === "razorpay"
          ? " · paid online"
          : o.paymentMethod === "cash_on_delivery"
            ? " · cash on delivery"
            : ""}
      </p>
      <div className="mt-3">
        <Link
          href={`/pos/returns/${o.orderId}`}
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--pos-surface-2)] px-4 py-2.5 text-sm font-medium hover:bg-[var(--pos-surface-3)]"
        >
          <RotateCcw className="h-4 w-4" />
          Take return
        </Link>
      </div>
    </li>
  );

  return (
    <PosScreen
      title={isReturns ? "Returns" : "Pickups"}
      subtitle={
        isReturns
          ? "Find the order the customer is bringing back"
          : // The breakdown, not just a total — the two halves are what a shop
            // actually plans around.
            toPrepare.length > 0
            ? `${toPrepare.length} to prepare · ${readyToCollect.length} ready`
            : readyToCollect.length > 0
              ? `${readyToCollect.length} ready to collect`
              : "Collections and returns"
      }
      width="wide"
    >
      <form
        className="relative mb-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed.length >= 4) runSearch(trimmed);
        }}
      >
        <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-[var(--pos-ink-3)]" />
        <input
          ref={boxRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // Says every kind of thing it takes, because the whole point of the
          // merge is that the cashier no longer has to know which kind of visit
          // this is before they can look it up. The Returns door leads with the
          // order number — the customer holding a parcel usually has one, and
          // rarely a collection code — but the box behaves identically, so a
          // scanned code still resolves here.
          placeholder={
            isReturns
              ? "Order number, phone or email — or scan a code…"
              : "Scan a collection code, or type an order number, phone or email…"
          }
          className="w-full rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] py-3.5 pl-11 pr-11 text-base outline-none focus:border-[var(--pos-border-strong)]"
        />
        {pending && (
          <Loader2 className="absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 animate-spin text-[var(--pos-ink-3)]" />
        )}
      </form>

      {error && (
        <p className="mb-4 rounded-xl border border-[var(--pos-danger-border)] bg-[var(--pos-danger-soft)] px-4 py-3 text-sm text-[var(--pos-danger)]">
          {error}
        </p>
      )}

      {tooShort && (
        <p className="mb-3 text-sm text-[var(--pos-ink-2)]">
          Type a bit more — at least 4 characters.
        </p>
      )}

      {!error && rows.length === 0 && !pending && (
        <div className="rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] px-4 py-10 text-center">
          {searching && searched ? (
            <p className="text-sm text-[var(--pos-ink-2)]">
              Nothing found for “{trimmed}”. Check the number, or try their
              phone.
            </p>
          ) : isReturns ? (
            // Not an empty state — an instruction. There is nothing missing
            // here; the screen is waiting to be given a number, and saying
            // "nothing found" before anyone has searched reads like a fault.
            <>
              <p className="text-sm text-[var(--pos-ink-2)]">
                Search for the order the customer is bringing back.
              </p>
              <p className="mt-1 text-sm text-[var(--pos-ink-3)]">
                Their order number, the phone or email they ordered with, or a
                scanned collection code.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-[var(--pos-ink-2)]">
                Nothing waiting to be collected.
              </p>
              <p className="mt-1 text-sm text-[var(--pos-ink-3)]">
                {canRefund
                  ? "Search above to find a past order for a return."
                  : "Scan a collection code to find an order."}
              </p>
            </>
          )}
        </div>
      )}

      {/* ★ SEARCHING IS ONE FLAT LIST, THE QUEUE IS SECTIONED. When you are
          hunting for one specific order, splitting the two or three hits across
          headed sections makes you read all of them to find it. The queue is the
          opposite: nobody is looking for a particular row, they are asking "what
          do I have to do?" */}
      {searching ? (
        <Section
          title="Search results"
          count={rows.length}
          show={rows.length > 0}
        >
          {rows.map((row) =>
            row.kind === "pickup"
              ? renderPickup(row.order)
              : renderPastOrder(row.order),
          )}
        </Section>
      ) : (
        <>
          {/* ★★ BOTH SEGMENTS ALWAYS RENDER, even at zero. They used to hide
              when empty, so a queue holding only packed parcels showed ONE faint
              heading and read as a flat list again — the division existed in the
              data and disappeared from the screen exactly when there was least
              to compare it against. As permanent structure, "nothing to pack" is
              itself the answer to the question the shop is asking. (Rendering a
              zero here is not the badge rule in reverse: a heading is furniture
              you read past, a badge is a number that demands action.) */}
          <Section
            title="To prepare"
            count={toPrepare.length}
            tone="work"
            hint="Yours to pack. Mark one ready and the customer is told to come in."
            empty="Nothing waiting to be packed."
          >
            {toPrepare.map(renderPickup)}
          </Section>
          {/* ★ ABOVE the section, not inside it: it is a call to act on a
              handful of rows, and inside a list of twenty it would be one more
              thing to scroll past. Hidden at zero — unlike the section
              headings, which are permanent structure. A banner that is always
              there is a banner nobody reads. */}
          {expiringSoon.length > 0 && (
            <div className="mb-2 flex items-center gap-2 rounded-xl border border-[var(--pos-warn-border)] bg-[var(--pos-warn-soft)] px-3 py-2 text-sm text-[var(--pos-warn)]">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                <strong className="font-semibold">{expiringSoon.length}</strong>{" "}
                {expiringSoon.length === 1 ? "collection" : "collections"} on
                the shelf expiring within {PICKUP_WARN_HOURS} hours. Ring the
                customer, or they lapse and the stock goes back.
              </span>
            </div>
          )}
          <Section
            title="Ready to collect"
            count={readyToCollect.length}
            tone="waiting"
            hint="On the shelf, waiting for the customer to walk in."
            empty="Nothing on the shelf."
          >
            {readyToCollect.map(renderPickup)}
          </Section>
          {/* Only ever non-empty if a new pickup_status appears. Better a
              labelled section than a row that silently vanishes from a work
              queue. */}
          <Section title="Other" count={others.length} show={others.length > 0}>
            {others.map(renderPickup)}
          </Section>
          <Section
            title="Returns"
            count={pastOrders.length}
            show={pastOrders.length > 0}
          >
            {pastOrders.map(renderPastOrder)}
          </Section>
        </>
      )}

      {/* ★ BELOW THE PAD (z-40 vs z-50): "Take payment" here opens the same
        tender pad over the same order, and completing it closes both. */}
      {detailFor && (
        <CollectionDetail
          key={detailFor.id}
          order={detailFor}
          reloadKey={detailReload}
          canFulfilPickup={canFulfilPickup}
          busy={busy === detailFor.id}
          onClose={() => setDetailFor(null)}
          onMarkReady={() => {
            // Stays open on success, unlike a hand-over: the customer is often
            // standing there, and the next tap is immediately "Hand over".
            // markReady also moves the row behind into Ready to collect.
            void markReady(detailFor.id);
          }}
          onHandOver={(current) => handOver(current)}
        />
      )}

      {tendering && (
        <TenderPanel
          total={tendering.order.amountDue}
          title={`Collect ${tendering.order.orderRef}`}
          confirmLabel="Take payment & hand over"
          onCancel={() => setTendering(null)}
          onComplete={takePayment}
          // Null until the balance lands, which is what keeps the option off
          // the pad rather than flashing a ₹0 one. markCollected re-reads and
          // spends it atomically, so a stale figure costs a refusal, never an
          // overdraw.
          storeCredit={collectionCredit}
          onTakeOnline={gateway ? takeOnlinePayment : undefined}
        />
      )}

      {verification && (
        <CustomerPhoneVerification
          orderId={verification.orderId}
          purpose={verification.purpose}
          onCancel={() => settleVerification(null)}
          onVerified={() => settleVerification(false)}
          onOverride={() => settleVerification(true)}
        />
      )}

      {/* ★ A QUESTION, NOT A WARNING. The shop may well be packing this while
        the customer waits, so the cashier is asked the one thing only they can
        answer — is the box actually in your hands — rather than being told off.
        It exists so that closing an unprepared order is never what a mis-tap
        does. */}
      {confirmUnprepared && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-[var(--pos-surface)] p-5 ring-1 ring-[var(--pos-border)]">
            <h2 className="text-lg font-semibold">Not marked ready yet</h2>
            <p className="mt-2 text-sm text-[var(--pos-ink-2)]">
              Nobody has checked {confirmUnprepared.orderRef} off as packed. Do
              you have the goods to hand over now?
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmUnprepared(null)}
                className="flex-1 rounded-lg bg-[var(--pos-surface-2)] px-4 py-2.5 text-sm font-medium hover:bg-[var(--pos-surface-3)]"
              >
                Not yet
              </button>
              <button
                type="button"
                onClick={() => {
                  const o = confirmUnprepared;
                  setConfirmUnprepared(null);
                  handOver(o, true);
                }}
                className="flex-1 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold hover:bg-emerald-500 text-white"
              >
                Yes, hand over
              </button>
            </div>
          </div>
        </div>
      )}
    </PosScreen>
  );
}

/**
 * Did the queue actually change?
 *
 * ★ IT DECIDES TWO THINGS. It keeps the previous array IDENTITY when nothing
 * moved, so a poll every thirty seconds does not re-render the list (and reset
 * anything keyed off it) for no reason — and it tells `usePoll` whether to back
 * off, which is what stops a quiet shop paying a busy shop\'s request rate.
 *
 * Id + status is enough: those are the only fields a row\'s CONTROLS depend on.
 * Money and expiry are rendered but do not change without one of them changing
 * too, and comparing every field would make this a deep-equality helper nobody
 * can reason about.
 */
function sameQueue(a: PickupOrder[], b: PickupOrder[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((o, i) => o.id === b[i].id && o.status === b[i].status);
}

function rowId(row: CounterRow): string {
  return row.kind === "pickup" ? row.order.id : row.order.orderId;
}

/** A headed group of rows, with its count in the heading.
 *
 *  `show` rather than letting the caller conditionally render: an empty section
 *  must draw NOTHING — not a heading over blank space — and putting that rule
 *  here means each of the four call sites cannot forget it. The count is in the
 *  heading because "To prepare 3" is the whole answer a shop opens this for. */
/**
 * ★ THE TWO SEGMENTS ARE COLOURED BY WHO IS BEING WAITED ON, not by severity.
 * Amber = the SHOP owes something; emerald = the shop has done its part and the
 * CUSTOMER is the one outstanding. That is the whole distinction the split
 * exists to make, so it reads before the words do. Neutral is for the
 * exceptional sections (Other, Returns, Search) which are not part of the pair
 * and should not compete with it.
 */
const TONES = {
  work: {
    bar: "bg-amber-400",
    title: "text-[var(--pos-warn)]",
    pill: "bg-[var(--pos-warn-soft)] text-[var(--pos-warn)]",
  },
  waiting: {
    bar: "bg-emerald-400",
    title: "text-[var(--pos-ok)]",
    pill: "bg-[var(--pos-ok-soft)] text-[var(--pos-ok)]",
  },
  neutral: {
    bar: "bg-[var(--pos-surface-3)]",
    title: "text-[var(--pos-ink-3)]",
    pill: "bg-[var(--pos-surface-2)] text-[var(--pos-ink-2)]",
  },
} as const;

function Section({
  title,
  count,
  show = true,
  tone = "neutral",
  hint,
  empty,
  children,
}: {
  title: string;
  count: number;
  /** Omit for the two pickup segments: they are permanent structure. */
  show?: boolean;
  tone?: keyof typeof TONES;
  hint?: string;
  /** What to say when the section is empty. Required for a section that renders
   *  at zero, or it would be a heading over nothing. */
  empty?: string;
  children: React.ReactNode;
}) {
  if (!show) return null;
  const t = TONES[tone];
  return (
    <section className="mb-7 last:mb-0">
      <div className="mb-2 flex items-center gap-2.5">
        {/* A short coloured rule, not a full divider: it ties the heading to the
            rows under it without drawing a line across a screen that already has
            plenty. */}
        <span className={`h-4 w-1 shrink-0 rounded-full ${t.bar}`} />
        <h2
          className={`flex items-center gap-2 text-sm font-semibold tracking-wide ${t.title}`}
        >
          {title}
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${t.pill}`}
          >
            {count}
          </span>
        </h2>
      </div>
      {hint && count > 0 && (
        <p className="mb-2 pl-3.5 text-xs text-[var(--pos-ink-3)]">{hint}</p>
      )}
      {count === 0 && empty ? (
        <p className="pl-3.5 text-sm text-[var(--pos-ink-3)]">{empty}</p>
      ) : (
        <ul className="space-y-3 pl-3.5">{children}</ul>
      )}
    </section>
  );
}
