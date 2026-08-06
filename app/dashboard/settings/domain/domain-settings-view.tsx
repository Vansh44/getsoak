"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Copy, CheckCircle2, AlertCircle, Globe, Lock } from "lucide-react";
import {
  updateCustomDomain,
  verifyDomain,
  disconnectDomain,
  getDomainConnectionState,
  type DomainConnectionState,
} from "@/app/actions/store-domain";

// Poll while the merchant is actually looking, bounded — each check costs API
// calls. This is a CONVENIENCE, not the mechanism: issuance regularly outlives
// any tab, so `/api/cron/domain-reconcile` is what finishes the job. Before that
// cron existed this poll WAS the only path, which is why a domain that issued
// after the merchant closed the page never went live (CODEBASE.md §30).
const POLL_MS = 30_000;
const MAX_POLLS = 20; // ~10 minutes of attentive waiting

export function DomainSettingsView({
  initial,
  rootDomain,
}: {
  initial: DomainConnectionState;
  rootDomain: string;
}) {
  const [state, setState] = useState(initial);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<"save" | "verify" | "disconnect" | null>(
    null,
  );
  const polls = useRef(0);

  const refresh = useCallback(async () => {
    const next = await getDomainConnectionState();
    setState(next);
    return next;
  }, []);

  const check = useCallback(
    async (announce: boolean) => {
      const res = await verifyDomain();
      const next = await refresh();
      // Silent while polling: the merchant hasn't asked, and "not ready yet"
      // every 30 seconds reads as a series of failures rather than progress.
      if (res.error) {
        if (announce) toast.error(res.error);
      } else if (next.verified) {
        toast.success("Your domain is live.");
      }
      return next;
    },
    [refresh],
  );

  // Issuance takes minutes, so poll rather than making the merchant sit and
  // click. Bounded and stopped on success: an unbounded poll on a tab left open
  // would bill API calls indefinitely for a domain nobody is waiting on.
  useEffect(() => {
    if (!state.domain || state.verified || !state.allowed) return;
    const id = setInterval(() => {
      if (polls.current >= MAX_POLLS || document.hidden) return;
      polls.current += 1;
      void check(false);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [state.domain, state.verified, state.allowed, check]);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setBusy("save");
    const res = await updateCustomDomain(input.trim() || null);
    if (res.error) toast.error(res.error);
    else {
      polls.current = 0;
      await check(false);
      toast.success("Domain added. Now add the DNS records below.");
    }
    setBusy(null);
  }

  async function handleDisconnect() {
    if (
      !window.confirm(
        `Disconnect ${state.domain}? Your store stays available at its ${rootDomain} address, and this domain will stop working within a few minutes.`,
      )
    ) {
      return;
    }
    setBusy("disconnect");
    const res = await disconnectDomain();
    if (res.error) toast.error(res.error);
    else {
      setInput("");
      await refresh();
      toast.success("Domain disconnected.");
    }
    setBusy(null);
  }

  // ---- Not configured in this environment ---------------------------------
  if (!state.available) {
    return (
      <Shell>
        <Card>
          <div className="flex items-start gap-4 p-6">
            <span className="mt-0.5 rounded-lg bg-[#f3f4f6] p-2">
              <Globe className="h-5 w-5 text-[#5b6472]" />
            </span>
            <div>
              <h2 className="text-lg font-semibold text-[#111827]">
                Custom domains aren&apos;t available here
              </h2>
              <p className="mt-1 text-sm text-[#5b6472]">
                This environment isn&apos;t set up for custom domains.
              </p>
            </div>
          </div>
        </Card>
      </Shell>
    );
  }

  // ---- Not on Pro ---------------------------------------------------------
  if (!state.allowed) {
    return (
      <Shell>
        <Card>
          <div className="flex items-start gap-4 p-6">
            <span className="mt-0.5 rounded-lg bg-[#f3f4f6] p-2">
              <Lock className="h-5 w-5 text-[#5b6472]" />
            </span>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-[#111827]">
                Use your own domain
              </h2>
              <p className="mt-1 max-w-xl text-sm text-[#5b6472]">
                Serve your store from a domain you own, with HTTPS set up for
                you. Part of the Pro plan.
              </p>
              {state.domain && (
                // Honest about the consequence. This isn't a dormant setting —
                // the domain has stopped serving, and saying so is kinder than
                // letting them discover it from a customer.
                <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <strong>{state.domain}</strong> is no longer serving your
                  store because your plan changed. Upgrade to Pro to bring it
                  back.
                </p>
              )}
              <Link
                href="/dashboard/plans"
                className="dash-btn dash-btn-primary mt-4 inline-flex"
              >
                See Pro
              </Link>
            </div>
          </div>
        </Card>
      </Shell>
    );
  }

  // ---- Live ---------------------------------------------------------------
  if (state.verified && state.domain) {
    // The store is up on the domain they asked for, but the www/apex companion
    // validates separately and may still be outstanding. Showing "Live and
    // secured with HTTPS" and nothing else is how "www gives a security warning"
    // becomes a support ticket for a fix that was one DNS record away.
    const pending = state.records.filter((r) => r.purpose === "certificate");
    return (
      <Shell>
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4 p-6">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              <div>
                <p className="text-lg font-semibold text-[#111827]">
                  {state.domain}
                </p>
                <p className="text-sm text-[#5b6472]">
                  Live and secured with HTTPS
                  {state.extraHosts.length > 0
                    ? `, along with ${state.extraHosts.join(" and ")}.`
                    : "."}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={busy === "disconnect"}
              className="dash-btn text-red-600 hover:bg-red-50 disabled:opacity-60"
            >
              {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        </Card>

        {pending.length > 0 && (
          <Card>
            <div className="border-b border-[rgba(17,24,39,0.08)] p-6">
              <h2 className="text-base font-semibold text-[#111827]">
                Finish covering {pending.map((r) => hostOf(r.fqdn)).join(", ")}
              </h2>
              <p className="mt-1 text-sm text-[#5b6472]">
                Your store is live. Add the record below and visitors who type
                the other form of your address get HTTPS too — until then their
                browser shows a security warning.
              </p>
            </div>
            <div className="divide-y divide-[rgba(17,24,39,0.08)]">
              {pending.map((r) => (
                <RecordRow key={`${r.type}-${r.name}`} record={r} />
              ))}
            </div>
          </Card>
        )}
      </Shell>
    );
  }

  // ---- Pending: the records to add ----------------------------------------
  if (state.domain) {
    return (
      <Shell>
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4 p-6">
            <div className="flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-amber-500" />
              <div>
                <p className="text-lg font-semibold text-[#111827]">
                  {state.domain}
                </p>
                <p className="text-sm text-[#5b6472]">
                  {/* Say they can leave. The certificate routinely takes longer
                      than anyone waits on a settings page, and the hourly sweep
                      now finishes it — a merchant who believes they must watch
                      will sit here and then assume it failed. Deliberately does
                      NOT promise an email: platform.domain_verified is
                      operators-only/in-app, so there is nothing to send yet. */}
                  Waiting on DNS and your certificate. You can safely close this
                  page — setup finishes on its own, usually within an hour of
                  your records going live.
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setBusy("verify");
                  void check(true).finally(() => setBusy(null));
                }}
                disabled={busy === "verify"}
                className="dash-btn dash-btn-primary"
              >
                {busy === "verify" ? "Checking…" : "Check now"}
              </button>
              <button
                type="button"
                onClick={handleDisconnect}
                disabled={busy === "disconnect"}
                className="dash-btn text-red-600 hover:bg-red-50"
              >
                Remove
              </button>
            </div>
          </div>
        </Card>

        <Card>
          <div className="border-b border-[rgba(17,24,39,0.08)] p-6">
            <h2 className="text-lg font-semibold text-[#111827]">
              Add these DNS records
            </h2>
            <p className="mt-1 text-sm text-[#5b6472]">
              Add them wherever you bought your domain. We check automatically.
            </p>
            <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Enter each Name exactly as shown. GoDaddy and most DNS providers
              add <strong>{state.domain}</strong>  automatically—don&apos;t type
              the domain again.
            </p>
          </div>
          <div className="divide-y divide-[rgba(17,24,39,0.08)]">
            {state.records.map((r) => (
              <RecordRow key={`${r.type}-${r.name}`} record={r} />
            ))}
            {state.records.length === 0 && (
              <p className="p-6 text-sm text-[#5b6472]">
                Preparing your records — check back in a moment.
              </p>
            )}
          </div>
        </Card>
      </Shell>
    );
  }

  // ---- Nothing connected yet ----------------------------------------------
  return (
    <Shell>
      <Card>
        <form onSubmit={handleConnect} className="p-6">
          <h2 className="text-lg font-semibold text-[#111827]">
            Connect your domain
          </h2>
          <p className="mt-1 max-w-xl text-sm text-[#5b6472]">
            Enter a domain you already own. We&apos;ll set up HTTPS for you.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="yourstore.com"
              className="dash-input max-w-md"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="submit"
              disabled={busy === "save" || !input.trim()}
              className="dash-btn dash-btn-primary"
            >
              {busy === "save" ? "Adding…" : "Connect"}
            </button>
          </div>
        </form>
      </Card>
    </Shell>
  );
}

/** `_acme-challenge.www.acme.com` → `www.acme.com`: the host the record is FOR,
 *  which is what the merchant recognises. The raw challenge name means nothing
 *  to them and reads like a typo. */
function hostOf(challengeFqdn: string): string {
  return challengeFqdn.replace(/^_acme-challenge\./, "");
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#111827]">Domain</h1>
        <p className="mt-1 text-sm text-[#5b6472]">
          Serve your store from a domain you own.
        </p>
      </div>
      {children}
    </div>
  );
}

function RecordRow({
  record,
}: {
  record: {
    type: string;
    name: string;
    fqdn: string;
    value: string;
    purpose: string;
  };
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 p-6">
      <span className="w-16 shrink-0 rounded-md bg-[#f3f4f6] px-2 py-1 text-center text-xs font-semibold text-[#111827]">
        {record.type}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs uppercase tracking-wide text-[#5b6472]">Name</p>
        <CopyLine text={record.name} />
        <p className="mt-1 truncate text-xs text-[#6b7280]" title={record.fqdn}>
          Creates {record.fqdn}
        </p>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs uppercase tracking-wide text-[#5b6472]">Value</p>
        <CopyLine text={record.value} />
      </div>
    </div>
  );
}

function CopyLine({ text }: { text: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        toast.success("Copied");
      }}
      className="group flex w-full min-w-0 items-center gap-2 text-left"
      title="Copy"
    >
      <code className="truncate font-mono text-sm text-[#111827]">{text}</code>
      <Copy className="h-3.5 w-3.5 shrink-0 text-[#5b6472] opacity-0 transition group-hover:opacity-100" />
    </button>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[rgba(17,24,39,0.08)] bg-white shadow-sm">
      {children}
    </div>
  );
}
