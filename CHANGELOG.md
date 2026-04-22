# Changelog

모든 주요 변경사항은 이 파일에 기록된다.

이 프로젝트는 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따르며,
포맷은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)을 따른다.

## [Unreleased]

### Added
- `describe` MCP 도구 — 허용 명령, 사용 가능 파서, guard 제한, 버전 정보를 단일 호출로 반환. 에이전트 온보딩에 사용.
- `dry_run` MCP 도구 — 실제 실행 없이 guard 통과 여부만 확인. `would_pass`, `reason`, `message` 반환.
- `TelemetryField` 타입 (`types/envelope.ts`) — `guard_ms`, `exec_ms`, `parse_ms`, `redact_ms`, `total_ms`, `raw_bytes` 단계별 성능 메트릭.
- `PipelineTimer` 유틸 (`src/engine/telemetry.ts`) — `performance.now()` 기반 파이프라인 스톱워치.
- `PrismTelemetryConfig` 설정 (`config/loader.ts`) — `config.telemetry.enabled` 로 텔레메트리 활성화.
- `ResponseEnvelope.telemetry?` 필드 — `config.telemetry.enabled=true` 시에만 응답 봉투에 포함.
- `ParismEngine.describe()` / `ParismEngine.dryRun()` 메서드 — 라이브러리 모드에서도 사용 가능.
- `src/version.ts` — `PACKAGE_VERSION` 상수를 독립 모듈로 분리하여 순환 의존성 방지.

### Changed
- `MCP_INSTRUCTIONS` 에 `describe`, `dry_run` 도구 안내 추가 및 사용 순서 권고 (describe 먼저 호출).
- `ParismEngine.run()` 에 텔레메트리 계측 삽입 (guard/exec/parse/redact 각 단계 타이밍).

### Fixed
- `envToConfig()` — `PARISM_*` 환경 변수 미설정 시 빈 배열이 이전 설정 레이어를 덮어쓰던 버그 수정. `Partial<PrismGuardConfig>` 사용하여 실제 설정된 필드만 emit.
- Guard 인젝션 패턴 검사 — `args.join(" ")` 방식에서 개별 인자 순회로 변경하여 교차 경계 오탐 방지 (예: `["foo>", ">bar"]` → `>>` 오탐 제거).
- `PATH_TAKING_COMMANDS` 에 `git`, `docker`, `kubectl`, `cargo` 추가 — 경로 인자를 받는 명령의 경로 guard 검증 누락 수정.

## [1.0.0] - 2026-04-15

### Changed
- 첫 stable 릴리스. API 안정성 보장: Semantic Versioning 을 따르며, `ResponseEnvelope` 계약, `ParismEngine` 라이브러리 API, `ParserPack` SDK 는 v2.0.0 전까지 breaking change 없이 유지된다.
- v0.6.0-alpha.1 / v0.6.0-alpha.2 의 모든 개선 항목을 포함하며, alpha 레이블만 제거된다.

### Deprecated
- `guard.env_secret_patterns` 제거 예정 버전을 v0.7.0 → v2.0.0 으로 조정 (stable 릴리스 이후 breaking 정책 정합화).
- `ResponseEnvelope.guard_error` 권고 — v2.0.0 에서 제거 예정. 새 소비자는 `ResponseEnvelope.failure` 를 사용한다.

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
