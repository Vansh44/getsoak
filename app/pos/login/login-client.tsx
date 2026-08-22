"use client";

import { useRef, useState, useTransition } from "react";
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
  pairDevice,
  posLoginWithPin,
  requestPosCredentialReset,
} from "@/app/actions/pos-auth-actions";

export function PosLoginClient({
  locationName,
}: {
  /** Shown once the device is paired, so the cashier can confirm which counter
   *  they're on. Null on an unpaired device. */
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
  // Device pairing, surfaced only after credentials check out.
  const [pairing, setPairing] = useState(false);
  const [pairCode, setPairCode] = useState("");
  const pendingPinRef = useRef<string | null>(null);

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

  // Credentials are checked FIRST; if this browser isn't an authorized device
  // the server says so explicitly and we ask for a pairing code right here,
  // instead of blocking the cashier before they've typed anything.
  const submitPin = (retryPin?: string) => {
    const usePin = retryPin ?? pin;
    setError(null);
    start(async () => {
      const res = await posLoginWithPin(email, usePin);
      if (res.needsPairing) {
        // Keep the verified PIN so the sign-in completes itself once paired.
        pendingPinRef.current = usePin;
        setPairing(true);
        setError(null);
        return;
      }
      if (res.error) {
        setError(res.error);
        setPin("");
        return;
      }
      router.replace("/pos");
      router.refresh();
    });
  };

  const submitPairing = () => {
    setError(null);
    start(async () => {
      const res = await pairDevice(pairCode);
      if (res.error) {
        setError(res.error);
        return;
      }
      setPairing(false);
      setPairCode("");
      const held = pendingPinRef.current;
      pendingPinRef.current = null;
      if (held) {
        // Device is authorized now — finish the sign-in they already started.
        submitPin(held);
      } else {
        router.refresh();
      }
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
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--pos-surface-2)]">
            <Mail className="h-7 w-7" strokeWidth={1.75} />
          </div>
          <h1 className="mt-4 text-lg font-semibold">Check your email</h1>
          <p className="mt-2 text-sm text-[var(--pos-ink-2)]">
            If <span className="text-[var(--pos-ink)]">{email}</span> belongs to
            a staff account here, we&apos;ve sent a link to reset your PIN or
            password. It expires in 1 hour.
          </p>
          <button
            type="button"
            onClick={() => setResetSent(false)}
            className="mt-5 text-sm text-[var(--pos-ink-2)] underline-offset-4 hover:text-[var(--pos-ink)] hover:underline"
          >
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  // Credentials verified, but this browser isn't an authorized device yet.
  // Reached only AFTER a correct email + PIN, so the cashier already knows
  // their login works and just needs the device set up.
  if (pairing) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-sm text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-400/10 text-amber-300">
            <ShieldAlert className="h-7 w-7" strokeWidth={1.75} />
          </div>
          <h1 className="mt-4 text-lg font-semibold">Set up this device</h1>
          <p className="mt-2 text-sm text-[var(--pos-ink-2)]">
            Your sign-in is correct. For security the register only runs on a
            device the store owner has approved — enter a pairing code from
            Dashboard → POS → Devices to set this one up.
          </p>

          <input
            value={pairCode}
            autoFocus
            autoCapitalize="characters"
            autoCorrect="off"
            placeholder="8-character code"
            onChange={(e) =>
              setPairCode(e.target.value.toUpperCase().slice(0, 8))
            }
            onKeyDown={(e) => e.key === "Enter" && submitPairing()}
            className="mt-5 w-full rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] px-4 py-3 text-center text-lg tracking-[0.3em] outline-none placeholder:tracking-normal placeholder:text-[var(--pos-ink-3)] focus:border-[var(--pos-border-strong)]"
          />
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

          <button
            type="button"
            disabled={pending || pairCode.trim().length !== 8}
            onClick={submitPairing}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-sm font-semibold transition-colors hover:bg-emerald-500 disabled:opacity-40"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            Set up and sign in
          </button>

          <button
            type="button"
            onClick={() => {
              setPairing(false);
              setPairCode("");
              setPin("");
              pendingPinRef.current = null;
              setError(null);
            }}
            className="mt-4 text-sm text-[var(--pos-ink-2)] underline-offset-4 hover:text-[var(--pos-ink)] hover:underline"
          >
            Back to sign in
          </button>
          <Link
            href="/auth/login"
            className="mt-3 block text-sm text-[var(--pos-ink-2)] underline-offset-4 hover:text-[var(--pos-ink)] hover:underline"
          >
            Store owner? Sign in to approve this device
          </Link>
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
            <div className="mt-1 flex items-center justify-center gap-1.5 text-sm text-[var(--pos-ink-2)]">
              <MapPin className="h-4 w-4" strokeWidth={2} />
              {locationName}
            </div>
          )}
        </div>

        {/* Mode toggle */}
        <div className="mb-5 flex rounded-xl bg-[var(--pos-surface-2)] p-1 text-sm">
          {(["pin", "password"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`flex-1 rounded-lg py-1.5 font-medium transition-colors ${
                mode === m
                  ? "bg-[var(--pos-accent)] text-[var(--pos-on-accent)]"
                  : "text-[var(--pos-ink-2)]"
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
          className="mb-4 w-full rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] px-4 py-3 text-center text-sm outline-none placeholder:text-[var(--pos-ink-3)] focus:border-[var(--pos-border-strong)]"
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
                    i < pin.length
                      ? "bg-[var(--pos-accent)]"
                      : "bg-[var(--pos-surface-2)]"
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
                onClick={() => submitPin()}
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
              className="mb-4 w-full rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] px-4 py-3 text-center text-sm outline-none placeholder:text-[var(--pos-ink-3)] focus:border-[var(--pos-border-strong)]"
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
          className="mt-6 block w-full text-center text-sm text-[var(--pos-ink-2)] underline-offset-4 transition-colors hover:text-[var(--pos-ink)] hover:underline disabled:opacity-50"
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
      className="flex h-14 items-center justify-center rounded-xl bg-[var(--pos-surface-2)] text-xl font-medium transition-colors hover:bg-[var(--pos-surface-3)] active:bg-[var(--pos-surface-3)]"
      {...rest}
    >
      {children}
    </button>
  );
}
