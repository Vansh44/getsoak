"use server";

import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { deleteAuthUser } from "@/lib/auth/firebase-users";
import { logError } from "@/lib/observability/logger";
import { getServerUser } from "@/lib/auth/server-user";
import { withService } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import {
  admins,
  aiCreditBalances,
  aiCreditLedger,
  aiUsage,
  blogComments,
  blogs,
  cardColors,
  categories,
  emailCampaigns,
  planEvents,
  planPrices,
  platformAdmins,
  productReviews,
  productVariants,
  products,
  storePages,
  storePaymentProviders,
  stores,
  users,
} from "@/drizzle/schema";
import { STORE_TAG, FALLBACK_STORE_ID } from "@/lib/store/resolve";
import { emitEvent } from "@/lib/notifications/record";
import { getThemeDefinition } from "@/lib/themes";
import { applyTheme } from "@/lib/themes/apply";
import { deleteStorageUrls } from "@/lib/storage/cleanup";
import { PLAN_IDS, PLAN_META, normalizePlan, type Plan } from "@/lib/plans";
import {
  bustPlanPricing,
  getPlanPricingLive,
  type PlanPricing,
} from "@/lib/plans/pricing";
import { currentPeriod } from "@/lib/ai/quota";

// A Storemink platform operator (from platform_admins, by JWT email).
export interface PlatformViewer {
  email: string;
  role: "superadmin" | "member";
}

export async function getPlatformViewer(): Promise<PlatformViewer | null> {
  const user = await getServerUser();
  if (!user?.email) return null;
  // Exact (case-normalised) match, not ILIKE — a user-controlled email used as
  // a LIKE pattern is a privilege-escalation vector. platform_admins IS the
  // operator allowlist, so a service-scope read filtered by the verified email
  // is the gate.
  const rows = await withService((db) =>
    db
      .select({ email: platformAdmins.email, role: platformAdmins.role })
      .from(platformAdmins)
      .where(eq(platformAdmins.email, user.email!.toLowerCase()))
      .limit(1),
  ).catch(() => []);
  const data = rows[0];
  if (!data) return null;
  return {
    email: data.email,
    role: data.role as "superadmin" | "member",
  };
}

export interface PlatformStoreRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  plan: string;
  plan_expires_at: string | null; // timed plans — null = indefinite
  custom_domain: string | null;
  created_at: string;
  owner_email: string | null; // superadmin who set the store up (from admins)
  ai_used: number; // AI generations consumed this calendar month
  credit_balance: number; // purchased/granted AI credits remaining
  /** BYO payment gateway state: none = not connected. Never the keys. */
  gateway: "none" | "enabled" | "paused";
}

// Trim the search term to a sane length (parameterised — no escaping needed).
function sanitize(q: string): string {
  return q.trim().slice(0, 80);
}

