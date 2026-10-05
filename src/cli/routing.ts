/**
 * argv 가 CLI 인지 MCP 서버인지 정하는 라우팅.
 *
 * ## 왜 이 목록이 위험한가
 *
 * `commander` 에 등록한 명령과 **실제로 라우팅되는 명령은 따로 관리**되고 있었다.
 * 두 목록이 어긋나면, 등록된 명령이 조용히 **다른 프로그램으로 넘어간다.**
 *
 * 실제로 그렇게 못했다. `eval` 은 `parism --help` 에 정상적으로 광고되었는데
 * 라우팅 목록에 없어서, `parism eval ...` 은 **평범한 명령처럼 아무 일도 하지 않은 채
 * MCP 서버를 띄우고 종료했다.** 사용자는 exit 0 을 보므로 성공으로 읽는다.
 *
 *   - 실측: `node dist/index.js eval parse-error` → 출력 0바이트, exit 0, 0.42초.
 *   - 실측: 같은 명령에 stdin 을 열어두면 **종료하지 않는다**(exit 124) —
 *     평가가 아니라 MCP 서버가 떴다는 뜻이다. 같은 조건의 `inspect` 는 즉시 끝난다.
 *
 * 그래서 목록을 여기서 단일 출처로 만들고(`cli.ts` 와 같은 파일을 쓴다),
 * **commander 에 등록된 명령과 대조하는 시험**을 둔다. 어긋나면 시험이 먼저 깨진다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-05
 */

/**
 * CLI 로 라우팅할 첫 인자.
 *
 * `-` 로 시작하는 플래그와 `help` 도 포함한다 — 그것들 역시 CLI 경로로 가야 한다.
 * MCP 서버로 가면 표준 입력이 JSON-RPC 줄이 되기를 기다리며 멈춘다.
 */
export const CLI_COMMANDS: readonly string[] = [
  "capture", "init-parser", "test", "add", "inspect", "eval",
  "help", "--help", "-h", "--version", "-V",
];

/** 이 인자로 시작하면 CLI 다. 그 외에는 MCP 서버다. */
export function isCliMode(argv: readonly string[] = process.argv): boolean {
  const firstArg = argv[2];
  return firstArg != null && CLI_COMMANDS.includes(firstArg);
}
