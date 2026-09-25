import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const rt = vi.hoisted(() => ({
  dispatchTurn: vi.fn(async (runId: string) => `trig_${runId}`),
  mintRunToken: vi.fn(async (triggerRunId: string) => ({ triggerRunId, publicAccessToken: "pk_test", expiresAt: new Date().toISOString() })),
}));
vi.mock("./realtime", () => rt);

import { ensureUser, prisma } from "@gx/db";
import { resetDb, seedUserWithChat } from "@gx/db/testing";
import { logger } from "@gx/observability";
import { sendTurn } from "./turns";

beforeEach(async () => (await resetDb(), vi.clearAllMocks()));
afterAll(() => prisma.$disconnect());

const body = (clientMessageId = randomUUID()) => ({ clientMessageId, text: "crop the left half" });

describe("sendTurn", () => {
  it("admits, dispatches once, and returns realtime access; a replay returns the same run", async () => {
    const { user, chat } = await seedUserWithChat();
    const b = body();
    const first = await sendTurn(user, chat.id, b, logger);
    const replay = await sendTurn(user, chat.id, b, logger);

    expect(first.status).toBe(202);
    expect(replay.status).toBe(200);
    expect(replay.data.runId).toBe(first.data.runId);
    expect(rt.dispatchTurn).toHaveBeenCalledOnce();
    expect(first.data.realtime).toMatchObject({ triggerRunId: `trig_${first.data.runId}`, publicAccessToken: "pk_test" });
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: first.data.runId } })).triggerRunId).toBe(`trig_${first.data.runId}`);
  });

  it("a failed dispatch marks the run failed, returns 503, and frees the chat", async () => {
    const { user, chat } = await seedUserWithChat();
    rt.dispatchTurn.mockRejectedValueOnce(new Error("trigger down"));
    await expect(sendTurn(user, chat.id, body(), logger)).rejects.toMatchObject({ code: "dispatch_failed" });
    expect((await prisma.agentRun.findFirstOrThrow()).status).toBe("failed");
    await expect(sendTurn(user, chat.id, body(), logger)).resolves.toMatchObject({ status: 202 });
  });

  it("rejects a send while a reply is running", async () => {
    const { user, chat } = await seedUserWithChat();
    const first = await sendTurn(user, chat.id, body(), logger);
    await expect(sendTurn(user, chat.id, body(), logger)).rejects.toMatchObject({ code: "run_active", details: { activeRunId: first.data.runId } });
  });

  it("blocks users without credits before anything is saved", async () => {
    const { user, chat } = await seedUserWithChat("poor", 0n);
    await expect(sendTurn(user, chat.id, body(), logger)).rejects.toMatchObject({ code: "insufficient_credits" });
    expect(await prisma.message.count()).toBe(0);
  });

  it("rate limits sends per user", async () => {
    const { user, chat } = await seedUserWithChat();
    for (let i = 0; i < 10; i++) {
      const r = await sendTurn(user, chat.id, body(), logger);
      await prisma.agentRun.update({ where: { id: r.data.runId }, data: { status: "completed" } });
    }
    await expect(sendTurn(user, chat.id, body(), logger)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("hides other users' chats", async () => {
    const { chat } = await seedUserWithChat("owner");
    const intruder = await ensureUser("intruder", 1_000_000n);
    await expect(sendTurn(intruder, chat.id, body(), logger)).rejects.toMatchObject({ code: "not_found" });
  });
});
