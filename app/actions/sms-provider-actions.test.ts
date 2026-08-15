/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/sms/twilio", () => ({ twilioVerifyCreds: vi.fn() }));
// ⚠ The stub returns an OPAQUE value, not `enc:${s}`. A stub that keeps the
// plaintext inside its output makes the "never stored in the clear" assertion
// below unsatisfiable — it would fail for the stub's sake rather than the
// code's, which is the kind of test that gets deleted instead of believed.
vi.mock("@/lib/payments/crypto", () => ({
  encryptSecret: vi.fn(() => "OPAQUE-CIPHERTEXT"),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { getManagerUserId } from "@/app/dashboard/lib/access";
import { twilioVerifyCreds } from "@/lib/sms/twilio";
import { encryptSecret } from "@/lib/payments/crypto";
import {
  disconnectSms,
  getSmsChannelState,
  saveSmsCredentials,
  setSmsEnabled,
} from "./sms-provider-actions";

const SID = "AC" + "a".repeat(32);
const GOOD = {
  accountSid: SID,
  authToken: "x".repeat(32),
  senderHeader: "CORNRS",
  dltEntityId: "1701234567890123456",
};

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS.
  vi.mocked(getManagerUserId).mockResolvedValue("admin-1");
  vi.mocked(twilioVerifyCreds).mockResolvedValue({
    ok: true,
    friendlyName: "Corner Store",
  });
  vi.mocked(encryptSecret).mockReturnValue("OPAQUE-CIPHERTEXT");
  dbHolder.current = makeDbMock({ selectQueue: [[]] });
});

describe("permissions", () => {
  it.each([
    ["saveSmsCredentials", () => saveSmsCredentials(GOOD)],
    ["setSmsEnabled", () => setSmsEnabled(true)],
    ["disconnectSms", () => disconnectSms()],
  ])("%s refuses without the channels grant", async (_name, call) => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    expect((await call()).error).toMatch(/permission/i);
  });

  it("getSmsChannelState reports nothing without the grant", async () => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    expect((await getSmsChannelState()).connected).toBe(false);
  });
});

describe("saveSmsCredentials", () => {
  it("verifies BEFORE it stores", async () => {
    await saveSmsCredentials(GOOD);
    expect(twilioVerifyCreds).toHaveBeenCalledWith({
      accountSid: SID,
      authToken: GOOD.authToken,
    });
    expect(dbHolder.current.calls.values).toHaveLength(1);
  });

  // ★ A typo'd token must fail in front of the person who typed it, not six
  // hours later on a confirmation that never arrives.
  it("stores nothing when the provider rejects the credentials", async () => {
    vi.mocked(twilioVerifyCreds).mockResolvedValue({
      ok: false,
      error: "Twilio rejected that Account SID and token.",
    });
    const r = await saveSmsCredentials(GOOD);
    expect(r.error).toMatch(/rejected/i);
    expect(dbHolder.current.calls.values).toHaveLength(0);
  });

  it("encrypts the auth token and never stores it in the clear", async () => {
    await saveSmsCredentials(GOOD);
    const row = dbHolder.current.calls.values[0];
    expect(encryptSecret).toHaveBeenCalledWith(GOOD.authToken);
    expect(row.authTokenEnc).toBe("OPAQUE-CIPHERTEXT");
    // The whole row, not just that column — a token copied into a second field
    // would defeat the point of encrypting the first.
    expect(JSON.stringify(row)).not.toContain(GOOD.authToken);
  });

  it("enables the channel — pasting working credentials IS the intent", async () => {
    await saveSmsCredentials(GOOD);
    expect(dbHolder.current.calls.values[0].enabled).toBe(true);
    expect(dbHolder.current.calls.values[0].verifiedAt).toBeTruthy();
  });

  it("scopes to the acting store, never to caller input", async () => {
    await saveSmsCredentials({ ...GOOD, storeId: "other" } as never);
    expect(dbHolder.current.calls.values[0].storeId).toBe("store-1");
  });

  it("rejects a malformed Account SID without calling the provider", async () => {
    const r = await saveSmsCredentials({ ...GOOD, accountSid: "nope" });
    expect(r.error).toMatch(/Account SID/i);
    expect(twilioVerifyCreds).not.toHaveBeenCalled();
  });

  it("rejects an implausible auth token without calling the provider", async () => {
    const r = await saveSmsCredentials({ ...GOOD, authToken: "short" });
    expect(r.error).toMatch(/Auth Token/i);
    expect(twilioVerifyCreds).not.toHaveBeenCalled();
  });

  // ★★ THE DLT FIELDS ARE REQUIRED. A connection stored without them looks
  // connected and delivers nothing — the carrier drops it silently, so the
  // merchant gets no error to act on.
  it.each([
    ["CORNR", "five letters"],
    ["CORN12", "digits — that is a promotional header"],
    ["", "empty"],
  ])("refuses the sender header %s (%s)", async (senderHeader) => {
    const r = await saveSmsCredentials({ ...GOOD, senderHeader });
    expect(r.error).toMatch(/six letters/i);
    expect(dbHolder.current.calls.values).toHaveLength(0);
  });

  it("refuses a missing DLT entity id", async () => {
    const r = await saveSmsCredentials({ ...GOOD, dltEntityId: "  " });
    expect(r.error).toMatch(/Entity ID/i);
    expect(dbHolder.current.calls.values).toHaveLength(0);
  });

  it("upper-cases the header the way the portals issue it", async () => {
    await saveSmsCredentials({ ...GOOD, senderHeader: " cornrs " });
    expect(dbHolder.current.calls.values[0].senderHeader).toBe("CORNRS");
  });
});

