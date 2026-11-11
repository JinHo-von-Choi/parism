/**
 * contract_version: "next"에서 동작하는 엔진 기능 시험:
 * 기계용 형식 인자, 보고서 파일 읽기, 출처 분류, 재질의, 태스크, 영수증.
 *
 * 러너는 PATH 앞에 둔 가짜 실행 파일로 대신한다. 러너의 실제 출력 형식은 parsers/devloop.test.ts가 본다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-11
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync }                    from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir }                          from "node:os";
import path                                from "node:path";
import { ParismEngine }                    from "../../src/facade/engine.js";
import { DEFAULT_CONFIG, type PrismConfig } from "../../src/config/loader.js";
import { createRegistry }                  from "../../src/parsers/index.js";
import type { Receipt }                    from "../../src/engine/receipts.js";

const FIXTURES = path.join(import.meta.dirname, "..", "parsers", "devloop-fixtures");

let work:     string;
let bin:      string;
let home:     string;
let savedPath: string | undefined;
let savedHome: string | undefined;

/** PATH 앞에 둘 가짜 실행 파일을 만든다. */
function fakeBinary(name: string, script: string): void {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
}

function engineFor(patch: (c: PrismConfig) => void = () => {}): ParismEngine {
  const config = structuredClone(DEFAULT_CONFIG);
  config.guard.allowed_paths = [work];
  config.guard.allowed_commands.push("tsc", "vitest", "eslint", "sleep");
  patch(config);
  return new ParismEngine(config, createRegistry());
}

const NEXT = { contract_version: "next" as const };

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "parism-next-"));
  bin  = mkdtempSync(path.join(tmpdir(), "parism-bin-"));
  home = mkdtempSync(path.join(tmpdir(), "parism-home-"));
  mkdirSync(path.join(work, "src"));
  for (let i = 0; i < 8; i++) writeFileSync(path.join(work, "src", `f${i}.txt`), "x".repeat(i + 1));

  /** tsc: --pretty false로 불렸을 때만 진단을 내고 종료 코드 2로 끝난다. */
  fakeBinary("tsc", `case "$*" in *"--pretty false"*) printf '%s\\n' "${work}/src/a.ts(2,7): error TS2322: Type 'string' is not assignable to type 'number'." "${work}/src/b.ts(1,22): error TS2307: Cannot find module './missing.js'."; exit 2;; *) echo "pretty output"; exit 2;; esac`);
  /** vitest: --outputFile로 받은 경로에 보고서를 쓰고, 표준 출력에는 안내 문구만 낸다. */
  fakeBinary("vitest", `for a in "$@"; do case "$a" in --outputFile=*) cp "${FIXTURES}/vitest-failing.txt" "\${a#--outputFile=}";; esac; done; echo "JSON report written to somewhere"; exit 1`);
  /** eslint: 아무것도 출력하지 않고 실패한다(러너를 띄우지 못한 경우). */
  fakeBinary("eslint", `echo "config not found" >&2; exit 2`);

  savedPath = process.env.PATH;
  savedHome = process.env.PARISM_HOME;
  process.env.PATH        = `${bin}${path.delimiter}${savedPath ?? ""}`;
  process.env.PARISM_HOME = home;
});

afterAll(() => {
  process.env.PATH = savedPath;
  if (savedHome === undefined) delete process.env.PARISM_HOME;
  else process.env.PARISM_HOME = savedHome;
});

