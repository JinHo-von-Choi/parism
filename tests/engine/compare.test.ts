/**
 * 의미 diff 시험.
 *
 * 계획서 7장 완료 조건과 수용 기준을 그대로 옮긴다.
 *   거짓 삭제 0 / 순서만 변경하면 diff 0 / 다른 대상 비교 거절 / key 충돌 오류
 *   같은 fixture 두 번 diff 0, 필드 변화만, duplicate identity 오류, 잘린 입력은 거짓 삭제 0
 *
 * 가장 중요한 규칙: 불완전 결과의 없는 행을 '삭제'라고 말하지 않는다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { describe, it, expect } from "vitest";
import { buildFingerprint, compareFingerprints, maskArgv, realCwd, stableStringify } from "../../src/engine/compare/fingerprint.js";
import { gitStatusIdentity, kubernetesIdentity, gitRenameLink, DOMAIN_SUMMARY } from "../../src/engine/compare/identity.js";
import { compareResults, domainOf, type CompareSide } from "../../src/engine/compare/index.js";
import type { Review } from "../../src/engine/evidence.js";
import type { Fingerprint } from "../../src/engine/compare/fingerprint.js";

function review(over: Partial<Review> = {}): Review {
  return {
    result_id: "r_1", parser_id: "git", parser_version: "1", content_hash: "h1",
    schema_version: "parism/1.1", source_complete: true, parse_complete: true,
    representation_lossless: true, privacy_transform: "none", retained: true, warnings: [],
    ...over,
  } as Review;
}

function fingerprint(over: Partial<Fingerprint> = {}): Fingerprint {
  return {
    cmd: "git", argv_hash: "a1", argv_masked: "status --porcelain=v1 -z", cwd_real: "/repo",
    policy_hash: "p1", parser_id: "git", schema_version: "parism/1.1", content_hash: "h1",
    platform: { os: "linux", arch: "x64", node: "24.0.0" }, tools: {}, locale: ["LC_ALL=C"],
    context: {}, observation: { env_names: [] },
    ...over,
  };
}

function side(over: Partial<CompareSide> = {}): CompareSide {
  return {
    resultId: "r_1", fingerprint: fingerprint(), rows: [],
    incomplete: false, incompleteReasons: [], review: { source_complete: true, parse_complete: true },
    ...over,
  };
}

const MODIFIED = { xy: " M", index: " ", worktree: "M", path: "src/a.ts" };
const STAGED   = { xy: "M ", index: "M", worktree: " ", path: "src/a.ts" };

describe("지문", () => {
  it("argv 를 그대로 담지 않는다", () => {
    const fp = buildFingerprint({
      cmd: "gh", args: ["auth", "login", "--token=ghp_secretvalue"], cwd: "/x",
      policy: {}, review: review(), env: {},
    });
    expect(fp.argv_hash).not.toContain("secretvalue");
    expect(fp.argv_masked).not.toContain("secretvalue");
    expect(fp.argv_masked).toContain("[REDACTED]");
  });

  it("환경 변수는 이름만 담고 값은 담지 않는다", () => {
    const fp = buildFingerprint({
      cmd: "echo", args: [], cwd: "/x", policy: {},
      review: review(), env: { SECRET_TOKEN: "hunter2", PATH: "/bin" },
    });
    expect(fp.observation.env_names).toContain("SECRET_TOKEN");
    expect(JSON.stringify(fp.observation)).not.toContain("hunter2");
  });

  it("심볼릭 링크를 따라 실제 경로를 쓴다", () => {
    expect(realCwd(process.cwd())).toBe(realCwd(`${process.cwd()}/.`));
  });

  it("키 순서와 무관하게 같은 문자열을 만든다", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it("argv 표시에 비밀처럼 보이는 값을 가린다", () => {
    expect(maskArgv(["--password=hunter2"])).toBe("--password=[REDACTED]");
    expect(maskArgv(["--api-key", "abc"])).toBe("--api-key abc");
  });
});

describe("지문 호환성", () => {
  it("같은 지문은 same", () => {
    expect(compareFingerprints(fingerprint(), fingerprint()).compatibility).toBe("same");
  });

  it("명령·인자·작업 디렉터리·파서가 다르면 incompatible", () => {
    expect(compareFingerprints(fingerprint(), fingerprint({ cmd: "ls" })).compatibility).toBe("incompatible");
    expect(compareFingerprints(fingerprint(), fingerprint({ argv_hash: "a2" })).compatibility).toBe("incompatible");
    expect(compareFingerprints(fingerprint(), fingerprint({ cwd_real: "/other" })).compatibility).toBe("incompatible");
    expect(compareFingerprints(fingerprint(), fingerprint({ parser_id: "ls" })).compatibility).toBe("incompatible");
  });

  it("스키마 버전을 모르면 unknown", () => {
    const v = compareFingerprints(fingerprint(), fingerprint({ schema_version: "parism/2.0" }));
    expect(v.compatibility).toBe("unknown");
  });

  it("사용자 문맥이 다르면 unknown", () => {
    const v = compareFingerprints(fingerprint(), fingerprint({ context: { cluster: "prod" } }));
    expect(v.compatibility).toBe("unknown");
  });

  it("OS 나 정책 차이는 대상 동일성이면 무시 목록에 둔다", () => {
    const v = compareFingerprints(fingerprint(), fingerprint({
      content_hash: "h2", platform: { os: "darwin", arch: "arm64", node: "24.0.0" }, policy_hash: "p2",
    }));
    expect(v.compatibility).toBe("compatible");
    expect(v.ignored.length).toBeGreaterThan(0);
  });

  it("strict 에서 도구 버전 차이가 있으면 거절한다", () => {
    const other = fingerprint({ content_hash: "h2", tools: { git: "2.50" } });
    expect(compareFingerprints(fingerprint({ tools: { git: "2.49" } }), other).compatibility).toBe("compatible");
    expect(compareFingerprints(fingerprint({ tools: { git: "2.49" } }), other, { strict: true }).compatibility).toBe("unknown");
  });
});

describe("행 identity", () => {
  it("git 은 정규 경로를 쓴다", () => {
    const a = gitStatusIdentity({ path: "./src/a.ts" }, "/repo", {});
    const b = gitStatusIdentity({ path: "src/a.ts" }, "/repo", {});
    expect(a.trustworthy).toBe(true);
    expect(a.key).toBe(b.key);
  });

  it("git 경로는 저장소 기준으로 정규화한다 — 프로세스 cwd 에 의존하지 않는다", () => {
    /**
     * 회귀: `resolve(value)` 는 프로세스 cwd 기준이라, 같은 저장소 파일이 실행 위치마다 다른 키를 갖는다.
     * 저장소 identity(실경로) 기준이어야 '같은 파일인가'가 뜻이 된다.
     */
    const id = gitStatusIdentity({ path: "src/a.ts" }, "/repo", {});
    expect(id.key).toContain("/repo/src/a.ts");
    expect(id.key).not.toContain(process.cwd());
  });

  it("상대 경로와 절대 경로가 같은 행을 가리킨다", () => {
    const rel = gitStatusIdentity({ path: "src/a.ts" }, "/repo", {});
    const abs = gitStatusIdentity({ path: "/repo/src/a.ts" }, "/repo", {});
    expect(rel.key).toBe(abs.key);
  });

  it("저장소가 다르면 key 가 다르다", () => {
    expect(gitStatusIdentity({ path: "a.ts" }, "/r1", {}).key).not.toBe(gitStatusIdentity({ path: "a.ts" }, "/r2", {}).key);
  });

  it("identity 필드가 없으면 신뢰하지 않는다", () => {
    const id = gitStatusIdentity({ name: "a" }, "/repo", {});
    expect(id.trustworthy).toBe(false);
    expect(id.reason).toMatch(/missing/);
  });

  it("kubernetes 는 uid 가 있어야 비교한다", () => {
    const withUid = kubernetesIdentity({ kind: "Pod", name: "p", metadata: { uid: "u1" } }, {}, {});
    expect(withUid.trustworthy).toBe(true);
    const noUid = kubernetesIdentity({ kind: "Pod", name: "p", metadata: {} }, {}, {});
    expect(noUid.trustworthy).toBe(false);
    expect(noUid.reason).toMatch(/recreated/);
  });

  it("kubernetes 는 같은 이름 다른 uid 를 다른 자원으로 본다", () => {
    const a = kubernetesIdentity({ kind: "Pod", name: "p", metadata: { uid: "u1" } }, {}, {});
    const b = kubernetesIdentity({ kind: "Pod", name: "p", metadata: { uid: "u2" } }, {}, {});
    expect(a.key).not.toBe(b.key);
  });

  it("이름 변경은 확정 정보가 있을 때만 잇는다", () => {
    expect(gitRenameLink({ path: "b.ts", orig_path: "a.ts" })).toEqual({ from: "a.ts", to: "b.ts" });
    expect(gitRenameLink({ path: "b.ts" })).toBeNull();
  });

  it("ps 보류를 이유와 함께 밝힌다", () => {
    expect(DOMAIN_SUMMARY.ps).toMatch(/withheld/);
    expect(domainOf(fingerprint({ cmd: "ps", parser_id: "ps" }))).toBe("ps");
  });
});

