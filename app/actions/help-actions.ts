"use server";

// Help Centre server actions.
//
//   Public (anon):   search suggestions, view-count bump, "was this helpful"
//                     vote. All go through withAnon + the SECURITY DEFINER
//                     RPCs, so no write policy is opened to the public.
//   Operator (gated): full CRUD for articles + categories, publish/unpublish,
//                     reorder, and AI drafting. Gated by getPlatformViewer()
//                     (the platform_admins allowlist) exactly like platform.ts,
//                     then run under withService (BYPASSRLS) — help docs are
//                     platform-global, so there is no store to scope to.
//
// The help centre is platform-global: no store_id anywhere.

import { readFile } from "fs/promises";
import path from "path";
import { revalidateTag } from "next/cache";
import { after } from "next/server";
import { headers } from "next/headers";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  like,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { withAnon, withService } from "@/lib/db/client";
import { helpArticles, helpCategories } from "@/drizzle/schema";
import { getServerUser } from "@/lib/auth/server-user";
import { getPlatformViewer } from "@/app/actions/platform";
import { slugify } from "@/lib/slug";
import { sanitizeBlogContent } from "@/lib/sanitize";
import {
  deleteStorageUrls,
  extractMediaUrlsFromHtml,
} from "@/lib/storage/cleanup";
import { callGemini } from "@/lib/ai/gemini";
import { pingIndexNow } from "@/lib/seo/search-engines";
import { SEARCH_INDEXABLE } from "@/lib/store/host";
import { HELP_URL } from "@/lib/site";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { TAGS } from "@/lib/storefront/tags";
import { searchHelpArticles, getHelpCategories } from "@/lib/help/queries";
import {
  toHelpArticle,
  toHelpCard,
  toHelpCategory,
  type HelpArticle,
  type HelpArticleCard,
  type HelpCategory,
  type HelpStatus,
} from "@/lib/help/types";

type ActionResult<T = void> = { success?: boolean; error?: string; data?: T };

export interface HelpArticleInput {
  title: string;
  slug: string;
  categoryId: string | null;
  excerpt: string;
  body: string;
  status: HelpStatus;
  seoTitle: string;
  seoDescription: string;
}

export interface HelpCategoryInput {
  slug: string;
  title: string;
  description: string;
  icon: string;
}

// ─────────────────────────────── PUBLIC ────────────────────────────────────

export interface HelpSuggestion {
  title: string;
  url: string;
  excerpt: string | null;
}

/** Search-box live suggestions: top matches as {title, url, excerpt}. */
export async function suggestHelpArticles(
  query: string,
): Promise<HelpSuggestion[]> {
  const cards = await searchHelpArticles(query, 6);
  if (cards.length === 0) return [];
  const cats = await getHelpCategories();
  const bySlug = new Map(cats.map((c) => [c.id, c.slug]));
  return cards
    .map((c) => {
      const catSlug = c.categoryId ? bySlug.get(c.categoryId) : undefined;
      if (!catSlug) return null;
      return {
        title: c.title,
        url: `/help/${catSlug}/${c.slug}`,
        excerpt: c.excerpt,
      };
    })
    .filter((s): s is HelpSuggestion => s !== null);
}

/** Bump an article's view count (fire-and-forget; published-only in the RPC). */
export async function recordHelpArticleView(id: string): Promise<void> {
  if (!id) return;
  // Public + anon: throttle per IP so view_count — which drives the Popular
  // ordering AND search ranking — can't be inflated by scripted requests. The
  // cap is generous (genuine browsing is fine); on throttle we silently skip,
  // since view counting is best-effort. rateLimit fails open on DB hiccups.
  const { allowed } = await rateLimit(
    `help:view:${clientIp(await headers())}`,
    {
      max: 200,
      windowSeconds: 3600,
    },
  );
  if (!allowed) return;
  try {
    await withAnon((db) => db.execute(sql`SELECT help_article_view(${id})`));
  } catch {
    /* view counting is best-effort — never surface an error to the reader */
  }
}

