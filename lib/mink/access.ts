import "server-only";

import { eq } from "drizzle-orm";
import { minkStoreAccess } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { MinkRequestError } from "./errors";

/** Fail-closed beta eligibility read. The environment flag remains the global kill switch. */
export async function isMinkStoreInvited(storeId: string): Promise<boolean> {
  try {
    const rows = await withService((db) =>
      db
        .select({ enabled: minkStoreAccess.enabled })
        .from(minkStoreAccess)
        .where(eq(minkStoreAccess.storeId, storeId))
        .limit(1),
    );
    return rows[0]?.enabled === true;
  } catch {
    return false;
  }
}

export async function requireMinkStoreInvite(
  storeId: string,
  requireInvite: boolean,
): Promise<void> {
  if (!requireInvite || (await isMinkStoreInvited(storeId))) return;
  throw new MinkRequestError(
    "mink_beta_not_invited",
    "Mink AI is currently available only to invited beta stores.",
    403,
  );
}
