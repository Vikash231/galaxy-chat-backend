import { z } from "zod";
import { ContentBlock, SafeError } from "./content";
import { ToolStatus } from "./realtime";

const iso = z.string().datetime();
const id = z.string().min(1).max(64);
const microString = z.string().regex(/^-?\d+$/);

export const ChatParams = z.object({ chatId: id });
export const RunParams = z.object({ runId: id });

export const PageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
export type PageQuery = z.infer<typeof PageQuery>;
export const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const Credits = z.object({ balanceMicro: microString, formatted: z.string() });

export const MeResponse = z.object({
  user: z.object({ id, clerkId: z.string() }),
  credits: Credits,
});

export const ChatView = z.object({ id, title: z.string(), pinned: z.boolean(), createdAt: iso, updatedAt: iso });
export type ChatView = z.infer<typeof ChatView>;
export const CreateChatBody = z.object({ title: z.string().trim().min(1).max(120).optional() });

export const RunStatus = z.enum(["queued", "running", "waiting", "completed", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatus>;
export const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting"] as const satisfies RunStatus[];

export const ChatDetail = z.object({
  chat: ChatView,
  activeRun: z.object({ runId: id, status: RunStatus }).nullable(),
});

export const MessageView = z.object({
  id,
  role: z.enum(["user", "assistant", "system", "tool"]),
  status: z.enum(["streaming", "success", "failed", "cancelled"]),
  runId: id.nullable(),
  checkpointStep: z.number().int(),
  content: z.array(ContentBlock),
  error: SafeError.nullable(),
  createdAt: iso,
});
export type MessageView = z.infer<typeof MessageView>;

export const MAX_MESSAGE_CHARS = 8000;
export const MAX_ATTACHMENTS = 10;
export const SendMessageBody = z.object({
  clientMessageId: z.string().uuid(),
  text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  attachmentIds: z.array(id).max(MAX_ATTACHMENTS).default([]),
});
export type SendMessageBody = z.infer<typeof SendMessageBody>;

export const RealtimeAccess = z.object({ triggerRunId: z.string(), publicAccessToken: z.string(), expiresAt: iso });
export type RealtimeAccess = z.infer<typeof RealtimeAccess>;

export const SendMessageResponse = z.object({ chatId: id, messageId: id, runId: id, realtime: RealtimeAccess });
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;

export const ToolInvocationView = z.object({
  toolCallId: z.string(),
  seq: z.number().int(),
  name: z.string(),
  status: ToolStatus,
  input: z.unknown(),
  output: z.unknown().nullable(),
  durationMs: z.number().int().nullable(),
  credits: microString,
  error: SafeError.nullable(),
});

export const RunView = z.object({
  run: z.object({
    id,
    chatId: id,
    status: RunStatus,
    steps: z.number().int(),
    routedModels: z.array(z.string()),
    error: SafeError.nullable(),
    createdAt: iso,
    finishedAt: iso.nullable(),
  }),
  tools: z.array(ToolInvocationView),
  assistantMessage: MessageView.nullable(),
});
export type RunView = z.infer<typeof RunView>;

export const CancelResponse = z.object({ runId: id, status: z.union([RunStatus, z.literal("stopping")]) });
export const HealthResponse = z.object({ ok: z.boolean(), db: z.enum(["up", "down"]) });

// ---- uploads (Transloadit) ----
export const UPLOAD_MIME_PREFIXES = ["image/", "video/", "audio/"] as const;
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // Transloadit Community plan: 0.5 GB per file

/** params must be sent to Transloadit byte-for-byte as signed, so it travels as a string. */
export const SignUploadResponse = z.object({ params: z.string(), signature: z.string(), expiresAt: iso });
export const CompleteUploadBody = z.object({ assemblyId: z.string().regex(/^[a-f0-9]{32}$/) });
export const AttachmentView = z.object({
  id,
  kind: z.enum(["image", "video", "audio"]),
  name: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationSec: z.number().nonnegative().nullable(),
  url: z.string().url(),
  persistent: z.boolean(),
});
export type AttachmentView = z.infer<typeof AttachmentView>;
export const CompleteUploadResponse = z.object({ attachments: z.array(AttachmentView) });
