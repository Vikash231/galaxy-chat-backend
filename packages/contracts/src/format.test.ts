import { describe, expect, it } from "vitest";
import { formatCredits } from "./format";

describe("formatCredits", () => {
  it("matches the reference product's credit display", () => {
    expect(formatCredits(5_000)).toBe("5,000");
    expect(formatCredits(29_919_034)).toBe("29.92M");
    expect(formatCredits(5_000_000n)).toBe("5.00M");
    expect(formatCredits(0)).toBe("0");
  });
});
