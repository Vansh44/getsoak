"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { onAuthStateChanged, type User as FirebaseUser } from "firebase/auth";
import {
  getFirebaseAuth,
  endSession,
  establishSession,
} from "@/lib/auth/firebase-client";
import {
  getMyCustomerSession,
  type MyCustomer,
} from "@/app/actions/customer-profile";

type Customer = MyCustomer;

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

export default function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  // Reads the signed-in customer's own row via a server action (the browser
  // can't use the server-only Drizzle layer). Resolves identity server-side
  // from the session cookie, so no user id needs threading in.
  const fetchCustomer = useCallback(async () => {
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
      if (res.status === "no-session" && getFirebaseAuth().currentUser) {
        // forceRefresh, so a revoked or disabled account fails HERE rather than
        // minting a session cookie from a stale cached token.
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
    const current = getFirebaseAuth().currentUser;
    setUser(toAuthUser(current));
    if (current) {
      await fetchCustomer();
    } else {
      setCustomer(null);
    }
  }, [fetchCustomer]);

  useEffect(() => {
    let active = true;

    // Fires once on mount with the restored session (or null), then on every
    // sign-in / sign-out. Firebase's listener has no re-entrancy lock, so it's
    // safe to kick off the async customer fetch straight from the callback.
    const unsubscribe = onAuthStateChanged(getFirebaseAuth(), (fbUser) => {
      if (!active) return;
      setUser(toAuthUser(fbUser));
      if (fbUser) {
        // ★ `loading` clears only once the customer row has LANDED, not as soon
        // as Firebase answers. Clearing it early leaves a window where the
        // visitor is signed in but `customer` is still null — and every
        // consumer reads that pair as "signed out". That window is what popped
        // the auth modal over a signed-in checkout on every refresh (and
        // flashed "sign in to review" on product pages): the modal opened
        // before the fetch resolved, and nothing closes it afterwards.
        fetchCustomer().finally(() => {
          if (active) setLoading(false);
        });
      } else {
        setCustomer(null);
        setLoading(false);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [fetchCustomer]);

  const openAuthModal = useCallback(() => setIsAuthModalOpen(true), []);
  const closeAuthModal = useCallback(() => setIsAuthModalOpen(false), []);

  const signOut = useCallback(async () => {
    // Clear local UI state immediately so the header updates without waiting on
    // the network, then tear down both the client session and the server cookie.
    setUser(null);
    setCustomer(null);
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
