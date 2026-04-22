import { Command }        from "commander";
import { PACKAGE_VERSION } from "./server.js";

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
    .command("test [parser]")
    .description("Run fixture replay tests for a parser pack")
    .action(async (_parser: string | undefined) => {
      console.log("[parism] test: not yet implemented");
      process.exit(1);
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