/** Record a "was this helpful?" vote (published-only in the RPC). */
export async function voteHelpArticle(
  id: string,
  helpful: boolean,
): Promise<ActionResult> {
  if (!id) return { error: "Missing article." };
  // Public + anon: throttle per IP. The widget already dedups one vote per
  // article per browser client-side; this backstops scripted ratio-skewing of
  // helpful_yes/no. On throttle, return success WITHOUT writing so a genuine
  // reader (who votes at most a handful of times) is never shown an error.
  const { allowed } = await rateLimit(
    `help:vote:${clientIp(await headers())}`,
    {
      max: 20,
      windowSeconds: 3600,
    },
  );
  if (!allowed) return { success: true };
  try {
    await withAnon((db) =>
      db.execute(sql`SELECT help_article_vote(${id}, ${helpful})`),
    );
    // NOTE: deliberately no revalidateTag here. This action is PUBLIC + anon,
    // so busting the whole help cache on every vote let any visitor force
    // repeated full invalidation (DoS amplifier). Helpful counts are
    // operator-facing analytics with no reader-visible cache dependency (the
    // widget confirms the vote client-side), so eventual consistency is fine —
    // matching recordHelpArticleView, which also doesn't revalidate.
    return { success: true };
  } catch {
    return { error: "Could not record your feedback." };
  }
}

// ────────────────────────────── OPERATOR ───────────────────────────────────

async function requireOperator(): Promise<{
  uid: string;
  email: string | null;
} | null> {
  const viewer = await getPlatformViewer();
  if (!viewer) return null;
  const user = await getServerUser();
  if (!user) return null;
  return { uid: user.id, email: user.email };
}

const MAX_SLUG_ATTEMPTS = 20;

// Resolve a globally-unique article slug from a base, appending -2, -3… on
// collision. The unique index is the real guarantee; this just avoids the
// common case. `excludeId` lets an edit keep its own slug.
async function resolveHelpSlug(
  base: string,
  excludeId?: string,
): Promise<string> {
  const root = slugify(base) || "article";
  const taken = await withService((db) =>
    db
      .select({ slug: helpArticles.slug, id: helpArticles.id })
      .from(helpArticles)
      .where(like(helpArticles.slug, `${root}%`)),
  ).catch(() => [] as { slug: string; id: string }[]);
  const used = new Set(
    taken.filter((r) => r.id !== excludeId).map((r) => r.slug),
  );
  if (!used.has(root)) return root;
  for (let n = 2; n <= MAX_SLUG_ATTEMPTS; n++) {
    const candidate = `${root}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${root}-${Date.now()}`;
}

function nowIso() {
  return new Date().toISOString();
}

const ARTICLE_ADMIN_COLS = {
  id: helpArticles.id,
  categoryId: helpArticles.categoryId,
  slug: helpArticles.slug,
  title: helpArticles.title,
  excerpt: helpArticles.excerpt,
  status: helpArticles.status,
  position: helpArticles.position,
  viewCount: helpArticles.viewCount,
  helpfulYes: helpArticles.helpfulYes,
  helpfulNo: helpArticles.helpfulNo,
  updatedAt: helpArticles.updatedAt,
  publishedAt: helpArticles.publishedAt,
};

/** Operator list — every status, optional text/category/status filters. */
export async function listHelpArticlesAdmin(opts?: {
  q?: string;
  categoryId?: string;
  status?: HelpStatus;
}): Promise<HelpArticleCard[]> {
  if (!(await requireOperator())) return [];
  const filters: SQL[] = [];
  if (opts?.q) {
    const pat = `%${opts.q}%`;
    const m = or(ilike(helpArticles.title, pat), ilike(helpArticles.slug, pat));
    if (m) filters.push(m);
  }
  if (opts?.categoryId)
    filters.push(eq(helpArticles.categoryId, opts.categoryId));
  if (opts?.status) filters.push(eq(helpArticles.status, opts.status));
  const rows = await withService((db) =>
    db
      .select(ARTICLE_ADMIN_COLS)
      .from(helpArticles)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(helpArticles.position), desc(helpArticles.updatedAt)),
  ).catch(() => []);
  return rows.map(toHelpCard);
}

/** Full article row (incl. body) for the editor. */
export async function getHelpArticleForEditor(
  id: string,
): Promise<HelpArticle | null> {
  if (!(await requireOperator())) return null;
  const rows = await withService((db) =>
    db.select().from(helpArticles).where(eq(helpArticles.id, id)).limit(1),
  ).catch(() => []);
  return rows[0] ? toHelpArticle(rows[0]) : null;
}

