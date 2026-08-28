"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Loader2,
  Monitor,
  Trash2,
  Copy,
  Check,
  ShieldAlert,
} from "lucide-react";
import {
  createPairingCode,
  revokeDevice,
  type PosDeviceRow,
  type PosActivityRow,
} from "@/app/actions/pos-auth-actions";

interface LocationOpt {
  id: string;
  name: string;
}

// How each audit event reads to a shop owner, and whether it needs attention.
const EVENT_META: Record<
  string,
  { label: string; tone: "info" | "warn" | "danger" }
> = {
  device_authorized: { label: "Device authorized", tone: "info" },
  device_revoked: { label: "Device revoked", tone: "info" },
  device_clone_detected: {
    label: "Device revoked automatically — copied credential detected",
    tone: "danger",
  },
  operator_login: { label: "Staff signed in", tone: "info" },
  operator_login_failed: { label: "Failed sign-in", tone: "warn" },
  credential_reset: { label: "Credential reset", tone: "info" },
  // `warn`, not `info`: it is ordinary enough on legacy orders to be expected,
  // and serious enough that a run of them is worth a second look.
  identity_override: {
    label: "Handed over without customer verification — no mobile on the order",
    tone: "warn",
  },
};

const REVOKED_REASON: Record<string, string> = {
  clone_detected: "Revoked automatically — a copied credential was detected",
  revoked_by_admin: "Revoked from the dashboard",
  // Without this the row falls through to a bare "Revoked", which for a device
  // the owner deliberately swapped out reads like something went wrong.
  replaced: "Replaced by another device at this location",
};

const TONE_CLS: Record<string, string> = {
  info: "bg-[#111827]/5 text-[#5b6472]",
  warn: "bg-amber-500/10 text-amber-700",
  danger: "bg-red-500/10 text-red-700",
};

const INPUT_CLS =
  "rounded-lg border border-[rgba(17,24,39,0.12)] bg-white px-3 py-2 text-sm text-[#111827] outline-none transition-colors focus:border-[#111827]";

/**
 * How many revoked devices and audit rows this page shows.
 *
 * ★ THIS PAGE IS FOR ACTING, NOT FOR AUDITING. What needs attention is at the
 * top — the devices that work, and any that were revoked automatically. Below
 * them sat an unbounded revoked list and 30 rows of routine sign-ins, so the
 * two things worth reading were pushed off the screen by the thing that wasn't.
 * Five is enough to answer "what just happened?"; anything older is history,
 * and history has its own place (activity logs).
 *
 * Exported so app/dashboard/pos/devices/page.tsx fetches exactly one more than
 * this — enough to know whether to say "there are more", never a second number
 * to keep in step.
 */
export const RECENT_LIMIT = 5;

