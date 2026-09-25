import { z } from "zod";
import type { ToolDef } from "./types";

const args = z
  .object({
    image_url: z.string().url().startsWith("https://").describe("Public HTTPS URL of the image to crop."),
    unit: z.enum(["percent", "pixels"]).describe("Units for x, y, width and height."),
    x: z.number().min(0).optional().describe("Left edge. Required for percent. For pixels, omit x and y to centre the crop."),
    y: z.number().min(0).optional().describe("Top edge. Required for percent. For pixels, omit x and y to centre the crop."),
    width: z.number().positive().describe("Crop width."),
    height: z.number().positive().describe("Crop height."),
  })
  .superRefine((a, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (a.unit === "percent") {
      if (a.x === undefined || a.y === undefined) issue("A percent crop needs both x and y.");
      if ((a.x ?? 0) + a.width > 100 || (a.y ?? 0) + a.height > 100) issue("The crop extends past the image (x + width and y + height must be at most 100).");
    } else if ((a.x === undefined) !== (a.y === undefined)) {
      issue("Give both x and y, or neither to centre the crop.");
    }
  });

// Shape confirmed from a live run: { image_url, width, height, creditUsed }.
const output = z.object({ image_url: z.string().url(), width: z.number().int().optional(), height: z.number().int().optional() });

export const cropImage: ToolDef<typeof args, z.infer<typeof output>> = {
  name: "crop_image",
  description:
    "Crop an image. Use percent units for relative regions (e.g. left half: x=0,y=0,width=50,height=100) " +
    "or pixel units for exact sizes. Returns the cropped image URL.",
  label: "Cropping image",
  args,
  // Accept the documented `crop: {x, y, width, height}` shape as an alias.
  normalize: (raw) => {
    const r = raw as { crop?: Record<string, unknown> } & Record<string, unknown>;
    return r && typeof r.crop === "object" ? { ...r, ...r.crop, crop: undefined } : raw;
  },
  output,
  estimateMicro: () => 5_000n,
  assets: (o) => [{ kind: "image", url: o.image_url }],
  exec: {
    kind: "magica",
    nodeType: "crop_image",
    toInput: (a) =>
      a.unit === "percent"
        ? { image_url: a.image_url, x_percent: a.x, y_percent: a.y, width_percent: a.width, height_percent: a.height }
        : { image_url: a.image_url, width_px: a.width, height_px: a.height, ...(a.x !== undefined && { x_px: a.x, y_px: a.y }) },
    fromOutput: (raw) => output.parse(raw),
  },
};
