import { requireSectionAccess } from "@/app/dashboard/lib/access";
import { getStorePolicies } from "@/app/actions/store-policy-actions";
import { STORE_POLICIES } from "@/lib/legal/store-policies";
import { PoliciesView } from "./policies-view";

// Settings → Policies. The store's OWN policies (its contract with its
// shoppers), not StoreMink's — see lib/legal/store-policies.ts for why the two
// are built completely differently.
export default async function PoliciesSettingsPage() {
  await requireSectionAccess("settings", "view");

  const policies = await getStorePolicies();

  // Prompts live in the registry (pure, server-safe) and are passed down so
  // the client bundle doesn't import the whole module.
  const prompts = Object.fromEntries(
    STORE_POLICIES.map((p) => [p.kind, p.prompts]),
  );

  return <PoliciesView policies={policies} prompts={prompts} />;
}
