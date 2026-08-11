// The shared chrome for every POS screen that is not the register itself.
//
// It exists because the five screens each hand-rolled a header, and they had
// drifted: three different back arrows (ArrowLeft in a 9×9 box, ChevronLeft,
// and inventory's own), two different page backgrounds (`bg-neutral-950` over
// the layout's `bg-[#0b0f14]`), and two different title sizes. None of that was
// a decision — it was five people solving the same problem five times.
//
// There is no back button, deliberately. Back-to-/pos was the only way out of
// these screens, which made every switch a three-tap trip through a page whose
// entire content was "You're signed in". The rail (or the hamburger, below
// `lg`) is the way out now, and it goes anywhere in one tap.
//
// The title is `lg`-only: below that the nav's own top bar already names the
// screen, and two titles stacked on a phone is just lost height.

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
      {/* With actions the header has to render at every size; without them it
          would be an empty bar on a phone, so it waits for the wide layout. */}
      <header
        className={`h-14 shrink-0 items-center gap-3 border-b border-white/10 px-4 ${
          actions ? "flex" : "hidden lg:flex"
        }`}
      >
        <h1 className="hidden shrink-0 text-lg font-semibold lg:block">
          {title}
        </h1>
        {subtitle && (
          <span className="hidden truncate text-sm text-white/45 lg:block">
            {subtitle}
          </span>
        )}
        {actions && (
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`${body} p-4`}>{children}</div>
      </div>
    </>
  );
}
