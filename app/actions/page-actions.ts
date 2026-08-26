"use server";

import { and, desc, eq, ne } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { after } from "next/server";
import { withService } from "@/lib/db/client";
import { storePages } from "@/drizzle/schema";
import { getManagerUserId, getActingStoreId } from "@/app/dashboard/lib/access";
import { emitEvent } from "@/lib/notifications/record";
import { getStoreOriginById } from "@/lib/site";
import { notifyStoreContentPublished } from "@/lib/seo/store-indexing";
import { TAGS } from "@/lib/storefront/tags";
import { getStoreSetting } from "@/lib/settings/resolve";
import { sanitizeBlogContent } from "@/lib/sanitize";
import {
  validatePageSlug,
  validateSections,
  type PageSectionItem,
  type RichTextConfig,
  type ValidateMode,
} from "@/lib/sections/registry";

// ---------------------------------------------------------------------------
// Website-builder page actions.
//
// All reads/writes use the SERVICE scope because the draft `sections` column
// is revoked from anon+authenticated at the DB layer (see store_pages.sql) —
// RLS/column grants can't be the gate here. So getManagerUserId("builder") IS
// the trust boundary, and every query is explicitly scoped by store_id (the
// service scope bypasses RLS). Never select or return draft `sections` to a
// caller that hasn't passed this gate.
// ---------------------------------------------------------------------------

