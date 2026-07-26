"use server";

import { revalidateTag } from "next/cache";
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import { admins, stores } from "@/drizzle/schema";
import { getServerUser } from "@/lib/auth/server-user";
import { STORE_TAG } from "@/lib/store/resolve";
import { ROOT_DOMAIN } from "@/lib/store/host";
import { slugify } from "@/lib/slug";
import { emitEvent } from "@/lib/notifications/record";
import { applyTheme } from "@/lib/themes/apply";
import { DEFAULT_THEME_ID } from "@/lib/themes/meta";
import { submitSitemapToGoogle, pingIndexNow } from "@/lib/seo/search-engines";

// Subdomains we can never hand out (platform-reserved or operational).
const RESERVED = new Set([
  "www",
  "app",
  "help",
  "api",
  "admin",
  "dashboard",
  "auth",
  "mail",
  "email",
  "smtp",
  "ftp",
  "blog",
  "status",
  "support",
  "billing",
  "account",
  "accounts",
  "login",
  "signup",
  "store",
  "stores",
  "storiq",
  "storemink",
  "assets",
  "cdn",
  "static",
  "media",
  "img",
  "images",
]);

export interface SlugCheck {
  slug: string;
  available: boolean;
  reason?: string;
}

/**
 * Live store-name → subdomain availability check for signup. Derives the slug
 * from what the user typed, validates its shape, rejects reserved names, then
 * checks (via the service role, so pending/suspended stores count too) whether
 * any store already owns it.
 */
export async function checkStoreSlugAvailability(
  raw: string,
): Promise<SlugCheck> {
  const slug = slugify(raw || "");

  if (!slug) {
    return { slug, available: false, reason: "Enter a store name." };
  }
  if (slug.length < 3) {
    return { slug, available: false, reason: "At least 3 characters." };
  }
  if (slug.length > 40) {
    return { slug, available: false, reason: "Too long (40 characters max)." };
  }
  if (RESERVED.has(slug)) {
    return { slug, available: false, reason: "This name is reserved." };
  }
  // The demo- namespace belongs to theme demo stores (seedDemoStore).
  if (/^demo(-|$)/.test(slug)) {
    return { slug, available: false, reason: "This name is reserved." };
  }

  try {
    const rows = await withService((db) =>
      db
        .select({ id: stores.id })
        .from(stores)
        .where(eq(stores.slug, slug))
        .limit(1),
    );
    if (rows[0]) {
      return { slug, available: false, reason: "This name is not available." };
    }
    return { slug, available: true };
  } catch (err) {
    console.error(
      "checkStoreSlugAvailability:",
      err instanceof Error ? err.message : err,
    );
    return { slug, available: false, reason: "Couldn't check right now." };
  }
}

export interface SignupResume {
  /** Whether there's an authenticated session (email/password or Google). */
  authenticated: boolean;
  /** Whether this account already owns a store (→ send them to the dashboard). */
  hasStore: boolean;
  /** The owned store's slug, when hasStore. */
  slug?: string;
  /** Whether the account's phone is OTP-verified already. */
  phoneConfirmed: boolean;
  email?: string;
  /** Name prefill (from Google profile metadata when signing in with Google). */
  firstName?: string;
  lastName?: string;
}

/**
 * What the signup wizard needs on load to resume: after a Google redirect (or a
 * refreshed tab), an account may already have a session — and possibly a store.
 * Lets the client jump straight to the phone/name step (prefilling the Google
 * name), or bounce a finished account to its dashboard.
 */
export async function getSignupResumeInfo(): Promise<SignupResume> {
  const user = await getServerUser();
  if (!user) {
    return { authenticated: false, hasStore: false, phoneConfirmed: false };
  }

  let storeIdOwned: string | undefined;
  let slug: string | undefined;
  try {
    const existing = await withService((db) =>
      db
        .select({ store_id: admins.storeId })
        .from(admins)
        .where(eq(admins.id, user.id))
        .limit(1),
    );
    storeIdOwned = existing[0]?.store_id ?? undefined;

    if (storeIdOwned) {
      const storeRows = await withService((db) =>
        db
          .select({ slug: stores.slug })
          .from(stores)
          .where(eq(stores.id, storeIdOwned!))
          .limit(1),
      );
      slug = storeRows[0]?.slug ?? undefined;
    }
  } catch (err) {
    console.error("getSignupResumeInfo:", err);
  }

  // Best-effort name prefill from OAuth profile metadata.
  const meta = user.metadata ?? {};
  const full = String(meta.full_name || meta.name || "").trim();
  const parts = full ? full.split(/\s+/) : [];
  const firstName = (meta.given_name as string) || parts[0] || undefined;
  const lastName =
    (meta.family_name as string) ||
    (parts.length > 1 ? parts.slice(1).join(" ") : undefined);

  return {
    authenticated: true,
    hasStore: !!storeIdOwned,
    slug,
    phoneConfirmed: user.phoneConfirmed,
    email: user.email ?? undefined,
    firstName,
    lastName,
  };
}

export interface CreateStoreInput {
  /** Store display name (also seeds the subdomain slug). */
  name: string;
  /** Chosen theme/template id (see lib/themes/meta). */
  template?: string;
  /** Owner's first name (written to admins.first_name). */
  firstName?: string;
  /** Owner's last name (admins.last_name; optional). */
  lastName?: string;
  /** ISO country code the merchant sells from (settings.business.country). */
  country?: string;
  /** City the merchant sells from (settings.business.city; optional). */
  city?: string;
}

