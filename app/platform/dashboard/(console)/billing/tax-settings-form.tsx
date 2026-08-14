"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Lock } from "lucide-react";
import { saveTaxSettings } from "@/app/actions/platform";
// The state list comes from the pure GST module — `lib/billing/platform-settings.ts`
// is `server-only`, so importing a runtime value from it here fails the build.
import { GST_STATES } from "@/lib/billing/gst";
import type { PlatformTaxSettings } from "@/lib/billing/invoice-types";

// ---------------------------------------------------------------------------
// StoreMink's OWN tax identity (§34) — what a GST tax invoice says.
//
// ★★ THE TWO THINGS THIS SCREEN MUST MAKE UNMISSABLE, because both are
// counter-intuitive and both are irreversible once an invoice is finalized:
//
//   1. Turning tax ON is NOT retroactive. Finalized invoices are immutable by
//      trigger, so an April invoice cannot sprout GST in September. The
//      intuition — "I've added my GSTIN, now everything is a tax invoice" — is
//      the opposite of what happens.
//   2. INCLUSIVE vs EXCLUSIVE changes what merchants PAY, not just how it is
//      printed. Exclusive adds 18% on top of every price; inclusive carves it
//      out of the price they already see. Picking the one that disagrees with
//      the public pricing page either overcharges every merchant or quietly
//      cuts revenue by ~15%.
//
// Every rule here is re-checked server-side (and the GSTIN one by a database
// CHECK); these exist to answer before a round trip, not instead of one.
// ---------------------------------------------------------------------------

