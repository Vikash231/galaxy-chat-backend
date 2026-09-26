import { createHmac, randomUUID } from "node:crypto";
import { apiEnv } from "@gx/config";
import { AppError, MAX_UPLOAD_BYTES, UPLOAD_MIME_PREFIXES, type AttachmentView } from "@gx/contracts";
import { monthlyUploadBytes, saveAttachments, type UserRow } from "@gx/db";
import type { Logger } from "@gx/observability";

const API = "https://api2.transloadit.com";
const SIGN_TTL_MS = 60 * 60_000;
const STORE_STEP = "stored";

function credentials() {
  const env = apiEnv();
  if (!env.TRANSLOADIT_AUTH_KEY || !env.TRANSLOADIT_AUTH_SECRET) throw new AppError("upload_rejected", "Uploads aren't configured yet.");
  return { env, key: env.TRANSLOADIT_AUTH_KEY, secret: env.TRANSLOADIT_AUTH_SECRET };
}

const sign = (params: string, secret: string) => `sha384:${createHmac("sha384", secret).update(params).digest("hex")}`;

/**
 * Signed Assembly instructions for one browser upload. The browser can't alter them without breaking the signature,
 * and the owner id travels in the signed fields so completion can prove whose upload it is.
 */
export async function signUpload(user: UserRow) {
  const { env, key, secret } = credentials();
  if ((await monthlyUploadBytes()) >= env.UPLOAD_MONTHLY_QUOTA_BYTES)
    throw new AppError("upload_quota", "The monthly upload allowance is used up. Try again next month.");

  const expires = new Date(Date.now() + SIGN_TTL_MS);
  const steps: Record<string, unknown> = {
    ":original": { robot: "/upload/handle" },
    // Keep only media files; anything else produces no result and is rejected at completion.
    filtered: { robot: "/file/filter", use: ":original", accepts: [["${file.mime}", "regex", "^(image|video|audio)/"]], error_on_decline: true },
  };
  if (env.TRANSLOADIT_R2_CREDENTIALS && env.R2_PUBLIC_URL) {
    steps[STORE_STEP] = {
      robot: "/cloudflare/store",
      use: "filtered",
      credentials: env.TRANSLOADIT_R2_CREDENTIALS,
      path: `uploads/${user.id}/\${unique_prefix}/\${file.url_name}`,
      url_prefix: `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/`,
      result: true,
    };
  }
  const params = JSON.stringify({
    auth: { key, expires: expires.toISOString() },
    nonce: randomUUID(),
    steps,
    fields: { gx_user: user.id },
  });
  return { params, signature: sign(params, secret), expiresAt: expires.toISOString() };
}

type AssemblyFile = {
  id: string;
  original_id?: string;
  name: string;
  mime: string;
  size: number;
  ssl_url: string;
  meta?: { width?: number; height?: number; duration?: number };
};
type Assembly = {
  ok?: string;
  error?: string;
  message?: string;
  fields?: Record<string, string>;
  results?: Record<string, AssemblyFile[]>;
};

/**
 * Read the Assembly from Transloadit (never trust what the browser reports), check it finished,
 * belongs to this user and holds only allowed media, then save one attachment per file.
 */
export async function completeUpload(user: UserRow, assemblyId: string, log: Logger): Promise<AttachmentView[]> {
  credentials();
  const res = await fetch(`${API}/assemblies/${assemblyId}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res?.ok) throw new AppError("upload_not_ready", "Couldn't confirm the upload. Try again.");
  const a = (await res.json()) as Assembly;

  if (a.fields?.gx_user !== user.id) throw new AppError("not_found", "Upload not found.");
  if (a.error) {
    log.warn({ assemblyId, error: a.error, message: a.message }, "upload.assembly_failed");
    throw new AppError("upload_rejected", a.error === "FILE_FILTER_DECLINED_FILE" ? "Only images, videos and audio can be attached." : "The upload failed. Try again.");
  }
  if (a.ok !== "ASSEMBLY_COMPLETED") throw new AppError("upload_not_ready", "The upload is still processing.");

  const persistent = Boolean(a.results?.[STORE_STEP]);
  const files = a.results?.[STORE_STEP] ?? a.results?.filtered ?? [];
  if (!files.length) throw new AppError("upload_rejected", "Only images, videos and audio can be attached.");
  for (const f of files) {
    if (!UPLOAD_MIME_PREFIXES.some((p) => f.mime.startsWith(p))) throw new AppError("upload_rejected", `${f.name} isn't an image, video or audio file.`);
    if (f.size > MAX_UPLOAD_BYTES) throw new AppError("upload_rejected", `${f.name} is larger than 500 MB.`);
  }
  if (!persistent) log.warn({ assemblyId }, "upload.temporary_url: R2 not configured, attachment URL will expire");

  return saveAttachments(
    files.map((f) => ({
      userId: user.id,
      assemblyId,
      transloaditFileId: f.original_id ?? f.id,
      kind: f.mime.split("/")[0] as AttachmentView["kind"],
      name: f.name,
      mime: f.mime,
      sizeBytes: f.size,
      width: f.meta?.width ?? null,
      height: f.meta?.height ?? null,
      durationSec: f.meta?.duration ?? null,
      url: f.ssl_url,
      persistent,
    })),
  );
}
