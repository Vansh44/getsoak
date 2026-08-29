import "server-only";

import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  minkActionApprovals,
  minkActionAudit,
  minkActionToolAccess,
  minkDrafts,
  products,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { normalizeMinkDraftContent } from "./draft-types";
import { MinkRequestError } from "./errors";
import {
  actionFieldsForTool,
  actionToolForDraftKind,
  draftContentForAction,
  isMinkProductActionTool,
  type MinkProductActionApproval,
  type MinkProductActionOperation,
  type MinkProductActionResult,
  type MinkProductActionStatus,
  type MinkProductActionTool,
  type MinkProductActionValues,
} from "./product-action-types";
import type { MinkActorContext } from "./types";

const APPROVAL_TTL_MS = 10 * 60 * 1_000;
const TOOL_VERSION = 1;

export async function getLatestMinkProductAction(
  actor: MinkActorContext,
  draftId: string,
): Promise<MinkProductActionResult | null> {
  assertProductActionAuthority(actor);
  return withService(async (db) => {
    const rows = await db
      .select()
      .from(minkActionApprovals)
      .where(
        and(
          eq(minkActionApprovals.storeId, actor.storeId),
          eq(minkActionApprovals.adminId, actor.adminId),
          eq(minkActionApprovals.draftId, draftId),
          eq(minkActionApprovals.status, "executed"),
        ),
      )
      .orderBy(desc(minkActionApprovals.executedAt))
      .limit(1);
    if (!rows[0]) return null;
    const approval = validateApprovalRow(rows[0]);
    const [product, audit] = await Promise.all([
      readProduct(db, actor.storeId, approval.productId),
      readApprovalAudit(db, actor.storeId, approval.id),
    ]);
    return {
      approval: toApproval(approval, product),
      auditId: audit?.id ?? null,
      repeated: true,
    };
  });
}

export async function previewMinkProductAction(input: {
  actor: MinkActorContext;
  draftId: string;
  expectedDraftVersion: number;
  idempotencyKey: string;
}): Promise<MinkProductActionApproval> {
  assertProductActionAuthority(input.actor);
  return withService(async (db) => {
    await lockOwnedDraft(db, input.actor, input.draftId);
    const draft = await readSavedProductDraft(db, input.actor, input.draftId);
    if (draft.currentVersion !== input.expectedDraftVersion) {
      throw versionConflict();
    }
    const tool = actionToolForDraftKind(draft.kind);
    if (!tool) throw unsupportedDraft();
    await assertToolEnabled(db, input.actor.storeId, tool);

    const product = await readProduct(db, input.actor.storeId, draft.productId);
    const draftContent = normalizeDraftContent(draft.kind, draft.content);
    const before = productValues(tool, product);
    const after = draftContentForAction(tool, draftContent);
    if (sameValues(tool, before, after)) {
      throw new MinkRequestError(
        "mink_action_no_change",
        "This saved draft already matches the product.",
        409,
      );
    }
    return createApproval(db, {
      actor: input.actor,
      draftId: draft.id,
      draftVersion: draft.currentVersion,
      product,
      tool,
      operation: "apply",
      sourceApprovalId: null,
      before,
      after,
      idempotencyKey: input.idempotencyKey,
    });
  });
}

