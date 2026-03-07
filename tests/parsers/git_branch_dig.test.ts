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
