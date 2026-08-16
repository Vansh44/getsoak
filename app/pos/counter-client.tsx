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
// halves matter. "Mark ready" is `fulfil_pickup` (manager and above: it is the
// step that tells a customer to travel), handing over is `sell`, taking a
// return is `refund` — every one of them re-checked in the action. Hiding what
// would be refused is not the security boundary, it is not making someone fail
// in front of a customer.

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  Check,
  Loader2,
  PackageCheck,
  RotateCcw,
  Search,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { isCollectionCode } from "@/lib/fulfilment/collection-code";
import { collectionNote, collectionState } from "@/lib/pos/collection-state";
import {
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
import type { PosTender } from "@/app/actions/pos-sale-actions";
import { TenderPanel } from "./sell/tender-panel";
import { PosScreen } from "./pos-screen";
import { POS_POLL_MS, usePoll } from "./use-poll";

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
}: {
  mode: CounterMode;
  initial: PickupOrder[];
  error: string | null;
  /** Taking a return is a manager capability — a cashier hands collections
   *  over and reprints, but does not give money back. */
  canRefund: boolean;
  /** Marking a box packed and ready. Manager and above. */
  canFulfilPickup: boolean;
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
  } | null>(null);
  const [confirmUnprepared, setConfirmUnprepared] =
    useState<PickupOrder | null>(null);
  const [pending, start] = useTransition();
  const boxRef = useRef<HTMLInputElement>(null);

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
    !busy && !tendering && !confirmUnprepared && !searching && !pending;
  usePoll(
    useCallback(() => {
      void getPickupQueue().then((res) => {
        if (!res.error) setQueue(res.orders);
      });
    }, []),
    POS_POLL_MS,
    idle,
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

  // Debounced so a scanner burst or a fast typist doesn't fire per keystroke.
  // Nothing is set synchronously here — below the floor there is simply no
  // search to schedule, and what shows is derived above.
  useEffect(() => {
    if (trimmed.length < 4) return;
    const handle = setTimeout(() => runSearch(trimmed), 300);
    return () => clearTimeout(handle);
  }, [trimmed, runSearch]);

  /** After acting on an order, drop it from wherever it was shown. It is no
   *  longer waiting, and leaving it there invites a second tap on a thing that
   *  has already happened. */
  const settle = (id: string, message: string) => {
    toast.success(message);
    setQueue((cur) => cur.filter((o) => o.id !== id));
    setResults((cur) => (cur ? cur.filter((r) => rowId(r) !== id) : cur));
  };

  const act = async (
    id: string,
    fn: (id: string) => Promise<{ success?: boolean; error?: string }>,
    message: string,
  ) => {
    setBusy(id);
    const res = await fn(id);
    setBusy(null);
    if (res.error) {
      toast.error(res.error);
      // Refused means the list is stale — someone else got there first.
      refreshQueue();
      return;
    }
    settle(id, message);
  };

  /**
   * Nothing owed hands over straight away; money due opens the tender pad.
   *
   * An order nobody marked ready is confirmed first (`handoverGate`): the shop
   * may genuinely be packing it while the customer waits, so this is a question,
   * not a refusal — but it must never be the thing a mis-tap does.
   */
  const handOver = (o: PickupOrder, acked = false) => {
    if (!acked && o.status !== "ready") {
      setConfirmUnprepared(o);
      return;
    }
    if (o.amountDue > 0) {
      setTendering({ order: o, acked });
      return;
    }
    void act(
      o.id,
      (id) => markCollected(id, [], { acknowledgeUnprepared: acked }),
      "Handed over.",
    );
  };

  const takePayment = async (tenders: PosTender[]) => {
    if (!tendering) return {};
    const { order: o, acked } = tendering;
    const res = await markCollected(o.id, tenders, {
      acknowledgeUnprepared: acked,
    });
    if (res.error) {
      // The panel stays open — the customer is standing there and the cashier
      // needs to see why, and to retry, without re-entering the tender. But the
      // queue behind it may be the reason it failed, so re-read it rather than
      // leaving a list that disagrees with the server.
      refreshQueue();
      return { error: res.error };
    }
    setTendering(null);
    settle(
      o.id,
      res.changeDue
        ? `Handed over. Change ₹${res.changeDue.toLocaleString("en-IN")}.`
        : "Paid and handed over.",
    );
    return {};
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
            ? "border-white/5 bg-white/[0.02] text-white/50"
            : "border-white/10 bg-white/5"
        }`}
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-base font-semibold">
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
              <span className="rounded-full bg-sky-500/20 px-2 py-0.5 text-xs font-medium text-sky-300">
                Collection
              </span>
              {o.status === "ready" && (
                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-300">
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
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300">
              {money(o.amountDue)} to pay
            </span>
          )}
          <span className="ml-auto text-base font-semibold">
            {money(o.total)}
          </span>
        </div>
        <p
          className={`mt-1 text-sm ${gone ? "text-white/40" : "text-white/60"}`}
        >
          {o.customerName ?? "Customer"} · {o.itemCount} item
          {o.itemCount === 1 ? "" : "s"}
          {/* Only while the countdown is still RUNNING. Past the deadline
            expiryLabel just says "Expired", which sat immediately beside a note
            saying the order could still be handed over — two contradictory
            answers to the same question. The note is the better one, so it
            wins, and it carries the date itself on a gone order. */}
          {o.expiresAt && state === "collectable"
            ? ` · ${expiryLabel(o.expiresAt)}`
            : ""}
        </p>

        {/* ★ THE NOTE REPLACES THE GUESS. The old failure path returned "That
          order isn't waiting for collection here. It may already have been
          collected." — a hedge, given AFTER the tap, that was wrong whenever
          the real answer was "it expired". */}
        {note && (
          <p
            className={`mt-2 rounded-lg px-3 py-2 text-sm ${
              state === "lapsed"
                ? "bg-amber-500/10 text-amber-200"
                : "bg-white/5 text-white/55"
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
                onClick={() => act(o.id, markReadyForPickup, "Marked ready.")}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-50"
              >
                <PackageCheck className="h-4 w-4" />
                Mark ready
              </button>
            )}
            {/* ★ WHICH ONE IS LOUD FOLLOWS WHICH ONE IS EXPECTED. On an
              unprepared order the next step is packing it, so hand-over drops
              to secondary while "Mark ready" takes the green — for a cashier
              with no `fulfil_pickup` there is no other button, so it stays
              primary and their one action is not greyed into the background. */}
            <button
              type="button"
              disabled={busy === o.id}
              onClick={() => handOver(o)}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm disabled:opacity-50 ${
                o.status === "awaiting" && canFulfilPickup
                  ? "bg-white/10 font-medium hover:bg-white/20"
                  : "bg-emerald-600 font-semibold hover:bg-emerald-500"
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
      className="rounded-xl border border-white/10 bg-white/5 p-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-base font-semibold">{o.label}</span>
        {/* Said up front, so the cashier knows before they open it that this
            one depends on the shop's BORIS settings. */}
        {o.broughtIn && (
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-medium text-white/70">
            Bought elsewhere
          </span>
        )}
        <span className="ml-auto text-base font-semibold tabular-nums">
          {money(o.total)}
        </span>
      </div>
      <p className="mt-1 text-sm text-white/60">
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
          className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2.5 text-sm font-medium hover:bg-white/20"
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
        <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-white/40" />
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
          className="w-full rounded-xl border border-white/10 bg-white/5 py-3.5 pl-11 pr-11 text-base outline-none focus:border-white/30"
        />
        {pending && (
          <Loader2 className="absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 animate-spin text-white/40" />
        )}
      </form>

      {error && (
        <p className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </p>
      )}

      {tooShort && (
        <p className="mb-3 text-sm text-white/50">
          Type a bit more — at least 4 characters.
        </p>
      )}

      {!error && rows.length === 0 && !pending && (
        <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-10 text-center">
          {searching && searched ? (
            <p className="text-sm text-white/60">
              Nothing found for “{trimmed}”. Check the number, or try their
              phone.
            </p>
          ) : isReturns ? (
            // Not an empty state — an instruction. There is nothing missing
            // here; the screen is waiting to be given a number, and saying
            // "nothing found" before anyone has searched reads like a fault.
            <>
              <p className="text-sm text-white/60">
                Search for the order the customer is bringing back.
              </p>
              <p className="mt-1 text-sm text-white/40">
                Their order number, the phone or email they ordered with, or a
                scanned collection code.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-white/60">
                Nothing waiting to be collected.
              </p>
              <p className="mt-1 text-sm text-white/40">
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
          <Section
            title="To prepare"
            count={toPrepare.length}
            show={toPrepare.length > 0}
            hint="Packed and ready? Mark it, and the customer is told to come in."
          >
            {toPrepare.map(renderPickup)}
          </Section>
          <Section
            title="Ready to collect"
            count={readyToCollect.length}
            show={readyToCollect.length > 0}
            hint="On the shelf, waiting for the customer."
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

      {tendering && (
        <TenderPanel
          total={tendering.order.amountDue}
          title={`Collect ${tendering.order.orderRef}`}
          confirmLabel="Take payment & hand over"
          onCancel={() => setTendering(null)}
          onComplete={takePayment}
        />
      )}

      {/* ★ A QUESTION, NOT A WARNING. The shop may well be packing this while
        the customer waits, so the cashier is asked the one thing only they can
        answer — is the box actually in your hands — rather than being told off.
        It exists so that closing an unprepared order is never what a mis-tap
        does. */}
      {confirmUnprepared && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-neutral-900 p-5 ring-1 ring-white/10">
            <h2 className="text-lg font-semibold">Not marked ready yet</h2>
            <p className="mt-2 text-sm text-white/65">
              Nobody has checked {confirmUnprepared.orderRef} off as packed. Do
              you have the goods to hand over now?
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmUnprepared(null)}
                className="flex-1 rounded-lg bg-white/10 px-4 py-2.5 text-sm font-medium hover:bg-white/20"
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
                className="flex-1 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold hover:bg-emerald-500"
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

function rowId(row: CounterRow): string {
  return row.kind === "pickup" ? row.order.id : row.order.orderId;
}

/** A headed group of rows, with its count in the heading.
 *
 *  `show` rather than letting the caller conditionally render: an empty section
 *  must draw NOTHING — not a heading over blank space — and putting that rule
 *  here means each of the four call sites cannot forget it. The count is in the
 *  heading because "To prepare 3" is the whole answer a shop opens this for. */
function Section({
  title,
  count,
  show,
  hint,
  children,
}: {
  title: string;
  count: number;
  show: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  if (!show) return null;
  return (
    <section className="mb-6 last:mb-0">
      <h2 className="mb-1 flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-white/35">
        {title}
        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] tabular-nums text-white/60">
          {count}
        </span>
      </h2>
      {hint && <p className="mb-2 text-xs text-white/30">{hint}</p>}
      <ul className="space-y-3">{children}</ul>
    </section>
  );
}
