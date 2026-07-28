"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Image from "next/image";
import {
  RecaptchaVerifier,
  signInWithPhoneNumber,
  type ConfirmationResult,
} from "firebase/auth";
import {
  getFirebaseAuth,
  establishSession,
  firebaseAuthErrorMessage,
} from "@/lib/auth/firebase-client";
import {
  updateCustomerProfile,
  getMyCustomer,
} from "@/app/actions/customer-profile";
import { useAuth } from "./AuthProvider";
import { useBrand } from "@/app/(storefront)/components/brand-provider";
import styles from "./AuthModal.module.css";
import PhoneInput from "react-phone-number-input";
import "react-phone-number-input/style.css";
import { customPhoneLabels } from "@/lib/phone-labels";
import { CountrySelect } from "@/components/ui/phone-country-select";
import { useOtpThrottle } from "@/lib/use-otp-throttle";

type Step = "phone" | "otp" | "profile";

const OTP_LENGTH = 6;
const RESEND_COOLDOWN = 30;

export default function AuthModal() {
  const { isAuthModalOpen, closeAuthModal, refreshCustomer } = useAuth();
  const brand = useBrand();

  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState<string | undefined>("");
  const [otp, setOtp] = useState<string[]>(Array(OTP_LENGTH).fill(""));
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resendTimer, setResendTimer] = useState(0);

  const otpRefs = useRef<(HTMLInputElement | null)[]>([]);
  const phoneInputRef = useRef<HTMLInputElement | null>(null);

  // Firebase phone auth: an invisible reCAPTCHA (required by Identity Platform)
  // and the ConfirmationResult returned by signInWithPhoneNumber, held across
  // the send → verify steps.
  const recaptchaRef = useRef<HTMLDivElement | null>(null);
  const verifierRef = useRef<RecaptchaVerifier | null>(null);
  const confirmationRef = useRef<ConfirmationResult | null>(null);

  /**
   * A FRESH reCAPTCHA verifier for every send attempt.
   *
   * A RecaptchaVerifier is SINGLE-USE: once signInWithPhoneNumber solves it,
   * that instance can never be handed to Firebase again. This used to memoise
   * one and only tear it down when the modal CLOSED, which produced a dead end
   * the user couldn't escape:
   *
   *   • First send fails (a mistyped number, say). The verifier is already
   *     spent. Correct the number, press Continue → the same spent verifier
   *     goes back to Firebase → fails again, with the same opaque message,
   *     forever. "Please try again" was advice that could not work.
   *   • "Resend code" had it too: it reused the verifier the initial send
   *     consumed, so resending never once succeeded.
   *
   * Recreating per attempt costs nothing — the widget is invisible and the
   * container is reused — and removes the whole class of problem.
   */
  const getVerifier = useCallback((): RecaptchaVerifier => {
    verifierRef.current?.clear();
    verifierRef.current = new RecaptchaVerifier(
      getFirebaseAuth(),
      recaptchaRef.current!,
      { size: "invisible" },
    );
    return verifierRef.current;
  }, []);

  // Client-side caps on wrong-code submissions and resends (see hook).
  const {
    verifyBlocked,
    resendBlocked,
    registerFailedVerify,
    registerResend,
    reset: resetOtpThrottle,
  } = useOtpThrottle();

  // Reset state when modal closes
  useEffect(() => {
    if (!isAuthModalOpen) {
      // Small delay so the close animation finishes
      const t = setTimeout(() => {
        setStep("phone");
        setPhone("");
        setOtp(Array(OTP_LENGTH).fill(""));
        setFirstName("");
        setLastName("");
        setEmail("");
        setError("");
        setLoading(false);
        setResendTimer(0);
        resetOtpThrottle();
        // Tear down the reCAPTCHA + pending confirmation so the next open starts
        // clean (the verifier is bound to the DOM container and can't be reused
        // once solved).
        confirmationRef.current = null;
        verifierRef.current?.clear();
        verifierRef.current = null;
      }, 400);
      return () => clearTimeout(t);
    }
  }, [isAuthModalOpen, resetOtpThrottle]);

  // Focus phone input on open
  useEffect(() => {
    if (isAuthModalOpen && step === "phone") {
      setTimeout(() => phoneInputRef.current?.focus(), 400);
    }
  }, [isAuthModalOpen, step]);

  // Resend timer countdown
  useEffect(() => {
    if (resendTimer <= 0) return;
    const interval = setInterval(() => {
      setResendTimer((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [resendTimer]);

  // Lock body scroll when modal is open
  useEffect(() => {
    if (isAuthModalOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isAuthModalOpen]);

  const fullPhone = phone || "";

  // ---- Step 1: Send OTP ----
  const handleSendOtp = async () => {
    if (!phone || phone.length < 10) {
      setError("Please enter a valid phone number.");
      return;
    }

    setError("");
    setLoading(true);

    try {
      // Identity Platform sends the SMS after solving the invisible reCAPTCHA;
      // the returned ConfirmationResult carries the code verifier.
      confirmationRef.current = await signInWithPhoneNumber(
        getFirebaseAuth(),
        fullPhone,
        getVerifier(),
      );

      setStep("otp");
      setResendTimer(RESEND_COOLDOWN);
      setLoading(false);

      // Focus first OTP input
      setTimeout(() => otpRefs.current[0]?.focus(), 100);
    } catch (err) {
      setError(firebaseAuthErrorMessage(err));
      setLoading(false);
    }
  };

  // ---- Resend OTP ----
  const handleResendOtp = async () => {
    if (resendBlocked) {
      setError("Too many code requests. Please try again later.");
      return;
    }
    setError("");
    setLoading(true);

    try {
      confirmationRef.current = await signInWithPhoneNumber(
        getFirebaseAuth(),
        fullPhone,
        getVerifier(),
      );
      registerResend();
      setResendTimer(RESEND_COOLDOWN);
      setOtp(Array(OTP_LENGTH).fill(""));
      setTimeout(() => otpRefs.current[0]?.focus(), 100);
    } catch (err) {
      setError(firebaseAuthErrorMessage(err) || "Failed to resend OTP.");
    }
    setLoading(false);
  };

  // ---- Step 2: Verify OTP ----
  const handleVerifyOtp = useCallback(
    async (otpValue: string) => {
      if (verifyBlocked) return;
      if (!confirmationRef.current) {
        setError("Please request a code first.");
        return;
      }
      setError("");
      setLoading(true);

      try {
        // Confirm the code (signs the user in on the client), then exchange the
        // fresh ID token for the httpOnly server session cookie so the server
        // actions below resolve identity.
        await confirmationRef.current.confirm(otpValue);
        const sessErr = await establishSession();
        if (sessErr) {
          setError(sessErr);
          setLoading(false);
          return;
        }

        // Check if a customer profile exists for this (now-authenticated) user.
        const existingCustomer = await getMyCustomer();
        if (existingCustomer) {
          // Returning user — done!
          await refreshCustomer();
          setLoading(false);
          closeAuthModal();
        } else {
          // New user — show profile completion
          setStep("profile");
          setLoading(false);
        }
      } catch (err) {
        registerFailedVerify();
        setError(
          firebaseAuthErrorMessage(err) ||
            "Verification failed. Please try again.",
        );
        setLoading(false);
      }
    },
    [refreshCustomer, closeAuthModal, verifyBlocked, registerFailedVerify],
  );

  // ---- OTP input handlers ----
  const handleOtpChange = (index: number, value: string) => {
    // Only allow digits
    const digit = value.replace(/\D/g, "").slice(-1);
    const newOtp = [...otp];
    newOtp[index] = digit;
    setOtp(newOtp);

    if (digit && index < OTP_LENGTH - 1) {
      otpRefs.current[index + 1]?.focus();
    }

    // Auto-verify when all digits filled
    const fullOtp = newOtp.join("");
    if (fullOtp.length === OTP_LENGTH) {
      handleVerifyOtp(fullOtp);
    }
  };

  const handleOtpKeyDown = (
    index: number,
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "");
    if (pasted.length === OTP_LENGTH) {
      const newOtp = pasted.split("");
      setOtp(newOtp);
      handleVerifyOtp(pasted);
    }
  };

  // ---- Step 3: Save profile ----
  const handleSaveProfile = async () => {
    if (!firstName.trim()) {
      setError("First name is required.");
      return;
    }

    setError("");
    setLoading(true);

    try {
      const formData = new FormData();
      formData.set("firstName", firstName);
      formData.set("lastName", lastName);
      formData.set("email", email);

      const result = await updateCustomerProfile(formData);

      if (result.error) {
        setError(result.error);
        setLoading(false);
        return;
      }

      await refreshCustomer();
      setLoading(false);
      closeAuthModal();
    } catch {
      setError("Failed to save profile. Please try again.");
      setLoading(false);
    }
  };

  // ---- Render steps ----
  const renderPhoneStep = () => (
    <div className={styles.step} key="phone">
      <h2 className={styles.title}>Welcome to {brand.name}</h2>
      <p className={styles.subtitle}>
        Enter your mobile number to sign in or create an account
      </p>

      <div className={styles.phoneRow}>
        <PhoneInput
          defaultCountry="IN"
          countrySelectComponent={CountrySelect}
          labels={customPhoneLabels}
          placeholder="Mobile number"
          value={phone}
          onChange={setPhone}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) =>
            e.key === "Enter" && handleSendOtp()
          }
          className="flex-1 flex gap-2 [&>.PhoneInputCountry]:h-[48px] [&>.PhoneInputCountry]:rounded-xl [&>.PhoneInputCountry]:border [&>.PhoneInputCountry]:border-gray-300 [&>.PhoneInputCountry]:bg-[#f9f9f9] [&>.PhoneInputCountry]:p-0"
          numberInputProps={{
            ref: phoneInputRef,
            className: styles.phoneInput,
            autoComplete: "tel-national",
            id: "auth-phone-input",
          }}
        />
      </div>

      <button
        className={styles.primaryBtn}
        onClick={handleSendOtp}
        disabled={loading || !phone || phone.length < 10}
        id="auth-send-otp-btn"
      >
        {loading ? (
          <>
            <span className={styles.spinner} />
            Sending OTP…
          </>
        ) : (
          "Continue"
        )}
      </button>

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );

  const renderOtpStep = () => (
    <div className={styles.step} key="otp">
      <button
        className={styles.backBtn}
        onClick={() => {
          setStep("phone");
          setOtp(Array(OTP_LENGTH).fill(""));
          setError("");
          resetOtpThrottle();
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Back
      </button>

      <h2 className={styles.title}>Verify your number</h2>
      <p className={styles.phoneDisplay}>
        OTP sent to <span className={styles.phoneNumber}>{fullPhone}</span>
        <button
          className={styles.editPhone}
          onClick={() => {
            setStep("phone");
            setOtp(Array(OTP_LENGTH).fill(""));
            setError("");
            resetOtpThrottle();
          }}
        >
          Edit
        </button>
      </p>

      <div className={styles.otpGrid} onPaste={handleOtpPaste}>
        {otp.map((digit, i) => (
          <input
            key={i}
            ref={(el) => {
              otpRefs.current[i] = el;
            }}
            className={styles.otpInput}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={digit}
            placeholder="·"
            disabled={verifyBlocked}
            onChange={(e) => handleOtpChange(i, e.target.value)}
            onKeyDown={(e) => handleOtpKeyDown(i, e)}
            id={`auth-otp-input-${i}`}
          />
        ))}
      </div>

      {loading && (
        <div style={{ textAlign: "center", marginBottom: 12 }}>
          <span
            className={styles.spinner}
            style={{
              borderTopColor: "#1a1a1a",
              borderColor: "rgba(26,26,26,0.15)",
            }}
          />
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {verifyBlocked && !resendBlocked && (
        <p className={styles.error}>
          Too many incorrect attempts. Request a new code to try again.
        </p>
      )}

      <div className={styles.secondaryAction}>
        {resendBlocked ? (
          <span>Too many code requests. Please try again later.</span>
        ) : resendTimer > 0 ? (
          <span>Resend OTP in {resendTimer}s</span>
        ) : (
          <button
            className={styles.resendBtn}
            onClick={handleResendOtp}
            disabled={loading}
          >
            Resend OTP
          </button>
        )}
      </div>
    </div>
  );

  const renderProfileStep = () => (
    <div className={styles.step} key="profile">
      <div className={styles.successCheck}>
        <div className={styles.checkCircle}>
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
      </div>

      <h2 className={styles.title}>Almost there!</h2>
      <p className={styles.subtitle}>Complete your profile to get started</p>

      <div className={styles.inputGroup}>
        <label className={styles.label} htmlFor="auth-first-name">
          First name<span className={styles.requiredDot}>*</span>
        </label>
        <input
          id="auth-first-name"
          className={styles.textInput}
          type="text"
          placeholder="Your first name"
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          autoFocus
          autoComplete="given-name"
        />
      </div>

      <div className={styles.inputGroup}>
        <label className={styles.label} htmlFor="auth-last-name">
          Last name
        </label>
        <input
          id="auth-last-name"
          className={styles.textInput}
          type="text"
          placeholder="Your last name (optional)"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          autoComplete="family-name"
        />
      </div>

      <div className={styles.inputGroup}>
        <label className={styles.label} htmlFor="auth-email">
          Email
        </label>
        <input
          id="auth-email"
          className={styles.textInput}
          type="email"
          placeholder="you@example.com (optional)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
      </div>

      <button
        className={styles.primaryBtn}
        onClick={handleSaveProfile}
        disabled={loading || !firstName.trim()}
        id="auth-save-profile-btn"
      >
        {loading ? (
          <>
            <span className={styles.spinner} />
            Saving…
          </>
        ) : (
          "Get Started"
        )}
      </button>

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );

  return (
    <div
      className={`${styles.overlay} ${isAuthModalOpen ? styles.overlayVisible : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeAuthModal();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`Sign in to ${brand.name}`}
    >
      <div className={styles.modal}>
        <button
          className={styles.closeBtn}
          onClick={closeAuthModal}
          aria-label="Close"
          id="auth-modal-close-btn"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className={styles.content}>
          <div className={styles.branding}>
            {brand.logoUrl ? (
              <Image
                src={brand.logoUrl}
                alt={brand.name}
                width={120}
                height={44}
                className={styles.brandLogo}
                priority
              />
            ) : (
              <span className={styles.brandLogo}>{brand.name}</span>
            )}
          </div>

          <div className={styles.stepContainer}>
            {step === "phone" && renderPhoneStep()}
            {step === "otp" && renderOtpStep()}
            {step === "profile" && renderProfileStep()}
          </div>
        </div>

        {/* Anchor for the invisible reCAPTCHA that Identity Platform runs
            before sending the phone OTP. Never displays anything in invisible
            mode. */}
        <div ref={recaptchaRef} />
      </div>
    </div>
  );
}
