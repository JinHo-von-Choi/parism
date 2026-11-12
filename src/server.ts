import { McpServer }    from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z }            from "zod";
import { realpathSync } from "node:fs";
import path            from "node:path";
import type { PrismConfig }    from "./config/loader.js";
import { DEFAULT_MCP }         from "./config/loader.js";
import type { ParserRegistry } from "./parsers/registry.js";
import { createRegistry }      from "./parsers/index.js";
import { ParismEngine }        from "./facade/engine.js";
import { PACKAGE_VERSION }     from "./version.js";
import { PROJECTION_SHAPE, BUDGET_SHAPE } from "./engine/projection.js";
import { MAX_TASK_WAIT_MS }             from "./engine/tasks.js";
import { MAX_LEASE_MS }                 from "./engine/services.js";
import { isBuildProfile }               from "./engine/policy.js";
import type { ResponseEnvelope }        from "./types/envelope.js";
import type { RunOptions }              from "./facade/envelope.js";

export { PACKAGE_VERSION };

/**
 * 심볼릭 링크를 따라 실제 경로를 확정한다. 실패하면 절대 경로로 떨어진다.
 */
function resolveRealPath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * 결과 텍스트 맨 앞에 실제 작업 디렉터리를 밝히는 배너. 배너 뒤에 빈 줄 하나를 두고 JSON이 온다.
 * JSON은 들여쓰기 없이 한 줄로 쓴다. 들여쓰기 공백만으로 응답 토큰의 22~30%가 든다.
 */
export function withCwdBanner(cwd: string, payload: unknown): string {
  return `[cwd] ${resolveRealPath(cwd)}\n\n${JSON.stringify(payload)}`;
}

export const MCP_INSTRUCTIONS = `Parism runs shell commands without a shell and returns parsed JSON.

1. run({command: "ps aux | grep node | head -5"}) takes one command line. Quotes, globs, ~ and a leading "cd dir &&" work. Pipe stages grep, head, tail, wc, sort, uniq, cut run inside Parism: on parsed rows when possible, otherwise on text. Redirection, ;, &&, || and $(...) are refused with a suggestion.
2. Test runners, compilers and linters (vitest, jest, tsc, eslint, cargo, go test, pytest) return every failure with file and line, plus attribution: whether the failing line was changed in the working tree.
3. Large results return the first rows, a result_id and a _hint. Read the rest with query_result(result_id, where/select/sort_by/limit/aggregate) instead of running again.
4. On refusal, result.failure has kind, reason, message and often hint.args or suggestion: rerun as suggested. describe(cmd) lists allowed subcommands and flags; describe({command}) checks a command without running it.

Results start with "[cwd] <path>" and a blank line, then JSON. stdout.raw is left out when parsing succeeded; pass include_raw: true to get it. Long commands: mode "task"; servers: mode "service" with ready_pattern or ready_port, then run({task_id}) to read or cancel.`;

/** 실패를 MCP 도구 오류로 알릴지. 파싱 실패는 결과를 돌려준 것이므로 오류가 아니다. */
function isToolError(result: { ok?: boolean; failure?: { kind: string } }): boolean {
  return result.ok === false && result.failure !== undefined && result.failure.kind !== "parse";
}

/** 텍스트와 구조화 결과를 함께 돌려준다. 클라이언트가 구조화 결과를 읽지 못하면 텍스트를 쓴다. */
function reply(text: string, structured: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text" as const, text }],
    ...(structured !== null && typeof structured === "object" && !Array.isArray(structured) && { structuredContent: structured as Record<string, unknown> }),
    ...(isError && { isError: true }),
  };
}

function replyEnvelope(envelope: ResponseEnvelope, maxBytes?: number): CallToolResult {
  const fitted = maxBytes === undefined ? envelope : fitForClient(envelope, maxBytes);
  return reply(withCwdBanner(fitted.cwd, fitted), fitted, isToolError(fitted));
}

/** 앞에서부터 maxBytes(UTF-8) 안에 드는 완전한 줄까지 남긴다. 한 줄도 들지 않으면 빈 문자열이다. */
function headLines(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  if (maxBytes <= 0) return "";
  const partial = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  const end     = partial.lastIndexOf("\n");
  return end >= 0 ? partial.slice(0, end + 1) : "";
}

