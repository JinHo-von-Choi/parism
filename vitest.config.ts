import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    /** 시험이 사용자 홈의 ~/.parism(영수증, 사용 통계)에 쓰지 않게 한다. */
    globalSetup: ["tests/global-setup.ts"],
    include:   ["tests/**/*.test.ts"],
    coverage:  {
      provider:   "v8",
      include:    ["src/**/*.ts"],
      exclude:    [
        "src/index.ts",
        "src/cli.ts",
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