describe("machine_format", () => {
  it("기본 계약에서는 거절하고 명령을 실행하지 않는다", async () => {
    const result = await engineFor().run("tsc", { args: ["--noEmit"], cwd: work, machine_format: true });
    expect(result.failure).toMatchObject({ kind: "config", reason: "requires_contract_next" });
    expect(result.exitCode).toBe(-1);
  });

  it("형식 인자를 덧붙여 실행하고, 응답의 args에 실행한 인자를 싣는다", async () => {
    const result = await engineFor().run("tsc", { ...NEXT, args: ["--noEmit"], cwd: work, machine_format: true });

    expect(result.args).toEqual(["--noEmit", "--pretty", "false"]);
    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe("non_zero_exit");
    expect(result.stdout.parsed).toMatchObject({ kind: "diagnostics", tool: "tsc", errors: 2, files: 2 });
  });

  it("작업 디렉터리 접두사를 빼고, 파싱에 성공하면 원문을 싣지 않는다", async () => {
    const result = await engineFor().run("tsc", { ...NEXT, args: ["--noEmit"], cwd: work, machine_format: true });
    const parsed = result.stdout.parsed as { diagnostics: { file: string }[] };

    expect(parsed.diagnostics.map(d => d.file)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.stdout.raw).toBe("");
  });

  it("machine_format 없이 다른 형식으로 실행하면 바꿀 인자를 안내한다", async () => {
    const result = await engineFor().run("tsc", { ...NEXT, args: ["--noEmit", "--pretty"], cwd: work });
    expect(result.stdout.parsed).toBeNull();
    expect(result.stdout.parse_error?.reason).toBe("unsupported_format");
    expect(result.stdout.raw).toContain("pretty output");
  });

  it("보고서를 파일로 쓰는 러너는 임시 파일로 받아 읽고, 끝나면 그 파일을 지운다", async () => {
    const before = readdirSync(tmpdir()).filter(n => n.startsWith("parism-report-"));
    const result = await engineFor().run("vitest", { ...NEXT, args: ["run"], cwd: work, machine_format: true });

    expect(result.args).toEqual(["run", "--reporter=json"]);
    expect(result.stdout.parsed).toMatchObject({ kind: "test", passed: 2, failed: 2, files_failed: 1 });
    expect((result.stdout.parsed as { failures: unknown[] }).failures).toHaveLength(3);
    expect(readdirSync(tmpdir()).filter(n => n.startsWith("parism-report-"))).toEqual(before);
  });

  it("러너가 실패했는데 읽을 출력이 없으면 결과를 만들지 않는다", async () => {
    const result = await engineFor().run("eslint", { ...NEXT, args: ["src"], cwd: work, machine_format: true });
    expect(result.ok).toBe(false);
    expect(result.stdout.parsed).toBeNull();
    expect(result.failure?.reason).toBe("non_zero_exit");
  });

  it("max_output_bytes보다 큰 보고서도 전체를 읽어 파싱한다", async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `src/f${i}.ts(1,1): error TS2322: ${"long message ".repeat(8)}`);
    writeFileSync(path.join(work, "many.txt"), lines.join("\n") + "\n");
    fakeBinary("tsc", `cat "${work}/many.txt"; exit 2`);
    try {
      const result = await engineFor(c => { c.guard.max_output_bytes = 2048; c.guard.max_items = 5; })
        .run("tsc", { ...NEXT, args: ["--noEmit"], cwd: work, machine_format: true });
      const parsed = result.stdout.parsed as { errors: number; diagnostics: unknown[]; diagnostics_omitted: number };

      expect(parsed.errors).toBe(400);
      expect(parsed.diagnostics).toHaveLength(5);
      expect(parsed.diagnostics_omitted).toBe(395);
      expect(result.truncated).toBeUndefined();
    } finally {
      fakeBinary("tsc", `printf '%s\\n' "${work}/src/a.ts(2,7): error TS2322: bad."; exit 2`);
    }
  });
});