/** JSON 직렬화 크기(바이트) */
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * 응답이 클라이언트 상한을 넘으면 stdout.raw와 stderr.raw를 줄 경계에서 잘라 상한에 맞춘다.
 * 상한을 넘는 도구 결과는 클라이언트가 통째로 버리므로, 앞부분이라도 받게 하고 나머지는 options.page로 읽게 한다.
 * 리댁션과 영수증은 이미 끝난 뒤라 자르는 것은 전달 형태만 바꾼다.
 */
export function fitForClient(envelope: ResponseEnvelope, maxBytes: number): ResponseEnvelope {
  if (jsonBytes(envelope) <= maxBytes) return envelope;
  const stdoutBytes = Buffer.byteLength(envelope.stdout.raw, "utf8");
  if (stdoutBytes === 0 && envelope.stderr.raw === "") return envelope;
  const stderr = headLines(envelope.stderr.raw, 4096);
  /** 원문 한 바이트가 JSON에서 차지하는 비율로 남길 원문 크기를 정하고, 그래도 넘으면 조금씩 더 줄인다 */
  const ratio = jsonBytes(envelope.stdout.raw) / Math.max(1, stdoutBytes);
  let limit   = Math.floor((maxBytes - 2048) / ratio);
  let fitted  = envelope;
  for (let round = 0; round < 4; round++) {
    const stdout = headLines(envelope.stdout.raw, limit);
    const shown  = Buffer.byteLength(stdout, "utf8");
    fitted = {
      ...envelope,
      stdout: { ...envelope.stdout, raw: stdout },
      stderr: { ...envelope.stderr, raw: stderr },
      truncated: true,
      _hint: `stdout.raw shows the first ${shown} of ${envelope.truncated === true ? "more than " : ""}${stdoutBytes} bytes to fit the client's response limit (mcp.max_response_bytes ${maxBytes}). ` +
        "Read the rest with options: { page: 0, page_size: 200 } and the following pages, or narrow the command (head, grep, a path).",
    };
    const over = jsonBytes(fitted) - maxBytes;
    if (over <= 0) return fitted;
    limit -= Math.ceil(over / ratio) + 512;
  }
  return fitted;
}

/**
 * Guard 검사 → 실행 → JSON 직렬화까지의 파이프라인. 시험 코드가 쓴다.
 * @internal
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
  const result  = await engine.run(cmd, { args, cwd, format, includeDiff, include_raw: true });
  return JSON.stringify(result, null, 2);
}

/**
 * Guard 검사 → 실행 → 페이지 분할 → JSON 직렬화. parsed는 항상 null이다. 시험 코드가 쓴다.
 * @internal
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
  const engine = new ParismEngine(config, createRegistry());
  const result = await engine.runPaged(cmd, { args, cwd, page, page_size: pageSize, includeDiff });
  return JSON.stringify(result, null, 2);
}

/** MCP 태스크 확장 어댑터 모듈(src/mcp/task-extension.ts)의 모양 */
export type TaskExtensionModule = typeof import("./mcp/task-extension.js");

/**
 * 설정에서 태스크 확장을 켰을 때만 어댑터 모듈을 불러온다.
 * 꺼져 있으면 MCP SDK의 experimental 코드를 불러오지 않는다.
 */
