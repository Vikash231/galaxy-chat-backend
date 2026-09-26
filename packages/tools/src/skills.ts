import { z } from "zod";
import { readAsset, SkillError, type SkillSet } from "@gx/skills";
import { ToolRunError, type AnyTool, type ToolDef } from "./types";

/** load_skill and read_skill_asset for the given skills; none when there are no skills. */
export function skillTools(set: SkillSet): AnyTool[] {
  const names = [...set.skills.keys()];
  if (!names.length) return [];
  const skillName = z.enum(names as [string, ...string[]]);

  const loadArgs = z.object({ name: skillName.describe("The skill to load, from the skills list.") });
  const loadOutput = z.object({ name: z.string(), content: z.string(), files: z.array(z.string()), alreadyLoaded: z.boolean() });
  const loadSkill: ToolDef<typeof loadArgs, z.infer<typeof loadOutput>> = {
    name: "load_skill",
    description: "Load a skill's instructions before doing a task it covers. Free. Returns the guide and the names of any extra files.",
    label: "Loading skill",
    args: loadArgs,
    output: loadOutput,
    estimateMicro: () => 0n,
    assets: () => [],
    exec: {
      kind: "local",
      run: async ({ name }, ctx) => {
        const skill = set.skills.get(name)!;
        // The first load in a run is stored; a retry gets that same snapshot even if the file changed since.
        const rec = await ctx.recordSkill(name, skill.hash, skill.body);
        return { name, content: rec.content, files: skill.assets, alreadyLoaded: !rec.first };
      },
    },
  };

  const readArgs = z.object({
    skill: skillName.describe("The skill the file belongs to."),
    path: z.string().min(1).max(200).describe('A file listed by load_skill, e.g. "sizes.json".'),
  });
  const readOutput = z.object({ skill: z.string(), path: z.string(), content: z.string() });
  const readSkillAsset: ToolDef<typeof readArgs, z.infer<typeof readOutput>> = {
    name: "read_skill_asset",
    description: "Read one extra file of a loaded skill (as listed by load_skill). Free.",
    label: "Reading skill file",
    args: readArgs,
    output: readOutput,
    estimateMicro: () => 0n,
    assets: () => [],
    exec: {
      kind: "local",
      run: async ({ skill, path }) => {
        try {
          return { skill, path, content: readAsset(set.skills.get(skill)!, path) };
        } catch (e) {
          if (e instanceof SkillError) throw new ToolRunError(e.message);
          throw e;
        }
      },
    },
  };

  return [loadSkill, readSkillAsset];
}

/** The lines added to the system prompt: names and descriptions only, never the guides themselves. */
export const skillIndex = (set: SkillSet) => [...set.skills.values()].map((s) => `- ${s.name}: ${s.description}`);
