"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signInWithEmailAndPassword } from "firebase/auth";
import { Delete, Loader2, Mail, MapPin, ShieldAlert } from "lucide-react";
import {
  getFirebaseAuth,
  establishSession,
  firebaseAuthErrorMessage,
} from "@/lib/auth/firebase-client";
import {
  posLoginWithPin,
  requestPosCredentialReset,
} from "@/app/actions/pos-auth-actions";

export function PosLoginClient({
  deviceAuthorized,
  locationName,
}: {
  deviceAuthorized: boolean;
  locationName: string | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"pin" | "password">("pin");
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);
  // "Forgot?" — reuses the email already typed above.
  const [resetSent, setResetSent] = useState(false);

  const requestReset = () => {
    setError(null);
    if (!email.includes("@")) {
      setError("Enter your email above, then tap Forgot again.");
      return;
    }
    start(async () => {
      await requestPosCredentialReset(email);
      // Always confirms — the action never reveals whether the address exists.
      setResetSent(true);
    });
  };

  // --- Device not authorized: staff can't sign in here. ---
  if (!deviceAuthorized) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-sm text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-400/10 text-amber-300">
            <ShieldAlert className="h-7 w-7" strokeWidth={1.75} />
          </div>
          <h1 className="mt-4 text-lg font-semibold">
            Use your shop&apos;s register
          </h1>
          <p className="mt-2 text-sm text-white/60">
            If you&apos;ve already set up your account, it&apos;s ready — you
            just can&apos;t sell from this device. For security the register
            only runs on a device your store owner has authorized, so sign in on
            the one at your shop.
          </p>
          <p className="mt-3 text-sm text-white/50">
            Store owner? Sign in below to authorize this device.
          </p>
          <Link
            href="/auth/login"
            className="mt-5 inline-block rounded-lg bg-white px-4 py-2 text-sm font-semibold text-[#0b0f14] transition-opacity hover:opacity-90"
          >
            Store owner? Sign in
          </Link>
        </div>
      </div>
    );
  }

  const submitPin = () => {
    setError(null);
    start(async () => {
      const res = await posLoginWithPin(email, pin);
      if (res.error) {
        setError(res.error);
        setPin("");
        return;
      }
      router.replace("/pos");
      router.refresh();
    });
  };

  const submitPassword = async () => {
    setError(null);
    setBusy(true);
    try {
      await signInWithEmailAndPassword(
        getFirebaseAuth(),
        email.trim(),
        password,
      );
      const sessErr = await establishSession();
      if (sessErr) {
        setError(sessErr);
        setBusy(false);
        return;
      }
      router.replace("/pos");
      router.refresh();
    } catch (err) {
      setError(firebaseAuthErrorMessage(err) || "Couldn't sign in.");
      setBusy(false);
    }
  };

  const press = (d: string) => {
    if (pending) return;
    setError(null);
    setPin((p) => (p + d).slice(0, 8));
  };

  // Reset requested — generic confirmation (never reveals if the email exists).
  if (resetSent) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-sm text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10">
            <Mail className="h-7 w-7" strokeWidth={1.75} />
          </div>
          <h1 className="mt-4 text-lg font-semibold">Check your email</h1>
          <p className="mt-2 text-sm text-white/60">
            If <span className="text-white/80">{email}</span> belongs to a staff
            account here, we&apos;ve sent a link to reset your PIN or password.
            It expires in 1 hour.
          </p>
          <button
            type="button"
            onClick={() => setResetSent(false)}
            className="mt-5 text-sm text-white/60 underline-offset-4 hover:text-white hover:underline"
          >
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-xs">
        <div className="mb-6 text-center">
          <div className="text-lg font-semibold">Point of Sale</div>
          {locationName && (
            <div className="mt-1 flex items-center justify-center gap-1.5 text-sm text-white/60">
              <MapPin className="h-4 w-4" strokeWidth={2} />
              {locationName}
            </div>
          )}
        </div>

        {/* Mode toggle */}
        <div className="mb-5 flex rounded-xl bg-white/10 p-1 text-sm">
          {(["pin", "password"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`flex-1 rounded-lg py-1.5 font-medium transition-colors ${
                mode === m ? "bg-white text-[#0b0f14]" : "text-white/70"
              }`}
            >
              {m === "pin" ? "PIN" : "Password"}
            </button>
          ))}
        </div>

        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          inputMode="email"
          autoCapitalize="none"
          placeholder="Email"
          className="mb-4 w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-center text-sm outline-none placeholder:text-white/30 focus:border-white/40"
        />

        {error && (
          <p className="mb-4 text-center text-sm text-red-400">{error}</p>
        )}

        {mode === "pin" ? (
          <>
            <div className="mb-5 flex justify-center gap-2.5">
              {Array.from({ length: 8 }).map((_, i) => (
                <span
                  key={i}
                  className={`h-2.5 w-2.5 rounded-full transition-colors ${
                    i < pin.length ? "bg-white" : "bg-white/15"
                  }`}
                />
              ))}
            </div>
            <div className="grid grid-cols-3 gap-3">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                <KeypadButton key={d} onClick={() => press(d)}>
                  {d}
                </KeypadButton>
              ))}
              <KeypadButton
                onClick={() => setPin((p) => p.slice(0, -1))}
                aria-label="Delete"
              >
                <Delete className="mx-auto h-5 w-5" strokeWidth={2} />
              </KeypadButton>
              <KeypadButton onClick={() => press("0")}>0</KeypadButton>
              <button
                type="button"
                disabled={pending || pin.length !== 8 || !email.includes("@")}
                onClick={submitPin}
                className="flex items-center justify-center rounded-xl bg-emerald-600 text-sm font-semibold transition-colors hover:bg-emerald-500 disabled:opacity-40"
              >
                {pending ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  "Enter"
                )}
              </button>
            </div>
          </>
        ) : (
          <>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder="Password"
              onKeyDown={(e) => e.key === "Enter" && submitPassword()}
              className="mb-4 w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-center text-sm outline-none placeholder:text-white/30 focus:border-white/40"
            />
            <button
              type="button"
              disabled={busy || !email.includes("@") || password.length < 1}
              onClick={submitPassword}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-sm font-semibold transition-colors hover:bg-emerald-500 disabled:opacity-40"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Sign in
            </button>
          </>
        )}

        <button
          type="button"
          onClick={requestReset}
          disabled={pending}
          className="mt-6 block w-full text-center text-sm text-white/50 underline-offset-4 transition-colors hover:text-white hover:underline disabled:opacity-50"
        >
          Forgot PIN or password?
        </button>
      </div>
    </div>
  );
}

function KeypadButton({
  children,
  onClick,
  ...rest
}: {
  children: React.ReactNode;
  onClick: () => void;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-14 items-center justify-center rounded-xl bg-white/10 text-xl font-medium transition-colors hover:bg-white/20 active:bg-white/30"
      {...rest}
    >
      {children}
    </button>
  );
}
