import { describe, it, expect, beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// REAL Certificate Manager calls. Skipped unless RUN_DOMAIN_INTEGRATION=1, so
// CI never touches GCP — this is a tool for exercising the provisioning path
// by hand, not a unit test.
//
// It creates and then deletes real resources under the sm-domain-stg- prefix.
// It deliberately CANNOT reach ACTIVE: that needs the challenge CNAME published
// in the test domain's DNS, which is the one step a script can't do for itself.
// Everything up to that point is real — auth, naming, idempotency, the
// certificate request, the gate that refuses to attach a non-ACTIVE cert, and
// cleanup.
//
//   RUN_DOMAIN_INTEGRATION=1 npx vitest run lib/domains/certificates.integration
// ---------------------------------------------------------------------------

const RUN = process.env.RUN_DOMAIN_INTEGRATION === "1";
const d = RUN ? describe : describe.skip;

// A domain under one the owner controls. Nothing is served here; the resources
// are torn down at the end.
//
// ⚠ REQUIRES APPLICATION DEFAULT CREDENTIALS, not just `gcloud auth login`.
// GoogleAuth reads ADC, which is a separate credential file:
//   gcloud auth application-default login
// Without it every call fails `invalid_grant / invalid_rapt`, which looks like a
// provisioning bug and is not one.
const TEST_DOMAIN = process.env.DOMAIN_TEST_HOST ?? "cert-test.wholesip.com";

// ★ A SUBDOMAIN HAS NO www COMPANION, so TEST_DOMAIN alone cannot exercise the
// apex→www path at all — it would pass while that code was completely broken.
// Opt-in with NO default, deliberately: pointing this at a live apex creates a
// second certificate for it, and Certificate Manager rate-limits per top-level
// private domain, so a careless default could throttle issuance for a REAL
// merchant domain mid-setup.
//   DOMAIN_TEST_APEX=example.com
const TEST_APEX = process.env.DOMAIN_TEST_APEX ?? "";

d("Certificate Manager provisioning (live)", () => {
  let mod: typeof import("./certificates");
  let naming: typeof import("./naming");

  beforeAll(async () => {
    process.env.DOMAIN_ENV = "stg";
    process.env.DOMAIN_GCP_PROJECT_ID ??= "storemink-prod";
    process.env.DOMAIN_CERT_MAP ??= "prod-cert-map";
    process.env.DOMAIN_LB_IP ??= "136.69.75.127";
    mod = await import("./certificates");
    naming = await import("./naming");
  });

  it("reads its configuration", () => {
    const cfg = mod.getCertConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.certificateMap).toBeTruthy();
  });

  it("creates a DNS authorization and returns a challenge record", async () => {
    const res = await mod.ensureDnsAuthorization(TEST_DOMAIN);
    expect(res.error).toBeUndefined();
    expect(res.challenge?.name).toContain("_acme-challenge");
    expect(res.challenge?.value).toBeTruthy();
    console.log("\n  challenge CNAME:", res.challenge?.name);
    console.log("  →", res.challenge?.value, "\n");
  }, 60_000);

  it("is idempotent — a second run adopts, it does not duplicate", async () => {
    // The property the whole design rests on. A retried background job must
    // converge, not mint a second billable certificate.
    const first = await mod.ensureDnsAuthorization(TEST_DOMAIN);
    const second = await mod.ensureDnsAuthorization(TEST_DOMAIN);
    expect(second.error).toBeUndefined();
    expect(second.challenge).toEqual(first.challenge);
  }, 60_000);

  it("requests a certificate but refuses to attach it before ACTIVE", async () => {
    const state = await mod.ensureProvisioned(TEST_DOMAIN);
    // No CNAME is published, so issuance cannot complete. The point of the
    // assertion is that we stop cleanly and keep showing the record to add,
    // rather than attaching a hostname the load balancer can't serve.
    expect(state.ready).toBe(false);
    expect(state.attached).toBe(false);
    expect(state.challenge?.name).toContain("_acme-challenge");
    console.log("  certificate state:", state.certificateState);
  }, 90_000);

  it("invents no www companion for a subdomain", async () => {
    // shop.acme.com has no second form worth guessing at, and a certificate for
    // www.shop.acme.com would be a billable resource nobody asked for.
    const state = await mod.ensureProvisioned(TEST_DOMAIN);
    expect(state.hosts).toHaveLength(1);
    expect(state.hosts[0]!.host).toBe(TEST_DOMAIN);
  }, 90_000);

  it("running provisioning twice still creates nothing extra", async () => {
    const a = await mod.ensureProvisioned(TEST_DOMAIN);
    const b = await mod.ensureProvisioned(TEST_DOMAIN);
    expect(b.ready).toBe(a.ready);
    expect(b.challenge).toEqual(a.challenge);
  }, 90_000);

  it("refuses to delete the platform's own certificate map entries", () => {
    // The guard that stands between certificatemanager.editor and taking TLS
    // down for storemink.com and every store subdomain.
    expect(() => naming.assertManaged("prod-wildcard")).toThrow();
    expect(() => naming.assertManaged("prod-apex")).toThrow();
  });

  it("cleans up everything it created", async () => {
    const res = await mod.deprovision(TEST_DOMAIN);
    expect(res.error).toBeUndefined();
    // Deprovision is order-tolerant: running it again on already-deleted
    // resources must succeed, so a half-finished cleanup can be completed.
    const again = await mod.deprovision(TEST_DOMAIN);
    expect(again.error).toBeUndefined();
  }, 90_000);
});