// Every store on the platform (operator-only; service scope bypasses per-store RLS).
export async function listAllStores(q?: string): Promise<PlatformStoreRow[]> {
  if (!(await getPlatformViewer())) return [];

  const term = sanitize(q ?? "");
  try {
    return await withService(async (db) => {
      const conds = term
        ? [
            or(
              ilike(stores.name, `%${term}%`),
              ilike(stores.slug, `%${term}%`),
            )!,
          ]
        : [];
      const rows = await db
        .select({
          id: stores.id,
          slug: stores.slug,
          name: stores.name,
          status: stores.status,
          plan: stores.plan,
          plan_expires_at: stores.planExpiresAt,
          custom_domain: stores.customDomain,
          created_at: stores.createdAt,
        })
        .from(stores)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(stores.createdAt))
        .limit(500);

      const list = rows.map(
        (s): PlatformStoreRow => ({
          ...s,
          owner_email: null,
          ai_used: 0,
          credit_balance: 0,
          gateway: "none" as const,
        }),
      );
      if (!list.length) return list;

      // Enrich in four batch queries (never per-store): owner email, this
      // month's AI usage, the credit balance, and the BYO gateway state.
      const ids = list.map((s) => s.id);
      const owners = await db
        .select({
          store_id: admins.storeId,
          email: admins.email,
          created_at: admins.createdAt,
        })
        .from(admins)
        .where(and(inArray(admins.storeId, ids), eq(admins.role, "superadmin")))
        .orderBy(asc(admins.createdAt));
      const usage = await db
        .select({ store_id: aiUsage.storeId, used: aiUsage.used })
        .from(aiUsage)
        .where(
          and(
            inArray(aiUsage.storeId, ids),
            eq(aiUsage.period, currentPeriod()),
          ),
        );
      const credits = await db
        .select({
          store_id: aiCreditBalances.storeId,
          balance: aiCreditBalances.balance,
        })
        .from(aiCreditBalances)
        .where(inArray(aiCreditBalances.storeId, ids));
      const gw = await db
        .select({
          store_id: storePaymentProviders.storeId,
          enabled: storePaymentProviders.enabled,
        })
        .from(storePaymentProviders)
        .where(inArray(storePaymentProviders.storeId, ids));

      // Earliest superadmin per store wins as "owner".
      const ownerByStore = new Map<string, string>();
      for (const o of owners) {
        if (!ownerByStore.has(o.store_id) && o.email)
          ownerByStore.set(o.store_id, o.email);
      }
      const usedByStore = new Map(usage.map((u) => [u.store_id, u.used]));
      const creditsByStore = new Map(
        credits.map((c) => [c.store_id, c.balance]),
      );
      const gatewayByStore = new Map(
        gw.map((g) => [
          g.store_id,
          g.enabled ? ("enabled" as const) : ("paused" as const),
        ]),
      );

      for (const s of list) {
        s.owner_email = ownerByStore.get(s.id) ?? null;
        s.ai_used = usedByStore.get(s.id) ?? 0;
        s.credit_balance = creditsByStore.get(s.id) ?? 0;
        s.gateway = gatewayByStore.get(s.id) ?? "none";
      }
      return list;
    });
  } catch (err) {
    console.error("listAllStores:", err instanceof Error ? err.message : err);
    return [];
  }
}

export interface ActionResult {
  success?: boolean;
  error?: string;
}

// Suspend / reactivate a store (platform superadmin only). A suspended store
// stops resolving on the storefront (Read stores policy requires status=active).
export async function setStoreStatus(
  storeId: string,
  status: "active" | "suspended",
): Promise<ActionResult> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can change store status." };
  }
  if (!["active", "suspended"].includes(status)) {
    return { error: "Invalid status." };
  }
  try {
    await withService((db) =>
      db.update(stores).set({ status }).where(eq(stores.id, storeId)),
    );
  } catch (err) {
    console.error("setStoreStatus:", err instanceof Error ? err.message : err);
    return { error: "Could not update the store. Please try again." };
  }
  revalidateTag(STORE_TAG, "max");
  emitEvent({
    type: "platform.store_suspended",
    storeId: null,
    actor: { type: "operator", label: viewer.email },
    subject: { type: "store", id: storeId },
    payload: { status },
  });
  return { success: true };
}

