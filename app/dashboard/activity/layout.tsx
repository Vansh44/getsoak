import { Suspense } from "react";
import { LogsRail } from "./logs-rail";

// The Logs hub. Every log type renders inside this shell, so the rail is the
// one navigation between them and each page only has to render its own table.
//
// The rail is NOT duplicated in the dashboard sidebar: `activity` used to
// carry three `children` there, which meant two competing navigations for the
// same five destinations. The sidebar now links here and this rail takes over.
export default function LogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col lg:flex-row lg:gap-6">
      {/* useSearchParams needs a boundary — without it this opts the whole
          subtree into client-side bailout during rendering. */}
      <Suspense fallback={<div className="mb-4 shrink-0 lg:mb-0 lg:w-52" />}>
        <LogsRail />
      </Suspense>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
