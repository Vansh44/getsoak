import { redirect } from "next/navigation";

// Collections merged into the counter screen — see app/pos/orders/orders-client.tsx
// for why. This stays as a door because `revalidatePath` calls, the acceptance
// doc and any till someone left open still name it.
//
// TEMPORARY (307), deliberately: `redirect()` issues one, and a 308 is cached by
// browsers indefinitely — the trap proxy.ts already had to work around with
// `Cache-Control: no-store`. There are no SEO signals to consolidate on a path
// behind a login, so a permanent redirect buys nothing and costs reversibility.
export default function PosPickupsRedirect() {
  redirect("/pos/orders");
}
