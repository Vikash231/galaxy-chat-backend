# Day 1 low-level design: core flow working end to end, with Crop Image

> Goal for tonight: a signed-in user types *"crop the left half of https://…/photo.jpg"*. They see the agent think, stream a reply, run **Crop Image** on the real Magica API, and show the cropped image. After a reload, the finished turn is still there and loaded from Postgres.
>
> Out of scope today: GPT Image 2, Merge Videos, skills, uploads, approvals, search, polished UI. The design below leaves room for each of them.

---

## 0. Verified facts this design depends on

| Fact | Source |
|---|---|
| `crop_image` input: `image_url` (required). Either `x/y/width/height_percent` (0–100) **or** `width_px`+`height_px` with optional `x_px`/`y_px`. Leaving out x/y centres the crop | `GET /v1/models/crop_image/schema`, saved in `docs/magica/` |
| Crop cost: fixed **5,000 microcredits** | `GET /v1/models/crop_image/pricing` |
| Run API: `POST /v1/nodes/{nodeType}/run` → `202 {runId}`, then `GET /v1/nodes/runs/{runId}` → `status, output, error, userMessage, creditUsed` | Magica docs |
| Run request accepts `webhook: {url, events, metadata}` | Magica docs |
| Trigger.dev `wait.createToken()` returns `url`. **A POST to that URL completes the token, no auth needed** | Trigger.dev docs |
| Trigger.dev streams: `streams.define<T>({id})`, `.append()`/`.writer()`. React: `useRealtimeStream(def, runId, {accessToken, startIndex})` | Trigger.dev docs |
| `openrouter/free` routes only to models that support the request's features (tool calling included), **choosing a random model per request**. The response `model` field is the model it actually used | OpenRouter docs |
| **Not yet known:** the exact key Magica uses for crop's `output` field | Learned from the first live run (≈5k microcredits) |

---

## 1. Repos and setup (≈1.5 h)

```
galaxy-chat-backend/     Next.js 15 App Router, route handlers only + Trigger.dev tasks + Prisma
galaxy-chat-frontend/    Next.js 15 App Router + shadcn + Tailwind + TanStack Query + Zustand
```

**Backend dependencies:**
- `zod`, `@asteasolutions/zod-to-openapi`, `@prisma/client`, `prisma`
- `@trigger.dev/sdk`, `@clerk/nextjs`, `openai` (only as the OpenRouter HTTP client), `pino`
- Dev: `vitest`, `msw`

**Frontend dependencies:**
- `@clerk/nextjs`, `@tanstack/react-query`, `zustand`, `@trigger.dev/react-hooks`
- `openapi-fetch`, `openapi-typescript`, `zod`

**Backend `.env`** (move the existing `~/Desktop/galaxy/.env` here and add it to `.gitignore`):
```
DATABASE_URL=            # Neon pooled
DIRECT_URL=              # Neon direct (migrations)
CLERK_SECRET_KEY=
CLERK_PUBLISHABLE_KEY=
FRONTEND_ORIGIN=http://localhost:3001
TRIGGER_SECRET_KEY=
OPENROUTER_API_KEY=
OPENROUTER_MODEL=openrouter/free      # rejected at boot if it is anything else
MAGICA_API_KEY=gx_...
MAGICA_BASE_URL=https://inference.magica.com
MAGICA_MODE=fixture                   # fixture | live
MAGICA_DAILY_CAP_MICRO=200000         # hard cap on live spend per day
NEW_USER_GRANT_MICRO=5000000          # app credits given at signup
```
- All of these are parsed once in `src/env.ts` with Zod. The app crashes at boot if any are missing or invalid.
- The Trigger.dev cloud environment needs the same values, set in the dashboard or through `syncEnvVars` in `trigger.config.ts`.

---

## 2. Data model: `prisma/schema.prisma` (≈1 h)

