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

## 훅으로 연결하기

저장소에서 한 번 실행하면 Bash 호출과 세션 종료가 Parism을 거친다.

```bash
npx @nerdvana/parism hook install                 # .claude/settings.json
npx @nerdvana/parism hook install --scope user    # ~/.claude/settings.json
```

- `PreToolUse`(Bash): Parism 대상 명령을 `parism exec`로 바꿔 실행한다. 결과는 파싱한 JSON이나 원문 가운데 짧은 쪽이고, 시험 러너·린터는 모든 실패가 든 보고서다. 허용된 명령에 금지 인자를 쓰면(`git push`) 사유와 함께 막는다.
- `SessionStart`: 세션 시작 시점의 작업 공간 상태를 남긴다.
- `Stop`: 시작 이후 작업 공간이 바뀌었는데 지금 상태에서 통과한 시험·빌드 영수증이 없으면 종료를 막고 무엇을 해야 하는지 알린다.

훅이 읽는 설정은 `~/.parism/hook.config.json`이다. 설치기가 build 프로필, 영수증 켜기, 리댁션 켜기, `allowed_paths`는 이 저장소로 만든다. 완료 조건을 특정 명령으로 정하려면 그 파일에 `verify.commands`를 둔다.

```json
{ "verify": { "commands": [["npx", "vitest", "run"], ["npx", "tsc", "--noEmit"]] } }
```

바꾼 명령이 모두 읽기 전용이면 묻지 않고 실행한다(`permissionDecision: "allow"`). 파일·프로세스·네트워크를 건드리는 명령은 판정을 비워 두어 Claude Code의 권한 규칙과 모드를 따른다. 같은 파일에 `"hook": { "permission": "allow" }`를 두면 모두 묻지 않고, `"ask"`를 두면 모두 묻는다.

## 훅 없이 Stop 판정만 쓰기

`parism receipts check`를 Stop 훅으로 직접 등록할 수도 있다. 이때 에이전트는 완료 조건이 되는 명령을 Parism의 `run`으로 실행해야 영수증이 남는다.

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "parism receipts check 1>&2 || exit 2" }] }
    ]
  }
}
```

훅이 종료 코드 2로 끝나면 Claude Code는 종료를 막고 표준 오류의 내용을 에이전트에게 전달한다.

```
FAIL npx vitest run  [stale] the workspace changed after the run at 2026-11-11T09:12:03.000Z
ok   npx tsc --noEmit  [ok] passed at 2026-11-11T09:14:40.000Z
one or more required commands lack a passing, fresh receipt
```

## 참고

- [README.md](../../README.md) — Parism 개요
- [SPECIFICATION.md](../../SPECIFICATION.md) — 도구 계약