describe("진단의 근거 조회", () => {
  it("진단의 메시지, 코드, 줄 번호가 원문 어느 구간에서 왔는지 돌려준다", async () => {
    const engine = engineFor();
    const result = await engine.run("tsc", { ...NEXT, args: ["--noEmit"], cwd: work, machine_format: true, evidence: "fields", retain: true });
    const id     = result.review!.result_id;

    const message = engine.explainResult(id, "/diagnostics/0/message");
    expect(message).toMatchObject({ ok: true, source_kind: "verbatim", value: "bad." });
    expect(message.ok && message.quoted).toEqual(["bad."]);

    const code = engine.explainResult(id, "/diagnostics/0/code");
    expect(code.ok && code.quoted).toEqual(["TS2322"]);

    const line = engine.explainResult(id, "/diagnostics/0/line");
    expect(line).toMatchObject({ ok: true, source_kind: "derived", value: 2 });
    expect(line.ok && line.quoted).toEqual(["2"]);
  });

  it("작업 디렉터리 접두사를 뺀 경로처럼 원문과 글자가 다른 값은 근거 없음으로 둔다", async () => {
    const engine = engineFor();
    const result = await engine.run("tsc", { ...NEXT, args: ["--noEmit"], cwd: work, machine_format: true, evidence: "fields", retain: true });
    const file   = engine.explainResult(result.review!.result_id, "/diagnostics/0/file");
    expect(file).toMatchObject({ ok: true, value: "src/a.ts", source_kind: "none" });
  });
});

describe("_origin", () => {
  it("새 계약에서 분류표가 있는 파서의 결과에 external과 fixed 필드 목록을 싣는다", async () => {
    const result = await engineFor().run("tsc", { ...NEXT, args: ["--noEmit"], cwd: work, machine_format: true });
    expect(result._origin?.external).toContain("diagnostics[].message");
    expect(result._origin?.fixed).toContain("errors");
  });

  it("기본 계약의 응답과 파싱 결과가 없는 응답에는 싣지 않는다", async () => {
    const engine = engineFor();
    expect((await engine.run("tsc", { args: ["--noEmit", "--pretty", "false"], cwd: work }))._origin).toBeUndefined();
    expect((await engine.run("ls", { args: ["-l", work], cwd: work }))._origin).toBeUndefined();
    expect((await engine.run("echo", { ...NEXT, args: ["hi"], cwd: work }))._origin).toBeUndefined();
  });

  it("분류표가 없는 파서의 결과는 값의 형으로 분류하고 그 사실을 밝힌다", async () => {
    const engine = engineFor();
    const env    = await engine.run("env", { ...NEXT, args: [], cwd: work });
    expect(env._origin).toEqual({ external: ["vars.*"], fixed: [], basis: "value_types" });

    const tabled = await engine.run("ls", { ...NEXT, args: ["-l", path.join(work, "src")], cwd: work });
    expect(tabled._origin?.basis).toBe("table");
  });

  it("내장 파서의 결과에도 싣고, 이름과 권한 문자열은 external로 분류한다", async () => {
    const result = await engineFor().run("ls", { ...NEXT, args: ["-l", path.join(work, "src")], cwd: work });
    expect(result.failure).toBeUndefined();
    expect(result._origin?.external).toEqual(expect.arrayContaining(["entries[].name", "entries[].permissions", "entries[].owner"]));
    expect(result._origin?.fixed).toEqual(expect.arrayContaining(["entries[].size_bytes", "entries[].type"]));
  });
});

