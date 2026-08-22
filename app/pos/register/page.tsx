import { getInviteInfo } from "@/app/actions/pos-staff-actions";
import { RegisterClient } from "./register-client";

export const metadata = { title: "Set up your POS access" };

export default async function PosRegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  const info = await getInviteInfo(token);

  if ("error" in info) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold">Invitation link problem</h1>
          <p className="mt-2 text-sm text-[var(--pos-ink-2)]">{info.error}</p>
        </div>
      </div>
    );
  }

  return (
    <RegisterClient
      token={token}
      email={info.email}
      name={info.name}
      role={info.role}
    />
  );
}