function cleanInput(input: HelpArticleInput) {
  const status: HelpStatus =
    input.status === "published" ? "published" : "draft";
  return {
    title: input.title.trim().slice(0, 300),
    excerpt: input.excerpt.trim().slice(0, 500) || null,
    body: input.body ? sanitizeBlogContent(input.body) : null,
    status,
    categoryId: input.categoryId || null,
    seoTitle: input.seoTitle.trim().slice(0, 200) || null,
    seoDescription: input.seoDescription.trim().slice(0, 320) || null,
  };
}

export async function createHelpArticle(
  input: HelpArticleInput,
): Promise<ActionResult<{ id: string; slug: string }>> {
  const op = await requireOperator();
  if (!op) return { error: "Not authorized." };
  if (!input.title.trim()) return { error: "Title is required." };

  const c = cleanInput(input);
  const slug = await resolveHelpSlug(input.slug || input.title);
  const ts = nowIso();
  try {
    const rows = await withService((db) =>
      db
        .insert(helpArticles)
        .values({
          ...c,
          slug,
          createdBy: op.uid,
          updatedBy: op.uid,
          publishedAt: c.status === "published" ? ts : null,
          createdAt: ts,
          updatedAt: ts,
        })
        .returning({ id: helpArticles.id, slug: helpArticles.slug }),
    );
    revalidateTag(TAGS.help, "max");
    if (c.status === "published") pingArticle(c.categoryId, slug);
    return { success: true, data: rows[0] };
  } catch (e) {
    return { error: dbMessage(e) };
  }
}

export async function updateHelpArticle(
  id: string,
  input: HelpArticleInput,
): Promise<ActionResult<{ slug: string }>> {
  const op = await requireOperator();
  if (!op) return { error: "Not authorized." };
  if (!input.title.trim()) return { error: "Title is required." };

  const existing = await getHelpArticleForEditor(id);
  if (!existing) return { error: "Article not found." };

  const c = cleanInput(input);
  const slug = await resolveHelpSlug(input.slug || input.title, id);
  const ts = nowIso();
  // Publish timestamp: set when transitioning into published; keep otherwise.
  const publishedAt =
    c.status === "published" ? (existing.publishedAt ?? ts) : null;
  try {
    await withService((db) =>
      db
        .update(helpArticles)
        .set({
          ...c,
          slug,
          publishedAt,
          updatedBy: op.uid,
          updatedAt: ts,
        })
        .where(eq(helpArticles.id, id)),
    );
    // Purge images dropped from the body (best-effort; GCS only).
    after(async () => {
      const before = extractMediaUrlsFromHtml(existing.body ?? "");
      const afterUrls = new Set(extractMediaUrlsFromHtml(c.body ?? ""));
      const orphaned = before.filter((u) => !afterUrls.has(u));
      if (orphaned.length) await deleteStorageUrls(orphaned).catch(() => {});
    });
    revalidateTag(TAGS.help, "max");
    if (c.status === "published") pingArticle(c.categoryId, slug);
    return { success: true, data: { slug } };
  } catch (e) {
    return { error: dbMessage(e) };
  }
}

export async function deleteHelpArticle(id: string): Promise<ActionResult> {
  const op = await requireOperator();
  if (!op) return { error: "Not authorized." };
  const existing = await getHelpArticleForEditor(id);
  try {
    await withService((db) =>
      db.delete(helpArticles).where(eq(helpArticles.id, id)),
    );
    revalidateTag(TAGS.help, "max");
    if (existing?.body) {
      const urls = extractMediaUrlsFromHtml(existing.body);
      after(async () => {
        if (urls.length) await deleteStorageUrls(urls).catch(() => {});
      });
    }
    return { success: true };
  } catch (e) {
    return { error: dbMessage(e) };
  }
}

export async function setHelpArticleStatus(
  id: string,
  status: HelpStatus,
): Promise<ActionResult> {
  const op = await requireOperator();
  if (!op) return { error: "Not authorized." };
  const ts = nowIso();
  try {
    const rows = await withService((db) =>
      db
        .update(helpArticles)
        .set({
          status,
          publishedAt: status === "published" ? ts : null,
          updatedBy: op.uid,
          updatedAt: ts,
        })
        .where(eq(helpArticles.id, id))
        .returning({
          slug: helpArticles.slug,
          categoryId: helpArticles.categoryId,
        }),
    );
    revalidateTag(TAGS.help, "max");
    if (status === "published" && rows[0])
      pingArticle(rows[0].categoryId, rows[0].slug);
    return { success: true };
  } catch (e) {
    return { error: dbMessage(e) };
  }
}

