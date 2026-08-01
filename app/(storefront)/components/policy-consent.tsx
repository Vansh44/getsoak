"use client";

// ---------------------------------------------------------------------------
// The shopper-facing consent line, shared by the signup modal and checkout.
//
// It renders NOTHING when the store has published no relevant policies. A box
// that names documents nobody can read would manufacture a record of agreement
// to a blank page — worse than no box at all. That is also why the parent asks
// `required` back: it must not gate its button on a box that isn't there.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import {
  getPolicyLinks,
  type PolicyLink,
} from "@/app/actions/store-policy-actions";

export function usePolicyLinks(scope: "all" | "checkout") {
  const [links, setLinks] = useState<PolicyLink[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPolicyLinks(scope)
      .then((rows) => {
        if (!cancelled) setLinks(rows);
      })
      // A failed read must not block signup or checkout — no links, no box,
      // and the sale still happens.
      .catch(() => {
        if (!cancelled) setLinks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  return {
    links: links ?? [],
    /** null while loading — the caller shouldn't gate on an unknown answer. */
    loading: links === null,
    required: (links?.length ?? 0) > 0,
  };
}

export function PolicyConsent({
  links,
  checked,
  onChange,
  className,
  verb = "I agree to the",
}: {
  links: PolicyLink[];
  checked: boolean;
  onChange: (next: boolean) => void;
  className?: string;
  verb?: string;
}) {
  if (links.length === 0) return null;

  return (
    <label
      className={className}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "0.55rem",
        cursor: "pointer",
        fontSize: "0.8125rem",
        lineHeight: 1.5,
        color: "var(--sm-ink-soft)",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{
          marginTop: "0.2rem",
          flexShrink: 0,
          width: "1rem",
          height: "1rem",
          cursor: "pointer",
          accentColor: "var(--sm-accent)",
        }}
      />
      <span>
        {verb}{" "}
        {links.map((link, i) => (
          <span key={link.slug}>
            {i > 0 && (i === links.length - 1 ? " and " : ", ")}
            <a
              href={`/${link.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{
                color: "var(--sm-ink)",
                fontWeight: 600,
                textDecoration: "underline",
              }}
            >
              {link.label}
            </a>
          </span>
        ))}
        .
      </span>
    </label>
  );
}
