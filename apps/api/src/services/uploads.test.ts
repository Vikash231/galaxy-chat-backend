import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { admitTurn, prisma } from "@gx/db";
import { resetDb, seedUserWithChat } from "@gx/db/testing";
import { logger } from "@gx/observability";
import { completeUpload, signUpload } from "./uploads";

process.env.TRANSLOADIT_AUTH_KEY = "a".repeat(32);
process.env.TRANSLOADIT_AUTH_SECRET = "test-secret";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(async () => (server.close(), await prisma.$disconnect()));
beforeEach(resetDb);

const ASM = "0123456789abcdef0123456789abcdef";
const file = (over: Record<string, unknown> = {}) => ({
  id: "f1", original_id: "u1", name: "cat.jpg", mime: "image/jpeg", size: 88_423,
  ssl_url: "https://tmp.transloadit.net/cat.jpg", meta: { width: 800, height: 1066 }, ...over,
});
const assembly = (body: Record<string, unknown>) => server.use(http.get(`https://api2.transloadit.com/assemblies/${ASM}`, () => HttpResponse.json(body)));

describe("signUpload", () => {
  it("returns params signed with sha384 over the exact string, carrying the owner id", async () => {
    const { user } = await seedUserWithChat();
    const { params, signature } = await signUpload(user);
    expect(signature).toBe(`sha384:${createHmac("sha384", "test-secret").update(params).digest("hex")}`);
    expect(JSON.parse(params)).toMatchObject({ auth: { key: "a".repeat(32) }, fields: { gx_user: user.id } });
  });

  it("stores to R2 only when the R2 credentials are configured", async () => {
    const { user } = await seedUserWithChat();
    expect(JSON.parse((await signUpload(user)).params).steps.stored).toBeUndefined();
  });
});

describe("completeUpload", () => {
  it("saves one attachment per file, and completing twice returns the same rows", async () => {
    const { user } = await seedUserWithChat();
    assembly({ ok: "ASSEMBLY_COMPLETED", fields: { gx_user: user.id }, results: { filtered: [file()] } });
    const [a] = await completeUpload(user, ASM, logger);
    expect(a).toMatchObject({ kind: "image", name: "cat.jpg", width: 800, height: 1066, persistent: false });
    const [again] = await completeUpload(user, ASM, logger);
    expect(again!.id).toBe(a!.id);
    expect(await prisma.attachment.count()).toBe(1);
  });

  it("refuses another user's Assembly", async () => {
    const { user } = await seedUserWithChat();
    assembly({ ok: "ASSEMBLY_COMPLETED", fields: { gx_user: "someone_else" }, results: { filtered: [file()] } });
    await expect(completeUpload(user, ASM, logger)).rejects.toMatchObject({ code: "not_found" });
  });

  it("asks the client to wait while the Assembly is still running", async () => {
    const { user } = await seedUserWithChat();
    assembly({ ok: "ASSEMBLY_EXECUTING", fields: { gx_user: user.id } });
    await expect(completeUpload(user, ASM, logger)).rejects.toMatchObject({ code: "upload_not_ready" });
  });

  it("rejects files the filter declined and non-media types", async () => {
    const { user } = await seedUserWithChat();
    assembly({ error: "FILE_FILTER_DECLINED_FILE", fields: { gx_user: user.id } });
    await expect(completeUpload(user, ASM, logger)).rejects.toMatchObject({ code: "upload_rejected" });
    assembly({ ok: "ASSEMBLY_COMPLETED", fields: { gx_user: user.id }, results: { filtered: [file({ mime: "application/pdf", name: "x.pdf" })] } });
    await expect(completeUpload(user, ASM, logger)).rejects.toMatchObject({ code: "upload_rejected" });
  });
});

describe("attachments on send", () => {
  async function uploaded() {
    const { user, chat } = await seedUserWithChat();
    assembly({ ok: "ASSEMBLY_COMPLETED", fields: { gx_user: user.id }, results: { filtered: [file()] } });
    const [a] = await completeUpload(user, ASM, logger);
    return { user, chat, attachmentId: a!.id };
  }
  const send = (userId: string, chatId: string, attachmentIds: string[]) =>
    admitTurn({ userId, chatId, clientMessageId: randomUUID(), text: "crop the left half", attachmentIds });

  it("puts the attachment before the text in the user message and links it", async () => {
    const { user, chat, attachmentId } = await uploaded();
    const { messageId } = await send(user.id, chat.id, [attachmentId]);
    const msg = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    expect((msg.content as { type: string }[]).map((b) => b.type)).toEqual(["attachment", "text"]);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } })).messageId).toBe(messageId);
  });

  it("refuses an attachment already used or owned by someone else, and saves nothing", async () => {
    const { user, chat, attachmentId } = await uploaded();
    const first = await send(user.id, chat.id, [attachmentId]);
    await prisma.agentRun.update({ where: { id: first.runId }, data: { status: "completed" } });
    await expect(send(user.id, chat.id, [attachmentId])).rejects.toMatchObject({ code: "upload_rejected" });

    const other = await seedUserWithChat("other_user");
    await expect(send(other.user.id, other.chat.id, [attachmentId])).rejects.toMatchObject({ code: "upload_rejected" });
    expect(await prisma.message.count()).toBe(1);
  });
});
