import { describe, expect, it } from "vitest";
import { cropImage } from "./crop-image";
import { parseArgs, toolSpecs } from "./registry";

const url = "https://example.com/a.jpg";
const parse = (args: object) => parseArgs(cropImage, JSON.stringify(args));
const argsOf = (r: ReturnType<typeof parse>) => {
  if (!r.ok) throw new Error(r.message);
  return r.args as Parameters<typeof cropImage.exec.toInput>[0];
};

describe("crop_image input", () => {
  it("accepts a complete percent rectangle and maps it to Magica fields", () => {
    const r = parse({ image_url: url, unit: "percent", x: 0, y: 0, width: 50, height: 100 });
    expect(cropImage.exec.toInput(argsOf(r))).toEqual({ image_url: url, x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100 });
  });

  it("centres a pixel crop when x and y are omitted", () => {
    const r = parse({ image_url: url, unit: "pixels", width: 300, height: 200 });
    expect(cropImage.exec.toInput(argsOf(r))).toEqual({ image_url: url, width_px: 300, height_px: 200 });
  });

  it.each([
    [{ unit: "percent", width: 50, height: 50 }, "needs both x and y"],
    [{ unit: "percent", x: 60, y: 0, width: 50, height: 50 }, "extends past the image"],
    [{ unit: "pixels", x: 10, width: 50, height: 50 }, "both x and y, or neither"],
    [{ unit: "pixels", width: 0, height: 50 }, "width"],
  ])("rejects an incomplete or invalid rectangle %#", (rect, message) => {
    const r = parse({ image_url: url, ...rect });
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain(message);
  });

  it("rejects non-https URLs and bad JSON", () => {
    expect(parse({ image_url: "http://example.com/a.jpg", unit: "pixels", width: 1, height: 1 }).ok).toBe(false);
    expect(parseArgs(cropImage, "{not json")).toEqual({ ok: false, message: "Arguments were not valid JSON." });
  });

  it("accepts the documented crop.{x,y,width,height} alias", () => {
    const r = parse({ image_url: url, unit: "percent", crop: { x: 0, y: 0, width: 50, height: 50 } });
    expect(r.ok).toBe(true);
  });

  it("parses the output shape recorded from a live Magica run", () => {
    const live = { width: 400, height: 533, image_url: url, creditUsed: 5000 };
    expect(cropImage.exec.fromOutput(live)).toEqual({ image_url: url, width: 400, height: 533 });
    expect(() => cropImage.exec.fromOutput({ width: 1 })).toThrow();
  });

  it("publishes an LLM function spec generated from the schema", () => {
    const spec = toolSpecs().find((s) => s.function.name === "crop_image")!;
    expect(spec.function.parameters).toMatchObject({ type: "object", required: expect.arrayContaining(["image_url", "unit", "width", "height"]) });
    expect(spec.function.parameters).not.toHaveProperty("$schema");
  });
});
