import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  minkActionApprovals,
  minkActionAudit,
  minkActionToolAccess,
  minkDrafts,
  orders,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { normalizeMinkDraftContent } from "./draft-types";
import { MinkRequestError } from "./errors";
import type {
  MinkOrderStatusActionApproval,
  MinkOrderStatusActionResult,
  MinkOrderStatusActionValues,
  MinkOrderStatusExecutionResult,
} from "./order-status-action-types";
import { evaluateMinkOrderTransition } from "./order-status-policy";
import {
  readMinkOrderStatusTarget,
  type MinkOrderStatusTargetRecord,
} from "./order-status-target";
import type { MinkActorContext } from "./types";
import { hashMinkActionPayload } from "./action-integrity";

const APPROVAL_TTL_MS = 5 * 60 * 1_000;
const TOOL_VERSION = 1;

type ApprovalRow = typeof minkActionApprovals.$inferSelect & {
  toolName: "transition_order_status";
  operation: "apply";
  status: "pending" | "executed" | "conflicted" | "expired" | "cancelled";
  resourceType: "order";
  resourceId: string;
};

export async function getLatestMinkOrderStatusAction(
  actor: MinkActorContext,
  draftId: string,
): Promise<MinkOrderStatusActionResult | null> {
  return withService(async (db) => {
    assertOrderAuthority(actor);
    const rows = await db
      .select()
      .from(minkActionApprovals)
      .where(
        and(
          eq(minkActionApprovals.storeId, actor.storeId),
          eq(minkActionApprovals.adminId, actor.adminId),
          eq(minkActionApprovals.draftId, draftId),
          eq(minkActionApprovals.toolName, "transition_order_status"),
          eq(minkActionApprovals.status, "executed"),
        ),
      )
      .orderBy(desc(minkActionApprovals.executedAt))
      .limit(1);
    if (!rows[0]) return null;
    const approval = validateApproval(rows[0]);
    const audit = await readAudit(db, actor.storeId, approval.id);
    return {
      approval: toApproval(approval),
      auditId: audit?.id ?? null,
      repeated: true,
    };
  });
}

export async function previewMinkOrderStatusAction(input: {
  actor: MinkActorContext;
  draftId: string;
  expectedDraftVersion: number;
  idempotencyKey: string;
}): Promise<MinkOrderStatusActionApproval> {
  return withService(async (db) => {
    assertOrderAuthority(input.actor);
    await lockDraft(db, input.actor, input.draftId);
    const draft = await readDraft(db, input.actor, input.draftId);
    if (draft.currentVersion !== input.expectedDraftVersion) {
      throw conflict(
        "mink_order_draft_conflict",
        "The saved order-status proposal changed. Save and review it again.",
      );
    }
    await assertToolEnabled(db, input.actor.storeId);
    const order = await readMinkOrderStatusTarget(db, input.actor, {
      orderId: draft.destinationId!,
    });
    const content = normalizeOrderContent(draft.content);
    const initialStatus = readInitialStatus(draft.before);
    if (initialStatus !== order.status) throw orderConflict();
    const decision = evaluateMinkOrderTransition(order, content.target_status);
    if (!decision.allowed) {
      throw conflict(decision.code, decision.message);
    }
    const before = values(order, null);
    const after = values(order, {
      targetStatus: decision.targetStatus,
      note: content.note,
    });
    return createApproval(db, {
      actor: input.actor,
      draftId: draft.id,
      draftVersion: draft.currentVersion,
      order,
      before,
      after,
      idempotencyKey: input.idempotencyKey,
    });
  });
}