export async function loadTaskExtension(config: PrismConfig): Promise<TaskExtensionModule | undefined> {
  return config.tasks?.mcp_extension === true ? import("./mcp/task-extension.js") : undefined;
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** run의 annotations. readonly 프로필은 조회 명령만 허용하므로 읽기 전용이다. 네트워크 명령(curl, ping)이 있어 open world다. */
function runAnnotations(config: PrismConfig): ToolAnnotations {
  const build = isBuildProfile(config.guard);
  return { readOnlyHint: !build, destructiveHint: build, idempotentHint: false, openWorldHint: true };
}

/** run과 run_task가 함께 받는 명령 입력 */
function commandShape() {
  return {
    command:     z.string().optional().describe("One command line, e.g. \"git log --oneline -5\" or \"ps aux | grep node\". Use this or cmd+args."),
    cmd:         z.string().optional().describe("Executable name when passing args separately"),
    args:        z.array(z.string()).optional().describe("Arguments for cmd, one per element"),
    cwd:         z.string().default(process.cwd()).describe("Working directory"),
    format:      z.enum(["json", "compact", "json-no-raw"]).default("json").describe("compact = columnar rows"),
    include_raw: z.boolean().optional().describe("Also return stdout.raw when parsing succeeded"),
    includeDiff: z.boolean().default(false).describe("Include filesystem diff (created/deleted/modified)"),
    select:      PROJECTION_SHAPE.select.describe("Keep only these fields per row"),
    where:       PROJECTION_SHAPE.where.describe("Row conditions [{field, op, value}]; op eq|ne|prefix|contains|gt|gte|lt|lte"),
    sort_by:     PROJECTION_SHAPE.sort_by.describe("{field, order: asc|desc}"),
    limit:       PROJECTION_SHAPE.limit.describe("Maximum rows; 0 returns only _summary"),
    array:       PROJECTION_SHAPE.array.describe("Which array to project when there are several"),
    aggregate:   PROJECTION_SHAPE.aggregate.describe("contract_version next: {group_by?, sum?, distinct?}"),
    budget:      BUDGET_SHAPE.optional().describe("Token budget for the response"),
    contract_version: z.enum(["stable", "next"]).default("stable").describe("'next' adds review, _origin, receipt"),
    evidence:    z.enum(["none", "rows", "fields"]).default("none").describe("next: field evidence for explain"),
    retain:      z.boolean().default(false).describe("next: keep the full result for query_result"),
    machine_format: z.boolean().default(false).describe("next: add machine-readable flags for test runners and linters"),
    attribution: z.boolean().optional().describe("false skips git-diff attribution of failures"),
  };
}

/** run 도구 하나로 태스크, 서비스, 페이지까지 다루는 입력(core 표면) */
function runShape() {
  return {
    ...commandShape(),
    mode:        z.enum(["wait", "task", "service"]).default("wait")
                 .describe("task: start and return task_id (needs contract_version next). service: start a server, wait for ready_pattern or ready_port, return task_id"),
    ready_pattern: z.string().optional().describe("service: regex on output that means ready"),
    ready_port:  z.number().int().min(1).max(65535).optional().describe("service: local port that means ready"),
    lease_ms:    z.number().int().min(1000).max(MAX_LEASE_MS).optional().describe(`service: stop after this many ms (max ${MAX_LEASE_MS})`),
    persist:     z.boolean().optional().describe("service: keep running after this server exits, until lease_ms (host must allow it)"),
    task_id:     z.string().optional().describe("Read a task or service started earlier instead of running a command"),
    wait_ms:     z.number().int().min(0).default(0).describe(`task_id: wait up to this long (capped at ${MAX_TASK_WAIT_MS}) for it to finish or report a new failure`),
    cancel:      z.boolean().optional().describe("task_id: stop it"),
    page:        z.number().int().min(0).optional().describe("Return raw stdout lines of this page (0-based) instead of parsing"),
    page_size:   z.number().int().min(1).optional().describe("page: lines per page"),
  };
}

type RunInput = z.infer<z.ZodObject<ReturnType<typeof runShape>>>;

/** 입력에서 run 옵션을 고른다. 정의되지 않은 키는 넣지 않는다. */
function runOptionsOf(input: Partial<RunInput>): RunOptions {
  const keys = ["command", "args", "cwd", "format", "include_raw", "includeDiff", "select", "where", "sort_by", "limit", "array",
    "aggregate", "budget", "contract_version", "evidence", "retain", "machine_format", "attribution"] as const;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined && !(key === "machine_format" && value === false)) out[key] = value;
  }
  return out as RunOptions;
}

/** core 표면의 where 조건. 정확한 형 검사는 엔진의 투영 문법(engine/projection.ts)이 한다. */
const LOOSE_WHERE = z.array(z.object({ field: z.string(), op: z.string(), value: z.unknown() }))
  .describe("[{field, op: eq|ne|prefix|contains|gt|gte|lt|lte, value}]");

