import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  getSalesAnalytics,
  getSalesByChannel,
  getTopProducts,
} from "@/app/dashboard/analytics/data";
import {
  activityEvents,
  adminLocations,
  admins,
  minkWorkflowEvents,
  minkWorkflowRuns,
  minkWorkflowSteps,
  platformAdmins,
  roles,
} from "@/drizzle/schema";
import { parseAnalyticsRange } from "@/lib/analytics/range";
import { withService, type Db } from "@/lib/db/client";
import { recordEvent } from "@/lib/notifications/record";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { getMinkStoreAccess } from "./access";
import { getMinkConfig } from "./config";
import { MinkRequestError, MinkToolInputError } from "./errors";
import { resolveMinkLocation } from "./tools/location-scope";
import type { MinkActorContext } from "./types";
import {
  buildWeeklyTradingReportResult,
  isMinkWorkflowStatus,
  type MinkWorkflowEventView,
  type MinkWorkflowStatus,
  type MinkWorkflowView,
  type WeeklyTradingReportInput,
  type WeeklyTradingReportResult,
  type WeeklyTradingReportSnapshot,
} from "./workflow-types";

const WORKFLOW_STEPS = ["snapshot", "analyse", "finalise"] as const;
const WORKFLOW_LEASE_SECONDS = 120;
export const MAX_MINK_WORKFLOW_CLAIMS_PER_RUN = 15;

type WorkflowRow = typeof minkWorkflowRuns.$inferSelect;
type ClaimedWorkflow = Pick<
  WorkflowRow,
  | "id"
  | "storeId"
  | "adminId"
  | "template"
  | "status"
  | "inputJson"
  | "currentStep"
  | "totalSteps"
  | "attemptCount"
  | "maxAttempts"
  | "leaseOwner"
  | "cancelRequestedAt"
>;

export interface MinkWorkflowWorkerResult {
  claims: number;
  stepsCompleted: number;
  workflowsCompleted: number;
  workflowsCancelled: number;
  retriesScheduled: number;
  workflowsFailed: number;
  notificationsDelivered: number;
}

interface WorkflowExecutionScope {
  locationIds: string[];
  locationLabel: string;
}

class WorkflowCancellationRequestedError extends Error {}