export function TaxSettingsForm({
  initial,
  canEdit,
}: {
  initial: PlatformTaxSettings;
  canEdit: boolean;
}) {
  const [pending, start] = useTransition();
  const [legalName, setLegalName] = useState(initial.legalName ?? "");
  const [gstin, setGstin] = useState(initial.gstin ?? "");
  const [line1, setLine1] = useState(initial.address.line1 ?? "");
  const [line2, setLine2] = useState(initial.address.line2 ?? "");
  const [city, setCity] = useState(initial.address.city ?? "");
  const [postalCode, setPostalCode] = useState(
    initial.address.postalCode ?? "",
  );
  const [stateCode, setStateCode] = useState(initial.stateCode ?? "");
  const [taxEnabled, setTaxEnabled] = useState(initial.taxEnabled);
  const [taxRatePercent, setTaxRatePercent] = useState(
    String(initial.taxRateBps / 100),
  );
  const [taxInclusive, setTaxInclusive] = useState(initial.taxInclusive);
  const [invoicePrefix, setInvoicePrefix] = useState(initial.invoicePrefix);

  // Mirrors the DB CHECK, so the switch explains itself rather than failing.
  const missingForTax = !gstin.trim()
    ? "a GSTIN"
    : !stateCode
      ? "a state"
      : !legalName.trim()
        ? "a legal name"
        : null;

  function save() {
    start(async () => {
      const res = await saveTaxSettings({
        legalName,
        gstin,
        addressLine1: line1,
        addressLine2: line2,
        city,
        postalCode,
        stateCode,
        taxEnabled,
        taxRatePercent: Number(taxRatePercent),
        taxInclusive,
        invoicePrefix,
      });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Tax settings saved.");
    });
  }

  return (
    <div className="dash-card max-w-3xl p-6">
      {/* ── Status, first: is tax being charged right now, or not? ── */}
      <div
        className={`mb-6 rounded-lg border px-4 py-3 text-sm ${
          initial.taxEnabled
            ? "border-green-200 bg-green-50 text-green-900"
            : "border-[#e5e5e5] bg-[#f9fafb] text-[#5b6472]"
        }`}
      >
        {initial.taxEnabled ? (
          <>
            <strong>GST is being charged</strong> at {initial.taxRateBps / 100}
            %, {initial.taxInclusive ? "included in" : "added to"} every plan
            price.
          </>
        ) : (
          <>
            <strong>No tax is being charged.</strong> Invoices render without a
            GST block, which is correct while StoreMink has no GSTIN.
          </>
        )}
      </div>

      <Field
        label="Registered legal name"
        hint="The entity issuing the invoice."
      >
        <input
          className="dash-input w-full"
          value={legalName}
          onChange={(e) => setLegalName(e.target.value)}
          disabled={!canEdit}
          placeholder="StoreMink Technologies Pvt Ltd"
        />
      </Field>

      <Field
        label="GSTIN"
        hint="15 characters. Its first two digits are the state, and they must match the state below."
      >
        <input
          className="dash-input w-full font-mono uppercase"
          value={gstin}
          onChange={(e) => setGstin(e.target.value.toUpperCase())}
          disabled={!canEdit}
          placeholder="07AABCS1429B1ZX"
          maxLength={15}
        />
      </Field>

      <Field
        label="State (place of supply origin)"
        hint="Decides CGST+SGST for merchants in the same state, IGST for everyone else."
      >
        <select
          className="dash-input w-full"
          value={stateCode}
          onChange={(e) => setStateCode(e.target.value)}
          disabled={!canEdit}
        >
          <option value="">Not set</option>
          {GST_STATES.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name} ({s.code})
            </option>
          ))}
        </select>
      </Field>

      <Field label="Registered address" hint="Printed on every invoice.">
        <div className="space-y-2">
          <input
            className="dash-input w-full"
            value={line1}
            onChange={(e) => setLine1(e.target.value)}
            disabled={!canEdit}
            placeholder="Address line 1"
          />
          <input
            className="dash-input w-full"
            value={line2}
            onChange={(e) => setLine2(e.target.value)}
            disabled={!canEdit}
            placeholder="Address line 2"
          />
          <div className="flex gap-2">
            <input
              className="dash-input w-full"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              disabled={!canEdit}
              placeholder="City"
            />
            <input
              className="dash-input w-40"
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value)}
              disabled={!canEdit}
              placeholder="PIN"
            />
          </div>
        </div>
      </Field>

      <hr className="my-6 border-[#e5e5e5]" />

      {/* ── Charging ───────────────────────────────────────────────────── */}
      <Field
        label="Charge GST on subscription invoices"
        hint={
          missingForTax
            ? `Add ${missingForTax} above before switching this on — an invoice charging GST without one isn't a valid tax invoice.`
            : "Applies from the next invoice issued. Existing invoices are immutable and never change."
        }
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={taxEnabled}
            onChange={(e) => setTaxEnabled(e.target.checked)}
            disabled={!canEdit || (!!missingForTax && !taxEnabled)}
          />
          <span>{taxEnabled ? "Charging GST" : "Not charging GST"}</span>
        </label>
      </Field>

      <Field label="GST rate" hint="18% for SaaS in India.">
        <div className="flex items-center gap-2">
          <input
            className="dash-input w-24"
            value={taxRatePercent}
            onChange={(e) => setTaxRatePercent(e.target.value)}
            disabled={!canEdit}
            inputMode="decimal"
          />
          <span className="text-sm text-[#5b6472]">%</span>
        </div>
      </Field>

      <Field
        label="Pricing mode"
        hint="This changes what merchants PAY, not just how the invoice reads."
      >
        <div className="space-y-2">
          <Radio
            checked={!taxInclusive}
            onChange={() => setTaxInclusive(false)}
            disabled={!canEdit}
            title="Exclusive — tax on top"
            body={`A ₹5,000 plan is billed ₹${Math.round(5000 * (1 + Number(taxRatePercent || 0) / 100)).toLocaleString("en-IN")}. Every merchant's bill goes up the day you switch tax on.`}
          />
          <Radio
            checked={taxInclusive}
            onChange={() => setTaxInclusive(true)}
            disabled={!canEdit}
            title="Inclusive — tax carved out"
            body={`A ₹5,000 plan is billed ₹5,000, of which ₹${Math.round((5000 * Number(taxRatePercent || 0)) / (100 + Number(taxRatePercent || 0))).toLocaleString("en-IN")} is GST. Nobody's bill changes; revenue per plan falls.`}
          />
        </div>
      </Field>

      {/* ⚠ The one mistake with no undo: whichever is picked has to match what
          the public pricing page says, or every merchant is over- or
          under-charged from the next invoice on. */}
      <p className="mb-6 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          This must match what the pricing page advertises. If the page says
          &ldquo;₹5,000/month&rdquo; and this is set to Exclusive, merchants are
          billed ₹5,900.
        </span>
      </p>

      <Field
        label="Invoice number prefix"
        hint="Appears in every document number, e.g. SM/2026-27/00001. Changing it does not renumber existing invoices."
      >
        <input
          className="dash-input w-32 font-mono uppercase"
          value={invoicePrefix}
          onChange={(e) => setInvoicePrefix(e.target.value.toUpperCase())}
          disabled={!canEdit}
          maxLength={8}
        />
      </Field>

      <div className="mt-6 flex items-center gap-3 border-t border-[#e5e5e5] pt-4">
        <button
          type="button"
          onClick={save}
          disabled={!canEdit || pending}
          className="inline-flex items-center gap-2 rounded-lg bg-[#111827] px-4 py-2 text-sm font-semibold text-white transition hover:bg-black disabled:opacity-50"
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          Save tax settings
        </button>
        {!canEdit && (
          <span className="inline-flex items-center gap-1.5 text-xs text-[#6b7280]">
            <Lock className="h-3.5 w-3.5" />
            Only a platform superadmin can change these.
          </span>
        )}
        {initial.updatedAt && (
          <span className="ml-auto text-xs text-[#9aa1ab]">
            Last changed{" "}
            {new Date(initial.updatedAt).toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "numeric",
              timeZone: "Asia/Kolkata",
            })}
            {initial.updatedBy ? ` by ${initial.updatedBy}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <label className="mb-1 block text-sm font-medium text-[#111827]">
        {label}
      </label>
      {hint && <p className="mb-2 text-xs text-[#6b7280]">{hint}</p>}
      {children}
    </div>
  );
}

function Radio({
  checked,
  onChange,
  disabled,
  title,
  body,
}: {
  checked: boolean;
  onChange: () => void;
  disabled: boolean;
  title: string;
  body: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
        checked ? "border-[#111827] bg-[#111827]/[0.02]" : "border-[#e5e5e5]"
      } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
    >
      <input
        type="radio"
        className="mt-1"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
      <span>
        <span className="block text-sm font-medium text-[#111827]">
          {title}
        </span>
        <span className="mt-0.5 block text-xs text-[#6b7280]">{body}</span>
      </span>
    </label>
  );
}
