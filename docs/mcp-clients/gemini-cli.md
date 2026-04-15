# Gemini CLI — Parism MCP 설정

작성일: 2026-04-15
대상 버전: Parism v1.0.0

## 개요

Gemini CLI 는 `gemini mcp add` 명령 또는 `~/.gemini/settings.json` 직접 편집으로 MCP 서버를 등록한다.

## 설정 파일 위치

- `~/.gemini/settings.json`

## 설정 예시

CLI 명령으로 등록:

```bash
gemini mcp add parism node /path/to/parism/dist/index.js --cwd /path/to/parism
```

또는 `~/.gemini/settings.json` 에 직접 추가:

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

`gemini mcp list` 명령으로 parism 이 목록에 나타나면 등록 성공이다.

## 주의사항

Gemini CLI 는 MCP 프로토콜 버전에 민감하다. Parism 의 `@modelcontextprotocol/sdk` 버전이 현재 사용 중인 Gemini CLI 와 호환되는지 사전에 확인한다.

## 참고

- [README.md](../../README.md) — Parism 개요
- [SPECIFICATION.md](../../SPECIFICATION.md) — `run` / `run_paged` 도구 계약