```prisma
enum MessageRole   { user assistant system tool }
enum MessageStatus { streaming success failed cancelled }
enum RunStatus     { queued running waiting completed failed cancelled }
enum ToolStatus    { pending dispatching running completed failed cancelled }

model User {
  id           String   @id @default(cuid())
  clerkId      String   @unique
  balanceMicro BigInt   @default(0)            // cache of SUM(ledger), updated in the same tx
  createdAt    DateTime @default(now())
  chats        Chat[]
  runs         AgentRun[]
  ledger       CreditLedger[]
}

model Chat {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  title     String    @default("New chat")
  pinned    Boolean   @default(false)
  deletedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  messages  Message[]
  runs      AgentRun[]
  @@index([userId, updatedAt(sort: Desc), id(sort: Desc)])   // matches ORDER BY updatedAt DESC, id DESC
}

model Message {
  id              String        @id @default(cuid())
  chatId          String
  chat            Chat          @relation(fields: [chatId], references: [id], onDelete: Cascade)
  role            MessageRole
  status          MessageStatus @default(success)
  content         Json          // ContentBlock[] – validated by Zod on write AND read
  clientMessageId String?       // double-submit guard
  runId           String?       @unique   // assistant message ↔ run (1:1)
  checkpointStep  Int           @default(-1)  // last LLM step persisted; UI renders live parts only after it
  run             AgentRun?     @relation("RunAssistantMessage", fields: [runId], references: [id])
  errorCode       String?
  errorMessage    String?
  createdAt       DateTime      @default(now())
  @@unique([chatId, clientMessageId])
  @@index([chatId, createdAt(sort: Desc), id(sort: Desc)])   // matches ORDER BY createdAt DESC, id DESC
}

model AgentRun {
  id               String    @id @default(cuid())
  chatId           String
  chat             Chat      @relation(fields: [chatId], references: [id], onDelete: Cascade)
  userId           String    // denormalized: ownership checks + per-user rate limit without joins
  user             User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  userMessageId    String    @unique
  status           RunStatus @default(queued)
  triggerRunId     String?   @unique
  steps            Int       @default(0)
  routedModels     String[]  // one entry per LLM step (the free router can switch model mid-turn)
  usage            Json?     // {promptTokens, completionTokens} – 0 app credits
  errorCode        String?
  errorMessage     String?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
  finishedAt       DateTime?
  assistantMessage Message?  @relation("RunAssistantMessage")
  tools            ToolInvocation[]
  ledger           CreditLedger[]
  @@index([chatId, createdAt])
  @@index([userId, createdAt])
}

model ToolInvocation {
  id           String     @id @default(cuid())
  runId        String
  run          AgentRun   @relation(fields: [runId], references: [id], onDelete: Cascade)
  toolCallId   String     // from the LLM
  seq          Int        // order within the turn, so rendering is deterministic
  name         String
  status       ToolStatus @default(pending)
  input        Json       // sanitized, Zod-validated
  output       Json?
  magicaRunId  String?    @unique
  creditsMicro BigInt     @default(0)
  startedAt    DateTime?
  finishedAt   DateTime?
  durationMs   Int?
  errorCode    String?
  errorMessage String?
  createdAt    DateTime   @default(now())
  ledger       CreditLedger[]
  @@unique([runId, toolCallId])
}

model CreditLedger {
  id               String   @id @default(cuid())
  userId           String
  user             User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  deltaMicro       BigInt   // + grant/refund, − charge
  reason           String   // grant | tool_charge | refund
  idempotencyKey   String   @unique   // "grant:<userId>", "tool:<toolInvocationId>"
  runId            String?
  run              AgentRun?       @relation(fields: [runId], references: [id], onDelete: SetNull)
  toolInvocationId String?
  toolInvocation   ToolInvocation? @relation(fields: [toolInvocationId], references: [id], onDelete: SetNull)
  createdAt        DateTime @default(now())
  @@index([userId, createdAt])
  @@index([runId])             // FK: Postgres does not index FKs automatically
  @@index([toolInvocationId])  // FK
}

// One row per provider per day. The spend cap check is a single-row read, not a SUM over ToolInvocation.
model ProviderSpendDaily {
  provider   String   // "magica"
  day        DateTime @db.Date
  spentMicro BigInt   @default(0)
  @@id([provider, day])
}
```

