import { redirect } from "next/navigation";

// The counter screen is /pos/pickups now — "Orders" at a till reads as the
// sales you rang, which is a different screen (/pos/sales). It briefly lived
// here, so the path keeps working.
//
// 307, not 308 — see the note in app/pos/returns/page.tsx.
export default function PosOrdersRedirect() {
  redirect("/pos/pickups");
}
