import Link from "next/link";
import { AlertTriangle, Mail, MessageSquare } from "lucide-react";
import { requireOperator } from "../require-operator";
import { PLATFORM_LOG_TYPES } from "./log-types";

export const metadata = { title: "Logs — StoreMink Admin" };

const ICONS = {
  mail: Mail,
  message: MessageSquare,
  alert: AlertTriangle,
} as const;

// The hub landing.
//
// ★ A LANDING RATHER THAN A REDIRECT TO THE FIRST LOG. The merchant hub can
// default to its Activity feed because it has one; the platform has no
// cross-store equivalent, so "Logs" would otherwise silently mean "Email logs"
// — which is both surprising and hides that the other two exist. Three cards
// is a cheap answer to "what is recorded here?".
export default async function PlatformLogsHub() {
  await requireOperator();

  return (
    <div className="w-full max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
          Logs
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          What the platform sent, and what didn&apos;t work.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        {PLATFORM_LOG_TYPES.map((type) => {
          const Icon = ICONS[type.icon as keyof typeof ICONS] ?? Mail;
          return (
            <Link
              key={type.key}
              href={type.href}
              className="group rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 hover:shadow"
            >
              <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-600 transition group-hover:bg-slate-900 group-hover:text-white">
                <Icon className="h-4 w-4" />
              </div>
              <div className="text-sm font-semibold text-slate-900">
                {type.label}
              </div>
              <p className="mt-1 text-sm text-slate-500">{type.blurb}</p>
            </Link>
          );
        })}
      </div>

      <p className="text-xs text-slate-400">
        Stack traces and platform internals stay in Cloud Logging and Error
        Reporting, which already group and alert on them. These logs are the
        merchant-readable record.
      </p>
    </div>
  );
}
