/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";

/**
 * ★★ THE REGRESSION THIS FILE EXISTS FOR. `domain-actions.ts` dispatches on the
 * tool or the resource type in a dozen places, and Offers (Phase I) was wired
 * into some of them. Every site it missed failed the same way — by falling
 * through into the arm written for something else, which TypeScript is happy
 * with because the return type is satisfied either way:
 *
 *   • `isResourceType` still read `product | coupon | customer_group`, and
 *     `validateDomainApprovalRow` runs it over every approval created, executed
 *     or rolled back. The database accepted `resource_type = 'offer'` (0070)
 *     and the application threw "This Mink approval is invalid" on the way in —
 *     so this one alone kept offers dead even with the rest fixed.
 *   • `normalizeProposedValues` ended in the CUSTOMER-GROUP branch, which reads
 *     `content.color`. No offer draft has that key (MINK_DRAFT_CONFIG declares
 *     eight fields and `normalizeMinkDraftContent` returns exactly the
 *     configured keys), so reviewing any offer proposal threw
 *     `TypeError: Cannot read properties of undefined (reading 'trim')` and all
 *     three offer tools were dead on arrival.
 *   • `assertNoUniqueConflict` fell into the same branch and refused an offer
 *     for sharing a name with an unrelated customer group.
 *   • `deleteCreatedResource` had no `create_offer` arm, so rollback threw
 *     `invalid approval` even though `assertSafeCreateRollback`'s dedicated
 *     offer branch had just cleared it.
 *   • `assertDomainActionAuthority`'s section ternary ended in `"users"`, so
 *     the action gate asked for the CUSTOMER LIST permission while
 *     `MINK_DRAFT_PERMISSIONS` asks for `promotions`. Drafts are created and
 *     previewed by the same admin and drafts.ts refuses a `users`-only admin at
 *     creation, so the reachable effect was refusing the real offers manager —
 *     but two gates on one feature that disagree are one upstream change away
 *     from being an escalation, so this is now a total map.
 *
 * There was no test file for this module at all, which is why a completely
 * dead feature path shipped green.
 */

const state = vi.hoisted(() => ({
  selects: {} as Record<string, any[][]>,
  inserted: [] as any[],
}));

function takeSelect(table: string) {
  const queue = state.selects[table];
  if (!queue || queue.length === 0) return [];
  return queue.length === 1 ? queue[0] : queue.shift();
}

/** A chainable stand-in that answers by TABLE, not by call position — the read
 *  order here varies with the tool, so a positional queue could not reach it. */
function selectChain() {
  let table = "";
  const c: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: any) => res(takeSelect(table));
        return (...args: any[]) => {
          if (prop === "from" && args[0]) table = getTableName(args[0]);
          return c;
        };
      },
    },
  );
  return c;
}

/** Echoes the row the code asked to insert, so assertions see the real payload. */
function insertChain() {
  let payload: any = {};
  const c: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: any) => res(rows());
        return (...args: any[]) => {
          if (prop === "values") {
            payload = args[0];
            state.inserted.push(args[0]);
          }
          return c;
        };
      },
    },
  );
  const rows = () => [
    {
      status: "pending",
      resultId: null,
      resultVersion: null,
      executedAt: null,
      ...payload,
    },
  ];
  return c;
}

const db = {
  execute: async () => ({ rows: [] }),
  select: () => selectChain(),
  insert: () => insertChain(),
  update: () => selectChain(),
  delete: () => selectChain(),
};

vi.mock("@/lib/db/client", () => ({
  withService: (fn: any) => fn(db),
}));

const OFFER_ID = "11111111-1111-4111-8111-111111111111";
const DRAFT_ID = "22222222-2222-4222-8222-222222222222";

function actor(overrides: Record<string, unknown> = {}) {
  return {
    storeId: "33333333-3333-4333-8333-333333333333",
    adminId: "admin-1",
    isSuperadmin: false,
    draftingEnabled: true,
    permissions: { promotions: ["manage"] },
    ...overrides,
  } as any;
}

function offerDraft(kind: string, content: Record<string, string>) {
  return {
    id: DRAFT_ID,
    kind,
    status: "draft",
    destinationId: kind === "offer_create" ? null : OFFER_ID,
    content,
    currentVersion: 1,
  };
}

const CREATE_CONTENT = {
  name: "Weekend 10%",
  description: "",
  reward_type: "percent_off",
  reward_value: "10",
  min_subtotal: "500",
  budget: "5000",
  max_redemptions: "",
  valid_until: "",
};

const LIVE_OFFER = {
  id: OFFER_ID,
  storeId: "33333333-3333-4333-8333-333333333333",
  name: "Weekend 10%",
  description: null,
  status: "disabled",
  rewardType: "percent_off",
  rewardConfig: { percent: 10 },
  triggerConfig: { minSubtotal: 500 },
  budgetPaise: 500000,
  spentPaise: 0,
  maxRedemptions: null,
  redemptionCount: 0,
  validUntil: null,
  version: "2026-09-04 00:00:00.123456+00",
};

