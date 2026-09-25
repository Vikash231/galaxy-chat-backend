import { AppError } from "@gx/contracts";

export type Cursor = { at: Date; id: string };

export const encodeCursor = (c: Cursor) => Buffer.from(`${c.at.toISOString()}|${c.id}`).toString("base64url");

/** Sorts after every real row, so page one uses the same seek query as later pages. */
const FIRST_PAGE: Cursor = { at: new Date("9999-12-31T23:59:59.999Z"), id: "" };

export function decodeCursor(raw: string | undefined): Cursor {
  if (!raw) return FIRST_PAGE;
  const [iso, id] = Buffer.from(raw, "base64url").toString().split("|");
  const at = new Date(iso ?? "");
  if (!id || Number.isNaN(at.getTime())) throw new AppError("validation_failed", "Invalid cursor.");
  return { at, id };
}

/** Rows are fetched with limit + 1; the extra row only signals that another page exists. */
export function toPage<T>(rows: T[], limit: number, key: (row: T) => Cursor) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(key(last)) : null };
}
