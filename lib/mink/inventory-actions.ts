import "server-only";

import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  inventoryLevels,
  minkActionApprovals,
  minkActionAudit,
  minkActionToolAccess,
  minkDrafts,
  products,
  productVariants,
  stockMovements,
  storeLocations,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { normalizeMinkDraftContent } from "./draft-types";
import { MinkRequestError } from "./errors";
import type {
  MinkInventoryActionApproval,
  MinkInventoryActionResult,
  MinkInventoryActionValues,
} from "./inventory-action-types";
import type { MinkActorContext } from "./types";

const APPROVAL_TTL_MS = 10 * 60 * 1_000;
const MAX_DELTA = 1_000_000;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const TOOL_VERSION = 1;

type ApprovalRow = typeof minkActionApprovals.$inferSelect & {
  toolName: "adjust_inventory";
  operation: "apply";
  status: "pending" | "executed" | "conflicted" | "expired" | "cancelled";
  resourceType: "inventory";
  resourceId: string;
  locationId: string;
};

interface InventoryTarget {
  levelId: string | null;
  productId: string;
  variantId: string | null;
  locationId: string;
  productName: string;
  variantName: string | null;
  sku: string;
  locationName: string;
  onHand: number;
  reserved: number;
  version: string | null;
}

export async function getLatestMinkInventoryAction(
  actor: MinkActorContext,
  draftId: string,
): Promise<MinkInventoryActionResult | null> {
  return withService(async (db) => {
    const rows = await db
      .select()
      .from(minkActionApprovals)
      .where(
        and(
          eq(minkActionApprovals.storeId, actor.storeId),
          eq(minkActionApprovals.adminId, actor.adminId),
          eq(minkActionApprovals.draftId, draftId),
          eq(minkActionApprovals.toolName, "adjust_inventory"),
          eq(minkActionApprovals.status, "executed"),
        ),
      )
      .orderBy(desc(minkActionApprovals.executedAt))
      .limit(1);
    if (!rows[0]) return null;
    assertInventoryAuthority(actor);
    const approval = validateApproval(rows[0]);
    const audit = await readAudit(db, actor.storeId, approval.id);
    return {
      approval: toApproval(approval),
      auditId: audit?.id ?? null,
      repeated: true,
    };
  });
}

export async function previewMinkInventoryAction(input: {
  actor: MinkActorContext;
  draftId: string;
  expectedDraftVersion: number;
  idempotencyKey: string;
}): Promise<MinkInventoryActionApproval> {
  return withService(async (db) => {
    assertInventoryAuthority(input.actor);
    await lockDraft(db, input.actor, input.draftId);
    const draft = await readDraft(db, input.actor, input.draftId);
    if (draft.currentVersion !== input.expectedDraftVersion) {
      throw conflict(
        "mink_inventory_draft_conflict",
        "The saved inventory proposal changed. Save and review it again.",
      );
    }
    await assertToolEnabled(db, input.actor.storeId);
    const target = await readTarget(db, input.actor, {
      productId: draft.destinationId,
      variantId: draft.variantId,
      locationId: draft.locationId,
    });
    const content = normalizeInventoryContent(draft.content);
    const delta = Number(content.quantity_change);
    const resulting = target.onHand + delta;
    if (resulting < 0) {
      throw new MinkRequestError(
        "mink_inventory_negative_stock",
        `This adjustment would reduce ${target.sku} below zero at ${target.locationName}.`,
        409,
      );
    }
    if (resulting < target.reserved) {
      throw new MinkRequestError(
        "mink_inventory_reserved_stock_conflict",
        `This adjustment would reduce ${target.sku} below its ${target.reserved} reserved units. Use the manual inventory workflow after resolving reservations.`,
        409,
      );
    }
    if (resulting > MAX_POSTGRES_INTEGER) {
      throw invalidDraft("The resulting stock is outside the supported range.");
    }
    const before = values(target, null, target.onHand);
    const after = values(target, content, resulting);
    return createApproval(db, {
      actor: input.actor,
      draftId: draft.id,
      draftVersion: draft.currentVersion,
      target,
      before,
      after,
      idempotencyKey: input.idempotencyKey,
    });
  });
}