// Set a store's plan (platform superadmin only) — ANY direction, optionally
// time-boxed. Downgrades are soft (existing data is never deleted; creating
// new rows past the smaller plan's caps is what gets blocked — lib/plans.ts).
// `expiresAt` bounds the grant: an ISO timestamp in the future, or null for
// indefinite. Expired plans behave as free immediately (effectivePlan) and are
// durably flipped by /api/cron/plan-expiry. Every change is recorded in the
// append-only plan_events audit log.
export async function setStorePlan(
  storeId: string,
  targetPlan: string,
  opts?: { expiresAt?: string | null },
): Promise<ActionResult> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can change store plans." };
  }
  if (!PLAN_IDS.includes(targetPlan as Plan)) {
    return { error: "Invalid plan." };
  }
  const target = targetPlan as Plan;

  // Free never expires (there is nothing to lapse to); paid plans may carry
  // an expiry, which must parse and lie in the future.
  let expiresAt: string | null = null;
  if (target !== "free" && opts?.expiresAt != null) {
    const parsed = new Date(opts.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      return { error: "Invalid expiry date." };
    }
    if (parsed.getTime() <= Date.now()) {
      return { error: "The expiry date must be in the future." };
    }
    expiresAt = parsed.toISOString();
  }

  const storeRows = await withService((db) =>
    db
      .select({ plan: stores.plan, plan_expires_at: stores.planExpiresAt })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  ).catch(() => []);
  const store = storeRows[0];
  if (!store) return { error: "Store not found." };

  const current = normalizePlan(store.plan);
  if (
    current === target &&
    (store.plan_expires_at ?? null) === (expiresAt ?? null)
  ) {
    return { error: `This store is already on ${PLAN_META[target].name}.` };
  }

  try {
    await withService((db) =>
      db
        .update(stores)
        .set({ plan: target, planSource: "comp", planExpiresAt: expiresAt })
        // no-op if the plan changed under us (stale row).
        .where(and(eq(stores.id, storeId), eq(stores.plan, store.plan))),
    );
  } catch (err) {
    console.error("setStorePlan:", err instanceof Error ? err.message : err);
    return { error: "Could not update the plan. Please try again." };
  }

  // Best-effort audit trail — the plan change itself is the source of truth.
  try {
    await withService((db) =>
      db.insert(planEvents).values({
        storeId,
        fromPlan: current,
        toPlan: target,
        source: "operator",
        actor: viewer.email,
        note: expiresAt
          ? `expires ${expiresAt.slice(0, 10)}`
          : target === "free"
            ? null
            : "indefinite",
      }),
    );
  } catch (auditErr) {
    console.error(
      "setStorePlan (audit):",
      auditErr instanceof Error ? auditErr.message : auditErr,
    );
  }

  // Plan gates feature settings (minPlan) — bust the cached store lookups so
  // the store's dashboard + storefront see the new plan immediately.
  revalidateTag(STORE_TAG, "max");

  // Two events, two audiences: the MERCHANT is told their plan changed, and
  // StoreMink operators see it on the platform feed.
  emitEvent({
    type: "plan.changed",
    storeId,
    actor: { type: "operator", label: viewer.email },
    subject: { type: "plan", id: target, label: PLAN_META[target].name },
    payload: { plan: target, note: "Changed by StoreMink" },
  });
  emitEvent({
    type: "platform.plan_changed",
    storeId: null,
    actor: { type: "operator", label: viewer.email },
    subject: { type: "store", id: storeId },
    payload: { plan: target },
  });
  return { success: true };
}

// Grant free AI credits to a store (platform superadmin only). Goes through
// the same atomic add_ai_credits RPC as purchases, so every grant lands in the
// append-only ai_credit_ledger with the operator's email as the ref.
const MAX_CREDIT_GRANT = 10_000;

export async function grantAiCredits(
  storeId: string,
  amount: number,
  note?: string,
): Promise<ActionResult> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can grant credits." };
  }
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_CREDIT_GRANT) {
    return {
      error: `Credits must be a whole number between 1 and ${MAX_CREDIT_GRANT}.`,
    };
  }

  const storeRows = await withService((db) =>
    db
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  ).catch(() => []);
  if (!storeRows[0]) return { error: "Store not found." };

  const noteVal = sanitize(note ?? "").slice(0, 200) || null;
  try {
    await withService((db) =>
      db.execute(
        sql`select add_ai_credits(p_store => ${storeId}, p_delta => ${amount}, p_kind => ${"grant"}, p_ref => ${viewer.email}, p_note => ${noteVal})`,
      ),
    );
  } catch (err) {
    console.error("grantAiCredits:", err instanceof Error ? err.message : err);
    return { error: "Could not grant credits. Please try again." };
  }
  return { success: true };
}

// Per-store audit history for the console drawer: plan changes (plan_events)
// + the AI-credit ledger. Read-only, superadmin-gated like the mutations.
export interface StoreAuditData {
  planEvents: Array<{
    id: string;
    from_plan: string | null;
    to_plan: string;
    source: string;
    actor: string | null;
    note: string | null;
    created_at: string;
  }>;
  creditLedger: Array<{
    id: string;
    delta: number;
    kind: string;
    ref: string | null;
    note: string | null;
    created_at: string;
  }>;
}

