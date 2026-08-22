import Link from "next/link";
import { getPosResetInfo } from "@/app/actions/pos-auth-actions";
import { ResetClient } from "./reset-client";

export const metadata = { title: "Reset your POS access" };

export default async function PosResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  const info = await getPosResetInfo(token);

  if ("error" in info) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold">Reset link problem</h1>
          <p className="mt-2 text-sm text-[var(--pos-ink-2)]">{info.error}</p>
          <Link
            href="/pos/login"
            className="mt-5 inline-block rounded-lg bg-[var(--pos-accent)] px-4 py-2 text-sm font-semibold text-[var(--pos-on-accent)] transition-opacity hover:opacity-90"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return <ResetClient token={token} name={info.name} email={info.email} />;
}
