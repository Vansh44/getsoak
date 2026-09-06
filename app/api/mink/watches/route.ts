import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError, MinkToolInputError } from "@/lib/mink/errors";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import {
  changeMinkWatch,
  createMinkWatch,
  listMinkWatches,
} from "@/lib/mink/watches";
import { rateLimit } from "@/lib/rate-limit";
import { logError } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = {
  "Cache-Control": "no-store, private",
  "X-Content-Type-Options": "nosniff",
};
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers });

export async function GET(request: Request) {
  return handle(request, false);
}
export async function POST(request: Request) {
  const rejected = rejectForeignMinkOrigin(request);
  if (rejected) return rejected;
  return handle(request, true);
}
async function handle(request: Request, write: boolean) {
  const requestId = crypto.randomUUID();
  try {
    // Stop controls remain usable when the global/beta gates are turned off.
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: false,
    });
    if (
      !(
        await rateLimit(
          `mink-watches:${actor.storeId}:${actor.adminId}:${write}`,
          { max: write ? 10 : 60, windowSeconds: 60 },
        )
      ).allowed
    )
      return json(
        { error: "Too many watch requests. Try again shortly." },
        429,
      );
    if (!write) return json(await listMinkWatches(actor));
    if (!request.body) return json({ error: "Empty request." }, 400);
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          return json({ error: "Watch request too large." }, 413);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    let raw: Record<string, unknown>;
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
      raw = value;
    } catch {
      return json({ error: "Invalid watch request." }, 400);
    }
    if (
      !["create", "pause", "resume", "delete"].includes(raw.action as string) ||
      typeof raw.action !== "string"
    )
      return json({ error: "Invalid watch action." }, 400);
    if (raw.action === "create" || raw.action === "resume") {
      if (!getMinkConfig().enabled)
        return json({ error: "Mink AI is disabled." }, 403);
      // Re-resolve with the current invite policy before activating new recurring work.
      const enabledActor = await getMinkActorContext(requestId);
      return json(
        raw.action === "create"
          ? await createMinkWatch(enabledActor, raw)
          : await changeMinkWatch(enabledActor, raw),
      );
    }
    return json(await changeMinkWatch(actor, raw));
  } catch (error) {
    if (error instanceof MinkRequestError)
      return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof MinkToolInputError)
      return json({ error: error.message }, 400);
    logError("mink.watches: request failed", error, { requestId });
    return json(
      { error: "Watches are temporarily unavailable. Refresh and try again." },
      503,
    );
  }
}
