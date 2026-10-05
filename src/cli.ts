import { Command }        from "commander";
import { existsSync }    from "node:fs";
import { join }          from "node:path";
import { PACKAGE_VERSION } from "./server.js";
import { parismHome }     from "./cli/paths.js";

/**
 * CLI 프로그램을 생성한다. 명령어 핸들러는 각 모듈에서 등록.
 */
export function createCli(): Command {
  const program = new Command();

  program
    .name("parism")
    .description("Structured shell output for AI agents")
    .version(PACKAGE_VERSION);

  program
    .command("capture <command>")
    .description("Execute command and save raw output as fixture")
    .option("-o, --output <dir>", "Output directory", "~/.parism/fixtures")
    .action(async (command: string, options: { output?: string }) => {
      const { captureCommand } = await import("./cli/capture.js");
      const parts  = command.split(/\s+/);
      const cmd    = parts[0];
      const args   = parts.slice(1);
      const result = await captureCommand(cmd, args, options.output);
      console.log(`Fixture saved: ${result.fixturePath}`);
      console.log(`Exit code: ${result.exitCode}`);
      /** 무엇이 가려졌는지 모른 채 '저장했다'만 말하면 나중에 원문 유출 여부를 알 수 없다. */
      if (result.redactions > 0) {
        const kinds = result.manifest.redactions.map(r => `${r.pattern}×${r.count}`).join(", ");
        console.log(`Redacted ${result.redactions} occurrence(s) (${kinds}) — manifest 의 redactions 에 남았다`);
      }
      console.log("This fixture replays but has no expected values yet.");
      console.log("Add expected (and reviewed_by) by hand, then run: parism test " + (options.output ?? "~/.parism/fixtures"));
    });

  program
    .command("init-parser <name>")
    .description("Scaffold a new parser pack (TypeScript + schema + test)")
    .option("-d, --dir <dir>", "Output directory", ".")
    .action(async (name: string, options: { dir?: string }) => {
      const { initParser } = await import("./cli/init-parser.js");
      const result = initParser(name, options.dir ?? ".");
      console.log(`Parser pack "${result.name}" created:`);
      result.files.forEach(f => console.log(`  ${f}`));
    });

  program
    .command("test [target]")
    .description("Replay fixtures in a directory offline and report contract changes")
    .option("--limit <n>", "How many changed paths to print per fixture", "20")
    .action(async (target: string | undefined, options: { limit?: string }) => {
      const dir = target ?? join(parismHome(), "fixtures");
      if (!existsSync(dir)) {
        console.log(`[parism] test: no such fixture directory: ${dir}`);
        console.log("Capture one first: parism capture \"git status --porcelain\"");
        process.exit(1);
      }
      const { replayDirectory, formatReport } = await import("./fixtures/run.js");
      const limit  = Number(options.limit ?? "20");
      const report = replayDirectory(dir, {});
      console.log(formatReport(report, Number.isFinite(limit) && limit > 0 ? limit : 20));
      /**
       * 판정: 깨진 fixture 와 계약 변화가 있으면 실패다.
       * 미검토 기대값은 실패로 세지 않는다 — 그것은 '틀렸다'가 아니라 '아직 보지 않았다' 다.
       */
      if (report.invalid > 0 || report.contractChanges > 0) process.exit(1);
    });

  program
    .command("add <path>")
    .description("Register a local parser pack permanently")
    .action(async (pathArg: string) => {
      const { addParserPack } = await import("./cli/add.js");
      const result = await addParserPack(pathArg);
      console.log(`Parser "${result.name}" added to ${result.installedTo}`);
    });

  program
    .command("inspect <command>")
    .description("Show raw / parsed / compact output comparison")
    .action(async (command: string) => {
      const { inspectOutput }  = await import("./cli/inspect.js");
      const { createRegistry } = await import("./parsers/index.js");
      const { execFile }       = await import("node:child_process");
      const { promisify }      = await import("node:util");
      const execFileAsync = promisify(execFile);

      const parts    = command.split(/\s+/);
      const cmd      = parts[0];
      const args     = parts.slice(1);
      const registry = createRegistry();

      let raw: string;
      try {
        const result = await execFileAsync(cmd, args, { timeout: 10_000 });
        raw = result.stdout;
      } catch (err: unknown) {
        raw = (err as { stdout?: string }).stdout ?? "";
      }

      const result = inspectOutput(cmd, args, raw, registry);
      console.log("=== RAW ===");
      console.log(result.raw);
      console.log("\n=== PARSED ===");
      console.log(JSON.stringify(result.parsed, null, 2));
      console.log("\n=== COMPACT ===");
      console.log(JSON.stringify(result.compact, null, 2));
      console.log(`\nTokens: raw=${result.tokens.raw} parsed=${result.tokens.parsed} compact=${result.tokens.compact}`);
    });

  program
    .command("eval [scenario]")
    .description("Run benchmark suite: parse-error, retry-rate, completion (default: all)")
    .option("-v, --verbose", "Show detailed output for each test case")
    .action(async (scenario: string | undefined, options: { verbose?: boolean }) => {
      const { runEvalSuite } = await import("./cli/eval.js");
      const results = await runEvalSuite(scenario, options.verbose);
      
      console.log("\n=== Eval Suite Results ===");
      console.log(`Scenario          | Runs | Success | Fail | Rate`);
      console.log(`-------------------|------|----------|------|------`);
      
      for (const [name, data] of Object.entries(results)) {
        const r = data as { total: number; success: number; fail: number };
        const rate = r.total > 0 ? ((r.success / r.total) * 100).toFixed(1) + "%" : "N/A";
        console.log(`${name.padEnd(17)}| ${String(r.total).padStart(4)} | ${String(r.success).padStart(8)} | ${String(r.fail).padStart(4)} | ${rate}`);
      }
      
      const totalRuns = Object.values(results).reduce((sum: number, r: unknown) => sum + (r as { total: number }).total, 0);
      const totalSuccess = Object.values(results).reduce((sum: number, r: unknown) => sum + (r as { success: number }).success, 0);
      console.log(`-------------------|------|----------|------|------`);
      console.log(`Overall           | ${String(totalRuns).padStart(4)} | ${String(totalSuccess).padStart(8)} | ${String(totalRuns - totalSuccess).padStart(4)} | ${totalRuns > 0 ? ((totalSuccess / totalRuns) * 100).toFixed(1) + "%" : "N/A"}`);
    });

  return program;
}
