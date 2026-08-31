import "server-only";

import { and, asc, eq, lte } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import {
  blogs,
  minkActionApprovals,
  minkActionToolAccess,
  minkBlogPublications,
  minkStoreAccess,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { getMinkConfig } from "@/lib/mink/config";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { notifyStoreContentPublished } from "@/lib/seo/store-indexing";
import { TAGS } from "@/lib/storefront/tags";

export const MAX_MINK_PUBLICATIONS_PER_RUN = 20;

export interface MinkPublicationWorkerResult {
  processed: number;
  published: number;
  conflicted: number;
}

type WorkerOutcome =
  | { type: "published"; storeId: string; slug: string; blogId: string }
  | { type: "conflicted"; publicationId: string }
  | { type: "empty" };

/**
 * Publish a bounded batch of due, still-authorized Mink schedules.
 *
 * Each row is its own transaction and is claimed with SKIP LOCKED. Overlapping
 * Cloud Scheduler retries therefore publish a blog at most once, while one bad
 * or manually edited post cannot roll back unrelated due posts.
 */
export async function runMinkBlogPublicationWorker(
  limit = MAX_MINK_PUBLICATIONS_PER_RUN,
): Promise<MinkPublicationWorkerResult> {
  if (!getMinkConfig().enabled) {
    return { processed: 0, published: 0, conflicted: 0 };
  }
  const bounded = Math.max(
    1,
    Math.min(MAX_MINK_PUBLICATIONS_PER_RUN, Math.trunc(limit)),
  );
  const result: MinkPublicationWorkerResult = {
    processed: 0,
    published: 0,
    conflicted: 0,
  };
  const published: Array<Extract<WorkerOutcome, { type: "published" }>> = [];
  for (let index = 0; index < bounded; index += 1) {
    const outcome = await processOne();
    if (outcome.type === "empty") break;
    result.processed += 1;
    if (outcome.type === "conflicted") {
      result.conflicted += 1;
      continue;
    }
    result.published += 1;
    published.push(outcome);
    revalidatePath("/dashboard/blogs");
    revalidatePath("/blogs");
    revalidatePath(`/blogs/${outcome.slug}`);
    revalidateTag(TAGS.blogs, "max");
  }
  await notifyPublishedBlogs(published);
  if (result.processed > 0) {
    logInfo("mink blog publication worker: completed", { ...result });
  }
  return result;
}

async function notifyPublishedBlogs(
  outcomes: Array<Extract<WorkerOutcome, { type: "published" }>>,
) {
  const concurrency = 4;
  for (let start = 0; start < outcomes.length; start += concurrency) {
    const batch = outcomes.slice(start, start + concurrency);
    const settled = await Promise.allSettled(
      batch.map((outcome) =>
        notifyStoreContentPublished({
          storeId: outcome.storeId,
          paths: [`/blogs/${outcome.slug}`, "/blogs", "/"],
        }),
      ),
    );
    settled.forEach((notification, index) => {
      if (notification.status === "fulfilled") return;
      const outcome = batch[index];
      logWarn("mink blog publication worker: discovery notification failed", {
        storeId: outcome.storeId,
        blogId: outcome.blogId,
        error:
          notification.reason instanceof Error
            ? notification.reason.message
            : String(notification.reason),
      });
    });
  }
}

async function processOne(): Promise<WorkerOutcome> {
  try {
    return await withService(async (db) => {
      const now = new Date().toISOString();
      const rows = await db
        .select({
          id: minkBlogPublications.id,
          storeId: minkBlogPublications.storeId,
          approvalId: minkBlogPublications.approvalId,
          blogId: minkBlogPublications.blogId,
          blogVersion: minkBlogPublications.blogVersion,
        })
        .from(minkBlogPublications)
        .innerJoin(
          minkStoreAccess,
          and(
            eq(minkStoreAccess.storeId, minkBlogPublications.storeId),
            eq(minkStoreAccess.enabled, true),
            eq(minkStoreAccess.draftingEnabled, true),
          ),
        )
        .innerJoin(
          minkActionToolAccess,
          and(
            eq(minkActionToolAccess.storeId, minkBlogPublications.storeId),
            eq(minkActionToolAccess.toolName, "publish_blog"),
            eq(minkActionToolAccess.enabled, true),
          ),
        )
        .where(
          and(
            eq(minkBlogPublications.mode, "schedule"),
            eq(minkBlogPublications.status, "scheduled"),
            lte(minkBlogPublications.scheduledFor, now),
          ),
        )
        .orderBy(
          asc(minkBlogPublications.scheduledFor),
          asc(minkBlogPublications.createdAt),
        )
        .limit(1)
        .for("update", { skipLocked: true });
      const publication = rows[0];
      if (!publication) return { type: "empty" };

      const approvalRows = await db
        .select({
          status: minkActionApprovals.status,
          toolName: minkActionApprovals.toolName,
          resultId: minkActionApprovals.resultId,
        })
        .from(minkActionApprovals)
        .where(
          and(
            eq(minkActionApprovals.id, publication.approvalId),
            eq(minkActionApprovals.storeId, publication.storeId),
          ),
        )
        .limit(1)
        .for("update");
      const approval = approvalRows[0];
      const blogRows = await db
        .select({
          id: blogs.id,
          slug: blogs.slug,
          status: blogs.status,
          updatedAt: blogs.updatedAt,
        })
        .from(blogs)
        .where(
          and(
            eq(blogs.id, publication.blogId),
            eq(blogs.storeId, publication.storeId),
          ),
        )
        .limit(1)
        .for("update");
      const blog = blogRows[0];
      if (
        !approval ||
        approval.status !== "executed" ||
        approval.toolName !== "publish_blog" ||
        approval.resultId !== publication.blogId ||
        !blog ||
        blog.status !== "draft" ||
        blog.updatedAt !== publication.blogVersion
      ) {
        await db
          .update(minkBlogPublications)
          .set({
            status: "conflicted",
            detail:
              "The approved blog was changed, removed or published through another workflow before its scheduled time.",
            updatedAt: now,
          })
          .where(
            and(
              eq(minkBlogPublications.id, publication.id),
              eq(minkBlogPublications.status, "scheduled"),
            ),
          );
        return { type: "conflicted", publicationId: publication.id };
      }

      const updated = await db
        .update(blogs)
        .set({
          status: "published",
          publishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(blogs.id, blog.id),
            eq(blogs.storeId, publication.storeId),
            eq(blogs.status, "draft"),
            eq(blogs.updatedAt, publication.blogVersion),
          ),
        )
        .returning({
          id: blogs.id,
          slug: blogs.slug,
          updatedAt: blogs.updatedAt,
        });
      if (!updated[0]) {
        await db
          .update(minkBlogPublications)
          .set({
            status: "conflicted",
            detail: "The blog changed during scheduled publication.",
            updatedAt: now,
          })
          .where(eq(minkBlogPublications.id, publication.id));
        return { type: "conflicted", publicationId: publication.id };
      }
      const finalized = await db
        .update(minkBlogPublications)
        .set({
          status: "published",
          publishedAt: now,
          blogVersion: updated[0].updatedAt,
          detail: "Published by the authenticated Mink schedule worker.",
          updatedAt: now,
        })
        .where(
          and(
            eq(minkBlogPublications.id, publication.id),
            eq(minkBlogPublications.status, "scheduled"),
          ),
        )
        .returning({ id: minkBlogPublications.id });
      if (!finalized[0]) {
        throw new Error("Scheduled publication lost its row lock");
      }
      return {
        type: "published",
        storeId: publication.storeId,
        slug: updated[0].slug,
        blogId: updated[0].id,
      };
    });
  } catch (error) {
    logError("mink blog publication worker: row failed", error);
    throw error;
  }
}