**Hand-written SQL.** Generate the migration with `prisma migrate dev --create-only`, then append this to it:
```sql
-- one active run per chat, enforced by the database, not by app logic
CREATE UNIQUE INDEX "AgentRun_one_active_per_chat"
  ON "AgentRun"("chatId") WHERE "status" IN ('queued','running','waiting');
```
**Cursor queries** use a row comparison so Postgres can seek straight into the index. Prisma's `OR` form can't express this, so it goes through `$queryRaw` inside the repository:
```sql
SELECT ... FROM "Message"
WHERE "chatId" = $1 AND ("createdAt", "id") < ($2, $3)   -- cursor = last row of the previous page
ORDER BY "createdAt" DESC, "id" DESC
LIMIT $4 + 1;                                           -- one extra row tells us whether a next page exists
```
Leave `RunSkill`, `Waitpoint` and `Attachment` for Day 2. Those migrations only add tables, so they're safe.

---

## 3. Contracts: `src/contracts/` (Zod, the single source of truth)

```ts
// content.ts – what Message.content holds
export const SafeError = z.object({ code: z.string(), message: z.string(), retryable: z.boolean() });
export const ContentBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"),        text: z.string() }),
  z.object({ type: z.literal("thinking"),    text: z.string(), durationMs: z.number().int().optional() }),
  z.object({ type: z.literal("tool_use"),    toolCallId: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("tool_result"), toolCallId: z.string(), status: z.enum(["completed","failed","cancelled"]),
             output: z.unknown().optional(), error: SafeError.optional() }),
  z.object({ type: z.literal("asset"),       kind: z.enum(["image","video","audio"]), url: z.string().url(), toolCallId: z.string() }),
]);

// realtime.ts – run metadata (state) and stream parts (tokens) are kept separate, as the doc requires
export const RunMeta = z.object({
  status: z.enum(["thinking","working","complete","failed","cancelled","stopping"]),
  step: z.number().int(),
  label: z.string().optional(),                       // "Cropping image…"
  tools: z.record(z.object({ name: z.string(), status: ToolStatusEnum, seq: z.number(),
                             durationMs: z.number().optional(), creditsMicro: z.number().optional(),
                             assetUrl: z.string().optional(), error: SafeError.optional() })),
});
export const StreamPart = z.discriminatedUnion("t", [
  z.object({ t: z.literal("text"),     step: z.number(), d: z.string() }),
  z.object({ t: z.literal("thinking"), step: z.number(), d: z.string() }),
]);

// api.ts – request/response for every route below; registered in the OpenAPI registry
```
- **How the frontend gets these types:** `GET /api/openapi.json` is generated from the registry. The frontend runs `pnpm gen:api` (`openapi-typescript`), then calls the API through `openapi-fetch`.
- `RunMeta` and `StreamPart` are registered as OpenAPI components too, so the frontend gets their types from the same generated file.

---

## 4. Tool registry and the Magica adapter (≈1.5 h)

```ts
// src/tools/types.ts
export interface ToolDef<I, O> {
  name: string;                         // "crop_image"
  description: string;                  // shown to the LLM
  label: (i: I) => string;              // "Cropping image…"
  input: z.ZodType<I>;                  // LLM-facing (JSON schema via z.toJSONSchema)
  output: z.ZodType<O>;
  estimateMicro: (i: I) => bigint;      // for the credit gate
  assets: (o: O) => { kind: "image"|"video"|"audio"; url: string }[];
  magica?: {                            // present ⇒ executed by the generic magica-run task
    nodeType: string;
    subModelId?: (i: I) => string | undefined;
    toMagicaInput: (i: I) => Record<string, unknown>;
    fromMagicaOutput: (raw: unknown) => O;
  };
}
// src/tools/registry.ts
export const tools = { crop_image: cropImage } satisfies Record<string, ToolDef<any, any>>;
```
**Adding GPT Image 2 or Merge Videos tomorrow means one new file plus one line in the registry.** No changes to the agent loop or the task.

### 4.1 `src/tools/magica/client.ts`
```ts
class MagicaClient {
  run(nodeType, { input, subModelId, webhook }): Promise<{ runId: string }>   // POST, expects 202
  getRun(runId): Promise<MagicaRun>                                           // GET, Zod-parsed
}
MagicaRun = { id, status: "QUEUED"|"RUNNING"|"COMPLETED"|"FAILED"|"CANCELED",
              output: unknown|null, error: string|null, userMessage: string|null, creditUsed: number }
```
- **Timeout:** every request uses `AbortSignal.timeout(15_000)`.
- The base URL and key come from `env`. The key is never logged; the pino redact list includes `authorization` and `*.apiKey`.
- **Error mapping** turns responses into `MagicaError { code, status, retryable, userMessage, traceId }`:

