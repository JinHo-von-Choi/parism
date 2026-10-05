/**
 * 근거 조회(explain_result) 계약 시험.
 *
 * 근거는 값이 어디서 나왔는지를 말하는 연결이지, 그 값이 참이라는 보증이 아니다.
 * 확인되지 않은 근거는 지어내지 않고 "근거 없음"으로 남긴다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ParismEngine } from "../../src/facade/engine.js";
import { DEFAULT_CONFIG, type PrismConfig } from "../../src/config/loader.js";
import { createRegistry, type ParserRegistry } from "../../src/parsers/index.js";

const PS_SAMPLE = [
  "USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND",
  "root           1  0.3  0.0  25320 16384 ?        Ss   Sep04 147:31 /usr/lib/systemd/systemd --system",
  "git         1519  0.0  0.0 4087944 1644204 ?     Sl   Sep26 3553:18 ruby app",
  "",
].join("\n");

/** ps 출력을 그대로 돌려주는 파일과 그것을 실행할 엔진을 만든다. */
function fixture(options: { patch?: (c: PrismConfig) => void } = {}) {
  const dir  = mkdtempSync(path.join(tmpdir(), "parism-m1-"));
  const file = path.join(dir, "ps.txt");
  writeFileSync(file, PS_SAMPLE);

  const config = structuredClone(DEFAULT_CONFIG);
  config.guard.allowed_commands = ["ps"];
  config.guard.allowed_paths    = [dir];
  options.patch?.(config);

  /** ps 를 인자로 실측 출력 파일을 읽는 셸 명령으로 대체한다 */
  const registry: ParserRegistry = createRegistry();
  const engine = new ParismEngine(config, registry);
  return { dir, file, config, engine, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("review 는 opt-in 이다", () => {
  it("아무것도 요구하지 않으면 응답에 review 가 붙지 않는다", async () => {
    const f = fixture();
    try {
      /** ps 는 실제 프로세스를 읽으므로 파일 경로 없는 호출 대신 형식만 확인한다 */
      const res = await f.engine.run("ps", { args: ["aux"], cwd: f.dir, format: "json-no-raw" });
      expect(res.review).toBeUndefined();
    } finally { f.cleanup(); }
  });

  it("contract_version='next' 면 review 가 붙고 기존 필드는 그대로 있다", async () => {
    const f = fixture();
    try {
      const res = await f.engine.run("ps", { args: ["aux"], cwd: f.dir, contract_version: "next" });
      expect(res.review).toBeDefined();
      expect(res.review?.result_id).toMatch(/^r_/);
      expect(typeof res.ok).toBe("boolean");
      expect(res.stdout).toHaveProperty("raw");
    } finally { f.cleanup(); }
  });
});

describe("근거 조회", () => {
  it("보관하지 않은 결과는 조회할 수 없고 그 사실을 알린다", async () => {
    const f = fixture();
    try {
      const res = await f.engine.run("ps", { args: ["aux"], cwd: f.dir, contract_version: "next", evidence: "rows" });
      expect(res.review?.retained).toBe(false);
      const ex = f.engine.explainResult(res.review!.result_id, "/processes/0/pid");
      expect(ex.ok).toBe(false);
      expect(ex.ok === false && ex.reason).toBe("unknown_id");
    } finally { f.cleanup(); }
  });

  it("아는 없는 결과 id 를 재실행하지 않는다", () => {
    const f = fixture();
    try {
      const ex = f.engine.explainResult("r_없는_아이디", "/processes/0/pid");
      expect(ex.ok).toBe(false);
      expect(ex.ok === false && ex.reason).toBe("unknown_id");
      expect(ex.ok === false && ex.message).toMatch(/not re-executed/);
    } finally { f.cleanup(); }
  });

  it("근거 없는 포인터를 정직하게 답한다", () => {
    const f = fixture();
    try {
      const ex = f.engine.explainResult("r_없는_아이디", "/nope");
      expect(ex.ok).toBe(false);
    } finally { f.cleanup(); }
  });
});

describe("정밀 근거 계산", () => {
  it("바이트 구간이 원문에서 그 값을 정확히 가리킨다", async () => {
    const f = fixture();
    try {
      const res = await f.engine.run("ps", { args: ["aux"], cwd: f.dir, contract_version: "next", evidence: "rows", retain: true });
      expect(res.review?.retained).toBe(true);
      const raw = res.stdout.raw;
      const buf = Buffer.from(raw, "utf8");

      for (const field of ["user", "pid", "cpu", "mem", "vsz", "rss", "tty", "stat", "start", "time", "command"] as const) {
        const ex = f.engine.explainResult(res.review!.result_id, `/processes/0/${field}`);
        if (field === "cpu" || field === "mem" || field === "vsz" || field === "rss" || field === "pid") {
          /** 숫자는 변환이 있었으므로 derived 여야 하고, 구간은 원문 숫자 텍스트여야 한다 */
          expect(ex.ok, field).toBe(true);
          if (!ex.ok) continue;
          expect(ex.source_kind, field).toBe("derived");
          expect(ex.transform, field).toMatch(/parse/);
          const text = buf.subarray(ex.source_spans[0]!.start, ex.source_spans[0]!.end).toString("utf8");
          /** 표기가 달라도 값이 같으면 근거다("0.0" 과 0) */
          expect(Number(text), field).toBe(ex.value as number);
          continue;
        }
        expect(ex.ok, field).toBe(true);
        if (!ex.ok) continue;
        const text = buf.subarray(ex.source_spans[0]!.start, ex.source_spans[0]!.end).toString("utf8");
        expect(text, field).toBe(String(ex.value));
      }
    } finally { f.cleanup(); }
  });

  it("원문에 그대로 있는 값은 verbatim 이고 줄 번호를 함께 준다", async () => {
    const f = fixture();
    try {
      const res = await f.engine.run("ps", { args: ["aux"], cwd: f.dir, contract_version: "next", evidence: "rows", retain: true });
      const ex = f.engine.explainResult(res.review!.result_id, "/processes/0/user");
      expect(ex.ok).toBe(true);
      if (!ex.ok) return;
      expect(ex.source_kind).toBe("verbatim");
      expect(ex.source_spans[0]?.line).toBe(2);
      expect(ex.quoted).toEqual(["root"]);
    } finally { f.cleanup(); }
  });

  it("유니코드 값도 바이트 구간이 정확하다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "parism-m1-u-"));
    try {
      const raw = [
        "USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND",
        "root           1  0.0  0.0  25320 16384 ?        Ss   Sep04 147:31 파일-이름 café",
        "",
      ].join("\n");
      const { parsePsWithEvidence } = await import("../../src/parsers/process/ps.js");
      const parsed = parsePsWithEvidence("ps", ["aux"], raw, { maxItems: 0, format: "json" });
      expect((parsed.processes[0] as { command: string }).command).toBe("파일-이름 café");

      const { evidenceToByteSpans } = await import("../../src/engine/review.js");
      const { buildLineIndex, byteLengthOf } = await import("../../src/engine/evidence.js");
      const spans = evidenceToByteSpans(parsed.evidence, buildLineIndex(raw), raw, []);
      const command = spans["/processes/0/command"]!;
      const start = command[0]!.start;
      const end   = command[0]!.end;
      expect(Buffer.from(raw, "utf8").subarray(start, end).toString("utf8")).toBe("파일-이름 café");
      expect(end - start).toBe(byteLengthOf("파일-이름 café"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
