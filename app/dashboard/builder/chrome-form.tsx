"use client";

import { useState } from "react";
import { ChevronDown, GripVertical, Plus, X } from "lucide-react";
import type { ChromeLink, FooterGroup, StoreChrome } from "@/lib/chrome/types";

// ---------------------------------------------------------------------------
// Header + footer editors, inside the builder's inspector.
//
// These replace /dashboard/navigation, which was a separate dashboard page with
// a separate form and no preview: you edited your footer blind, saved, then
// navigated to the storefront to see what you'd done. Here every keystroke
// paints in the preview iframe beside it.
//
// Deliberately NOT a section canvas. The merchant controls what each block
// SAYS and whether it appears; the arrangement stays theme-controlled. A footer
// you can drag arbitrary blocks into is a footer merchants can make look
// broken, and it is the one surface that appears on every page of the store.
// ---------------------------------------------------------------------------

// A collapsible group, matching the inspector's field-group treatment so the
// chrome editor doesn't look like a different product bolted on.
function Group({
  title,
  hint,
  children,
  defaultOpen = true,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="sm-b-group">
      <button
        type="button"
        className="sm-b-group-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>{title}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <div className="sm-b-group-body">
          {hint && <p className="sm-b-hint">{hint}</p>}
          {children}
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="sm-b-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="sm-b-toggle-label">{label}</span>
        {hint && <span className="sm-b-toggle-hint">{hint}</span>}
      </span>
    </label>
  );
}

/** One editable label→href list. Used by the header and by each footer column. */
function LinkList({
  links,
  onChange,
  addLabel = "Add link",
}: {
  links: ChromeLink[];
  onChange: (next: ChromeLink[]) => void;
  addLabel?: string;
}) {
  const set = (i: number, patch: Partial<ChromeLink>) =>
    onChange(links.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= links.length) return;
    const next = [...links];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="sm-b-linklist">
      {links.map((link, i) => (
        <div key={i} className="sm-b-linkrow">
          <span className="sm-b-linkgrip" aria-hidden>
            <GripVertical className="h-3.5 w-3.5" />
          </span>
          <div className="sm-b-linkfields">
            <input
              className="sm-b-input"
              value={link.label}
              placeholder="Label"
              onChange={(e) => set(i, { label: e.target.value })}
            />
            <input
              className="sm-b-input sm-b-input-mono"
              value={link.href}
              placeholder="/shop"
              onChange={(e) => set(i, { href: e.target.value })}
            />
          </div>
          <div className="sm-b-linkactions">
            <button
              type="button"
              onClick={() => move(i, -1)}
              disabled={i === 0}
              aria-label="Move up"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => move(i, 1)}
              disabled={i === links.length - 1}
              aria-label="Move down"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => onChange(links.filter((_, n) => n !== i))}
              aria-label="Remove link"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        className="sm-b-addbtn"
        onClick={() => onChange([...links, { label: "", href: "" }])}
      >
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </button>
      {links.length === 0 && (
        <p className="sm-b-hint">
          No links yet. Visitors will still reach your pages from the footer and
          from links inside your content.
        </p>
      )}
    </div>
  );
}

export function HeaderForm({
  chrome,
  onChange,
}: {
  chrome: StoreChrome;
  onChange: (next: StoreChrome) => void;
}) {
  const h = chrome.header;
  const patch = (p: Partial<typeof h>) =>
    onChange({ ...chrome, header: { ...h, ...p } });

  return (
    <>
      <Group title="Menu" hint="The links across the top of every page.">
        <LinkList
          links={h.links}
          onChange={(links) => patch({ links })}
          addLabel="Add menu link"
        />
      </Group>

      <Group title="What appears">
        <Toggle
          label="Search"
          hint="A search box in the header."
          checked={h.showSearch}
          onChange={(showSearch) => patch({ showSearch })}
        />
        <Toggle
          label="Account"
          hint="Sign in and order history."
          checked={h.showAccount}
          onChange={(showAccount) => patch({ showAccount })}
        />
        <Toggle
          label="Cart"
          hint="Turn off for a catalogue-only store that takes enquiries instead of orders."
          checked={h.showCart}
          onChange={(showCart) => patch({ showCart })}
        />
        <Toggle
          label="Stay visible when scrolling"
          checked={h.sticky}
          onChange={(sticky) => patch({ sticky })}
        />
      </Group>

      <Group title="Logo" defaultOpen={false}>
        <p className="sm-b-hint">
          Your logo and store name come from your brand, so they stay the same
          everywhere — invoices and emails included.{" "}
          <a href="/dashboard/branding" target="_blank" rel="noopener">
            Edit branding
          </a>
        </p>
      </Group>
    </>
  );
}

