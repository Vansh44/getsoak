// The Logs hub. Every log type renders inside this shell, so each page only has
// to render its own table.
//
// ★ THE NAVIGATION IS NOT HERE — it is the dashboard SIDEBAR, which swaps its
// main nav for the logs rail while you are in this section (the same sub-nav
// panel Settings and Blogs use). This layout used to render the rail as a second
// column, which put three levels of navigation on screen at once: the dashboard
// nav, the rail, and the page's own filters. One section, one navigation.
export default function LogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="min-w-0">{children}</div>;
}