| HTTP | code | retryable | user-facing message |
|---|---|---|---|
| 400 | `invalid_input` | no | Magica's `message` |
| 401 | `unauthorized` | no | "Image service is misconfigured." (and we log an alert) |
| 403 | `provider_credits` | no | "Image service is out of credits." |
| 404 / 410 | `model_unavailable` | no | "This tool is temporarily unavailable." |
| 429 | `rate_limited` | yes (backoff 2 s → 4 s → 8 s, max 3) | "Busy, retrying…" |
| 5xx / network / timeout | `provider_error` | yes (same backoff) | "Image service error." |

- **`MAGICA_MODE=fixture`:** `run()` returns a fake runId, and `getRun()` returns `fixtures/magica/crop_image.completed.json` after a 2 s cancellable delay.
- **`MAGICA_MODE=live`:** before dispatch, reserve the estimate atomically in `ProviderSpendDaily`:
  ```sql
  INSERT INTO "ProviderSpendDaily" (provider, day, "spentMicro") VALUES ('magica', CURRENT_DATE, 0) ON CONFLICT DO NOTHING;
  UPDATE "ProviderSpendDaily" SET "spentMicro" = "spentMicro" + $est
  WHERE provider = 'magica' AND day = CURRENT_DATE AND "spentMicro" + $est <= $cap;   -- 0 rows updated = over the cap
  ```
  Settlement then adds `actual − estimate`, in the same transaction as the ledger row. Concurrent tool calls can't push spend past the cap, and the check reads one row.

### 4.2 `src/tools/magica/crop-image.ts`
The LLM gets a **simple 5-field input** instead of Magica's nine. Free models handle that better.
```ts
const Rect = z.object({ x: z.number().min(0).optional(), y: z.number().min(0).optional(),
                        width: z.number().positive(), height: z.number().positive() });
export const CropInput = z.preprocess(
  (v: any) => (v?.crop ? { ...v, ...v.crop } : v),             // accept crop.{x,y,width,height} too
  z.object({ image_url: z.string().url().startsWith("https://"),
             unit: z.enum(["percent", "pixels"]) }).merge(Rect)
).superRefine((i, ctx) => {
  if (i.unit === "percent") {
    if (i.x === undefined || i.y === undefined) ctx.addIssue({ code: "custom", message: "percent crop needs x and y" });
    if ((i.x ?? 0) + i.width > 100 || (i.y ?? 0) + i.height > 100) ctx.addIssue({ code: "custom", message: "crop exceeds image bounds" });
  } else if ((i.x === undefined) !== (i.y === undefined)) {
    ctx.addIssue({ code: "custom", message: "give both x and y, or neither to centre" });
  }
});
toMagicaInput = (i) => i.unit === "percent"
  ? { image_url: i.image_url, x_percent: i.x, y_percent: i.y, width_percent: i.width, height_percent: i.height }
  : { image_url: i.image_url, width_px: i.width, height_px: i.height,
      ...(i.x !== undefined && { x_px: i.x, y_px: i.y }) };
fromMagicaOutput = (raw) => CropOutput.parse({ image_url: pickUrl(raw) });   // pickUrl: output.image_url ?? output.images?.[0]; fixed after first live run
estimateMicro = () => 5_000n;
```
If validation fails, the tool never reaches Magica. The model gets back a `tool_result` error with the Zod message and can correct itself.

---

## 5. OpenRouter adapter and the agent loop (≈1.5 h)

### 5.1 `src/agent/llm.ts`: the interface the agent uses (provider-neutral)
```ts
interface LlmProvider {
  stream(req: { messages: LlmMessage[]; tools: LlmToolSpec[]; signal: AbortSignal }):
    AsyncIterable<{ type: "text" | "thinking"; delta: string }
                | { type: "tool_call"; id: string; name: string; argsJson: string }
                | { type: "done"; model: string; usage: Usage; finish: string }>;
}
```
- The OpenRouter implementation uses `new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey })` with `model: env.OPENROUTER_MODEL` and `stream: true`.
- Tool calls arrive in pieces, grouped by `index`. Collect all the pieces, then emit each tool call once the stream finishes.
- `delta.reasoning` is emitted as `thinking`.
- **Failures:**

