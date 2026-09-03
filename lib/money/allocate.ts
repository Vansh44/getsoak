// ---------------------------------------------------------------------------
// Splitting one rupee amount across several lines, in paise, exactly.
//
// Extracted from `lib/pos/returns.ts`, which needed it to re-allocate an order
// discount on a return. The offer engine (`lib/offers/apply.ts`) needs the SAME
// arithmetic to allocate an order-level reward across lines at sale time — and
// those two are the sale and the refund of that sale, so a second
// hand-written copy is a guarantee that a full return eventually comes back a
// paisa short of what was paid. That difference is the kind a customer notices
// at a counter and nobody can explain.
//
// ── Why paise, and why the remainder rule ─────────────────────────────────
// Allocating in floats leaves a stray fraction, so the parts do not sum to the
// whole. Integer paise plus an explicit remainder pass makes the sum exact.
// The remainder goes to the LARGEST FRACTIONAL PARTS rather than to the last
// line: giving it to the last line means one arbitrary line silently carries
// everybody else's rounding, which shows up as a receipt whose lines do not add
// up to its total.
// ---------------------------------------------------------------------------

/** Round to 2 decimal places (money), guarding float error. */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Rupees → integer paise. Non-finite input is 0, never NaN. */
export function toPaise(n: number): number {
  return Math.round((Number(n) || 0) * 100);
}

/** Integer paise → rupees. */
export function toRupees(p: number): number {
  return Math.round(p) / 100;
}

/**
 * Split `totalPaise` across `weightsPaise` in proportion to each weight.
 *
 * Returns one integer-paise share per weight, guaranteed to sum to exactly
 * `min(totalPaise, Σ weightsPaise)` — never more than there is to give, and
 * never less than the caller asked for when there is room.
 *
 * ★ NEVER ALLOCATES TO A ZERO OR NEGATIVE WEIGHT. A line worth nothing cannot
 * absorb part of a discount: doing so produces a negative charge on that line,
 * which then refunds as a negative amount. Zero-weight lines are a real case —
 * a Phase G free gift is a ₹0 line sitting in the same cart as paid ones.
 */
export function allocateProportional(
  weightsPaise: readonly number[],
  totalPaise: number,
): number[] {
  const n = weightsPaise.length;
  const share = new Array<number>(n).fill(0);
  if (n === 0) return share;

  // Negative weights are treated as zero rather than rejected: the caller is
  // money arithmetic, and refusing here would fail a sale over a data problem.
  const w = weightsPaise.map((x) =>
    Number.isFinite(x) ? Math.max(0, Math.trunc(x)) : 0,
  );
  const weightTotal = w.reduce((a, b) => a + b, 0);

  const total = Math.min(
    Math.max(0, Math.trunc(Number.isFinite(totalPaise) ? totalPaise : 0)),
    weightTotal,
  );
  if (total <= 0 || weightTotal <= 0) return share;

  let handed = 0;
  const exact = w.map((g) => (g * total) / weightTotal);
  exact.forEach((e, i) => {
    share[i] = Math.floor(e);
    handed += share[i];
  });

  // Largest fractional parts absorb the remainder. Ties break on index so the
  // result is byte-identical across runs — a receipt that changes between two
  // renders of the same cart is not reproducible for the merchant.
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .filter(({ i }) => w[i] > 0)
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  let left = total - handed;
  // Several passes: one pass gives at most 1 paisa per line, and the remainder
  // can exceed the number of eligible lines when weights are very uneven.
  while (left > 0 && order.length > 0) {
    for (const { i } of order) {
      if (left <= 0) break;
      if (share[i] >= w[i]) continue; // never allocate more than the line holds
      share[i] += 1;
      left -= 1;
    }
    // Nothing could absorb another paisa — stop rather than spin.
    if (order.every(({ i }) => share[i] >= w[i])) break;
  }

  return share;
}
