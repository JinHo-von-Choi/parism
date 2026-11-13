import { Command }        from "commander";
import { existsSync }    from "node:fs";
import { join }          from "node:path";
import { PACKAGE_VERSION } from "./server.js";
import { parismHome, expandTilde, defaultFixturesDir } from "./cli/paths.js";
import { lexCommand }    from "./engine/command-lexer.js";

/**
 * 명령 문자열을 argv 로 바꾼다.
 *
 *   `parism inspect ls -l /path`      → argv 를 그대로 쓴다.
 *   `parism inspect "ls -l /path"`    → 셸 없이 렉서(engine/command-lexer.ts)로 나눈다. 따옴표와 백슬래시를 지킨다.
 *
 * 렉서가 받지 않는 셸 문법(파이프, 리다이렉션, 치환)이 있으면 실행하지 않고 그 사실을 알린다.
 */
function splitSingleCommand(token: string): { args: string[] } | { error: string } {
  const lexed = lexCommand(token);
  if (!lexed.ok) return { error: `${lexed.message}. ${lexed.hint}` };
  if (lexed.pipeline.length > 0 || lexed.cwd !== undefined) return { error: "pipes and 'cd dir &&' are not run here; use parism exec" };
  return { args: [lexed.cmd, ...lexed.args] };
}