export async function getStoreAudit(
  storeId: string,
): Promise<StoreAuditData | null> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") return null;

  try {
    return await withService(async (db) => {
      const planEventRows = await db
        .select({
          id: planEvents.id,
          from_plan: planEvents.fromPlan,
          to_plan: planEvents.toPlan,
          source: planEvents.source,
          actor: planEvents.actor,
          note: planEvents.note,
          created_at: planEvents.createdAt,
        })
        .from(planEvents)
        .where(eq(planEvents.storeId, storeId))
        .orderBy(desc(planEvents.createdAt))
        .limit(30);
      const creditLedgerRows = await db
        .select({
          id: aiCreditLedger.id,
          delta: aiCreditLedger.delta,
          kind: aiCreditLedger.kind,
          ref: aiCreditLedger.ref,
          note: aiCreditLedger.note,
          created_at: aiCreditLedger.createdAt,
        })
        .from(aiCreditLedger)
        .where(eq(aiCreditLedger.storeId, storeId))
        .orderBy(desc(aiCreditLedger.createdAt))
        .limit(30);
      return {
        planEvents: planEventRows as StoreAuditData["planEvents"],
        creditLedger: creditLedgerRows as StoreAuditData["creditLedger"],
      };
    });
  } catch (err) {
    console.error("getStoreAudit:", err instanceof Error ? err.message : err);
    return null;
  }
}

// Any managed media public URL — Supabase (…/object/public/media/…) OR Google
// Cloud Storage (storage.googleapis.com/<bucket>/…), since a store's media may
// straddle both during the Phase 3 migration. Store media isn't namespaced by
// store in the bucket, so we can't purge by prefix — instead we scrape every
// media URL out of the store's own rows (product images, blog bodies, brand
// logo, page sections…) before the DB rows cascade away, then delete those
// files (deleteStorageUrls routes each URL to the right backend).
const MEDIA_URL_RE =
  /https?:\/\/[^"'\s)]*(?:\/object\/public\/media\/|storage\.googleapis\.com\/[^/"'\s)]+\/)[^"'\s)]+/g;

// Every store-scoped table that can hold an uploaded image (product/variant
// galleries, category tiles, blog covers+bodies, page sections, review photos,
// campaign HTML, colour-card art, customer avatars). Selecting all columns +
// JSON scan means a new image column is covered automatically.
const MEDIA_TABLES = [
  products,
  productVariants,
  categories,
  blogs,
  blogComments,
  storePages,
  productReviews,
  emailCampaigns,
  cardColors,
  users,
];

// PERMANENTLY delete a store and everything belonging to it (platform
// superadmin only). Irreversible. Every store-scoped table FKs stores(id) with
// ON DELETE CASCADE, so one DELETE removes all DB rows; we additionally purge
// the store's uploaded media and delete its owner/staff login accounts (neither
// cascades from the stores table).
export async function deleteStore(storeId: string): Promise<ActionResult> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can delete a store." };
  }
  // The WholeSip fallback store underpins unresolved-host handling — never let
  // it be deleted from the console.
  if (storeId === FALLBACK_STORE_ID) {
    return { error: "The WholeSip fallback store can't be deleted." };
  }

  const mediaUrls = new Set<string>();
  const authUserIds = new Set<string>();
  const scan = (obj: unknown) => {
    for (const m of JSON.stringify(obj ?? "").match(MEDIA_URL_RE) ?? [])
      mediaUrls.add(m);
  };

  try {
    const found = await withService(async (db) => {
      const storeRows = await db
        .select({ id: stores.id, settings: stores.settings })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      if (!storeRows[0]) return null;
      scan(storeRows[0].settings);

      // Login accounts to delete (auth.users). admins.id AND users.id are both
      // auth user ids; their rows cascade with the store, so collect ids first.
      const staff = await db
        .select({ id: admins.id })
        .from(admins)
        .where(eq(admins.storeId, storeId));
      const customerRows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.storeId, storeId));
      for (const r of staff) authUserIds.add(r.id);
      for (const r of customerRows) authUserIds.add(r.id);

      // Media URLs referenced anywhere in the store's rows (scanned as JSON so
      // we catch image fields, jsonb arrays AND HTML bodies).
      for (const table of MEDIA_TABLES) {
        const rows = await db
          .select()
          .from(table)
          .where(eq(table.storeId, storeId));
        if (rows.length) scan(rows);
      }
      return true;
    });
    if (!found) return { error: "Store not found." };
  } catch (err) {
    console.error("deleteStore (scan):", err);
    return { error: "Could not delete the store. Please try again." };
  }

  // Delete the store — FK ON DELETE CASCADE wipes every store-scoped row.
  try {
    await withService((db) => db.delete(stores).where(eq(stores.id, storeId)));
  } catch (err) {
    console.error("deleteStore:", err instanceof Error ? err.message : err);
    return { error: "Could not delete the store. Please try again." };
  }

  // Best-effort cleanup of things that DON'T cascade from stores. The store is
  // already gone (its cascade removed the Cloud SQL admins/users rows), so these
  // failures are logged but not surfaced. Remove the Identity Platform logins.
  await deleteStorageUrls(Array.from(mediaUrls));
  for (const id of authUserIds) {
    await deleteAuthUser(id).catch((err) =>
      console.error("deleteStore (auth user)", id, err),
    );
  }

  revalidateTag(STORE_TAG, "max");
  return { success: true };
}

