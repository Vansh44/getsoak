"use client";

// Per-event recipient picker (superadmin, "Store default" tab).
//
// Three modes, mirroring lib/notifications/routing.ts:
//   Everyone who can view {Section}  — the default
//   Specific roles
//   Specific people
//
// THE HONEST BIT: routing can only NARROW the permission-derived set. Picking
// someone who can't view the event's section does not start sending it to them
// — a notification's copy is a preview of the thing itself ("New order
// ORD10010004 · ₹1,240 · from Priya S."), so it must not become a side channel
// around the dashboard's own access rules. Rather than silently dropping such a
// pick, this panel greys it out and says why, with the fix (their role) named.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Info, Users } from "lucide-react";
import type {
  AudienceMember,
  AudienceRole,
} from "@/app/actions/notification-actions";
import type { RoutingMode, RoutingRule } from "@/lib/notifications/routing";

const MODE_LABEL: Record<RoutingMode, string> = {
  permission: "Everyone who can view",
  roles: "Specific roles",
  admins: "Specific people",
};

/** One-line summary for the collapsed row. */
export function routingSummary(
  rule: RoutingRule,
  sectionLabel: string,
  roles: AudienceRole[],
  members: AudienceMember[],
): string {
  if (rule.mode === "permission")
    return `Everyone who can view ${sectionLabel}`;
  if (rule.mode === "roles") {
    const names = rule.roles.map(
      (slug) => roles.find((r) => r.slug === slug)?.name ?? slug,
    );
    return names.length
      ? names.join(", ")
      : `Everyone who can view ${sectionLabel}`;
  }
  const names = rule.admins.map(
    (id) => members.find((m) => m.id === id)?.name ?? "Removed member",
  );
  if (!names.length) return `Everyone who can view ${sectionLabel}`;
  if (names.length <= 2) return names.join(", ");
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

function Row({
  checked,
  disabled,
  onToggle,
  title,
  subtitle,
  note,
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
  title: string;
  subtitle?: string;
  note?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors ${
        disabled
          ? "cursor-not-allowed opacity-55"
          : "hover:bg-[var(--dash-surface-2)]"
      }`}
    >
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
          checked
            ? "border-[var(--dash-accent)] bg-[var(--dash-accent)] text-white"
            : "border-[var(--dash-border-strong)]"
        }`}
        aria-hidden
      >
        {checked && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-[var(--dash-text)]">
          {title}
        </span>
        {subtitle && (
          <span className="block text-[11.5px] text-[var(--dash-text-3)]">
            {subtitle}
          </span>
        )}
        {note && (
          <span className="mt-0.5 block text-[11.5px] text-amber-700">
            {note}
          </span>
        )}
      </span>
    </button>
  );
}

const PANEL_WIDTH = 300;
const PANEL_MAX_HEIGHT = 380;

export function RecipientPicker({
  rule,
  sectionLabel,
  sectionKey,
  roles,
  members,
  disabled,
  onChange,
}: {
  rule: RoutingRule;
  sectionLabel: string;
  sectionKey: string;
  roles: AudienceRole[];
  members: AudienceMember[];
  disabled?: boolean;
  onChange: (next: RoutingRule) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; flip: boolean }>({
    top: 0,
    left: 0,
    flip: false,
  });

  // The panel is PORTALLED to <body> and positioned fixed, because .dash-card
  // sets overflow-y: hidden — an absolutely-positioned child was clipped at the
  // card's edge, which is why this picker looked broken. Fixed positioning also
  // lets it flip above the trigger near the bottom of the viewport.
  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flip = spaceBelow < PANEL_MAX_HEIGHT + 16 && rect.top > spaceBelow;
    setPos({
      top: flip ? rect.top - 6 : rect.bottom + 6,
      left: Math.max(
        8,
        Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8),
      ),
      flip,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Reposition rather than close: a picker that vanishes when the page moves
    // under it feels broken.
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, place]);

  // Who the permission map already allows for THIS event. Everyone else is
  // shown but not selectable — with the reason.
  const eligibleIds = useMemo(
    () =>
      new Set(
        members.filter((m) => m.sections.includes(sectionKey)).map((m) => m.id),
      ),
    [members, sectionKey],
  );
  const eligibleRoleSlugs = useMemo(
    () =>
      new Set(
        members.filter((m) => eligibleIds.has(m.id)).map((m) => m.roleSlug),
      ),
    [members, eligibleIds],
  );

  const setMode = (mode: RoutingMode) => onChange({ ...rule, mode });

  const toggleRole = (slug: string) => {
    const next = rule.roles.includes(slug)
      ? rule.roles.filter((r) => r !== slug)
      : [...rule.roles, slug];
    onChange({ ...rule, mode: "roles", roles: next });
  };

  const toggleMember = (id: string) => {
    const next = rule.admins.includes(id)
      ? rule.admins.filter((a) => a !== id)
      : [...rule.admins, id];
    onChange({ ...rule, mode: "admins", admins: next });
  };

  const summary = routingSummary(rule, sectionLabel, roles, members);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          // Measure in the event handler, not an effect — the position is
          // known the moment the trigger is clicked, and doing it in an effect
          // is a second render for no reason.
          if (!open) place();
          setOpen((v) => !v);
        }}
        disabled={disabled}
        className="flex w-[200px] items-center justify-between gap-2 rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-2.5 py-1.5 text-left text-[12.5px] text-[var(--dash-text)] transition-colors hover:border-[var(--dash-border-hover)] disabled:opacity-45"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Users className="h-3.5 w-3.5 shrink-0 text-[var(--dash-text-3)]" />
          <span className="truncate">{summary}</span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--dash-text-3)]" />
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            {/* Click-away. */}
            <div
              className="fixed inset-0 z-[300]"
              onClick={() => setOpen(false)}
              aria-hidden
            />
            <div
              className="dashboard-shell fixed z-[301] overflow-y-auto rounded-[var(--dash-radius)] border border-[var(--dash-border-strong)] bg-[var(--dash-surface)] p-1.5 shadow-[var(--dash-shadow-lg)]"
              style={{
                top: pos.flip ? undefined : pos.top,
                bottom: pos.flip ? window.innerHeight - pos.top : undefined,
                left: pos.left,
                width: PANEL_WIDTH,
                maxHeight: PANEL_MAX_HEIGHT,
              }}
            >
              <div className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--dash-text-3)]">
                Send to
              </div>

              {(Object.keys(MODE_LABEL) as RoutingMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setMode(mode)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-[var(--dash-surface-2)] ${
                    rule.mode === mode
                      ? "font-semibold text-[var(--dash-text)]"
                      : "text-[var(--dash-text-2)]"
                  }`}
                >
                  <span
                    className={`h-3 w-3 shrink-0 rounded-full border-[3px] ${
                      rule.mode === mode
                        ? "border-[var(--dash-accent)]"
                        : "border-[var(--dash-border-strong)]"
                    }`}
                    aria-hidden
                  />
                  {mode === "permission"
                    ? `${MODE_LABEL[mode]} ${sectionLabel}`
                    : MODE_LABEL[mode]}
                </button>
              ))}

              {rule.mode === "roles" && (
                <div className="mt-1.5 border-t border-[var(--dash-border)] pt-1.5">
                  {roles.length === 0 ? (
                    <p className="px-2 py-2 text-[12px] text-[var(--dash-text-3)]">
                      No roles yet.
                    </p>
                  ) : (
                    roles.map((role) => {
                      const eligible = eligibleRoleSlugs.has(role.slug);
                      return (
                        <Row
                          key={role.slug}
                          checked={rule.roles.includes(role.slug)}
                          disabled={!eligible}
                          onToggle={() => toggleRole(role.slug)}
                          title={role.name}
                          note={
                            eligible
                              ? undefined
                              : `Can't view ${sectionLabel} — give the role access first`
                          }
                        />
                      );
                    })
                  )}
                </div>
              )}

              {rule.mode === "admins" && (
                <div className="mt-1.5 border-t border-[var(--dash-border)] pt-1.5">
                  {members.length === 0 ? (
                    <p className="px-2 py-2 text-[12px] text-[var(--dash-text-3)]">
                      No team members yet.
                    </p>
                  ) : (
                    members.map((member) => {
                      const eligible = eligibleIds.has(member.id);
                      return (
                        <Row
                          key={member.id}
                          checked={rule.admins.includes(member.id)}
                          disabled={!eligible}
                          onToggle={() => toggleMember(member.id)}
                          title={member.name}
                          subtitle={member.email}
                          note={
                            eligible
                              ? undefined
                              : `Can't view ${sectionLabel} — change their role first`
                          }
                        />
                      );
                    })
                  )}
                </div>
              )}

              <p className="mt-1.5 flex items-start gap-1.5 border-t border-[var(--dash-border)] px-2 pb-1 pt-2 text-[11.5px] leading-snug text-[var(--dash-text-3)]">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  Only people who can view {sectionLabel} can be notified about
                  it. Pick nobody and everyone eligible gets it.
                </span>
              </p>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
