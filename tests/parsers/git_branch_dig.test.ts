import { describe, it, expect } from "vitest";
import { parseGitBranch } from "../../src/parsers/git/branch.js";
import { parseDig }        from "../../src/parsers/network/dig.js";
import { createRegistry }  from "../../src/parsers/index.js";

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
    expect(r.branches[1]).toMatchObject({ upstream: null, ahead: null, behind: null, upstream_gone: true, message: "stale" });
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

  it("열을 맞춘 심볼릭 참조 줄(-a -v, -r -v)도 points_to를 담는다", () => {
    const raw = [
      "* main                       7434367 [origin/main] fourth",
      "  remotes/origin/HEAD        -> origin/main",
      "  remotes/origin/main        7434367 fourth",
    ].join("\n") + "\n";
    const r = parseGitBranch("git", ["branch", "-avv"], raw);
    expect(r.branches).toHaveLength(3);
    expect(r.branches[1]).toEqual({ current: false, name: "remotes/origin/HEAD", hash: "", upstream: null, ahead: 0, behind: 0, message: "", points_to: "origin/main" });
    const remote = parseGitBranch("git", ["branch", "-r", "-v"], "  origin/HEAD        -> origin/main\n  origin/kept-branch 7434367 fourth\n");
    expect(remote.branches.map(b => [b.name, b.points_to ?? null, b.hash])).toEqual([["origin/HEAD", "origin/main", ""], ["origin/kept-branch", null, "7434367"]]);
  });

  it("사라진 상류(gone)는 upstream_gone이며 앞섬과 뒤짐은 알 수 없어 null이다", () => {
    const vv = parseGitBranch("git", ["branch", "-vv"], "  gone-branch 7434367 [origin/gone-branch: gone] fourth\n  kept-branch de92e81 [origin/kept-branch: ahead 1] work\n");
    expect(vv.branches[0]).toEqual({ current: false, name: "gone-branch", hash: "7434367", upstream: "origin/gone-branch", ahead: null, behind: null, upstream_gone: true, message: "fourth" });
    expect(vv.branches[1]).toMatchObject({ upstream: "origin/kept-branch", ahead: 1, behind: 0 });
    expect(vv.branches[1]).not.toHaveProperty("upstream_gone");
    const v = parseGitBranch("git", ["branch", "-v"], "  gone-branch 7434367 [gone] fourth\n");
    expect(v.branches[0]).toMatchObject({ upstream: null, ahead: null, behind: null, upstream_gone: true, message: "fourth" });
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

  it("QUESTION 섹션이 없으면 query_type을 비워 둔다", () => {
    const raw = [";; ANSWER SECTION:", "example.com.\t51\tIN\tA\t104.20.23.154", ";; Query time: 0 msec"].join("\n");
    const result = parseDig("dig", ["+noquestion", "example.com"], raw);
    expect(result).toMatchObject({ query: "", query_type: "" });
    expect(result.answers).toHaveLength(1);
  });

  it("+noall +answer 출력은 머리말이 없으므로 모든 레코드를 답변으로 읽는다", () => {
    const raw = ["example.com.\t51\tIN\tA\t172.66.147.243", "example.com.\t51\tIN\tA\t104.20.23.154"].join("\n");
    expect(parseDig("dig", ["+noall", "+answer", "example.com"], raw).answers).toHaveLength(2);
  });

  it("+multiline의 괄호 레코드를 한 값으로 잇고 주석을 버린다", () => {
    const raw = [
      ";; ANSWER SECTION:",
      "example.com.\t\t1551 IN\tSOA elliott.ns.cloudflare.com. dns.cloudflare.com. (",
      "\t\t\t\t2416374680 ; serial",
      "\t\t\t\t10000      ; refresh (2 hours 46 minutes 40 seconds)",
      "\t\t\t\t1800       ; minimum (30 minutes)",
      "\t\t\t\t)",
      "",
      ";; Query time: 0 msec",
    ].join("\n");
    const result = parseDig("dig", ["+multiline", "example.com", "SOA"], raw);
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0]!.value).toBe("elliott.ns.cloudflare.com. dns.cloudflare.com. ( 2416374680 10000 1800 )");
    expect(result.query_time_ms).toBe(0);
  });

  it("쿼리가 여럿이면 응답마다 query, query_type, answers, query_time_ms를 queries에 나누고 맨 위는 첫 응답이다", () => {
    const raw = [
      "; <<>> DiG 9.18.39 <<>> example.com example.org MX",
      ";; global options: +cmd",
      ";; Got answer:",
      ";; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 10749",
      ";; QUESTION SECTION:",
      ";example.com.\t\t\tIN\tA",
      "",
      ";; ANSWER SECTION:",
      "example.com.\t\t300\tIN\tA\t172.66.147.243",
      "example.com.\t\t300\tIN\tA\t104.20.23.154",
      "",
      ";; Query time: 41 msec",
      ";; SERVER: 127.0.0.53#53(127.0.0.53) (UDP)",
      "",
      ";; Got answer:",
      ";; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 5167",
      ";; QUESTION SECTION:",
      ";example.org.\t\t\tIN\tMX",
      "",
      ";; ANSWER SECTION:",
      "example.org.\t\t300\tIN\tMX\t0 .",
      "",
      ";; Query time: 43 msec",
      ";; SERVER: 127.0.0.1#53(127.0.0.1) (UDP)",
      "",
    ].join("\n");
    const r = parseDig("dig", ["example.com", "example.org", "MX"], raw);
    expect(r).toMatchObject({ query: "example.com", query_type: "A", query_time_ms: 41, server: "127.0.0.53#53(127.0.0.53)" });
    expect(r.answers).toHaveLength(2);
    expect(r.queries).toHaveLength(2);
    expect(r.queries![1]).toEqual({
      query: "example.org", query_type: "MX", query_time_ms: 43, server: "127.0.0.1#53(127.0.0.1)",
      answers: [{ name: "example.org", ttl: 300, class: "IN", type: "MX", value: "0 ." }],
    });
    expect(parseDig("dig", ["example.com"], raw.split("\n\n;; Got answer:")[0]!).queries).toBeUndefined();
  });

  it("루트 이름(.)과 루트를 가리키는 값은 점을 지킨다", () => {
    const raw = [";; QUESTION SECTION:", ";.\t\t\t\tIN\tNS", "", ";; ANSWER SECTION:", ".\t\t\t518400\tIN\tNS\ta.root-servers.net.", "example.org.\t300\tIN\tMX\t0 ."].join("\n");
    const r   = parseDig("dig", [".", "NS"], raw);
    expect(r.query).toBe(".");
    expect(r.answers.map(a => [a.name, a.value])).toEqual([[".", "a.root-servers.net"], ["example.org", "0 ."]]);
  });

  it("TXT 값의 연속 공백을 보존한다", () => {
    const raw = [";; ANSWER SECTION:", "example.com.\t60\tIN\tTXT\t\"v=spf1  -all\""].join("\n");
    expect(parseDig("dig", ["example.com", "TXT"], raw).answers[0]!.value).toBe("\"v=spf1  -all\"");
  });
});