/** core 표면 run의 고급 옵션. 하나의 객체로 받아 스키마를 짧게 두고, 받은 뒤 runShape로 검사한다. */
const RUN_OPTION_KEYS = [
  "format", "include_raw", "includeDiff", "array", "aggregate", "budget", "contract_version", "evidence", "retain",
  "machine_format", "attribution", "ready_pattern", "ready_port", "lease_ms", "persist", "page", "page_size",
] as const;

function coreRunShape() {
  return {
    command: z.string().optional().describe("Whole command line, e.g. \"git log --oneline -5\" or \"ps aux | grep node | head -5\""),
    cmd:     z.string().optional().describe("Executable, when passing args separately"),
    args:    z.array(z.string()).optional(),
    cwd:     z.string().optional().describe("Working directory"),
    select:  z.array(z.string()).optional().describe("Fields to keep per row"),
    where:   LOOSE_WHERE.optional(),
    sort_by: z.object({ field: z.string(), order: z.enum(["asc", "desc"]).optional() }).optional(),
    limit:   z.number().int().min(0).optional(),
    mode:    z.enum(["wait", "task", "service"]).optional().describe("task: long command, returns task_id. service: start a server and wait until ready"),
    task_id: z.string().optional().describe("Read (wait_ms) or stop (cancel) a task or service"),
    wait_ms: z.number().int().min(0).optional().describe(`Capped at ${MAX_TASK_WAIT_MS}`),
    cancel:  z.boolean().optional(),
    options: z.record(z.string(), z.unknown()).optional()
      .describe(`Advanced: ${RUN_OPTION_KEYS.join(", ")}. See describe().run_options`),
  };
}

function coreQueryShape() {
  return {
    result_id:    z.string(),
    select:       z.array(z.string()).optional(),
    where:        LOOSE_WHERE.optional(),
    sort_by:      z.object({ field: z.string(), order: z.enum(["asc", "desc"]).optional() }).optional(),
    limit:        z.number().int().min(0).optional(),
    aggregate:    z.object({ group_by: z.array(z.string()).optional(), sum: z.array(z.string()).optional(), distinct: z.array(z.string()).optional() }).optional(),
    pointer:      z.string().optional().describe("JSON Pointer: where did this value come from"),
    cursor:       z.string().optional().describe("continuation.cursor: next page"),
    compare_with: z.string().optional().describe("Another result_id: what changed"),
    options:      z.record(z.string(), z.unknown()).optional().describe("array, budget, keys, ignore_fields, strict"),
  };
}

/** core 표면 입력을 run 입력으로 펼치고 엄격한 스키마로 검사한다 */
function expandCoreRun(input: Record<string, unknown>): { ok: true; value: Partial<RunInput> } | { ok: false; message: string } {
  const { options, ...rest } = input as { options?: Record<string, unknown> } & Record<string, unknown>;
  const unknownKeys = Object.keys(options ?? {}).filter(k => !(RUN_OPTION_KEYS as readonly string[]).includes(k));
  if (unknownKeys.length > 0) return { ok: false, message: `unknown option(s): ${unknownKeys.join(", ")}; allowed: ${RUN_OPTION_KEYS.join(", ")}` };
  const parsed = z.object(runShape()).strict().safeParse({ ...rest, ...(options ?? {}) });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map(i => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
  }
  return { ok: true, value: parsed.data };
}

/**
 * MCP 서버를 만든다. mcp.surface가 core면 run, query_result, describe 세 도구를,
 * full이면 이전 판의 아홉 도구(run, task, query_result, compare_results, fetch_result, explain_result, run_paged, describe, dry_run)를 등록한다.
 */
