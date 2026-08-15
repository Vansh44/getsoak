// The log-type rail — the one list of what "Logs" contains.
//
// A registry rather than markup in the layout, because three things have to
// agree on this list: the rail itself, the hub's empty/landing copy, and the
// sidebar entry. Adding a log type should be one entry here.
//
// Client-safe: labels, hrefs and icon names only, no server imports.

export interface LogType {
  key: string;
  label: string;
  href: string;
  /** lucide-react icon name, resolved in logs-rail.tsx. The union spans BOTH
   *  consoles' registries — the operator console has an announcements log the
   *  merchant one does not. */
  icon:
    | "activity"
    | "mail"
    | "message"
    | "download"
    | "upload"
    | "alert"
    | "megaphone";
  /** One line under the heading, so a rail entry explains itself. */
  blurb: string;
}

export const LOG_TYPES: LogType[] = [
  {
    key: "activity",
    label: "Activity",
    href: "/dashboard/logs",
    icon: "activity",
    blurb: "Everything that happened in this store.",
  },
  {
    key: "email",
    label: "Email logs",
    href: "/dashboard/logs/email-logs",
    icon: "mail",
    blurb: "Every message sent, and what was in it.",
  },
  {
    key: "sms",
    label: "SMS logs",
    href: "/dashboard/logs/sms-logs",
    icon: "message",
    blurb: "Every text sent, and what it cost.",
  },
  {
    // Import and Export are ONE page filtered two ways — `data_jobs.kind`
    // already separates them, so this costs a query param rather than a route.
    key: "imports",
    label: "Import logs",
    href: "/dashboard/logs/import-export?kind=import",
    icon: "download",
    blurb: "Files brought in, and what they changed.",
  },
  {
    key: "exports",
    label: "Export logs",
    href: "/dashboard/logs/import-export?kind=export",
    icon: "upload",
    blurb: "Files taken out.",
  },
  {
    key: "failures",
    label: "Failures",
    href: "/dashboard/logs/failures",
    icon: "alert",
    blurb: "Everything that didn't work, in one place.",
  },
];

/**
 * Which rail entry is active for a given path + `kind`.
 *
 * Import and Export share a pathname, so the query string is part of the
 * answer: without it both rail entries light up on either page. An unknown
 * `kind` on that path resolves to Imports, matching what the page shows when
 * the param is absent or invalid.
 */
export function activeLogKey(pathname: string, kind?: string): string {
  if (pathname.startsWith("/dashboard/logs/import-export")) {
    return kind === "export" ? "exports" : "imports";
  }
  if (pathname.startsWith("/dashboard/logs/email-logs")) return "email";
  if (pathname.startsWith("/dashboard/logs/sms-logs")) return "sms";
  if (pathname.startsWith("/dashboard/logs/failures")) return "failures";
  return "activity";
}
