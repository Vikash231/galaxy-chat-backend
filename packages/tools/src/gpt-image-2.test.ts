import { describe, expect, it } from "vitest";
import { gptImage2 } from "./gpt-image-2";
import { parseArgs, toolSpecs } from "./registry";

const url = "https://example.com/a.png";
const files = new Map([["img_1", url]]);
const parse = (args: object) => parseArgs(gptImage2, JSON.stringify(args), files);
const argsOf = (r: ReturnType<typeof parse>) => {
  if (!r.ok) throw new Error(r.message);
  return r.args as Parameters<typeof gptImage2.exec.toInput>[0];
};

describe("gpt_image_2 input", () => {
  it("creates from text with cheap defaults and the text submodel", () => {
    const a = argsOf(parse({ prompt: "a red fox" }));
    expect(gptImage2.exec.subModelId!(a)).toBe("gpt-image-2-text");
    expect(gptImage2.exec.toInput(a)).toEqual({ prompt: "a red fox", size: "Auto", quality: "Low", background: "Auto", n: 1 });
    expect(gptImage2.estimateMicro(a)).toBe(7_644n); // matches the live bill
  });

  it("edits named images with the edit submodel and resolves names to URLs", () => {
    const a = argsOf(parse({ prompt: "make it night", images: ["img_1"] }));
    expect(gptImage2.exec.subModelId!(a)).toBe("gpt-image-2-edit");
    expect(gptImage2.exec.toInput(a)).toMatchObject({ uploadedImages: [url] });
  });

  it("accepts a single image under image or image_url, and capitalised enums", () => {
    expect(argsOf(parse({ prompt: "x", image: "img_1" })).images).toEqual([url]);
    expect(argsOf(parse({ prompt: "x", image_url: "img_1", quality: "High" })).quality).toBe("high");
  });

  it("prices by quality, size and count", () => {
    expect(gptImage2.estimateMicro(argsOf(parse({ prompt: "x", quality: "high", size: "2048x2048", n: 2 })))).toBe(1_113_216n);
  });

  it.each([
    [{ prompt: "" }, "prompt"],
    [{ prompt: "x".repeat(4001) }, "prompt"],
    [{ prompt: "x", n: 5 }, "n"],
    [{ prompt: "x", size: "999x999" }, "size"],
    [{ prompt: "x", images: ["http://example.com/a.png"] }, "images.0"],
    [{ prompt: "x", images: Array(11).fill("img_1") }, "images"],
  ])("rejects invalid input %#", (args, path) => {
    const r = parse(args);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain(path);
  });

  it("rejects unknown image names before any spend", () => {
    expect(parse({ prompt: "x", images: ["img_9"] })).toMatchObject({ ok: false, message: expect.stringContaining("Unknown file img_9") });
  });

  it("parses the output recorded from a live Magica run", () => {
    const live = {
      result: ["https://g.tlcdn.com/gen/d153abb419a345d29ef5fa02112a01ab.png"],
      provider: "fal",
      creditUsed: 7644,
      resultMetadata: [{ size: 2079183, width: 1402, height: 1122, mimeType: "image/png", mediaType: "image" }],
    };
    const out = gptImage2.exec.fromOutput(live);
    expect(out).toEqual({ images: [{ url: live.result[0], width: 1402, height: 1122 }] });
    expect(gptImage2.assets(out)).toEqual([{ kind: "image", url: live.result[0] }]);
    expect(() => gptImage2.exec.fromOutput({ result: [] })).toThrow();
  });

  it("only requires the prompt in the LLM spec", () => {
    const spec = toolSpecs().find((s) => s.function.name === "gpt_image_2")!;
    expect(spec.function.parameters).toMatchObject({ required: ["prompt"] });
  });
});