export async function executeMinkInventoryAction(input: {
  actor: MinkActorContext;
  draftId: string;
  approvalId: string;
}): Promise<MinkInventoryActionResult> {
  const outcome = await withService(async (db) => {
    assertInventoryAuthority(input.actor);
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
        },
      };
    }
    if (approval.status !== "pending") {
      throw conflict(
        "mink_inventory_approval_terminal",
        "This inventory approval is no longer available.",
      );
    }
    await assertToolEnabled(db, input.actor.storeId, true);
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      const auditId = await finalizeWithoutWrite(
        db,
        approval,
        "expired",
        "Approval expired before execution.",
      );
      return {
        error: new MinkRequestError(
          "mink_inventory_approval_expired",
          "This approval expired. Review the latest stock and create a new preview.",
          409,
        ),
        auditId,
      };
    }
    await lockDraft(db, input.actor, approval.draftId);
    const draft = await readDraft(db, input.actor, approval.draftId);
    const normalized = normalizeInventoryContent(draft.content);
    if (
      draft.currentVersion !== approval.draftVersion ||
      hashValues(valuesFromJson(approval.afterJson)) !==
        hashValues({
          ...valuesFromJson(approval.afterJson),
          quantity_change: normalized.quantity_change,
          reason: normalized.reason,
          note: normalized.note,
        })
    ) {
      const auditId = await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The saved inventory proposal changed after preview.",
      );
      return {
        error: conflict(
          "mink_inventory_draft_conflict",
          "The saved inventory proposal changed after preview. Review it again.",
        ),
        auditId,
      };
    }

    const target = await readTarget(db, input.actor, {
      productId: approval.resourceId,
      variantId: approval.variantId,
      locationId: approval.locationId,
    });
    const before = valuesFromJson(approval.beforeJson);
    const after = valuesFromJson(approval.afterJson);
    if (
      target.version !== approval.resourceVersion ||
      String(target.onHand) !== before.on_hand ||
      String(target.reserved) !== before.reserved ||
      target.sku !== before.sku ||
      target.locationName !== before.location
    ) {
      const auditId = await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "Inventory changed after preview.",
        target.version,
      );
      return {
        error: conflict(
          "mink_inventory_stock_conflict",
          "This SKU's stock or location changed after preview. Review the latest values.",
        ),
        auditId,
      };
    }
    const delta = Number(after.quantity_change);
    const resulting = target.onHand + delta;
    if (
      !Number.isInteger(delta) ||
      delta === 0 ||
      Math.abs(delta) > MAX_DELTA ||
      resulting < 0 ||
      resulting < target.reserved ||
      resulting > MAX_POSTGRES_INTEGER ||
      String(resulting) !== after.resulting_on_hand
    ) {
      throw invalidApproval();
    }

    const mutation = await writeAdjustment(
      db,
      input.actor,
      target,
      delta,
      resulting,
      after,
    );
    if (!mutation) {
      const auditId = await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "Inventory changed during execution.",
      );
      return { error: stockConflict(), auditId };
    }
    const now = new Date().toISOString();
    await db
      .update(minkActionApprovals)
      .set({
        status: "executed",
        approvedAt: now,
        executedAt: now,
        resultId: mutation.levelId,
        resultVersion: mutation.version,
        updatedAt: now,
      })
      .where(
        and(
          eq(minkActionApprovals.id, approval.id),
          eq(minkActionApprovals.storeId, input.actor.storeId),
          eq(minkActionApprovals.status, "pending"),
        ),
      );
    const auditId = crypto.randomUUID();
    await db.insert(minkActionAudit).values({
      id: auditId,
      approvalId: approval.id,
      storeId: approval.storeId,
      adminId: approval.adminId,
      draftId: approval.draftId,
      productId: approval.resourceId,
      resourceType: "inventory",
      resourceId: approval.resourceId,
      locationId: approval.locationId,
      variantId: approval.variantId,
      resourceVersionBefore: approval.resourceVersion,
      resourceVersionAfter: mutation.version,
      resultId: mutation.levelId,
      toolName: "adjust_inventory",
      operation: "apply",
      outcome: "executed",
      beforeJson: before,
      afterJson: after,
      productVersionBefore: null,
      productVersionAfter: null,
      requestHash: approval.requestHash,
      toolVersion: TOOL_VERSION,
      detail: `Approved single-SKU inventory adjustment; stock movement ${mutation.movementId}.`,
    });
    return {
      result: {
        approval: toApproval({
          ...approval,
          status: "executed",
          approvedAt: now,
          executedAt: now,
          resultId: mutation.levelId,
          resultVersion: mutation.version,
        }),
        auditId,
        repeated: false,
      },
    };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

