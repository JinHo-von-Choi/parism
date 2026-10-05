#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer }         from "./server.js";
import { loadConfigMultiLayer } from "./config/loader.js";
import { createRegistry }       from "./parsers/index.js";
import { createCli }            from "./cli.js";
import { validatePatterns, DEFAULT_OUTPUT_REDACT_PATTERNS } from "./engine/redactor.js";

const CLI_COMMANDS = ["capture", "init-parser", "test", "add", "inspect", "help", "--help", "-h", "--version", "-V"];

function isCliMode(): boolean {
  const firstArg = process.argv[2];
  return firstArg != null && CLI_COMMANDS.includes(firstArg);
}

async function startMcpServer(): Promise<void> {
  const config     = await loadConfigMultiLayer();
  const registry   = createRegistry();

  const { loadExternalParsers, externalParserOptions } = await import("./cli/auto-loader.js");
  const { parismHome }                                 = await import("./cli/paths.js");
  const loaded = await loadExternalParsers(parismHome(), registry, externalParserOptions(config.parsers));
  if (loaded > 0) {
    console.error(`[parism] Loaded ${loaded} external parser(s)`);
  }

  if (config.guard.secrets?.output_redaction_enabled === true) {
    const rawPatterns     = config.guard.secrets.output_patterns !== undefined
      ? config.guard.secrets.output_patterns
      : DEFAULT_OUTPUT_REDACT_PATTERNS;
    const validatedCount  = validatePatterns(rawPatterns).length;
    process.stderr.write(`[parism] output redaction enabled (${validatedCount} patterns, raw/stderr only)\n`);
  }

  const server    = createServer(config, registry);
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

async function startCli(): Promise<void> {
  const program = createCli();
  await program.parseAsync(process.argv);
}

async function main(): Promise<void> {
  if (isCliMode()) {
    await startCli();
  } else {
    await startMcpServer();
  }
}

main().catch((err) => {
  console.error("[parism] Fatal error:", err);
  process.exit(1);
});

/**
 * 공개 타입을 루트 경로에서 다시 내보낸다.
 *
 * `parism init-parser` 가 만드는 스캐폴드는
 *   `import type { ParserPack, ParseContext } from "@nerdvana/parism"`
 * 라고 적는다. 그런데 이 파일은 CLI/MCP 실행 진입점이라 **아무것도 내보내지 않았다.**
 * 그래서 파서를 만들라는 안내를 따라간 사람이 받는 첫 오류가
 *   "Module '@nerdvana/parism' has no exported member 'ParserPack'"  였다(실측).
 * 5분짜리 안내가 처음부터 컴파일되지 않는 코드를 내놓는 셈이다.
 *
 * **타입 전용 export 이므로 런타임에 지워진다** — 코드 크기와 실행 비용은 늘지 않는다.
 * 값(함수·상수)은 여기서 내보내지 않는다. 루트는 실행 파일이지 라이브러리 입구가 아니다.
 */
export type {
  ParserPack,
  ParserContract,
  ParseContext,
  ParserFn,
  Fixture,
  ParseResult,
  FallbackParseResult,
  ParseErrorReason,
  OutputFormat,
  OutputShape,
  IsolatedParser,
  IsolatedParseResult,
} from "./parsers/registry.js";
