# Claude Code — Parism MCP 설정

작성일: 2026-04-15
대상 버전: Parism v1.0.0

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

## 참고

- [README.md](../../README.md) — Parism 개요
- [SPECIFICATION.md](../../SPECIFICATION.md) — `run` / `run_paged` 도구 계약
