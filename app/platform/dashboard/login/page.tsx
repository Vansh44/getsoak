"use client";

import { BrandMark } from "../../brand-mark";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signInWithCustomToken } from "firebase/auth";
import {
  getFirebaseAuth,
  establishSession,
  firebaseAuthErrorMessage,
} from "@/lib/auth/firebase-client";
import {
  requestOperatorOtp,
  verifyOperatorOtp,
} from "@/app/actions/operator-otp-actions";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Platform-operator login (storemink.com/dashboard/login). A 6-digit code is
// emailed (via our Resend domain — deliverable, not the magic link's spam), then
// verified server-side → Firebase custom token → session. Console access is then
// gated by platform_admins membership.
export default function OperatorLoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) return setError("Enter a valid email.");
    setBusy(true);
    setError("");
    try {
      const res = await requestOperatorOtp(email.trim());
      if (!res.ok) {
        setError(res.error || "Something went wrong. Please try again.");
        return;
      }
      setStep("code");
      setNotice(
        `If ${email.trim()} is an operator, a 6-digit code is on its way.`,
      );
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim()))
      return setError("Enter the 6-digit code.");
    setBusy(true);
    setError("");
    try {
      const res = await verifyOperatorOtp(email.trim(), code.trim());
      if (res.error || !res.customToken) {
        setError(res.error || "Something went wrong. Please try again.");
        return;
      }
      await signInWithCustomToken(getFirebaseAuth(), res.customToken);
      const sessErr = await establishSession();
      if (sessErr) {
        setError(sessErr);
        return;
      }
      router.replace("/dashboard");
      router.refresh();
    } catch (err) {
      setError(firebaseAuthErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stq-auth-wrap">
      <form
        className="stq-auth"
        onSubmit={step === "email" ? sendCode : verify}
      >
        <Link href="/" className="stq-logo" style={{ fontSize: 20 }}>
          <BrandMark size={22} priority />
          <em>
            Store<span>Mink</span>
          </em>
        </Link>
        <h1 style={{ marginTop: 18 }}>Operator login</h1>
        <p className="sub">
          {step === "email"
            ? "Sign in to the StoreMink admin console."
            : notice || `Enter the code we sent to ${email.trim()}.`}
        </p>

        {step === "email" ? (
          <>
            <div className="stq-field">
              <label className="stq-label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                className="stq-input"
                placeholder="you@storemink.com"
                autoFocus
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError("");
                }}
              />
            </div>

            <button
              type="submit"
              className="stq-btn stq-btn-primary stq-btn-block"
              disabled={busy}
            >
              {busy ? "Please wait…" : "Email me a code"}
            </button>
          </>
        ) : (
          <>
            <div className="stq-field">
              <label className="stq-label" htmlFor="code">
                6-digit code
              </label>
              <input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className="stq-input"
                placeholder="000000"
                autoFocus
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                  setError("");
                }}
                style={{ letterSpacing: 6, fontVariantNumeric: "tabular-nums" }}
              />
            </div>

            <button
              type="submit"
              className="stq-btn stq-btn-primary stq-btn-block"
              disabled={busy}
            >
              {busy ? "Verifying…" : "Verify & sign in"}
            </button>

            <p className="stq-alt">
              <button
                type="button"
                className="stq-linkbtn"
                onClick={() => {
                  setStep("email");
                  setCode("");
                  setError("");
                  setNotice("");
                }}
              >
                Use a different email
              </button>
            </p>
          </>
        )}

        {error && (
          <div className="stq-hint bad" style={{ marginTop: 14 }}>
            {error}
          </div>
        )}
      </form>
    </div>
  );
}
