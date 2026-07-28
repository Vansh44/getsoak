import "server-only";

// ---------------------------------------------------------------------------
// Reading and publishing legal documents, and recording consent.
//
// THE ONE RULE HERE: acceptance is written by the SERVER, from what the server
// observed — never from a client claiming it agreed. A checkbox is a UI
// affordance; the evidence is a row the server wrote with the request's own IP
// and user agent at the moment the account was created.
// ---------------------------------------------------------------------------

import { and, desc, eq, inArray } from "drizzle-orm";
import { headers } from "next/headers";
import { unstable_cache, revalidateTag } from "next/cache";
import { withAnon, withService } from "@/lib/db/client";
import { legalAcceptances, legalDocuments } from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import { LEGAL_CONTENT, type LegalContent } from "./content";
import { checksumBody, signupRequiredDocs, type LegalKind } from "./documents";

/**
 * Cache tag for the CURRENT-version list.
 *
 * Only the re-acceptance gate reads through the cache (see
 * getSignupDocsCached). Busted by publishLegalVersion, which is the one thing
 * that can change which version is in force.
 */
export const LEGAL_TAG = "legal:documents";

export interface PublishedDoc {
  id: string;
  kind: string;
  version: number;
  title: string;
  body: string;
  /**
   * sha256 of the body at publish time. Lets the publish script detect a body
   * edited WITHOUT a version bump — otherwise that edit silently does nothing
   * and whoever made it believes the policy changed.
   */
  checksum: string;
  effectiveAt: string;
}

/**
 * The version currently in force for a document kind, or null.
 *
 * Uncached on purpose: this is read on the consent path, and serving a stale
 * "current version" would mean recording an acceptance against a document that
 * is no longer the one being shown.
 */
export async function getCurrentDoc(
  kind: string,
): Promise<PublishedDoc | null> {
  try {
    const rows = await withAnon((db) =>
      db
        .select({
          id: legalDocuments.id,
          kind: legalDocuments.kind,
          version: legalDocuments.version,
          title: legalDocuments.title,
          body: legalDocuments.body,
          checksum: legalDocuments.checksum,
          effectiveAt: legalDocuments.effectiveAt,
        })
        .from(legalDocuments)
        .where(
          and(
            eq(legalDocuments.kind, kind),
            eq(legalDocuments.isCurrent, true),
          ),
        )
        .limit(1),
    );
    return rows[0] ?? null;
  } catch (error) {
    logError("legal: current doc read failed", error, { kind });
    return null;
  }
}

/** Every document a new account must accept, in registry order. */
export async function getSignupDocs(): Promise<PublishedDoc[]> {
  const kinds = signupRequiredDocs().map((d) => d.kind);
  if (kinds.length === 0) return [];
  try {
    const rows = await withAnon((db) =>
      db
        .select({
          id: legalDocuments.id,
          kind: legalDocuments.kind,
          version: legalDocuments.version,
          title: legalDocuments.title,
          body: legalDocuments.body,
          checksum: legalDocuments.checksum,
          effectiveAt: legalDocuments.effectiveAt,
        })
        .from(legalDocuments)
        .where(
          and(
            inArray(legalDocuments.kind, kinds),
            eq(legalDocuments.isCurrent, true),
          ),
        ),
    );
    // Registry order, not query order — the consent sentence reads
    // "Terms and Privacy Policy" in a fixed order.
    return kinds
      .map((k) => rows.find((r) => r.kind === k))
      .filter((r): r is PublishedDoc => Boolean(r));
  } catch (error) {
    logError("legal: signup docs read failed", error);
    return [];
  }
}

/**
 * The same list, read through a short cache. For the RE-ACCEPTANCE GATE only.
 *
 * The gate runs on every dashboard page load, so an uncached read would add a
 * query to every one. It can tolerate being a minute stale — the worst case is
 * a merchant being asked to accept a new version a minute later than they
 * could have been.
 *
 * The consent WRITE path deliberately does NOT use this: recording an
 * acceptance against a version that has since been superseded would produce
 * exactly the wrong evidence, which is the one thing this whole feature exists
 * to avoid. Busted immediately by publishLegalVersion anyway.
 */
const readSignupDocsCached = unstable_cache(
  async () => getSignupDocs(),
  ["legal:signup-docs"],
  { revalidate: 60, tags: [LEGAL_TAG] },
);

