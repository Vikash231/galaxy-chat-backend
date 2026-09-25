import type { MagicaRun } from "./types";
import cropImage from "./fixtures/crop_image.completed.json";

// Real responses recorded from live runs; fixture mode replays them without calling Magica.
const RECORDED: Record<string, Omit<MagicaRun, "id">> = {
  crop_image: cropImage as Omit<MagicaRun, "id">,
};

export function fixtureRun(runId: string, nodeType: string): MagicaRun {
  const recorded = RECORDED[nodeType];
  return recorded
    ? { ...recorded, id: runId, nodeType }
    : { id: runId, nodeType, status: "FAILED", output: null, error: "no fixture", userMessage: `No fixture for ${nodeType}.`, creditUsed: 0 };
}
