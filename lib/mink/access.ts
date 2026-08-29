import "server-only";

import { eq } from "drizzle-orm";
import { minkStoreAccess } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { MinkRequestError } from "./errors";

export interface MinkStoreAccessState {
  enabled: boolean;
  draftingEnabled: boolean;
}

/** Fail-closed beta eligibility read. The environment flag remains the global kill switch. */
export async function getMinkStoreAccess(
  storeId: string,
): Promise<MinkStoreAccessState> {
  try {
    const rows = await withService((db) =>
      db
        .select({
          enabled: minkStoreAccess.enabled,
          draftingEnabled: minkStoreAccess.draftingEnabled,
        })
        .from(minkStoreAccess)
        .where(eq(minkStoreAccess.storeId, storeId))
        .limit(1),
    );
    return {
      enabled: rows[0]?.enabled === true,
      draftingEnabled:
        rows[0]?.enabled === true && rows[0]?.draftingEnabled === true,
    };
  } catch {
    return { enabled: false, draftingEnabled: false };
  }
}

export async function isMinkStoreInvited(storeId: string): Promise<boolean> {
  return (await getMinkStoreAccess(storeId)).enabled;
}

export async function requireMinkStoreInvite(
  storeId: string,
  requireInvite: boolean,
): Promise<MinkStoreAccessState> {
  if (!requireInvite) return { enabled: true, draftingEnabled: false };
  const access = await getMinkStoreAccess(storeId);
  if (access.enabled) return access;
  throw new MinkRequestError(
    "mink_beta_not_invited",
    "Mink AI is currently available only to invited beta stores.",
    403,
  );
}
