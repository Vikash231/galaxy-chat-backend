import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const rt = vi.hoisted(() => ({
  dispatchTurn: vi.fn(async (runId: string) => `trig_${runId}`),
  mintRunToken: vi.fn(async (triggerRunId: string) => ({ triggerRunId, publicAccessToken: "pk_test", expiresAt: new Date().toISOString() })),
  cancelTriggerRun: vi.fn(async () => {}),
  reconcileProviderCall: vi.fn(async () => {}),
  triggerRunEnded: vi.fn(async (): Promise<"cancelled" | "ended" | null> => null),
}));
vi.mock("./realtime", () => rt);

import { ensureUser, markDispatching, markRunning, prisma, saveCancelledMessage, upsertAssistantMessage, upsertInvocation } from "@gx/db";
import { resetDb, seedUserWithChat } from "@gx/db/testing";
import { logger } from "@gx/observability";
import { sendTurn, stopTurn, watchTurn } from "./turns";

beforeEach(async () => (await resetDb(), vi.clearAllMocks()));
afterAll(() => prisma.$disconnect());

const body = (clientMessageId = randomUUID(), attachmentIds: string[] = []) => ({ clientMessageId, text: "crop the left half", attachmentIds });

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

describe("stopTurn", () => {
  async function runningTurn() {
    const { user, chat } = await seedUserWithChat();
    const sent = await sendTurn(user, chat.id, body(), logger);
    const runId = sent.data.runId;
    await prisma.agentRun.update({ where: { id: runId }, data: { status: "running" } });
    const message = await upsertAssistantMessage(chat.id, runId);
    await prisma.message.update({ where: { id: message.id }, data: { content: [{ type: "text", text: "Saved so far." }] } });
    return { user, chat, runId, messageId: message.id };
  }
  const invocation = async (runId: string, toolCallId: string, magicaRunId?: string) => {
    const inv = await upsertInvocation({ runId, toolCallId, seq: 0, name: "crop_image", input: {}, estimateMicro: 5_000n });
    await markDispatching(inv.id);
    if (magicaRunId) await markRunning(inv.id, magicaRunId);
    return inv.id;
  };

  it("records the stop itself, keeps the saved reply, frees the chat, and finishes accepted Magica calls", async () => {
    const { user, chat, runId, messageId } = await runningTurn();
    const accepted = await invocation(runId, "0:a", "mg_1");
    await invocation(runId, "0:b"); // claimed but never accepted: not restarted

    await expect(stopTurn(user, runId, logger)).resolves.toEqual({ runId, status: "cancelled" });

    expect(rt.cancelTriggerRun).toHaveBeenCalledWith(`trig_${runId}`);
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
    expect(await prisma.message.findUniqueOrThrow({ where: { id: messageId } })).toMatchObject({ status: "cancelled", content: [{ type: "text", text: "Saved so far." }] });
    expect(rt.reconcileProviderCall.mock.calls).toEqual([[accepted]]);
    await expect(sendTurn(user, chat.id, body(), logger)).resolves.toMatchObject({ status: 202 });
  });

  it("the worker can still add the text streamed before the stop to the cancelled reply", async () => {
    const { user, runId, messageId } = await runningTurn();
    await stopTurn(user, runId, logger);
    const error = { code: "cancelled", message: "You stopped this reply.", retryable: true };
    await saveCancelledMessage(messageId, [{ type: "text", text: "Saved so far." }, { type: "text", text: "and this streamed" }], error);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: messageId } })).content).toHaveLength(2);
  });

  it("still records the stop when Trigger.dev refuses the cancel", async () => {
    const { user, runId } = await runningTurn();
    rt.cancelTriggerRun.mockRejectedValueOnce(new Error("run already finished"));
    await expect(stopTurn(user, runId, logger)).resolves.toEqual({ runId, status: "cancelled" });
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe("cancelled");
  });

  it("a second stop, or a stop after the reply finished, changes nothing", async () => {
    const { user, runId } = await runningTurn();
    await stopTurn(user, runId, logger);
    await expect(stopTurn(user, runId, logger)).resolves.toEqual({ runId, status: "cancelled" });
    expect(rt.cancelTriggerRun).toHaveBeenCalledOnce();
  });

  it("another user's run looks like it does not exist", async () => {
    const { runId } = await runningTurn();
    const other = await ensureUser("user_other", 0n);
    await expect(stopTurn(other, runId, logger)).rejects.toMatchObject({ code: "not_found" });
    expect(rt.cancelTriggerRun).not.toHaveBeenCalled();
  });
});

describe("watchTurn (recovering runs the worker could not close)", () => {
  async function activeTurn() {
    const { user, chat } = await seedUserWithChat();
    const sent = await sendTurn(user, chat.id, body(), logger);
    await prisma.agentRun.update({ where: { id: sent.data.runId }, data: { status: "running" } });
    await upsertAssistantMessage(chat.id, sent.data.runId);
    return { user, chat, runId: sent.data.runId };
  }

  it("returns a token while Trigger.dev still runs it", async () => {
    const { user, runId } = await activeTurn();
    await expect(watchTurn(user, runId, logger)).resolves.toMatchObject({ publicAccessToken: "pk_test" });
  });

  it("a run Trigger.dev cancelled but Postgres still shows active is recorded as stopped, and its Magica call finished", async () => {
    const { user, chat, runId } = await activeTurn();
    const inv = await upsertInvocation({ runId, toolCallId: "0:a", seq: 0, name: "gpt_image_2", input: {}, estimateMicro: 7_644n });
    await markDispatching(inv.id);
    await markRunning(inv.id, "mg_1");
    rt.triggerRunEnded.mockResolvedValueOnce("cancelled");

    await expect(watchTurn(user, runId, logger)).rejects.toMatchObject({ code: "run_finished" });
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe("cancelled");
    expect((await prisma.message.findUniqueOrThrow({ where: { runId } })).status).toBe("cancelled");
    expect(rt.reconcileProviderCall.mock.calls).toEqual([[inv.id]]);
    expect(rt.mintRunToken).toHaveBeenCalledTimes(1); // only the send; no token for the dead run
    await expect(sendTurn(user, chat.id, body(), logger)).resolves.toMatchObject({ status: 202 });
  });

  it("a run that crashed on Trigger.dev is recorded as failed with a safe message", async () => {
    const { user, runId } = await activeTurn();
    rt.triggerRunEnded.mockResolvedValueOnce("ended");
    await expect(watchTurn(user, runId, logger)).rejects.toMatchObject({ code: "run_finished" });
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: "failed", errorCode: "run_lost" });
    expect((await prisma.message.findUniqueOrThrow({ where: { runId } })).status).toBe("failed");
  });

  it("a finished run gets no token", async () => {
    const { user, runId } = await activeTurn();
    await prisma.agentRun.update({ where: { id: runId }, data: { status: "completed" } });
    await expect(watchTurn(user, runId, logger)).rejects.toMatchObject({ code: "run_finished" });
    expect(rt.triggerRunEnded).not.toHaveBeenCalled();
  });
});