describe("queryResult()", () => {
  it("보관된 결과에 처음과 다른 조건을 걸어 돌려준다", async () => {
    const engine = engineFor();
    const first  = await engine.run("ls", { ...NEXT, args: ["-l", path.join(work, "src")], cwd: work, retain: true, select: ["name"], limit: 2 });
    const id     = first.review!.result_id;
    expect((first.stdout.parsed as { entries: unknown[] }).entries).toHaveLength(2);

    const query = engine.queryResult(id, { where: [{ field: "size_bytes", op: "gte", value: 7 }], select: ["name", "size_bytes"], sort_by: { field: "size_bytes", order: "desc" } });
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect((query.value as { entries: unknown[] }).entries).toEqual([{ name: "f7.txt", size_bytes: 8 }, { name: "f6.txt", size_bytes: 7 }]);
    expect(query.source_complete).toBe(true);
  });

  it("조건 없이 부르면 프로젝션 전의 전체 결과다", async () => {
    const engine = engineFor();
    const first  = await engine.run("ls", { ...NEXT, args: ["-l", path.join(work, "src")], cwd: work, retain: true, limit: 1 });
    const query  = engine.queryResult(first.review!.result_id, {});
    expect(query.ok && (query.value as { entries: unknown[] }).entries).toHaveLength(8);
  });

  it("프로젝션 없이 보관한 결과는 항목 수 상한에서 잘렸을 수 있음을 알린다", async () => {
    const engine = engineFor();
    const first  = await engine.run("ls", { ...NEXT, args: ["-l", path.join(work, "src")], cwd: work, retain: true });
    const query  = engine.queryResult(first.review!.result_id, { limit: 3 });
    expect(query.ok && query.source_complete).toBe(false);
  });

  it("보관하지 않은 결과, 모르는 id, 잘못된 조건은 이유와 함께 거절한다", async () => {
    const engine = engineFor();
    const first  = await engine.run("ls", { ...NEXT, args: ["-l", work], cwd: work });
    expect(engine.queryResult(first.review!.result_id, {})).toMatchObject({ ok: false, reason: "not_retained" });
    expect(engine.queryResult("r_unknown", {})).toMatchObject({ ok: false, reason: "unknown_id" });

    const kept = await engine.run("ls", { ...NEXT, args: ["-l", work], cwd: work, retain: true });
    const bad  = engine.queryResult(kept.review!.result_id, { where: [{ field: "size_bytes", op: "nope", value: 1 }] });
    expect(bad.ok).toBe(false);
  });

  it("돌려준 행의 원래 위치를 포인터로 주고, 그 포인터로 근거를 조회할 수 있다", async () => {
    const engine = engineFor();
    const first  = await engine.run("ps", { ...NEXT, args: ["aux"], cwd: work, retain: true, evidence: "fields", format: "json" });
    const id     = first.review!.result_id;
    const query  = engine.queryResult(id, { sort_by: { field: "pid", order: "desc" }, limit: 2, select: ["pid"] });

    expect(query.ok).toBe(true);
    if (!query.ok) return;
    const rows = (query.value as { processes: { pid: number }[] }).processes;
    expect(query.row_pointers).toHaveLength(2);
    expect(query.row_pointers![0]).toMatch(/^\/processes\/\d+$/);

    const explained = engine.explainResult(id, `${query.row_pointers![0]}/pid`);
    expect(explained).toMatchObject({ ok: true, value: rows[0]!.pid });
    expect(explained.ok && explained.source_spans.length).toBeGreaterThan(0);
  });

  it("처음 실행에 프로젝션이 있었거나 집계한 결과에는 포인터를 주지 않는다", async () => {
    const engine    = engineFor();
    const projected = await engine.run("ls", { ...NEXT, args: ["-l", path.join(work, "src")], cwd: work, retain: true, limit: 1 });
    const again     = engine.queryResult(projected.review!.result_id, { limit: 2 });
    expect(again.ok && again.row_pointers).toBeUndefined();

    const plain  = await engine.run("ls", { ...NEXT, args: ["-l", path.join(work, "src")], cwd: work, retain: true });
    expect(engine.queryResult(plain.review!.result_id, { limit: 2 })).toMatchObject({ ok: true, row_pointers: ["/entries/0", "/entries/1"] });
    const grouped = engine.queryResult(plain.review!.result_id, { aggregate: { group_by: ["type"] } });
    expect(grouped.ok && grouped.row_pointers).toBeUndefined();
  });

  it("보관된 결과를 묶어 집계한다", async () => {
    const engine = engineFor();
    const first  = await engine.run("ls", { ...NEXT, args: ["-l", path.join(work, "src")], cwd: work, retain: true, limit: 1 });
    const query  = engine.queryResult(first.review!.result_id, { aggregate: { group_by: ["type"], sum: ["size_bytes"] } });

    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect((query.value as { entries: unknown[] }).entries).toEqual([{ type: "file", count: 8, sum_size_bytes: 36 }]);
  });

  it("run의 집계는 새 계약에서만 받는다", async () => {
    const engine  = engineFor();
    const refused = await engine.run("ls", { args: ["-l", path.join(work, "src")], cwd: work, aggregate: { group_by: ["type"] } });
    expect(refused.failure?.reason).toBe("requires_contract_next");

    const result = await engine.run("ls", { ...NEXT, args: ["-l", path.join(work, "src")], cwd: work, aggregate: { group_by: ["type"] } });
    const parsed = result.stdout.parsed as { entries: unknown[]; _summary: unknown };
    expect(parsed.entries).toEqual([{ type: "file", count: 8 }]);
    expect(parsed._summary).toEqual({ total: 8, matched: 8, shown: 1, groups: 1 });
  });

  it("보관 한도를 설정으로 바꿀 수 있다", async () => {
    const engine = engineFor(c => { c.results = { max_entries: 1, ttl_ms: 60_000 }; });
    const first  = await engine.run("ls", { ...NEXT, args: ["-l", work], cwd: work, retain: true });
    const second = await engine.run("ls", { ...NEXT, args: ["-l", work], cwd: work, retain: true });
    expect(engine.queryResult(first.review!.result_id, {})).toMatchObject({ ok: false, reason: "evicted" });
    expect(engine.queryResult(second.review!.result_id, {}).ok).toBe(true);
  });
});

