/**
 * `git status --porcelain=v1 -z` 파서와 근거 시험.
 *
 * 이 형식을 따로 다룬 이유는 실측에 있다. 줄 구분 porcelain 은 경로를 C 스타일로 이스케이프하고
 * 따옴표로 감싼다. 파일 이름에 개행 문자가 있으면 `?? "line\nbreak.txt"` 로 표시되어 원래 이름과
 * 다르다. -z 는 그런 가공 없이 경로를 그대로 내고 NUL 로 레코드를 나눈다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { describe, it, expect } from "vitest";
import { parseGitStatusPorcelain, isPorcelainArgs } from "../../src/parsers/git/status-porcelain.js";
import { checkFormat } from "../../src/parsers/format.js";
import { BUILTIN_CONTRACTS } from "../../src/parsers/contracts.js";
import { createRegistry } from "../../src/parsers/index.js";
import { buildLineIndex } from "../../src/engine/evidence.js";
import { evidenceToByteSpans } from "../../src/engine/review.js";

const NUL = "\0";

function parse(raw: string, args: string[] = ["status", "--porcelain=v1", "-z"], maxItems = 0) {
  return parseGitStatusPorcelain(args, raw, { maxItems });
}

/** 근거 구간을 실제 바이트로 되짚어 그 값을 가리키는지 확인한다 */
function sliceOf(raw: string, start: number, end: number): string {
  return Buffer.from(raw, "utf8").subarray(start, end).toString("utf8");
}

describe("porcelain=v1 -z 계약", () => {
  it("porcelain 인자를 값 유무와 함께 받는다", () => {
    const contract = BUILTIN_CONTRACTS.git as never;
    for (const args of [
      ["status", "--porcelain=v1", "-z"],
      ["status", "--porcelain", "-z"],
      ["status", "--porcelain=v2", "-z"],
      ["status", "--porcelain=v1", "--branch", "-z"],
      ["status", "--porcelain=v1", "-b", "--null"],
    ]) {
      expect(checkFormat(contract, args).accepted, args.join(" ")).toBe(true);
    }
  });

  it("버전과 무관한 포맷 값은 거절한다", () => {
    const v = checkFormat(BUILTIN_CONTRACTS.git as never, ["status", "--porcelain=vX", "-z"]);
    expect(v.accepted).toBe(false);
  });

  it("porcelain 인자를 아는지 확인한다", () => {
    expect(isPorcelainArgs(["status", "--porcelain=v1", "-z"])).toBe(true);
    expect(isPorcelainArgs(["status", "--porcelain"])).toBe(true);
    expect(isPorcelainArgs(["status", "-s"])).toBe(false);
    expect(isPorcelainArgs([])).toBe(false);
  });
});

