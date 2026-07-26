import { describe, it, expect } from "vitest";
import {
  absoluteUrl,
  platformBrand,
  renderNotificationDigest,
  renderNotificationEmail,
  type NotificationEmailItem,
} from "./notification-emails";
import {
  digestSendAfter,
  DAILY_DIGEST_HOUR_UTC,
} from "@/lib/notifications/digest";
import type { StoreBrand } from "@/lib/store/brand";

const brand: StoreBrand = {
  name: "Acme Juice",
  logoUrl: null,
  primaryColor: "#123456",
  tagline: null,
  blurb: null,
  legalName: null,
  creditLine: null,
  email: null,
  phone: null,
  hours: null,
  social: { instagram: null, youtube: null, whatsapp: null },
  badges: [],
  domain: "acme.storemink.com",
};

const BASE = "https://acme.storemink.com";

function item(
  overrides: Partial<NotificationEmailItem> = {},
): NotificationEmailItem {
  return {
    title: "New order ORD10010004",
    body: "₹1,240 · from Priya S.",
    url: "/dashboard/orders?q=ORD10010004",
    severity: "success",
    createdAt: "2026-07-25T10:00:00.000Z",
    ...overrides,
  };
}

describe("absoluteUrl", () => {
  it("absolutises an app-relative path", () => {
    expect(absoluteUrl("/dashboard/orders", BASE)).toBe(
      "https://acme.storemink.com/dashboard/orders",
    );
  });

  it("passes an already-absolute URL through", () => {
    expect(absoluteUrl("https://elsewhere.test/x", BASE)).toBe(
      "https://elsewhere.test/x",
    );
  });

  it("doesn't double the slash when the base has a trailing one", () => {
    expect(absoluteUrl("/orders", "https://acme.storemink.com/")).toBe(
      "https://acme.storemink.com/orders",
    );
  });

  // A stored value that isn't a plain path must not become a link somewhere
  // else entirely (or a javascript: URL in a mail client).
  it("drops anything that isn't a plain path", () => {
    expect(absoluteUrl("javascript:alert(1)", BASE)).toBeNull();
    expect(absoluteUrl("//evil.test/x", BASE)).toBe(
      "https://acme.storemink.com//evil.test/x",
    );
    expect(absoluteUrl("mailto:a@b.com", BASE)).toBeNull();
    expect(absoluteUrl("", BASE)).toBeNull();
    expect(absoluteUrl(null, BASE)).toBeNull();
  });
});

