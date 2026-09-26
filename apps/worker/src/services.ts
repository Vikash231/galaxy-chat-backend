import { workerEnv } from "@gx/config";
import { createOpenRouterProvider, createScriptedProvider, type LlmProvider } from "@gx/llm";
import { createMagicaClient, type MagicaClient } from "@gx/magica";
import { logger } from "@gx/observability";
import { loadSkills, type SkillSet } from "@gx/skills";
import { installSkills } from "@gx/tools";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

let llm: LlmProvider | undefined;
let magica: MagicaClient | undefined;

// LLM_FIXTURE=scripted swaps the model for a local script (see @gx/llm scripted); only for trying flows without a model.
export const getLlm = () =>
  (llm ??=
    process.env.LLM_FIXTURE === "scripted"
      ? createScriptedProvider()
      : createOpenRouterProvider({ apiKey: workerEnv().OPENROUTER_API_KEY, baseURL: workerEnv().OPENROUTER_BASE_URL, model: workerEnv().OPENROUTER_MODEL }));

export const getMagica = () =>
  (magica ??= createMagicaClient({ apiKey: workerEnv().MAGICA_API_KEY, baseUrl: workerEnv().MAGICA_BASE_URL, mode: workerEnv().MAGICA_MODE }));

let skills: SkillSet | undefined;

/**
 * Skills shipped with this worker version, loaded once. Deployed images carry them at ./agent-skills
 * (trigger.config.ts copies them); `trigger dev` runs from apps/worker, so the repo copy is two levels up.
 */
export function getSkills(): SkillSet {
  if (skills) return skills;
  const dir = [process.env.SKILLS_DIR, "agent-skills", "../../agent-skills"].filter((d): d is string => !!d).map((d) => resolve(d)).find((d) => existsSync(d));
  skills = loadSkills(dir ? [dir] : []);
  for (const r of skills.rejected) logger.error({ folder: r.folder, reason: r.reason }, "skill.rejected");
  logger.info({ dir, count: skills.skills.size, names: [...skills.skills.keys()] }, "skills.loaded");
  installSkills(skills);
  return skills;
}
