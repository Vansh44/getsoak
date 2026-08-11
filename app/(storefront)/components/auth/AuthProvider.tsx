"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import type { User as FirebaseUser } from "firebase/auth";
import {
  getMyCustomerSession,
  type MyCustomer,
} from "@/app/actions/customer-profile";

type Customer = MyCustomer;

type FirebaseModules = readonly [
  typeof import("firebase/auth"),
  typeof import("@/lib/auth/firebase-client"),
];

let firebaseModulesPromise: Promise<FirebaseModules> | null = null;

// Firebase Auth is needed immediately for a returning shopper with a server
// session, but not for an anonymous catalog visit. Keeping both imports behind
// this boundary removes the SDK and its auth iframe from the anonymous
// storefront's critical path; opening the account UI starts it on demand.
function loadFirebaseModules(): Promise<FirebaseModules> {
  firebaseModulesPromise ??= Promise.all([
    import("firebase/auth"),
    import("@/lib/auth/firebase-client"),
  ]);
  return firebaseModulesPromise;
}

// Provider-agnostic identity exposed to consumers (maps the Firebase User's
// uid/email/phoneNumber onto the id/email/phone the storefront reads), so no
// consumer needs to know which auth provider is behind it.
export type AuthUser = {
  id: string;
  email: string | null;
  phone: string | null;
};

function toAuthUser(u: FirebaseUser | null): AuthUser | null {
  return u ? { id: u.uid, email: u.email, phone: u.phoneNumber } : null;
}

type AuthContextType = {
  user: AuthUser | null;
  customer: Customer | null;
  loading: boolean;
  isAuthModalOpen: boolean;
  openAuthModal: () => void;
  closeAuthModal: () => void;
  signOut: () => Promise<void>;
  refreshCustomer: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export default function AuthProvider({
  children,
  initialHasSession = true,
}: {
  children: ReactNode;
  initialHasSession?: boolean;
}) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(initialHasSession);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const mountedRef = useRef(false);
  const authGenerationRef = useRef(0);
  const authStartPromiseRef = useRef<Promise<void> | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Reads the signed-in customer's own row via a server action (the browser
  // can't use the server-only Drizzle layer). Resolves identity server-side
  // from the session cookie, so no user id needs threading in.
  const fetchCustomer = useCallback(async (fbUser: FirebaseUser | null) => {
    try {
      let res = await getMyCustomerSession();

      // ★ SELF-HEAL A LAPSED SESSION COOKIE. `sm_session` lasts 14 days while
      // the client SDK's own persistence is indefinite, so a shopper who comes
      // back after a fortnight has a browser that is still signed in and a
      // server that no longer agrees — and gets asked to sign in again, over a
      // checkout they were part-way through. The refresh token is still valid,
      // which is what "still signed in" MEANS, so mint a fresh cookie from it
      // and retry ONCE.
      //
      // Only `no-session` qualifies: a store admin browsing their own
      // storefront has a valid cookie and no `users` row (`no-row`), and an
      // outage is `unavailable`. A new cookie fixes neither, so retrying on
      // those would buy nothing and cost every page load a wasted round-trip.
      if (res.status === "no-session" && fbUser) {
        // forceRefresh, so a revoked or disabled account fails HERE rather than
        // minting a session cookie from a stale cached token.
        const { establishSession } = await import("@/lib/auth/firebase-client");
        const err = await establishSession(true);
        if (!err) res = await getMyCustomerSession();
      }

      setCustomer(res.customer);
    } catch {
      // A failed round-trip is not a sign-out — keep whatever row we already
      // had rather than presenting a signed-in shopper as anonymous. `loading`
      // still settles below, so nothing waits on it forever.
    }
  }, []);

  // Resolve from the *live* Firebase session rather than the `user` React state.
  // Right after the modal verifies + establishes the session cookie it calls
  // this before onAuthStateChanged has propagated, so reading currentUser
  // directly keeps both bits of state in sync.
  const refreshCustomer = useCallback(async () => {
    const { getFirebaseAuth } = await import("@/lib/auth/firebase-client");
    const current = getFirebaseAuth().currentUser;
    setUser(toAuthUser(current));
    if (current) {
      await fetchCustomer(current);
    } else {
      setCustomer(null);
    }
  }, [fetchCustomer]);

  const startAuth = useCallback(() => {
    if (authStartPromiseRef.current) return authStartPromiseRef.current;

    setLoading(true);
    const generation = ++authGenerationRef.current;
    const startPromise = loadFirebaseModules()
      .then(([{ onAuthStateChanged }, { getFirebaseAuth }]) => {
        if (!mountedRef.current || generation !== authGenerationRef.current) {
          return;
        }

        unsubscribeRef.current = onAuthStateChanged(
          getFirebaseAuth(),
          (fbUser) => {
            if (
              !mountedRef.current ||
              generation !== authGenerationRef.current
            ) {
              return;
            }
            setUser(toAuthUser(fbUser));
            if (fbUser) {
              // `loading` clears only once the customer row has landed. This
              // prevents signed-in consumers from observing a false anonymous
              // state between Firebase restoration and the profile read.
              fetchCustomer(fbUser).finally(() => {
                if (
                  mountedRef.current &&
                  generation === authGenerationRef.current
                ) {
                  setLoading(false);
                }
              });
            } else {
              setCustomer(null);
              setLoading(false);
            }
          },
        );
      })
      .catch(() => {
        if (mountedRef.current && generation === authGenerationRef.current) {
          setLoading(false);
          authStartPromiseRef.current = null;
        }
      });

    authStartPromiseRef.current = startPromise;
    return startPromise;
  }, [fetchCustomer]);

  useEffect(() => {
    mountedRef.current = true;
    if (initialHasSession) void startAuth();

    return () => {
      mountedRef.current = false;
      authGenerationRef.current += 1;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      authStartPromiseRef.current = null;
    };
  }, [initialHasSession, startAuth]);

  const openAuthModal = useCallback(() => {
    setIsAuthModalOpen(true);
    void startAuth();
  }, [startAuth]);
  const closeAuthModal = useCallback(() => setIsAuthModalOpen(false), []);

  const signOut = useCallback(async () => {
    // Clear local UI state immediately so the header updates without waiting on
    // the network, then tear down both the client session and the server cookie.
    setUser(null);
    setCustomer(null);
    const { endSession } = await import("@/lib/auth/firebase-client");
    await endSession();
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        customer,
        loading,
        isAuthModalOpen,
        openAuthModal,
        closeAuthModal,
        signOut,
        refreshCustomer,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
