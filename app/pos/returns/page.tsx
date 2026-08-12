import { redirect } from "next/navigation";

// The returns LOOKUP merged into the counter screen (app/pos/orders): it and the
// collections queue were two search boxes for the same moment — a customer at
// the counter holding an order number, who does not know which of our two
// screens their visit belongs to.
//
// The return DETAIL screen stays here, at /pos/returns/[orderId], and is still
// where "Take return" goes. Only the front door moved.
//
// 307, not 308 — see the note in app/pos/pickups/page.tsx.
export default function PosReturnsRedirect() {
  redirect("/pos/pickups");
}
