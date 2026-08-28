import { useCallback, useState } from "react";

// Client-side throttle for phone-OTP flows: caps how many wrong codes can be
// submitted and how many fresh codes can be requested in one session.
//
// This is a UX + SMS-cost guardrail layered ON TOP OF the server action's rate
// limits and Firebase Phone Auth's CAPTCHA/provider controls. It is NOT a
// security boundary (it lives in the browser and can be bypassed); it stops
// honest users and casual scripts from hammering the endpoints and gives clearer
// feedback than silent retries.
export const MAX_VERIFY_ATTEMPTS = 5;
export const MAX_RESENDS = 3;

export function useOtpThrottle() {
  const [failedVerifies, setFailedVerifies] = useState(0);
  const [resends, setResends] = useState(0);

  const verifyBlocked = failedVerifies >= MAX_VERIFY_ATTEMPTS;
  const resendBlocked = resends >= MAX_RESENDS;

  // A submitted code was rejected by the server.
  const registerFailedVerify = useCallback(
    () => setFailedVerifies((n) => n + 1),
    [],
  );

  // A fresh code was issued — count it and clear the wrong-attempt tally so the
  // user starts clean against the new code.
  const registerResend = useCallback(() => {
    setResends((n) => n + 1);
    setFailedVerifies(0);
  }, []);

  // Full reset — call when the flow restarts (modal reopened, phone edited).
  const reset = useCallback(() => {
    setFailedVerifies(0);
    setResends(0);
  }, []);

  return {
    verifyBlocked,
    resendBlocked,
    attemptsLeft: Math.max(0, MAX_VERIFY_ATTEMPTS - failedVerifies),
    resendsLeft: Math.max(0, MAX_RESENDS - resends),
    registerFailedVerify,
    registerResend,
    reset,
  };
}