// ---------------------------------------------------------------------------
// The apex→www path. Separate block because it needs an apex domain nobody is
// depending on; see TEST_APEX above for why there is no default.
// ---------------------------------------------------------------------------
const apex = RUN && TEST_APEX ? describe : describe.skip;

apex("apex domains also cover www (live)", () => {
  let mod: typeof import("./certificates");

  beforeAll(async () => {
    process.env.DOMAIN_ENV = "stg";
    process.env.DOMAIN_GCP_PROJECT_ID ??= "storemink-prod";
    process.env.DOMAIN_CERT_MAP ??= "prod-cert-map";
    process.env.DOMAIN_LB_IP ??= "136.69.75.127";
    mod = await import("./certificates");
  });

  it("provisions a full triple for BOTH the apex and its www form", async () => {
    const state = await mod.ensureProvisioned(TEST_APEX);

    expect(state.hosts).toHaveLength(2);
    // Primary first — the top-level fields mirror it, and it is what gates going
    // live. If this order ever flips, www failing would block the whole store.
    expect(state.hosts[0]!.host).toBe(TEST_APEX);
    expect(state.hosts[1]!.host).toBe(`www.${TEST_APEX}`);
    expect(state.host).toBe(TEST_APEX);

    // Each host gets its OWN challenge CNAME — a shared one would mean the
    // merchant is shown half of what they have to add.
    const names = state.hosts.map((h) => h.challenge?.name);
    expect(names[0]).toBe(`_acme-challenge.${TEST_APEX}`);
    expect(names[1]).toBe(`_acme-challenge.www.${TEST_APEX}`);
    expect(state.hosts[0]!.challenge?.value).not.toBe(
      state.hosts[1]!.challenge?.value,
    );

    for (const h of state.hosts) {
      console.log(`  ${h.host}: ${h.challenge?.name} → ${h.challenge?.value}`);
    }
  }, 120_000);

  it("cleans up BOTH hosts — an orphaned certificate keeps billing", async () => {
    const res = await mod.deprovision(TEST_APEX);
    expect(res.error).toBeUndefined();
    const again = await mod.deprovision(TEST_APEX);
    expect(again.error).toBeUndefined();
  }, 120_000);
});