export interface CreateStoreResult {
  slug?: string;
  storeId?: string;
  error?: string;
}

/**
 * Provision a new store. Called AFTER the owner has phone-OTP-verified (so
 * there's an authenticated session — see the signup wizard). Creates the store,
 * makes the caller its superadmin (recording their name + selling location),
 * and returns the slug + id. Runs the writes via the service role because a
 * brand-new owner isn't yet a superadmin of any store (so RLS would block them).
 */
export async function createStore(
  input: CreateStoreInput,
): Promise<CreateStoreResult> {
  const rawName = input.name;
  const template = input.template || DEFAULT_THEME_ID;

  const user = await getServerUser();
  if (!user) {
    return { error: "Please sign in before creating a store." };
  }
  // The client wizard tracks verification in React state, which a caller can
  // bypass by invoking this action directly. Phone is the authoritative
  // verification (email confirmation is disabled — signup is phone-only), so a
  // store can't be provisioned without a confirmed phone number.
  if (!user.phoneConfirmed) {
    return {
      error: "Please verify your phone number before creating a store.",
    };
  }

  // Authoritative re-check (the client check is just for live feedback).
  const check = await checkStoreSlugAvailability(rawName);
  if (!check.available) {
    return { error: check.reason ?? "This name is not available." };
  }
  const slug = check.slug;

  // One store per owner for now (admins.id is the auth user id).
  const existing = await withService((db) =>
    db
      .select({ store_id: admins.storeId })
      .from(admins)
      .where(eq(admins.id, user.id))
      .limit(1),
  ).catch(() => []);
  if (existing[0]) {
    return { error: "This account already has a store." };
  }

  // Where the merchant sells from — captured at signup, non-secret (it prints on
  // invoices later), so it lives in the anon-readable stores.settings jsonb
  // under `business` (never a secret — convention #9).
  const country = (input.country || "").trim().slice(0, 2).toUpperCase();
  const city = (input.city || "").trim().slice(0, 80);
  const business: Record<string, string> = {};
  if (country) business.country = country;
  if (city) business.city = city;

  // Create the store.
  let store: { id: string; slug: string };
  try {
    const [created] = await withService((db) =>
      db
        .insert(stores)
        .values({
          slug,
          name: rawName.trim(),
          status: "active",
          plan: "free",
          settings: {
            template,
            brand: { name: rawName.trim() },
            ...(Object.keys(business).length ? { business } : {}),
          },
        })
        .returning({ id: stores.id, slug: stores.slug }),
    );
    store = created;
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { error: "That name was just taken — try another." };
    }
    console.error(
      "createStore (store insert):",
      err instanceof Error ? err.message : err,
    );
    return { error: "Could not create your store. Please try again." };
  }

  // Make the owner the store's superadmin, recording their name (falls back to
  // the email local-part so admins.first_name is never blank).
  const firstName =
    (input.firstName || "").trim() ||
    (user.email ? user.email.split("@")[0] : "Owner");
  const lastName = (input.lastName || "").trim() || null;
  try {
    await withService((db) =>
      db.insert(admins).values({
        id: user.id,
        email: user.email ?? "",
        role: "superadmin",
        storeId: store.id,
        firstName: firstName.slice(0, 80),
        lastName: lastName ? lastName.slice(0, 80) : null,
        // The owner set their own password during signup — the admins column
        // defaults force_password_reset=true (that's for INVITED staff who get
        // a temporary password), so override it here or the owner is bounced to
        // /auth/set-password on their first login.
        forcePasswordReset: false,
      }),
    );
  } catch (err) {
    // Roll back the store so a retry isn't blocked by the now-taken slug.
    await withService((db) =>
      db.delete(stores).where(eq(stores.id, store.id)),
    ).catch(() => {});
    console.error(
      "createStore (admin insert):",
      err instanceof Error ? err.message : err,
    );
    return { error: "Could not set up your store account. Please try again." };
  }

  // Seed the chosen theme: homepage + content pages (published), menus, brand
  // accents, and clearly-labeled sample products/categories — the merchant
  // starts by EDITING a real website, not building from a blank canvas.
  // Best-effort: a partial seed still leaves a working store, and applyTheme
  // is idempotent (upserts by store_id+slug) so it can be re-run.
  const seeded = await applyTheme(store.id, template, {
    publish: true,
    actorUserId: user.id,
  });
  if (!seeded.success) {
    console.error("createStore (theme seed):", seeded.errors.join(" | "));
  }

  // New store row is now resolvable — bust the cached store lookups.
  revalidateTag(STORE_TAG, "max");

  // Announce the new store to search engines so it's discovered without waiting
  // for organic crawl. Runs after the response (never blocks signup) and is
  // best-effort/dormant until the platform's Search Console + IndexNow env is
  // configured. Google then finds all future content via the dynamic sitemap.
  const storeUrl = `https://${store.slug}.${ROOT_DOMAIN}`;
  after(async () => {
    await Promise.allSettled([
      submitSitemapToGoogle(`${storeUrl}/sitemap.xml`),
      pingIndexNow([`${storeUrl}/`]),
    ]);
  });

  // Platform-level event (store_id NULL): this is news for StoreMink
  // operators, not for the merchant's own dashboard.
  emitEvent({
    type: "platform.store_created",
    storeId: null,
    actor: { type: "admin", id: user.id, label: user.email ?? null },
    subject: { type: "store", id: store.id, label: rawName.trim() },
    payload: { slug: store.slug, template },
  });

  return { slug: store.slug, storeId: store.id };
}