describe("renderNotificationEmail", () => {
  it("uses the notification title as the subject", () => {
    const { subject } = renderNotificationEmail({
      item: item(),
      brand,
      baseUrl: BASE,
    });
    expect(subject).toBe("New order ORD10010004");
  });

  it("includes the body, an absolute CTA, and the preferences footer", () => {
    const { html } = renderNotificationEmail({
      item: item(),
      brand,
      baseUrl: BASE,
    });
    expect(html).toContain("₹1,240");
    expect(html).toContain(
      "https://acme.storemink.com/dashboard/orders?q=ORD10010004",
    );
    expect(html).toContain(
      "https://acme.storemink.com/dashboard/settings/notifications",
    );
  });

  it("renders without a CTA when the notification has no link", () => {
    const { html } = renderNotificationEmail({
      item: item({ url: null }),
      brand,
      baseUrl: BASE,
    });
    expect(html).not.toContain("View in dashboard");
  });

  // Titles/bodies are built from DB values (customer names, product names), so
  // the guarantee is that no interpolated value can open a TAG — the escaped
  // attribute text itself surviving as inert characters is fine.
  it("escapes interpolated copy so no tag can form", () => {
    const { html } = renderNotificationEmail({
      item: item({
        title: 'Order <img src=x onerror="alert(1)">',
        body: "<script>alert(2)</script>",
      }),
      brand,
      baseUrl: BASE,
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    // The quotes that would close an attribute are escaped too.
    expect(html).toContain("onerror=&quot;");
  });
});

describe("renderNotificationDigest", () => {
  const items = [
    item(),
    item({ title: "Low stock · Cold Brew", severity: "warning" }),
  ];

  it("summarises the count in the subject", () => {
    const { subject } = renderNotificationDigest({
      items,
      brand,
      baseUrl: BASE,
      digest: "daily",
    });
    expect(subject).toBe("2 updates from Acme Juice");
  });

  it("singularises a one-item digest", () => {
    const { subject } = renderNotificationDigest({
      items: [item()],
      brand,
      baseUrl: BASE,
      digest: "hourly",
    });
    expect(subject).toBe("1 update from Acme Juice");
  });

  it("lists every item with its own link", () => {
    const { html } = renderNotificationDigest({
      items,
      brand,
      baseUrl: BASE,
      digest: "daily",
    });
    expect(html).toContain("New order ORD10010004");
    expect(html).toContain("Low stock · Cold Brew");
    expect(html).toContain("https://acme.storemink.com/dashboard/activity");
  });

  it("names the window it covers", () => {
    expect(
      renderNotificationDigest({
        items,
        brand,
        baseUrl: BASE,
        digest: "hourly",
      }).html,
    ).toContain("in the last hour");
    expect(
      renderNotificationDigest({ items, brand, baseUrl: BASE, digest: "daily" })
        .html,
    ).toContain("since yesterday");
  });

  it("escapes item copy", () => {
    const { html } = renderNotificationDigest({
      items: [item({ title: "<b>bold</b>" })],
      brand,
      baseUrl: BASE,
      digest: "daily",
    });
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("platformBrand", () => {
  it("is a complete StoreBrand for operator mail", () => {
    const b = platformBrand();
    expect(b.name).toBe("StoreMink");
    expect(b.domain).toBeTruthy();
    expect(b.primaryColor).toMatch(/^#/);
  });
});

describe("digestSendAfter", () => {
  const at = (iso: string) => new Date(iso);

  it("sends instant rows immediately", () => {
    const from = at("2026-07-25T14:37:12.000Z");
    expect(digestSendAfter("instant", from).toISOString()).toBe(
      from.toISOString(),
    );
  });

  // Clock-aligned, not "now + 1h": everything in one hour must share a send
  // time or the digest degrades into one email per event.
  it("aligns an hourly digest to the top of the next hour", () => {
    expect(
      digestSendAfter("hourly", at("2026-07-25T14:37:12.000Z")).toISOString(),
    ).toBe("2026-07-25T15:00:00.000Z");
    expect(
      digestSendAfter("hourly", at("2026-07-25T14:00:00.000Z")).toISOString(),
    ).toBe("2026-07-25T15:00:00.000Z");
  });

  it("rolls an hourly digest past midnight", () => {
    expect(
      digestSendAfter("hourly", at("2026-07-25T23:40:00.000Z")).toISOString(),
    ).toBe("2026-07-26T00:00:00.000Z");
  });

  it("sends a daily digest at the next daily slot", () => {
    const hh = String(DAILY_DIGEST_HOUR_UTC).padStart(2, "0");
    // Before today's slot → today.
    expect(
      digestSendAfter("daily", at("2026-07-25T02:00:00.000Z")).toISOString(),
    ).toBe(`2026-07-25T${hh}:00:00.000Z`);
    // Past it → tomorrow's.
    const past = at(`2026-07-25T${hh}:30:00.000Z`);
    expect(digestSendAfter("daily", past).toISOString()).toBe(
      `2026-07-26T${hh}:00:00.000Z`,
    );
  });

  // The slot must land BEFORE the /api/cron/send-emails heartbeat (00:00 UTC),
  // or a daily digest comes due just after the only run of the day and waits a
  // further 24 hours. See the note on DAILY_DIGEST_HOUR_UTC.
  it("keeps the daily slot ahead of the 00:00 UTC cron", () => {
    expect(DAILY_DIGEST_HOUR_UTC).toBeGreaterThanOrEqual(20);
    expect(DAILY_DIGEST_HOUR_UTC).toBeLessThan(24);
  });

  it("two events in the same window share a send time", () => {
    const a = digestSendAfter("hourly", at("2026-07-25T14:01:00.000Z"));
    const b = digestSendAfter("hourly", at("2026-07-25T14:59:00.000Z"));
    expect(a.toISOString()).toBe(b.toISOString());
  });
});