describe("getSmsChannelState", () => {
  // ★ WRITE-ONLY BY DESIGN. No action returns the token, and the card shows
  // "connected" rather than a masked value — a masked value invites someone to
  // try to read it.
  it("never returns the auth token", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            accountSid: SID,
            senderHeader: "CORNRS",
            dltEntityId: "170",
            enabled: true,
            verifiedAt: "2026-08-15T00:00:00Z",
          },
        ],
      ],
    });
    const state = await getSmsChannelState();
    expect(state.connected).toBe(true);
    expect(JSON.stringify(state)).not.toMatch(/authToken|auth_token/i);
  });

  it("reports not connected when there is no row", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect((await getSmsChannelState()).connected).toBe(false);
  });

  // ⚠ KNOWN GAP, pinned rather than papered over. access.ts's rule is that a DB
  // error must never become a state decision (getViewerContext returns
  // `dbError` so the layout shows an outage, not "no access"). This read cannot
  // do that yet — SmsChannelState has no third state — so an unreachable
  // database currently reads as "not connected", which invites the merchant to
  // re-enter a DLT registration that is already stored.
  it("survives a read failure without throwing into the page", async () => {
    // The mock has no selectFails option, so the throw is injected directly.
    dbHolder.current = {
      db: {
        select: () => {
          throw new Error("connection reset");
        },
      },
      calls: { values: [], set: [] },
    };
    // What this pins is only that the page still renders. The `connected: false`
    // below is today's behaviour, NOT the desired one — see the note above.
    await expect(getSmsChannelState()).resolves.toMatchObject({
      connected: false,
    });
  });
});

describe("setSmsEnabled / disconnectSms", () => {
  // Pausing must not discard a DLT registration the merchant cannot retype.
  it("pausing updates the flag rather than deleting the row", async () => {
    await setSmsEnabled(false);
    expect(dbHolder.current.calls.set[0]).toMatchObject({ enabled: false });
    expect(dbHolder.current.calls.deleted ?? 0).toBeFalsy();
  });

  it("disconnecting removes the connection", async () => {
    const r = await disconnectSms();
    expect(r.success).toBe(true);
  });
});