describe("startTask()", () => {
  const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

  it("기본 계약에서는 시작하지 않는다", () => {
    const started = engineFor().startTask("sleep", { args: ["1"], cwd: work });
    expect(started.started).toBe(false);
    expect(!started.started && started.envelope.failure?.reason).toBe("requires_contract_next");
  });

  it("가드가 막는 명령은 시작하지 않는다", () => {
    const started = engineFor().startTask("rm", { ...NEXT, args: ["-rf", work], cwd: work });
    expect(!started.started && started.envelope.failure?.kind).toBe("guard");
  });

  it("바로 식별자를 돌려주고, 끝나면 run과 같은 결과를 싣는다", async () => {
    const engine  = engineFor();
    const started = engine.startTask("tsc", { ...NEXT, args: ["--noEmit"], cwd: work, machine_format: true });
    if (!started.started) throw new Error("task did not start");
    expect(started.task.state).toBe("running");

    let status = engine.taskStatus(started.task.task_id);
    for (let i = 0; i < 50 && status.found && status.task.state === "running"; i++) {
      await wait(50);
      status = engine.taskStatus(started.task.task_id);
    }
    expect(status.found && status.task.state).toBe("completed");
    expect(status.found && status.task.result?.stdout.parsed).toMatchObject({ kind: "diagnostics", errors: 1 });
  });

  it("일반 시간 제한보다 오래 걸리는 명령을 태스크 시간 제한으로 실행한다", async () => {
    const engine  = engineFor(c => { c.guard.timeout_ms = 100; c.tasks = { max_concurrency: 1, timeout_ms: 5000 }; });
    const started = engine.startTask("sleep", { ...NEXT, args: ["0.5"], cwd: work });
    if (!started.started) throw new Error("task did not start");

    await wait(900);
    const status = engine.taskStatus(started.task.task_id);
    expect(status.found && status.task.state).toBe("completed");
    expect(status.found && status.task.result?.ok).toBe(true);
  });

  it("태스크 시간 제한을 넘으면 timeout으로 끝난다", async () => {
    const engine  = engineFor(c => { c.tasks = { max_concurrency: 1, timeout_ms: 200 }; });
    const started = engine.startTask("sleep", { ...NEXT, args: ["5"], cwd: work });
    if (!started.started) throw new Error("task did not start");

    await wait(800);
    const status = engine.taskStatus(started.task.task_id);
    expect(status.found && status.task.result?.failure?.reason).toBe("timeout");
  });

  it("슬롯이 차면 거절하고, 그동안 일반 run은 그대로 실행된다. 취소하면 그 태스크만 끝난다", async () => {
    const engine = engineFor(c => { c.tasks = { max_concurrency: 1, timeout_ms: 60_000 }; });
    const first  = engine.startTask("sleep", { ...NEXT, args: ["30"], cwd: work });
    if (!first.started) throw new Error("task did not start");

    const second = engine.startTask("sleep", { ...NEXT, args: ["30"], cwd: work });
    expect(!second.started && second.envelope.failure?.reason).toBe("task_slots_full");

    const normal = await engine.run("ls", { args: ["-l", work], cwd: work });
    expect(normal.ok).toBe(true);

    engine.taskCancel(first.task.task_id);
    await wait(600);
    const status = engine.taskStatus(first.task.task_id);
    expect(status.found && status.task.state).toBe("cancelled");
    expect(status.found && status.task.elapsed_ms).toBeLessThan(5000);
    expect(engine.startTask("sleep", { ...NEXT, args: ["0.1"], cwd: work }).started).toBe(true);
  });
});

