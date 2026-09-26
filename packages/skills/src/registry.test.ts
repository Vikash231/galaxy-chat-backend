import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS, loadSkills, readAsset } from "./registry";

let root: string;
const skill = (folder: string, skillMd: string, files: Record<string, string> = {}) => {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, "SKILL.md"), skillMd);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, folder, p, ".."), { recursive: true });
    writeFileSync(join(root, folder, p), c);
  }
};
const md = (name: string, description = "Use when testing.", body = "Do the thing.") => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skills-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("loadSkills", () => {
  it("loads valid skills with metadata, body, hash and allowed assets only", () => {
    skill("social-media-sizes", md("social-media-sizes", "Platform sizes."), { "sizes.json": "{}", "notes/tips.md": "tip", "run.sh": "rm -rf /", ".env": "SECRET=1" });
    const { skills, rejected } = loadSkills([root]);
    const s = skills.get("social-media-sizes")!;
    expect(rejected).toEqual([]);
    expect(s).toMatchObject({ description: "Platform sizes.", body: "Do the thing.", assets: ["notes/tips.md", "sizes.json"] });
    expect(s.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns an empty set when the folder does not exist", () => {
    expect(loadSkills([join(root, "missing")]).skills.size).toBe(0);
  });

  it.each([
    ["no frontmatter", "Just text", "must start with"],
    ["bad yaml", "---\nname: [unclosed\n---\nbody", "not valid YAML"],
    ["missing name", "---\ndescription: x\n---\nbody", "name"],
    ["bad name", md("Bad_Name"), "lowercase words"],
    ["long description", md("x", "y".repeat(301)), "description"],
    ["no body", md("x", "ok", ""), "no instructions"],
  ])("rejects malformed frontmatter: %s, and still loads the others", (_label, content, reason) => {
    skill("x", content);
    skill("good", md("good"));
    const { skills, rejected } = loadSkills([root]);
    expect([...skills.keys()]).toEqual(["good"]);
    expect(rejected).toEqual([{ folder: join(root, "x"), reason: expect.stringContaining(reason) }]);
  });

  it("rejects a name that does not match its folder, and an oversized SKILL.md", () => {
    skill("folder-a", md("other-name"));
    skill("big", md("big", "ok", "x".repeat(LIMITS.bodyBytes)));
    const reasons = loadSkills([root]).rejected.map((r) => r.reason);
    expect(reasons).toEqual([expect.stringContaining("larger than 32 KB"), expect.stringContaining('must match the folder name "folder-a"')]);
  });

  it("rejects every copy of a name found in two approved roots", () => {
    const second = mkdtempSync(join(tmpdir(), "skills-b-"));
    try {
      skill("dup", md("dup"));
      skill("only-here", md("only-here"));
      mkdirSync(join(second, "dup"));
      writeFileSync(join(second, "dup", "SKILL.md"), md("dup"));
      const { skills, rejected } = loadSkills([root, second]);
      expect([...skills.keys()]).toEqual(["only-here"]);
      expect(rejected.map((r) => r.reason)).toEqual(['duplicate skill name "dup"', 'duplicate skill name "dup"']);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });
});

describe("readAsset", () => {
  beforeEach(() => {
    skill("s", md("s"), { "sizes.json": '{"a":1}', "docs/guide.md": "guide" });
    writeFileSync(join(root, "secret.txt"), "top secret");
    symlinkSync(join(root, "secret.txt"), join(root, "s", "escape.txt"));
  });
  const s = () => loadSkills([root]).skills.get("s")!;

  it("reads listed files, including nested ones", () => {
    expect(readAsset(s(), "sizes.json")).toBe('{"a":1}');
    expect(readAsset(s(), "docs/./guide.md")).toBe("guide");
  });

  it.each([
    ["../secret.txt", "inside the skill folder"],
    ["/etc/passwd", "inside the skill folder"],
    ["docs/../../secret.txt", "inside the skill folder"],
    ["%2e%2e/secret.txt", "not allowed"],
    ["..\\secret.txt", "not allowed"],
    [".env", "inside the skill folder"],
    ["SKILL.md", "Use load_skill"],
    ["escape.txt", 'has no file "escape.txt"'],
    ["missing.json", 'has no file "missing.json". Files: docs/guide.md, sizes.json.'],
  ])("rejects %s", (path, message) => {
    expect(() => readAsset(s(), path)).toThrow(message);
  });
});

describe("repository skills", () => {
  it("all load with no rejections, and each description says when to use it", () => {
    const { skills, rejected } = loadSkills([new URL("../../../agent-skills", import.meta.url).pathname]);
    expect(rejected).toEqual([]);
    expect([...skills.keys()]).toEqual(["product-photo", "social-media-sizes", "video-montage"]);
    for (const s of skills.values()) expect(s.description).toMatch(/Use when/);
    expect(skills.get("social-media-sizes")!.assets).toEqual(["sizes.json"]);
    expect(JSON.parse(readAsset(skills.get("social-media-sizes")!, "sizes.json")).instagram.story).toEqual([1080, 1920]);
  });
});
