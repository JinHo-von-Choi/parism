import { McpServer }              from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport }   from "@modelcontextprotocol/sdk/server/stdio.js";
import { z }                      from "zod";
import { execute }                from "./engine/executor.js";
import { checkGuard, GuardError } from "./engine/guard.js";
import { defaultRegistry }        from "./parsers/index.js";
import { paginateLines }          from "./engine/paginator.js";
import type { PrismConfig }       from "./config/loader.js";

const PACKAGE_VERSION = "0.1.4";

/**
 * Guard 검사 → 실행 → JSON 직렬화까지의 파이프라인.
 * MCP 서버와 테스트 코드가 공통으로 사용한다.
 */
export async function buildRunResult(
  cmd:    string,
  args:   string[],
  cwd:    string,
  config: PrismConfig,
): Promise<string> {
  try {
    checkGuard(cmd, args, cwd, config);
  } catch (err) {
    if (err instanceof GuardError) {
      const envelope = {
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
      };
      return JSON.stringify(envelope, null, 2);
    }
    throw err;
  }

  const envelope = await execute(
    cmd, args, cwd,
    config.guard.env_secret_patterns,
    config.guard.timeout_ms,
    config.guard.max_output_bytes,
  );
  const parsed   = defaultRegistry.parse(cmd, args, envelope.stdout.raw, { maxItems: config.guard.max_items });
  const enriched = { ...envelope, stdout: { ...envelope.stdout, parsed } };
  return JSON.stringify(enriched, null, 2);
}

/**
 * Guard 검사 → 실행 → 페이지 분할 → JSON 직렬화.
 * parsed는 항상 null (부분 출력은 구조화 파싱 불가).
 */
export async function buildPagedResult(
  cmd:      string,
  args:     string[],
  cwd:      string,
  page:     number,
  pageSize: number,
  config:   PrismConfig,
): Promise<string> {
  try {
    checkGuard(cmd, args, cwd, config);
  } catch (err) {
    if (err instanceof GuardError) {
      const envelope = {
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
      };
      return JSON.stringify(envelope, null, 2);
    }
    throw err;
  }

  // 전체 stdout이 필요하므로 max_output_bytes 비활성 (0)
  const envelope               = await execute(
    cmd, args, cwd,
    config.guard.env_secret_patterns,
    config.guard.timeout_ms,
    0,
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

/**
 * MCP 서버를 생성하고 `run` 도구를 등록한다.
 */
export function createServer(config: PrismConfig): McpServer {
  const server = new McpServer({
    name:    "parism",
    version: PACKAGE_VERSION,
  });

  server.tool(
    "run",
    "Execute a shell command and receive structured JSON output. " +
    "All commands are filtered through an execution guard (whitelist + injection prevention).",
    {
      cmd:  z.string().describe("Command name (e.g. 'ls', 'git')"),
      args: z.array(z.string()).default([]).describe("Command arguments"),
      cwd:  z.string().default(process.cwd()).describe("Working directory"),
    },
    async ({ cmd, args, cwd }) => {
      const result = await buildRunResult(cmd, args, cwd, config);
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
      cmd:       z.string().describe("Command name"),
      args:      z.array(z.string()).default([]).describe("Command arguments"),
      cwd:       z.string().default(process.cwd()).describe("Working directory"),
      page:      z.number().int().min(0).default(0).describe("Page index (0-based)"),
      page_size: z.number().int().min(1).default(config.guard.default_page_size)
                 .describe("Lines per page"),
    },
    async ({ cmd, args, cwd, page, page_size }) => {
      const result = await buildPagedResult(cmd, args, cwd, page, page_size, config);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );

  return server;
}
