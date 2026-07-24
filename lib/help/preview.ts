import "server-only";
import { eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { helpArticles } from "@/drizzle/schema";
import { getPlatformViewer } from "@/app/actions/platform";
import { toHelpArticle, type HelpArticle } from "@/lib/help/types";

// UNCACHED, operator-gated draft loader for the ?preview=1 route. Returns null
// for anyone who isn't a signed-in platform operator, so the article page then
// falls back to the published (or 404) path — a leaked preview URL reveals
// nothing to the public. Loads an article of ANY status by slug (drafts too).
export async function getHelpArticlePreview(
  slug: string,
): Promise<HelpArticle | null> {
  if (!(await getPlatformViewer())) return null;
  const rows = await withService((db) =>
    db.select().from(helpArticles).where(eq(helpArticles.slug, slug)).limit(1),
  ).catch(() => []);
  return rows[0] ? toHelpArticle(rows[0]) : null;
}
