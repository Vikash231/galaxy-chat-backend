import { z } from "zod";
import type { ToolDef } from "./types";

const SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "3840x2160", "2160x3840"] as const;
const QUALITIES = ["low", "medium", "high"] as const;

// Listed microcredits per image, from docs/magica/gpt-image-2-*.pricing.json (text and edit share one table; "auto" bills as 1024x1024).
const PRICE: Record<(typeof QUALITIES)[number], Record<Exclude<(typeof SIZES)[number], "auto">, number>> = {
  low: { "1024x1024": 5_880, "1536x1024": 4_740, "1024x1536": 4_740, "2048x2048": 11_910, "2048x1152": 4_710, "3840x2160": 11_130, "2160x3840": 11_130 },
  medium: { "1024x1024": 52_680, "1536x1024": 41_160, "1024x1536": 41_160, "2048x2048": 107_040, "2048x1152": 42_390, "3840x2160": 100_080, "2160x3840": 100_080 },
  high: { "1024x1024": 210_720, "1536x1024": 164_640, "1024x1536": 164_640, "2048x2048": 428_160, "2048x1152": 169_500, "3840x2160": 400_260, "2160x3840": 400_260 },
};

// A live Low/auto run listed at 5,880 was billed 7,644: exactly 1.3x the listed tier.
const billed = (listed: number) => Math.ceil((listed * 13) / 10);

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

const args = z
  .object({
    prompt: z.string().trim().min(1).max(4000).describe("What to create, or how to change the given images."),
    images: z
      .array(z.string())
      .max(10)
      .default([])
      .describe('Images to edit, by name (e.g. ["img_1"]). Leave empty to create a new image from the prompt.'),
    size: z.enum(SIZES).default("auto").describe("Output size in pixels, or auto."),
    quality: z.enum(QUALITIES).default("low").describe("Use low unless the user asks for higher quality; medium costs ~9x and high ~36x more."),
    n: z.number().int().min(1).max(4).default(1).describe("How many images to generate."),
    background: z.enum(["auto", "opaque", "transparent"]).default("auto"),
  })
  .superRefine((a, ctx) => {
    // File names are swapped for their URL before validation, so by now each must be a real https URL.
    a.images.forEach((url, i) => {
      if (!/^https:\/\/\S+$/.test(url)) ctx.addIssue({ code: "custom", path: ["images", i], message: 'must be a file name like "img_1" or an https URL.' });
    });
  });

// Shape confirmed from a live run: { result: [url], resultMetadata: [{ width, height, ... }], creditUsed }.
const raw = z.object({
  result: z.array(z.string().url()).min(1),
  resultMetadata: z.array(z.object({ width: z.number().int().optional(), height: z.number().int().optional() })).optional(),
});

const output = z.object({ images: z.array(z.object({ url: z.string().url(), width: z.number().int().optional(), height: z.number().int().optional() })).min(1) });

export const gptImage2: ToolDef<typeof args, z.infer<typeof output>> = {
  name: "gpt_image_2",
  description:
    "Create images from a text prompt, or edit existing images (pass their names in images). " +
    "Returns the generated image URLs.",
  label: "Generating image",
  args,
  // Models often send a single image as a string or under image/image_url.
  normalize: (raw) => {
    const r = { ...(raw as Record<string, unknown>) };
    const single = r.image ?? r.image_url;
    if (r.images === undefined && typeof single === "string") Object.assign(r, { images: [single] });
    if (typeof r.images === "string") r.images = [r.images];
    delete r.image;
    delete r.image_url;
    for (const k of ["size", "quality", "background"]) if (typeof r[k] === "string") r[k] = (r[k] as string).toLowerCase();
    return r;
  },
  output,
  estimateMicro: (a) => BigInt(billed(PRICE[a.quality][a.size === "auto" ? "1024x1024" : a.size]) * a.n),
  assets: (o) => o.images.map((i) => ({ kind: "image" as const, url: i.url })),
  exec: {
    kind: "magica",
    nodeType: "gpt_image_2",
    subModelId: (a) => (a.images.length ? "gpt-image-2-edit" : "gpt-image-2-text"),
    toInput: (a) => ({
      prompt: a.prompt,
      size: a.size === "auto" ? "Auto" : a.size,
      quality: cap(a.quality),
      background: cap(a.background),
      n: a.n,
      ...(a.images.length > 0 && { uploadedImages: a.images }),
    }),
    fromOutput: (out) => {
      const r = raw.parse(out);
      return { images: r.result.map((url, i) => ({ url, width: r.resultMetadata?.[i]?.width, height: r.resultMetadata?.[i]?.height })) };
    },
  },
};
