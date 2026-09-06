import { MinkWatchManager } from "./watch-manager";

export default function MinkWatchesPage() {
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
      <header>
        <h1 className="text-2xl font-semibold">Mink watches</h1>
        <p className="mt-2 text-muted-foreground">
          Private daily or weekly checks, enabled by you. No automatic changes
          to your business.
        </p>
      </header>
      <MinkWatchManager />
    </main>
  );
}
