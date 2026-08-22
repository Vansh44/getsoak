import "server-only";

import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { admins, platformAdmins, posStaff, users } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { parseHost } from "@/lib/store/host";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";

interface UploadIdentity {
  id: string;
  email: string | null;
}

export type UploadOwner =
  | { kind: "store"; storeId: string }
  | { kind: "platform" };

/**
 * Resolve and authorize who owns an upload. Authentication alone is not
 * enough: the shared StoreMink session cookie is valid on every subdomain, so
 * the caller must also belong to the requested store (or be an operator).
 */
export async function resolveUploadOwner(
  identity: UploadIdentity,
): Promise<UploadOwner | null> {
  const headerList = await headers();
  const host =
    headerList.get("x-forwarded-host") || headerList.get("host") || "";
  const kind = parseHost(host);

  if (kind.type === "platform") {
    if (!identity.email) return null;
    const operator = await withService((db) =>
      db
        .select({ id: platformAdmins.id })
        .from(platformAdmins)
        .where(eq(platformAdmins.email, identity.email!.trim().toLowerCase()))
        .limit(1),
    );
    return operator[0] ? { kind: "platform" } : null;
  }

  const store = await getCurrentStoreOrNull();
  if (!store) return null;

  const allowed = await withService(async (db) => {
    const [admin, customer, staff, operator] = await Promise.all([
      db
        .select({ id: admins.id })
        .from(admins)
        .where(and(eq(admins.storeId, store.id), eq(admins.id, identity.id)))
        .limit(1),
      db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.storeId, store.id), eq(users.id, identity.id)))
        .limit(1),
      db
        .select({ id: posStaff.id })
        .from(posStaff)
        .where(
          and(eq(posStaff.storeId, store.id), eq(posStaff.userId, identity.id)),
        )
        .limit(1),
      identity.email
        ? db
            .select({ id: platformAdmins.id })
            .from(platformAdmins)
            .where(
              eq(platformAdmins.email, identity.email.trim().toLowerCase()),
            )
            .limit(1)
        : Promise.resolve([]),
    ]);
    return Boolean(admin[0] || customer[0] || staff[0] || operator[0]);
  });

  return allowed ? { kind: "store", storeId: store.id } : null;
}