async function writeAdjustment(
  db: Db,
  actor: MinkActorContext,
  target: InventoryTarget,
  delta: number,
  resulting: number,
  after: MinkInventoryActionValues,
) {
  let levelId = target.levelId;
  let version = target.version;
  if (!levelId) {
    const inserted = await db
      .insert(inventoryLevels)
      .values({
        storeId: actor.storeId,
        locationId: target.locationId,
        productId: target.productId,
        variantId: target.variantId,
        onHand: resulting,
        reserved: 0,
      })
      .onConflictDoNothing()
      .returning({
        id: inventoryLevels.id,
        version: inventoryLevels.updatedAt,
      });
    if (!inserted[0]) return null;
    levelId = inserted[0].id;
    version = inserted[0].version;
  } else {
    if (!version) throw invalidApproval();
    const updated = await db
      .update(inventoryLevels)
      .set({ onHand: resulting, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(inventoryLevels.id, levelId),
          eq(inventoryLevels.storeId, actor.storeId),
          eq(inventoryLevels.locationId, target.locationId),
          eq(inventoryLevels.productId, target.productId),
          target.variantId
            ? eq(inventoryLevels.variantId, target.variantId)
            : sql`${inventoryLevels.variantId} is null`,
          eq(inventoryLevels.onHand, target.onHand),
          eq(inventoryLevels.reserved, target.reserved),
          eq(inventoryLevels.updatedAt, version),
        ),
      )
      .returning({
        id: inventoryLevels.id,
        version: inventoryLevels.updatedAt,
      });
    if (!updated[0]) return null;
    levelId = updated[0].id;
    version = updated[0].version;
  }
  if (!version) throw invalidApproval();
  const movements = await db
    .insert(stockMovements)
    .values({
      storeId: actor.storeId,
      productId: target.productId,
      variantId: target.variantId,
      locationId: target.locationId,
      delta,
      reason: after.reason!,
      balanceAfter: resulting,
      note: after.note || null,
      createdBy: actor.adminId,
    })
    .returning({ id: stockMovements.id });
  if (!movements[0])
    throw new Error("Inventory movement insert returned no row");
  return {
    levelId,
    version,
    movementId: movements[0].id,
  };
}