describe("비교", () => {
  it("같은 fixture 두 번은 diff 0", () => {
    const out = compareResults({ base: side({ rows: [MODIFIED] }), current: side({ rows: [MODIFIED] }) });
    expect(out.changed).toHaveLength(0);
    expect(out.added).toHaveLength(0);
    expect(out.removed).toHaveLength(0);
    expect(out.unchanged_count).toBe(1);
  });

  it("행 순서만 바뀌면 변화 0", () => {
    const a = { ...MODIFIED, path: "src/a.ts" };
    const b = { ...MODIFIED, path: "src/b.ts" };
    const out = compareResults({ base: side({ rows: [a, b] }), current: side({ rows: [b, a] }) });
    expect(out.changed).toHaveLength(0);
    expect(out.unchanged_count).toBe(2);
  });

  it("결과에는 사람이 읽는 행 이름을 함께 준다", () => {
    /**
     * key 는 저장소 identity 가 접두사로 붙은 내부 식별자라 사람이 읽기 어렵다.
     * 무엇이 변했는지 말하려면 이름이 보여야 한다.
     */
    const out = compareResults({ base: side({ rows: [MODIFIED] }), current: side({ rows: [STAGED] }) });
    expect(out.changed[0]!.label).toBe("/repo/src/a.ts");
    expect(out.changed[0]!.key).toContain("\0");
  });

  it("필드 변화는 해당 행에서만 보고된다", () => {
    const out = compareResults({ base: side({ rows: [MODIFIED] }), current: side({ rows: [STAGED] }) });
    expect(out.changed).toHaveLength(1);
    expect(out.changed[0]!.changes.map(c => c.field)).toContain("xy");
    expect(out.changed[0]!.base_pointer).toBe("/0");
    expect(out.changed[0]!.current_pointer).toBe("/0");
  });

  it("무시한 필드는 결과에 공개한다", () => {
    const out = compareResults({
      base: side({ rows: [MODIFIED] }), current: side({ rows: [STAGED] }), options: { ignore_fields: ["xy", "index", "worktree"] },
    });
    expect(out.changed).toHaveLength(0);
    expect(out.ignored_fields).toEqual(["xy", "index", "worktree"]);
  });

  it("추가와 삭제를 구분한다", () => {
    const out = compareResults({ base: side({ rows: [] }), current: side({ rows: [MODIFIED] }) });
    expect(out.added).toHaveLength(1);
    expect(out.removed).toHaveLength(0);
  });

  it("다른 대상은 거절한다", () => {
    const out = compareResults({
      base: side(), current: side({ fingerprint: fingerprint({ cwd_real: "/other" }) }),
    });
    expect(out.comparable).toBe(false);
    expect(out.refusal_reason).toBe("different_subject");
  });

  it("ps 는 보류한다", () => {
    const out = compareResults({
      base:   side({ fingerprint: fingerprint({ cmd: "ps", parser_id: "ps" }) }),
      current: side({ fingerprint: fingerprint({ cmd: "ps", parser_id: "ps" }) }),
    });
    expect(out.comparable).toBe(false);
    expect(out.refusal_reason).toBe("domain_withheld");
  });

  it("비교 규칙이 없는 명령은 거절한다", () => {
    const out = compareResults({
      base:   side({ fingerprint: fingerprint({ cmd: "ls", parser_id: "ls" }) }),
      current: side({ fingerprint: fingerprint({ cmd: "ls", parser_id: "ls" }) }),
    });
    expect(out.refusal_reason).toBe("domain_unsupported");
  });

  it("identity 를 확정할 수 없으면 행을 빼고 그 사실을 밝힌다", () => {
    /** kubectl 도메인이어야 uid 규칙이 걸린다 */
    const k8s = (over: Partial<Fingerprint>) => fingerprint({ cmd: "kubectl", parser_id: "kubectl", ...over });
    const out = compareResults({
      base:    side({ fingerprint: k8s({}), rows: [{ kind: "Pod", name: "p", metadata: {} }] }),
      current: side({ fingerprint: k8s({ content_hash: "h2" }), rows: [{ kind: "Pod", name: "p", metadata: { uid: "u1" } }] }),
    });
    expect(out.added).toHaveLength(0);
    expect(out.removed).toHaveLength(0);
    expect(out.partial.withheld_reasons.join(" ")).toMatch(/uid|recreated/);
  });

  it("identity 를 확정하지 못한 행이 있으면 비교가 성립했다고 말하지 않는다", () => {
    /**
     * 회귀: 보류 사유를 남기면서 comparable=true 를 돌려주면 어느 쪽을 믿어야 하는지 알 수 없다.
     * 비교가 성립하지 않았다는 사실과 보류 사유가 함께 있어야 한다.
     */
    const k8s = (over: Partial<Fingerprint>) => fingerprint({ cmd: "kubectl", parser_id: "kubectl", ...over });
    const out = compareResults({
      base:    side({ fingerprint: k8s({}), rows: [{ kind: "Pod", name: "p", metadata: {} }] }),
      current: side({ fingerprint: k8s({ content_hash: "h2" }), rows: [{ kind: "Pod", name: "p", metadata: { uid: "u1" } }] }),
    });
    expect(out.comparable).toBe(false);
    expect(out.refusals.comparable).toBe(false);
    expect(out.partial.withheld_reasons.join(" ")).toMatch(/withheld rather than reported as complete/);
  });

  it("중복 identity 는 오류다 — 조용히 한 행을 버리지 않는다", () => {
    const out = compareResults({
      base:   side({ rows: [MODIFIED, { ...MODIFIED }] }),
      current: side({ rows: [MODIFIED] }),
    });
    expect(out.comparable).toBe(false);
    expect(out.refusal_reason).toBe("duplicate_identity");
    expect(out.key_conflicts.length).toBeGreaterThan(0);
  });
});

