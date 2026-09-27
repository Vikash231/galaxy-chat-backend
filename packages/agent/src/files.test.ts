import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@gx/contracts";
import { collectAliases, hideFileNames } from "./files";

describe("hideFileNames", () => {
  it("removes invented media tags and name-only links, and drops parenthesised names", () => {
    const live = 'The two videos have been merged. Here\'s the result:\n\n<video>\nurl="vid_9"\n</video>\n\nThe merged video (vid_9) is 21 seconds long.';
    expect(hideFileNames(live)).toBe("The two videos have been merged. Here's the result:\n\nThe merged video is 21 seconds long.");
    expect(hideFileNames("Done! ![cropped](img_3)")).toBe("Done!");
    expect(hideFileNames('<img src="img_2" />Here it is.')).toBe("Here it is.");
  });

  it("speaks bare names as the kind of file", () => {
    expect(hideFileNames("I cropped `img_4` and merged vid_2 with aud_1.")).toBe("I cropped the image and merged the video with the audio.");
  });

  it("drops tool-call markup a model printed as text", () => {
    expect(hideFileNames("</tool_call>")).toBe("");
    expect(hideFileNames('Sure.<tool_call>{"name":"crop_image"}</tool_call> Cropping now.')).toBe("Sure. Cropping now.");
  });

  it("leaves ordinary text and real links alone", () => {
    const text = "Use a vivid_palette and see [docs](https://example.com/img_1.png).";
    expect(hideFileNames(text)).toBe(text);
  });
});

describe("collectAliases", () => {
  const upload = (ref: string, name: string): ContentBlock => ({ type: "attachment", attachmentId: ref, ref, kind: "video", url: `https://x/${ref}.mp4`, name, mime: "video/mp4", width: null, height: null });
  it("maps unique upload names to short names and drops names used twice", () => {
    const aliases = collectAliases([{ content: [upload("vid_1", "a.mp4"), upload("vid_2", "b.mp4")] }, { content: [upload("vid_3", "a.mp4")] }]);
    expect([...aliases]).toEqual([["b.mp4", "vid_2"]]);
  });
});