beforeEach(() => {
  state.selects = {};
  state.inserted = [];
});

async function preview(a = actor()) {
  const { previewMinkDomainAction } = await import("./domain-actions");
  return previewMinkDomainAction({
    actor: a,
    draftId: DRAFT_ID,
    expectedDraftVersion: 1,
    idempotencyKey: "idem-1",
  });
}

describe("Mink offer proposals reach a preview at all", () => {
  it("reviews a create_offer proposal instead of crashing on a group's colour", async () => {
    state.selects.mink_drafts = [[offerDraft("offer_create", CREATE_CONTENT)]];
    state.selects.mink_action_tool_access = [[{ enabled: true }]];

    const approval = await preview();

    expect(approval.toolName).toBe("create_offer");
    expect(approval.resource.type).toBe("offer");
    expect(approval.after).toMatchObject({
      name: "Weekend 10%",
      reward_type: "percent_off",
      reward_value: "10.00",
      min_subtotal: "500.00",
      budget: "5000.00",
      max_redemptions: null,
      // Pinned literally: turning an offer on is its own approval.
      status: "disabled",
    });
  });

  it("never queries customer groups to decide whether an offer name is free", async () => {
    state.selects.mink_drafts = [[offerDraft("offer_create", CREATE_CONTENT)]];
    state.selects.mink_action_tool_access = [[{ enabled: true }]];
    // A group with the same name. The old fallthrough refused the offer with
    // "A customer group with this name already exists."
    state.selects.user_groups = [[{ id: "group-1" }]];

    await expect(preview()).resolves.toMatchObject({
      toolName: "create_offer",
    });
  });

  it("proposes activation as the live offer with one field moved", async () => {
    state.selects.mink_drafts = [
      [offerDraft("offer_activate", { offer_id: OFFER_ID })],
    ];
    state.selects.mink_action_tool_access = [[{ enabled: true }]];
    state.selects.offers = [[LIVE_OFFER]];

    const approval = await preview();

    expect(approval.toolName).toBe("activate_offer");
    expect(approval.before.status).toBe("disabled");
    expect(approval.after.status).toBe("active");
    // Everything else is the offer AS IT STANDS TODAY, which is what makes
    // writeOffer's mandatory budget re-check meaningful at activation.
    for (const field of ["name", "reward_type", "reward_value", "budget"]) {
      expect(approval.after[field]).toBe(approval.before[field]);
    }
  });

  it("keeps stored and proposed money in one text format", async () => {
    // `sameValues` compares these as strings. A stored "5000" against a
    // proposed "5000.00" would report a change nobody made, and would make
    // every activation look like a terms edit.
    state.selects.mink_drafts = [
      [offerDraft("offer_activate", { offer_id: OFFER_ID })],
    ];
    state.selects.mink_action_tool_access = [[{ enabled: true }]];
    state.selects.offers = [[LIVE_OFFER]];

    const approval = await preview();
    expect(approval.before.budget).toBe("5000.00");
    expect(approval.before.reward_value).toBe("10.00");
    expect(approval.before.min_subtotal).toBe("500.00");
  });

  it("refuses a reward shape Mink is not allowed to propose", async () => {
    state.selects.mink_drafts = [
      [
        offerDraft("offer_create", {
          ...CREATE_CONTENT,
          reward_type: "buy_x_get_y",
        }),
      ],
    ];
    state.selects.mink_action_tool_access = [[{ enabled: true }]];
    await expect(preview()).rejects.toThrow(/percent_off or amount_off/);
  });

  it("refuses an offer with no budget, before the merchant approves it", async () => {
    state.selects.mink_drafts = [
      [offerDraft("offer_create", { ...CREATE_CONTENT, budget: "" })],
    ];
    state.selects.mink_action_tool_access = [[{ enabled: true }]];
    await expect(preview()).rejects.toThrow(/Total budget/);
  });
});

describe("Mink offer authority is the promotions section", () => {
  it("accepts the offers manager", async () => {
    state.selects.mink_drafts = [[offerDraft("offer_create", CREATE_CONTENT)]];
    state.selects.mink_action_tool_access = [[{ enabled: true }]];
    await expect(
      preview(actor({ permissions: { promotions: ["manage"] } })),
    ).resolves.toMatchObject({ toolName: "create_offer" });
  });

  it("refuses an admin who only manages the customer list", async () => {
    state.selects.mink_drafts = [[offerDraft("offer_create", CREATE_CONTENT)]];
    state.selects.mink_action_tool_access = [[{ enabled: true }]];
    // The mirror of the test above: the action gate and the draft gate must
    // name the SAME section, or one of them is deciding something the other
    // already decided differently.
    await expect(
      preview(actor({ permissions: { users: ["manage"] } })),
    ).rejects.toThrow(/permission/i);
  });
});