// ---------------------------------------------------------------------------
// Platform operators (RBAC) — manage who can operate Storemink.
// ---------------------------------------------------------------------------

export interface PlatformAdminRow {
  id: string;
  email: string;
  role: "superadmin" | "member";
  created_at: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The operator roster (any operator can view).
export async function listPlatformAdmins(): Promise<PlatformAdminRow[]> {
  if (!(await getPlatformViewer())) return [];
  try {
    const rows = await withService((db) =>
      db
        .select({
          id: platformAdmins.id,
          email: platformAdmins.email,
          role: platformAdmins.role,
          created_at: platformAdmins.createdAt,
        })
        .from(platformAdmins)
        .orderBy(asc(platformAdmins.createdAt)),
    );
    return rows as PlatformAdminRow[];
  } catch (err) {
    console.error("listPlatformAdmins:", err);
    return [];
  }
}

async function requireSuperadmin(): Promise<PlatformViewer | null> {
  const viewer = await getPlatformViewer();
  return viewer?.role === "superadmin" ? viewer : null;
}

// Count of platform superadmins (last-superadmin guards).
async function platformSuperadminCount(): Promise<number> {
  const rows = await withService((db) =>
    db
      .select({ role: platformAdmins.role })
      .from(platformAdmins)
      .where(eq(platformAdmins.role, "superadmin")),
  ).catch(() => []);
  return rows.length;
}

// Add (or re-role) a platform operator by email. They're recognised on their
// next login — no account needs to exist yet.
export async function invitePlatformAdmin(
  email: string,
  role: "superadmin" | "member",
): Promise<ActionResult> {
  const me = await requireSuperadmin();
  if (!me) return { error: "Only a platform superadmin can add operators." };
  const clean = email.trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) return { error: "Enter a valid email." };
  if (!["superadmin", "member"].includes(role))
    return { error: "Invalid role." };

  try {
    await withService((db) =>
      db
        .insert(platformAdmins)
        .values({ email: clean, role })
        .onConflictDoUpdate({ target: platformAdmins.email, set: { role } }),
    );
  } catch (err) {
    if (isUniqueViolation(err))
      return { error: "That operator already exists." };
    console.error(
      "invitePlatformAdmin:",
      err instanceof Error ? err.message : err,
    );
    return { error: "Could not add the operator. Please try again." };
  }
  return { success: true };
}

