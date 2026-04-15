# GitHub Copilot CLI — Parism MCP 설정

작성일: 2026-04-15
대상 버전: Parism v0.6.0-alpha.2

## 개요

GitHub Copilot CLI 는 `~/.copilot/mcp-config.json` 또는 `--additional-mcp-config` 플래그로 MCP 서버를 등록한다.

## 설정 파일 위치

- 전역: `~/.copilot/mcp-config.json`
- 세션별: `--additional-mcp-config /path/to/config.json` 플래그로 주입

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

`gh copilot explain "list files"` 등 명령 실행 후 parism 도구가 호출 가능한 상태인지 확인한다.

## 주의사항

`~/.copilot/mcp-config.json` 파일이 없으면 직접 생성한다. `--additional-mcp-config` 플래그는 세션 단위로만 적용되며 전역 파일에 영향을 주지 않는다.

## 참고

- [README.md](../../README.md) — Parism 개요
- [SPECIFICATION.md](../../SPECIFICATION.md) — `run` / `run_paged` 도구 계약
