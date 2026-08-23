import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["vitest.config.ts", "**/*.test.ts"],
    },
  },
});
