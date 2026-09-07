import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { MinkRequestError } from "@/lib/mink/errors";
import {
  listProactiveResponses,
  decideProactiveResponse,
} from "@/lib/mink/proactive-responses";
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
    const actor = await getMinkActorContext(crypto.randomUUID());
    if (
      !(
        await rateLimit(
          `mink-response:${actor.storeId}:${actor.adminId}:${write}`,
          { max: write ? 10 : 60, windowSeconds: 60 },
        )
      ).allowed
    )
      return json({ error: "Too many requests. Try again shortly." }, 429);
    if (!write)
      return json(
        await listProactiveResponses(
          actor,
          new URL(request.url).searchParams.get("watchId") ?? "",
        ),
      );
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "Empty request." }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2048) {
          await reader.cancel();
          return json({ error: "Request too large." }, 413);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return json({ error: "Invalid request." }, 400);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return json({ error: "Invalid request." }, 400);
    return json(
      await decideProactiveResponse(actor, raw as Record<string, unknown>),
    );
  } catch (error) {
    if (error instanceof MinkRequestError)
      return json({ error: error.message, code: error.code }, error.status);
    logError("mink.watch-response: request failed", error);
    return json(
      { error: "The response could not be prepared. Refresh and try again." },
      503,
    );
  }
}
