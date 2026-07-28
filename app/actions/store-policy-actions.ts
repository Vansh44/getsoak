"use server";

// ---------------------------------------------------------------------------
// A store's own policies, edited at Settings → Policies.
//
// These write ORDINARY store_pages rows, at the slugs the storefront footer
// already links to. That is the whole design decision: the website builder
// already renders, routes and revalidates pages, so a policy editor is a
// focused FORM over that, not a second content system. A merchant who wants
// full control can still open the same page in the builder afterwards.
//
// Saving publishes immediately. A policy that exists only as a draft is a
// broken footer link and a shopper who can't read what they're agreeing to —
// there is no useful "draft refund policy" state.
// ---------------------------------------------------------------------------

import { and, eq } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { withService } from "@/lib/db/client";
import { storePages } from "@/drizzle/schema";
import { getManagerUserId, getActingStoreId } from "@/app/dashboard/lib/access";
import { TAGS } from "@/lib/storefront/tags";
import { sanitizeBlogContent } from "@/lib/sanitize";
import {
  POLICY_HEADING_SECTION_ID,
  POLICY_BODY_SECTION_ID,
  policyBodyHtml,
} from "@/lib/legal/policy-text";
import { STORE_POLICIES, getStorePolicyDef } from "@/lib/legal/store-policies";
import {
  getLivePolicies,
  getCheckoutPolicies,
} from "@/lib/legal/store-consent";
import { getCurrentStoreId } from "@/lib/store/resolve";
import type { PageSectionItem } from "@/lib/sections/registry";

export interface StorePolicyState {
  kind: string;
  slug: string;
  title: string;
  description: string;
  /** The merchant's HTML, or "" when they haven't written one yet. */
  html: string;
  /** Published and non-empty — i.e. a shopper can actually read it. */
  live: boolean;
  updatedAt: string | null;
}

export interface PolicyResult {
  success?: boolean;
  error?: string;
}

/**
 * A policy page: a heading, then the merchant's text.
 *
 * The HEADING is its own section because a page renders only its sections —
 * `store_pages.title` is metadata, and shows in the browser tab, not on the
 * page. Without this a policy opened as a link is a wall of text with nothing
 * saying which policy it is. Keeping it separate from the body is what lets
 * the plain-text editor keep working (see policy-text.ts).
 *
 * `enabled` is REQUIRED and load-bearing: the storefront renderer filters on
 * `sections.filter((s) => s.enabled)`, so a section without it is silently
 * dropped and the page renders empty. No cast here — the annotation is what
 * makes the compiler check every required field.
 */
function policySections(title: string, html: string): PageSectionItem[] {
  return [
    {
      id: POLICY_HEADING_SECTION_ID,
      type: "rich_text",
      enabled: true,
      config: {
        html: `<h1>${escapeText(title)}</h1>`,
        width: "contained",
      },
    },
    {
      id: POLICY_BODY_SECTION_ID,
      type: "rich_text",
      enabled: true,
      config: { html, width: "contained" },
    },
  ];
}

const TEXT_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};
const escapeText = (text: string) =>
  text.replace(/[&<>]/g, (c) => TEXT_ESCAPES[c]);

export interface PolicyLink {
  slug: string;
  label: string;
}

/**
 * The store's LIVE policies, for a consent sentence to name and link.
 *
 * Public on purpose — it runs on the storefront for a shopper who may not have
 * an account yet, and it returns nothing a visitor can't already read by
 * clicking the footer. It exposes titles and slugs only, never the bodies:
 * hashing those is the server's job (lib/legal/store-consent.ts).
 *
 * `scope: "checkout"` narrows to the policies that bind at the moment money
 * moves — payment and refund terms — rather than naming the privacy policy in
 * a sentence about paying.
 */
export async function getPolicyLinks(
  scope: "all" | "checkout" = "all",
): Promise<PolicyLink[]> {
  const storeId = await getCurrentStoreId();
  const live =
    scope === "checkout"
      ? await getCheckoutPolicies(storeId)
      : await getLivePolicies(storeId);
  return live.map((p) => ({ slug: p.slug, label: p.shortLabel }));
}