export interface ActionResult {
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

/** Builder list-row shape (no draft sections). */
export interface PageListItem {
  id: string;
  slug: string;
  title: string;
  status: "draft" | "published";
  updated_at: string;
  published_at: string | null;
}

/** Full draft page for the builder editor (includes draft sections). */
export interface PageDraft extends PageListItem {
  seo_title: string;
  seo_description: string;
  seo_noindex: boolean;
  sections: PageSectionItem[];
}

// Aliased select preserving the snake_case list-row shape.
const PAGE_LIST_COLUMNS = {
  id: storePages.id,
  slug: storePages.slug,
  title: storePages.title,
  status: storePages.status,
  updated_at: storePages.updatedAt,
  published_at: storePages.publishedAt,
};

function revalidatePage(slug: string) {
  revalidatePath("/dashboard/builder");
  if (slug) revalidatePath(`/${slug}`);
  revalidateTag(TAGS.pages, "max");
}

/**
 * Validate + process a draft sections array for saving: shape/size via the
 * registry, then the cross-cutting server rules — reject custom_code when the
 * store setting is off, and sanitize rich_text HTML. Returns clean items or an
 * error. mode "draft" (autosave) skips completeness rules so a mid-edit save
 * never fails; "publish" is strict.
 */
async function processSections(
  raw: unknown,
  mode: ValidateMode = "publish",
  retainedRaw: unknown = [],
): Promise<{ sections: PageSectionItem[] } | { error: string }> {
  const result = validateSections(raw, { mode });
  if ("error" in result) return result;

  const hasCustomCode = result.sections.some((s) => s.type === "custom_code");
  if (hasCustomCode && !(await getStoreSetting("pages.customCode"))) {
    // A downgrade must not make the rest of a page impossible to save. Keep
    // previously stored custom-code sections byte-for-byte equivalent after
    // normalisation, while still rejecting newly-added or edited paid
    // sections. Merchants may deliberately remove a locked section.
    const retained = validateSections(retainedRaw, { mode: "draft" });
    const retainedById = new Map(
      "sections" in retained
        ? retained.sections
            .filter((section) => section.type === "custom_code")
            .map((section) => [section.id, JSON.stringify(section)] as const)
        : [],
    );
    const changedLockedSection = result.sections.some(
      (section) =>
        section.type === "custom_code" &&
        retainedById.get(section.id) !== JSON.stringify(section),
    );
    if (changedLockedSection) {
      return {
        error:
          "Custom code is available on Basic and Pro. Existing custom-code sections can stay or be removed, but cannot be added or changed until you upgrade.",
      };
    }
  }

  const sections = result.sections.map((s) => {
    if (s.type === "rich_text") {
      const c = s.config as RichTextConfig;
      return { ...s, config: { ...c, html: sanitizeBlogContent(c.html) } };
    }
    return s;
  });
  return { sections };
}

// --- Reads (builder only) ---------------------------------------------------

export async function listPages(): Promise<PageListItem[]> {
  const userId = await getManagerUserId("builder");
  if (!userId) return [];
  const storeId = await getActingStoreId();
  try {
    const rows = await withService((db) =>
      db
        .select(PAGE_LIST_COLUMNS)
        .from(storePages)
        .where(
          and(eq(storePages.storeId, storeId), ne(storePages.slug, "")), // hide the homepage sentinel
        )
        .orderBy(desc(storePages.updatedAt)),
    );
    return rows as PageListItem[];
  } catch (err) {
    console.error("listPages error:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * The homepage is the store_pages row with the empty slug ("") — the "homepage
 * sentinel". It's edited in the builder like any page, but it's hidden from
 * listPages() and must always exist. This returns it, creating an empty draft
 * row on demand for stores that predate the homepage migration (or new stores
 * that skipped the seed). Never deletable/renamable (guarded in delete/meta).
 */
export async function ensureHomepage(): Promise<PageListItem | null> {
  const userId = await getManagerUserId("builder");
  if (!userId) return null;
  const storeId = await getActingStoreId();

  try {
    const existingRows = await withService((db) =>
      db
        .select(PAGE_LIST_COLUMNS)
        .from(storePages)
        .where(and(eq(storePages.storeId, storeId), eq(storePages.slug, "")))
        .limit(1),
    );
    if (existingRows[0]) return existingRows[0] as PageListItem;

    const [created] = await withService((db) =>
      db
        .insert(storePages)
        .values({
          storeId,
          slug: "",
          title: "Home",
          status: "draft",
          sections: [],
          publishedSections: [],
          createdBy: userId,
          updatedBy: userId,
        })
        .returning(PAGE_LIST_COLUMNS),
    );
    return (created as PageListItem) ?? null;
  } catch (err) {
    console.error(
      "ensureHomepage error:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function getPageDraft(id: string): Promise<PageDraft | null> {
  const userId = await getManagerUserId("builder");
  if (!userId) return null;
  const storeId = await getActingStoreId();
  try {
    const rows = await withService((db) =>
      db
        .select({
          ...PAGE_LIST_COLUMNS,
          seo_title: storePages.seoTitle,
          seo_description: storePages.seoDescription,
          seo_noindex: storePages.seoNoindex,
          sections: storePages.sections,
        })
        .from(storePages)
        .where(and(eq(storePages.storeId, storeId), eq(storePages.id, id)))
        .limit(1),
    );
    return (rows[0] as unknown as PageDraft | undefined) ?? null;
  } catch {
    return null;
  }
}

// --- Mutations --------------------------------------------------------------

export async function createPage(
  rawSlug: string,
  rawTitle: string,
): Promise<ActionResult> {
  const userId = await getManagerUserId("builder");
  if (!userId) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();

  const slugResult = validatePageSlug(rawSlug);
  if ("error" in slugResult) return { error: slugResult.error };
  const slug = slugResult.slug;
  const title = (rawTitle || "").trim() || slug;

  try {
    const existing = await withService((db) =>
      db
        .select({ id: storePages.id })
        .from(storePages)
        .where(and(eq(storePages.storeId, storeId), eq(storePages.slug, slug)))
        .limit(1),
    );
    if (existing[0])
      return { error: `A page with the slug "${slug}" already exists.` };

    const [created] = await withService((db) =>
      db
        .insert(storePages)
        .values({
          storeId,
          slug,
          title,
          status: "draft",
          sections: [],
          publishedSections: [],
          createdBy: userId,
          updatedBy: userId,
        })
        .returning({ id: storePages.id }),
    );

    revalidatePage(slug);
    return { success: true, data: { id: created.id } };
  } catch (err) {
    console.error(
      "createPage error:",
      err instanceof Error ? err.message : err,
    );
    return { error: "Could not create the page. Please try again." };
  }
}

export async function updatePageMeta(
  id: string,
  fields: {
    title?: string;
    slug?: string;
    seo_title?: string;
    seo_description?: string;
    seo_noindex?: boolean;
  },
): Promise<ActionResult> {
  const userId = await getManagerUserId("builder");
  if (!userId) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();

  const pageRows = await withService((db) =>
    db
      .select({ slug: storePages.slug })
      .from(storePages)
      .where(and(eq(storePages.storeId, storeId), eq(storePages.id, id)))
      .limit(1),
  ).catch(() => []);
  const page = pageRows[0];
  if (!page) return { error: "Page not found." };
  // The homepage sentinel's slug is immutable and it's never renamed here.
  const isHomepage = page.slug === "";

  const update: {
    updatedBy: string;
    slug?: string;
    title?: string;
    seoTitle?: string;
    seoDescription?: string;
    seoNoindex?: boolean;
  } = { updatedBy: userId };

  if (fields.slug !== undefined && !isHomepage) {
    const slugResult = validatePageSlug(fields.slug);
    if ("error" in slugResult) return { error: slugResult.error };
    if (slugResult.slug !== page.slug) {
      const clashRows = await withService((db) =>
        db
          .select({ id: storePages.id })
          .from(storePages)
          .where(
            and(
              eq(storePages.storeId, storeId),
              eq(storePages.slug, slugResult.slug),
            ),
          )
          .limit(1),
      ).catch(() => []);
      if (clashRows[0])
        return { error: `The slug "${slugResult.slug}" is taken.` };
      update.slug = slugResult.slug;
    }
  }
  if (fields.title !== undefined) update.title = fields.title.trim();
  if (fields.seo_title !== undefined) update.seoTitle = fields.seo_title.trim();
  if (fields.seo_description !== undefined)
    update.seoDescription = fields.seo_description.trim();
  if (fields.seo_noindex !== undefined)
    update.seoNoindex = !!fields.seo_noindex;

  try {
    await withService((db) =>
      db
        .update(storePages)
        .set(update)
        .where(and(eq(storePages.storeId, storeId), eq(storePages.id, id))),
    );
  } catch (err) {
    console.error(
      "updatePageMeta error:",
      err instanceof Error ? err.message : err,
    );
    return { error: "Could not save. Please try again." };
  }

  revalidatePage(update.slug ?? page.slug);
  return { success: true };
}

export async function savePageDraft(
  id: string,
  rawSections: unknown,
  expectedUpdatedAt?: string,
): Promise<ActionResult> {
  const userId = await getManagerUserId("builder");
  if (!userId) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();

  const pageRows = await withService((db) =>
    db
      .select({
        slug: storePages.slug,
        updated_at: storePages.updatedAt,
        sections: storePages.sections,
      })
      .from(storePages)
      .where(and(eq(storePages.storeId, storeId), eq(storePages.id, id)))
      .limit(1),
  ).catch(() => []);
  const page = pageRows[0];
  if (!page) return { error: "Page not found." };

  // Stale-tab guard: refuse to clobber edits saved from another tab/session.
  // data.stale lets the autosave hook distinguish this (hard block + reload)
  // from a transient failure (retry).
  if (expectedUpdatedAt && page.updated_at !== expectedUpdatedAt) {
    return {
      error:
        "This page was changed somewhere else. Reload the builder to get the latest version before saving.",
      data: { stale: true },
    };
  }

  // Draft mode: safety normalisation only — a half-configured section must
  // never make autosave fail (publish re-validates strictly).
  const processed = await processSections(rawSections, "draft", page.sections);
  if ("error" in processed) return { error: processed.error };

  // .returning() gives the trigger-stamped updated_at in the same round trip —
  // the client feeds it back as the next expectedUpdatedAt (stale-tab token).
  // No revalidatePath here: autosave fires every few seconds and the builder
  // list doesn't need per-keystroke freshness (create/publish/delete revalidate).
  try {
    const [saved] = await withService((db) =>
      db
        .update(storePages)
        .set({ sections: processed.sections, updatedBy: userId })
        .where(and(eq(storePages.storeId, storeId), eq(storePages.id, id)))
        .returning({ updated_at: storePages.updatedAt }),
    );
    return { success: true, data: { updated_at: saved.updated_at } };
  } catch (err) {
    console.error(
      "savePageDraft error:",
      err instanceof Error ? err.message : err,
    );
    return { error: "Could not save the draft. Please try again." };
  }
}

export async function publishPage(
  id: string,
  expectedUpdatedAt?: string,
): Promise<ActionResult> {
  const userId = await getManagerUserId("builder");
  if (!userId) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();

  const pageRows = await withService((db) =>
    db
      .select({
        slug: storePages.slug,
        sections: storePages.sections,
        updated_at: storePages.updatedAt,
      })
      .from(storePages)
      .where(and(eq(storePages.storeId, storeId), eq(storePages.id, id)))
      .limit(1),
  ).catch(() => []);
  const page = pageRows[0];
  if (!page) return { error: "Page not found." };

  // Same stale-tab guard as savePageDraft — publishing from a tab that hasn't
  // seen the latest draft would push someone else's half-finished edits live.
  if (expectedUpdatedAt && page.updated_at !== expectedUpdatedAt) {
    return {
      error:
        "This page was changed somewhere else. Reload the builder to get the latest version before publishing.",
      data: { stale: true },
    };
  }

  // Strict re-validation on publish (completeness rules + the custom-code
  // setting may have changed since the last draft save).
  const processed = await processSections(
    page.sections,
    "publish",
    page.sections,
  );
  if ("error" in processed) return { error: processed.error };

  let saved: { updated_at: string; published_at: string | null };
  try {
    [saved] = await withService((db) =>
      db
        .update(storePages)
        .set({
          publishedSections: processed.sections,
          sections: processed.sections,
          status: "published",
          publishedAt: new Date().toISOString(),
          updatedBy: userId,
        })
        .where(and(eq(storePages.storeId, storeId), eq(storePages.id, id)))
        .returning({
          updated_at: storePages.updatedAt,
          published_at: storePages.publishedAt,
        }),
    );
  } catch (err) {
    console.error(
      "publishPage error:",
      err instanceof Error ? err.message : err,
    );
    return { error: "Could not publish. Please try again." };
  }

  revalidatePage(page.slug);

  // Nudge search engines to re-crawl the just-published page (best-effort, off
  // the response path). Resolve by the durable acting store id, not request
  // Host: platform operators can publish while standing on the apex.
  const base = await getStoreOriginById(storeId).catch(() => null);
  const pageUrl = base
    ? page.slug
      ? `${base}/${page.slug}`
      : `${base}/`
    : page.slug
      ? `/${page.slug}`
      : "/";

  // The merchant has now published a page THEY edited, so the store is no
  // longer indistinguishable from the theme seed. Open it to search engines
  // and announce it — including its sitemap, which nothing else submits (the
  // one-time registration that used to happen at signup, now deferred to the
  // moment there is something worth registering). See lib/store/launch.ts.
  after(() =>
    notifyStoreContentPublished({
      storeId,
      paths: [page.slug ? `/${page.slug}` : "/", "/"],
    }),
  );

  emitEvent({
    type: "page.published",
    storeId,
    actor: { type: "admin", id: userId },
    subject: { type: "page", id, label: page.slug || "Home" },
    payload: { page: page.slug || "Home", url: pageUrl },
  });

  return {
    success: true,
    data: {
      updated_at: saved.updated_at,
      published_at: saved.published_at as string,
    },
  };
}

export async function unpublishPage(id: string): Promise<ActionResult> {
  const userId = await getManagerUserId("builder");
  if (!userId) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();

  const pageRows = await withService((db) =>
    db
      .select({ slug: storePages.slug })
      .from(storePages)
      .where(and(eq(storePages.storeId, storeId), eq(storePages.id, id)))
      .limit(1),
  ).catch(() => []);
  const page = pageRows[0];
  if (!page) return { error: "Page not found." };

  try {
    await withService((db) =>
      db
        .update(storePages)
        .set({ status: "draft", updatedBy: userId })
        .where(and(eq(storePages.storeId, storeId), eq(storePages.id, id))),
    );
  } catch (err) {
    console.error(
      "unpublishPage error:",
      err instanceof Error ? err.message : err,
    );
    return { error: "Could not unpublish. Please try again." };
  }

  revalidatePage(page.slug);
  return { success: true };
}

export async function deletePage(id: string): Promise<ActionResult> {
  const userId = await getManagerUserId("builder");
  if (!userId) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();

  const pageRows = await withService((db) =>
    db
      .select({ slug: storePages.slug })
      .from(storePages)
      .where(and(eq(storePages.storeId, storeId), eq(storePages.id, id)))
      .limit(1),
  ).catch(() => []);
  const page = pageRows[0];
  if (!page) return { error: "Page not found." };
  // The homepage sentinel is never deletable through the builder.
  if (page.slug === "") return { error: "The homepage can't be deleted." };

  try {
    await withService((db) =>
      db
        .delete(storePages)
        .where(and(eq(storePages.storeId, storeId), eq(storePages.id, id))),
    );
  } catch (err) {
    console.error(
      "deletePage error:",
      err instanceof Error ? err.message : err,
    );
    return { error: "Could not delete the page. Please try again." };
  }

  revalidatePage(page.slug);
  return { success: true };
}