describe("porcelain=v1 -z 파싱", () => {
  it("상태 두 자리와 경로를 나눈다", () => {
    const raw = `?? untracked.txt${NUL} M src/a.ts${NUL}M  src/b.ts${NUL}`;
    const { parsed } = parse(raw);
    expect(parsed.entries).toEqual([
      { xy: "??", index: "?", worktree: "?", path: "untracked.txt" },
      { xy: " M", index: " ", worktree: "M", path: "src/a.ts" },
      { xy: "M ", index: "M", worktree: " ", path: "src/b.ts" },
    ]);
  });

  it("경로에 개행이 있어도 한 레코드로 읽는다", () => {
    const raw = `?? line${NUL ? "\n" : ""}break.txt${NUL}`;
    const { parsed } = parse(raw);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.path).toBe("line\nbreak.txt");
    expect(parsed.entries[0]!.path).not.toContain("\\n");
  });

  it("따옴표와 역슬래시를 가공하지 않는다", () => {
    const raw = `?? quote"dq.txt${NUL}?? tab\there.txt${NUL}?? back\\slash.txt${NUL}`;
    const { parsed } = parse(raw);
    expect(parsed.entries.map(e => e.path)).toEqual(['quote"dq.txt', "tab\there.txt", "back\\slash.txt"]);
  });

  it("경로에 NUL 이 아닌 구분자가 섞여도 경계를 어기지 않는다", () => {
    const raw = `?? a:b.txt${NUL}?? c|d.txt${NUL}?? e f.txt${NUL}`;
    const { parsed } = parse(raw);
    expect(parsed.entries.map(e => e.path)).toEqual(["a:b.txt", "c|d.txt", "e f.txt"]);
  });

  it("이름 변경은 새 경로가 먼저, 원래 경로가 다음 레코드다", () => {
    const raw = `RM renamed.txt${NUL}keep.txt${NUL}`;
    const { parsed } = parse(raw);
    expect(parsed.entries).toEqual([
      { xy: "RM", index: "R", worktree: "M", path: "renamed.txt", orig_path: "keep.txt" },
    ]);
  });

  it("복사(C)도 원래 경로를 따로 받는다", () => {
    const raw = `C  copy.txt${NUL}orig.txt${NUL}`;
    const { parsed } = parse(raw);
    expect(parsed.entries[0]!.orig_path).toBe("orig.txt");
  });

  it("--branch 헤더를 읽는다", () => {
    expect(parse(`## master${NUL}?? a.txt${NUL}`).parsed.branch).toBe("master");
    expect(parse(`## HEAD (no branch)${NUL}?? a.txt${NUL}`).parsed).toMatchObject({ branch: "HEAD", detached: true });
    expect(parse(`## No commits yet on main${NUL}?? a.txt${NUL}`).parsed.branch).toBe("main");
  });

  it("빈 출력은 빈 항목 배열이다", () => {
    expect(parse("").parsed.entries).toEqual([]);
    expect(parse(NUL).parsed.entries).toEqual([]);
  });

  it("형식을 못 읽는 레코드는 조용히 버리지 않고 건너뛴다", () => {
    const raw = `garbage line${NUL}?? a.txt${NUL}`;
    const { parsed } = parse(raw);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.path).toBe("a.txt");
  });

  it("maxItems 를 넘으면 절단 요약을 함께 준다", () => {
    const raw = `?? a.txt${NUL}?? b.txt${NUL}?? c.txt${NUL}`;
    const { parsed } = parse(raw, ["status", "--porcelain=v1", "-z"], 2);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed._summary).toEqual({ total: 3, shown: 2, truncated: true });
  });
});

describe("porcelain=v1 -z 근거", () => {
  it("필드마다 원문 위치를 준다", () => {
    const raw = `RM renamed.txt${NUL}keep.txt${NUL}`;
    const { evidence } = parse(raw);
    expect(evidence["/entries/0/xy"]).toBeDefined();
    expect(evidence["/entries/0/path"]).toBeDefined();
    expect(evidence["/entries/0/orig_path"]).toBeDefined();
  });

  it("바이트 구간이 원문에서 그 값을 정확히 가리킨다", () => {
    const raw = `RM renamed.txt${NUL}keep.txt${NUL}?? second.txt${NUL}`;
    const { parsed, evidence } = parse(raw);
    const spans = evidenceToByteSpans(evidence, buildLineIndex(raw), raw, []);

    for (const entry of parsed.entries) {
      for (const [key, value] of Object.entries(entry) as Array<[string, unknown]>) {
        const list = spans[`/entries/${parsed.entries.indexOf(entry)}/${key}`];
        expect(list, `${key} 근거 없음`).toBeDefined();
        const text = sliceOf(raw, list![0]!.start, list![0]!.end);
        expect(text, `${key} 불일치`).toBe(String(value));
      }
    }
  });

  it("경로에 개행이 있어도 근거가 정확하다 (줄이 아니라 레코드 기준)", () => {
    const raw = `?? line\nbreak.txt${NUL}?? tab\there.txt${NUL}`;
    const { parsed, evidence } = parse(raw);
    const spans = evidenceToByteSpans(evidence, buildLineIndex(raw), raw, []);
    expect(parsed.entries[0]!.path).toBe("line\nbreak.txt");

    const list = spans["/entries/0/path"]!;
    expect(sliceOf(raw, list[0]!.start, list[0]!.end)).toBe("line\nbreak.txt");
    /** 두 번째 항목의 구간도 첫 항목의 개행을 건너뛰고 정확해야 한다 */
    const second = spans["/entries/1/path"]!;
    expect(sliceOf(raw, second[0]!.start, second[0]!.end)).toBe("tab\there.txt");
  });

  it("레코드 번호를 함께 준다", () => {
    const raw = `?? a.txt${NUL}?? b.txt${NUL}?? c.txt${NUL}`;
    const { evidence } = parse(raw);
    const spans = evidenceToByteSpans(evidence, buildLineIndex(raw), raw, []);
    expect(spans["/entries/0/path"]![0]!.record).toBe(1);
    expect(spans["/entries/2/path"]![0]!.record).toBe(3);
  });

  it("유니코드 경로도 바이트 구간이 정확하다", () => {
    const path = "디렉터리/파일 이름 — café.md";
    const raw = `?? ${path}${NUL}`;
    const { parsed, evidence } = parse(raw);
    const spans = evidenceToByteSpans(evidence, buildLineIndex(raw), raw, []);
    expect(parsed.entries[0]!.path).toBe(path);
    const list = spans["/entries/0/path"]!;
    expect(sliceOf(raw, list[0]!.start, list[0]!.end)).toBe(path);
  });
});

