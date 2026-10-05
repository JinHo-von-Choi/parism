import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/parsers/index.js";

const reg   = createRegistry();
const parse = (cmd: string, args: string[], raw: string) =>
  reg.parse(cmd, args, raw, { maxItems: 0, format: "json" }, false);

describe("파서 실패 계약", () => {
  it("지원하지 않는 형식은 unsupported_format", () => {
    const r = parse("git", ["log"], "commit abc\nAuthor: a\n\n    msg\n");
    expect(r.parsed).toBeNull();
    expect(r.parse_error?.reason).toBe("unsupported_format");
  });
  it("git 앞의 전역 옵션을 건너뛰고 서브커맨드 형식을 판정한다", () => {
    const raw = "commit abc\nAuthor: a\n\n    msg\n";
    for (const args of [["--no-pager", "log"], ["-C", "repo", "log"], ["-c", "k=v", "log"]]) {
      expect(parse("git", args, raw).parse_error?.reason).toBe("unsupported_format");
    }
    const r = parse("git", ["--no-pager", "log", "--oneline"], "abc1234 first\n") as { parsed: { commits: { hash: string }[] } };
    expect(r.parsed.commits[0]).toMatchObject({ hash: "abc1234" });
  });
  it("한 줄도 인식하지 못하면 unrecognized_output", () => {
    const r = parse("ls", ["-l"], "this is not ls output\n");
    expect(r.parsed).toBeNull();
    expect(r.parse_error?.reason).toBe("unrecognized_output");
  });
  it("정상적으로 빈 출력은 실패가 아니다", () => {
    expect(parse("ls", ["-l"], "total 0\n").parse_error).toBeUndefined();
    expect(parse("git", ["status"], "On branch main\nnothing to commit, working tree clean\n").parse_error).toBeUndefined();
    expect(parse("docker", ["ps"], "CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES\n").parse_error).toBeUndefined();
    expect(parse("docker", ["images"], "REPOSITORY   TAG   IMAGE ID   CREATED   SIZE\n").parse_error).toBeUndefined();
    expect(parse("gh", ["pr", "list", "--json", "title"], "[]\n").parse_error).toBeUndefined();
  });

  it("docker images 손상 출력은 unrecognized_output", () => {
    const r = parse("docker", ["images"], "malformed output\n");
    expect(r.parsed).toBeNull();
    expect(r.parse_error?.reason).toBe("unrecognized_output");
  });
  it("systemctl list-units 단일 공백 열을 파싱한다", () => {
    const raw = "  UNIT LOAD ACTIVE SUB DESCRIPTION\n  cron.service loaded active running Regular background program processing daemon\n";
    const r = parse("systemctl", ["list-units"], raw) as { parsed: { units: { name: string; sub: string }[] } };
    expect(r.parsed.units[0]).toMatchObject({ name: "cron.service", sub: "running" });
  });
});

describe("숫자 0 값", () => {
  it("id -u, id -g의 0은 인식된 값이다", () => {
    expect(parse("id", ["-u"], "0\n")).toEqual({ parsed: { uid: 0 } });
    expect(parse("id", ["-g"], "0\n")).toEqual({ parsed: { gid: 0 } });
  });

  it("문자열이나 하위 값과 섞인 0만 있는 결과는 계속 unrecognized_output이다", () => {
    expect(parse("ls", ["-l"], "this is not ls output\n").parse_error?.reason).toBe("unrecognized_output");
    expect(parse("id", [], "not id output\n").parse_error?.reason).toBe("unrecognized_output");
    expect(parse("ping", [], "not ping output\n").parse_error?.reason).toBe("unrecognized_output");
    expect(parse("curl", ["-I", "https://example.com"], "not a header\n").parse_error?.reason).toBe("unrecognized_output");
    expect(parse("free", [], "not free output\n").parse_error?.reason).toBe("unrecognized_output");
  });
});
