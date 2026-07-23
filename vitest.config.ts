import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: { environment: "node", include: ["packages/**/*.test.ts"] },
  resolve: {
    alias: {
      "@core": path.resolve(__dirname, "packages/core/src"),
      "@clickhouse": path.resolve(__dirname, "packages/clickhouse/src"),
      "@ingestion": path.resolve(__dirname, "packages/ingestion/src"),
      "@analysis": path.resolve(__dirname, "packages/analysis/src")
    }
  }
});
