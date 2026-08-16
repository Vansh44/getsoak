"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  PhoneAuthProvider,
  RecaptchaVerifier,
  updatePhoneNumber,
} from "firebase/auth";
import {
  getFirebaseAuth,
  establishSession,
  endSession,
  firebaseAuthErrorMessage,
  phoneLinkErrorMessage,
} from "@/lib/auth/firebase-client";
import {
  checkStoreSlugAvailability,
  createStore,
  getSignupResumeInfo,
  type SlugCheck,
} from "@/app/actions/store-signup";
// ★ The NEW billing system (§34). The first cycle is a one-time ORDER paid on
// session, not a Razorpay Subscription — StoreMink computes the amount and the
// gateway only collects it, so a later price change needs nothing updated at the
// provider. Razorpay cannot update a Subscription authorised by UPI or
// e-mandate at all, which is why the old path had to go.
import {
  startSignupSubscribe,
  confirmSignupSubscribe,
} from "@/app/actions/subscribe-actions";
import { openRazorpayModal } from "@/lib/payments/razorpay-client";
import {
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
  Loader2,
  Check,
  Eye,
  EyeOff,
  Lock,
  RotateCcw,
} from "lucide-react";
import {
  THEME_META,
  THEME_CATEGORIES,
  DEFAULT_THEME_ID,
  canPreviewTheme,
  isThemeSelectable,
  type ThemeIndustry,
} from "@/lib/themes/meta";
import { PLAN_META, PLAN_LIMITS, type Plan } from "@/lib/plans";
import type { PlanPrice, PlanPricing } from "@/lib/plans/pricing";
import { COUNTRIES, DEFAULT_COUNTRY } from "@/lib/countries";
import PhoneInput, { isValidPhoneNumber } from "react-phone-number-input";
import "react-phone-number-input/style.css";
import { customPhoneLabels } from "@/lib/phone-labels";
import { CountrySelect } from "@/components/ui/phone-country-select";
import { LocationPicker, type PickedLocation } from "./location-picker";
import { acceptPlatformPolicies } from "@/app/actions/legal-actions";
import { signupRequiredDocs } from "@/lib/legal/documents";
import {
  requestSignupEmailOtp,
  verifySignupEmailOtp,
} from "@/app/actions/signup-email-otp";

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "storemink.com";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type BillingPeriod = "monthly" | "yearly";

const FREE_PRICE: PlanPrice = {
  monthlyInr: 0,
  yearlyInr: 0,
  baseMonthlyInr: null,
  baseYearlyInr: null,
};

function isPlanPricing(value: unknown): value is PlanPricing {
  if (!value || typeof value !== "object") return false;
  return (["free", "basic", "pro"] as Plan[]).every((plan) => {
    const row = (value as Record<string, unknown>)[plan];
    if (!row || typeof row !== "object") return false;
    const p = row as Record<string, unknown>;
    return (
      typeof p.monthlyInr === "number" &&
      p.monthlyInr >= 0 &&
      typeof p.yearlyInr === "number" &&
      p.yearlyInr >= 0 &&
      (p.baseMonthlyInr === null || typeof p.baseMonthlyInr === "number") &&
      (p.baseYearlyInr === null || typeof p.baseYearlyInr === "number")
    );
  });
}

function annualOfferLabel(pricing: PlanPricing): string | null {
  const paid = (["basic", "pro"] as Plan[])
    .map((plan) => pricing[plan])
    .filter((row) => row.monthlyInr > 0);
  const months = paid.map(
    (row) => (row.monthlyInr * 12 - row.yearlyInr) / row.monthlyInr,
  );
  if (
    months.length > 0 &&
    months.every((value) => value > 0 && Number.isInteger(value)) &&
    months.every((value) => value === months[0])
  ) {
    return `${months[0]} ${months[0] === 1 ? "month" : "months"} free`;
  }
  return paid.some((row) => row.yearlyInr < row.monthlyInr * 12)
    ? "Save with yearly"
    : null;
}

function inr(value: number): string {
  return `₹${value.toLocaleString("en-IN")}`;
}

// Steps in flow order. "password" is the second screen of the Account stage.
type Step =
  | "email"
  | "password"
  | "email-code"
  | "phone"
  | "name"
  | "store"
  | "location"
  | "theme"
  | "plan"
  | "creating";

// Progress stages shown in the stepper (Account folds email+password).
const STAGES = [
  "Account",
  "Phone",
  "You",
  "Store",
  "Location",
  "Theme",
  "Plan",
] as const;
function stageOf(step: Step): number {
  switch (step) {
    case "email":
    case "password":
    case "email-code":
      return 0;
    case "phone":
      return 1;
    case "name":
      return 2;
    case "store":
      return 3;
    case "location":
      return 4;
    case "theme":
      return 5;
    default:
      return 6; // plan / creating
  }
}

type CheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "done"; result: SlugCheck };

function demoUrl(demoSlug: string): string {
  const { hostname, protocol, port } = window.location;
  return hostname.endsWith("localhost")
    ? `${protocol}//${demoSlug}.localhost${port ? ":" + port : ""}`
    : `https://${demoSlug}.${ROOT_DOMAIN}`;
}

function dashboardUrl(slug: string): string {
  const { hostname, protocol, port } = window.location;
  return hostname.endsWith("localhost")
    ? `${protocol}//${slug}.localhost${port ? ":" + port : ""}/dashboard`
    : `https://${slug}.${ROOT_DOMAIN}/dashboard`;
}

// The documents the consent box covers, straight from the registry — the same
// list the server writes acceptance rows for. Adding one to lib/legal/documents
// changes the sentence, the acceptance write and the re-acceptance gate
// together, which is the only way they can't drift apart.
const CONSENT_DOCS = signupRequiredDocs();
/** "the Terms of Service, Privacy Policy and Acceptable Use Policy" */
const CONSENT_DOC_NAMES = CONSENT_DOCS.map((d, i) =>
  i === 0
    ? `the ${d.title}`
    : `${i === CONSENT_DOCS.length - 1 ? " and " : ", "}${d.title}`,
).join("");

// Short marketing bullets per plan (derived from the plan catalog; kept concise
// for the signup card, not the full feature matrix).
const PLAN_BULLETS: Record<Plan, string[]> = {
  free: [
    "Free .storemink.com address",
    "Up to 25 products",
    "Cash on delivery",
    "1 staff account",
  ],
  basic: [
    "Everything in Free, plus:",
    "Connect a custom domain",
    "Online payments (Razorpay)",
    "Up to 500 products · 3 staff",
  ],
  pro: [
    "Everything in Basic, plus:",
    "Unlimited products & staff",
    "Email marketing campaigns",
    "Highest AI limits",
  ],
};

