"use server";

import { eq, sql } from "drizzle-orm";
import { getServerUser } from "@/lib/auth/server-user";
import { updateAuthUser } from "@/lib/auth/firebase-users";
import { withUser } from "@/lib/db/client";
import { emitEvent } from "@/lib/notifications/record";
import { users } from "@/drizzle/schema";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { recordStorePolicyConsent } from "@/lib/legal/store-consent";

export interface MyCustomer {
  id: string;
  phone: string;
  email: string | null;
  first_name: string;
  last_name: string | null;
  updated_at: string;
}

/**
 * WHY a status and not just a null: the AuthProvider has to tell three very
 * different "no customer" cases apart, because only ONE of them is worth
 * recovering from.
 *
 * - `no-session`  — the server saw nobody. For a browser that still holds a
 *   live Firebase session that means the httpOnly `sm_session` cookie lapsed
 *   (14 days; the client SDK's own persistence is indefinite), and the client
 *   can mint a fresh one from its refresh token.
 * - `no-row`      — a perfectly valid session with no `users` row. A store
 *   admin browsing their own storefront is exactly this. Nothing to recover.
 * - `unavailable` — the read failed. A new cookie fixes nothing, and treating
 *   an outage as "not a customer" would sign people out for a DB blip.
 */
export type MyCustomerSession =
  | { status: "ok"; customer: MyCustomer }
  | { status: "no-session"; customer: null }
  | { status: "no-row"; customer: null }
  | { status: "unavailable"; customer: null };

/**
 * The signed-in customer's own profile row *with the reason* when there isn't
 * one. Replaces a browser-side `users` read (a "use client" provider cannot use
 * the server-only Drizzle layer). Own-row RLS under the customer's identity.
 */
export async function getMyCustomerSession(): Promise<MyCustomerSession> {
  const user = await getServerUser();
  if (!user) return { status: "no-session", customer: null };

  let readFailed = false;
  const rows = await withUser({ uid: user.id, email: user.email }, (db) =>
    db
      .select({
        id: users.id,
        phone: users.phone,
        email: users.email,
        first_name: users.firstName,
        last_name: users.lastName,
        updated_at: users.updatedAt,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1),
  ).catch(() => {
    readFailed = true;
    return [] as MyCustomer[];
  });

  if (readFailed) return { status: "unavailable", customer: null };
  const row = rows[0];
  return row
    ? { status: "ok", customer: row }
    : { status: "no-row", customer: null };
}

/** Just the row, for callers that have no use for the reason. */
export async function getMyCustomer(): Promise<MyCustomer | null> {
  return (await getMyCustomerSession()).customer;
}

export async function updateCustomerProfile(formData: FormData) {
  const firstName = formData.get("firstName") as string;
  const lastName = (formData.get("lastName") as string) || null;
  const email = (formData.get("email") as string) || null;

  if (!firstName || !firstName.trim()) {
    return { error: "First name is required." };
  }

  if (email && !email.includes("@")) {
    return { error: "Please provide a valid email address." };
  }

  const user = await getServerUser();
  if (!user) {
    return { error: "Not authenticated." };
  }

  // Update the Identity Platform email if it changed.
  if (email && email.trim() !== user.email) {
    try {
      await updateAuthUser(user.id, { email: email.trim() });
    } catch (err) {
      console.error("Failed to update auth email:", err);
      return { error: "Failed to update email address." };
    }
  }

  // `users.phone` is NOT NULL UNIQUE — never write an empty string (it would
  // collide across every phone-less customer). Only set it when the
  // authenticated user actually has a verified phone; otherwise leave the
  // existing value untouched (the conflict-update path preserves it).
  const trimmedFirst = firstName.trim();
  const trimmedLast = lastName?.trim() || null;
  const trimmedEmail = email?.trim() || null;

  const storeId = await getCurrentStoreId();
  const insertRow = {
    id: user.id,
    firstName: trimmedFirst,
    lastName: trimmedLast,
    email: trimmedEmail,
    storeId,
    ...(user.phone ? { phone: user.phone } : {}),
  };
  // Columns overwritten on conflict — never `id`, and only touch `phone` when
  // we actually have a verified one to write.
  const conflictSet = {
    firstName: trimmedFirst,
    lastName: trimmedLast,
    email: trimmedEmail,
    ...(user.phone ? { phone: user.phone } : {}),
  };

  // This is an UPSERT — it runs on every profile edit too. `xmax = 0` is the
  // Postgres trick for "this row was INSERTed, not updated", so the signup
  // notification fires exactly once, on the row's first write.
  let isNewCustomer = false;
  try {
    // Own-row upsert under the customer's identity (RLS-scoped to user_id).
    // phone is filled from the verified auth identity, not the form.
    const rows = await withUser({ uid: user.id, email: user.email }, (db) =>
      db
        .insert(users)
        .values(insertRow as typeof users.$inferInsert)
        .onConflictDoUpdate({ target: users.id, set: conflictSet })
        .returning({ inserted: sql<boolean>`(xmax = 0)` }),
    );
    isNewCustomer = rows[0]?.inserted === true;
  } catch (err) {
    console.error("Failed to update customer profile:", err);
    return { error: "Failed to save profile. Please try again." };
  }

  if (isNewCustomer) {
    // Consent is recorded HERE, not from the tick box, and only on a genuine
    // first insert — the same `xmax = 0` signal the signup event uses. The
    // shopper agreed to the store's policies as they read at this moment; the
    // server re-reads and hashes them rather than trusting anything sent.
    // Best-effort: a failed audit row must never block someone's account.
    await recordStorePolicyConsent({
      userId: user.id,
      email: user.email ?? trimmedEmail,
      storeId,
      context: "signup",
    });

    emitEvent({
      type: "customer.signed_up",
      storeId,
      actor: {
        type: "customer",
        id: user.id,
        label: [trimmedFirst, trimmedLast].filter(Boolean).join(" ") || null,
      },
      subject: {
        type: "customer",
        id: user.id,
        label: [trimmedFirst, trimmedLast].filter(Boolean).join(" ") || null,
      },
    });
  }

  return { success: true };
}
