import type { TriggerConfig } from "@trigger.dev/sdk";

export default {
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_wvsuixwhaupuhvoqwrgj",
  dirs: ["./trigger"],
  runtime: "node-22",
  maxDuration: 300,
  retries: { maxAttempts: 3, factor: 1.8, minTimeoutInMs: 1000, maxTimeoutInMs: 30000, randomize: true }
} satisfies TriggerConfig;
