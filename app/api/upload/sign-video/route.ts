import { NextResponse } from "next/server";
import { getServerUser } from "@/lib/auth/server-user";
import { rateLimit } from "@/lib/rate-limit";
import {
  gcsConfigured,
  gcsSignUploadUrl,
  gcsPublicUrl,
} from "@/lib/storage/gcs";
import { logError } from "@/lib/observability/logger";
import { storeUploadPath } from "@/lib/storage/paths";
import { resolveUploadOwner } from "@/lib/storage/upload-owner";

// Signed-URL flow for VIDEO uploads. Videos are far too big to proxy through
// a serverless route, so instead:
//   1. the client POSTs metadata here; we authenticate, rate-limit, validate;
//   2. we mint a one-time v4 signed PUT URL for a random path in GCS;
//   3. the client uploads the file DIRECTLY to Google Cloud Storage with it.
// The URL only authorizes that single path, so the client can't write
// anywhere else in the bucket.
export const runtime = "nodejs";

const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB

const EXT_BY_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export async function POST(request: Request) {
  const user = await getServerUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const owner = await resolveUploadOwner(user);
  if (!owner) {
    return NextResponse.json(
      { error: "You don't have access to upload here." },
      { status: 403 },
    );
  }

  // Tighter than images — videos are large; 10/min is plenty for editing.
  const { allowed } = await rateLimit(`upload-video:${user.id}`, {
    max: 10,
    windowSeconds: 60,
  });
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many uploads. Please slow down and try again shortly." },
      { status: 429 },
    );
  }

  let body: { type?: string; size?: number; folder?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const type = typeof body.type === "string" ? body.type : "";
  const size = Number(body.size);
  const folder = typeof body.folder === "string" ? body.folder : "";

  if (!ALLOWED_VIDEO_TYPES.includes(type)) {
    return NextResponse.json(
      {
        error: `Unsupported video type: ${type || "unknown"}. Use MP4 or WebM.`,
      },
      { status: 400 },
    );
  }
  if (!Number.isFinite(size) || size <= 0 || size > MAX_VIDEO_BYTES) {
    return NextResponse.json(
      {
        error: `Video too large. Maximum is ${MAX_VIDEO_BYTES / 1024 / 1024} MB.`,
      },
      { status: 400 },
    );
  }

  const fileName = `${Math.random().toString(36).substring(2, 12)}_${Date.now()}.${EXT_BY_TYPE[type]}`;
  const filePath = storeUploadPath(
    owner.kind === "store" ? owner.storeId : null,
    folder,
    fileName,
  );

  if (!gcsConfigured) {
    logError("sign-video: GCS not configured", new Error("GCS_BUCKET unset"), {
      path: filePath,
    });
    return NextResponse.json(
      { error: "Uploads are not configured." },
      { status: 500 },
    );
  }
  try {
    const uploadUrl = await gcsSignUploadUrl(filePath, type);
    return NextResponse.json({
      uploadUrl,
      publicUrl: gcsPublicUrl(filePath),
    });
  } catch (err) {
    logError("sign-video: GCS signing failed", err, { path: filePath });
    return NextResponse.json(
      { error: "Could not start the upload. Please try again." },
      { status: 500 },
    );
  }
}
