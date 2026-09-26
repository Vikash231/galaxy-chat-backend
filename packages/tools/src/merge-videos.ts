import { z } from "zod";
import type { MagicaTool } from "./types";

// From docs/magica/merge_videos.pricing.json: 40,000 per minute plus 10,000 per extra video per minute, prorated.
// A live run billed exactly this on the output length (21.108 s, 2 videos → 17,590), with no markup.
const BASE_PER_MIN = 40_000;
const EXTRA_VIDEO_PER_MIN = 10_000;
// Only used when a file's length is unknown; one minute each keeps the reservation on the safe side.
const UNKNOWN_DURATION_SEC = 60;

const args = z
  .object({
    videos: z
      .array(z.string())
      .min(2, "Give at least 2 videos to merge.")
      .max(100)
      .describe('Videos to join, by name (e.g. ["vid_1", "vid_2"]), in playback order.'),
    transition: z.enum(["none", "fade", "dissolve"]).default("none").describe("Effect between clips."),
  })
  .superRefine((a, ctx) => {
    // File names are swapped for their URL before validation, so by now each must be a real https URL.
    a.videos.forEach((url, i) => {
      if (!/^https:\/\/\S+$/.test(url)) ctx.addIssue({ code: "custom", path: ["videos", i], message: 'must be a file name like "vid_1" or an https URL.' });
    });
  });

// Shape confirmed from a live run: { video_url, duration, width, height, fps, ... }. Mixed inputs come out at one size.
const raw = z.object({
  video_url: z.string().url(),
  duration: z.number().nonnegative().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
});

const output = z.object({
  video: z.object({ url: z.string().url(), durationSec: z.number().nonnegative().optional(), width: z.number().int().optional(), height: z.number().int().optional() }),
});

export const mergeVideos: MagicaTool<typeof args, z.infer<typeof output>> = {
  name: "merge_videos",
  description: "Join 2 or more videos end to end into one video, in the given order. Returns the merged video URL.",
  label: "Merging videos",
  accepts: "video",
  args,
  normalize: (r) => {
    const o = { ...(r as Record<string, unknown>) };
    if (o.videos === undefined && Array.isArray(o.video_urls)) o.videos = o.video_urls;
    delete o.video_urls;
    if (typeof o.transition === "string") o.transition = o.transition.toLowerCase();
    return o;
  },
  output,
  // Summed source length is Magica's own conservative reservation; transitions can only shorten the output.
  estimateMicro: (a, files) => {
    const seconds = a.videos.reduce((sum, url) => sum + (files.durationSec(url) ?? UNKNOWN_DURATION_SEC), 0);
    const perMinute = BASE_PER_MIN + EXTRA_VIDEO_PER_MIN * (a.videos.length - 1);
    return BigInt(Math.ceil((perMinute * seconds) / 60));
  },
  assets: (o) => [{ kind: "video", url: o.video.url, durationSec: o.video.durationSec }],
  exec: {
    kind: "magica",
    nodeType: "merge_videos",
    toInput: (a) => ({ video_urls: a.videos, transition: a.transition }),
    fromOutput: (out) => {
      const r = raw.parse(out);
      return { video: { url: r.video_url, durationSec: r.duration, width: r.width, height: r.height } };
    },
  },
};
