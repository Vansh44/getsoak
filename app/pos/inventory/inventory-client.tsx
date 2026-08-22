"use client";

// POS Phase 4 — stock from the shop floor.
//
// Built for someone holding a shelf, not sitting at a desk: search or scan to
// find the SKU, then one of three actions on the row itself. The dashboard's
// inventory page is the desk view; this one answers "how many are actually
// here, and let me fix it".

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  Loader2,
  Minus,
  Package,
  Plus,
  Search,
  Send,
  TriangleAlert,
} from "lucide-react";
import { PosScreen } from "../pos-screen";
import { usePoll } from "@/lib/pos/use-poll";
import { fetchStock } from "@/lib/pos/live";
import {
  adjustPosStock,
  countPosStock,
  transferPosStock,
  type PosInventoryItem,
  type PosTransferTarget,
} from "@/app/actions/pos-inventory-actions";
import { getPosInventory } from "@/app/actions/pos-inventory-actions";

type Mode = "receive" | "count" | "transfer";

const MODE_META: Record<Mode, { label: string; verb: string }> = {
  receive: { label: "Receive / correct", verb: "Apply" },
  count: { label: "Count", verb: "Save count" },
  transfer: { label: "Send to…", verb: "Send" },
};

export function InventoryClient({
  initial,
  targets,
  locationName,
}: {
  initial: PosInventoryItem[];
  targets: PosTransferTarget[];
  locationName: string;
}) {
  const [items, setItems] = useState(initial);
  const [query, setQuery] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (q: string, low: boolean) => {
    setLoading(true);
    const res = await getPosInventory({ query: q, lowOnly: low });
    setLoading(false);
    if (res.error) setError(res.error);
    else setItems(res.items);
  }, []);

  // Skip the first run: the server already rendered `initial`, and refetching
  // on mount is a wasted round-trip plus a visible flash of re-sorted rows.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const t = setTimeout(() => void refresh(query.trim(), lowOnly), 250);
    return () => clearTimeout(t);
  }, [query, lowOnly, refresh]);

  // ── Stock, kept live ──────────────────────────────────────────────────────
  // Numbers here move for reasons that have nothing to do with this screen: a
  // sale on the till next to you, a transfer in, a correction someone made on
  // the dashboard. Without this the list was a snapshot from whenever the page
  // last loaded — and stock is the one figure people act on assuming it is now.
  //
  // ★ QUIET, AND SUSPENDED WHILE SOMETHING IS OPEN. It skips `setLoading` so
  // the spinner never blinks unasked, drops errors (the next real action still
  // reports them), and holds off entirely while an adjustment sheet is open —
  // re-sorting rows under a half-filled form is how someone counts one product
  // and submits against another.
  const adjusting = openKey !== null;
  usePoll(
    useCallback(
      async (run) => {
        const res = await fetchStock(query.trim(), lowOnly, run.signal);
        if (!res || res.error || !run.isCurrent()) return undefined;
        let moved = false;
        setItems((cur) => {
          if (!run.isCurrent()) return cur;
          moved = !sameStock(cur, res.items);
          return moved ? res.items : cur;
        });
        return moved;
      },
      [query, lowOnly],
    ),
    { enabled: !adjusting, backOff: true },
  );

  const done = (msg: string) => {
    setNotice(msg);
    setOpenKey(null);
    setError(null);
    void refresh(query.trim(), lowOnly);
    setTimeout(() => setNotice(null), 3000);
  };

  return (
    // Chrome from PosScreen — the "Back to register" button is gone with it:
    // the rail goes to the register, or anywhere else, in the same one tap.
    <PosScreen title="Stock" subtitle={locationName} width="narrow">
      <div className="mb-3 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--pos-ink-3)]" />
          <input
            ref={searchRef}
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Scan or search…"
            className="w-full rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] py-2.5 pl-9 pr-3 text-sm outline-none placeholder:text-[var(--pos-ink-3)] focus:border-[var(--pos-border-strong)]"
          />
          {loading && (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[var(--pos-ink-3)]" />
          )}
        </div>
        <button
          type="button"
          onClick={() => setLowOnly((v) => !v)}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm font-medium transition-colors ${
            lowOnly
              ? "bg-amber-500 text-black"
              : "bg-[var(--pos-surface-2)] hover:bg-[var(--pos-surface-3)]"
          }`}
        >
          <TriangleAlert className="h-4 w-4" strokeWidth={2} />
          Low
        </button>
      </div>

      {notice && (
        <p className="mb-3 rounded-lg bg-[var(--pos-ok-soft)] px-3 py-2 text-sm text-[var(--pos-ok)]">
          {notice}
        </p>
      )}
      {error && (
        <p className="mb-3 rounded-lg bg-[var(--pos-danger-soft)] px-3 py-2 text-sm text-[var(--pos-danger)]">
          {error}
        </p>
      )}

      <div className="space-y-2">
        {items.map((it) => {
          const key = `${it.productId}:${it.variantId ?? ""}`;
          return (
            <Row
              key={key}
              item={it}
              targets={targets}
              open={openKey === key}
              onToggle={() => {
                setOpenKey(openKey === key ? null : key);
                setError(null);
              }}
              onError={setError}
              onDone={done}
            />
          );
        })}
        {items.length === 0 && !loading && (
          <p className="py-10 text-center text-sm text-[var(--pos-ink-3)]">
            {lowOnly ? "Nothing is running low." : "No products match."}
          </p>
        )}
      </div>
    </PosScreen>
  );
}

/**
 * Did any stock number move?
 *
 * Keeps the previous array identity when nothing changed, so a poll does not
 * re-render (and re-sort) a list nobody is looking away from — and tells
 * `usePoll` to back off, which is what stops a shelf nobody is touching costing
 * the same as one being counted.
 */
function sameStock(a: PosInventoryItem[], b: PosInventoryItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (it, i) =>
      it.productId === b[i].productId &&
      it.variantId === b[i].variantId &&
      it.onHand === b[i].onHand,
  );
}

function Row({
  item,
  targets,
  open,
  onToggle,
  onError,
  onDone,
}: {
  item: PosInventoryItem;
  targets: PosTransferTarget[];
  open: boolean;
  onToggle: () => void;
  onError: (msg: string) => void;
  onDone: (msg: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("receive");
  const [value, setValue] = useState("");
  const [target, setTarget] = useState(targets[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();

  const label = item.variantName
    ? `${item.name} · ${item.variantName}`
    : item.name;
  const n = Number(value);
  const valid = Number.isInteger(n) && (mode === "count" ? n >= 0 : n > 0);

  const submit = () =>
    start(async () => {
      const res =
        mode === "count"
          ? await countPosStock(item.productId, item.variantId, n, note)
          : mode === "receive"
            ? await adjustPosStock(
                item.productId,
                item.variantId,
                n,
                "received",
                note,
              )
            : await transferPosStock(
                item.productId,
                item.variantId,
                n,
                target,
                note,
              );
      if (res.error) {
        onError(res.error);
        return;
      }
      setValue("");
      setNote("");
      onDone(
        mode === "transfer"
          ? `Sent ${n} × ${label}`
          : `${label} is now ${"newStock" in res ? res.newStock : n}`,
      );
    });

  // Quick −1 / +1 for the common case: one broken jar, one found tin.
  const quick = (delta: number) =>
    start(async () => {
      const res = await adjustPosStock(
        item.productId,
        item.variantId,
        delta,
        "adjustment",
      );
      if (res.error) onError(res.error);
      else onDone(`${label} is now ${res.newStock}`);
    });

  return (
    <div className="rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)]">
      <div className="flex items-center gap-3 p-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--pos-surface)]">
          {item.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.image}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <Package
              className="h-4 w-4 text-[var(--pos-ink-3)]"
              strokeWidth={1.5}
            />
          )}
        </span>
        <button
          type="button"
          onClick={onToggle}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-sm font-medium">{label}</span>
          <span className="block truncate text-xs text-[var(--pos-ink-2)]">
            {item.sku ?? item.barcode ?? "—"}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          {item.low && (
            <TriangleAlert
              className="h-4 w-4 text-[var(--pos-warn)]"
              strokeWidth={2}
              aria-label="Low stock"
            />
          )}
          <button
            type="button"
            disabled={pending}
            onClick={() => quick(-1)}
            aria-label={`One less ${label}`}
            className="rounded-lg bg-[var(--pos-surface-2)] p-1.5 transition-colors hover:bg-[var(--pos-surface-3)] disabled:opacity-40"
          >
            <Minus className="h-4 w-4" />
          </button>
          <span
            className={`w-10 text-center text-lg font-bold ${
              item.low ? "text-[var(--pos-warn)]" : ""
            }`}
          >
            {item.onHand}
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() => quick(1)}
            aria-label={`One more ${label}`}
            className="rounded-lg bg-[var(--pos-surface-2)] p-1.5 transition-colors hover:bg-[var(--pos-surface-3)] disabled:opacity-40"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-[var(--pos-border)] p-3">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {(Object.keys(MODE_META) as Mode[]).map((m) => {
              // Nowhere to send stock in a single-location store.
              if (m === "transfer" && targets.length === 0) return null;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors ${
                    mode === m
                      ? "bg-[var(--pos-accent)] text-[var(--pos-on-accent)]"
                      : "bg-[var(--pos-surface-2)] hover:bg-[var(--pos-surface-3)]"
                  }`}
                >
                  {MODE_META[m].label}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-24 flex-1">
              <span className="mb-1 block text-xs text-[var(--pos-ink-2)]">
                {mode === "count" ? "Counted" : "Quantity"}
              </span>
              <input
                value={value}
                inputMode="numeric"
                onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="0"
                className="w-full rounded-lg border border-[var(--pos-border)] bg-[var(--pos-surface)] px-3 py-2 text-right outline-none focus:border-[var(--pos-border-strong)]"
              />
            </label>

            {mode === "transfer" && (
              <label className="min-w-36 flex-1">
                <span className="mb-1 block text-xs text-[var(--pos-ink-2)]">
                  To
                </span>
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  className="w-full rounded-lg border border-[var(--pos-border)] bg-[var(--pos-surface)] px-3 py-2 outline-none focus:border-[var(--pos-border-strong)]"
                >
                  {targets.map((t) => (
                    <option
                      key={t.id}
                      value={t.id}
                      className="bg-[var(--pos-bg)]"
                    >
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="min-w-36 flex-[2]">
              <span className="mb-1 block text-xs text-[var(--pos-ink-2)]">
                Reason (optional)
              </span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={
                  mode === "count" ? "e.g. weekly stocktake" : "e.g. damaged"
                }
                className="w-full rounded-lg border border-[var(--pos-border)] bg-[var(--pos-surface)] px-3 py-2 outline-none focus:border-[var(--pos-border-strong)]"
              />
            </label>

            <button
              type="button"
              disabled={pending || !valid}
              onClick={submit}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold transition-colors hover:bg-emerald-500 disabled:opacity-40 text-white"
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : mode === "transfer" ? (
                <Send className="h-4 w-4" strokeWidth={2} />
              ) : null}
              {MODE_META[mode].verb}
            </button>
          </div>

          {mode === "count" && (
            <p className="mt-2 text-xs text-[var(--pos-ink-3)]">
              Saved as the difference from {item.onHand}, so a sale rung while
              you were counting isn&apos;t wiped out.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