describe("porcelain 줄 레코드 모드 (-z 없음)", () => {
  /**
   * 회귀: -z 전용 파서에 줄 구분 출력을 넘기면 모든 레코드가 첫 항목의 경로에 몰린다.
   * 실제로 확인한 입력이다 — 항목이 하나가 되고 경로에 개행이 그대로 남는다.
   */
  const lineParse = (raw: string, maxItems = 0) =>
    parseGitStatusPorcelain(["status", "--porcelain=v1"], raw, { maxItems });

  it("레코드를 개행으로 나눠 항목마다 하나씩 낸다", () => {
    const raw = "?? a.txt\n?? b.txt\n?? c.txt\n";
    expect(lineParse(raw).parsed.entries).toEqual([
      { xy: "??", index: "?", worktree: "?", path: "a.txt" },
      { xy: "??", index: "?", worktree: "?", path: "b.txt" },
      { xy: "??", index: "?", worktree: "?", path: "c.txt" },
    ]);
  });

  it("따옴표와 C 이스케이프를 풀어 원래 이름을 낸다", () => {
    const raw = '?? "line\\nbreak.txt"\n?? "quote\\"dq.txt"\n?? "tab\\there.txt"\n';
    const entries = lineParse(raw).parsed.entries;
    expect(entries.map(e => e.path)).toEqual(["line\nbreak.txt", 'quote"dq.txt', "tab\there.txt"]);
    /** 가공이 있었음을 값으로 알린다 — -z 출력에는 붙지 않는다 */
    expect(entries.every(e => e.quoted === true)).toBe(true);
  });

  it("가공되지 않은 경로에는 quoted 를 붙이지 않는다", () => {
    expect(lineParse("?? a.txt\n").parsed.entries[0]!.quoted).toBeUndefined();
  });

  it("경로에 ' -> ' 가 있어도 화살표 표기로 잘리지 않는다", () => {
    const raw = '?? "arrow -> x.txt"\n?? plain -> y.txt\n';
    expect(lineParse(raw).parsed.entries.map(e => e.path)).toEqual(["arrow -> x.txt", "plain -> y.txt"]);
  });

  it("이름 변경은 한 줄의 ' -> ' 표기에서 양쪽 경로를 얻는다", () => {
    const raw = "R  old.txt -> new.txt\n";
    expect(lineParse(raw).parsed.entries).toEqual([
      { xy: "R ", index: "R", worktree: " ", path: "new.txt", orig_path: "old.txt" },
    ]);
  });

  it("따옴표로 감싼 이름 변경도 양쪽 경로를 얻는다", () => {
    const raw = 'R  "old name.txt" -> "new name.txt"\n';
    expect(lineParse(raw).parsed.entries[0]).toMatchObject({ path: "new name.txt", orig_path: "old name.txt" });
  });

  it("두 형식이 같은 경로 집합을 낸다 (실측 원문)", () => {
    /** 위 프로브에서 실제로 나온 두 원문이다. 항목 수와 경로가 같아야 한다. */
    const nul   = " M mod.txt R  new.txt old.txt ?? arrow -> x.txt ?? line\nbreak.txt "
                + '?? quote"dq.txt ?? tab\there.txt ';
    const lines = ' M mod.txt\nR  old.txt -> new.txt\n?? "arrow -> x.txt"\n?? "line\\nbreak.txt"\n'
                + '?? "quote\\"dq.txt"\n?? "tab\\there.txt"\n';
    const z = parse(nul).parsed.entries;
    const l = lineParse(lines).parsed.entries;
    expect(z).toHaveLength(6);
    expect(l).toHaveLength(6);
    expect(l.map(e => e.path).sort()).toEqual(z.map(e => e.path).sort());
    expect(l.map(e => e.orig_path).filter(Boolean)).toEqual(["old.txt"]);
  });

  it("줄 모드 근거가 원문을 정확히 가리킨다", () => {
    const raw = '?? "line\\nbreak.txt"\n M mod.txt\n';
    const { parsed, evidence } = lineParse(raw);
    const spans = evidenceToByteSpans(evidence, buildLineIndex(raw), raw, []);
    expect(parsed.entries[0]!.path).toBe("line\nbreak.txt");

    /** 이스케이프가 풀린 값이므로 근거는 원문의 따옴표 구간을 가리키고 그 사실을 transform 이 말한다 */
    const pathSpan = spans["/entries/0/path"]![0]!;
    expect(pathSpan.transform).toBe("unescape_c_quotes");
    expect(sliceOf(raw, pathSpan.start, pathSpan.end)).toBe('"line\\nbreak.txt"');

    const modSpan = spans["/entries/1/path"]![0]!;
    expect(modSpan.transform).toBeUndefined();
    expect(sliceOf(raw, modSpan.start, modSpan.end)).toBe("mod.txt");
  });

  it("-z 여부가 레코드 경계를 정한다", () => {
    /** 같은 원문을 -z 로 읽으면 NUL 이 경계다 */
    const raw = "?? a.txt\0?? b.txt\0";
    expect(parse(raw).parsed.entries).toHaveLength(2);
    expect(lineParse(raw).parsed.entries).toHaveLength(1);
  });
});

