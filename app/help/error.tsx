"use client";

export default function HelpError({
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <main className="hc-main">
      <div className="hc-wrap hc-empty" role="alert">
        <h1>Help Centre is temporarily unavailable</h1>
        <p>We couldn&apos;t load the guides. Please try again in a moment.</p>
        <button className="hc-retry" type="button" onClick={unstable_retry}>
          Try again
        </button>
        <p>
          Still having trouble? Email{" "}
          <a href="mailto:support@storemink.com">support@storemink.com</a>.
        </p>
      </div>
    </main>
  );
}