/** Persist a new ordering (drag-reorder in the console). */
export async function reorderHelpArticles(
  orderedIds: string[],
): Promise<ActionResult> {
  const op = await requireOperator();
  if (!op) return { error: "Not authorized." };
  try {
    await withService(async (db) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await db
          .update(helpArticles)
          .set({ position: i })
          .where(eq(helpArticles.id, orderedIds[i]));
      }
    });
    revalidateTag(TAGS.help, "max");
    return { success: true };
  } catch (e) {
    return { error: dbMessage(e) };
  }
}

// ---- Categories ----

export async function listHelpCategoriesAdmin(): Promise<HelpCategory[]> {
  if (!(await requireOperator())) return [];
  const rows = await withService((db) =>
    db
      .select({
        id: helpCategories.id,
        slug: helpCategories.slug,
        title: helpCategories.title,
        description: helpCategories.description,
        icon: helpCategories.icon,
        position: helpCategories.position,
      })
      .from(helpCategories)
      .orderBy(asc(helpCategories.position), asc(helpCategories.title)),
  ).catch(() => []);
  return rows.map(toHelpCategory);
}

export async function createHelpCategory(
  input: HelpCategoryInput,
): Promise<ActionResult> {
  const op = await requireOperator();
  if (!op) return { error: "Not authorized." };
  if (!input.title.trim()) return { error: "Title is required." };
  const slug = slugify(input.slug || input.title) || `category-${Date.now()}`;
  const ts = nowIso();
  try {
    await withService((db) =>
      db.insert(helpCategories).values({
        slug,
        title: input.title.trim(),
        description: input.description.trim() || null,
        icon: input.icon.trim() || null,
        createdAt: ts,
        updatedAt: ts,
      }),
    );
    revalidateTag(TAGS.help, "max");
    return { success: true };
  } catch (e) {
    return { error: dbMessage(e) };
  }
}

export async function updateHelpCategory(
  id: string,
  input: HelpCategoryInput,
): Promise<ActionResult> {
  const op = await requireOperator();
  if (!op) return { error: "Not authorized." };
  try {
    await withService((db) =>
      db
        .update(helpCategories)
        .set({
          title: input.title.trim(),
          description: input.description.trim() || null,
          icon: input.icon.trim() || null,
          ...(input.slug ? { slug: slugify(input.slug) } : {}),
          updatedAt: nowIso(),
        })
        .where(eq(helpCategories.id, id)),
    );
    revalidateTag(TAGS.help, "max");
    return { success: true };
  } catch (e) {
    return { error: dbMessage(e) };
  }
}

/**
 * Delete a category — ONLY if it holds no articles.
 *
 * The FK is ON DELETE SET NULL, so deleting a non-empty category used to orphan
 * its articles: they kept status='published' but lost the category that gives
 * them their URL (/help/{category}/{slug}), leaving them unreachable and
 * invisible (the storefront queries inner-join the category). Rather than
 * silently stranding content, refuse and tell the operator to move or delete the
 * articles first (Shopify-style).
 *
 * The guard is the `NOT EXISTS` on the DELETE itself, so it's atomic — a
 * concurrent "add article to this category" can't slip between a check and the
 * delete (the conditional-write pattern used by increment_coupon_usage and the
 * order stock claims). The count is read only when the delete is refused, purely
 * to write a useful message.
 */
