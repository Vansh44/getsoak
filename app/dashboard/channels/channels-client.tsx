"use client";

import { useMemo, useState, useTransition } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CreditCard,
  ShieldCheck,
  Lock,
  Unplug,
  X,
  Search,
  Truck,
  MessageSquare,
  Copy,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import {
  disconnectRazorpay,
  generateWebhookSecret,
  saveRazorpayCredentials,
  setRazorpayEnabled,
  type ChannelState,
} from "@/app/actions/payment-provider-actions";
import {
  disconnectSms,
  saveSmsCredentials,
  setSmsEnabled,
  type SmsChannelState,
} from "@/app/actions/sms-provider-actions";
import {
  disconnectShiprocket,
  rotateShiprocketWebhookSecret,
  saveShiprocketCredentials,
  setShiprocketEnabled,
  syncShiprocketPickupLocations,
  type ShiprocketChannelState,
} from "@/app/actions/logistics-provider-actions";

// ---------------------------------------------------------------------------
// Channel catalog — data-driven so new channels (logistics, SMS, marketplace…)
// are a one-line addition here later.
// ---------------------------------------------------------------------------

type Category =
  | "payment"
  | "inventory"
  | "logistics"
  | "sms"
  | "email"
  | "ecommerce"
  | "marketplace";

interface ChannelDef {
  id: string;
  name: string;
  category: Category;
  tagline: string;
  /** Brand accent for the icon tile (fallback when no logo). */
  accent: string;
  icon: LucideIcon;
  /** Optional brand logo (public/ path). Drop the official SVG/PNG in
   *  public/channels/ to replace the fallback icon tile. */
  logo?: string;
  /** Natural aspect ratio of the logo (width / height) so wordmark logos
   *  render wide instead of squished into a square. Defaults to 1. */
  logoAspect?: number;
}

const SHIPROCKET_CHANNEL: ChannelDef = {
  id: "shiprocket",
  name: "Shiprocket",
  category: "logistics",
  tagline: "Courier booking, labels, tracking & NDR",
  accent: "#7357e8",
  icon: Truck,
  logo: "/channels/shiprocket.svg",
  logoAspect: 854.34 / 189.9,
};

const TWILIO_CHANNEL: ChannelDef = {
  id: "twilio",
  name: "Twilio SMS",
  category: "sms",
  tagline: "Order updates by SMS, on your own DLT registration",
  accent: "#f22f46",
  // Fallback only — the wordmark below wins whenever it loads.
  icon: MessageSquare,
  logo: "/channels/twilio.svg",
  // Measured from the artwork's own bounding box (99.7 × 30), not eyeballed.
  // ⚠ The file shipped with viewBox="-14.955 -7.5 129.61 45" — ~23% horizontal
  // and 33% vertical padding baked in — which at height 24 would have drawn a
  // 16px mark next to Shiprocket's 24px one. The viewBox is trimmed to the
  // artwork so the two carry the same optical weight; nothing about the paths
  // changed.
  logoAspect: 99.7 / 30,
};

const CHANNELS: ChannelDef[] = [
  {
    id: "razorpay",
    name: "Razorpay",
    category: "payment",
    tagline: "Accept UPI, cards & netbanking at checkout",
    accent: "#0b6cff",
    icon: CreditCard,
    logo: "/channels/razorpay.webp",
    logoAspect: 132 / 38, // Razorpay wordmark
  },
  SHIPROCKET_CHANNEL,
  TWILIO_CHANNEL,
];

// Brand logo when the channel ships one, else a tinted icon tile. `height`
// drives the size; the logo keeps its natural aspect (wordmarks render wide).
//
// ★★ AN SVG MUST SKIP THE OPTIMIZER, OR IT IS A BROKEN IMAGE. `next/image`
// answers 400 — "image type is not allowed" — for any SVG unless
// `dangerouslyAllowSVG` is set, and there is no automatic fallback: the <img>
// still points at /_next/image and simply fails to load. That is why the
// Shiprocket logo was rendering broken here before this line existed.
//
// ★ `unoptimized` PER-IMAGE, NOT `dangerouslyAllowSVG` GLOBALLY. That flag
// would apply to every SVG next/image touches, including remote ones matched by
// `remotePatterns` — and merchant-uploaded media lives in a public GCS bucket
// (§7). An SVG can carry script, so allowing the optimizer to serve
// merchant-supplied ones same-origin is an XSS vector. These logos are
// first-party files in public/, so scoping the exemption to them costs nothing.
//
// Nothing is lost by skipping it: the optimizer RASTERISES (the .webp control
// comes back as image/jpeg), which for a vector logo is strictly worse than the
// 6 KB original.
function ChannelLogo({ def, height }: { def: ChannelDef; height: number }) {
  if (def.logo) {
    const width = Math.round(height * (def.logoAspect ?? 1));
    return (
      <Image
        src={def.logo}
        alt={`${def.name} logo`}
        width={width}
        height={height}
        unoptimized={def.logo.endsWith(".svg")}
        className="object-contain"
        style={{ maxWidth: "80%", height: "auto" }}
      />
    );
  }
  const Icon = def.icon;
  return (
    <span
      className="flex items-center justify-center rounded-2xl"
      style={{ width: height, height, background: `${def.accent}1a` }}
    >
      <Icon
        style={{ width: height * 0.5, height: height * 0.5, color: def.accent }}
      />
    </span>
  );
}