export async function getSignupDocsCached(): Promise<PublishedDoc[]> {
  try {
    return await readSignupDocsCached();
  } catch {
    // `unstable_cache` THROWS ("Invariant: incrementalCache missing") when
    // there is no render scope — a server action, a route handler, a script.
    // outstandingDocs is called from the dashboard layout (has one) AND from
    // acceptUpdatedPolicies (does not), so without this the accept button
    // rejected and the screen hung on "Saving…" forever.
    //
    // The cache is an OPTIMISATION, never an input to correctness: reading
    // straight through returns the same rows, just without the 60s reuse.
    return getSignupDocs();
  }
}

export interface ConsentContext {
  userId: string;
  email?: string | null;
  actorType: "merchant" | "customer";
  storeId?: string | null;
  context: "signup" | "signin" | "checkout" | "reaccept";
}

/**
 * Record that someone accepted the CURRENT version of every signup document.
 *
 * Best-effort by design: an account that exists without its consent row is a
 * problem to fix, but a consent write that fails and takes the signup down with
 * it is worse — the person is left with a half-created account and no way
 * forward. Failures are logged loudly.
 *
 * Idempotent: the (user_id, document_id) unique index means re-running is a
 * no-op rather than a duplicate.
 */
export async function recordSignupConsent(ctx: ConsentContext): Promise<void> {
  const docs = await getSignupDocs();
  if (docs.length === 0) {
    // Nothing published yet. Say so loudly: an account was created with no
    // recorded agreement to anything, which is exactly what this exists to stop.
    logError("legal: no published documents to accept", null, {
      userId: ctx.userId,
    });
    return;
  }

  // The evidence. Read from the REQUEST, not from anything the client sent.
  let ip: string | null = null;
  let userAgent: string | null = null;
  try {
    const h = await headers();
    ip =
      h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      h.get("x-real-ip") ||
      null;
    userAgent = h.get("user-agent");
  } catch {
    // No request scope (a script, a test) — the row is still worth writing.
  }

  try {
    await withService((db) =>
      db
        .insert(legalAcceptances)
        .values(
          docs.map((doc) => ({
            documentId: doc.id,
            kind: doc.kind,
            version: doc.version,
            userId: ctx.userId,
            email: ctx.email?.slice(0, 320) ?? null,
            actorType: ctx.actorType,
            storeId: ctx.storeId ?? null,
            context: ctx.context,
            ip: ip?.slice(0, 60) ?? null,
            userAgent: userAgent?.slice(0, 400) ?? null,
          })),
        )
        .onConflictDoNothing(),
    );
  } catch (error) {
    logError("legal: consent write failed", error, { userId: ctx.userId });
  }
}

/**
 * Which required documents this person has NOT accepted at their current
 * version. Empty means they're up to date — the question the re-acceptance
 * gate asks after a version bump.
 */
export async function outstandingDocs(userId: string): Promise<PublishedDoc[]> {
  const docs = await getSignupDocsCached();
  if (docs.length === 0) return [];
  try {
    const accepted = await withService((db) =>
      db
        .select({ documentId: legalAcceptances.documentId })
        .from(legalAcceptances)
        .where(
          and(
            eq(legalAcceptances.userId, userId),
            inArray(
              legalAcceptances.documentId,
              docs.map((d) => d.id),
            ),
          ),
        ),
    );
    const seen = new Set(accepted.map((a) => a.documentId));
    return docs.filter((d) => !seen.has(d.id));
  } catch (error) {
    // Fail OPEN: a DB hiccup must not lock every merchant out of their
    // dashboard behind a consent screen they can't get past.
    logError("legal: outstanding check failed, allowing through", error, {
      userId,
    });
    return [];
  }
}

/**
 * Publish version 1 of each policy if that kind has no current version.
 *
 * Idempotent and additive — it never edits a published row (the DB forbids it
 * anyway), so running it twice is a no-op. Mirrors ensureHomepage() for
 * store_pages: the product needs these rows to exist before anyone can agree
 * to them, so seeding is part of the code rather than a manual step someone
 * forgets on a fresh environment.
 */
export interface PublishOutcome {
  kind: string;
  /** "published" | "unchanged" (already current) | "error". */
  status: "published" | "unchanged" | "error";
  fromVersion: number | null;
  toVersion: number;
  message?: string;
}