describe("거짓 삭제 0", () => {
  it("현재 쪽이 불완전하면 없는 행을 삭제라고 말하지 않는다", () => {
    const out = compareResults({
      base:    side({ rows: [MODIFIED, { ...MODIFIED, path: "src/b.ts" }] }),
      current: side({ rows: [MODIFIED], incomplete: true, incompleteReasons: ["cut at the capture limit"] }),
    });
    expect(out.removed).toHaveLength(0);
    expect(out.partial.current_incomplete).toBe(true);
    expect(out.partial.withheld_reasons.join(" ")).toMatch(/withheld/);
  });

  it("기준 쪽이 불완전하면 추가도 삭제처럼 말하지 않는다", () => {
    const out = compareResults({
      base:    side({ rows: [], incomplete: true, incompleteReasons: ["cut"] }),
      current: side({ rows: [MODIFIED] }),
    });
    expect(out.added).toHaveLength(0);
    expect(out.partial.base_incomplete).toBe(true);
  });

  it("양쪽이 완전해야 삭제를 말한다", () => {
    const out = compareResults({
      base:    side({ rows: [MODIFIED, { ...MODIFIED, path: "src/b.ts" }] }),
      current: side({ rows: [MODIFIED] }),
    });
    expect(out.removed).toHaveLength(1);
  });
});

describe("문맥 불일치", () => {
  it("문맥이 다르면 strict 비교를 거절한다", () => {
    const base    = side({ fingerprint: fingerprint({ context: { cluster: "a" } }) });
    const current = side({ fingerprint: fingerprint({ context: { cluster: "b" }, content_hash: "h2" }) });
    expect(compareResults({ base, current }).refusals.compatibility).toBe("unknown");
    expect(compareResults({ base, current, strict: true }).comparable).toBe(false);
  });
});