/** Queue one deterministic read-only report. Model retries reuse source run. */
export async function enqueueWeeklyTradingReport(
  actor: MinkActorContext,
): Promise<MinkWorkflowView> {
  if (!actor.runId) {
    throw new MinkToolInputError(
      "A weekly report can be queued only from an active Mink AI run.",
    );
  }
  const location = await resolveMinkLocation(actor, undefined);
  const now = new Date().toISOString();
  const input: WeeklyTradingReportInput = {
    timeZone: actor.analyticsTimeZone,
    currency: actor.currency,
    // Snapshot exact active location authority. Never store null/all because
    // a later location could otherwise silently enter an already queued job.
    locationIds: location.availableLocations.map((item) => item.id),
    restrictedLocationScope: actor.locationIds !== null,
    includeUnassigned: location.includeUnassigned,
    locationLabel:
      location.includeUnassigned && !location.selectedId
        ? `${location.label} plus online or unassigned orders`
        : location.label,
    requesterEmail: actor.email?.trim().toLowerCase() ?? null,
    requestedAt: now,
  };
  const idempotencyKey = `agent-run:${actor.runId}:weekly-trading-report:v1`;

  return withService(async (db) => {
    const inserted = await db
      .insert(minkWorkflowRuns)
      .values({
        storeId: actor.storeId,
        adminId: actor.adminId,
        sourceRunId: actor.runId,
        template: "weekly_trading_report",
        status: "queued",
        idempotencyKey,
        inputJson: input,
        totalSteps: WORKFLOW_STEPS.length,
        maxAttempts: 6,
        runAfter: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          minkWorkflowRuns.storeId,
          minkWorkflowRuns.adminId,
          minkWorkflowRuns.idempotencyKey,
        ],
      })
      .returning();
    let run = inserted[0];
    if (run) {
      await db.insert(minkWorkflowSteps).values(
        WORKFLOW_STEPS.map((stepKey, position) => ({
          runId: run!.id,
          storeId: actor.storeId,
          stepKey,
          position,
          inputJson: {},
        })),
      );
      await insertWorkflowEvent(db, {
        runId: run.id,
        storeId: actor.storeId,
        eventKey: "queued",
        eventType: "queued",
        detail: { template: "weekly_trading_report" },
      });
    } else {
      const existing = await db
        .select()
        .from(minkWorkflowRuns)
        .where(
          and(
            eq(minkWorkflowRuns.storeId, actor.storeId),
            eq(minkWorkflowRuns.adminId, actor.adminId),
            eq(minkWorkflowRuns.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      run = existing[0];
    }
    if (!run) throw new Error("Mink workflow idempotency lookup failed");
    return toWorkflowView(run);
  });
}

export async function getMinkWorkflow(
  actor: MinkActorContext,
  workflowId: string,
  includeEvents = true,
): Promise<MinkWorkflowView> {
  return withService(async (db) => {
    const rows = await db
      .select()
      .from(minkWorkflowRuns)
      .where(ownerPredicate(actor, workflowId))
      .limit(1);
    const run = rows[0];
    if (!run) {
      throw new MinkRequestError(
        "mink_workflow_not_found",
        "That Mink workflow is not available.",
        404,
      );
    }
    const events = includeEvents
      ? await db
          .select()
          .from(minkWorkflowEvents)
          .where(
            and(
              eq(minkWorkflowEvents.runId, run.id),
              eq(minkWorkflowEvents.storeId, actor.storeId),
            ),
          )
          .orderBy(
            asc(minkWorkflowEvents.createdAt),
            asc(minkWorkflowEvents.id),
          )
          .limit(100)
      : [];
    return toWorkflowView(
      run,
      events.map((event) => ({
        id: event.id,
        type: event.eventType,
        stepKey: event.stepKey,
        detail: readObject(event.detailJson),
        createdAt: event.createdAt,
      })),
    );
  });
}

export async function cancelMinkWorkflow(
  actor: MinkActorContext,
  workflowId: string,
): Promise<MinkWorkflowView> {
  return withService(async (db) => {
    const rows = await db
      .select()
      .from(minkWorkflowRuns)
      .where(ownerPredicate(actor, workflowId))
      .limit(1)
      .for("update");
    const run = rows[0];
    if (!run) {
      throw new MinkRequestError(
        "mink_workflow_not_found",
        "That Mink workflow is not available.",
        404,
      );
    }
    if (["completed", "failed", "cancelled"].includes(run.status)) {
      return toWorkflowView(run);
    }
    const now = new Date().toISOString();
    if (run.status === "running") {
      const updated = await db
        .update(minkWorkflowRuns)
        .set({ cancelRequestedAt: now, updatedAt: now })
        .where(ownerPredicate(actor, workflowId))
        .returning();
      await insertWorkflowEvent(db, {
        runId: run.id,
        storeId: actor.storeId,
        eventKey: "cancel-requested",
        eventType: "cancel_requested",
        detail: {},
      });
      return toWorkflowView(updated[0] ?? run);
    }
    const updated = await db
      .update(minkWorkflowRuns)
      .set({
        status: "cancelled",
        cancelRequestedAt: now,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(ownerPredicate(actor, workflowId))
      .returning();
    await db
      .update(minkWorkflowSteps)
      .set({ status: "cancelled", completedAt: now, updatedAt: now })
      .where(
        and(
          eq(minkWorkflowSteps.runId, run.id),
          eq(minkWorkflowSteps.storeId, actor.storeId),
          inArray(minkWorkflowSteps.status, [
            "queued",
            "running",
            "waiting_approval",
          ]),
        ),
      );
    await insertWorkflowEvent(db, {
      runId: run.id,
      storeId: actor.storeId,
      eventKey: "cancelled",
      eventType: "cancelled",
      detail: {},
    });
    return toWorkflowView(updated[0] ?? run);
  });
}

/** Generic approval-resume primitive; cancelled workflows are never resumable. */
export async function resumeMinkWorkflow(
  actor: MinkActorContext,
  workflowId: string,
): Promise<MinkWorkflowView> {
  return withService(async (db) => {
    const rows = await db
      .select()
      .from(minkWorkflowRuns)
      .where(ownerPredicate(actor, workflowId))
      .limit(1)
      .for("update");
    const run = rows[0];
    if (!run) {
      throw new MinkRequestError(
        "mink_workflow_not_found",
        "That Mink workflow is not available.",
        404,
      );
    }
    if (run.status !== "waiting_approval") {
      throw new MinkRequestError(
        "mink_workflow_not_resumable",
        run.status === "cancelled"
          ? "Cancelled Mink workflows cannot be resumed."
          : "This Mink workflow is not waiting for approval.",
        409,
      );
    }
    const now = new Date().toISOString();
    const updated = await db
      .update(minkWorkflowRuns)
      .set({ status: "queued", runAfter: now, updatedAt: now })
      .where(ownerPredicate(actor, workflowId))
      .returning();
    await db
      .update(minkWorkflowSteps)
      .set({ status: "queued", updatedAt: now })
      .where(
        and(
          eq(minkWorkflowSteps.runId, run.id),
          eq(minkWorkflowSteps.storeId, actor.storeId),
          eq(minkWorkflowSteps.position, run.currentStep),
          eq(minkWorkflowSteps.status, "waiting_approval"),
        ),
      );
    await insertWorkflowEvent(db, {
      runId: run.id,
      storeId: actor.storeId,
      eventKey: `resumed:${run.currentStep}`,
      eventType: "resumed",
      detail: { step: run.currentStep },
    });
    return toWorkflowView(updated[0] ?? run);
  });
}

export async function runMinkWorkflowWorker(
  limit = MAX_MINK_WORKFLOW_CLAIMS_PER_RUN,
): Promise<MinkWorkflowWorkerResult> {
  const result: MinkWorkflowWorkerResult = {
    claims: 0,
    stepsCompleted: 0,
    workflowsCompleted: 0,
    workflowsCancelled: 0,
    retriesScheduled: 0,
    workflowsFailed: 0,
    notificationsDelivered: 0,
  };
  const config = getMinkConfig();
  if (!config.enabled) return result;
  const bounded = Math.max(
    1,
    Math.min(MAX_MINK_WORKFLOW_CLAIMS_PER_RUN, Math.trunc(limit)),
  );
  const workerId = crypto.randomUUID();
  result.workflowsFailed += await failExpiredExhaustedWorkflows(bounded);
  for (let index = 0; index < bounded; index += 1) {
    const run = await claimWorkflow(workerId);
    if (!run) break;
    result.claims += 1;
    try {
      if (run.cancelRequestedAt) {
        await cancelClaimedWorkflow(run, workerId, "cancel_requested");
        result.workflowsCancelled += 1;
        continue;
      }
      if (config.betaRequireInvite) {
        const access = await getMinkStoreAccess(run.storeId);
        if (!access.enabled) {
          await cancelClaimedWorkflow(run, workerId, "store_access_revoked");
          result.workflowsCancelled += 1;
          continue;
        }
      }
      const executionScope = await revalidateWorkflowAuthority(run);
      if (!executionScope) {
        await cancelClaimedWorkflow(run, workerId, "authorization_revoked");
        result.workflowsCancelled += 1;
        continue;
      }
      const outcome = await executeClaimedStep(run, workerId, executionScope);
      result.stepsCompleted += 1;
      if (outcome.completed) result.workflowsCompleted += 1;
    } catch (error) {
      if (error instanceof WorkflowCancellationRequestedError) {
        await cancelClaimedWorkflow(run, workerId, "cancel_requested");
        result.workflowsCancelled += 1;
        continue;
      }
      const failure = await scheduleWorkflowRetry(run, workerId, error);
      if (failure === "retry") result.retriesScheduled += 1;
      else result.workflowsFailed += 1;
    }
  }
  result.notificationsDelivered =
    await deliverPendingWorkflowNotifications(bounded);
  if (result.claims > 0) {
    logInfo("mink workflow worker: completed", { workerId, ...result });
  }
  return result;
}

/**
 * Re-check durable work at execution time. A queued job is never a capability
 * token: removing Analytics access, suspending the requester, removing their
 * platform-operator row, or narrowing an explicit location assignment takes
 * effect before the next step reads store data.
 */
async function revalidateWorkflowAuthority(
  run: ClaimedWorkflow,
): Promise<WorkflowExecutionScope | null> {
  const input = readWeeklyInput(run.inputJson);
  return withService(async (db) => {
    let isPlatformOperator = false;
    if (input.requesterEmail) {
      const platformRows = await db
        .select({ id: platformAdmins.id })
        .from(platformAdmins)
        .where(eq(platformAdmins.email, input.requesterEmail))
        .limit(1);
      isPlatformOperator = Boolean(platformRows[0]);
    }

    if (!isPlatformOperator) {
      const adminRows = await db
        .select({ role: admins.role, isSuspended: admins.isSuspended })
        .from(admins)
        .where(and(eq(admins.id, run.adminId), eq(admins.storeId, run.storeId)))
        .limit(1);
      const admin = adminRows[0];
      if (!admin || admin.isSuspended === true) return null;
      if (admin.role !== "superadmin") {
        const roleRows = await db
          .select({ permissions: roles.permissions })
          .from(roles)
          .where(
            and(eq(roles.storeId, run.storeId), eq(roles.slug, admin.role)),
          )
          .limit(1);
        if (!grantsAnalyticsView(roleRows[0]?.permissions)) return null;
      }
    }

    if (!input.restrictedLocationScope || isPlatformOperator) {
      return {
        locationIds: input.locationIds,
        locationLabel: input.locationLabel,
      };
    }
    const bindings = await db
      .select({ locationId: adminLocations.locationId })
      .from(adminLocations)
      .where(
        and(
          eq(adminLocations.adminId, run.adminId),
          eq(adminLocations.storeId, run.storeId),
        ),
      );
    const currentlyAllowed = new Set(
      bindings.map((binding) => binding.locationId),
    );
    const locationIds = input.locationIds.filter((id) =>
      currentlyAllowed.has(id),
    );
    if (locationIds.length === 0) return null;
    return {
      locationIds,
      locationLabel:
        locationIds.length === input.locationIds.length
          ? input.locationLabel
          : `${locationIds.length} currently authorized ${locationIds.length === 1 ? "location" : "locations"} (narrowed from ${input.locationIds.length} queued)`,
    };
  });
}

function grantsAnalyticsView(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actions = (value as Record<string, unknown>).analytics;
  return (
    Array.isArray(actions) &&
    (actions.includes("view") || actions.includes("manage"))
  );
}

/**
 * Completion delivery is a reconciled outbox: the partial unique index on
 * activity_events makes concurrent/retried deliveries exactly-once per run.
 */
async function deliverPendingWorkflowNotifications(limit: number) {
  const pending = await withService((db) =>
    db
      .select({
        id: minkWorkflowRuns.id,
        storeId: minkWorkflowRuns.storeId,
        template: minkWorkflowRuns.template,
      })
      .from(minkWorkflowRuns)
      .where(
        and(
          eq(minkWorkflowRuns.status, "completed"),
          sql`NOT EXISTS (
            SELECT 1
            FROM ${activityEvents}
            WHERE ${activityEvents.storeId} = ${minkWorkflowRuns.storeId}
              AND ${activityEvents.type} = 'mink.workflow_completed'
              AND ${activityEvents.subjectId} = ${minkWorkflowRuns.id}::text
          )`,
        ),
      )
      .orderBy(asc(minkWorkflowRuns.completedAt), asc(minkWorkflowRuns.id))
      .limit(Math.max(1, Math.min(limit, 25))),
  );
  let delivered = 0;
  for (const run of pending) {
    const eventId = await recordEvent({
      type: "mink.workflow_completed",
      storeId: run.storeId,
      actor: { type: "system", label: "Mink AI" },
      subject: {
        type: "mink_workflow",
        id: run.id,
        label: "Weekly trading report",
      },
      payload: { template: run.template },
      deduplicate: true,
    });
    if (eventId) delivered += 1;
  }
  return delivered;
}

/**
 * A process can die on its final permitted attempt before it records a retry.
 * Reap that expired lease explicitly; otherwise the max-attempt predicate would
 * leave the run permanently stuck in `running`.
 */
async function failExpiredExhaustedWorkflows(limit: number): Promise<number> {
  return withService(async (db) => {
    const rows = await db
      .select({
        id: minkWorkflowRuns.id,
        storeId: minkWorkflowRuns.storeId,
        currentStep: minkWorkflowRuns.currentStep,
        attemptCount: minkWorkflowRuns.attemptCount,
      })
      .from(minkWorkflowRuns)
      .where(
        and(
          eq(minkWorkflowRuns.status, "running"),
          sql`${minkWorkflowRuns.leaseExpiresAt} <= now()`,
          sql`${minkWorkflowRuns.attemptCount} >= ${minkWorkflowRuns.maxAttempts}`,
        ),
      )
      .orderBy(asc(minkWorkflowRuns.leaseExpiresAt), asc(minkWorkflowRuns.id))
      .limit(Math.max(1, Math.min(limit, 25)))
      .for("update", { skipLocked: true });
    if (rows.length === 0) return 0;
    const now = new Date().toISOString();
    for (const run of rows) {
      await db
        .update(minkWorkflowRuns)
        .set({
          status: "failed",
          errorCode: "workflow_lease_expired_after_max_attempts",
          errorDetail: "Mink could not finish this report after safe retries.",
          completedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(minkWorkflowRuns.id, run.id),
            eq(minkWorkflowRuns.storeId, run.storeId),
            eq(minkWorkflowRuns.status, "running"),
          ),
        );
      await db
        .update(minkWorkflowSteps)
        .set({
          status: "failed",
          errorCode: "workflow_lease_expired_after_max_attempts",
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(minkWorkflowSteps.runId, run.id),
            eq(minkWorkflowSteps.storeId, run.storeId),
            eq(minkWorkflowSteps.position, run.currentStep),
            inArray(minkWorkflowSteps.status, ["queued", "running"]),
          ),
        );
      await insertWorkflowEvent(db, {
        runId: run.id,
        storeId: run.storeId,
        eventKey: `failed:exhausted:${run.attemptCount}`,
        eventType: "failed",
        stepKey: WORKFLOW_STEPS[run.currentStep],
        detail: {
          attempt: run.attemptCount,
          code: "workflow_lease_expired_after_max_attempts",
        },
      });
    }
    logWarn("mink workflow worker: expired exhausted leases failed", {
      count: rows.length,
    });
    return rows.length;
  });
}

async function claimWorkflow(
  workerId: string,
): Promise<ClaimedWorkflow | null> {
  return withService(async (db) => {
    const claimed = await db.execute(sql<ClaimedWorkflow>`
      WITH candidate AS (
        SELECT id
        FROM public.mink_workflow_runs
        WHERE (
          (status = 'queued' AND run_after <= now())
          OR (status = 'running' AND lease_expires_at <= now())
        )
          AND attempt_count < max_attempts
        ORDER BY run_after, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.mink_workflow_runs AS run
      SET status = 'running',
          lease_owner = ${workerId}::uuid,
          lease_expires_at = now() + (${WORKFLOW_LEASE_SECONDS}::int * interval '1 second'),
          attempt_count = run.attempt_count + 1,
          updated_at = now()
      FROM candidate
      WHERE run.id = candidate.id
      RETURNING run.id,
                run.store_id AS "storeId",
                run.admin_id AS "adminId",
                run.template,
                run.status,
                run.input_json AS "inputJson",
                run.current_step AS "currentStep",
                run.total_steps AS "totalSteps",
                run.attempt_count AS "attemptCount",
                run.max_attempts AS "maxAttempts",
                run.lease_owner AS "leaseOwner",
                run.cancel_requested_at AS "cancelRequestedAt"
    `);
    const run = parseClaimedWorkflow(claimed.rows[0]);
    if (run) {
      await insertWorkflowEvent(db, {
        runId: run.id,
        storeId: run.storeId,
        eventKey: `claimed:${run.attemptCount}`,
        eventType: "claimed",
        detail: { attempt: run.attemptCount },
      });
    }
    return run;
  });
}

function parseClaimedWorkflow(value: unknown): ClaimedWorkflow | null {
  const row = readObject(value);
  const cancelRequestedAt = normalizeTimestamp(row.cancelRequestedAt);
  if (
    typeof row.id !== "string" ||
    typeof row.storeId !== "string" ||
    typeof row.adminId !== "string" ||
    typeof row.template !== "string" ||
    row.status !== "running" ||
    !row.inputJson ||
    typeof row.inputJson !== "object" ||
    Array.isArray(row.inputJson) ||
    !Number.isInteger(row.currentStep) ||
    !Number.isInteger(row.totalSteps) ||
    !Number.isInteger(row.attemptCount) ||
    !Number.isInteger(row.maxAttempts) ||
    typeof row.leaseOwner !== "string" ||
    (row.cancelRequestedAt != null && cancelRequestedAt === null)
  ) {
    throw new Error("invalid_claimed_workflow_row");
  }
  return {
    id: row.id,
    storeId: row.storeId,
    adminId: row.adminId,
    template: row.template,
    status: "running",
    inputJson: row.inputJson,
    currentStep: row.currentStep as number,
    totalSteps: row.totalSteps as number,
    attemptCount: row.attemptCount as number,
    maxAttempts: row.maxAttempts as number,
    leaseOwner: row.leaseOwner,
    cancelRequestedAt,
  };
}

function normalizeTimestamp(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return null;
}

async function executeClaimedStep(
  run: ClaimedWorkflow,
  workerId: string,
  executionScope: WorkflowExecutionScope,
): Promise<{ completed: boolean }> {
  const stepKey = WORKFLOW_STEPS[run.currentStep];
  if (!stepKey || run.template !== "weekly_trading_report") {
    throw new Error("unsupported_workflow_step");
  }
  await markStepStarted(run, workerId, stepKey);
  if (stepKey === "snapshot") {
    const snapshot = await collectWeeklySnapshot(run, executionScope);
    await completeIntermediateStep(run, workerId, stepKey, snapshot);
    return { completed: false };
  }
  if (stepKey === "analyse") {
    const snapshot = await readStepOutput<WeeklyTradingReportSnapshot>(
      run,
      "snapshot",
    );
    const report = buildWeeklyTradingReportResult(snapshot);
    await completeIntermediateStep(run, workerId, stepKey, report);
    return { completed: false };
  }
  const report = await readStepOutput<WeeklyTradingReportResult>(
    run,
    "analyse",
  );
  await completeFinalStep(run, workerId, stepKey, report);
  return { completed: true };
}

async function collectWeeklySnapshot(
  run: ClaimedWorkflow,
  executionScope: WorkflowExecutionScope,
): Promise<WeeklyTradingReportSnapshot> {
  const input = readWeeklyInput(run.inputJson);
  const requestedAt = new Date(input.requestedAt);
  const range = parseAnalyticsRange(
    { range: "7d", compare: "previous" },
    input.timeZone,
    requestedAt,
  );
  const location = {
    locationIds: executionScope.locationIds,
    selectedId: null,
    includeUnassigned: input.includeUnassigned,
  };
  const [sales, topProducts, channels] = await Promise.all([
    getSalesAnalytics(run.storeId, location, range, "all"),
    getTopProducts(run.storeId, location, range, 5),
    getSalesByChannel(run.storeId, location, range),
  ]);
  return {
    rangeLabel: sales.rangeLabel,
    comparisonLabel: sales.comparisonLabel,
    fromInclusive: range.current.from.toISOString(),
    toExclusive: range.current.to.toISOString(),
    timeZone: range.timeZone,
    currency: input.currency,
    locationLabel: executionScope.locationLabel,
    netSales: sales.totalSales.value,
    netSalesTrendPercent: sales.totalSales.trendPct,
    orders: sales.orders.value,
    ordersTrendPercent: sales.orders.trendPct,
    averageOrderValue: sales.averageOrderValue.value,
    averageOrderValueTrendPercent: sales.averageOrderValue.trendPct,
    unitsSold: sales.unitsSold.value,
    unitsSoldTrendPercent: sales.unitsSold.trendPct,
    topProducts: topProducts.map((product) => ({
      ...product,
      dashboardPath: `/dashboard/products/${product.id}`,
    })),
    channels,
    dataAsOf: new Date().toISOString(),
  };
}

async function markStepStarted(
  run: ClaimedWorkflow,
  workerId: string,
  stepKey: string,
) {
  await withService(async (db) => {
    await assertActiveLease(db, run, workerId);
    const now = new Date().toISOString();
    await db
      .update(minkWorkflowSteps)
      .set({
        status: "running",
        attemptCount: sql`${minkWorkflowSteps.attemptCount} + 1`,
        startedAt: now,
        errorCode: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(minkWorkflowSteps.runId, run.id),
          eq(minkWorkflowSteps.storeId, run.storeId),
          eq(minkWorkflowSteps.stepKey, stepKey),
          inArray(minkWorkflowSteps.status, ["queued", "running"]),
        ),
      );
    await insertWorkflowEvent(db, {
      runId: run.id,
      storeId: run.storeId,
      eventKey: `step-started:${stepKey}:${run.attemptCount}`,
      eventType: "step_started",
      stepKey,
      detail: { attempt: run.attemptCount },
    });
  });
}

async function completeIntermediateStep(
  run: ClaimedWorkflow,
  workerId: string,
  stepKey: string,
  output: object,
) {
  await withService(async (db) => {
    await assertActiveLease(db, run, workerId);
    const now = new Date().toISOString();
    await db
      .update(minkWorkflowSteps)
      .set({
        status: "completed",
        outputJson: output,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(minkWorkflowSteps.runId, run.id),
          eq(minkWorkflowSteps.storeId, run.storeId),
          eq(minkWorkflowSteps.stepKey, stepKey),
          eq(minkWorkflowSteps.status, "running"),
        ),
      );
    await db
      .update(minkWorkflowRuns)
      .set({
        status: "queued",
        currentStep: run.currentStep + 1,
        runAfter: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(activeLeasePredicate(run, workerId));
    await insertWorkflowEvent(db, {
      runId: run.id,
      storeId: run.storeId,
      eventKey: `step-completed:${stepKey}`,
      eventType: "step_completed",
      stepKey,
      detail: {},
    });
  });
}

async function completeFinalStep(
  run: ClaimedWorkflow,
  workerId: string,
  stepKey: string,
  report: WeeklyTradingReportResult,
) {
  await withService(async (db) => {
    await assertActiveLease(db, run, workerId);
    const now = new Date().toISOString();
    await db
      .update(minkWorkflowSteps)
      .set({
        status: "completed",
        outputJson: { reportReady: true },
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(minkWorkflowSteps.runId, run.id),
          eq(minkWorkflowSteps.storeId, run.storeId),
          eq(minkWorkflowSteps.stepKey, stepKey),
          eq(minkWorkflowSteps.status, "running"),
        ),
      );
    await db
      .update(minkWorkflowRuns)
      .set({
        status: "completed",
        currentStep: run.totalSteps,
        resultJson: report,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(activeLeasePredicate(run, workerId));
    await insertWorkflowEvent(db, {
      runId: run.id,
      storeId: run.storeId,
      eventKey: `step-completed:${stepKey}`,
      eventType: "step_completed",
      stepKey,
      detail: {},
    });
    await insertWorkflowEvent(db, {
      runId: run.id,
      storeId: run.storeId,
      eventKey: "completed",
      eventType: "completed",
      detail: {},
    });
  });
}

async function readStepOutput<T extends object>(
  run: ClaimedWorkflow,
  stepKey: string,
): Promise<T> {
  return withService(async (db) => {
    const rows = await db
      .select({ output: minkWorkflowSteps.outputJson })
      .from(minkWorkflowSteps)
      .where(
        and(
          eq(minkWorkflowSteps.runId, run.id),
          eq(minkWorkflowSteps.storeId, run.storeId),
          eq(minkWorkflowSteps.stepKey, stepKey),
          eq(minkWorkflowSteps.status, "completed"),
        ),
      )
      .limit(1);
    const output = readObject(rows[0]?.output);
    if (!rows[0] || Object.keys(output).length === 0) {
      throw new Error(`missing_workflow_step:${stepKey}`);
    }
    return output as unknown as T;
  });
}

async function scheduleWorkflowRetry(
  run: ClaimedWorkflow,
  workerId: string,
  error: unknown,
): Promise<"retry" | "failed"> {
  const safeCode = workflowErrorCode(error);
  const terminal = run.attemptCount >= run.maxAttempts;
  await withService(async (db) => {
    const rows = await db
      .select({ id: minkWorkflowRuns.id })
      .from(minkWorkflowRuns)
      .where(activeLeasePredicate(run, workerId))
      .limit(1)
      .for("update");
    if (!rows[0]) return;
    const now = new Date();
    const nowIso = now.toISOString();
    await db
      .update(minkWorkflowSteps)
      .set({
        status: terminal ? "failed" : "queued",
        errorCode: safeCode,
        completedAt: terminal ? nowIso : null,
        updatedAt: nowIso,
      })
      .where(
        and(
          eq(minkWorkflowSteps.runId, run.id),
          eq(minkWorkflowSteps.storeId, run.storeId),
          eq(minkWorkflowSteps.position, run.currentStep),
          eq(minkWorkflowSteps.status, "running"),
        ),
      );
    await db
      .update(minkWorkflowRuns)
      .set(
        terminal
          ? {
              status: "failed",
              errorCode: safeCode,
              errorDetail:
                "Mink could not finish this report after safe retries.",
              completedAt: nowIso,
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: nowIso,
            }
          : {
              status: "queued",
              errorCode: safeCode,
              runAfter: new Date(
                now.getTime() + Math.min(60, 2 ** run.attemptCount) * 1_000,
              ).toISOString(),
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: nowIso,
            },
      )
      .where(activeLeasePredicate(run, workerId));
    await insertWorkflowEvent(db, {
      runId: run.id,
      storeId: run.storeId,
      eventKey: `${terminal ? "failed" : "retry"}:${run.attemptCount}`,
      eventType: terminal ? "failed" : "retry_scheduled",
      stepKey: WORKFLOW_STEPS[run.currentStep],
      detail: { attempt: run.attemptCount, code: safeCode },
    });
  });
  if (terminal) {
    logError("mink workflow worker: workflow failed", error, {
      workflowId: run.id,
      storeId: run.storeId,
      code: safeCode,
    });
    return "failed";
  }
  logWarn("mink workflow worker: retry scheduled", {
    workflowId: run.id,
    storeId: run.storeId,
    attempt: run.attemptCount,
    code: safeCode,
  });
  return "retry";
}

async function cancelClaimedWorkflow(
  run: ClaimedWorkflow,
  workerId: string,
  reason: string,
) {
  await withService(async (db) => {
    await assertActiveLease(db, run, workerId, true);
    const now = new Date().toISOString();
    await db
      .update(minkWorkflowRuns)
      .set({
        status: "cancelled",
        errorCode: reason,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(activeLeasePredicate(run, workerId));
    await db
      .update(minkWorkflowSteps)
      .set({ status: "cancelled", completedAt: now, updatedAt: now })
      .where(
        and(
          eq(minkWorkflowSteps.runId, run.id),
          eq(minkWorkflowSteps.storeId, run.storeId),
          inArray(minkWorkflowSteps.status, [
            "queued",
            "running",
            "waiting_approval",
          ]),
        ),
      );
    await insertWorkflowEvent(db, {
      runId: run.id,
      storeId: run.storeId,
      eventKey: "cancelled",
      eventType: "cancelled",
      detail: { reason },
    });
  });
}

function ownerPredicate(actor: MinkActorContext, workflowId: string) {
  return and(
    eq(minkWorkflowRuns.id, workflowId),
    eq(minkWorkflowRuns.storeId, actor.storeId),
    eq(minkWorkflowRuns.adminId, actor.adminId),
  );
}

function activeLeasePredicate(run: ClaimedWorkflow, workerId: string) {
  return and(
    eq(minkWorkflowRuns.id, run.id),
    eq(minkWorkflowRuns.storeId, run.storeId),
    eq(minkWorkflowRuns.status, "running"),
    eq(minkWorkflowRuns.leaseOwner, workerId),
  );
}

async function assertActiveLease(
  db: Db,
  run: ClaimedWorkflow,
  workerId: string,
  allowCancellation = false,
) {
  const rows = await db
    .select({
      id: minkWorkflowRuns.id,
      cancelRequestedAt: minkWorkflowRuns.cancelRequestedAt,
    })
    .from(minkWorkflowRuns)
    .where(activeLeasePredicate(run, workerId))
    .limit(1)
    .for("update");
  if (!rows[0]) throw new Error("workflow_lease_lost");
  if (rows[0].cancelRequestedAt && !allowCancellation) {
    throw new WorkflowCancellationRequestedError();
  }
}

async function insertWorkflowEvent(
  db: Db,
  input: {
    runId: string;
    storeId: string;
    eventKey: string;
    eventType: string;
    stepKey?: string;
    detail: Record<string, unknown>;
  },
) {
  await db
    .insert(minkWorkflowEvents)
    .values({
      runId: input.runId,
      storeId: input.storeId,
      eventKey: input.eventKey,
      eventType: input.eventType,
      stepKey: input.stepKey,
      detailJson: input.detail,
    })
    .onConflictDoNothing({
      target: [minkWorkflowEvents.runId, minkWorkflowEvents.eventKey],
    });
}

function toWorkflowView(
  run: WorkflowRow,
  events?: MinkWorkflowEventView[],
): MinkWorkflowView {
  if (!isMinkWorkflowStatus(run.status)) {
    throw new Error("Invalid Mink workflow status");
  }
  return {
    id: run.id,
    template: "weekly_trading_report",
    status: run.status as MinkWorkflowStatus,
    currentStep: run.currentStep,
    totalSteps: run.totalSteps,
    attemptCount: run.attemptCount,
    errorCode: run.errorCode,
    errorDetail: run.errorDetail,
    cancelRequested: run.cancelRequestedAt !== null,
    result:
      run.status === "completed"
        ? (readObject(run.resultJson) as unknown as WeeklyTradingReportResult)
        : null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    ...(events ? { events } : {}),
  };
}

function readWeeklyInput(value: unknown): WeeklyTradingReportInput {
  const row = readObject(value);
  if (
    typeof row.timeZone !== "string" ||
    typeof row.currency !== "string" ||
    !Array.isArray(row.locationIds) ||
    !row.locationIds.every((id) => typeof id === "string") ||
    typeof row.restrictedLocationScope !== "boolean" ||
    typeof row.includeUnassigned !== "boolean" ||
    typeof row.locationLabel !== "string" ||
    !(row.requesterEmail === null || typeof row.requesterEmail === "string") ||
    typeof row.requestedAt !== "string" ||
    Number.isNaN(new Date(row.requestedAt).getTime())
  ) {
    throw new Error("invalid_weekly_report_input");
  }
  return row as unknown as WeeklyTradingReportInput;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function workflowErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "workflow_step_failed";
  if (/^[a-z0-9_:.-]{1,100}$/i.test(error.message)) return error.message;
  return "workflow_step_failed";
}
