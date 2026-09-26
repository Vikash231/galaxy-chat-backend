import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, posix, relative, sep } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const LIMITS = { bodyBytes: 32 * 1024, assetBytes: 64 * 1024, assetsPerSkill: 20, skills: 100 } as const;
export const ASSET_EXTENSIONS = [".md", ".txt", ".json", ".yaml", ".yml", ".csv"];

const Frontmatter = z.object({
  name: z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be lowercase words joined by hyphens"),
  description: z.string().trim().min(1).max(300),
});

export type Skill = {
  name: string;
  description: string;
  /** Real path of the skill folder; every read must stay inside it. */
  dir: string;
  body: string;
  /** sha256 of the whole SKILL.md, so any edit gives a new hash. */
  hash: string;
  /** Readable extra files, as posix paths relative to the folder. */
  assets: string[];
};

export type SkillSet = { skills: Map<string, Skill>; rejected: { folder: string; reason: string }[] };

export class SkillError extends Error {}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Scan the approved roots for skill folders. Invalid folders and duplicate names are rejected, never half-loaded. */
export function loadSkills(roots: string[]): SkillSet {
  const set: SkillSet = { skills: new Map(), rejected: [] };
  const loaded: Skill[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const folders = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
    for (const folder of folders) {
      if (loaded.length >= LIMITS.skills) {
        set.rejected.push({ folder: join(root, folder), reason: `more than ${LIMITS.skills} skills` });
        continue;
      }
      try {
        loaded.push(readSkill(root, folder));
      } catch (e) {
        set.rejected.push({ folder: join(root, folder), reason: (e as Error).message });
      }
    }
  }

  const count = new Map<string, number>();
  for (const s of loaded) count.set(s.name, (count.get(s.name) ?? 0) + 1);
  for (const s of loaded) {
    if (count.get(s.name)! > 1) set.rejected.push({ folder: s.dir, reason: `duplicate skill name "${s.name}"` });
    else set.skills.set(s.name, s);
  }
  return set;
}

function readSkill(root: string, folder: string): Skill {
  const dir = realpathSync(join(root, folder));
  const file = join(dir, "SKILL.md");
  if (!existsSync(file) || !statSync(file).isFile()) throw new SkillError("SKILL.md is missing");
  if (statSync(file).size > LIMITS.bodyBytes) throw new SkillError(`SKILL.md is larger than ${LIMITS.bodyBytes / 1024} KB`);

  const raw = readFileSync(file, "utf8");
  const m = FRONTMATTER.exec(raw);
  if (!m) throw new SkillError("SKILL.md must start with a --- frontmatter --- block");
  let data: unknown;
  try {
    data = parse(m[1]!);
  } catch {
    throw new SkillError("frontmatter is not valid YAML");
  }
  const fm = Frontmatter.safeParse(data);
  if (!fm.success) throw new SkillError(`frontmatter: ${fm.error.issues.map((i) => `${i.path.join(".") || "root"} ${i.message}`).join("; ")}`);
  if (fm.data.name !== folder) throw new SkillError(`name "${fm.data.name}" must match the folder name "${folder}"`);
  const body = m[2]!.trim();
  if (!body) throw new SkillError("SKILL.md has no instructions after the frontmatter");

  return { ...fm.data, dir, body, hash: createHash("sha256").update(raw).digest("hex"), assets: listAssets(dir) };
}

/** Allowed, bounded files inside the folder; symlinks that point outside it are skipped. */
function listAssets(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const d of readdirSync(at, { withFileTypes: true })) {
      if (d.name.startsWith(".") || out.length >= LIMITS.assetsPerSkill) continue;
      const full = join(at, d.name);
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        continue; // broken symlink
      }
      if (!real.startsWith(dir + sep)) continue;
      const stat = statSync(real);
      if (stat.isDirectory()) walk(full);
      else if (!(at === dir && d.name === "SKILL.md") && ASSET_EXTENSIONS.includes(extname(d.name).toLowerCase()) && stat.size <= LIMITS.assetBytes)
        out.push(relative(dir, full).split(sep).join(posix.sep));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Read one extra file of a skill. Only files found by the startup scan can be read, and the path is
 * re-checked here because a file could be swapped for a symlink after the scan.
 */
export function readAsset(skill: Skill, requested: string): string {
  if (!requested || requested.length > 200 || /[\0\\]/.test(requested) || /%2e|%2f|%5c/i.test(requested)) throw new SkillError("That file path is not allowed.");
  const path = posix.normalize(requested);
  if (path.startsWith("/") || path.split("/").some((s) => s === ".." || s.startsWith("."))) throw new SkillError("Only files inside the skill folder can be read.");
  if (path === "SKILL.md") throw new SkillError("Use load_skill to read SKILL.md.");
  if (!skill.assets.includes(path))
    throw new SkillError(`${skill.name} has no file "${path}". ${skill.assets.length ? `Files: ${skill.assets.join(", ")}.` : "It has no extra files."}`);

  const real = realpathSync(join(skill.dir, path));
  if (!real.startsWith(skill.dir + sep)) throw new SkillError("Only files inside the skill folder can be read.");
  if (statSync(real).size > LIMITS.assetBytes) throw new SkillError(`That file is larger than ${LIMITS.assetBytes / 1024} KB.`);
  return readFileSync(real, "utf8");
}