| Case | Handling |
|---|---|
| 429 / 503 | Retry up to 3 times with backoff 1 s → 3 s → 9 s, then throw `LlmUnavailable` (terminal and user-safe: "Free models are busy right now, retry in a minute."). There is no paid fallback. |
| Empty stream (no text, no tool calls) | Retry once, then `LlmEmptyResponse`. |
| Malformed `argsJson` | Not thrown. Returned to the model as a `tool_result` error, which lets it repair the call once. |

### 5.2 `src/agent/loop.ts`: pure logic that doesn't call Trigger.dev directly
```ts
async function runAgentTurn(ctx: TurnCtx): Promise<TurnResult> {
  const messages = await ctx.history.load();                 // summary + messages after it, token-budgeted (plans/07)
  for (let step = 0; step < MAX_STEPS /* 8 */; step++) {
    ctx.meta.set({ status: "thinking", step });
    const { text, thinking, toolCalls, model, usage } = await ctx.llm.streamStep(messages, ctx.stream, step);
    await ctx.persist.stepDone({ step, text, thinking, toolCalls, model, usage });   // checkpoint every step
    if (!toolCalls.length) return { status: "completed" };
    ctx.meta.set({ status: "working", step });
    const results = await ctx.tools.executeAll(toolCalls);   // parallel; results ordered by seq
    messages.push(assistantMsg(text, toolCalls), ...results.map(toolMsg));
  }
  return { status: "completed", note: "max_steps" };
}
```
`ctx` is injected, which is how Vitest can test the loop without Trigger.dev, Postgres or the network. `executeAll` does the following for each call:
1. Look the tool up in the registry. An unknown tool becomes an error result.
2. Parse `argsJson` and validate it with `tool.input`. Invalid input becomes an error result.
3. Credit gate: if `balanceMicro < estimateMicro`, fail the tool with `insufficient_credits` and **stop the loop safely**.
4. Upsert the `ToolInvocation` on `(runId, toolCallId)`. If it is already terminal, return the stored result, which prevents duplicate work on retry.
5. `magica` tools: `magicaRun.triggerAndWait({ toolInvocationId }, { idempotencyKey: toolInvocationId })`.
6. On completion, settle credits in one transaction: ledger row `tool:<id>` (unique) plus `UPDATE "User" SET balanceMicro = balanceMicro - x`. This charges exactly once.

---

## 6. Trigger.dev tasks (≈1 h)

### 6.1 `src/trigger/agent-turn.ts`
```ts
export const assistantStream = streams.define<StreamPart>({ id: "assistant" });

export const agentTurn = task({
  id: "agent-turn",
  retry: { maxAttempts: 2 },
  run: async ({ runId }: { runId: string }, { ctx, signal }) => {
    const run = await db.agentRun.findUniqueOrThrow(...);
    if (isTerminal(run.status)) return;                         // idempotent re-delivery
    await db.agentRun.update({ status: "running", triggerRunId: ctx.run.id });
    const msg = await upsertAssistantMessage(run.id);           // unique runId ⇒ safe on retry
    try {
      const res = await runAgentTurn(buildCtx(run, msg, signal));
      await finalize(run, msg, "success");                      // message success, run completed, finishedAt
      metadata.set("status", "complete");
    } catch (e) {
      const safe = toSafeError(e);
      await finalize(run, msg, "failed", safe);                 // partial text + tool results kept
      metadata.set("status", "failed").set("error", safe);
      throw e instanceof RetryableError ? e : new AbortTaskRunError(safe.message);
    }
  },
  onCancel: async ({ payload }) => finalize(..., "cancelled"),
});
```
- Text deltas are written with `assistantStream.append(part)`.
- Accumulated text is saved **at each step boundary**, not on every token. That keeps it to one DB write per step while never losing more than the current step.

