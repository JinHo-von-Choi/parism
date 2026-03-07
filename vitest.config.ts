import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include:   ["tests/**/*.test.ts"],
    coverage:  {
      provider:   "v8",
      include:    ["src/**/*.ts"],
      exclude:    [
        "src/index.ts",
        "src/types/**",
        "**/*.test.ts",
        "benchmarks/**",
      ],
      thresholds: {
        statements: 80,
        branches:   80,
        functions:  80,
        lines:      80,
      },
    },
  },
});
