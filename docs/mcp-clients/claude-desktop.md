# Claude Desktop — Parism MCP 설정

작성일: 2026-04-15
대상 버전: Parism v1.0.0

## 개요

Claude Desktop 은 `claude_desktop_config.json` 을 통해 MCP 서버를 등록한다. Parism 은 stdio 프로토콜로 연결된다.

## 설정 파일 위치

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

## 설정 예시

```json
{
  "mcpServers": {
    "parism": {
      "command": "npx",
      "args": ["-y", "@nerdvana/parism"]
    }
  }
}
```

## 검증

Claude Desktop 재시작 후 채팅 입력창 하단에 parism 도구 아이콘이 표시되면 연결 성공이다.

## 주의사항

첫 실행 시 `npx` 가 패키지를 다운로드하는 지연이 발생한다. 프로덕션 환경에서는 `npm i -g @nerdvana/parism` 으로 사전 설치 후 `"command": "parism"` 으로 변경하는 것을 권장한다.

## 참고

- [README.md](../../README.md) — Parism 개요
- [SPECIFICATION.md](../../SPECIFICATION.md) — `run` / `run_paged` 도구 계약
