import { requireSectionAccess } from "@/app/dashboard/lib/access";
import { getDomainConnectionState } from "@/app/actions/store-domain";
import { ROOT_DOMAIN } from "@/lib/store/host";
import { DomainSettingsView } from "./domain-settings-view";

export default async function DomainSettingsPage() {
  await requireSectionAccess("settings", "view");

  // One call covers entitlement, connection state and the records still
  // outstanding. It is read-only apart from idempotent provisioning progress,
  // so loading the page cannot create anything the merchant didn't ask for.
  const initial = await getDomainConnectionState();

  return <DomainSettingsView initial={initial} rootDomain={ROOT_DOMAIN} />;
}
