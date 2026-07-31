"use server";

import { eq } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { withService } from "@/lib/db/client";
import { stores } from "@/drizzle/schema";
import { getActingStoreId, getManagerUserId } from "@/app/dashboard/lib/access";
import { STORE_TAG } from "@/lib/store/resolve";
import { ROOT_DOMAIN } from "@/lib/store/host";
import { brandFromSettings, type StoreBrand } from "@/lib/store/brand";

export interface ActionResult {
  success?: boolean;
  error?: string;
}

// Current brand for the acting admin's store (full object incl. defaults),
// used to pre-fill the dashboard editor.
export async function getStoreBrandingForEditor(): Promise<StoreBrand> {
  const storeId = await getActingStoreId();
  let row:
    | {
        name: string;
        settings: unknown;
        slug: string;
        custom_domain: string | null;
      }
    | undefined;
  try {
    [row] = await withService((db) =>
      db
        .select({
          name: stores.name,
          settings: stores.settings,
          slug: stores.slug,
          custom_domain: stores.customDomain,
        })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1),
    );
  } catch (err) {
    console.error("getStoreBrandingForEditor:", err);
  }
  const domain = row?.custom_domain || `${row?.slug || "store"}.${ROOT_DOMAIN}`;
  return brandFromSettings(
    (row?.settings as Record<string, unknown>) ?? {},
    row?.name ?? "Store",
    domain,
  );
}

function clean(v: FormDataEntryValue | null): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}

// Persist branding from the dashboard editor. Merges into settings.brand,
// preserves any other settings (and badges, which the editor doesn't expose
// yet), and busts the store-lookup cache so the storefront updates at once.
export async function saveStoreBranding(
  formData: FormData,
): Promise<ActionResult> {
  const storeId = await getActingStoreId();

  const name = clean(formData.get("name"));
  if (!name) return { error: "Store name is required." };

  let settings: Record<string, unknown>;
  try {
    const [store] = await withService((db) =>
      db
        .select({ settings: stores.settings })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1),
    );
    settings = ((store?.settings as Record<string, unknown>) ?? {}) as Record<
      string,
      unknown
    >;
  } catch (err) {
    console.error("saveStoreBranding read:", err);
    return { error: "Could not save branding. Please try again." };
  }
  const existingBrand = (settings.brand as Record<string, unknown>) ?? {};

  const brand = {
    ...existingBrand, // keep fields the editor doesn't manage (e.g. badges)
    name,
    logoUrl: clean(formData.get("logoUrl")),
    primaryColor: clean(formData.get("primaryColor")) ?? "#1f7a5a",
    tagline: clean(formData.get("tagline")),
    blurb: clean(formData.get("blurb")),
    legalName: clean(formData.get("legalName")),
    creditLine: clean(formData.get("creditLine")),
    email: clean(formData.get("email")),
    phone: clean(formData.get("phone")),
    hours: clean(formData.get("hours")),
    social: {
      instagram: clean(formData.get("instagram")),
      youtube: clean(formData.get("youtube")),
      whatsapp: clean(formData.get("whatsapp")),
    },
  };

  try {
    await withService((db) =>
      db
        .update(stores)
        .set({ settings: { ...settings, brand }, name })
        .where(eq(stores.id, storeId)),
    );
  } catch (err) {
    console.error(
      "saveStoreBranding:",
      err instanceof Error ? err.message : err,
    );
    return { error: "Could not save branding. Please try again." };
  }

  revalidateTag(STORE_TAG, "max");
  return { success: true };
}

/**
 * Patch ONLY the appearance fields, for the website builder's Brand panel.
 *
 * saveStoreBranding rebuilds the whole brand object from a FormData carrying
 * every field, so calling it from a panel that edits two of them would blank
 * the merchant's email, social links and legal name. This merges instead, and
 * touches nothing it wasn't given.
 */
export async function saveBrandAppearance(input: {
  primaryColor?: string;
  logoUrl?: string | null;
}): Promise<ActionResult> {
  const userId = await getManagerUserId("builder");
  if (!userId) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();

  let settings: Record<string, unknown>;
  try {
    const [store] = await withService((db) =>
      db
        .select({ settings: stores.settings })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1),
    );
    settings = ((store?.settings as Record<string, unknown>) ?? {}) as Record<
      string,
      unknown
    >;
  } catch (err) {
    console.error("saveBrandAppearance read:", err);
    return { error: "Could not save. Please try again." };
  }

  const existingBrand = (settings.brand as Record<string, unknown>) ?? {};
  const brand: Record<string, unknown> = { ...existingBrand };
  // A colour renders into an inline style attribute, so validate rather than
  // trust: anything that isn't a hex is dropped, not written through.
  if (input.primaryColor && /^#[0-9a-fA-F]{6}$/.test(input.primaryColor)) {
    brand.primaryColor = input.primaryColor;
  }
  if (input.logoUrl !== undefined) {
    brand.logoUrl = input.logoUrl || null;
  }

  try {
    await withService((db) =>
      db
        .update(stores)
        .set({ settings: { ...settings, brand } })
        .where(eq(stores.id, storeId)),
    );
  } catch (err) {
    console.error("saveBrandAppearance write:", err);
    return { error: "Could not save. Please try again." };
  }

  revalidateTag(STORE_TAG, "max");
  return { success: true };
}