export async function previewMinkProductActionRollback(input: {
  actor: MinkActorContext;
  draftId: string;
  sourceApprovalId: string;
  idempotencyKey: string;
}): Promise<MinkProductActionApproval> {
  assertProductActionAuthority(input.actor);
  return withService(async (db) => {
    await lockOwnedApproval(db, input.actor, input.sourceApprovalId);
    const source = await readOwnedApproval(
      db,
      input.actor,
      input.sourceApprovalId,
    );
    if (source.draftId !== input.draftId) throw approvalNotFound();
    if (source.status !== "executed" || source.operation !== "apply") {
      throw new MinkRequestError(
        "mink_action_rollback_unavailable",
        "Only a completed product action can be rolled back.",
        409,
      );
    }
    if (!isMinkProductActionTool(source.toolName)) throw invalidApproval();
    await assertToolEnabled(db, input.actor.storeId, source.toolName);
    const audit = await readApprovalAudit(db, input.actor.storeId, source.id);
    if (!audit?.productVersionAfter) {
      throw new MinkRequestError(
        "mink_action_rollback_unavailable",
        "The completed action does not have a safe rollback checkpoint.",
        409,
      );
    }
    const product = await readProduct(
      db,
      input.actor.storeId,
      source.productId,
    );
    const current = productValues(source.toolName, product);
    const sourceAfter = readActionValues(source.toolName, source.afterJson);
    if (
      product.contentUpdatedAt !== audit.productVersionAfter ||
      !sameValues(source.toolName, current, sourceAfter)
    ) {
      throw new MinkRequestError(
        "mink_action_product_conflict",
        "The product changed after this Mink action. Review the current product instead of rolling it back automatically.",
        409,
      );
    }
    return createApproval(db, {
      actor: input.actor,
      draftId: source.draftId,
      draftVersion: source.draftVersion,
      product,
      tool: source.toolName,
      operation: "rollback",
      sourceApprovalId: source.id,
      before: current,
      after: readActionValues(source.toolName, source.beforeJson),
      idempotencyKey: input.idempotencyKey,
    });
  });
}

