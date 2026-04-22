import { McpServer }    from "@modelcontextprotocol/sdk/server/mcp.js";
import { z }            from "zod";
import type { PrismConfig }    from "./config/loader.js";
import type { ParserRegistry } from "./parsers/registry.js";
import { createRegistry }      from "./parsers/index.js";
import { ParismEngine }        from "./facade/engine.js";
import { PACKAGE_VERSION }     from "./version.js";

export { PACKAGE_VERSION };

const MCP_INSTRUCTIONS = `Parism: Structured shell output for AI agents.

When to use:
- ls/find: entries[] (name, type, size, permissions)
- git status/log/diff: branch, modified[], commits[], hunks
- ps/docker ps: processes[]/containers[]
- df/netstat: filesystems[]/connections[]
- systemctl/journalctl: units[]/entries[]
- helm/terraform: releases[]/summary
- apt/brew/npm/cargo: packages[]/dependencies[]/crates[]
- Filenames with spaces, OS-specific formats, or when you need to count/filter/compare fields.

When NOT to use: Single-line output (pwd, echo) or commands needing pipe/redirect (Guard blocks).

Tools:
- describe: Show allowed commands, available parsers, guard restrictions, version. Call this first.
- dry_run: Check if a command would pass the guard WITHOUT executing it.
- run: Execute command, get structured JSON. format: json|compact|json-no-raw.
- run_paged: Paginated stdout for large output. parsed is always null.

Usage:
1. Call describe first to understand what commands and parsers are available.
2. Use dry_run to pre-validate unfamiliar commands before executing.
3. Prefer run for small output; format=compact saves tokens.
4. Large output: run_paged(page=0) first, check page_info.total_lines, fetch needed pages.
5. Guard blocks disallowed commands. Check result.ok. On failure, result.failure has { kind, reason, message } — kind is 'guard' | 'exec' | 'parse' | 'config'. Legacy result.guard_error is still emitted for backward compatibility.
6. stdout.parsed has structured data; stdout.raw is fallback.

Notes:
- When config.telemetry.enabled is true, responses include a telemetry field with per-stage timing (guard_ms, exec_ms, parse_ms, redact_ms, total_ms, raw_bytes).
- When config.guard.secrets.output_redaction_enabled is true, stdout.raw and stderr.raw are masked with [REDACTED]; stdout.parsed is untouched.
- When config.parsers.strict_schemas is true, parser output is validated against the Zod schema — failure.reason = 'schema_violation' on mismatch.`;

/**
 * Guard 검사 → 실행 → JSON 직렬화까지의 파이프라인.
 * MCP 서버와 테스트 코드가 공통으로 사용한다.
 * 내부적으로 ParismEngine에 위임한다.
 *
 * @internal 테스트 헬퍼 전용. 서버 도구 핸들러는 engine.run을 직접 호출한다.
 */
export async function buildRunResult(
  cmd:         string,
  args:        string[],
  cwd:         string,
  config:      PrismConfig,
  registry:    ParserRegistry,
  format:      "json" | "compact" | "json-no-raw" = "json",
  includeDiff: boolean     = false,
): Promise<string> {
  const engine  = new ParismEngine(config, registry);
  const result  = await engine.run(cmd, { args, cwd, format, includeDiff });
  return JSON.stringify(result, null, 2);
}

/**
 * Guard 검사 → 실행 → 페이지 분할 → JSON 직렬화.
 * parsed는 항상 null (부분 출력은 구조화 파싱 불가).
 * 내부적으로 ParismEngine에 위임한다.
 *
 * @internal 테스트 헬퍼 전용. 서버 도구 핸들러는 engine.runPaged를 직접 호출한다.
 */
export async function buildPagedResult(
  cmd:         string,
  args:        string[],
  cwd:         string,
  page:        number,
  pageSize:    number,
  config:      PrismConfig,
  includeDiff: boolean = false,
): Promise<string> {
  // runPaged does not invoke parsers; a fresh registry is sufficient
  const engine = new ParismEngine(config, createRegistry());
  const result = await engine.runPaged(cmd, { args, cwd, page, page_size: pageSize, includeDiff });
  return JSON.stringify(result, null, 2);
}

/**
 * MCP 서버를 생성하고 `run` 도구를 등록한다.
 */
export function createServer(config: PrismConfig, registry: ParserRegistry): McpServer {
  const server = new McpServer(
    { name: "parism", version: PACKAGE_VERSION },
    { instructions: MCP_INSTRUCTIONS },
  );

  const engine = new ParismEngine(config, registry);

  server.tool(
    "run",
    "Execute a shell command and receive structured output. " +
    "All commands are filtered through an execution guard (whitelist + injection prevention). " +
    "Use format='compact' for token-efficient columnar output.",
    {
      cmd:         z.string().describe("Command name (e.g. 'ls', 'git')"),
      args:        z.array(z.string()).default([]).describe("Command arguments"),
      cwd:         z.string().default(process.cwd()).describe("Working directory"),
      format:      z.enum(["json", "compact", "json-no-raw"]).default("json")
                   .describe("Output format. 'compact'=columnar. 'json-no-raw'=omit raw for token savings."),
      includeDiff: z.boolean().default(false)
                   .describe("Include filesystem diff (created/deleted/modified). false=skip snapshot, lower latency."),
    },
    async ({ cmd, args, cwd, format, includeDiff }) => {
      const result = await engine.run(cmd, { args, cwd, format, includeDiff });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "run_paged",
    "Execute a shell command and return paginated stdout. " +
    "Use this for commands with large output (ps aux, find, grep -r). " +
    "Returns page_info with total_lines and has_next for navigation.",
    {
      cmd:         z.string().describe("Command name"),
      args:        z.array(z.string()).default([]).describe("Command arguments"),
      cwd:         z.string().default(process.cwd()).describe("Working directory"),
      page:        z.number().int().min(0).default(0).describe("Page index (0-based)"),
      page_size:   z.number().int().min(1).default(config.guard.default_page_size)
                   .describe("Lines per page"),
      includeDiff: z.boolean().default(false)
                   .describe("Include filesystem diff. false=skip snapshot, lower latency."),
    },
    async ({ cmd, args, cwd, page, page_size, includeDiff }) => {
      const result = await engine.runPaged(cmd, { args, cwd, page, page_size, includeDiff });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "describe",
    "Describe the current Parism environment: allowed commands, available parsers, guard restrictions, and version. " +
    "Call this first when using Parism to understand what commands are available and how the guard is configured.",
    {},
    async () => {
      const result = engine.describe();
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "dry_run",
    "Check whether a command would pass the execution guard WITHOUT actually running it. " +
    "Use this to pre-validate commands before calling run, especially for unfamiliar commands.",
    {
      cmd:  z.string().describe("Command name to test (e.g. 'git', 'rm')"),
      args: z.array(z.string()).default([]).describe("Command arguments to test"),
      cwd:  z.string().default(process.cwd()).describe("Working directory to test"),
    },
    async ({ cmd, args, cwd }) => {
      const result = engine.dryRun(cmd, args, cwd);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  return server;
}
