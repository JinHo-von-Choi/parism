# Claude Code — Parism MCP 설정

## 개요

Claude Code 는 전역 또는 프로젝트 로컬 JSON 파일로 MCP 서버를 등록한다. stdio 프로토콜을 완전히 지원한다.

## 설정 파일 위치

- 전역: `~/.claude/mcp.json`
- 프로젝트 로컬: `<프로젝트 루트>/.mcp.json`

## 설정 예시

```json
{
  "mcpServers": {
    "parism": {
      "command": "node",
      "args": ["/path/to/parism/dist/index.js"],
      "cwd": "/path/to/parism"
    }
  }
}
```

## 검증

새 Claude Code 세션을 시작한 뒤 `/mcp` 명령으로 parism 서버가 목록에 나타나면 연결 성공이다.

## 주의사항

`cwd` 는 프로젝트별로 다르게 지정할 수 있다. `prism.config.json` 은 `cwd` 기준으로 로드되므로 경로를 정확히 지정해야 한다.

## 완료 보고 검증 (Stop 훅)

에이전트가 작업을 끝내려 할 때, 정해 둔 명령이 현재 작업 공간 상태에서 통과했는지 확인한다.

1. 호스트 설정 `~/.parism/prism.config.json`에서 영수증을 켜고 완료 조건이 되는 명령을 적는다. 러너를 Parism으로 실행할 수 있도록 `npx`를 허용하고 build 프로필을 쓴다.

```json
{
  "guard":    { "profile": "build", "allowed_commands": ["ls", "git", "grep", "npx"] },
  "receipts": { "enabled": true },
  "verify":   { "commands": [["npx", "vitest", "run"], ["npx", "tsc", "--noEmit"]] }
}
```

2. `~/.claude/settings.json`(또는 프로젝트의 `.claude/settings.json`)에 Stop 훅을 등록한다.

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "parism receipts check 1>&2 || exit 2" }] }
    ]
  }
}
```

훅이 종료 코드 2로 끝나면 Claude Code는 종료를 막고 표준 오류의 내용을 에이전트에게 전달한다. 에이전트는 어느 명령이 `missing`, `failed`, `stale`인지 보고 그 명령을 Parism으로 다시 실행한다.

```
FAIL npx vitest run  [stale] the workspace changed after the run at 2026-11-11T09:12:03.000Z
ok   npx tsc --noEmit  [ok] passed at 2026-11-11T09:14:40.000Z
one or more required commands lack a passing, fresh receipt
```

에이전트는 완료 조건이 되는 명령을 셸 도구가 아니라 Parism의 `run`으로 실행해야 영수증이 남는다. `verify.commands`에 적은 인자와 같은 인자로 실행한다. `machine_format: true`로 덧붙은 인자는 달라도 같은 명령으로 본다.

시험이 통과할 수 없는 상태에서는 훅이 종료를 계속 막는다. 훅 입력의 `stop_hook_active`를 보고 한 번만 막도록 감싸는 스크립트를 쓸 수 있다.

## 참고

- [README.md](../../README.md) — Parism 개요
- [SPECIFICATION.md](../../SPECIFICATION.md) — `run` / `run_paged` 도구 계약
