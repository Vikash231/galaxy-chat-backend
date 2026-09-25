import { prisma } from "./client";
import { ensureUser } from "./users";

/** Empty every table; tests run one file at a time against a dedicated database. */
export async function resetDb() {
  if (!process.env.DATABASE_URL?.includes("_test")) throw new Error("resetDb refuses to run against a non-test database");
  await prisma.$executeRawUnsafe(
    `TRUNCATE "CreditLedger", "ToolInvocation", "Message", "AgentRun", "Chat", "User", "ProviderSpendDaily" RESTART IDENTITY CASCADE`,
  );
}

export async function seedUserWithChat(clerkId = "user_test", grantMicro = 1_000_000n) {
  const user = await ensureUser(clerkId, grantMicro);
  const chat = await prisma.chat.create({ data: { userId: user.id } });
  return { user, chat };
}