### 6.2 `src/trigger/magica-run.ts`: waits without using compute
```ts
export const magicaRun = task({
  id: "magica-run",
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 2000 },
  run: async ({ toolInvocationId }) => {
    const inv = await db.toolInvocation.findUniqueOrThrow(...);
    if (isTerminal(inv.status)) return inv.output;              // already done
    const tool = registry[inv.name];
    const token = await wait.createToken({ timeout: "10m", idempotencyKey: `magica:${inv.id}` });

    let magicaRunId = inv.magicaRunId;
    if (!magicaRunId) {                                         // never start a second Magica run
      ({ runId: magicaRunId } = await magica.run(tool.magica.nodeType, {
        input: tool.magica.toMagicaInput(inv.input),
        subModelId: tool.magica.subModelId?.(inv.input),
        webhook: { url: token.url, events: ["run.completed", "run.failed", "run.canceled"] },
      }));
      await db.toolInvocation.update({ magicaRunId, status: "running", startedAt: new Date() });
    }

    await wait.forToken(token.id);                               // suspended, no compute; webhook body ignored
    let r = await magica.getRun(magicaRunId);                    // GET is the source of truth, never the webhook payload
    for (let i = 0; !isMagicaTerminal(r) && i < 60; i++) {       // fallback if the webhook was lost
      await wait.for({ seconds: 5 });
      r = await magica.getRun(magicaRunId);
    }
    return persistTerminal(inv, tool, r);                        // output / error / creditsMicro / durationMs
  },
});
```
- **Why point the webhook at the Trigger token URL:** there's no webhook route of ours to secure, no Svix secret to store, and it works from `trigger dev` locally.
- **Why a forged call can't do damage:** after waking up, the task always re-reads the run from Magica with `GET`. A forged POST to the token URL can at worst wake the task early.

---

## 7. REST routes: `app/api/v1/**` (≈1 h)

**Rate limiting on Day 1 covers sends only:** at most 10 `AgentRun` rows per user in the last 60 s, served by the `AgentRun(userId, createdAt)` index. Other routes have no rate limit until Day 2, when a `RateLimiter` backend (a `RateLimitBucket` table or Redis) is added behind the same interface.

Every route goes through the same wrapper: `withRoute({ auth: true, body: Schema, query: Schema }, handler)`. The wrapper handles:
- Clerk `auth()` (the frontend sends `Authorization: Bearer <session token>`; `authorizedParties: [FRONTEND_ORIGIN]`)
- Upserting the `User` row (plus a one-time grant, ledger key `grant:<userId>`)
- Zod parsing
- The error envelope `{ error: { code, message, traceId } }`
- A pino child logger carrying `traceId`
- CORS for `FRONTEND_ORIGIN`, including `OPTIONS`

| Method and path | Purpose |
|---|---|
| `GET  /api/v1/me` | Profile and `balanceMicro` |
| `POST /api/v1/chats` | Create a chat |
| `GET  /api/v1/chats?cursor=` | Chat list; cursor is `(updatedAt,id)`, limit 30 |
| `GET  /api/v1/chats/:id/messages?cursor=` | Newest first, cursor is `(createdAt,id)`, limit 30 |
| `POST /api/v1/chats/:id/messages` | **Send a turn** (below) |
| `GET  /api/v1/runs/:id` | REST fallback: run status, meta snapshot, assistant message |
| `POST /api/v1/runs/:id/cancel` | `runs.cancel(triggerRunId)` → `stopping` |
| `GET  /api/openapi.json` | Generated spec |

**Send turn** (`POST /chats/:id/messages`, body `{ text ≤ 8000 chars, clientMessageId: uuid }`):
1. Check auth and body. Check ownership with `findFirst({ id, userId, deletedAt: null })`. Anything else returns **404**, never 403, so the response doesn't reveal that the chat exists.
2. Admission check: `balanceMicro ≥ 5_000`, otherwise `402 insufficient_credits`.
3. Transaction:
   - Insert the user `Message` (unique `clientMessageId`).
   - Insert an `AgentRun` with status `queued`.
   - If the partial unique index throws P2002 → `409 run_active`, and the response includes the active `runId` so the UI can re-attach to it.
   - If `clientMessageId` is a duplicate → return the existing run instead (safe double-submit).
4. After commit: `tasks.trigger("agent-turn", { runId }, { idempotencyKey: runId, tags: [\`chat_${chatId}\`] })`. If this fails, mark the run failed and return `503`.
5. Return `202 { chatId, messageId, runId, realtime: { triggerRunId, publicAccessToken } }`. The token is `handle.publicAccessToken`, which can only read this one run.

---

## 8. Frontend, minimal version (≈1 h; UI polish is Day 3)