export function DevicesClient({
  initialDevices,
  events,
  locations,
  canManage,
}: {
  initialDevices: PosDeviceRow[];
  events: PosActivityRow[];
  locations: LocationOpt[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const locName = (id: string) =>
    locations.find((l) => l.id === id)?.name ?? "";
  const active = initialDevices.filter((d) => !d.revoked);
  // Newest first, then capped. Unsorted, "the first 5" would be whatever order
  // the query happened to return — and the one you need is the most recent.
  const allRevoked = initialDevices
    .filter((d) => d.revoked)
    .sort((a, b) => (b.revokedAt ?? "").localeCompare(a.revokedAt ?? ""));
  const revoked = allRevoked.slice(0, RECENT_LIMIT);
  const recentEvents = events.slice(0, RECENT_LIMIT);
  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString() : "";

  const generate = () =>
    start(async () => {
      const res = await createPairingCode(locationId);
      if (res.error || !res.code) {
        toast.error(res.error ?? "Failed.");
        return;
      }
      setCode(res.code);
      setCopied(false);
    });

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the code is visible to type */
    }
  };

  const revoke = (d: PosDeviceRow) => {
    if (!confirm("Revoke this device? It will be signed out of the register."))
      return;
    start(async () => {
      const res = await revokeDevice(d.id);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Device revoked");
      router.refresh();
    });
  };

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header">
        <h1>POS Devices</h1>
        <p>
          Staff can only sign into the register on a device you&apos;ve
          authorized — their personal phones won&apos;t work. The easiest way is
          to open /pos on the shop&apos;s device while signed in as the owner
          and tap &ldquo;Authorize this device&rdquo;; use a code below to set
          one up remotely.
        </p>
      </header>

      <div className="mt-5 max-w-3xl space-y-6">
        {/* Pair a device */}
        {canManage && (
          <div className="rounded-2xl border border-[#e5e5e5] bg-white p-5">
            <h2 className="text-sm font-semibold text-[#111827]">
              Authorize a device remotely
            </h2>
            <p className="mt-1 text-xs text-[#5b6472]">
              Generate a code, then open{" "}
              <code className="rounded bg-[#f2f3f5] px-1 py-0.5">/pos</code> on
              the shop&apos;s device and enter it. Codes expire in 10 minutes.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                className={INPUT_CLS}
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={generate}
                disabled={pending || !locationId}
                className="inline-flex items-center gap-2 rounded-lg bg-[#111827] px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                Generate authorization code
              </button>
            </div>

            {code && (
              <div className="mt-4 flex items-center gap-3 rounded-xl border border-[#111827]/10 bg-[#f8f9fb] p-4">
                <span className="font-mono text-2xl font-bold tracking-[0.35em] text-[#111827]">
                  {code}
                </span>
                <button
                  type="button"
                  onClick={copy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[rgba(17,24,39,0.15)] px-2.5 py-1.5 text-xs font-medium text-[#5b6472] hover:bg-white"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </button>
                <span className="text-xs text-[#9aa1ab]">
                  for {locName(locationId)}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Paired devices */}
        <div>
          <h2 className="mb-2 text-sm font-semibold text-[#111827]">
            Authorized devices
          </h2>
          {active.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[#e5e5e5] bg-white p-6 text-center text-sm text-[#9aa1ab]">
              No devices authorized yet.
            </p>
          ) : (
            <div className="space-y-3">
              {active.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between rounded-xl border border-[#e5e5e5] bg-white p-4"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#111827]/5 text-[#111827]">
                      <Monitor className="h-5 w-5" strokeWidth={1.75} />
                    </div>
                    <div>
                      <div className="font-semibold text-[#111827]">
                        {d.label || "Register"}
                      </div>
                      <div className="text-xs text-[#5b6472]">
                        {locName(d.locationId)}
                        {d.lastSeenAt
                          ? ` · last used ${new Date(d.lastSeenAt).toLocaleDateString()}`
                          : ""}
                      </div>
                    </div>
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => revoke(d)}
                      className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-[#b42318] transition-colors hover:bg-[#fef3f2]"
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
                      Revoke
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Revoked devices — so "why did the register stop working?" has an
            answer. A clone-detected auto-revoke would otherwise be invisible. */}
        {revoked.length > 0 && (
          <div>
            <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-[#111827]">
              Revoked devices
              {allRevoked.length > revoked.length && (
                <span className="text-xs font-normal text-[#9aa1ab]">
                  {revoked.length} most recent of {allRevoked.length}
                </span>
              )}
            </h2>
            <div className="space-y-3">
              {revoked.map((d) => {
                const danger = d.revokedReason === "clone_detected";
                return (
                  <div
                    key={d.id}
                    className={`flex items-start gap-3 rounded-xl border bg-white p-4 ${
                      danger
                        ? "border-red-200 bg-[#fffbfb]"
                        : "border-[#e5e5e5]"
                    }`}
                  >
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                        danger
                          ? "bg-red-500/10 text-red-600"
                          : "bg-[#111827]/5 text-[#9aa1ab]"
                      }`}
                    >
                      {danger ? (
                        <ShieldAlert className="h-5 w-5" strokeWidth={1.75} />
                      ) : (
                        <Monitor className="h-5 w-5" strokeWidth={1.75} />
                      )}
                    </div>
                    <div>
                      <div className="font-semibold text-[#111827]">
                        {d.label || "Register"} · {locName(d.locationId)}
                      </div>
                      <div className="mt-0.5 text-xs text-[#5b6472]">
                        {REVOKED_REASON[d.revokedReason ?? ""] ?? "Revoked"}
                        {d.revokedAt ? ` · ${when(d.revokedAt)}` : ""}
                      </div>
                      {danger && (
                        <p className="mt-1.5 text-xs text-red-700">
                          If this was your own device, authorize it again. If
                          not, someone copied a register credential — change
                          affected staff PINs.
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Security activity */}
        <div>
          <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-[#111827]">
            Recent activity
            {events.length > recentEvents.length && (
              <span className="text-xs font-normal text-[#9aa1ab]">
                last {recentEvents.length}
              </span>
            )}
          </h2>
          {recentEvents.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[#e5e5e5] bg-white p-6 text-center text-sm text-[#9aa1ab]">
              Nothing yet. Device authorizations and staff sign-ins appear here.
            </p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-[#e5e5e5] bg-white">
              {recentEvents.map((e, i) => {
                const meta = EVENT_META[e.event] ?? {
                  label: e.event,
                  tone: "info" as const,
                };
                return (
                  <div
                    key={e.id}
                    className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm ${
                      i > 0 ? "border-t border-[#f0f1f3]" : ""
                    }`}
                  >
                    <span
                      className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${TONE_CLS[meta.tone]}`}
                    >
                      {meta.label}
                    </span>
                    {e.actor && (
                      <span className="text-[#111827]">{e.actor}</span>
                    )}
                    {e.locationId && (
                      <span className="text-xs text-[#5b6472]">
                        {locName(e.locationId)}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-[#9aa1ab]">
                      {e.ip ? `${e.ip} · ` : ""}
                      {when(e.createdAt)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