export async function updatePlatformAdminRole(
  id: string,
  role: "superadmin" | "member",
): Promise<ActionResult> {
  if (!(await requireSuperadmin()))
    return { error: "Only a platform superadmin can change roles." };

  // Don't allow demoting the last remaining superadmin.
  if (role === "member") {
    const targetRows = await withService((db) =>
      db
        .select({ role: platformAdmins.role })
        .from(platformAdmins)
        .where(eq(platformAdmins.id, id))
        .limit(1),
    ).catch(() => []);
    if (targetRows[0]?.role === "superadmin") {
      if ((await platformSuperadminCount()) <= 1)
        return { error: "Can't demote the last superadmin." };
    }
  }

  try {
    await withService((db) =>
      db.update(platformAdmins).set({ role }).where(eq(platformAdmins.id, id)),
    );
  } catch {
    return { error: "Could not update the operator." };
  }
  return { success: true };
}

export async function removePlatformAdmin(id: string): Promise<ActionResult> {
  if (!(await requireSuperadmin()))
    return { error: "Only a platform superadmin can remove operators." };

  const targetRows = await withService((db) =>
    db
      .select({ role: platformAdmins.role })
      .from(platformAdmins)
      .where(eq(platformAdmins.id, id))
      .limit(1),
  ).catch(() => []);
  if (targetRows[0]?.role === "superadmin") {
    if ((await platformSuperadminCount()) <= 1)
      return { error: "Can't remove the last superadmin." };
  }

  try {
    await withService((db) =>
      db.delete(platformAdmins).where(eq(platformAdmins.id, id)),
    );
  } catch {
    return { error: "Could not remove the operator." };
  }
  return { success: true };
}

// ---------------------------------------------------------------------------
// Theme demo stores — one real store per theme (slug demo-{themeId}, marked
// settings.demo) that the signup picker's Preview button opens. Re-seedable:
// applyTheme with reset:true wipes the demo's catalog/pages/menus and applies
// the theme fresh, so demos always show the theme's pristine state. No admins
// row is created — nobody logs into a demo store.
// ---------------------------------------------------------------------------

export interface SeedDemoResult {
  success?: boolean;
  error?: string;
  slug?: string;
  warnings?: string[];
}

export async function seedDemoStore(themeId: string): Promise<SeedDemoResult> {
  if (!(await requireSuperadmin())) {
    return { error: "Only a platform superadmin can seed demo stores." };
  }
  const theme = getThemeDefinition(themeId);
  if (theme.id !== themeId) {
    return { error: `Unknown theme "${themeId}".` };
  }

  const slug = theme.demo.slug;

  // Create the store row if missing.
  let storeId: string | undefined;
  try {
    storeId = await withService(async (db) => {
      const existing = await db
        .select({ id: stores.id })
        .from(stores)
        .where(eq(stores.slug, slug))
        .limit(1);
      if (existing[0]) return existing[0].id;

      const [created] = await db
        .insert(stores)
        .values({
          slug,
          name: `${theme.name} Demo`,
          status: "active",
          plan: "free",
          settings: {
            demo: true,
            template: theme.id,
            brand: { name: `${theme.name} Demo` },
          },
        })
        .returning({ id: stores.id });
      return created.id;
    });
  } catch (err) {
    console.error("seedDemoStore (insert):", err);
    return { error: "Could not create the demo store." };
  }

  const result = await applyTheme(storeId, theme.id, {
    publish: true,
    reset: true,
    // A demo store IS the showcase — its whole job is to look like a finished
    // shop, so its sample catalogue must be live. Real merchant stores seed
    // these as drafts (see applyTheme's publishSampleProducts).
    publishSampleProducts: true,
  });

  revalidateTag(STORE_TAG, "max");
  if (!result.success) {
    return {
      success: true,
      slug,
      warnings: result.errors,
    };
  }
  return { success: true, slug };
}

// ── Plan pricing (platform superadmin) ──────────────────────────────────────
// Prices were compiled into lib/plans.ts, so moving one meant a deploy. These
// let an operator set them from the console; lib/plans/pricing.ts folds the
// stored rows onto the code defaults, so an empty table behaves exactly as
// before and a failed read falls back to the constants rather than to nothing.
//
// EXISTING SUBSCRIBERS ARE NOT REPRICED. lib/payments/subscription.ts keys its
// Razorpay plan cache on (plan, period, amountPaise), so a new price mints a
// NEW Razorpay plan and anyone already subscribed keeps the amount they agreed
// to. That grandfathering is deliberate.

