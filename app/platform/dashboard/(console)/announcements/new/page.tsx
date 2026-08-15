import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { smsAvailability } from "@/lib/announcements/sms-availability";
import { canManage, requireOperator } from "../../require-operator";
import { AnnouncementComposer } from "../composer";

export const metadata = { title: "New announcement — StoreMink Admin" };

export default async function NewAnnouncementPage() {
  const viewer = await requireOperator();

  // Computed on the SERVER: it reads process.env, which the browser has no
  // business seeing even the shape of.
  const smsGate = smsAvailability(null);

  return (
    <div className="w-full max-w-6xl space-y-6">
      <Link
        href="/dashboard/announcements"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" /> Announcements
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
        New announcement
      </h1>
      <AnnouncementComposer
        initial={null}
        canSend={canManage(viewer)}
        smsGate={smsGate}
      />
    </div>
  );
}
