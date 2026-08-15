import type { LogType } from "@/app/dashboard/logs/log-types";

// ---------------------------------------------------------------------------
// What "Logs" contains ON THE OPERATOR CONSOLE.
//
// ★ IT IS NOT THE MERCHANT'S LIST, AND IT MUST NOT BE. `LOG_TYPES` in
// app/dashboard/logs carries Activity, Import and Export — none of which the
// platform has: `activity_events` is store-scoped (a cross-store feed of every
// event on the platform would be noise, not a log), and CSV jobs belong to a
// merchant's catalogue. Rendering the merchant registry here would have put
// three rail entries in front of routes that 404.
//
// The reverse is also true: the FAILURES feed here is scoped
// `{ kind: "platform" }` — every store at once — which is the one view a
// merchant must never have.
//
// Adding an operator log should be one entry here.
// ---------------------------------------------------------------------------

export const PLATFORM_LOG_TYPES: LogType[] = [
  {
    key: "email",
    label: "Email logs",
    href: "/dashboard/logs/email-logs",
    icon: "mail",
    blurb: "Every message the platform sent, including signup codes.",
  },
  {
    key: "sms",
    label: "SMS logs",
    href: "/dashboard/logs/sms-logs",
    icon: "message",
    blurb: "Every text the platform sent, and what it cost.",
  },
  {
    key: "failures",
    label: "Failures",
    href: "/dashboard/logs/failures",
    icon: "alert",
    blurb: "Everything that didn't work, across every store.",
  },
];
