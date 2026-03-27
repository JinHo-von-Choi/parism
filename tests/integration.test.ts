import { describe, it, expect } from "vitest";
import { buildRunResult } from "../src/server.js";
import { DEFAULT_CONFIG } from "../src/config/loader.js";
import { createRegistry } from "../src/parsers/index.js";

const registry = createRegistry();

describe("Integration: buildRunResult with parsers", () => {
  it("echo 결과에 parsed가 없다 (파서 미등록)", async () => {
    const result = await buildRunResult("echo", ["hello"], process.cwd(), DEFAULT_CONFIG, registry);
    const env    = JSON.parse(result);

    expect(env.ok).toBe(true);
    expect(env.stdout.raw.trim()).toBe("hello");
    expect(env.stdout.parsed).toBeNull();
  });

  it("ls 결과에 parsed entries가 있다", async () => {
    const result = await buildRunResult("ls", ["-la"], process.cwd(), DEFAULT_CONFIG, registry);
    const env    = JSON.parse(result);

    expect(env.ok).toBe(true);
    expect(env.stdout.parsed).not.toBeNull();
    expect(env.stdout.parsed.entries).toBeInstanceOf(Array);
  });

  it("env 결과에 parsed vars가 있다", async () => {
    const result = await buildRunResult("env", [], process.cwd(), DEFAULT_CONFIG, registry);
    const env    = JSON.parse(result);

    expect(env.ok).toBe(true);
    expect(env.stdout.parsed).not.toBeNull();
    expect(typeof env.stdout.parsed.vars).toBe("object");
  });
});
