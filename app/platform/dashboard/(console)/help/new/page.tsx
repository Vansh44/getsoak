import { redirect } from "next/navigation";
import { getPlatformViewer } from "@/app/actions/platform";
import { listHelpCategoriesAdmin } from "@/app/actions/help-actions";
import { ArticleEditor } from "../article-editor";

export const metadata = { title: "New article · StoreMink Help" };
export const dynamic = "force-dynamic";

export default async function NewHelpArticlePage() {
  const viewer = await getPlatformViewer();
  if (!viewer) redirect("/dashboard/login");

  const categories = await listHelpCategoriesAdmin();
  return <ArticleEditor articleId={null} categories={categories} />;
}
