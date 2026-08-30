import "server-only";

import { createHash } from "node:crypto";
import { and, count, desc, eq, ne, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  couponUserGroups,
  coupons,
  minkActionApprovals,
  minkActionAudit,
  minkActionToolAccess,
  minkDrafts,
  orderItems,
  orders,
  products,
  productVariants,
  userGroupMembers,
  userGroups,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import {
  assertCanCreateCustomerGroup,
  assertCanCreateProduct,
  PlanEntitlementError,
} from "@/lib/plans/entitlements";
import { slugify } from "@/lib/slug";
import {
  domainActionFields,
  domainActionToolForDraftKind,
  isCreateDomainTool,
  resourceTypeForDomainTool,
  type MinkDomainActionApproval,
  type MinkDomainActionResult,
  type MinkDomainActionValues,
  type MinkDomainResourceType,
} from "./domain-action-types";
import { normalizeMinkDraftContent } from "./draft-types";
import { MinkRequestError } from "./errors";
import {
  isMinkDomainActionTool,
  type MinkDomainActionTool,
  type MinkProductActionOperation,
  type MinkProductActionStatus,
} from "./product-action-types";
import type { MinkActorContext } from "./types";

const APPROVAL_TTL_MS = 10 * 60 * 1_000;
const TOOL_VERSION = 1;
const GROUP_COLORS = new Set(["blue", "green", "amber", "violet", "grey"]);

export async function getLatestMinkDomainAction(
  actor: MinkActorContext,
  draftId: string,
): Promise<MinkDomainActionResult | null> {
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
    if (!rows[0] || !isMinkDomainActionTool(rows[0].toolName)) return null;
    const approval = validateDomainApprovalRow(rows[0]);
    assertDomainActionAuthority(actor, approval.toolName);
    const audit = await readApprovalAudit(db, actor.storeId, approval.id);
    return {
      approval: toDomainApproval(approval),
      auditId: audit?.id ?? null,
      repeated: true,
    };
  });
}

export async function previewMinkDomainAction(input: {
  actor: MinkActorContext;
  draftId: string;
  expectedDraftVersion: number;
  idempotencyKey: string;
}): Promise<MinkDomainActionApproval> {
  return withDomainErrors(async () =>
    withService(async (db) => {
      await lockOwnedDraft(db, input.actor, input.draftId);
      const draft = await readSavedDomainDraft(db, input.actor, input.draftId);
      if (draft.currentVersion !== input.expectedDraftVersion) {
        throw draftConflict();
      }
      const tool = domainActionToolForDraftKind(draft.kind);
      if (!tool) throw unsupportedDraft();
      assertDomainActionAuthority(input.actor, tool);
      await assertToolEnabled(db, input.actor.storeId, tool);

      const content = normalizeDomainDraft(draft.kind, draft.content);
      let resource: ResourceRow | null = null;
      let before: MinkDomainActionValues = emptyValues(tool);
      if (!isCreateDomainTool(tool)) {
        if (!draft.destinationId) throw unsupportedDraft();
        resource = await readResource(
          db,
          input.actor.storeId,
          resourceTypeForDomainTool(tool),
          draft.destinationId,
        );
        before = resourceValues(tool, resource);
        assertResourceEligible(tool, resource);
      }
      const after = normalizeProposedValues(tool, content, before);
      if (resource && sameValues(tool, before, after)) {
        throw new MinkRequestError(
          "mink_action_no_change",
          "This saved proposal already matches the destination.",
          409,
        );
      }
      await assertNoUniqueConflict(
        db,
        input.actor.storeId,
        tool,
        after,
        resource?.id ?? null,
      );
      return createApproval(db, {
        actor: input.actor,
        draftId: draft.id,
        draftVersion: draft.currentVersion,
        tool,
        operation: "apply",
        sourceApprovalId: null,
        resourceType: resourceTypeForDomainTool(tool),
        resourceId: resource?.id ?? null,
        resourceVersion: resource?.version ?? null,
        resourceLabel: resource?.label ?? labelFromValues(tool, after),
        before,
        after,
        idempotencyKey: input.idempotencyKey,
      });
    }),
  );
}

export async function previewMinkDomainActionRollback(input: {
  actor: MinkActorContext;
  draftId: string;
  sourceApprovalId: string;
  idempotencyKey: string;
}): Promise<MinkDomainActionApproval> {
  return withDomainErrors(async () =>
    withService(async (db) => {
      await lockOwnedApproval(db, input.actor, input.sourceApprovalId);
      const source = await readOwnedDomainApproval(
        db,
        input.actor,
        input.sourceApprovalId,
      );
      if (source.draftId !== input.draftId) throw approvalNotFound();
      assertDomainActionAuthority(input.actor, source.toolName);
      if (source.status !== "executed" || source.operation !== "apply") {
        throw rollbackUnavailable();
      }
      await assertToolEnabled(db, input.actor.storeId, source.toolName);
      if (!source.resultId || !source.resultVersion) {
        throw rollbackUnavailable();
      }
      const resource = await readResource(
        db,
        input.actor.storeId,
        source.resourceType,
        source.resultId,
      );
      const current = resourceValues(source.toolName, resource);
      const sourceAfter = readStoredValues(source.toolName, source.afterJson);
      if (
        resource.version !== source.resultVersion ||
        !sameValues(source.toolName, current, sourceAfter)
      ) {
        throw resourceConflict(source.resourceType, "after this Mink action");
      }
      if (isCreateDomainTool(source.toolName)) {
        await assertSafeCreateRollback(db, source.toolName, resource);
      }
      return createApproval(db, {
        actor: input.actor,
        draftId: source.draftId,
        draftVersion: source.draftVersion,
        tool: source.toolName,
        operation: "rollback",
        sourceApprovalId: source.id,
        resourceType: source.resourceType,
        resourceId: resource.id,
        resourceVersion: resource.version,
        resourceLabel: resource.label,
        before: current,
        after: readStoredValues(source.toolName, source.beforeJson),
        idempotencyKey: input.idempotencyKey,
      });
    }),
  );
}