export default function SignupPage() {
  // Firebase phone linking: invisible reCAPTCHA + the verificationId from
  // PhoneAuthProvider, held across the send → verify steps.
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

  const [step, setStepRaw] = useState<Step>("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recoveryRequired, setRecoveryRequired] = useState(false);

  // ★★ AN ERROR BELONGS TO THE STEP THAT RAISED IT.
  //
  // There is ONE `error` state and ONE banner, rendered above whichever step is
  // showing — so any transition that forgets to clear it carries the last
  // step's failure onto the next one, where it describes nothing. Two of the
  // fourteen transitions forgot: `resumeWizard` (which jumps straight to
  // phone/name from the session cookie) and the theme step's Continue.
  //
  // Clearing at each call site is what produced the bug; the fifteenth site
  // would have forgotten too. Going through here makes it structural — a step
  // change cannot leave a stale error behind. Where an error must SURVIVE a
  // transition (nothing does today), set it after the call.
  const setStep = useCallback((next: Step) => {
    setError("");
    setRecoveryRequired(false);
    setStepRaw(next);
  }, []);

  // Account
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [emailCode, setEmailCode] = useState("");
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [operatorLogOnly, setOperatorLogOnly] = useState(false);
  const [devConsoleOnly, setDevConsoleOnly] = useState(false);

  // Phone
  const [phone, setPhone] = useState<string | undefined>("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneSent, setPhoneSent] = useState(false);

  // You
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  // Store + location
  const [name, setName] = useState("");
  const [country, setCountry] = useState(DEFAULT_COUNTRY);
  const [addressLine1, setAddressLine1] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postalCode, setPostalCode] = useState("");
  // Consent. `agreed` gates BOTH signup paths (email and Google) because both
  // start from the same screen; `marketing` is the optional box beneath it and
  // gates nothing.
  const [agreed, setAgreed] = useState(false);
  const [marketing, setMarketing] = useState(false);
  // The map pin, when the merchant captured one. Optional by design: geolocation
  // can be declined and the map can fail to load, and neither may block signup.
  const [place, setPlace] = useState<PickedLocation>({
    lat: null,
    lng: null,
    address: "",
    addressLine1: "",
    city: "",
    state: "",
    postalCode: "",
    countryCode: "",
  });
  const [check, setCheck] = useState<CheckState>({ status: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seq = useRef(0);

  // Theme
  const [template, setTemplate] = useState<string>(DEFAULT_THEME_ID);
  const [themeFilter, setThemeFilter] = useState<ThemeIndustry | "all">("all");

  // Plan
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const [selectedPlan, setSelectedPlan] = useState<Plan>("free");
  const [pricing, setPricing] = useState<PlanPricing | null>(null);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [pricingError, setPricingError] = useState("");

  // The store, once provisioned (a paid plan creates it before payment, so an
  // abandoned payment doesn't recreate/duplicate the store on retry).
  const [createdStoreId, setCreatedStoreId] = useState<string | null>(null);
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);

  const loadPricing = useCallback(async (): Promise<PlanPricing | null> => {
    setPricingLoading(true);
    setPricingError("");
    try {
      const response = await fetch("/api/plans/pricing", { cache: "no-store" });
      const payload: unknown = await response.json();
      if (!response.ok || !isPlanPricing(payload)) {
        throw new Error("pricing unavailable");
      }
      setPricing(payload);
      return payload;
    } catch {
      setPricingError(
        "Paid plan pricing is temporarily unavailable. You can retry or create your store on Free.",
      );
      setSelectedPlan("free");
      return null;
    } finally {
      setPricingLoading(false);
    }
  }, []);

  useEffect(() => {
    if (step === "plan" && !pricing && !pricingLoading && !pricingError) {
      void loadPricing();
    }
  }, [loadPricing, pricing, pricingError, pricingLoading, step]);

  async function restartSignup() {
    setBusy(true);
    setError("");
    setRecoveryRequired(false);
    await endSession();
    window.location.assign("/signup");
  }

  // Place the wizard at the right step for the current session: an account that
  // already owns a store goes to its dashboard; one with a session but no store
  // jumps to phone (or name, if phone is already verified). Used both on mount
  // (refreshed tab) and right after Google sign-in. Returns true if a session
  // was found.
  const resumeWizard = useCallback(async (): Promise<boolean> => {
    const info = await getSignupResumeInfo();
    if (!info.authenticated) return false;
    if (info.hasStore && info.slug) {
      window.location.href = dashboardUrl(info.slug);
      return true;
    }
    if (info.email) setEmail(info.email);
    if (info.firstName) setFirstName(info.firstName);
    if (info.lastName) setLastName(info.lastName);
    setStep(
      !info.emailConfirmed
        ? "email-code"
        : info.phoneConfirmed
          ? "name"
          : "phone",
    );
    return true;
  }, [setStep]);

  // On mount: resume a refreshed tab from the existing session cookie.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    void resumeWizard();
  }, [resumeWizard]);

  // ── Slug availability (store step) ───────────────────────────────────────
  function onNameChange(value: string) {
    setName(value);
    if (timer.current) clearTimeout(timer.current);
    if (!value.trim()) {
      setCheck({ status: "idle" });
      return;
    }
    setCheck({ status: "checking" });
    const mySeq = ++seq.current;
    timer.current = setTimeout(async () => {
      const result = await checkStoreSlugAvailability(value);
      if (mySeq === seq.current) setCheck({ status: "done", result });
    }, 400);
  }
  const isNameAvailable = check.status === "done" && check.result.available;
  const currentSlug =
    check.status === "done"
      ? check.result.slug
      : name.trim()
        ? name.trim().toLowerCase().replace(/\s+/g, "-")
        : "your-store";
  function slugHint() {
    if (check.status === "idle")
      return { cls: "neutral", text: `your-store.${ROOT_DOMAIN}` };
    if (check.status === "checking")
      return { cls: "neutral", text: "Checking availability…" };
    const r = check.result;
    return r.available
      ? { cls: "ok", text: `${r.slug}.${ROOT_DOMAIN} is available ✓` }
      : { cls: "bad", text: r.reason ?? "Not available" };
  }

  // ── Account ──────────────────────────────────────────────────────────────
  function continueFromEmail() {
    if (!EMAIL_RE.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    // Checked here as well as via the disabled button: `disabled` is a UI
    // affordance, and this is the only client-side gate before an account is
    // created. (The real guarantee is the server-side acceptance write.)
    if (!agreed) {
      setError(`Please accept ${CONSENT_DOC_NAMES} to continue.`);
      return;
    }
    setError("");
    setStep("password");
  }

  async function handleGoogle() {
    if (!agreed) {
      setError(`Please accept ${CONSENT_DOC_NAMES} to continue.`);
      return;
    }
    setGoogleLoading(true);
    setError("");
    try {
      // signInWithPopup keeps everything client-side (no OAuth callback route);
      // establish the session cookie, then resume the wizard at the right step.
      await signInWithPopup(getFirebaseAuth(), new GoogleAuthProvider());
      const sessErr = await establishSession();
      if (sessErr) {
        setGoogleLoading(false);
        setError(sessErr);
        return;
      }
      // The account now exists and a session cookie is set, so the server can
      // observe who is consenting. Before this point there is no identity to
      // attach it to.
      await acceptPlatformPolicies({ marketingOptIn: marketing });
      await resumeWizard();
      setGoogleLoading(false);
    } catch (err) {
      setGoogleLoading(false);
      setError(firebaseAuthErrorMessage(err));
    }
  }

  async function handleCreateAccount() {
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    setError("");
    const auth = getFirebaseAuth();
    try {
      await createUserWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      // The email may already have an account — try signing in with the same
      // credentials to recover a returning owner and resume at the phone step.
      if ((err as { code?: string })?.code === "auth/email-already-in-use") {
        try {
          await signInWithEmailAndPassword(auth, email.trim(), password);
        } catch {
          setBusy(false);
          setError(
            "An account with this email already exists. Log in, or use a different email.",
          );
          return;
        }
      } else {
        setBusy(false);
        setError(firebaseAuthErrorMessage(err));
        return;
      }
    }
    // Exchange the fresh ID token for the session cookie the server reads.
    const sessErr = await establishSession();
    if (sessErr) {
      setBusy(false);
      setError(sessErr);
      return;
    }
    // Same as the Google path: consent is recorded server-side the moment
    // there is an identity to attach it to.
    await acceptPlatformPolicies({ marketingOptIn: marketing });
    const otp = await requestSignupEmailOtp();
    setBusy(false);
    if (otp.alreadyVerified) {
      setStep("phone");
      return;
    }
    setEmailCodeSent(otp.ok);
    setOperatorLogOnly(otp.operatorLogOnly === true);
    setDevConsoleOnly(otp.devConsoleOnly === true);
    setStep("email-code");
    if (otp.error) setError(otp.error);
  }

  async function handleSendEmailOtp() {
    setBusy(true);
    setError("");
    const result = await requestSignupEmailOtp();
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "We couldn't send a verification code.");
      return;
    }
    if (result.alreadyVerified) {
      setStep("phone");
      return;
    }
    setEmailCodeSent(true);
    setOperatorLogOnly(result.operatorLogOnly === true);
    setDevConsoleOnly(result.devConsoleOnly === true);
  }

  async function handleVerifyEmailOtp() {
    setBusy(true);
    setError("");
    setRecoveryRequired(false);
    const result = await verifySignupEmailOtp(emailCode);
    if (!result.ok) {
      if (result.staleSession) {
        // A deleted Firebase user can leave a signature-valid 14-day server
        // cookie behind. Re-exchange the browser's current user; the session
        // route also evicts any legacy host-only cookie shadowing the fresh
        // shared-domain cookie. The old OTP was UID-bound, so issue a new one.
        const sessionError = await establishSession(true);
        if (sessionError) {
          setBusy(false);
          setRecoveryRequired(true);
          setError(
            "Your session expired. Start again with this email, or log in if you already finished creating the account.",
          );
          return;
        }
        const otp = await requestSignupEmailOtp();
        setBusy(false);
        if (!otp.ok) {
          setError(otp.error ?? "We couldn't send a new verification code.");
          return;
        }
        if (otp.alreadyVerified) {
          setStep("phone");
          return;
        }
        setEmailCode("");
        setEmailCodeSent(true);
        setOperatorLogOnly(otp.operatorLogOnly === true);
        setDevConsoleOnly(otp.devConsoleOnly === true);
        setError("Your session was refreshed. Enter the new code we sent.");
        return;
      }
      setBusy(false);
      setError(result.error ?? "That code couldn't be verified.");
      return;
    }

    // The Admin SDK changed the server record. Reload the browser user, then
    // mint a session cookie carrying the new email_verified claim.
    try {
      await getFirebaseAuth().currentUser?.reload();
      const sessionError = await establishSession(true);
      if (sessionError) {
        setBusy(false);
        setError(sessionError);
        return;
      }
    } catch {
      setBusy(false);
      setError(
        "Email verified, but the session couldn't refresh. Please reload.",
      );
      return;
    }
    setBusy(false);
    setStep("phone");
  }

  // ── Phone ────────────────────────────────────────────────────────────────
  async function handleSendPhoneOtp() {
    if (!phone || !isValidPhoneNumber(phone)) {
      setError("Enter a valid phone number.");
      return;
    }
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
      setError(phoneLinkErrorMessage(err));
    }
    setBusy(false);
  }

  async function handleVerifyPhoneOtp() {
    if (!phone || !verificationIdRef.current) return;
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
      // Re-mint the session cookie so it carries the verified phone —
      // createStore enforces phone_confirmed server-side.
      await establishSession(true);
      setBusy(false);
      setStep("name");
    } catch (err) {
      setBusy(false);
      setError(phoneLinkErrorMessage(err));
    }
  }

  // ── Finalize (plan step) ───────────────────────────────────────────────────
  // Creates the store once (on free), then — for a paid plan — opens the
  // Razorpay autopay mandate and activates the plan on success. An abandoned
  // payment leaves a working Free store the merchant can upgrade later.
  async function ensureStore(): Promise<{
    storeId: string;
    slug: string;
  } | null> {
    if (createdStoreId && createdSlug) {
      return { storeId: createdStoreId, slug: createdSlug };
    }
    const res = await createStore({
      name,
      template,
      firstName,
      lastName,
      country,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      lat: place.lat ?? undefined,
      lng: place.lng ?? undefined,
    });
    if (res.error || !res.storeId || !res.slug) {
      setError(res.error ?? "Could not create your store.");
      return null;
    }
    setCreatedStoreId(res.storeId);
    setCreatedSlug(res.slug);
    return { storeId: res.storeId, slug: res.slug };
  }

  async function finalize() {
    setBusy(true);
    setError("");

    if (selectedPlan !== "free" && !pricing) {
      setBusy(false);
      setError("Load the current plan price before starting payment.");
      return;
    }

    // The wizard can sit open while an operator reprices. Re-read immediately
    // before a paid checkout and make the merchant review any changed number;
    // never let the Razorpay modal be the first place they see the new amount.
    if (selectedPlan !== "free" && pricing) {
      const quoted =
        period === "yearly"
          ? pricing[selectedPlan].yearlyInr
          : pricing[selectedPlan].monthlyInr;
      const latest = await loadPricing();
      if (!latest) {
        setBusy(false);
        setError("We couldn't confirm the current price. Retry before paying.");
        return;
      }
      const current =
        period === "yearly"
          ? latest[selectedPlan].yearlyInr
          : latest[selectedPlan].monthlyInr;
      if (current !== quoted) {
        setBusy(false);
        setError(
          "Pricing changed while you were signing up. Review the updated plan price, then continue.",
        );
        return;
      }
    }

    if (selectedPlan === "free") {
      setStep("creating");
      const store = await ensureStore();
      if (!store) {
        setBusy(false);
        setStep("plan");
        return;
      }
      window.location.href = dashboardUrl(store.slug);
      return;
    }

    // Paid: provision the store, then collect the autopay mandate.
    const store = await ensureStore();
    if (!store) {
      setBusy(false);
      return;
    }

    const start = await startSignupSubscribe(
      store.storeId,
      selectedPlan,
      period,
    );
    if (!start.ok) {
      setBusy(false);
      setError(start.error);
      return;
    }

    const opened = await openRazorpayModal({
      keyId: start.keyId,
      rzpOrderId: start.providerOrderId,
      amountPaise: start.amountPaise,
      customerId: start.providerCustomerId,
      name: "StoreMink",
      description: `${PLAN_META[selectedPlan].name} plan — first ${
        period === "yearly" ? "year" : "month"
      }`,
      prefill: {
        name: `${firstName} ${lastName}`.trim() || undefined,
        email: email || undefined,
        contact: phone || undefined,
      },
      onSuccess: async (res) => {
        const done = await confirmSignupSubscribe(
          store.storeId,
          start.invoiceId,
          res.razorpay_payment_id,
          res.razorpay_signature,
        );
        // ★ GO TO THE DASHBOARD EITHER WAY. The store exists and the money has
        // moved; parking a new merchant on the signup screen to read an error
        // helps nobody. A confirm that did not land leaves an open invoice, which
        // /dashboard/plans shows with a Pay button — unlike the old flow, there
        // is no webhook this silently depends on.
        if (!done.ok) {
          console.error("signup: confirm subscription:", done.error);
        }
        window.location.href = dashboardUrl(store.slug);
      },
      onDismiss: () => {
        setBusy(false);
        // ★ The store is real and on Free — say so, because "payment failed" on
        // the last step of signup reads as "your store wasn't created".
        setError(
          "Payment wasn't completed. Your store is ready on the Free plan — you can upgrade any time from Plans & Billing.",
        );
      },
    });
    if (!opened) {
      setBusy(false);
      setError("Couldn't open the payment window. Please try again.");
    }
  }

  const h = slugHint();
  const stage = stageOf(step);

  // Which steps show a Back control (and where it goes).
  const BACK: Partial<Record<Step, Step>> = {
    password: "email",
    store: "name",
    location: "store",
    theme: "location",
    plan: "theme",
  };

  const width =
    step === "theme" || step === "plan"
      ? "max-w-5xl"
      : step === "location"
        ? "max-w-2xl"
        : "max-w-md";

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Invisible reCAPTCHA anchor for Identity Platform phone verification. */}
      <div ref={recaptchaRef} />
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <Link
          href="/"
          className="font-bold text-xl text-gray-900 tracking-tight flex items-center"
        >
          Store<span className="text-primary">Mink</span>
        </Link>
        <div className="flex items-center gap-4 text-sm font-medium">
          {step !== "email" && step !== "password" && step !== "creating" && (
            <button
              type="button"
              onClick={restartSignup}
              disabled={busy}
              className="inline-flex items-center gap-1.5 text-gray-500 hover:text-gray-900 disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Start over
            </button>
          )}
          <p className="text-gray-500">
            Already selling?{" "}
            <Link
              href="/platform/login"
              className="text-primary hover:underline"
            >
              Log in
            </Link>
          </p>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center px-4 pt-8 pb-20">
        {/* Progress stepper */}
        {step !== "creating" && (
          <div className="w-full max-w-md mb-8">
            <div className="flex items-center gap-1.5">
              {STAGES.map((label, i) => (
                <div key={label} className="flex-1">
                  <div
                    className={`h-1.5 rounded-full transition-colors ${
                      i <= stage ? "bg-primary" : "bg-gray-200"
                    }`}
                  />
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs font-medium text-gray-500">
              Step {stage + 1} of {STAGES.length} · {STAGES[stage]}
            </p>
          </div>
        )}

        <div className={`w-full ${width}`}>
          {error && (
            <div
              role="alert"
              aria-live="assertive"
              className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-700"
            >
              <p>{error}</p>
              {recoveryRequired && (
                <div className="mt-4 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={restartSignup}
                    disabled={busy}
                    className="stq-btn stq-btn-primary inline-flex h-10 items-center gap-2 px-4"
                  >
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4" />
                    )}
                    Start signup again
                  </button>
                  <Link
                    href="/platform/login"
                    className="stq-btn stq-btn-ghost inline-flex h-10 items-center px-4"
                  >
                    Go to login
                  </Link>
                </div>
              )}
            </div>
          )}

          {/* ── Email ─────────────────────────────────────────────── */}
          {step === "email" && (
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <h1 className="text-2xl font-bold text-gray-900 mb-1">
                Start your free store
              </h1>
              <p className="text-gray-500 mb-8">
                Enter your email to create your StoreMink account.
              </p>

              <button
                type="button"
                onClick={handleGoogle}
                disabled={googleLoading}
                aria-describedby="signup-consent-help"
                className="w-full h-12 flex items-center justify-center gap-3 rounded-lg border border-gray-300 bg-white font-semibold text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-60"
              >
                {googleLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <GoogleIcon />
                )}
                Continue with Google
              </button>

              <div className="my-6 flex items-center gap-3">
                <div className="h-px flex-1 bg-gray-200" />
                <span className="text-xs font-medium text-gray-400">OR</span>
                <div className="h-px flex-1 bg-gray-200" />
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  continueFromEmail();
                }}
              >
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-semibold text-gray-700">
                    Email address
                  </label>
                  <input
                    type="email"
                    className="stq-input h-12"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoFocus
                    autoComplete="email"
                  />
                </div>
                <button
                  type="submit"
                  aria-describedby="signup-consent-help"
                  className="stq-btn stq-btn-primary w-full h-12 mt-6 flex items-center justify-center gap-2 disabled:opacity-60"
                >
                  Continue <ChevronRight className="w-5 h-5" />
                </button>
              </form>

              {/* Consent remains mandatory for both paths, but an enabled
                  button can explain WHY it cannot continue. A silently greyed
                  Google button looked like an OAuth outage. */}
              <div
                id="signup-consent-help"
                className={`mt-7 flex flex-col gap-3 rounded-xl border p-4 transition-colors ${
                  agreed
                    ? "border-emerald-200 bg-emerald-50/50"
                    : "border-amber-200 bg-amber-50/60"
                }`}
              >
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-indigo-600"
                  />
                  {/* Driven by the REGISTRY, not hardcoded: the same list
                      (signupRequiredDocs) decides what this sentence names,
                      what recordSignupConsent writes a row for, and what the
                      re-acceptance gate checks. Hardcoding it here is how a
                      merchant ends up ticking a box for two documents while
                      the server records three. */}
                  <span className="text-[13px] leading-relaxed text-gray-700">
                    <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-amber-700">
                      Required to create an account
                    </span>
                    I agree to StoreMink&apos;s{" "}
                    {CONSENT_DOCS.map((doc, i) => (
                      <span key={doc.kind}>
                        {i > 0 &&
                          (i === CONSENT_DOCS.length - 1 ? " and " : ", ")}
                        <a
                          href={`/legal/${doc.slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-semibold text-indigo-600 underline"
                        >
                          {doc.title}
                        </a>
                      </span>
                    ))}
                    .
                  </span>
                </label>

                {/* Optional, and visibly so: unticked by default, gating
                    nothing. A pre-ticked marketing box is not consent either. */}
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={marketing}
                    onChange={(e) => setMarketing(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-indigo-600"
                  />
                  <span className="text-[13px] leading-relaxed text-gray-500">
                    Send me product updates and selling tips.{" "}
                    <span className="text-gray-400">(Optional)</span>
                  </span>
                </label>
              </div>
            </div>
          )}

          {/* ── Password ──────────────────────────────────────────── */}
          {step === "password" && (
            <div className="animate-in fade-in slide-in-from-right-2 duration-300">
              <h1 className="text-2xl font-bold text-gray-900 mb-1">
                Create a password
              </h1>
              <p className="text-gray-500 mb-8">
                Securing the account for{" "}
                <span className="font-medium text-gray-700">{email}</span>.
                We&apos;ll verify this email next.
              </p>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleCreateAccount();
                }}
              >
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-semibold text-gray-700">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      className="stq-input h-12 pr-11"
                      placeholder="At least 8 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoFocus
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      tabIndex={-1}
                      aria-label={
                        showPassword ? "Hide password" : "Show password"
                      }
                    >
                      {showPassword ? (
                        <EyeOff className="w-5 h-5" />
                      ) : (
                        <Eye className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    Use 8 or more characters.
                  </p>
                </div>

                <button
                  type="submit"
                  disabled={busy || password.length < 8}
                  className="stq-btn stq-btn-primary w-full h-12 mt-6 flex items-center justify-center gap-2"
                >
                  {busy ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <>
                      Continue <ChevronRight className="w-5 h-5" />
                    </>
                  )}
                </button>
              </form>
            </div>
          )}

          {/* ── Email verification ─────────────────────────────── */}
          {step === "email-code" && (
            <div className="animate-in fade-in slide-in-from-right-2 duration-300">
              <h1 className="text-2xl font-bold text-gray-900 mb-1">
                Verify your email
              </h1>
              <p className="text-gray-500 mb-8">
                Enter the six-digit code for{" "}
                <span className="font-medium text-gray-700">{email}</span>.
              </p>

              {operatorLogOnly && (
                <div className="mb-5 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-800">
                  This is a reserved test address, so no email was sent. The
                  code is available in Operator dashboard → Email logs.
                </div>
              )}

              {devConsoleOnly && (
                <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  Email isn&apos;t configured in this environment, so nothing
                  was sent. The code is printed in your dev server terminal.
                </div>
              )}

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleVerifyEmailOtp();
                }}
                className="flex flex-col gap-4"
              >
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-semibold text-gray-700">
                    Verification code
                  </label>
                  <input
                    type="text"
                    className="stq-input h-12 text-center font-mono text-xl tracking-[0.35em]"
                    placeholder="000000"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    autoFocus
                    value={emailCode}
                    onChange={(event) =>
                      setEmailCode(event.target.value.replace(/\D/g, ""))
                    }
                  />
                </div>

                <button
                  type="submit"
                  disabled={busy || emailCode.length !== 6}
                  className="stq-btn stq-btn-primary flex h-12 w-full items-center justify-center gap-2"
                >
                  {busy ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <>
                      Verify email <ChevronRight className="h-5 w-5" />
                    </>
                  )}
                </button>
              </form>

              <button
                type="button"
                onClick={() => void handleSendEmailOtp()}
                disabled={busy}
                className="mt-4 text-sm font-medium text-gray-500 hover:text-primary disabled:opacity-50"
              >
                {emailCodeSent ? "Resend code" : "Send verification code"}
              </button>
              <p className="mt-2 text-xs text-gray-400">
                Codes expire after 10 minutes and can only be used in this
                browser.
              </p>
            </div>
          )}

          {/* ── Phone ─────────────────────────────────────────────── */}
          {step === "phone" && (
            <div className="animate-in fade-in slide-in-from-right-2 duration-300">
              <h1 className="text-2xl font-bold text-gray-900 mb-1">
                Verify your phone
              </h1>
              <p className="text-gray-500 mb-8">
                We&apos;ll text a one-time code to confirm it&apos;s you.
              </p>

              <div className="flex flex-col gap-3">
                <label className="text-sm font-semibold text-gray-700">
                  Mobile number
                </label>
                <div className="flex gap-2">
                  <PhoneInput
                    defaultCountry="IN"
                    countrySelectComponent={CountrySelect}
                    labels={customPhoneLabels}
                    placeholder="Mobile number"
                    value={phone}
                    onChange={setPhone}
                    disabled={phoneSent}
                    numberInputProps={{ autoComplete: "tel-national" }}
                    className="stq-phone"
                  />
                  <button
                    type="button"
                    onClick={handleSendPhoneOtp}
                    disabled={busy || phoneSent || !phone}
                    className="stq-btn stq-btn-primary whitespace-nowrap text-sm px-4"
                  >
                    {phoneSent ? "Sent" : busy ? "…" : "Send OTP"}
                  </button>
                </div>

                {phoneSent && (
                  <div className="flex flex-col gap-2 pt-2 animate-in fade-in slide-in-from-top-2">
                    <label className="text-sm font-semibold text-gray-700">
                      Enter the 6-digit code
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        className="stq-input flex-1 h-12"
                        placeholder="6-digit code"
                        inputMode="numeric"
                        maxLength={6}
                        autoFocus
                        value={phoneCode}
                        onChange={(e) =>
                          setPhoneCode(e.target.value.replace(/\D/g, ""))
                        }
                      />
                      <button
                        type="button"
                        onClick={handleVerifyPhoneOtp}
                        disabled={busy || phoneCode.length < 6}
                        className="stq-btn stq-btn-primary whitespace-nowrap px-5"
                      >
                        {busy ? "…" : "Verify"}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setPhoneSent(false);
                        setPhoneCode("");
                        setError("");
                      }}
                      className="text-xs text-gray-500 hover:text-primary text-left mt-1"
                    >
                      ← Wrong number? Edit and resend
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Name ──────────────────────────────────────────────── */}
          {step === "name" && (
            <div className="animate-in fade-in slide-in-from-right-2 duration-300">
              <h1 className="text-2xl font-bold text-gray-900 mb-1">
                What&apos;s your name?
              </h1>
              <p className="text-gray-500 mb-8">
                This is how we&apos;ll address you in your dashboard.
              </p>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!firstName.trim()) {
                    setError("Enter your first name.");
                    return;
                  }
                  setError("");
                  setStep("store");
                }}
                className="flex flex-col gap-4"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-semibold text-gray-700">
                      First name
                    </label>
                    <input
                      className="stq-input h-12"
                      placeholder="First name"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      autoFocus
                      autoComplete="given-name"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-semibold text-gray-700">
                      Last name{" "}
                      <span className="font-normal text-gray-400">
                        (optional)
                      </span>
                    </label>
                    <input
                      className="stq-input h-12"
                      placeholder="Last name"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      autoComplete="family-name"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  className="stq-btn stq-btn-primary w-full h-12 mt-2 flex items-center justify-center gap-2"
                >
                  Continue <ChevronRight className="w-5 h-5" />
                </button>
              </form>
            </div>
          )}

          {/* ── Store + location ──────────────────────────────────── */}
          {step === "store" && (
            <div className="animate-in fade-in slide-in-from-right-2 duration-300">
              <h1 className="text-2xl font-bold text-gray-900 mb-1">
                Name your store
              </h1>
              <p className="text-gray-500 mb-8">
                You can change this later — the address is yours to keep.
              </p>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!isNameAvailable) return;
                  setError("");
                  setStep("location");
                }}
                className="flex flex-col gap-5"
              >
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-semibold text-gray-700">
                    Store name
                  </label>
                  <input
                    className="stq-input h-12 text-lg"
                    placeholder="E.g., My Awesome Store"
                    value={name}
                    onChange={(e) => onNameChange(e.target.value)}
                    autoFocus
                    maxLength={50}
                  />
                  <div className={`stq-hint !mt-1 ${h.cls}`}>{h.text}</div>
                </div>

                {/* Live subdomain chip */}
                <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-500 font-mono">
                  <Lock className="w-3.5 h-3.5 text-emerald-600" />
                  https://{currentSlug}.{ROOT_DOMAIN}
                </div>

                <div className="mt-2 flex items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50/80 p-3 shadow-sm">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-indigo-100 bg-white text-xl shadow-sm">
                    🎉
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-indigo-900">
                      Free lifetime domain
                    </h4>
                    <p className="mt-0.5 text-xs font-medium text-indigo-700">
                      Your .storemink.com address is free forever.
                    </p>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={!isNameAvailable}
                  className="stq-btn stq-btn-primary w-full h-12 flex items-center justify-center gap-2"
                >
                  Continue <ChevronRight className="w-5 h-5" />
                </button>
              </form>
            </div>
          )}

          {/* ── Location ──────────────────────────────────────────────
              Its own step, and REQUIRED: this address prints on every invoice
              the store issues, and it decides tax treatment. Bolted onto the
              "name your store" screen with an optional city, it was the field
              everyone skipped. */}
          {step === "location" && (
            <div className="animate-in fade-in slide-in-from-right-2 duration-300">
              <h1 className="text-2xl font-bold text-gray-900 mb-1">
                Where do you sell from?
              </h1>
              <p className="text-gray-500 mb-8">
                Your business address appears on invoices. You can change it
                later in Settings.
              </p>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!country) {
                    setError("Please choose the country you sell from.");
                    return;
                  }
                  if (!addressLine1.trim()) {
                    setError("Please enter your street and building address.");
                    return;
                  }
                  if (!city.trim()) {
                    setError("Please enter the city you sell from.");
                    return;
                  }
                  if (!state.trim()) {
                    setError("Please enter your state or province.");
                    return;
                  }
                  if (!postalCode.trim()) {
                    setError("Please enter your postal or PIN code.");
                    return;
                  }
                  setError("");
                  setStep("theme");
                }}
                className="flex flex-col gap-5"
              >
                <LocationPicker
                  value={place}
                  onChange={(next) => {
                    setPlace(next);
                    // The pin fills the fields, it doesn't lock them — a
                    // reverse-geocode is often a suburb off and the merchant
                    // gets the final word.
                    if (next.addressLine1) setAddressLine1(next.addressLine1);
                    if (next.city) setCity(next.city);
                    if (next.state) setState(next.state);
                    if (next.postalCode) setPostalCode(next.postalCode);
                    if (
                      next.countryCode &&
                      COUNTRIES.some((c) => c.code === next.countryCode)
                    ) {
                      setCountry(next.countryCode);
                    }
                  }}
                />

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="business-address-1"
                    className="text-sm font-semibold text-gray-700"
                  >
                    Address line 1
                  </label>
                  <input
                    id="business-address-1"
                    className="stq-input h-12"
                    placeholder="Building number and street"
                    value={addressLine1}
                    onChange={(e) => setAddressLine1(e.target.value)}
                    maxLength={160}
                    autoComplete="address-line1"
                    autoFocus
                    required
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="business-address-2"
                    className="text-sm font-semibold text-gray-700"
                  >
                    Address line 2{" "}
                    <span className="font-normal text-gray-400">
                      (optional)
                    </span>
                  </label>
                  <input
                    id="business-address-2"
                    className="stq-input h-12"
                    placeholder="Floor, suite, area or landmark"
                    value={addressLine2}
                    onChange={(e) => setAddressLine2(e.target.value)}
                    maxLength={160}
                    autoComplete="address-line2"
                  />
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="business-city"
                      className="text-sm font-semibold text-gray-700"
                    >
                      City
                    </label>
                    <input
                      id="business-city"
                      className="stq-input h-12"
                      placeholder="E.g., Mumbai"
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      maxLength={80}
                      autoComplete="address-level2"
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="business-state"
                      className="text-sm font-semibold text-gray-700"
                    >
                      State / province
                    </label>
                    <input
                      id="business-state"
                      className="stq-input h-12"
                      placeholder="E.g., Maharashtra"
                      value={state}
                      onChange={(e) => setState(e.target.value)}
                      maxLength={80}
                      autoComplete="address-level1"
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="business-postal-code"
                      className="text-sm font-semibold text-gray-700"
                    >
                      Postal / PIN code
                    </label>
                    <input
                      id="business-postal-code"
                      className="stq-input h-12"
                      placeholder="E.g., 400001"
                      value={postalCode}
                      onChange={(e) => setPostalCode(e.target.value)}
                      maxLength={20}
                      autoComplete="postal-code"
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="business-country"
                      className="text-sm font-semibold text-gray-700"
                    >
                      Country
                    </label>
                    <select
                      id="business-country"
                      className="stq-input h-12 bg-white"
                      value={country}
                      onChange={(e) => setCountry(e.target.value)}
                      autoComplete="country"
                      required
                    >
                      {COUNTRIES.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <p className="text-xs leading-relaxed text-gray-500">
                  Required fields are used for invoices and tax calculations.
                  The map is only an autofill aid—you can correct every field.
                </p>

                <button
                  type="submit"
                  className="stq-btn stq-btn-primary flex h-12 w-full items-center justify-center gap-2"
                >
                  Continue <ChevronRight className="w-5 h-5" />
                </button>
              </form>
            </div>
          )}

          {/* ── Theme ─────────────────────────────────────────────── */}
          {step === "theme" && (
            <div className="animate-in fade-in slide-in-from-right-2 duration-300">
              <h1 className="text-2xl font-bold text-gray-900 mb-1">
                Choose a store theme
              </h1>
              <p className="text-gray-500 mb-6">
                Pick a starting look for {name.trim() ? name : "your store"} —
                you can customise everything later.
              </p>

              <div className="mb-6 flex flex-wrap gap-2">
                {THEME_CATEGORIES.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setThemeFilter(c.id)}
                    className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
                      themeFilter === c.id
                        ? "border-primary bg-primary text-white"
                        : "border-gray-200 bg-white text-gray-600 hover:border-primary/50"
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
                {THEME_META.filter(isThemeSelectable)
                  .filter(
                    (t) =>
                      themeFilter === "all" ||
                      t.catalog.industries.includes(themeFilter),
                  )
                  .map((t) => {
                    const selected = template === t.id;
                    const locked = !!t.catalog.minPlan; // signup provisions "free"
                    const previewable = canPreviewTheme(t);
                    return (
                      <div
                        key={t.id}
                        onClick={() => !locked && setTemplate(t.id)}
                        className={`group relative overflow-hidden rounded-xl border-2 bg-white shadow-sm transition-all ${
                          locked
                            ? "cursor-not-allowed opacity-70"
                            : "cursor-pointer"
                        } ${
                          selected
                            ? "border-primary ring-2 ring-primary ring-offset-2"
                            : "border-gray-200 hover:border-primary/50 hover:shadow-md"
                        }`}
                      >
                        <div className="relative aspect-[4/3] w-full overflow-hidden border-b bg-gray-100">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={t.catalog.previewImage}
                            alt={t.name}
                            className="h-full w-full object-cover"
                          />
                          {selected && (
                            <div className="absolute inset-0 flex items-center justify-center bg-primary/10">
                              <div className="rounded-full bg-white p-1 shadow-md">
                                <CheckCircle2 className="h-6 w-6 text-primary" />
                              </div>
                            </div>
                          )}
                          {locked && (
                            <span className="absolute right-2 top-2 rounded-full bg-gray-900/80 px-2.5 py-1 text-[11px] font-bold text-white">
                              {t.catalog.minPlan!.toUpperCase()}+ plan
                            </span>
                          )}
                        </div>
                        <div className="p-4">
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <h3 className="text-lg font-bold text-gray-900">
                              {t.name}
                            </h3>
                            <button
                              type="button"
                              disabled={!previewable}
                              title={
                                previewable
                                  ? `Preview ${t.name}`
                                  : t.demo.unavailableReason ||
                                    "Preview is temporarily unavailable"
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!previewable) return;
                                window.open(
                                  demoUrl(t.demo.slug),
                                  "_blank",
                                  "noopener,noreferrer",
                                );
                              }}
                              className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-600 hover:border-primary/50 hover:text-primary disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400 disabled:hover:border-gray-200"
                            >
                              {previewable ? "Preview" : "Preview unavailable"}
                              {previewable && (
                                <ExternalLink className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                          <p className="line-clamp-2 h-8 text-xs text-gray-500">
                            {t.description}
                          </p>
                        </div>
                      </div>
                    );
                  })}
              </div>

              <button
                type="button"
                onClick={() => setStep("plan")}
                className="stq-btn stq-btn-primary w-full h-12 max-w-md flex items-center justify-center gap-2"
              >
                Continue <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          )}

          {/* ── Plan ──────────────────────────────────────────────── */}
          {step === "plan" && (
            <div className="animate-in fade-in slide-in-from-right-2 duration-300">
              <h1 className="text-2xl font-bold text-gray-900 mb-1">
                Choose your plan
              </h1>
              <p className="text-gray-500 mb-6">
                Start free — upgrade any time. Paid plans unlock custom domains
                and online payments.
              </p>

              {/* Billing period toggle. The offer label is derived from the
                  operator's live prices; it is never a hard-coded promise. */}
              {pricing && (
                <div
                  className="mb-6 inline-flex rounded-lg border border-gray-200 bg-white p-1"
                  role="group"
                  aria-label="Billing period"
                >
                  {(["monthly", "yearly"] as BillingPeriod[]).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPeriod(p)}
                      aria-pressed={period === p}
                      className={`rounded-md px-4 py-1.5 text-sm font-semibold capitalize transition-colors ${
                        period === p
                          ? "bg-primary text-white"
                          : "text-gray-600 hover:text-gray-900"
                      }`}
                    >
                      {p}
                      {p === "yearly" && annualOfferLabel(pricing) && (
                        <span
                          className={`ml-1.5 text-[11px] ${period === "yearly" ? "text-white/80" : "text-emerald-600"}`}
                        >
                          {annualOfferLabel(pricing)}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {pricingLoading && !pricing && (
                <div className="mb-6 flex h-24 items-center justify-center rounded-xl border border-gray-200 bg-white text-sm text-gray-500">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading
                  current pricing…
                </div>
              )}

              {pricingError && !pricing && (
                <div
                  role="status"
                  className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
                >
                  <p>{pricingError}</p>
                  <button
                    type="button"
                    onClick={loadPricing}
                    disabled={pricingLoading}
                    className="mt-3 font-semibold text-primary hover:underline disabled:opacity-50"
                  >
                    Retry pricing
                  </button>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
                {(pricing
                  ? (["free", "basic", "pro"] as Plan[])
                  : (["free"] as Plan[])
                ).map((planId) => {
                  const meta = PLAN_META[planId];
                  const limits = PLAN_LIMITS[planId];
                  const selected = selectedPlan === planId;
                  const price = pricing?.[planId] ?? FREE_PRICE;
                  const priceInr =
                    period === "yearly"
                      ? Math.round(price.yearlyInr / 12)
                      : price.monthlyInr;
                  const baseTotal =
                    period === "yearly"
                      ? price.baseYearlyInr
                      : price.baseMonthlyInr;
                  const baseInr =
                    baseTotal === null
                      ? null
                      : period === "yearly"
                        ? Math.round(baseTotal / 12)
                        : baseTotal;
                  return (
                    <div
                      key={planId}
                      onClick={() => setSelectedPlan(planId)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedPlan(planId);
                        }
                      }}
                      role="radio"
                      aria-checked={selected}
                      tabIndex={0}
                      className={`relative cursor-pointer rounded-xl border-2 bg-white p-5 shadow-sm transition-all ${
                        selected
                          ? "border-primary ring-2 ring-primary ring-offset-2"
                          : "border-gray-200 hover:border-primary/50 hover:shadow-md"
                      }`}
                    >
                      {planId === "basic" && (
                        <span className="absolute right-3 top-3 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary">
                          Popular
                        </span>
                      )}
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-bold text-gray-900">
                          {meta.name}
                        </h3>
                        {selected && (
                          <CheckCircle2 className="h-5 w-5 text-primary" />
                        )}
                      </div>
                      <div className="mt-2 mb-1">
                        {priceInr === 0 ? (
                          <span className="text-2xl font-extrabold text-gray-900">
                            Free
                          </span>
                        ) : (
                          <>
                            {baseInr !== null && baseInr > priceInr && (
                              <span className="mr-2 text-sm text-gray-400 line-through">
                                {inr(baseInr)}
                              </span>
                            )}
                            <span className="text-2xl font-extrabold text-gray-900">
                              {inr(priceInr)}
                            </span>
                            <span className="text-sm text-gray-500">/mo</span>
                          </>
                        )}
                      </div>
                      <p className="mb-3 min-h-5 text-xs font-medium text-gray-500">
                        {priceInr === 0
                          ? "Free forever. No card needed."
                          : period === "yearly"
                            ? `${inr(price.yearlyInr)} billed once a year`
                            : `${inr(price.monthlyInr)} billed every month`}
                      </p>
                      <p className="mb-4 h-8 text-xs text-gray-500">
                        {meta.tagline}
                      </p>
                      <ul className="flex flex-col gap-2">
                        {PLAN_BULLETS[planId].map((b) => (
                          <li
                            key={b}
                            className="flex items-start gap-2 text-sm text-gray-600"
                          >
                            <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                            {b}
                          </li>
                        ))}
                      </ul>
                      {limits.removeBadge && (
                        <p className="mt-3 text-[11px] font-medium text-gray-400">
                          No “Powered by StoreMink” badge
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={finalize}
                disabled={busy}
                className="stq-btn stq-btn-primary w-full h-12 max-w-md flex items-center justify-center gap-2"
              >
                {busy ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : selectedPlan === "free" ? (
                  "Create my store"
                ) : (
                  `Subscribe to ${PLAN_META[selectedPlan].name} & continue`
                )}
              </button>

              {createdStoreId && createdSlug && selectedPlan !== "free" && (
                <button
                  type="button"
                  onClick={() =>
                    (window.location.href = dashboardUrl(createdSlug))
                  }
                  className="mt-3 w-full max-w-md text-center text-sm font-medium text-gray-500 hover:text-primary"
                >
                  Continue on Free for now →
                </button>
              )}
            </div>
          )}

          {/* ── Creating ──────────────────────────────────────────── */}
          {step === "creating" && (
            <div className="mt-16 flex flex-col items-center text-center">
              <Loader2 className="mb-6 h-12 w-12 animate-spin text-primary" />
              <h1 className="mb-2 text-2xl font-bold tracking-tight text-gray-900">
                Creating {name || "your store"}…
              </h1>
              <p className="text-gray-500">
                Applying your theme and setting up your dashboard. Hang tight!
              </p>
            </div>
          )}

          {/* Back control */}
          {BACK[step] && step !== "creating" && (
            <button
              type="button"
              onClick={() => {
                setError("");
                setStep(BACK[step]!);
              }}
              className="stq-btn stq-btn-ghost mt-6 flex items-center gap-1 font-medium"
            >
              <ChevronLeft className="h-4 w-4" /> Back
            </button>
          )}
        </div>
      </main>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.583-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.166 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}
