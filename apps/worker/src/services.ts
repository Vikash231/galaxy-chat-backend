import { workerEnv } from "@gx/config";
import { createOpenRouterProvider, type LlmProvider } from "@gx/llm";
import { createMagicaClient, type MagicaClient } from "@gx/magica";

let llm: LlmProvider | undefined;
let magica: MagicaClient | undefined;

export const getLlm = () =>
  (llm ??= createOpenRouterProvider({ apiKey: workerEnv().OPENROUTER_API_KEY, baseURL: workerEnv().OPENROUTER_BASE_URL, model: workerEnv().OPENROUTER_MODEL }));

export const getMagica = () =>
  (magica ??= createMagicaClient({ apiKey: workerEnv().MAGICA_API_KEY, baseUrl: workerEnv().MAGICA_BASE_URL, mode: workerEnv().MAGICA_MODE }));