/** Every policy in the registry, with whatever the store has written so far. */
export async function getStorePolicies(): Promise<StorePolicyState[]> {
  const userId = await getManagerUserId("settings");
  if (!userId) return [];
  const storeId = await getActingStoreId();

  let rows: {
    slug: string;
    status: string;
    sections: unknown;
    publishedSections: unknown;
    updatedAt: string | null;
  }[] = [];
  try {
    rows = await withService((db) =>
      db
        .select({
          slug: storePages.slug,
          status: storePages.status,
          sections: storePages.sections,
          publishedSections: storePages.publishedSections,
          updatedAt: storePages.updatedAt,
        })
        .from(storePages)
        .where(eq(storePages.storeId, storeId)),
    );
  } catch (err) {
    console.error("getStorePolicies error:", err);
    return [];
  }

  const bySlug = new Map(rows.map((r) => [r.slug, r]));

  return STORE_POLICIES.map((def) => {
    const row = bySlug.get(def.slug);
    // Read the DRAFT column: it's what the editor last saved, and saving here
    // publishes both, so they agree. A page edited in the builder afterwards
    // shows its current draft, which is what the merchant expects to see.
    const html = row ? policyBodyHtml(row.sections) : "";
    const publishedHtml = row ? policyBodyHtml(row.publishedSections) : "";
    return {
      kind: def.kind,
      slug: def.slug,
      title: def.title,
      description: def.description,
      html,
      live: row?.status === "published" && publishedHtml.trim().length > 0,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

/**
 * Write one policy and publish it.
 *
 * Upsert on (store_id, slug): the page may not exist yet (a new store gets
 * none), may exist empty from a theme, or may already hold an older version.
 */
export async function saveStorePolicy(
  kind: string,
  rawHtml: string,
): Promise<PolicyResult> {
  const userId = await getManagerUserId("settings");
  if (!userId) return { error: "Not authorised." };

  const def = getStorePolicyDef(kind);
  if (!def) return { error: "Unknown policy." };

  const storeId = await getActingStoreId();
  // Same trust model as blog and page content: sanitized on write AND on
  // render. A policy is merchant-authored HTML like any other.
  const html = sanitizeBlogContent(rawHtml ?? "");

  if (html.length > 200_000) {
    return { error: "That policy is too long. Please shorten it." };
  }

  const sections = policySections(def.title, html);
  const isEmpty = html.replace(/<[^>]*>/g, "").trim().length === 0;

  try {
    const existing = await withService((db) =>
      db
        .select({ id: storePages.id })
        .from(storePages)
        .where(
          and(eq(storePages.storeId, storeId), eq(storePages.slug, def.slug)),
        )
        .limit(1),
    );

    if (existing[0]) {
      await withService((db) =>
        db
          .update(storePages)
          .set({
            title: def.title,
            sections,
            publishedSections: sections,
            // Emptying a policy UNPUBLISHES it rather than leaving a blank page
            // live — a blank refund policy is worse than an absent one.
            status: isEmpty ? "draft" : "published",
            publishedAt: isEmpty ? null : new Date().toISOString(),
            updatedBy: userId,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(storePages.id, existing[0].id)),
      );
    } else {
      if (isEmpty) return { success: true }; // nothing to create
      await withService((db) =>
        db.insert(storePages).values({
          storeId,
          slug: def.slug,
          title: def.title,
          status: "published",
          sections,
          publishedSections: sections,
          publishedAt: new Date().toISOString(),
          createdBy: userId,
          updatedBy: userId,
        }),
      );
    }

    revalidatePath(`/${def.slug}`);
    revalidatePath("/dashboard/settings/policies");
    revalidateTag(TAGS.pages, "max");
    return { success: true };
  } catch (err) {
    console.error("saveStorePolicy error:", err);
    return { error: "Could not save. Please try again." };
  }
}
