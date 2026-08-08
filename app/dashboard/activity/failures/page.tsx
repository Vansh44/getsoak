import { requireSectionAccess } from "../../lib/access";
import { pickParam } from "../../lib/list-params";
import { getCurrentStoreId } from "@/lib/store/resolve";
import {
  FAILURE_SOURCES,
  collectFailures,
  type FailureSourceKey,
} from "@/lib/logs/failures";
import { FailuresView } from "./failures-view";

// Failures — the fifth log, and the only one that reads across the others.
//
// Same `activity` permission as its siblings (see permissions.ts): "what
// didn't work" is the same class of question as "what happened" and "what did
// we send", asked by the same person.
//
// ★ SCOPE IS EXPLICIT. collectFailures runs under `withService`, which bypasses
// RLS, so this store id is the only thing keeping one merchant's failures out
// of another's view — hence the discriminated union rather than an optional
// field (lib/logs/failures.ts explains why).
export default async function FailuresPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSectionAccess("activity", "view");

  const sp = await searchParams;
  const sourceParam = pickParam(sp.source);
  const valid = FAILURE_SOURCES.some((s) => s.key === sourceParam);
  const source = valid ? (sourceParam as FailureSourceKey) : "";

  const storeId = await getCurrentStoreId();
  const { rows, failedSources } = await collectFailures(
    { kind: "store", storeId },
    { sources: source ? [source] : undefined },
  );

  return (
    <FailuresView rows={rows} source={source} failedSources={failedSources} />
  );
}
