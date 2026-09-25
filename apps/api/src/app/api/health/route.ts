import { NextResponse } from "next/server";
import { prisma } from "@gx/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = await prisma.$queryRaw`SELECT 1`.then(() => "up" as const, () => "down" as const);
  return NextResponse.json({ ok: db === "up", db }, { status: db === "up" ? 200 : 503 });
}