export async function executeMinkDomainAction(input: {
  actor: MinkActorContext;
  draftId: string;
  approvalId: string;
}): Promise<MinkDomainActionResult> {
  return withDomainErrors(async () => {
    const outcome = await withService(async (db) => {
      await lockOwnedApproval(db, input.actor, input.approvalId);
      const approval = await readOwnedDomainApproval(
        db,
        input.actor,
        input.approvalId,
      );
      if (approval.draftId !== input.draftId) throw approvalNotFound();
      assertDomainActionAuthority(input.actor, approval.toolName);

      if (approval.status === "executed") {
        const audit = await readApprovalAudit(
          db,
          input.actor.storeId,
          approval.id,
        );
        return {
          result: {
            approval: toDomainApproval(approval),
            auditId: audit?.id ?? null,
            repeated: true,
          },
        };
      }
      if (approval.status !== "pending") return terminalError(approval.status);
      await assertToolEnabled(db, input.actor.storeId, approval.toolName, true);

      const before = readStoredValues(approval.toolName, approval.beforeJson);
      const after = readStoredValues(approval.toolName, approval.afterJson);
      if (Date.parse(approval.expiresAt) <= Date.now()) {
        const auditId = await finalizeWithoutWrite(db, approval, {
          status: "expired",
          detail: "Approval expired before execution.",
        });
        return {
          error: new MinkRequestError(
            "mink_action_approval_expired",
            "This approval expired. Review the latest proposal and create a new preview.",
            409,
          ),
          auditId,
        };
      }

      if (approval.operation === "apply") {
        if (await hasDraftConflict(db, input.actor, approval)) {
          const auditId = await finalizeWithoutWrite(db, approval, {
            status: "conflicted",
            detail: "The saved private proposal changed after preview.",
          });
          return {
            error: new MinkRequestError(
              "mink_action_draft_conflict",
              "The private proposal changed after this preview. Review it again before applying.",
              409,
            ),
            auditId,
          };
        }
      } else if (await hasRollbackSourceConflict(db, input.actor, approval)) {
        const auditId = await finalizeWithoutWrite(db, approval, {
          status: "conflicted",
          detail: "The source action is no longer a valid rollback checkpoint.",
        });
        return {
          error: new MinkRequestError(
            "mink_action_rollback_conflict",
            "The rollback checkpoint is no longer valid. Review the current destination.",
            409,
          ),
          auditId,
        };
      }

      let current: ResourceRow | null = null;
      if (approval.resourceId) {
        current = await readResource(
          db,
          input.actor.storeId,
          approval.resourceType,
          approval.resourceId,
        );
        if (
          current.version !== approval.resourceVersion ||
          !sameValues(
            approval.toolName,
            resourceValues(approval.toolName, current),
            before,
          )
        ) {
          const auditId = await finalizeWithoutWrite(db, approval, {
            status: "conflicted",
            detail: "The destination changed after preview.",
            resourceVersionAfter: current.version,
          });
          return {
            error: resourceConflict(approval.resourceType, "after preview"),
            auditId,
          };
        }
      } else if (!isCreateDomainTool(approval.toolName)) {
        throw invalidApproval();
      }

      const mutation =
        approval.operation === "rollback" &&
        isCreateDomainTool(approval.toolName)
          ? await deleteCreatedResource(db, approval, current)
          : await writeResource(db, input.actor, approval, after, current);
      const now = new Date().toISOString();
      await db
        .update(minkActionApprovals)
        .set({
          status: "executed",
          approvedAt: now,
          executedAt: now,
          resultId: mutation.id,
          resultVersion: mutation.version,
          resourceLabel: mutation.label,
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
        productId: null,
        resourceType: approval.resourceType,
        resourceId: approval.resourceId,
        resourceVersionBefore: approval.resourceVersion,
        resourceVersionAfter: mutation.version,
        resultId: mutation.id,
        toolName: approval.toolName,
        operation: approval.operation,
        outcome: "executed",
        beforeJson: before,
        afterJson: after,
        productVersionBefore: null,
        productVersionAfter: null,
        requestHash: approval.requestHash,
        toolVersion: TOOL_VERSION,
        detail: mutation.detail,
      });
      const executed = {
        ...approval,
        status: "executed" as const,
        approvedAt: now,
        executedAt: now,
        resultId: mutation.id,
        resultVersion: mutation.version,
        resourceLabel: mutation.label,
      };
      return {
        result: {
          approval: toDomainApproval(executed),
          auditId,
          repeated: false,
        },
      };
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.result;
  });
}

async function writeResource(
  db: Db,
  actor: MinkActorContext,
  approval: DomainApprovalRow,
  after: MinkDomainActionValues,
  current: ResourceRow | null,
): Promise<MutationResult> {
  await assertNoUniqueConflict(
    db,
    actor.storeId,
    approval.toolName,
    after,
    current?.id ?? null,
  );
  if (approval.toolName === "create_product") {
    await assertCanCreateProduct(db, actor.storeId);
    await db.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`mink-product-slug:${actor.storeId}:${after.slug}`}, 0)
      )
    `);
    await assertNoUniqueConflict(
      db,
      actor.storeId,
      approval.toolName,
      after,
      null,
    );
    const [row] = await db
      .insert(products)
      .values({
        name: required(after.name),
        slug: required(after.slug),
        description: nullable(after.description),
        seoTitle: nullable(after.seo_title),
        seoDescription: nullable(after.seo_description),
        basePrice: Number(after.base_price),
        sellingPrice: Number(after.selling_price),
        status: "draft",
        trackInventory: false,
        images: [],
        createdBy: actor.adminId,
        updatedBy: actor.adminId,
        storeId: actor.storeId,
      } as unknown as typeof products.$inferInsert)
      .returning({
        id: products.id,
        name: products.name,
        version: products.contentUpdatedAt,
      });
    if (!row) throw new Error("Product insert returned no row");
    return {
      id: row.id,
      version: row.version,
      label: row.name,
      detail: "Approved unpublished draft product created.",
    };
  }
  if (approval.toolName === "create_coupon") {
    const [row] = await db
      .insert(coupons)
      .values({
        ...couponUpdate(after),
        status: "disabled",
        showOnStorefront: false,
        usedCount: 0,
        createdBy: actor.adminId,
        updatedBy: actor.adminId,
        storeId: actor.storeId,
      })
      .returning({
        id: coupons.id,
        code: coupons.code,
        version: coupons.updatedAt,
      });
    if (!row) throw new Error("Coupon insert returned no row");
    return {
      id: row.id,
      version: row.version,
      label: `Coupon ${row.code}`,
      detail: "Approved disabled, hidden coupon created.",
    };
  }
  if (approval.toolName === "create_customer_group") {
    await assertCanCreateCustomerGroup(db, actor.storeId);
    const [row] = await db
      .insert(userGroups)
      .values({
        name: required(after.name),
        description: nullable(after.description),
        color: required(after.color),
        createdBy: actor.adminId,
        storeId: actor.storeId,
      })
      .returning({
        id: userGroups.id,
        name: userGroups.name,
        version: userGroups.updatedAt,
      });
    if (!row) throw new Error("Customer-group insert returned no row");
    return {
      id: row.id,
      version: row.version,
      label: row.name,
      detail: "Approved customer-group metadata created without members.",
    };
  }
  if (!current || !approval.resourceVersion) throw invalidApproval();
  const now = new Date().toISOString();
  if (approval.toolName === "update_coupon") {
    assertResourceEligible(approval.toolName, current);
    const [row] = await db
      .update(coupons)
      .set({ ...couponUpdate(after), updatedBy: actor.adminId, updatedAt: now })
      .where(
        and(
          eq(coupons.id, current.id),
          eq(coupons.storeId, actor.storeId),
          eq(coupons.updatedAt, approval.resourceVersion),
          eq(coupons.status, "disabled"),
          eq(coupons.showOnStorefront, false),
        ),
      )
      .returning({
        id: coupons.id,
        code: coupons.code,
        version: coupons.updatedAt,
      });
    if (!row) throw resourceConflict("coupon", "during execution");
    return {
      id: row.id,
      version: row.version,
      label: `Coupon ${row.code}`,
      detail:
        "Approved disabled-coupon terms updated; activation and audience were unchanged.",
    };
  }
  const [row] = await db
    .update(userGroups)
    .set({
      name: required(after.name),
      description: nullable(after.description),
      color: required(after.color),
      updatedAt: now,
    })
    .where(
      and(
        eq(userGroups.id, current.id),
        eq(userGroups.storeId, actor.storeId),
        eq(userGroups.updatedAt, approval.resourceVersion),
      ),
    )
    .returning({
      id: userGroups.id,
      name: userGroups.name,
      version: userGroups.updatedAt,
    });
  if (!row) throw resourceConflict("customer_group", "during execution");
  return {
    id: row.id,
    version: row.version,
    label: row.name,
    detail:
      "Approved customer-group metadata updated; membership was unchanged.",
  };
}

async function deleteCreatedResource(
  db: Db,
  approval: DomainApprovalRow,
  current: ResourceRow | null,
): Promise<MutationResult> {
  if (!current || !approval.resourceVersion) throw invalidApproval();
  await assertSafeCreateRollback(db, approval.toolName, current);
  if (approval.toolName === "create_product") {
    const rows = await db
      .delete(products)
      .where(
        and(
          eq(products.id, current.id),
          eq(products.storeId, approval.storeId),
          eq(products.contentUpdatedAt, approval.resourceVersion),
          eq(products.status, "draft"),
        ),
      )
      .returning({ id: products.id });
    if (!rows[0]) throw resourceConflict("product", "during rollback");
  } else if (approval.toolName === "create_coupon") {
    const rows = await db
      .delete(coupons)
      .where(
        and(
          eq(coupons.id, current.id),
          eq(coupons.storeId, approval.storeId),
          eq(coupons.updatedAt, approval.resourceVersion),
          eq(coupons.status, "disabled"),
          eq(coupons.showOnStorefront, false),
          eq(coupons.usedCount, 0),
        ),
      )
      .returning({ id: coupons.id });
    if (!rows[0]) throw resourceConflict("coupon", "during rollback");
  } else if (approval.toolName === "create_customer_group") {
    const rows = await db
      .delete(userGroups)
      .where(
        and(
          eq(userGroups.id, current.id),
          eq(userGroups.storeId, approval.storeId),
          eq(userGroups.updatedAt, approval.resourceVersion),
        ),
      )
      .returning({ id: userGroups.id });
    if (!rows[0]) throw resourceConflict("customer_group", "during rollback");
  } else {
    throw invalidApproval();
  }
  return {
    id: current.id,
    version: null,
    label: current.label,
    detail:
      "Approved safe rollback removed the unchanged, unused record created by Mink.",
  };
}

async function createApproval(
  db: Db,
  input: {
    actor: MinkActorContext;
    draftId: string;
    draftVersion: number;
    tool: MinkDomainActionTool;
    operation: MinkProductActionOperation;
    sourceApprovalId: string | null;
    resourceType: MinkDomainResourceType;
    resourceId: string | null;
    resourceVersion: string | null;
    resourceLabel: string;
    before: MinkDomainActionValues;
    after: MinkDomainActionValues;
    idempotencyKey: string;
  },
) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const requestHash = hashRequest({
    storeId: input.actor.storeId,
    adminId: input.actor.adminId,
    draftId: input.draftId,
    draftVersion: input.draftVersion,
    tool: input.tool,
    operation: input.operation,
    sourceApprovalId: input.sourceApprovalId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    resourceVersion: input.resourceVersion,
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
      productVersion: null,
      sourceApprovalId: input.sourceApprovalId,
      toolName: input.tool,
      operation: input.operation,
      draftVersion: input.draftVersion,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      resourceVersion: input.resourceVersion,
      resourceLabel: input.resourceLabel,
      beforeJson: input.before,
      afterJson: input.after,
      requestHash,
      idempotencyKey: input.idempotencyKey,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0]
    ? validateDomainApprovalRow(inserted[0])
    : await readApprovalByIdempotency(db, input.actor, input.idempotencyKey);
  if (row.requestHash !== requestHash) {
    throw new MinkRequestError(
      "mink_action_idempotency_conflict",
      "This approval request key was already used for a different preview.",
      409,
    );
  }
  return toDomainApproval(row);
}

async function hasDraftConflict(
  db: Db,
  actor: MinkActorContext,
  approval: DomainApprovalRow,
) {
  await lockOwnedDraft(db, actor, approval.draftId);
  try {
    const draft = await readSavedDomainDraft(db, actor, approval.draftId);
    if (draft.currentVersion !== approval.draftVersion) return true;
    if (domainActionToolForDraftKind(draft.kind) !== approval.toolName)
      return true;
    const content = normalizeDomainDraft(draft.kind, draft.content);
    const proposed = normalizeProposedValues(
      approval.toolName,
      content,
      readStoredValues(approval.toolName, approval.beforeJson),
    );
    return !sameValues(
      approval.toolName,
      proposed,
      readStoredValues(approval.toolName, approval.afterJson),
    );
  } catch (error) {
    if (error instanceof MinkRequestError) return true;
    throw error;
  }
}

async function hasRollbackSourceConflict(
  db: Db,
  actor: MinkActorContext,
  approval: DomainApprovalRow,
) {
  if (!approval.sourceApprovalId) return true;
  await lockOwnedApproval(db, actor, approval.sourceApprovalId);
  const source = await readOwnedDomainApproval(
    db,
    actor,
    approval.sourceApprovalId,
  );
  return (
    source.status !== "executed" ||
    source.operation !== "apply" ||
    source.toolName !== approval.toolName ||
    source.resultId !== approval.resourceId ||
    source.resultVersion !== approval.resourceVersion ||
    !sameValues(
      approval.toolName,
      readStoredValues(approval.toolName, approval.beforeJson),
      readStoredValues(approval.toolName, source.afterJson),
    ) ||
    !sameValues(
      approval.toolName,
      readStoredValues(approval.toolName, approval.afterJson),
      readStoredValues(approval.toolName, source.beforeJson),
    )
  );
}

async function finalizeWithoutWrite(
  db: Db,
  approval: DomainApprovalRow,
  input: {
    status: "conflicted" | "expired";
    detail: string;
    resourceVersionAfter?: string | null;
  },
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
    productId: null,
    resourceType: approval.resourceType,
    resourceId: approval.resourceId,
    resourceVersionBefore: approval.resourceVersion,
    resourceVersionAfter: input.resourceVersionAfter ?? null,
    resultId: null,
    toolName: approval.toolName,
    operation: approval.operation,
    outcome: input.status,
    beforeJson: readStoredValues(approval.toolName, approval.beforeJson),
    afterJson: readStoredValues(approval.toolName, approval.afterJson),
    productVersionBefore: null,
    productVersionAfter: null,
    requestHash: approval.requestHash,
    toolVersion: TOOL_VERSION,
    detail: input.detail,
  });
  return id;
}

async function readSavedDomainDraft(
  db: Db,
  actor: MinkActorContext,
  draftId: string,
) {
  const rows = await db
    .select({
      id: minkDrafts.id,
      kind: minkDrafts.kind,
      status: minkDrafts.status,
      destinationId: minkDrafts.destinationId,
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
  if (!draft) throw draftNotFound();
  if (
    draft.status !== "draft" ||
    draft.currentVersion < 1 ||
    !domainActionToolForDraftKind(draft.kind)
  ) {
    throw unsupportedDraft();
  }
  return draft;
}

async function readResource(
  db: Db,
  storeId: string,
  type: MinkDomainResourceType,
  id: string,
): Promise<ResourceRow> {
  if (type === "product") {
    const rows = await db
      .select({
        id: products.id,
        storeId: products.storeId,
        name: products.name,
        slug: products.slug,
        description: products.description,
        seoTitle: products.seoTitle,
        seoDescription: products.seoDescription,
        basePrice: products.basePrice,
        sellingPrice: products.sellingPrice,
        status: products.status,
        trackInventory: products.trackInventory,
        version: products.contentUpdatedAt,
      })
      .from(products)
      .where(and(eq(products.id, id), eq(products.storeId, storeId)))
      .limit(1);
    if (!rows[0]) throw resourceNotFound(type);
    return { type, label: rows[0].name, ...rows[0] };
  }
  if (type === "coupon") {
    const rows = await db
      .select({
        id: coupons.id,
        storeId: coupons.storeId,
        code: coupons.code,
        description: coupons.description,
        discountType: coupons.discountType,
        discountValue: coupons.discountValue,
        minOrderAmount: coupons.minOrderAmount,
        maxUses: coupons.maxUses,
        usedCount: coupons.usedCount,
        status: coupons.status,
        validFrom: coupons.validFrom,
        validUntil: coupons.validUntil,
        showOnStorefront: coupons.showOnStorefront,
        version: coupons.updatedAt,
      })
      .from(coupons)
      .where(and(eq(coupons.id, id), eq(coupons.storeId, storeId)))
      .limit(1);
    if (!rows[0]) throw resourceNotFound(type);
    const [links] = await db
      .select({ n: count() })
      .from(couponUserGroups)
      .where(
        and(
          eq(couponUserGroups.couponId, id),
          eq(couponUserGroups.storeId, storeId),
        ),
      );
    return {
      type,
      label: `Coupon ${rows[0].code}`,
      groupLinks: links?.n ?? 0,
      ...rows[0],
    };
  }
  const rows = await db
    .select({
      id: userGroups.id,
      storeId: userGroups.storeId,
      name: userGroups.name,
      description: userGroups.description,
      color: userGroups.color,
      version: userGroups.updatedAt,
    })
    .from(userGroups)
    .where(and(eq(userGroups.id, id), eq(userGroups.storeId, storeId)))
    .limit(1);
  if (!rows[0]) throw resourceNotFound(type);
  return { type, label: rows[0].name, ...rows[0] };
}

function resourceValues(
  tool: MinkDomainActionTool,
  resource: ResourceRow,
): MinkDomainActionValues {
  if (resource.type === "product" && tool === "create_product") {
    return {
      name: resource.name,
      slug: resource.slug,
      description: resource.description,
      seo_title: resource.seoTitle,
      seo_description: resource.seoDescription,
      base_price: money(resource.basePrice),
      selling_price: money(resource.sellingPrice),
      status: resource.status,
      track_inventory: resource.trackInventory ? "enabled" : "disabled",
    };
  }
  if (
    resource.type === "coupon" &&
    (tool === "create_coupon" || tool === "update_coupon")
  ) {
    return {
      code: resource.code,
      description: resource.description,
      discount_type: resource.discountType,
      discount_value: money(resource.discountValue),
      min_order_amount: money(resource.minOrderAmount),
      max_uses: String(resource.maxUses),
      valid_from: resource.validFrom,
      valid_until: resource.validUntil,
      status: resource.status,
      show_on_storefront: resource.showOnStorefront ? "yes" : "no",
      audience:
        resource.groupLinks > 0
          ? `restricted to ${resource.groupLinks} customer group${resource.groupLinks === 1 ? "" : "s"}`
          : "all customers (no group restriction)",
    };
  }
  if (resource.type === "customer_group") {
    return {
      name: resource.name,
      description: resource.description,
      color: resource.color,
    };
  }
  throw invalidApproval();
}

function normalizeProposedValues(
  tool: MinkDomainActionTool,
  content: Record<string, string>,
  before: MinkDomainActionValues,
): MinkDomainActionValues {
  if (tool === "create_product") {
    const base = positiveMoney(content.base_price, "Base price");
    const selling = positiveMoney(content.selling_price, "Selling price");
    if (Number(selling) > Number(base)) {
      throw invalidDraft("Selling price cannot exceed the base price.");
    }
    const slug = slugify(content.slug).slice(0, 200);
    if (!slug) throw invalidDraft("The product URL slug is invalid.");
    return {
      name: requiredText(content.name, "Product name", 200),
      slug,
      description: requiredText(content.description, "Description", 3_000),
      seo_title: requiredText(content.seo_title, "SEO title", 70),
      seo_description: requiredText(
        content.seo_description,
        "SEO description",
        180,
      ),
      base_price: base,
      selling_price: selling,
      status: "draft",
      track_inventory: "disabled",
    };
  }
  if (tool === "create_coupon" || tool === "update_coupon") {
    const discountType = content.discount_type;
    if (discountType !== "percentage" && discountType !== "fixed") {
      throw invalidDraft("Discount type must be percentage or fixed.");
    }
    const discountValue = positiveMoney(
      content.discount_value,
      "Discount value",
    );
    if (discountType === "percentage" && Number(discountValue) > 100) {
      throw invalidDraft("A percentage discount cannot exceed 100%.");
    }
    const validFrom = optionalTimestamp(content.valid_from, "Valid from");
    const validUntil = optionalTimestamp(content.valid_until, "Valid until");
    if (
      validFrom &&
      validUntil &&
      Date.parse(validFrom) > Date.parse(validUntil)
    ) {
      throw invalidDraft("Valid from must be before valid until.");
    }
    return {
      code: normalizeCouponCode(content.code),
      description: nullableText(content.description, 500),
      discount_type: discountType,
      discount_value: discountValue,
      min_order_amount: nonNegativeMoney(
        content.min_order_amount,
        "Minimum order amount",
      ),
      max_uses: nonNegativeInteger(content.max_uses, "Maximum uses"),
      valid_from: validFrom,
      valid_until: validUntil,
      status: tool === "update_coupon" ? before.status : "disabled",
      show_on_storefront:
        tool === "update_coupon" ? before.show_on_storefront : "no",
      audience:
        tool === "update_coupon"
          ? before.audience
          : "all customers (no group restriction)",
    };
  }
  const color = content.color.trim().toLowerCase();
  if (!GROUP_COLORS.has(color)) {
    throw invalidDraft("Colour must be blue, green, amber, violet or grey.");
  }
  return {
    name: requiredText(content.name, "Group name", 120),
    description: nullableText(content.description, 500),
    color,
  };
}

async function assertNoUniqueConflict(
  db: Db,
  storeId: string,
  tool: MinkDomainActionTool,
  after: MinkDomainActionValues,
  excludeId: string | null,
) {
  if (tool === "create_product") {
    const rows = await db
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.storeId, storeId),
          eq(products.slug, required(after.slug)),
        ),
      )
      .limit(1);
    if (rows[0])
      throw uniqueConflict("A product with this URL slug already exists.");
    return;
  }
  if (tool === "create_coupon" || tool === "update_coupon") {
    const rows = await db
      .select({ id: coupons.id })
      .from(coupons)
      .where(
        and(
          eq(coupons.storeId, storeId),
          eq(coupons.code, required(after.code)),
          ...(excludeId ? [ne(coupons.id, excludeId)] : []),
        ),
      )
      .limit(1);
    if (rows[0])
      throw uniqueConflict("A coupon with this code already exists.");
    return;
  }
  const rows = await db
    .select({ id: userGroups.id })
    .from(userGroups)
    .where(
      and(
        eq(userGroups.storeId, storeId),
        eq(userGroups.name, required(after.name)),
        ...(excludeId ? [ne(userGroups.id, excludeId)] : []),
      ),
    )
    .limit(1);
  if (rows[0])
    throw uniqueConflict("A customer group with this name already exists.");
}

async function assertSafeCreateRollback(
  db: Db,
  tool: MinkDomainActionTool,
  resource: ResourceRow,
) {
  if (tool === "create_product" && resource.type === "product") {
    if (resource.status !== "draft" || resource.trackInventory) {
      throw rollbackUnsafe(
        "The product is no longer an untouched, untracked draft.",
      );
    }
    const [[variants], [lines]] = await Promise.all([
      db
        .select({ n: count() })
        .from(productVariants)
        .where(eq(productVariants.productId, resource.id)),
      db
        .select({ n: count() })
        .from(orderItems)
        .where(eq(orderItems.productId, resource.id)),
    ]);
    if ((variants?.n ?? 0) > 0 || (lines?.n ?? 0) > 0) {
      throw rollbackUnsafe("The product now has variants or order history.");
    }
    return;
  }
  if (tool === "create_coupon" && resource.type === "coupon") {
    const [orderRows] = await db
      .select({ n: count() })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, resourceStoreId(resource)),
          eq(orders.appliedCouponCode, resource.code),
        ),
      );
    if (
      resource.status !== "disabled" ||
      resource.showOnStorefront ||
      resource.usedCount !== 0 ||
      resource.groupLinks > 0 ||
      (orderRows?.n ?? 0) > 0
    ) {
      throw rollbackUnsafe(
        "The coupon was enabled, linked, used or added to an order.",
      );
    }
    return;
  }
  if (tool === "create_customer_group" && resource.type === "customer_group") {
    const [[members], [links]] = await Promise.all([
      db
        .select({ n: count() })
        .from(userGroupMembers)
        .where(eq(userGroupMembers.groupId, resource.id)),
      db
        .select({ n: count() })
        .from(couponUserGroups)
        .where(eq(couponUserGroups.groupId, resource.id)),
    ]);
    if ((members?.n ?? 0) > 0 || (links?.n ?? 0) > 0) {
      throw rollbackUnsafe(
        "The customer group now has members or coupon links.",
      );
    }
    return;
  }
  throw rollbackUnavailable();
}

function assertResourceEligible(
  tool: MinkDomainActionTool,
  resource: ResourceRow,
) {
  if (tool === "update_coupon" && resource.type === "coupon") {
    if (resource.status !== "disabled" || resource.showOnStorefront) {
      throw new MinkRequestError(
        "mink_action_coupon_not_disabled",
        "Mink can update coupon terms only while the coupon is disabled and hidden from the storefront.",
        409,
      );
    }
  }
}

function couponUpdate(values: MinkDomainActionValues) {
  return {
    code: required(values.code),
    description: nullable(values.description),
    discountType: required(values.discount_type),
    discountValue: Number(values.discount_value),
    minOrderAmount: Number(values.min_order_amount),
    maxUses: Number(values.max_uses),
    validFrom: values.valid_from,
    validUntil: values.valid_until,
  };
}

function normalizeDomainDraft(kind: string, value: unknown) {
  if (!domainActionToolForDraftKind(kind)) throw unsupportedDraft();
  try {
    return normalizeMinkDraftContent(
      kind as Parameters<typeof normalizeMinkDraftContent>[0],
      value,
    );
  } catch (error) {
    throw invalidDraft(
      error instanceof Error ? error.message : "The saved proposal is invalid.",
    );
  }
}

function readStoredValues(tool: MinkDomainActionTool, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidApproval();
  }
  const raw = value as Record<string, unknown>;
  const result: MinkDomainActionValues = {};
  for (const field of domainActionFields(tool)) {
    const item = raw[field];
    if (item !== null && typeof item !== "string") throw invalidApproval();
    result[field] = item ?? null;
  }
  return result;
}

function emptyValues(tool: MinkDomainActionTool): MinkDomainActionValues {
  return Object.fromEntries(
    domainActionFields(tool).map((field) => [field, null]),
  );
}

function sameValues(
  tool: MinkDomainActionTool,
  left: MinkDomainActionValues,
  right: MinkDomainActionValues,
) {
  return domainActionFields(tool).every(
    (field) => (left[field] ?? null) === (right[field] ?? null),
  );
}

function toDomainApproval(row: DomainApprovalRow): MinkDomainActionApproval {
  const resourceId = row.resultId ?? row.resourceId;
  return {
    id: row.id,
    sourceApprovalId: row.sourceApprovalId,
    toolName: row.toolName,
    operation: row.operation,
    status: row.status,
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    resource: {
      type: row.resourceType,
      id: resourceId,
      label: row.resourceLabel ?? "Dashboard record",
      dashboardPath: resourcePath(row.resourceType, resourceId),
    },
    before: readStoredValues(row.toolName, row.beforeJson),
    after: readStoredValues(row.toolName, row.afterJson),
    expiresAt: row.expiresAt,
    executedAt: row.executedAt,
  };
}

function resourcePath(type: MinkDomainResourceType, id: string | null) {
  if (type === "product")
    return id ? `/dashboard/products/${id}` : "/dashboard/products";
  if (type === "coupon") {
    return id
      ? `/dashboard/marketing/coupons/${id}/edit`
      : "/dashboard/marketing/coupons";
  }
  return id
    ? `/dashboard/users/user_groups/${id}/edit`
    : "/dashboard/users/user_groups";
}

async function readOwnedDomainApproval(
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
  return validateDomainApprovalRow(rows[0]);
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
  return validateDomainApprovalRow(rows[0]);
}

async function readApprovalAudit(db: Db, storeId: string, approvalId: string) {
  const rows = await db
    .select({ id: minkActionAudit.id })
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

function validateDomainApprovalRow(
  row: typeof minkActionApprovals.$inferSelect,
): DomainApprovalRow {
  if (
    !isMinkDomainActionTool(row.toolName) ||
    (row.operation !== "apply" && row.operation !== "rollback") ||
    !isActionStatus(row.status) ||
    !isResourceType(row.resourceType)
  ) {
    throw invalidApproval();
  }
  if (
    !isCreateDomainTool(row.toolName) &&
    (!row.resourceId || !row.resourceVersion)
  ) {
    throw invalidApproval();
  }
  return {
    ...row,
    toolName: row.toolName,
    operation: row.operation,
    status: row.status,
    resourceType: row.resourceType,
  };
}

async function assertToolEnabled(
  db: Db,
  storeId: string,
  tool: MinkDomainActionTool,
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
  if (!rows[0]?.enabled) throw toolDisabled();
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

function assertDomainActionAuthority(
  actor: MinkActorContext,
  tool: MinkDomainActionTool,
) {
  const section =
    tool === "create_product"
      ? "products"
      : tool === "create_coupon" || tool === "update_coupon"
        ? "marketing"
        : "users";
  if (
    actor.draftingEnabled &&
    can(actor.permissions, section, "manage", actor.isSuperadmin)
  ) {
    return;
  }
  throw new MinkRequestError(
    "mink_action_access_denied",
    "You don't have permission to use this Mink action.",
    403,
  );
}

async function withDomainErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PlanEntitlementError) {
      throw new MinkRequestError("mink_action_plan_limit", error.message, 409);
    }
    if (isUniqueViolation(error)) {
      throw uniqueConflict("That name, code or URL slug is already in use.");
    }
    throw error;
  }
}

function hashRequest(value: Record<string, unknown>) {
  return createHash("sha256")
    .update(JSON.stringify({ ...value, toolVersion: TOOL_VERSION }))
    .digest("hex");
}

function labelFromValues(
  tool: MinkDomainActionTool,
  values: MinkDomainActionValues,
) {
  if (tool === "create_coupon") return `Coupon ${values.code}`;
  return required(values.name);
}

function required(value: string | null | undefined) {
  if (!value) throw invalidApproval();
  return value;
}

function nullable(value: string | null | undefined) {
  return value || null;
}

function requiredText(value: string, label: string, max: number) {
  const result = value.normalize("NFKC").trim();
  if (!result || result.length > max)
    throw invalidDraft(`${label} is invalid.`);
  return result;
}

function nullableText(value: string, max: number) {
  const result = value.normalize("NFKC").trim();
  if (result.length > max) throw invalidDraft("A text field is too long.");
  return result || null;
}

function normalizeCouponCode(value: string) {
  const code = value.normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
  if (!code || code.length > 100) throw invalidDraft("Coupon code is invalid.");
  return code;
}

function positiveMoney(value: string, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 99_999_999.99) {
    throw invalidDraft(
      `${label} must be greater than zero and within the supported range.`,
    );
  }
  return money(number);
}

function nonNegativeMoney(value: string, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 99_999_999.99) {
    throw invalidDraft(`${label} must be zero or a positive amount.`);
  }
  return money(number);
}

function money(value: number) {
  return (Math.round(Number(value) * 100) / 100).toFixed(2);
}

function nonNegativeInteger(value: string, label: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 1_000_000_000) {
    throw invalidDraft(`${label} must be a non-negative whole number.`);
  }
  return String(number);
}

function optionalTimestamp(value: string, label: string) {
  const input = value.trim();
  if (!input) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime()))
    throw invalidDraft(`${label} is not a valid date.`);
  return date.toISOString();
}

function resourceStoreId(resource: ResourceRow) {
  return "storeId" in resource ? resource.storeId : "";
}

function isResourceType(value: string): value is MinkDomainResourceType {
  return (
    value === "product" || value === "coupon" || value === "customer_group"
  );
}

function isActionStatus(value: string): value is MinkProductActionStatus {
  return ["pending", "executed", "conflicted", "expired", "cancelled"].includes(
    value,
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

function draftNotFound() {
  return new MinkRequestError(
    "mink_draft_not_found",
    "This private proposal is not available.",
    404,
  );
}

function unsupportedDraft() {
  return new MinkRequestError(
    "mink_action_draft_unsupported",
    "Save a supported product, coupon or customer-group proposal before reviewing an action.",
    409,
  );
}

function invalidDraft(message: string) {
  return new MinkRequestError("mink_action_draft_invalid", message, 409);
}

function draftConflict() {
  return new MinkRequestError(
    "mink_action_draft_conflict",
    "The private proposal changed in another tab. Reload it before reviewing.",
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

function invalidApproval() {
  return new MinkRequestError(
    "mink_action_approval_invalid",
    "This Mink approval is invalid and cannot be executed.",
    409,
  );
}

function toolDisabled() {
  return new MinkRequestError(
    "mink_action_tool_disabled",
    "This Mink action is not enabled for this store.",
    403,
  );
}

function resourceNotFound(type: MinkDomainResourceType) {
  return new MinkRequestError(
    "mink_action_resource_not_found",
    `The linked ${type.replace("_", " ")} is no longer available in this store.`,
    404,
  );
}

function resourceConflict(type: MinkDomainResourceType, when: string) {
  return new MinkRequestError(
    "mink_action_resource_conflict",
    `The ${type.replace("_", " ")} changed ${when}. Nothing was overwritten; review the latest record.`,
    409,
  );
}

function uniqueConflict(message: string) {
  return new MinkRequestError("mink_action_unique_conflict", message, 409);
}

function rollbackUnavailable() {
  return new MinkRequestError(
    "mink_action_rollback_unavailable",
    "A safe rollback is not available for this action.",
    409,
  );
}

function rollbackUnsafe(message: string) {
  return new MinkRequestError(
    "mink_action_rollback_unsafe",
    `${message} Rollback was refused.`,
    409,
  );
}

type ProductResource = {
  type: "product";
  id: string;
  storeId: string;
  label: string;
  name: string;
  slug: string;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  basePrice: number;
  sellingPrice: number;
  status: string;
  trackInventory: boolean;
  version: string;
};

type CouponResource = {
  type: "coupon";
  id: string;
  storeId: string;
  label: string;
  code: string;
  description: string | null;
  discountType: string;
  discountValue: number;
  minOrderAmount: number;
  maxUses: number;
  usedCount: number;
  status: string;
  validFrom: string | null;
  validUntil: string | null;
  showOnStorefront: boolean;
  groupLinks: number;
  version: string;
};

type GroupResource = {
  type: "customer_group";
  id: string;
  storeId: string;
  label: string;
  name: string;
  description: string | null;
  color: string;
  version: string;
};

type ResourceRow = ProductResource | CouponResource | GroupResource;
type MutationResult = {
  id: string;
  version: string | null;
  label: string;
  detail: string;
};
type DomainApprovalRow = Omit<
  typeof minkActionApprovals.$inferSelect,
  "toolName" | "operation" | "status" | "resourceType"
> & {
  toolName: MinkDomainActionTool;
  operation: MinkProductActionOperation;
  status: MinkProductActionStatus;
  resourceType: MinkDomainResourceType;
};