/** A sane ceiling. Guards a typo — a trailing zero on a price page is the kind
 *  of mistake that is only noticed by the first person who refuses to pay. */
const MAX_PLAN_PRICE_INR = 500_000;

export interface PlanPriceInput {
  plan: string;
  monthlyInr: number;
  yearlyInr: number;
  /** Struck-through list price. Null / 0 / blank clears the offer. */
  baseMonthlyInr: number | null;
  baseYearlyInr: number | null;
}

export async function getPlanPricingForConsole(): Promise<
  { pricing: PlanPricing } | { error: string }
> {
  const viewer = await getPlatformViewer();
  if (!viewer) return { error: "Not authorized." };
  // Live, not cached: an operator editing prices must see what is stored, not
  // what the public page happens to be serving.
  return { pricing: await getPlanPricingLive() };
}

export async function savePlanPricing(
  input: PlanPriceInput[],
): Promise<ActionResult> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can change pricing." };
  }
  if (!Array.isArray(input) || input.length === 0) {
    return { error: "Nothing to save." };
  }

  const rows: {
    plan: string;
    monthlyInr: number;
    yearlyInr: number;
    baseMonthlyInr: number | null;
    baseYearlyInr: number | null;
    updatedBy: string | null;
  }[] = [];

  for (const p of input) {
    if (!(PLAN_IDS as readonly string[]).includes(p.plan)) {
      return { error: `Unknown plan: ${p.plan}` };
    }
    const num = (v: unknown, label: string): number | { error: string } => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > MAX_PLAN_PRICE_INR) {
        return {
          error: `${label} must be a whole number between 0 and ${MAX_PLAN_PRICE_INR}.`,
        };
      }
      return n;
    };
    const monthly = num(p.monthlyInr, `${p.plan} monthly price`);
    if (typeof monthly !== "number") return monthly;
    const yearly = num(p.yearlyInr, `${p.plan} yearly price`);
    if (typeof yearly !== "number") return yearly;

    // A blank or zero base means "no offer running" — not a free list price.
    const baseM =
      p.baseMonthlyInr === null || Number(p.baseMonthlyInr) === 0
        ? null
        : num(p.baseMonthlyInr, `${p.plan} base monthly price`);
    if (baseM !== null && typeof baseM !== "number") return baseM;
    const baseY =
      p.baseYearlyInr === null || Number(p.baseYearlyInr) === 0
        ? null
        : num(p.baseYearlyInr, `${p.plan} base yearly price`);
    if (baseY !== null && typeof baseY !== "number") return baseY;

    // The DB has a CHECK for this too; catching it here gives the operator a
    // sentence instead of a constraint violation.
    if (baseM !== null && baseM < monthly) {
      return {
        error: `${p.plan}: the struck-through price must be at least the price you charge.`,
      };
    }
    if (baseY !== null && baseY < yearly) {
      return {
        error: `${p.plan}: the struck-through yearly price must be at least the yearly price.`,
      };
    }

    rows.push({
      plan: p.plan,
      monthlyInr: monthly,
      yearlyInr: yearly,
      baseMonthlyInr: baseM,
      baseYearlyInr: baseY,
      updatedBy: viewer.email ?? null,
    });
  }

  try {
    await withService(async (db) => {
      for (const r of rows) {
        await db
          .insert(planPrices)
          .values(r)
          .onConflictDoUpdate({
            target: planPrices.plan,
            set: {
              monthlyInr: r.monthlyInr,
              yearlyInr: r.yearlyInr,
              baseMonthlyInr: r.baseMonthlyInr,
              baseYearlyInr: r.baseYearlyInr,
              updatedBy: r.updatedBy,
              updatedAt: new Date().toISOString(),
            },
          });
      }
    });
  } catch (error) {
    logError("savePlanPricing failed", error);
    return { error: "Couldn't save pricing. Please try again." };
  }

  // Public pages read through a cached loader — without this the change would
  // not show until the 5-minute window lapsed, which is not "real time".
  bustPlanPricing();
  revalidatePath("/platform");
  revalidatePath("/platform/pos");
  revalidatePath("/dashboard/plans");
  return { success: true };
}