const CATEGORY_LABEL: Record<Category, string> = {
  payment: "Payment",
  inventory: "Inventory",
  logistics: "Logistics",
  sms: "SMS",
  email: "Email",
  ecommerce: "Ecommerce",
  marketplace: "Marketplace",
};

const CATEGORY_BADGE: Record<Category, string> = {
  payment: "bg-emerald-50 text-emerald-700",
  inventory: "bg-sky-50 text-sky-700",
  logistics: "bg-amber-50 text-amber-700",
  sms: "bg-pink-50 text-pink-700",
  email: "bg-violet-50 text-violet-700",
  ecommerce: "bg-blue-50 text-blue-700",
  marketplace: "bg-orange-50 text-orange-700",
};

// Small iOS-style toggle used on active channel cards.
function Toggle({
  on,
  onClick,
  disabled,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-emerald-500" : "bg-gray-300"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          on ? "translate-x-[22px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function ChannelsClient({
  initialState,
  initialShiprocketState,
  initialSmsState,
  canManage,
}: {
  initialState: ChannelState;
  initialShiprocketState: ShiprocketChannelState;
  initialSmsState: SmsChannelState;
  canManage: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [state, setState] = useState(initialState);
  const [shiprocketState, setShiprocketState] = useState(
    initialShiprocketState,
  );
  const [smsState, setSmsState] = useState(initialSmsState);
  const [tab, setTab] = useState<"all" | Category>("all");
  const [query, setQuery] = useState("");
  // Which channel's connect/manage modal is open.
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = () => startTransition(() => router.refresh());

  const isConnected = (id: string) =>
    id === "razorpay"
      ? state.connected
      : id === "shiprocket"
        ? shiprocketState.connected
        : id === "twilio"
          ? smsState.connected
          : false;
  const isEnabled = (id: string) =>
    id === "razorpay"
      ? state.enabled
      : id === "shiprocket"
        ? shiprocketState.enabled && shiprocketState.availableOnPlan
        : id === "twilio"
          ? smsState.enabled
          : false;

  const categories = useMemo(() => {
    const present = new Set(CHANNELS.map((c) => c.category));
    return (Object.keys(CATEGORY_LABEL) as Category[]).filter((c) =>
      present.has(c),
    );
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CHANNELS.filter(
      (c) =>
        (tab === "all" || c.category === tab) &&
        (!q || c.name.toLowerCase().includes(q)),
    );
  }, [tab, query]);

  const active = visible.filter((c) => isConnected(c.id));
  const available = visible.filter((c) => !isConnected(c.id));

  async function handleToggle(id: string) {
    const next = !isEnabled(id);
    const res =
      id === "shiprocket"
        ? await setShiprocketEnabled(next)
        : await setRazorpayEnabled(next);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    if (id === "shiprocket") {
      setShiprocketState((s) => ({ ...s, enabled: next }));
      toast.success(next ? "Shiprocket enabled." : "Shiprocket paused.");
    } else {
      setState((s) => ({ ...s, enabled: next }));
      toast.success(
        next ? "Online payments enabled." : "Online payments paused.",
      );
    }
    refresh();
  }

  const countFor = (c: "all" | Category) =>
    c === "all"
      ? CHANNELS.length
      : CHANNELS.filter((ch) => ch.category === c).length;

  return (
    <div className="max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#111827]">Channels</h1>
        <p className="mt-1 text-sm text-[#5b6472]">
          Connect the services your store sells and operates through. Money from
          online payments settles directly in your own gateway account —
          StoreMink never touches it and takes no transaction fee.
        </p>
      </div>

      {/* Category tabs */}
      <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-[rgba(17,24,39,0.08)]">
        {(["all", ...categories] as const).map((c) => {
          const activeTab = tab === c;
          return (
            <button
              key={c}
              type="button"
              onClick={() => setTab(c)}
              className={`-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                activeTab
                  ? "border-indigo-600 text-indigo-700"
                  : "border-transparent text-[#5b6472] hover:text-[#111827]"
              }`}
            >
              {c === "all" ? "All" : CATEGORY_LABEL[c]}
              <span className="rounded-full bg-[#f1f3f5] px-1.5 py-0.5 text-[11px] font-semibold text-[#5b6472]">
                {countFor(c)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="mb-6 flex max-w-md items-center gap-2 rounded-lg border border-[rgba(17,24,39,0.12)] bg-white px-3 py-2">
        <Search className="h-4 w-4 text-[#9ca3af]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name"
          className="flex-1 border-none bg-transparent text-sm outline-none placeholder:text-[#9ca3af]"
        />
      </div>

      {active.length > 0 && (
        <Section title="Active channels">
          {active.map((c) => (
            <ChannelCard
              key={c.id}
              def={c}
              badge={
                isEnabled(c.id)
                  ? { text: "Live", tone: "green" }
                  : { text: "Paused", tone: "amber" }
              }
              toggle={
                canManage &&
                (c.id !== "shiprocket" || shiprocketState.availableOnPlan) ? (
                  <Toggle
                    on={isEnabled(c.id)}
                    onClick={() => handleToggle(c.id)}
                  />
                ) : null
              }
              onClick={() => setOpenId(c.id)}
            />
          ))}
        </Section>
      )}

      <Section title="Available channels">
        {available.length === 0 ? (
          <p className="text-sm text-[#9ca3af]">
            Every available channel is already connected.
          </p>
        ) : (
          available.map((c) => (
            <ChannelCard
              key={c.id}
              def={c}
              badge={
                c.id === "razorpay" && !state.planAllowsOnlinePayments
                  ? { text: "Basic plan onwards", tone: "amber", icon: Lock }
                  : c.id === "shiprocket" && !shiprocketState.availableOnPlan
                    ? { text: "Basic plan onwards", tone: "amber", icon: Lock }
                    : undefined
              }
              cta="Connect"
              onClick={() => setOpenId(c.id)}
            />
          ))
        )}
      </Section>

      {openId === "razorpay" && (
        <RazorpayModal
          state={state}
          canManage={canManage}
          onClose={() => setOpenId(null)}
          onState={setState}
          onRefresh={refresh}
        />
      )}
      {openId === "shiprocket" && (
        <ShiprocketModal
          state={shiprocketState}
          canManage={canManage}
          onClose={() => setOpenId(null)}
          onState={setShiprocketState}
          onRefresh={refresh}
        />
      )}
      {openId === "twilio" && (
        <TwilioModal
          state={smsState}
          canManage={canManage}
          onClose={() => setOpenId(null)}
          onState={setSmsState}
          onRefresh={refresh}
        />
      )}
    </div>
  );
}

function ShiprocketModal({
  state,
  canManage,
  onClose,
  onState,
  onRefresh,
}: {
  state: ShiprocketChannelState;
  canManage: boolean;
  onClose: () => void;
  onState: React.Dispatch<React.SetStateAction<ShiprocketChannelState>>;
  onRefresh: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showForm, setShowForm] = useState(!state.connected);
  const [busy, setBusy] = useState(false);
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = useState(state.webhookUrl);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const result = await saveShiprocketCredentials(email, password);
    setBusy(false);
    if (result.error) return toast.error(result.error);
    setWebhookSecret(result.webhookSecret ?? null);
    setWebhookUrl(result.webhookUrl ?? null);
    setPassword("");
    setShowForm(false);
    onState((s) => ({
      ...s,
      connected: true,
      enabled: true,
      accountEmail: email.trim().toLowerCase(),
      webhookUrl: result.webhookUrl ?? s.webhookUrl,
    }));
    toast.success("Shiprocket connected. Now sync your warehouse locations.");
    onRefresh();
  }

  async function handleSync() {
    setBusy(true);
    const result = await syncShiprocketPickupLocations();
    setBusy(false);
    if (result.error) toast.error(result.error);
    if (result.synced) {
      onState((s) => ({ ...s, mappedLocations: result.synced ?? 0 }));
      toast.success(
        `${result.synced} fulfilment location${result.synced === 1 ? "" : "s"} synced.`,
      );
    }
    for (const item of result.skipped ?? []) {
      toast.warning(`${item.location}: ${item.reason}`);
    }
    onRefresh();
  }

  async function handleRotate() {
    setBusy(true);
    const result = await rotateShiprocketWebhookSecret();
    setBusy(false);
    if (result.error) return toast.error(result.error);
    setWebhookSecret(result.webhookSecret ?? null);
    setWebhookUrl(result.webhookUrl ?? webhookUrl);
    toast.success("Webhook token rotated. Update it in Shiprocket now.");
  }

  async function handleToggle() {
    setBusy(true);
    const next = !state.enabled;
    const result = await setShiprocketEnabled(next);
    setBusy(false);
    if (result.error) return toast.error(result.error);
    onState((s) => ({ ...s, enabled: next }));
    toast.success(next ? "Shiprocket enabled." : "Shiprocket paused.");
    onRefresh();
  }

  async function handleDisconnect() {
    if (
      !window.confirm(
        "Disconnect Shiprocket? Existing shipment records remain, but new bookings and live tracking will stop.",
      )
    )
      return;
    setBusy(true);
    const result = await disconnectShiprocket();
    setBusy(false);
    if (result.error) return toast.error(result.error);
    onState({
      availableOnPlan: state.availableOnPlan,
      connected: false,
      enabled: false,
      accountEmail: null,
      connectionId: null,
      webhookUrl: null,
      mappedLocations: 0,
      eligibleLocations: state.eligibleLocations,
    });
    toast.success("Shiprocket disconnected.");
    onRefresh();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-xl bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[rgba(17,24,39,0.08)] p-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-[7.5rem] items-center justify-center">
              <ChannelLogo def={SHIPROCKET_CHANNEL} height={24} />
            </span>
            <div>
              <h2 className="text-base font-semibold text-[#111827]">
                Shiprocket
              </h2>
              <p className="text-xs text-[#5b6472]">
                Courier aggregation on your own account
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[#6b7280] hover:bg-[#f3f4f6]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {!state.availableOnPlan ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              Shiprocket is available on Basic and Pro. This saved connection,
              warehouse mappings and shipment history are retained and will work
              again after an upgrade.
            </div>
          ) : null}
          {state.connected && !showForm ? (
            <>
              <div className="rounded-lg border border-[rgba(17,24,39,0.08)] bg-[#f9fafb] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-[#111827]">
                      {state.accountEmail}
                    </p>
                    <p className="mt-1 text-xs text-[#5b6472]">
                      Password and API token are encrypted and never displayed.
                    </p>
                  </div>
                  <ShieldCheck className="h-5 w-5 text-green-600" />
                </div>
                <div className="mt-3 text-xs text-[#5b6472]">
                  {state.mappedLocations} of {state.eligibleLocations}{" "}
                  online-fulfilment locations synced
                </div>
              </div>

              <div className="rounded-lg border border-violet-100 bg-violet-50/50 p-4">
                <p className="text-sm font-semibold text-[#111827]">
                  Live tracking webhook
                </p>
                <p className="mt-1 text-xs text-[#5b6472]">
                  In Shiprocket, open Settings → API → Webhooks. Paste this URL
                  and use the token as the <code>x-api-key</code> header.
                </p>
                {webhookUrl && (
                  <button
                    type="button"
                    onClick={() => copy(webhookUrl, "Webhook URL")}
                    className="mt-3 flex w-full items-center justify-between gap-2 rounded-md border bg-white px-3 py-2 text-left font-mono text-xs text-[#344054]"
                  >
                    <span className="truncate">{webhookUrl}</span>
                    <Copy className="h-3.5 w-3.5 shrink-0" />
                  </button>
                )}
                {webhookSecret ? (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => copy(webhookSecret, "Webhook token")}
                      className="flex w-full items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-left font-mono text-xs text-amber-900"
                    >
                      <span className="truncate">{webhookSecret}</span>
                      <Copy className="h-3.5 w-3.5 shrink-0" />
                    </button>
                    <p className="mt-1 text-[11px] text-amber-700">
                      Copy now. This token will not be shown again.
                    </p>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={handleRotate}
                    disabled={!canManage || !state.availableOnPlan || busy}
                    className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-violet-700 disabled:opacity-50"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Generate a new webhook
                    token
                  </button>
                )}
              </div>

              {canManage && state.availableOnPlan && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="dash-btn dash-btn-primary"
                    onClick={handleSync}
                    disabled={busy}
                  >
                    Sync warehouses
                  </button>
                  <button
                    type="button"
                    className="dash-btn"
                    onClick={handleToggle}
                    disabled={busy}
                  >
                    {state.enabled ? "Pause" : "Resume"}
                  </button>
                  <button
                    type="button"
                    className="dash-btn"
                    onClick={() => setShowForm(true)}
                    disabled={busy}
                  >
                    Replace login
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                    onClick={handleDisconnect}
                    disabled={busy}
                  >
                    <Unplug className="h-4 w-4" /> Disconnect
                  </button>
                </div>
              )}
            </>
          ) : (
            <form onSubmit={handleSave} className="space-y-4">
              <p className="text-sm text-[#5b6472]">
                Use a dedicated Shiprocket API user. We verify the login before
                storing it; bookings and charges stay in the merchant&apos;s
                Shiprocket account.
              </p>
              <div>
                <label
                  htmlFor="sr-email"
                  className="mb-1.5 block text-sm font-medium text-[#344054]"
                >
                  API user email
                </label>
                <input
                  id="sr-email"
                  type="email"
                  className="dash-input w-full"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  disabled={!canManage || !state.availableOnPlan || busy}
                />
              </div>
              <div>
                <label
                  htmlFor="sr-password"
                  className="mb-1.5 block text-sm font-medium text-[#344054]"
                >
                  API user password
                </label>
                <input
                  id="sr-password"
                  type="password"
                  className="dash-input w-full"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  autoComplete="off"
                  disabled={!canManage || !state.availableOnPlan || busy}
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="dash-btn dash-btn-primary"
                  disabled={!canManage || !state.availableOnPlan || busy}
                >
                  {busy ? "Verifying…" : "Verify & connect"}
                </button>
                {state.connected && (
                  <button
                    type="button"
                    className="dash-btn"
                    onClick={() => setShowForm(false)}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#6b7280]">
        {title}
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {children}
      </div>
    </div>
  );
}

function ChannelCard({
  def,
  badge,
  toggle,
  cta,
  onClick,
}: {
  def: ChannelDef;
  badge?: { text: string; tone: "green" | "amber"; icon?: LucideIcon };
  toggle?: React.ReactNode;
  cta?: string;
  onClick: () => void;
}) {
  const BadgeIcon = badge?.icon;
  return (
    // A clickable div (not <button>): the card contains a Toggle button, and a
    // <button> can't nest inside a <button> (invalid HTML / hydration error).
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="group flex cursor-pointer flex-col rounded-xl border border-[rgba(17,24,39,0.1)] bg-white p-4 text-left shadow-sm transition-all hover:border-indigo-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
    >
      <div className="mb-4 flex items-start justify-between">
        <span
          className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium capitalize ${CATEGORY_BADGE[def.category]}`}
        >
          {CATEGORY_LABEL[def.category]}
        </span>
        {badge && (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              badge.tone === "green"
                ? "bg-green-50 text-green-700"
                : "bg-amber-50 text-amber-700"
            }`}
          >
            {BadgeIcon && <BadgeIcon className="h-3 w-3" />}
            {badge.text}
          </span>
        )}
      </div>

      <div className="flex flex-1 items-center justify-center py-4">
        <ChannelLogo def={def} height={40} />
      </div>

      <div className="mt-2 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-[#111827]">{def.name}</div>
          <div className="text-xs text-[#9ca3af]">{def.tagline}</div>
        </div>
        {toggle ??
          (cta ? (
            <span className="shrink-0 text-sm font-semibold text-indigo-600 group-hover:underline">
              {cta}
            </span>
          ) : null)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
/** Shared by both channel modals — no component state, so it lives out here. */
async function copy(value: string, label: string) {
  await navigator.clipboard.writeText(value);
  toast.success(`${label} copied.`);
}

// Razorpay connect / manage modal (the previous page body, now in a dialog).
// ---------------------------------------------------------------------------
function RazorpayModal({
  state,
  canManage,
  onClose,
  onState,
  onRefresh,
}: {
  state: ChannelState;
  canManage: boolean;
  onClose: () => void;
  onState: React.Dispatch<React.SetStateAction<ChannelState>>;
  onRefresh: () => void;
}) {
  const [keyId, setKeyId] = useState("");
  const [payWebhookSecret, setPayWebhookSecret] = useState<string | null>(null);

  async function handleGenerateWebhook() {
    const res = await generateWebhookSecret();
    if ("error" in res) return toast.error(res.error);
    setPayWebhookSecret(res.secret);
    onState((s) => ({ ...s, webhookConfigured: true }));
    toast.success("Webhook secret generated. Add it in Razorpay now.");
  }
  const [keySecret, setKeySecret] = useState("");
  const [showForm, setShowForm] = useState(!state.connected);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const res = await saveRazorpayCredentials(keyId, keySecret);
    setSaving(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success("Razorpay connected — online payments are live.");
    onState((s) => ({
      ...s,
      connected: true,
      keyId: keyId.trim(),
      enabled: true,
    }));
    setKeyId("");
    setKeySecret("");
    setShowForm(false);
    onRefresh();
  }

  async function handleToggle() {
    const next = !state.enabled;
    setToggling(true);
    const res = await setRazorpayEnabled(next);
    setToggling(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    onState((s) => ({ ...s, enabled: next }));
    toast.success(
      next ? "Online payments enabled." : "Online payments paused.",
    );
    onRefresh();
  }

  async function handleDisconnect() {
    if (
      !window.confirm(
        "Disconnect Razorpay? Online payments will stop; your Razorpay account itself is untouched.",
      )
    ) {
      return;
    }
    const res = await disconnectRazorpay();
    if (res.error) {
      toast.error(res.error);
      return;
    }
    onState((s) => ({ ...s, connected: false, keyId: null, enabled: false }));
    toast.success("Razorpay disconnected.");
    onRefresh();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[rgba(17,24,39,0.08)] p-5">
          <div className="flex items-center gap-3">
            <Image
              src="/channels/razorpay.webp"
              alt="Razorpay logo"
              width={Math.round(28 * (132 / 38))}
              height={28}
              className="object-contain"
            />
            <div>
              <h2 className="text-base font-semibold text-[#111827]">
                Razorpay
              </h2>
              <p className="text-xs text-[#5b6472]">
                UPI, cards & netbanking on your own account
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[#6b7280] hover:bg-[#f3f4f6]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5">
          {!state.planAllowsOnlinePayments ? (
            <div className="flex items-start gap-3 rounded-md bg-amber-50 p-4">
              <Lock className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500" />
              <div className="text-sm text-amber-800">
                <p className="font-medium">
                  Online payments are included from the Basic plan.
                </p>
                <p className="mt-1">
                  Upgrade your plan to connect your own Razorpay account —
                  checkout stays Cash&nbsp;on&nbsp;Delivery until then.
                </p>
              </div>
            </div>
          ) : state.connected && !showForm ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between rounded-lg border border-[rgba(17,24,39,0.08)] bg-[#f9fafb] px-4 py-3">
                <div>
                  <div className="text-sm font-medium text-[#344054]">
                    Key ID
                  </div>
                  <div className="mt-0.5 font-mono text-sm text-[#111827]">
                    {state.keyId}
                  </div>
                  <div className="mt-1 text-xs text-[#5b6472]">
                    The key secret is stored encrypted and never shown again.
                  </div>
                </div>
                <ShieldCheck className="h-5 w-5 text-green-600" />
              </div>

              {/* ★ Without this, a payment is only noticed when the shopper's
                  success page loads or the hourly reaper sweeps — so a closed
                  tab leaves a paid order sitting `pending`. */}
              <div className="rounded-lg border border-violet-100 bg-violet-50/50 p-4">
                <p className="text-sm font-semibold text-[#111827]">
                  Payment webhook{" "}
                  {state.webhookConfigured && (
                    <span className="ml-1 text-xs font-normal text-green-700">
                      · active
                    </span>
                  )}
                </p>
                <p className="mt-1 text-xs text-[#5b6472]">
                  In Razorpay, open Settings → Webhooks → Add New Webhook. Paste
                  this URL, set the same secret, and tick{" "}
                  <code>payment.captured</code>. Orders are then confirmed the
                  moment payment clears, even if the shopper closes the tab.
                </p>
                {state.webhookUrl && (
                  <button
                    type="button"
                    onClick={() => copy(state.webhookUrl!, "Webhook URL")}
                    className="mt-3 flex w-full items-center justify-between gap-2 rounded-md border bg-white px-3 py-2 text-left font-mono text-xs text-[#344054]"
                  >
                    <span className="truncate">{state.webhookUrl}</span>
                    <Copy className="h-3.5 w-3.5 shrink-0" />
                  </button>
                )}
                {payWebhookSecret ? (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => copy(payWebhookSecret, "Webhook secret")}
                      className="flex w-full items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-left font-mono text-xs text-amber-900"
                    >
                      <span className="truncate">{payWebhookSecret}</span>
                      <Copy className="h-3.5 w-3.5 shrink-0" />
                    </button>
                    <p className="mt-1 text-[11px] text-amber-700">
                      Copy now. This secret will not be shown again.
                    </p>
                  </div>
                ) : (
                  canManage && (
                    <button
                      type="button"
                      onClick={handleGenerateWebhook}
                      className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-violet-700"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      {state.webhookConfigured
                        ? "Generate a new secret"
                        : "Generate a webhook secret"}
                    </button>
                  )
                )}
              </div>

              {canManage && (
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    className="dash-btn dash-btn-primary"
                    onClick={handleToggle}
                    disabled={toggling}
                  >
                    {toggling
                      ? "Saving…"
                      : state.enabled
                        ? "Pause online payments"
                        : "Resume online payments"}
                  </button>
                  <button
                    type="button"
                    className="dash-btn"
                    onClick={() => setShowForm(true)}
                  >
                    Replace keys
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                    onClick={handleDisconnect}
                  >
                    <Unplug className="h-4 w-4" /> Disconnect
                  </button>
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={handleSave} className="space-y-4">
              <p className="text-sm text-[#5b6472]">
                Paste the API keys from your Razorpay dashboard (Settings → API
                keys). We verify them with Razorpay before saving; the secret is
                encrypted and never displayed again.
              </p>
              <div>
                <label
                  htmlFor="rzp-key-id"
                  className="mb-1.5 block text-sm font-medium text-[#344054]"
                >
                  Key ID
                </label>
                <input
                  id="rzp-key-id"
                  className="dash-input w-full font-mono"
                  placeholder="rzp_live_…"
                  value={keyId}
                  onChange={(e) => setKeyId(e.target.value)}
                  required
                  disabled={!canManage || saving}
                />
              </div>
              <div>
                <label
                  htmlFor="rzp-key-secret"
                  className="mb-1.5 block text-sm font-medium text-[#344054]"
                >
                  Key Secret
                </label>
                <input
                  id="rzp-key-secret"
                  type="password"
                  className="dash-input w-full font-mono"
                  placeholder="••••••••••••"
                  value={keySecret}
                  onChange={(e) => setKeySecret(e.target.value)}
                  required
                  autoComplete="off"
                  disabled={!canManage || saving}
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  className="dash-btn dash-btn-primary"
                  disabled={!canManage || saving}
                >
                  {saving ? "Verifying…" : "Verify & save"}
                </button>
                {state.connected && (
                  <button
                    type="button"
                    className="dash-btn"
                    onClick={() => setShowForm(false)}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ★★ SMS IS BYO BECAUSE THE LAW MAKES IT SO, and this modal has to say that.
//
// TRAI requires the MERCHANT to register a Principal Entity, a 6-character
// sender header and every message template on an operator DLT portal. The
// header IS their registered identity, so StoreMink cannot send under it from a
// shared account — and a message that does not match an approved template is
// dropped by the carrier with no bounce and no error anywhere.
//
// That last property is why the copy here is unusually explicit. Every other
// channel fails loudly; this one fails silently, and a merchant who does not
// know about DLT will read the silence as our bug.
// ---------------------------------------------------------------------------
function TwilioModal({
  state,
  canManage,
  onClose,
  onState,
  onRefresh,
}: {
  state: SmsChannelState;
  canManage: boolean;
  onClose: () => void;
  onState: React.Dispatch<React.SetStateAction<SmsChannelState>>;
  onRefresh: () => void;
}) {
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [senderHeader, setSenderHeader] = useState(state.senderHeader ?? "");
  const [dltEntityId, setDltEntityId] = useState(state.dltEntityId ?? "");
  const [showForm, setShowForm] = useState(!state.connected);
  const [busy, setBusy] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const result = await saveSmsCredentials({
      accountSid,
      authToken,
      senderHeader,
      dltEntityId,
    });
    setBusy(false);
    if (result.error) return toast.error(result.error);
    // Cleared immediately — there is no reason for a live auth token to sit in
    // a React state tree after it has been stored.
    setAuthToken("");
    setShowForm(false);
    onState((s) => ({
      ...s,
      connected: true,
      enabled: true,
      accountSid: accountSid.trim(),
      senderHeader: senderHeader.trim().toUpperCase(),
      dltEntityId: dltEntityId.trim(),
    }));
    toast.success("SMS connected. Add your DLT templates to start sending.");
    onRefresh();
  }

  async function handleToggle() {
    setBusy(true);
    const next = !state.enabled;
    const result = await setSmsEnabled(next);
    setBusy(false);
    if (result.error) return toast.error(result.error);
    onState((s) => ({ ...s, enabled: next }));
    toast.success(next ? "SMS enabled." : "SMS paused.");
    onRefresh();
  }

  async function handleDisconnect() {
    // ⚠ Names what is actually lost. The header and entity id live on the DLT
    // portal and cannot be retyped from memory.
    if (
      !window.confirm(
        "Disconnect SMS? Your DLT sender header and Entity ID are removed too — you'll need them from your DLT portal to reconnect.",
      )
    )
      return;
    setBusy(true);
    const result = await disconnectSms();
    setBusy(false);
    if (result.error) return toast.error(result.error);
    onState({
      connected: false,
      enabled: false,
      accountSid: null,
      senderHeader: null,
      dltEntityId: null,
      verifiedAt: null,
    });
    toast.success("SMS disconnected.");
    onRefresh();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-xl bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[rgba(17,24,39,0.08)] p-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-[7.5rem] items-center justify-center">
              <ChannelLogo def={TWILIO_CHANNEL} height={24} />
            </span>
            <div>
              <h2 className="text-base font-semibold text-[#111827]">
                Twilio SMS
              </h2>
              <p className="text-xs text-[#5b6472]">
                Your own Twilio account and DLT registration
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[#6b7280] hover:bg-[#f3f4f6]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {state.connected && !showForm ? (
            <>
              <div className="rounded-lg border border-[rgba(17,24,39,0.08)] bg-[#f9fafb] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm text-[#111827]">
                      {state.accountSid}
                    </p>
                    <p className="mt-1 text-xs text-[#5b6472]">
                      The auth token is encrypted and never displayed.
                    </p>
                  </div>
                  <ShieldCheck className="h-5 w-5 shrink-0 text-green-600" />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <dt className="text-[#5b6472]">Sender header</dt>
                    <dd className="font-mono text-[#111827]">
                      {state.senderHeader}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[#5b6472]">DLT Entity ID</dt>
                    <dd className="truncate font-mono text-[#111827]">
                      {state.dltEntityId}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-semibold text-[#111827]">
                  Messages still need approved templates
                </p>
                <p className="mt-1 text-xs text-[#5b6472]">
                  Carriers in India drop any message whose text doesn&apos;t
                  match a template you registered on your DLT portal — with no
                  bounce and no error. Add each one under Settings →
                  Notifications before switching a message on.
                </p>
              </div>
            </>
          ) : (
            <form onSubmit={handleSave} className="space-y-3">
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-[#5b6472]">
                <p className="text-sm font-semibold text-[#111827]">
                  You need a DLT registration first
                </p>
                <p className="mt-1">
                  India&apos;s TRAI rules require every business to register its
                  own entity, sender header and message templates with an
                  operator DLT portal. It takes 7–21 days, and SMS to Indian
                  numbers is blocked at the carrier until it is done. StoreMink
                  can&apos;t send under a shared header on your behalf.
                </p>
              </div>

              <Field
                label="Twilio Account SID"
                value={accountSid}
                onChange={setAccountSid}
                placeholder="AC…"
                mono
              />
              <Field
                label="Twilio Auth Token"
                value={authToken}
                onChange={setAuthToken}
                type="password"
                placeholder="Your auth token"
                mono
              />
              <Field
                label="DLT sender header"
                value={senderHeader}
                onChange={(v) => setSenderHeader(v.toUpperCase().slice(0, 6))}
                placeholder="CORNRS"
                hint="Exactly six letters — the transactional form. A numeric header is promotional and will be rejected."
                mono
              />
              <Field
                label="DLT Principal Entity ID"
                value={dltEntityId}
                onChange={setDltEntityId}
                placeholder="1701234567890123456"
                hint="From your DLT portal. Sent with every message; without it carriers drop the message silently."
                mono
              />

              <button
                type="submit"
                disabled={busy || !canManage}
                className="w-full rounded-md bg-[#111827] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? "Verifying…" : "Verify & save"}
              </button>
              {state.connected && (
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="w-full rounded-md px-4 py-2 text-sm text-[#5b6472] hover:bg-[#f3f4f6]"
                >
                  Cancel
                </button>
              )}
            </form>
          )}

          {state.connected && !showForm && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleToggle}
                disabled={busy || !canManage}
                className="rounded-md border px-3 py-2 text-sm text-[#344054] disabled:opacity-50"
              >
                {state.enabled ? "Pause SMS" : "Resume SMS"}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(true)}
                disabled={!canManage}
                className="rounded-md border px-3 py-2 text-sm text-[#344054] disabled:opacity-50"
              >
                Update credentials
              </button>
              <button
                type="button"
                onClick={handleDisconnect}
                disabled={busy || !canManage}
                className="ml-auto flex items-center gap-1.5 rounded-md px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                <Unplug className="h-4 w-4" />
                Disconnect
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = "text",
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  type?: string;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[#344054]">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={`w-full rounded-md border border-[rgba(17,24,39,0.16)] px-3 py-2 text-sm outline-none focus:border-[#111827] ${
          mono ? "font-mono" : ""
        }`}
      />
      {hint && (
        <span className="mt-1 block text-[11px] text-[#5b6472]">{hint}</span>
      )}
    </label>
  );
}