export function createServer(config: PrismConfig, registry: ParserRegistry, taskExtension?: TaskExtensionModule): McpServer {
  const engine    = new ParismEngine(config, registry);
  const surface   = (config.mcp ?? DEFAULT_MCP).surface;
  const maxResponse = (config.mcp ?? DEFAULT_MCP).max_response_bytes ?? DEFAULT_MCP.max_response_bytes;
  /**
   * 태스크 확장은 tasks.mcp_extension이 켜져 있고 호출자가 어댑터 모듈을 넘겼을 때만 붙는다.
   * 어댑터는 MCP SDK의 experimental API를 쓰므로 필요할 때만 불러오게 호출자가 넘긴다(loadTaskExtension).
   */
  const extension = config.tasks?.mcp_extension === true && taskExtension
    ? { module: taskExtension, parts: taskExtension.createTaskExtensionParts(engine) }
    : undefined;

  const server = new McpServer(
    { name: "parism", version: PACKAGE_VERSION },
    {
      instructions: MCP_INSTRUCTIONS,
      ...(extension && {
        capabilities:     extension.module.TASK_CAPABILITIES,
        taskStore:        extension.parts.taskStore,
        taskMessageQueue: extension.parts.taskMessageQueue,
      }),
    },
  );

  if (extension) {
    extension.module.registerRunTask(server, engine, extension.parts.taskStore, commandShape(), envelope => withCwdBanner(envelope.cwd, envelope));
  }

  /** 태스크·서비스 조회 결과 */
  const taskReply = async (taskId: string, waitMs: number, cancel: boolean): Promise<CallToolResult> => {
    const lookup = cancel ? engine.taskCancel(taskId) : await engine.taskWait(taskId, waitMs);
    const body   = lookup.found ? { ok: true, task: lookup.task } : { ok: false, reason: lookup.reason, message: lookup.message };
    return reply(JSON.stringify(body), body, !lookup.found);
  };

  /** run 한 번. 태스크·서비스 시작과 페이지 읽기도 여기서 고른다. */
  const runTool = async (input: Partial<RunInput>): Promise<CallToolResult> => {
    if (input.task_id !== undefined) return taskReply(input.task_id, input.wait_ms ?? 0, input.cancel === true);
    const cmd  = input.cmd ?? "";
    const opts = runOptionsOf(input);
    if (input.command === undefined && cmd === "") {
      const body = { ok: false, failure: { kind: "config", reason: "missing_command", message: "give command (one string) or cmd" } };
      return reply(JSON.stringify(body), body, true);
    }
    if (input.page !== undefined) {
      return replyEnvelope(await engine.runPaged(cmd, { ...opts, page: input.page, ...(input.page_size !== undefined && { page_size: input.page_size }) }), maxResponse);
    }
    if (input.mode === "task" || input.mode === "service") {
      const started = input.mode === "task"
        ? engine.startTask(cmd, opts)
        : await engine.startService(cmd, {
            ...opts,
            ...(input.ready_pattern !== undefined && { ready_pattern: input.ready_pattern }),
            ...(input.ready_port !== undefined && { ready_port: input.ready_port }),
            ...(input.lease_ms !== undefined && { lease_ms: input.lease_ms }),
            ...(input.persist !== undefined && { persist: input.persist }),
          });
      if (!started.started) return replyEnvelope(started.envelope, maxResponse);
      return reply(withCwdBanner(started.task.cwd, { task: started.task }), { task: started.task });
    }
    return replyEnvelope(await engine.run(cmd, opts), maxResponse);
  };

  const runDescription =
    "Run a command without a shell and get parsed JSON. Pass the whole line as command (pipes to grep/head/tail/wc/sort/uniq/cut work). " +
    "Large results return a preview, result_id and _hint; continue with query_result. Commands pass an execution guard.";

  if (surface === "core") {
    server.registerTool("run", {
      description: `${runDescription} mode starts tasks and services; task_id reads or stops them.`,
      inputSchema: coreRunShape(),
      annotations: runAnnotations(config),
    }, async (input) => {
      const expanded = expandCoreRun(input as Record<string, unknown>);
      if (!expanded.ok) {
        const body = { ok: false, failure: { kind: "config", reason: "invalid_input", message: expanded.message } };
        return reply(JSON.stringify(body), body, true);
      }
      return runTool(expanded.value);
    });
  } else {
    server.registerTool("run", {
      description: `${runDescription} Also starts tasks and services (mode), reads or stops them (task_id), and pages raw output (page).`,
      inputSchema: runShape(),
      annotations: runAnnotations(config),
    }, runTool);
  }

  /** query_result: 보관 결과 재질의. core 표면(coreQueryShape)에서는 이어 읽기, 비교, 근거 설명도 맡는다. */
  const queryShape = {
    result_id:     z.string().describe("result_id from run"),
    select:        PROJECTION_SHAPE.select.describe("Keep only these fields per row"),
    where:         PROJECTION_SHAPE.where.describe("Row conditions, same operators as run"),
    sort_by:       PROJECTION_SHAPE.sort_by.describe("{field, order}"),
    limit:         PROJECTION_SHAPE.limit.describe("Maximum rows"),
    array:         PROJECTION_SHAPE.array.describe("Which array when there are several"),
    aggregate:     PROJECTION_SHAPE.aggregate.describe("{group_by?, sum?, distinct?}: one row per group with count"),
  };
  const queryInput = (surface === "core" ? coreQueryShape() : queryShape) as z.ZodRawShape;
  server.registerTool("query_result", {
    description: "Read a kept result again WITHOUT re-running the command: filter, sort, limit, pick fields or aggregate the full rows" +
      (surface === "core" ? "; or explain a value (pointer), read the next page (cursor), or compare with another result (compare_with)." : ".") +
      " An expired or unknown id is an error and is never re-executed.",
    inputSchema: queryInput,
    annotations: READ_ONLY,
  }, async (input: Record<string, unknown>) => {
    const { options, ...given } = input as Record<string, unknown> & { options?: Record<string, unknown> };
    const args = { ...given, ...(options ?? {}) } as Record<string, unknown> & { result_id: string };
    if (typeof args.pointer === "string") {
      const r = engine.explainResult(args.result_id, args.pointer);
      return reply(JSON.stringify(r), r, !r.ok);
    }
    if (typeof args.cursor === "string") {
      const r = engine.fetchResult(args.result_id, args.cursor, args.budget as { max_tokens: number; tokenizer?: string } | undefined);
      return reply(JSON.stringify(r), r, !r.ok);
    }
    if (typeof args.compare_with === "string") {
      const r = engine.compare(args.result_id, args.compare_with, {
        ...(args.keys !== undefined && { keys: args.keys as string[] }),
        ...(args.ignore_fields !== undefined && { ignore_fields: args.ignore_fields as string[] }),
        strict: args.strict === true,
      });
      return reply(JSON.stringify(r), r, !r.ok);
    }
    const query: Record<string, unknown> = {};
    for (const key of ["select", "where", "sort_by", "limit", "array", "aggregate"]) if (args[key] !== undefined) query[key] = args[key];
    const r = engine.queryResult(args.result_id, query);
    return reply(JSON.stringify(r), r, !r.ok);
  });

  server.registerTool("describe", {
    description: "Without arguments: allowed commands, parsers, guard, side effects, version. With cmd: that command's allowed subcommands, flags, parser formats, side effect and examples. " +
      "With command (or cmd+args): check whether it would pass the guard without running it.",
    inputSchema: {
      cmd:     z.string().optional().describe("Command name to describe, e.g. 'git'"),
      command: z.string().optional().describe("A full command line to check without running"),
      args:    z.array(z.string()).optional().describe("With cmd: arguments to check without running"),
      cwd:     z.string().default(process.cwd()).describe("Working directory for the check"),
    },
    annotations: READ_ONLY,
  }, async ({ cmd, command, args, cwd }) => {
    if (command !== undefined || args !== undefined) {
      const r = engine.dryRun(cmd ?? "", args ?? [], cwd, command);
      return reply(JSON.stringify(r), r);
    }
    /** 허용되지 않은 명령의 설명은 도구 오류가 아니라 그 사실을 담은 결과다. */
    const r = cmd === undefined ? engine.describe() : engine.describe(cmd);
    return reply(JSON.stringify(r), r);
  });

  if (surface === "full") registerLegacyTools(server, engine, config);
  return server;
}

