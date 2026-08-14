"use server";

import "server-only";
import { createHash, createHmac, randomInt, timingSafeEqual } from "crypto";
import { cookies, headers } from "next/headers";
import { getServerUser } from "@/lib/auth/server-user";
import { updateAuthUser } from "@/lib/auth/firebase-users";
import { sendSignupOtpEmail } from "@/lib/email/signup-otp";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const OTP_COOKIE = "sm_signup_email_otp";
const TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

interface SignupOtpPayload {
  u: string;
  e: string;
  h: string;
  x: number;
  a: number;
}

function otpSecret(): string {
  const value =
    process.env.SIGNUP_OTP_SECRET ||
    process.env.OPERATOR_OTP_SECRET ||
    process.env.CRON_SECRET;
  if (!value) throw new Error("Signup OTP signing secret is not configured.");
  return value;
}

function hashCode(code: string): string {
  return createHash("sha256").update(`${code}:${otpSecret()}`).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function encode(payload: SignupOtpPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", otpSecret())
    .update(body)
    .digest("hex");
  return `${body}.${signature}`;
}

function decode(raw: string | undefined): SignupOtpPayload | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const body = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  const expected = createHmac("sha256", otpSecret()).update(body).digest("hex");
  if (!safeEqualHex(signature, expected)) return null;
  try {
    const value = JSON.parse(
      Buffer.from(body, "base64url").toString(),
    ) as SignupOtpPayload;
    if (
      typeof value.u !== "string" ||
      typeof value.e !== "string" ||
      typeof value.h !== "string" ||
      typeof value.x !== "number" ||
      typeof value.a !== "number"
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

export async function requestSignupEmailOtp(): Promise<{
  ok: boolean;
  alreadyVerified?: boolean;
  operatorLogOnly?: boolean;
  devConsoleOnly?: boolean;
  error?: string;
}> {
  const user = await getServerUser();
  if (!user?.email)
    return { ok: false, error: "Sign in to verify your email." };
  if (user.emailConfirmed) return { ok: true, alreadyVerified: true };

  const email = user.email.trim().toLowerCase();
  const ip = clientIp(await headers());
  const [byAccount, byIp] = await Promise.all([
    rateLimit(`signup-email-otp:${user.id}`, { max: 5, windowSeconds: 900 }),
    rateLimit(`signup-email-otp-ip:${ip}`, { max: 20, windowSeconds: 900 }),
  ]);
  if (!byAccount.allowed || !byIp.allowed) {
    return {
      ok: false,
      error: "Too many codes requested. Try again in 15 minutes.",
    };
  }

  let code: string;
  try {
    code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const delivery = await sendSignupOtpEmail(email, code);
    // The code has to have reached SOMEWHERE the person can read it: an inbox,
    // the operator log (dummy address), or the dev console (no mail provider).
    // Anything else and issuing the cookie would strand them on a step they
    // could never pass.
    if (
      !delivery.sent &&
      !delivery.operatorLogOnly &&
      !delivery.devConsoleOnly
    ) {
      return {
        ok: false,
        error: "We couldn't send the verification email. Please try again.",
      };
    }

    const payload: SignupOtpPayload = {
      u: user.id,
      e: email,
      h: hashCode(code),
      x: Date.now() + TTL_MS,
      a: 0,
    };
    (await cookies()).set(
      OTP_COOKIE,
      encode(payload),
      cookieOptions(TTL_MS / 1000),
    );
    return {
      ok: true,
      operatorLogOnly: delivery.operatorLogOnly,
      ...(delivery.devConsoleOnly ? { devConsoleOnly: true } : {}),
    };
  } catch (error) {
    console.error("requestSignupEmailOtp:", error);
    return { ok: false, error: "We couldn't create a verification code." };
  }
}

export async function verifySignupEmailOtp(rawCode: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const code = String(rawCode ?? "").trim();
  if (!/^\d{6}$/.test(code))
    return { ok: false, error: "Enter the 6-digit code." };

  const user = await getServerUser();
  if (!user?.email)
    return { ok: false, error: "Sign in to verify your email." };
  const jar = await cookies();
  if (user.emailConfirmed) {
    jar.delete(OTP_COOKIE);
    return { ok: true };
  }

  const ip = clientIp(await headers());
  const limit = await rateLimit(`signup-email-verify:${user.id}:${ip}`, {
    max: 12,
    windowSeconds: 900,
  });
  if (!limit.allowed) {
    return { ok: false, error: "Too many attempts. Try again in 15 minutes." };
  }

  const payload = decode(jar.get(OTP_COOKIE)?.value);
  const email = user.email.trim().toLowerCase();
  if (!payload || payload.u !== user.id || payload.e !== email) {
    return { ok: false, error: "No active code. Request a new one." };
  }
  if (Date.now() > payload.x) {
    jar.delete(OTP_COOKIE);
    return { ok: false, error: "That code expired. Request a new one." };
  }
  if (payload.a >= MAX_ATTEMPTS) {
    jar.delete(OTP_COOKIE);
    return { ok: false, error: "Too many wrong attempts. Request a new code." };
  }

  if (!safeEqualHex(hashCode(code), payload.h)) {
    const attempts = payload.a + 1;
    const remaining = MAX_ATTEMPTS - attempts;
    if (remaining <= 0) {
      jar.delete(OTP_COOKIE);
      return {
        ok: false,
        error: "Too many wrong attempts. Request a new code.",
      };
    }
    jar.set(
      OTP_COOKIE,
      encode({ ...payload, a: attempts }),
      cookieOptions(Math.max(1, Math.ceil((payload.x - Date.now()) / 1000))),
    );
    return {
      ok: false,
      error: `Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`,
    };
  }

  try {
    await updateAuthUser(user.id, { emailVerified: true });
    jar.delete(OTP_COOKIE);
    return { ok: true };
  } catch (error) {
    console.error("verifySignupEmailOtp:", error);
    return {
      ok: false,
      error: "We couldn't verify the email. Please try again.",
    };
  }
}