```
lib/api/client.ts      openapi-fetch + Clerk getToken() header; the only place fetch is called
lib/api/queries.ts     useChats, useMessages (infinite), useSendMessage, useCancelRun (TanStack Query)
lib/realtime.ts        useLiveRun(runId, token): useRealtimeRun (meta) + useRealtimeStream("assistant") → Zustand slice
app/chat/[id]/page.tsx MessageList (persisted) + LiveAssistantBubble (stream) + Composer (send/stop)
components/blocks/     TextBlock, ThinkingBlock, ToolCard (pending/running/done/failed), ImageAsset
```
- **When a run finishes** (`meta.status` is terminal): invalidate `useMessages`, then drop the live bubble. The saved message replaces it, so a finished turn is never shown twice.
- **On reload:** `GET /chats/:id/messages` returns the assistant message with `status: streaming` and its `runId`, and `GET /runs/:id` returns a fresh token. The page then re-subscribes with `startIndex` = the stored chunk count.

---

## 9. Logging
- pino child logger with `{ chatId, runId, messageId, traceId, triggerRunId, toolInvocationId, magicaRunId }`.
- One line per state change: `run.queued`, `run.started`, `llm.step`, `tool.dispatched`, `tool.completed`, `credits.settled`, `run.finished`.
- The Magica key, the Clerk token and prompt bodies are never logged.

---

## 10. Tests written today (Vitest + MSW, all using fixtures, 0 credits)
| Test | What it checks |
|---|---|
| `crop-input.test.ts` | percent without x/y → error; out-of-bounds → error; pixels with x but no y → error; `crop.{…}` alias gets normalised; the http:// URL is rejected |
| `magica-client.test.ts` | Each status 400/401/403/404/410/429/500/timeout maps to the right `code` and `retryable` flag |
| `magica-run.test.ts` | An existing `magicaRunId` means no second POST (duplicate dispatch); the webhook is lost, so polling finishes the run; FAILED is saved with `userMessage` |
| `loop.test.ts` | A fake LLM returns tool call → text; results come back ordered by seq; malformed args are fed back to the model; max steps; insufficient credits stops safely |
| `send-route.test.ts` | Double submit → same run; a second concurrent send → 409; another user's chat → 404 |

---

## 11. Day 1 timeline and cut-line
| Time | Block | Done when |
|---|---|---|
| 0:00–1:30 | Repos, Clerk, Neon, Trigger.dev init, env schema | Both apps boot; `trigger dev` connects |
| 1:30–2:30 | Prisma schema + migration + partial index | `migrate dev` applies cleanly |
| 2:30–4:00 | Magica client + crop tool + tests (fixture mode) | Tests pass |
| 4:00–5:30 | OpenRouter adapter + loop + `agent-turn` + `magica-run` | A run started from the Trigger.dev dashboard completes in fixture mode |
| 5:30–6:30 | REST routes + send flow | curl send → 202 → run completes → rows are correct |
| 6:30–7:30 | Minimal frontend + streaming | Browser shows streamed text and the tool card |
| 7:30–8:00 | **One live crop** (needs your OK, ≈5k microcredits), save the fixture, deploy to Vercel | Cropped image renders; it survives a reload |

**Cut-line if behind:** drop the frontend (step 6:30) and demo it with curl plus the Trigger.dev dashboard. The backend flow matters more for Day 1.

---

## 12. Verifying Day 1 end to end
1. `pnpm test` passes, with 0 Magica credits used.
2. `curl -X POST /api/v1/chats/:id/messages` twice with the same `clientMessageId` → the same `runId`.
3. Two different messages sent at the same time → one `202` and one `409 run_active`.
4. Live: *"crop the left half of <https image>"*. Then:
   - `ToolInvocation` has `magicaRunId`, `completed`, `durationMs` and `creditsMicro=5000`.
   - `CreditLedger` has exactly one `tool:<id>` row.
   - `GET /v1/credits/balance` on Magica dropped by about 5,000.
5. Reload the chat in the middle of the run → the live bubble comes back. Reload after it finishes → the cropped image loads from Postgres.
6. Set `MAGICA_API_KEY=bad` in fixture-off mode → the tool card shows "Image service is misconfigured"; the run is `failed`, the partial text is kept, and retry is available.
