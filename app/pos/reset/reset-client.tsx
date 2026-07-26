"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Loader2 } from "lucide-react";
import {
  completePosReset,
  type PosResetMode,
} from "@/app/actions/pos-auth-actions";

// Two modes on one link — a cashier who forgot their PIN shouldn't be forced to
// invent a new password too (and vice versa). PIN is the default: it's the
// credential used at the register every day.
export function ResetClient({
  token,
  name,
  email,
}: {
  token: string;
  name: string;
  email: string;
}) {
  const [mode, setMode] = useState<PosResetMode>("pin");
  const [value, setValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  const isPin = mode === "pin";
  const label = isPin ? "PIN" : "password";

  const switchMode = (m: PosResetMode) => {
    setMode(m);
    setValue("");
    setConfirm("");
    setError("");
  };

  const submit = () => {
    if (isPin && !/^\d{8}$/.test(value)) {
      return setError("PIN must be exactly 8 digits.");
    }
    if (!isPin && value.length < 8) {
      return setError("Password must be at least 8 characters.");
    }
    if (value !== confirm) {
      return setError(`${isPin ? "PINs" : "Passwords"} don't match.`);
    }
    setError("");
    start(async () => {
      const res = await completePosReset(token, mode, value);
      if (res.error) {
        setError(res.error);
        return;
      }
      setDone(true);
    });
  };

  if (done) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-sm text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400">
            <Check className="h-7 w-7" strokeWidth={2.5} />
          </div>
          <h1 className="mt-4 text-lg font-semibold">
            Your {label} is updated
          </h1>
          <p className="mt-2 text-sm text-white/60">
            Sign in at your shop&apos;s register with{" "}
            <span className="text-white/80">{email}</span> and your new {label}.
          </p>
          <Link
            href="/pos/login"
            className="mt-5 inline-block rounded-lg bg-white px-4 py-2 text-sm font-semibold text-[#0b0f14] transition-opacity hover:opacity-90"
          >
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-xs">
        <div className="mb-6 text-center">
          <div className="text-lg font-semibold">Hello, {name}</div>
          <div className="mt-1 text-sm text-white/60">{email}</div>
        </div>

        <div className="mb-5 flex rounded-xl bg-white/10 p-1 text-sm">
          {(["pin", "password"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              className={`flex-1 rounded-lg py-1.5 font-medium transition-colors ${
                mode === m ? "bg-white text-[#0b0f14]" : "text-white/70"
              }`}
            >
              {m === "pin" ? "New PIN" : "New password"}
            </button>
          ))}
        </div>

        {error && (
          <p className="mb-4 text-center text-sm text-red-400">{error}</p>
        )}

        <div className="space-y-3">
          <input
            value={value}
            type="password"
            inputMode={isPin ? "numeric" : "text"}
            autoCapitalize="none"
            placeholder={isPin ? "New 8-digit PIN" : "New password (min 8)"}
            onChange={(e) =>
              setValue(
                isPin
                  ? e.target.value.replace(/\D/g, "").slice(0, 8)
                  : e.target.value,
              )
            }
            className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm outline-none placeholder:text-white/30 focus:border-white/40"
          />
          <input
            value={confirm}
            type="password"
            inputMode={isPin ? "numeric" : "text"}
            autoCapitalize="none"
            placeholder={isPin ? "Confirm PIN" : "Confirm password"}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            onChange={(e) =>
              setConfirm(
                isPin
                  ? e.target.value.replace(/\D/g, "").slice(0, 8)
                  : e.target.value,
              )
            }
            className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm outline-none placeholder:text-white/30 focus:border-white/40"
          />
          <button
            type="button"
            onClick={submit}
            disabled={pending || !value || !confirm}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-sm font-semibold transition-colors hover:bg-emerald-500 disabled:opacity-40"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            Set new {label}
          </button>
        </div>
      </div>
    </div>
  );
}
