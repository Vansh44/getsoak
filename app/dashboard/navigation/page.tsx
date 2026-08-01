import { redirect } from "next/navigation";

/**
 * Retired. Header and footer are edited inside the website builder, where they
 * sit beside a live preview and share the page's draft → publish flow.
 *
 * This route stays as a redirect rather than being deleted: it is linked from
 * bookmarks, from the sidebar of anyone with a stale tab open, and from the old
 * builder's own "Edit" affordance. A 404 would read as "the feature was
 * removed" — which is the opposite of what happened.
 *
 * Leaving it as a working SECOND editor was the alternative, and worse: two
 * screens writing the same data, one of them with no preview and no draft, is
 * exactly the split this redesign set out to remove.
 */
export default function NavigationPage() {
  redirect("/dashboard/builder");
}