async function readTarget(
  db: Db,
  actor: MinkActorContext,
  ids: {
    productId: string | null;
    variantId: string | null;
    locationId: string | null;
  },
): Promise<InventoryTarget> {
  if (!ids.productId || !ids.locationId) throw invalidApproval();
  if (actor.locationIds?.length === 0) throw authorityDenied();
  if (actor.locationIds && !actor.locationIds.includes(ids.locationId)) {
    throw authorityDenied();
  }
  const locations = await db
    .select({ id: storeLocations.id, name: storeLocations.name })
    .from(storeLocations)
    .where(
      and(
        eq(storeLocations.id, ids.locationId),
        eq(storeLocations.storeId, actor.storeId),
        eq(storeLocations.active, true),
      ),
    )
    .limit(1);
  if (!locations[0]) throw resourceNotFound();
  const productRows = await db
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      tracked: products.trackInventory,
      hasVariants: sql<boolean>`exists (
        select 1 from public.product_variants pv
        where pv.product_id = ${products.id} and pv.store_id = ${actor.storeId}::uuid
      )`,
    })
    .from(products)
    .where(
      and(eq(products.id, ids.productId), eq(products.storeId, actor.storeId)),
    )
    .limit(1);
  const product = productRows[0];
  if (!product) throw resourceNotFound();
  let variant: {
    id: string;
    name: string;
    sku: string;
    tracked: boolean;
  } | null = null;
  if (ids.variantId) {
    const rows = await db
      .select({
        id: productVariants.id,
        name: productVariants.name,
        sku: productVariants.sku,
        tracked: productVariants.trackInventory,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.id, ids.variantId),
          eq(productVariants.productId, product.id),
          eq(productVariants.storeId, actor.storeId),
        ),
      )
      .limit(1);
    variant = rows[0] ?? null;
    if (!variant) throw resourceNotFound();
  } else if (product.hasVariants) {
    throw invalidApproval();
  }
  if (!product.tracked || (variant && !variant.tracked)) {
    throw conflict(
      "mink_inventory_tracking_disabled",
      "Inventory tracking is no longer enabled for this SKU.",
    );
  }
  const levels = await db
    .select({
      id: inventoryLevels.id,
      onHand: inventoryLevels.onHand,
      reserved: inventoryLevels.reserved,
      version: inventoryLevels.updatedAt,
    })
    .from(inventoryLevels)
    .where(
      and(
        eq(inventoryLevels.storeId, actor.storeId),
        eq(inventoryLevels.locationId, ids.locationId),
        eq(inventoryLevels.productId, product.id),
        variant
          ? eq(inventoryLevels.variantId, variant.id)
          : sql`${inventoryLevels.variantId} is null`,
      ),
    )
    .limit(1);
  return {
    levelId: levels[0]?.id ?? null,
    productId: product.id,
    variantId: variant?.id ?? null,
    locationId: locations[0].id,
    productName: product.name,
    variantName: variant?.name ?? null,
    sku: variant?.sku ?? product.sku ?? "",
    locationName: locations[0].name,
    onHand: levels[0]?.onHand ?? 0,
    reserved: levels[0]?.reserved ?? 0,
    version: levels[0]?.version ?? null,
  };
}

async function createApproval(
  db: Db,
  input: {
    actor: MinkActorContext;
    draftId: string;
    draftVersion: number;
    target: InventoryTarget;
    before: MinkInventoryActionValues;
    after: MinkInventoryActionValues;
    idempotencyKey: string;
  },
) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const requestHash = hashValues({
    storeId: input.actor.storeId,
    adminId: input.actor.adminId,
    draftId: input.draftId,
    draftVersion: input.draftVersion,
    productId: input.target.productId,
    variantId: input.target.variantId,
    locationId: input.target.locationId,
    resourceVersion: input.target.version,
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
      productId: input.target.productId,
      resourceType: "inventory",
      resourceId: input.target.productId,
      resourceVersion: input.target.version,
      resourceLabel: resourceLabel(input.target),
      locationId: input.target.locationId,
      variantId: input.target.variantId,
      sourceApprovalId: null,
      toolName: "adjust_inventory",
      operation: "apply",
      draftVersion: input.draftVersion,
      productVersion: null,
      beforeJson: input.before,
      afterJson: input.after,
      requestHash,
      idempotencyKey: input.idempotencyKey,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0]
    ? validateApproval(inserted[0])
    : await readByIdempotency(db, input.actor, input.idempotencyKey);
  if (row.requestHash !== requestHash) {
    throw conflict(
      "mink_inventory_idempotency_conflict",
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
      locationId: minkDrafts.locationId,
      variantId: minkDrafts.variantId,
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
    draft.kind !== "inventory_adjustment" ||
    draft.status !== "draft" ||
    draft.currentVersion < 1
  ) {
    throw new MinkRequestError(
      "mink_inventory_draft_unavailable",
      "Save this private inventory proposal before reviewing it.",
      409,
    );
  }
  return draft;
}

function normalizeInventoryContent(value: unknown) {
  try {
    const content = normalizeMinkDraftContent("inventory_adjustment", value);
    const delta = Number(content.quantity_change);
    if (Math.abs(delta) > MAX_DELTA) throw new Error("Invalid delta");
    return content;
  } catch (error) {
    throw invalidDraft(
      error instanceof Error ? error.message : "Invalid inventory proposal.",
    );
  }
}

function values(
  target: InventoryTarget,
  content: Record<string, string> | null,
  resulting: number,
): MinkInventoryActionValues {
  return {
    product: target.productName,
    variant: target.variantName,
    sku: target.sku,
    location: target.locationName,
    on_hand: String(content ? resulting : target.onHand),
    reserved: String(target.reserved),
    available: String(
      content ? resulting - target.reserved : target.onHand - target.reserved,
    ),
    quantity_change: content?.quantity_change ?? null,
    resulting_on_hand: content ? String(resulting) : String(target.onHand),
    reason: content?.reason ?? null,
    note: content?.note ?? null,
  };
}

function toApproval(row: ApprovalRow): MinkInventoryActionApproval {
  return {
    id: row.id,
    sourceApprovalId: null,
    toolName: "adjust_inventory",
    operation: "apply",
    status: row.status,
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    resource: {
      type: "inventory",
      id: row.resourceId,
      label: row.resourceLabel ?? "Inventory item",
      dashboardPath: `/dashboard/inventory?location=${encodeURIComponent(row.locationId)}`,
      productId: row.resourceId,
      variantId: row.variantId,
      locationId: row.locationId,
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
    row.toolName !== "adjust_inventory" ||
    row.operation !== "apply" ||
    !["pending", "executed", "conflicted", "expired", "cancelled"].includes(
      row.status,
    ) ||
    row.resourceType !== "inventory" ||
    !row.resourceId ||
    !row.locationId ||
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
      where store_id = ${storeId}::uuid and tool_name = 'adjust_inventory'
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
          eq(minkActionToolAccess.toolName, "adjust_inventory"),
        ),
      )
      .limit(1);
    if (rows[0]?.enabled) return;
  }
  throw new MinkRequestError(
    "mink_inventory_tool_disabled",
    "StoreMink support has not enabled Mink inventory adjustments for this store.",
    403,
  );
}