export async function deleteHelpCategory(id: string): Promise<ActionResult> {
  const op = await requireOperator();
  if (!op) return { error: "Not authorized." };
  try {
    return await withService(async (db) => {
      const deleted = await db
        .delete(helpCategories)
        .where(
          and(
            eq(helpCategories.id, id),
            sql`NOT EXISTS (SELECT 1 FROM ${helpArticles} WHERE ${helpArticles.categoryId} = ${helpCategories.id})`,
          ),
        )
        .returning({ id: helpCategories.id });

      if (deleted.length > 0) {
        revalidateTag(TAGS.help, "max");
        return { success: true };
      }

      // Nothing deleted: either the category still has articles, or it was
      // already gone. Distinguish so the operator gets an actionable message.
      const [{ n } = { n: 0 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(helpArticles)
        .where(eq(helpArticles.categoryId, id));

      if (n > 0) {
        return {
          error: `This category still has ${n} article${n === 1 ? "" : "s"}. Move ${n === 1 ? "it" : "them"} to another category (or delete ${n === 1 ? "it" : "them"}) first.`,
        };
      }
      // Already deleted by someone else — the end state matches the intent.
      revalidateTag(TAGS.help, "max");
      return { success: true };
    });
  } catch (e) {
    return { error: dbMessage(e) };
  }
}

export async function reorderHelpCategories(
  orderedIds: string[],
): Promise<ActionResult> {
  const op = await requireOperator();
  if (!op) return { error: "Not authorized." };
  try {
    await withService(async (db) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await db
          .update(helpCategories)
          .set({ position: i })
          .where(eq(helpCategories.id, orderedIds[i]));
      }
    });
    revalidateTag(TAGS.help, "max");
    return { success: true };
  } catch (e) {
    return { error: dbMessage(e) };
  }
}

// ─────────────────────────────── AI ────────────────────────────────────────

// The help-writer system prompt lives in brand/tasks/help-article.md (deployed
// app content, traced into the serverless bundle by next.config.ts alongside
// the other brand/tasks/*.md). Read at runtime; the fallback keeps the button
// working if the file can't be read.
const HELP_WRITER_FALLBACK = `You are a senior technical writer for StoreMink, an India-first no-code e-commerce store builder (like Shopify). You write clear, friendly, task-oriented help-centre articles for non-technical merchants.

Rules:
- Output clean semantic HTML only — use <h2>/<h3> for sections, <p>, <ul>/<ol>/<li>, <strong>, <a>. NO <html>, <head>, <body>, <h1>, inline styles, or scripts.
- Start with a one or two sentence intro (no heading), then step-by-step sections.
- Use numbered lists for procedures. Be concise and concrete. Reference real StoreMink concepts (dashboard, storefront, plans: Free/Basic/Pro, custom domain, Razorpay, COD, GST) accurately; never invent features or prices.
- Indian English, rupee (₹) for money. No marketing fluff.`;

async function loadHelpWriterSystem(): Promise<string> {
  try {
    const raw = await readFile(
      path.join(process.cwd(), "brand", "tasks", "help-article.md"),
      "utf8",
    );
    return raw.trim() || HELP_WRITER_FALLBACK;
  } catch {
    return HELP_WRITER_FALLBACK;
  }
}

export interface HelpAiCommandInput {
  /** The operator's natural-language instruction ("write a guide on…", "make
   *  this shorter", "add a table of DNS records", "add a meta description"). */
  instruction: string;
  /** Current editor HTML, if any — present ⇒ EDIT it; empty ⇒ WRITE fresh. */
  currentHtml?: string;
  /** Current field values, so the model preserves/echoes what it shouldn't change. */
  title?: string;
  excerpt?: string;
  seoTitle?: string;
  seoDescription?: string;
  /** Prior chat turns, so a clarify→answer follow-up has context. */
  history?: { role: "user" | "ai"; text: string }[];
}

export interface HelpAiResult {
  /** "clarify" ⇒ the model needs more info and returned a question instead of
   *  writing; "apply" ⇒ it produced/updated the article. */
  action: "apply" | "clarify";
  question?: string;
  body?: string;
  excerpt?: string;
  seoTitle?: string;
  seoDescription?: string;
}

// Gemini structured-output schema (uppercase OpenAPI types, per the codebase's
// existing SEO_SCHEMA). Forcing JSON lets one call fill the body AND the SEO
// fields, and lets the model ask a question instead of guessing.
const AI_ARTICLE_SCHEMA = {
  type: "OBJECT",
  properties: {
    action: { type: "STRING", enum: ["apply", "clarify"] },
    question: { type: "STRING" },
    body: { type: "STRING" },
    excerpt: { type: "STRING" },
    seoTitle: { type: "STRING" },
    seoDescription: { type: "STRING" },
  },
  required: ["action"],
  propertyOrdering: [
    "action",
    "question",
    "body",
    "excerpt",
    "seoTitle",
    "seoDescription",
  ],
};

/**
 * The article editor's AI assistant. One flexible command that drafts from
 * scratch, edits the current content, OR asks a clarifying question when the
 * request is ambiguous. Returns STRUCTURED output so it can populate the body
 * AND the excerpt / SEO fields in one go (production-ready). Body is sanitized
 * before it reaches the editor or DB.
 */
