"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import {
  subscribeNewsletter,
  type NewsletterActionState,
} from "@/app/actions/newsletter-actions";

export interface NewsletterFormClasses {
  form?: string;
  fields?: string;
  input?: string;
  button?: string;
  consent?: string;
  message?: string;
}

export function NewsletterForm({
  buttonLabel,
  consentText,
  successMessage,
  source,
  classes = {},
}: {
  buttonLabel: string;
  consentText: string;
  successMessage?: string;
  source: "footer" | "section";
  classes?: NewsletterFormClasses;
}) {
  const initial: NewsletterActionState = { status: "idle", message: "" };
  const [state, action, pending] = useActionState(subscribeNewsletter, initial);
  const formRef = useRef<HTMLFormElement>(null);
  const emailId = useId();

  useEffect(() => {
    if (state.status === "success") formRef.current?.reset();
  }, [state.status]);

  return (
    <form ref={formRef} action={action} className={classes.form}>
      <input type="hidden" name="source" value={source} />
      <input type="hidden" name="consent_text" value={consentText} />
      <label className="sr-only" aria-hidden="true">
        Website
        <input name="website" type="text" tabIndex={-1} autoComplete="off" />
      </label>
      <div className={classes.fields}>
        <label className="sr-only" htmlFor={emailId}>
          Email address
        </label>
        <input
          id={emailId}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          maxLength={320}
          required
          placeholder="your@email.com"
          className={classes.input}
        />
        <button type="submit" disabled={pending} className={classes.button}>
          {pending ? "Subscribing…" : buttonLabel}
        </button>
      </div>
      <label className={classes.consent}>
        <input name="consent" type="checkbox" required />
        <span>{consentText}</span>
      </label>
      <p
        className={classes.message}
        data-status={state.status}
        aria-live="polite"
      >
        {state.status === "success"
          ? successMessage || state.message
          : state.message}
      </p>
    </form>
  );
}
