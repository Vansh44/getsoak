"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { getMyAddresses } from "@/app/actions/address-actions";
import { useAuth } from "@/app/(storefront)/components/auth/AuthProvider";

const STORAGE_KEY = "storemink.delivery-location.v1";

export type DeliveryLocationSource = "manual" | "saved" | "current";

export interface DeliveryLocation {
  postalCode: string;
  city: string;
  state: string;
  label: string;
  source: DeliveryLocationSource;
}

type DeliveryLocationContextValue = {
  location: DeliveryLocation | null;
  locating: boolean;
  locationError: string;
  setPostalCode: (postalCode: string) => void;
  useCurrentLocation: () => void;
};

const DeliveryLocationContext =
  createContext<DeliveryLocationContextValue | null>(null);

function validPostalCode(value: unknown): value is string {
  return typeof value === "string" && /^\d{6}$/.test(value);
}

function readRememberedLocation(): DeliveryLocation | null {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "null",
    ) as Partial<DeliveryLocation> | null;
    if (!parsed || !validPostalCode(parsed.postalCode)) return null;
    return {
      postalCode: parsed.postalCode,
      city: typeof parsed.city === "string" ? parsed.city : "",
      state: typeof parsed.state === "string" ? parsed.state : "",
      label:
        typeof parsed.label === "string" && parsed.label.trim()
          ? parsed.label
          : parsed.postalCode,
      source:
        parsed.source === "saved" || parsed.source === "current"
          ? parsed.source
          : "manual",
    };
  } catch {
    return null;
  }
}

function rememberLocation(location: DeliveryLocation) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(location));
  } catch {
    // Storage can be unavailable in private/restricted browser contexts. The
    // location still works for the current page session.
  }
}

// useSyncExternalStore gives localStorage a stable server snapshot (null) and
// then hydrates from the browser without a state-setting mount effect.
let rememberedLocation: DeliveryLocation | null = null;
let rememberedLocationLoaded = false;
const rememberedLocationListeners = new Set<() => void>();

function getRememberedLocationSnapshot() {
  if (!rememberedLocationLoaded && typeof window !== "undefined") {
    rememberedLocation = readRememberedLocation();
    rememberedLocationLoaded = true;
  }
  return rememberedLocation;
}

function subscribeRememberedLocation(listener: () => void) {
  rememberedLocationListeners.add(listener);
  return () => rememberedLocationListeners.delete(listener);
}

function publishLocation(location: DeliveryLocation) {
  rememberedLocation = location;
  rememberedLocationLoaded = true;
  rememberLocation(location);
  rememberedLocationListeners.forEach((listener) => listener());
}

type ReverseGeocodeResult = {
  city?: string;
  locality?: string;
  principalSubdivision?: string;
  postcode?: string;
};

async function describeCoordinates(lat: number, lng: number) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    localityLanguage: "en",
  });
  const response = await fetch(
    `https://api.bigdatacloud.net/data/reverse-geocode-client?${params}`,
  );
  if (!response.ok) throw new Error("reverse geocoding failed");
  const result = (await response.json()) as ReverseGeocodeResult;
  const postalCode = String(result.postcode ?? "").replace(/\D/g, "");
  if (!validPostalCode(postalCode)) {
    throw new Error("postal code unavailable");
  }
  const city = result.city || result.locality || "";
  const state = result.principalSubdivision || "";
  return {
    postalCode,
    city,
    state,
    label: [city, state].filter(Boolean).join(", ") || postalCode,
    source: "current" as const,
  };
}

export function DeliveryLocationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { user, loading } = useAuth();
  const location = useSyncExternalStore(
    subscribeRememberedLocation,
    getRememberedLocationSnapshot,
    () => null,
  );
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");

  // A saved default address is the closest equivalent to Flipkart's automatic
  // delivery location: it is accurate, needs no permission prompt, and follows
  // the shopper between devices. A deliberate manual/current choice on this
  // browser wins until the shopper changes it again.
  useEffect(() => {
    if (loading || !user) return;
    let cancelled = false;
    void getMyAddresses().then((addresses) => {
      if (cancelled) return;
      const current = getRememberedLocationSnapshot();
      if (current?.source === "manual" || current?.source === "current") return;
      const saved =
        addresses.find((address) => address.is_default) ?? addresses[0];
      if (!saved || !validPostalCode(saved.postal_code)) return;
      publishLocation({
        postalCode: saved.postal_code,
        city: saved.city,
        state: saved.state,
        label:
          [saved.city, saved.state].filter(Boolean).join(", ") ||
          saved.postal_code,
        source: "saved",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [loading, user]);

  const setPostalCode = useCallback((postalCode: string) => {
    const normalized = postalCode.replace(/\D/g, "").slice(0, 6);
    if (!validPostalCode(normalized)) return;
    const next: DeliveryLocation = {
      postalCode: normalized,
      city: "",
      state: "",
      label: normalized,
      source: "manual",
    };
    publishLocation(next);
    setLocationError("");
  }, []);

  const useCurrentLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationError(
        "This browser cannot share your location. Enter your PIN code instead.",
      );
      return;
    }
    setLocating(true);
    setLocationError("");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        void describeCoordinates(
          position.coords.latitude,
          position.coords.longitude,
        )
          .then((next) => {
            publishLocation(next);
          })
          .catch(() => {
            setLocationError(
              "We found your location but not its PIN code. Enter the PIN code instead.",
            );
          })
          .finally(() => setLocating(false));
      },
      (error) => {
        setLocating(false);
        setLocationError(
          error.code === error.PERMISSION_DENIED
            ? "Location permission was denied. Enter your PIN code instead."
            : "We could not find your location. Enter your PIN code instead.",
        );
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  }, []);

  const value = useMemo(
    () => ({
      location,
      locating,
      locationError,
      setPostalCode,
      useCurrentLocation,
    }),
    [location, locating, locationError, setPostalCode, useCurrentLocation],
  );

  return (
    <DeliveryLocationContext.Provider value={value}>
      {children}
    </DeliveryLocationContext.Provider>
  );
}

export function useDeliveryLocation() {
  const context = useContext(DeliveryLocationContext);
  if (!context) {
    throw new Error(
      "useDeliveryLocation must be used within DeliveryLocationProvider",
    );
  }
  return context;
}
