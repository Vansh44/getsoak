import { describe, expect, it } from "vitest";
import {
  MINK_ACTION_TOOL_LABELS,
  actionFieldsForTool,
  actionToolForDraftKind,
  draftContentForAction,
  isMinkActionTool,
  isMinkDomainActionTool,
} from "./product-action-types";

describe("Mink Phase 4A product action contract", () => {
  it("maps only the two saved product-text draft kinds to live actions", () => {
    expect(actionToolForDraftKind("product_description")).toBe(
      "apply_product_description",
    );
    expect(actionToolForDraftKind("product_seo")).toBe("apply_product_seo");
    expect(actionToolForDraftKind("blog")).toBeNull();
    expect(actionToolForDraftKind("coupon_email")).toBeNull();
    expect(actionToolForDraftKind("customer_message")).toBeNull();
  });

  it("allowlists description without accepting other product fields", () => {
    const fields = actionFieldsForTool("apply_product_description");
    expect(fields).toEqual(["description"]);
    expect(
      draftContentForAction("apply_product_description", {
        description: "Approved copy",
        status: "published",
        stock: "999",
        selling_price: "1",
      }),
    ).toEqual({ description: "Approved copy" });
  });

  it("allowlists exactly the two SEO fields", () => {
    const fields = actionFieldsForTool("apply_product_seo");
    expect(fields).toEqual(["seo_title", "seo_description"]);
    expect(
      draftContentForAction("apply_product_seo", {
        seo_title: "Tea",
        seo_description: "Fresh tea.",
        name: "Browser replacement",
        images: "[]",
      }),
    ).toEqual({ seo_title: "Tea", seo_description: "Fresh tea." });
  });

  it("keeps the Phase 5A inventory gate independent from Phase 4 domain tools", () => {
    expect(isMinkActionTool("adjust_inventory")).toBe(true);
    expect(isMinkDomainActionTool("adjust_inventory")).toBe(false);
    expect(MINK_ACTION_TOOL_LABELS.adjust_inventory).toBe(
      "Single-SKU inventory adjustments",
    );
  });

  it("keeps the Phase 5B bulk inventory gate independent", () => {
    expect(isMinkActionTool("bulk_adjust_inventory")).toBe(true);
    expect(isMinkDomainActionTool("bulk_adjust_inventory")).toBe(false);
    expect(MINK_ACTION_TOOL_LABELS.bulk_adjust_inventory).toBe(
      "Bulk inventory adjustments",
    );
  });

  it("keeps the Phase 5C order-status gate independent", () => {
    expect(isMinkActionTool("transition_order_status")).toBe(true);
    expect(isMinkDomainActionTool("transition_order_status")).toBe(false);
    expect(MINK_ACTION_TOOL_LABELS.transition_order_status).toBe(
      "Delivery order-status transitions",
    );
  });

  it("keeps the Phase 5D blog-publication gate independent", () => {
    expect(isMinkActionTool("publish_blog")).toBe(true);
    expect(isMinkDomainActionTool("publish_blog")).toBe(false);
    expect(MINK_ACTION_TOOL_LABELS.publish_blog).toBe(
      "Blog publication and scheduling",
    );
  });

  it("keeps the Phase 5E campaign gate independent", () => {
    expect(isMinkActionTool("send_campaign")).toBe(true);
    expect(isMinkDomainActionTool("send_campaign")).toBe(false);
    expect(MINK_ACTION_TOOL_LABELS.send_campaign).toBe(
      "Coupon email campaigns",
    );
  });

  it("keeps the Phase 5F bulk-pricing gate independent", () => {
    expect(isMinkActionTool("bulk_update_prices")).toBe(true);
    expect(isMinkDomainActionTool("bulk_update_prices")).toBe(false);
    expect(MINK_ACTION_TOOL_LABELS.bulk_update_prices).toBe(
      "Bulk price updates",
    );
  });
});
