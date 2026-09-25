import { metadata } from "@trigger.dev/sdk";
import { RUN_META_KEY, type RunMeta } from "@gx/contracts";

/** Holds the run's RunMeta snapshot and publishes it under one metadata key. */
export function createMetaWriter() {
  const state: RunMeta = { status: "thinking", step: 0, tools: {} };
  const publish = () => metadata.set(RUN_META_KEY, structuredClone(state));
  return {
    set(patch: Partial<Omit<RunMeta, "tools">>) {
      Object.assign(state, patch);
      publish();
    },
    tool(key: string, patch: RunMeta["tools"][string]) {
      state.tools[key] = { ...state.tools[key], ...patch };
      publish();
    },
    flush: () => metadata.flush(),
  };
}
export type MetaWriter = ReturnType<typeof createMetaWriter>;