describe("영수증", () => {
  const receiptFile = (): string => path.join(home, "receipts", "receipts.jsonl");
  const onDisk      = (): Receipt[] => existsSync(receiptFile())
    ? readFileSync(receiptFile(), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as Receipt) : [];

  it("켜지 않으면 응답에도 디스크에도 남기지 않는다", async () => {
    const result = await engineFor().run("ls", { ...NEXT, args: ["-l", work], cwd: work });
    expect(result.receipt).toBeUndefined();
    expect(onDisk()).toEqual([]);
  });

  it("켜면 새 계약 응답에 싣고, 같은 내용을 디스크에 남긴다", async () => {
    const engine = engineFor(c => { c.receipts = { ...c.receipts!, enabled: true }; });
    const result = await engine.run("tsc", { ...NEXT, args: ["--noEmit"], cwd: work, machine_format: true });

    expect(result.receipt).toMatchObject({
      cmd: "tsc", args: ["--noEmit", "--pretty", "false"], args_requested: ["--noEmit"],
      exit_code: 2, summary: { kind: "diagnostics", errors: 1, warnings: 0 },
    });
    expect(result.receipt?.output_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(onDisk().at(-1)).toEqual(result.receipt);
  });

  it("기본 계약에서는 응답에 싣지 않고 디스크에만 남긴다", async () => {
    const engine = engineFor(c => { c.receipts = { ...c.receipts!, enabled: true }; });
    const before = onDisk().length;
    const result = await engine.run("ls", { args: ["-l", work], cwd: work });

    expect(result.receipt).toBeUndefined();
    expect(onDisk()).toHaveLength(before + 1);
    expect(onDisk().at(-1)).toMatchObject({ cmd: "ls", exit_code: 0 });
    expect(onDisk().at(-1)?.summary).toBeUndefined();
  });

  it("git 저장소 안에서는 작업 공간 상태를 싣고, 가드가 막은 호출에는 영수증을 만들지 않는다", async () => {
    execFileSync("git", ["init", "-q"], { cwd: work, stdio: "ignore" });
    const engine = engineFor(c => { c.receipts = { ...c.receipts!, enabled: true }; });
    const result = await engine.run("ls", { ...NEXT, args: ["-l", work], cwd: work });
    expect(result.receipt?.workspace?.state_digest).toMatch(/^[0-9a-f]{64}$/);

    const before  = onDisk().length;
    const blocked = await engine.run("rm", { ...NEXT, args: ["-rf", work], cwd: work });
    expect(blocked.failure?.kind).toBe("guard");
    expect(onDisk()).toHaveLength(before);
  });

  it("실행 실패 사유를 남긴다", async () => {
    const engine = engineFor(c => { c.receipts = { ...c.receipts!, enabled: true }; c.guard.timeout_ms = 100; });
    const result = await engine.run("sleep", { ...NEXT, args: ["5"], cwd: work });
    expect(result.receipt).toMatchObject({ failure_reason: "timeout" });
    expect(result.receipt?.exit_code).not.toBe(0);
  });
});