/**
 * Publish a NEW version of a policy, retiring whatever is current.
 *
 * This is the ONLY way to change a published policy. The DB forbids editing a
 * published row (legal_documents_guard) because an acceptance is worthless if
 * the text behind it can move — so "editing the terms" is always: write a new
 * version, point `is_current` at it, and leave the old one in place for the
 * people who accepted it.
 *
 * THE RETIRE AND THE INSERT ARE ONE TRANSACTION, and they must be. The partial
 * unique index (legal_documents_current_key) allows exactly one current version
 * per kind, so inserting before retiring would violate it — and retiring
 * without inserting, if the process died between the two, would leave the
 * policy with NO current version at all: the signup consent screen would have
 * nothing to name and `recordSignupConsent` would log "no published documents"
 * for every new account. withService wraps the callback in BEGIN/COMMIT, so
 * either both land or neither does.
 *
 * Refuses to go backwards or sideways: the new version must be strictly higher
 * than the current one. Re-running with an unchanged version is a no-op, not an
 * error, so the script is safe to run twice.
 */
export async function publishLegalVersion(
  content: LegalContent,
  publishedBy = "script",
): Promise<PublishOutcome> {
  const current = await getCurrentDoc(content.kind);
  const fromVersion = current?.version ?? null;

  if (current && content.version <= current.version) {
    return {
      kind: content.kind,
      status: "unchanged",
      fromVersion,
      toVersion: content.version,
      message:
        content.version === current.version
          ? `v${current.version} is already current`
          : `refusing to go backwards: v${content.version} is older than the current v${current.version}`,
    };
  }

  try {
    const checksum = await checksumBody(content.body);
    await withService(async (db) => {
      // Order matters: retire first, or the partial unique index rejects the
      // insert. Sequential await, not Promise.all — one pooled connection.
      if (current) {
        await db
          .update(legalDocuments)
          .set({ isCurrent: false })
          .where(eq(legalDocuments.id, current.id));
      }
      await db.insert(legalDocuments).values({
        kind: content.kind,
        version: content.version,
        title: content.title,
        body: content.body,
        checksum,
        isCurrent: true,
        publishedAt: new Date().toISOString(),
        createdBy: publishedBy,
      });
    });

    // The gate must ask people about the new version now, not in a minute.
    try {
      revalidateTag(LEGAL_TAG, "max");
    } catch {
      // No request scope (a script) — nothing is cached there to bust.
    }

    return {
      kind: content.kind,
      status: "published",
      fromVersion,
      toVersion: content.version,
    };
  } catch (error) {
    logError("legal: publish failed", error, {
      kind: content.kind,
      version: content.version,
    });
    return {
      kind: content.kind,
      status: "error",
      fromVersion,
      toVersion: content.version,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Every version of a kind, newest first — the history an operator audits. */
export async function listLegalVersions(kind: string): Promise<
  {
    id: string;
    version: number;
    checksum: string;
    isCurrent: boolean;
    publishedAt: string | null;
  }[]
> {
  try {
    return await withService((db) =>
      db
        .select({
          id: legalDocuments.id,
          version: legalDocuments.version,
          checksum: legalDocuments.checksum,
          isCurrent: legalDocuments.isCurrent,
          publishedAt: legalDocuments.publishedAt,
        })
        .from(legalDocuments)
        .where(eq(legalDocuments.kind, kind))
        .orderBy(desc(legalDocuments.version)),
    );
  } catch (error) {
    logError("legal: version list failed", error, { kind });
    return [];
  }
}

export async function ensureLegalSeeded(): Promise<{ published: string[] }> {
  const published: string[] = [];
  for (const doc of LEGAL_CONTENT) {
    try {
      const existing = await getCurrentDoc(doc.kind);
      if (existing) continue;

      const checksum = await checksumBody(doc.body);
      await withService((db) =>
        db
          .insert(legalDocuments)
          .values({
            kind: doc.kind,
            version: doc.version,
            title: doc.title,
            body: doc.body,
            checksum,
            isCurrent: true,
            publishedAt: new Date().toISOString(),
            createdBy: "seed",
          })
          .onConflictDoNothing(),
      );
      published.push(`${doc.kind} v${doc.version}`);
    } catch (error) {
      logError("legal: seed failed", error, { kind: doc.kind });
    }
  }
  return { published };
}

export type { LegalKind };