export async function executeMinkOrderStatusAction(input: {
  actor: MinkActorContext;
  draftId: string;
  approvalId: string;
}): Promise<MinkOrderStatusExecutionResult> {
  const outcome = await withService(async (db) => {
    assertOrderAuthority(input.actor);
    await lockApproval(db, input.actor, input.approvalId);
    const approval = await readApproval(db, input.actor, input.approvalId);
    if (approval.draftId !== input.draftId) throw approvalNotFound();
    if (approval.status === "executed") {
      const audit = await readAudit(db, input.actor.storeId, approval.id);
      return {
        result: {
          approval: toApproval(approval),
          auditId: audit?.id ?? null,
          repeated: true,
          eventCustomerId: null,
        },
      };
    }
    if (approval.status !== "pending") {
      throw conflict(
        "mink_order_approval_terminal",
        "This order-status approval is no longer available.",
      );
    }
    await assertToolEnabled(db, input.actor.storeId, true);
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      await finalizeWithoutWrite(
        db,
        approval,
        "expired",
        "Approval expired before execution.",
      );
      return {
        error: conflict(
          "mink_order_approval_expired",
          "This order-status approval expired. Review the latest order and create a new preview.",
        ),
      };
    }
    await lockDraft(db, input.actor, approval.draftId);
    const draft = await readDraft(db, input.actor, approval.draftId);
    const content = normalizeOrderContent(draft.content);
    const approvedAfter = valuesFromJson(approval.afterJson);
    if (
      draft.currentVersion !== approval.draftVersion ||
      approvedAfter.status !== content.target_status ||
      (approvedAfter.note ?? "") !== content.note
    ) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The saved order-status proposal changed after preview.",
      );
      return {
        error: conflict(
          "mink_order_draft_conflict",
          "The saved order-status proposal changed after preview. Review it again.",
        ),
      };
    }
    await lockOrder(db, input.actor, approval.resourceId);
    let order: MinkOrderStatusTargetRecord;
    try {
      order = await readMinkOrderStatusTarget(db, input.actor, {
        orderId: approval.resourceId,
      });
    } catch (error) {
      if (!(error instanceof MinkRequestError)) throw error;
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "Order was deleted, reassigned or left the approving admin's location scope.",
      );
      return {
        error: conflict(
          "mink_order_state_conflict",
          "This order is no longer available in your current store and location access. Review the order before trying again.",
        ),
      };
    }
    const currentValues = values(order, null);
    const approvedBefore = valuesFromJson(approval.beforeJson);
    if (
      order.updatedAt !== approval.resourceVersion ||
      hashMinkActionPayload(currentValues) !==
        hashMinkActionPayload(approvedBefore)
    ) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "Order, payment, cancellation, location or shipment state changed after preview.",
        order.updatedAt,
      );
      return { error: orderConflict() };
    }
    const decision = evaluateMinkOrderTransition(order, approvedAfter.status);
    if (!decision.allowed) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        `Execution policy rejected the transition: ${decision.code}.`,
        order.updatedAt,
      );
      return { error: conflict(decision.code, decision.message) };
    }
    if (
      approval.requestHash !==
      requestHash(approval, approvedBefore, approvedAfter)
    ) {
      throw invalidApproval();
    }
    const now = new Date().toISOString();
    const updated = await db
      .update(orders)
      .set({
        status: decision.targetStatus,
        updatedAt: now,
        ...(decision.targetStatus === "delivered"
          ? { deliveredAt: sql`coalesce(${orders.deliveredAt}, now())` }
          : {}),
      })
      .where(
        and(
          eq(orders.id, order.id),
          eq(orders.storeId, input.actor.storeId),
          eq(orders.status, order.status),
          eq(orders.updatedAt, order.updatedAt),
        ),
      )
      .returning({ id: orders.id, updatedAt: orders.updatedAt });
    if (!updated[0]) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "Order changed during execution.",
      );
      return { error: orderConflict() };
    }
    const finalized = await db
      .update(minkActionApprovals)
      .set({
        status: "executed",
        approvedAt: now,
        executedAt: now,
        resultId: updated[0].id,
        resultVersion: updated[0].updatedAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(minkActionApprovals.id, approval.id),
          eq(minkActionApprovals.storeId, input.actor.storeId),
          eq(minkActionApprovals.status, "pending"),
        ),
      )
      .returning({ id: minkActionApprovals.id });
    if (!finalized[0]) throw invalidApproval();
    const auditId = crypto.randomUUID();
    await db.insert(minkActionAudit).values({
      id: auditId,
      approvalId: approval.id,
      storeId: approval.storeId,
      adminId: approval.adminId,
      draftId: approval.draftId,
      productId: null,
      resourceType: "order",
      resourceId: approval.resourceId,
      locationId: null,
      variantId: null,
      resourceVersionBefore: approval.resourceVersion,
      resourceVersionAfter: updated[0].updatedAt,
      resultId: updated[0].id,
      toolName: "transition_order_status",
      operation: "apply",
      outcome: "executed",
      beforeJson: approvedBefore,
      afterJson: approvedAfter,
      productVersionBefore: null,
      productVersionAfter: null,
      requestHash: approval.requestHash,
      toolVersion: TOOL_VERSION,
      detail: `Approved one-step order transition ${order.status} -> ${decision.targetStatus}.`,
    });
    return {
      result: {
        approval: toApproval({
          ...approval,
          status: "executed",
          approvedAt: now,
          executedAt: now,
          resultId: updated[0].id,
          resultVersion: updated[0].updatedAt,
        }),
        auditId,
        repeated: false,
        eventCustomerId: order.customerId,
      },
    };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

