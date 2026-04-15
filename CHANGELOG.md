# Changelog

모든 주요 변경사항은 이 파일에 기록된다.

이 프로젝트는 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따르며,
포맷은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)을 따른다.

## [Unreleased]

## [0.6.0-alpha.2] - 2026-04-15

### Added
- `docs/mcp-clients/` 디렉터리 — Claude Desktop, Claude Code, Cursor, Gemini CLI, Codex CLI, GitHub Copilot CLI 6개 클라이언트 설정 가이드
- `ResponseEnvelope.guard_error?` 필드 선언 (하위 호환 유지, `failure` 필드가 권위 필드)
- `CHANGELOG.md` 에 v0.1 → v0.6.0-alpha.1 변경 이력 누적 기록

### Changed
- `MCP_INSTRUCTIONS` 에 v0.6 기능 반영 — `failure` 필드, `output_redaction_enabled`, `strict_schemas` 안내 추가 (1,496 chars, 1,500 limit 내)
- `README.md` 에 Guard 응답 예시 `failure` 필드 병기, `prism.config.json` 예시를 `guard.secrets` / `parsers.strict_schemas` 스키마로 교체, 라이브러리 모드 섹션 확장 (+47줄)
- `README.md` 에서 Claude Desktop / Cursor 개별 연동 섹션을 `docs/mcp-clients/` 로 분리하고 단일 표로 consolidation
- `SECURITY.md` 에 `failure.kind: "guard"` 권위 필드 명시, 참고 문서 블록 추가
- `SPECIFICATION.md` 변경이력 v0.6 행의 "대안" 셀에 구체적 철회 이력 기록
- `src/server.ts` `buildRunResult` / `buildPagedResult` 의 `includeDiff` 기본값을 `true` → `false` 로 정정 (@internal test helpers, MCP 도구 기본값과 일치)
- `src/facade/engine.ts` 의 `as unknown as ResponseEnvelope` 캐스트 제거

### Fixed
- `src/config/loader.ts` 의 `guard.env_secret_patterns` deprecation 주석이 `v0.6.0 제거 예정` 으로 잘못 표기되어 있던 것을 `v0.7.0 제거 예정` 으로 정정

## [0.6.0-alpha.1] - 2026-04-15

### Added
- `ResponseEnvelope.failure` 통합 실패 필드 (kind: `guard` / `exec` / `parse` / `config`)
- `guard.secrets` 설정 섹션 통합 (`env_patterns`, `output_patterns`, `output_redaction_enabled`)
- Zod 기반 `ParserPack` 스키마 계약, `config.parsers.strict_schemas` opt-in 런타임 검증
- `src/engine/redactor.ts` — 출력 시크릿 레덕션 레이어 (파싱 후 직렬화 전 단계 적용)
- `ParismEngine` 라이브러리 파사드 (`src/facade/engine.ts`), `createEngine()` 팩토리
- `package.json` `./engine` subpath export — 라이브러리 모드 개방
- `SECURITY.md` — 위협 모델, 4겹 방어선 한계, 신뢰할 수 없는 입력 격리 권고
- `SPECIFICATION.md` — 단일 소스 설계 스펙 (v0.1 → v0.6 변경 이력 포함)

### Changed
- `src/server.ts` 비즈니스 로직을 `ParismEngine` 에 위임 (237 → 129 LOC)
- `package.json` version 0.5.0 → 0.6.0-alpha.1
- 벤치마크 러너는 기존 `defaultRegistry` 경로 유지 (순수 파서 속도 측정 보존)

### Deprecated
- `guard.env_secret_patterns` → `guard.secrets.env_patterns` (v0.7.0 제거 예정)

### Security
- `output_redaction_enabled` opt-in: 활성 시 stdout/stderr raw 필드에 7 개 기본 패턴 (`sk-*`, `ghp_*`, `gho_*`, `glpat-*`, `AKIA*`, `xox[baprs]-*`, `Bearer *`) 을 `[REDACTED]` 로 치환

## [0.5.0] - 2026-03-28

### Added
- ParserPack SDK 도입, CLI 5 개 명령어 (`capture`, `init-parser`, `test`, `add`, `inspect`)
- `createRegistry()` DI 팩토리 (기존 `defaultRegistry` 싱글턴은 deprecated 유지)
- 외부 파서 자동 로더 (`~/.parism/parsers/`)

## [0.4.0] - 2026-03-12

### Changed
- 비판적 수용 피드백 반영: 경로 가드 강화, 스냅샷 성능, 문서 정합성, 파서 실패 관측 개선

## [0.3.0]

### Added
- `run_paged` 도구 및 페이지네이션 (`page_info.total_lines`, `has_next`)

## [0.2.0]

### Added
- Guard 4 겹 방어선 (화이트리스트 / 경로 / 인젝션 패턴 / 인자 플래그)

## [0.1.0] - 2026-03-06

### Added
- 초기 릴리스: MCP 서버 + execFile 게이트웨이, 내장 파서 카탈로그