function assertInventoryAuthority(actor: MinkActorContext) {
  if (
    !actor.draftingEnabled ||
    !can(actor.permissions, "inventory", "manage", actor.isSuperadmin)
  ) {
    throw authorityDenied();
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
  const id = crypto.randomUUID();
  await db.insert(minkActionAudit).values({
    id,
    approvalId: approval.id,
    storeId: approval.storeId,
    adminId: approval.adminId,
    draftId: approval.draftId,
    productId: approval.resourceId,
    resourceType: "inventory",
    resourceId: approval.resourceId,
    locationId: approval.locationId,
    variantId: approval.variantId,
    resourceVersionBefore: approval.resourceVersion,
    resourceVersionAfter,
    resultId: null,
    toolName: "adjust_inventory",
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
  return id;
}

function valuesFromJson(value: unknown): MinkInventoryActionValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidApproval();
  }
  const result: MinkInventoryActionValues = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && typeof item !== "string") throw invalidApproval();
    result[key] = item;
  }
  return result;
}

function hashValues(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function resourceLabel(target: InventoryTarget) {
  return `${target.productName}${target.variantName ? ` · ${target.variantName}` : ""} (${target.sku}) at ${target.locationName}`;
}

function invalidApproval() {
  return new MinkRequestError(
    "mink_inventory_approval_invalid",
    "This inventory approval is invalid. Create a new preview.",
    409,
  );
}

function approvalNotFound() {
  return new MinkRequestError(
    "mink_inventory_approval_not_found",
    "This inventory approval is unavailable.",
    404,
  );
}

function invalidDraft(message: string) {
  return new MinkRequestError("mink_inventory_draft_invalid", message, 400);
}

function resourceNotFound() {
  return new MinkRequestError(
    "mink_inventory_target_not_found",
    "The inventory SKU or location is no longer available.",
    404,
  );
}

function authorityDenied() {
  return new MinkRequestError(
    "mink_inventory_access_denied",
    "You do not have permission for this inventory location or action.",
    403,
  );
}

function conflict(code: string, message: string) {
  return new MinkRequestError(code, message, 409);
}

function stockConflict() {
  return conflict(
    "mink_inventory_stock_conflict",
    "This SKU's stock changed during approval. Review the latest values before trying again.",
  );
}
