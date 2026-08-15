/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// The gate, not the plumbing.
//
// Every export of this module is a publicly reachable POST endpoint, and one of
// them mails every merchant on the platform. The db mock here does not evaluate
// predicates, so these assert WHO may call WHAT — which is the part a mistake
// is unrecoverable in.
// ---------------------------------------------------------------------------

vi.mock("@/app/actions/platform", () => ({ getPlatformViewer: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/announcements/resolve", () => ({
  materialiseRecipients: vi.fn(),
  previewAudience: vi.fn(),
}));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/email/trigger-worker", () => ({ triggerEmailWorker: vi.fn() }));
// Partial: lib/site.ts pulls in lib/store/resolve.ts, which calls
// `unstable_cache` at module scope — a bare mock would make the import throw.
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  revalidatePath: vi.fn(),
}));

import {
  deleteAnnouncement,
  previewAnnouncementAudience,
  saveAnnouncement,
  sendAnnouncement,
  sendAnnouncementTest,
} from "./announcement-actions";
import { getPlatformViewer } from "@/app/actions/platform";
import { withService } from "@/lib/db/client";
import { materialiseRecipients } from "@/lib/announcements/resolve";
import { sendEmail } from "@/lib/email/send";
import { triggerEmailWorker } from "@/lib/email/trigger-worker";

const asMember = () =>
  vi.mocked(getPlatformViewer).mockResolvedValue({
    email: "member@storemink.com",
    role: "member",
  });
const asSuperadmin = () =>
  vi.mocked(getPlatformViewer).mockResolvedValue({
    email: "owner@storemink.com",
    role: "superadmin",
  });
const asNobody = () => vi.mocked(getPlatformViewer).mockResolvedValue(null);

const draft = {
  id: "a1",
  title: "News",
  category: "feature",
  subject: "Something new",
  body: "<p>Hello</p>",
  ctaLabel: null,
  ctaUrl: null,
  smsBody: null,
  dltTemplateId: null,
  channels: { email: true, sms: false },
  audience: { include: ["owner"] },
  status: "draft",
  total: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
  createdBy: "owner@storemink.com",
  createdAt: "2026-08-15T00:00:00.000Z",
  sentAt: null,
};

/** `withService(cb)` runs `cb` against a stub db returning `rows`. */
function dbReturning(rows: unknown[]) {
  const chain: any = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
    update: () => chain,
    set: () => chain,
    insert: () => chain,
    values: () => chain,
    delete: () => chain,
    returning: () => Promise.resolve(rows),
  };
  vi.mocked(withService).mockImplementation((cb: any) => cb(chain));
}

beforeEach(() => {
  // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS — defaults are restored
  // explicitly so nothing leaks into the next test (see CODEBASE §8).
  vi.clearAllMocks();
  dbReturning([draft]);
  vi.mocked(materialiseRecipients).mockResolvedValue({ total: 3, skipped: 1 });
  vi.mocked(sendEmail).mockResolvedValue({ sent: true } as any);
  vi.mocked(triggerEmailWorker).mockResolvedValue(undefined as any);
});

describe("authorization", () => {
  it("refuses everything to a non-operator", async () => {
    asNobody();
    expect(
      await saveAnnouncement({
        title: "x",
        category: "feature",
        subject: "s",
        body: "b",
        channels: { email: true, sms: false },
        audience: {},
      }),
    ).toMatchObject({ error: expect.any(String) });
    expect(await sendAnnouncement("a1")).toMatchObject({
      error: expect.any(String),
    });
    expect(await sendAnnouncementTest("a1")).toMatchObject({
      error: expect.any(String),
    });
    expect(await deleteAnnouncement("a1")).toMatchObject({
      error: expect.any(String),
    });
    expect(
      (
        await previewAnnouncementAudience({}, "feature", {
          email: true,
          sms: false,
        })
      ).ok,
    ).toBe(false);
  });

  // ★ SENDING IS THE ONE ACTION THAT REACHES EVERY MERCHANT AND CANNOT BE
  // RECALLED. Drafting and previewing are deliberately delegable — reviewing
  // copy is the half that benefits from more eyes.
  it("lets a member draft but not send", async () => {
    asMember();
    expect(
      await saveAnnouncement({
        title: "x",
        category: "feature",
        subject: "s",
        body: "b",
        channels: { email: true, sms: false },
        audience: {},
      }),
    ).toMatchObject({ success: true });

    expect(await sendAnnouncement("a1")).toMatchObject({
      error: expect.stringContaining("superadmin"),
    });
    expect(materialiseRecipients).not.toHaveBeenCalled();
  });

  it("lets a member delete nothing", async () => {
    asMember();
    expect(await deleteAnnouncement("a1")).toMatchObject({
      error: expect.stringContaining("superadmin"),
    });
  });
});

