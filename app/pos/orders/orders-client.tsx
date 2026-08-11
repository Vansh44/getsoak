"use client";

// The counter screen: a customer is standing here with an order that already
// exists. Collections and returns, one screen, one box.
//
// ★ WHY THEY MERGED. They were two search screens for the same physical moment.
// /pos/pickups searched a collection code or an order number; /pos/returns
// searched an order number, a phone or an email — and neither could find what
// the other could. So a cashier had to know which kind of visit this was BEFORE
// they knew which order it was, and pick a screen accordingly. The customer
// holding the phone does not present that way: they hand over a number and the
// till should work out what can be done with it.
//
// It is the rule /pos/pickups already had — ONE BOX TAKES BOTH a scanned code
// and a typed order number — carried one step further, to the order itself.
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
import { TenderPanel } from "../sell/tender-panel";
import { PosScreen } from "../pos-screen";

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

export function OrdersClient({
  initial,
  error,
  canRefund,
  canFulfilPickup,
}: {
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
  const [tendering, setTendering] = useState<PickupOrder | null>(null);
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

  /** Nothing owed hands over straight away; money due opens the tender pad. */
  const handOver = (o: PickupOrder) => {
    if (o.amountDue > 0) {
      setTendering(o);
      return;
    }
    void act(o.id, markCollected, "Handed over.");
  };

  const takePayment = async (tenders: PosTender[]) => {
    const o = tendering;
    if (!o) return {};
    const res = await markCollected(o.id, tenders);
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

  // No search on screen ⇒ the shelf. The queue is the till's default view
  // because it is the work waiting to be done, not a blank box.
  const rows: CounterRow[] =
    found ?? queue.map((order) => ({ kind: "pickup" as const, order }));

  const waiting = queue.length;

  return (
    <PosScreen
      title="Orders"
      subtitle={
        waiting > 0
          ? `${waiting} waiting to collect`
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
          // this is before they can look it up.
          placeholder="Scan a collection code, or type an order number, phone or email…"
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

      {/* Says which list is on screen. Without it, a search returning one
          collection looks identical to a queue with one thing in it. */}
      {!error && rows.length > 0 && (
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/35">
          {searching ? "Search results" : "Waiting to collect"}
        </h2>
      )}

      {!error && rows.length === 0 && !pending && (
        <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-10 text-center">
          {searching && searched ? (
            <p className="text-sm text-white/60">
              Nothing found for “{trimmed}”. Check the number, or try their
              phone.
            </p>
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

      <ul className="space-y-3">
        {rows.map((row) =>
          row.kind === "pickup" ? (
            <li
              key={`pickup:${row.order.id}`}
              className="rounded-xl border border-white/10 bg-white/5 p-4"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-base font-semibold">
                  {row.order.orderRef}
                </span>
                <span className="rounded-full bg-sky-500/20 px-2 py-0.5 text-xs font-medium text-sky-300">
                  Collection
                </span>
                {row.order.status === "ready" && (
                  <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-300">
                    Ready
                  </span>
                )}
                {/* Whether to ask for money is the first thing the cashier
                    needs to know — before they open the order, not after. */}
                {row.order.amountDue > 0 && (
                  <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300">
                    {money(row.order.amountDue)} to pay
                  </span>
                )}
                <span className="ml-auto text-base font-semibold">
                  {money(row.order.total)}
                </span>
              </div>
              <p className="mt-1 text-sm text-white/60">
                {row.order.customerName ?? "Customer"} · {row.order.itemCount}{" "}
                item{row.order.itemCount === 1 ? "" : "s"}
                {row.order.expiresAt
                  ? ` · ${expiryLabel(row.order.expiresAt)}`
                  : ""}
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                {row.order.status === "awaiting" && canFulfilPickup && (
                  <button
                    type="button"
                    disabled={busy === row.order.id}
                    onClick={() =>
                      act(row.order.id, markReadyForPickup, "Marked ready.")
                    }
                    className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2.5 text-sm font-medium hover:bg-white/20 disabled:opacity-50"
                  >
                    <PackageCheck className="h-4 w-4" />
                    Mark ready
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy === row.order.id}
                  onClick={() => handOver(row.order)}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-50"
                >
                  {busy === row.order.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : row.order.amountDue > 0 ? (
                    <Wallet className="h-4 w-4" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                  {row.order.amountDue > 0 ? "Take payment" : "Hand over"}
                </button>
              </div>
            </li>
          ) : (
            <li
              key={`past:${row.order.orderId}`}
              className="rounded-xl border border-white/10 bg-white/5 p-4"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-base font-semibold">
                  {row.order.label}
                </span>
                {/* Said up front, so the cashier knows before they open it that
                    this one depends on the shop's BORIS settings. */}
                {row.order.broughtIn && (
                  <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-medium text-white/70">
                    Bought elsewhere
                  </span>
                )}
                <span className="ml-auto text-base font-semibold tabular-nums">
                  {money(row.order.total)}
                </span>
              </div>
              <p className="mt-1 text-sm text-white/60">
                {fmtDate(row.order.createdAt)}
                {row.order.paymentMethod === "razorpay"
                  ? " · paid online"
                  : row.order.paymentMethod === "cash_on_delivery"
                    ? " · cash on delivery"
                    : ""}
              </p>
              <div className="mt-3">
                <Link
                  href={`/pos/returns/${row.order.orderId}`}
                  className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2.5 text-sm font-medium hover:bg-white/20"
                >
                  <RotateCcw className="h-4 w-4" />
                  Take return
                </Link>
              </div>
            </li>
          ),
        )}
      </ul>

      {tendering && (
        <TenderPanel
          total={tendering.amountDue}
          title={`Collect ${tendering.orderRef}`}
          confirmLabel="Take payment & hand over"
          onCancel={() => setTendering(null)}
          onComplete={takePayment}
        />
      )}
    </PosScreen>
  );
}

function rowId(row: CounterRow): string {
  return row.kind === "pickup" ? row.order.id : row.order.orderId;
}
