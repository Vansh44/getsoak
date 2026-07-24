import { redirect } from "next/navigation";
import { getPlatformViewer } from "@/app/actions/platform";
import { listHelpCategoriesAdmin } from "@/app/actions/help-actions";
import { ArticleEditor } from "../article-editor";

export const metadata = { title: "Edit article · StoreMink Help" };
export const dynamic = "force-dynamic";

export default async function EditHelpArticlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await getPlatformViewer();
  if (!viewer) redirect("/dashboard/login");

  const { id } = await params;
  const categories = await listHelpCategoriesAdmin();
  return <ArticleEditor articleId={id} categories={categories} />;
}
