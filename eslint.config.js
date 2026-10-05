import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType:  "module",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    /**
     * 실험 스크립트(`experiments/`)는 Node 를 직접 쓴다.
     *
     * **여기를 검사한다는 것이 요점이다.** TypeScript 파일은 타입이 문법까지 잡아 주므로
     * `npm run lint` 에 포함되어 있지 않아도 그랬다. `.mjs` 는 순수 JavaScript 라
     * `function f(x: unknown): number {}` 같은 **타입 주석**이 문법 오류로 남고,
     * **CI 가 한 번도 실행하지 않는 채 통과한다.** 이 스크립트들에서 실제로 두 번 물렸다.
     *
     * `globals` 패키지를 새 의존성으로 넣지 않고, 실제로 쓰이는 전역만 좁혀 선언한다.
     * 여기 없는 이름은 계속 `no-undef` 로 걸린다 — 선언을 넓히면 검사가 느슨해진다.
     */
    files: ["experiments/**/*.mjs"],
    languageOptions: {
      globals: {
        console:        "readonly",
        process:        "readonly",
        Buffer:         "readonly",
        structuredClone: "readonly",
      },
    },
  },
);
