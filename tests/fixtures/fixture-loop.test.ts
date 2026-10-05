import { describe, it, expect } from "vitest";
import { validateManifest, isReviewed, contentHashOf, FIXTURE_MANIFEST_VERSION } from "../../src/fixtures/manifest.js";
import { sanitizeText, sanitizeArgs, defaultRules } from "../../src/fixtures/sanitize.js";
import { diffJson, replayManifest } from "../../src/fixtures/replay.js";
import { loadFixtures, replayDirectory } from "../../src/fixtures/run.js";
import { createRegistry } from "../../src/parsers/index.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = "/home/사람이름";

describe("fixture 매니페스트", () => {
  const base = {
    manifest_version: FIXTURE_MANIFEST_VERSION,
    id: "f1",
    captured_at: "2026-10-05T00:00:00.000Z",
    tool: { command: "ls", args: ["-l"] },
    exit: { code: 0 },
    stdout: "total 0\n",
    stderr: "",
    content_hash: "abc123",
    versions: { parism: "2.0.2" },
  };

  it("계획서 8장이 요구한 필드를 모두 받는다", () => {
    const check = validateManifest(base);
    expect(check.issues).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it("깨진 매니페스트를 조용히 버리지 않고 이유를 돌려준다", () => {
    const check = validateManifest({ ...base, stdout: 42 });
    expect(check.ok).toBe(false);
    expect(check.issues.length).toBeGreaterThan(0);
  });

  it("reviewed_by 가 없으면 계약이 아니라 제안이다", () => {
    const without = validateManifest({ ...base, expected: { parsed: {} } });
    expect(without.ok).toBe(true);
    expect(without.manifest && isReviewed(without.manifest)).toBe(false);

    const withReview = validateManifest({ ...base, expected: { parsed: {}, reviewed_by: "최진호" } });
    expect(withReview.manifest && isReviewed(withReview.manifest)).toBe(true);
  });
});

describe("fixture 정제", () => {
  it("시크릿과 홈 경로를 가린다", () => {
    const text = `token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 home=${HOME}/src`;
    const out  = sanitizeText(text, { home: HOME });
    expect(out.text).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(out.text).not.toContain(HOME);
    expect(out.text).toContain("token=");
    expect(out.text).toContain("~/src");
  });

  it("무엇을 가렸는지 남긴다 — 흔적이 없으면 검증할 수 없다", () => {
    const out = sanitizeText(`x=${HOME}`, { home: HOME });
    expect(out.redactions.length).toBe(1);
    expect(out.redactions[0]!.kind).toBe("home_path");
    expect(out.redactions[0]!.count).toBe(1);
  });

  it("가린 뒤에도 문맥이 남아 눈으로 확인된다", () => {
    const out = sanitizeText(`Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345`, { home: HOME });
    expect(out.text).toContain("Authorization: Bearer");
    expect(out.text).toContain("[REDACTED]");
  });

  it("겹치는 구간에서는 앞선 규칙이 이긴다", () => {
    /**
     * `--token=<홈 경로>` 에서 홈 경로 규칙(2번)이 argv 시크릿 규칙(3번)보다 앞선다.
     * 뒤 규칙이 잘라내면 '무엇이 가려졌는지'가 규칙마다 달라져 재현이 어려워진다.
     * 우선순위가 있다는 사실 자체를 고정한다.
     */
    const out = sanitizeText(`--token=${HOME}/secretpart`, { home: HOME });
    expect(out.text).toBe("--token=~/secretpart");
    expect(out.redactions.map(r => r.kind)).toEqual(["home_path"]);
  });

  it("토큰 규칙은 홈 경로 규칙보다 먼저 온다 — 진짜 토큰은 통째로 가려진다", () => {
    const out = sanitizeText(`ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345`, { home: HOME });
    expect(out.text).toBe("[REDACTED]");
    expect(out.redactions[0]!.kind).toBe("secret");
  });

  it("argv 는 옵션 이름과 길이를 남긴다 — 비교 키가 사라지면 안 된다", () => {
    const out = sanitizeArgs(["get", "pods", "--token=abcdef123456"]);
    expect(out.redacted).toBe(true);
    expect(out.args[0]).toBe("get");
    expect(out.args[2]).toBe("--token=<redacted:12>");
  });

  it("사용자 규칙이 기본 규칙 뒤에 적용된다", () => {
    const rules = defaultRules(HOME);
    const out   = sanitizeText("고유번호 12345", { home: HOME, extraRules: [{ kind: "secret", pattern: /고유번호 \d+/g }] });
    expect(out.text).toBe("[REDACTED]");
    expect(rules.length).toBeGreaterThan(0);
  });
});

describe("계약 변화 탐지", () => {
  it("키 순서만 바뀐 것은 변화가 아니다", () => {
    expect(diffJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });

  it("배열 순서만 바뀐 것은 변화다 (순서도 값이다)", () => {
    const changes = diffJson([1, 2], [2, 1]);
    expect(changes.length).toBeGreaterThan(0);
  });

  it("누락과 추가를 구분해 알려준다", () => {
    const changes = diffJson({ a: 1, b: 2 }, { a: 1, c: 3 });
    expect(changes.some(c => c.kind === "missing" && c.path === "/b")).toBe(true);
    expect(changes.some(c => c.kind === "extra" && c.path === "/c")).toBe(true);
  });

  it("타입이 다르면 값이 아니라 타입 변화로 보고한다", () => {
    const changes = diffJson({ entries: { a: 1 } }, { entries: [] });
    expect(changes[0]!.kind).toBe("type");
  });

  it("포인터 경로에 슬래시와 물결표가 있어도 깨지지 않는다", () => {
    const changes = diffJson({ "a/b": 1, "c~d": 2 }, { "a/b": 9, "c~d": 2 });
    expect(changes[0]!.path).toBe("/a~1b");
  });
});

describe("오프라인 replay", () => {
  const stdout = " M src/a.ts\n?? src/b.ts\n";
  const manifestOf = (expected?: unknown) => ({
    manifest_version: FIXTURE_MANIFEST_VERSION,
    id: "g1",
    captured_at: "2026-10-05T00:00:00.000Z",
    tool: { command: "git", args: ["status", "--porcelain"] },
    exit: { code: 0 },
    stdout, stderr: "", content_hash: contentHashOf(stdout),
    versions: {},
    redactions: [],
    ...(expected !== undefined && { expected }),
  });

  it("사람이 검토한 기대값이 없으면 계약 위반으로 세지 않는다", () => {
    const parsed = validateManifest(manifestOf({ parsed: { entries: [] } }));
    const result = replayManifest(parsed.manifest!, createRegistry());
    expect(result.reviewed).toBe(false);
    expect(result.status).toBe("unreviewed");
  });

  it("기대값이 맞으면 변화 0", () => {
    const parsed = validateManifest(manifestOf({
      parsed: { entries: [
        { xy: " M", index: " ", worktree: "M", path: "src/a.ts" },
        { xy: "??", index: "?", worktree: "?", path: "src/b.ts" },
      ] },
      reviewed_by: "최진호",
    }));
    const result = replayManifest(parsed.manifest!, createRegistry());
    expect(result.status).toBe("match");
    expect(result.changes).toBe(0);
  });

  it("값이 어긋나면 어디가 어긋났는지 경로로 알려준다", () => {
    const parsed = validateManifest(manifestOf({
      parsed: { entries: [{ xy: " M", index: " ", worktree: "M", path: "src/다른.ts" }] },
      reviewed_by: "최진호",
    }));
    const result = replayManifest(parsed.manifest!, createRegistry());
    expect(result.status).toBe("changed");
    expect(result.changes).toBeGreaterThan(0);
    const hit = result.checks.find(c => c.name === "parsed")!.changes
      .some(c => c.actual === "src/a.ts" && c.expected === "src/다른.ts");
    expect(hit).toBe(true);
  });

  it("기대 실패 계약이 맞는 실패는 통과로 본다", () => {
    /** `ls` 에 -l 이 없으면 파서가 그 형식을 지원하지 않는다(계약대로 실패한다). */
    const failing = {
      ...manifestOf({ failure: { reason: "unsupported_format" }, reviewed_by: "최진호" }),
      tool: { command: "ls", args: [] },
      stdout: "src/a.ts\nsrc/b.ts\n",
    };
    const result = replayManifest(validateManifest(failing).manifest!, createRegistry());
    expect(result.checks.find(c => c.name === "failure")!.status).toBe("match");
    expect(result.status).toBe("match");
  });

  it("기대 실패 계약이 있는데 실제로 성공하면 변화로 본다", () => {
    const parsed = validateManifest(manifestOf({ failure: { reason: "unsupported_format" }, reviewed_by: "최진호" }));
    const result = replayManifest(parsed.manifest!, createRegistry());
    expect(result.checks.find(c => c.name === "failure")!.status).toBe("changed");
  });

  it("근거는 적은 포인터만 확인한다 — 전수 확인을 켜면 빠진 것도 센다", () => {
    const m1 = manifestOf({ reviewed_by: "최진호", evidence: { pointers: { "/entries/0/path": [{ source: "stdout", line: 0, start: 3, end: 11 }] } } });
    const r1 = replayManifest(validateManifest(m1).manifest!, createRegistry());
    expect(r1.checks.find(c => c.name === "evidence")!.status).toBe("match");

    /** exhaustive 는 expected 안의 evidence 에 있는 값이다. */
    const m2 = {
      ...m1,
      expected: { ...m1.expected, evidence: { exhaustive: true, pointers: m1.expected.evidence.pointers } },
    };
    const r2 = replayManifest(validateManifest(m2).manifest!, createRegistry());
    expect(r2.checks.find(c => c.name === "evidence")!.changes.length).toBeGreaterThan(0);
  });

  it("명령을 다시 실행하지 않는다 — 저장된 stdout 만 쓴다", () => {
    const parsed = validateManifest(manifestOf({ reviewed_by: "최진호" }));
    const before = process.hrtime.bigint();
    replayManifest(parsed.manifest!, createRegistry());
    const ms = Number(process.hrtime.bigint() - before) / 1e6;
    /** git 을 실행했다면 수십 ms 이상 걸린다. 파싱만 하면 1ms 대다. */
    expect(ms).toBeLessThan(20);
  });
});

describe("fixture 집합 되짚기", () => {
  it("매니페스트가 아닌 파일을 조용히 건너뛰지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "parism-fixt-"));
    try {
      writeFileSync(join(dir, "a.json"), JSON.stringify({ command: "ls", stdout: "x" }));
      writeFileSync(join(dir, "b.json"), "{ 깨진 JSON");
      const loaded = loadFixtures(dir);
      expect(loaded).toHaveLength(2);
      expect(loaded[0]!.error).toContain("manifest_version");
      expect(loaded[1]!.error).toContain("JSON");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("깨진 fixture 가 있으면 보고하고, 되짚기는 되돌아온다", () => {
    const dir = mkdtempSync(join(tmpdir(), "parism-fixt2-"));
    try {
      writeFileSync(join(dir, "broken.json"), "{ nope");
      const report = replayDirectory(dir, {});
      expect(report.invalid).toBe(1);
      expect(report.contractChanges).toBe(0);
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("되짚기는 기대값을 쓰지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "parism-fixt3-"));
    try {
      const stdout = " M src/a.ts\n";
      writeFileSync(join(dir, "g.json"), JSON.stringify({
        manifest_version: FIXTURE_MANIFEST_VERSION, id: "g", captured_at: "2026-10-05T00:00:00.000Z",
        tool: { command: "git", args: ["status", "--porcelain"] }, exit: { code: 0 },
        stdout, stderr: "", content_hash: contentHashOf(stdout), versions: {}, redactions: [],
        expected: { parsed: { entries: [] }, reviewed_by: "최진호" },
      }));
      const before = readFileSync(join(dir, "g.json"), "utf-8");
      replayDirectory(dir, {});
      expect(readFileSync(join(dir, "g.json"), "utf-8")).toBe(before);
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});
