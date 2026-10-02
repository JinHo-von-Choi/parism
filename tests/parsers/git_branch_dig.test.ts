import { describe, it, expect } from "vitest";
import { parseGitBranch } from "../../src/parsers/git/branch.js";
import { parseDig }        from "../../src/parsers/network/dig.js";

describe("parseGitBranch()", () => {
  const raw = [
    "* main                abc1234 [origin/main] latest commit",
    "  feature/auth        def5678 [origin/feature/auth: ahead 2] add auth",
    "  local-only          fab9012 local work",
  ].join("\n");

  it("브랜치 목록을 파싱한다", () => {
    const result = parseGitBranch("git", ["branch", "-vv"], raw) as {
      branches: Array<{ name: string; current: boolean; upstream: string | null; ahead: number }>;
    };
    expect(result.branches).toHaveLength(3);
    expect(result.branches[0].current).toBe(true);
    expect(result.branches[0].name).toBe("main");
    expect(result.branches[1].upstream).toBe("origin/feature/auth");
    expect(result.branches[1].ahead).toBe(2);
    expect(result.branches[2].upstream).toBeNull();
  });
});

describe("parseGitBranch() 항목 모양", () => {
  it("detached HEAD 항목을 현재 항목으로 담는다", () => {
    const raw = [
      "* (HEAD detached at ada9e43) ada9e43 first",
      "  main                       5701e61 second",
    ].join("\n");
    const r = parseGitBranch("git", ["branch", "-v"], raw);
    expect(r.branches).toHaveLength(2);
    expect(r.branches[0]).toMatchObject({ current: true, name: "(HEAD detached at ada9e43)", hash: "ada9e43", message: "first", detached: true });
  });

  it("-v의 상태만 있는 대괄호는 상류 이름으로 읽지 않는다", () => {
    const raw = ["* main 1111111 [ahead 2, behind 1] work", "  old  2222222 [gone] stale"].join("\n");
    const r = parseGitBranch("git", ["branch", "-v"], raw);
    expect(r.branches[0]).toMatchObject({ upstream: null, ahead: 2, behind: 1, message: "work" });
    expect(r.branches[1]).toMatchObject({ upstream: null, ahead: 0, behind: 0, message: "stale" });
  });

  it("-v에서 대괄호로 시작하는 제목은 제목으로 둔다", () => {
    const r = parseGitBranch("git", ["branch", "-v"], "  topic 3333333 [WIP] draft: x");
    expect(r.branches[0]).toMatchObject({ upstream: null, message: "[WIP] draft: x" });
  });

  it("-vv에서는 대괄호를 상류 이름으로 읽는다", () => {
    const r = parseGitBranch("git", ["branch", "-vv"], "* main 1111111 [origin/main: ahead 1] work");
    expect(r.branches[0]).toMatchObject({ upstream: "origin/main", ahead: 1, message: "work" });
  });

  it("-a의 심볼릭 참조 줄은 points_to를 담고 해시는 비운다", () => {
    const raw = ["* main 1111111 first", "  remotes/origin/HEAD -> origin/main", "  remotes/origin/main 1111111 first"].join("\n");
    const r = parseGitBranch("git", ["branch", "-av"], raw);
    expect(r.branches).toHaveLength(3);
    expect(r.branches[1]).toMatchObject({ name: "remotes/origin/HEAD", points_to: "origin/main", hash: "" });
  });

  it("다른 작업 트리에서 쓰는 브랜치(+)를 표시한다", () => {
    const r = parseGitBranch("git", ["branch", "-v"], "+ wt 4444444 other tree");
    expect(r.branches[0]).toMatchObject({ name: "wt", current: false, worktree: true });
  });
});

describe("parseDig()", () => {
  const raw = [
    "; <<>> DiG 9.18.1 <<>> google.com",
    ";; QUESTION SECTION:",
    ";google.com.			IN	A",
    "",
    ";; ANSWER SECTION:",
    "google.com.		300	IN	A	142.250.196.110",
    "google.com.		300	IN	A	142.250.196.111",
    "",
    ";; Query time: 12 msec",
    ";; SERVER: 8.8.8.8#53(8.8.8.8)",
  ].join("\n");

  it("DNS 응답을 파싱한다", () => {
    const result = parseDig("dig", ["google.com"], raw);
    expect(result.query).toBe("google.com");
    expect(result.answers).toHaveLength(2);
    expect(result.answers[0].type).toBe("A");
    expect(result.answers[0].value).toBe("142.250.196.110");
    expect(result.query_time_ms).toBe(12);
  });

  it("AUTHORITY SECTION 등장 시 inAnswer를 false로 전환", () => {
    const withAuth = [
      ";; ANSWER SECTION:",
      "example.com.	300	IN	A	93.184.216.34",
      ";; AUTHORITY SECTION:",
      "example.com.	300	IN	NS	a.iana-servers.net.",
      ";; ADDITIONAL SECTION:",
    ].join("\n");
    const result = parseDig("dig", ["example.com", "NS"], withAuth);
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].name).toBe("example.com");
  });
});
