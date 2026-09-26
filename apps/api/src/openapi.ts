import { z } from "zod";
import {
  AnswerWaitpointResponse,
  CancelResponse,
  CompleteUploadBody,
  CompleteUploadResponse,
  SignUploadResponse,
  ChatDetail,
  ChatParams,
  ChatView,
  CreateChatBody,
  ErrorBody,
  HealthResponse,
  MeResponse,
  MessageView,
  PageQuery,
  RealtimeAccess,
  RunMeta,
  RunParams,
  RunView,
  SendMessageBody,
  SendMessageResponse,
  StreamPart,
  WaitpointAnswer,
  WaitpointParams,
  page,
} from "@gx/contracts";

type Op = {
  method: "get" | "post";
  path: string;
  summary: string;
  auth?: boolean;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  ok: [number, z.ZodType];
  errors: number[];
};

const OPS: Op[] = [
  { method: "get", path: "/api/health", summary: "Liveness and database check", auth: false, ok: [200, HealthResponse], errors: [503] },
  { method: "get", path: "/api/v1/me", summary: "Current user and credit balance", ok: [200, MeResponse], errors: [401] },
  { method: "post", path: "/api/v1/chats", summary: "Create a chat", body: CreateChatBody, ok: [201, ChatView], errors: [401, 422] },
  { method: "get", path: "/api/v1/chats", summary: "List chats, most recent activity first", query: PageQuery, ok: [200, page(ChatView)], errors: [401, 422] },
  { method: "get", path: "/api/v1/chats/{chatId}", summary: "One chat and its active run", params: ChatParams, ok: [200, ChatDetail], errors: [401, 404] },
  { method: "get", path: "/api/v1/chats/{chatId}/messages", summary: "Message history, newest first", params: ChatParams, query: PageQuery, ok: [200, page(MessageView)], errors: [401, 404, 422] },
  { method: "post", path: "/api/v1/chats/{chatId}/messages", summary: "Send a message and start the agent turn", params: ChatParams, body: SendMessageBody, ok: [202, SendMessageResponse], errors: [401, 402, 404, 409, 422, 429, 503] },
  { method: "post", path: "/api/v1/uploads/sign", summary: "Signed Transloadit Assembly params for one upload", ok: [200, SignUploadResponse], errors: [401, 422, 429] },
  { method: "post", path: "/api/v1/uploads/complete", summary: "Verify a finished Assembly and save its files as attachments", body: CompleteUploadBody, ok: [200, CompleteUploadResponse], errors: [401, 404, 409, 422] },
  { method: "get", path: "/api/v1/runs/{runId}", summary: "Run status, tool calls and the assistant message", params: RunParams, ok: [200, RunView], errors: [401, 404] },
  { method: "post", path: "/api/v1/runs/{runId}/token", summary: "Mint a realtime read token for one run", params: RunParams, ok: [200, RealtimeAccess], errors: [401, 404, 409] },
  { method: "post", path: "/api/v1/runs/{runId}/cancel", summary: "Stop an active run", params: RunParams, ok: [202, CancelResponse], errors: [401, 404] },
  { method: "post", path: "/api/v1/waitpoints/{waitpointId}/answer", summary: "Answer a question the agent is waiting on (option, file, plan or cost approval)", params: WaitpointParams, body: WaitpointAnswer, ok: [200, AnswerWaitpointResponse], errors: [401, 404, 409, 422, 503] },
];

// Requests are described by what the client may send (defaults optional); responses by what the server returns.
const schema = (s: z.ZodType, io: "input" | "output" = "output") => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s, { io, unrepresentable: "any" }) as Record<string, unknown>;
  return rest;
};

const parameters = (obj: z.ZodObject | undefined, where: "path" | "query") =>
  obj
    ? Object.entries(obj.shape).map(([name, s]) => ({
        name,
        in: where,
        required: where === "path" || !(s as z.ZodType).safeParse(undefined).success,
        schema: schema(s as z.ZodType, "input"),
      }))
    : [];

/** OpenAPI 3.1 generated from the same Zod contracts the routes validate with. */
export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPS) {
    (paths[op.path] ??= {})[op.method] = {
      summary: op.summary,
      security: op.auth === false ? [] : [{ clerk: [] }],
      parameters: [...parameters(op.params, "path"), ...parameters(op.query, "query")],
      ...(op.body && { requestBody: { required: true, content: { "application/json": { schema: schema(op.body, "input") } } } }),
      responses: {
        [op.ok[0]]: { description: "OK", content: { "application/json": { schema: schema(op.ok[1]) } } },
        ...Object.fromEntries(op.errors.map((s) => [s, { $ref: "#/components/responses/Error" }])),
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Galaxy Agent Chat API", version: "1.0.0" },
    paths,
    components: {
      securitySchemes: { clerk: { type: "http", scheme: "bearer", bearerFormat: "Clerk session JWT" } },
      responses: { Error: { description: "Error envelope", content: { "application/json": { schema: schema(ErrorBody) } } } },
      // Realtime payloads are not HTTP responses but are part of the contract the frontend consumes.
      schemas: { RunMeta: schema(RunMeta), StreamPart: schema(StreamPart) },
    },
  };
}