export function FooterForm({
  chrome,
  onChange,
}: {
  chrome: StoreChrome;
  onChange: (next: StoreChrome) => void;
}) {
  const f = chrome.footer;
  const patch = (p: Partial<typeof f>) =>
    onChange({ ...chrome, footer: { ...f, ...p } });

  const setGroup = (i: number, next: Partial<FooterGroup>) =>
    patch({
      groups: f.groups.map((g, n) => (n === i ? { ...g, ...next } : g)),
    });

  return (
    <>
      <Group
        title="Link columns"
        hint="Each column becomes one list in the footer."
      >
        {f.groups.map((group, i) => (
          <div key={i} className="sm-b-column">
            <div className="sm-b-column-head">
              <input
                className="sm-b-input sm-b-input-strong"
                value={group.title}
                placeholder="Column title"
                onChange={(e) => setGroup(i, { title: e.target.value })}
              />
              <button
                type="button"
                onClick={() =>
                  patch({ groups: f.groups.filter((_, n) => n !== i) })
                }
                aria-label="Remove column"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <LinkList
              links={group.links}
              onChange={(links) => setGroup(i, { links })}
            />
          </div>
        ))}
        {f.groups.length < 6 && (
          <button
            type="button"
            className="sm-b-addbtn"
            onClick={() =>
              patch({ groups: [...f.groups, { title: "", links: [] }] })
            }
          >
            <Plus className="h-3.5 w-3.5" />
            Add column
          </button>
        )}
      </Group>

      <Group title="Newsletter" defaultOpen={false}>
        <Toggle
          label="Show the sign-up bar"
          checked={f.newsletter.enabled}
          onChange={(enabled) =>
            patch({ newsletter: { ...f.newsletter, enabled } })
          }
        />
        {f.newsletter.enabled && (
          <>
            <label className="sm-b-field">
              <span>Heading</span>
              <input
                className="sm-b-input"
                value={f.newsletter.heading}
                onChange={(e) =>
                  patch({
                    newsletter: { ...f.newsletter, heading: e.target.value },
                  })
                }
              />
            </label>
            <label className="sm-b-field">
              <span>Subtext</span>
              <input
                className="sm-b-input"
                value={f.newsletter.subtext}
                onChange={(e) =>
                  patch({
                    newsletter: { ...f.newsletter, subtext: e.target.value },
                  })
                }
              />
            </label>
            <label className="sm-b-field">
              <span>Button</span>
              <input
                className="sm-b-input"
                value={f.newsletter.buttonLabel}
                onChange={(e) =>
                  patch({
                    newsletter: {
                      ...f.newsletter,
                      buttonLabel: e.target.value,
                    },
                  })
                }
              />
            </label>
          </>
        )}
      </Group>

      <Group title="Blocks" defaultOpen={false}>
        <Toggle
          label="Contact details"
          hint="Email, phone and hours from your branding."
          checked={f.contact.enabled}
          onChange={(enabled) => patch({ contact: { enabled } })}
        />
        <Toggle
          label="Social links"
          hint="Only the profiles you've set in branding appear."
          checked={f.social.enabled}
          onChange={(enabled) => patch({ social: { enabled } })}
        />
        <Toggle
          label="Trust badges"
          checked={f.badges.enabled}
          onChange={(enabled) => patch({ badges: { enabled } })}
        />
      </Group>

      <Group
        title="Legal row"
        defaultOpen={false}
        hint="The small print along the very bottom."
      >
        <LinkList
          links={f.legal}
          onChange={(legal) => patch({ legal })}
          addLabel="Add legal link"
        />
      </Group>
    </>
  );
}

export interface BrandAppearance {
  name: string;
  primaryColor: string;
  logoUrl: string | null;
}

/**
 * Brand — the third global "section".
 *
 * Deliberately narrow: the colour and logo that decide how the WEBSITE looks.
 * Contact details, social profiles and the legal name stay in
 * /dashboard/branding because they are store identity — they print on invoices
 * and go out in email, so they are not a website decision and should not be
 * edited from a screen whose Publish button is about the website.
 */
export function BrandForm({
  brand,
  onChange,
}: {
  brand: BrandAppearance;
  onChange: (next: BrandAppearance) => void;
}) {
  return (
    <>
      <Group title="Colour" hint="Used for buttons, links and accents.">
        <div className="sm-b-colorrow">
          <input
            type="color"
            className="sm-b-color"
            value={brand.primaryColor}
            onChange={(e) =>
              onChange({ ...brand, primaryColor: e.target.value })
            }
            aria-label="Primary colour"
          />
          <input
            className="sm-b-input sm-b-input-mono"
            value={brand.primaryColor}
            onChange={(e) =>
              onChange({ ...brand, primaryColor: e.target.value })
            }
            aria-label="Primary colour hex"
          />
        </div>
      </Group>

      <Group title="Logo" defaultOpen={false}>
        <label className="sm-b-field">
          <span>Image URL</span>
          <input
            className="sm-b-input sm-b-input-mono"
            value={brand.logoUrl ?? ""}
            placeholder="https://…"
            onChange={(e) =>
              onChange({ ...brand, logoUrl: e.target.value || null })
            }
          />
        </label>
        <p className="sm-b-hint">
          Leave empty to show your store name as text. Upload images in the{" "}
          <a href="/dashboard/media" target="_blank" rel="noopener">
            media library
          </a>
          .
        </p>
      </Group>

      <Group title="Everything else" defaultOpen={false}>
        <p className="sm-b-hint">
          Your store name, contact details, social profiles and legal name are
          store identity — they also appear on invoices and in email, so they
          live in{" "}
          <a href="/dashboard/branding" target="_blank" rel="noopener">
            branding
          </a>
          .
        </p>
      </Group>
    </>
  );
}
