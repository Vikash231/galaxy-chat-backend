import { defineConfig } from "@trigger.dev/sdk";
import { additionalFiles } from "@trigger.dev/build/extensions/core";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_set_TRIGGER_PROJECT_REF",
  dirs: ["./src/tasks"],
  ignorePatterns: ["**/*.test.ts"],
  maxDuration: 900,
  retries: { enabledInDev: false, default: { maxAttempts: 1 } },
  build: {
    extensions: [
      prismaExtension({ mode: "legacy", schema: "../../packages/db/prisma/schema.prisma" }),
      // Our own skills ship inside each worker version (lands at ./agent-skills in the image).
      additionalFiles({ files: ["../../agent-skills/**"] }),
    ],
  },
});
