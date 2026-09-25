import { z } from "zod";

/** Error details shown to users; never contains provider internals or secrets. */
export const SafeError = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
export type SafeError = z.infer<typeof SafeError>;

export const AssetKind = z.enum(["image", "video", "audio"]);

export const ContentBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), text: z.string(), durationMs: z.number().int().optional() }),
  z.object({ type: z.literal("tool_use"), toolCallId: z.string(), name: z.string(), input: z.unknown() }),
  z.object({
    type: z.literal("tool_result"),
    toolCallId: z.string(),
    status: z.enum(["completed", "failed", "cancelled"]),
    output: z.unknown().optional(),
    error: SafeError.optional(),
  }),
  z.object({ type: z.literal("asset"), kind: AssetKind, url: z.string().url(), toolCallId: z.string() }),
  z.object({ type: z.literal("error"), error: SafeError }),
]);
export type ContentBlock = z.infer<typeof ContentBlock>;
export const ContentBlocks = z.array(ContentBlock);

/** Parse stored content; a corrupt row degrades to one error block instead of failing the page. */
export function readContent(raw: unknown): ContentBlock[] {
  const parsed = ContentBlocks.safeParse(raw);
  if (parsed.success) return parsed.data;
  return [{ type: "error", error: { code: "corrupt_content", message: "This message could not be displayed.", retryable: false } }];
}
