"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createUserWithEmailAndPassword,
  PhoneAuthProvider,
  RecaptchaVerifier,
  updatePhoneNumber,
} from "firebase/auth";
import PhoneInput, { isValidPhoneNumber } from "react-phone-number-input";
import "react-phone-number-input/style.css";
import { Loader2, Check } from "lucide-react";
import {
  getFirebaseAuth,
  establishSession,
  firebaseAuthErrorMessage,
} from "@/lib/auth/firebase-client";
import { completeStaffRegistration } from "@/app/actions/pos-staff-actions";

type Step = "password" | "phone" | "pin" | "done";

// Technical order (an account must exist before a phone can be linked): create
// the password account → OTP-verify the phone → set the 8-digit PIN → finalize.
export function RegisterClient({
  token,
  email,
  name,
  role,
}: {
  token: string;
  email: string;
  name: string;
  role: string;
}) {
  const router = useRouter();
  const recaptchaRef = useRef<HTMLDivElement | null>(null);
  const verifierRef = useRef<RecaptchaVerifier | null>(null);
  const verificationIdRef = useRef<string | null>(null);

  const getVerifier = useCallback((): RecaptchaVerifier => {
    if (!verifierRef.current) {
      verifierRef.current = new RecaptchaVerifier(
        getFirebaseAuth(),
        recaptchaRef.current!,
        { size: "invisible" },
      );
    }
    return verifierRef.current;
  }, []);

  const [step, setStep] = useState<Step>("password");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [phone, setPhone] = useState<string | undefined>("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneSent, setPhoneSent] = useState(false);
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");

  // Step 1 — password → create the Firebase account.
  async function handlePassword() {
    if (password.length < 8)
      return setError("Password must be at least 8 characters.");
    if (password !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    setError("");
    try {
      await createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
    } catch (err) {
      setBusy(false);
      if ((err as { code?: string })?.code === "auth/email-already-in-use") {
        return setError(
          "This email already has an account. Ask your manager to invite a different email.",
        );
      }
      return setError(firebaseAuthErrorMessage(err));
    }
    const sessErr = await establishSession();
    setBusy(false);
    if (sessErr) return setError(sessErr);
    setStep("phone");
  }

  // Step 2 — phone OTP → link to the account.
  async function handleSendOtp() {
    if (!phone || !isValidPhoneNumber(phone))
      return setError("Enter a valid phone number.");
    setBusy(true);
    setError("");
    try {
      const provider = new PhoneAuthProvider(getFirebaseAuth());
      verificationIdRef.current = await provider.verifyPhoneNumber(
        phone,
        getVerifier(),
      );
      setPhoneSent(true);
    } catch (err) {
      setError(firebaseAuthErrorMessage(err));
    }
    setBusy(false);
  }

  async function handleVerifyOtp() {
    if (!verificationIdRef.current) return;
    setBusy(true);
    setError("");
    try {
      const credential = PhoneAuthProvider.credential(
        verificationIdRef.current,
        phoneCode.trim(),
      );
      const user = getFirebaseAuth().currentUser;
      if (!user) throw new Error("Not signed in.");
      await updatePhoneNumber(user, credential);
      await establishSession(true);
      setBusy(false);
      setStep("pin");
    } catch (err) {
      setBusy(false);
      setError(firebaseAuthErrorMessage(err));
    }
  }

  // Step 3 — PIN → finalize registration.
  async function handlePin() {
    if (!/^\d{8}$/.test(pin)) return setError("PIN must be exactly 8 digits.");
    if (pin !== pinConfirm) return setError("PINs don't match.");
    setBusy(true);
    setError("");
    const res = await completeStaffRegistration(token, pin);
    if (res.error) {
      setBusy(false);
      return setError(res.error);
    }
    // Refresh the session so the new role claim rides in the cookie.
    await establishSession(true);

    // Staff normally register on their PERSONAL phone from the emailed link,
    // which can't sell — so confirm success there rather than bouncing them
    // into the register's device gate (that read as a rejection). If they
    // happened to register on the shop's authorized device, go straight in.
    if (res.deviceAuthorized) {
      router.replace("/pos");
      router.refresh();
      return;
    }
    setBusy(false);
    setStep("done");
  }

  // All set — but this browser can't sell (staff register on their own phone).
  if (step === "done") {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-sm text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400">
            <Check className="h-7 w-7" strokeWidth={2.5} />
          </div>
          <h1 className="mt-4 text-lg font-semibold">
            You&apos;re all set, {name}
          </h1>
          <p className="mt-2 text-sm text-white/60">
            Your {role} account is ready. Sign in at your shop&apos;s register
            with <span className="text-white/80">{email}</span> and your 8-digit
            PIN.
          </p>
          {/* <p className="mt-5 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left text-sm text-white/60">
            For security, the register only works on a device your store owner
            has set up — so you can&apos;t sell from this phone. Everything is
            saved; just use the shop&apos;s device.
          </p> */}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-lg font-semibold">Welcome, {name}</div>
          <div className="mt-1 text-sm text-white/60">
            Set up your {role} access · {email}
          </div>
        </div>

        <Stepper step={step} />

        {error && (
          <p className="mb-4 text-center text-sm text-red-400">{error}</p>
        )}

        {step === "password" && (
          <div className="space-y-3">
            <Input
              type="password"
              value={password}
              onChange={setPassword}
              placeholder="Create a password (min 8)"
            />
            <Input
              type="password"
              value={confirm}
              onChange={setConfirm}
              placeholder="Confirm password"
            />
            <Primary onClick={handlePassword} busy={busy}>
              Continue
            </Primary>
          </div>
        )}

        {step === "phone" && (
          <div className="space-y-3">
            {!phoneSent ? (
              <>
                <div className="pos-phone rounded-xl border border-white/15 bg-white/5 px-3 py-2">
                  <PhoneInput
                    international
                    defaultCountry="IN"
                    value={phone}
                    onChange={setPhone}
                    placeholder="Phone number"
                  />
                </div>
                <Primary onClick={handleSendOtp} busy={busy}>
                  Send code
                </Primary>
              </>
            ) : (
              <>
                <Input
                  value={phoneCode}
                  onChange={(v) =>
                    setPhoneCode(v.replace(/\D/g, "").slice(0, 6))
                  }
                  placeholder="6-digit code"
                  inputMode="numeric"
                />
                <Primary onClick={handleVerifyOtp} busy={busy}>
                  Verify phone
                </Primary>
                <button
                  type="button"
                  onClick={() => {
                    setPhoneSent(false);
                    setPhoneCode("");
                  }}
                  className="block w-full text-center text-sm text-white/50 hover:text-white"
                >
                  Use a different number
                </button>
              </>
            )}
          </div>
        )}

        {step === "pin" && (
          <div className="space-y-3">
            <Input
              value={pin}
              onChange={(v) => setPin(v.replace(/\D/g, "").slice(0, 8))}
              placeholder="Set an 8-digit PIN"
              inputMode="numeric"
              type="password"
            />
            <Input
              value={pinConfirm}
              onChange={(v) => setPinConfirm(v.replace(/\D/g, "").slice(0, 8))}
              placeholder="Confirm PIN"
              inputMode="numeric"
              type="password"
            />
            <Primary onClick={handlePin} busy={busy}>
              Finish
            </Primary>
          </div>
        )}

        <div ref={recaptchaRef} />
      </div>
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps: Step[] = ["password", "phone", "pin"];
  const idx = steps.indexOf(step);
  return (
    <div className="mb-6 flex items-center justify-center gap-2">
      {steps.map((s, i) => (
        <span
          key={s}
          className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
            i < idx
              ? "bg-emerald-600 text-white"
              : i === idx
                ? "bg-white text-[#0b0f14]"
                : "bg-white/10 text-white/40"
          }`}
        >
          {i < idx ? <Check className="h-3.5 w-3.5" /> : i + 1}
        </span>
      ))}
    </div>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  type = "text",
  inputMode,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  type?: string;
  inputMode?: "numeric" | "email" | "text";
}) {
  return (
    <input
      value={value}
      type={type}
      inputMode={inputMode}
      autoCapitalize="none"
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm outline-none placeholder:text-white/30 focus:border-white/40"
    />
  );
}

function Primary({
  children,
  onClick,
  busy,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-sm font-semibold transition-colors hover:bg-emerald-500 disabled:opacity-50"
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}
