import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  minkWatches,
  minkWatchResponses,
  minkWorkflowRuns,
  minkWorkflowSteps,
  minkWatchEvents,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { getMinkConfig } from "./config";
import { getMinkStoreAccess } from "./access";
import { revalidateWorkflowAuthority } from "./workflows";
import type { MinkActorContext } from "./types";
import type {
  BusinessBriefInput,
  BusinessBriefResult,
} from "./business-brief-types";
import {
  isResponseSignal,
  rankResponseSignals,
  RESPONSE_LIMITS,
} from "./proactive-response-types";
import { MinkRequestError } from "./errors";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function reject(message: string, status = 409): never {
  throw new MinkRequestError("watch_response_rejected", message, status);
}
type Watch = typeof minkWatches.$inferSelect;
async function authority(db: Db, actor: MinkActorContext, w: Watch) {
  const config = getMinkConfig();
  if (
    !config.enabled ||
    (config.betaRequireInvite &&
      !(await getMinkStoreAccess(actor.storeId, db)).enabled)
  )
    reject("Mink access is required.", 403);
  if (
    !(await revalidateWorkflowAuthority(
      {
        storeId: actor.storeId,
        adminId: actor.adminId,
        template: "business_brief",
        inputJson: w.inputJson,
      },
      true,
      db,
    ))
  )
    reject(
      "Your permissions or the captured locations changed. Create a new watch for your current scope.",
      403,
    );
}
function owner(actor: MinkActorContext, id: string) {
  if (!UUID.test(id)) reject("Choose a valid watch.", 400);
  return and(
    eq(minkWatches.id, id),
    eq(minkWatches.storeId, actor.storeId),
    eq(minkWatches.adminId, actor.adminId),
  );
}
async function plans(db: Db, w: Watch) {
  if (!w.processedRunId) return [];
  const [run] = await db
    .select()
    .from(minkWorkflowRuns)
    .where(
      and(
        eq(minkWorkflowRuns.id, w.processedRunId),
        eq(minkWorkflowRuns.watchId, w.id),
        eq(minkWorkflowRuns.storeId, w.storeId),
        eq(minkWorkflowRuns.adminId, w.adminId),
        eq(minkWorkflowRuns.status, "completed"),
        eq(minkWorkflowRuns.template, "business_brief"),
      ),
    )
    .limit(1);
  if (!run?.resultJson || !run.completedAt) return [];
  const result = run.resultJson as BusinessBriefResult;
  const expiresAt = new Date(
    new Date(run.completedAt).getTime() + 24 * 60 * 60 * 1000,
  ).toISOString();
  const decisions = await db
    .select()
    .from(minkWatchResponses)
    .where(
      and(
        eq(minkWatchResponses.watchId, w.id),
        eq(minkWatchResponses.storeId, w.storeId),
        eq(minkWatchResponses.adminId, w.adminId),
        eq(minkWatchResponses.sourceRunId, run.id),
      ),
    )
    .limit(4);
  return rankResponseSignals(result, w.kind).map((p) => {
    const planHash = createHash("sha256")
      .update(
        JSON.stringify({
          policy: "watch-response-v1",
          watchId: w.id,
          version: w.version,
          sourceRunId: run.id,
          scope: w.inputJson,
          signal: p.signal,
          evidence: p.evidence,
          limits: RESPONSE_LIMITS,
          expiresAt,
        }),
      )
      .digest("hex");
    const decision = decisions.find((d) => d.signal === p.signal);
    return {
      ...p,
      sourceRunId: run.id,
      watchVersion: w.version,
      planHash,
      expiresAt,
      dataAsOf: result.dataAsOf,
      locationLabel: result.locationLabel,
      timeZone: result.timeZone,
      rangeLabel: result.rangeLabel,
      limits: RESPONSE_LIMITS,
      status: decision?.status ?? "proposed",
      workflowId: decision?.workflowId ?? null,
    };
  });
}
export async function listProactiveResponses(
  actor: MinkActorContext,
  watchId: string,
) {
  return withService(async (db) => {
    const [w] = await db
      .select()
      .from(minkWatches)
      .where(owner(actor, watchId))
      .limit(1);
    if (!w || w.status === "deleted") reject("Watch not found.", 404);
    await authority(db, actor, w);
    const investigations = await db
      .select({
        workflowId: minkWatchResponses.workflowId,
        signal: minkWatchResponses.signal,
        createdAt: minkWatchResponses.createdAt,
      })
      .from(minkWatchResponses)
      .where(
        and(
          eq(minkWatchResponses.watchId, w.id),
          eq(minkWatchResponses.storeId, w.storeId),
          eq(minkWatchResponses.adminId, actor.adminId),
          eq(minkWatchResponses.status, "approved"),
        ),
      )
      .orderBy(desc(minkWatchResponses.createdAt))
      .limit(5);
    return {
      watchId: w.id,
      active: w.status === "active",
      plans: await plans(db, w),
      investigations,
      ranking:
        "Local stock availability, failed-payment orders, sales decline, then return activity. This is a fixed triage order, not a forecast.",
      requiresHumanApproval: true,
    };
  });
}
export async function decideProactiveResponse(
  actor: MinkActorContext,
  raw: Record<string, unknown>,
) {
  if (
    Object.keys(raw).some(
      (k) =>
        ![
          "action",
          "watchId",
          "sourceRunId",
          "signal",
          "planHash",
          "confirmed",
        ].includes(k),
    ) ||
    typeof raw.action !== "string" ||
    !["approve", "dismiss"].includes(raw.action) ||
    typeof raw.watchId !== "string" ||
    typeof raw.sourceRunId !== "string" ||
    !UUID.test(raw.sourceRunId) ||
    !isResponseSignal(raw.signal) ||
    typeof raw.planHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.planHash) ||
    (raw.action === "approve" && raw.confirmed !== true)
  )
    reject("Review the exact response plan and explicitly approve it.", 400);
  const watchId = raw.watchId as string;
  return withService(async (db) => {
    // Same lock order as scheduler and pause/delete: watch, then workflow.
    const [w] = await db
      .select()
      .from(minkWatches)
      .where(owner(actor, watchId))
      .limit(1)
      .for("update");
    if (!w || w.status === "deleted") reject("Watch not found.", 404);
    await authority(db, actor, w);
    const [previous] = await db
      .select()
      .from(minkWatchResponses)
      .where(
        and(
          eq(minkWatchResponses.watchId, w.id),
          eq(minkWatchResponses.storeId, w.storeId),
          eq(minkWatchResponses.adminId, actor.adminId),
          eq(minkWatchResponses.sourceRunId, raw.sourceRunId as string),
          eq(minkWatchResponses.signal, raw.signal as string),
        ),
      )
      .limit(1);
    if (previous) {
      if (
        previous.planHash !== raw.planHash ||
        previous.status !==
          (raw.action === "approve" ? "approved" : "dismissed")
      )
        reject(
          "This response was already decided differently. Refresh the watch.",
        );
      return { status: previous.status, workflowId: previous.workflowId };
    }
    if (w.status !== "active")
      reject("Resume the watch and review a fresh plan first.");
    const plan = (await plans(db, w)).find(
      (p) =>
        p.signal === raw.signal &&
        p.sourceRunId === raw.sourceRunId &&
        p.planHash === raw.planHash,
    );
    if (!plan || new Date(plan.expiresAt).getTime() <= Date.now())
      reject(
        "This plan expired or its evidence changed. Wait for a fresh check and review the new plan.",
      );
    const id = crypto.randomUUID();
    let workflowId: string | null = null;
    if (raw.action === "approve") {
      const [busy] = await db
        .select({ id: minkWorkflowRuns.id })
        .from(minkWorkflowRuns)
        .where(
          and(
            eq(minkWorkflowRuns.watchId, w.id),
            eq(minkWorkflowRuns.storeId, w.storeId),
            sql`${minkWorkflowRuns.status} IN ('queued','running')`,
          ),
        )
        .limit(1);
      if (busy)
        reject(
          "A check or response for this watch is already running. Wait for it to finish.",
        );
      workflowId = crypto.randomUUID();
      await db.insert(minkWorkflowRuns).values({
        id: workflowId,
        storeId: w.storeId,
        adminId: w.adminId,
        watchId: w.id,
        template: "watch_response_review",
        idempotencyKey: `watch-response:${id}`,
        inputJson: {
          ...(w.inputJson as BusinessBriefInput),
          responseId: id,
          signal: raw.signal,
          requestedAt: new Date().toISOString(),
        },
        totalSteps: 2,
      });
      await db.insert(minkWorkflowSteps).values(
        ["snapshot", "finalise"].map((stepKey, position) => ({
          runId: workflowId!,
          storeId: w.storeId,
          stepKey,
          position,
          inputJson: {},
        })),
      );
    }
    const status = raw.action === "approve" ? "approved" : "dismissed";
    await db.insert(minkWatchResponses).values({
      id,
      storeId: w.storeId,
      watchId: w.id,
      adminId: w.adminId,
      sourceRunId: raw.sourceRunId as string,
      signal: raw.signal as string,
      watchVersion: w.version,
      planHash: plan.planHash,
      status,
      workflowId,
    });
    await db.insert(minkWatchEvents).values({
      watchId: w.id,
      event: `response_${status}:${raw.signal}`,
      version: w.version,
    });
    return { status, workflowId };
  });
}
