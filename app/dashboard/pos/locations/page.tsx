import { redirect } from "next/navigation";

// Locations graduated out of the POS section (docs/locations-ia.md): POS is one
// capability OF a location, not its owner. Merchants have this URL bookmarked
// and in muscle memory, so it redirects rather than 404s.
export default function MovedToLocations() {
  redirect("/dashboard/locations");
}