export async function runHelpAiCommand(
  input: HelpAiCommandInput,
): Promise<ActionResult<HelpAiResult>> {
  if (!(await requireOperator())) return { error: "Not authorized." };
  const instruction = input.instruction.trim();
  if (!instruction) return { error: "Type what you'd like the AI to do." };

  const title = input.title?.trim();
  const current = (input.currentHtml ?? "").slice(0, 12000);
  const hasContent = current.replace(/<[^>]+>/g, "").trim().length > 0;

  const system = `${await loadHelpWriterSystem()}

OUTPUT CONTRACT — respond as JSON only:
- If the request is ambiguous or missing key details (which feature, the audience, the scope), set "action" to "clarify" and put ONE short question in "question". Do NOT write the article yet.
- Otherwise set "action" to "apply" and return:
  • "body": the COMPLETE article as clean semantic HTML. ALWAYS use <ol><li> for step-by-step procedures and <ul><li> for unordered lists — never fake lists with paragraphs, dashes or "1." text.
  • "excerpt": a one-line plain-text summary.
  • "seoTitle": <= 60 characters.
  • "seoDescription": a ~150-character plain-text meta description.
Preserve the existing values I give you unless the instruction asks to change them — echo them back.`;

  const history = (input.history ?? [])
    .slice(-6)
    .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.text}`)
    .join("\n");

  const userText = `Instruction: "${instruction}"

Article title: ${title || "(untitled)"}
Current excerpt: ${input.excerpt?.trim() || "(none)"}
Current SEO title: ${input.seoTitle?.trim() || "(none)"}
Current meta description: ${input.seoDescription?.trim() || "(none)"}
${hasContent ? `Current article HTML:\n${current}` : "The article body is currently empty."}${history ? `\n\nConversation so far:\n${history}` : ""}`;

  const { text, error } = await callGemini(system, userText, {
    temperature: 0.5,
    maxOutputTokens: 2048,
    responseMimeType: "application/json",
    responseSchema: AI_ARTICLE_SCHEMA,
  });
  if (error || !text) return { error: error ?? "AI did not return anything." };

  let parsed: HelpAiResult | null = null;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch {
    return { error: "The AI returned an unexpected format. Try again." };
  }
  if (!parsed) return { error: "The AI returned nothing usable. Try again." };

  if (parsed.action === "clarify") {
    return {
      success: true,
      data: {
        action: "clarify",
        question:
          parsed.question?.trim() ||
          "Could you add a bit more detail about what this article should cover?",
      },
    };
  }

  return {
    success: true,
    data: {
      action: "apply",
      body: parsed.body ? sanitizeBlogContent(stripCodeFence(parsed.body)) : "",
      excerpt: parsed.excerpt?.trim() || undefined,
      seoTitle: parsed.seoTitle?.trim() || undefined,
      seoDescription: parsed.seoDescription?.trim() || undefined,
    },
  };
}

// ─────────────────────────────── helpers ───────────────────────────────────

// Models sometimes wrap HTML in ```html fences — strip them.
function stripCodeFence(s: string): string {
  return s
    .replace(/^\s*```(?:html)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function dbMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/duplicate key|unique/i.test(msg)) return "That slug is already in use.";
  return "Could not save. Please try again.";
}

// Ping IndexNow for a newly-published article (prod only, non-blocking).
//
// THREE urls, not one. Publishing an article also changes the two pages that
// list it — its category page and the help hub — and the category page in
// particular may be entering the sitemap for the very first time (empty
// categories are pruned; see app/sitemap.ts). Announcing only the article left
// crawlers to rediscover its own inbound links on their own schedule, which is
// the opposite of the "new article indexed fast" goal. IndexNow takes up to
// 10,000 urls per request, so the extra two are free.
function pingArticle(categoryId: string | null, slug: string) {
  if (!SEARCH_INDEXABLE || !categoryId) return;
  after(async () => {
    const cats = await getHelpCategories().catch(() => []);
    const catSlug = cats.find((c) => c.id === categoryId)?.slug;
    if (!catSlug) return;
    await pingIndexNow([
      `${HELP_URL}/help/${catSlug}/${slug}`,
      `${HELP_URL}/help/${catSlug}`,
      `${HELP_URL}/help`,
    ]).catch(() => {});
  });
}