describe("saveAnnouncement", () => {
  it("refuses an announcement with no channel", async () => {
    asSuperadmin();
    const result = await saveAnnouncement({
      title: "x",
      category: "feature",
      subject: "s",
      body: "b",
      channels: { email: false, sms: false },
      audience: {},
    });
    expect(result).toMatchObject({ error: expect.stringContaining("channel") });
  });

  it("requires a name", async () => {
    asSuperadmin();
    const result = await saveAnnouncement({
      title: "   ",
      category: "feature",
      subject: "s",
      body: "b",
      channels: { email: true, sms: false },
      audience: {},
    });
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  // The update is a conditional claim on status='draft', so a zero-row result
  // means "already sent" rather than "not found" — and must say so.
  it("reports a locked announcement when the update matches nothing", async () => {
    asSuperadmin();
    dbReturning([]);
    const result = await saveAnnouncement({
      id: "a1",
      title: "x",
      category: "feature",
      subject: "s",
      body: "b",
      channels: { email: true, sms: false },
      audience: {},
    });
    expect(result).toMatchObject({ error: expect.stringContaining("locked") });
  });
});

describe("sendAnnouncement", () => {
  it("sends a complete draft", async () => {
    asSuperadmin();
    expect(await sendAnnouncement("a1")).toMatchObject({ success: true });
    expect(materialiseRecipients).toHaveBeenCalledOnce();
  });

  it("refuses one with no subject or no copy", async () => {
    asSuperadmin();
    dbReturning([{ ...draft, subject: "  " }]);
    expect(await sendAnnouncement("a1")).toMatchObject({
      error: expect.stringContaining("subject"),
    });

    dbReturning([{ ...draft, body: "" }]);
    expect(await sendAnnouncement("a1")).toMatchObject({
      error: expect.stringContaining("copy"),
    });
    expect(materialiseRecipients).not.toHaveBeenCalled();
  });

  it("refuses to send the same announcement twice", async () => {
    asSuperadmin();
    dbReturning([{ ...draft, status: "sent" }]);
    expect(await sendAnnouncement("a1")).toMatchObject({
      error: expect.stringContaining("already"),
    });
    expect(materialiseRecipients).not.toHaveBeenCalled();
  });

  // ★★ THE SMS GATE. There is no platform Twilio account and no DLT
  // registration, so accepting an SMS send would write recipient rows for
  // messages every carrier drops SILENTLY — pending forever, with no bounce.
  it("refuses an SMS announcement with a reason, and writes no rows", async () => {
    asSuperadmin();
    dbReturning([
      { ...draft, channels: { email: false, sms: true }, dltTemplateId: "T1" },
    ]);
    const result = await sendAnnouncement("a1");
    expect(result.error).toMatch(/SMS can't be sent/i);
    expect(materialiseRecipients).not.toHaveBeenCalled();
  });
});

describe("sendAnnouncementTest", () => {
  // ★ AN OPEN RELAY IS THE FAILURE MODE HERE. A test-send that took a
  // recipient would let any operator mail arbitrary HTML to any address from
  // StoreMink's verified sending domain.
  it("mails the signed-in operator's own address, and takes no recipient", async () => {
    asMember();
    expect(await sendAnnouncementTest("a1")).toMatchObject({ success: true });
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "member@storemink.com",
        mailer: "announcement",
        storeId: null,
      }),
    );
    expect(sendAnnouncementTest.length).toBe(1);
  });

  it("reports a send failure rather than claiming success", async () => {
    asMember();
    vi.mocked(sendEmail).mockResolvedValue({
      sent: false,
      error: "Resend down",
    } as any);
    expect(await sendAnnouncementTest("a1")).toMatchObject({
      error: "Resend down",
    });
  });
});
