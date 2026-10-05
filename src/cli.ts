import { Command }        from "commander";
import { existsSync }    from "node:fs";
import { join }          from "node:path";
import { PACKAGE_VERSION } from "./server.js";
import { parismHome, expandTilde, defaultFixturesDir } from "./cli/paths.js";

/**
 * CLI 프로그램을 생성한다. 명령어 핸들러는 각 모듈에서 등록.
 */
/**
 * 명령 문자열을 argv 로 바꾼다.
 *
 * ## 두 모드가 있고, 차이가 있다
 *
 *   `parism inspect ls -l /path`      → argv 를 **그대로** 쓴다. 공백·따옴표를 따로따로 지킨다.
 *   `parism inspect "ls -l /path"`    → 공백으로 **나눈다.** 따옴표를 지킨다는 보장이 없다.
 *
 * 두 번째 모드에서 `parism inspect 'echo "hello   world"'` 를 주면 따옴표가
 * **문자 그대로** 자식 프로세스에 전달된다(실측: 출력이 `"hello world"` 로 quotes 를 달고 나온다).
 * 사용자 의도는 `hello   world` 한 개의 인자였지만 되지 않는다.
 *
 * 그래서 **인자를 여러 개로 주면 argv 모드로 판단하고 안내를 낸다.**
 * 조용히 잘못된 인자를 실행하는 것보다 "지금 이렇게 호출했다"고 말하는 편이 낫다.
 */
function splitCommand(parts: string[]): { args: string[]; stringMode: boolean } {
  return { args: parts, stringMode: false };
}

/** 한 토큰 안에 공백이 있으면 문자열 모드이고, 그 한계를 먼저 말한다. */
function splitSingleCommand(token: string): { args: string[]; stringMode: boolean } {
  if (!/\s/.test(token)) return { args: [token], stringMode: false };
  return { args: token.split(/\s+/), stringMode: true };
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
      const parts  = command.split(/\s+/);
      const cmd    = parts[0];
      const args   = parts.slice(1);
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

      /**
       * 한 토큰이면 공백으로 나눈다(문자열 모드), 여러 개면 argv 그대로 쓴다.
       * 어느 쪽인지 사용자에게 밝힌다 — 조용히 다른 인자를 실행하지 않는다.
       */
      const parts = commandParts.length === 1
        ? splitSingleCommand(commandParts[0]!)
        : splitCommand(commandParts);
      const cmd  = parts.args[0]!;
      const args = parts.args.slice(1);
      if (parts.stringMode) {
        console.error("[parism] 문자열 모드: 공백으로 나눴습니다. 따옴표로 묶은 인자는 보존되지 않습니다.");
        console.error("[parism] 정확히 넘기려면 인자를 따로 주십시오: parism inspect <cmd> [args...]");
      }
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

      const report = await runEvalSuite(scenario ? [scenario] : undefined);

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

  return program;
}
