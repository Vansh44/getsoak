import {
  FAILURE_SOURCES,
  collectFailures,
  storeNamesFor,
  type FailureSourceKey,
} from "@/lib/logs/failures";
import { FailuresView } from "@/app/dashboard/logs/failures/failures-view";
import { requireOperator } from "../../require-operator";

export const metadata = { title: "Failures — StoreMink Admin" };

// Cross-store failures, for operators.
//
// ★ THIS IS THE ONLY PLACE `{ kind: "platform" }` IS CONSTRUCTED. It drops the
// store filter, so the gate below is the whole of the access control — hence
// `requireOperator()` on the page itself (the layout's redirect does not abort
// a concurrently-rendering page), and hence its living under app/platform/,
// which only ever renders on
// storemink.com (proxy.ts). A merchant host can't reach this route.
//
// ⚠ It still shows only MERCHANT-READABLE failures — the same sources the
// store view reads. Stack traces and platform internals stay in Cloud Logging
// / Error Reporting, which already group and alert on them; duplicating them
// into a table would be a second, worse copy that nobody prunes.
export default async function PlatformFailuresPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator();

  const sp = await searchParams;
  const raw = Array.isArray(sp.source) ? sp.source[0] : sp.source;
  const valid = FAILURE_SOURCES.some((s) => s.key === raw);
  const source = valid ? (raw as FailureSourceKey) : "";

  const { rows, failedSources } = await collectFailures(
    { kind: "platform" },
    { sources: source ? [source] : undefined },
  );

  const storeNames = await storeNamesFor(
    rows.map((r) => r.storeId).filter((id): id is string => Boolean(id)),
  );

  return (
    <FailuresView
      rows={rows}
      source={source}
      failedSources={failedSources}
      storeNames={storeNames}
    />
  );
}
