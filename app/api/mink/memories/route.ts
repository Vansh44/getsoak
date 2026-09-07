import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { MinkRequestError } from "@/lib/mink/errors";
import { readMinkBoundedJson } from "@/lib/mink/bounded-json";
import { listMinkMemories, changeMinkMemory } from "@/lib/mink/memories";
import { rateLimit } from "@/lib/rate-limit";
import { logError } from "@/lib/observability/logger";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
  });
export async function GET(request: Request) {
  return handle(request, false);
}
export async function POST(request: Request) {
  const rejected = rejectForeignMinkOrigin(request);
  if (rejected) return rejected;
  return handle(request, true);
}
async function handle(request: Request, write: boolean) {
  try {
    // Memory inspection/deletion remains possible when generation is disabled.
    const actor = await getMinkActorContext(crypto.randomUUID(), {
      betaRequireInvite: false,
    });
    if (
      !(
        await rateLimit(
          `mink-memory:${actor.storeId}:${actor.adminId}:${write}`,
          { max: write ? 10 : 60, windowSeconds: 60 },
        )
      ).allowed
    )
      return json({ error: "Too many requests. Try again shortly." }, 429);
    if (!write) return json({ memories: await listMinkMemories(actor) });
    return json(
      await changeMinkMemory(actor, await readMinkBoundedJson(request, 8192)),
    );
  } catch (e) {
    if (e instanceof MinkRequestError)
      return json({ error: e.message, code: e.code }, e.status);
    // Database errors can contain failing row values. Never log private memory text.
    logError(
      "mink.memory: request failed",
      new Error("memory_storage_unavailable"),
    );
    return json(
      {
        error: "Memory could not be loaded or changed. Refresh and try again.",
      },
      503,
    );
  }
}
