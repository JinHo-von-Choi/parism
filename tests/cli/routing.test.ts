/**
 * CLI 라우팅 시험 — 결함: `parism eval` 이 조용히 아무것도 하지 않았다.
 *
 * `commander` 에 등록된 명령과 `process.argv[2]` 를 실제로 라우팅하는 목록이 따로 관리되었다.
 * `eval` 이 앞에만 있었고 뒤에는 없었고, 그래서 `parism eval ...` 은
 * **MCP 서버를 띄우고 exit 0 으로 끝났다.** help 에는 정상적으로 광고되어 있었다.
 *
 * 이 시험은 그 **구조**를 막는다. "지금 `eval` 이 고쳐졌다" 를 확인하는 것이 아니라
 * 앞으로 명령을 하나 추가할 때 라우팅 목록을 잊지 못하게 하는 것이다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

import { describe, it, expect } from "vitest";
import { CLI_COMMANDS, isCliMode } from "../../src/cli/routing.js";
import { createCli }             from "../../src/cli.js";

/** 플래그·헬프 같은 하위 명령이 아닌 진입점들. */
const NON_COMMAND_ENTRIES = new Set(["help", "--help", "-h", "--version", "-V"]);

describe("CLI 라우팅", () => {
  it("등록된 모든 명령이 실제 라우팅 대상이다", () => {
    const program = createCli();
    /** commander 가 실제로 등록한 명령 이름 */
    const registered = program.commands.map(c => c.name());

    const unrouted = registered.filter(name => !CLI_COMMANDS.includes(name));
    expect(
      unrouted,
      `이 명령(들)은 --help 에 보이는데 ${CLI_COMMANDS.length}개 라우팅 목록에 없다. ` +
      `등록만 하고 argv 라우팅을 빠뜨리면 그 명령은 조용히 MCP 서버로 넘어간다.`,
    ).toEqual([]);
  });

  it("라우팅 목록에 남는 명령이 없다", () => {
    const program = createCli();
    const registered = new Set(program.commands.map(c => c.name()));
    /** 목록에 있는 비-명령 진입점은 따로 인정한다 */
    const extra = CLI_COMMANDS.filter(name => !registered.has(name) && !NON_COMMAND_ENTRIES.has(name));
    expect(extra, "라우팅 목록에 있지만 등록되지 않은 항목이 있다 — 어느 쪽이 맞는지 확인해야 한다").toEqual([]);
  });

  it("등록된 명령 이름이 모두 한 글자 대소문자가 정확히 일치한다", () => {
    /** 대소문자나 하이픈이 어긋나면 조용히 라우팅되지 않는다. */
    const program = createCli();
    for (const name of CLI_COMMANDS) {
      if (NON_COMMAND_ENTRIES.has(name)) continue;
      const found = program.commands.some(c => c.name() === name);
      expect(found, `라우팅 목록의 '${name}' 에 대응하는 명령이 없다`).toBe(true);
    }
  });

  it("argv 첫 인자로 CLI 여부를 판정한다", () => {
    expect(isCliMode(["node", "parism", "eval", "parse-error"])).toBe(true);
    expect(isCliMode(["node", "parism", "inspect", "ls"])).toBe(true);
    expect(isCliMode(["node", "parism", "--help"])).toBe(true);
  });

  it("MCP 서버로 보내는 입력을 CLI 로 착각하지 않는다", () => {
    /** 인자가 없으면 MCP 다. 이 경로가 틀리면 서버가 시작되지 않는다. */
    expect(isCliMode(["node", "parism"])).toBe(false);
  });
});
