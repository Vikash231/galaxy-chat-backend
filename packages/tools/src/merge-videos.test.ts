import { describe, expect, it } from "vitest";
import { cropImage } from "./crop-image";
import { mergeVideos } from "./merge-videos";
import { parseArgs } from "./registry";

const a = "https://example.com/a.mp4";
const b = "https://example.com/b.mp4";
const c = "https://example.com/c.mp4";
const files = new Map([["vid_1", a], ["vid_2", b], ["vid_3", c], ["img_4", "https://example.com/x.png"]]);
const parse = (args: object) => parseArgs(mergeVideos, JSON.stringify(args), files);
const argsOf = (r: ReturnType<typeof parse>) => {
  if (!r.ok) throw new Error(r.message);
  return r.args as Parameters<typeof mergeVideos.exec.toInput>[0];
};
const lengths = (m: Record<string, number>) => ({ durationSec: (url: string) => m[url] });

describe("merge_videos input", () => {
  it("keeps the given order and maps to Magica fields", () => {
    expect(mergeVideos.exec.toInput(argsOf(parse({ videos: ["vid_3", "vid_1", "vid_2"] })))).toEqual({ video_urls: [c, a, b], transition: "none" });
  });

  it("accepts the Magica field name and capitalised transitions", () => {
    expect(argsOf(parse({ video_urls: ["vid_1", "vid_2"], transition: "Fade" }))).toEqual({ videos: [a, b], transition: "fade" });
  });

  it.each([
    [{ videos: ["vid_1"] }, "at least 2 videos"],
    [{ videos: ["vid_1", "http://example.com/b.mp4"] }, "videos.1"],
    [{ videos: ["vid_1", "vid_2"], transition: "wipe" }, "transition"],
  ])("rejects invalid input %#", (args, message) => {
    const r = parse(args);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain(message);
  });

  it("accepts an uploaded file's original name as an alias for its short name", () => {
    const aliases = new Map([["tiger.mp4", "vid_2"], ["jungle.mp4", "vid_1"], ["photo.png", "img_4"]]);
    const r = parseArgs(mergeVideos, JSON.stringify({ videos: ["tiger.mp4", "jungle.mp4"] }), files, aliases);
    expect(argsOf(r).videos).toEqual([b, a]);
    // an alias still goes through the file-type check
    expect(parseArgs(mergeVideos, JSON.stringify({ videos: ["tiger.mp4", "photo.png"] }), files, aliases)).toMatchObject({ ok: false, message: expect.stringContaining("img_4 is not a video") });
  });

  it("rejects image names before any spend, and crop rejects video names", () => {
    expect(parse({ videos: ["vid_1", "img_4"] })).toEqual({ ok: false, message: "img_4 is not a video; merge_videos only takes video files." });
    expect(parseArgs(cropImage, JSON.stringify({ image: "vid_1", unit: "pixels", width: 10, height: 10 }), files)).toEqual({
      ok: false,
      message: "vid_1 is not an image; crop_image only takes image files.",
    });
  });

  it("prices summed length at the per-minute rate for the video count", () => {
    const two = argsOf(parse({ videos: ["vid_1", "vid_2"] }));
    // 50,000/min for 2 videos x 15 s total = 12,500
    expect(mergeVideos.estimateMicro(two, lengths({ [a]: 5, [b]: 10 }))).toBe(12_500n);
    // an unknown length counts as a full minute: 50,000 x (5 + 60) / 60
    expect(mergeVideos.estimateMicro(two, lengths({ [a]: 5 }))).toBe(54_167n);
    const three = argsOf(parse({ videos: ["vid_1", "vid_2", "vid_3"] }));
    expect(mergeVideos.estimateMicro(three, lengths({ [a]: 60, [b]: 60, [c]: 60 }))).toBe(180_000n);
  });

  it("parses the output recorded from a live Magica run", () => {
    const live = { fps: 24, width: 1280, height: 720, duration: 21.108, format: "mp4", video_url: a, creditUsed: 17590 };
    expect(mergeVideos.exec.fromOutput(live)).toEqual({ video: { url: a, durationSec: 21.108, width: 1280, height: 720 } });
    expect(() => mergeVideos.exec.fromOutput({ result: [a] })).toThrow();
    expect(mergeVideos.assets({ video: { url: a, durationSec: 3 } })).toEqual([{ kind: "video", url: a, durationSec: 3 }]);
  });
});
