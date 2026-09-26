import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const rt = vi.hoisted(() => ({ completeWaitpointToken: vi.fn(async (_id: string, _d: unknown) => {}) }));
vi.mock("./realtime", () => rt);

import { admitTurn, ensureUser, prisma, setWaitpointToken, upsertWaitpoint } from "@gx/db";
import { resetDb, seedUserWithChat } from "@gx/db/testing";
import { logger } from "@gx/observability";
import { answerWaitpointTurn } from "./waitpoints";

beforeEach(async () => (await resetDb(), vi.clearAllMocks()));
afterAll(() => prisma.$disconnect());

async function pending(withToken = true) {
  const { user, chat } = await seedUserWithChat();
  const run = await admitTurn({ userId: user.id, chatId: chat.id, clientMessageId: randomUUID(), text: "x" });
  const wp = await upsertWaitpoint({
    runId: run.runId,
    key: "0:c1",
    request: { kind: "options", question: "Which?", options: ["A", "B"] },
    expiresAt: new Date(Date.now() + 60_000),
  });
  if (withToken) await setWaitpointToken(wp.id, "waitpoint_tok_1");
  return { user, wp };
}

describe("answerWaitpointTurn", () => {
  it("saves the answer and wakes the run once", async () => {
    const { user, wp } = await pending();
    expect(await answerWaitpointTurn(user, wp.id, { choice: "A" }, logger)).toEqual({ id: wp.id, status: "answered" });
    expect(rt.completeWaitpointToken).toHaveBeenCalledOnce();
    expect(rt.completeWaitpointToken).toHaveBeenCalledWith("waitpoint_tok_1", { answered: true });
  });

  it("rejects an answer that is not one of the offered options and leaves the question open", async () => {
    const { user, wp } = await pending();
    await expect(answerWaitpointTurn(user, wp.id, { choice: "C" }, logger)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(answerWaitpointTurn(user, wp.id, { approve: true }, logger)).rejects.toMatchObject({ code: "validation_failed" });
    expect((await prisma.waitpoint.findUniqueOrThrow({ where: { id: wp.id } })).status).toBe("pending");
    expect(rt.completeWaitpointToken).not.toHaveBeenCalled();
  });

  it("if waking fails the answer stays saved, and sending it again wakes the run", async () => {
    const { user, wp } = await pending();
    rt.completeWaitpointToken.mockRejectedValueOnce(new Error("trigger down"));
    await expect(answerWaitpointTurn(user, wp.id, { choice: "B" }, logger)).rejects.toMatchObject({ code: "dispatch_failed" });
    expect((await prisma.waitpoint.findUniqueOrThrow({ where: { id: wp.id } })).status).toBe("answered");
    expect(await answerWaitpointTurn(user, wp.id, { choice: "B" }, logger)).toMatchObject({ status: "answered" });
    expect(rt.completeWaitpointToken).toHaveBeenCalledTimes(2);
  });

  it("a different answer after the first is refused with 409", async () => {
    const { user, wp } = await pending();
    await answerWaitpointTurn(user, wp.id, { choice: "A" }, logger);
    await expect(answerWaitpointTurn(user, wp.id, { choice: "B" }, logger)).rejects.toMatchObject({ code: "waitpoint_closed" });
  });

  it("someone else's question is not found", async () => {
    const { wp } = await pending();
    const stranger = await ensureUser("user_stranger", 0n);
    await expect(answerWaitpointTurn(stranger, wp.id, { choice: "A" }, logger)).rejects.toMatchObject({ code: "not_found" });
  });

  it("with no token yet the answer is saved and the worker picks it up", async () => {
    const { user, wp } = await pending(false);
    await answerWaitpointTurn(user, wp.id, { choice: "A" }, logger);
    expect(rt.completeWaitpointToken).not.toHaveBeenCalled();
    expect((await prisma.waitpoint.findUniqueOrThrow({ where: { id: wp.id } })).status).toBe("answered");
  });
});
