import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AppError } from "@gx/contracts";
import { prisma } from "./client";
import { ensureUser } from "./users";
import { admitTurn, transitionRun } from "./runs";
import { listMessages } from "./messages";
import { listChats, getOwnedChat } from "./chats";
import { settleToolCharge, reserveProviderSpend, adjustProviderSpend } from "./credits";
import { finishInvocation, inFlightProviderCalls, markDispatching, markRunning, upsertInvocation } from "./tools";
import { reserveFileRefs } from "./attachments";
import { recordRunSkill } from "./skills";
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
