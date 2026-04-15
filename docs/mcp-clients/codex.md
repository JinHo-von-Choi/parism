# Codex CLI — Parism MCP 설정

작성일: 2026-04-15
대상 버전: Parism v1.0.0

## 개요

OpenAI Codex CLI 는 `~/.codex/config.toml` 에서 MCP 서버 목록을 읽는다. v0.6.0 이후 MCP 기능이 stable 로 승격되었다.

## 설정 파일 위치

- `~/.codex/config.toml`

## 설정 예시

```toml
[mcp_servers.parism]
command = "node"
args    = ["/path/to/parism/dist/index.js"]
cwd     = "/path/to/parism"
```

## 검증

`codex mcp list` 서브커맨드로 parism 이 등록됐는지 확인한다.

## 주의사항

`codex mcp` 서브커맨드로 서버를 관리할 수 있다. TOML 직접 편집과 서브커맨드 둘 다 동일한 설정 파일을 수정하므로 중복 등록에 주의한다.

## 참고

- [README.md](../../README.md) — Parism 개요
- [SPECIFICATION.md](../../SPECIFICATION.md) — `run` / `run_paged` 도구 계약
