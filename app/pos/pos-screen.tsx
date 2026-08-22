// The shared chrome for every POS screen that is not the register itself.
//
// It exists because the five screens each hand-rolled a header, and they had
// drifted: three different back arrows (ArrowLeft in a 9×9 box, ChevronLeft,
// and inventory's own), two different page backgrounds (`bg-neutral-950` over
// the layout's `bg-[var(--pos-bg)]`), and two different title sizes. None of that was
// a decision — it was five people solving the same problem five times.
//
// There is no back button, deliberately. Back-to-/pos was the only way out of
// these screens, which made every switch a three-tap trip through a page whose
// entire content was "You're signed in". The hamburger is the way out now, and
// it goes anywhere in one tap.
//
// ★ THE TITLE IS NOT DRAWN VISIBLY ANY MORE. It used to render on `lg`, where
// the nav had a rail instead of a top bar; now the top bar is at every width, so
// this would be a second bar stacked directly under it saying the same word —
// every `title` passed in is its nav label. It stays as an `sr-only` h1,
// because the visible one is in the nav, outside this landmark, and a page with
// no heading is a page a screen-reader user cannot orient in.
//
// The SUBTITLE does still render: "3 shown", a location name — the part the nav
// cannot know. It sits above the content rather than in a bar of its own.

export function PosScreen({
  title,
  subtitle,
  actions,
  children,
  /** Screens that read as a document (stock rows, a shift report) are easier to
   *  scan when the line length is capped; a queue of cards wants the width. */
  width = "wide",
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  width?: "narrow" | "wide" | "full";
}) {
  const body =
    width === "full"
      ? "w-full"
      : width === "narrow"
        ? "mx-auto w-full max-w-2xl"
        : "mx-auto w-full max-w-5xl";

  return (
    <>
      {/* Only when there is something to put in it. An empty bar under the nav's
          own is pure lost height, and on a till height is the product grid. */}
      {actions && (
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--pos-border)] px-4">
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </header>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`${body} p-4`}>
          {/* Not shown, but the page still needs a heading: the visible title
              lives in the nav's top bar, which is outside this landmark, so
              without this a screen reader lands on a document with no h1. */}
          <h1 className="sr-only">{title}</h1>
          {subtitle && (
            <p className="mb-3 truncate text-sm text-[var(--pos-ink-3)]">
              {subtitle}
            </p>
          )}
          {children}
        </div>
      </div>
    </>
  );
}