async function createApproval(
  db: Db,
  input: {
    actor: MinkActorContext;
    draftId: string;
    draftVersion: number;
    order: MinkOrderStatusTargetRecord;
    before: MinkOrderStatusActionValues;
    after: MinkOrderStatusActionValues;
    idempotencyKey: string;
  },
) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const hash = hashMinkActionPayload({
    storeId: input.actor.storeId,
    adminId: input.actor.adminId,
    draftId: input.draftId,
    draftVersion: input.draftVersion,
    resourceId: input.order.id,
    resourceVersion: input.order.updatedAt,
    before: input.before,
    after: input.after,
  });
  const inserted = await db
    .insert(minkActionApprovals)
    .values({
      id,
      storeId: input.actor.storeId,
      adminId: input.actor.adminId,
      draftId: input.draftId,
      productId: null,
      resourceType: "order",
      resourceId: input.order.id,
      resourceVersion: input.order.updatedAt,
      resourceLabel: input.order.reference,
      locationId: null,
      variantId: null,
      sourceApprovalId: null,
      toolName: "transition_order_status",
      operation: "apply",
      draftVersion: input.draftVersion,
      productVersion: null,
      beforeJson: input.before,
      afterJson: input.after,
      requestHash: hash,
      idempotencyKey: input.idempotencyKey,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0]
    ? validateApproval(inserted[0])
    : await readByIdempotency(db, input.actor, input.idempotencyKey);
  if (row.requestHash !== hash) {
    throw conflict(
      "mink_order_idempotency_conflict",
      "This approval request key was already used for a different preview.",
    );
  }
  return toApproval(row);
}

async function readDraft(db: Db, actor: MinkActorContext, draftId: string) {
  const rows = await db
    .select({
      id: minkDrafts.id,
      kind: minkDrafts.kind,
      status: minkDrafts.status,
      destinationId: minkDrafts.destinationId,
      before: minkDrafts.beforeJson,
      content: minkDrafts.contentJson,
      currentVersion: minkDrafts.currentVersion,
    })
    .from(minkDrafts)
    .where(
      and(
        eq(minkDrafts.id, draftId),
        eq(minkDrafts.storeId, actor.storeId),
        eq(minkDrafts.adminId, actor.adminId),
      ),
    )
    .limit(1);
  const draft = rows[0];
  if (
    !draft ||
    draft.kind !== "order_status_transition" ||
    draft.status !== "draft" ||
    draft.currentVersion < 1 ||
    !draft.destinationId
  ) {
    throw new MinkRequestError(
      "mink_order_draft_unavailable",
      "Save this private order-status proposal before reviewing it.",
      409,
    );
  }
  return draft;
}

