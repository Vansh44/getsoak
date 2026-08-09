import { getCurrentStore } from "@/lib/store/resolve";
import { effectivePlan } from "@/lib/plans";
import {
  resolveStoreSettings,
  type SettingKey,
  type StoreSettingValues,
} from "./registry";

// Feature settings for the CURRENT request's store (resolved from the host).
// Piggybacks on the cached store lookup in lib/store/resolve — no extra query —
// so a settings change appears once STORE_TAG is revalidated. Plan-gated
// settings resolve against the EFFECTIVE plan (timed plans lapse to free).
export async function getStoreSettings(): Promise<StoreSettingValues> {
  const store = await getCurrentStore();
  return resolveStoreSettings(store.settings, effectivePlan(store));
}

// Convenience: one resolved setting for the current store.
export async function getStoreSetting(
  key: SettingKey,
): Promise<StoreSettingValues[SettingKey]> {
  return (await getStoreSettings())[key];
}
