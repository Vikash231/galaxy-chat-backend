import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AppError } from "@gx/contracts";
import { prisma } from "./client";
import { ensureUser } from "./users";
import { admitTurn, admitRetry, transitionRun } from "./runs";
import { listMessages } from "./messages";
import { listChats, getOwnedChat, updateChat, deleteChat, createChat, MAX_PINNED } from "./chats";
import { settleToolCharge, reserveProviderSpend, adjustProviderSpend } from "./credits";
import { finishInvocation, inFlightProviderCalls, markDispatching, markRunning, upsertInvocation } from "./tools";
import { reserveFileRefs } from "./attachments";
import { recordRunSkill } from "./skills";
import { answerWaitpoint, approvedCapMicro, expireWaitpoint, getOwnedWaitpoint, pendingWaitpoint, spentEstimateMicro, upsertWaitpoint } from "./waitpoints";
import { cancelRun, getRunView } from "./runs";
import { getChatDetail } from "./chats";
import { resetDb, seedUserWithChat } from "./testing";

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const send = (userId: string, chatId: string, clientMessageId = randomUUID(), text = "hi") =>
  admitTurn({ userId, chatId, clientMessageId, text });

describe("users", () => {
  it("parallel first requests create one user and one grant", async () => {
    const users = await Promise.all(Array.from({ length: 5 }, () => ensureUser("user_race", 5_000_000n)));
    expect(new Set(users.map((u) => u.id)).size).toBe(1);
    expect(await prisma.creditLedger.count()).toBe(1);
    expect(users[0]!.balanceMicro).toBe(5_000_000n);
  });
});

describe("admitTurn", () => {
  it("replaying the same clientMessageId returns the original run", async () => {
    const { user, chat } = await seedUserWithChat();
    const id = randomUUID();
    const first = await send(user.id, chat.id, id);
    const replay = await send(user.id, chat.id, id);
    expect(replay).toMatchObject({ runId: first.runId, messageId: first.messageId, replay: true });
    expect(await prisma.agentRun.count()).toBe(1);
  });

  it("rejects a second active run in the same chat, enforced by the partial unique index", async () => {
    const { user, chat } = await seedUserWithChat();
    const first = await send(user.id, chat.id);
    const err = await send(user.id, chat.id).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "run_active", details: { activeRunId: first.runId } });
    // The rejected message must not be left behind: the whole transaction rolled back.
    expect(await prisma.message.count()).toBe(1);
  });

  it("concurrent sends produce exactly one active run", async () => {
    const { user, chat } = await seedUserWithChat();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => send(user.id, chat.id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.agentRun.count()).toBe(1);
  });

  it("a finished run frees the chat for the next turn", async () => {
    const { user, chat } = await seedUserWithChat();
    const first = await send(user.id, chat.id);
    await transitionRun(first.runId, "completed");
    await expect(send(user.id, chat.id)).resolves.toMatchObject({ replay: false });
  });

  it("terminal states are final", async () => {
    const { user, chat } = await seedUserWithChat();
    const { runId } = await send(user.id, chat.id);
    expect(await transitionRun(runId, "cancelled")).toBe(true);
    expect(await transitionRun(runId, "completed")).toBe(false);
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe("cancelled");
  });
});

