"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAdditionalUserInfo,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  type ConfirmationResult,
  type User,
} from "firebase/auth";
import { CheckCircle2, Loader2, MessageSquareText, X } from "lucide-react";
import {
  beginCustomerPhoneVerification,
  confirmCustomerPhoneVerification,
} from "@/app/actions/pos-customer-verification-actions";
import {
  firebaseAuthErrorMessage,
  getSecondaryFirebaseAuth,
} from "@/lib/auth/firebase-client";
import type { PosCustomerVerificationPurpose } from "@/lib/pos/customer-verification";
import { useOtpThrottle } from "@/lib/use-otp-throttle";

const OTP_LENGTH = 6;
const RESEND_SECONDS = 30;

export function CustomerPhoneVerification({
  orderId,
  purpose,
  onVerified,
  onOverride,
  onCancel,
}: {
  orderId: string;
  purpose: PosCustomerVerificationPurpose;
  onVerified: () => void;
  /**
   * Proceed WITHOUT a code, because the order carries no mobile to text.
   *
   * Separate from `onVerified` so the caller cannot confuse "the customer
   * answered a code" with "a manager decided to go ahead anyway" — the second
   * has to travel to the server as its own acknowledgement and be audited.
   */
  onOverride: () => void;
  onCancel: () => void;
}) {
  const [maskedPhone, setMaskedPhone] = useState("");
  // Set only when the SERVER says no textable mobile exists on the order. The
  // dialog never decides this for itself.
  const [unverifiable, setUnverifiable] = useState<{
    canOverride: boolean;
    reason: string;
  } | null>(null);
  const [otp, setOtp] = useState("");
  const [sending, setSending] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const started = useRef(false);
  const recaptchaNode = useRef<HTMLDivElement | null>(null);
  const verifier = useRef<RecaptchaVerifier | null>(null);
  const confirmation = useRef<ConfirmationResult | null>(null);
  const token = useRef<string | null>(null);
  const temporaryUser = useRef<User | null>(null);
  const createdAuthUser = useRef(false);
  const otpInput = useRef<HTMLInputElement | null>(null);
  const { verifyBlocked, resendBlocked, registerFailedVerify, registerResend } =
    useOtpThrottle();

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setInterval(() => setResendIn((n) => n - 1), 1000);
    return () => clearInterval(timer);
  }, [resendIn]);

  useEffect(
    () => () => {
      verifier.current?.clear();
      if (temporaryUser.current) {
        void temporaryUser.current.delete().catch(() => undefined);
      }
      void getSecondaryFirebaseAuth()
        .signOut()
        .catch(() => undefined);
    },
    [],
  );

  const getVerifier = useCallback(() => {
    // Firebase consumes a reCAPTCHA verifier on every send attempt. Reusing it
    // makes the first failed send or the first resend a permanent dead end.
    verifier.current?.clear();
    verifier.current = new RecaptchaVerifier(
      getSecondaryFirebaseAuth(),
      recaptchaNode.current!,
      { size: "invisible" },
    );
    return verifier.current;
  }, []);

  const clearTemporarySession = useCallback(async () => {
    const user = temporaryUser.current;
    temporaryUser.current = null;
    createdAuthUser.current = false;
    if (user) await user.delete().catch(() => undefined);
    await getSecondaryFirebaseAuth()
      .signOut()
      .catch(() => undefined);
  }, []);

  const sendCode = useCallback(
    async (resend = false) => {
      if (resend && resendBlocked) {
        setError("Too many code requests. Please try again later.");
        return;
      }
      setSending(true);
      setError("");
      try {
        if (resend) await clearTemporarySession();
        // Re-authorize and rate-limit EVERY send, including resends. Caching the
        // phone in the browser must not become a way around the server limit or
        // keep sending to an order number that changed in the meantime.
        const begun = await beginCustomerPhoneVerification(orderId, purpose);
        if (begun.unverifiable) {
          setUnverifiable({
            canOverride: begun.canOverride === true,
            reason: begun.error ?? "This order can't be verified by code.",
          });
          return;
        }
        if (begun.error) {
          setError(begun.error);
          return;
        }
        if (begun.alreadyVerified) {
          onVerified();
          return;
        }
        const target = begun.phone ?? "";
        token.current = null;
        confirmation.current = await signInWithPhoneNumber(
          getSecondaryFirebaseAuth(),
          target,
          getVerifier(),
        );
        setMaskedPhone(begun.maskedPhone ?? "");
        if (resend) registerResend();
        setOtp("");
        setResendIn(RESEND_SECONDS);
        setTimeout(() => otpInput.current?.focus(), 50);
      } catch (err) {
        setError(
          firebaseAuthErrorMessage(err) ||
            "Couldn't send the code. Please try again.",
        );
      } finally {
        setSending(false);
      }
    },
    [
      clearTemporarySession,
      getVerifier,
      onVerified,
      orderId,
      purpose,
      registerResend,
      resendBlocked,
    ],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void sendCode();
  }, [sendCode]);

  const verify = useCallback(
    async (code: string) => {
      if (verifying || verifyBlocked) return;
      if (!confirmation.current && !token.current) {
        setError("Request a new code and try again.");
        return;
      }
      setVerifying(true);
      setError("");
      try {
        if (!token.current) {
          const credential = await confirmation.current!.confirm(code);
          createdAuthUser.current =
            getAdditionalUserInfo(credential)?.isNewUser === true;
          temporaryUser.current = createdAuthUser.current
            ? credential.user
            : null;
          token.current = await credential.user.getIdToken();
        }
        const result = await confirmCustomerPhoneVerification({
          orderId,
          purpose,
          idToken: token.current,
          cleanupCreatedAuthUser: createdAuthUser.current,
        });
        if (!result.verified) {
          registerFailedVerify();
          setError(result.error ?? "Couldn't verify that code.");
          return;
        }
        await clearTemporarySession();
        onVerified();
      } catch (err) {
        token.current = null;
        registerFailedVerify();
        setError(
          firebaseAuthErrorMessage(err) ||
            "That code isn't right. Please check and try again.",
        );
        setOtp("");
        setTimeout(() => otpInput.current?.focus(), 50);
      } finally {
        setVerifying(false);
      }
    },
    [
      clearTemporarySession,
      onVerified,
      orderId,
      purpose,
      registerFailedVerify,
      verifyBlocked,
      verifying,
    ],
  );

  const title =
    purpose === "pickup" ? "Verify before handover" : "Verify before return";

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="customer-verification-title"
        className="w-full max-w-sm rounded-2xl border border-[var(--pos-border)] bg-[var(--pos-surface)] p-5 shadow-2xl"
      >
        <div ref={recaptchaNode} />
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-[var(--pos-surface-2)] p-2.5 text-[var(--pos-ink-2)]">
            <MessageSquareText className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="customer-verification-title" className="font-semibold">
              {title}
            </h2>
            <p className="text-sm text-[var(--pos-ink-2)]">
              {unverifiable
                ? "No mobile number on this order"
                : maskedPhone
                  ? `Code sent to +91 ${maskedPhone}`
                  : "Checking the order's mobile number…"}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={verifying}
            aria-label="Close"
            className="rounded-lg p-2 text-[var(--pos-ink-2)] hover:bg-[var(--pos-surface-2)] disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {unverifiable ? (
          <div className="mt-5">
            <p className="rounded-xl bg-[var(--pos-warn-soft)] px-3 py-2.5 text-sm text-[var(--pos-warn)]">
              {unverifiable.reason}
            </p>
            {unverifiable.canOverride ? (
              <>
                <p className="mt-3 text-sm text-[var(--pos-ink-2)]">
                  Check who the customer is another way — the order reference,
                  their name, or the email on the order — then continue. This is
                  recorded against your name.
                </p>
                <button
                  type="button"
                  onClick={onOverride}
                  className="mt-4 w-full rounded-xl bg-[var(--pos-accent)] py-2.5 text-sm font-semibold text-[var(--pos-on-accent)] hover:opacity-90"
                >
                  {purpose === "pickup"
                    ? "Hand over without a code"
                    : "Take the return without a code"}
                </button>
              </>
            ) : (
              // A cashier sees the reason and no button. A control that always
              // fails, in front of a customer, is worse than no control.
              <p className="mt-3 text-sm text-[var(--pos-ink-2)]">
                A manager has to complete this one.
              </p>
            )}
            <button
              type="button"
              onClick={onCancel}
              className="mt-2 w-full rounded-xl bg-[var(--pos-surface-2)] py-2.5 text-sm font-medium hover:bg-[var(--pos-surface-3)]"
            >
              Cancel
            </button>
          </div>
        ) : sending && !maskedPhone ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--pos-ink-2)]">
            <Loader2 className="h-5 w-5 animate-spin" /> Sending code…
          </div>
        ) : maskedPhone ? (
          <>
            <label className="mt-5 block">
              <span className="mb-1.5 block text-sm font-medium">
                6-digit code
              </span>
              <input
                ref={otpInput}
                autoFocus
                autoComplete="one-time-code"
                inputMode="numeric"
                value={otp}
                disabled={verifying || verifyBlocked}
                onChange={(event) => {
                  const next = event.target.value
                    .replace(/\D/g, "")
                    .slice(0, OTP_LENGTH);
                  setOtp(next);
                  setError("");
                  if (next.length === OTP_LENGTH) void verify(next);
                }}
                className="w-full rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] px-4 py-3 text-center text-2xl font-semibold tracking-[0.4em] outline-none focus:border-[var(--pos-border-strong)] disabled:opacity-50"
              />
            </label>
            <p className="mt-2 text-center text-xs text-[var(--pos-ink-3)]">
              The code is checked automatically after the sixth digit.
            </p>
            {verifying && (
              <p className="mt-3 flex items-center justify-center gap-2 text-sm text-[var(--pos-ink-2)]">
                <Loader2 className="h-4 w-4 animate-spin" /> Verifying…
              </p>
            )}
            {!verifying && error && otp.length === OTP_LENGTH && (
              <button
                type="button"
                onClick={() => void verify(otp)}
                className="mt-3 w-full rounded-xl bg-[var(--pos-accent)] py-2.5 text-sm font-semibold text-[var(--pos-on-accent)] hover:opacity-90"
              >
                Try verification again
              </button>
            )}
            <button
              type="button"
              disabled={sending || verifying || resendIn > 0 || resendBlocked}
              onClick={() => void sendCode(true)}
              className="mt-4 w-full rounded-xl bg-[var(--pos-surface-2)] py-2.5 text-sm font-medium hover:bg-[var(--pos-surface-3)] disabled:opacity-40"
            >
              {sending
                ? "Sending…"
                : resendIn > 0
                  ? `Resend in ${resendIn}s`
                  : "Resend code"}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void sendCode()}
            className="mt-5 w-full rounded-xl bg-[var(--pos-accent)] py-2.5 text-sm font-semibold text-[var(--pos-on-accent)] hover:opacity-90"
          >
            Try sending again
          </button>
        )}

        {error && (
          <div
            role="alert"
            className="mt-4 rounded-xl bg-[var(--pos-danger-soft)] px-3 py-2.5 text-sm text-[var(--pos-danger)]"
          >
            {error}
          </div>
        )}
        {verifyBlocked && (
          <p className="mt-3 flex items-center gap-2 text-sm text-[var(--pos-danger)]">
            <CheckCircle2 className="h-4 w-4" /> Too many incorrect codes.
            Request a new code later.
          </p>
        )}
      </div>
    </div>
  );
}