function normalizeOrderContent(value: unknown) {
  try {
    return normalizeMinkDraftContent("order_status_transition", value);
  } catch (error) {
    throw new MinkRequestError(
      "mink_order_draft_invalid",
      error instanceof Error ? error.message : "Invalid order-status proposal.",
      400,
    );
  }
}

function readInitialStatus(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const status = (value as Record<string, unknown>).target_status;
  return typeof status === "string" ? status : "";
}

function values(
  order: MinkOrderStatusTargetRecord,
  proposal: { targetStatus: string; note: string } | null,
): MinkOrderStatusActionValues {
  return {
    order_ref: order.reference,
    status: proposal?.targetStatus ?? order.status,
    payment_status: order.paymentStatus,
    payment_method: order.paymentMethod,
    channel: order.salesChannel,
    fulfilment: order.fulfilmentType,
    location: order.locationName ?? "Unassigned",
    cancellation_status: order.cancellationStatus,
    shipment_status: order.shipmentStatus,
    note: proposal?.note ?? null,
  };
}

function toApproval(row: ApprovalRow): MinkOrderStatusActionApproval {
  const reference = row.resourceLabel ?? "Order";
  return {
    id: row.id,
    sourceApprovalId: null,
    toolName: "transition_order_status",
    operation: "apply",
    status: row.status,
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    resource: {
      type: "order",
      id: row.resourceId,
      label: reference,
      dashboardPath: `/dashboard/orders?q=${encodeURIComponent(reference)}`,
    },
    before: valuesFromJson(row.beforeJson),
    after: valuesFromJson(row.afterJson),
    expiresAt: row.expiresAt,
    executedAt: row.executedAt,
  };
}

function validateApproval(
  row: typeof minkActionApprovals.$inferSelect,
): ApprovalRow {
  if (
    row.toolName !== "transition_order_status" ||
    row.operation !== "apply" ||
    !["pending", "executed", "conflicted", "expired", "cancelled"].includes(
      row.status,
    ) ||
    row.resourceType !== "order" ||
    !row.resourceId ||
    row.productId ||
    row.locationId ||
    row.variantId ||
    row.sourceApprovalId
  ) {
    throw invalidApproval();
  }
  return row as ApprovalRow;
}

async function assertToolEnabled(db: Db, storeId: string, lock = false) {
  if (lock) {
    const result = await db.execute(sql`
      select enabled from public.mink_action_tool_access
      where store_id = ${storeId}::uuid
        and tool_name = 'transition_order_status'
      for update
    `);
    if ((result.rows[0] as { enabled?: boolean } | undefined)?.enabled) return;
  } else {
    const rows = await db
      .select({ enabled: minkActionToolAccess.enabled })
      .from(minkActionToolAccess)
      .where(
        and(
          eq(minkActionToolAccess.storeId, storeId),
          eq(minkActionToolAccess.toolName, "transition_order_status"),
        ),
      )
      .limit(1);
    if (rows[0]?.enabled) return;
  }
  throw new MinkRequestError(
    "mink_order_tool_disabled",
    "StoreMink support has not enabled Mink delivery order-status transitions for this store.",
    403,
  );
}

function assertOrderAuthority(actor: MinkActorContext) {
  if (
    !actor.draftingEnabled ||
    !can(actor.permissions, "orders", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_order_access_denied",
      "You do not have permission to manage this order through Mink.",
      403,
    );
  }
}

async function lockDraft(db: Db, actor: MinkActorContext, draftId: string) {
  await db.execute(sql`
    select id from public.mink_drafts
    where id = ${draftId}::uuid and store_id = ${actor.storeId}::uuid
      and admin_id = ${actor.adminId}
    for update
  `);
}

async function lockApproval(
  db: Db,
  actor: MinkActorContext,
  approvalId: string,
) {
  await db.execute(sql`
    select id from public.mink_action_approvals
    where id = ${approvalId}::uuid and store_id = ${actor.storeId}::uuid
      and admin_id = ${actor.adminId}
    for update
  `);
}

