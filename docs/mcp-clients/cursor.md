# Cursor — Parism MCP 설정

작성일: 2026-04-15
대상 버전: Parism v0.6.0-alpha.2

## 개요

Cursor 는 전역 또는 프로젝트 로컬 `mcp.json` 으로 MCP 서버를 등록한다. stdio 프로토콜을 지원한다.

## 설정 파일 위치

- 전역: `~/.cursor/mcp.json`
- 프로젝트 로컬: `<프로젝트 루트>/.cursor/mcp.json`

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

Cursor 재시작 후 Composer 패널에서 parism 도구가 사용 가능한지 확인한다.

## 주의사항

프로젝트별 `.cursor/mcp.json` 을 사용하면 해당 프로젝트를 열었을 때만 Parism 이 로드된다. 전역 등록이 필요하면 `~/.cursor/mcp.json` 에 추가한다.

## 참고

- [README.md](../../README.md) — Parism 개요
- [SPECIFICATION.md](../../SPECIFICATION.md) — `run` / `run_paged` 도구 계약
