"use client";

import Image from "next/image";
import Link from "next/link";
import { Search, Store, Menu, MessageSquare } from "lucide-react";
import { TopbarProfile, formatRole } from "./topbar-profile";
import { useMobileNav } from "./dashboard-mobile-nav";
import { useChat } from "./chat-context";
import { NotificationBell } from "./components/notification-bell";
import { LocationTag } from "./location-tag";

// Plan pill styling on the dark topbar — neutral for free, brand-tinted as the
// plan climbs, mirroring the console's plan colours.
const PLAN_PILL: Record<string, string> = {
  free: "bg-white/10 text-[#d1d5db]",
  basic: "bg-sky-400/20 text-sky-200",
  pro: "bg-[#7F4AFA]/25 text-[#c9b8fb]",
};

export function DashboardTopbar({
  email,
  role,
  firstName,
  lastName,
  storeName,
  planId,
  planName,
  scopedLocations = [],
}: {
  email: string;
  role: string;
  firstName?: string | null;
  lastName?: string | null;
  // Store context (store dashboards only). Absent on the platform operator
  // console, which manages every store rather than one.
  storeName?: string;
  planId?: string;
  planName?: string;
  /** The shops this viewer is restricted to. EMPTY = unrestricted, and the tag
   *  renders nothing — the platform console passes nothing at all. */
  scopedLocations?: { id: string; name: string }[];
}) {
  const { setOpen } = useMobileNav();
  const { isChatOpen, toggleChat } = useChat();
  const planPill = PLAN_PILL[planId ?? "free"] ?? PLAN_PILL.free;

  return (
    <header className="dash-topbar relative flex items-center justify-between px-2 sm:px-4 h-14 bg-[#3f3f46] text-white">
      {/* Left */}
      <div className="flex items-center gap-1 sm:gap-3 shrink-0">
        <button
          type="button"
          className="md:hidden flex items-center justify-center w-10 h-10 -ml-1 sm:-ml-2 rounded-md text-white hover:bg-slate-700 shrink-0"
          aria-label="Open navigation menu"
          onClick={() => setOpen(true)}
        >
          <Menu className="h-6 w-6" />
        </button>

        <Link
          href="/dashboard"
          className="flex items-center gap-2 no-underline hover:opacity-80 transition-opacity shrink-0 pr-1"
        >
          <div className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-md bg-white/10">
            <Image
              src="/brand/storemink-mark.png"
              alt="StoreMink logo"
              width={20}
              height={20}
              className="h-5 w-5 object-contain"
            />
          </div>
          <span className="hidden xs:inline-block sm:inline-block text-[17px] font-semibold tracking-tight text-white">
            StoreMink
          </span>
        </Link>

        {storeName && (
          <div className="hidden items-center gap-2 lg:flex shrink-0">
            <span className="h-5 w-px bg-white/15" aria-hidden />
            <span
              className="max-w-[160px] truncate text-[13px] font-medium text-white/90"
              title={storeName}
            >
              {storeName}
            </span>

            {planName && (
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${planPill}`}
                title={`This store is on the ${planName} plan`}
              >
                {planName}
              </span>
            )}
            <span className="hidden sm:inline-flex items-center rounded-full bg-white/10 px-2.5 h-[34px] text-[12.5px] font-medium text-white/85 shrink-0">
              {formatRole(role)}
            </span>
            {/* Immediately right of the role: both answer "who am I here", and
                for a restricted admin the second is the one that explains why
                their screens look different from a colleague's. */}
            <LocationTag locations={scopedLocations} />
          </div>
        )}
      </div>

      {/* Perfectly centered search */}
      <div className="absolute inset-0 hidden md:flex items-center justify-center pointer-events-none">
        <div className="pointer-events-auto w-full max-w-md bg-slate-700 hover:bg-slate-600 transition-colors border border-transparent hover:border-slate-500 rounded-lg h-[34px] px-3 flex items-center gap-2 group cursor-text">
          <Search className="h-4 w-4 shrink-0 text-slate-400 group-hover:text-white transition-colors" />

          <input
            type="search"
            placeholder="Search"
            className="flex-1 bg-transparent border-none outline-none text-white text-[13px] placeholder:text-slate-400"
          />

          <kbd className="shrink-0 bg-slate-800 border border-slate-600 text-slate-400 text-[10px] font-medium px-1.5 py-0.5 rounded">
            ⌘ K
          </kbd>
        </div>
      </div>

      {/* Right */}
      <div className="flex items-center gap-0.5 sm:gap-3 shrink-0 justify-end">
        <button
          type="button"
          onClick={() => window.open("/", "_blank")}
          className="hidden sm:flex items-center gap-2 text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 h-[34px] px-3 rounded-lg text-[13px] font-medium transition-colors shrink-0"
        >
          <Store className="h-4 w-4" />
          My Store
        </button>

        <button
          type="button"
          className="md:hidden relative text-slate-300 hover:text-white w-8 h-8 rounded-md flex items-center justify-center transition-colors hover:bg-slate-700 shrink-0"
          aria-label="Search"
        >
          <Search className="h-[18px] w-[18px]" />
        </button>

        <button
          type="button"
          onClick={toggleChat}
          className={`relative text-slate-300 hover:text-white w-8 h-8 rounded-md flex items-center justify-center transition-colors hover:bg-slate-700 shrink-0 ${
            isChatOpen ? "bg-slate-700 text-white" : ""
          }`}
          aria-label="Mink AI"
        >
          <MessageSquare className="h-[18px] w-[18px]" />
        </button>

        <NotificationBell />

        <div className="shrink-0 ml-1">
          <TopbarProfile
            email={email}
            role={role}
            firstName={firstName}
            lastName={lastName}
            storeName={storeName}
            planName={planName}
          />
        </div>
      </div>
    </header>
  );
}
