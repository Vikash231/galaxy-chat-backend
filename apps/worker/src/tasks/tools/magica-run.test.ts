import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

const trigger = vi.hoisted(() => ({
  createToken: vi.fn(async () => ({ id: "tok_1", url: "https://api.trigger.dev/api/v1/waitpoints/tokens/tok_1/complete", isCached: false })),
  forToken: vi.fn(async () => ({ ok: true, output: {} })),
  waitFor: vi.fn(async () => {}),
}));
vi.mock("@trigger.dev/sdk", () => ({
  task: (def: unknown) => def,
  queue: (q: unknown) => q,
  wait: { createToken: trigger.createToken, forToken: trigger.forToken, for: trigger.waitFor },
  AbortTaskRunError: class extends Error {},
}));

import { admitTurn, prisma, upsertInvocation } from "@gx/db";
import { resetDb, seedUserWithChat } from "@gx/db/testing";
import { magicaRun } from "./magica-run";

const BASE = "https://magica.test";
const server = setupServer();
const posts: unknown[] = [];
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(async () => (server.close(), await prisma.$disconnect()));

const run = (toolInvocationId: string) =>
  (magicaRun as unknown as { run: (p: object, c: object) => Promise<Record<string, unknown>> }).run({ toolInvocationId }, { ctx: { run: { id: "run_trigger_1" } } });

const acceptRun = (runId = "mg_1") =>
  http.post(`${BASE}/v1/nodes/crop_image/run`, async ({ request }) => (posts.push(await request.json()), HttpResponse.json({ runId }, { status: 202 })));
const runState = (...states: object[]) => {
  let i = 0;
  return http.get(`${BASE}/v1/nodes/runs/:id`, ({ params }) => HttpResponse.json({ id: params.id, nodeType: "crop_image", creditUsed: 0, ...states[Math.min(i++, states.length - 1)] }));
};
const completed = { status: "COMPLETED", output: { image_url: "https://cdn.magica/c.png" }, creditUsed: 5000 };

async function invocation(over: Record<string, unknown> = {}) {
  const { user, chat } = await seedUserWithChat();
  const { runId } = await admitTurn({ userId: user.id, chatId: chat.id, clientMessageId: randomUUID(), text: "crop" });
  const inv = await upsertInvocation({
    runId, toolCallId: "0:c1", seq: 0, name: "crop_image", estimateMicro: 5_000n,
    input: { image: "https://e.com/a.jpg", unit: "percent", x: 0, y: 0, width: 50, height: 100 },
  });
  if (Object.keys(over).length) await prisma.toolInvocation.update({ where: { id: inv.id }, data: over });
  return inv.id;
}
const spent = async () => (await prisma.providerSpendDaily.findFirst())?.spentMicro ?? 0n;

beforeEach(async () => {
  await resetDb();
  posts.length = 0;
  vi.clearAllMocks();
});

describe("magica-run", () => {
  it("dispatches with the token URL as webhook, waits, reconciles via GET and records cost", async () => {
    server.use(acceptRun(), runState({ status: "RUNNING" }, completed));
    const id = await invocation();
    const out = await run(id);

    expect(out).toMatchObject({ status: "completed", output: { image_url: "https://cdn.magica/c.png" }, creditsMicro: "5000" });
    expect(posts[0]).toMatchObject({ input: { image_url: "https://e.com/a.jpg", x_percent: 0, width_percent: 50 }, webhook: { url: expect.stringContaining("/tok_1/") } });
    expect(trigger.forToken).toHaveBeenCalledOnce();
    const row = await prisma.toolInvocation.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "completed", magicaRunId: "mg_1", creditsMicro: 5000n });
    expect(row.durationMs).not.toBeNull();
    expect(await spent()).toBe(5_000n);
  });

  it("never starts a second Magica run when one is already recorded", async () => {
    server.use(acceptRun(), runState(completed));
    const id = await invocation({ status: "running", magicaRunId: "mg_existing" });
    await expect(run(id)).resolves.toMatchObject({ status: "completed" });
    expect(posts).toHaveLength(0);
  });

  it("returns the stored result for a finished invocation without any provider call", async () => {
    const id = await invocation({ status: "completed", output: { image_url: "https://cdn/x.png" }, creditsMicro: 5000n });
    await expect(run(id)).resolves.toMatchObject({ status: "completed", creditsMicro: "5000" });
    expect(posts).toHaveLength(0);
  });

  it("does not re-POST after a crash mid-dispatch; fails as uncertain instead of risking a double charge", async () => {
    const id = await invocation({ status: "dispatching" });
    await expect(run(id)).resolves.toMatchObject({ status: "failed", error: { code: "dispatch_uncertain" } });
    expect(posts).toHaveLength(0);
  });

  it("releases the claim on 429 so the task retry can dispatch again", async () => {
    server.use(http.post(`${BASE}/v1/nodes/crop_image/run`, () => HttpResponse.json({ message: "slow down" }, { status: 429 })));
    const id = await invocation();
    await expect(run(id)).rejects.toMatchObject({ code: "rate_limited" });
    expect((await prisma.toolInvocation.findUniqueOrThrow({ where: { id } })).status).toBe("pending");
    expect(await spent()).toBe(0n);
  });

  it("fails permanently on 401 with a safe message and releases the reservation", async () => {
    server.use(http.post(`${BASE}/v1/nodes/crop_image/run`, () => HttpResponse.json({ message: "invalid key gx_abc" }, { status: 401 })));
    const id = await invocation();
    const out = await run(id);
    expect(out).toMatchObject({ status: "failed", error: { code: "unauthorized", retryable: false } });
    expect(JSON.stringify(out)).not.toContain("gx_");
    expect(await spent()).toBe(0n);
  });

  it("records a failed Magica run with its user message", async () => {
    server.use(acceptRun(), runState({ status: "FAILED", userMessage: "The image could not be downloaded.", creditUsed: 0 }));
    const id = await invocation();
    await expect(run(id)).resolves.toMatchObject({ status: "failed", creditsMicro: "0", error: { message: "The image could not be downloaded." } });
  });

  it("falls back to polling when the webhook never arrives", async () => {
    trigger.forToken.mockResolvedValueOnce({ ok: false, output: {} } as never);
    server.use(acceptRun(), runState({ status: "RUNNING" }, { status: "RUNNING" }, { status: "RUNNING" }, completed));
    const id = await invocation();
    await expect(run(id)).resolves.toMatchObject({ status: "completed" });
    expect(trigger.waitFor).toHaveBeenCalledTimes(2);
  });

  it("refuses to dispatch once the daily provider cap is reached", async () => {
    await prisma.providerSpendDaily.create({ data: { provider: "magica", day: new Date(new Date().toISOString().slice(0, 10)), spentMicro: 199_000n } });
    const id = await invocation();
    await expect(run(id)).resolves.toMatchObject({ status: "failed", error: { code: "spend_cap" } });
    expect(posts).toHaveLength(0);
  });
});
