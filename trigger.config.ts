import type { TriggerConfig } from "@trigger.dev/sdk";
import { pythonExtension } from "@trigger.dev/python/extension";

export default {
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_wvsuixwhaupuhvoqwrgj",
  dirs: ["./trigger"],
  runtime: "node-22",
  maxDuration: 300,
  build: {
    extensions: [
      pythonExtension({
        requirementsFile: "./requirements.txt",
      }),
    ],
  },
  retries: { maxAttempts: 3, factor: 1.8, minTimeoutInMs: 1000, maxTimeoutInMs: 30000, randomize: true }
} satisfies TriggerConfig;
