import { notFound } from "next/navigation";
import { requireSectionAccess } from "@/app/dashboard/lib/access";
import { getMerchantAnalyticsSettingsForEditor } from "@/app/actions/merchant-analytics-settings";
import { HELP_URL } from "@/lib/site";
import { MerchantAnalyticsSettingsView } from "./merchant-analytics-settings-view";

export const metadata = { title: "Analytics tracking settings" };

export default async function AnalyticsTrackingSettingsPage() {
  await requireSectionAccess("settings", "view");
  const editor = await getMerchantAnalyticsSettingsForEditor();
  if (!editor) notFound();

  return (
    <MerchantAnalyticsSettingsView
      initial={editor}
      ga4HelpUrl={`${HELP_URL}/help/analytics/connect-google-analytics-4`}
      metaHelpUrl={`${HELP_URL}/help/analytics/connect-meta-pixel`}
    />
  );
}
