/**
 * 텔레메트리를 켰을 때의 파서 결과 통계 시험.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, expect } from "vitest";
import { ParismEngine }         from "../../src/facade/engine.js";
import { DEFAULT_CONFIG }       from "../../src/config/loader.js";
import { createRegistry }       from "../../src/parsers/index.js";
import { UnrecognizedOutputError } from "../../src/parsers/registry.js";

function engine(telemetry: boolean): ParismEngine {
  const config = structuredClone(DEFAULT_CONFIG);
  config.guard.allowed_paths = [process.cwd()];
  config.telemetry           = { enabled: telemetry };
  return new ParismEngine(config, createRegistry());
}

describe("ParismEngine 결과 통계", () => {
  it("텔레메트리를 끄면(기본값) describe에 stats가 없다", async () => {
    const e = engine(false);
    await e.run("ls", { args: ["-l"] });
    expect(e.describe()).not.toHaveProperty("stats");
    expect(e.describe("ls")).not.toHaveProperty("stats");
  });

  it("텔레메트리를 켜면 run 결과를 명령과 결과별로 센다", async () => {
    const e = engine(true);
    await e.run("ls", { args: ["-l"] });
    await e.run("ls", { args: ["-l"], limit: 1 });
    await e.run("ls", { args: ["-C"] });
    await e.run("ls", { args: ["-l", "/etc"] });
    await e.run("echo", { args: ["hi"] });
    await e.run("cat", { args: ["no-such-file-for-stats"] });
    await e.run("rm", { args: ["x"] });
    await e.runPaged("ls", { args: ["-l", "/etc"] });

    const all = e.describe();
    expect(all.stats).toEqual({
      ls:           { parsed: 2, unsupported_format: 1, guard: { path_not_allowed: 2 } },
      echo:         { parser_not_found: 1 },
      cat:          { exec: { non_zero_exit: 1 } },
      "(unlisted)": { guard: { command_not_allowed: 1 } },
    });

    const ls = e.describe("ls");
    expect("stats" in ls && ls.stats).toEqual({ parsed: 2, unsupported_format: 1, guard: { path_not_allowed: 2 } });
  });

  it("파서 예외와 인식 실패를 사유로 센다", async () => {
    const config   = structuredClone(DEFAULT_CONFIG);
    config.telemetry = { enabled: true };
    const registry = createRegistry();
    registry.register("echo", () => { throw new Error("broken"); });
    registry.register("pwd", () => { throw new UnrecognizedOutputError("nothing"); });
    const e = new ParismEngine(config, registry);
    await e.run("echo", { args: ["hi"] });
    await e.run("pwd");
    expect(e.describe().stats).toEqual({ echo: { parser_exception: 1 }, pwd: { unrecognized_output: 1 } });
  });
});