describe("ownership", () => {
  it("another user's chat is not found", async () => {
    const { chat } = await seedUserWithChat("owner");
    const other = await ensureUser("intruder", 0n);
    await expect(getOwnedChat(other.id, chat.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(listMessages(other.id, chat.id, { limit: 10 })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("cursor pagination", () => {
  it("walks messages newest first with no gaps or repeats, including identical timestamps", async () => {
    const { user, chat } = await seedUserWithChat();
    const at = new Date("2026-09-25T10:00:00.000Z");
    await prisma.message.createMany({
      data: Array.from({ length: 7 }, (_, i) => ({ chatId: chat.id, role: "user" as const, content: [{ type: "text", text: `m${i}` }], createdAt: i < 4 ? at : new Date(at.getTime() + i * 1000) })),
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listMessages(user.id, chat.id, { limit: 3, cursor });
      seen.push(...page.items.map((m) => m.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("lists chats by most recent activity", async () => {
    const { user } = await seedUserWithChat();
    await prisma.chat.create({ data: { userId: user.id, title: "newer" } });
    const page = await listChats(user.id, { limit: 10 });
    expect(page.items[0]!.title).toBe("newer");
  });
});

describe("file names", () => {
  it("never hands out the same name twice in a chat, even concurrently", async () => {
    const { chat } = await seedUserWithChat();
    const batches = await Promise.all(Array.from({ length: 10 }, () => reserveFileRefs(prisma, chat.id, ["image", "image", "video"])));
    const names = batches.flat();
    expect(names).toHaveLength(30);
    expect(new Set(names.map((n) => n.split("_")[1])).size).toBe(30);
    expect(names.filter((n) => n.startsWith("vid_"))).toHaveLength(10);
  });

  it("numbers each chat independently", async () => {
    const a = await seedUserWithChat("u_a");
    const b = await seedUserWithChat("u_b");
    expect(await reserveFileRefs(prisma, a.chat.id, ["image"])).toEqual(["img_1"]);
    expect(await reserveFileRefs(prisma, b.chat.id, ["image"])).toEqual(["img_1"]);
    expect(await reserveFileRefs(prisma, a.chat.id, ["image"])).toEqual(["img_2"]);
  });
});

describe("credits", () => {
  it("charges a tool exactly once", async () => {
    const { user, chat } = await seedUserWithChat("u", 100_000n);
    const { runId } = await send(user.id, chat.id);
    const inv = await upsertInvocation({ runId, toolCallId: "0:a", seq: 0, name: "crop_image", input: {}, estimateMicro: 5_000n });
    const charge = { userId: user.id, runId, toolInvocationId: inv.id, creditsMicro: 5_000n };
    expect(await settleToolCharge(charge)).toBe(true);
    expect(await settleToolCharge(charge)).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).balanceMicro).toBe(95_000n);
  });

  it("the daily provider cap cannot be overshot by concurrent reservations", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => reserveProviderSpend("magica", 5_000n, 20_000n)));
    expect(results.filter(Boolean)).toHaveLength(4);
    await adjustProviderSpend("magica", -5_000n);
    expect(await reserveProviderSpend("magica", 5_000n, 20_000n)).toBe(true);
  });
});

describe("run skills", () => {
  it("records one row per run and skill; later loads, even after the file changed, get the first snapshot", async () => {
    const { user, chat } = await seedUserWithChat();
    const { runId } = await send(user.id, chat.id);
    const first = await recordRunSkill(runId, "product-photo", "hash-v1", "guide v1");
    // A retry of the same run after someone edited the skill file on disk.
    const again = await Promise.all([recordRunSkill(runId, "product-photo", "hash-v2", "guide v2"), recordRunSkill(runId, "product-photo", "hash-v2", "guide v2")]);
    expect(first).toEqual({ contentHash: "hash-v1", content: "guide v1", first: true });
    expect(again).toEqual([
      { contentHash: "hash-v1", content: "guide v1", first: false },
      { contentHash: "hash-v1", content: "guide v1", first: false },
    ]);
    expect(await prisma.runSkill.count({ where: { runId } })).toBe(1);
  });

  it("is removed with its run", async () => {
    const { user, chat } = await seedUserWithChat();
    const { runId } = await send(user.id, chat.id);
    await recordRunSkill(runId, "video-montage", "h", "c");
    await prisma.agentRun.delete({ where: { id: runId } });
    expect(await prisma.runSkill.count()).toBe(0);
  });
});

describe("in-flight provider calls", () => {
  it("lists only calls Magica accepted that have not finished", async () => {
    const { user, chat } = await seedUserWithChat();
    const { runId } = await send(user.id, chat.id);
    const make = (toolCallId: string) => upsertInvocation({ runId, toolCallId, seq: 0, name: "crop_image", input: {}, estimateMicro: 5_000n });
    const [accepted, claimed, done] = await Promise.all([make("0:a"), make("0:b"), make("0:c")]);
    for (const inv of [accepted, claimed, done]) await markDispatching(inv.id);
    await markRunning(accepted.id, "mg_a");
    await markRunning(done.id, "mg_c");
    await finishInvocation(done.id, { status: "completed", creditsMicro: 5_000n });
    // claimed has no Magica run id: its outcome is unknown, and it is never re-dispatched.
    expect(await inFlightProviderCalls(runId)).toEqual([{ id: accepted.id }]);
  });
});

describe("waitpoints", () => {
  const options = { kind: "options" as const, question: "Which?", options: ["A", "B"] };
  const soon = () => new Date(Date.now() + 60_000);
  async function pending(request: Parameters<typeof upsertWaitpoint>[0]["request"] = options, key = "0:c1") {
    const { user, chat } = await seedUserWithChat();
    const run = await send(user.id, chat.id);
    const wp = await upsertWaitpoint({ runId: run.runId, key, request, expiresAt: soon() });
    return { user, chat, run, wp };
  }

  it("asking the same question again returns the same row", async () => {
    const { run, wp } = await pending();
    const again = await upsertWaitpoint({ runId: run.runId, key: "0:c1", request: options, expiresAt: soon() });
    expect(again.id).toBe(wp.id);
    expect(await prisma.waitpoint.count()).toBe(1);
  });

  it("the first answer wins; the same answer again is a duplicate; a different one is refused", async () => {
    const { user, wp } = await pending();
    expect((await answerWaitpoint(user.id, wp.id, { choice: "A" })).result).toBe("answered");
    expect((await answerWaitpoint(user.id, wp.id, { choice: "A" })).result).toBe("duplicate");
    await expect(answerWaitpoint(user.id, wp.id, { choice: "B" })).rejects.toMatchObject({ code: "waitpoint_closed" });
    expect((await prisma.waitpoint.findUniqueOrThrow({ where: { id: wp.id } })).answer).toEqual({ choice: "A" });
  });

  it("two answers at the same moment: exactly one is recorded", async () => {
    const { user, wp } = await pending();
    const r = await Promise.allSettled([answerWaitpoint(user.id, wp.id, { choice: "A" }), answerWaitpoint(user.id, wp.id, { choice: "B" })]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.filter((x) => x.status === "rejected")).toHaveLength(1);
  });

  it("refuses an answer after expiry, after a stop, and from another user", async () => {
    const { user, run, wp } = await pending();
    await prisma.waitpoint.update({ where: { id: wp.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    await expect(answerWaitpoint(user.id, wp.id, { choice: "A" })).rejects.toMatchObject({ code: "waitpoint_closed" });

    const other = await pending(options, "0:c9");
    await cancelRun(other.run.runId, { code: "cancelled", message: "stopped", retryable: true });
    await expect(answerWaitpoint(other.user.id, other.wp.id, { choice: "A" })).rejects.toMatchObject({ code: "waitpoint_closed" });

    const stranger = await ensureUser("user_stranger", 0n);
    await expect(answerWaitpoint(stranger.id, wp.id, { choice: "A" })).rejects.toBeInstanceOf(AppError);
    await expect(getOwnedWaitpoint(stranger.id, wp.id)).rejects.toMatchObject({ code: "not_found" });
    expect(run.runId).toBeTruthy();
  });

  it("expiring only affects a still-pending question", async () => {
    const { user, wp } = await pending();
    await answerWaitpoint(user.id, wp.id, { choice: "A" });
    expect(await expireWaitpoint(wp.id)).toBe(false);
    const second = await pending(options, "0:c2");
    expect(await expireWaitpoint(second.wp.id)).toBe(true);
    expect(await pendingWaitpoint(second.run.runId)).toBeNull();
  });

  it("a stop cancels the run's pending questions", async () => {
    const { run, wp } = await pending();
    await cancelRun(run.runId, { code: "cancelled", message: "stopped", retryable: true });
    expect((await prisma.waitpoint.findUniqueOrThrow({ where: { id: wp.id } })).status).toBe("cancelled");
  });

  it("the approved cap is the biggest approved plan or cost, and only approvals count", async () => {
    const { user, run } = await pending();
    expect(await approvedCapMicro(run.runId)).toBeNull();
    const plan = await upsertWaitpoint({ runId: run.runId, key: "0:p", request: { kind: "plan", summary: "s", steps: [{ text: "t" }], estimateMicro: 12_000 }, expiresAt: soon() });
    await answerWaitpoint(user.id, plan.id, { approve: true });
    const credit = await upsertWaitpoint({ runId: run.runId, key: "credit:1", request: { kind: "credit", tools: [{ name: "x", estimateMicro: 1 }], stepMicro: 1, totalMicro: 30_000 }, expiresAt: soon() });
    await answerWaitpoint(user.id, credit.id, { approve: false });
    expect(await approvedCapMicro(run.runId)).toBe(12_000n);
    const credit2 = await upsertWaitpoint({ runId: run.runId, key: "credit:2", request: { kind: "credit", tools: [{ name: "x", estimateMicro: 1 }], stepMicro: 1, totalMicro: 40_000 }, expiresAt: soon() });
    await answerWaitpoint(user.id, credit2.id, { approve: true });
    expect(await approvedCapMicro(run.runId)).toBe(40_000n);
  });

  it("spent estimate sums the run's tool calls", async () => {
    const { run } = await pending();
    await upsertInvocation({ runId: run.runId, toolCallId: "a", seq: 0, name: "crop_image", input: {}, estimateMicro: 5_000n });
    await upsertInvocation({ runId: run.runId, toolCallId: "b", seq: 1, name: "gpt_image_2", input: {}, estimateMicro: 7_644n });
    expect(await spentEstimateMicro(run.runId)).toBe(12_644n);
  });

  it("the pending question shows in the chat detail and run view until it is answered", async () => {
    const { user, chat, run, wp } = await pending();
    expect((await getChatDetail(user.id, chat.id)).activeRun?.waitpoint).toMatchObject({ id: wp.id, kind: "options" });
    expect((await getRunView(user.id, run.runId)).waitpoint).toMatchObject({ id: wp.id });
    await answerWaitpoint(user.id, wp.id, { choice: "A" });
    expect((await getChatDetail(user.id, chat.id)).activeRun?.waitpoint).toBeNull();
    expect((await getRunView(user.id, run.runId)).waitpoint).toBeNull();
  });

  it("plan mode is saved on the run", async () => {
    const { user, chat } = await seedUserWithChat("user_plan");
    const run = await admitTurn({ userId: user.id, chatId: chat.id, clientMessageId: randomUUID(), text: "x", planMode: true });
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.runId } })).planMode).toBe(true);
  });
});

describe("chat management", () => {
  const list = (userId: string, q: object = {}) => listChats(userId, { limit: 30, ...q });
  const titles = async (userId: string, q: object = {}) => (await list(userId, q)).items.map((c) => c.title);

  it("pinned chats are listed separately and leave the recent list; unpinning brings them back", async () => {
    const { user, chat } = await seedUserWithChat();
    const other = await createChat(user.id, "other");
    await updateChat(user.id, chat.id, { pinned: true });
    expect(await titles(user.id, { pinned: "true" })).toEqual(["New chat"]);
    expect(await titles(user.id)).toEqual(["other"]);
    await updateChat(user.id, chat.id, { pinned: false });
    expect((await titles(user.id)).sort()).toEqual(["New chat", "other"]);
    expect(other.pinned).toBe(false);
  });

  it("pinning or renaming does not change the activity time, so the recent order stays", async () => {
    const { user, chat } = await seedUserWithChat();
    const before = (await getOwnedChat(user.id, chat.id)).updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 20));
    const renamed = await updateChat(user.id, chat.id, { title: "  My tiger  " });
    expect(renamed.title).toBe("My tiger");
    expect(new Date(renamed.updatedAt).getTime()).toBe(before);
  });

  it("search matches titles case-insensitively across pinned and unpinned, and treats % and _ as text", async () => {
    const { user } = await seedUserWithChat();
    const a = await createChat(user.id, "Tiger in the jungle");
    await createChat(user.id, "sale 50% off");
    await createChat(user.id, "snake_case names");
    await updateChat(user.id, a.id, { pinned: true });
    expect(await titles(user.id, { q: "TIGER" })).toEqual(["Tiger in the jungle"]);
    expect(await titles(user.id, { q: "50%" })).toEqual(["sale 50% off"]);
    expect(await titles(user.id, { q: "e_c" })).toEqual(["snake_case names"]);
    expect(await titles(user.id, { q: "%%" })).toEqual([]);
    expect(await titles(user.id, { q: "nothing" })).toEqual([]);
  });

  it("one user's chats never show in another's list or search, and cannot be changed or deleted", async () => {
    const { user, chat } = await seedUserWithChat("user_a");
    const stranger = await ensureUser("user_b", 0n);
    expect(await titles(stranger.id, { q: "New" })).toEqual([]);
    await expect(updateChat(stranger.id, chat.id, { pinned: true })).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteChat(stranger.id, chat.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await getOwnedChat(user.id, chat.id)).pinned).toBe(false);
  });

  it("delete hides the chat from lists, search and lookups but keeps its rows", async () => {
    const { user, chat } = await seedUserWithChat();
    await updateChat(user.id, chat.id, { pinned: true });
    await deleteChat(user.id, chat.id);
    expect(await titles(user.id)).toEqual([]);
    expect(await titles(user.id, { pinned: "true" })).toEqual([]);
    expect(await titles(user.id, { q: "New" })).toEqual([]);
    await expect(getOwnedChat(user.id, chat.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(updateChat(user.id, chat.id, { title: "x" })).rejects.toMatchObject({ code: "not_found" });
    expect(await prisma.chat.count({ where: { id: chat.id } })).toBe(1);
  });

  it("delete is refused while a reply is running", async () => {
    const { user, chat } = await seedUserWithChat();
    const run = await send(user.id, chat.id);
    await expect(deleteChat(user.id, chat.id)).rejects.toMatchObject({ code: "run_active", details: { activeRunId: run.runId } });
    await transitionRun(run.runId, "completed");
    await expect(deleteChat(user.id, chat.id)).resolves.toEqual({ id: chat.id });
  });

  it("stops pinning at the limit, so no pinned chat can vanish from both lists, and allows it again after an unpin", async () => {
    const { user, chat } = await seedUserWithChat();
    const others = await Promise.all(Array.from({ length: MAX_PINNED - 1 }, (_, i) => createChat(user.id, `p${i}`)));
    await prisma.chat.updateMany({ where: { id: { in: others.map((c) => c.id) } }, data: { pinned: true } });
    await updateChat(user.id, chat.id, { pinned: true }); // the 50th
    const extra = await createChat(user.id, "one too many");
    await expect(updateChat(user.id, extra.id, { pinned: true })).rejects.toMatchObject({ code: "validation_failed", message: expect.stringContaining("50") });
    expect((await list(user.id, { pinned: "true" })).items).toHaveLength(MAX_PINNED);
    expect(await titles(user.id)).toContain("one too many"); // still in Recent
    await updateChat(user.id, chat.id, { pinned: false });
    await expect(updateChat(user.id, extra.id, { pinned: true })).resolves.toMatchObject({ pinned: true });
    await expect(updateChat(user.id, extra.id, { title: "renamed while at the limit" })).resolves.toMatchObject({ title: "renamed while at the limit" });
  });

  it("renaming a pinned chat at the limit is allowed, and pinning never moves the activity time backwards", async () => {
    const { user, chat } = await seedUserWithChat();
    await send(user.id, chat.id); // bumps the activity time
    const afterSend = (await getOwnedChat(user.id, chat.id)).updatedAt.getTime();
    await updateChat(user.id, chat.id, { pinned: true });
    expect((await getOwnedChat(user.id, chat.id)).updatedAt.getTime()).toBe(afterSend);
  });

  it("a deleted chat gets no new message or retry, and nothing is left half-created", async () => {
    const { user, chat } = await seedUserWithChat();
    const run = await send(user.id, chat.id);
    await transitionRun(run.runId, "failed", { error: { code: "llm_unavailable", message: "x", retryable: true } });
    await deleteChat(user.id, chat.id);
    const before = { messages: await prisma.message.count(), runs: await prisma.agentRun.count() };
    await expect(send(user.id, chat.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(admitRetry(user.id, run.runId)).rejects.toMatchObject({ code: "not_found" });
    expect({ messages: await prisma.message.count(), runs: await prisma.agentRun.count() }).toEqual(before);
  });

  it("delete and a new message at the same moment never leave a running reply in a deleted chat", async () => {
    for (let i = 0; i < 12; i++) {
      const { user, chat } = await seedUserWithChat(`user_race_${i}`);
      await Promise.allSettled([deleteChat(user.id, chat.id), send(user.id, chat.id)]);
      const deleted = (await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } })).deletedAt !== null;
      const active = await prisma.agentRun.count({ where: { chatId: chat.id, status: { in: ["queued", "running", "waiting"] } } });
      expect(deleted && active > 0).toBe(false);
    }
  });

  it("the recent list pages without repeats", async () => {
    const { user } = await seedUserWithChat();
    for (let i = 0; i < 5; i++) await createChat(user.id, `chat ${i}`);
    const first = await list(user.id, { limit: 3 });
    const second = await list(user.id, { limit: 3, cursor: first.nextCursor ?? undefined });
    const ids = [...first.items, ...second.items].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6);
  });
});

describe("admitRetry", () => {
  const failed = async (retryable = true, code = "llm_unavailable") => {
    const { user, chat } = await seedUserWithChat();
    const run = await send(user.id, chat.id);
    await transitionRun(run.runId, "failed", { error: { code, message: "It stopped.", retryable } });
    return { user, chat, run };
  };

  it("creates a new run for the same user message, and asking twice returns the same one", async () => {
    const { user, run } = await failed();
    const first = await admitRetry(user.id, run.runId);
    const second = await admitRetry(user.id, run.runId);
    expect(first.replay).toBe(false);
    expect(first.messageId).toBe(run.messageId);
    expect(second).toMatchObject({ runId: first.runId, replay: true });
    const created = await prisma.agentRun.findUniqueOrThrow({ where: { id: first.runId } });
    expect(created).toMatchObject({ retryOfRunId: run.runId, userMessageId: run.messageId, status: "queued" });
    expect(await prisma.agentRun.count()).toBe(2);
  });

  it("two retries at the same moment create exactly one run", async () => {
    const { user, run } = await failed();
    const results = await Promise.all([admitRetry(user.id, run.runId), admitRetry(user.id, run.runId)]);
    expect(new Set(results.map((r) => r.runId)).size).toBe(1);
    expect(await prisma.agentRun.count()).toBe(2);
  });

  it("a stopped reply can be retried, and plan mode carries over", async () => {
    const { user, chat } = await seedUserWithChat();
    const run = await admitTurn({ userId: user.id, chatId: chat.id, clientMessageId: randomUUID(), text: "x", planMode: true });
    await transitionRun(run.runId, "cancelled", { error: { code: "cancelled", message: "Stopped.", retryable: true } });
    const retry = await admitRetry(user.id, run.runId);
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: retry.runId } })).planMode).toBe(true);
  });

  it("refuses a reply that did not fail, and a failure that trying again cannot fix", async () => {
    const done = await failed();
    await prisma.agentRun.update({ where: { id: done.run.runId }, data: { status: "completed" } });
    await expect(admitRetry(done.user.id, done.run.runId)).rejects.toMatchObject({ code: "run_not_retryable" });

    const poor = await failed(false, "insufficient_credits");
    await expect(admitRetry(poor.user.id, poor.run.runId)).rejects.toMatchObject({ code: "run_not_retryable", message: expect.stringContaining("out of credits") });
  });

  it("refuses when it is not the newest reply", async () => {
    const { user, chat, run } = await failed();
    const later = await send(user.id, chat.id);
    await transitionRun(later.runId, "completed");
    await expect(admitRetry(user.id, run.runId)).rejects.toMatchObject({ code: "run_not_retryable", message: expect.stringContaining("latest") });
  });

  it("refuses while a Magica job from the stopped run is still finishing, then allows it once done", async () => {
    const { user, run } = await failed();
    const inv = await upsertInvocation({ runId: run.runId, toolCallId: "0:c1", seq: 0, name: "gpt_image_2", input: {}, estimateMicro: 7_644n });
    await markDispatching(inv.id);
    await markRunning(inv.id, "magica_run_1");
    await expect(admitRetry(user.id, run.runId)).rejects.toMatchObject({ code: "run_not_retryable", message: expect.stringContaining("still finishing") });
    await finishInvocation(inv.id, { status: "completed", output: {}, creditsMicro: 7_644n });
    await expect(admitRetry(user.id, run.runId)).resolves.toMatchObject({ replay: false });
  });

  it("someone else's run is not found", async () => {
    const { run } = await failed();
    const stranger = await ensureUser("user_stranger", 0n);
    await expect(admitRetry(stranger.id, run.runId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("resending the original message still returns the first run, not the retry", async () => {
    const { user, chat } = await seedUserWithChat();
    const id = randomUUID();
    const first = await send(user.id, chat.id, id);
    await transitionRun(first.runId, "failed", { error: { code: "llm_unavailable", message: "x", retryable: true } });
    await admitRetry(user.id, first.runId);
    expect((await send(user.id, chat.id, id)).runId).toBe(first.runId);
  });
});