/** full 표면에만 있는 이전 판의 도구 */
function registerLegacyTools(server: McpServer, engine: ParismEngine, config: PrismConfig): void {
  server.registerTool("task", {
    description: "Read or cancel a task or service started by run(mode='task' or 'service'). Pass wait_ms with status instead of polling.",
    inputSchema: {
      task_id: z.string().describe("task_id from run"),
      action:  z.enum(["status", "cancel"]).default("status").describe("'status' reads it, 'cancel' stops it"),
      wait_ms: z.number().int().min(0).default(0).describe(`status: wait up to this long (capped at ${MAX_TASK_WAIT_MS})`),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ task_id, action, wait_ms }) => {
    const lookup = action === "cancel" ? engine.taskCancel(task_id) : await engine.taskWait(task_id, wait_ms);
    const body   = lookup.found ? { ok: true, task: lookup.task } : { ok: false, reason: lookup.reason, message: lookup.message };
    return reply(JSON.stringify(body), body, !lookup.found);
  });

  server.registerTool("compare_results", {
    description: "Compare two kept results and show what changed. Never runs a command. Refuses incomparable results instead of guessing.",
    inputSchema: {
      base_id:       z.string().describe("Earlier result_id"),
      current_id:    z.string().describe("Later result_id"),
      keys:          z.array(z.string()).optional().describe("Row identity fields"),
      ignore_fields: z.array(z.string()).optional().describe("Fields to leave out"),
      strict:        z.boolean().default(false).describe("Refuse weak guarantees"),
    },
    annotations: READ_ONLY,
  }, async ({ base_id, current_id, keys, ignore_fields, strict }) => {
    const r = engine.compare(base_id, current_id, { ...(keys && { keys }), ...(ignore_fields && { ignore_fields }), strict });
    return reply(JSON.stringify(r), r, !r.ok);
  });

  server.registerTool("fetch_result", {
    description: "Next page of a budgeted result WITHOUT re-running. Use continuation.cursor from run.",
    inputSchema: {
      result_id: z.string().describe("Result id"),
      cursor:    z.string().describe("continuation.cursor"),
      budget:    BUDGET_SHAPE.optional().describe("Budget for this page"),
    },
    annotations: READ_ONLY,
  }, async ({ result_id, cursor, budget }) => {
    const r = engine.fetchResult(result_id, cursor, budget);
    return reply(JSON.stringify(r), r, !r.ok);
  });

  server.registerTool("explain_result", {
    description: "Show where a value in a kept result came from: the byte span in the masked output. Never re-executes.",
    inputSchema: {
      result_id: z.string().describe("Result id"),
      pointer:   z.string().default("").describe("JSON Pointer, e.g. '/processes/0/pid'"),
    },
    annotations: READ_ONLY,
  }, async ({ result_id, pointer }) => {
    const r = engine.explainResult(result_id, pointer);
    return reply(JSON.stringify(r), r, !r.ok);
  });

  server.registerTool("run_paged", {
    description: "Run a command and return raw stdout lines page by page. parsed is always null.",
    inputSchema: {
      command:     z.string().optional().describe("One command line"),
      cmd:         z.string().optional().describe("Command name"),
      args:        z.array(z.string()).default([]).describe("Arguments"),
      cwd:         z.string().default(process.cwd()).describe("Working directory"),
      page:        z.number().int().min(0).default(0).describe("Page index (0-based)"),
      page_size:   z.number().int().min(1).default(config.guard.default_page_size).describe("Lines per page"),
      includeDiff: z.boolean().default(false).describe("Include filesystem diff"),
    },
    annotations: runAnnotations(config),
  }, async ({ command, cmd, args, cwd, page, page_size, includeDiff }) => {
    return replyEnvelope(await engine.runPaged(cmd ?? "", { ...(command !== undefined && { command }), args, cwd, page, page_size, includeDiff }));
  });

  server.registerTool("dry_run", {
    description: "Check whether a command would pass the guard WITHOUT running it.",
    inputSchema: {
      command: z.string().optional().describe("One command line"),
      cmd:     z.string().optional().describe("Command name"),
      args:    z.array(z.string()).default([]).describe("Arguments"),
      cwd:     z.string().default(process.cwd()).describe("Working directory"),
    },
    annotations: READ_ONLY,
  }, async ({ command, cmd, args, cwd }) => {
    const r = engine.dryRun(cmd ?? "", args, cwd, command);
    return reply(JSON.stringify(r), r);
  });
}
