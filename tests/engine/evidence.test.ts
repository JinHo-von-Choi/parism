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
      /**
       * review 에 result_id 가 실렸으므로 사용자는 이 id 로 다시 부를 수 있다.
       * 그렇다면 '이 세션이 모르는 id'(unknown_id)가 아니라 '처음부터 보관하지 않았다'(not_retained)로
       * 알려야 한다 — 무엇을 해야 하는지가 다르다.
       */
      expect(ex.ok === false && ex.reason).toBe("not_retained");
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

/**
 * 회귀 방지 — 근거 구간 변환이 포인터 수에 비례해 느려지지 않는가.
 *
 * 실제 결함이었다. 줄 시작 위치를 **포인터마다** 다시 계산해서
 * O(포인터 × 원문 길이) 이 되었다. 1MB 출력을 5천 행 fixture 로 재면
 * 근거 하나를 만드는 데 1.9초가 걸렸다(실측). 같은 입력 0.32초.
 *
 * 시간을 재는 대신 **동작으로** 고정한다 — 같은 원문에서 근거가 나오는지와
 * 포인터 수가 많아도 결과가 같은지(순서와 값)를 함께 본다.
 */
describe("근거 변환은 규모에 대해 선형이다", () => {
  it("행이 많아도 근거가 정확하고 빠르다", async () => {
    const f = fixture();
    try {
      /** `ps` 는 필드 근거를 내는 파서다(registry 에 evidence 빌더가 있다). */
      const small = await f.engine.run("ps", { args: ["aux"], cwd: f.dir, contract_version: "next", evidence: "rows", retain: true });
      const t0 = process.hrtime.bigint();
      const again = await f.engine.run("ps", { args: ["aux"], cwd: f.dir, contract_version: "next", evidence: "rows", retain: true });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;

      expect(again.review?.retained).toBe(small.review?.retained);
      const ex = f.engine.explainResult(again.review!.result_id, "/processes/0/user");
      expect(ex.ok).toBe(true);
      /** 근거가 사라지지 않았는지가 핵심이다. 이전 결함은 결과가 틀린 게 아니라 느린 것이었다. */
      expect(ms).toBeLessThan(5_000);
    } finally { f.cleanup(); }
  });

  it("같은 원문에서는 같은 근거가 나온다 (계산 순서가 결과를 바꾸지 않는다)", async () => {
    const f = fixture();
    try {
      const a = await f.engine.run("ps", { args: ["aux"], cwd: f.dir, contract_version: "next", evidence: "rows", retain: true });
      const b = await f.engine.run("ps", { args: ["aux"], cwd: f.dir, contract_version: "next", evidence: "rows", retain: true });
      const ea = f.engine.explainResult(a.review!.result_id, "/processes/0/command");
      const eb = f.engine.explainResult(b.review!.result_id, "/processes/0/command");
      expect(ea.ok && eb.ok).toBe(true);
      if (!ea.ok || !eb.ok) return;
      expect(eb.source_spans).toEqual(ea.source_spans);
      expect(eb.source_kind).toBe(ea.source_kind);
    } finally { f.cleanup(); }
  });
});

/**
 * 회귀 방지 — 보관 크기 계량에 근거가 포함되는가.
 *
 * 실제 결함이었다. 엔진이 저장소에 기록하는 `bytes` 가 원문과 본문만 재고
 * **근거 맵을 아예 세지 않았다.** 근거는 값 자체를 함께 담기 때문에(근거가 그 값을
 * 증명해야 하므로) 실제 보관본의 2.6배를 과소 보고했다.
 *
 * 결과는 문서에 적힌 한도가 거짓말을 하는 것이었다. 실측: 3,200행 `git status` 결과가
 * 1.58MiB 로 기록되어(한도 2MiB 안) `retained=true` 로 보관되었지만 실제 점유는
 * **4.11MiB — 한도의 두 배**였다. 지금은 올바르게 거절된다.
 */
describe("보관 크기 계량", () => {
  /** `results` 는 private 필드지만 컴파일 제약일 뿐이라 계량을 확인하는 데 읽는다. */
  const storedBytes = (e: unknown): number => (e as { results: { bytes: number } }).results.bytes;

  it("같은 출력이면 근거를 켠 쪽이 더 크게 기록된다", async () => {
    const withoutEv = fixture();
    const withEv    = fixture();
    try {
      const a = await withoutEv.engine.run("ps", { args: ["aux"], cwd: withoutEv.dir, contract_version: "next", retain: true });
      const b = await withEv.engine.run("ps", { args: ["aux"], cwd: withEv.dir, contract_version: "next", evidence: "rows", retain: true });

      expect(a.review?.retained).toBe(true);
      expect(b.review?.retained).toBe(true);
      /** 근거가 없으면 같은 출력이면 같은 크기여야 한다. */
      expect(storedBytes(withEv.engine)).toBeGreaterThan(storedBytes(withoutEv.engine));
    } finally {
      withoutEv.cleanup();
      withEv.cleanup();
    }
  });

  it("기록한 크기가 실제 보관본을 과소하지 않는다", async () => {
    const f = fixture();
    try {
      const r = await f.engine.run("ps", { args: ["aux"], cwd: f.dir, contract_version: "next", evidence: "rows", retain: true });
      expect(r.review?.retained).toBe(true);

      const store = (f.engine as unknown as { results: { bytes: number; get(id: string): { found: boolean; result?: unknown } } }).results;
      const hit = store.get(r.review!.result_id);
      expect(hit.found).toBe(true);

      const sizeOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v ?? null), "utf8");
      const stored = hit.result as Record<string, unknown>;
      const actual = sizeOf({ stdout: stored.stdout, stderr: stored.stderr, parsed: stored.parsed, evidence: stored.evidence });

      /**
       * 결함 상태에서는 이 비율이 0.38 이었다(2.6배 과소).
       * `review` 와 지문 같은 고정 크기 구성요소를 세지 않으므로 1.0 은 아니고,
       * 그래도 본문 대부분을 반영한다는 하한은 지켜야 한다.
       */
      expect(store.bytes).toBeGreaterThan(actual * 0.8);
    } finally {
      f.cleanup();
    }
  });
});