async function lockOrder(db: Db, actor: MinkActorContext, orderId: string) {
  await db.execute(sql`
    select id from public.orders
    where id = ${orderId}::uuid and store_id = ${actor.storeId}::uuid
    for update
  `);
}

async function readApproval(db: Db, actor: MinkActorContext, id: string) {
  const rows = await db
    .select()
    .from(minkActionApprovals)
    .where(
      and(
        eq(minkActionApprovals.id, id),
        eq(minkActionApprovals.storeId, actor.storeId),
        eq(minkActionApprovals.adminId, actor.adminId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw approvalNotFound();
  return validateApproval(rows[0]);
}

async function readByIdempotency(
  db: Db,
  actor: MinkActorContext,
  idempotencyKey: string,
) {
  const rows = await db
    .select()
    .from(minkActionApprovals)
    .where(
      and(
        eq(minkActionApprovals.storeId, actor.storeId),
        eq(minkActionApprovals.adminId, actor.adminId),
        eq(minkActionApprovals.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (!rows[0]) throw approvalNotFound();
  return validateApproval(rows[0]);
}

async function readAudit(db: Db, storeId: string, approvalId: string) {
  const rows = await db
    .select({ id: minkActionAudit.id })
    .from(minkActionAudit)
    .where(
      and(
        eq(minkActionAudit.storeId, storeId),
        eq(minkActionAudit.approvalId, approvalId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function finalizeWithoutWrite(
  db: Db,
  approval: ApprovalRow,
  status: "conflicted" | "expired",
  detail: string,
  resourceVersionAfter: string | null = null,
) {
  await db
    .update(minkActionApprovals)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(minkActionApprovals.id, approval.id),
        eq(minkActionApprovals.storeId, approval.storeId),
      ),
    );
  await db.insert(minkActionAudit).values({
    id: crypto.randomUUID(),
    approvalId: approval.id,
    storeId: approval.storeId,
    adminId: approval.adminId,
    draftId: approval.draftId,
    productId: null,
    resourceType: "order",
    resourceId: approval.resourceId,
    locationId: null,
    variantId: null,
    resourceVersionBefore: approval.resourceVersion,
    resourceVersionAfter,
    resultId: null,
    toolName: "transition_order_status",
    operation: "apply",
    outcome: status,
    beforeJson: valuesFromJson(approval.beforeJson),
    afterJson: valuesFromJson(approval.afterJson),
    productVersionBefore: null,
    productVersionAfter: null,
    requestHash: approval.requestHash,
    toolVersion: TOOL_VERSION,
    detail,
  });
}

function requestHash(
  approval: ApprovalRow,
  before: MinkOrderStatusActionValues,
  after: MinkOrderStatusActionValues,
) {
  return hashMinkActionPayload({
    storeId: approval.storeId,
    adminId: approval.adminId,
    draftId: approval.draftId,
    draftVersion: approval.draftVersion,
    resourceId: approval.resourceId,
    resourceVersion: approval.resourceVersion,
    before,
    after,
  });
}

function valuesFromJson(value: unknown): MinkOrderStatusActionValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidApproval();
  }
  const result: MinkOrderStatusActionValues = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && typeof item !== "string") throw invalidApproval();
    result[key] = item;
  }
  return result;
}

function invalidApproval() {
  return new MinkRequestError(
    "mink_order_approval_invalid",
    "This order-status approval is invalid. Create a new preview.",
    409,
  );
}

function approvalNotFound() {
  return new MinkRequestError(
    "mink_order_approval_not_found",
    "This order-status approval is unavailable.",
    404,
  );
}

function orderConflict() {
  return conflict(
    "mink_order_state_conflict",
    "This order, payment, cancellation, location or shipment state changed after preview. Review the latest order before trying again.",
  );
}

function conflict(code: string, message: string) {
  return new MinkRequestError(code, message, 409);
}