export async function executeMinkProductAction(input: {
  actor: MinkActorContext;
  draftId: string;
  approvalId: string;
}): Promise<MinkProductActionResult> {
  assertProductActionAuthority(input.actor);
  const outcome = await withService(async (db) => {
    await lockOwnedApproval(db, input.actor, input.approvalId);
    const approval = await readOwnedApproval(db, input.actor, input.approvalId);
    if (approval.draftId !== input.draftId) throw approvalNotFound();
    if (!isMinkProductActionTool(approval.toolName)) throw invalidApproval();

    if (approval.status === "executed") {
      const [product, audit] = await Promise.all([
        readProduct(db, input.actor.storeId, approval.productId),
        readApprovalAudit(db, input.actor.storeId, approval.id),
      ]);
      return {
        result: {
          approval: toApproval(approval, product),
          auditId: audit?.id ?? null,
          repeated: true,
        },
      };
    }
    if (approval.status !== "pending") {
      return terminalError(approval.status);
    }

    await assertToolEnabled(db, input.actor.storeId, approval.toolName, true);
    const product = await readProduct(
      db,
      input.actor.storeId,
      approval.productId,
    );
    const before = readActionValues(approval.toolName, approval.beforeJson);
    const after = readActionValues(approval.toolName, approval.afterJson);

    if (Date.parse(approval.expiresAt) <= Date.now()) {
      const auditId = await finalizeWithoutWrite(db, approval, product, {
        status: "expired",
        detail: "Approval expired before execution.",
      });
      return {
        error: new MinkRequestError(
          "mink_action_approval_expired",
          "This approval expired. Review the latest product and create a new preview.",
          409,
        ),
        auditId,
      };
    }

    if (approval.operation === "apply") {
      const draftConflict = await hasDraftConflict(db, input.actor, approval);
      if (draftConflict) {
        const auditId = await finalizeWithoutWrite(db, approval, product, {
          status: "conflicted",
          detail: "The saved private draft changed after preview.",
        });
        return {
          error: new MinkRequestError(
            "mink_action_draft_conflict",
            "The private draft changed after this preview. Review it again before applying.",
            409,
          ),
          auditId,
        };
      }
    } else if (await hasRollbackSourceConflict(db, input.actor, approval)) {
      const auditId = await finalizeWithoutWrite(db, approval, product, {
        status: "conflicted",
        detail: "The source action is no longer a valid rollback checkpoint.",
      });
      return {
        error: new MinkRequestError(
          "mink_action_rollback_conflict",
          "The rollback checkpoint is no longer valid. Review the current product.",
          409,
        ),
        auditId,
      };
    }

    const current = productValues(approval.toolName, product);
    if (
      product.contentUpdatedAt !== approval.productVersion ||
      !sameValues(approval.toolName, current, before)
    ) {
      const auditId = await finalizeWithoutWrite(db, approval, product, {
        status: "conflicted",
        detail: "The product content changed after preview.",
      });
      return {
        error: new MinkRequestError(
          "mink_action_product_conflict",
          "The product changed after this preview. Nothing was applied; review the latest product.",
          409,
        ),
        auditId,
      };
    }

    const now = new Date().toISOString();
    const updated = await db
      .update(products)
      .set({
        ...productUpdate(approval.toolName, after),
        updatedBy: input.actor.adminId,
        updatedAt: now,
      })
      .where(
        and(
          eq(products.id, approval.productId),
          eq(products.storeId, input.actor.storeId),
          eq(products.contentUpdatedAt, approval.productVersion),
        ),
      )
      .returning({
        id: products.id,
        name: products.name,
        slug: products.slug,
        description: products.description,
        seoTitle: products.seoTitle,
        seoDescription: products.seoDescription,
        contentUpdatedAt: products.contentUpdatedAt,
      });
    if (!updated[0]) {
      const auditId = await finalizeWithoutWrite(db, approval, product, {
        status: "conflicted",
        detail: "The product version changed during execution.",
      });
      return {
        error: new MinkRequestError(
          "mink_action_product_conflict",
          "The product changed while Mink was applying the action. Nothing was applied.",
          409,
        ),
        auditId,
      };
    }

    await db
      .update(minkActionApprovals)
      .set({
        status: "executed",
        approvedAt: now,
        executedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(minkActionApprovals.id, approval.id),
          eq(minkActionApprovals.storeId, input.actor.storeId),
        ),
      );
    const auditId = crypto.randomUUID();
    await db.insert(minkActionAudit).values({
      id: auditId,
      approvalId: approval.id,
      storeId: approval.storeId,
      adminId: approval.adminId,
      draftId: approval.draftId,
      productId: approval.productId,
      toolName: approval.toolName,
      operation: approval.operation,
      outcome: "executed",
      beforeJson: before,
      afterJson: after,
      productVersionBefore: approval.productVersion,
      productVersionAfter: updated[0].contentUpdatedAt,
      requestHash: approval.requestHash,
      toolVersion: TOOL_VERSION,
      detail:
        approval.operation === "apply"
          ? "Approved product-content action executed."
          : "Approved product-content rollback executed.",
    });
    return {
      result: {
        approval: toApproval(
          { ...approval, status: "executed", approvedAt: now, executedAt: now },
          updated[0],
        ),
        auditId,
        repeated: false,
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
    product: ProductRow;
    tool: MinkProductActionTool;
    operation: MinkProductActionOperation;
    sourceApprovalId: string | null;
    before: MinkProductActionValues;
    after: MinkProductActionValues;
    idempotencyKey: string;
  },
): Promise<MinkProductActionApproval> {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const requestHash = hashRequest({
    storeId: input.actor.storeId,
    adminId: input.actor.adminId,
    draftId: input.draftId,
    draftVersion: input.draftVersion,
    productId: input.product.id,
    productVersion: input.product.contentUpdatedAt,
    tool: input.tool,
    operation: input.operation,
    sourceApprovalId: input.sourceApprovalId,
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
      productId: input.product.id,
      sourceApprovalId: input.sourceApprovalId,
      toolName: input.tool,
      operation: input.operation,
      draftVersion: input.draftVersion,
      productVersion: input.product.contentUpdatedAt,
      beforeJson: input.before,
      afterJson: input.after,
      requestHash,
      idempotencyKey: input.idempotencyKey,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0]
    ? validateApprovalRow(inserted[0])
    : await readApprovalByIdempotency(db, input.actor, input.idempotencyKey);
  if (row.requestHash !== requestHash) {
    throw new MinkRequestError(
      "mink_action_idempotency_conflict",
      "This approval request key was already used for a different preview.",
      409,
    );
  }
  return toApproval(row, input.product);
}

async function hasDraftConflict(
  db: Db,
  actor: MinkActorContext,
  approval: ApprovalRow,
) {
  await lockOwnedDraft(db, actor, approval.draftId);
  try {
    const draft = await readSavedProductDraft(db, actor, approval.draftId);
    if (draft.currentVersion !== approval.draftVersion) return true;
    const tool = actionToolForDraftKind(draft.kind);
    if (tool !== approval.toolName) return true;
    const content = normalizeDraftContent(draft.kind, draft.content);
    return !sameValues(
      approval.toolName,
      draftContentForAction(approval.toolName, content),
      readActionValues(approval.toolName, approval.afterJson),
    );
  } catch (error) {
    if (error instanceof MinkRequestError) return true;
    throw error;
  }
}

async function hasRollbackSourceConflict(
  db: Db,
  actor: MinkActorContext,
  approval: ApprovalRow,
) {
  if (!approval.sourceApprovalId) return true;
  await lockOwnedApproval(db, actor, approval.sourceApprovalId);
  const source = await readOwnedApproval(db, actor, approval.sourceApprovalId);
  const audit = await readApprovalAudit(db, actor.storeId, source.id);
  return (
    source.status !== "executed" ||
    source.operation !== "apply" ||
    source.toolName !== approval.toolName ||
    source.productId !== approval.productId ||
    !audit?.productVersionAfter ||
    approval.productVersion !== audit.productVersionAfter ||
    !sameValues(
      approval.toolName,
      readActionValues(approval.toolName, approval.beforeJson),
      readActionValues(approval.toolName, source.afterJson),
    ) ||
    !sameValues(
      approval.toolName,
      readActionValues(approval.toolName, approval.afterJson),
      readActionValues(approval.toolName, source.beforeJson),
    )
  );
}

async function finalizeWithoutWrite(
  db: Db,
  approval: ApprovalRow,
  product: ProductRow,
  input: { status: "conflicted" | "expired"; detail: string },
) {
  const now = new Date().toISOString();
  await db
    .update(minkActionApprovals)
    .set({ status: input.status, updatedAt: now })
    .where(
      and(
        eq(minkActionApprovals.id, approval.id),
        eq(minkActionApprovals.storeId, approval.storeId),
      ),
    );
  const id = crypto.randomUUID();
  await db.insert(minkActionAudit).values({
    id,
    approvalId: approval.id,
    storeId: approval.storeId,
    adminId: approval.adminId,
    draftId: approval.draftId,
    productId: approval.productId,
    toolName: approval.toolName,
    operation: approval.operation,
    outcome: input.status,
    beforeJson: readActionValues(approval.toolName, approval.beforeJson),
    afterJson: readActionValues(approval.toolName, approval.afterJson),
    productVersionBefore: approval.productVersion,
    productVersionAfter: product.contentUpdatedAt,
    requestHash: approval.requestHash,
    toolVersion: TOOL_VERSION,
    detail: input.detail,
  });
  return id;
}

async function lockOwnedDraft(
  db: Db,
  actor: MinkActorContext,
  draftId: string,
) {
  await db.execute(sql`
    select id from public.mink_drafts
    where id = ${draftId}::uuid and store_id = ${actor.storeId}::uuid
      and admin_id = ${actor.adminId}
    for update
  `);
}

async function lockOwnedApproval(
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

async function readSavedProductDraft(
  db: Db,
  actor: MinkActorContext,
  draftId: string,
) {
  const rows = await db
    .select({
      id: minkDrafts.id,
      kind: minkDrafts.kind,
      status: minkDrafts.status,
      productId: minkDrafts.destinationId,
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
  if (!draft) {
    throw new MinkRequestError(
      "mink_draft_not_found",
      "This private draft is not available.",
      404,
    );
  }
  if (
    draft.status !== "draft" ||
    draft.currentVersion < 1 ||
    !draft.productId ||
    !actionToolForDraftKind(draft.kind)
  ) {
    throw unsupportedDraft();
  }
  return { ...draft, productId: draft.productId };
}

async function readProduct(db: Db, storeId: string, productId: string) {
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      description: products.description,
      seoTitle: products.seoTitle,
      seoDescription: products.seoDescription,
      contentUpdatedAt: products.contentUpdatedAt,
    })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.storeId, storeId)))
    .limit(1);
  if (!rows[0]) {
    throw new MinkRequestError(
      "mink_action_product_not_found",
      "The linked product is no longer available in this store.",
      404,
    );
  }
  return rows[0];
}

async function readOwnedApproval(
  db: Db,
  actor: MinkActorContext,
  approvalId: string,
) {
  const rows = await db
    .select()
    .from(minkActionApprovals)
    .where(
      and(
        eq(minkActionApprovals.id, approvalId),
        eq(minkActionApprovals.storeId, actor.storeId),
        eq(minkActionApprovals.adminId, actor.adminId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw approvalNotFound();
  return validateApprovalRow(rows[0]);
}

async function readApprovalByIdempotency(
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
  return validateApprovalRow(rows[0]);
}

async function readApprovalAudit(db: Db, storeId: string, approvalId: string) {
  const rows = await db
    .select({
      id: minkActionAudit.id,
      productVersionAfter: minkActionAudit.productVersionAfter,
    })
    .from(minkActionAudit)
    .where(
      and(
        eq(minkActionAudit.approvalId, approvalId),
        eq(minkActionAudit.storeId, storeId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function assertToolEnabled(
  db: Db,
  storeId: string,
  tool: MinkProductActionTool,
  lock = false,
) {
  if (lock) {
    const result = await db.execute(sql`
      select enabled from public.mink_action_tool_access
      where store_id = ${storeId}::uuid and tool_name = ${tool}
      for update
    `);
    if ((result.rows[0] as { enabled?: boolean } | undefined)?.enabled) return;
    throw toolDisabled();
  }
  const rows = await db
    .select({ enabled: minkActionToolAccess.enabled })
    .from(minkActionToolAccess)
    .where(
      and(
        eq(minkActionToolAccess.storeId, storeId),
        eq(minkActionToolAccess.toolName, tool),
      ),
    )
    .limit(1);
  if (rows[0]?.enabled) return;
  throw toolDisabled();
}

function validateApprovalRow(
  row: typeof minkActionApprovals.$inferSelect,
): ApprovalRow {
  if (
    !isMinkProductActionTool(row.toolName) ||
    (row.operation !== "apply" && row.operation !== "rollback") ||
    !isActionStatus(row.status)
  ) {
    throw invalidApproval();
  }
  return {
    ...row,
    toolName: row.toolName,
    operation: row.operation,
    status: row.status,
  };
}

function toApproval(
  row: ApprovalRow,
  product: Pick<ProductRow, "id" | "name" | "slug">,
): MinkProductActionApproval {
  return {
    id: row.id,
    sourceApprovalId: row.sourceApprovalId,
    toolName: row.toolName,
    operation: row.operation,
    status: row.status,
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    product: {
      id: product.id,
      name: product.name,
      slug: product.slug,
      dashboardPath: `/dashboard/products/${product.id}`,
    },
    before: readActionValues(row.toolName, row.beforeJson),
    after: readActionValues(row.toolName, row.afterJson),
    expiresAt: row.expiresAt,
    executedAt: row.executedAt,
  };
}

function productValues(
  tool: MinkProductActionTool,
  product: Pick<ProductRow, "description" | "seoTitle" | "seoDescription">,
): MinkProductActionValues {
  return tool === "apply_product_description"
    ? { description: product.description }
    : {
        seo_title: product.seoTitle,
        seo_description: product.seoDescription,
      };
}

function productUpdate(
  tool: MinkProductActionTool,
  values: MinkProductActionValues,
) {
  return tool === "apply_product_description"
    ? { description: values.description ?? null }
    : {
        seoTitle: values.seo_title ?? null,
        seoDescription: values.seo_description ?? null,
      };
}

function readActionValues(
  tool: MinkProductActionTool,
  value: unknown,
): MinkProductActionValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidApproval();
  }
  const raw = value as Record<string, unknown>;
  const result: MinkProductActionValues = {};
  for (const field of actionFieldsForTool(tool)) {
    const item = raw[field];
    if (item !== null && typeof item !== "string") throw invalidApproval();
    result[field] = item ?? null;
  }
  return result;
}

function sameValues(
  tool: MinkProductActionTool,
  left: MinkProductActionValues,
  right: MinkProductActionValues,
) {
  return actionFieldsForTool(tool).every(
    (field) => (left[field] ?? null) === (right[field] ?? null),
  );
}

function normalizeDraftContent(kind: string, value: unknown) {
  if (kind !== "product_description" && kind !== "product_seo") {
    throw unsupportedDraft();
  }
  try {
    return normalizeMinkDraftContent(kind, value);
  } catch (error) {
    throw new MinkRequestError(
      "mink_action_draft_invalid",
      error instanceof Error ? error.message : "The saved draft is invalid.",
      409,
    );
  }
}

function hashRequest(value: Record<string, unknown>) {
  return createHash("sha256")
    .update(JSON.stringify({ ...value, toolVersion: TOOL_VERSION }))
    .digest("hex");
}

function assertProductActionAuthority(actor: MinkActorContext) {
  if (
    actor.draftingEnabled &&
    can(actor.permissions, "products", "manage", actor.isSuperadmin)
  ) {
    return;
  }
  throw new MinkRequestError(
    "mink_action_access_denied",
    "You don't have permission to apply Mink product drafts.",
    403,
  );
}

function terminalError(status: MinkProductActionStatus) {
  return {
    error: new MinkRequestError(
      "mink_action_not_pending",
      status === "expired"
        ? "This approval expired. Create a new preview."
        : "This approval can no longer be executed.",
      409,
    ),
  };
}

function unsupportedDraft() {
  return new MinkRequestError(
    "mink_action_draft_unsupported",
    "Save a product description or product SEO proposal before applying it.",
    409,
  );
}

function approvalNotFound() {
  return new MinkRequestError(
    "mink_action_approval_not_found",
    "This Mink approval is not available.",
    404,
  );
}

function toolDisabled() {
  return new MinkRequestError(
    "mink_action_tool_disabled",
    "Applying this type of Mink draft is not enabled for this store.",
    403,
  );
}

function invalidApproval() {
  return new MinkRequestError(
    "mink_action_approval_invalid",
    "This Mink approval is invalid and cannot be executed.",
    409,
  );
}

function versionConflict() {
  return new MinkRequestError(
    "mink_action_draft_conflict",
    "The private draft changed in another tab. Reload it before reviewing.",
    409,
  );
}

function isActionStatus(value: string): value is MinkProductActionStatus {
  return (
    value === "pending" ||
    value === "executed" ||
    value === "conflicted" ||
    value === "expired" ||
    value === "cancelled"
  );
}

type ProductRow = Awaited<ReturnType<typeof readProduct>>;
type ApprovalRow = Omit<
  typeof minkActionApprovals.$inferSelect,
  "toolName" | "operation" | "status"
> & {
  toolName: MinkProductActionTool;
  operation: MinkProductActionOperation;
  status: MinkProductActionStatus;
};
