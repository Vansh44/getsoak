"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { acceptUpdatedPolicies } from "@/app/actions/legal-actions";
import { endSession } from "@/lib/auth/firebase-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export interface OutstandingDoc {
  kind: string;
  title: string;
  version: number;
  href: string;
}

export function AcceptForm({
  docs,
  email,
}: {
  docs: OutstandingDoc[];
  email: string | null;
}) {
  const router = useRouter();
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = () => {
    // The tick is a UI affordance; the action re-derives what is outstanding
    // and writes the row. Checking here just avoids a pointless round trip.
    if (!agreed) return;
    setError("");
    startTransition(async () => {
      // A THROWN action inside a transition leaves `pending` true forever and
      // shows nothing — the button just says "Saving…" for good. Whatever
      // fails, the person must get a way forward, not a dead screen.
      try {
        const result = await acceptUpdatedPolicies();
        if (result.error) {
          setError(result.error);
          return;
        }
        router.replace("/dashboard");
        router.refresh();
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  };

  // An escape hatch matters here. Someone who does NOT want to agree must be
  // able to leave rather than be stuck on a screen with one button — the gate
  // blocks the dashboard, not the door.
  const signOut = () => {
    startTransition(async () => {
      await endSession();
      router.replace("/auth/login");
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-primary/10">
          <ShieldCheck className="h-4 w-4 text-primary" />
        </div>
        <CardTitle>
          {docs.length === 1
            ? "We've updated a policy"
            : "We've updated our policies"}
        </CardTitle>
        <CardDescription>
          {docs.length === 1
            ? "Please review the updated document before continuing."
            : "Please review the updated documents before continuing."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <ul className="space-y-2">
          {docs.map((doc) => (
            <li key={doc.kind}>
              {/* NOT hover:bg-accent — `--accent` is #0f172a here, so the row
                  went near-black and the title, which inherited a dark
                  foreground, disappeared into it. A tint of the foreground
                  colour can't invert on us: it darkens in light themes and
                  lightens in dark ones, and the text stays readable either
                  way. */}
              <a
                href={doc.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm text-foreground transition-colors hover:border-foreground/25 hover:bg-foreground/[0.04]"
              >
                <span className="font-medium">
                  {doc.title}
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    v{doc.version}
                  </span>
                </span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </a>
            </li>
          ))}
        </ul>

        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary"
          />
          <span className="text-muted-foreground">
            I have read and agree to the{" "}
            {docs.map((doc, i) => (
              <span key={doc.kind}>
                {i > 0 && (i === docs.length - 1 ? " and " : ", ")}
                <span className="text-foreground">{doc.title}</span>
              </span>
            ))}
            .
          </span>
        </label>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button
          onClick={submit}
          disabled={!agreed || pending}
          className="w-full"
        >
          {pending ? "Saving…" : "Agree and continue"}
        </Button>

        <p className="text-center text-xs text-muted-foreground">
          {email && <span className="block">Signed in as {email}</span>}
          <button
            type="button"
            onClick={signOut}
            disabled={pending}
            className="mt-1 underline underline-offset-2 hover:text-foreground"
          >
            Sign out instead
          </button>
        </p>
      </CardContent>
    </Card>
  );
}