describe("레지스트리 경로", () => {
  it("porcelain -z 는 행 배열로 파싱된다", () => {
    const registry = createRegistry();
    const raw = `?? a.txt${NUL} M b.txt${NUL}`;
    const out = registry.parse("git", ["status", "--porcelain=v1", "-z"], raw, { maxItems: 0, format: "json" });
    expect(out.parse_error).toBeUndefined();
    expect((out.parsed as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it("porcelain 을 -z 없이 줘도 행 배열로 파싱된다", () => {
    const registry = createRegistry();
    const raw = "?? a.txt\n M b.txt\n";
    const out = registry.parse("git", ["status", "--porcelain=v1"], raw, { maxItems: 0, format: "json" });
    expect(out.parse_error).toBeUndefined();
    expect((out.parsed as { entries: Array<{ path: string }> }).entries.map(e => e.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("long 형식은 기존 모양을 유지한다", () => {
    const registry = createRegistry();
    const raw = ["On branch master", "", "Untracked files:", "\tnew.txt", ""].join("\n");
    const out = registry.parse("git", ["status"], raw, { maxItems: 0, format: "json" });
    const parsed = out.parsed as { branch: string; untracked: string[] };
    expect(parsed.branch).toBe("master");
    expect(parsed.untracked).toEqual(["new.txt"]);
  });
});