export function createCli(): Command {
  const program = new Command();

  program
    .name("parism")
    .description("Structured shell output for AI agents")
    .version(PACKAGE_VERSION);

  program
    .command("capture <command>")
    .description("Execute command and save raw output as fixture")
    .option("-o, --output <dir>", "Output directory (default: ~/.parism/fixtures)")
    .action(async (command: string, options: { output?: string }) => {
      const { captureCommand } = await import("./cli/capture.js");
      const parts  = splitSingleCommand(command);
      if ("error" in parts) {
        console.error(`[parism] capture: ${parts.error}`);
        process.exitCode = 2;
        return;
      }
      const cmd    = parts.args[0]!;
      const args   = parts.args.slice(1);
      /**
       * 기본값을 `~` **문자열**로 두면 셸이 아니라 Node 라서 전개되지 않는다.
       * 그 결과 fixture 가 작업 디렉터리 안의 `~` 폴더에 쓰이고, 사용자는
       * 집에 저장됐다고 믿는다. 실제 경로로 바꿔 넘긴다. (cli/paths.ts 의 `expandTilde` 주석 참고)
       */
      const outputDir = options.output ? expandTilde(options.output) : defaultFixturesDir();
      const result = await captureCommand(cmd, args, outputDir);
      console.log(`Fixture saved: ${result.fixturePath}`);
      console.log(`Exit code: ${result.exitCode}`);
      /** 무엇이 가려졌는지 모른 채 '저장했다'만 말하면 나중에 원문 유출 여부를 알 수 없다. */
      if (result.redactions > 0) {
        const kinds = result.manifest.redactions.map(r => `${r.pattern}×${r.count}`).join(", ");
        console.log(`Redacted ${result.redactions} occurrence(s) (${kinds}) — manifest 의 redactions 에 남았다`);
      }
      console.log("This fixture replays but has no expected values yet.");
      console.log("Add expected (and reviewed_by) by hand, then run: parism test " + outputDir);
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
      const limit = Number(options.limit ?? "20");
      const cap   = Number.isFinite(limit) && limit > 0 ? limit : 20;

      /**
       * 두 가지를 **한 명령**에서 되짚는다 — 계획서 4.5장
       * "runFixtureTests helper 를 CLI test 과 연결" 의 요구다.
       * manifest fixture(사람이 캡처해 기대값을 적은 것)와 팩 fixture(팩 안의 fixtures)를
       * 따로 돌리면 어느 한쪽의 회귀가 안 보인다. 회귀 고리가 하나여야 한다.
       */
      const { replayDirectory, formatReport, replayRegisteredPacks } = await import("./fixtures/run.js");
      const { loadParserPack } = await import("./cli/loader.js");
      const paths = await import("./cli/paths.js");

      const packs = await replayRegisteredPacks(loadParserPack, paths.parismHome());
      if (packs.results.length > 0) {
        console.log("등록된 파서 팩의 fixture:");
        for (const r of packs.results) {
          const head = `  ${r.name.padEnd(16)} `;
          if (r.status === "replayed") {
            const mark = r.failed > 0 ? "✗" : "✓";
            console.log(`${head}${mark} ${r.passed}/${r.total} 통과${r.errored > 0 ? ` (오류 ${r.errored})` : ""}`);
          } else {
            console.log(`${head}— ${r.reason}`);
          }
        }
        if (packs.failed > 0) {
          console.log(`\n  실패한 팩 fixture ${packs.failed}건 — 위 줄에서 어느 팩인지 볼 수 있다.`);
        }
        console.log("");
      }

      const report = replayDirectory(dir, {});
      console.log(formatReport(report, cap));
      /**
       * 판정: 깨진 fixture 와 계약 변화가 있으면 실패다.
       * 미검토 기대값은 실패로 세지 않는다 — 그것은 '틀렸다'가 아니라 '아직 보지 않았다' 다.
       */
      if (report.invalid > 0 || report.contractChanges > 0 || packs.failed > 0) process.exit(1);
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
    .command("inspect <command...>")
    .description("Show raw / parsed / compact output comparison")
    .action(async (commandParts: string[]) => {
      const { inspectOutput }  = await import("./cli/inspect.js");
      const { createRegistry } = await import("./parsers/index.js");
      const { execFile }       = await import("node:child_process");
      const { promisify }      = await import("node:util");
      const execFileAsync = promisify(execFile);

      /** 한 토큰이면 렉서로 나누고, 여러 개면 argv 그대로 쓴다. */
      const parts = commandParts.length === 1 ? splitSingleCommand(commandParts[0]!) : { args: commandParts };
      if ("error" in parts) {
        console.error(`[parism] inspect: ${parts.error}`);
        process.exitCode = 2;
        return;
      }
      const cmd  = parts.args[0]!;
      const args = parts.args.slice(1);
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
    .description("Run the eval suite. Results are judged separately at three levels: execution, parse, task")
    .option("-v, --verbose", "Show every case with its observation and any mismatch")
    .action(async (scenario: string | undefined, options: { verbose?: boolean }) => {
      const { runEvalSuite, SCENARIO_NAMES } = await import("./cli/eval.js");

      if (scenario && !SCENARIO_NAMES.includes(scenario)) {
        console.error(`[parism eval] 알 수 없는 시나리오 '${scenario}'. 있는 것: ${SCENARIO_NAMES.join(", ")}`);
        process.exitCode = 1;
        return;
      }

      const report = await runEvalSuite(scenario ? { names: [scenario] } : undefined);

      console.log("\n=== parism eval ===");
      console.log("판정은 세 층으로 따로 본다. 섞지 않는다.\n");

      for (const [name, s] of Object.entries(report.scenarios)) {
        console.log(`── ${name} ` + "─".repeat(Math.max(0, 58 - name.length)));
        console.log(`  층        기대있음  일치    관측`);
        for (const [layer, stats] of Object.entries({ execution: s.execution, parse: s.parse, task: s.task })) {
          const rate = stats.judged > 0 ? `${stats.matched}/${stats.judged}` : "판정 안 함";
          const seen = Object.entries(stats.observed).map(([k, v]) => `${k} ${v}`).join(", ") || "—";
          console.log(`  ${layer.padEnd(9)} ${String(stats.judged).padStart(7)}  ${rate.padStart(6)}    ${seen}`);
        }

        const bad = s.cases.filter(c => c.mismatches.length > 0);
        if (bad.length > 0) {
          console.log(`\n  기대와 어긋난 항목 ${bad.length}건:`);
          for (const c of bad) {
            console.log(`    ✗ ${c.id} (${c.cmd} ${c.args.join(" ")})`);
            for (const m of c.mismatches) console.log(`        ${m}`);
          }
        }
        if (options.verbose) {
          console.log("\n  관측 전부:");
          for (const c of s.cases) {
            const mark = c.mismatches.length > 0 ? "✗" : "·";
            console.log(`    ${mark} ${c.id.padEnd(18)} exec=${c.execution} parse=${c.parse ?? "—"} task=${c.task ?? "—"}${c.note ? `  (${c.note})` : ""}`);
          }
        }
        console.log("");
      }

      /** 기대에 어긋난 항목이 하나라도 있으면 게이트는 실패다. */
      const mismatched = Object.values(report.scenarios)
        .flatMap(s => s.cases).filter(c => c.mismatches.length > 0).length;
      if (mismatched > 0) {
        console.log(`[parism eval] 기대와 어긋난 항목 ${mismatched}건 — 실패다.`);
        process.exitCode = 1;
      } else {
        console.log("[parism eval] 기대한 대로의 항목은 어긋난 것이 없다.");
      }
      console.log("\n  관측은 관측이다. 기대를 세우지 않은 항목은 비율에 들어가지 않는다.");
    });

  const receipts = program
    .command("receipts")
    .description("Read run receipts written when receipts.enabled is set in the host config");

  receipts
    .command("check")
    .description("Exit 0 only if every required command has a passing receipt taken in the current workspace state. Never runs a command")
    .option("--cwd <dir>", "Workspace to check (default: current directory)")
    .option("--require <command>", "Command that must have passed, e.g. \"npx vitest run\" or a JSON array. Repeatable. Default: verify.commands", (value: string, all: string[]) => [...all, value], [] as string[])
    .option("--config <file>", "Config file to read instead of the global and project config")
    .option("--json", "Print the report as JSON")
    .action(async (options: { cwd?: string; require: string[]; config?: string; json?: boolean }) => {
      const { receiptsCheck, formatCheck, parseRequire } = await import("./cli/receipts.js");
      let required: string[][];
      try {
        required = options.require.map(parseRequire);
      } catch (err) {
        console.error(`[parism receipts] ${(err as Error).message}`);
        process.exitCode = 2;
        return;
      }
      const report = await receiptsCheck({ cwd: options.cwd, require: required, config: options.config });
      if ("error" in report) {
        console.error(`[parism receipts] ${report.error}`);
        process.exitCode = 2;
        return;
      }
      console.log(options.json ? JSON.stringify(report) : formatCheck(report));
      if (!report.ok) process.exitCode = 1;
    });

  receipts
    .command("list")
    .description("Show recent receipts, newest first")
    .option("--limit <n>", "How many to show", "20")
    .option("--config <file>", "Config file to read instead of the global and project config")
    .option("--json", "Print as JSON")
    .action(async (options: { limit: string; config?: string; json?: boolean }) => {
      const { receiptsList } = await import("./cli/receipts.js");
      const limit = Number(options.limit);
      const list  = await receiptsList({ limit: Number.isInteger(limit) && limit > 0 ? limit : 20, config: options.config });
      if (options.json) {
        console.log(JSON.stringify(list));
        return;
      }
      if (list.length === 0) {
        console.log("no receipts. Set receipts.enabled to true in the host config (~/.parism/prism.config.json).");
        return;
      }
      for (const r of list) {
        const summary = r.summary?.kind === "test" ? `passed ${r.summary.passed} failed ${r.summary.failed}`
          : r.summary?.kind === "diagnostics" ? `errors ${r.summary.errors} warnings ${r.summary.warnings}` : "";
        console.log(`${r.started_at}  exit ${r.exit_code}  ${[r.cmd, ...(r.args_requested ?? r.args)].join(" ")}  ${summary}`);
      }
    });

  receipts
    .command("verify")
    .description("Check the receipt file: hash chain (no edited, removed or inserted lines) and signatures. Never runs a command")
    .option("--config <file>", "Config file to read instead of the global and project config")
    .option("--json", "Print as JSON")
    .action(async (options: { config?: string; json?: boolean }) => {
      const { receiptsVerify } = await import("./cli/receipts.js");
      const report = await receiptsVerify({ ...(options.config && { config: options.config }) });
      if (options.json) console.log(JSON.stringify(report));
      else {
        for (const p of report.problems) console.log(`FAIL line ${p.line} ${p.id ?? ""} [${p.reason}] ${p.detail}`);
        console.log(`${report.entries} receipt(s) in ${report.file}; ${report.signed ? `signed with ${report.key_file ?? "the configured key"}` : "no signing key"}; ${report.ok ? "chain and signatures intact" : `${report.problems.length} problem(s)`}`);
      }
      if (!report.ok) process.exitCode = 1;
    });

  receipts
    .command("export")
    .description("Summarize receipts and usage for a pull request or CI: markdown, sarif, github (writes $GITHUB_STEP_SUMMARY) or json")
    .option("--format <format>", "markdown | sarif | github | json", "markdown")
    .option("--cwd <dir>", "Workspace (default: current directory)")
    .option("--since <when>", "Only receipts after this, e.g. 7d, 24h or a date")
    .option("--config <file>", "Config file to read instead of the global and project config")
    .action(async (options: { format: string; cwd?: string; since?: string; config?: string }) => {
      const { receiptsExport, formatExportMarkdown, formatExportSarif } = await import("./cli/receipts.js");
      const summary = await receiptsExport({ ...(options.cwd && { cwd: options.cwd }), ...(options.since && { since: options.since }), ...(options.config && { config: options.config }) });
      if (options.format === "json") console.log(JSON.stringify(summary));
      else if (options.format === "sarif") console.log(formatExportSarif(summary, PACKAGE_VERSION));
      else if (options.format === "markdown") console.log(formatExportMarkdown(summary));
      else if (options.format === "github") {
        const markdown = formatExportMarkdown(summary);
        const target   = process.env.GITHUB_STEP_SUMMARY;
        if (target) {
          const { appendFileSync } = await import("node:fs");
          appendFileSync(target, markdown + "\n");
          console.log(`written to ${target}`);
        } else {
          console.log(markdown);
        }
        for (const f of summary.failed_runs.slice(-20)) console.log(`::error title=parism::${f.command} failed: ${f.detail}`);
        if (!summary.chain.ok) console.log("::error title=parism::receipt file failed the chain or signature check");
      } else {
        console.error(`[parism receipts] unknown format '${options.format}'`);
        process.exitCode = 2;
        return;
      }
      if (summary.failed_runs.length > 0 || !summary.chain.ok) process.exitCode = 1;
    });

  program
    .command("exec [command...]")
    .description("Run one command line through the Parism engine (guard, parsing, redaction, receipts) and print it like a shell would")
    .option("--cwd <dir>", "Working directory (default: current directory)")
    .option("--config <file>", "Config file (default: ~/.parism/hook.config.json when it exists, else the global and project config)")
    .allowUnknownOption(true)
    .action(async (parts: string[], options: { cwd?: string; config?: string }) => {
      const { execCommand } = await import("./cli/exec.js");
      const { hookConfigFile } = await import("./cli/hook.js");
      if (parts.length === 0) {
        console.error("[parism exec] give a command, e.g. parism exec -- \"git status\"");
        process.exitCode = 2;
        return;
      }
      /** 인자 하나면 명령 문자열, 여럿이면 셸이 이미 나눈 argv다. argv는 따옴표로 다시 감싸 이어 붙인다. */
      const { quoteArg } = await import("./engine/command-lexer.js");
      const command = parts.length === 1 ? parts[0]! : parts.map(quoteArg).join(" ");
      const { existsSync: exists } = await import("node:fs");
      const config  = options.config ?? (exists(hookConfigFile()) ? hookConfigFile() : undefined);
      const result  = await execCommand(command, { ...(options.cwd && { cwd: options.cwd }), ...(config && { config }) });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    });

  const hook = program
    .command("hook")
    .description("Connect an agent CLI to Parism through hooks: rewrite Bash calls, record the session start, block unverified finishes");

  for (const event of ["pre-tool-use", "session-start", "stop"] as const) {
    hook
      .command(event)
      .description(`Handle the ${event} hook: read the hook JSON from stdin and answer on stdout`)
      .option("--config <file>", "Config file (default: ~/.parism/hook.config.json)")
      .option("--client <client>", "claude (default), gemini or agy")
      .action(async (options: { config?: string; client?: string }) => {
        const { runHook } = await import("./cli/hook.js");
        try {
          const out = await runHook(event, { ...(options.config && { config: options.config }), ...((options.client === "gemini" || options.client === "agy") && { client: options.client }) });
          if (out !== undefined) process.stdout.write(out + "\n");
        } catch (err) {
          /** 훅이 실패해도 에이전트 작업을 막지 않는다. 종료 코드 1은 비차단 오류다. */
          process.stderr.write(`[parism hook ${event}] ${(err as Error).message}\n`);
          process.exitCode = 1;
        }
      });
  }

  hook
    .command("install")
    .description("Add the PreToolUse, Stop and SessionStart hooks to the client settings and create ~/.parism/hook.config.json")
    .option("--client <client>", "claude (default), gemini or agy (Antigravity CLI)", "claude")
    .option("--scope <scope>", "project (default: .claude/settings.json, .gemini/settings.json, .agents/hooks.json) or user (under the home directory)", "project")
    .action(async (options: { client: string; scope: string }) => {
      const { installHooks } = await import("./cli/hook.js");
      if (!["claude", "gemini", "agy"].includes(options.client) || !["project", "user"].includes(options.scope)) {
        console.error("[parism hook install] --client claude|gemini|agy, --scope project|user");
        process.exitCode = 2;
        return;
      }
      const result = installHooks({ client: options.client as "claude" | "gemini" | "agy", scope: options.scope as "project" | "user" });
      console.log(`hooks written to ${result.settings}`);
      console.log(result.created_hook_config
        ? `hook config created at ${result.hook_config} (profile build, receipts on, redaction on, allowed_paths: this directory)`
        : `hook config kept at ${result.hook_config}`);
    });

  program
    .command("skill")
    .description("Install the Parism agent skill")
    .command("install")
    .description("Copy the Parism skill to .claude/skills/parism (project, default) or ~/.claude/skills/parism (user)")
    .option("--scope <scope>", "project or user", "project")
    .action(async (options: { scope: string }) => {
      if (!["project", "user"].includes(options.scope)) {
        console.error("[parism skill install] --scope project|user");
        process.exitCode = 2;
        return;
      }
      const { installSkill } = await import("./cli/skill.js");
      const result = installSkill({ scope: options.scope as "project" | "user" });
      console.log(`${result.replaced ? "updated" : "installed"} skill ${result.version ?? ""} at ${result.target}`.replace("  ", " "));
    });

  program
    .command("stats")
    .description("Show what Parism saved and blocked: tokens, re-queries, redactions, guard blocks, stop gate")
    .option("--since <when>", "e.g. 7d, 24h, 30m or a date")
    .option("--price <usd>", "Input price per million tokens for the cost estimate", "3")
    .option("--config <file>", "Config file to read instead of the global and project config")
    .option("--json", "Print as JSON")
    .action(async (options: { since?: string; price: string; config?: string; json?: boolean }) => {
      const { readStats, formatStats } = await import("./cli/stats.js");
      try {
        const report = await readStats({ ...(options.since && { since: options.since }), price: Number(options.price), ...(options.config && { config: options.config }) });
        console.log(options.json ? JSON.stringify(report) : formatStats(report));
      } catch (err) {
        console.error(`[parism stats] ${(err as Error).message}`);
        process.exitCode = 2;
      }
    });

  program
    .command("doctor")
    .description("Check the configuration and installation and say what to fix")
    .option("--config <file>", "Config file to read instead of the global and project config")
    .option("--json", "Print as JSON")
    .action(async (options: { config?: string; json?: boolean }) => {
      const { runDoctor, formatDoctor } = await import("./cli/doctor.js");
      const report = await runDoctor({ ...(options.config && { config: options.config }) });
      console.log(options.json ? JSON.stringify(report) : formatDoctor(report));
      if (!report.ok) process.exitCode = 1;
    });

  return program;
}
