import { redirect } from "next/navigation";
import { getPlatformViewer } from "@/app/actions/platform";
import {
  listHelpArticlesAdmin,
  listHelpCategoriesAdmin,
} from "@/app/actions/help-actions";
import { HELP_URL } from "@/lib/site";
import { HelpConsole } from "./help-console";

export const metadata = { title: "Help Centre · StoreMink Admin" };
export const dynamic = "force-dynamic";

export default async function HelpAdminPage() {
  const viewer = await getPlatformViewer();
  if (!viewer) redirect("/dashboard/login");

  const [articles, categories] = await Promise.all([
    listHelpArticlesAdmin(),
    listHelpCategoriesAdmin(),
  ]);

  return (
    <HelpConsole
      initialArticles={articles}
      initialCategories={categories}
      helpBaseUrl={HELP_URL}
    />
  );
}
