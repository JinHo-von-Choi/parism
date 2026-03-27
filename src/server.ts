import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z }         from "zod";
import { execute }                from "./engine/executor.js";
import { checkGuard, GuardError } from "./engine/guard.js";
import { paginateLines }          from "./engine/paginator.js";
import type { PrismConfig }       from "./config/loader.js";
import type { ParserRegistry }   from "./parsers/registry.js";
import type { OutputFormat }      from "./parsers/registry.js";
import { toCompact }              from "./parsers/compact.js";
import { tryParseNativeJson }    from "./parsers/json-passthrough.js";

export const PACKAGE_VERSION = "0.5.0";

/**
 * Guard 차단 시 반환하는 에러 봉투를 생성한다.
 */
function buildGuardErrorEnvelope(
  cmd: string, args: string[], cwd: string, err: GuardError,
): string {
  return JSON.stringify({
    ok:          false,
    exitCode:    -1,
    cmd,
    args,
    cwd,
    duration_ms: 0,
    stdout:      { raw: "", parsed: null },
    stderr:      { raw: err.message, parsed: null },
    diff:        null,
    guard_error: { reason: err.reason, message: err.message },
  }, null, 2);
}

/**
 * Guard 검사 → 실행 → JSON 직렬화까지의 파이프라인.
 * MCP 서버와 테스트 코드가 공통으로 사용한다.
 */
export async function buildRunResult(
  cmd:         string,
  args:        string[],
  cwd:         string,
  config:      PrismConfig,
  registry:    ParserRegistry,
  format:      OutputFormat = "json",
  includeDiff: boolean     = true,
): Promise<string> {
  try {
    checkGuard(cmd, args, cwd, config);
  } catch (err) {
    if (err instanceof GuardError) return buildGuardErrorEnvelope(cmd, args, cwd, err);
    throw err;
  }

  const envelope = await execute(
    cmd, args, cwd,
    config.guard.env_secret_patterns,
    config.guard.timeout_ms,
    config.guard.max_output_bytes,
    includeDiff,
  );
  const parseFormat  = format === "json-no-raw" ? "json" : format;
  const parseResult = registry.parse(cmd, args, envelope.stdout.raw, { maxItems: config.guard.max_items, format: parseFormat });
  let parsed        = parseResult.parsed;
  if (parsed == null) parsed = tryParseNativeJson(envelope.stdout.raw);
  const final       = parseFormat === "compact" ? toCompact(parsed) : parsed;
  const stdout      = format === "json-no-raw"
    ? { raw: "", parsed: final, ...(parseResult.parse_error && { parse_error: parseResult.parse_error }) }
    : { ...envelope.stdout, parsed: final, ...(parseResult.parse_error && { parse_error: parseResult.parse_error }) };
  const enriched    = { ...envelope, stdout };
  return JSON.stringify(enriched, null, 2);
}

/**
 * Guard 검사 → 실행 → 페이지 분할 → JSON 직렬화.
 * parsed는 항상 null (부분 출력은 구조화 파싱 불가).
 */
export async function buildPagedResult(
  cmd:         string,
  args:        string[],
  cwd:         string,
  page:        number,
  pageSize:    number,
  config:      PrismConfig,
  includeDiff: boolean = true,
): Promise<string> {
  try {
    checkGuard(cmd, args, cwd, config);
  } catch (err) {
    if (err instanceof GuardError) return buildGuardErrorEnvelope(cmd, args, cwd, err);
    throw err;
  }

  // 전체 stdout이 필요하므로 max_output_bytes 비활성 (0)
  const envelope               = await execute(
    cmd, args, cwd,
    config.guard.env_secret_patterns,
    config.guard.timeout_ms,
    0,
    includeDiff,
  );
  const { lines, page_info }   = paginateLines(envelope.stdout.raw, page, pageSize);
  const pagedRaw               = lines.join("\n") + (lines.length > 0 ? "\n" : "");
  const enriched               = {
    ...envelope,
    stdout:    { raw: pagedRaw, parsed: null },
    page_info,
  };
  return JSON.stringify(enriched, null, 2);
}

const MCP_INSTRUCTIONS = `Parism: Structured shell output for AI agents.

When to use Parism:
- File listing (ls, find): Get entries[] with name, type, size, permissions — no raw parsing.
- Git state (status, log, diff): Structured branch, modified[], commits[], hunks — code review ready.
- Process/container (ps, docker ps): Structured processes[]/containers[] — filter by PID, status.
- Disk/network (df, netstat): Structured filesystems[]/connections[] — no column alignment guess.
- System (systemctl list-units, journalctl -o short-iso): units[]/entries[] — service status, logs.
- DevOps (helm list, terraform plan): releases[]/summary — deployments, plan changes.
- Packages (apt list, brew list, npm list, cargo tree): packages[]/dependencies[]/crates[].
- When output has spaces in filenames or OS-specific format: Parism parses deterministically, CFR 0%.
- When you need to count, filter, or compare: Use parsed.entries.length, parsed.files_changed, etc.

When NOT to use: Simple one-line output (pwd, echo), or when you need pipe/redirect (Guard blocks).

Tools:
- run: Execute command, get structured JSON. format: json|compact|json-no-raw.
- run_paged: Paginated stdout for large output (ps aux, find, grep -r). parsed is always null.

Usage:
1. Prefer run when output is small. Use format=compact for token savings.
2. For large output: run_paged(page=0) first, check page_info.total_lines, then fetch needed pages.
3. Guard blocks disallowed commands. Check result.ok and result.guard_error on failure.
4. stdout.parsed has structured data; stdout.raw is fallback. Schema varies by command.`;

/**
 * MCP 서버를 생성하고 `run` 도구를 등록한다.
 */
export function createServer(config: PrismConfig, registry: ParserRegistry): McpServer {
  const server = new McpServer(
    { name: "parism", version: PACKAGE_VERSION },
    { instructions: MCP_INSTRUCTIONS },
  );

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
      const result = await buildRunResult(cmd, args, cwd, config, registry, format, includeDiff);
      return {
        content: [{ type: "text" as const, text: result }],
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
      const result = await buildPagedResult(cmd, args, cwd, page, page_size, config, includeDiff);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  return server;
}