describe("dig 대기와 재시도 옵션", () => {
  it("+time=N, +tries=N, +retry=N은 출력 형식을 바꾸지 않아 받고, 숫자 값만 받는다", () => {
    const reg = createRegistry();
    for (const args of [["+time=2", "example.com"], ["+tries=1", "example.com"], ["+retry=1", "example.com"], ["+time=3", "+tries=2", "example.com", "MX"]]) {
      expect(reg.parse("dig", args, "").parse_error?.reason).not.toBe("unsupported_format");
    }
    for (const args of [["+time", "example.com"], ["+time=x", "example.com"], ["+tries=", "example.com"]]) {
      expect(reg.parse("dig", args, "").parse_error?.reason).toBe("unsupported_format");
    }
  });

  it("+time과 +tries를 준 출력의 답변을 읽는다", () => {
    const raw = [
      "",
      "; <<>> DiG 9.18.39-0ubuntu0.24.04.7-Ubuntu <<>> +time=3 +tries=2 example.com MX",
      ";; global options: +cmd",
      ";; Got answer:",
      ";; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 65326",
      ";; flags: qr rd ra; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1",
      "",
      ";; QUESTION SECTION:",
      ";example.com.\t\t\tIN\tMX",
      "",
      ";; ANSWER SECTION:",
      "example.com.\t\t300\tIN\tMX\t0 .",
      "",
      ";; Query time: 6 msec",
      ";; SERVER: 127.0.0.53#53(127.0.0.53) (UDP)",
      "",
    ].join("\n");
    const r = createRegistry().parse("dig", ["+time=3", "+tries=2", "example.com", "MX"], raw);
    expect(r.parse_error).toBeUndefined();
    expect(r.parsed).toMatchObject({ query: "example.com", query_type: "MX", query_time_ms: 6, answers: [{ name: "example.com", ttl: 300, class: "IN", type: "MX", value: "0 ." }] });
  });
});
