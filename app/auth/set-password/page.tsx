"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  PhoneAuthProvider,
  RecaptchaVerifier,
  updatePhoneNumber,
} from "firebase/auth";
import {
  getFirebaseAuth,
  establishSession,
  phoneLinkErrorMessage,
} from "@/lib/auth/firebase-client";
import { setPassword, getSetPasswordProfile } from "@/app/actions/set-password";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import PhoneInput from "react-phone-number-input";
import "react-phone-number-input/style.css";
import { customPhoneLabels } from "@/lib/phone-labels";
import { CountrySelect } from "@/components/ui/phone-country-select";

function getPasswordStrength(password: string) {
  if (password.length === 0) return null;
  if (password.length < 8)
    return { label: "Too short", color: "bg-red-500", width: "w-1/3" };
  if (password.length < 12)
    return { label: "Fair", color: "bg-yellow-500", width: "w-2/3" };
  return { label: "Strong", color: "bg-green-500", width: "w-full" };
}

export default function SetPasswordPage() {
  const router = useRouter();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPasswordVal] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  // Phone & OTP states
  const [phone, setPhone] = useState<string | undefined>("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [isPhoneVerified, setIsPhoneVerified] = useState(false);
  const [otpError, setOtpError] = useState("");
  const [loadingOtp, setLoadingOtp] = useState(false);

  // Firebase phone linking: invisible reCAPTCHA + the verificationId returned
  // by PhoneAuthProvider, held across the send → verify steps.
  const recaptchaRef = useRef<HTMLDivElement | null>(null);
  const verifierRef = useRef<RecaptchaVerifier | null>(null);
  const verificationIdRef = useRef<string | null>(null);

  const strength = getPasswordStrength(password);
  const mismatch = confirmPassword.length > 0 && password !== confirmPassword;
  const fullPhone = phone || "";

  function getVerifier(): RecaptchaVerifier {
    if (!verifierRef.current) {
      verifierRef.current = new RecaptchaVerifier(
        getFirebaseAuth(),
        recaptchaRef.current!,
        { size: "invisible" },
      );
    }
    return verifierRef.current;
  }

  useEffect(() => {
    async function fetchProfile() {
      const profile = await getSetPasswordProfile();
      if (!profile) return;
      setFirstName(profile.firstName || "");
      setLastName(profile.lastName || "");
      if (profile.phone) {
        // A phone attached to the account was OTP-verified during signup.
        setPhone(
          profile.phone.startsWith("+") ? profile.phone : `+${profile.phone}`,
        );
        setIsPhoneVerified(true);
      }
    }
    fetchProfile();
  }, []);

  const handleSendOtp = async () => {
    if (!phone || phone.length < 10) {
      setOtpError("Please enter a valid phone number.");
      return;
    }

    setOtpError("");
    setLoadingOtp(true);

    try {
      // Start a phone-verification challenge for the signed-in user.
      const provider = new PhoneAuthProvider(getFirebaseAuth());
      verificationIdRef.current = await provider.verifyPhoneNumber(
        fullPhone,
        getVerifier(),
      );
      setOtpSent(true);
      setOtpError("");
    } catch (err) {
      setOtpError(phoneLinkErrorMessage(err));
    }
    setLoadingOtp(false);
  };

  const handleVerifyOtp = async () => {
    if (!otp || otp.length < 6) {
      setOtpError("Please enter the 6-digit OTP.");
      return;
    }
    if (!verificationIdRef.current) {
      setOtpError("Please request a code first.");
      return;
    }

    setOtpError("");
    setLoadingOtp(true);

    try {
      // Link the verified phone to the current user's Identity Platform account.
      const credential = PhoneAuthProvider.credential(
        verificationIdRef.current,
        otp,
      );
      const user = getFirebaseAuth().currentUser;
      if (!user) throw new Error("Not signed in.");
      await updatePhoneNumber(user, credential);
      setIsPhoneVerified(true);
      setOtpError("");
    } catch (err) {
      setOtpError(phoneLinkErrorMessage(err));
    }
    setLoadingOtp(false);
  };

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!firstName.trim()) {
      setError("First name is required.");
      return;
    }

    if (!isPhoneVerified) {
      setError("Please verify your phone number before setting your password.");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    const formData = new FormData();
    formData.set("password", password);
    formData.set("confirmPassword", confirmPassword);
    formData.set("firstName", firstName);
    formData.set("lastName", lastName);
    formData.set("phone", fullPhone);

    startTransition(async () => {
      const result = await setPassword(formData);
      if (result?.error) {
        setError(result.error);
        return;
      }
      // Re-mint the session cookie with a FORCE-REFRESHED token so the now-
      // cleared force_password_reset claim reaches the cookie — otherwise the
      // proxy would bounce the user straight back here.
      const sessErr = await establishSession(true);
      if (sessErr) {
        setError(sessErr);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    });
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <CardTitle className="text-xl font-bold">
          Complete your profile
        </CardTitle>
        <CardDescription>
          Please verify your details and set a secure password
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Invisible reCAPTCHA anchor for Identity Platform phone verification. */}
        <div ref={recaptchaRef} />
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="firstName">First Name</Label>
              <Input
                id="firstName"
                placeholder="First name"
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="lastName">Last Name</Label>
              <Input
                id="lastName"
                placeholder="Last name (optional)"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="phone">Phone Number</Label>
            <PhoneInput
              defaultCountry="IN"
              countrySelectComponent={CountrySelect}
              labels={customPhoneLabels}
              placeholder="Mobile number"
              value={phone}
              onChange={setPhone}
              disabled={isPhoneVerified || otpSent}
              inputComponent={Input}
              className="flex gap-2 [&>.PhoneInputCountry]:h-10 [&>.PhoneInputCountry]:rounded-md [&>.PhoneInputCountry]:border [&>.PhoneInputCountry]:border-input [&>.PhoneInputCountry]:bg-background [&>.PhoneInputCountry]:p-0"
            />

            {!isPhoneVerified && (
              <div className="mt-1">
                {!otpSent ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={handleSendOtp}
                    disabled={loadingOtp || !phone || phone.length < 10}
                  >
                    {loadingOtp ? "Sending..." : "Send OTP"}
                  </Button>
                ) : (
                  <div className="flex flex-col gap-2">
                    <p className="text-sm text-muted-foreground">
                      OTP sent to {fullPhone}.{" "}
                      <button
                        type="button"
                        onClick={() => {
                          setOtpSent(false);
                          setOtp("");
                        }}
                        className="text-primary underline"
                      >
                        Edit
                      </button>
                    </p>
                    <div className="flex gap-2">
                      <Input
                        type="text"
                        placeholder="Enter 6-digit OTP"
                        value={otp}
                        onChange={(e) =>
                          setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                        }
                        maxLength={6}
                      />
                      <Button
                        type="button"
                        onClick={handleVerifyOtp}
                        disabled={loadingOtp || otp.length < 6}
                      >
                        {loadingOtp ? "Verifying..." : "Verify"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {isPhoneVerified && (
              <p className="text-sm text-green-600 font-medium flex items-center gap-1">
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
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                Phone Number Verified
              </p>
            )}

            {otpError && <p className="text-sm text-destructive">{otpError}</p>}
          </div>

          <div className="flex flex-col gap-2 mt-2">
            <Label htmlFor="password">New Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="Minimum 8 characters"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPasswordVal(e.target.value)}
              autoComplete="new-password"
            />
            {strength && (
              <div className="flex flex-col gap-1">
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${strength.color} ${strength.width}`}
                  />
                </div>
                <span className="text-xs text-muted-foreground">
                  {strength.label}
                </span>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmPassword">Confirm Password</Label>
            <Input
              id="confirmPassword"
              type="password"
              placeholder="Re-enter your password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
            {mismatch && (
              <p className="text-xs text-destructive">Passwords do not match</p>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button
            type="submit"
            className="w-full"
            disabled={isPending || !isPhoneVerified}
          >
            {isPending ? "Setting up account…" : "Complete Setup"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
